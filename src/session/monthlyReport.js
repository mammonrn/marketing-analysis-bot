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
 * Benchmarks come from `config/report-benchmarks.json`, per site. Which matters
 * more than it looks: SH666's "RTP > 100% on 14% of days is normal" is not true
 * of U89, where it is 3% and genuinely worth investigating. A KPI with no
 * documented benchmark for the site shows none, rather than borrowing one.
 *
 * The output is a flat, render-agnostic shape:
 *
 *   sections: [{ id, title, fileType, available, alerts[], kpis[], charts[],
 *                tables[], insights[] }]
 *
 * so `public/miniapp/assets/monthly.js` is a generic renderer with no knowledge
 * of casino metrics, and a new section costs one builder here and nothing on
 * the front end.
 */

import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../paths.js';
import { logger } from '../logger.js';
import { getSite, siteDisplayName } from '../data/sites.js';
import { getFileType } from '../data/fileTypes.js';
import { normaliseRow, deriveMetrics, toNumber } from '../data/transform.js';
import { ensureParsed } from '../data/parse.js';
import { listRawFiles, queryParsedRows } from '../data/db.js';

const BENCHMARKS = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'config', 'report-benchmarks.json'), 'utf8'),
);

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

function values(records, column) {
  return records.map((record) => num(record[column])).filter((n) => n !== null);
}

function sum(records, column) {
  const found = values(records, column);
  return found.length === 0 ? null : found.reduce((total, n) => total + n, 0);
}

function mean(records, column) {
  const found = values(records, column);
  if (found.length === 0) return null;
  return found.reduce((total, n) => total + n, 0) / found.length;
}

/**
 * The reference files quote medians as often as means, and for a reason: this
 * business is volatile day to day, and one jackpot day drags a monthly mean
 * somewhere no ordinary day was. Both are reported where the reference does.
 */
function median(records, column) {
  const found = values(records, column).sort((a, b) => a - b);
  if (found.length === 0) return null;
  const mid = Math.floor(found.length / 2);
  return found.length % 2 ? found[mid] : (found[mid - 1] + found[mid]) / 2;
}

/** `null` rather than `-Infinity` when nothing in the column parsed as a number. */
function max(records, column) {
  const found = values(records, column);
  return found.length === 0 ? null : Math.max(...found);
}

function min(records, column) {
  const found = values(records, column);
  return found.length === 0 ? null : Math.min(...found);
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

function countWhere(records, predicate) {
  return records.filter(predicate).length;
}

// --- presentation helpers ----------------------------------------------------

const kpi = (label, value, unit, { note, status } = {}) => ({
  label,
  value,
  unit,
  ...(note ? { note } : {}),
  ...(status ? { status } : {}),
});

/**
 * `good` / `warn` / `bad`, or nothing at all.
 *
 * Nothing at all is the important case: a KPI whose site has no documented
 * benchmark gets no colour, because a green badge that means "we had no figure
 * to compare against" is worse than a plain number.
 */
function statusAtLeast(value, good, warn) {
  if (value === null || good === null || good === undefined) return undefined;
  if (value >= good) return 'good';
  if (warn !== undefined && warn !== null && value < warn) return 'bad';
  return 'warn';
}

function statusAtMost(value, good, bad) {
  if (value === null || good === null || good === undefined) return undefined;
  if (value <= good) return 'good';
  if (bad !== undefined && bad !== null && value > bad) return 'bad';
  return 'warn';
}

const nf = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

/** Formatters for insight sentences — the renderer formats the structured fields. */
const fmtInt = (n) => (n === null || n === undefined ? 'ไม่มีข้อมูล' : nf.format(Math.round(n)));
const fmtPct = (n, digits = 1) => (n === null || n === undefined ? 'ไม่มีข้อมูล' : `${n.toFixed(digits)}%`);
function fmtThb(n) {
  if (n === null || n === undefined) return 'ไม่มีข้อมูล';
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${sign}฿${(abs / 1_000_000).toFixed(2)}M`;
  return `${sign}฿${nf.format(Math.round(abs))}`;
}

const alert = (level, text) => ({ level, text });

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
    datasets: columns.map(({ column, label, unit, ...rest }) => ({
      label,
      unit,
      ...rest,
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

function bottomBy(records, column, limit = TOP_N) {
  return [...records]
    .filter((record) => num(record[column]) !== null)
    .sort((a, b) => num(a[column]) - num(b[column]))
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
 * Each entry owns one tab.
 *
 * `fileType` is the one that has to be there for the tab to exist at all.
 * `also` names files the section enriches itself with when they happen to be
 * present — the Overview reads VIP and deposit-count totals, the Hours tab
 * pairs the baht grid with its head-count twin — and simply says less when they
 * are not. Making those hard requirements would blank a whole tab over a
 * secondary file, which is the opposite of what an operator wants.
 *
 * `build(entries, extra, ctx)` gets the primary rows, a `Map` of the extras
 * (missing ones absent), and `{ site, yearMonth, bench, shared }`.
 */
const SECTIONS = [
  {
    id: 'overview',
    title: '🏠 ภาพรวม',
    fileType: 'daily_value',
    also: ['vip', 'deposit_count_distribution'],
    build(entries, extra, { bench, shared }) {
      const records = entries.map((entry) => entry.record);
      const days = entries.length;

      const rtpMedian = median(records, 'RTP_pct');
      const rBinMedian = median(records, 'R/BIn_pct');
      const rBinMonth = ratioPct(records, 'R_THB', 'BIn_THB');
      const dauMean = mean(records, 'DAU');
      const rTotal = sum(records, 'R_THB');
      const binTotal = sum(records, 'BIn_THB');
      const negativeDays = countWhere(records, (r) => (num(r.R_THB) ?? 0) < 0);
      const over100Days = countWhere(records, (r) => (num(r.RTP_pct) ?? 0) > 100);

      // Cross-file, because "how was the month" is not answerable from the
      // daily export alone — the VIP base and the power-user share are what
      // say whether the revenue rests on anything durable.
      const vipRecords = (extra.get('vip') ?? []).map((entry) => entry.record);
      const vipRated = vipRecords.filter((r) => num(r['Last BIn 2 Y']) !== null);
      const vipActive = countWhere(vipRated, (r) => num(r['Last BIn 2 Y']) <= 7);
      const vipActivePct = vipRated.length ? (vipActive / vipRated.length) * 100 : null;

      const countRecords = (extra.get('deposit_count_distribution') ?? []).map((e) => e.record);
      const plus21Pct = countRecords.length
        ? ratioPct(countRecords, '21+ Counts', 'BIn Mems')
        : null;

      const alerts = [];
      if (over100Days > 0) {
        const yearly = bench.rtpOver100YearPct;
        alerts.push(
          alert(
            'warn',
            `⚠️ มี ${over100Days} วันที่ RTP เกิน 100% (casino ขาดทุนวันนั้น)` +
              (yearly === null || yearly === undefined
                ? ''
                : ` — ${siteDisplayName(bench.site)} ทั้งปีเจอราว ${yearly}% ของวัน`) +
              ' ควรเช็คว่าไม่เกิดติดต่อกันเกิน 2 วัน',
          ),
        );
      }
      if (negativeDays > 0) {
        alerts.push(
          alert(
            'warn',
            `⚠️ มี ${negativeDays} วันที่ Revenue ติดลบ จาก ${days} วัน — ` +
              'เป็นความผันผวนปกติรายวัน ให้ดู trend สะสมแทนวันเดียว',
          ),
        );
      }
      if (vipActivePct !== null && 100 - vipActivePct > shared.vipLostPctWarn) {
        alerts.push(
          alert(
            'bad',
            `🚨 Lost VIP สูงถึง ${fmtPct(100 - vipActivePct)} ` +
              `(เกินเกณฑ์เตือน ${shared.vipLostPctWarn}%) ควรทำ re-engagement ด่วน`,
          ),
        );
      }
      if (alerts.length === 0) {
        alerts.push(
          alert(
            'ok',
            '✅ ไม่มีสัญญาณวิกฤตเด่นชัดในเดือนนี้ — ตัวเลขหลักอยู่ในเกณฑ์ดีเทียบ benchmark ของเว็บนี้เอง',
          ),
        );
      }

      const series = dailySeries(entries, [
        { column: 'R_THB', label: 'Revenue (บาท)', unit: THB },
      ]);
      const dauSeries = dailySeries(entries, [
        { column: 'DAU', label: 'DAU', unit: COUNT, chartType: 'bar' },
        { column: 'BIn Mems', label: 'BIn Mems', unit: COUNT, chartType: 'line' },
      ]);

      const insights = [
        `Revenue รวมเดือนนี้ ${fmtThb(rTotal)} จาก BIn รวม ${fmtThb(binTotal)} ` +
          `คิดเป็นอัตรากำไร ${fmtPct(rBinMonth)} ต่อยอดเติมเงิน`,
      ];
      if (dauMean !== null && bench.dauMean) {
        insights.push(
          `DAU เฉลี่ย ${fmtInt(dauMean)} คน/วัน ` +
            `${dauMean >= bench.dauMean ? 'สูงกว่า' : 'ต่ำกว่า'} benchmark ทั้งปีของเว็บนี้ (${fmtInt(bench.dauMean)} คน)`,
        );
      }
      if (vipActivePct !== null) {
        insights.push(
          `ฐานลูกค้า VIP มี Active ${fmtPct(vipActivePct)} ` +
            `${vipActivePct >= shared.vipActivePct.good ? 'ดีกว่า' : 'ต่ำกว่า'} benchmark (${shared.vipActivePct.good}%)`,
        );
      }
      if (plus21Pct !== null) {
        insights.push(
          `กลุ่ม Power User (ฝาก 21+ ครั้ง/วัน) คิดเป็น ${fmtPct(plus21Pct)} ของคนฝากทั้งหมด — ` +
            'core revenue พึ่งพากลุ่มนี้สูง ควรดูแลรักษากลุ่มนี้เป็นพิเศษ',
        );
      }

      return {
        alerts,
        kpis: [
          kpi('Revenue รวมทั้งเดือน', rTotal, THB, {
            note: `เฉลี่ย ${fmtThb(mean(records, 'R_THB'))}/วัน`,
          }),
          kpi('BIn รวมทั้งเดือน', binTotal, THB),
          kpi('RTP median', rtpMedian, PCT, {
            note: bench.rtpMedianPct === null ? undefined : `benchmark ทั้งปี ${bench.rtpMedianPct}%`,
            status: statusAtMost(rtpMedian, bench.rtpNormalPct?.[1] ?? null, 100),
          }),
          kpi('R / BIn median', rBinMedian, PCT, {
            note:
              bench.rBinGoodPct === null
                ? undefined
                : `benchmark median ${bench.rBinMedianPct}% (ดี > ${bench.rBinGoodPct}%)`,
            status: statusAtLeast(rBinMedian, bench.rBinGoodPct, bench.rBinWarnPct),
          }),
          kpi('DAU เฉลี่ย/วัน', dauMean, COUNT, {
            note: bench.dauMean === null ? undefined : `benchmark ทั้งปี ${fmtInt(bench.dauMean)} คน`,
            status: statusAtLeast(dauMean, bench.dauMean, null),
          }),
          kpi('BIn Mems เฉลี่ย/วัน', mean(records, 'BIn Mems'), COUNT, {
            note: 'ลูกค้าที่เติมเงินต่อวัน',
          }),
          kpi('BIn Mems (np) เฉลี่ย', mean(records, 'BIn Mems (np)'), COUNT, {
            note: `${fmtPct(ratioPct(records, 'BIn Mems (np)', 'BIn Mems'))} ของ BIn Mems ไม่พึ่งโปร`,
          }),
          kpi('สมาชิกใหม่รวม', sum(records, 'New Mems'), COUNT, {
            note: `เฉลี่ย ${fmtInt(mean(records, 'New Mems'))} คน/วัน`,
          }),
          kpi('VIP ทั้งหมด', vipRecords.length || null, COUNT, {
            note:
              vipActivePct === null
                ? 'ยังไม่ได้อัปโหลดไฟล์ VIP'
                : `${fmtPct(vipActivePct)} Active / ${fmtPct(100 - vipActivePct)} Lost`,
            status: statusAtLeast(vipActivePct, shared.vipActivePct.good, shared.vipActivePct.urgent),
          }),
          kpi('Power User (21+ ครั้ง)', plus21Pct, PCT, {
            note: `ของ BIn Mems ทั้งหมด — benchmark ~${shared.plus21Pct}%`,
            status: statusAtLeast(plus21Pct, shared.plus21Pct, null),
          }),
          kpi('จำนวนวันที่มีข้อมูล', days, COUNT),
        ],
        charts: [
          {
            id: 'overview-revenue',
            type: 'line',
            title: 'Revenue รายวัน (บาท)',
            labels: series.labels,
            datasets: series.datasets,
          },
          {
            id: 'overview-dau',
            type: 'bar',
            title: 'DAU เทียบ BIn Mems รายวัน',
            labels: dauSeries.labels,
            datasets: dauSeries.datasets,
          },
        ],
        tables: [],
        insights,
      };
    },
  },
  {
    id: 'finance',
    title: '💰 การเงิน & RTP',
    fileType: 'daily_value',
    build(entries, _extra, { bench }) {
      const records = entries.map((entry) => entry.record);
      const negativeDays = countWhere(records, (r) => (num(r.R_THB) ?? 0) < 0);
      const over100Days = countWhere(records, (r) => (num(r.RTP_pct) ?? 0) > 100);
      const rtpMean = mean(records, 'RTP_pct');
      const rtpMedian = median(records, 'RTP_pct');
      const rBinMedian = median(records, 'R/BIn_pct');
      const bonusTotal = sum(records, 'Bonus_THB');
      const binTotal = sum(records, 'BIn_THB');
      const bonusRatio = bonusTotal !== null && binTotal ? (bonusTotal / binTotal) * 100 : null;

      const rtpSeries = dailySeries(entries, [{ column: 'RTP_pct', label: 'RTP (%)', unit: PCT }]);
      const rBinSeries = dailySeries(entries, [
        { column: 'R/BIn_pct', label: 'R/BIn (%)', unit: PCT, colorBySign: true },
      ]);

      const dayColumns = [
        { key: 'date', label: 'วันที่', unit: TEXT },
        { key: 'R_THB', label: 'Revenue', unit: THB },
        { key: 'BIn_THB', label: 'BIn', unit: THB },
        { key: 'RTP_pct', label: 'RTP', unit: PCT },
      ];
      const dayRow = (entry) => ({
        date: entry.date,
        R_THB: num(entry.record.R_THB),
        BIn_THB: num(entry.record.BIn_THB),
        RTP_pct: num(entry.record.RTP_pct),
      });
      const rated = entries.filter((entry) => num(entry.record.R_THB) !== null);

      const insights = [];
      if (rtpMedian !== null && bench.rtpMedianPct !== null) {
        insights.push(
          `RTP median ${fmtPct(rtpMedian, 2)} เทียบ benchmark ทั้งปีของเว็บนี้ (${bench.rtpMedianPct}%) — ` +
            `${Math.abs(rtpMedian - bench.rtpMedianPct) <= 1 ? 'ใกล้เคียง ไม่มีสัญญาณผิดปกติเชิงระบบ' : 'ต่างจาก benchmark พอสมควร ควรดูรายวันประกอบ'}`,
        );
      }
      if (rBinMedian !== null && bench.rBinGoodPct !== null) {
        insights.push(
          `R/BIn median ${fmtPct(rBinMedian, 2)} ` +
            `${rBinMedian >= bench.rBinGoodPct ? `สูงกว่าเกณฑ์ "ดี" (> ${bench.rBinGoodPct}%)` : 'ต่ำกว่าเกณฑ์ดี ควรติดตาม'} — ` +
            'ควรดู moving average 7 วันแทนดูวันเดียว เพราะธุรกิจนี้ผันผวนรายวันสูงเป็นปกติ',
        );
      }
      if (over100Days > 0 && bench.rtpOver100YearPct !== null) {
        insights.push(
          `วันที่ RTP > 100% มี ${over100Days} วัน — เว็บนี้ทั้งปีเจอราว ${bench.rtpOver100YearPct}% ของวัน ` +
            'ถือว่าอยู่ในช่วงปกติตราบใดที่ไม่เกิดติดต่อกัน 2 วันขึ้นไป',
        );
      }
      if (bonusRatio !== null) {
        insights.push(
          `Bonus / BIn = ${fmtPct(bonusRatio, 2)} — ใช้เทียบกับเว็บอื่นในเครือเพื่อดูว่าคืน bonus เกินสัดส่วนหรือไม่`,
        );
      }

      return {
        alerts: [],
        kpis: [
          kpi('Revenue รวม', sum(records, 'R_THB'), THB),
          kpi('วันที่ Revenue ติดลบ', negativeDays, COUNT, {
            note: `จาก ${entries.length} วัน — ปกติของธุรกิจนี้ถ้าไม่ติดกันหลายวัน`,
          }),
          kpi('RTP เฉลี่ย', rtpMean, PCT, {
            note: bench.rtpNormalPct ? `ปกติ ${bench.rtpNormalPct[0]}–${bench.rtpNormalPct[1]}%` : undefined,
            status: statusAtMost(rtpMean, bench.rtpNormalPct?.[1] ?? null, 100),
          }),
          kpi('วันที่ RTP > 100%', over100Days, COUNT, {
            note: 'casino ขาดทุนวันนั้น',
            status: statusAtMost(over100Days, Math.round(entries.length * 0.15), Math.round(entries.length * 0.3)),
          }),
          kpi('R / BIn เฉลี่ย', mean(records, 'R/BIn_pct'), PCT, { note: 'อัตรากำไรต่อยอดเติมเงิน' }),
          kpi('CIn (Turnover) รวม', sum(records, 'CIn_THB'), THB),
          kpi('Net Win รวม', sum(records, 'Nw_THB'), THB),
          kpi('Bet Out รวม', sum(records, 'Bo_THB'), THB),
          kpi('Bonus จ่ายรวม', bonusTotal, THB, { note: `${fmtPct(bonusRatio, 2)} ของ BIn` }),
          kpi('Promotion Cost รวม', sum(records, 'Pro_THB'), THB),
        ],
        charts: [
          {
            id: 'finance-rtp',
            type: 'line',
            title: 'RTP รายวัน (%) — เส้นประ = 100%',
            labels: rtpSeries.labels,
            datasets: rtpSeries.datasets,
            refLine: { value: 100, label: '100%' },
          },
          {
            id: 'finance-rbin',
            type: 'bar',
            title: 'R/BIn รายวัน (%) — แดง = วันที่ขาดทุน',
            labels: rBinSeries.labels,
            datasets: rBinSeries.datasets,
          },
        ],
        tables: [
          {
            title: '5 วันที่ Revenue สูงสุด',
            columns: dayColumns,
            rows: [...rated].sort((a, b) => num(b.record.R_THB) - num(a.record.R_THB)).slice(0, 5).map(dayRow),
          },
          {
            title: '5 วันที่ Revenue ต่ำสุด',
            columns: dayColumns,
            rows: [...rated].sort((a, b) => num(a.record.R_THB) - num(b.record.R_THB)).slice(0, 5).map(dayRow),
          },
        ],
        insights,
      };
    },
  },
  {
    id: 'activity',
    title: '👥 กิจกรรมผู้เล่น',
    fileType: 'daily_value',
    build(entries, _extra, { bench }) {
      const records = entries.map((entry) => entry.record);
      const dauMean = mean(records, 'DAU');
      const binMemsMean = mean(records, 'BIn Mems');
      const npRatio = ratioPct(records, 'BIn Mems (np)', 'BIn Mems');
      const dauConversion = dauMean && binMemsMean ? (binMemsMean / dauMean) * 100 : null;

      const series = dailySeries(entries, [
        { column: 'DAU', label: 'DAU', unit: COUNT },
        { column: 'BIn Mems', label: 'BIn Mems', unit: COUNT },
        { column: 'BIn Mems (np)', label: 'BIn Mems (np)', unit: COUNT },
      ]);

      const insights = [
        `สัดส่วนลูกค้าไม่พึ่งโปร (BIn Mems np) ${fmtPct(npRatio)} ของคนที่ฝากเงินทั้งหมด ` +
          `สะท้อนคุณภาพฐานลูกค้าที่ค่อนข้าง${(npRatio ?? 0) >= 80 ? 'แข็งแรง' : 'ต้องเฝ้าดู'}`,
        `Conversion จาก DAU เป็น BIn Mems เฉลี่ย ${fmtPct(dauConversion)} — ` +
          'ใช้เทียบ trend วันต่อวันเพื่อจับสัญญาณลูกค้าหาย',
      ];

      return {
        alerts: [],
        kpis: [
          kpi('DAU เฉลี่ย', dauMean, COUNT, {
            note: `ต่ำสุด ${fmtInt(min(records, 'DAU'))} / สูงสุด ${fmtInt(max(records, 'DAU'))}`,
            status: statusAtLeast(dauMean, bench.dauMean, null),
          }),
          kpi('BIn Mems เฉลี่ย', binMemsMean, COUNT, {
            note: bench.binMemsMean === null ? undefined : `benchmark ${fmtInt(bench.binMemsMean)} คน/วัน`,
            status: statusAtLeast(binMemsMean, bench.binMemsMean, null),
          }),
          kpi('BIn Mems (np) เฉลี่ย', mean(records, 'BIn Mems (np)'), COUNT, {
            note: 'ลูกค้าเติมเงินโดยไม่รับโปร',
          }),
          kpi('สัดส่วน organic (np)', npRatio, PCT, {
            note: 'ยิ่งสูงยิ่งดี = ฐานลูกค้าไม่พึ่งโปร',
            status: statusAtLeast(npRatio, 80, 60),
          }),
          kpi('BIn Mems / DAU', dauConversion, PCT, { note: 'ใช้จับ trend เท่านั้น' }),
          kpi('สมาชิกใหม่รวม', sum(records, 'New Mems'), COUNT),
          kpi('Pro Mems รวม', sum(records, 'Pro Mems'), COUNT),
          kpi('ARPPU เฉลี่ยรายวัน', mean(records, 'ARPPU_THB'), THB, {
            note: 'BIn ต่อลูกค้าที่เติมเงิน 1 คน',
          }),
        ],
        charts: [
          {
            id: 'activity-daily',
            type: 'line',
            title: 'DAU / BIn Mems / BIn Mems (np) รายวัน',
            labels: series.labels,
            datasets: series.datasets,
          },
        ],
        tables: [],
        insights,
      };
    },
  },
  {
    id: 'new_member',
    title: '🆕 คุณภาพสมาชิกใหม่',
    fileType: 'new_member_quality',
    build(entries, _extra, { bench }) {
      const records = entries.map((entry) => entry.record);
      const verifyMean = mean(records, 'Verify%_pct');
      const firstNewMean = mean(records, '1st New%_pct');
      const firstNewNpMean = mean(records, '1st New (np%)_pct');
      const delayedTotal = sum(records, 'delayed_1st_deposit');
      const delayedMean = mean(records, 'delayed_1st_deposit');
      const newTotal = sum(records, 'New');
      // New (Ref.) / New — head counts, so computing it here is the case
      // SKILL.md permits; the export carries no `_pct` twin for it.
      const refRate = ratioPct(records, 'New (Ref.)', 'New');

      const funnelLabels = ['New (สมัคร)', 'Verify', '1st New Mems', '1st Day Mems'];
      const funnelData = [
        newTotal,
        sum(records, 'Verify'),
        sum(records, '1st New Mems'),
        sum(records, '1st Day Mems'),
      ];

      const series = dailySeries(entries, [
        { column: 'New', label: 'สมัครใหม่', unit: COUNT },
        { column: '1st New Mems', label: 'ฝากวันเดียวกับที่สมัคร', unit: COUNT },
        { column: '1st Day Mems', label: 'ฝากครั้งแรกวันนี้', unit: COUNT },
      ]);
      const delaySeries = dailySeries(entries, [
        { column: 'delayed_1st_deposit', label: 'Delayed 1st Deposit', unit: COUNT },
      ]);

      const insights = [];
      if (verifyMean !== null && bench.verifyPct !== null) {
        insights.push(
          `Verify% เฉลี่ย ${fmtPct(verifyMean)} ` +
            `${verifyMean >= bench.verifyPct ? 'อยู่ในเกณฑ์ดี ใกล้หรือดีกว่า benchmark' : 'ต่ำกว่า benchmark ควรดู onboarding flow'} ` +
            `(benchmark เว็บนี้ ${bench.verifyPct}%)`,
        );
      }
      if (firstNewMean !== null && bench.firstNewPct !== null) {
        insights.push(
          `1st New% (ฝากวันเดียวกับสมัคร) เฉลี่ย ${fmtPct(firstNewMean)} — คุณภาพ traffic ` +
            `${firstNewMean >= bench.firstNewPct ? 'ปกติ/ดี' : 'ต่ำกว่าค่าเฉลี่ยของเว็บนี้ ควรเช็คแหล่งโฆษณา'}`,
        );
      }
      insights.push(
        `Delayed Depositors เฉลี่ย ${fmtInt(delayedMean)} คน/วัน (รวม ${fmtInt(delayedTotal)} คนทั้งเดือน) — ` +
          'เป็น pool คนที่สมัครไว้ก่อนแล้วมาฝากทีหลัง เหมาะเป็นเป้าหมาย re-engagement campaign',
      );
      if (firstNewNpMean !== null) {
        insights.push(
          `1st New (np%) เฉลี่ย ${fmtPct(firstNewNpMean)} แปลว่าคนฝากวันแรกส่วนใหญ่ไม่ได้พึ่งโปรโมชั่น ` +
            'เป็นสัญญาณบวกต่อคุณภาพ member',
        );
      }

      return {
        alerts: [],
        kpis: [
          kpi('สมาชิกใหม่รวม', newTotal, COUNT, { note: `เฉลี่ย ${fmtInt(mean(records, 'New'))} คน/วัน` }),
          kpi('Verify% เฉลี่ย', verifyMean, PCT, {
            note: bench.verifyPct === null ? undefined : `benchmark เว็บนี้ ~${bench.verifyPct}%`,
            status: statusAtLeast(verifyMean, bench.verifyPct, null),
          }),
          kpi('1st New% เฉลี่ย', firstNewMean, PCT, {
            note: bench.firstNewPct === null ? undefined : `benchmark เว็บนี้ ~${bench.firstNewPct}%`,
            status: statusAtLeast(firstNewMean, bench.firstNewPct, null),
          }),
          kpi('1st New (np%) เฉลี่ย', firstNewNpMean, PCT, {
            note: bench.firstNewNpPct === null ? undefined : `benchmark ~${bench.firstNewNpPct}%`,
            status: statusAtLeast(firstNewNpMean, bench.firstNewNpPct, null),
          }),
          kpi('1st Day (np%) เฉลี่ย', mean(records, '1st Day (np%)_pct'), PCT),
          kpi('Delayed Depositors เฉลี่ย/วัน', delayedMean, COUNT, {
            note:
              bench.delayedPerDay === null
                ? '1st Day Mems − 1st New Mems'
                : `benchmark เว็บนี้ ~${bench.delayedPerDay} คน/วัน`,
          }),
          kpi('Delayed Depositors รวม', delayedTotal, COUNT),
          kpi('Referral Rate เฉลี่ย', refRate, PCT, { note: 'New (Ref.) ต่อ New — benchmark 1.5–2%' }),
          kpi('ยอดฝากของ 1st New รวม', sum(records, '1st New (BIn)_THB'), THB),
          kpi('ยอดฝากของ 1st Day รวม', sum(records, '1st Day (BIn)_THB'), THB),
        ],
        charts: [
          {
            id: 'new-member-funnel',
            type: 'bar',
            title: 'Conversion Funnel: New → Verify → 1st New Mems → 1st Day Mems (รวมทั้งเดือน)',
            labels: funnelLabels,
            datasets: [{ label: 'จำนวนคน', unit: COUNT, data: funnelData, colorByIndex: true }],
            horizontal: true,
          },
          {
            id: 'new-member-delay',
            type: 'bar',
            title: 'Delayed 1st Deposit รายวัน',
            labels: delaySeries.labels,
            datasets: delaySeries.datasets,
          },
          {
            id: 'new-member-daily',
            type: 'line',
            title: 'สมาชิกใหม่และการฝากครั้งแรก รายวัน',
            labels: series.labels,
            datasets: series.datasets,
          },
        ],
        tables: [],
        insights,
      };
    },
  },
  {
    id: 'deposit_count',
    title: '📊 ความถี่การฝาก',
    fileType: 'deposit_count_distribution',
    build(entries, _extra, { shared }) {
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
      const plus21Pct = ratioPct(records, '21+ Counts', 'BIn Mems');
      const casualPct = ratioPct(records, '1 Time', 'BIn Mems');

      // Per-day share, so the stacked chart shows the mix moving rather than
      // the head counts moving with the size of the day.
      const stacked = byDate(entries.filter((entry) => entry.date));
      const sharePerDay = (entry, column) => {
        const mems = num(entry.record['BIn Mems']);
        const value = num(entry.record[column]);
        return mems && value !== null ? (value / mems) * 100 : null;
      };

      const insights = [];
      if (plus21Pct !== null) {
        insights.push(
          `กลุ่ม Power User (21+ ครั้ง/วัน) คิดเป็น ${fmtPct(plus21Pct)} ของคนฝากทั้งหมด ` +
            `${plus21Pct >= shared.plus21Pct ? `สูงกว่า benchmark (${shared.plus21Pct}%) — ฐาน loyal player แข็งแรง` : `ต่ำกว่า benchmark (${shared.plus21Pct}%) ควรดู retention`} ` +
            'เป็น core revenue driver',
        );
      }
      if (casualPct !== null) {
        insights.push(
          `Casual player (1 Time) มีสัดส่วน ${fmtPct(casualPct)} ` +
            `${casualPct <= shared.casualPctMax ? 'อยู่ในเกณฑ์ปกติ' : `สูงกว่าเกณฑ์ (${shared.casualPctMax}%) ควรดู retention ของกลุ่มนี้`}`,
        );
      }
      if (powerUserPct !== null) {
        insights.push(
          `Power User Index ${fmtPct(powerUserPct)} สะท้อนว่า casino พึ่งพา core player ค่อนข้างมาก — ` +
            'ถ้ากลุ่มนี้ churn จะกระทบ revenue หนัก ควรมีมาตรการรักษาเป็นพิเศษ',
        );
      }

      return {
        alerts: [],
        kpis: [
          kpi('BIn Mems เฉลี่ย/วัน', mean(records, 'BIn Mems'), COUNT),
          kpi('21+ Counts (Power User)', plus21Pct, PCT, {
            note: `benchmark ~${shared.plus21Pct}%`,
            status: statusAtLeast(plus21Pct, shared.plus21Pct, null),
          }),
          kpi('1 Time (Casual)', casualPct, PCT, {
            note: `benchmark < ${shared.casualPctMax}% (สูง = ต้องระวัง)`,
            status: statusAtMost(casualPct, shared.casualPctMax, null),
          }),
          kpi('Power User Index', powerUserPct, PCT, {
            note: `(11–20 + 21+) / BIn Mems — benchmark ~${shared.powerUserIndexPct}%`,
            status: statusAtLeast(powerUserPct, shared.powerUserIndexPct, null),
          }),
        ],
        charts: [
          {
            id: 'deposit-count-share',
            type: 'doughnut',
            title: 'สัดส่วน Segment รวมทั้งเดือน',
            labels: totals.map((bucket) => bucket.label),
            datasets: [{ label: 'จำนวน member', unit: COUNT, data: totals.map((b) => b.total) }],
          },
          {
            id: 'deposit-count-stack',
            type: 'bar',
            title: 'สัดส่วน Casual เทียบ Power user รายวัน (%)',
            labels: stacked.map((entry) => dayLabel(entry.date)),
            datasets: [
              {
                label: '1 ครั้ง (%)',
                unit: PCT,
                data: stacked.map((entry) => sharePerDay(entry, '1 Time')),
              },
              {
                label: '21+ ครั้ง (%)',
                unit: PCT,
                data: stacked.map((entry) => sharePerDay(entry, '21+ Counts')),
              },
            ],
            stacked: true,
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
            rows: totals.map((bucket) => ({
              label: bucket.label,
              total: bucket.total,
              share: bucket.total !== null && memsTotal ? (bucket.total / memsTotal) * 100 : null,
            })),
            note: 'นับแบบ "คน-วัน" — member หนึ่งคนที่ฝากหลายวันถูกนับทุกวัน',
          },
        ],
        insights,
      };
    },
  },
  {
    id: 'brand_game',
    title: '🎮 Brand / Game',
    fileType: 'brand_game_value',
    build(entries) {
      const records = entries.map((entry) => entry.record);
      const totalCIn = sum(records, 'CIn_THB');
      const ranked = topBy(records, 'CIn_THB', 20);
      const losing = records.filter((record) => (num(record.RTP_pct) ?? 0) > 100);
      const top = ranked[0];

      const alerts = losing.map((record) =>
        alert(
          'bad',
          `🚨 ${record.GameKind ?? 'เกมนี้'} มี RTP ${fmtPct(num(record.RTP_pct))} (เกิน 100%) — ` +
            'casino ขาดทุนจากประเภทเกมนี้',
        ),
      );

      const insights = [];
      if (top && totalCIn) {
        insights.push(
          `${top.GameKind} เป็นเกมหลัก คิดเป็น ${fmtPct(((num(top.CIn_THB) ?? 0) / totalCIn) * 100)} ของ CIn ทั้งหมด — ` +
            'การเปลี่ยนแปลงของเกมนี้กระทบภาพรวมทันที',
        );
      }
      if (losing.length > 0) {
        insights.push(
          `มี ${losing.length} ประเภทเกมที่ RTP เกิน 100% (${losing.map((r) => r.GameKind).join(', ')}) — ` +
            'ถ้า CIn ของกลุ่มนี้เล็กก็กระทบไม่มาก แต่ควรดูว่าเป็นเรื้อรังหรือชั่วคราว',
        );
      }
      insights.push(
        'ไฟล์นี้เป็นข้อมูลสะสม 6 เดือนล่าสุดตามที่ Power BI export มา ไม่ใช่เฉพาะเดือนที่เลือก — ' +
          'ใช้ดูโครงสร้าง market share ไม่ใช่ดู trend รายเดือน',
      );

      return {
        alerts,
        kpis: [
          kpi('CIn รวมทุกประเภทเกม', totalCIn, THB),
          kpi('Net Win รวม', sum(records, 'Nw_THB'), THB),
          kpi('ประเภทเกมที่มีข้อมูล', records.length, COUNT),
          kpi('เกมที่ RTP > 100%', losing.length, COUNT, {
            note: 'ประเภทเกมที่ casino ขาดทุน',
            status: statusAtMost(losing.length, 0, 2),
          }),
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
            horizontal: true,
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
              // Money over money: the site factor cancels, so the share is a
              // pure ratio and needs no conversion of its own.
              share: totalCIn ? ((num(record.CIn_THB) ?? 0) / totalCIn) * 100 : null,
              Nw_THB: num(record.Nw_THB),
              RTP_pct: num(record.RTP_pct),
              DAU: num(record.DAU),
              Counts: num(record.Counts),
              // The renderer paints the row's RTP cell from this.
              _status: { RTP_pct: (num(record.RTP_pct) ?? 0) > 100 ? 'bad' : 'good' },
            })),
            note: 'ไฟล์นี้เป็นข้อมูลสะสม 6 เดือนล่าสุด ไม่ใช่เฉพาะเดือนที่เลือก',
          },
        ],
        insights,
      };
    },
  },
  {
    id: 'vip',
    title: '👑 VIP',
    fileType: 'vip',
    build(entries, _extra, { shared }) {
      const records = entries.map((entry) => entry.record);
      // vip-members.md: Last BIn 2 Y counts days back from yesterday, and > 7
      // is the file's own definition of a lost VIP.
      const withRecency = records.filter((record) => num(record['Last BIn 2 Y']) !== null);
      const active = withRecency.filter((record) => num(record['Last BIn 2 Y']) <= 7);
      const lost = withRecency.filter((record) => num(record['Last BIn 2 Y']) > 7);
      const activePct = withRecency.length ? (active.length / withRecency.length) * 100 : null;
      const lostPct = activePct === null ? null : 100 - activePct;
      const lostAvgDays = mean(lost, 'Last BIn 2 Y');

      // vip-members.md names the Agent breakdown as a standing question: which
      // channel actually produces VIPs, as opposed to sign-ups.
      const agents = new Map();
      for (const record of records) {
        const name = String(record.Agent ?? '').trim() || '(ไม่ระบุ)';
        agents.set(name, (agents.get(name) ?? 0) + 1);
      }
      const agentBreakdown = [...agents.entries()]
        .map(([agent, count]) => ({ agent, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 8);

      const alerts = [];
      if (lostPct !== null && lostPct > shared.vipLostPctWarn) {
        alerts.push(
          alert(
            'bad',
            `🚨 Lost VIP ${fmtPct(lostPct)} สูงกว่าเกณฑ์เตือน (> ${shared.vipLostPctWarn}%) ควรทำ re-engagement ด่วน`,
          ),
        );
      }

      const vipRow = (record) => ({
        Username: record.Username ?? '—',
        BIn_THB: num(record.BIn_THB),
        R_THB: num(record.R_THB),
        'BIn Days': num(record['BIn Days']),
        'Med. BIn_THB': num(record['Med. BIn_THB']),
        'Last BIn 2 Y': num(record['Last BIn 2 Y']),
      });

      const insights = [];
      if (activePct !== null) {
        insights.push(
          `Active VIP ${fmtPct(activePct)} ` +
            `${activePct >= shared.vipActivePct.good ? `ดีกว่า benchmark (${shared.vipActivePct.good}%)` : `ต่ำกว่า benchmark (${shared.vipActivePct.good}%) ควรทำ re-engagement`}`,
        );
      }
      if (lostAvgDays !== null) {
        insights.push(
          `Lost VIP เฉลี่ยหายไปนาน ${fmtInt(lostAvgDays)} วัน — ` +
            'ถ้าเพิ่งหาย (8–14 วัน) มีโอกาส re-engage สูงกว่ากลุ่มที่หายนาน',
        );
      }
      if (agentBreakdown[0] && agentBreakdown[0].agent !== '(ไม่ระบุ)') {
        insights.push(
          `Agent ที่ส่ง VIP มากที่สุดคือ ${agentBreakdown[0].agent} (${agentBreakdown[0].count} คน) — ` +
            'ใช้เทียบ Revenue เฉลี่ยต่อ agent เพื่อดูคุณภาพ traffic',
        );
      }

      return {
        alerts,
        kpis: [
          kpi('VIP ทั้งหมด', records.length, COUNT),
          kpi('Active VIP', active.length, COUNT, {
            note: `${fmtPct(activePct)} (benchmark ${shared.vipActivePct.good}%)`,
            status: statusAtLeast(activePct, shared.vipActivePct.good, shared.vipActivePct.urgent),
          }),
          kpi('Lost VIP', lost.length, COUNT, {
            note: `${fmtPct(lostPct)} — หายไปเฉลี่ย ${fmtInt(lostAvgDays)} วัน`,
            status: statusAtMost(lostPct, shared.vipLostPctWarn, null),
          }),
          kpi('BIn เฉลี่ย/คน', mean(records, 'BIn_THB'), THB),
          kpi('Revenue เฉลี่ย/คน', mean(records, 'R_THB'), THB),
          kpi('BIn รวมทั้งกลุ่ม', sum(records, 'BIn_THB'), THB),
          kpi('Revenue รวมทั้งกลุ่ม', sum(records, 'R_THB'), THB),
        ],
        charts: [
          {
            id: 'vip-status',
            type: 'doughnut',
            title: 'Active เทียบ Lost',
            labels: ['Active', 'Lost'],
            datasets: [{ label: 'จำนวน VIP', unit: COUNT, data: [active.length, lost.length] }],
          },
          {
            id: 'vip-agent',
            type: 'bar',
            title: 'Agent ที่ส่ง VIP มามากที่สุด (Top 8)',
            labels: agentBreakdown.map((entry) => entry.agent),
            datasets: [
              { label: 'จำนวน VIP', unit: COUNT, data: agentBreakdown.map((entry) => entry.count) },
            ],
            horizontal: true,
          },
        ],
        tables: [
          {
            title: `Top ${TOP_N} VIP by Revenue`,
            columns: [
              { key: 'Username', label: 'Username', unit: TEXT },
              { key: 'BIn_THB', label: 'ยอดฝากรวม', unit: THB },
              { key: 'R_THB', label: 'Revenue', unit: THB },
              { key: 'BIn Days', label: 'วันที่ฝาก', unit: COUNT },
              { key: 'Med. BIn_THB', label: 'ฝากครั้งละ (median)', unit: THB },
              { key: 'Last BIn 2 Y', label: 'ฝากล่าสุด (วันก่อน)', unit: COUNT },
            ],
            rows: topBy(records, 'R_THB').map(vipRow),
          },
          {
            title: `Top ${TOP_N} Lost VIP (เรียงตาม BIn) — สำหรับทีม CRM`,
            columns: [
              { key: 'Username', label: 'Username', unit: TEXT },
              { key: 'BIn_THB', label: 'ยอดฝากรวม', unit: THB },
              { key: 'Last BIn 2 Y', label: 'หายไปกี่วัน', unit: COUNT },
              { key: 'Phone', label: 'โทร', unit: TEXT },
            ],
            // Phone is here because the report this page replaces has it and
            // vip-members.md names calling these members as the list's purpose.
            // It is the only contact detail anywhere in the payload, and it
            // rides the same one-hour single-chat token as everything else.
            rows: topBy(lost, 'BIn_THB').map((record) => ({
              ...vipRow(record),
              Phone: String(record.Phone ?? '').trim() || '—',
            })),
            note: 'รายชื่อสำหรับทีม CRM ติดต่อกลับ — มีเบอร์โทรของลูกค้า อย่าส่งลิงก์นี้ต่อออกนอกทีม',
          },
        ],
        insights,
      };
    },
  },
  {
    id: 'referrer',
    title: '🔗 Referrer & Agent',
    fileType: 'referrer',
    also: ['ad_agent'],
    build(entries, extra) {
      const records = entries.map((entry) => entry.record);
      const ranked = topBy(records, 'R_THB');
      const totalMems = sum(records, 'Total Mems');
      const totalBinMems = sum(records, 'Total BIn Mems');
      const conversion = totalMems ? (totalBinMems / totalMems) * 100 : null;

      // Head counts over head counts: the export's own `BIn Mems%` has no
      // `_pct` twin, and SKILL.md permits computing a ratio of people.
      const conversionOf = (record) => {
        const total = num(record['Total Mems']);
        const depositing = num(record['Total BIn Mems']);
        return total && depositing !== null ? (depositing / total) * 100 : null;
      };

      const referrerRow = (record) => ({
        Referrer: record.Referrer ?? '—',
        'Total Mems': num(record['Total Mems']),
        binMemsPct: conversionOf(record),
        BIn_THB: num(record.BIn_THB),
        'Ref Bonus_THB': num(record['Ref Bonus_THB']),
        R_THB: num(record.R_THB),
      });
      const referrerColumns = [
        { key: 'Referrer', label: 'Referrer', unit: TEXT },
        { key: 'Total Mems', label: 'Downline', unit: COUNT },
        { key: 'binMemsPct', label: 'ฝากจริง%', unit: PCT },
        { key: 'BIn_THB', label: 'ยอดฝากรวม', unit: THB },
        { key: 'Ref Bonus_THB', label: 'Ref Bonus', unit: THB },
        { key: 'R_THB', label: 'Revenue', unit: THB },
      ];

      // referrer.md's red flag: many recruits, almost none depositing. The
      // floor of 5 keeps someone who invited one friend out of the list.
      const lowQuality = records
        .filter((record) => (num(record['Total Mems']) ?? 0) >= 5)
        .filter((record) => (conversionOf(record) ?? 100) < 20)
        .sort((a, b) => (num(b['Total Mems']) ?? 0) - (num(a['Total Mems']) ?? 0))
        .slice(0, TOP_N);

      const unprofitable = records.filter((record) => {
        const bonus = num(record['Ref Bonus_THB']);
        const revenue = num(record.R_THB);
        return bonus !== null && revenue !== null && bonus > revenue;
      });

      // AD / Agent lives in its own export and answers the other half of
      // "where does traffic come from" — paid channels rather than word of
      // mouth. Optional: a month without the file just loses this chart.
      const adRecords = (extra.get('ad_agent') ?? []).map((entry) => entry.record);
      const adChannels = topBy(adRecords, 'R_THB');

      const charts = [
        {
          id: 'referrer-top',
          type: 'bar',
          title: `Referrer ที่สร้าง Revenue สูงสุด ${TOP_N} อันดับ (บาท)`,
          labels: ranked.map((record) => String(record.Referrer ?? '—')),
          datasets: [{ label: 'Revenue (บาท)', unit: THB, data: ranked.map((r) => num(r.R_THB)) }],
          horizontal: true,
        },
      ];
      const tables = [
        { title: `Top ${TOP_N} Referrer by Revenue`, columns: referrerColumns, rows: ranked.map(referrerRow) },
        {
          title: 'Referrer ที่ downline ฝากจริงต่ำ (Downline ≥ 5, ฝากจริง < 20%)',
          columns: referrerColumns,
          rows: lowQuality.map(referrerRow),
          note: 'ชวนมาเยอะแต่แทบไม่มีใครฝากจริง เข้าข่าย referral abuse — ตรวจต่อใน fraud-anomaly-detection',
        },
      ];

      const insights = [
        `Conversion เฉลี่ยของ downline (ฝากจริง / ถูกชวนมา) อยู่ที่ ${fmtPct(conversion)}`,
        `มี ${unprofitable.length} referrer ที่จ่าย Ref Bonus แพงกว่า Revenue ที่ downline สร้างได้`,
      ];

      if (adChannels.length > 0) {
        charts.push({
          id: 'referrer-ad-agent',
          type: 'bar',
          title: `ช่องทางโฆษณา / Agent — Top ${TOP_N} by Revenue (บาท)`,
          labels: adChannels.map((record) => String(record['AD / Agent'] ?? record.Agent ?? '—')),
          datasets: [{ label: 'Revenue (บาท)', unit: THB, data: adChannels.map((r) => num(r.R_THB)) }],
          horizontal: true,
        });
        tables.push({
          title: 'ช่องทางโฆษณา / Agent',
          columns: [
            { key: 'channel', label: 'ช่องทาง', unit: TEXT },
            { key: 'Total Mems', label: 'สมาชิก', unit: COUNT },
            { key: 'BIn_THB', label: 'ยอดฝากรวม', unit: THB },
            { key: 'Pro_THB', label: 'Promotion', unit: THB },
            { key: 'R_THB', label: 'Revenue', unit: THB },
          ],
          rows: adChannels.map((record) => ({
            channel: record['AD / Agent'] ?? record.Agent ?? '—',
            'Total Mems': num(record['Total Mems']),
            BIn_THB: num(record.BIn_THB),
            Pro_THB: num(record.Pro_THB),
            R_THB: num(record.R_THB),
          })),
        });
        insights.push(
          `ช่องทาง ${adChannels[0]['AD / Agent'] ?? adChannels[0].Agent} สร้าง Revenue สูงสุด — ` +
            'ใช้เทียบ (Pro + Bonus) / R เพื่อดูต้นทุนต่อช่องทาง',
        );
      } else {
        insights.push(
          'ยังไม่ได้อัปโหลดไฟล์ AD / Agent ของเดือนนี้ — อัปโหลดแล้วหน้านี้จะเทียบช่องทางโฆษณาให้ด้วย',
        );
      }

      return {
        alerts: [],
        kpis: [
          kpi('Referrer ทั้งหมด', records.length, COUNT),
          kpi('Downline ที่ถูกชวนมา', totalMems, COUNT),
          kpi('Downline ที่ฝากเงินจริง', totalBinMems, COUNT, { note: `${fmtPct(conversion)} conversion` }),
          kpi('Ref Bonus ที่จ่ายรวม', sum(records, 'Ref Bonus_THB'), THB),
          kpi('Revenue จาก downline รวม', sum(records, 'R_THB'), THB),
          kpi('Referrer ที่จ่ายแพงกว่าที่ได้', unprofitable.length, COUNT, {
            note: 'Ref Bonus สูงกว่า Revenue ที่ downline สร้าง',
            status: statusAtMost(unprofitable.length, 0, Math.max(1, Math.round(records.length * 0.2))),
          }),
          kpi('Referrer คุณภาพต่ำ', lowQuality.length, COUNT, {
            note: 'Downline ≥ 5 แต่ฝากจริง < 20%',
          }),
        ],
        charts,
        tables,
        insights,
      };
    },
  },
  {
    id: 'hours',
    title: '⏰ ช่วงเวลาพีค',
    fileType: 'avg_bin_by_hour',
    also: ['avg_bin_mems_by_hour'],
    build(entries, extra) {
      const records = entries.map((entry) => entry.record);

      // avg-bin-by-hour.md's third question: "เงินเยอะเพราะคนเยอะ หรือเพราะ
      // ฝากหนัก" — only answerable with both grids side by side, so the head
      // count is looked up per (weekday, hour) when its file is there.
      const memsByCell = new Map();
      for (const entry of extra.get('avg_bin_mems_by_hour') ?? []) {
        const key = `${entry.record.weekday} ${num(entry.record.hour)}`;
        memsByCell.set(key, num(entry.record.avg_mems));
      }
      const memsFor = (record) =>
        memsByCell.get(`${record.weekday} ${num(record.hour)}`) ?? null;
      const hasMems = memsByCell.size > 0;

      // The grid is 7 weekdays × 24 hours. Averaging down to one line per hour
      // is what answers "ช่วงไหนเงินเข้าเยอะ"; the weekday detail stays in the
      // tables below, where the peak slot can be read off by name.
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
        .map(([hour, found]) => ({ hour, avg: found.reduce((t, n) => t + n, 0) / found.length }));

      const peak = topBy(records, 'avg_bin_THB', 5);
      const quiet = bottomBy(records, 'avg_bin_THB', 5);
      const busiest = hours.length ? [...hours].sort((a, b) => b.avg - a.avg)[0] : null;
      const quietest = hours.length ? [...hours].sort((a, b) => a.avg - b.avg)[0] : null;

      const slotColumns = [
        { key: 'weekday', label: 'วัน', unit: TEXT },
        { key: 'hour', label: 'ชั่วโมง', unit: TEXT },
        { key: 'avg_bin_THB', label: 'BIn เฉลี่ย', unit: THB },
        ...(hasMems ? [{ key: 'avg_mems', label: 'คนเฉลี่ย', unit: NUMBER }] : []),
      ];
      const slotRow = (record) => ({
        weekday: record.weekday ?? '—',
        hour: `${num(record.hour)}:00`,
        avg_bin_THB: num(record.avg_bin_THB),
        ...(hasMems ? { avg_mems: memsFor(record) } : {}),
      });

      const insights = [];
      if (peak[0]) {
        insights.push(
          `ช่วงพีคสุดคือ ${peak[0].weekday} เวลา ${num(peak[0].hour)}:00 น. — ` +
            'เหมาะสำหรับเพิ่มงบโปรโมชั่น/โบนัสในช่วงนี้ ' +
            '(ธุรกิจนี้ยิงโฆษณา 24 ชม. อยู่แล้ว ไม่ต้องปรับเวลายิงแอด)',
        );
      }
      if (quiet[0]) {
        insights.push(
          `ช่วงเงียบสุดคือ ${quiet[0].weekday} เวลา ${num(quiet[0].hour)}:00 น. — ` +
            'เหมาะสำหรับ maintenance หรือทดสอบระบบ',
        );
      }
      if (hasMems && peak[0]) {
        const peakMems = memsFor(peak[0]);
        const avgMems = [...memsByCell.values()].filter((n) => n !== null);
        const overallMems = avgMems.length ? avgMems.reduce((t, n) => t + n, 0) / avgMems.length : null;
        if (peakMems !== null && overallMems) {
          insights.push(
            peakMems >= overallMems * 1.5
              ? 'ช่วงพีคมีทั้งเงินและคนสูงพร้อมกัน — เป็นช่วงที่คนเข้ามาเยอะจริง ไม่ใช่รายใหญ่คนเดียวดันยอด'
              : 'ช่วงพีคมีเงินสูงแต่จำนวนคนไม่ได้สูงตาม — น่าจะมาจากลูกค้ารายใหญ่ไม่กี่คน ควรดูควบคู่กับหน้า VIP',
          );
        }
      } else {
        insights.push(
          'ยังไม่ได้อัปโหลดไฟล์ Average BIn Mems (Week Day × Hour) — ' +
            'อัปโหลดแล้วจะบอกได้ว่าช่วงพีคเงินเยอะเพราะคนเยอะ หรือเพราะมีรายใหญ่ฝากหนัก',
        );
      }

      return {
        alerts: [],
        kpis: [
          kpi('ชั่วโมงที่เงินเข้าสูงสุด', busiest ? `${busiest.hour}:00` : null, TEXT, {
            note: busiest ? `เฉลี่ยทุกวันในสัปดาห์ ${fmtThb(busiest.avg)}` : undefined,
          }),
          kpi('ชั่วโมงที่เงียบที่สุด', quietest ? `${quietest.hour}:00` : null, TEXT, {
            note: quietest ? `เฉลี่ยทุกวันในสัปดาห์ ${fmtThb(quietest.avg)}` : undefined,
          }),
          kpi('ช่องเวลาที่มีข้อมูล', records.length, COUNT, { note: 'ครบทั้งตารางคือ 7 × 24 = 168 ช่อง' }),
        ],
        charts: [
          {
            id: 'hours-avg',
            type: 'line',
            title: 'BIn เฉลี่ยตามชั่วโมง (รวมทุกวันในสัปดาห์, บาท)',
            labels: hours.map((entry) => `${entry.hour}:00`),
            datasets: [{ label: 'BIn เฉลี่ย (บาท)', unit: THB, data: hours.map((e) => e.avg) }],
          },
        ],
        tables: [
          { title: '🔥 Top 5 ช่วงพีค (BIn เฉลี่ยสูงสุด)', columns: slotColumns, rows: peak.map(slotRow) },
          {
            title: '🌙 Top 5 ช่วงเงียบ (BIn เฉลี่ยต่ำสุด)',
            columns: slotColumns,
            rows: quiet.map(slotRow),
            note: 'ธุรกิจยิงโฆษณา 24 ชม. อยู่แล้ว — ใช้ช่วงพีคเพื่อเพิ่มงบโปร/โบนัส ไม่ใช่เพื่อย้ายเวลายิงแอด',
          },
        ],
        insights,
      };
    },
  },
  {
    id: 'deposit_detail',
    title: '💳 ช่องทางฝากเงิน',
    fileType: 'deposit_detail',
    build(entries, _extra, { shared }) {
      const records = entries.map((entry) => entry.record);

      // Stored rows are one per (day × PayName); the channel view rolls the
      // days back up so a gateway problem shows as one line, not thirty.
      const channels = new Map();
      for (const record of records) {
        const name = String(record.PayName ?? '').trim() || '(ไม่ระบุ/ฝากมือ)';
        if (!channels.has(name)) channels.set(name, { name, total: 0, success: 0, durations: [] });
        const bucket = channels.get(name);
        bucket.total += num(record.total_count) ?? 0;
        bucket.success += num(record.success_count) ?? 0;
        const duration = num(record.avg_duration_min);
        if (duration !== null) bucket.durations.push(duration);
      }

      const rows = [...channels.values()]
        .map((bucket) => {
          // Counts over counts.
          const rate = bucket.total ? (bucket.success / bucket.total) * 100 : null;
          return {
            PayName: bucket.name,
            total_count: bucket.total,
            success_count: bucket.success,
            success_rate: rate,
            avg_duration_min: bucket.durations.length
              ? bucket.durations.reduce((total, n) => total + n, 0) / bucket.durations.length
              : null,
            _status: {
              success_rate: statusAtLeast(rate, shared.depositSuccessPct.good, shared.depositSuccessPct.warn),
            },
          };
        })
        .sort((a, b) => b.total_count - a.total_count);

      const totalCount = rows.reduce((total, row) => total + row.total_count, 0);
      const totalSuccess = rows.reduce((total, row) => total + row.success_count, 0);
      const overallRate = totalCount ? (totalSuccess / totalCount) * 100 : null;
      const overallDuration = mean(records, 'avg_duration_min');
      const worst = [...rows].filter((row) => row.success_rate !== null).sort((a, b) => a.success_rate - b.success_rate)[0];
      const top = rows.slice(0, 12);

      const alerts = [];
      if (worst && worst.success_rate < shared.depositSuccessPct.warn) {
        alerts.push(
          alert(
            'bad',
            `🚨 ช่องทาง ${worst.PayName} มีอัตราสำเร็จเพียง ${fmtPct(worst.success_rate)} ` +
              `(ต่ำกว่าเกณฑ์ ${shared.depositSuccessPct.warn}%) — ควรตรวจ payment gateway`,
          ),
        );
      }

      const insights = [
        `อัตราสำเร็จรวม ${fmtPct(overallRate, 2)} ` +
          `${(overallRate ?? 0) >= shared.depositSuccessPct.good ? 'อยู่ในเกณฑ์ดี' : 'ต่ำกว่าเกณฑ์ปกติ ควรตรวจช่องทางที่ success rate ต่ำ'}`,
        `เวลายืนยันเฉลี่ย ${overallDuration === null ? 'ไม่มีข้อมูล' : `${overallDuration.toFixed(2)} นาที`} — ` +
          'ถ้าค่อย ๆ สูงขึ้นควรเช็ค เพราะกระทบ conversion โดยตรง',
      ];
      if (rows[0]) {
        insights.push(
          `ช่องทางหลักคือ ${rows[0].PayName} (${fmtInt(rows[0].total_count)} รายการ) — ` +
            'ถ้าช่องทางนี้มีปัญหา ยอดฝากรวมทั้งเว็บจะกระทบทันที',
        );
      }

      return {
        alerts,
        kpis: [
          kpi('รายการฝากทั้งหมด', totalCount || null, COUNT),
          kpi('สำเร็จ', totalSuccess || null, COUNT),
          kpi('อัตราสำเร็จรวม', overallRate, PCT, {
            note: `เกณฑ์ดี ≥ ${shared.depositSuccessPct.good}%`,
            status: statusAtLeast(overallRate, shared.depositSuccessPct.good, shared.depositSuccessPct.warn),
          }),
          kpi('เวลายืนยันเฉลี่ย', overallDuration, MINUTES, { note: 'เฉพาะรายการที่สำเร็จ' }),
          kpi('ช่องทางที่ใช้งาน', rows.length, COUNT),
        ],
        charts: [
          {
            id: 'deposit-detail-volume',
            type: 'bar',
            title: 'จำนวนรายการต่อช่องทาง',
            labels: top.map((row) => row.PayName),
            datasets: [
              { label: 'รายการทั้งหมด', unit: COUNT, data: top.map((r) => r.total_count) },
              { label: 'สำเร็จ', unit: COUNT, data: top.map((r) => r.success_count) },
            ],
            horizontal: true,
          },
          {
            id: 'deposit-detail-success',
            type: 'bar',
            title: 'อัตราสำเร็จ (%) ต่อช่องทาง',
            labels: top.map((row) => row.PayName),
            datasets: [
              {
                label: 'Success %',
                unit: PCT,
                data: top.map((row) => row.success_rate),
                colorByThreshold: { good: shared.depositSuccessPct.good, warn: shared.depositSuccessPct.warn },
              },
            ],
            horizontal: true,
            maxValue: 100,
          },
        ],
        tables: [
          {
            title: 'รายละเอียดตามช่องทางจ่ายเงิน',
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
        insights,
      };
    },
  },
  {
    id: 'bonus',
    title: '🎁 Bonus / Points',
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

      const totalPoints = rows.reduce((total, row) => total + row.total_points, 0);
      const totalTxn = rows.reduce((total, row) => total + row.transaction_count, 0);
      const series = dailySeries(entries, [
        { column: 'total_points', label: 'point ที่จ่าย', unit: NUMBER },
      ]);

      const insights = [
        `ต้นทุน Point รวม ${fmtInt(totalPoints)} จาก ${fmtInt(totalTxn)} ธุรกรรม — ` +
          'Cashback/Loyalty ผูกกับ Turnover เป็นต้นทุนตามสัดส่วน ควรดูคู่กับ CIn ในหน้าการเงิน',
      ];
      if (rows[0]) {
        insights.push(
          `ประเภท ${rows[0].Type} กินงบสูงสุด (${fmtInt(rows[0].total_points)} point) — ` +
            'ถ้าเป็น Referrer Reward Point ที่โตเร็วผิดปกติ ควรเช็คร่วมกับหน้า Referrer ว่าเป็น referral abuse หรือไม่',
        );
      }
      insights.push(
        'Point ไม่ใช่จำนวนเงินบาท จึงไม่มีคอลัมน์ _THB คู่กัน — ตัวเลขในหน้านี้เป็นหน่วย point ตามไฟล์',
      );

      return {
        alerts: [],
        kpis: [
          kpi('Point รวมที่จ่าย', totalPoints || null, NUMBER),
          kpi('จำนวนธุรกรรม', totalTxn || null, COUNT),
          kpi('ประเภท point ที่จ่าย', rows.length, COUNT),
          kpi('ประเภทที่กินงบสูงสุด', rows[0]?.Type ?? null, TEXT, {
            note: rows[0] ? `${fmtInt(rows[0].total_points)} point` : undefined,
          }),
        ],
        charts: [
          {
            id: 'bonus-types',
            type: 'doughnut',
            title: 'Point แยกตามประเภท',
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
            title: 'รายละเอียดตามประเภท',
            columns: [
              { key: 'Type', label: 'ประเภท', unit: TEXT },
              { key: 'total_points', label: 'Point รวม', unit: NUMBER },
              { key: 'transaction_count', label: 'จำนวนครั้ง', unit: COUNT },
              { key: 'avg_points', label: 'เฉลี่ย/ครั้ง', unit: NUMBER },
            ],
            rows,
            note: 'Point ไม่ใช่จำนวนเงินบาท จึงไม่มีคอลัมน์ _THB คู่กัน',
          },
        ],
        insights,
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
 * This site's benchmarks, or a set of nulls.
 *
 * Nulls rather than a fallback to another site's figures: SKILL.md forbids
 * mixing them, and a KPI compared against the wrong site's normal range is
 * worse than one compared against nothing — it reads as a verdict.
 */
function benchmarksFor(site) {
  const own = BENCHMARKS.sites[site];
  if (!own) {
    logger.warn('no benchmarks configured for site — KPIs will show none', { site });
    return { site };
  }
  return { site, ...own };
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

  // Every file any section wants, loaded once. Several sections read
  // daily_value and the Overview reads three files, so loading per section
  // would parse the same workbook repeatedly.
  const wanted = new Set();
  for (const section of SECTIONS) {
    wanted.add(section.fileType);
    for (const extra of section.also ?? []) wanted.add(extra);
  }

  const loaded = new Map();
  for (const fileType of wanted) {
    if (!uploaded.has(fileType)) continue;
    const entries = await loadRows({ site, yearMonth, fileType, onProgress });
    if (entries) loaded.set(fileType, entries);
  }

  const ctx = { site, yearMonth, bench: benchmarksFor(site), shared: BENCHMARKS.shared };
  const sections = [];
  const missing = [];

  const noteMissing = (fileType, label) => {
    if (!missing.some((entry) => entry.fileType === fileType)) missing.push({ fileType, label });
  };

  for (const section of SECTIONS) {
    const label = getFileType(section.fileType)?.label ?? section.fileType;
    const base = { id: section.id, title: section.title, fileType: section.fileType, fileLabel: label };

    if (!uploaded.has(section.fileType)) {
      noteMissing(section.fileType, label);
      sections.push({ ...base, available: false, reason: 'ยังไม่ได้อัปโหลดไฟล์นี้สำหรับเดือนนี้' });
      continue;
    }

    const entries = loaded.get(section.fileType);
    if (!entries) {
      sections.push({ ...base, available: false, reason: 'มีไฟล์อยู่ในระบบ แต่อ่านข้อมูลจากไฟล์ไม่ได้' });
      continue;
    }

    // Optional companions: present ones enrich the section, absent ones are
    // listed as worth uploading but never block the tab.
    const extra = new Map();
    for (const fileType of section.also ?? []) {
      if (loaded.has(fileType)) extra.set(fileType, loaded.get(fileType));
      else noteMissing(fileType, getFileType(fileType)?.label ?? fileType);
    }

    try {
      const built = section.build(entries, extra, ctx);
      sections.push({
        ...base,
        available: true,
        rowCount: entries.length,
        alerts: built.alerts ?? [],
        kpis: built.kpis ?? [],
        charts: built.charts ?? [],
        tables: built.tables ?? [],
        insights: built.insights ?? [],
      });
    } catch (err) {
      // One section's shape surprising it must not cost the other ten.
      logger.error('monthly section failed to build', {
        site,
        yearMonth,
        section: section.id,
        message: err?.message,
        stack: err?.stack?.split('\n').slice(0, 3).join(' | '),
      });
      sections.push({ ...base, available: false, reason: 'สร้างส่วนนี้ไม่สำเร็จ' });
    }
  }

  logger.info('built monthly payload', {
    site,
    yearMonth,
    sections: sections.length,
    available: sections.filter((section) => section.available).length,
    files: loaded.size,
  });

  return {
    kind: 'monthly',
    generatedAt: new Date().toISOString(),
    site,
    siteName: siteDisplayName(site),
    yearMonth,
    currency: currencyOf(site),
    fileCount: loaded.size,
    missingFiles: missing,
    sections,
  };
}
