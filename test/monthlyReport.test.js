import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// config.js resolves DATA_DIR at import time, so the env has to exist before
// anything in the module graph is evaluated — same reasoning as session.test.js.
process.env.TELEGRAM_BOT_TOKEN ??= 'test-token';
process.env.ANTHROPIC_API_KEY ??= 'test-key';

let tmpDir;
let db;
let monthly;

const SITE = 'shwe666';
const MONTH = '2026-07';

/**
 * Seeds an already-parsed file. `parsed = 1` short-circuits `ensureParsed`, so
 * the builder reads `parsed_rows` straight through and no workbook is needed —
 * these tests are about the aggregation, not about reading Excel.
 */
function seed({ site = SITE, yearMonth = MONTH, fileType, rows }) {
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
    rows: rows.map((row) => ({ rowDate: row.Date ?? null, row })),
  });
  db.markParsed(raw.id);
  return raw;
}

/** SH666 is MMK: scaleFactor 1000 × fxRate 0.787, so BIn 100 → ฿78,700. */
const THB_FACTOR = 1000 * 0.787;

const dailyValueRows = [
  { Date: '2026-07-01', BIn: 100, R: 20, RTP: 0.95, DAU: 500, 'BIn Mems': 200, 'BIn Mems (np)': 120, 'New Mems': 30, CIn: 1000, Nw: 50, Bo: 950, Pro: 10, Bonus: 5, 'Pro Mems': 40 },
  { Date: '2026-07-02', BIn: 200, R: 40, RTP: 1.02, DAU: 600, 'BIn Mems': 300, 'BIn Mems (np)': 150, 'New Mems': 40, CIn: 2000, Nw: 60, Bo: 1940, Pro: 20, Bonus: 5, 'Pro Mems': 60 },
  { Date: '2026-07-03', BIn: 300, R: -10, RTP: 1.05, DAU: 400, 'BIn Mems': 100, 'BIn Mems (np)': 30, 'New Mems': 20, CIn: 1500, Nw: 10, Bo: 1490, Pro: 15, Bonus: 5, 'Pro Mems': 20 },
];

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ads-analytics-monthly-'));
  process.env.DATA_DIR = tmpDir;

  db = await import('../src/data/db.js');
  db.initDataDb(path.join(tmpDir, 'test.sqlite'));
  monthly = await import('../src/session/monthlyReport.js');

  seed({ fileType: 'daily_value', rows: dailyValueRows });
  seed({
    fileType: 'new_member_quality',
    rows: [
      { Date: '2026-07-01', New: 30, 'Verify%': 0.72, '1st New%': 0.1, '1st New Mems': 3, '1st New (BIn)': 5, '1st Day Mems': 8, '1st Day (BIn)': 12, '1st New (np%)': 0.9, '1st Day (np%)': 0.85 },
      { Date: '2026-07-02', New: 40, 'Verify%': 0.78, '1st New%': 0.2, '1st New Mems': 8, '1st New (BIn)': 9, '1st Day Mems': 14, '1st Day (BIn)': 20, '1st New (np%)': 0.95, '1st Day (np%)': 0.88 },
    ],
  });
  seed({
    fileType: 'deposit_count_distribution',
    rows: [
      { Date: '2026-07-01', 'BIn Mems': 200, '1 Time': 40, '2~5 Counts': 30, '6~10 Counts': 20, '11~20 Counts': 30, '21+ Counts': 80 },
      { Date: '2026-07-02', 'BIn Mems': 300, '1 Time': 60, '2~5 Counts': 40, '6~10 Counts': 30, '11~20 Counts': 50, '21+ Counts': 120 },
    ],
  });
  seed({
    fileType: 'brand_game_value',
    rows: [
      { GameKind: 'SLOT', CIn: 9000, Nw: 350, RTP: 0.961, DAU: 900, Counts: 50000 },
      { GameKind: 'FISH', CIn: 1000, Nw: 40, RTP: 0.963, DAU: 60, Counts: 3000 },
      { GameKind: 'LOTTO', CIn: 100, Nw: -20, RTP: 4.8, DAU: 10, Counts: 200 },
    ],
  });
  seed({
    fileType: 'vip',
    rows: [
      { Username: 'alice', 'Last BIn 2 Y': 1, BIn: 500, R: 60, 'BIn Counts': 200, 'BIn Days': 90, 'Med. BIn': 12 },
      { Username: 'bob', 'Last BIn 2 Y': 3, BIn: 300, R: 40, 'BIn Counts': 150, 'BIn Days': 70, 'Med. BIn': 8 },
      { Username: 'carol', 'Last BIn 2 Y': 30, BIn: 900, R: 90, 'BIn Counts': 400, 'BIn Days': 120, 'Med. BIn': 20 },
      { Username: 'dave', 'Last BIn 2 Y': 12, BIn: 100, R: 5, 'BIn Counts': 110, 'BIn Days': 55, 'Med. BIn': 2 },
    ],
  });
  seed({
    fileType: 'referrer',
    rows: [
      { Referrer: 'promoter1', 'Ref Bonus': 5, 'Total Mems': 100, 'Total BIn Mems': 60, BIn: 400, R: 50 },
      // Paid more in referral bonus than the downline ever returned.
      { Referrer: 'promoter2', 'Ref Bonus': 40, 'Total Mems': 500, 'Total BIn Mems': 20, BIn: 50, R: 3 },
    ],
  });
  seed({
    fileType: 'avg_bin_by_hour',
    rows: [
      { weekday: 'Monday', weekday_num: 1, hour: 20, avg_bin: 90 },
      { weekday: 'Monday', weekday_num: 1, hour: 4, avg_bin: 5 },
      { weekday: 'Tuesday', weekday_num: 2, hour: 20, avg_bin: 110 },
      { weekday: 'Tuesday', weekday_num: 2, hour: 4, avg_bin: 7 },
    ],
  });
  seed({
    fileType: 'deposit_detail',
    rows: [
      { Date: '2026-07-01', PayName: 'k_pay', total_count: 100, success_count: 95, success_rate: 0.95, avg_duration_min: 2 },
      { Date: '2026-07-02', PayName: 'k_pay', total_count: 100, success_count: 85, success_rate: 0.85, avg_duration_min: 4 },
      { Date: '2026-07-01', PayName: 'wave_money', total_count: 50, success_count: 25, success_rate: 0.5, avg_duration_min: 9 },
    ],
  });
  seed({
    fileType: 'bonus_log',
    rows: [
      { Date: '2026-07-01', Type: 'Loyalty Point', total_points: 1000, transaction_count: 50 },
      { Date: '2026-07-02', Type: 'Loyalty Point', total_points: 1500, transaction_count: 60 },
      { Date: '2026-07-01', Type: 'Referrer Reward Point', total_points: 300, transaction_count: 10 },
    ],
  });
});

after(() => {
  db?.closeDataDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const sectionOf = (payload, id) => payload.sections.find((section) => section.id === id);
const kpiOf = (section, label) => section.kpis.find((kpi) => kpi.label === label);

test('a site/month with nothing uploaded produces no payload at all', async () => {
  // The caller turns this into "ยังไม่มีไฟล์เดือนนี้" rather than opening a
  // dashboard of eleven empty tabs.
  assert.equal(await monthly.buildMonthlyPayload({ site: 'ubet89', yearMonth: MONTH }), null);
  assert.equal(await monthly.buildMonthlyPayload({ site: SITE, yearMonth: '2020-01' }), null);
});

test('every declared section appears, in order, whether or not its file is there', async () => {
  const payload = await monthly.buildMonthlyPayload({ site: SITE, yearMonth: MONTH });
  assert.deepEqual(
    payload.sections.map((section) => section.id),
    monthly.MONTHLY_SECTION_IDS,
  );
  assert.equal(payload.sections.length, 11);
  assert.equal(payload.kind, 'monthly');
  assert.equal(payload.siteName, 'SH666');
  assert.equal(payload.yearMonth, MONTH);
});

test('the payload states the rate its baht figures came from', async () => {
  const payload = await monthly.buildMonthlyPayload({ site: SITE, yearMonth: MONTH });
  assert.equal(payload.currency.currency, 'MMK');
  assert.equal(payload.currency.needsFxConversion, true);
  assert.equal(payload.currency.scaleFactor, 1000);
  assert.ok(payload.currency.fxRateAsOf, 'the rate is dated');
});

test('money is reported from the pipeline_THB columns, never re-converted', async () => {
  const payload = await monthly.buildMonthlyPayload({ site: SITE, yearMonth: MONTH });
  const overview = sectionOf(payload, 'overview');

  // 100 + 200 + 300 = 600 file units → 600 × 1000 × 0.787.
  assert.equal(kpiOf(overview, 'BIn รวมทั้งเดือน').value, 600 * THB_FACTOR);
  assert.equal(kpiOf(overview, 'BIn รวมทั้งเดือน').unit, 'thb');
  // 20 + 40 - 10 = 50.
  assert.equal(kpiOf(overview, 'Revenue รวมทั้งเดือน').value, 50 * THB_FACTOR);
});

test('percentages come from the _pct columns and are not multiplied again', async () => {
  const payload = await monthly.buildMonthlyPayload({ site: SITE, yearMonth: MONTH });
  const overview = sectionOf(payload, 'overview');

  // (0.95 + 1.02 + 1.05) / 3 = 1.00666… → 100.67%, not 1.0067 and not 10,067%.
  const rtp = kpiOf(overview, 'RTP เฉลี่ยรายวัน');
  assert.ok(Math.abs(rtp.value - 100.6667) < 0.001, `RTP was ${rtp.value}`);
  assert.equal(rtp.unit, 'pct');
});

test('R / BIn is the ratio of the two monthly sums, not the mean of daily ratios', async () => {
  const payload = await monthly.buildMonthlyPayload({ site: SITE, yearMonth: MONTH });
  // 50 / 600 = 8.33%. The mean of the daily ratios (20%, 20%, -3.3%) is 12.2%,
  // which is the number this must NOT produce.
  const ratio = kpiOf(sectionOf(payload, 'overview'), 'R / BIn');
  assert.ok(Math.abs(ratio.value - 8.3333) < 0.001, `R/BIn was ${ratio.value}`);
});

test('finance counts the days that actually lost money or over-paid players', async () => {
  const payload = await monthly.buildMonthlyPayload({ site: SITE, yearMonth: MONTH });
  const finance = sectionOf(payload, 'finance');

  assert.equal(kpiOf(finance, 'วันที่ Revenue ติดลบ').value, 1);
  assert.equal(kpiOf(finance, 'วันที่ RTP > 100%').value, 2);

  const best = finance.tables.find((table) => table.title.includes('สูงสุด'));
  assert.equal(best.rows[0].date, '2026-07-02');
  assert.equal(best.rows[0].R_THB, 40 * THB_FACTOR);
});

test('activity reports the organic share as a ratio of head counts', async () => {
  const payload = await monthly.buildMonthlyPayload({ site: SITE, yearMonth: MONTH });
  const activity = sectionOf(payload, 'activity');
  // (120 + 150 + 30) / (200 + 300 + 100) = 300/600 = 50%.
  assert.equal(kpiOf(activity, 'สัดส่วน organic').value, 50);
  assert.equal(kpiOf(activity, 'DAU สูงสุด').value, 600);
});

test('new member reports Delayed 1st Deposit, which no export column carries', async () => {
  const payload = await monthly.buildMonthlyPayload({ site: SITE, yearMonth: MONTH });
  const section = sectionOf(payload, 'new_member');
  // (8 - 3) + (14 - 8) = 11.
  assert.equal(kpiOf(section, 'Delayed 1st Deposit รวม').value, 11);
  // 5 + 9 = 14 file units of first-deposit money.
  assert.equal(kpiOf(section, 'ยอดฝากของ 1st New รวม').value, 14 * THB_FACTOR);
  assert.equal(kpiOf(section, 'Verify% เฉลี่ย').value, 75);
});

test('deposit-count segments sum to BIn Mems and the indices follow the reference', async () => {
  const payload = await monthly.buildMonthlyPayload({ site: SITE, yearMonth: MONTH });
  const section = sectionOf(payload, 'deposit_count');

  assert.equal(kpiOf(section, 'BIn Mems รวมทั้งเดือน').value, 500);
  // (30 + 50 + 80 + 120) / 500 = 56%.
  assert.ok(Math.abs(kpiOf(section, 'Power User Index').value - 56) < 0.001);
  // (40 + 60) / 500 = 20%.
  assert.equal(kpiOf(section, 'Casual Rate').value, 20);

  const table = section.tables[0];
  const shares = table.rows.reduce((total, row) => total + row.share, 0);
  assert.ok(Math.abs(shares - 100) < 0.001, `segment shares summed to ${shares}`);
});

test('brand/game share is money over money and flags RTP above 100%', async () => {
  const payload = await monthly.buildMonthlyPayload({ site: SITE, yearMonth: MONTH });
  const section = sectionOf(payload, 'brand_game');

  assert.equal(kpiOf(section, 'เกมที่ RTP > 100%').value, 1, 'LOTTO at 480%');

  const slot = section.tables[0].rows.find((row) => row.GameKind === 'SLOT');
  // 9000 / 10100 — the site factor cancels, so the share is unaffected by it.
  assert.ok(Math.abs(slot.share - 89.108) < 0.01, `SLOT share was ${slot.share}`);
  assert.equal(slot.CIn_THB, 9000 * THB_FACTOR);
  assert.ok(Math.abs(slot.RTP_pct - 96.1) < 0.001);
});

test('VIP active/lost follows the file rule of 7 days since the last deposit', async () => {
  const payload = await monthly.buildMonthlyPayload({ site: SITE, yearMonth: MONTH });
  const section = sectionOf(payload, 'vip');

  assert.equal(kpiOf(section, 'VIP ทั้งหมด').value, 4);
  assert.equal(kpiOf(section, 'Active VIP').value, 2);
  assert.equal(kpiOf(section, 'Lost VIP').value, 2);
  assert.equal(kpiOf(section, 'Active VIP%').value, 50);

  const lostTable = section.tables.find((table) => table.title.includes('Lost'));
  assert.deepEqual(lostTable.rows.map((row) => row.Username), ['carol', 'dave']);
});

test('the VIP tables never carry phone numbers off the workbook', async () => {
  const payload = await monthly.buildMonthlyPayload({ site: SITE, yearMonth: MONTH });
  const section = sectionOf(payload, 'vip');
  for (const table of section.tables) {
    assert.equal(
      table.columns.some((column) => /phone|เบอร์/i.test(column.key + column.label)),
      false,
      'a token-addressable page must not publish contact details',
    );
    for (const row of table.rows) assert.equal('Phone' in row, false);
  }
});

test('referrer flags whoever was paid more than their downline returned', async () => {
  const payload = await monthly.buildMonthlyPayload({ site: SITE, yearMonth: MONTH });
  const section = sectionOf(payload, 'referrer');

  assert.equal(kpiOf(section, 'Referrer ที่จ่ายแพงกว่าที่ได้').value, 1);

  const rows = section.tables[0].rows;
  const abuser = rows.find((row) => row.Referrer === 'promoter2');
  // 20 / 500 — head counts only, because the export's `BIn Mems%` has no
  // converted twin for this module to read.
  assert.equal(abuser.binMemsPct, 4);
  assert.equal(abuser['Ref Bonus_THB'], 40 * THB_FACTOR);
});

test('hours averages the weekday grid down to one figure per hour', async () => {
  const payload = await monthly.buildMonthlyPayload({ site: SITE, yearMonth: MONTH });
  const section = sectionOf(payload, 'hours');

  assert.equal(kpiOf(section, 'ชั่วโมงที่เงินเข้าสูงสุด').value, 20);
  assert.equal(kpiOf(section, 'ชั่วโมงที่เงียบที่สุด').value, 4);

  const chart = section.charts[0];
  assert.deepEqual(chart.labels, ['4', '20']);
  // (90 + 110) / 2 = 100 file units at hour 20.
  assert.equal(chart.datasets[0].data[1], 100 * THB_FACTOR);
});

test('deposit detail rolls the daily rows back up per channel', async () => {
  const payload = await monthly.buildMonthlyPayload({ site: SITE, yearMonth: MONTH });
  const section = sectionOf(payload, 'deposit_detail');

  assert.equal(kpiOf(section, 'รายการฝากทั้งหมด').value, 250);
  assert.equal(kpiOf(section, 'สำเร็จ').value, 205);
  assert.equal(kpiOf(section, 'อัตราสำเร็จรวม').value, 82);

  const rows = section.tables[0].rows;
  const kpay = rows.find((row) => row.PayName === 'k_pay');
  // 180/200 across the two days — recomputed from the counts, not the mean of
  // the two daily rates.
  assert.equal(kpay.success_rate, 90);
  assert.equal(kpay.avg_duration_min, 3);
});

test('bonus totals points per type and never labels them as baht', async () => {
  const payload = await monthly.buildMonthlyPayload({ site: SITE, yearMonth: MONTH });
  const section = sectionOf(payload, 'bonus');

  assert.equal(kpiOf(section, 'Point ที่จ่ายรวม').value, 2800);
  assert.equal(kpiOf(section, 'ประเภทที่กินงบมากสุด').value, 'Loyalty Point');

  const loyalty = section.tables[0].rows.find((row) => row.Type === 'Loyalty Point');
  assert.equal(loyalty.total_points, 2500);
  // Points are not money, so no column here may claim to be baht.
  for (const column of section.tables[0].columns) assert.notEqual(column.unit, 'thb');
});

test('a missing file leaves its tab present, unavailable, and named', async () => {
  const payload = await monthly.buildMonthlyPayload({ site: SITE, yearMonth: MONTH });
  // Nothing was seeded for member_referrer_detail — but every section this
  // report declares does have a file, so the missing list is empty here.
  assert.deepEqual(payload.missingFiles, []);

  // A month with only one file: the other ten tabs must still be there.
  seed({ site: '88fed', yearMonth: '2026-06', fileType: 'vip', rows: [
    { Username: 'solo', 'Last BIn 2 Y': 2, BIn: 500, R: 60, 'BIn Counts': 200, 'BIn Days': 90, 'Med. BIn': 12 },
  ] });

  const sparse = await monthly.buildMonthlyPayload({ site: '88fed', yearMonth: '2026-06' });
  assert.equal(sparse.sections.length, 11);
  assert.equal(sectionOf(sparse, 'vip').available, true);
  assert.equal(sectionOf(sparse, 'overview').available, false);
  assert.match(sectionOf(sparse, 'overview').reason, /ยังไม่ได้อัปโหลด/);
  assert.equal(sectionOf(sparse, 'overview').fileLabel, 'Daily Value');

  // Deduplicated: three sections read daily_value, and the operator only needs
  // to be told to upload it once.
  const dailyValueMentions = sparse.missingFiles.filter((entry) => entry.fileType === 'daily_value');
  assert.equal(dailyValueMentions.length, 1);
});

test('a file present but unreadable is distinguished from one never uploaded', async () => {
  // A raw_files row with no parsed_rows behind it and no workbook on disk —
  // what an upload that failed to parse leaves behind.
  db.upsertRawFile({
    site: 'ubet89',
    yearMonth: '2026-05',
    fileType: 'daily_value',
    relPath: 'data/ubet89/2026-05/missing.xlsx',
    fileSize: 10,
    originalFilename: 'missing.xlsx',
  });

  const payload = await monthly.buildMonthlyPayload({ site: 'ubet89', yearMonth: '2026-05' });
  const overview = sectionOf(payload, 'overview');
  assert.equal(overview.available, false);
  assert.match(overview.reason, /อ่านข้อมูลจากไฟล์ไม่ได้/);
  // Not listed as "never uploaded" — it is in the database, and telling someone
  // to re-upload a file they already sent is the failure this distinction exists
  // to prevent.
  assert.equal(payload.missingFiles.some((entry) => entry.fileType === 'daily_value'), false);
});

test('a baht site says so instead of quoting an exchange rate', async () => {
  const payload = await monthly.buildMonthlyPayload({ site: '88fed', yearMonth: '2026-06' });
  assert.equal(payload.currency.currency, 'THB');
  assert.equal(payload.currency.needsFxConversion, false);
  // The ×1,000 de-scaling still applies, so BIn 500 is ฿500,000.
  const vip = sectionOf(payload, 'vip');
  assert.equal(kpiOf(vip, 'ยอดฝากรวมของ VIP').value, 500 * 1000);
});
