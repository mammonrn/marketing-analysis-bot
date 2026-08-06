/**
 * Layer 2 of spec §3B: parse a raw workbook into `parsed_rows` only when a
 * question actually needs it, then never again (`parsed = 1` short-circuits
 * every later call). `readSheet` is also reused by `ingest.js` at upload time
 * to read just the header row (+ date column, for dating the file) — that is
 * a cheap read of the same workbook, not the lazy "layer 2" parse itself.
 *
 * NOTE (2026-08): switched from `exceljs` to `xlsx` (SheetJS) because some
 * upstream exports (e.g. shwe666/SH666 detail exports) write xl/workbook.xml
 * with a namespaced element prefix (`<x:workbook>` instead of `<workbook>`).
 * That's valid OOXML, but exceljs's parser looks for unprefixed tag names
 * and never finds `<sheets>`, throwing "Cannot read properties of undefined
 * (reading 'sheets')". SheetJS tolerates the prefix on the workbook/sheet
 * structure.
 *
 * The same exports also carry the prefix into xl/styles.xml, which makes
 * SheetJS (like exceljs would) fail to resolve which cells are
 * date-formatted — date cells come back as plain Excel serial numbers
 * (e.g. 46239.999...) instead of JS Date objects, silently, with no error.
 * `normaliseDate` below decodes those serials itself (via XLSX's own
 * `SSF.parse_date_code`) as a fallback, so date columns stay correct
 * regardless of whether the source file's style metadata survived parsing.
 */

import path from 'node:path';
import fs from 'node:fs';
import XLSX from 'xlsx';
import { getFileType } from './fileTypes.js';
import { normaliseDate, yearMonthOf } from './dates.js';
import { findRawFile, getRawFile, markParsed, insertParsedRows } from './db.js';
import { ROOT } from '../paths.js';
import { logger } from '../logger.js';

export class MissingDataError extends Error {}

function cellToPlain(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  // With `raw: true` below, SheetJS already returns plain strings/numbers/
  // booleans (formulas resolved to their computed value) — no exceljs-style
  // {result}/{richText}/{text} wrapper objects to unwrap here.
  return value;
}

/** Reads the first worksheet's header row + data rows, keyed by header text. */
export async function readSheet(source) {
  const buffer = Buffer.isBuffer(source) ? source : fs.readFileSync(source);

  // cellDates: true -> when SheetJS *can* resolve a cell's date style, it
  // hands back a JS Date directly instead of a serial number. Kept as a
  // best case; normaliseDate() below still has to cover the case where it
  // can't (see file header note).
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });

  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) return { headers: [], rows: [] };
  const sheet = workbook.Sheets[firstSheetName];

  // header: 1 -> array-of-arrays instead of auto-keyed objects, so we read
  // the header row ourselves exactly like the old exceljs code did (keeps
  // control over trimming/blank-header handling below). raw: true -> keep
  // numbers as numbers instead of formatting everything to display strings
  // (raw: false would also turn e.g. `Points` / `Duration (m)` into text).
  const grid = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null });

  if (grid.length === 0) return { headers: [], rows: [] };

  const headers = (grid[0] ?? []).map((h) => String(h ?? '').trim());

  const rows = [];
  for (let r = 1; r < grid.length; r += 1) {
    const values = grid[r] ?? [];
    const obj = {};
    let hasValue = false;
    headers.forEach((header, idx) => {
      if (!header) return;
      const cell = cellToPlain(values[idx]);
      if (cell !== null && cell !== '') hasValue = true;
      obj[header] = cell;
    });
    if (hasValue) rows.push(obj);
  }

  return { headers, rows };
}

/** Cheap read of just the header row — used to decide whether a file is
 * even worth fully parsing, before paying the memory cost of reading every
 * row. `sheetRows: 1` tells SheetJS to stop building cell objects after the
 * first row instead of materialising the whole worksheet, which is what
 * blew a 150k-row unrecognised file past pm2's memory limit. */
export async function readHeaderRow(source) {
  const buffer = Buffer.isBuffer(source) ? source : fs.readFileSync(source);
  const workbook = XLSX.read(buffer, { type: 'buffer', sheetRows: 1 });

  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) return [];
  const sheet = workbook.Sheets[firstSheetName];

  const grid = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null });
  return (grid[0] ?? []).map((h) => String(h ?? '').trim());
}

// The export numbers its row axis 1-7 and says which end it starts at in its
// own filename ("Week Day (Week begins on Monday) x Hour").
const WEEKDAY_NAMES = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
];

/**
 * Reshapes an hour cross-tab into ordinary rows: 7 weekday rows across 24
 * hour columns become 168 `{weekday, hour, <valueKey>}` rows, so the pivot
 * goes through the same storage path as every other file type.
 *
 * The sheet carries two rows of furniture that are not data and are skipped
 * by the 1-7 check: a `Week Day | Average of Points | ...` sub-header sitting
 * under the real header row, and an `Applied filters: ...` trailer at the
 * bottom. The leading column is headed `Hour` even though it holds the
 * weekday axis — that is how Power BI labels a pivot, not a mistake to fix.
 */
export async function parsePivotSheet(source, { valueKey = 'avg_bin' } = {}) {
  const { headers, rows } = await readSheet(source);
  if (headers.length === 0) return [];

  const [axisColumn, ...hourColumns] = headers;

  const out = [];
  for (const row of rows) {
    const dayNumber = Number(row[axisColumn]);
    if (!Number.isInteger(dayNumber) || dayNumber < 1 || dayNumber > 7) continue;

    for (const column of hourColumns) {
      const hour = Number.parseInt(column, 10);
      if (!Number.isInteger(hour)) continue;
      out.push({
        weekday: WEEKDAY_NAMES[dayNumber - 1],
        weekday_num: dayNumber,
        hour,
        [valueKey]: row[column] ?? null,
      });
    }
  }
  return out;
}

// Imported (not just re-exported) because `ensureParsed` below calls it.
export { normaliseDate, yearMonthOf };

function requireRawFile({ site, yearMonth, fileType }) {
  const row = findRawFile({ site, yearMonth, fileType });
  if (!row) {
    throw new MissingDataError(
      `ยังไม่มีข้อมูล ${fileType} ของเว็บนี้ในเดือน ${yearMonth} — ขอให้ upload เพิ่มก่อนครับ`,
    );
  }
  return row;
}

/**
 * Ensures `parsed_rows` has this file's data, parsing on first use only
 * (spec §3B layer 2). Silently returns already-parsed files unchanged —
 * `toNumber` is intentionally not applied to non-date cells here: raw values
 * stay exactly as the workbook had them, and `transform.js` converts at
 * query time so the same cell can serve both `_THB`/`_pct` and raw display.
 */
export async function ensureParsed({ site, yearMonth, fileType }) {
  const rawFile = requireRawFile({ site, yearMonth, fileType });
  if (rawFile.parsed) return rawFile;

  const type = getFileType(fileType);
  const absPath = path.join(ROOT, rawFile.path);
  const dateColumn = type?.dateColumn;

  // Three shapes reach storage the same way: ordinary row-per-record sheets,
  // cross-tabs reshaped into rows, and transaction logs collapsed to a daily
  // summary. Only what produces `rows` differs.
  let rows;
  if (type?.pivot) {
    rows = await parsePivotSheet(absPath, { valueKey: type.pivotValueKey });
  } else {
    ({ rows } = await readSheet(absPath));
    if (type?.aggregate) rows = type.aggregate(rows);
  }

  const parsedRows = rows.map((row) => ({
    row,
    rowDate: dateColumn ? normaliseDate(row[dateColumn]) : null,
  }));

  insertParsedRows(rawFile.id, { fileType, site, yearMonth, rows: parsedRows });
  markParsed(rawFile.id);
  logger.info('parsed raw file', { site, yearMonth, fileType, rows: parsedRows.length });

  return getRawFile(rawFile.id);
}
