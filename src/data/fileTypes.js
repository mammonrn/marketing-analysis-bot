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
 * - `aggregate(rows, { site })` — transaction logs (deposit_detail, bonus_log) run to
 *   six figures of rows, which is far more than a question ever needs and
 *   more than the process wants to hold. The raw file is still stored, but
 *   what lands in `parsed_rows` is a daily summary. `dateColumn` then refers
 *   to a key on the *summary* row, so `sourceDateColumn` names the raw
 *   column that ingest reads to work out which month the file belongs to.
 * - `pivot: true` — the sheet is a cross-tab, not a row-per-record table, so
 *   `parsePivotSheet` reshapes it instead of `readSheet`.
 * - `leadColumnIsUserText: true` — the sheet's first column holds something a
 *   person typed (a username, a channel name) rather than an axis Power BI
 *   controls. `dropNonDataRows` then refuses to treat a leading "Total" /
 *   "sum" / "รวม" as furniture on its own, because on these files it is a
 *   real member. Left unset for date axes and fixed vocabularies (GameKind),
 *   where such a label can only be Power BI's own total row.
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
    // Leading column is `Username`. See `dropNonDataRows`.
    leadColumnIsUserText: true,
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
  // `reward point.xlsx` and `other transfer.xlsx` are the same point-log shape
  // as `bonus.xlsx` (AddTime / Type / Username / Lv / Points / Memo), so they
  // match the signature above and all three used to share one storage key —
  // uploading two of them in a month kept only the last. They are separate
  // reports: casino-metrics.md documents the Type vocabulary of reward point,
  // and fraud-anomaly-detection.md reads other transfer for manual credit.
  // Same aggregation, same date column; only the identity differs.
  {
    id: 'reward_point',
    label: 'Reward / Loyalty Point Log (สรุปรายวัน)',
    referenceFile: 'casino-metrics.md',
    dateColumn: 'Date',
    sourceDateColumn: 'AddTime',
    aggregate: aggregateBonusLog,
  },
  {
    id: 'other_transfer',
    label: 'Other Transfer / Manual Credit (สรุปรายวัน)',
    referenceFile: 'fraud-anomaly-detection.md',
    dateColumn: 'Date',
    sourceDateColumn: 'AddTime',
    aggregate: aggregateBonusLog,
  },
  {
    id: 'ad_agent',
    label: 'AD / Agent',
    referenceFile: 'ad-agent.md',
    dateColumn: null,
    // Leading column is a channel/agent name someone typed.
    leadColumnIsUserText: true,
    signature: (headers) => headers.has('AD / Agent'),
  },
  {
    id: 'referrer',
    label: 'Referrer',
    referenceFile: 'referrer.md',
    dateColumn: null,
    // Leading column is the referrer's username.
    leadColumnIsUserText: true,
    signature: (headers) => headers.has('Ref Bonus'),
  },
  {
    id: 'member_referrer_detail',
    label: 'Member Referrer Detail',
    referenceFile: 'fraud-anomaly-detection.md',
    dateColumn: null,
    leadColumnIsUserText: true,
    // No signature: its columns are member_detail's (Username, Referrer, BIn,
    // Pro, R, BIn Days — u89-metrics.md and fraud-anomaly-detection.md), so the
    // header row cannot tell the two apart. The filename can, and must:
    // fraud-anomaly-detection.md calls for this file by name to find referral
    // abuse, and while both landed on `member_detail` the second upload of the
    // month silently replaced the first.
  },
  {
    id: 'member_detail',
    label: 'Member Detail',
    referenceFile: 'member-detail.md',
    dateColumn: null,
    // Leading column is `Username`.
    leadColumnIsUserText: true,
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

/**
 * Exports that a signature matches but that are not the report it names.
 *
 * Two families share a header shape with a type that has a signature, so
 * `detectFileType` hands all of them the same id — and since `raw_files` is
 * unique on (site, year_month, file_type), the second upload of a month
 * replaced the first on disk and in the database. Nothing errored; the file
 * just stopped existing. That is how `Member Referrer Detail.xlsx` came back
 * labelled "Member Detail" and `reward point.xlsx` came back as "Bonus /
 * Points Log": not a misreading of the columns, but two different reports
 * sharing one slot.
 *
 * It matters beyond the label. `fraud-anomaly-detection.md` is a required
 * part of the system prompt and calls for `Member Referrer Detail.xlsx`,
 * `reward point.xlsx` and `other transfer.xlsx` by name; the referral-abuse
 * and manual-credit checks cannot run on files that overwrite each other.
 *
 * Filename is the only thing left to separate them, which is the same
 * position the two hour pivots are in and is resolved the same way. Order
 * matters: `member referrer detail` has to be tested before any looser
 * `member` rule would catch it.
 */
const FILENAME_OVERRIDES = [
  { pattern: /member\s*referrer\s*detail/i, from: ['member_detail'], to: 'member_referrer_detail' },
  { pattern: /reward\s*point/i, from: ['bonus_log'], to: 'reward_point' },
  { pattern: /other\s*transfer/i, from: ['bonus_log'], to: 'other_transfer' },
];

/**
 * Refines a signature match using the filename, or returns it unchanged.
 *
 * Deliberately narrow: an override only fires when the signature already
 * produced the type it is registered against, so a filename can redirect a
 * `member_detail` match but can never invent a type for a file whose columns
 * say something else entirely.
 */
export function refineFileTypeByFilename(fileType, originalFilename) {
  if (!fileType) return fileType;
  const name = String(originalFilename ?? '');
  const hit = FILENAME_OVERRIDES.find(
    (override) => override.from.includes(fileType) && override.pattern.test(name),
  );
  return hit ? hit.to : fileType;
}

export function getFileType(id) {
  return FILE_TYPES.find((t) => t.id === id) ?? null;
}
