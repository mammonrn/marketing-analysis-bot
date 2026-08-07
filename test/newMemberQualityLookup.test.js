/**
 * The reported failure, end to end: a New Member Quality file is uploaded with
 * no site clue, the user answers "SH666", the bot confirms it saved — and then
 * a later question about that very report finds nothing and falls back to
 * daily_value as a proxy.
 *
 * Storage was never the problem. Querying the database after step 2 shows the
 * row under exactly the key every reader looks it up by
 * (shwe666 / 2026-07 / new_member_quality). What failed was `pickFileType`:
 * the question was asked as "คุณภาพ new member ..." and the route only matched
 * the Thai "สมาชิกใหม่", so the question was answered from the wrong report.
 *
 * These tests therefore run the real ingest path against a real SQLite file
 * and assert on both halves — what is stored, and what a question gets back.
 */

import { test, before, after } from 'node:test';
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
let query;

/**
 * The month the file is for. Deliberately relative to now rather than a fixed
 * 2026-07: `buildDataContext` only looks at the last three calendar months, so
 * a hardcoded month would turn this into a test that passes until it silently
 * stops covering anything.
 */
function lastMonth(from = new Date()) {
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() - 1, 1));
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + 1;
  return {
    yearMonth: `${year}-${String(month).padStart(2, '0')}`,
    // Day 0 of the next month is the last day of this one.
    days: new Date(Date.UTC(year, month, 0)).getUTCDate(),
  };
}

const MONTH = lastMonth();

const HEADERS = [
  'Date', 'New', 'New (Ref.)', 'Verify', 'Verify%', '1st New%', '1st New Mems',
  '1st New (BIn)', '1st New (np%)', '1st Day Mems', '1st Day (BIn)', '1st Day (np%)',
];

/**
 * Shaped like the real export: percentages as decimals, money on the raw
 * Power BI scale, and the two trailing rows Power BI adds — a blank one and
 * an "Applied filters:" line — which are not data.
 */
function workbookBuffer() {
  const rows = [];
  for (let day = 1; day <= MONTH.days; day += 1) {
    rows.push([
      `${MONTH.yearMonth}-${String(day).padStart(2, '0')}`,
      700 + day, 10, 500,
      0.755187, 0.0982, 70,
      4.285, 0.9321, 100, 6.104, 0.8908,
    ]);
  }
  rows.push([]);
  rows.push([`Applied filters: Date is ${MONTH.yearMonth}-01 to ${MONTH.yearMonth}-${MONTH.days}`]);

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([HEADERS, ...rows]), 'Sheet1');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ads-analytics-nmq-'));
  process.env.DATA_DIR = tmpDir;

  db = await import('../src/data/db.js');
  db.initDataDb(path.join(tmpDir, 'test.sqlite'));
  ingest = await import('../src/data/ingest.js');
  query = await import('../src/data/query.js');
});

after(() => {
  db?.closeDataDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('a file saved via the "user names the site" reply is found again by a question', async () => {
  const buffer = workbookBuffer();

  const asked = await ingest.ingestUpload({
    buffer,
    originalFilename: 'Daily (1st New & 1st).xlsx',
    fileSize: buffer.length,
    chatId: 'nmq-chat',
    // No site in the caption and none in the filename — this is what puts the
    // upload down the manual path in the first place.
    captionText: '',
  });
  assert.equal(asked.status, 'needs_site');
  assert.equal(asked.fileType, 'new_member_quality');
  assert.equal(asked.yearMonth, MONTH.yearMonth);

  const batch = ingest.resolvePendingSite('nmq-chat', 'SH666');
  assert.equal(batch.status, 'resolved');
  assert.equal(batch.site, 'shwe666', 'what the user typed is stored canonicalised');
  assert.equal(batch.results[0].status, 'saved');

  // The key it was stored under is the key a reader looks it up by.
  const stored = db.findRawFile({
    site: 'shwe666',
    yearMonth: MONTH.yearMonth,
    fileType: 'new_member_quality',
  });
  assert.ok(stored, 'raw_files row is under the canonical site key');

  // And the question that failed now reaches it.
  const context = await query.buildDataContext('shwe666', 'คุณภาพ new member เดือนที่แล้วเป็นยังไง');
  assert.ok(context, 'the question found the uploaded file');
  assert.match(context, /new_member_quality/, 'and was answered from the right report');
});

test('the two trailing Power BI rows are dropped — N is the real number of days', async () => {
  const rows = db.queryParsedRows({
    site: 'shwe666',
    fileType: 'new_member_quality',
    yearMonths: [MONTH.yearMonth],
  });
  assert.equal(
    rows.length,
    MONTH.days,
    'the blank row and the "Applied filters:" trailer are not data',
  );
});

test('percentage columns reach the model already converted, and labelled as such', async () => {
  const context = await query.buildDataContext('shwe666', 'verify rate เดือนที่แล้ว');
  assert.ok(context);

  // Power BI stores these as decimals; the converted companion is what the
  // model must quote. 0.755187 reported as "0.76%" is the failure this guards.
  assert.match(context, /"Verify%_pct":75\.5187/);
  assert.match(context, /"1st New%_pct":9\.82/);
  assert.match(context, /"1st New \(np%\)_pct":93\.21/);
  assert.match(context, /"1st Day \(np%\)_pct":89\.08/);

  // A 31-row file goes down the small-file path, where no summary block is
  // built — so the header is the only place the convention can be stated.
  assert.match(context, /`_pct` คือค่าที่แปลงเป็นเปอร์เซ็นต์เรียบร้อยแล้ว/);
  assert.match(context, /ห้ามนำไปคูณ 100 ซ้ำอีก/);
});

test('both 1st-deposit money columns get a converted companion', async () => {
  const context = await query.buildDataContext('shwe666', '1st new deposit เดือนที่แล้ว');
  assert.ok(context);

  // 4.285 and 6.104 on the file's scale, times SH666's 1000 * 0.787.
  assert.match(context, /"1st New \(BIn\)_THB":3372\.295/);
  assert.match(context, /"1st Day \(BIn\)_THB":4803\.848/);
});

test('every spelling of a site name resolves to one stored key', async () => {
  const buffer = workbookBuffer();
  const seen = new Set();

  for (const [index, spelling] of ['SH666', 'sh666', 'shwe666', 'SHWE666'].entries()) {
    const chatId = `spelling-${index}`;
    const asked = await ingest.ingestUpload({
      buffer,
      // A distinct filename per attempt: an identical name and size would be
      // treated as a duplicate and park on a confirm instead of saving.
      originalFilename: `nmq-${index}.xlsx`,
      fileSize: buffer.length + index,
      chatId,
      captionText: '',
    });
    assert.equal(asked.status, 'needs_site');

    const batch = ingest.resolvePendingSite(chatId, spelling);
    assert.equal(batch.status, 'resolved', `"${spelling}" is a usable answer`);
    seen.add(batch.site);
    assert.equal(batch.results[0].site, 'shwe666', `"${spelling}" is stored as shwe666`);
  }

  assert.deepEqual([...seen], ['shwe666'], 'all four spellings collapse to one key');

  // All four went to the same (site, month, type), so there is still exactly
  // one row — proof they are not four separate sites in the database.
  const rows = db.listRawFiles({ site: 'shwe666' })
    .filter((r) => r.file_type === 'new_member_quality' && r.year_month === MONTH.yearMonth);
  assert.equal(rows.length, 1);
});

test('a site that cannot be resolved is refused, never stored verbatim', async () => {
  const buffer = workbookBuffer();
  const asked = await ingest.ingestUpload({
    buffer,
    originalFilename: 'nmq-unknown.xlsx',
    fileSize: buffer.length + 99,
    chatId: 'unknown-site',
    captionText: '',
  });
  assert.equal(asked.status, 'needs_site');

  const batch = ingest.resolvePendingSite('unknown-site', 'ไม่รู้จักเว็บนี้');
  assert.equal(batch.status, 'invalid_site');
  // The queue survives so the user can answer again.
  assert.equal(ingest.hasPendingUpload('unknown-site'), true);

  ingest.resolvePendingSite('unknown-site', 'SH666');
});
