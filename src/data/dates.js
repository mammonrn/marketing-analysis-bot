/**
 * Date coercion shared by the parse and aggregate paths.
 *
 * Lives apart from `parse.js` only to keep the module graph acyclic:
 * `parse.js` needs `fileTypes.js` (for the type descriptor), `fileTypes.js`
 * needs `aggregate.js` (for the daily-summary functions), and `aggregate.js`
 * needs these two helpers. `parse.js` re-exports both, so existing callers
 * that import them from there keep working.
 */

import XLSX from 'xlsx';

/** `YYYY-MM-DD` for anything that looks like a date, otherwise null. */
export function normaliseDate(value) {
  if (value === null || value === undefined || value === '') return null;

  // Fallback for date cells that came through as a raw Excel serial number
  // instead of a JS Date (see the note at the top of parse.js) — decode with
  // SheetJS's own date-serial math rather than guessing. Range chosen to
  // safely bracket plausible spreadsheet dates (~1954-2119) without colliding
  // with small numeric business values (durations, points, counts, etc.) that
  // might end up in a mis-mapped date column.
  //
  // A number is either a serial in that band or not a date at all: falling
  // through to `new Date(String(n))` would read a bare number as a year
  // (100 -> "0100-01-01", 19999 -> "+019999-01"), so bail out instead.
  if (typeof value === 'number') {
    if (value <= 20000 || value >= 80000) return null;
    const dc = XLSX.SSF.parse_date_code(value);
    if (!dc) return null;
    const d = new Date(Date.UTC(dc.y, dc.m - 1, dc.d));
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }

  const s = String(value);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

export function yearMonthOf(dateStr) {
  return dateStr ? dateStr.slice(0, 7) : null;
}
