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
  const out = deriveMetrics(
    {
      R: 100,
      BIn: 400,
      'BIn Mems': 400,
      'BIn Mems (np)': 300,
      '1 Time': 86,
      '11~20 Counts': 37,
      '21+ Counts': 188,
      '1st Day Mems': 50,
      '1st New Mems': 18,
    },
    'shwe666',
  );

  assert.equal(out['R/BIn_pct'], 25);
  // 400 in the file is 400,000 MMK = ฿314,800 across 400 depositors.
  assert.equal(out.ARPPU_THB, 787);
  assert.equal(out.organic_pct, 75);
  // Power User Index = (11~20 + 21+) / BIn Mems × 100
  assert.equal(Math.round(out.power_user_pct * 10) / 10, 56.3);
  assert.equal(Math.round(out.casual_pct * 10) / 10, 21.5);
  // Delayed 1st Deposit = 1st Day Mems − 1st New Mems
  assert.equal(out.delayed_1st_deposit, 32);
});

test('ARPPU is baht per depositor, not raw file units', () => {
  // The reported case: BIn 1000 over 50 depositors read as "20" when the
  // answer is ฿15,740 — understated by the site's whole 787x factor, and
  // silently, because ARPPU is not in the export to disagree with.
  const row = { BIn: 1000, 'BIn Mems': 50 };

  assert.equal(deriveMetrics(row, 'shwe666').ARPPU_THB, 15_740);
  // A baht site keeps only the ×1,000 de-scaling.
  assert.equal(deriveMetrics(row, 'ubet89').ARPPU_THB, 20_000);
  // The old, unit-less name must be gone — two ARPPU columns of different
  // magnitudes side by side is the ambiguity that caused this in the first place.
  assert.equal('ARPPU' in deriveMetrics(row, 'shwe666'), false);
});

test('metrics whose units cancel are unaffected by the site', () => {
  // R/BIn is money over money, so the factor divides out; the head-count
  // ratios never touch money at all. All must agree across sites.
  const row = {
    R: 100,
    BIn: 400,
    'BIn Mems': 400,
    'BIn Mems (np)': 300,
    '1 Time': 86,
    '1st Day Mems': 50,
    '1st New Mems': 18,
  };

  const mmk = deriveMetrics(row, 'shwe666');
  const thb = deriveMetrics(row, 'ubet89');

  for (const key of ['R/BIn_pct', 'organic_pct', 'casual_pct', 'delayed_1st_deposit']) {
    assert.equal(mmk[key], thb[key], `${key} must not depend on the site`);
  }
});

test('the ad_agent / referrer money columns get converted companions too', () => {
  // Same audit, one layer up: ad-agent.md and referrer.md mark all of these
  // "THB (พัน)", but they were missing from MONEY_COLUMNS, so on those files
  // they reached the model as bare MMK with no baht column beside them.
  const row = { ARPPU: 12, Pw: -300, 'Ref Bonus': 45, 'Total Mems': 900 };
  const out = normaliseRow(row, 'shwe666');

  assert.equal(out.ARPPU_THB, 12 * 787);
  assert.equal(out.Pw_THB, -300 * 787, 'a negative Pw converts too — players won that period');
  assert.equal(out['Ref Bonus_THB'], 45 * 787);
  // Head counts stay untouched, as before.
  assert.equal(out['Total Mems'], 900);
  assert.equal(out['Total Mems_THB'], undefined);
});

test('the hourly pivot grid converts its money cell but not its head-count twin', () => {
  // `avg_bin` / `avg_mems` come from `parsePivotSheet`, not from a Power BI
  // header, so neither looked like a money column — but avg_bin is baht on the
  // same footing as BIn, and avg-bin-by-hour.md now tells the model to quote a
  // `_THB` column that has to actually exist.
  const money = normaliseRow({ weekday: 'Monday', hour: 21, avg_bin: 8 }, 'shwe666');
  assert.equal(money.avg_bin_THB, 8 * 787);
  assert.equal(money.avg_bin, 8, 'the raw cell survives for Power BI cross-checks');

  const people = normaliseRow({ weekday: 'Monday', hour: 21, avg_mems: 8 }, 'shwe666');
  assert.equal(people.avg_mems_THB, undefined, 'the members grid counts people, not baht');
});

test("the export's own ARPPU column and the derived one never collide", () => {
  // ad_agent/referrer carry `Total BIn Mems`, not the `BIn Mems` deriveMetrics
  // needs, so only one of the two ever produces an ARPPU_THB for a given row.
  const adAgent = { 'AD / Agent': 'line', BIn: 400, ARPPU: 12, 'Total BIn Mems': 33 };
  assert.equal('ARPPU_THB' in deriveMetrics(adAgent, 'shwe666'), false);
  assert.equal(normaliseRow(adAgent, 'shwe666').ARPPU_THB, 12 * 787);

  const daily = { BIn: 1000, 'BIn Mems': 50 };
  assert.equal(deriveMetrics(daily, 'shwe666').ARPPU_THB, 15_740);
  assert.equal(normaliseRow(daily, 'shwe666').ARPPU_THB, undefined);
});

test('deriveMetrics omits metrics it cannot compute instead of emitting NaN', () => {
  const out = deriveMetrics({ R: 100 }, 'shwe666');
  assert.equal('R/BIn_pct' in out, false);
  assert.equal('delayed_1st_deposit' in out, false);
});

test('an unresolvable site omits ARPPU rather than guessing a factor', () => {
  // Same rule the function already applies to a missing column: what cannot
  // be computed is left out, never emitted at the wrong scale.
  const row = { BIn: 1000, 'BIn Mems': 50 };
  assert.equal('ARPPU_THB' in deriveMetrics(row, 'mystery'), false);
  assert.equal('ARPPU_THB' in deriveMetrics(row), false);
  // The metrics that need no site still come through.
  assert.equal(deriveMetrics({ '1st Day Mems': 50, '1st New Mems': 18 }).delayed_1st_deposit, 32);
});
