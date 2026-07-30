import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';

// config.js resolves DATA_DIR at import time, so the env has to be set before
// anything in the module graph is evaluated — same reasoning as session.test.js.
process.env.TELEGRAM_BOT_TOKEN ??= 'test-token';
process.env.ANTHROPIC_API_KEY ??= 'test-key';

let tmpDir;
let db;
let ingest;
let ROOT;

async function workbookBuffer(headers, rows) {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('Sheet1');
  sheet.addRow(headers);
  for (const row of rows) sheet.addRow(headers.map((h) => row[h] ?? null));
  return wb.xlsx.writeBuffer();
}

const DAILY_HEADERS = ['Date', 'RTP', 'BIn', 'DAU', 'R'];
const dailyRows = () => [
  { Date: '2026-06-01', RTP: 0.95, BIn: 400000, DAU: 470, R: 90000 },
  { Date: '2026-06-02', RTP: 0.96, BIn: 410000, DAU: 480, R: 91000 },
];

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ads-analytics-ingest-'));
  process.env.DATA_DIR = tmpDir;

  db = await import('../src/data/db.js');
  db.initDataDb(path.join(tmpDir, 'test.sqlite'));
  ingest = await import('../src/data/ingest.js');
  ({ ROOT } = await import('../src/paths.js'));
});

after(() => {
  db?.closeDataDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('an unrecognised header set is rejected without touching storage', async () => {
  const buffer = await workbookBuffer(['Foo', 'Bar'], [{ Foo: 1, Bar: 2 }]);
  const result = await ingest.ingestUpload({
    buffer,
    originalFilename: 'mystery.xlsx',
    fileSize: buffer.length,
    chatId: 'chat-1',
    captionText: '',
  });
  assert.equal(result.status, 'unrecognized');
});

test('a file with no site clue asks, then resolves on the next reply — folder matches spec §3B', async () => {
  const buffer = await workbookBuffer(DAILY_HEADERS, dailyRows());
  const asked = await ingest.ingestUpload({
    buffer,
    originalFilename: 'daily.xlsx',
    fileSize: buffer.length,
    chatId: 'chat-2',
    captionText: '',
  });
  assert.equal(asked.status, 'needs_site');
  assert.equal(asked.fileType, 'daily_value');
  // Majority of the rows' Date column is June 2026.
  assert.equal(asked.yearMonth, '2026-06');

  const resolved = ingest.resolvePendingSite('chat-2', 'SH666');
  assert.equal(resolved.status, 'saved');
  assert.equal(resolved.site, 'shwe666');

  const normalised = resolved.row.path.replace(/\\/g, '/');
  assert.match(normalised, /SH666\/2026\/06\/daily_value_[0-9a-f]+\.xlsx$/);
  assert.ok(fs.existsSync(path.join(ROOT, resolved.row.path)), 'the raw file was actually written to disk');
});

test('site named in the caption is used directly', async () => {
  const buffer = await workbookBuffer(DAILY_HEADERS, dailyRows());
  const result = await ingest.ingestUpload({
    buffer,
    originalFilename: 'daily-u89.xlsx',
    fileSize: buffer.length,
    chatId: 'chat-3',
    captionText: 'U89 มิถุนายน',
  });
  assert.equal(result.status, 'saved');
  assert.equal(result.site, 'ubet89');
  assert.equal(result.yearMonth, '2026-06');
});

test('re-uploading the identical file asks to confirm before overwriting', async () => {
  const buffer = await workbookBuffer(DAILY_HEADERS, dailyRows());
  const first = await ingest.ingestUpload({
    buffer,
    originalFilename: 'daily-88f.xlsx',
    fileSize: buffer.length,
    chatId: 'chat-4',
    captionText: '88F',
  });
  assert.equal(first.status, 'saved');

  const second = await ingest.ingestUpload({
    buffer,
    originalFilename: 'daily-88f.xlsx',
    fileSize: buffer.length,
    chatId: 'chat-4',
    captionText: '88F',
  });
  assert.equal(second.status, 'needs_confirm');

  const confirmed = ingest.resolvePendingDuplicate('chat-4', true);
  assert.equal(confirmed.status, 'saved');
});

test('declining the duplicate confirm keeps the existing file untouched', async () => {
  const buffer = await workbookBuffer(DAILY_HEADERS, dailyRows());
  const first = await ingest.ingestUpload({
    buffer,
    originalFilename: 'keep.xlsx',
    fileSize: buffer.length,
    chatId: 'chat-5',
    captionText: 'U89',
  });
  const dup = await ingest.ingestUpload({
    buffer,
    originalFilename: 'keep.xlsx',
    fileSize: buffer.length,
    chatId: 'chat-5',
    captionText: 'U89',
  });
  assert.equal(dup.status, 'needs_confirm');

  const declined = ingest.resolvePendingDuplicate('chat-5', false);
  assert.equal(declined.status, 'kept_existing');
  assert.ok(fs.existsSync(path.join(ROOT, first.row.path)), 'original file still on disk');
});

test('re-uploading with a different filename/size updates silently — no confirm needed', async () => {
  const bufferA = await workbookBuffer(DAILY_HEADERS, dailyRows());
  await ingest.ingestUpload({
    buffer: bufferA,
    originalFilename: 'v1.xlsx',
    fileSize: bufferA.length,
    chatId: 'chat-6',
    captionText: 'SH666',
  });

  const bufferB = await workbookBuffer(DAILY_HEADERS, [
    ...dailyRows(),
    { Date: '2026-06-03', RTP: 0.94, BIn: 420000, DAU: 460, R: 89000 },
  ]);
  const result = await ingest.ingestUpload({
    buffer: bufferB,
    originalFilename: 'v2-updated.xlsx',
    fileSize: bufferB.length,
    chatId: 'chat-6',
    captionText: 'SH666',
  });
  assert.equal(result.status, 'saved');
});
