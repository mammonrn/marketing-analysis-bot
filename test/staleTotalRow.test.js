/**
 * Power BI's `Total` row, when it is already sitting in `parsed_rows`.
 *
 * `dropNonDataRows` has discarded that row at the read since PR #9, so a file
 * parsed after that never produces one. But `parsed = 1` means a file parsed
 * *before* it is never re-read, and those rows stay in the table for ever —
 * carrying a 32nd "day" whose figures are the other 31 added up. Every sum over
 * the month then comes out roughly doubled and every maximum ~31x a real day.
 *
 * That is a query-time problem, not a parse-time one, so it is guarded in
 * `queryParsedRows` — the single point `query.js` and `session/monthlyReport.js`
 * share. These tests are at that layer plus one at each caller, because the
 * failure was reported against the dashboard but the chat path had it too.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.TELEGRAM_BOT_TOKEN ??= 'test-token';
process.env.ANTHROPIC_API_KEY ??= 'test-key';

let tmpDir;
let db;
let fileTypes;
let query;
let monthly;

const SITE = 'shwe666';
const MONTH = '2026-07';
/** SH666: scaleFactor 1000 × fxRate 0.787. */
const THB = 1000 * 0.787;

/** 31 real days, each identical, so the true totals are trivial to state. */
const DAYS = Array.from({ length: 31 }, (_, i) => ({
  Date: `2026-07-${String(i + 1).padStart(2, '0')}`,
  R: 50,
  BIn: 200,
  RTP: 0.95,
  DAU: 500,
  'BIn Mems': 400,
  'BIn Mems (np)': 350,
  'New Mems': 100,
}));
const R_TOTAL = 31 * 50;
const BIN_TOTAL = 31 * 200;

/**
 * Seeds the shape the reported database was actually in: the two furniture
 * rows Power BI writes below the grid, then the real days.
 */
function seedWithFurniture({ site = SITE, yearMonth = MONTH, fileType = 'daily_value', days = DAYS }) {
  const raw = db.upsertRawFile({
    site,
    yearMonth,
    fileType,
    relPath: `data/${site}/${yearMonth}/${fileType}.xlsx`,
    fileSize: 1024,
    originalFilename: `${fileType}.xlsx`,
  });
  db.insertParsedRows(raw.id, {
    fileType,
    site,
    yearMonth,
    rows: [
      // The `Total` row: no date, and its figures ARE the month's own sums.
      {
        rowDate: null,
        row: { Date: null, R: R_TOTAL, BIn: BIN_TOTAL, RTP: 0.95, DAU: 500, 'BIn Mems': 400 },
      },
      // The `Applied filters:` trailer: no date, no values.
      { rowDate: null, row: { Date: null, R: null, BIn: null } },
      ...days.map((row) => ({ rowDate: row.Date, row })),
    ],
  });
  db.markParsed(raw.id);
  return raw;
}

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ads-analytics-stale-'));
  process.env.DATA_DIR = tmpDir;

  db = await import('../src/data/db.js');
  db.initDataDb(path.join(tmpDir, 'test.sqlite'));
  fileTypes = await import('../src/data/fileTypes.js');
  query = await import('../src/data/query.js');
  monthly = await import('../src/session/monthlyReport.js');
});

after(() => {
  db?.closeDataDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// --- the guard itself --------------------------------------------------------

test('a dated series drops rows with no date; the count is days, not rows stored', () => {
  seedWithFurniture({});
  const rows = db.queryParsedRows({ site: SITE, fileType: 'daily_value', yearMonths: [MONTH] });

  assert.equal(rows.length, 31, '33 rows are stored, 31 of them are days');
  assert.equal(rows.every((row) => row.row_date), true, 'every row that comes back has a date');
});

test('a snapshot export keeps every row, because a null date is normal there', () => {
  // The load-bearing half of the conditional. vip/brand_game_value/referrer/
  // ad_agent and the hour pivots have no date axis at all, so filtering them
  // the same way would return nothing and blank half the dashboard.
  const snapshots = fileTypes.FILE_TYPES.filter((type) => !type.dateColumn);
  assert.ok(snapshots.length >= 6, 'there are snapshot types to protect');

  for (const type of snapshots) {
    const raw = db.upsertRawFile({
      site: SITE,
      yearMonth: '2026-06',
      fileType: type.id,
      relPath: `data/x/${type.id}.xlsx`,
      fileSize: 1,
      originalFilename: 'x.xlsx',
    });
    db.insertParsedRows(raw.id, {
      fileType: type.id,
      site: SITE,
      yearMonth: '2026-06',
      rows: [
        { rowDate: null, row: { Username: 'a', BIn: 1 } },
        { rowDate: null, row: { Username: 'b', BIn: 2 } },
      ],
    });
    db.markParsed(raw.id);

    const rows = db.queryParsedRows({ site: SITE, fileType: type.id, yearMonths: ['2026-06'] });
    assert.equal(rows.length, 2, `${type.id} must keep its dateless rows`);
  }
});

test('every dated file type is guarded, not just daily_value', () => {
  // The reported symptom was on daily_value, but the same export convention
  // produces the same furniture on every dated report.
  const dated = fileTypes.FILE_TYPES.filter((type) => type.dateColumn);
  assert.ok(dated.length >= 5, 'there are dated types to guard');

  for (const type of dated) {
    const raw = db.upsertRawFile({
      site: SITE,
      yearMonth: '2026-05',
      fileType: type.id,
      relPath: `data/y/${type.id}.xlsx`,
      fileSize: 1,
      originalFilename: 'y.xlsx',
    });
    db.insertParsedRows(raw.id, {
      fileType: type.id,
      site: SITE,
      yearMonth: '2026-05',
      rows: [
        { rowDate: '2026-05-01', row: { Date: '2026-05-01', v: 1 } },
        { rowDate: '2026-05-02', row: { Date: '2026-05-02', v: 2 } },
        { rowDate: null, row: { Date: null, v: 3, note: 'Total' } },
      ],
    });
    db.markParsed(raw.id);

    const rows = db.queryParsedRows({ site: SITE, fileType: type.id, yearMonths: ['2026-05'] });
    assert.equal(rows.length, 2, `${type.id} must drop its Total row`);
  }
});

// --- the dashboard -----------------------------------------------------------

test('the monthly dashboard does not add the Total row to the month it summarises', async () => {
  // The reported bug, in the units it was reported in: ฿2.73M shown for a
  // month whose real revenue was ฿1.36M.
  const payload = await monthly.buildMonthlyPayload({ site: SITE, yearMonth: MONTH });
  const section = (id) => payload.sections.find((s) => s.id === id);
  const kpi = (s, label) => s.kpis.find((k) => k.label === label);

  const overview = section('overview');
  assert.equal(kpi(overview, 'Revenue รวมทั้งเดือน').value, R_TOTAL * THB);
  assert.equal(kpi(overview, 'BIn รวมทั้งเดือน').value, BIN_TOTAL * THB);
  assert.equal(kpi(overview, 'จำนวนวันที่มีข้อมูล').value, 31, 'not 33');

  const finance = section('finance');
  assert.equal(kpi(finance, 'Revenue รวม').value, R_TOTAL * THB);
  // The Total row carries no date, so a chart built from it would have gained
  // a nameless 32nd point.
  assert.equal(overview.charts[0].labels.length, 31);
});

test('averages and maxima are per real day, not skewed by the Total row', async () => {
  const payload = await monthly.buildMonthlyPayload({ site: SITE, yearMonth: MONTH });
  const activity = payload.sections.find((s) => s.id === 'activity');
  const kpi = (label) => activity.kpis.find((k) => k.label === label);

  // Every seeded day has DAU 500 and the Total row also says 500, so the mean
  // survives either way — the min/max in the note is what exposes an extra
  // row, and the R maximum would have been 31x a real day.
  assert.equal(kpi('DAU เฉลี่ย').value, 500);
  assert.equal(kpi('DAU เฉลี่ย').note, 'ต่ำสุด 500 / สูงสุด 500');

  const finance = payload.sections.find((s) => s.id === 'finance');
  const best = finance.tables.find((t) => t.title.includes('สูงสุด'));
  assert.equal(best.rows[0].R_THB, 50 * THB, 'the best day is a day, not the month total');
  assert.ok(best.rows.every((row) => row.date), 'no dateless row reached the table');
});

test('the finance tab shows the BIn its own ratios are quoted against', async () => {
  const payload = await monthly.buildMonthlyPayload({ site: SITE, yearMonth: MONTH });
  const finance = payload.sections.find((s) => s.id === 'finance');
  const bin = finance.kpis.find((k) => k.label === 'BIn รวม');

  assert.ok(bin, 'the tab quotes R/BIn and Bonus/BIn, so it must show BIn');
  assert.equal(bin.value, BIN_TOTAL * THB);
  assert.equal(bin.unit, 'thb');
});

// --- the chat path -----------------------------------------------------------

test('the chat path summary block is also free of the Total row', async () => {
  // Latent rather than visible: a monthly export is 33 rows, which slips under
  // DETAIL_ROW_LIMIT into the send-every-row branch. Over 40 rows it takes the
  // statistics branch, where the same stale row doubled every sum.
  const many = Array.from({ length: 45 }, (_, i) => ({
    Date: `2026-04-${String((i % 28) + 1).padStart(2, '0')}`,
    R: 10,
    BIn: 20,
  }));
  const raw = db.upsertRawFile({
    site: SITE,
    yearMonth: '2026-04',
    fileType: 'daily_value',
    relPath: 'data/z/daily.xlsx',
    fileSize: 1,
    originalFilename: 'daily.xlsx',
  });
  db.insertParsedRows(raw.id, {
    fileType: 'daily_value',
    site: SITE,
    yearMonth: '2026-04',
    rows: [
      { rowDate: null, row: { Date: null, R: 450, BIn: 900 } },
      ...many.map((row) => ({ rowDate: row.Date, row })),
    ],
  });
  db.markParsed(raw.id);

  const rows = db.queryParsedRows({ site: SITE, fileType: 'daily_value', yearMonths: ['2026-04'] });
  const block = query.formatContext({
    site: SITE,
    fileType: 'daily_value',
    availableMonths: ['2026-04'],
    rows,
  });

  const line = block.split('\n').find((l) => l.trim().startsWith('- R:'));
  assert.ok(line, 'the statistics branch was taken');
  assert.match(line, /รวม 450 /, 'the sum is the 45 days, not double');
  assert.match(line, /สูงสุด 10 /, 'the maximum is a day, not the month total');
});
