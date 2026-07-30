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
 * Detection order matters: check the most specific signature first.
 * `daily_value` is the fallback because its RTP/BIn/DAU columns are broad
 * enough that a more specific file (brand_game_value also has RTP and DAU)
 * must be ruled out first.
 */

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
    id: 'daily_value',
    label: 'Daily Value',
    referenceFile: 'casino-metrics.md',
    dateColumn: 'Date',
    signature: (headers) => headers.has('RTP') && headers.has('BIn') && headers.has('DAU'),
  },
];

export const FILE_TYPE_IDS = FILE_TYPES.map((t) => t.id);

/** `headers` — column names read from the workbook's first row, already trimmed. */
export function detectFileType(headers) {
  const set = new Set(headers.map((h) => String(h).trim()));
  return FILE_TYPES.find((t) => t.signature(set))?.id ?? null;
}

export function getFileType(id) {
  return FILE_TYPES.find((t) => t.id === id) ?? null;
}
