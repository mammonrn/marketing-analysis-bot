#!/usr/bin/env node
/**
 * Measure what a data context costs, per file type and in total.
 *
 * The question this answers: if the bot stopped picking one file type and sent
 * every file it holds for a site+month, how big would that be? Run it before
 * changing the selection rule, and again after, so the budget is a measured
 * number rather than an expectation.
 *
 * Row counts below are the realistic maxima for one month, taken from the
 * reference docs and the shapes already seen in production. No network and no
 * database — it builds rows in memory and formats them through the real
 * `formatContext`.
 */

process.env.TELEGRAM_BOT_TOKEN ??= 'measure';
process.env.ANTHROPIC_API_KEY ??= 'measure';

// Dynamic: config.js validates the env at import time, and static imports are
// hoisted above the assignments above.
const { formatContext } = await import('../src/data/query.js');
const { FILE_TYPES } = await import('../src/data/fileTypes.js');

const SITE = 'shwe666';
const MONTH = '2026-07';
const DAYS = 31;

const day = (i) => `${MONTH}-${String((i % DAYS) + 1).padStart(2, '0')}`;
const rep = (n, fn) => Array.from({ length: n }, (_, i) => fn(i));

/**
 * One generator per file type: the columns the reference doc lists, and the
 * number of rows a full month actually produces.
 */
const FIXTURES = {
  daily_value: () =>
    rep(DAYS, (i) => ({
      Date: day(i), CIn: 1075.5, Nw: 45.2, 'Nw (np)': 40.1, RTP: 0.9585, BIn: 400.25,
      'BIn (np)%': 0.683, Bo: 355.1, R: 88.6, 'BIn (P)': 120.5, Pro: 15.2, Pass: 8.1,
      'Pro R': -6.3, Bonus: 12.4, Manual: 0.5, 'R / BIn': 0.2214, DAU: 473,
      'New Mems': 773, 'BIn Mems': 409, 'BIn Mems (np)': 279, 'Pro Mems': 130,
      'Bo Mems': 388, 'Bonus Mems': 96, 'Manual Mems': 3, 'CIn (np)%': 0.712,
    })),

  new_member_quality: () =>
    rep(DAYS, (i) => ({
      Date: day(i), New: 773, 'New (Ref.)': 12, Verify: 578, 'Verify%': 0.755187,
      '1st New%': 0.0982, '1st New Mems': 76, '1st New (BIn)': 4.285,
      '1st New (np%)': 0.9321, '1st Day Mems': 108, '1st Day (BIn)': 6.104,
      '1st Day (np%)': 0.8908,
    })),

  deposit_count_distribution: () =>
    rep(DAYS, (i) => ({
      Date: day(i), 'BIn Mems': 409, '1 Time': 86, '2~5 Counts': 92,
      '6~10 Counts': 38, '11~20 Counts': 37, '21+ Counts': 156,
    })),

  brand_game_value: () =>
    rep(9, (i) => ({
      GameKind: ['SLOT', 'FISH', 'CASINO', 'GAMES', 'SPORT', 'ARCADE', 'POKER', 'LOTTO', 'PROMO'][i],
      CIn: 178512.3, 'CIn (np)%': 0.858, Nw: 6960.8, RTP: 0.961, DAU: 12043,
      'DAU% (np)': 0.84, 'Nw (np)': 5900.2, 'Nw (p)': 1060.6, 'RTP (np)': 0.958,
      'RTP (p)': 0.972, Counts: 64322702,
    })),

  vip: () =>
    rep(606, (i) => ({
      Username: `member${i}`, 'Real Name': `ชื่อจริง ${i}`, RegDate: '2025-11-04',
      Lv: null, Referrer: `ref${i % 40}`, AD: 'fbmkt', Agent: `agent${i % 12}`,
      'Last Login 2 Y': i % 30, 'Last BIn 2 Y': i % 60, BIn: 36.8, 'BIn Counts': 244,
      'BIn Days': 57, Bo: 30.1, R: 6.8, 'Pro Counts': 12, Pro: 1.2, Pass: 0.4,
      Bonus: 0.9, 'Med. BIn': 0.14, Phone: `08${String(i).padStart(8, '0')}`,
    })),

  member_detail: () =>
    rep(4000, (i) => ({
      Username: `member${i}`, Referrer: `ref${i % 200}`, BIn: 12.5, Pro: 1.1, R: 2.4,
      'BIn Days': 9, 'BIn (Pro)%': 0.32, 'Last BIn Date': day(i), 'Prefer Game': 'JILI_SLOT',
    })),

  referrer: () =>
    rep(450, (i) => ({
      Referrer: `ref${i}`, 'Ref Bonus': 3.2, 'Total Mems': 41, 'Total BIn Mems': 12,
      'BIn Mems%': 0.29, BIn: 88.4, ARPPU: 7.3, 'BIn (Pro)%': 0.31, Pro: 4.1,
      Bonus: 1.8, R: 14.2, DAU: 22, CIn: 240.5, Pw: 15.1,
    })),

  ad_agent: () =>
    rep(120, (i) => ({
      'AD / Agent': `channel${i}`, Agent: `agent${i % 9}`, 'Total Mems': 940,
      'Total BIn Mems': 310, 'BIn Mems%': 0.33, BIn: 512.4, ARPPU: 1.65,
      'BIn (Pro)%': 0.28, Pro: 20.1, Bonus: 9.4, R: 88.2, DAU: 402, CIn: 1400.2, Pw: 92.5,
    })),

  // Both transaction logs are stored as a daily summary, not row-per-txn.
  deposit_detail: () =>
    rep(DAYS * 6, (i) => ({
      Date: day(Math.floor(i / 6)), PayName: ['k_pay', 'wave_money', 'kbz', 'aya', 'cb', ''][i % 6],
      count: 210, total_points: 92400, avg_duration_m: 3.4,
    })),

  bonus_log: () =>
    rep(DAYS * 6, (i) => ({
      Date: day(Math.floor(i / 6)),
      Type: ['Cashback Point', 'Auto Cashback Point', 'Loyalty Point', 'Loyalty Point Claim', 'Reward Point', 'Referrer Reward Point'][i % 6],
      count: 380, total_points: 15400,
    })),

  // Same log shape as bonus_log, split off so they stop overwriting each other.
  reward_point: () =>
    rep(DAYS * 5, (i) => ({
      Date: day(Math.floor(i / 5)),
      Type: ['Cashback Point', 'Auto Cashback Point', 'Loyalty Point', 'Loyalty Point Claim', 'Referrer Reward Point'][i % 5],
      count: 410, total_points: 18800,
    })),

  other_transfer: () =>
    rep(DAYS * 3, (i) => ({
      Date: day(Math.floor(i / 3)),
      Type: ['manual credit', 'คืนยอดเสีย', 'ของรางวัล'][i % 3],
      count: 24, total_points: 3200,
    })),

  member_referrer_detail: () =>
    rep(2500, (i) => ({
      Username: `down${i}`, Referrer: `ref${i % 200}`, BIn: 8.2, Pro: 0.9, R: 1.7,
      'BIn Days': 4, 'Prefer Game': 'JILI_SLOT',
    })),

  avg_bin_by_hour: () =>
    rep(168, (i) => ({
      weekday: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'][Math.floor(i / 24)],
      weekday_num: Math.floor(i / 24) + 1, hour: i % 24, avg_bin: 18.4,
    })),

  avg_bin_mems_by_hour: () =>
    rep(168, (i) => ({
      weekday: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'][Math.floor(i / 24)],
      weekday_num: Math.floor(i / 24) + 1, hour: i % 24, avg_mems: 22,
    })),
};

// The repo's own estimate, as used by scripts/check-skill.mjs.
const CHARS_PER_TOKEN = 3.2;
const tokens = (chars) => Math.round(chars / CHARS_PER_TOKEN);

const results = [];

for (const type of FILE_TYPES) {
  const build = FIXTURES[type.id];
  if (!build) {
    results.push({ id: type.id, label: type.label, rows: 0, chars: 0, note: 'ไม่มี fixture' });
    continue;
  }
  const rows = build();
  const text = formatContext({
    site: SITE,
    fileType: type.id,
    availableMonths: [MONTH],
    rows: rows.map((row) => ({
      row,
      row_date: type.dateColumn ? row[type.dateColumn] ?? null : null,
      year_month: MONTH,
    })),
  });
  results.push({
    id: type.id,
    label: type.label,
    rows: rows.length,
    chars: text.length,
    path: rows.length <= 40 ? 'verbatim' : 'summary',
  });
}

results.sort((a, b) => b.chars - a.chars);

console.log(`ประมาณการต้นทุน context — ${SITE} เดือน ${MONTH}`);
console.log(`(ประมาณ token ด้วย chars / ${CHARS_PER_TOKEN} ซึ่งเป็นสูตรเดียวกับ scripts/check-skill.mjs)\n`);
console.log('file type'.padEnd(30) + 'rows'.padStart(7) + 'path'.padStart(11) + 'chars'.padStart(10) + '~tokens'.padStart(10));
console.log('-'.repeat(68));

let totalChars = 0;
for (const r of results) {
  totalChars += r.chars;
  console.log(
    r.id.padEnd(30) +
      String(r.rows).padStart(7) +
      String(r.path ?? '-').padStart(11) +
      r.chars.toLocaleString('en-US').padStart(10) +
      tokens(r.chars).toLocaleString('en-US').padStart(10),
  );
}

console.log('-'.repeat(68));
console.log(
  'รวมทุกไฟล์'.padEnd(28) +
    String(results.filter((r) => r.chars > 0).length).padStart(7) + ' types' +
    totalChars.toLocaleString('en-US').padStart(9) +
    tokens(totalChars).toLocaleString('en-US').padStart(10),
);

const skillTokens = 26773; // scripts/check-skill.mjs, current bundle
console.log(`\nsystem prompt (skill bundle):        ~${skillTokens.toLocaleString('en-US')} tokens`);
console.log(`data context ถ้าส่งทุกไฟล์:            ~${tokens(totalChars).toLocaleString('en-US')} tokens`);
console.log(`รวมต่อ 1 คำถาม:                       ~${(skillTokens + tokens(totalChars)).toLocaleString('en-US')} tokens`);
