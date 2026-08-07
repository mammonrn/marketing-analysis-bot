/**
 * Question → data context (replaces the old Sheets-backed `buildDataContext`).
 * `pickFileType` is `pickTabKey`'s routing logic carried over under the new
 * `file_type` names; `buildDataContext` looks at the last 3 calendar months
 * (spec §3B's own comparison scope) for whichever raw files exist, parses
 * any that haven't been yet, and formats the rows for `claude/client.js`.
 */

import { getFileType, FILE_TYPES, FILE_TYPE_IDS } from './fileTypes.js';
import { siteDisplayName, getSite } from './sites.js';
import { normaliseRow, deriveMetrics, toNumber } from './transform.js';
import { thresholdGroupsFor, countByThresholds } from './thresholds.js';
import { ensureParsed } from './parse.js';
import { findRawFile, queryParsedRows, listRawFiles } from './db.js';
import { logger } from '../logger.js';

/**
 * Question → file type. A wrong pick fails in the most confusing way possible:
 * `daily_value` is the fallback and it is almost always uploaded, so the model
 * receives a context that is real but about the wrong report, and truthfully
 * reports that the file the user asked about "has not been uploaded" — while
 * it sits in the database. That is the bug this list keeps having.
 *
 * Hence the language rule: these questions arrive in Thai, in English, and
 * mixed inside one sentence ("คุณภาพ new member เดือน 7 เป็นยังไง"), because the
 * column names in the exports are English while the conversation is Thai.
 * Every route therefore needs the Thai term, the English term, AND the way
 * they get spliced together. A route with only its Thai patterns silently
 * routes half its real traffic to `daily_value`.
 */
const ROUTES = [
  {
    fileType: 'vip',
    patterns: [/\bvip\b/i, /big bettor/i, /high.?roller/i, /ลูกค้าใหญ่/, /ลูกค้า vip/i],
  },
  {
    fileType: 'new_member_quality',
    patterns: [
      /สมาชิกใหม่/,
      /1st new/i,
      /1st day/i,
      /1st dep/i,
      /delayed deposit/i,
      /ฝากช้า/,
      /\bverify/i,
      /ยืนยันตัวตน/,
      // The English and mixed forms of "new member", which is what the
      // reported failure was asked in. `mem` covers "new mems" (the export's
      // own column name) and "new member(s)" in one.
      /\bnew\s*mem/i,
      /member\s*ใหม่/i,
      /สมัครใหม่/,
      /คนใหม่/,
      // "คุณภาพ member" / "member quality" — the report's own subject, in
      // either language, without the word "new".
      /คุณภาพ\s*(ของ)?\s*(new\s*)?(member|mem|สมาชิก)/i,
      /member quality/i,
    ],
  },
  {
    fileType: 'deposit_count_distribution',
    patterns: [
      /power user/i,
      /casual/i,
      /21\+/,
      /จำนวนครั้ง.*ฝาก/,
      /ฝาก.*จำนวนครั้ง/,
      /ความถี่.*ฝาก/,
      /ฝาก.*ความถี่/,
      /deposit count/i,
      /deposit frequency/i,
      /ฝากกี่ครั้ง/,
    ],
  },
  {
    fileType: 'brand_game_value',
    patterns: [
      /สล็อต/,
      /brand value/i,
      /fish shooting/i,
      /ยิงปลา/,
      /gamekind/i,
      /ประเภทเกม/,
      // The English game names are what the export actually contains, so they
      // are what people type: "slot vs fish เป็นยังไง".
      /\bslot\b/i,
      /\bfish\b/i,
      /game kind/i,
      /game type/i,
      /ค่ายเกม/,
      /เกมไหน/,
    ],
  },
  // The types below had no route at all, which is why "referrer คนไหนสร้าง
  // มูลค่าจริง" scored as `daily_value`. Harmless now that a miss only affects
  // ordering, but the ordering is still worth getting right.
  {
    fileType: 'referrer',
    patterns: [/referrer/i, /ผู้แนะนำ/, /ชวนเพื่อน/, /แนะนำเพื่อน/, /referral/i, /commission/i, /ค่าคอม/],
  },
  {
    fileType: 'member_referrer_detail',
    patterns: [/member referrer/i, /downline/i, /ลูกทีม/, /คนที่ถูกแนะนำ/],
  },
  {
    fileType: 'ad_agent',
    patterns: [/\bagent\b/i, /\bad\b.*agent/i, /ช่องทางโฆษณา/, /เอเย่นต์/, /ตัวแทน/],
  },
  {
    fileType: 'member_detail',
    patterns: [/member detail/i, /รายชื่อ.*member/i, /prefer game/i, /เกมที่ชอบ/],
  },
  {
    fileType: 'bonus_log',
    patterns: [/\bbonus\b/i, /โบนัส/, /loyalty point/i, /cashback/i, /ค่าน้ำ/],
  },
  {
    fileType: 'reward_point',
    patterns: [/reward point/i, /รีวอร์ด/, /แต้มสะสม/],
  },
  {
    fileType: 'other_transfer',
    patterns: [/other transfer/i, /manual credit/i, /เติมเครดิตมือ/, /คืนยอดเสีย/, /โอนพิเศษ/],
  },
  {
    fileType: 'deposit_detail',
    patterns: [/payname/i, /ช่องทางฝาก/, /ช่องทางการฝาก/, /ธนาคาร/, /deposit detail/i, /รายการฝาก/],
  },
  {
    fileType: 'avg_bin_by_hour',
    patterns: [/ชั่วโมง/, /ช่วงเวลา/, /peak/i, /by hour/i, /เวลาไหน/, /ยิงแอดตอนไหน/],
  },
];

/** Defaults to `daily_value` for anything that doesn't match a more specific route. */
export function pickFileType(question) {
  const text = String(question ?? '');
  return ROUTES.find((route) => route.patterns.some((re) => re.test(text)))?.fileType ?? 'daily_value';
}

function lastNYearMonths(n, from = new Date()) {
  const out = [];
  for (let i = n - 1; i >= 0; i -= 1) {
    const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

/**
 * At or below this many rows every row is sent verbatim, exactly as before.
 * The ordinary daily exports are a few dozen rows and must not change shape.
 *
 * 40, not 30: a month of `daily_value` is 28-31 rows, so 30 cut the commonest
 * file in the project in half and lost the per-day rows that "วันไหนยอดสูงสุด /
 * ต่ำสุด" needs — the summary block carries min/max but not *which day*. One
 * limit for every file type, deliberately: what makes a context too big is its
 * row count, not which export produced it, and a per-type table would drift out
 * of date the moment a new type is added.
 */
const DETAIL_ROW_LIMIT = 40;

/** How many real rows accompany the summary once a file is too big to send whole. */
const SAMPLE_ROW_LIMIT = 15;

/**
 * A column that parses as a number is not necessarily a metric. Summing
 * member ids or phone numbers produces a confident-looking figure that means
 * nothing, so anything named like an identifier is excluded.
 *
 * `(^|_)id($|_)` already covers both `member_id` and `id_foo`, so no separate
 * prefix/suffix test is needed.
 */
const IDENTIFIER_NAME =
  /(^|_)(id|no|code|rank|order|seq|phone|tel|mobile|account|acc)($|_)/i;

/** Spaces and punctuation are normalised to `_` so "Member ID" is caught too. */
function looksLikeIdentifierName(name) {
  return IDENTIFIER_NAME.test(String(name).trim().replace(/[\s.\-/()]+/g, '_'));
}

/**
 * The second identifier test, on the values rather than the name: whole
 * numbers that are almost all distinct are keys, not measurements. A real
 * metric repeats itself.
 */
function looksLikeIdentifierValues(values, rowCount) {
  if (values.length === 0 || rowCount === 0) return false;
  if (!values.every((value) => Number.isInteger(value))) return false;
  return new Set(values).size >= rowCount * 0.95;
}

/**
 * Columns worth summarising, discovered from the data rather than declared
 * per file type — the exports gain and lose columns over time and a hardcoded
 * list would quietly stop covering them.
 *
 * A column counts as numeric only if every non-empty value parses as a
 * number; one stray label means it is a text column that happens to contain
 * digits, not a metric.
 */
function numericColumnStats(records) {
  const seen = new Map();

  for (const record of records) {
    for (const [column, raw] of Object.entries(record)) {
      if (!seen.has(column)) seen.set(column, { values: [], nonNumeric: 0 });
      const entry = seen.get(column);

      if (raw === null || raw === undefined || raw === '') continue;
      const value = toNumber(raw);
      if (value === null) entry.nonNumeric += 1;
      else entry.values.push(value);
    }
  }

  const stats = [];
  for (const [column, { values, nonNumeric }] of seen) {
    if (values.length === 0 || nonNumeric > 0) continue;
    if (looksLikeIdentifierName(column)) continue;
    if (looksLikeIdentifierValues(values, records.length)) continue;

    const sum = values.reduce((total, value) => total + value, 0);
    stats.push({
      column,
      count: values.length,
      sum,
      avg: sum / values.length,
      min: Math.min(...values),
      max: Math.max(...values),
    });
  }
  return stats;
}

const numberFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 });
const fmt = (n) => numberFormat.format(n);

function renderRow(record, meta) {
  return `[${meta}] ${JSON.stringify(record)}`;
}

/**
 * States the site's currency and what the `_THB` suffix means.
 *
 * `normaliseRow` has always added a correct `BIn_THB` beside the raw `BIn`,
 * and SH666's was right to the baht — but nothing ever told the model which
 * of the two to quote. Worse, `SKILL.md` used to teach the conversion as
 * something the analyst performs (`df[col + "_THB"] = df[col] * FACTOR`), so
 * from the model's side `_THB` read as a column it was supposed to produce,
 * not one it had been handed. Quoting the raw MMK figure as baht and
 * multiplying the already-converted one a second time were both consistent
 * with its instructions. This block is what makes them not — and the skill
 * files now point at this header instead of carrying a formula of their own,
 * so the two no longer contradict each other.
 *
 * Every number comes from the site's own config entry, so a fourth site
 * describes itself correctly the day it is added.
 */
/**
 * The percentage counterpart of `currencyGuidance`, and it exists for exactly
 * the same reason.
 *
 * `normaliseRow` adds a correct `Verify%_pct` (75.5) beside the raw
 * `Verify%` (0.755187) — Power BI stores these as decimals — but nothing ever
 * said so. The reference files, meanwhile, tell the analyst to "คูณ 100 ก่อนแสดง",
 * which makes `_pct` read as a column it is supposed to produce rather than
 * one it has been handed. Both failure modes follow from that: reporting the
 * raw decimal as "Verify 0.76%", and multiplying the already-converted
 * `_pct` by 100 again for "7,551%".
 *
 * Kept separate from the currency block because it applies to every site
 * identically — there is no per-site rate involved, only a decimal convention.
 */
const PERCENT_GUIDANCE =
  `คอลัมน์ที่ลงท้าย \`_pct\` คือค่าที่แปลงเป็นเปอร์เซ็นต์เรียบร้อยแล้ว (× 100 ให้แล้ว)\n` +
  `ให้อ้างอิงคอลัมน์ \`_pct\` เสมอเมื่อพูดถึงเปอร์เซ็นต์ ห้ามนำไปคูณ 100 ซ้ำอีก\n` +
  `คอลัมน์ดิบคู่ของมัน (เช่น \`Verify%\` = 0.755187) เป็นทศนิยมตามที่ Power BI เก็บ ` +
  `ห้ามรายงานเป็นเปอร์เซ็นต์โดยตรง — ค่าที่ถูกคือ \`Verify%_pct\` = 75.5\n`;

function currencyGuidance(siteInput) {
  const site = getSite(siteInput);
  if (!site) return '';

  const scale = fmt(site.scaleFactor);
  const common =
    `ให้อ้างอิงคอลัมน์ \`_THB\` เสมอเมื่อพูดถึงจำนวนเงิน ห้ามนำไปคูณซ้ำอีก\n` +
    `คอลัมน์ดิบที่ไม่มี \`_THB\` คือค่าตามที่ปรากฏในไฟล์ต้นฉบับ ` +
    `ใช้เมื่อต้อง cross-check กับ Power BI เท่านั้น ห้ามรายงานเป็นจำนวนเงิน\n`;

  // A THB site must not be told about an exchange rate it does not have —
  // "× 1" would read as a conversion that happened. The ×1,000 de-scaling
  // still applies, so `_THB` is still the column to quote.
  if (!site.needsFxConversion) {
    return (
      `สกุลเงินต้นทาง: ${site.currency} — เป็นเงินบาทอยู่แล้ว ไม่มีการแปลงสกุลเงิน\n` +
      `จำนวนเงินในไฟล์ถูกตัด 3 ศูนย์ไว้ คอลัมน์ที่ลงท้าย \`_THB\` คือค่าที่คูณ ${scale} กลับคืนแล้ว\n` +
      common
    );
  }

  return (
    `สกุลเงินต้นทาง: ${site.currency} (จำนวนเงินในไฟล์ถูกตัด 3 ศูนย์ไว้)\n` +
    `คอลัมน์ที่ลงท้าย \`_THB\` คือค่าที่แปลงเป็นเงินบาทเรียบร้อยแล้ว ` +
    `(× ${scale} × ${site.fxRate} — rate ณ ${site.fxRateAsOf})\n` +
    common
  );
}

/**
 * `BIn_THB` immediately before `BIn`, so the baht figure is the one read
 * first, and each line says which unit it is in.
 *
 * `normaliseRow` appends the converted columns after every original one, so
 * left alone the summary listed all the raw MMK figures first and the baht
 * ones far below — exactly the wrong way round for a model skimming for a
 * number to quote.
 *
 * `_pct` gets identical treatment: `Verify%_pct` (75.5) ahead of the raw
 * `Verify%` (0.755), both labelled. Without it the summary offers two columns
 * whose names differ by a suffix and whose values differ by 100x, and nothing
 * on the line says which one is the percentage.
 *
 * Display order only. The ranking that picks the sample sorts its own copy by
 * sum, and is deliberately left alone.
 */
const CONVERTED_SUFFIXES = [
  { suffix: '_THB', unit: 'บาท', rawUnit: 'ค่าดิบตามไฟล์ ยังไม่แปลงเป็นบาท' },
  { suffix: '_pct', unit: 'เปอร์เซ็นต์ (%)', rawUnit: 'ค่าดิบตามไฟล์ เป็นทศนิยม ยังไม่ใช่ %' },
];

function orderStatsForReading(stats) {
  const byColumn = new Map(stats.map((stat) => [stat.column, stat]));
  const out = [];
  const placed = new Set();

  const place = (stat, unit) => {
    if (placed.has(stat.column)) return;
    placed.add(stat.column);
    out.push({ ...stat, unit });
  };

  for (const stat of stats) {
    if (placed.has(stat.column)) continue;

    const own = CONVERTED_SUFFIXES.find(({ suffix }) => stat.column.endsWith(suffix));
    if (own) {
      place(stat, own.unit);
      continue;
    }

    const pair = CONVERTED_SUFFIXES.map((entry) => ({
      entry,
      converted: byColumn.get(`${stat.column}${entry.suffix}`),
    })).find(({ converted }) => converted);

    if (pair) {
      place(pair.converted, pair.entry.unit);
      place(stat, pair.entry.rawUnit);
    } else {
      place(stat, null);
    }
  }
  return out;
}

/**
 * Ratios the summary states outright instead of leaving to the model.
 *
 * Everything else in the block — sum, avg, min, max — is computed here and
 * quoted back correctly. A ratio was the one figure the model had to work out
 * for itself, and on `vip.xlsx` it answered 24.3% three times running: the
 * `daily_value` R/BIn for the whole site, from an earlier turn in the same
 * conversation, rather than 22.31% from the VIP rows in front of it. Nothing
 * in the context was wrong; the number simply was not there, and the nearest
 * plausible one was.
 *
 * Computed from the two sums, not as the mean of the per-row ratios. Those are
 * different numbers whenever the rows differ in size — the mean lets a member
 * who deposited 20 baht count as much as one who deposited 200,000 — and the
 * sum-based figure is the one the reference files' benchmarks mean.
 *
 * Raw columns rather than `_THB`: the site factor appears in both halves and
 * cancels, so the result is identical and needs no site to compute.
 */
const SUMMARY_RATIOS = [
  {
    label: 'R / BIn',
    numerator: 'R',
    denominator: 'BIn',
    note: 'กำไรต่อยอดเติมเงินของทั้งไฟล์นี้',
  },
];

/**
 * The threshold counts, as summary lines. Same contract as the stats above:
 * computed here over every row, quoted rather than derived by the model.
 */
function thresholdSummaryLines(records, fileType) {
  const groups = thresholdGroupsFor(fileType);
  if (groups.length === 0) return [];

  const lines = [];
  for (const group of groups) {
    const result = countByThresholds(records, group);
    if (result.counted === 0) continue;

    lines.push(`- นับตามเกณฑ์จากคอลัมน์ \`${result.column}\` (จาก ${result.counted} แถวที่มีค่า):`);
    for (const bucket of result.buckets) {
      lines.push(`  • ${bucket.label}: ${bucket.count} แถว (${fmt(bucket.pct)}%)`);
    }
    if (result.missing > 0) {
      lines.push(
        `  • อีก ${result.missing} แถวไม่มีค่าในคอลัมน์นี้ ` +
          `จึงไม่ถูกนับรวมทั้งในจำนวนและใน % ข้างบน`,
      );
    }
  }
  return lines;
}

function ratioSummaryLines(stats) {
  const byColumn = new Map(stats.map((stat) => [stat.column, stat]));

  return SUMMARY_RATIOS.flatMap(({ label, numerator, denominator, note }) => {
    const top = byColumn.get(numerator);
    const bottom = byColumn.get(denominator);
    if (!top || !bottom || !bottom.sum) return [];

    const pct = (top.sum / bottom.sum) * 100;
    return [
      `- ${label} = ${fmt(pct)}%  ` +
        `(คำนวณจากผลรวมทั้งไฟล์: ${numerator} ${fmt(top.sum)} ÷ ${denominator} ${fmt(bottom.sum)}) ` +
        `— ${note} **ใช้ค่านี้ ห้ามคำนวณเองและห้ามใช้ค่าจากไฟล์อื่น**`,
    ];
  });
}

/**
 * Picks the rows worth showing alongside the summary, and says how they were
 * picked — the caller has to tell Claude the selection rule, or a "top 15 by
 * deposits" list reads as "the whole file".
 */
function selectSample(entries, stats) {
  if (entries.some((entry) => entry.rowDate)) {
    const sorted = [...entries].sort((a, b) =>
      String(b.rowDate ?? '').localeCompare(String(a.rowDate ?? '')),
    );
    return {
      rows: sorted.slice(0, SAMPLE_ROW_LIMIT),
      criterion: `เรียงตามวันที่ล่าสุด เอา ${SAMPLE_ROW_LIMIT} แถวล่าสุด`,
      trustworthy: true,
    };
  }

  const ranking = [...stats].sort((a, b) => b.sum - a.sum)[0];
  if (ranking) {
    const sorted = [...entries].sort(
      (a, b) => (toNumber(b.record[ranking.column]) ?? -Infinity)
        - (toNumber(a.record[ranking.column]) ?? -Infinity),
    );
    return {
      rows: sorted.slice(0, SAMPLE_ROW_LIMIT),
      criterion: `เรียงตาม \`${ranking.column}\` จากมากไปน้อย เอา ${SAMPLE_ROW_LIMIT} อันดับแรก`,
      trustworthy: true,
    };
  }

  // Nothing numeric survived the identifier filter, so there is no meaningful
  // order to impose. Say so rather than implying these are the important rows.
  return {
    rows: entries.slice(0, SAMPLE_ROW_LIMIT),
    criterion: `${SAMPLE_ROW_LIMIT} แถวแรกตามลำดับเดิม **ไม่ได้เรียงตามความสำคัญ**`,
    trustworthy: false,
  };
}

/**
 * Turns the rows for a question into the text block Claude sees.
 *
 * Small files are sent whole. Large ones are not: `vip.xlsx` is 602 rows and
 * dumping it cost ~183k input tokens for a single question, enough that the
 * model spent its whole thinking budget on the dump and returned an empty
 * answer. Those files become exact statistics over every row plus a labelled
 * sample of real rows.
 *
 * The labelling is the load-bearing part. Without it the sample reads as the
 * complete data and the model answers "who is ranked 20th?" confidently from
 * fifteen rows it was handed.
 *
 * Exported for tests.
 */
export function formatContext({ site, fileType, availableMonths, rows }) {
  const type = getFileType(fileType);
  const header =
    `ประเภทไฟล์: ${type?.label ?? fileType} (${fileType})\n` +
    `เว็บ: ${siteDisplayName(site)}\n` +
    `เดือนที่มีข้อมูล: ${availableMonths.join(', ')}\n` +
    // On both paths, small file and large: the ambiguity it resolves is in the
    // rows themselves, which are present either way. That applies to the
    // percentage columns too — and more so, because a 31-row file like
    // new_member_quality goes down the small-file path, where every row is
    // sent verbatim and the summary block that could have carried a unit
    // label is never built.
    currencyGuidance(site) +
    PERCENT_GUIDANCE;

  const entries = rows.map((r) => ({
    record: { ...normaliseRow(r.row, site), ...deriveMetrics(r.row, site) },
    rowDate: r.row_date,
    meta: r.row_date ? `${r.year_month} ${r.row_date}` : r.year_month,
  }));

  if (rows.length <= DETAIL_ROW_LIMIT) {
    const lines = entries.map((entry) => renderRow(entry.record, entry.meta));
    return `${header}จำนวนแถว: ${rows.length}\n\n${lines.join('\n')}`;
  }

  const stats = numericColumnStats(entries.map((entry) => entry.record));
  const sample = selectSample(entries, stats);

  // The unit note goes at the end of the line, leaving the `- <column>:` head
  // exactly as it was — that prefix is what a reader (and the tests) key off.
  const summaryLines = orderStatsForReading(stats).map(
    (s) =>
      `- ${s.column}: รวม ${fmt(s.sum)} | เฉลี่ย ${fmt(s.avg)} | ต่ำสุด ${fmt(s.min)} | ` +
      `สูงสุด ${fmt(s.max)} | มีค่า ${s.count} แถว` +
      (s.unit ? ` — หน่วย: ${s.unit}` : ''),
  );

  const records = entries.map((entry) => entry.record);
  const ratioLines = ratioSummaryLines(stats);
  const thresholdLines = thresholdSummaryLines(records, fileType);

  const summaryBlock =
    `===== สรุปสถิติ — คำนวณจากข้อมูลจริงครบทั้ง ${rows.length} แถว =====\n` +
    `ตัวเลขในบล็อกนี้ถูกต้อง 100% ใช้ตอบคำถามภาพรวมได้เต็มที่ ` +
    `(ค่าเฉลี่ยคิดจากเฉพาะแถวที่มีค่าตัวเลข ตามจำนวนที่กำกับไว้ท้ายแต่ละบรรทัด)\n` +
    `⚠️ ตัวเลขทุกตัวในบล็อกนี้เป็นของ**ไฟล์ชุดนี้เท่านั้น** (${type?.label ?? fileType} — ` +
    `${siteDisplayName(site)} — ${availableMonths.join(', ')}) ` +
    `ห้ามนำค่าจากไฟล์ประเภทอื่น หรือจากคำตอบก่อนหน้าในบทสนทนา มาใช้แทนค่าในบล็อกนี้ ` +
    `ถ้าตัวเลขที่ต้องใช้ไม่มีอยู่ในบล็อกนี้ ให้บอกว่าไม่มี — ห้ามหยิบตัวเลขที่ใกล้เคียงจากที่อื่นมาตอบ\n` +
    (summaryLines.length > 0
      ? summaryLines.join('\n')
      : '(ไม่พบคอลัมน์ตัวเลขที่เป็น metric ในไฟล์นี้)') +
    (ratioLines.length > 0 ? `\n\n${ratioLines.join('\n')}` : '') +
    (thresholdLines.length > 0 ? `\n\n${thresholdLines.join('\n')}` : '');

  const sampleBlock =
    `===== ตัวอย่างข้อมูลรายแถว ${sample.rows.length} แถว จากทั้งหมด ${rows.length} แถว =====\n` +
    `นี่คือ**ตัวอย่าง ไม่ใช่ข้อมูลครบ** — เกณฑ์การเลือก: ${sample.criterion}\n` +
    sample.rows.map((entry) => renderRow(entry.record, entry.meta)).join('\n');

  const hidden = rows.length - sample.rows.length;
  const guardBlock =
    `===== ข้อจำกัดของข้อมูลชุดนี้ (สำคัญ) =====\n` +
    `ข้อมูลรายแถวที่ส่งมาให้มีแค่ ${sample.rows.length} แถวข้างบนเท่านั้น ` +
    `อีก ${hidden} แถวไม่ได้ถูกส่งมาด้วย\n` +
    `ห้ามตอบคำถามที่ต้องดูแถวรายตัวนอกเหนือจากตัวอย่างข้างบน ` +
    `(เช่น "อันดับที่ 20 คือใคร", "username นี้มียอดเท่าไหร่", "ใครบ้างที่เข้าเงื่อนไข X") ` +
    `เพราะข้อมูลส่วนนั้นไม่ได้ถูกส่งมา\n` +
    `ถ้าถูกถามแบบนั้น ให้บอกตรง ๆ ว่าข้อมูลรายแถวส่วนนั้นไม่ได้ถูกส่งมา ` +
    `แล้วแนะนำให้ถามให้เจาะจงขึ้น — ห้ามเดา ห้ามประมาณจากตัวอย่าง ` +
    `และห้ามสรุปว่าตัวอย่างคือข้อมูลทั้งหมด`;

  return `${header}จำนวนแถวทั้งหมด: ${rows.length}\n\n${summaryBlock}\n\n${sampleBlock}\n\n${guardBlock}`;
}

/**
 * A generous runaway guard, not a budget.
 *
 * Measured with `scripts/measure-context.mjs`: every one of the twelve file
 * types, each at a full month's rows, comes to ~102k characters (~32k tokens),
 * on top of a ~27k-token cached system prompt. That fits a 200k window several
 * times over, so nothing is dropped in practice and this ceiling exists only so
 * an unforeseen export — a file type with far more rows than any seen — cannot
 * silently produce a context that costs a fortune or fails the call.
 *
 * When it does bite, the least relevant files are the ones left out and the
 * inventory says so by name. Lowering it to impose a real budget is a one-line
 * change; the "present but not sent" path below is built and tested either way.
 */
const CONTEXT_CHAR_BUDGET = 400_000;

/**
 * File types in the order they are written into the context: manifest order,
 * always, independent of the question.
 *
 * This used to sort the question's keyword match to the front. That was a real
 * improvement to how the context reads — and it made the whole block
 * uncacheable, because the bytes then depended on the question. Two questions
 * against the same site and month produced two different prefixes and every
 * request paid full price for ~36k tokens of identical data.
 *
 * The relevance signal is not lost, only moved: `relevanceHint` below produces
 * a one-line pointer that the caller places *after* the cache breakpoint,
 * alongside the question. Same guidance to the model, none of the cache cost —
 * a stable prefix is worth far more than the ordering was.
 */
function manifestOrder(fileTypes) {
  return [...fileTypes].sort(
    (a, b) => FILE_TYPE_IDS.indexOf(a) - FILE_TYPE_IDS.indexOf(b),
  );
}

/**
 * The one-line "look here first" pointer, for the volatile part of the prompt.
 *
 * Pure function of the question — no database, no site — so the caller can
 * place it after the breakpoint without a second query. It names a file type
 * that may or may not be present; the inventory inside the cached block is the
 * authority on what actually exists, and the wording defers to it.
 */
export function relevanceHint(question) {
  const fileType = pickFileType(question);
  const label = getFileType(fileType)?.label ?? fileType;
  return (
    `คำถามนี้น่าจะเกี่ยวกับไฟล์ **${label}** (${fileType}) มากที่สุด — ` +
    `ถ้ามีบล็อกของไฟล์นี้อยู่ในข้อมูลด้านบน ให้ดูบล็อกนั้นก่อน ` +
    `แต่ถ้าคำถามต้องใช้หลายไฟล์ ให้ดูบล็อกอื่นด้วย และถ้าไฟล์นี้ไม่มีในรายการ ` +
    `ให้ยึดตามรายการไฟล์ที่มีอยู่จริงเป็นหลัก`
  );
}

/**
 * The list of everything the bot holds for this site, and what happened to
 * each entry in this call.
 *
 * Required in every context, including the one where nothing could be sent.
 * The reported failure was the bot answering "ไฟล์นี้ยังไม่ถูกอัปโหลด" about a
 * file sitting in the database — because the context it was handed contained
 * no trace of that file, and from where the model sat, absent and non-existent
 * are the same thing. With this block they are not: it can say the data was
 * not included in this round, which is true and actionable, instead of that
 * the file was never uploaded, which is false and sends someone re-uploading.
 */
function inventoryBlock(site, entries) {
  const lines = entries.map((entry) => {
    const months = entry.availableMonths.join(', ');
    if (entry.included) return `  ✅ ${entry.label} (${entry.fileType}) — เดือน ${months} — ส่งข้อมูลมาด้วยแล้ว`;
    return (
      `  ⬜ ${entry.label} (${entry.fileType}) — เดือน ${months} — ` +
      `**มีไฟล์นี้อยู่ในระบบ แต่ข้อมูลไม่ได้ถูกส่งมาในรอบนี้** (${entry.reason})`
    );
  });

  return (
    `===== ไฟล์ทั้งหมดที่มีอยู่ในระบบของ ${siteDisplayName(site)} =====\n` +
    (lines.length > 0 ? lines.join('\n') : '  (ยังไม่มีไฟล์ใดถูกอัปโหลดสำหรับเว็บนี้)') +
    `\n\nรายการข้างบนคือความจริงเรื่อง "มีไฟล์อะไรบ้าง" — ใช้รายการนี้ตอบเสมอ\n` +
    `ถ้าถูกถามถึงไฟล์ที่ขึ้น ⬜ ให้ตอบว่า **มีไฟล์นั้นอยู่ในระบบแล้ว แต่ข้อมูลไม่ได้ถูกส่งมาในรอบนี้** ` +
    `แล้วให้ผู้ใช้ถามเจาะจงไฟล์นั้นอีกครั้ง — ` +
    `**ห้ามตอบว่ายังไม่ได้อัปโหลด** เพราะไฟล์นั้นถูกอัปโหลดมาแล้ว\n` +
    `ถ้าไฟล์ที่ต้องใช้ไม่มีอยู่ในรายการนี้เลย นั่นคือยังไม่ได้อัปโหลดจริง ให้บอกให้อัปโหลดเพิ่ม`
  );
}

/**
 * Every file the bot holds for this site, formatted for one question.
 *
 * Was: pick one file type from the question's keywords and send only that.
 * That could not answer anything spanning two reports — "ตรวจสอบการแจก bonus
 * และ commission โปรแนะนำเพื่อน" needs referrer, member_detail and bonus_log at
 * once — and when the keywords missed, the single file it did send was the
 * wrong one. Sending everything makes both failures impossible.
 *
 * What made it affordable is PR #8: a file that used to cost ~92k tokens as a
 * raw dump now costs ~3k as a summary block, so all twelve together cost less
 * than one file did before.
 *
 * Returns `null` only when the site has no files at all — the caller turns that
 * into "ยังไม่มีข้อมูล ขอให้ upload". Any file present means a context, even if
 * its rows could not be read.
 */
export async function buildDataContext(site, question, { monthsBack = 3, onProgress } = {}) {
  const candidateMonths = lastNYearMonths(monthsBack);

  // What exists, per type, within the comparison window.
  const present = FILE_TYPE_IDS.map((fileType) => ({
    fileType,
    label: getFileType(fileType)?.label ?? fileType,
    availableMonths: candidateMonths.filter((ym) => findRawFile({ site, yearMonth: ym, fileType })),
  })).filter((entry) => entry.availableMonths.length > 0);

  if (present.length === 0) return null;

  // Manifest order, not question order: the bytes of this block must not
  // depend on the question, or the prompt cache misses on every turn.
  const ordered = manifestOrder(present.map((entry) => entry.fileType));
  const byType = new Map(present.map((entry) => [entry.fileType, entry]));

  const entries = [];
  const blocks = [];
  let usedChars = 0;

  for (const fileType of ordered) {
    const entry = byType.get(fileType);
    const label = entry.label;

    for (const yearMonth of entry.availableMonths) {
      try {
        // The first question after a big upload is the one that pays for
        // parsing it, so progress has to reach the asker here too.
        await ensureParsed({
          site,
          yearMonth,
          fileType,
          onProgress: onProgress ? (update) => onProgress({ ...update, label }) : undefined,
        });
      } catch (err) {
        logger.error('failed to parse raw file on demand', {
          site,
          yearMonth,
          fileType,
          message: err?.message,
        });
      }
    }

    const rows = queryParsedRows({ site, fileType, yearMonths: entry.availableMonths });
    if (rows.length === 0) {
      // The file is there but produced nothing readable. Still listed, because
      // "uploaded but unreadable" is a different thing to tell the user than
      // "never uploaded", and only the inventory can carry that distinction.
      entries.push({ ...entry, included: false, reason: 'อ่านข้อมูลจากไฟล์ไม่ได้' });
      continue;
    }

    const block = formatContext({ site, fileType, availableMonths: entry.availableMonths, rows });

    if (usedChars + block.length > CONTEXT_CHAR_BUDGET && blocks.length > 0) {
      entries.push({ ...entry, included: false, reason: 'context เต็มงบในรอบนี้' });
      continue;
    }

    usedChars += block.length;
    blocks.push(block);
    entries.push({ ...entry, included: true });
  }

  // Inventory first: it is the shortest block and the one that must survive
  // being skimmed, and it frames everything after it.
  const inventory = inventoryBlock(site, entries);

  logger.info('built data context', {
    site,
    types: entries.length,
    included: entries.filter((e) => e.included).length,
    chars: usedChars,
  });

  if (blocks.length === 0) return inventory;

  const separated = blocks
    .map((block, i) => `########## ไฟล์ที่ ${i + 1} จาก ${blocks.length} ##########\n${block}`)
    .join('\n\n');

  return (
    `${inventory}\n\n` +
    `หมายเหตุ: ด้านล่างนี้มีข้อมูลหลายไฟล์ต่อกัน แต่ละไฟล์คั่นด้วยบรรทัด ####### ` +
    `แต่ละบล็อกมีหัวบอกชัดว่าเป็นไฟล์ประเภทไหน ` +
    `**ห้ามเอาตัวเลขข้ามไฟล์มาปนกัน** — ถ้าจะอ้างตัวเลขใด ให้ดูว่ามาจากบล็อกไหน\n\n` +
    separated
  );
}

/** Per-file-type inventory for a site — used by `/status`. */
export function fileInventory(site) {
  const bySite = new Map(listRawFiles({ site }).map((row) => [row.file_type, row]));
  return FILE_TYPES.map((type) => ({
    fileType: type.id,
    label: type.label,
    file: bySite.get(type.id) ?? null,
  }));
}
