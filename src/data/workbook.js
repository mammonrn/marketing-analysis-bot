/**
 * Pure workbook reading — no database, no storage, no side effects.
 *
 * Kept apart from `parse.js` so `parseWorker.js` can import it on a worker
 * thread without dragging in `db.js`: better-sqlite3 is a native addon and
 * its connections are not safe to touch from more than one thread, so the
 * worker must never even load it.
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
 * `normaliseDate` in `dates.js` decodes those serials itself (via XLSX's own
 * `SSF.parse_date_code`) as a fallback, so date columns stay correct
 * regardless of whether the source file's style metadata survived parsing.
 */

import fs from 'node:fs';
import XLSX from 'xlsx';
import { getFileType } from './fileTypes.js';
import { normaliseDate, yearMonthOf } from './dates.js';

/**
 * A source is either a path to read or the bytes themselves.
 *
 * The `ArrayBuffer.isView` branch is not decoration: passing a Buffer through
 * `workerData` structured-clones it into a plain Uint8Array, which still holds
 * the file's bytes but no longer satisfies `Buffer.isBuffer`. Without this the
 * worker would hand 6MB of workbook to `fs.readFileSync` as if it were a
 * filename.
 */
function toBuffer(source) {
  if (Buffer.isBuffer(source)) return source;
  if (ArrayBuffer.isView(source)) {
    return Buffer.from(source.buffer, source.byteOffset, source.byteLength);
  }
  return fs.readFileSync(source);
}

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
  const buffer = toBuffer(source);

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
  const buffer = toBuffer(source);
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

/**
 * Everything that has to happen to a workbook before its rows can be stored:
 * read it, then reshape (pivot) or summarise (transaction log) according to
 * the file type. Still free of any database or filesystem writes, which is
 * what lets `parseWorker.js` run it on a worker thread.
 *
 * `shape` selects what comes back: `'typed'` applies the file type's pivot or
 * aggregate step, `'raw'` returns the sheet's rows untouched, and
 * `'year-month'` returns only a `{ '2026-07': 1234 }` tally of the months
 * found in `dateColumn` — which is all `ingest.js` needs to date a file.
 *
 * `onProgress` reports phases. The read itself is one opaque SheetJS call
 * with no way to observe partial progress, so that phase only announces that
 * it started; the aggregate loop is ours and does report row counts.
 */
export async function readAndShapeRows({
  filePath,
  buffer,
  fileType,
  shape = 'typed',
  dateColumn,
  onProgress,
} = {}) {
  const source = buffer ?? filePath;
  const type = shape === 'typed' ? getFileType(fileType) : null;

  onProgress?.({ phase: 'reading' });

  if (type?.pivot) {
    return parsePivotSheet(source, { valueKey: type.pivotValueKey });
  }

  const { rows } = await readSheet(source);
  onProgress?.({ phase: 'read', rowsRead: rows.length });

  // Counting months is the whole job for ingest, and the answer is a handful
  // of keys. Doing the tally here rather than shipping 150k row objects back
  // across the thread boundary avoids a structured clone that briefly doubles
  // them in memory — which cost more than the read itself.
  if (shape === 'year-month') {
    const counts = {};
    for (const row of rows) {
      const ym = yearMonthOf(normaliseDate(row[dateColumn]));
      if (ym) counts[ym] = (counts[ym] ?? 0) + 1;
    }
    return counts;
  }

  if (type?.aggregate) {
    return type.aggregate(rows, {
      onProgress: (processed, total) => onProgress?.({ phase: 'aggregating', processed, total }),
    });
  }

  return rows;
}
