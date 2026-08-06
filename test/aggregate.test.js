/**
 * Daily-summary and pivot-reshape tests.
 *
 * The pivot fixture reproduces the real sheet's furniture — a `Week Day`
 * sub-header under the real header row, numeric 1-7 weekdays, and an
 * `Applied filters: ...` trailer — because those are exactly what a naive
 * reshape would turn into junk rows.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';

// config.js resolves its env at import time, so the env has to be set before
// anything in the module graph is evaluated — same reasoning as session.test.js.
process.env.TELEGRAM_BOT_TOKEN ??= 'test-token';
process.env.ANTHROPIC_API_KEY ??= 'test-key';

const { aggregateDepositDetail, aggregateBonusLog } = await import('../src/data/aggregate.js');
const { parsePivotSheet } = await import('../src/data/parse.js');

test('aggregateDepositDetail summarises per day and payment channel', () => {
  const rows = [
    { AddTime: '2026-06-01', PayName: 'k_pay', Status: 'success', 'Duration (m)': 2 },
    { AddTime: '2026-06-01', PayName: 'k_pay', Status: 'success', 'Duration (m)': 4 },
    { AddTime: '2026-06-01', PayName: 'k_pay', Status: 'failed', 'Duration (m)': 99 },
    { AddTime: '2026-06-01', PayName: 'wave_money', Status: 'success', 'Duration (m)': 1 },
    { AddTime: '2026-06-02', PayName: 'k_pay', Status: 'success', 'Duration (m)': 6 },
  ];

  const out = aggregateDepositDetail(rows);
  assert.equal(out.length, 3);

  const kpayDay1 = out.find((r) => r.Date === '2026-06-01' && r.PayName === 'k_pay');
  assert.equal(kpayDay1.total_count, 3);
  assert.equal(kpayDay1.success_count, 2);
  assert.equal(kpayDay1.success_rate, 2 / 3);
  // Only the two successful rows count: (2+4)/2, not (2+4+99)/3.
  assert.equal(kpayDay1.avg_duration_min, 3);
});

test('aggregateDepositDetail matches Status case-insensitively', () => {
  const out = aggregateDepositDetail([
    { AddTime: '2026-06-01', PayName: 'k_pay', Status: 'Success', 'Duration (m)': 2 },
    { AddTime: '2026-06-01', PayName: 'k_pay', Status: 'SUCCESS', 'Duration (m)': 4 },
  ]);
  assert.equal(out[0].success_count, 2);
  assert.equal(out[0].success_rate, 1);
});

test('aggregateDepositDetail omits avg_duration_min when nothing succeeded', () => {
  const out = aggregateDepositDetail([
    { AddTime: '2026-06-01', PayName: 'k_pay', Status: 'failed', 'Duration (m)': 9 },
  ]);
  assert.equal(out[0].success_count, 0);
  assert.equal(out[0].success_rate, 0);
  assert.ok(!('avg_duration_min' in out[0]), 'should be absent rather than NaN');
});

test('aggregateDepositDetail keeps blank PayName as its own channel and drops undated rows', () => {
  const out = aggregateDepositDetail([
    { AddTime: '2026-06-01', PayName: '', Status: 'success', 'Duration (m)': 2 },
    { AddTime: null, PayName: 'k_pay', Status: 'success', 'Duration (m)': 2 },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].PayName, '');
});

test('aggregateBonusLog sums points per day and type', () => {
  const out = aggregateBonusLog([
    { AddTime: '2026-06-01', Type: 'Loyalty Point', Points: 10 },
    { AddTime: '2026-06-01', Type: 'Loyalty Point', Points: 5.5 },
    { AddTime: '2026-06-01', Type: 'Referrer Reward Point', Points: 3 },
    { AddTime: '2026-06-02', Type: 'Loyalty Point', Points: 1 },
  ]);

  assert.equal(out.length, 3);
  const loyaltyDay1 = out.find((r) => r.Date === '2026-06-01' && r.Type === 'Loyalty Point');
  assert.equal(loyaltyDay1.total_points, 15.5);
  assert.equal(loyaltyDay1.transaction_count, 2);
});

test('aggregateBonusLog counts a row even when its Points cell is unreadable', () => {
  const out = aggregateBonusLog([
    { AddTime: '2026-06-01', Type: 'Loyalty Point', Points: 10 },
    { AddTime: '2026-06-01', Type: 'Loyalty Point', Points: null },
  ]);
  assert.equal(out[0].total_points, 10);
  assert.equal(out[0].transaction_count, 2);
});

function hourPivotBuffer(measureLabel) {
  const hours = Array.from({ length: 24 }, (_, i) => i);
  const aoa = [
    ['Hour', ...hours],
    ['Week Day', ...hours.map(() => measureLabel)], // sub-header, not data
    ...Array.from({ length: 7 }, (_, day) => [day + 1, ...hours.map((h) => day * 100 + h)]),
    ['Applied filters:\nLabel is BIn\nMem Filter is 1', ...hours.map(() => null)], // trailer
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Export');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

test('parsePivotSheet turns the 7x24 grid into 168 rows', async () => {
  const rows = await parsePivotSheet(hourPivotBuffer('Average of Points'));

  assert.equal(rows.length, 168, 'sub-header and trailer must not become rows');
  assert.deepEqual(rows[0], { weekday: 'Monday', weekday_num: 1, hour: 0, avg_bin: 0 });
  assert.deepEqual(rows[23], { weekday: 'Monday', weekday_num: 1, hour: 23, avg_bin: 23 });
  assert.deepEqual(rows[167], { weekday: 'Sunday', weekday_num: 7, hour: 23, avg_bin: 623 });

  // Every weekday appears exactly 24 times, one per hour.
  const perDay = new Map();
  for (const row of rows) perDay.set(row.weekday, (perDay.get(row.weekday) ?? 0) + 1);
  assert.equal(perDay.size, 7);
  assert.ok([...perDay.values()].every((n) => n === 24));
});

test('parsePivotSheet names the measure column per file type', async () => {
  const rows = await parsePivotSheet(hourPivotBuffer('Average of Mems'), { valueKey: 'avg_mems' });
  assert.equal(rows.length, 168);
  assert.equal(rows[0].avg_mems, 0);
  assert.ok(!('avg_bin' in rows[0]), 'the Mems pivot counts members, not baht');
});
