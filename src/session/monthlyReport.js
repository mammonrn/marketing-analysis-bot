/**
 * Whole-month dashboard payload.
 *
 * Deliberately not part of `summary.js`, because the two read from different
 * places and mean different things. `summary.js` summarises a *conversation*:
 * it reads `turns` — what this chat asked and what Claude answered — and its
 * numbers only exist because someone asked for them. This module summarises a
 * *month*: it reads every `raw_files` entry for one site and one `year_month`,
 * whether or not anyone ever asked about it, and computes every figure here in
 * JavaScript rather than through the model. Folding them together would put an
 * `if (kind === ...)` at the top of every function in both.
 *
 * Money and percentages come from the `_THB` / `_pct` columns that
 * `normaliseRow` and `deriveMetrics` already produce (SKILL.md, "หน่วยเงินและ
 * การแสดงผล"): no exchange rate and no ×100 is applied here. Ratios that the
 * pipeline has no converted column for are computed from head counts only —
 * the one case SKILL.md permits — never from a raw money column.
 *
 * The output is a flat, render-agnostic shape:
 *
 *   sections: [{ id, title, fileType, available, kpis[], charts[], tables[] }]
 *
 * so `public/miniapp/assets/monthly.js` is a generic renderer with no
 * knowledge of casino metrics, and a new section costs one builder here and
 * nothing on the front end.
 */

import { logger } from '../logger.js';
import { getSite, siteDisplayName } from '../data/sites.js';
import { getFileType } from '../data/fileTypes.js';
import { normaliseRow, deriveMetrics, toNumber } from '../data/transform.js';
import { ensureParsed } from '../data/parse.js';
import { listRawFiles, queryParsedRows } from '../data/db.js';

/** Unit tags the renderer formats by. Money is always already-converted baht. */
const THB = 'thb';
const PCT = 'pct';
const COUNT = 'count';
const NUMBER = 'number';
const MINUTES = 'min';
const TEXT = 'text';

/** How many rows a "top N" table shows. Enough to act on, short enough to scroll. */
const TOP_N = 10;

const num = (value) => {
  const n = toNumber(value);
  return Number.isFinite(n) ? n : null;
};

function sum(records, column) {
  let total = 0;
  let seen = 0;
  for (const record of records) {
    const value = num(record[column]);
    if (value === null) continue;
    total += value;
    seen += 1;
  }
  return seen === 0 ? null : total;
}

function mean(records, column) {
  const values = records.map((record) => num(record[column])).filter((n) => n !== null);
  if (values.length === 0) return null;
  return values.reduce((total, n) => total + n, 0) / values.length;
}

/** `null` rather than `-Infinity` when nothing in the column parsed as a number. */
function max(records, column) {
  const values = records.map((record) => num(record[column])).filter((n) => n !== null);
  return values.length === 0 ? null : Math.max(...values);
}

/**
 * A ratio of two sums, as a percentage.
 *
 * Sums, never the mean of the per-row ratios: those differ whenever the rows
 * differ in size, and it is the sum-based figure the reference files'
 * benchmarks mean (the same reasoning as `SUMMARY_RATIOS` in query.js).
 */
function ratioPct(records, numerator, denominator) {
  const top = sum(records, numerator);
  const bottom = sum(records, denominator);
  if (top === null || !bottom) return null;
  return (top / bottom) * 100;
}

const kpi = (label, value, unit, hint) => ({ label, value, unit, ...(hint ? { hint } : {}) });

function byDate(entries) {
  return [...entries].sort((a, b) => String(a.date ?? '').localeCompare(String(b.date ?? '')));
}

/** `2026-07-14` → `14` — the x axis is one month, so the day alone is enough. */
function dayLabel(date) {
  const match = /^\d{4}-\d{2}-(\d{2})$/.exec(String(date ?? ''));
  return match ? String(Number(match[1])) : String(date ?? '');
}

function dailySeries(entries, columns) {
  const sorted = byDate(entries.filter((entry) => entry.date));
  return {
    labels: sorted.map((entry) => dayLabel(entry.date)),
    datasets: columns.map(({ column, label, unit }) => ({
      label,
      unit,
      data: sorted.map((entry) => num(entry.record[column])),
    })),
  };
}

/** Descending by `column`, missing values last, capped at `limit`. */
function topBy(records, column, limit = TOP_N) {
  return [...records]
    .filter((record) => num(record[column]) !== null)
    .sort((a, b) => num(b[column]) - num(a[column]))
    .slice(0, limit);
}

// --- loading -----------------------------------------------------------------

/**
 * One file type's rows for the month, already converted.
 *
 * Parsing is lazy everywhere in this project, so a file uploaded minutes ago
 * has a `raw_files` row and no `parsed_rows` yet; `ensureParsed` is what turns
 * the first read into the parse. A file that cannot be read is reported as
 * unavailable rather than thrown — one broken export must not cost the other
 * ten sections.
 */
async function loadRows({ site, yearMonth, fileType, onProgress }) {
  const label = getFileType(fileType)?.label ?? fileType;
  try {
    await ensureParsed({
      site,
      yearMonth,
      fileType,
      onProgress: onProgress ? (update) => onProgress({ ...update, label }) : undefined,
    });
  } catch (err) {
    logger.warn('monthly report could not parse a file', {
      site,
      yearMonth,
      fileType,
      message: err?.message,
    });
    return null;
  }

  const rows = queryParsedRows({ site, fileType, yearMonths: [yearMonth] });
  if (rows.length === 0) return null;

  return rows.map((row) => ({
    date: row.row_date,
    record: { ...normaliseRow(row.row, site), ...deriveMetrics(row.row, site) },
  }));
}

// --- sections ----------------------------------------------------------------

/**
 * Each entry owns one tab. `fileType` is what has to be uploaded for the tab to
 * have anything in it; `build(entries)` receives the loaded rows and returns
 * `{ kpis, charts, tables }`. Several tabs share `daily_value` — they are
 * different readings of the same export, and splitting them is what keeps any
 * one tab short enough to take in at a glance.
 */
const SECTIONS = [
  {
    id: 'overview',
    title: 'Overview',
    fileType: 'daily_value',
    build(entries) {
      const records = entries.map((entry) => entry.record);
      const series = dailySeries(entries, [
        { column: 'BIn_THB', label: 'BIn (บาท)', unit: THB },
        { column: 'R_THB', label: 'Revenue (บาท)', unit: THB },
      ]);

      return {
        kpis: [
          kpi('BIn รวมทั้งเดือน', sum(records, 'BIn_THB'), THB),
          kpi('Revenue รวมทั้งเดือน', sum(records, 'R_THB'), THB),
          kpi('R / BIn', ratioPct(records, 'R_THB', 'BIn_THB'), PCT, 'กำไรต่อยอดเติมเงินทั้งเดือน'),
          kpi('RTP เฉลี่ยรายวัน', mean(records, 'RTP_pct'), PCT),
          kpi('DAU เฉลี่ยต่อวัน', mean(records, 'DAU'), COUNT),
          kpi('BIn Mems เฉลี่ยต่อวัน', mean(records, 'BIn Mems'), COUNT),
          kpi('New Mems รวมทั้งเดือน', sum(records, 'New Mems'), COUNT),
          kpi('จำนวนวันที่มีข้อมูล', entries.length, COUNT),
        ],
        charts: [
          {
            id: 'overview-daily',
            type: 'line',
            title: 'BIn และ Revenue รายวัน (บาท)',
            labels: series.labels,
            datasets: series.datasets,
          },
        ],
        tables: [],
      };
    },
  },
  {
    id: 'finance',
    title: 'Finance',
    fileType: 'daily_value',
    build(entries) {
      const records = entries.map((entry) => entry.record);
      const negativeDays = entries.filter((entry) => (num(entry.record.R_THB) ?? 0) < 0);
      const highRtpDays = entries.filter((entry) => (num(entry.record.RTP_pct) ?? 0) > 100);

      const revenueSeries = dailySeries(entries, [
        { column: 'R_THB', label: 'Revenue (บาท)', unit: THB },
      ]);
      const rtpSeries = dailySeries(entries, [{ column: 'RTP_pct', label: 'RTP (%)', unit: PCT }]);

      const dayRow = (entry) => ({
        date: entry.date,
        R_THB: num(entry.record.R_THB),
        BIn_THB: num(entry.record.BIn_THB),
        RTP_pct: num(entry.record.RTP_pct),
      });
      const ranked = byDate(entries).filter((entry) => num(entry.record.R_THB) !== null);
      const best = [...ranked].sort((a, b) => num(b.record.R_THB) - num(a.record.R_THB)).slice(0, 5);
      const worst = [...ranked].sort((a, b) => num(a.record.R_THB) - num(b.record.R_THB)).slice(0, 5);

      return {
        kpis: [
          kpi('CIn (Turnover) รวม', sum(records, 'CIn_THB'), THB),
          kpi('Net Win รวม', sum(records, 'Nw_THB'), THB),
          kpi('Bet Out รวม', sum(records, 'Bo_THB'), THB),
          kpi('Promotion Cost รวม', sum(records, 'Pro_THB'), THB),
          kpi('Bonus รวม', sum(records, 'Bonus_THB'), THB),
          kpi('Revenue รวม', sum(records, 'R_THB'), THB),
          kpi('วันที่ Revenue ติดลบ', negativeDays.length, COUNT),
          kpi('วันที่ RTP > 100%', highRtpDays.length, COUNT, 'วันที่จ่ายคืนผู้เล่นมากกว่าที่รับเข้า'),
        ],
        charts: [
          {
            id: 'finance-revenue',
            type: 'bar',
            title: 'Revenue รายวัน (บาท)',
            labels: revenueSeries.labels,
            datasets: revenueSeries.datasets,
          },
          {
            id: 'finance-rtp',
            type: 'line',
            title: 'RTP รายวัน (%)',
            labels: rtpSeries.labels,
            datasets: rtpSeries.datasets,
          },
        ],
        tables: [
          {
            title: '5 วันที่ Revenue สูงสุด',
            columns: [
              { key: 'date', label: 'วันที่', unit: TEXT },
              { key: 'R_THB', label: 'Revenue', unit: THB },
              { key: 'BIn_THB', label: 'BIn', unit: THB },
              { key: 'RTP_pct', label: 'RTP', unit: PCT },
            ],
            rows: best.map(dayRow),
          },
          {
            title: '5 วันที่ Revenue ต่ำสุด',
            columns: [
              { key: 'date', label: 'วันที่', unit: TEXT },
              { key: 'R_THB', label: 'Revenue', unit: THB },
              { key: 'BIn_THB', label: 'BIn', unit: THB },
              { key: 'RTP_pct', label: 'RTP', unit: PCT },
            ],
            rows: worst.map(dayRow),
          },
        ],
      };
    },
  },
  {
    id: 'activity',
    title: 'Activity',
    fileType: 'daily_value',
    build(entries) {
      const records = entries.map((entry) => entry.record);
      const series = dailySeries(entries, [
        { column: 'DAU', label: 'DAU', unit: COUNT },
        { column: 'BIn Mems', label: 'BIn Mems', unit: COUNT },
        { column: 'BIn Mems (np)', label: 'BIn Mems (np)', unit: COUNT },
      ]);

      return {
        kpis: [
          kpi('DAU เฉลี่ย', mean(records, 'DAU'), COUNT),
          kpi('DAU สูงสุด', max(records, 'DAU'), COUNT),
          kpi('BIn Mems เฉลี่ย', mean(records, 'BIn Mems'), COUNT, 'ลูกค้าที่เติมเงินต่อวัน'),
          kpi(
            'BIn Mems (np) เฉลี่ย',
            mean(records, 'BIn Mems (np)'),
            COUNT,
            'ลูกค้าที่เติมเงินโดยไม่รับโปร',
          ),
          kpi(
            'สัดส่วน organic',
            ratioPct(records, 'BIn Mems (np)', 'BIn Mems'),
            PCT,
            'BIn Mems (np) ต่อ BIn Mems ทั้งเดือน — ยิ่งสูงยิ่งพึ่งโปรน้อย',
          ),
          kpi('New Mems รวม', sum(records, 'New Mems'), COUNT),
          kpi('Pro Mems รวม', sum(records, 'Pro Mems'), COUNT),
          kpi('ARPPU เฉลี่ยรายวัน', mean(records, 'ARPPU_THB'), THB, 'BIn ต่อลูกค้าที่เติมเงิน 1 คน'),
        ],
        charts: [
          {
            id: 'activity-daily',
            type: 'line',
            title: 'DAU และลูกค้าที่เติมเงิน รายวัน',
            labels: series.labels,
            datasets: series.datasets,
          },
        ],
        tables: [],
      };
    },
  },
  {
    id: 'new_member',
    title: 'New Member',
    fileType: 'new_member_quality',
    build(entries) {
      const records = entries.map((entry) => entry.record);
      const series = dailySeries(entries, [
        { column: 'New', label: 'สมัครใหม่', unit: COUNT },
        { column: '1st New Mems', label: 'ฝากวันเดียวกับที่สมัคร', unit: COUNT },
        { column: '1st Day Mems', label: 'ฝากครั้งแรกวันนี้', unit: COUNT },
      ]);

      return {
        kpis: [
          kpi('สมัครใหม่รวม', sum(records, 'New'), COUNT),
          kpi('Verify% เฉลี่ย', mean(records, 'Verify%_pct'), PCT),
          kpi('1st New% เฉลี่ย', mean(records, '1st New%_pct'), PCT, 'สมัครแล้วฝากวันเดียวกัน'),
          kpi('1st New (np%) เฉลี่ย', mean(records, '1st New (np%)_pct'), PCT),
          kpi('1st Day (np%) เฉลี่ย', mean(records, '1st Day (np%)_pct'), PCT),
          kpi('ยอดฝากของ 1st New รวม', sum(records, '1st New (BIn)_THB'), THB),
          kpi('ยอดฝากของ 1st Day รวม', sum(records, '1st Day (BIn)_THB'), THB),
          kpi(
            'Delayed 1st Deposit รวม',
            sum(records, 'delayed_1st_deposit'),
            COUNT,
            '1st Day Mems − 1st New Mems: คนที่สมัครไว้ก่อนแล้วเพิ่งมาฝาก',
          ),
        ],
        charts: [
          {
            id: 'new-member-daily',
            type: 'line',
            title: 'สมาชิกใหม่และการฝากครั้งแรก รายวัน',
            labels: series.labels,
            datasets: series.datasets,
          },
        ],
        tables: [],
      };
    },
  },
  {
    id: 'deposit_count',
    title: 'Deposit Count',
    fileType: 'deposit_count_distribution',
    build(entries) {
      const records = entries.map((entry) => entry.record);
      const buckets = [
        { column: '1 Time', label: '1 ครั้ง (Casual)' },
        { column: '2~5 Counts', label: '2–5 ครั้ง' },
        { column: '6~10 Counts', label: '6–10 ครั้ง' },
        { column: '11~20 Counts', label: '11–20 ครั้ง' },
        { column: '21+ Counts', label: '21+ ครั้ง (Power user)' },
      ];

      const totals = buckets.map((bucket) => ({ ...bucket, total: sum(records, bucket.column) }));
      const memsTotal = sum(records, 'BIn Mems');
      // deposit-count-distribution.md: (11~20 + 21+) / BIn Mems. Head counts
      // throughout, so this is computed here rather than read off a `_pct`
      // column — there is none for it.
      const heavy = sum(records, '11~20 Counts');
      const power = sum(records, '21+ Counts');
      const powerUserPct =
        memsTotal && heavy !== null && power !== null ? ((heavy + power) / memsTotal) * 100 : null;

      const series = dailySeries(entries, [
        { column: '21+ Counts', label: '21+ ครั้ง', unit: COUNT },
        { column: '1 Time', label: '1 ครั้ง', unit: COUNT },
      ]);

      return {
        kpis: [
          kpi('BIn Mems รวมทั้งเดือน', memsTotal, COUNT),
          kpi('Power User Index', powerUserPct, PCT, '(11–20 + 21+) ต่อ BIn Mems — benchmark ~56%'),
          kpi('Casual Rate', ratioPct(records, '1 Time', 'BIn Mems'), PCT, 'benchmark < 25%'),
          kpi('21+ Counts%', ratioPct(records, '21+ Counts', 'BIn Mems'), PCT, 'benchmark > 47% = ดี'),
        ],
        charts: [
          {
            id: 'deposit-count-share',
            type: 'doughnut',
            title: 'สัดส่วนกลุ่มความถี่การฝาก (รวมทั้งเดือน)',
            labels: totals.map((bucket) => bucket.label),
            datasets: [{ label: 'จำนวน member', unit: COUNT, data: totals.map((b) => b.total) }],
          },
          {
            id: 'deposit-count-daily',
            type: 'line',
            title: 'Power user เทียบ casual รายวัน',
            labels: series.labels,
            datasets: series.datasets,
          },
        ],
        tables: [
          {
            title: 'สรุปรายกลุ่ม',
            columns: [
              { key: 'label', label: 'กลุ่ม', unit: TEXT },
              { key: 'total', label: 'จำนวน (คน-วัน)', unit: COUNT },
              { key: 'share', label: '% ของ BIn Mems', unit: PCT },
            ],
            // Head counts over head counts — the one ratio SKILL.md allows this
            // module to compute itself, because there is no `_pct` twin for it.
            rows: totals.map((bucket) => ({
              label: bucket.label,
              total: bucket.total,
              share: bucket.total !== null && memsTotal ? (bucket.total / memsTotal) * 100 : null,
            })),
            note: 'นับแบบ "คน-วัน" — member หนึ่งคนที่ฝากหลายวันถูกนับทุกวัน',
          },
        ],
      };
    },
  },
  {
    id: 'brand_game',
    title: 'Brand / Game',
    fileType: 'brand_game_value',
    build(entries) {
      const records = entries.map((entry) => entry.record);
      const totalCIn = sum(records, 'CIn_THB');
      const ranked = topBy(records, 'CIn_THB', 20);

      return {
        kpis: [
          kpi('CIn รวมทุกประเภทเกม', totalCIn, THB),
          kpi('Net Win รวม', sum(records, 'Nw_THB'), THB),
          kpi('ประเภทเกมที่มีข้อมูล', records.length, COUNT),
          kpi(
            'เกมที่ RTP > 100%',
            records.filter((record) => (num(record.RTP_pct) ?? 0) > 100).length,
            COUNT,
            'ประเภทเกมที่ casino ขาดทุน',
          ),
        ],
        charts: [
          {
            id: 'brand-cin',
            type: 'bar',
            title: 'CIn ตามประเภทเกม (บาท)',
            labels: ranked.map((record) => String(record.GameKind ?? '—')),
            datasets: [
              { label: 'CIn (บาท)', unit: THB, data: ranked.map((record) => num(record.CIn_THB)) },
            ],
          },
        ],
        tables: [
          {
            title: 'รายละเอียดตามประเภทเกม',
            columns: [
              { key: 'GameKind', label: 'ประเภทเกม', unit: TEXT },
              { key: 'CIn_THB', label: 'CIn', unit: THB },
              { key: 'share', label: 'Share', unit: PCT },
              { key: 'Nw_THB', label: 'Net Win', unit: THB },
              { key: 'RTP_pct', label: 'RTP', unit: PCT },
              { key: 'DAU', label: 'DAU', unit: COUNT },
              { key: 'Counts', label: 'รอบเดิมพัน', unit: COUNT },
            ],
            rows: ranked.map((record) => ({
              GameKind: record.GameKind ?? '—',
              CIn_THB: num(record.CIn_THB),
              // Money over money: the site factor cancels, so this is a pure
              // share and needs no conversion of its own.
              share: totalCIn ? ((num(record.CIn_THB) ?? 0) / totalCIn) * 100 : null,
              Nw_THB: num(record.Nw_THB),
              RTP_pct: num(record.RTP_pct),
              DAU: num(record.DAU),
              Counts: num(record.Counts),
            })),
            note: 'ไฟล์นี้เป็นข้อมูลสะสม 6 เดือนล่าสุด ไม่ใช่เฉพาะเดือนที่เลือก',
          },
        ],
      };
    },
  },
  {
    id: 'vip',
    title: 'VIP',
    fileType: 'vip',
    build(entries) {
      const records = entries.map((entry) => entry.record);
      // vip-members.md: Last BIn 2 Y counts days back from yesterday, and > 7
      // is the file's own definition of a lost VIP.
      const withRecency = records.filter((record) => num(record['Last BIn 2 Y']) !== null);
      const active = withRecency.filter((record) => num(record['Last BIn 2 Y']) <= 7);
      const lost = withRecency.filter((record) => num(record['Last BIn 2 Y']) > 7);
      const activePct = withRecency.length ? (active.length / withRecency.length) * 100 : null;

      const vipRow = (record) => ({
        Username: record.Username ?? '—',
        BIn_THB: num(record.BIn_THB),
        R_THB: num(record.R_THB),
        'BIn Counts': num(record['BIn Counts']),
        'Med. BIn_THB': num(record['Med. BIn_THB']),
        'Last BIn 2 Y': num(record['Last BIn 2 Y']),
      });
      const columns = [
        { key: 'Username', label: 'Username', unit: TEXT },
        { key: 'BIn_THB', label: 'ยอดฝากรวม', unit: THB },
        { key: 'R_THB', label: 'Revenue', unit: THB },
        { key: 'BIn Counts', label: 'ครั้งที่ฝาก', unit: COUNT },
        { key: 'Med. BIn_THB', label: 'ฝากครั้งละ (median)', unit: THB },
        { key: 'Last BIn 2 Y', label: 'ฝากล่าสุด (วันก่อน)', unit: COUNT },
      ];

      return {
        kpis: [
          kpi('VIP ทั้งหมด', records.length, COUNT),
          kpi('Active VIP', active.length, COUNT, 'ฝากภายใน 7 วันล่าสุด'),
          kpi('Lost VIP', lost.length, COUNT, 'ไม่ได้ฝากเกิน 7 วัน'),
          kpi('Active VIP%', activePct, PCT, 'benchmark 60.1% — ต่ำกว่า 55% ต้อง re-engage ด่วน'),
          kpi('ยอดฝากรวมของ VIP', sum(records, 'BIn_THB'), THB),
          kpi('Revenue รวมจาก VIP', sum(records, 'R_THB'), THB),
        ],
        charts: [
          {
            id: 'vip-status',
            type: 'doughnut',
            title: 'Active เทียบ Lost',
            labels: ['Active', 'Lost'],
            datasets: [{ label: 'จำนวน VIP', unit: COUNT, data: [active.length, lost.length] }],
          },
        ],
        tables: [
          {
            title: `VIP ที่สร้างยอดฝากสูงสุด ${TOP_N} อันดับ`,
            columns,
            rows: topBy(records, 'BIn_THB').map(vipRow),
          },
          {
            title: `Lost VIP ที่ยอดฝากสูงสุด ${TOP_N} อันดับ`,
            columns,
            rows: topBy(lost, 'BIn_THB').map(vipRow),
            note: 'รายชื่อสำหรับทีม CRM ติดต่อกลับ — เบอร์โทรอยู่ในไฟล์ต้นฉบับ ไม่ได้ส่งมาที่หน้านี้',
          },
        ],
      };
    },
  },
  {
    id: 'referrer',
    title: 'Referrer',
    fileType: 'referrer',
    build(entries) {
      const records = entries.map((entry) => entry.record);
      const ranked = topBy(records, 'BIn_THB');

      // referrer.md's red flag: paid more in referral bonus than the downline
      // ever returned. Money against money, so no conversion decision here —
      // both sides are the pipeline's `_THB` columns.
      const unprofitable = records.filter((record) => {
        const bonus = num(record['Ref Bonus_THB']);
        const revenue = num(record.R_THB);
        return bonus !== null && revenue !== null && bonus > revenue;
      });

      return {
        kpis: [
          kpi('Referrer ทั้งหมด', records.length, COUNT),
          kpi('Ref Bonus ที่จ่ายรวม', sum(records, 'Ref Bonus_THB'), THB),
          kpi('Revenue จาก downline รวม', sum(records, 'R_THB'), THB),
          kpi('ยอดฝากของ downline รวม', sum(records, 'BIn_THB'), THB),
          kpi('downline ที่ชวนมาได้รวม', sum(records, 'Total Mems'), COUNT),
          kpi(
            'Referrer ที่จ่ายแพงกว่าที่ได้',
            unprofitable.length,
            COUNT,
            'Ref Bonus สูงกว่า Revenue ที่ downline สร้าง',
          ),
        ],
        charts: [
          {
            id: 'referrer-top',
            type: 'bar',
            title: `ยอดฝากของ downline สูงสุด ${TOP_N} อันดับ (บาท)`,
            labels: ranked.map((record) => String(record.Referrer ?? '—')),
            datasets: [
              { label: 'BIn (บาท)', unit: THB, data: ranked.map((record) => num(record.BIn_THB)) },
            ],
          },
        ],
        tables: [
          {
            title: `Referrer สูงสุด ${TOP_N} อันดับ`,
            columns: [
              { key: 'Referrer', label: 'Referrer', unit: TEXT },
              { key: 'Total Mems', label: 'downline', unit: COUNT },
              { key: 'binMemsPct', label: 'ฝากจริง%', unit: PCT },
              { key: 'BIn_THB', label: 'ยอดฝากรวม', unit: THB },
              { key: 'Ref Bonus_THB', label: 'Ref Bonus', unit: THB },
              { key: 'R_THB', label: 'Revenue', unit: THB },
            ],
            rows: ranked.map((record) => {
              const total = num(record['Total Mems']);
              const depositing = num(record['Total BIn Mems']);
              return {
                Referrer: record.Referrer ?? '—',
                'Total Mems': total,
                // Head counts over head counts: the export's own `BIn Mems%`
                // has no `_pct` twin, and SKILL.md permits computing a ratio of
                // people. No money column is touched here.
                binMemsPct: total && depositing !== null ? (depositing / total) * 100 : null,
                BIn_THB: num(record.BIn_THB),
                'Ref Bonus_THB': num(record['Ref Bonus_THB']),
                R_THB: num(record.R_THB),
              };
            }),
            note: 'ฝากจริง% ต่ำมาก (< 20%) พร้อม downline จำนวนมาก เข้าข่าย referral abuse',
          },
        ],
      };
    },
  },
  {
    id: 'hours',
    title: 'Hours',
    fileType: 'avg_bin_by_hour',
    build(entries) {
      const records = entries.map((entry) => entry.record);

      // The grid is 7 weekdays × 24 hours. Averaging down to one line per hour
      // is what answers "ช่วงไหนเงินเข้าเยอะ"; the weekday detail stays in the
      // table below, where the peak slot can still be read off by name.
      const byHour = new Map();
      for (const record of records) {
        const hour = num(record.hour);
        const value = num(record.avg_bin_THB);
        if (hour === null || value === null) continue;
        if (!byHour.has(hour)) byHour.set(hour, []);
        byHour.get(hour).push(value);
      }
      const hours = [...byHour.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([hour, values]) => ({
          hour,
          avg: values.reduce((total, n) => total + n, 0) / values.length,
        }));

      const peak = topBy(records, 'avg_bin_THB');
      const busiest = hours.length ? [...hours].sort((a, b) => b.avg - a.avg)[0] : null;
      const quietest = hours.length ? [...hours].sort((a, b) => a.avg - b.avg)[0] : null;

      return {
        kpis: [
          kpi(
            'ชั่วโมงที่เงินเข้าสูงสุด',
            busiest ? busiest.hour : null,
            COUNT,
            busiest ? `เฉลี่ยทุกวันในสัปดาห์ ${Math.round(busiest.avg).toLocaleString('en-US')} บาท` : '',
          ),
          kpi('ชั่วโมงที่เงียบที่สุด', quietest ? quietest.hour : null, COUNT),
          kpi('ช่องเวลาที่มีข้อมูล', records.length, COUNT, 'ครบทั้งตารางคือ 7 × 24 = 168 ช่อง'),
        ],
        charts: [
          {
            id: 'hours-avg',
            type: 'bar',
            title: 'BIn เฉลี่ยตามชั่วโมง (เฉลี่ยทุกวันในสัปดาห์, บาท)',
            labels: hours.map((entry) => String(entry.hour)),
            datasets: [{ label: 'BIn เฉลี่ย (บาท)', unit: THB, data: hours.map((e) => e.avg) }],
          },
        ],
        tables: [
          {
            title: `ช่วงเวลาที่เงินเข้าสูงสุด ${TOP_N} อันดับ`,
            columns: [
              { key: 'weekday', label: 'วัน', unit: TEXT },
              { key: 'hour', label: 'ชั่วโมง', unit: COUNT },
              { key: 'avg_bin_THB', label: 'BIn เฉลี่ย', unit: THB },
            ],
            rows: peak.map((record) => ({
              weekday: record.weekday ?? '—',
              hour: num(record.hour),
              avg_bin_THB: num(record.avg_bin_THB),
            })),
            note: 'ธุรกิจยิงโฆษณา 24 ชม. อยู่แล้ว — ใช้ช่วงพีคเพื่อเพิ่มงบโปร/โบนัส ไม่ใช่เพื่อย้ายเวลายิงแอด',
          },
        ],
      };
    },
  },
  {
    id: 'deposit_detail',
    title: 'Deposit Detail',
    fileType: 'deposit_detail',
    build(entries) {
      const records = entries.map((entry) => entry.record);

      // Stored rows are one per (day × PayName); the channel view rolls the
      // days back up so a gateway problem shows as one line, not thirty.
      const channels = new Map();
      for (const record of records) {
        const name = String(record.PayName ?? '').trim() || '(ไม่ระบุช่องทาง)';
        if (!channels.has(name)) channels.set(name, { name, total: 0, success: 0, durations: [] });
        const bucket = channels.get(name);
        bucket.total += num(record.total_count) ?? 0;
        bucket.success += num(record.success_count) ?? 0;
        const duration = num(record.avg_duration_min);
        if (duration !== null) bucket.durations.push(duration);
      }

      const rows = [...channels.values()]
        .map((bucket) => ({
          PayName: bucket.name,
          total_count: bucket.total,
          success_count: bucket.success,
          // Counts over counts.
          success_rate: bucket.total ? (bucket.success / bucket.total) * 100 : null,
          avg_duration_min: bucket.durations.length
            ? bucket.durations.reduce((total, n) => total + n, 0) / bucket.durations.length
            : null,
        }))
        .sort((a, b) => b.total_count - a.total_count);

      const totalCount = rows.reduce((total, row) => total + row.total_count, 0);
      const totalSuccess = rows.reduce((total, row) => total + row.success_count, 0);

      return {
        kpis: [
          kpi('รายการฝากทั้งหมด', totalCount || null, COUNT),
          kpi('สำเร็จ', totalSuccess || null, COUNT),
          kpi('อัตราสำเร็จรวม', totalCount ? (totalSuccess / totalCount) * 100 : null, PCT),
          kpi('ช่องทางที่ใช้งาน', rows.length, COUNT),
        ],
        charts: [
          {
            id: 'deposit-detail-channels',
            type: 'bar',
            title: 'จำนวนรายการฝากตามช่องทาง',
            labels: rows.slice(0, 12).map((row) => row.PayName),
            datasets: [
              { label: 'รายการทั้งหมด', unit: COUNT, data: rows.slice(0, 12).map((r) => r.total_count) },
              { label: 'สำเร็จ', unit: COUNT, data: rows.slice(0, 12).map((r) => r.success_count) },
            ],
          },
        ],
        tables: [
          {
            title: 'ช่องทางการฝากเงิน',
            columns: [
              { key: 'PayName', label: 'ช่องทาง', unit: TEXT },
              { key: 'total_count', label: 'รายการ', unit: COUNT },
              { key: 'success_count', label: 'สำเร็จ', unit: COUNT },
              { key: 'success_rate', label: 'อัตราสำเร็จ', unit: PCT },
              { key: 'avg_duration_min', label: 'เวลาเฉลี่ย', unit: MINUTES },
            ],
            rows,
            note: 'เวลาเฉลี่ยนับเฉพาะรายการที่สำเร็จ',
          },
        ],
      };
    },
  },
  {
    id: 'bonus',
    title: 'Bonus',
    fileType: 'bonus_log',
    build(entries) {
      const records = entries.map((entry) => entry.record);

      const types = new Map();
      for (const record of records) {
        const name = String(record.Type ?? '').trim() || '(ไม่ระบุประเภท)';
        if (!types.has(name)) types.set(name, { name, points: 0, count: 0 });
        const bucket = types.get(name);
        bucket.points += num(record.total_points) ?? 0;
        bucket.count += num(record.transaction_count) ?? 0;
      }

      const rows = [...types.values()]
        .map((bucket) => ({
          Type: bucket.name,
          total_points: bucket.points,
          transaction_count: bucket.count,
          avg_points: bucket.count ? bucket.points / bucket.count : null,
        }))
        .sort((a, b) => b.total_points - a.total_points);

      const series = dailySeries(entries, [
        { column: 'total_points', label: 'point ที่จ่าย', unit: NUMBER },
      ]);

      return {
        kpis: [
          kpi('Point ที่จ่ายรวม', rows.reduce((total, row) => total + row.total_points, 0) || null, NUMBER),
          kpi(
            'จำนวนครั้งที่จ่าย',
            rows.reduce((total, row) => total + row.transaction_count, 0) || null,
            COUNT,
          ),
          kpi('ประเภท point ที่จ่าย', rows.length, COUNT),
          kpi('ประเภทที่กินงบมากสุด', rows[0]?.Type ?? null, TEXT),
        ],
        charts: [
          {
            id: 'bonus-types',
            type: 'bar',
            title: 'Point ที่จ่ายตามประเภท',
            labels: rows.map((row) => row.Type),
            datasets: [{ label: 'point รวม', unit: NUMBER, data: rows.map((row) => row.total_points) }],
          },
          {
            id: 'bonus-daily',
            type: 'line',
            title: 'Point ที่จ่ายรายวัน',
            labels: series.labels,
            datasets: series.datasets,
          },
        ],
        tables: [
          {
            title: 'ประเภท point',
            columns: [
              { key: 'Type', label: 'ประเภท', unit: TEXT },
              { key: 'total_points', label: 'point รวม', unit: NUMBER },
              { key: 'transaction_count', label: 'ครั้ง', unit: COUNT },
              { key: 'avg_points', label: 'เฉลี่ยต่อครั้ง', unit: NUMBER },
            ],
            rows,
            note: 'Point ไม่ใช่จำนวนเงินบาท จึงไม่มีคอลัมน์ _THB คู่กัน',
          },
        ],
      };
    },
  },
];

/** The tab list, for anything that needs it without loading a month (tests, docs). */
export const MONTHLY_SECTION_IDS = SECTIONS.map((section) => section.id);

/**
 * How the money in this payload was arrived at, verbatim from the site config.
 *
 * On the page for the same reason `currencyGuidance` puts it in the model's
 * context: a baht figure with no stated rate cannot be checked against Power
 * BI, and a reader with no rate in front of them tends to assume the file's
 * raw numbers are what they are seeing.
 */
function currencyOf(site) {
  const descriptor = getSite(site);
  if (!descriptor) return null;
  return {
    currency: descriptor.currency,
    scaleFactor: descriptor.scaleFactor,
    fxRate: descriptor.fxRate,
    fxRateAsOf: descriptor.fxRateAsOf,
    needsFxConversion: descriptor.needsFxConversion,
  };
}

/**
 * Everything the monthly dashboard shows, for one site and one month.
 *
 * Returns `null` when that site/month has no uploaded file at all — the caller
 * turns that into "ยังไม่มีข้อมูลเดือนนี้" rather than opening a page of empty
 * tabs. A month with *some* files always produces a payload: the sections whose
 * file is missing come back `available: false` and name what to upload, which
 * is the same distinction `inventoryBlock` draws for the model.
 */
export async function buildMonthlyPayload({ site, yearMonth, onProgress } = {}) {
  const uploaded = new Set(listRawFiles({ site, yearMonth }).map((row) => row.file_type));
  if (uploaded.size === 0) return null;

  const sections = [];
  const missing = [];

  for (const section of SECTIONS) {
    const label = getFileType(section.fileType)?.label ?? section.fileType;
    const base = { id: section.id, title: section.title, fileType: section.fileType, fileLabel: label };

    if (!uploaded.has(section.fileType)) {
      if (!missing.some((entry) => entry.fileType === section.fileType)) {
        missing.push({ fileType: section.fileType, label });
      }
      sections.push({ ...base, available: false, reason: 'ยังไม่ได้อัปโหลดไฟล์นี้สำหรับเดือนนี้' });
      continue;
    }

    const entries = await loadRows({ site, yearMonth, fileType: section.fileType, onProgress });
    if (!entries) {
      sections.push({ ...base, available: false, reason: 'มีไฟล์อยู่ในระบบ แต่อ่านข้อมูลจากไฟล์ไม่ได้' });
      continue;
    }

    try {
      const built = section.build(entries);
      sections.push({
        ...base,
        available: true,
        rowCount: entries.length,
        kpis: built.kpis ?? [],
        charts: built.charts ?? [],
        tables: built.tables ?? [],
      });
    } catch (err) {
      // One section's shape surprising it must not cost the other ten.
      logger.error('monthly section failed to build', {
        site,
        yearMonth,
        section: section.id,
        message: err?.message,
      });
      sections.push({ ...base, available: false, reason: 'สร้างส่วนนี้ไม่สำเร็จ' });
    }
  }

  logger.info('built monthly payload', {
    site,
    yearMonth,
    sections: sections.length,
    available: sections.filter((section) => section.available).length,
  });

  return {
    kind: 'monthly',
    generatedAt: new Date().toISOString(),
    site,
    siteName: siteDisplayName(site),
    yearMonth,
    currency: currencyOf(site),
    missingFiles: missing,
    sections,
  };
}
