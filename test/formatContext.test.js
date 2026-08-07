/**
 * Tests for the large-file data context.
 *
 * Dumping every row of `vip.xlsx` (602 rows) cost ~183k input tokens for one
 * question — enough that the model burned its thinking budget on the dump and
 * replied with nothing. Big files now become exact statistics over every row
 * plus a clearly labelled sample.
 *
 * The fixtures are built so that statistics computed from the 15-row sample
 * would be visibly wrong, which is the only way to prove the summary really
 * reads the whole set.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.TELEGRAM_BOT_TOKEN ??= 'test-token';
process.env.ANTHROPIC_API_KEY ??= 'test-key';

const { formatContext } = await import('../src/data/query.js');
const { normaliseRow, deriveMetrics } = await import('../src/data/transform.js');
const { SITES } = await import('../src/data/sites.js');

/** Shapes a parsed_rows row the way queryParsedRows hands it over. */
function dbRow(record, { rowDate = null, yearMonth = '2026-07' } = {}) {
  return { row: record, row_date: rowDate, year_month: yearMonth };
}

function context(rows, { fileType = 'vip', site = 'shwe666' } = {}) {
  return formatContext({ site, fileType, availableMonths: ['2026-07'], rows });
}

/** Pulls "รวม X | เฉลี่ย Y | ต่ำสุด Z | สูงสุด W | มีค่า N" back out of the block. */
function summaryFor(text, column) {
  const line = text
    .split('\n')
    .find((l) => l.startsWith(`- ${column}:`));
  if (!line) return null;
  const num = (label) => {
    const m = new RegExp(`${label} ([-\\d,.]+)`).exec(line);
    return m ? Number(m[1].replace(/,/g, '')) : null;
  };
  return { sum: num('รวม'), avg: num('เฉลี่ย'), min: num('ต่ำสุด'), max: num('สูงสุด'), count: num('มีค่า') };
}

const approx = (a, b, tolerance = 0.001) =>
  assert.ok(Math.abs(a - b) <= tolerance, `expected ${a} ≈ ${b}`);

// ---------------------------------------------------------------------------

test('statistics are computed from every row, not from the 15-row sample', () => {
  // Deliberately skewed: the 15 largest BIn values are all >= 10000, while the
  // other 185 rows are tiny. Stats taken from the sample alone would be wildly
  // higher than the truth.
  // Values repeat, as real metrics do — perfectly distinct integers would be
  // (correctly) rejected as identifiers by the value-shape rule.
  const rows = [];
  for (let i = 0; i < 185; i += 1) rows.push(dbRow({ Username: `small${i}`, BIn: 10 + (i % 40) }));
  for (let i = 0; i < 15; i += 1) rows.push(dbRow({ Username: `whale${i}`, BIn: 10000 + (i % 5) }));

  const values = rows.map((r) => r.row.BIn);
  const expected = {
    count: values.length,
    sum: values.reduce((a, b) => a + b, 0),
    min: Math.min(...values),
    max: Math.max(...values),
  };
  expected.avg = expected.sum / expected.count;

  const text = context(rows);
  const stats = summaryFor(text, 'BIn');

  assert.ok(stats, 'BIn should appear in the summary block');
  assert.equal(stats.count, expected.count);
  assert.equal(stats.sum, expected.sum);
  assert.equal(stats.min, expected.min);
  assert.equal(stats.max, expected.max);
  approx(stats.avg, expected.avg, 0.01);

  // The distinguishing check: the sample's own average is an order of
  // magnitude away, so these numbers cannot have come from it.
  const sampleAvg = 10002;
  assert.ok(
    Math.abs(stats.avg - sampleAvg) > 5000,
    `summary avg ${stats.avg} looks like it came from the sample (${sampleAvg})`,
  );
  assert.equal(stats.min, 10, 'min must come from a row outside the sample');
});

test('the average counts only rows that have a numeric value', () => {
  const rows = [];
  for (let i = 0; i < 40; i += 1) rows.push(dbRow({ Username: `u${i}`, Bonus: 100 }));
  for (let i = 0; i < 20; i += 1) rows.push(dbRow({ Username: `n${i}`, Bonus: null }));

  const stats = summaryFor(context(rows), 'Bonus');
  assert.equal(stats.count, 40, 'nulls must not be counted');
  assert.equal(stats.sum, 4000);
  assert.equal(stats.avg, 100, 'average must divide by 40, not 60');
});

test('the sample is labelled as a sample, with the real total and the selection rule', () => {
  const rows = Array.from({ length: 200 }, (_, i) =>
    dbRow({ Username: `u${i}`, BIn: i }),
  );

  const text = context(rows);

  assert.match(text, /จำนวนแถวทั้งหมด: 200/);
  assert.match(text, /คำนวณจากข้อมูลจริงครบทั้ง 200 แถว/);
  assert.match(text, /ตัวอย่างข้อมูลรายแถว 15 แถว จากทั้งหมด 200 แถว/);
  assert.match(text, /ไม่ใช่ข้อมูลครบ/);
  assert.match(text, /เกณฑ์การเลือก:/);
  // The guard that stops per-row questions being answered from the sample.
  assert.match(text, /อีก 185 แถวไม่ได้ถูกส่งมา/);
  assert.match(text, /ห้ามตอบคำถามที่ต้องดูแถวรายตัว/);
  assert.match(text, /ห้ามเดา/);
});

test('rows with dates are sampled newest first', () => {
  const rows = Array.from({ length: 60 }, (_, i) =>
    dbRow(
      { Date: `2026-07-${String((i % 28) + 1).padStart(2, '0')}`, BIn: i },
      { rowDate: `2026-07-${String((i % 28) + 1).padStart(2, '0')}` },
    ),
  );

  const text = context(rows, { fileType: 'daily_value' });
  assert.match(text, /เรียงตามวันที่ล่าสุด/);

  const sampleSection = text.split('===== ตัวอย่างข้อมูลรายแถว')[1];
  const dates = [...sampleSection.matchAll(/\[2026-07 (\d{4}-\d{2}-\d{2})\]/g)].map((m) => m[1]);
  assert.equal(dates.length, 15);
  assert.deepEqual(dates, [...dates].sort().reverse(), 'sample must be newest first');
});

test('snapshots are sampled by the largest-sum column, descending', () => {
  // Bonus sums far higher than BIn, so it should be the ranking column.
  const rows = Array.from({ length: 100 }, (_, i) =>
    dbRow({ Username: `u${i}`, BIn: i % 13, Bonus: (i % 20) * 1000 }),
  );

  const text = context(rows);
  // Bonus is a money column, so normaliseRow adds Bonus_THB with a larger sum;
  // ranking picks whichever tops the summary block, which is that companion.
  assert.match(text, /เรียงตาม `Bonus(_THB)?` จากมากไปน้อย/);

  const sampleSection = text.split('===== ตัวอย่างข้อมูลรายแถว')[1];
  const bonuses = [...sampleSection.matchAll(/"Bonus":(\d+)/g)].map((m) => Number(m[1]));
  assert.equal(bonuses.length, 15);
  assert.deepEqual(bonuses, [...bonuses].sort((a, b) => b - a));
  assert.equal(bonuses[0], 19000, 'the largest row must be first');
});

// --- identifier filtering ---------------------------------------------------

test('identifier-looking columns are excluded from the summary and from ranking', () => {
  // member_id and Phone parse as numbers but are keys, not metrics.
  const rows = Array.from({ length: 100 }, (_, i) =>
    dbRow({
      member_id: 500000 + i,
      Phone: 900000000 + i,
      'Member ID': 700000 + i,
      Username: `u${i}`,
      BIn: 10 + (i % 7),
    }),
  );

  const text = context(rows);

  assert.equal(summaryFor(text, 'member_id'), null, 'member_id must not be summarised');
  assert.equal(summaryFor(text, 'Phone'), null, 'Phone must not be summarised');
  assert.equal(summaryFor(text, 'Member ID'), null, 'spaced "Member ID" must be caught too');
  assert.ok(summaryFor(text, 'BIn'), 'the real metric must survive');

  // And none of them may become the ranking column — it has to be the metric.
  assert.match(text, /เรียงตาม `BIn(_THB)?` จากมากไปน้อย/);
  assert.ok(!/เรียงตาม `(member_id|Phone|Member ID)`/.test(text));
});

test('an unnamed column whose values are near-unique integers is treated as an id', () => {
  // No identifier-ish name at all — only the value shape gives it away.
  const rows = Array.from({ length: 100 }, (_, i) =>
    dbRow({ ticket: 40000 + i, BIn: 5 + (i % 4) }),
  );

  const text = context(rows);
  assert.equal(summaryFor(text, 'ticket'), null, '100 distinct integers over 100 rows is a key');
  assert.ok(summaryFor(text, 'BIn'), 'a repeating metric must survive');
});

test('a near-unique but non-integer column is kept — money is not an id', () => {
  const rows = Array.from({ length: 100 }, (_, i) =>
    dbRow({ Username: `u${i}`, BIn: 1000.5 + i }),
  );
  assert.ok(summaryFor(context(rows), 'BIn'), 'decimals are measurements, not keys');
});

test('with every numeric column filtered out, the sample says it is unordered', () => {
  const rows = Array.from({ length: 100 }, (_, i) =>
    dbRow({ member_id: 1000 + i, Username: `u${i}` }),
  );

  const text = context(rows);
  assert.match(text, /ไม่พบคอลัมน์ตัวเลขที่เป็น metric/);
  assert.match(text, /ไม่ได้เรียงตามความสำคัญ/);

  const sampleSection = text.split('===== ตัวอย่างข้อมูลรายแถว')[1];
  const names = [...sampleSection.matchAll(/"Username":"(u\d+)"/g)].map((m) => m[1]);
  assert.deepEqual(names.slice(0, 3), ['u0', 'u1', 'u2'], 'falls back to original order');
});

// --- currency guidance ------------------------------------------------------

test('the header states the source currency and what _THB already means', () => {
  const rows = [dbRow({ Date: '2026-07-01', BIn: 1000 }, { rowDate: '2026-07-01' })];
  const text = context(rows, { fileType: 'daily_value', site: 'shwe666' });

  assert.match(text, /สกุลเงินต้นทาง: MMK/);
  assert.match(text, /ค่าที่แปลงเป็นเงินบาทเรียบร้อยแล้ว/);
  // The instruction that stops the raw MMK figure being quoted as baht, and
  // the one that stops the converted figure being multiplied a second time.
  assert.match(text, /ให้อ้างอิงคอลัมน์ `_THB` เสมอ/);
  assert.match(text, /ห้ามนำไปคูณซ้ำอีก/);
  assert.match(text, /cross-check/);
});

test('the rate in the header comes from config, not a hardcoded string', () => {
  const site = SITES.shwe666;

  const rows = [dbRow({ Date: '2026-07-01', BIn: 1000 }, { rowDate: '2026-07-01' })];
  const text = context(rows, { fileType: 'daily_value', site: 'shwe666' });

  assert.ok(
    text.includes(`× 1,000 × ${site.fxRate} — rate ณ ${site.fxRateAsOf}`),
    `header must quote the configured rate ${site.fxRate} as of ${site.fxRateAsOf}`,
  );
  // And the figure in the rows agrees with what the header claims.
  assert.ok(text.includes(`"BIn_THB":${1000 * site.scaleFactor * site.fxRate}`));
});

test('a THB site is not told about an exchange rate it does not have', () => {
  const rows = [dbRow({ Date: '2026-07-01', BIn: 1000 }, { rowDate: '2026-07-01' })];
  const text = context(rows, { fileType: 'daily_value', site: 'ubet89' });

  assert.match(text, /สกุลเงินต้นทาง: THB/);
  assert.match(text, /ไม่มีการแปลงสกุลเงิน/);
  // "× 1" would read as a conversion that happened, and a rate date would
  // imply a rate that can go stale. Neither belongs here.
  assert.ok(!/× 1 —/.test(text), 'no phantom ×1 conversion');
  assert.ok(!/rate ณ/.test(text), 'no exchange-rate date for a baht site');
  // But _THB is still the column to quote, because the ×1,000 still applies.
  assert.match(text, /ให้อ้างอิงคอลัมน์ `_THB` เสมอ/);
  assert.ok(text.includes('"BIn_THB":1000000'));
});

test('in the stats block the converted column leads its raw twin, both labelled', () => {
  const rows = Array.from({ length: 45 }, (_, i) =>
    dbRow({ Username: `u${i}`, BIn: 1000 + (i % 7), DAU: 470 }),
  );

  const text = context(rows, { site: 'shwe666' });
  const lines = text.split('\n').filter((l) => l.startsWith('- '));

  const thbAt = lines.findIndex((l) => l.startsWith('- BIn_THB:'));
  const rawAt = lines.findIndex((l) => l.startsWith('- BIn:'));
  assert.ok(thbAt >= 0 && rawAt >= 0, 'both columns must be summarised');
  assert.ok(thbAt < rawAt, 'the baht figure must be the one read first');

  assert.match(lines[thbAt], /หน่วย: บาท$/);
  assert.match(lines[rawAt], /หน่วย: ค่าดิบตามไฟล์ ยังไม่แปลงเป็นบาท$/);
  // A head count has no currency unit and must not be given one.
  const dau = lines.find((l) => l.startsWith('- DAU:'));
  assert.ok(dau && !dau.includes('หน่วย:'), 'DAU is people, not money');
});

// --- the 40-row boundary ----------------------------------------------------

test('40 rows keeps the original verbatim format exactly', () => {
  const rows = Array.from({ length: 40 }, (_, i) => dbRow({ Username: `u${i}`, BIn: i }));
  const text = context(rows);

  assert.match(text, /จำนวนแถว: 40/);
  assert.ok(!text.includes('====='), 'no summary blocks below the threshold');
  assert.ok(!text.includes('ตัวอย่าง'), 'nothing may be described as a sample');
  // Every row is present, in order, in the original `[meta] {json}` shape —
  // compared against the same enrichment the old code applied, so this really
  // pins "unchanged" rather than just "looks similar".
  const expected = rows.map(
    (r) =>
      `[2026-07] ${JSON.stringify({ ...normaliseRow(r.row, 'shwe666'), ...deriveMetrics(r.row, 'shwe666') })}`,
  );
  const lines = text.trim().split('\n').filter((l) => l.startsWith('['));
  assert.deepEqual(lines, expected);
});

test('41 rows switches to the summarised format', () => {
  const rows = Array.from({ length: 41 }, (_, i) => dbRow({ Username: `u${i}`, BIn: i }));
  const text = context(rows);

  assert.match(text, /จำนวนแถวทั้งหมด: 41/);
  assert.match(text, /คำนวณจากข้อมูลจริงครบทั้ง 41 แถว/);
  assert.match(text, /ตัวอย่างข้อมูลรายแถว 15 แถว จากทั้งหมด 41 แถว/);
  assert.equal(text.split('\n').filter((l) => l.startsWith('[')).length, 15);
});

test('a full 31-day month of daily_value stays verbatim, every day addressable', () => {
  // The case that moved the limit: a monthly daily_value export sat at 31-33
  // rows, just over the old 30, so ranking questions ("ยอดสูงสุดวันไหน") lost
  // the per-day rows they can only be answered from.
  const rows = Array.from({ length: 31 }, (_, i) => {
    const date = `2026-07-${String(i + 1).padStart(2, '0')}`;
    return dbRow({ Date: date, BIn: 1000 + i, DAU: 400 + i }, { rowDate: date });
  });

  const text = context(rows, { fileType: 'daily_value' });

  assert.match(text, /จำนวนแถว: 31/);
  assert.ok(!text.includes('====='), 'a whole month must not be summarised away');
  assert.equal(text.split('\n').filter((l) => l.startsWith('[')).length, 31);
  // Every single day is present and quotable, not just the sampled 15.
  for (let i = 1; i <= 31; i += 1) {
    assert.ok(
      text.includes(`2026-07-${String(i).padStart(2, '0')}`),
      `day ${i} must be in the context`,
    );
  }
});

// --- the case that started this ---------------------------------------------

test('a vip.xlsx-shaped file of 602 rows shrinks the context substantially', () => {
  const rows = Array.from({ length: 602 }, (_, i) =>
    dbRow({
      Username: `swmember${i}`,
      'Real Name': `Member Name ${i}`,
      member_id: 500000 + i,
      Phone: `09${String(200000000 + i)}`,
      RegDate: '2026-02-21',
      'Last BIn 2 Y': i % 30,
      BIn: 100.5 + i * 3,
      'BIn Counts': 10 + (i % 90),
      'BIn Days': 1 + (i % 28),
      Bo: 50.25 + i * 2,
      R: 20.1 + i,
      'Med. BIn': 15 + (i % 40),
    }),
  );

  const summarised = formatContext({
    site: 'shwe666',
    fileType: 'vip',
    availableMonths: ['2026-07'],
    rows,
  });

  // What the old code produced: every row as JSON.
  const dumped =
    `ประเภทไฟล์: VIP Members (vip)\nเว็บ: SH666\nเดือนที่มีข้อมูล: 2026-07\nจำนวนแถว: 602\n\n` +
    rows.map((r) => `[${r.year_month}] ${JSON.stringify(r.row)}`).join('\n');

  // The repo's own approximation, from prompt/loader.js.
  const tokens = (text) => Math.round(text.length / 3.2);

  const reduction = 1 - summarised.length / dumped.length;
  console.log(
    `\n  vip.xlsx (602 rows): ${dumped.length} chars (~${tokens(dumped)} tokens) ` +
      `-> ${summarised.length} chars (~${tokens(summarised)} tokens), ` +
      `${(reduction * 100).toFixed(1)}% smaller\n`,
  );

  assert.ok(reduction > 0.8, `expected a large reduction, got ${(reduction * 100).toFixed(1)}%`);
  // Statistics still cover all 602 rows.
  assert.match(summarised, /คำนวณจากข้อมูลจริงครบทั้ง 602 แถว/);
  const stats = summaryFor(summarised, 'BIn');
  const expectedSum = rows.reduce((total, r) => total + r.row.BIn, 0);
  approx(stats.sum, expectedSum, 1);
  // And the identifier columns stayed out of it.
  assert.equal(summaryFor(summarised, 'member_id'), null);
  assert.equal(summaryFor(summarised, 'Phone'), null);
});
