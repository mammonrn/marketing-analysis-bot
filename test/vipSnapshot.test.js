/**
 * The three faults reported against `vip.xlsx` (SH666, 2026-07), pinned to the
 * figures pandas reads off the real file:
 *
 *   606 rows | 429 with a numeric BIn | BIn 5,339.26 | R 1,190.95
 *   R/BIn 22.31% | Last BIn 2 Y <= 7: 321 | > 7: 283
 *
 * The bot was answering 602 / 426 / 24.3%, and saying it could not work out
 * Active VIP% at all.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.TELEGRAM_BOT_TOKEN ??= 'test-token';
process.env.ANTHROPIC_API_KEY ??= 'test-key';

const { formatContext } = await import('../src/data/query.js');
const { dropNonDataRows } = await import('../src/data/workbook.js');
const { getFileType } = await import('../src/data/fileTypes.js');

const VIP_HEADERS = [
  'Username', 'Last Login 2 Y', 'Last BIn 2 Y', 'BIn', 'BIn Counts', 'BIn Days',
  'Bo', 'R', 'Pro', 'Pass', 'Bonus', 'Med. BIn',
];

/**
 * A stand-in for the real sheet that reproduces its shape exactly: 606 rows,
 * of which 429 carry a numeric BIn, 604 carry a `Last BIn 2 Y` (321 of them
 * <= 7), and the BIn / R columns sum to the reference totals.
 *
 * Four of the usernames are the ones the old filter deleted — `total`, `sum`,
 * `รวม` and `sum 99` — and they sit in the body of the sheet, where the export
 * sorted them, not at the bottom where Power BI's own furniture goes.
 */
function buildVipRows() {
  const rows = [];

  // 321 active members (<= 7 days) and 283 lost (> 7), 604 with a value.
  for (let i = 0; i < 604; i += 1) {
    rows.push({
      Username: `member${i}`,
      'Last Login 2 Y': 1,
      'Last BIn 2 Y': i < 321 ? i % 8 : 8 + (i % 90),
      BIn: null,
      'BIn Counts': 10,
      'BIn Days': 5,
      Bo: 1,
      R: null,
      Pro: 0,
      Pass: 0,
      Bonus: 0,
      'Med. BIn': 1,
    });
  }
  // Two members with no Last BIn 2 Y at all — 606 rows, 604 counted.
  for (let i = 0; i < 2; i += 1) {
    rows.push({
      Username: `nodate${i}`,
      'Last Login 2 Y': 1,
      'Last BIn 2 Y': null,
      BIn: null,
      'BIn Counts': 0,
      'BIn Days': 0,
      Bo: 0,
      R: null,
      Pro: 0,
      Pass: 0,
      Bonus: 0,
      'Med. BIn': 0,
    });
  }

  // 429 of the 606 carry a numeric BIn, summing to 5,339.26, with R summing
  // to 1,190.95 over the same rows.
  const BIN_TOTAL = 5339.26;
  const R_TOTAL = 1190.95;
  for (let i = 0; i < 429; i += 1) {
    rows[i].BIn = i === 428 ? null : 12;
    rows[i].R = i === 428 ? null : 2;
  }
  // Put the remainder on the last of the 429 so the totals land exactly.
  rows[428].BIn = Number((BIN_TOTAL - 12 * 428).toFixed(2));
  rows[428].R = Number((R_TOTAL - 2 * 428).toFixed(2));

  // The four real members whose usernames collide with the furniture labels,
  // placed in the middle of the sheet.
  ['total', 'sum', 'รวม', 'sum 99'].forEach((name, i) => {
    rows[100 + i].Username = name;
  });

  return rows;
}

const dbRows = (rows) =>
  rows.map((row) => ({ row, row_date: null, year_month: '2026-07' }));

const vipContext = (rows) =>
  formatContext({
    site: 'shwe666',
    fileType: 'vip',
    availableMonths: ['2026-07'],
    rows: dbRows(rows),
  });

// --- 1. the missing rows -----------------------------------------------------

test('a member whose username looks like a summary label is not furniture', () => {
  const rows = buildVipRows();
  const kept = dropNonDataRows(rows, {
    headers: VIP_HEADERS,
    dateColumn: getFileType('vip').dateColumn,
    leadColumnIsUserText: getFileType('vip').leadColumnIsUserText,
  });

  assert.equal(kept.length, 606, 'no real member is dropped');
  for (const name of ['total', 'sum', 'รวม', 'sum 99']) {
    assert.ok(
      kept.some((r) => r.Username === name),
      `the member called "${name}" survives the read`,
    );
  }
});

test('the trailing Applied filters / Total block is still dropped', () => {
  const rows = [
    ...buildVipRows(),
    { Username: 'Total', 'Last BIn 2 Y': null, BIn: 5339.26, R: 1190.95 },
    { Username: 'Applied filters: Site is SH666', 'Last BIn 2 Y': null, BIn: null, R: null },
  ];

  const kept = dropNonDataRows(rows, {
    headers: VIP_HEADERS,
    dateColumn: null,
    leadColumnIsUserText: true,
  });

  assert.equal(kept.length, 606, 'both furniture rows go, no member goes with them');
  assert.ok(!kept.some((r) => r.Username === 'Applied filters: Site is SH666'));
  // The member named "total" in the body stays; the Total row at the bottom does not.
  const totals = kept.filter((r) => r.Username === 'total' || r.Username === 'Total');
  assert.equal(totals.length, 1);
  assert.equal(totals[0].Username, 'total', 'the body one is the member');
});

test('a time-series file still loses its Total and trailer rows', () => {
  // Regression: daily_value has a real date column and a Date axis in the lead
  // column, so both original tests must keep firing exactly as before.
  const headers = ['Date', 'RTP', 'BIn', 'DAU'];
  const rows = [
    { Date: '2026-07-01', RTP: 0.95, BIn: 100, DAU: 470 },
    { Date: '2026-07-02', RTP: 0.96, BIn: 110, DAU: 480 },
    { Date: 'Total', RTP: null, BIn: 210, DAU: 950 },
    { Date: null, RTP: null, BIn: 210, DAU: 950 },
    { Date: 'Applied filters: ...', RTP: null, BIn: null, DAU: null },
  ];

  const kept = dropNonDataRows(rows, { headers, dateColumn: 'Date' });
  assert.equal(kept.length, 2);
  assert.deepEqual(kept.map((r) => r.Date), ['2026-07-01', '2026-07-02']);
});

// --- the reference figures ---------------------------------------------------

test('the summary reports the real row and column counts', () => {
  const text = vipContext(buildVipRows());

  assert.match(text, /จำนวนแถวทั้งหมด: 606/);
  const binLine = text.split('\n').find((l) => l.startsWith('- BIn:'));
  assert.ok(binLine, 'BIn is summarised');
  assert.match(binLine, /มีค่า 429 แถว/);
  assert.match(binLine, /รวม 5,339\.26/);

  const rLine = text.split('\n').find((l) => l.startsWith('- R:'));
  assert.match(rLine, /รวม 1,190\.95/);
});

// --- 2. the ratio ------------------------------------------------------------

test('R/BIn is computed from the file and stated outright', () => {
  const text = vipContext(buildVipRows());

  const line = text.split('\n').find((l) => l.startsWith('- R / BIn ='));
  assert.ok(line, 'the ratio is in the summary block, not left to the model');
  // 1,190.95 / 5,339.26 = 22.3055%, and emphatically not daily_value's 24.3%.
  assert.match(line, /22\.3055%/);
  assert.match(line, /R 1,190\.95 ÷ BIn 5,339\.26/);
  assert.ok(!line.includes('24.3'));
});

test('the ratio uses the totals, not the mean of the per-row ratios', () => {
  // Two rows: sums give 110/1010 = 10.89%; the mean of the row ratios would be
  // (10% + 100%)/2 = 55%. They are different numbers and only one is right.
  const rows = Array.from({ length: 41 }, (_, i) =>
    i === 0 ? { Username: 'whale', BIn: 1000, R: 100 } : { Username: `u${i}`, BIn: 0.25, R: 0.25 },
  );
  const line = vipContext(rows).split('\n').find((l) => l.startsWith('- R / BIn ='));
  assert.match(line, /10\.89/);
});

test('the header forbids reusing numbers from another file or an earlier turn', () => {
  const text = vipContext(buildVipRows());
  assert.match(text, /ตัวเลขทุกตัวในบล็อกนี้เป็นของ\*\*ไฟล์ชุดนี้เท่านั้น\*\*/);
  assert.match(text, /ห้ามนำค่าจากไฟล์ประเภทอื่น หรือจากคำตอบก่อนหน้าในบทสนทนา/);
});

// --- 3. the threshold counts -------------------------------------------------

test('Active and Lost VIP are counted from every row', () => {
  const text = vipContext(buildVipRows());

  assert.match(text, /นับตามเกณฑ์จากคอลัมน์ `Last BIn 2 Y` \(จาก 604 แถวที่มีค่า\)/);
  // The counts are the reference figures exactly. The percentages are over the
  // 604 rows that have a value, not all 606 — a member with no `Last BIn 2 Y`
  // is neither Active nor Lost, and the two shares add to 100%.
  assert.match(text, /Active VIP \(Last BIn 2 Y <= 7 วัน\): 321 แถว \(53\.1457%\)/);
  assert.match(text, /Lost VIP \(Last BIn 2 Y > 7 วัน\): 283 แถว \(46\.8543%\)/);
  // The two rows with no value are declared rather than folded into a bucket.
  assert.match(text, /อีก 2 แถวไม่มีค่าในคอลัมน์นี้/);
});

test('a file type with no thresholds configured gets no count block', () => {
  const rows = Array.from({ length: 45 }, (_, i) => ({ Date: `2026-07-${i}`, BIn: 10, R: 2 }));
  const text = formatContext({
    site: 'shwe666',
    fileType: 'daily_value',
    availableMonths: ['2026-07'],
    rows: rows.map((row) => ({ row, row_date: null, year_month: '2026-07' })),
  });
  assert.ok(!text.includes('นับตามเกณฑ์จากคอลัมน์'));
});

test('the thresholds come from config, not from a literal in the code', async () => {
  const { thresholdGroupsFor } = await import('../src/data/thresholds.js');
  const [group] = thresholdGroupsFor('vip');

  assert.equal(group.column, 'Last BIn 2 Y');
  assert.match(group.source, /vip-members\.md/, 'the entry names the doc it came from');
  assert.deepEqual(
    group.buckets.map((b) => [b.op, b.value]),
    [['lte', 7], ['gt', 7]],
  );
});
