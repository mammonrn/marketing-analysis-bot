/**
 * Proof that large-file parsing no longer blocks the main thread.
 *
 * The claim being tested is not "a worker is used" but the thing that
 * actually matters to a user: while a big export is being read, the process
 * can still do other work promptly. So the assertions are about timers firing
 * and an unrelated request completing — observable behaviour, not
 * implementation detail.
 *
 * Before this change the same test would have failed: the concurrent request
 * could not finish until the whole parse had, because the parse held the
 * event loop for its entire duration.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as XLSX from 'xlsx';

process.env.TELEGRAM_BOT_TOKEN ??= 'test-token';
process.env.ANTHROPIC_API_KEY ??= 'test-key';

const { parseWorkbookRows, WORKER_MIN_BYTES } = await import('../src/data/parseRunner.js');
const { pickFileType } = await import('../src/data/query.js');
const { SITES, applyFxOverride, clearFxOverrides } = await import('../src/data/sites.js');

const ROW_COUNT = 60000;

let tmpDir;
let bigFixture;
let smallFixture;
let bigBonusFixture;
let smallBonusFixture;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function depositDetailWorkbook(rowCount) {
  const headers = ['Username', 'Type', 'TypeName', 'PayName', 'AddTime', 'Confirm Time',
    'Duration (m)', 'Points', 'Status'];
  const channels = ['k_pay', 'wave_money', 'aya_pay'];
  const aoa = [headers];
  for (let i = 0; i < rowCount; i += 1) {
    aoa.push([
      `user_with_a_longish_name_${i}`,
      'In',
      '3rd Party',
      channels[i % channels.length],
      `2026-06-${String((i % 28) + 1).padStart(2, '0')}`,
      `2026-06-${String((i % 28) + 1).padStart(2, '0')}`,
      (i % 7) + 1,
      100 + (i % 500),
      i % 10 === 0 ? 'failed' : 'success',
    ]);
  }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Export');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

/**
 * A point log, whose `Points` column is on the ×100,000 scale. Every row is
 * the real SH666 value this change was reported against: raw 1.200 = 120,000
 * MMK.
 */
function bonusLogWorkbook(rowCount) {
  const aoa = [['AddTime', 'Type', 'Username', 'Lv', 'Points', 'Memo']];
  for (let i = 0; i < rowCount; i += 1) {
    aoa.push([
      `2026-07-${String((i % 28) + 1).padStart(2, '0')}`,
      'Money Daily',
      `user_with_a_longish_name_${i}`,
      '',
      1.2,
      `Money Daily ( Period No : ${i % 98} ) padded out so the file clears the worker threshold`,
    ]);
  }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Export');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ads-analytics-worker-'));
  bigFixture = path.join(tmpDir, 'Detail (Last 6 Months).xlsx');
  fs.writeFileSync(bigFixture, depositDetailWorkbook(ROW_COUNT));
  smallFixture = path.join(tmpDir, 'small.xlsx');
  fs.writeFileSync(smallFixture, depositDetailWorkbook(20));
  bigBonusFixture = path.join(tmpDir, 'bonus.xlsx');
  fs.writeFileSync(bigBonusFixture, bonusLogWorkbook(ROW_COUNT));
  smallBonusFixture = path.join(tmpDir, 'bonus-small.xlsx');
  fs.writeFileSync(smallBonusFixture, bonusLogWorkbook(20));
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('the fixture is actually big enough to take the worker path', () => {
  const bytes = fs.statSync(bigFixture).size;
  assert.ok(
    bytes >= WORKER_MIN_BYTES,
    `fixture is ${bytes} bytes, under the ${WORKER_MIN_BYTES} threshold — the ` +
      'concurrency test below would prove nothing',
  );
  assert.ok(fs.statSync(smallFixture).size < WORKER_MIN_BYTES);
});

test('an unrelated request completes while a large file is being parsed', async () => {
  // Timers ticking is the direct signal: a blocked event loop fires none.
  let ticks = 0;
  const heartbeat = setInterval(() => { ticks += 1; }, 100);

  const startedAt = Date.now();
  const parsing = parseWorkbookRows({ filePath: bigFixture, fileType: 'deposit_detail' });

  // Stand in for an ordinary question arriving mid-parse: some awaited I/O
  // turns plus real routing work.
  const otherStartedAt = Date.now();
  let routed;
  for (let i = 0; i < 10; i += 1) {
    await delay(20);
    routed = pickFileType('VIP สัปดาห์นี้เป็นยังไง');
  }
  const otherMs = Date.now() - otherStartedAt;

  const rows = await parsing;
  const parseMs = Date.now() - startedAt;
  clearInterval(heartbeat);

  assert.equal(routed, 'vip', 'the concurrent request must really have run');
  assert.ok(rows.length > 0, 'the parse must still produce rows');

  // If the parse were fast, this test would pass for the wrong reason.
  assert.ok(parseMs > 1500, `parse only took ${parseMs}ms — too fast to prove anything`);

  // 10 x 20ms of awaited delay should take ~200ms. Allow generous slack for a
  // loaded machine, but nothing close to the parse duration.
  assert.ok(
    otherMs < 2000,
    `concurrent request took ${otherMs}ms while the ${parseMs}ms parse ran — ` +
      'the main thread was blocked',
  );
  assert.ok(
    otherMs < parseMs / 2,
    `concurrent request (${otherMs}ms) should finish well inside the parse (${parseMs}ms)`,
  );

  // Roughly one tick per 100ms if the loop never stalled.
  const expectedTicks = Math.floor(parseMs / 100);
  assert.ok(
    ticks > expectedTicks * 0.5,
    `only ${ticks} of ~${expectedTicks} timer ticks fired during the parse — the loop stalled`,
  );
});

test('progress is reported through the phases while the worker runs', async () => {
  const updates = [];
  const rows = await parseWorkbookRows({
    filePath: bigFixture,
    fileType: 'deposit_detail',
    onProgress: (update) => updates.push(update),
  });

  assert.ok(rows.length > 0);
  const phases = updates.map((u) => u.phase);
  assert.ok(phases.includes('reading'), 'should announce the read starting');

  const read = updates.find((u) => u.phase === 'read');
  assert.ok(read, 'should report the row count once the sheet is read');
  assert.equal(read.rowsRead, ROW_COUNT);

  const aggregating = updates.filter((u) => u.phase === 'aggregating');
  assert.ok(aggregating.length > 0, 'the aggregate loop should report row counts');
  assert.ok(aggregating.every((u) => u.processed > 0 && u.total === ROW_COUNT));
});

test('worker and inline paths produce identical rows', async () => {
  // Same file, forced down both routes: the thread must be an execution
  // detail, not a behaviour change.
  const viaWorker = await parseWorkbookRows({ filePath: bigFixture, fileType: 'deposit_detail' });
  const { readAndShapeRows } = await import('../src/data/workbook.js');
  const inline = await readAndShapeRows({ filePath: bigFixture, fileType: 'deposit_detail' });

  assert.deepEqual(viaWorker, inline);
});

test('a small file still parses correctly through the inline path', async () => {
  const rows = await parseWorkbookRows({ filePath: smallFixture, fileType: 'deposit_detail' });
  assert.ok(rows.length > 0);
  assert.ok('total_count' in rows[0] && 'success_rate' in rows[0]);
});

test('shape: raw skips the daily summary and returns the sheet rows', async () => {
  const rows = await parseWorkbookRows({ filePath: bigFixture, shape: 'raw' });
  assert.equal(rows.length, ROW_COUNT);
  assert.ok('AddTime' in rows[0], 'raw rows keep the original columns');
  assert.ok(!('total_count' in rows[0]), 'raw rows must not be aggregated');
});

test('countYearMonths returns a tally, not the rows behind it', async () => {
  const { countYearMonths } = await import('../src/data/parseRunner.js');
  const counts = await countYearMonths({ filePath: bigFixture, dateColumn: 'AddTime' });

  // The fixture's dates are all in June 2026, one row each.
  assert.deepEqual(Object.keys(counts), ['2026-06']);
  assert.equal(counts['2026-06'], ROW_COUNT);
  // The point of the shape: what crosses the thread boundary is this small,
  // not 60k row objects.
  assert.ok(Object.keys(counts).length < 10);
});

test('a large buffer (not a path) survives the trip to the worker', async () => {
  // workerData structured-clones a Buffer into a plain Uint8Array. Reading
  // from a buffer is the ingest path, so this is the case that broke first:
  // the worker treated the file's bytes as a filename.
  const buffer = fs.readFileSync(bigFixture);
  assert.ok(buffer.length >= WORKER_MIN_BYTES, 'must be big enough to take the worker path');

  const rows = await parseWorkbookRows({ buffer, shape: 'raw' });
  assert.equal(rows.length, ROW_COUNT);
  assert.ok('AddTime' in rows[0]);
});

/**
 * `aggregateBonusLog` is the first aggregator that converts money, and it does
 * so on whichever thread the parse landed on. These cover the two ways that
 * could go wrong: the site never reaching the worker at all, and the worker's
 * fresh module graph converting at the config rate after a rate change.
 */
test('the bonus fixture is big enough to take the worker path', () => {
  assert.ok(fs.statSync(bigBonusFixture).size >= WORKER_MIN_BYTES);
  assert.ok(fs.statSync(smallBonusFixture).size < WORKER_MIN_BYTES);
});

test('the site reaches the worker, so a big point log still converts', async () => {
  const rows = await parseWorkbookRows({
    filePath: bigBonusFixture,
    fileType: 'bonus_log',
    site: 'shwe666',
  });

  assert.ok(rows.length > 0);
  // Every fixture row is 1.2, so a day's total is 1.2 × however many landed
  // on it — and the converted column is that times the site's point factor.
  for (const row of rows) {
    assert.ok(Math.abs(row.total_points - 1.2 * row.transaction_count) < 1e-6);
    assert.ok(
      Math.abs(row.total_points_THB - row.total_points * SITES.shwe666.pointsFactor) < 1e-6,
      'the worker must convert with the same factor the inline path uses',
    );
  }
});

test('worker and inline point logs agree, including after an fx change', async (t) => {
  t.after(clearFxOverrides);
  applyFxOverride('shwe666', { fxRate: 0.812, fxRateAsOf: '2026-08-08' });

  const { readAndShapeRows } = await import('../src/data/workbook.js');
  const viaWorker = await parseWorkbookRows({
    filePath: bigBonusFixture, fileType: 'bonus_log', site: 'shwe666',
  });
  const inline = await readAndShapeRows({
    filePath: bigBonusFixture, fileType: 'bonus_log', site: 'shwe666',
  });

  // Without the override crossing the thread boundary the worker would still
  // be using the config's 0.787 — the same file converting two ways depending
  // on its size.
  assert.deepEqual(viaWorker, inline);
  assert.ok(Math.abs(viaWorker[0].total_points_THB - viaWorker[0].total_points * 100_000 * 0.812) < 1e-6);
});

test('a point log for a site with no configured scale rejects rather than converting', async () => {
  await assert.rejects(
    () => parseWorkbookRows({ filePath: bigBonusFixture, fileType: 'bonus_log', site: 'ubet89' }),
    /ยังไม่ได้ตั้งค่า pointsScaleFactor/,
    'the refusal must survive the trip back from the worker',
  );

  // And on the inline path too, so file size cannot decide whether it fires.
  await assert.rejects(
    () => parseWorkbookRows({ filePath: smallBonusFixture, fileType: 'bonus_log', site: 'ubet89' }),
    /ยังไม่ได้ตั้งค่า pointsScaleFactor/,
  );
});

test('a worker that fails rejects instead of hanging', async () => {
  // Big enough to take the worker path, and genuinely unreadable: SheetJS is
  // happy to treat arbitrary bytes as a one-sheet text file, but a ZIP magic
  // number followed by rubbish is an .xlsx it must reject.
  const corrupt = path.join(tmpDir, 'corrupt.xlsx');
  fs.writeFileSync(
    corrupt,
    Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(WORKER_MIN_BYTES + 1024, 0x00)]),
  );

  await assert.rejects(
    () => parseWorkbookRows({ filePath: corrupt, fileType: 'deposit_detail' }),
    (err) => err instanceof Error,
    'a crashed worker must surface as a rejection the handler can report',
  );
});
