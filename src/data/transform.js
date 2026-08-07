/**
 * Numeric/currency/metric transforms for Power BI exports (casino-metrics.md
 * and friends). Kept file-type-agnostic: `normaliseRow` / `deriveMetrics` work
 * on whatever columns a row actually has, so the same helpers serve every
 * parsed table in `src/data/fileTypes.js`.
 */

import { getSite } from './sites.js';

function roundTo(n, decimals) {
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

/**
 * Power BI export cells show up as numbers, plain digit strings, thousands-
 * separated strings, a ฿ prefix, accounting-style negatives in parentheses,
 * or already-a-percentage strings like "95.2%" (which this returns as the
 * 0.952 decimal, matching how a numeric percent cell reads).
 */
export function toNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;

  let s = String(value).trim();
  if (s === '') return null;

  const isPercent = s.endsWith('%');
  if (isPercent) s = s.slice(0, -1).trim();

  const isParenNegative = /^\(.*\)$/.test(s);
  if (isParenNegative) s = s.slice(1, -1).trim();

  s = s.replace(/[฿,\s]/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;

  let n = Number.parseFloat(s);
  if (!Number.isFinite(n)) return null;
  if (isParenNegative) n = -Math.abs(n);
  if (isPercent) n = roundTo(n / 100, 10);
  return n;
}

/**
 * File values are already ÷1,000 (spec's "MMK ตัด 3 ศูนย์"). `moneyFactor`
 * folds the ×1,000 back in together with the site's currency conversion
 * (SH666 is MMK→THB at 0.787; U89/88F are already THB) — see
 * `config/site-aliases.json`.
 */
export function toThb(value, siteInput) {
  const site = getSite(siteInput);
  if (!site) throw new Error(`Unknown site: ${siteInput}`);
  const n = typeof value === 'number' ? value : toNumber(value);
  if (n === null) return null;
  return n * site.moneyFactor;
}

/** A decimal (0.952) → the percentage it displays as (95.2). */
export function toPercent(value) {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : toNumber(value);
  if (n === null || !Number.isFinite(n)) return null;
  return roundTo(n * 100, 10);
}

export function formatThb(amount) {
  if (amount === null || amount === undefined || !Number.isFinite(amount)) return 'ไม่มีข้อมูล';
  const sign = amount < 0 ? '-' : '';
  const abs = Math.abs(amount);
  if (abs >= 1_000_000) return `${sign}฿${(abs / 1_000_000).toFixed(2)}M`;
  return `${sign}฿${Math.round(abs).toLocaleString('en-US')}`;
}

export function formatPercent(value, decimals = 1) {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'ไม่มีข้อมูล';
  return `${value.toFixed(decimals)}%`;
}

/**
 * Column classification for `normaliseRow`, gathered from the skill glossary
 * tables (casino-metrics.md, new-member-quality.md, vip-members.md,
 * brand-game-value.md). Add a column here when a new reference file
 * introduces one — this is the one place that knows "this is money" or
 * "this is a decimal that displays as %", so every parsed table gets
 * consistent `_THB` / `_pct` companions without per-file-type code.
 */
const MONEY_COLUMNS = new Set([
  'CIn', 'Nw', 'Nw (np)', 'Nw (p)', 'BIn', 'Bo', 'R', 'BIn (P)', 'Pro', 'Pass', 'Pro R', 'Bonus',
  'Manual', 'Med. BIn', '1st New (BIn)', '1st Day (BIn)',
  // Found while auditing `deriveMetrics` for unit errors: ad-agent.md,
  // referrer.md and member-detail.md all mark these "THB (พัน)", so they are
  // money on exactly the same footing as BIn — but they were absent here, so
  // on the ad_agent and referrer files they reached the model as bare local
  // currency with no converted companion at all.
  //
  // `ARPPU` here is the export's own column (BIn / Total BIn Mems, computed
  // upstream by Power BI), not the one `deriveMetrics` derives. They never
  // collide: the files that carry this column have `Total BIn Mems` rather
  // than the `BIn Mems` that `deriveMetrics` requires.
  'ARPPU', 'Pw', 'Ref Bonus',
  // `avg_bin` is not a Power BI column name — it is what `parsePivotSheet`
  // calls the cell of the "Average BIn (Week Day × Hour)" grid, and it is
  // baht-denominated exactly like BIn. Missing here, it was the one money
  // figure in the whole corpus reaching the model with no converted companion
  // at all, which is why avg-bin-by-hour.md could not point at a `_THB` column
  // the way every other reference file now does. Its sibling grid's
  // `avg_mems` is a head count and correctly stays out.
  'avg_bin',
]);

const PERCENT_COLUMNS = new Set([
  'RTP', 'CIn (np)%', 'BIn (np)%', 'R / BIn', 'Verify%', '1st New%', '1st New (np%)',
  '1st Day (np%)', 'DAU% (np)', 'RTP (np)', 'RTP (p)',
]);

/**
 * Add `_THB`/`_pct` companion fields for known columns without touching the
 * raw ones — head-count columns (DAU, BIn Mems, ...) are left untouched
 * because scaling them by a currency factor would be meaningless.
 */
export function normaliseRow(row, siteInput) {
  const out = { ...row };
  for (const [key, value] of Object.entries(row)) {
    if (MONEY_COLUMNS.has(key)) {
      out[`${key}_THB`] = toThb(value, siteInput) ?? null;
    } else if (PERCENT_COLUMNS.has(key)) {
      out[`${key}_pct`] = toPercent(value);
    }
  }
  return out;
}

/**
 * The metrics `casino-metrics.md` says to always compute (§8 ARPPU, §6 organic
 * ratio, deposit-count-distribution's power-user/casual segments, and the
 * new-member-quality "delayed 1st deposit" gap). Only emitted when every
 * input column it needs is actually present — a metric the row can't support
 * is omitted, never sent out as NaN.
 *
 * `siteInput` is required for any metric whose result is an amount of money.
 * Every metric here was audited for its unit, and they fall into three groups:
 *
 * - **Ratios of two money columns** (`R/BIn_pct`) — the site factor appears in
 *   both halves and cancels, so they were and remain correct without a site.
 * - **Ratios of two head counts** (`organic_pct`, `casual_pct`,
 *   `power_user_pct`) and **differences of head counts**
 *   (`delayed_1st_deposit`) — no money involved at all.
 * - **Money divided by a head count** — the result is money, so it has to be
 *   converted. `ARPPU` was the only one, and it was wrong: computed from the
 *   raw `BIn`, it reported SH666 as 20 where the truth is ฿15,740, understating
 *   by the site's whole 787x factor. It is now `ARPPU_THB`, computed from the
 *   converted figure.
 *
 * The rename is the point, not incidental. A bare `ARPPU` alongside `BIn` and
 * `BIn_THB` is exactly the ambiguity that caused the original bug, and this one
 * failed silently: unlike `BIn`, ARPPU is not in the export, so there was no
 * Power BI figure to notice it disagreed with.
 *
 * A site that cannot be resolved omits `ARPPU_THB` rather than guessing a
 * factor — the same rule this function already applies to a missing column.
 */
export function deriveMetrics(row, siteInput) {
  const out = {};
  const get = (key) => (key in row ? toNumber(row[key]) : null);
  const site = getSite(siteInput);

  const R = get('R');
  const BIn = get('BIn');
  const binMems = get('BIn Mems');
  const binMemsNp = get('BIn Mems (np)');
  const oneTime = get('1 Time');
  const t1120 = get('11~20 Counts');
  const t21plus = get('21+ Counts');
  const firstDayMems = get('1st Day Mems');
  const firstNewMems = get('1st New Mems');

  // Money over money: the site factor cancels, so this one needs no site.
  if (R !== null && BIn) out['R/BIn_pct'] = roundTo((R / BIn) * 100, 6);
  // Money over people: the result is money and must be in baht.
  if (BIn !== null && binMems && site) {
    out.ARPPU_THB = roundTo((BIn * site.moneyFactor) / binMems, 6);
  }
  if (binMemsNp !== null && binMems) out.organic_pct = roundTo((binMemsNp / binMems) * 100, 6);
  if (oneTime !== null && binMems) out.casual_pct = roundTo((oneTime / binMems) * 100, 6);
  if (t1120 !== null && t21plus !== null && binMems) {
    out.power_user_pct = roundTo(((t1120 + t21plus) / binMems) * 100, 6);
  }
  if (firstDayMems !== null && firstNewMems !== null) {
    out.delayed_1st_deposit = firstDayMems - firstNewMems;
  }

  return out;
}
