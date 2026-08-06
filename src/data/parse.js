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

/** `YYYY-MM-DD` for anything that looks like a date, otherwise null. */
export function normaliseDate(value) {
  if (value === null || value === undefined || value === '') return null;

  // Fallback for date cells that came through as a raw Excel serial number
  // instead of a JS Date (see file header note) — decode with SheetJS's own
  // date-serial math rather than guessing. Range chosen to safely bracket
  // plausible spreadsheet dates (~1954-2119) without colliding with small
  // numeric business values (durations, points, counts, etc.) that might
  // end up in a mis-mapped date column.
  // A number is either a serial in that band or not a date at all: falling
  // through to `new Date(String(n))` would read a bare number as a year
  // (100 -> "0100-01-01", 19999 -> "+019999-01"), so bail out instead.
  if (typeof value === 'number') {
    if (value <= 20000 || value >= 80000) return null;
    const dc = XLSX.SSF.parse_date_code(value);
    if (!dc) return null;
    const d = new Date(Date.UTC(dc.y, dc.m - 1, dc.d));
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }

  const s = String(value);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

export function yearMonthOf(dateStr) {
  return dateStr ? dateStr.slice(0, 7) : null;
}

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
  const { rows } = await readSheet(path.join(ROOT, rawFile.path));
  const dateColumn = type?.dateColumn;

  const parsedRows = rows.map((row) => ({
    row,
    rowDate: dateColumn ? normaliseDate(row[dateColumn]) : null,
  }));

  insertParsedRows(rawFile.id, { fileType, site, yearMonth, rows: parsedRows });
  markParsed(rawFile.id);
  logger.info('parsed raw file', { site, yearMonth, fileType, rows: parsedRows.length });

  return getRawFile(rawFile.id);
}
