/**
 * Layer 1 of spec §3B: receive an uploaded workbook, work out what it is,
 * store the raw file, and record its metadata — parsing happens later, lazily
 * (`parse.js`), only when a question needs it.
 *
 * Two things this file resolves that the spec leaves to judgement:
 *
 * - **Which month the data is for.** The example path in §3B
 *   (`DATA/SH666/2026/06/daily_value_20260701_143022.xlsx`) uploads on Jul 1
 *   but files under June — the reporting month, not the upload date. Daily
 *   time-series files (`dateColumn` set) get this from the majority month of
 *   their own `Date` column. Snapshot files (VIP, brand/game value) have no
 *   date column, so the caption/message text is checked for an explicit
 *   month first (`มิถุนายน`, `2026-06`, ...), falling back to "the calendar
 *   month before upload" — the ordinary end-of-month upload pattern.
 * - **Which site.** Tries the caption/message text, then the filename, both
 *   via `normalizeSiteName` — the one function spec §3B requires everywhere
 *   a site name needs resolving.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { ROOT } from '../paths.js';
import { logger } from '../logger.js';
import { detectFileType, getFileType } from './fileTypes.js';
import { normalizeSiteName, siteDisplayName } from './sites.js';
import { readSheet, normaliseDate, yearMonthOf } from './parse.js';
import {
  findRawFile,
  upsertRawFile,
  setPendingUpload,
  getPendingUpload,
  clearPendingUpload,
  setPendingDuplicate,
  getPendingDuplicate,
  clearPendingDuplicate,
} from './db.js';

const THAI_MONTHS = {
  'มกราคม': 1, 'ม.ค.': 1,
  'กุมภาพันธ์': 2, 'ก.พ.': 2,
  'มีนาคม': 3, 'มี.ค.': 3,
  'เมษายน': 4, 'เม.ย.': 4,
  'พฤษภาคม': 5, 'พ.ค.': 5,
  'มิถุนายน': 6, 'มิ.ย.': 6,
  'กรกฎาคม': 7, 'ก.ค.': 7,
  'สิงหาคม': 8, 'ส.ค.': 8,
  'กันยายน': 9, 'ก.ย.': 9,
  'ตุลาคม': 10, 'ต.ค.': 10,
  'พฤศจิกายน': 11, 'พ.ย.': 11,
  'ธันวาคม': 12, 'ธ.ค.': 12,
};

function extractYearMonthHint(text) {
  if (!text) return null;
  const iso = text.match(/(\d{4})[-/](\d{1,2})\b/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, '0')}`;

  for (const [name, month] of Object.entries(THAI_MONTHS)) {
    if (text.includes(name)) {
      const year = text.match(/(20\d{2})/)?.[1] ?? String(new Date().getFullYear());
      return `${year}-${String(month).padStart(2, '0')}`;
    }
  }
  return null;
}

function previousYearMonth(date = new Date()) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function resolveYearMonth({ dateColumn, rows, hintText }) {
  const hint = extractYearMonthHint(hintText);
  if (hint) return hint;

  if (dateColumn) {
    const counts = new Map();
    for (const row of rows) {
      const ym = yearMonthOf(normaliseDate(row[dateColumn]));
      if (ym) counts.set(ym, (counts.get(ym) ?? 0) + 1);
    }
    if (counts.size > 0) return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  }

  return previousYearMonth();
}

function timestampSuffix() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  // Milliseconds + a random suffix: two uploads for the same site/month/type
  // seconds apart are routine (tests, retries, a fast re-send), and a
  // second-resolution name would collide and make writeFinal's "delete the
  // old version" step below delete the file it just wrote.
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${ms}`;
  return `${stamp}${crypto.randomBytes(3).toString('hex')}`;
}

function finalPathFor({ site, yearMonth, fileType }) {
  const [year, month] = yearMonth.split('-');
  const dir = path.join(config.data.dir, siteDisplayName(site), year, month);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${fileType}_${timestampSuffix()}.xlsx`);
}

function pendingDir() {
  const dir = path.join(config.data.dir, '_pending');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeTemp(chatId, buffer) {
  const absPath = path.join(pendingDir(), `${chatId}_${timestampSuffix()}.xlsx`);
  fs.writeFileSync(absPath, buffer);
  return absPath;
}

function writeFinal({ site, yearMonth, fileType, buffer, originalFilename, fileSize }) {
  const existing = findRawFile({ site, yearMonth, fileType });
  const absPath = finalPathFor({ site, yearMonth, fileType });
  fs.writeFileSync(absPath, buffer);

  // The old physical file is replaced, not kept alongside — one active raw file per key.
  // Guard against the (now-unlikely) case of a filename collision: never delete the
  // path we just wrote.
  const oldAbsPath = existing ? path.join(ROOT, existing.path) : null;
  if (oldAbsPath && oldAbsPath !== absPath) fs.rmSync(oldAbsPath, { force: true });

  const relPath = path.relative(ROOT, absPath);
  const row = upsertRawFile({ site, yearMonth, fileType, relPath, fileSize, originalFilename });
  logger.info('raw file stored', { site, yearMonth, fileType, path: relPath });
  return row;
}

function finishOrConfirm({ site, yearMonth, fileType, buffer, originalFilename, fileSize, chatId }) {
  const existing = findRawFile({ site, yearMonth, fileType });
  const isExactDuplicate =
    existing && existing.original_filename === originalFilename && existing.file_size === fileSize;

  if (isExactDuplicate) {
    const tempPath = writeTemp(chatId, buffer);
    setPendingDuplicate(chatId, {
      rawFileId: existing.id,
      tempPath,
      originalFilename,
      fileSize,
      site,
      yearMonth,
      fileType,
    });
    return { status: 'needs_confirm', site, yearMonth, fileType, existing };
  }

  const row = writeFinal({ site, yearMonth, fileType, buffer, originalFilename, fileSize });
  return { status: 'saved', site, yearMonth, fileType, row };
}

/**
 * Entry point for a document Telegram just delivered.
 * `captionText` is whatever the user typed alongside the file (caption, or a
 * text message sent right before it) — used for both site and month hints.
 */
export async function ingestUpload({ buffer, originalFilename, fileSize, chatId, captionText }) {
  const { headers, rows } = await readSheet(buffer);
  const fileType = detectFileType(headers);
  if (!fileType) return { status: 'unrecognized' };

  const type = getFileType(fileType);
  const site = normalizeSiteName(captionText) ?? normalizeSiteName(originalFilename);
  const yearMonth = resolveYearMonth({ dateColumn: type.dateColumn, rows, hintText: captionText });

  if (!site) {
    const tempPath = writeTemp(chatId, buffer);
    setPendingUpload(chatId, { tempPath, originalFilename, fileSize, fileType, yearMonth });
    return { status: 'needs_site', fileType, yearMonth };
  }

  return finishOrConfirm({ site, yearMonth, fileType, buffer, originalFilename, fileSize, chatId });
}

/** The next text message after a `needs_site` reply is expected to name the site. */
export function resolvePendingSite(chatId, siteInput) {
  const pending = getPendingUpload(chatId);
  if (!pending) return { status: 'no_pending' };

  const site = normalizeSiteName(siteInput);
  if (!site) return { status: 'invalid_site' };

  const buffer = fs.readFileSync(pending.temp_path);
  clearPendingUpload(chatId);
  fs.rmSync(pending.temp_path, { force: true });

  return finishOrConfirm({
    site,
    yearMonth: pending.year_month,
    fileType: pending.file_type,
    buffer,
    originalFilename: pending.original_filename,
    fileSize: pending.file_size,
    chatId,
  });
}

export function hasPendingUpload(chatId) {
  return Boolean(getPendingUpload(chatId));
}

export function hasPendingDuplicate(chatId) {
  return Boolean(getPendingDuplicate(chatId));
}

/** Answer to the "ต้องการอัปเดตทับไหม" confirm (spec §3B duplicate rule). */
export function resolvePendingDuplicate(chatId, overwrite) {
  const pending = getPendingDuplicate(chatId);
  if (!pending) return { status: 'no_pending' };

  clearPendingDuplicate(chatId);

  if (!overwrite) {
    fs.rmSync(pending.temp_path, { force: true });
    return { status: 'kept_existing' };
  }

  const buffer = fs.readFileSync(pending.temp_path);
  fs.rmSync(pending.temp_path, { force: true });

  const row = writeFinal({
    site: pending.site,
    yearMonth: pending.year_month,
    fileType: pending.file_type,
    buffer,
    originalFilename: pending.original_filename,
    fileSize: pending.file_size,
  });
  return { status: 'saved', site: pending.site, yearMonth: pending.year_month, fileType: pending.file_type, row };
}
