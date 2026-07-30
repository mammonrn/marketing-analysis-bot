/**
 * File-ingestion storage (spec §3B).
 *
 * A second connection to the same SQLite file the session store uses
 * (`config.session.sqlitePath`) — one file for the whole bot per the repo's
 * own decision log (spec §9 Q2), WAL mode makes two same-process connections
 * to it safe, and it keeps this module independent of `session/store.js`'s
 * internal singleton.
 *
 * `parsed_rows` is one shared table for every file type instead of five
 * bespoke ones — see the comment in `fileTypes.js` for why. `file_type`
 * plus `site`/`year_month`/`row_date` are the only columns queries filter
 * on; everything else stays inside `row_json` exactly as read from the
 * workbook, so `transform.js`'s `normaliseRow`/`deriveMetrics` (which key
 * off the original column names) work unchanged at query time.
 */

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from '../config.js';
import { logger } from '../logger.js';

let db;

export function initDataDb(sqlitePath = config.session.sqlitePath) {
  fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
  db = new Database(sqlitePath);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS raw_files (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      site                TEXT NOT NULL,
      year_month          TEXT NOT NULL,
      file_type           TEXT NOT NULL,
      path                TEXT NOT NULL,
      file_size           INTEGER NOT NULL,
      original_filename   TEXT NOT NULL,
      uploaded_at          INTEGER NOT NULL,
      parsed              INTEGER NOT NULL DEFAULT 0,
      UNIQUE (site, year_month, file_type)
    );

    -- raw_file_id is informational, not an enforced foreign key: retention
    -- (spec §3B) deletes old raw_files rows but keeps parsed_rows, since the
    -- parsed cache is much lighter than the raw workbook and worth retaining
    -- even after the source file itself has aged out.
    CREATE TABLE IF NOT EXISTS parsed_rows (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      raw_file_id   INTEGER NOT NULL,
      file_type     TEXT NOT NULL,
      site          TEXT NOT NULL,
      year_month    TEXT NOT NULL,
      row_date      TEXT,
      row_json      TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_parsed_rows_lookup
      ON parsed_rows(site, file_type, year_month);

    -- Waiting on the user to name a site for an upload we couldn't guess (spec §3B step 1).
    CREATE TABLE IF NOT EXISTS pending_uploads (
      chat_id            TEXT PRIMARY KEY,
      temp_path          TEXT NOT NULL,
      original_filename  TEXT NOT NULL,
      file_size          INTEGER NOT NULL,
      file_type          TEXT NOT NULL,
      year_month         TEXT NOT NULL,
      created_at         INTEGER NOT NULL
    );

    -- Waiting on a yes/no to overwrite an exact duplicate (spec §3B duplicate rule).
    CREATE TABLE IF NOT EXISTS pending_duplicates (
      chat_id            TEXT PRIMARY KEY,
      raw_file_id        INTEGER NOT NULL,
      temp_path          TEXT NOT NULL,
      original_filename  TEXT NOT NULL,
      file_size          INTEGER NOT NULL,
      site               TEXT NOT NULL,
      year_month         TEXT NOT NULL,
      file_type          TEXT NOT NULL,
      created_at         INTEGER NOT NULL
    );
  `);

  logger.info('data store ready', { path: sqlitePath });
  return db;
}

function requireDb() {
  if (!db) throw new Error('Data store not initialised — call initDataDb() first');
  return db;
}

const now = () => Date.now();

export function findRawFile({ site, yearMonth, fileType }) {
  return requireDb()
    .prepare('SELECT * FROM raw_files WHERE site = ? AND year_month = ? AND file_type = ?')
    .get(site, yearMonth, fileType);
}

export function getRawFile(id) {
  return requireDb().prepare('SELECT * FROM raw_files WHERE id = ?').get(id);
}

/** Insert a brand-new (site, year_month, file_type), or overwrite the existing one — spec §3B "update" path (no confirm needed). */
export function upsertRawFile({ site, yearMonth, fileType, relPath, fileSize, originalFilename }) {
  const d = requireDb();
  d.prepare(
    `INSERT INTO raw_files (site, year_month, file_type, path, file_size, original_filename, uploaded_at, parsed)
     VALUES (@site, @yearMonth, @fileType, @relPath, @fileSize, @originalFilename, @uploadedAt, 0)
     ON CONFLICT(site, year_month, file_type) DO UPDATE SET
       path = excluded.path,
       file_size = excluded.file_size,
       original_filename = excluded.original_filename,
       uploaded_at = excluded.uploaded_at,
       parsed = 0`,
  ).run({ site, yearMonth, fileType, relPath, fileSize, originalFilename, uploadedAt: now() });

  const row = findRawFile({ site, yearMonth, fileType });
  // A prior version's rows are stale the moment the file underneath them changes.
  d.prepare('DELETE FROM parsed_rows WHERE raw_file_id = ?').run(row.id);
  return row;
}

export function markParsed(rawFileId) {
  requireDb().prepare('UPDATE raw_files SET parsed = 1 WHERE id = ?').run(rawFileId);
}

export function listRawFiles({ site } = {}) {
  const d = requireDb();
  return site
    ? d.prepare('SELECT * FROM raw_files WHERE site = ? ORDER BY year_month DESC, file_type').all(site)
    : d.prepare('SELECT * FROM raw_files ORDER BY site, year_month DESC, file_type').all();
}

export function insertParsedRows(rawFileId, { fileType, site, yearMonth, rows }) {
  const d = requireDb();
  const insert = d.prepare(
    `INSERT INTO parsed_rows (raw_file_id, file_type, site, year_month, row_date, row_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const tx = d.transaction((items) => {
    for (const item of items) {
      insert.run(rawFileId, fileType, site, yearMonth, item.rowDate ?? null, JSON.stringify(item.row));
    }
  });
  tx(rows);
}

/** Rows for a site/file-type across up to `monthsBack` calendar months (spec §3B comparison scope). */
export function queryParsedRows({ site, fileType, yearMonths }) {
  const d = requireDb();
  const placeholders = yearMonths.map(() => '?').join(',');
  return d
    .prepare(
      `SELECT * FROM parsed_rows
       WHERE site = ? AND file_type = ? AND year_month IN (${placeholders})
       ORDER BY year_month, row_date`,
    )
    .all(site, fileType, ...yearMonths)
    .map((r) => ({ ...r, row: JSON.parse(r.row_json) }));
}

export function rawFilesOlderThan(cutoffMs) {
  return requireDb().prepare('SELECT * FROM raw_files WHERE uploaded_at < ?').all(cutoffMs);
}

export function deleteRawFile(id) {
  requireDb().prepare('DELETE FROM raw_files WHERE id = ?').run(id);
}

export function setPendingUpload(chatId, data) {
  requireDb()
    .prepare(
      `INSERT INTO pending_uploads (chat_id, temp_path, original_filename, file_size, file_type, year_month, created_at)
       VALUES (@chatId, @tempPath, @originalFilename, @fileSize, @fileType, @yearMonth, @createdAt)
       ON CONFLICT(chat_id) DO UPDATE SET
         temp_path = excluded.temp_path, original_filename = excluded.original_filename,
         file_size = excluded.file_size, file_type = excluded.file_type,
         year_month = excluded.year_month, created_at = excluded.created_at`,
    )
    .run({ chatId: String(chatId), createdAt: now(), ...data });
}

export function getPendingUpload(chatId) {
  return requireDb().prepare('SELECT * FROM pending_uploads WHERE chat_id = ?').get(String(chatId));
}

export function clearPendingUpload(chatId) {
  requireDb().prepare('DELETE FROM pending_uploads WHERE chat_id = ?').run(String(chatId));
}

export function setPendingDuplicate(chatId, data) {
  requireDb()
    .prepare(
      `INSERT INTO pending_duplicates
         (chat_id, raw_file_id, temp_path, original_filename, file_size, site, year_month, file_type, created_at)
       VALUES (@chatId, @rawFileId, @tempPath, @originalFilename, @fileSize, @site, @yearMonth, @fileType, @createdAt)
       ON CONFLICT(chat_id) DO UPDATE SET
         raw_file_id = excluded.raw_file_id, temp_path = excluded.temp_path,
         original_filename = excluded.original_filename, file_size = excluded.file_size,
         site = excluded.site, year_month = excluded.year_month, file_type = excluded.file_type,
         created_at = excluded.created_at`,
    )
    .run({ chatId: String(chatId), createdAt: now(), ...data });
}

export function getPendingDuplicate(chatId) {
  return requireDb().prepare('SELECT * FROM pending_duplicates WHERE chat_id = ?').get(String(chatId));
}

export function clearPendingDuplicate(chatId) {
  requireDb().prepare('DELETE FROM pending_duplicates WHERE chat_id = ?').run(String(chatId));
}

export function closeDataDb() {
  if (db) {
    db.close();
    db = undefined;
  }
}
