/**
 * Regression test for the OOM that pm2 was restarting the bot out of: a large
 * workbook whose header row matches no signature used to be parsed in full
 * (every row into memory) before `detectFileType` ever got to reject it.
 *
 * The existing ingest tests all use two-row fixtures, so nothing in the suite
 * could catch this — same blind spot that let the namespace-prefix bug ship.
 * The memory assertion runs in a child process on purpose: measuring RSS in
 * this process would be meaningless, because generating the fixture already
 * grew the heap and V8 happily reuses that space instead of asking the OS for
 * more.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as XLSX from 'xlsx';

process.env.TELEGRAM_BOT_TOKEN ??= 'test-token';
process.env.ANTHROPIC_API_KEY ??= 'test-key';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROW_COUNT = 120000;

// Deliberately matches no signature in fileTypes.js — no 'Last BIn 2 Y',
// '1st New%', 'GameKind' or '21+ Counts', and not RTP+BIn+DAU together.
const UNKNOWN_HEADERS = ['Member ID', 'Bonus Name', 'Amount', 'Granted At', 'Status'];

let tmpDir;
let fixturePath;
let db;
let ingest;

function buildLargeUnrecognisedWorkbook(rowCount) {
  // Numeric ids and a couple of repeated strings keep the shared-string table
  // small, so the fixture stays cheap to build while still being big enough
  // (>100k rows) to reproduce the original blow-up.
  const aoa = [UNKNOWN_HEADERS];
  for (let i = 0; i < rowCount; i += 1) {
    aoa.push([i, 'Welcome Bonus', 100 + (i % 500), 46204, 'granted']);
  }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Sheet1');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ads-analytics-large-'));
  process.env.DATA_DIR = tmpDir;

  fixturePath = path.join(tmpDir, 'bonus.xlsx');
  fs.writeFileSync(fixturePath, buildLargeUnrecognisedWorkbook(ROW_COUNT));

  db = await import('../src/data/db.js');
  db.initDataDb(path.join(tmpDir, 'test.sqlite'));
  ingest = await import('../src/data/ingest.js');
});

after(() => {
  db?.closeDataDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('a huge unrecognised workbook is rejected on its header row alone', async () => {
  const buffer = fs.readFileSync(fixturePath);
  const startedAt = Date.now();

  const result = await ingest.ingestUpload({
    buffer,
    originalFilename: 'bonus.xlsx',
    fileSize: buffer.length,
    chatId: 'chat-large',
    captionText: '',
  });

  const elapsed = Date.now() - startedAt;
  assert.equal(result.status, 'unrecognized');
  // Smoke bound only — this runs on a heap already holding the fixture, so
  // the clean measurement is the child-process test below.
  assert.ok(elapsed < 5000, `expected a fast reject, took ${elapsed}ms`);
});

test('rejecting it does not balloon the process (measured in a fresh process)', () => {
  const runnerPath = path.join(tmpDir, 'measure-ingest.mjs');
  fs.writeFileSync(
    runnerPath,
    `import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
const [, , fixture, projectRoot, dataDir] = process.argv;
process.env.TELEGRAM_BOT_TOKEN ??= 'test-token';
process.env.ANTHROPIC_API_KEY ??= 'test-key';
process.env.DATA_DIR = dataDir;
const buffer = fs.readFileSync(fixture);
const rssBefore = process.memoryUsage().rss;
const startedAt = Date.now();
const db = await import(pathToFileURL(projectRoot + '/src/data/db.js').href);
db.initDataDb(dataDir + '/child.sqlite');
const { ingestUpload } = await import(pathToFileURL(projectRoot + '/src/data/ingest.js').href);
const result = await ingestUpload({
  buffer, originalFilename: 'bonus.xlsx', fileSize: buffer.length,
  chatId: 'child', captionText: '',
});
const rssDeltaMb = Math.round((process.memoryUsage().rss - rssBefore) / 1024 / 1024);
console.log('RESULT:' + JSON.stringify({ status: result.status, rssDeltaMb, elapsedMs: Date.now() - startedAt }));
`,
  );

  const childDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ads-analytics-child-'));
  const stdout = execFileSync(
    process.execPath,
    [runnerPath, fixturePath, PROJECT_ROOT, childDataDir],
    { encoding: 'utf8', timeout: 120000 },
  );
  fs.rmSync(childDataDir, { recursive: true, force: true });

  // The logger writes JSON lines to stdout, so pick our line out by prefix.
  const line = stdout.split('\n').find((l) => l.startsWith('RESULT:'));
  assert.ok(line, `child produced no result line. stdout was:\n${stdout}`);
  const { status, rssDeltaMb, elapsedMs } = JSON.parse(line.slice('RESULT:'.length));

  assert.equal(status, 'unrecognized');
  // Measured on this fixture: parsing all 120k rows costs ~235MB and ~4.4s,
  // the header-only read ~64MB and ~0.5s. Both bounds sit between the two
  // with room on either side, so neither GC luck nor a slow machine flips
  // the result — but restoring the old ordering fails both.
  assert.ok(
    rssDeltaMb < 120,
    `header-only reject should stay well under 120MB, used ${rssDeltaMb}MB`,
  );
  assert.ok(
    elapsedMs < 2000,
    `header-only reject should be well under 2s, took ${elapsedMs}ms`,
  );
});

// Guard the other half of the change: a recognised file must still get every
// row, since resolveYearMonth reads the Date column out of them.
test('a recognised file still gets its rows parsed, just later', async () => {
  const aoa = [
    ['Date', 'RTP', 'BIn', 'DAU', 'R'],
    ['2026-06-01', 0.95, 400000, 470, 90000],
    ['2026-06-02', 0.96, 410000, 480, 91000],
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Sheet1');
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  const result = await ingest.ingestUpload({
    buffer,
    originalFilename: 'daily.xlsx',
    fileSize: buffer.length,
    chatId: 'chat-large-known',
    captionText: 'SH666',
  });

  assert.equal(result.status, 'saved');
  assert.equal(result.fileType, 'daily_value');
  // Derived from the Date column, which only exists if `rows` was populated.
  assert.equal(result.yearMonth, '2026-06');
});
