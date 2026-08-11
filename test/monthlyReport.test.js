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
let ROOT;

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
  ({ ROOT } = await import('../src/paths.js'));

  seed({ fileType: 'daily_value', rows: dailyValueRows });
  seed({
    fileType: 'new_member_quality',
    rows: [
      { Date: '2026-07-01', New: 30, 'New (Ref.)': 1, Verify: 21, 'Verify%': 0.72, '1st New%': 0.1, '1st New Mems': 3, '1st New (BIn)': 5, '1st Day Mems': 8, '1st Day (BIn)': 12, '1st New (np%)': 0.9, '1st Day (np%)': 0.85 },
      { Date: '2026-07-02', New: 40, 'New (Ref.)': 2, Verify: 31, 'Verify%': 0.78, '1st New%': 0.2, '1st New Mems': 8, '1st New (BIn)': 9, '1st Day Mems': 14, '1st Day (BIn)': 20, '1st New (np%)': 0.95, '1st Day (np%)': 0.88 },
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
      { Username: 'alice', Agent: 'agentA', Phone: '0800000001', 'Last BIn 2 Y': 1, BIn: 500, R: 60, 'BIn Counts': 200, 'BIn Days': 90, 'Med. BIn': 12 },
      { Username: 'bob', Agent: 'agentA', Phone: '0800000002', 'Last BIn 2 Y': 3, BIn: 300, R: 40, 'BIn Counts': 150, 'BIn Days': 70, 'Med. BIn': 8 },
      { Username: 'carol', Agent: 'agentB', Phone: '0800000003', 'Last BIn 2 Y': 30, BIn: 900, R: 90, 'BIn Counts': 400, 'BIn Days': 120, 'Med. BIn': 20 },
      { Username: 'dave', Agent: 'agentB', 'Last BIn 2 Y': 12, BIn: 100, R: 5, 'BIn Counts': 110, 'BIn Days': 55, 'Med. BIn': 2 },
    ],
  });
  seed({
    fileType: 'referrer',
    rows: [
      { Referrer: 'promoter1', 'Ref Bonus': 5, 'Total Mems': 100, 'Total BIn Mems': 60, BIn: 400, R: 50 },
      // Paid more in referral bonus than the downline ever returned, and only
      // 4% of the people recruited ever deposited.
      { Referrer: 'promoter2', 'Ref Bonus': 40, 'Total Mems': 500, 'Total BIn Mems': 20, BIn: 50, R: 3 },
      // Below the Total Mems >= 5 floor, so not a low-quality flag however bad
      // its ratio looks.
      { Referrer: 'tiny', 'Ref Bonus': 0, 'Total Mems': 2, 'Total BIn Mems': 0, BIn: 0, R: 0 },
    ],
  });
  seed({
    fileType: 'ad_agent',
    rows: [
      { 'AD / Agent': 'facebook', Agent: 'Total', 'Total Mems': 900, 'Total BIn Mems': 300, BIn: 700, Pro: 40, R: 90 },
      { 'AD / Agent': 'tiktok', Agent: 'Total', 'Total Mems': 400, 'Total BIn Mems': 100, BIn: 200, Pro: 30, R: 20 },
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
    fileType: 'avg_bin_mems_by_hour',
    rows: [
      { weekday: 'Monday', weekday_num: 1, hour: 20, avg_mems: 40 },
      { weekday: 'Monday', weekday_num: 1, hour: 4, avg_mems: 3 },
      { weekday: 'Tuesday', weekday_num: 2, hour: 20, avg_mems: 55 },
      { weekday: 'Tuesday', weekday_num: 2, hour: 4, avg_mems: 4 },
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
  // `aggregateBonusLog` writes both columns: the raw Power BI sum and the baht
  // figure it converts to with the site's own `pointsScaleFactor`. SH666's is
  // 100, so 1,000 raw points × 100 × 0.787 = ฿78,700.
  seed({
    fileType: 'bonus_log',
    rows: [
      { Date: '2026-07-01', Type: 'Loyalty Point', total_points: 1000, total_points_THB: 1000 * 100 * 0.787, transaction_count: 50 },
      { Date: '2026-07-02', Type: 'Loyalty Point', total_points: 1500, total_points_THB: 1500 * 100 * 0.787, transaction_count: 60 },
      { Date: '2026-07-01', Type: 'Referrer Reward Point', total_points: 300, total_points_THB: 300 * 100 * 0.787, transaction_count: 10 },
    ],
  });
});

after(() => {
  db?.closeDataDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const sectionOf = (payload, id) => payload.sections.find((section) => section.id === id);
const kpiOf = (section, label) => section.kpis.find((kpi) => kpi.label === label);
const chartOf = (section, id) => section.charts.find((chart) => chart.id === id);
const tableTitled = (section, fragment) =>
  section.tables.find((table) => table.title.includes(fragment));
const joined = (section) => section.insights.join(' | ');

// --- shape -------------------------------------------------------------------

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

test('every available section carries all five renderable parts', async () => {
  const payload = await monthly.buildMonthlyPayload({ site: SITE, yearMonth: MONTH });
  for (const section of payload.sections.filter((s) => s.available)) {
    for (const key of ['alerts', 'kpis', 'charts', 'tables', 'insights']) {
      assert.ok(Array.isArray(section[key]), `${section.id}.${key} is an array`);
    }
    assert.ok(section.kpis.length > 0, `${section.id} has KPIs`);
    assert.ok(section.insights.length > 0, `${section.id} has insights`);
  }
});

test('every KPI declares a unit the renderer knows how to format', async () => {
  const payload = await monthly.buildMonthlyPayload({ site: SITE, yearMonth: MONTH });
  const known = new Set(['thb', 'pct', 'count', 'number', 'min', 'text']);
  for (const section of payload.sections.filter((s) => s.available)) {
    for (const kpi of section.kpis) {
      assert.ok(known.has(kpi.unit), `${section.id} / ${kpi.label} has unit ${kpi.unit}`);
      if (kpi.status) assert.ok(['good', 'warn', 'bad'].includes(kpi.status));
    }
  }
});

test('the payload states the rate its baht figures came from', async () => {
  const payload = await monthly.buildMonthlyPayload({ site: SITE, yearMonth: MONTH });
  assert.equal(payload.currency.currency, 'MMK');
  assert.equal(payload.currency.needsFxConversion, true);
  assert.equal(payload.currency.scaleFactor, 1000);
  assert.ok(payload.currency.fxRateAsOf, 'the rate is dated');
});

// --- units -------------------------------------------------------------------

test('money is reported from the pipeline _THB columns, never re-converted', async () => {
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
  const finance = sectionOf(payload, 'finance');

  // (0.95 + 1.02 + 1.05) / 3 = 1.00666… → 100.67%, not 1.0067 and not 10,067%.
  const rtp = kpiOf(finance, 'RTP เฉลี่ย');
  assert.ok(Math.abs(rtp.value - 100.6667) < 0.001, `RTP was ${rtp.value}`);
  assert.equal(rtp.unit, 'pct');
});

test('the median is the median, not a second name for the mean', async () => {
  const payload = await monthly.buildMonthlyPayload({ site: SITE, yearMonth: MONTH });
  const overview = sectionOf(payload, 'overview');
  // RTP_pct over the three days is 95, 102, 105 → median 102, mean 100.67.
  assert.ok(Math.abs(kpiOf(overview, 'RTP median').value - 102) < 0.001);
});

test('R / BIn is the ratio of the two monthly sums, not the mean of daily ratios', async () => {
  const payload = await monthly.buildMonthlyPayload({ site: SITE, yearMonth: MONTH });
  const insights = joined(sectionOf(payload, 'overview'));
  // 50 / 600 = 8.33%. The mean of the daily ratios (20%, 20%, -3.3%) is 12.2%,
  // which is the number this must NOT produce.
  assert.match(insights, /8\.3%/);
});

// --- per-site benchmarks -----------------------------------------------------

test('benchmark notes quote the site being reported on, never another site', async () => {
  const payload = await monthly.buildMonthlyPayload({ site: SITE, yearMonth: MONTH });
  const overview = sectionOf(payload, 'overview');

  // casino-metrics.md: SH666 RTP median 95.85%, DAU 473/day.
  assert.match(kpiOf(overview, 'RTP median').note, /95\.85/);
  assert.match(kpiOf(overview, 'DAU เฉลี่ย/วัน').note, /473/);
  // u89-metrics.md's 96.7 / 1,062 must not appear anywhere in SH666's report.
  const serialised = JSON.stringify(payload);
  assert.equal(serialised.includes('96.7%'), false, "U89's RTP benchmark leaked into SH666");
  assert.equal(serialised.includes('1,062'), false, "U89's DAU benchmark leaked into SH666");
});

test('a different site gets its own documented benchmarks', async () => {
  seed({ site: 'ubet89', yearMonth: '2026-04', fileType: 'daily_value', rows: dailyValueRows });
  const payload = await monthly.buildMonthlyPayload({ site: 'ubet89', yearMonth: '2026-04' });
  const overview = sectionOf(payload, 'overview');

  // u89-metrics.md: RTP median 96.7%, DAU 1,062/day.
  assert.match(kpiOf(overview, 'RTP median').note, /96\.7/);
  assert.match(kpiOf(overview, 'DAU เฉลี่ย/วัน').note, /1,062/);
  assert.equal(JSON.stringify(payload).includes('95.85'), false, "SH666's benchmark leaked into U89");
});

test('a KPI with no documented benchmark for the site gets no status badge', async () => {
  // 88fed-metrics.md documents no Delayed Depositors figure, so that KPI must
  // not borrow SH666's 32/day — an unearned verdict is worse than none.
  seed({
    site: '88fed',
    yearMonth: '2026-03',
    fileType: 'new_member_quality',
    rows: [
      { Date: '2026-03-01', New: 30, Verify: 20, 'Verify%': 0.65, '1st New%': 0.13, '1st New Mems': 4, '1st Day Mems': 9, '1st New (np%)': 0.88, '1st Day (np%)': 0.9, '1st New (BIn)': 4, '1st Day (BIn)': 9 },
    ],
  });
  const payload = await monthly.buildMonthlyPayload({ site: '88fed', yearMonth: '2026-03' });
  const section = sectionOf(payload, 'new_member');

  const delayed = kpiOf(section, 'Delayed Depositors เฉลี่ย/วัน');
  assert.equal(delayed.note, '1st Day Mems − 1st New Mems');
  assert.equal(delayed.status, undefined);
  // The ones 88F does document still carry theirs.
  assert.match(kpiOf(section, 'Verify% เฉลี่ย').note, /64\.8/);
});

// --- alerts and insights -----------------------------------------------------

test('the overview raises the alerts the month actually earned', async () => {
  const payload = await monthly.buildMonthlyPayload({ site: SITE, yearMonth: MONTH });
  const alerts = sectionOf(payload, 'overview').alerts;
  const text = alerts.map((a) => a.text).join(' | ');

  assert.match(text, /RTP เกิน 100%/);
  assert.match(text, /Revenue ติดลบ/);
  // 2 of 4 VIPs lost = 50% > the 40% warning threshold.
  assert.match(text, /Lost VIP/);
  assert.ok(alerts.some((a) => a.level === 'bad'), 'the VIP alert is the severe one');
  assert.equal(alerts.some((a) => a.level === 'ok'), false, 'no all-clear when there are alerts');
});

test('a clean month gets an explicit all-clear rather than silence', async () => {
  seed({
    site: '88fed',
    yearMonth: '2026-02',
    fileType: 'daily_value',
    rows: [
      { Date: '2026-02-01', BIn: 100, R: 30, RTP: 0.95, DAU: 400, 'BIn Mems': 200, 'BIn Mems (np)': 180, 'New Mems': 20 },
      { Date: '2026-02-02', BIn: 120, R: 35, RTP: 0.94, DAU: 410, 'BIn Mems': 210, 'BIn Mems (np)': 190, 'New Mems': 25 },
    ],
  });
  const payload = await monthly.buildMonthlyPayload({ site: '88fed', yearMonth: '2026-02' });
  const alerts = sectionOf(payload, 'overview').alerts;

  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].level, 'ok');
});

test('insights are plain sentences with the real numbers in them', async () => {
  const payload = await monthly.buildMonthlyPayload({ site: SITE, yearMonth: MONTH });
  for (const section of payload.sections.filter((s) => s.available)) {
    for (const line of section.insights) {
      assert.equal(typeof line, 'string');
      assert.ok(line.length > 20, `${section.id}: "${line}" is too short to say anything`);
      assert.equal(/undefined|NaN|\[object/.test(line), false, `${section.id}: "${line}"`);
    }
  }
});

// --- per-section correctness -------------------------------------------------

test('the overview reads VIP and deposit-count files, not just the daily export', async () => {
  const payload = await monthly.buildMonthlyPayload({ site: SITE, yearMonth: MONTH });
  const overview = sectionOf(payload, 'overview');

  assert.equal(kpiOf(overview, 'VIP ทั้งหมด').value, 4);
  // (30 + 50 + 80 + 120 → no: 21+ only) 80 + 120 = 200 of 500 = 40%.
  assert.equal(kpiOf(overview, 'Power User (21+ ครั้ง)').value, 40);
});

test('the overview still renders when its companion files are absent', async () => {
  const payload = await monthly.buildMonthlyPayload({ site: '88fed', yearMonth: '2026-02' });
  const overview = sectionOf(payload, 'overview');

  assert.equal(overview.available, true, 'a missing VIP file must not blank the overview');
  assert.equal(kpiOf(overview, 'VIP ทั้งหมด').value, null);
  assert.match(kpiOf(overview, 'VIP ทั้งหมด').note, /ยังไม่ได้อัปโหลด/);
});

test('finance counts the days that actually lost money or over-paid players', async () => {
  const payload = await monthly.buildMonthlyPayload({ site: SITE, yearMonth: MONTH });
  const finance = sectionOf(payload, 'finance');

  assert.equal(kpiOf(finance, 'วันที่ Revenue ติดลบ').value, 1);
  assert.equal(kpiOf(finance, 'วันที่ RTP > 100%').value, 2);

  const best = tableTitled(finance, 'สูงสุด');
  assert.equal(best.rows[0].date, '2026-07-02');
  assert.equal(best.rows[0].R_THB, 40 * THB_FACTOR);

  // The 100% mark is drawn, because "is this day above the line" is the whole
  // question the RTP chart exists to answer.
  assert.equal(chartOf(finance, 'finance-rtp').refLine.value, 100);
  // Losing days are painted red rather than left the same colour as the rest.
  assert.equal(chartOf(finance, 'finance-rbin').datasets[0].colorBySign, true);
});

test('activity reports the organic share as a ratio of head counts', async () => {
  const payload = await monthly.buildMonthlyPayload({ site: SITE, yearMonth: MONTH });
  const activity = sectionOf(payload, 'activity');
  // (120 + 150 + 30) / (200 + 300 + 100) = 300/600 = 50%.
  assert.equal(kpiOf(activity, 'สัดส่วน organic (np)').value, 50);
  assert.equal(kpiOf(activity, 'DAU เฉลี่ย').note, 'ต่ำสุด 400 / สูงสุด 600');
});

test('new member reports Delayed 1st Deposit and the funnel behind it', async () => {
  const payload = await monthly.buildMonthlyPayload({ site: SITE, yearMonth: MONTH });
  const section = sectionOf(payload, 'new_member');

  // (8 - 3) + (14 - 8) = 11.
  assert.equal(kpiOf(section, 'Delayed Depositors รวม').value, 11);
  assert.equal(kpiOf(section, 'ยอดฝากของ 1st New รวม').value, 14 * THB_FACTOR);
  assert.equal(kpiOf(section, 'Verify% เฉลี่ย').value, 75);
  // New (Ref.) / New = 3 / 70 — head counts, the one ratio this may compute.
  assert.ok(Math.abs(kpiOf(section, 'Referral Rate เฉลี่ย').value - 4.2857) < 0.001);

  // Funnel: New → Verify → 1st New Mems → 1st Day Mems, each strictly the
  // count of the stage before it that got further.
  const funnel = chartOf(section, 'new-member-funnel');
  assert.deepEqual(funnel.datasets[0].data, [70, 52, 11, 22]);
  assert.equal(funnel.horizontal, true);
});

test('deposit-count segments sum to BIn Mems and the indices follow the reference', async () => {
  const payload = await monthly.buildMonthlyPayload({ site: SITE, yearMonth: MONTH });
  const section = sectionOf(payload, 'deposit_count');

  // (30 + 50 + 80 + 120) / 500 = 56%.
  assert.ok(Math.abs(kpiOf(section, 'Power User Index').value - 56) < 0.001);
  // (40 + 60) / 500 = 20%.
  assert.equal(kpiOf(section, '1 Time (Casual)').value, 20);

  const table = section.tables[0];
  const shares = table.rows.reduce((total, row) => total + row.share, 0);
  assert.ok(Math.abs(shares - 100) < 0.001, `segment shares summed to ${shares}`);

  // The daily chart is a share, not a head count, or the mix would appear to
  // move whenever the size of the day moves.
  const stack = chartOf(section, 'deposit-count-stack');
  assert.equal(stack.stacked, true);
  assert.equal(stack.datasets[0].unit, 'pct');
  assert.equal(stack.datasets[0].data[0], 20);
});

test('brand/game share is money over money and flags RTP above 100%', async () => {
  const payload = await monthly.buildMonthlyPayload({ site: SITE, yearMonth: MONTH });
  const section = sectionOf(payload, 'brand_game');

  assert.equal(kpiOf(section, 'เกมที่ RTP > 100%').value, 1, 'LOTTO at 480%');
  assert.equal(section.alerts.length, 1);
  assert.equal(section.alerts[0].level, 'bad');
  assert.match(section.alerts[0].text, /LOTTO/);

  const slot = section.tables[0].rows.find((row) => row.GameKind === 'SLOT');
  // 9000 / 10100 — the site factor cancels, so the share is unaffected by it.
  assert.ok(Math.abs(slot.share - 89.108) < 0.01, `SLOT share was ${slot.share}`);
  assert.equal(slot.CIn_THB, 9000 * THB_FACTOR);
  assert.equal(slot._status.RTP_pct, 'good');

  const lotto = section.tables[0].rows.find((row) => row.GameKind === 'LOTTO');
  assert.equal(lotto._status.RTP_pct, 'bad');
});

test('VIP active/lost follows the file rule of 7 days since the last deposit', async () => {
  const payload = await monthly.buildMonthlyPayload({ site: SITE, yearMonth: MONTH });
  const section = sectionOf(payload, 'vip');

  assert.equal(kpiOf(section, 'VIP ทั้งหมด').value, 4);
  assert.equal(kpiOf(section, 'Active VIP').value, 2);
  assert.equal(kpiOf(section, 'Lost VIP').value, 2);
  // vip-members.md: 60.1% is the benchmark and below 55% is "re-engage ด่วน".
  // 50% is under both, so this is the severe badge, not the middling one.
  assert.equal(kpiOf(section, 'Active VIP').status, 'bad');

  // Top VIP is by Revenue, matching the table's own title.
  const top = tableTitled(section, 'Top 10 VIP by Revenue');
  assert.deepEqual(top.rows.map((row) => row.Username), ['carol', 'alice', 'bob', 'dave']);
  const lostTable = tableTitled(section, 'Lost VIP');
  assert.deepEqual(lostTable.rows.map((row) => row.Username), ['carol', 'dave']);
});

test('no phone number reaches the payload, from any section', async () => {
  // The VIP workbook has `Phone` on every row and the report this page
  // replaces printed it in the Lost VIP list. It must not appear here: the
  // page is reachable by URL, and a forwarded link is not something this code
  // can take back. Asserted over the whole serialised payload rather than the
  // one table, so a future section cannot quietly reintroduce it.
  const payload = await monthly.buildMonthlyPayload({ site: SITE, yearMonth: MONTH });

  // Every number seeded onto a VIP row. Checked against the serialised
  // payload, so it catches a leak through a chart label or an insight
  // sentence as well as through a table cell.
  const serialised = JSON.stringify(payload);
  for (const seeded of ['0800000001', '0800000002', '0800000003']) {
    assert.equal(serialised.includes(seeded), false, `phone ${seeded} leaked`);
  }

  // Structural, so a future section cannot reintroduce the column under a
  // different table. Prose is exempt: the Lost VIP note says the words
  // "เบอร์โทร" on purpose, to point at where the number actually lives.
  for (const section of payload.sections.filter((s) => s.available)) {
    for (const table of section.tables) {
      const where = `${section.id}: ${table.title}`;
      for (const column of table.columns) {
        assert.equal(/phone|เบอร์|โทร|mobile|tel/i.test(column.key), false, `${where} column key`);
        assert.equal(/phone|เบอร์|โทร|mobile|tel/i.test(column.label), false, `${where} column label`);
      }
      for (const row of table.rows) {
        assert.equal('Phone' in row, false, where);
        // Nothing that merely looks like a number someone could dial. Dates
        // are the one long digit string that legitimately appears in a cell.
        for (const value of Object.values(row)) {
          if (typeof value !== 'string' || /^\d{4}-\d{2}-\d{2}$/.test(value)) continue;
          assert.equal(/^\+?\d[\d\s-]{7,}$/.test(value), false, `${where}: "${value}" looks dialable`);
        }
      }
    }
  }
});

test('the Lost VIP list still identifies who to call, by username', async () => {
  const payload = await monthly.buildMonthlyPayload({ site: SITE, yearMonth: MONTH });
  const lostTable = tableTitled(sectionOf(payload, 'vip'), 'Lost VIP');

  assert.deepEqual(lostTable.rows.map((row) => row.Username), ['carol', 'dave']);
  assert.equal(lostTable.rows[0].BIn_THB, 900 * THB_FACTOR);
  // And it says where the contact details actually live.
  assert.match(lostTable.note, /ระบบหลังบ้าน/);
});

test('VIP breaks down which agent actually produced the VIPs', async () => {
  const payload = await monthly.buildMonthlyPayload({ site: SITE, yearMonth: MONTH });
  const chart = chartOf(sectionOf(payload, 'vip'), 'vip-agent');

  assert.deepEqual(chart.labels, ['agentA', 'agentB']);
  assert.deepEqual(chart.datasets[0].data, [2, 2]);
});

test('referrer flags both kinds of abuse the reference describes', async () => {
  const payload = await monthly.buildMonthlyPayload({ site: SITE, yearMonth: MONTH });
  const section = sectionOf(payload, 'referrer');

  assert.equal(kpiOf(section, 'Referrer ที่จ่ายแพงกว่าที่ได้').value, 1);
  assert.equal(kpiOf(section, 'Referrer คุณภาพต่ำ').value, 1);

  const lowQuality = tableTitled(section, 'ฝากจริงต่ำ');
  // promoter2 only: 4% conversion on 500 recruits. `tiny` has a worse-looking
  // 0% but only two recruits, which is noise, not a pattern.
  assert.deepEqual(lowQuality.rows.map((row) => row.Referrer), ['promoter2']);
  assert.equal(lowQuality.rows[0].binMemsPct, 4);
  assert.equal(lowQuality.rows[0]['Ref Bonus_THB'], 40 * THB_FACTOR);
});

test('referrer folds in the AD / Agent file when the month has one', async () => {
  const payload = await monthly.buildMonthlyPayload({ site: SITE, yearMonth: MONTH });
  const section = sectionOf(payload, 'referrer');

  const chart = chartOf(section, 'referrer-ad-agent');
  assert.deepEqual(chart.labels, ['facebook', 'tiktok']);
  assert.equal(chart.datasets[0].data[0], 90 * THB_FACTOR);
  assert.match(joined(section), /facebook/);
});

test('referrer says what is missing when the AD / Agent file is absent', async () => {
  seed({
    site: '88fed',
    yearMonth: '2026-05',
    fileType: 'referrer',
    rows: [{ Referrer: 'solo', 'Ref Bonus': 1, 'Total Mems': 10, 'Total BIn Mems': 5, BIn: 20, R: 4 }],
  });
  const payload = await monthly.buildMonthlyPayload({ site: '88fed', yearMonth: '2026-05' });
  const section = sectionOf(payload, 'referrer');

  assert.equal(section.available, true, 'the tab still works without the optional file');
  assert.equal(chartOf(section, 'referrer-ad-agent'), undefined);
  assert.match(joined(section), /ยังไม่ได้อัปโหลดไฟล์ AD \/ Agent/);
  // And it is listed as worth uploading.
  assert.ok(payload.missingFiles.some((entry) => entry.fileType === 'ad_agent'));
});

test('hours averages the weekday grid and pairs it with the head-count file', async () => {
  const payload = await monthly.buildMonthlyPayload({ site: SITE, yearMonth: MONTH });
  const section = sectionOf(payload, 'hours');

  assert.equal(kpiOf(section, 'ชั่วโมงที่เงินเข้าสูงสุด').value, '20:00');
  assert.equal(kpiOf(section, 'ชั่วโมงที่เงียบที่สุด').value, '4:00');

  const chart = chartOf(section, 'hours-avg');
  assert.deepEqual(chart.labels, ['4:00', '20:00']);
  // (90 + 110) / 2 = 100 file units at hour 20.
  assert.equal(chart.datasets[0].data[1], 100 * THB_FACTOR);

  // The sibling grid supplies "คนเฉลี่ย", which is what separates "lots of
  // people" from "one whale" in a peak hour.
  const peak = tableTitled(section, 'ช่วงพีค');
  assert.ok(peak.columns.some((column) => column.key === 'avg_mems'));
  assert.equal(peak.rows[0].weekday, 'Tuesday');
  assert.equal(peak.rows[0].hour, '20:00');
  assert.equal(peak.rows[0].avg_mems, 55);

  const quiet = tableTitled(section, 'ช่วงเงียบ');
  assert.equal(quiet.rows[0].weekday, 'Monday');
  assert.equal(quiet.rows[0].hour, '4:00');
});

test('hours drops the head-count column rather than showing an empty one', async () => {
  seed({
    site: '88fed',
    yearMonth: '2026-01',
    fileType: 'avg_bin_by_hour',
    rows: [{ weekday: 'Monday', weekday_num: 1, hour: 20, avg_bin: 50 }],
  });
  const payload = await monthly.buildMonthlyPayload({ site: '88fed', yearMonth: '2026-01' });
  const section = sectionOf(payload, 'hours');

  const peak = tableTitled(section, 'ช่วงพีค');
  assert.equal(peak.columns.some((column) => column.key === 'avg_mems'), false);
  assert.match(joined(section), /ยังไม่ได้อัปโหลดไฟล์ Average BIn Mems/);
});

test('deposit detail rolls the daily rows back up per channel and flags the bad one', async () => {
  const payload = await monthly.buildMonthlyPayload({ site: SITE, yearMonth: MONTH });
  const section = sectionOf(payload, 'deposit_detail');

  assert.equal(kpiOf(section, 'รายการฝากทั้งหมด').value, 250);
  assert.equal(kpiOf(section, 'อัตราสำเร็จรวม').value, 82);
  assert.equal(kpiOf(section, 'อัตราสำเร็จรวม').status, 'bad');

  const rows = section.tables[0].rows;
  const kpay = rows.find((row) => row.PayName === 'k_pay');
  // 180/200 across the two days — recomputed from the counts, not the mean of
  // the two daily rates.
  assert.equal(kpay.success_rate, 90);
  assert.equal(kpay.avg_duration_min, 3);
  assert.equal(kpay._status.success_rate, 'warn');

  const wave = rows.find((row) => row.PayName === 'wave_money');
  assert.equal(wave._status.success_rate, 'bad');
  assert.match(section.alerts[0].text, /wave_money/);
});

test('bonus leads with the baht cost the pipeline converted, not the raw points', async () => {
  const payload = await monthly.buildMonthlyPayload({ site: SITE, yearMonth: MONTH });
  const section = sectionOf(payload, 'bonus');
  const POINTS_THB = 100 * 0.787; // SH666 pointsScaleFactor × fxRate

  // 1000 + 1500 + 300 = 2,800 raw points.
  const cost = kpiOf(section, 'ต้นทุน Point รวม');
  assert.equal(cost.unit, 'thb');
  assert.ok(Math.abs(cost.value - 2800 * POINTS_THB) < 0.01, `cost was ${cost.value}`);
  assert.equal(kpiOf(section, 'ประเภทที่กินงบสูงสุด').value, 'Loyalty Point');

  const loyalty = section.tables[0].rows.find((row) => row.Type === 'Loyalty Point');
  assert.ok(Math.abs(loyalty.total_points_THB - 2500 * POINTS_THB) < 0.01);
  // Sorted by cost, so the biggest spend is the first row.
  assert.equal(section.tables[0].rows[0].Type, 'Loyalty Point');
});

test('bonus keeps the raw point sum, labelled as a cross-check and not as money', async () => {
  // aggregate.js is explicit that the raw column is the only figure that can
  // be checked against Power BI, and that it must never be quoted as an
  // amount. Both halves of that are asserted here.
  const payload = await monthly.buildMonthlyPayload({ site: SITE, yearMonth: MONTH });
  const section = sectionOf(payload, 'bonus');

  const raw = kpiOf(section, 'Point ดิบรวม (cross-check)');
  assert.equal(raw.value, 2800);
  assert.equal(raw.unit, 'number', 'the raw sum must not be formatted as baht');
  assert.match(raw.note, /ห้ามรายงานเป็นจำนวนเงิน/);

  const rawColumn = section.tables[0].columns.find((column) => column.key === 'total_points');
  assert.equal(rawColumn.unit, 'number');
  assert.equal(section.tables[0].rows[0].total_points, 2500);
});

test('a section whose file the parser refused explains why, in the parser own words', async () => {
  // U89 has no `pointsScaleFactor`, so aggregateBonusLog throws rather than
  // storing a wrongly-scaled figure. The tab must pass that reason through:
  // "อ่านไฟล์ไม่ได้" would send someone re-uploading a file that is fine, when
  // the fix is a config entry.
  const workbook = path.join(tmpDir, 'bonus-u89.xlsx');
  fs.writeFileSync(workbook, 'not a real workbook');
  db.upsertRawFile({
    site: 'ubet89',
    yearMonth: '2026-04',
    fileType: 'bonus_log',
    relPath: path.relative(ROOT, workbook),
    fileSize: 20,
    originalFilename: 'bonus.xlsx',
  });

  const payload = await monthly.buildMonthlyPayload({ site: 'ubet89', yearMonth: '2026-04' });
  const section = sectionOf(payload, 'bonus');

  assert.equal(section.available, false);
  assert.match(section.reason, /pointsScaleFactor/);
  // And the other tabs of that month are unaffected.
  assert.equal(sectionOf(payload, 'overview').available, true);
});

// --- missing and broken files ------------------------------------------------

test('a missing file leaves its tab present, unavailable, and named', async () => {
  // A month with only one file: the other ten tabs must still be there.
  seed({
    site: '88fed',
    yearMonth: '2026-06',
    fileType: 'vip',
    rows: [
      { Username: 'solo', Agent: 'agentZ', 'Last BIn 2 Y': 2, BIn: 500, R: 60, 'BIn Counts': 200, 'BIn Days': 90, 'Med. BIn': 12 },
    ],
  });

  const sparse = await monthly.buildMonthlyPayload({ site: '88fed', yearMonth: '2026-06' });
  assert.equal(sparse.sections.length, 11);
  assert.equal(sectionOf(sparse, 'vip').available, true);
  assert.equal(sectionOf(sparse, 'overview').available, false);
  assert.match(sectionOf(sparse, 'overview').reason, /ยังไม่ได้อัปโหลด/);
  assert.equal(sectionOf(sparse, 'overview').fileLabel, 'Daily Value');

  // Deduplicated: three sections read daily_value, and the operator only needs
  // to be told to upload it once.
  const mentions = sparse.missingFiles.filter((entry) => entry.fileType === 'daily_value');
  assert.equal(mentions.length, 1);
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
  // to re-upload a file they already sent is the failure this distinction
  // exists to prevent.
  assert.equal(payload.missingFiles.some((entry) => entry.fileType === 'daily_value'), false);
});

test('a baht site says so instead of quoting an exchange rate', async () => {
  const payload = await monthly.buildMonthlyPayload({ site: '88fed', yearMonth: '2026-06' });
  assert.equal(payload.currency.currency, 'THB');
  assert.equal(payload.currency.needsFxConversion, false);
  // The ×1,000 de-scaling still applies, so BIn 500 is ฿500,000.
  assert.equal(kpiOf(sectionOf(payload, 'vip'), 'BIn รวมทั้งกลุ่ม').value, 500 * 1000);
});

test('each file is read once even though several sections share it', async () => {
  const payload = await monthly.buildMonthlyPayload({ site: SITE, yearMonth: MONTH });
  // Eleven file types were seeded for this month and eleven sections were
  // built from them — but overview/finance/activity all read daily_value and
  // the overview reads three files, so this counts files, not section reads.
  assert.equal(payload.fileCount, 11);
});
