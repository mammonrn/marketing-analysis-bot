/**
 * Layer 2 of spec §3B: parse a raw workbook into `parsed_rows` only when a
 * question actually needs it, then never again (`parsed = 1` short-circuits
 * every later call). `readSheet` is also reused by `ingest.js` at upload time
 * to read just the header row (+ date column, for dating the file) — that is
 * a cheap read of the same workbook, not the lazy "layer 2" parse itself.
 */

import path from 'node:path';
import ExcelJS from 'exceljs';
import { getFileType } from './fileTypes.js';
import { findRawFile, getRawFile, markParsed, insertParsedRows } from './db.js';
import { ROOT } from '../paths.js';
import { logger } from '../logger.js';

export class MissingDataError extends Error {}

function cellToPlain(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    // exceljs formula/hyperlink/rich-text cells: prefer the computed value.
    if ('result' in value) return cellToPlain(value.result);
    if ('richText' in value) return value.richText.map((t) => t.text).join('');
    if ('text' in value) return value.text;
    return null;
  }
  return value;
}

/** Reads the first worksheet's header row + data rows, keyed by header text. */
export async function readSheet(source) {
  const workbook = new ExcelJS.Workbook();
  if (Buffer.isBuffer(source)) {
    await workbook.xlsx.load(source);
  } else {
    await workbook.xlsx.readFile(source);
  }

  const sheet = workbook.worksheets[0];
  if (!sheet) return { headers: [], rows: [] };

  const headerValues = sheet.getRow(1).values ?? [];
  const headers = [];
  for (let i = 1; i < headerValues.length; i += 1) {
    headers.push(String(headerValues[i] ?? '').trim());
  }

  const rows = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const values = row.values ?? [];
    const obj = {};
    let hasValue = false;
    headers.forEach((header, idx) => {
      if (!header) return;
      const cell = cellToPlain(values[idx + 1]);
      if (cell !== null && cell !== '') hasValue = true;
      obj[header] = cell;
    });
    if (hasValue) rows.push(obj);
  });

  return { headers, rows };
}

/** `YYYY-MM-DD` for anything that looks like a date, otherwise null. */
export function normaliseDate(value) {
  if (value === null || value === undefined || value === '') return null;
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
