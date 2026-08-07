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
 *   a site name needs resolving. Callers resolve a site to decide what to ask
 *   the user; `canonicalSiteOrThrow` below is what guarantees the stored key
 *   is canonical, and it sits on the write path so no route can skip it.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { ROOT } from '../paths.js';
import { logger } from '../logger.js';
import {
  detectFileType,
  getFileType,
  isHourPivotHeader,
  refineFileTypeByFilename,
  resolvePivotFileType,
} from './fileTypes.js';
import { normalizeSiteName, siteDisplayName } from './sites.js';
import { readHeaderRow } from './parse.js';
import { countYearMonths } from './parseRunner.js';
import {
  findRawFile,
  upsertRawFile,
  addPendingUpload,
  listPendingUploads,
  countPendingUploads,
  clearPendingUploads,
  addPendingDuplicate,
  listPendingDuplicates,
  countPendingDuplicates,
  clearPendingDuplicates,
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

/**
 * `readCounts` is a thunk, not a tally, because producing it is the expensive
 * part: a six-month transaction log is ~150k rows and reading them costs
 * hundreds of MB. A caption that names the month, or a snapshot type with no
 * date column at all, settles the question without ever opening the sheet.
 *
 * What comes back is only `{ 'YYYY-MM': rowCount }` — the counting happens
 * wherever the rows already are (on the worker thread, for a big file), so
 * the rows themselves never have to travel or be held here.
 */
async function resolveYearMonth({ dateColumn, readCounts, hintText }) {
  const hint = extractYearMonthHint(hintText);
  if (hint) return hint;

  if (dateColumn) {
    const counts = Object.entries((await readCounts()) ?? {});
    if (counts.length > 0) return counts.sort((a, b) => b[1] - a[1])[0][0];
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

/**
 * The one place a `site` becomes a stored key.
 *
 * Every write path funnels through here — the auto-detected upload, the
 * "user typed the site name" reply, and the overwrite-confirm — so this is
 * where the canonical form is enforced rather than in each of them. The
 * callers still resolve a site of their own, but only to drive their own
 * control flow (ask for a name / reject an unusable one); what they resolve
 * is never what gets written unless it survives this call.
 *
 * Throwing rather than storing the input verbatim is deliberate. A raw
 * "SH666" written here reads back as a site that has no data at all, because
 * every reader looks it up as `shwe666` — a silent, invisible failure that
 * only shows up much later as "ไฟล์นี้ยังไม่ถูกอัปโหลด" for a file that is
 * plainly there.
 */
function canonicalSiteOrThrow(siteInput) {
  const site = normalizeSiteName(siteInput);
  if (!site) throw new Error(`Refusing to store a file under an unknown site: ${siteInput}`);
  return site;
}

function writeFinal({ site: siteInput, yearMonth, fileType, buffer, originalFilename, fileSize }) {
  const site = canonicalSiteOrThrow(siteInput);
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

function finishOrConfirm({ site: siteInput, yearMonth, fileType, buffer, originalFilename, fileSize, chatId }) {
  // Normalised here as well as in `writeFinal`, because the duplicate branch
  // does not reach `writeFinal` in this call — it parks the site in
  // `pending_duplicates` and only writes if the user confirms, possibly after
  // a restart. Staging a non-canonical key would defer the same corruption
  // rather than prevent it.
  const site = canonicalSiteOrThrow(siteInput);
  const existing = findRawFile({ site, yearMonth, fileType });
  const isExactDuplicate =
    existing && existing.original_filename === originalFilename && existing.file_size === fileSize;

  if (isExactDuplicate) {
    const tempPath = writeTemp(chatId, buffer);
    addPendingDuplicate(chatId, {
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
export async function ingestUpload({
  buffer,
  originalFilename,
  fileSize,
  chatId,
  captionText,
  onProgress,
}) {
  // Header row only: an unrecognised file is dropped here, before the cost of
  // materialising every row. A 150k-row file that matches no signature used to
  // be parsed in full first and pushed the process past pm2's memory limit.
  const headers = await readHeaderRow(buffer);
  // Signature first, exactly as before. Only when that finds nothing do we ask
  // whether this is one of the two hour pivots, which share a byte-identical
  // header row and can only be told apart by filename — so every other file
  // type's detection is untouched by this fallback.
  const fileType =
    // A signature match can still be the wrong report when two exports share a
    // header shape — the filename settles those before anything is stored.
    refineFileTypeByFilename(detectFileType(headers), originalFilename) ??
    (isHourPivotHeader(headers) ? resolvePivotFileType(originalFilename) : null);
  if (!fileType) {
    // The header row as actually read is the only thing that can explain a
    // rejection — a signature that matches in a unit test says nothing about
    // what this particular upload contained (a different export variant, a
    // stray leading column, a file the running build predates).
    logger.warn('unrecognized file upload', { originalFilename, headers });
    return { status: 'unrecognized' };
  }

  const type = getFileType(fileType);
  const site = normalizeSiteName(captionText) ?? normalizeSiteName(originalFilename);
  // Aggregating types date the file from a raw column (`AddTime`) — their
  // `dateColumn` names a key that only exists after the daily summary is built.
  const dateColumn = type.sourceDateColumn ?? type.dateColumn;
  const yearMonth = await resolveYearMonth({
    dateColumn,
    // Goes through the runner so a large log is read off-thread instead of
    // stalling every other chat, and comes back as a month tally rather than
    // 150k rows nothing here would use.
    readCounts: () => countYearMonths({ buffer, dateColumn, onProgress }),
    hintText: captionText,
  });

  if (!site) {
    const tempPath = writeTemp(chatId, buffer);
    addPendingUpload(chatId, { tempPath, originalFilename, fileSize, fileType, yearMonth });
    return { status: 'needs_site', fileType, yearMonth };
  }

  return finishOrConfirm({ site, yearMonth, fileType, buffer, originalFilename, fileSize, chatId });
}

/**
 * The next text message after a `needs_site` reply is expected to name the
 * site — and it answers for **every** file still waiting on that chat, not
 * just the most recent one.
 *
 * That is what someone who sends eleven files and then types "SH666 ทั้งหมด"
 * plainly means, and answering for only one of them is how ten uploads went
 * missing before this.
 */
export function resolvePendingSite(chatId, siteInput) {
  const pending = listPendingUploads(chatId);
  if (pending.length === 0) return { status: 'no_pending' };

  const site = normalizeSiteName(siteInput);
  // Leave the queue untouched on an unusable answer: the user gets to try again.
  if (!site) return { status: 'invalid_site' };

  clearPendingUploads(chatId);

  const results = [];
  for (const item of pending) {
    let buffer;
    try {
      buffer = fs.readFileSync(item.temp_path);
    } catch (err) {
      // A temp file that vanished (manual cleanup, a restart mid-flight)
      // must not abort the rest of the batch.
      logger.warn('pending upload temp file missing on resolve', {
        chatId,
        tempPath: item.temp_path,
        message: err?.message,
      });
      results.push({
        status: 'missing_temp',
        fileType: item.file_type,
        originalFilename: item.original_filename,
      });
      continue;
    }
    fs.rmSync(item.temp_path, { force: true });

    results.push(
      finishOrConfirm({
        site,
        yearMonth: item.year_month,
        fileType: item.file_type,
        buffer,
        originalFilename: item.original_filename,
        fileSize: item.file_size,
        chatId,
      }),
    );
  }

  logger.info('resolved pending uploads', { chatId, site, files: results.length });
  return { status: 'resolved', site, results };
}

export function hasPendingUpload(chatId) {
  return countPendingUploads(chatId) > 0;
}

export function hasPendingDuplicate(chatId) {
  return countPendingDuplicates(chatId) > 0;
}

/** Answer to the "ต้องการอัปเดตทับไหม" confirm (spec §3B duplicate rule). */
export function resolvePendingDuplicate(chatId, overwrite) {
  const pending = listPendingDuplicates(chatId);
  if (pending.length === 0) return { status: 'no_pending' };

  clearPendingDuplicates(chatId);

  // One yes/no answers for the whole batch, the same way one site name does.
  // Re-sending a month's files makes every one of them a duplicate at once,
  // so asking per file would mean eleven button presses.
  const results = pending.map((item) => {
    if (!overwrite) {
      fs.rmSync(item.temp_path, { force: true });
      return { status: 'kept_existing', fileType: item.file_type, site: item.site };
    }

    const buffer = fs.readFileSync(item.temp_path);
    fs.rmSync(item.temp_path, { force: true });

    const row = writeFinal({
      site: item.site,
      yearMonth: item.year_month,
      fileType: item.file_type,
      buffer,
      originalFilename: item.original_filename,
      fileSize: item.file_size,
    });
    return {
      status: 'saved',
      site: item.site,
      yearMonth: item.year_month,
      fileType: item.file_type,
      row,
    };
  });

  return { status: 'resolved', results };
}
