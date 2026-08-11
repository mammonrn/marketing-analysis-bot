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
// For `dateColumn` only — which file types are a dated time series and so
// cannot legitimately hold a row without a date. `fileTypes.js` imports
// nothing from here, so this introduces no cycle.
import { getFileType } from './fileTypes.js';

let db;

const PENDING_TABLES = ['pending_uploads', 'pending_duplicates'];

/**
 * Both pending tables originally keyed on `chat_id` alone, which is the bug
 * this migration exists to undo. `CREATE TABLE IF NOT EXISTS` would leave an
 * existing database on the old shape for ever, so the old table is renamed
 * out of the way first and its rows copied back afterwards — no waiting
 * upload is dropped by the upgrade.
 */
function setAsideLegacyPendingTables(d) {
  const moved = [];
  for (const table of PENDING_TABLES) {
    const columns = d.prepare(`PRAGMA table_info(${table})`).all();
    // Empty for a table that does not exist yet — a fresh database migrates nothing.
    if (columns.some((column) => column.name === 'chat_id' && column.pk === 1)) {
      d.exec(`ALTER TABLE ${table} RENAME TO ${table}_legacy`);
      moved.push(table);
    }
  }
  return moved;
}

function restoreLegacyPendingRows(d, moved) {
  for (const table of moved) {
    // The legacy table has exactly the new columns minus the new surrogate id.
    const columns = d
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((column) => column.name)
      .filter((name) => name !== 'id')
      .join(', ');

    const { count } = d.prepare(`SELECT COUNT(*) AS count FROM ${table}_legacy`).get();
    d.exec(`INSERT INTO ${table} (${columns}) SELECT ${columns} FROM ${table}_legacy`);
    d.exec(`DROP TABLE ${table}_legacy`);
    logger.info('migrated pending table to one row per file', { table, rows: count });
  }
}

export function initDataDb(sqlitePath = config.session.sqlitePath) {
  fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
  db = new Database(sqlitePath);
  db.pragma('journal_mode = WAL');

  const legacy = setAsideLegacyPendingTables(db);

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
    --
    -- One row per waiting file, NOT one per chat. chat_id used to be the
    -- primary key, so a second upload arriving before the user answered
    -- overwrote the first: eleven files sent at once left ten temp files on
    -- disk with nothing in the database pointing at them.
    CREATE TABLE IF NOT EXISTS pending_uploads (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id            TEXT NOT NULL,
      temp_path          TEXT NOT NULL,
      original_filename  TEXT NOT NULL,
      file_size          INTEGER NOT NULL,
      file_type          TEXT NOT NULL,
      year_month         TEXT NOT NULL,
      created_at         INTEGER NOT NULL,
      UNIQUE (chat_id, temp_path)
    );
    CREATE INDEX IF NOT EXISTS idx_pending_uploads_chat ON pending_uploads(chat_id);

    -- Waiting on a yes/no to overwrite an exact duplicate (spec §3B duplicate rule).
    -- Also one row per file, for the same reason: re-sending a whole month's
    -- batch makes every file in it a duplicate at once.
    CREATE TABLE IF NOT EXISTS pending_duplicates (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id            TEXT NOT NULL,
      raw_file_id        INTEGER NOT NULL,
      temp_path          TEXT NOT NULL,
      original_filename  TEXT NOT NULL,
      file_size          INTEGER NOT NULL,
      site               TEXT NOT NULL,
      year_month         TEXT NOT NULL,
      file_type          TEXT NOT NULL,
      created_at         INTEGER NOT NULL,
      UNIQUE (chat_id, temp_path)
    );
    CREATE INDEX IF NOT EXISTS idx_pending_duplicates_chat ON pending_duplicates(chat_id);

    -- Exchange-rate overrides set from chat.
    --
    -- Deliberately NOT written back to config/site-aliases.json: that file is
    -- in git and deployed, so a bot writing to it would collide with the next
    -- pull and could be silently reverted by a checkout. What changes at
    -- runtime has to live apart from what ships.
    --
    -- Append-only — one row per change, never an update in place — so the
    -- history of who changed what to what survives. The rate in force is the
    -- newest row for that site; previous_rate records what it displaced so a
    -- single row explains the whole change on its own.
    CREATE TABLE IF NOT EXISTS fx_rate_overrides (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      site           TEXT NOT NULL,
      fx_rate        REAL NOT NULL,
      fx_rate_as_of  TEXT NOT NULL,
      previous_rate  REAL,
      updated_by     TEXT NOT NULL,
      updated_at     INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_fx_overrides_site ON fx_rate_overrides(site, id DESC);

    -- When each site was last warned that its rate is older than its data,
    -- so the warning does not repeat on every upload.
    CREATE TABLE IF NOT EXISTS fx_rate_alerts (
      site             TEXT PRIMARY KEY,
      last_alerted_at  INTEGER NOT NULL
    );

    -- A rate change waiting on its confirm. In SQLite rather than memory for
    -- the same reason the upload confirms are: a restart between the question
    -- and the answer would otherwise leave a live button wired to nothing.
    -- One at a time per chat — a second request replaces the first.
    CREATE TABLE IF NOT EXISTS pending_fx_updates (
      chat_id       TEXT PRIMARY KEY,
      site          TEXT NOT NULL,
      fx_rate       REAL NOT NULL,
      previous_rate REAL,
      requested_by  TEXT NOT NULL,
      created_at    INTEGER NOT NULL
    );

    -- Where a chat has got to in a menu flow: which flow it started, which
    -- metric it picked, which site, which month. Here rather than in memory
    -- for the same reason as every other pending row above — the buttons the
    -- user is looking at outlive a restart, and a half-made selection that
    -- silently evaporated would answer the next tap with the wrong month.
    --
    -- One selection per chat: starting a flow replaces whatever was in
    -- progress, and "❌ ยกเลิก" deletes the row outright.
    CREATE TABLE IF NOT EXISTS menu_selections (
      chat_id     TEXT PRIMARY KEY,
      flow        TEXT NOT NULL,
      metric      TEXT,
      site        TEXT,
      year_month  TEXT,
      created_at  INTEGER NOT NULL
    );
  `);

  restoreLegacyPendingRows(db, legacy);

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

export function listRawFiles({ site, yearMonth } = {}) {
  const d = requireDb();
  if (site && yearMonth) {
    return d
      .prepare('SELECT * FROM raw_files WHERE site = ? AND year_month = ? ORDER BY file_type')
      .all(site, yearMonth);
  }
  return site
    ? d.prepare('SELECT * FROM raw_files WHERE site = ? ORDER BY year_month DESC, file_type').all(site)
    : d.prepare('SELECT * FROM raw_files ORDER BY site, year_month DESC, file_type').all();
}

/**
 * The months this site actually has files for, newest first.
 *
 * The month picker is built from this rather than from the calendar: offering
 * a month with nothing behind it produces a dashboard of empty sections, and
 * the user has no way to tell that apart from a month whose data is bad.
 */
export function listRawFileMonths(site) {
  return requireDb()
    .prepare('SELECT DISTINCT year_month FROM raw_files WHERE site = ? ORDER BY year_month DESC')
    .all(site)
    .map((row) => row.year_month);
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

/**
 * Rows for a site/file-type across up to `monthsBack` calendar months (spec
 * §3B comparison scope).
 *
 * On a dated time series, a row with no `row_date` is Power BI furniture — the
 * `Total` row holding the month's own sums, or the `Applied filters:` trailer.
 * `dropNonDataRows` has discarded both at the read since PR #9, so a file
 * parsed after that never produces one. Rows parsed *before* it are still in
 * the table, and `parsed = 1` means they are never re-read: the month sits
 * there permanently carrying a 32nd "day" whose figures are the other 31 added
 * up. Every sum over it comes out roughly doubled and every maximum ~31x a
 * real day.
 *
 * The guard therefore belongs here rather than in either caller. Both
 * `query.js` and `session/monthlyReport.js` were affected — the dashboard
 * visibly, the chat path latently, escaping only because a monthly export is
 * 33 rows and slips under `DETAIL_ROW_LIMIT` into the send-every-row branch
 * instead of the statistics one. One filter at the single point they share
 * fixes both, and any future consumer with them.
 *
 * Conditional on `dateColumn`, and that is load-bearing: the snapshot exports
 * (vip, brand_game_value, referrer, ad_agent, the hour pivots) have no date
 * axis at all, so `row_date` is null on every one of their rows. Filtering
 * unconditionally would return nothing for them and blank half the dashboard.
 */
export function queryParsedRows({ site, fileType, yearMonths }) {
  const d = requireDb();
  const placeholders = yearMonths.map(() => '?').join(',');
  const datedSeries = Boolean(getFileType(fileType)?.dateColumn);

  return d
    .prepare(
      `SELECT * FROM parsed_rows
       WHERE site = ? AND file_type = ? AND year_month IN (${placeholders})
         ${datedSeries ? 'AND row_date IS NOT NULL' : ''}
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

/** Adds one waiting file. Several may wait on the same chat at once. */
export function addPendingUpload(chatId, data) {
  requireDb()
    .prepare(
      `INSERT INTO pending_uploads (chat_id, temp_path, original_filename, file_size, file_type, year_month, created_at)
       VALUES (@chatId, @tempPath, @originalFilename, @fileSize, @fileType, @yearMonth, @createdAt)
       ON CONFLICT(chat_id, temp_path) DO UPDATE SET
         original_filename = excluded.original_filename,
         file_size = excluded.file_size, file_type = excluded.file_type,
         year_month = excluded.year_month, created_at = excluded.created_at`,
    )
    .run({ chatId: String(chatId), createdAt: now(), ...data });
}

/** Oldest first, so a batch is processed in the order it was sent. */
export function listPendingUploads(chatId) {
  return requireDb()
    .prepare('SELECT * FROM pending_uploads WHERE chat_id = ? ORDER BY id')
    .all(String(chatId));
}

export function countPendingUploads(chatId) {
  return requireDb()
    .prepare('SELECT COUNT(*) AS count FROM pending_uploads WHERE chat_id = ?')
    .get(String(chatId)).count;
}

export function clearPendingUploads(chatId) {
  requireDb().prepare('DELETE FROM pending_uploads WHERE chat_id = ?').run(String(chatId));
}

export function addPendingDuplicate(chatId, data) {
  requireDb()
    .prepare(
      `INSERT INTO pending_duplicates
         (chat_id, raw_file_id, temp_path, original_filename, file_size, site, year_month, file_type, created_at)
       VALUES (@chatId, @rawFileId, @tempPath, @originalFilename, @fileSize, @site, @yearMonth, @fileType, @createdAt)
       ON CONFLICT(chat_id, temp_path) DO UPDATE SET
         raw_file_id = excluded.raw_file_id,
         original_filename = excluded.original_filename, file_size = excluded.file_size,
         site = excluded.site, year_month = excluded.year_month, file_type = excluded.file_type,
         created_at = excluded.created_at`,
    )
    .run({ chatId: String(chatId), createdAt: now(), ...data });
}

export function listPendingDuplicates(chatId) {
  return requireDb()
    .prepare('SELECT * FROM pending_duplicates WHERE chat_id = ? ORDER BY id')
    .all(String(chatId));
}

export function countPendingDuplicates(chatId) {
  return requireDb()
    .prepare('SELECT COUNT(*) AS count FROM pending_duplicates WHERE chat_id = ?')
    .get(String(chatId)).count;
}

export function clearPendingDuplicates(chatId) {
  requireDb().prepare('DELETE FROM pending_duplicates WHERE chat_id = ?').run(String(chatId));
}

// --- exchange rates ---------------------------------------------------------

/** Appends a rate change. Never updates in place — the history is the point. */
export function insertFxRateOverride({ site, fxRate, fxRateAsOf, previousRate, updatedBy }) {
  requireDb()
    .prepare(
      `INSERT INTO fx_rate_overrides (site, fx_rate, fx_rate_as_of, previous_rate, updated_by, updated_at)
       VALUES (@site, @fxRate, @fxRateAsOf, @previousRate, @updatedBy, @updatedAt)`,
    )
    .run({ site, fxRate, fxRateAsOf, previousRate: previousRate ?? null, updatedBy: String(updatedBy), updatedAt: now() });
}

/** The rate in force for one site, or undefined when config still governs it. */
export function latestFxRateOverride(site) {
  return requireDb()
    .prepare('SELECT * FROM fx_rate_overrides WHERE site = ? ORDER BY id DESC LIMIT 1')
    .get(site);
}

/** The newest row per site, for loading every override at startup in one pass. */
export function latestFxRateOverrides() {
  return requireDb()
    .prepare(
      `SELECT o.* FROM fx_rate_overrides o
       JOIN (SELECT site, MAX(id) AS id FROM fx_rate_overrides GROUP BY site) newest
         ON newest.id = o.id`,
    )
    .all();
}

export function listFxRateHistory(site, limit = 10) {
  return requireDb()
    .prepare('SELECT * FROM fx_rate_overrides WHERE site = ? ORDER BY id DESC LIMIT ?')
    .all(site, limit);
}

export function getFxRateAlert(site) {
  return requireDb().prepare('SELECT * FROM fx_rate_alerts WHERE site = ?').get(site);
}

export function recordFxRateAlert(site, at = now()) {
  requireDb()
    .prepare(
      `INSERT INTO fx_rate_alerts (site, last_alerted_at) VALUES (?, ?)
       ON CONFLICT(site) DO UPDATE SET last_alerted_at = excluded.last_alerted_at`,
    )
    .run(site, at);
}

export function setPendingFxUpdate(chatId, { site, fxRate, previousRate, requestedBy }) {
  requireDb()
    .prepare(
      `INSERT INTO pending_fx_updates (chat_id, site, fx_rate, previous_rate, requested_by, created_at)
       VALUES (@chatId, @site, @fxRate, @previousRate, @requestedBy, @createdAt)
       ON CONFLICT(chat_id) DO UPDATE SET
         site = excluded.site, fx_rate = excluded.fx_rate,
         previous_rate = excluded.previous_rate, requested_by = excluded.requested_by,
         created_at = excluded.created_at`,
    )
    .run({
      chatId: String(chatId),
      site,
      fxRate,
      previousRate: previousRate ?? null,
      requestedBy: String(requestedBy),
      createdAt: now(),
    });
}

export function getPendingFxUpdate(chatId) {
  return requireDb()
    .prepare('SELECT * FROM pending_fx_updates WHERE chat_id = ?')
    .get(String(chatId));
}

export function clearPendingFxUpdate(chatId) {
  requireDb().prepare('DELETE FROM pending_fx_updates WHERE chat_id = ?').run(String(chatId));
}

// --- menu flow state --------------------------------------------------------

/** Starts a flow, discarding whatever selection was half-made before it. */
export function startMenuSelection(chatId, { flow, metric = null }) {
  requireDb()
    .prepare(
      `INSERT INTO menu_selections (chat_id, flow, metric, site, year_month, created_at)
       VALUES (@chatId, @flow, @metric, NULL, NULL, @createdAt)
       ON CONFLICT(chat_id) DO UPDATE SET
         flow = excluded.flow, metric = excluded.metric,
         site = NULL, year_month = NULL, created_at = excluded.created_at`,
    )
    .run({ chatId: String(chatId), flow, metric, createdAt: now() });
}

/**
 * Fills in one step of the flow. Returns the updated row, or `null` when
 * nothing was in progress — a button from a cancelled or expired flow must not
 * quietly create a new selection with only half its fields set.
 */
export function updateMenuSelection(chatId, patch) {
  const d = requireDb();
  const key = String(chatId);
  // Through getMenuSelection so an aged-out selection is refused here too — a
  // button pressed a week later must not revive the flow it belonged to.
  const existing = getMenuSelection(key);
  if (!existing) return null;

  d.prepare('UPDATE menu_selections SET metric = ?, site = ?, year_month = ? WHERE chat_id = ?').run(
    'metric' in patch ? patch.metric : existing.metric,
    'site' in patch ? patch.site : existing.site,
    'yearMonth' in patch ? patch.yearMonth : existing.year_month,
    key,
  );
  return d.prepare('SELECT * FROM menu_selections WHERE chat_id = ?').get(key);
}

/**
 * How long a half-made selection stays live.
 *
 * It has to expire, because the keyboard that made it never does: a site
 * button tapped out of a week-old message would otherwise resume a flow whose
 * context the user has long forgotten, and answer with a month they picked for
 * a different question. A day is generous for "I got interrupted mid-flow" and
 * short enough that a stale tap lands on the "เริ่มใหม่จากเมนูหลัก" reply
 * instead of on a silent answer.
 */
const MENU_SELECTION_TTL_MS = 24 * 60 * 60 * 1000;

/** The live selection for this chat, or `null` if there is none or it aged out. */
export function getMenuSelection(chatId, { ttlMs = MENU_SELECTION_TTL_MS } = {}) {
  const key = String(chatId);
  const row = requireDb().prepare('SELECT * FROM menu_selections WHERE chat_id = ?').get(key);
  if (!row) return null;

  if (now() - row.created_at > ttlMs) {
    // Cleaned up on read rather than by a sweeper: there is at most one row per
    // chat, so the table cannot grow, and the only moment staleness matters is
    // the moment someone asks.
    clearMenuSelection(key);
    return null;
  }
  return row;
}

export function clearMenuSelection(chatId) {
  return requireDb()
    .prepare('DELETE FROM menu_selections WHERE chat_id = ?')
    .run(String(chatId)).changes;
}

/**
 * How recent this site's data actually is, as `YYYY-MM-DD`.
 *
 * Both sources are consulted because neither is complete on its own: parsing
 * is lazy, so a file uploaded seconds ago has no `parsed_rows` yet and only
 * its `year_month` is known; and retention deletes old `raw_files` while
 * keeping the parsed rows. A month with no per-row dates counts as its last
 * day — the newest data it could possibly contain.
 */
export function latestDataDate(site) {
  const d = requireDb();
  const { rowDate } = d
    .prepare('SELECT MAX(row_date) AS rowDate FROM parsed_rows WHERE site = ?')
    .get(site);
  const { yearMonth } = d
    .prepare('SELECT MAX(year_month) AS yearMonth FROM raw_files WHERE site = ?')
    .get(site);

  const candidates = [rowDate];
  if (yearMonth) {
    const [year, month] = yearMonth.split('-').map(Number);
    // Day 0 of the next month is the last day of this one.
    candidates.push(new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10));
  }

  const known = candidates.filter(Boolean).sort();
  return known.length > 0 ? known[known.length - 1] : null;
}

export function closeDataDb() {
  if (db) {
    db.close();
    db = undefined;
  }
}
