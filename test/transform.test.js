import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  toNumber,
  toThb,
  toPercent,
  formatThb,
  formatPercent,
  normaliseRow,
  deriveMetrics,
} from '../src/data/transform.js';

test('toNumber handles the shapes Power BI exports produce', () => {
  assert.equal(toNumber(886), 886);
  assert.equal(toNumber('886'), 886);
  assert.equal(toNumber('1,075'), 1075);
  assert.equal(toNumber('฿1,075'), 1075);
  assert.equal(toNumber('(50)'), -50); // accounting negative
  assert.equal(toNumber('-50'), -50);
  assert.equal(toNumber('95.2%'), 0.952); // a cell already in % form
  assert.equal(toNumber(''), null);
  assert.equal(toNumber(null), null);
  assert.equal(toNumber('n/a'), null);
});

test('money conversion follows the per-site rule', () => {
  // casino-metrics.md worked example: 886 → ฿697,282 for SH666.
  assert.equal(Math.round(toThb(886, 'shwe666')), 697_282);
  assert.equal(Math.round(toThb(1075, 'shwe666')), 846_025);
  // U89 / 88F are THB already: 886 → ฿886,000.
  assert.equal(toThb(886, 'ubet89'), 886_000);
  assert.equal(toThb(886, '88fed'), 886_000);
  // Aliases resolve too.
  assert.equal(Math.round(toThb(886, 'SH666')), 697_282);
});

test('toThb rejects an unknown site rather than guessing a factor', () => {
  assert.throws(() => toThb(100, 'mystery'), /Unknown site/);
});

test('decimals render as percentages', () => {
  assert.equal(toPercent(0.952), 95.2);
  assert.equal(Math.round(toPercent(0.683) * 10) / 10, 68.3);
  assert.equal(toPercent(null), null);
});

test('formatThb uses the ฿X.XXM / ฿X,XXX thresholds', () => {
  assert.equal(formatThb(697_282), '฿697,282');
  assert.equal(formatThb(1_234_567), '฿1.23M');
  assert.equal(formatThb(-50_000), '-฿50,000');
  assert.equal(formatThb(null), 'ไม่มีข้อมูล');
});

test('formatPercent keeps one decimal by default', () => {
  assert.equal(formatPercent(95.24), '95.2%');
  assert.equal(formatPercent(null), 'ไม่มีข้อมูล');
});

test('normaliseRow adds converted columns without losing the raw ones', () => {
  const row = { R: 886, RTP: 0.952, DAU: 473 };
  const out = normaliseRow(row, 'shwe666');

  assert.equal(out.R, 886, 'raw value is preserved');
  assert.equal(Math.round(out.R_THB), 697_282);
  assert.equal(out.RTP_pct, 95.2);
  // DAU is a head count — it must never be scaled.
  assert.equal(out.DAU, 473);
  assert.equal(out.DAU_THB, undefined);
});

test('deriveMetrics computes the metrics the skill says to always show', () => {
  const out = deriveMetrics({
    R: 100,
    BIn: 400,
    'BIn Mems': 400,
    'BIn Mems (np)': 300,
    '1 Time': 86,
    '11~20 Counts': 37,
    '21+ Counts': 188,
    '1st Day Mems': 50,
    '1st New Mems': 18,
  });

  assert.equal(out['R/BIn_pct'], 25);
  assert.equal(out.ARPPU, 1);
  assert.equal(out.organic_pct, 75);
  // Power User Index = (11~20 + 21+) / BIn Mems × 100
  assert.equal(Math.round(out.power_user_pct * 10) / 10, 56.3);
  assert.equal(Math.round(out.casual_pct * 10) / 10, 21.5);
  // Delayed 1st Deposit = 1st Day Mems − 1st New Mems
  assert.equal(out.delayed_1st_deposit, 32);
});

test('deriveMetrics omits metrics it cannot compute instead of emitting NaN', () => {
  const out = deriveMetrics({ R: 100 });
  assert.equal('R/BIn_pct' in out, false);
  assert.equal('delayed_1st_deposit' in out, false);
});
