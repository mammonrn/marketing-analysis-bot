/**
 * Regression tests for the production data-loss bug: `pending_uploads` keyed
 * on `chat_id` alone, so a second file arriving before the user named a site
 * silently replaced the first. Eleven files were sent, one site name was
 * given, and ten uploads were lost — their temp files stranded in
 * DATA/_pending with nothing in the database referring to them.
 */

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as XLSX from 'xlsx';

process.env.TELEGRAM_BOT_TOKEN ??= 'test-token';
process.env.ANTHROPIC_API_KEY ??= 'test-key';

let tmpDir;
let db;
let ingest;
let ROOT;

// Header rows lifted from the real exports, so each fixture lands on a
// different file type — the batch has to keep them apart.
const HEADERS = {
  daily_value: ['Date', 'CIn', 'RTP', 'BIn', 'DAU', 'R'],
  vip: ['Username', 'Last BIn 2 Y', 'BIn', 'BIn Counts'],
  ad_agent: ['AD / Agent', 'Agent', 'Total Mems', 'BIn', 'DAU'],
  referrer: ['Referrer', 'Ref Bonus', 'Total Mems', 'BIn', 'DAU'],
  member_detail: ['Username', 'Referrer', 'BIn', 'Last BIn Date', 'Prefer Game'],
};

function workbook(headers, rowCount = 2) {
  const aoa = [headers];
  for (let i = 0; i < rowCount; i += 1) {
    aoa.push(headers.map((h) => (h === 'Date' ? `2026-07-0${i + 1}` : i + 1)));
  }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Export');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

/** Upload with no site clue anywhere — the case that parks a file as pending. */
function uploadWithoutSite(chatId, key) {
  const buffer = workbook(HEADERS[key]);
  return ingest.ingestUpload({
    buffer,
    originalFilename: `${key}.xlsx`,
    fileSize: buffer.length,
    chatId,
    captionText: '2026-07',
  });
}

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ads-analytics-pending-'));
  process.env.DATA_DIR = tmpDir;
  db = await import('../src/data/db.js');
  ingest = await import('../src/data/ingest.js');
  ({ ROOT } = await import('../src/paths.js'));
});

beforeEach(() => {
  db.closeDataDb?.();
  db.initDataDb(path.join(tmpDir, `t-${Date.now()}-${Math.random()}.sqlite`));
});

after(() => {
  db?.closeDataDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('three files with no site all stay queued instead of overwriting each other', async () => {
  const chatId = 'chat-multi';
  for (const key of ['daily_value', 'vip', 'ad_agent']) {
    const result = await uploadWithoutSite(chatId, key);
    assert.equal(result.status, 'needs_site', `${key} should be parked`);
  }

  assert.equal(db.countPendingUploads(chatId), 3, 'all three must still be waiting');
});

test('one site answer saves every queued file — the reported bug', async () => {
  const chatId = 'chat-batch';
  const keys = ['daily_value', 'vip', 'ad_agent'];
  for (const key of keys) await uploadWithoutSite(chatId, key);

  const batch = ingest.resolvePendingSite(chatId, 'SH666');

  assert.equal(batch.status, 'resolved');
  assert.equal(batch.site, 'shwe666');
  assert.equal(batch.results.length, 3, 'one answer must resolve all three');
  assert.ok(batch.results.every((r) => r.status === 'saved'), JSON.stringify(batch.results));

  // The real check: all three reached storage, not just the last one.
  const stored = db.listRawFiles({ site: 'shwe666' });
  assert.equal(stored.length, 3);
  assert.deepEqual(
    stored.map((r) => r.file_type).sort(),
    ['ad_agent', 'daily_value', 'vip'],
  );

  for (const row of stored) {
    assert.ok(
      fs.existsSync(path.join(ROOT, row.path)),
      `raw file missing on disk: ${row.path}`,
    );
  }
  assert.equal(db.countPendingUploads(chatId), 0, 'the queue must be drained');
});

test('a larger batch resolves completely — eleven files, one answer', async () => {
  const chatId = 'chat-eleven';
  const keys = Object.keys(HEADERS);
  // Five distinct types is all the manifest gives us without collisions;
  // what matters is that nothing is dropped between queueing and storage.
  for (const key of keys) await uploadWithoutSite(chatId, key);
  assert.equal(db.countPendingUploads(chatId), keys.length);

  const batch = ingest.resolvePendingSite(chatId, 'U89');
  assert.equal(batch.results.length, keys.length);
  assert.equal(db.listRawFiles({ site: 'ubet89' }).length, keys.length);
});

test('an unusable site answer leaves the queue intact so it can be retried', async () => {
  const chatId = 'chat-bad-site';
  await uploadWithoutSite(chatId, 'daily_value');
  await uploadWithoutSite(chatId, 'vip');

  const bad = ingest.resolvePendingSite(chatId, 'ไม่ใช่ชื่อเว็บ');
  assert.equal(bad.status, 'invalid_site');
  assert.equal(db.countPendingUploads(chatId), 2, 'nothing may be consumed by a bad answer');

  const good = ingest.resolvePendingSite(chatId, 'SH666');
  assert.equal(good.results.length, 2);
});

test('a missing temp file does not abort the rest of the batch', async () => {
  const chatId = 'chat-missing';
  await uploadWithoutSite(chatId, 'daily_value');
  await uploadWithoutSite(chatId, 'vip');

  // Simulate the stranded-file case: delete one temp file behind the queue.
  const [first] = db.listPendingUploads(chatId);
  fs.rmSync(first.temp_path, { force: true });

  const batch = ingest.resolvePendingSite(chatId, 'SH666');
  assert.equal(batch.results.length, 2);
  assert.equal(batch.results.filter((r) => r.status === 'missing_temp').length, 1);
  assert.equal(batch.results.filter((r) => r.status === 'saved').length, 1);
  assert.equal(db.listRawFiles({ site: 'shwe666' }).length, 1);
});

test('re-sending the whole batch queues every duplicate, not just the last', async () => {
  const chatId = 'chat-dupe';
  const keys = ['daily_value', 'vip', 'ad_agent'];

  for (const key of keys) await uploadWithoutSite(chatId, key);
  ingest.resolvePendingSite(chatId, 'SH666');

  // Same files again: identical filename and size, so each is an exact duplicate.
  for (const key of keys) await uploadWithoutSite(chatId, key);
  const batch = ingest.resolvePendingSite(chatId, 'SH666');

  assert.equal(batch.results.filter((r) => r.status === 'needs_confirm').length, 3);
  assert.equal(db.countPendingDuplicates(chatId), 3, 'all three must await the confirm');

  const confirmed = ingest.resolvePendingDuplicate(chatId, true);
  assert.equal(confirmed.results.length, 3);
  assert.ok(confirmed.results.every((r) => r.status === 'saved'));
  assert.equal(db.listRawFiles({ site: 'shwe666' }).length, 3);
});

test('declining the confirm keeps every existing file and drops every temp', async () => {
  const chatId = 'chat-decline';
  const keys = ['daily_value', 'vip'];

  for (const key of keys) await uploadWithoutSite(chatId, key);
  ingest.resolvePendingSite(chatId, 'SH666');
  for (const key of keys) await uploadWithoutSite(chatId, key);
  ingest.resolvePendingSite(chatId, 'SH666');

  const tempPaths = db.listPendingDuplicates(chatId).map((r) => r.temp_path);
  assert.equal(tempPaths.length, 2);

  const declined = ingest.resolvePendingDuplicate(chatId, false);
  assert.equal(declined.results.length, 2);
  assert.ok(declined.results.every((r) => r.status === 'kept_existing'));
  assert.equal(db.countPendingDuplicates(chatId), 0);
  for (const temp of tempPaths) {
    assert.equal(fs.existsSync(temp), false, 'declined temps must be cleaned up');
  }
});

test('queues are per chat — one chat answering does not consume another', async () => {
  await uploadWithoutSite('chat-a', 'daily_value');
  await uploadWithoutSite('chat-b', 'vip');

  const batch = ingest.resolvePendingSite('chat-a', 'SH666');
  assert.equal(batch.results.length, 1);
  assert.equal(db.countPendingUploads('chat-b'), 1, "chat-b's file must be untouched");
});

/**
 * The production database was created with the old schema, so the upgrade has
 * to carry it forward rather than silently leaving it on `chat_id PRIMARY KEY`
 * (which `CREATE TABLE IF NOT EXISTS` would do).
 */
test('an existing database on the old chat_id-keyed schema migrates without losing rows', async () => {
  const { default: Database } = await import('better-sqlite3');
  const legacyPath = path.join(tmpDir, 'legacy.sqlite');

  // Build the pre-fix schema exactly as it shipped.
  const legacy = new Database(legacyPath);
  legacy.exec(`
    CREATE TABLE pending_uploads (
      chat_id            TEXT PRIMARY KEY,
      temp_path          TEXT NOT NULL,
      original_filename  TEXT NOT NULL,
      file_size          INTEGER NOT NULL,
      file_type          TEXT NOT NULL,
      year_month         TEXT NOT NULL,
      created_at         INTEGER NOT NULL
    );
    CREATE TABLE pending_duplicates (
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
    INSERT INTO pending_uploads VALUES
      ('chat-legacy', '/tmp/legacy-one.xlsx', 'one.xlsx', 111, 'vip', '2026-07', 1);
    INSERT INTO pending_duplicates VALUES
      ('chat-legacy', 7, '/tmp/legacy-dupe.xlsx', 'dupe.xlsx', 222, 'shwe666', '2026-07', 'daily_value', 2);
  `);
  legacy.close();

  db.closeDataDb();
  db.initDataDb(legacyPath);

  // The waiting rows survived the schema change.
  const uploads = db.listPendingUploads('chat-legacy');
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].original_filename, 'one.xlsx');
  assert.equal(uploads[0].file_type, 'vip');
  assert.ok(uploads[0].id > 0, 'the row should now carry a surrogate id');

  const dupes = db.listPendingDuplicates('chat-legacy');
  assert.equal(dupes.length, 1);
  assert.equal(dupes[0].raw_file_id, 7);

  // And the table now accepts a second file for the same chat, which is the
  // whole point of the migration.
  db.addPendingUpload('chat-legacy', {
    tempPath: '/tmp/legacy-two.xlsx',
    originalFilename: 'two.xlsx',
    fileSize: 333,
    fileType: 'ad_agent',
    yearMonth: '2026-07',
  });
  assert.equal(db.countPendingUploads('chat-legacy'), 2);

  // Re-opening an already-migrated database must be a no-op, not a re-run.
  db.closeDataDb();
  db.initDataDb(legacyPath);
  assert.equal(db.countPendingUploads('chat-legacy'), 2);
});
