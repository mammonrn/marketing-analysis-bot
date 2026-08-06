/**
 * Question → data context (replaces the old Sheets-backed `buildDataContext`).
 * `pickFileType` is `pickTabKey`'s routing logic carried over under the new
 * `file_type` names; `buildDataContext` looks at the last 3 calendar months
 * (spec §3B's own comparison scope) for whichever raw files exist, parses
 * any that haven't been yet, and formats the rows for `claude/client.js`.
 */

import { getFileType, FILE_TYPES } from './fileTypes.js';
import { siteDisplayName } from './sites.js';
import { normaliseRow, deriveMetrics } from './transform.js';
import { ensureParsed } from './parse.js';
import { findRawFile, queryParsedRows, listRawFiles } from './db.js';
import { logger } from '../logger.js';

const ROUTES = [
  { fileType: 'vip', patterns: [/\bvip\b/i, /big bettor/i, /high.?roller/i, /ลูกค้าใหญ่/, /ลูกค้า vip/i] },
  {
    fileType: 'new_member_quality',
    patterns: [/สมาชิกใหม่/, /1st new/i, /1st day/i, /delayed deposit/i, /\bverify/i, /ยืนยันตัวตน/],
  },
  {
    fileType: 'deposit_count_distribution',
    patterns: [/power user/i, /casual/i, /21\+/, /จำนวนครั้ง.*ฝาก/, /ความถี่.*ฝาก/, /deposit count/i],
  },
  {
    fileType: 'brand_game_value',
    patterns: [/สล็อต/, /brand value/i, /fish shooting/i, /ยิงปลา/, /gamekind/i, /ประเภทเกม/],
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

function formatContext({ site, fileType, availableMonths, rows }) {
  const type = getFileType(fileType);
  const lines = rows.map((r) => {
    const enriched = { ...normaliseRow(r.row, site), ...deriveMetrics(r.row) };
    const meta = r.row_date ? `${r.year_month} ${r.row_date}` : r.year_month;
    return `[${meta}] ${JSON.stringify(enriched)}`;
  });

  return (
    `ประเภทไฟล์: ${type?.label ?? fileType} (${fileType})\n` +
    `เว็บ: ${siteDisplayName(site)}\n` +
    `เดือนที่มีข้อมูล: ${availableMonths.join(', ')}\n` +
    `จำนวนแถว: ${rows.length}\n\n` +
    `${lines.join('\n')}`
  );
}

/**
 * Returns the formatted data block for a question, or `null` when nothing is
 * uploaded yet for that site/file-type — the caller (spec §6/§3B layer 2)
 * turns `null` into "ยังไม่มีข้อมูลนี้ ขอให้ upload เพิ่ม" rather than guessing.
 */
export async function buildDataContext(site, question, { monthsBack = 3, onProgress } = {}) {
  const fileType = pickFileType(question);
  const candidateMonths = lastNYearMonths(monthsBack);
  const availableMonths = candidateMonths.filter((ym) => findRawFile({ site, yearMonth: ym, fileType }));

  if (availableMonths.length === 0) return null;

  for (const yearMonth of availableMonths) {
    try {
      // The first question after a big upload is the one that pays for
      // parsing it, so progress has to reach the asker here too.
      await ensureParsed({
        site,
        yearMonth,
        fileType,
        onProgress: onProgress
          ? (update) => onProgress({ ...update, label: getFileType(fileType)?.label ?? fileType })
          : undefined,
      });
    } catch (err) {
      logger.error('failed to parse raw file on demand', { site, yearMonth, fileType, message: err?.message });
    }
  }

  const rows = queryParsedRows({ site, fileType, yearMonths: availableMonths });
  if (rows.length === 0) return null;

  return formatContext({ site, fileType, availableMonths, rows });
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
