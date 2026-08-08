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
const { SITES, applyFxOverride, clearFxOverrides } = await import('../src/data/sites.js');

// The only site whose `Points` scale has been verified against a real file,
// and therefore the only one these tests can convert with.
const SH666 = 'shwe666';

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
  ], { site: SH666 });

  assert.equal(out.length, 3);
  const loyaltyDay1 = out.find((r) => r.Date === '2026-06-01' && r.Type === 'Loyalty Point');
  assert.equal(loyaltyDay1.total_points, 15.5);
  assert.equal(loyaltyDay1.transaction_count, 2);
});

test('aggregateBonusLog counts a row even when its Points cell is unreadable', () => {
  const out = aggregateBonusLog([
    { AddTime: '2026-06-01', Type: 'Loyalty Point', Points: 10 },
    { AddTime: '2026-06-01', Type: 'Loyalty Point', Points: null },
  ], { site: SH666 });
  assert.equal(out[0].total_points, 10);
  assert.equal(out[0].transaction_count, 2);
});

/**
 * The regression this whole change exists for.
 *
 * Confirmed against SH666's own `reward_point.xlsx` for 2026-07: the "Money
 * Daily" row reads 1.200 in the file and is 120,000 MMK in reality. Reading
 * the column raw is what produced "Loyalty Point รวม 278.8" for a figure in
 * the tens of millions of kyat.
 */
test('a raw Points value of 1.200 is 120,000 MMK before any fx conversion', (t) => {
  t.after(clearFxOverrides);
  // fxRate 1 isolates the point scale from the currency step, so this asserts
  // the MMK figure itself rather than inferring it back out of a baht number.
  applyFxOverride(SH666, { fxRate: 1, fxRateAsOf: '2026-07-31' });

  const out = aggregateBonusLog(
    [{ AddTime: '2026-07-15', Type: 'Money Daily', Points: 1.2 }],
    { site: SH666 },
  );

  assert.equal(out[0].total_points, 1.2, 'the raw column must survive untouched');
  assert.equal(out[0].total_points_THB, 120_000);
});

test('120,000 MMK then converts to baht at the site rate', () => {
  const out = aggregateBonusLog(
    [{ AddTime: '2026-07-15', Type: 'Money Daily', Points: 1.2 }],
    { site: SH666 },
  );

  const { pointsScaleFactor, fxRate } = SITES[SH666];
  assert.equal(pointsScaleFactor, 100_000);
  // 1.2 × 100,000 × 0.787 = 94,440.
  assert.equal(out[0].total_points_THB, 1.2 * pointsScaleFactor * fxRate);
  assert.ok(Math.abs(out[0].total_points_THB - 94_440) < 1e-6);
});

test('aggregateBonusLog keeps the raw sum alongside the converted one', () => {
  const out = aggregateBonusLog(
    [
      { AddTime: '2026-07-15', Type: 'Loyalty Point', Points: 1 },
      { AddTime: '2026-07-15', Type: 'Loyalty Point', Points: 2 },
    ],
    { site: SH666 },
  );

  // Both columns, because only the raw one can be checked against Power BI.
  assert.equal(out[0].total_points, 3);
  assert.equal(out[0].total_points_THB, 3 * SITES[SH666].pointsFactor);
});

test('the converted column uses the _THB spelling query.js pairs and labels', () => {
  const [row] = aggregateBonusLog(
    [{ AddTime: '2026-07-15', Type: 'Loyalty Point', Points: 1 }],
    { site: SH666 },
  );
  // Lower-case `_thb` would reach the model as an unexplained third number:
  // `CONVERTED_SUFFIXES` in query.js matches on the exact `_THB` suffix.
  assert.ok('total_points_THB' in row);
  assert.ok(!('total_points_thb' in row));
});

test('a site with no pointsScaleFactor refuses to guess one', () => {
  // U89/88F have no verified scale, so their point logs must fail loudly
  // rather than borrow SH666's 100,000 — the failure mode the old fused
  // `moneyFactor` taught this codebase to fear.
  for (const site of ['ubet89', '88fed']) {
    assert.equal(SITES[site].pointsFactor, null, `${site} must not have a guessed factor`);
    assert.throws(
      () => aggregateBonusLog([{ AddTime: '2026-07-15', Type: 'Loyalty Point', Points: 1 }], { site }),
      /ยังไม่ได้ตั้งค่า pointsScaleFactor/,
      `${site} should refuse rather than convert`,
    );
  }
});

test('aggregateBonusLog refuses to run without a site at all', () => {
  assert.throws(
    () => aggregateBonusLog([{ AddTime: '2026-07-15', Type: 'Loyalty Point', Points: 1 }]),
    /ต้องระบุเว็บ/,
  );
});

test('a runtime fx change moves the converted points with it', (t) => {
  t.after(clearFxOverrides);
  const rows = [{ AddTime: '2026-07-15', Type: 'Money Daily', Points: 1.2 }];

  const atConfigRate = aggregateBonusLog(rows, { site: SH666 })[0].total_points_THB;
  applyFxOverride(SH666, { fxRate: 0.812, fxRateAsOf: '2026-08-08' });
  const atNewRate = aggregateBonusLog(rows, { site: SH666 })[0].total_points_THB;

  assert.notEqual(atNewRate, atConfigRate);
  assert.equal(atNewRate, 1.2 * 100_000 * 0.812);
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
