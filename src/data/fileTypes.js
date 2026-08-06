/**
 * File-type manifest (spec §3B step 1) — the single place that knows how to
 * recognise a Power BI export from its header row and which skill reference
 * file its benchmarks live in.
 *
 * Storage model: rather than hand-declaring a fixed SQL column per source
 * column (the source sheets carry ~15-30 columns each and gain new ones over
 * time), every parsed table has the same generic shape — one row per source
 * row, the row's original cells kept as a JSON object keyed by the exact
 * column names from the file (see `src/data/db.js`). `normaliseRow` /
 * `deriveMetrics` from `transform.js` already operate on that same
 * column-name-keyed shape, so nothing downstream needs a second schema.
 * `dateColumn` names which of those keys holds a per-row date, for file
 * types that are daily time series; snapshot/aggregate exports (vip,
 * brand_game_value) leave it null and are scoped by `year_month` alone.
 *
 * Three optional fields let a type deviate without a schema change:
 *
 * - `aggregate(rows)` — transaction logs (deposit_detail, bonus_log) run to
 *   six figures of rows, which is far more than a question ever needs and
 *   more than the process wants to hold. The raw file is still stored, but
 *   what lands in `parsed_rows` is a daily summary. `dateColumn` then refers
 *   to a key on the *summary* row, so `sourceDateColumn` names the raw
 *   column that ingest reads to work out which month the file belongs to.
 * - `pivot: true` — the sheet is a cross-tab, not a row-per-record table, so
 *   `parsePivotSheet` reshapes it instead of `readSheet`.
 * - no `signature` — the type cannot be told apart from its header row alone
 *   (the two hour-pivot exports are byte-identical up there). `detectFileType`
 *   skips those; `ingest.js` resolves them from the filename instead.
 *
 * Detection order matters: check the most specific signature first.
 * `daily_value` is the fallback because its RTP/DAU columns are broad enough
 * that a more specific file (brand_game_value also has RTP and DAU) must be
 * ruled out first.
 */

import { aggregateDepositDetail, aggregateBonusLog } from './aggregate.js';

export const FILE_TYPES = [
  {
    id: 'vip',
    label: 'VIP Members',
    referenceFile: 'vip-members.md',
    dateColumn: null,
    signature: (headers) => headers.has('Last BIn 2 Y'),
  },
  {
    id: 'new_member_quality',
    label: 'New Member Quality',
    referenceFile: 'new-member-quality.md',
    dateColumn: 'Date',
    signature: (headers) => headers.has('1st New%'),
  },
  {
    id: 'brand_game_value',
    label: 'Brand / Game Value',
    referenceFile: 'brand-game-value.md',
    dateColumn: null,
    signature: (headers) => headers.has('GameKind'),
  },
  {
    id: 'deposit_count_distribution',
    label: 'Deposit Count Distribution',
    referenceFile: 'deposit-count-distribution.md',
    dateColumn: 'Date',
    signature: (headers) => headers.has('21+ Counts'),
  },
  {
    id: 'deposit_detail',
    label: 'Deposit Detail (สรุปรายวัน)',
    referenceFile: 'deposit-detail.md',
    dateColumn: 'Date',
    sourceDateColumn: 'AddTime',
    aggregate: aggregateDepositDetail,
    signature: (headers) =>
      headers.has('AddTime') && headers.has('Confirm Time') && headers.has('PayName'),
  },
  {
    id: 'bonus_log',
    label: 'Bonus / Points Log (สรุปรายวัน)',
    referenceFile: 'bonus-log.md',
    dateColumn: 'Date',
    sourceDateColumn: 'AddTime',
    aggregate: aggregateBonusLog,
    signature: (headers) => headers.has('Memo') && headers.has('Lv') && headers.has('Points'),
  },
  {
    id: 'ad_agent',
    label: 'AD / Agent',
    referenceFile: 'ad-agent.md',
    dateColumn: null,
    signature: (headers) => headers.has('AD / Agent'),
  },
  {
    id: 'referrer',
    label: 'Referrer',
    referenceFile: 'referrer.md',
    dateColumn: null,
    signature: (headers) => headers.has('Ref Bonus'),
  },
  {
    id: 'member_detail',
    label: 'Member Detail',
    referenceFile: 'member-detail.md',
    dateColumn: null,
    signature: (headers) => headers.has('Prefer Game'),
  },
  {
    id: 'daily_value',
    label: 'Daily Value',
    referenceFile: 'casino-metrics.md',
    dateColumn: 'Date',
    // BIn is deliberately not required: the "Daily Value (Last 6 Months)"
    // variant drops that column but is the same report. Every file that
    // carries RTP/DAU for another reason (brand_game_value) is matched by a
    // more specific signature above.
    signature: (headers) => headers.has('RTP') && headers.has('DAU'),
  },
  {
    id: 'avg_bin_by_hour',
    label: 'Average BIn (Week Day × Hour)',
    referenceFile: 'avg-bin-by-hour.md',
    dateColumn: null,
    pivot: true,
    // No signature — identical header row to avg_bin_mems_by_hour.
  },
  {
    id: 'avg_bin_mems_by_hour',
    label: 'Average BIn Mems (Week Day × Hour)',
    referenceFile: 'avg-bin-by-hour.md',
    dateColumn: null,
    pivot: true,
    // Same grid, different measure: this one averages depositing members, not
    // baht, so calling the cell `avg_bin` would misname it in the prompt.
    pivotValueKey: 'avg_mems',
  },
];

export const FILE_TYPE_IDS = FILE_TYPES.map((t) => t.id);

/**
 * `headers` — column names read from the workbook's first row, already trimmed.
 * Types without a `signature` are never returned from here; they are resolved
 * by `resolvePivotFileType` in the ingest path.
 */
export function detectFileType(headers) {
  const set = new Set(headers.map((h) => String(h).trim()));
  return FILE_TYPES.find((t) => t.signature && t.signature(set))?.id ?? null;
}

/**
 * The two hour-pivot exports share this exact header row: `Hour` followed by
 * the 24 hour columns. Recognising the *shape* is all a header row can do —
 * which of the two it is comes from the filename.
 */
export function isHourPivotHeader(headers) {
  const cells = headers.map((h) => String(h ?? '').trim());
  if (cells.length !== 25) return false;
  if (cells[0] !== 'Hour') return false;
  return cells.slice(1).every((cell, idx) => cell === String(idx));
}

/**
 * Which of the two hour pivots a file is, from its name. "Mems" counts
 * members, the other counts baht — same grid, different measure.
 */
export function resolvePivotFileType(originalFilename) {
  return /mems/i.test(String(originalFilename ?? '')) ? 'avg_bin_mems_by_hour' : 'avg_bin_by_hour';
}

export function getFileType(id) {
  return FILE_TYPES.find((t) => t.id === id) ?? null;
}
