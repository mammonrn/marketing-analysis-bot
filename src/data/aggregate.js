/**
 * Daily summaries for the transaction-log exports.
 *
 * `Detail (Last 6 Months).xlsx` and `bonus.xlsx` are per-transaction logs —
 * six figures of rows for a six-month window. Storing them row-for-row would
 * bury every useful question under detail nobody asks for, so what reaches
 * `parsed_rows` is one row per (day × category) with the counts and averages
 * the skill actually reports on. The raw workbook is still kept on disk under
 * the ordinary retention window, so a re-aggregation is always possible.
 *
 * Output rows are plain column-name-keyed objects like every other file
 * type's, so `db.js`, `query.js` and `transform.js` need no changes.
 */

import { normaliseDate } from './dates.js';
import { toNumber } from './transform.js';
import { getSite, siteDisplayName } from './sites.js';

// Often enough to keep a progress message moving on a 150k-row file, rare
// enough that the reporting itself costs nothing.
const PROGRESS_EVERY = 20000;

/** Rows whose date cannot be read at all are dropped rather than bucketed under null. */
function groupByDayAnd(rows, dateColumn, categoryColumn, onProgress) {
  const groups = new Map();
  for (let i = 0; i < rows.length; i += 1) {
    if (onProgress && i > 0 && i % PROGRESS_EVERY === 0) onProgress(i, rows.length);
    const row = rows[i];
    const date = normaliseDate(row[dateColumn]);
    if (!date) continue;
    const category = row[categoryColumn] ?? '';
    // \u0000 cannot occur in a date or a PayName/Type cell, so it joins the
    // two parts without any chance of two different pairs colliding.
    const key = `${date}\u0000${category}`;
    let bucket = groups.get(key);
    if (!bucket) {
      bucket = { date, category, rows: [] };
      groups.set(key, bucket);
    }
    bucket.rows.push(row);
  }
  return [...groups.values()].sort(
    (a, b) => a.date.localeCompare(b.date) || String(a.category).localeCompare(String(b.category)),
  );
}

/**
 * Status values are compared case-insensitively: the export has been seen
 * writing both `success` and `Success`, and an exact match would silently
 * score every row as a failure rather than erroring.
 */
function isSuccess(value) {
  return String(value ?? '').trim().toLowerCase() === 'success';
}

function mean(values) {
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/**
 * `Detail (Last 6 Months).xlsx` → one row per (day × PayName):
 * how many deposits went through that channel, how many succeeded, and how
 * long the successful ones took.
 */
export function aggregateDepositDetail(rows, { onProgress } = {}) {
  return groupByDayAnd(rows, 'AddTime', 'PayName', onProgress).map(({ date, category, rows: group }) => {
    const successRows = group.filter((row) => isSuccess(row.Status));
    // Only successful deposits have a meaningful duration — a failed one
    // stops the clock wherever it gave up, which would drag the average down
    // for reasons that have nothing to do with how fast the channel is.
    const durations = successRows
      .map((row) => toNumber(row['Duration (m)']))
      .filter((n) => Number.isFinite(n));
    const avgDuration = mean(durations);

    return {
      Date: date,
      PayName: category,
      total_count: group.length,
      success_count: successRows.length,
      success_rate: group.length > 0 ? successRows.length / group.length : null,
      // Left out entirely rather than reported as NaN when nothing succeeded,
      // matching how `deriveMetrics` omits what it cannot compute.
      ...(avgDuration === null ? {} : { avg_duration_min: avgDuration }),
    };
  });
}

/**
 * Resolves the factor that turns a raw `Points` cell into baht, or explains
 * why it cannot.
 *
 * The point logs are the one export where the raw cell is not on the same
 * scale as the money columns: SH666 writes `Points` scaled by 100,000, so a
 * raw `1.200` is 120,000 MMK. Summing the raw column and calling the result
 * an amount — which is what this function exists to stop — is how "Loyalty
 * Point รวม 278.8" came to be reported for a figure that was really tens of
 * millions of kyat.
 *
 * A site with no `pointsScaleFactor` throws rather than borrowing SH666's.
 * The scale has only ever been checked against SH666's own file; whether
 * U89/88F share it is unknown, and a wrong factor here is invisible in a way
 * a missing file is not — the numbers still look like numbers. This is the
 * same failure the fused `moneyFactor` produced (see `sites.js`), and the
 * only defence that works is refusing to produce a figure at all.
 */
function requirePointsFactor(siteInput) {
  const site = getSite(siteInput);
  if (!site) {
    throw new Error(
      `aggregateBonusLog: ต้องระบุเว็บ (site) ก่อนจึงจะแปลง Points เป็นเงินได้ — ได้รับ: ${siteInput ?? 'ไม่มี'}`,
    );
  }
  if (site.pointsFactor === null) {
    throw new Error(
      `ยังไม่ได้ตั้งค่า pointsScaleFactor สำหรับเว็บนี้ (${siteDisplayName(site.canonical)}) — ` +
        'ไฟล์ point log (bonus / reward point / other transfer) ของเว็บนี้จึงยังแปลงเป็นเงินไม่ได้ ' +
        'ต้องยืนยันสเกลของคอลัมน์ Points กับไฟล์จริงก่อน แล้วเพิ่ม pointsScaleFactor ใน ' +
        'config/site-aliases.json (ห้ามยืมค่าของเว็บอื่นมาใช้)',
    );
  }
  return site;
}

/**
 * `bonus.xlsx` → one row per (day × Type): how many point transactions of
 * that kind happened, how many raw points they moved, and what that is worth
 * in baht.
 *
 * Both columns are kept on purpose. `total_points` is the raw sum, which is
 * the only figure that can be checked against Power BI; `total_points_THB` is
 * the one to quote. The `_THB` spelling is not cosmetic — `query.js` pairs a
 * `X_THB` column with its raw `X` and labels the units, so a lower-case
 * suffix would reach the model as an unexplained third number.
 *
 * KNOWN LIMITATION: unlike every other `_THB` column, this one is computed at
 * parse time and stored, so it freezes the rate in force when the file was
 * first parsed. A later `/fxrate` change does not reach rows already in
 * `parsed_rows`; those need a re-parse. It is computed here anyway because
 * this is also the only point in the pipeline that sees the file arrive, and
 * so the only place the missing-scale refusal above can fire before a wrong
 * number is stored.
 */
export function aggregateBonusLog(rows, { site: siteInput, onProgress } = {}) {
  const site = requirePointsFactor(siteInput);

  return groupByDayAnd(rows, 'AddTime', 'Type', onProgress).map(({ date, category, rows: group }) => {
    const points = group.map((row) => toNumber(row.Points)).filter((n) => Number.isFinite(n));
    const totalPoints = points.reduce((sum, n) => sum + n, 0);

    return {
      Date: date,
      Type: category,
      total_points: totalPoints,
      total_points_THB: totalPoints * site.pointsFactor,
      transaction_count: group.length,
    };
  });
}
