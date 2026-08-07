#!/usr/bin/env node
/**
 * Report any stored row whose `site` is not a canonical site key.
 *
 * READ ONLY. This script never writes, updates or deletes anything — it prints
 * what it found and the SQL that would fix it, and stops there. Deciding
 * whether to run that SQL is a judgement about live data, and belongs to
 * whoever owns it.
 *
 * Why it exists: every reader (`findRawFile`, `queryParsedRows`,
 * `latestDataDate`) looks a site up by its canonical key, so a row stored
 * under anything else — "SH666" instead of "shwe666" — is invisible rather
 * than wrong. Nothing errors; the file simply reads as never uploaded. That
 * failure mode is quiet enough to be worth a standing check even now that
 * `ingest.js` refuses to create one.
 *
 * Usage:  node scripts/check-site-keys.mjs [path/to/sessions.sqlite]
 * Exit:   0 = every row canonical, 1 = something needs a decision.
 */

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { ROOT } from '../src/paths.js';
import { ALL_SITE_KEYS, normalizeSiteName, siteDisplayName } from '../src/data/sites.js';

const sqlitePath = path.resolve(
  ROOT,
  process.argv[2] ?? process.env.SQLITE_PATH ?? './data/sessions.sqlite',
);

if (!fs.existsSync(sqlitePath)) {
  console.error(`ไม่พบไฟล์ฐานข้อมูล: ${sqlitePath}`);
  console.error('ระบุ path มาเองได้: node scripts/check-site-keys.mjs path/to/sessions.sqlite');
  process.exit(1);
}

const db = new Database(sqlitePath, { readonly: true });

// Every table that stores a site key. `sessions`/`turns` are included because
// a stale site there makes follow-up questions resolve to nothing too.
const TABLES = [
  { table: 'raw_files', extra: 'year_month, file_type' },
  { table: 'parsed_rows', extra: 'year_month, file_type' },
  { table: 'pending_duplicates', extra: 'year_month, file_type' },
  { table: 'fx_rate_overrides', extra: 'fx_rate' },
  { table: 'fx_rate_alerts', extra: null },
  { table: 'pending_fx_updates', extra: 'fx_rate' },
  { table: 'sessions', extra: 'chat_id' },
  { table: 'turns', extra: 'chat_id' },
];

function tableExists(name) {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name),
  );
}

console.log(`ฐานข้อมูล: ${sqlitePath}`);
console.log(`คีย์ที่ถูกต้อง: ${ALL_SITE_KEYS.join(', ')}`);
console.log(`(ชื่อที่ผู้ใช้เห็น: ${ALL_SITE_KEYS.map(siteDisplayName).join(', ')})\n`);

const problems = [];

for (const { table, extra } of TABLES) {
  if (!tableExists(table)) continue;

  const columns = ['site', 'COUNT(*) AS rows'];
  const rows = db
    .prepare(`SELECT ${columns.join(', ')} FROM ${table} WHERE site IS NOT NULL GROUP BY site`)
    .all();

  for (const row of rows) {
    if (ALL_SITE_KEYS.includes(row.site)) continue;

    // An alias ("SH666") can be repaired mechanically. Anything that resolves
    // to nothing at all cannot, and needs a human to say what it meant.
    const canonical = normalizeSiteName(row.site);
    problems.push({ table, extra, stored: row.site, rows: row.rows, canonical });
  }
}

if (problems.length === 0) {
  console.log('✅ ทุกแถวใช้คีย์ canonical ถูกต้อง ไม่มีอะไรต้องแก้');
  db.close();
  process.exit(0);
}

console.log(`⚠️  พบ ${problems.length} กลุ่มที่คีย์ไม่ใช่ canonical:\n`);

for (const p of problems) {
  console.log(`  ${p.table}: site = ${JSON.stringify(p.stored)} — ${p.rows} แถว`);
  if (p.canonical) {
    console.log(`    → ควรเป็น ${JSON.stringify(p.canonical)} (เป็น alias ของเว็บนี้)`);
  } else {
    console.log('    → แปลงเป็นเว็บไหนไม่ได้ ต้องให้คนตัดสินใจว่าหมายถึงอะไร');
  }
}

const repairable = problems.filter((p) => p.canonical);

if (repairable.length > 0) {
  console.log('\n--- SQL ที่จะแก้ให้ถูก (ยังไม่ได้รัน — ตรวจก่อนแล้วค่อยรันเอง) ---');
  console.log('-- สำรองไฟล์ฐานข้อมูลก่อนเสมอ:  cp sessions.sqlite sessions.sqlite.bak');
  console.log('BEGIN;');
  for (const p of repairable) {
    console.log(
      `UPDATE ${p.table} SET site = '${p.canonical}' WHERE site = '${p.stored}';` +
        `  -- ${p.rows} แถว`,
    );
  }
  console.log('COMMIT;');

  // raw_files has UNIQUE(site, year_month, file_type): if both the alias row
  // and a canonical row exist for the same month and type, the UPDATE hits
  // that constraint. Saying so here is cheaper than discovering it mid-run.
  if (repairable.some((p) => p.table === 'raw_files' || p.table === 'parsed_rows')) {
    console.log(
      '\nหมายเหตุ: raw_files มี UNIQUE (site, year_month, file_type) — ถ้ามีทั้งแถว alias\n' +
        'และแถว canonical ของเดือน/ประเภทเดียวกันอยู่แล้ว UPDATE จะชนกัน\n' +
        'กรณีนั้นต้องเลือกก่อนว่าจะเก็บไฟล์ไหน (ดู uploaded_at) แล้วลบอีกแถวทิ้ง',
    );
  }
}

db.close();
process.exit(1);
