/**
 * The "รวมทั้งเดือน 33 วัน" bug.
 *
 * A `daily_value` export for July — 31 calendar days — was reaching the model
 * as 33 rows. Power BI's matrix export writes two rows of furniture below the
 * data: a `Total` row holding the month's sums, and an `Applied filters: ...`
 * trailer. Both carry values, so the blank-row check in `readSheet` kept them,
 * and both became ordinary rows in `parsed_rows`.
 *
 * The day count was only the visible symptom. The `Total` row's figures are
 * the month's sums, so while it was in the data it also inflated every sum,
 * average, maximum and ranking computed from the file — which is why these
 * tests check the metrics as well as the count, and why the filtering is
 * asserted at the ingest/parse boundary rather than at display time.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as XLSX from 'xlsx';

// config.js resolves DATA_DIR at import time, so the env has to be set before
// anything in the module graph is evaluated — same reasoning as ingest.test.js.
process.env.TELEGRAM_BOT_TOKEN ??= 'test-token';
process.env.ANTHROPIC_API_KEY ??= 'test-key';

let tmpDir;
let db;
let ingest;
let parse;
let query;

function workbookBuffer(aoa) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Sheet1');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

const DAILY_HEADERS = ['Date', 'CIn', 'RTP', 'BIn', 'DAU', 'R'];

/** July 2026 — 31 days — exactly as the real export lays it out. */
const JULY_DAYS = Array.from({ length: 31 }, (_, i) => [
  `2026-07-${String(i + 1).padStart(2, '0')}`,
  1000 + i,
  0.95,
  400 + i,
  470 + i,
  90 + i,
]);

const JULY_BIN_SUM = JULY_DAYS.reduce((total, row) => total + row[3], 0);

/**
 * The trailer as the failing file actually had it: a `Total` row whose figures
 * are the month's sums, then Power BI's filter note.
 */
const POWER_BI_TRAILER = [
  ['Total', 32_000, 0.95, JULY_BIN_SUM, 470, 3_000],
  ['Applied filters:', null, null, null, null, null],
];

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ads-analytics-summary-rows-'));
  process.env.DATA_DIR = tmpDir;

  db = await import('../src/data/db.js');
  db.initDataDb(path.join(tmpDir, 'test.sqlite'));
  ingest = await import('../src/data/ingest.js');
  parse = await import('../src/data/parse.js');
  query = await import('../src/data/query.js');
});

after(() => {
  db?.closeDataDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Uploads a workbook and parses it, returning what landed in `parsed_rows`.
 *
 * The filename carries `chatId` because several tests upload the same bytes
 * for the same site and month, which is the exact-duplicate case — it would
 * come back as `needs_confirm` rather than being stored.
 */
async function ingestAndParse({ buffer, site, chatId, fileType }) {
  const result = await ingest.ingestUpload({
    buffer,
    originalFilename: `${fileType}_${chatId}.xlsx`,
    fileSize: buffer.length,
    chatId,
    captionText: site,
  });
  assert.equal(result.status, 'saved', `upload should be stored, got ${result.status}`);

  await parse.ensureParsed({
    site: result.site,
    yearMonth: result.yearMonth,
    fileType: result.fileType,
  });

  return {
    ...result,
    rows: db.queryParsedRows({
      site: result.site,
      fileType: result.fileType,
      yearMonths: [result.yearMonth],
    }),
  };
}

// ---------------------------------------------------------------------------

test('a daily_value export with a Total row stores 31 rows for a 31-day July', async () => {
  const buffer = workbookBuffer([DAILY_HEADERS, ...JULY_DAYS, ...POWER_BI_TRAILER]);

  const { rows, yearMonth } = await ingestAndParse({
    buffer,
    site: 'SH666',
    chatId: 'chat-total-1',
    fileType: 'daily_value',
  });

  assert.equal(yearMonth, '2026-07');
  // The count the bot reports. 33 here is the bug.
  assert.equal(rows.length, 31, 'July has 31 days — the Total and trailer rows must be gone');

  // Filtered at ingest, so nothing downstream has to know about it: every
  // stored row is a real dated day, and no row carries the Total label.
  assert.ok(rows.every((r) => r.row_date), 'every stored row must have a real date');
  assert.deepEqual(
    rows.map((r) => r.row_date).sort(),
    JULY_DAYS.map((d) => d[0]),
    'the stored dates must be exactly the 31 calendar days',
  );
  assert.ok(
    !rows.some((r) => String(r.row.Date).toLowerCase().startsWith('total')),
    'no Total row may survive as data',
  );
});

test('the Total row does not inflate the metrics computed from the file', async () => {
  const buffer = workbookBuffer([DAILY_HEADERS, ...JULY_DAYS, ...POWER_BI_TRAILER]);

  const { rows } = await ingestAndParse({
    buffer,
    site: 'SH666',
    chatId: 'chat-total-2',
    fileType: 'daily_value',
  });

  // The Total row's BIn is the month's own sum, so had it survived the total
  // would have come out at exactly twice the truth and the max at ~34x a day.
  const bin = rows.map((r) => r.row.BIn);
  assert.equal(
    bin.reduce((total, n) => total + n, 0),
    JULY_BIN_SUM,
    'summing the stored rows must not double-count the Total row',
  );
  assert.equal(Math.max(...bin), 430, 'the largest day must be a day, not the month total');
});

test('the context handed to the model reports the real day count', async () => {
  const buffer = workbookBuffer([DAILY_HEADERS, ...JULY_DAYS, ...POWER_BI_TRAILER]);

  const { rows, site, yearMonth } = await ingestAndParse({
    buffer,
    site: 'SH666',
    chatId: 'chat-total-3',
    fileType: 'daily_value',
  });

  const text = query.formatContext({
    site,
    fileType: 'daily_value',
    availableMonths: [yearMonth],
    rows,
  });

  assert.match(text, /จำนวนแถว: 31/);
  assert.ok(!/33/.test(text.split('\n')[3] ?? ''), 'the row-count line must not say 33');
  assert.ok(!text.includes('"Date":"Total"'), 'the Total row must not reach the model');
  assert.equal(text.split('\n').filter((l) => l.startsWith('[')).length, 31);
});

test('a Total row with a blank date cell is dropped too', async () => {
  // The other shape seen in the wild: the label cell is empty rather than
  // saying "Total", so only the date test can catch it.
  const buffer = workbookBuffer([
    DAILY_HEADERS,
    ...JULY_DAYS,
    [null, 32_000, 0.95, JULY_BIN_SUM, 470, 3_000],
  ]);

  const { rows } = await ingestAndParse({
    buffer,
    site: 'U89',
    chatId: 'chat-total-4',
    fileType: 'daily_value',
  });

  assert.equal(rows.length, 31, 'an undated summary row is not a day');
});

test('a snapshot type with no date column still loses its Total row', async () => {
  // vip has `dateColumn: null`, so the label test is the only one that runs.
  const headers = ['Username', 'Last BIn 2 Y', 'BIn', 'Bo', 'R'];
  const members = Array.from({ length: 5 }, (_, i) => [`member${i}`, i, 100 + i, 50, 20]);
  const buffer = workbookBuffer([headers, ...members, ['Total', null, 510, 250, 100]]);

  const { rows } = await ingestAndParse({
    buffer,
    site: 'SH666',
    chatId: 'chat-total-5',
    fileType: 'vip',
  });

  assert.equal(rows.length, 5, 'the Total row is not a member');
  assert.ok(!rows.some((r) => r.row.Username === 'Total'));
});

// --- the filter must not be greedy ------------------------------------------

test('real rows that merely contain the word are kept', async () => {
  const { dropNonDataRows } = await import('../src/data/workbook.js');

  const headers = ['Username', 'Total Mems', 'BIn'];
  const rows = [
    { Username: 'sumalee', 'Total Mems': 3, BIn: 10 },
    { Username: 'totally_legit', 'Total Mems': 4, BIn: 20 },
    { Username: 'Total', 'Total Mems': 7, BIn: 30 },
  ];

  const kept = dropNonDataRows(rows, { headers });
  assert.deepEqual(
    kept.map((r) => r.Username),
    ['sumalee', 'totally_legit'],
    'only an exact leading label is furniture — a prefix match is not enough',
  );
});

test('a date column that is not in the sheet drops nothing', async () => {
  const { dropNonDataRows } = await import('../src/data/workbook.js');

  const headers = ['Username', 'BIn'];
  const rows = [{ Username: 'a', BIn: 1 }, { Username: 'b', BIn: 2 }];

  // A file type whose dateColumn names a column this sheet does not have must
  // not cause every row to fail a test it never took.
  assert.equal(dropNonDataRows(rows, { headers, dateColumn: 'Date' }).length, 2);
});
