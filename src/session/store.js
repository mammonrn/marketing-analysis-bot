/**
 * Session state (spec §5).
 *
 * SQLite rather than Redis: the VPS has 4GB RAM shared with telegram-ads-bot,
 * traffic is a handful of internal users, and a single file means no extra
 * service to install or keep alive (spec §9 question 2 — this is the spec's own
 * recommendation, taken as the default).
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { config } from '../config.js';
import { logger } from '../logger.js';

let db;

export function initDb(sqlitePath = config.session.sqlitePath) {
  fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
  db = new Database(sqlitePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    -- No summary_prompted_at column: it existed only so the sweeper would not
    -- ask the same session twice, and the sweeper no longer asks anything — it
    -- closes the session, which archives the turns and takes it out of
    -- findIdleSessions on its own. An existing database keeps the column;
    -- nothing reads or writes it.
    CREATE TABLE IF NOT EXISTS sessions (
      chat_id      TEXT PRIMARY KEY,
      user_id      TEXT NOT NULL,
      site         TEXT,
      last_active  INTEGER NOT NULL,
      created_at   INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS turns (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id       TEXT NOT NULL,
      question      TEXT NOT NULL,
      site          TEXT,
      metrics_json  TEXT NOT NULL DEFAULT '[]',
      reply         TEXT,
      response_kind TEXT,
      ts            INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_turns_chat ON turns(chat_id, ts);

    -- spec §5.3 step 4 allows archiving instead of hard-deleting, which keeps a
    -- trail of what was answered without bloating the live session.
    CREATE TABLE IF NOT EXISTS turn_archive (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id       TEXT NOT NULL,
      question      TEXT NOT NULL,
      site          TEXT,
      metrics_json  TEXT NOT NULL DEFAULT '[]',
      reply         TEXT,
      response_kind TEXT,
      ts            INTEGER NOT NULL,
      archived_at   INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS summaries (
      token        TEXT PRIMARY KEY,
      chat_id      TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at   INTEGER NOT NULL,
      consumed_at  INTEGER
    );

    -- Separate from the summaries table because the lifetime differs by an order
    -- of magnitude: a session payload is a one-hour capability handed to one
    -- chat, a monthly dashboard is a link people forward to each other and
    -- reopen for weeks. Keeping them in one table would mean one pruning rule
    -- and one expiry for two very different things.
    CREATE TABLE IF NOT EXISTS monthly_dashboards (
      token        TEXT PRIMARY KEY,
      site         TEXT NOT NULL,
      year_month   TEXT NOT NULL,
      chat_id      TEXT,
      payload_json TEXT NOT NULL,
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL
    );
    -- One live link per (site, month): the uniqueness is what makes the token
    -- reusable instead of a new one per tap.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_monthly_dashboards_key
      ON monthly_dashboards(site, year_month);
  `);

  logger.info('session store ready', { path: sqlitePath });
  return db;
}

function requireDb() {
  if (!db) throw new Error('Session store not initialised — call initDb() first');
  return db;
}

const now = () => Date.now();

export function getOrCreateSession(chatId, userId) {
  const d = requireDb();
  const key = String(chatId);
  const existing = d.prepare('SELECT * FROM sessions WHERE chat_id = ?').get(key);
  if (existing) return existing;

  d.prepare(
    'INSERT INTO sessions (chat_id, user_id, site, last_active, created_at) VALUES (?, ?, NULL, ?, ?)',
  ).run(key, String(userId), now(), now());
  return d.prepare('SELECT * FROM sessions WHERE chat_id = ?').get(key);
}

export function getSession(chatId) {
  return requireDb().prepare('SELECT * FROM sessions WHERE chat_id = ?').get(String(chatId));
}

/** Any activity resets the idle clock. */
export function touchSession(chatId) {
  requireDb()
    .prepare('UPDATE sessions SET last_active = ? WHERE chat_id = ?')
    .run(now(), String(chatId));
}

/** Remember the site so the user need not repeat it every turn (spec §5.1). */
export function setSessionSite(chatId, site) {
  if (!site) return;
  requireDb().prepare('UPDATE sessions SET site = ? WHERE chat_id = ?').run(site, String(chatId));
}

export function addTurn(chatId, { question, site, metrics, reply, responseKind }) {
  requireDb()
    .prepare(
      `INSERT INTO turns (chat_id, question, site, metrics_json, reply, response_kind, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      String(chatId),
      question,
      site ?? null,
      JSON.stringify(metrics ?? []),
      reply ?? null,
      responseKind ?? null,
      now(),
    );
}

export function getTurns(chatId) {
  return requireDb()
    .prepare('SELECT * FROM turns WHERE chat_id = ? ORDER BY ts ASC')
    .all(String(chatId))
    .map((row) => ({
      ...row,
      metrics: safeParse(row.metrics_json, []),
    }));
}

export function countTurns(chatId) {
  return requireDb()
    .prepare('SELECT COUNT(*) AS n FROM turns WHERE chat_id = ?')
    .get(String(chatId)).n;
}

/**
 * Sessions that have gone quiet and still hold turns.
 *
 * The turns requirement is what keeps the sweeper from looping: someone who
 * said hello and left has nothing to close, and a session that was just closed
 * has had its turns archived, so it drops out of this query until the next
 * question arrives.
 */
export function findIdleSessions(idleMinutes = config.session.idleMinutes) {
  const cutoff = now() - idleMinutes * 60_000;
  return requireDb()
    .prepare(
      `SELECT s.* FROM sessions s
       WHERE s.last_active < ?
         AND EXISTS (SELECT 1 FROM turns t WHERE t.chat_id = s.chat_id)`,
    )
    .all(cutoff);
}

/** Archive the turns, then reset the live session (spec §5.3 step 4). */
export function clearSession(chatId) {
  const d = requireDb();
  const key = String(chatId);
  const tx = d.transaction(() => {
    d.prepare(
      `INSERT INTO turn_archive (chat_id, question, site, metrics_json, reply, response_kind, ts, archived_at)
       SELECT chat_id, question, site, metrics_json, reply, response_kind, ts, ? FROM turns WHERE chat_id = ?`,
    ).run(now(), key);
    d.prepare('DELETE FROM turns WHERE chat_id = ?').run(key);
    d.prepare('UPDATE sessions SET last_active = ? WHERE chat_id = ?').run(now(), key);
  });
  tx();
}

/**
 * Stash a dashboard payload for the Mini App to fetch.
 * The token is the capability: it is unguessable, single-use, and short-lived,
 * so the Mini App URL can be handed to Telegram without exposing chat data.
 */
export function createSummaryToken(chatId, payload) {
  const token = crypto.randomBytes(24).toString('base64url');
  requireDb()
    .prepare('INSERT INTO summaries (token, chat_id, payload_json, created_at) VALUES (?, ?, ?, ?)')
    .run(token, String(chatId), JSON.stringify(payload), now());
  return token;
}

export function readSummary(token, { maxAgeMinutes = 60 } = {}) {
  const row = requireDb().prepare('SELECT * FROM summaries WHERE token = ?').get(token);
  if (!row) return null;
  if (now() - row.created_at > maxAgeMinutes * 60_000) return null;
  return safeParse(row.payload_json, null);
}

/**
 * The monthly dashboard link, which is a different kind of thing from the
 * session token above.
 *
 * Telegram strips `web_app` buttons out of a forwarded message, so the only
 * copy of the link that survives a forward is the URL printed in the message
 * body — and that URL is useless if the token behind it was single-use and
 * expired in an hour. So this token is keyed by (site, month) and reused:
 * every tap on "สรุปเดือน" for July/SH666 hands back the same URL with fresh
 * data behind it, and every copy of that URL anyone forwarded keeps working
 * until the link expires.
 *
 * Losing single-use is why the page in front of it now asks for a PIN
 * (src/miniapp/pin.js) — the token alone is no longer treated as the secret.
 *
 * Hex rather than base64url: the URL is printed as plain text into a Markdown
 * message, and `_` in a token is exactly what makes Telegram mangle it.
 */
export function createMonthlyDashboardToken(
  { site, yearMonth, chatId, payload },
  { ttlDays = config.dashboard.monthlyLinkDays } = {},
) {
  if (!site || !yearMonth) throw new Error('createMonthlyDashboardToken needs a site and a yearMonth');
  const d = requireDb();
  const ts = now();
  const cutoff = ts - ttlDays * 86_400_000;

  const existing = d
    .prepare('SELECT token, created_at FROM monthly_dashboards WHERE site = ? AND year_month = ?')
    .get(site, yearMonth);

  // Refresh in place while the link is still live. Expiry is measured from
  // when the token was first handed out, so re-running the report cannot keep
  // one URL alive forever — past the TTL the row is replaced and old copies
  // of the link stop resolving.
  if (existing && existing.created_at > cutoff) {
    d.prepare('UPDATE monthly_dashboards SET payload_json = ?, chat_id = ?, updated_at = ? WHERE token = ?')
      .run(JSON.stringify(payload), chatId == null ? null : String(chatId), ts, existing.token);
    return existing.token;
  }

  const token = crypto.randomBytes(32).toString('hex');
  const tx = d.transaction(() => {
    if (existing) d.prepare('DELETE FROM monthly_dashboards WHERE token = ?').run(existing.token);
    d.prepare(
      `INSERT INTO monthly_dashboards (token, site, year_month, chat_id, payload_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(token, site, yearMonth, chatId == null ? null : String(chatId), JSON.stringify(payload), ts, ts);
  });
  tx();
  return token;
}

export function readMonthlyDashboard(token, { ttlDays = config.dashboard.monthlyLinkDays } = {}) {
  const row = requireDb().prepare('SELECT * FROM monthly_dashboards WHERE token = ?').get(String(token ?? ''));
  if (!row) return null;
  if (now() - row.created_at > ttlDays * 86_400_000) return null;
  return safeParse(row.payload_json, null);
}

/** Housekeeping so the file does not grow without bound on a small VPS. */
export function pruneOldData({
  summaryDays = 7,
  archiveDays = 90,
  monthlyLinkDays = config.dashboard.monthlyLinkDays,
} = {}) {
  const d = requireDb();
  const summaries = d
    .prepare('DELETE FROM summaries WHERE created_at < ?')
    .run(now() - summaryDays * 86_400_000);
  const archive = d
    .prepare('DELETE FROM turn_archive WHERE archived_at < ?')
    .run(now() - archiveDays * 86_400_000);
  // Expired links are already refused by readMonthlyDashboard; this is only so
  // the file does not carry dead rows forever.
  const monthly = d
    .prepare('DELETE FROM monthly_dashboards WHERE created_at < ?')
    .run(now() - monthlyLinkDays * 86_400_000);
  if (summaries.changes || archive.changes || monthly.changes) {
    logger.info('pruned old session data', {
      summaries: summaries.changes,
      archivedTurns: archive.changes,
      monthlyDashboards: monthly.changes,
    });
  }
}

function safeParse(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

export function closeDb() {
  if (db) {
    db.close();
    db = undefined;
  }
}
