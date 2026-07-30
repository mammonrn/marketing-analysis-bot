/**
 * Raw-file retention (spec §3B): "เก็บไฟล์ดิบสูงสุด 6 เดือนย้อนหลัง ... ลบไฟล์ดิบ
 * ... ออกจาก DATA/ และลบ record ใน raw_files ตาม (ตารางข้อมูล parsed แล้วเก็บไว้ต่อได้)".
 * Deletes the physical file + its `raw_files` row once it's older than the
 * retention window; `parsed_rows` is left alone on purpose (see `db.js`).
 *
 * Runs from a daily check in `index.js` (same lightweight-cron style as the
 * session store's `pruneOldData`) rather than a real cron job, since the spec
 * only asks for "after midnight on the 1st" — a monthly no-op skip is cheap
 * and avoids adding a scheduling dependency.
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { ROOT } from '../paths.js';
import { logger } from '../logger.js';
import { rawFilesOlderThan, deleteRawFile } from './db.js';

export function pruneRawFiles(months = config.data.retentionMonths) {
  const now = new Date();
  const cutoff = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - months, now.getUTCDate());

  const stale = rawFilesOlderThan(cutoff);
  for (const row of stale) {
    fs.rmSync(path.join(ROOT, row.path), { force: true });
    deleteRawFile(row.id);
  }

  if (stale.length > 0) {
    logger.info('pruned raw files past retention', { count: stale.length, months });
  }
  return stale.length;
}

/** Only acts on the 1st of the month, per spec §3B — safe to call on any interval. */
export function runMonthlyRetentionIfDue(now = new Date()) {
  if (now.getDate() !== 1) return 0;
  return pruneRawFiles();
}
