/**
 * Layer 2 of spec §3B: parse a raw workbook into `parsed_rows` only when a
 * question actually needs it, then never again (`parsed = 1` short-circuits
 * every later call).
 *
 * The reading itself lives in `workbook.js` and, for anything big enough to
 * be worth the thread, runs off the main thread via `parseRunner.js`. This
 * module owns only the part that must stay on the main thread: deciding what
 * to parse and writing the result to SQLite.
 *
 * `readSheet` / `readHeaderRow` / `parsePivotSheet` and the date helpers are
 * re-exported here so existing callers keep importing them from `parse.js`.
 */

import path from 'node:path';
import { getFileType } from './fileTypes.js';
import { normaliseDate, yearMonthOf } from './dates.js';
import { readSheet, readHeaderRow, parsePivotSheet } from './workbook.js';
import { parseWorkbookRows } from './parseRunner.js';
import { findRawFile, getRawFile, markParsed, insertParsedRows } from './db.js';
import { ROOT } from '../paths.js';
import { logger } from '../logger.js';

export { readSheet, readHeaderRow, parsePivotSheet };
export { normaliseDate, yearMonthOf };

export class MissingDataError extends Error {}

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
 *
 * `onProgress` is forwarded to the runner so a caller (the Telegram handler)
 * can report that a slow file is still being worked on.
 */
export async function ensureParsed({ site, yearMonth, fileType, onProgress } = {}) {
  const rawFile = requireRawFile({ site, yearMonth, fileType });
  if (rawFile.parsed) return rawFile;

  const type = getFileType(fileType);
  const absPath = path.join(ROOT, rawFile.path);

  // Reading + reshaping + aggregating all happen in `parseWorkbookRows`, on a
  // worker thread when the file is large enough to be worth it. Only the
  // insert below touches the database, and it stays on this thread.
  // `site` is passed down because the point-log aggregators need this site's
  // `Points` scale to convert; every other file type ignores it and converts
  // at query time instead.
  const rows = await parseWorkbookRows({ filePath: absPath, fileType, site, onProgress });

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
