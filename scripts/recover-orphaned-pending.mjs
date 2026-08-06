#!/usr/bin/env node
/**
 * One-off recovery for uploads stranded by the pending_uploads bug.
 *
 * `pending_uploads` used to key on `chat_id` alone, so a second file arriving
 * before the user named a site replaced the first. Eleven files were sent at
 * once, one site name was given, and only the last upload was recorded — the
 * other ten are still sitting in DATA/_pending with nothing in the database
 * pointing at them.
 *
 * This script puts them back through the *real* ingest entry point rather
 * than writing rows by hand, so file-type detection, the site/month rules,
 * duplicate detection, storage layout and retention all behave exactly as
 * they would have if the upload had worked the first time.
 *
 * Safe by default: it reports what it would do and changes nothing unless
 * you pass --apply.
 *
 *   node scripts/recover-orphaned-pending.mjs              # dry run
 *   node scripts/recover-orphaned-pending.mjs --apply      # do it
 *
 * Options:
 *   --site=SH666        target site (default SH666)
 *   --month=2026-07     target reporting month (default 2026-07)
 *   --keep-temp         leave the recovered files in DATA/_pending
 *   --all-sizes         consider every file in _pending, not just the known ten
 */

import fs from 'node:fs';
import path from 'node:path';

const args = new Set(process.argv.slice(2).filter((a) => !a.includes('=')));
const options = Object.fromEntries(
  process.argv
    .slice(2)
    .filter((a) => a.includes('='))
    .map((a) => a.replace(/^--/, '').split('=')),
);

const APPLY = args.has('--apply');
const KEEP_TEMP = args.has('--keep-temp');
const ALL_SIZES = args.has('--all-sizes');
const SITE_INPUT = options.site ?? 'SH666';
const MONTH = options.month ?? '2026-07';

/**
 * The ten files known to be victims of the bug, identified by exact byte size.
 * Anything else in _pending is left alone — an unrelated in-flight upload
 * must not be swept into this recovery.
 */
const ORPHAN_SIZES = new Set([9103, 11038, 3113, 4950, 7168, 3970, 9396, 6015, 37327, 3520]);

/**
 * The two hour-pivot exports have byte-identical header rows and are normally
 * told apart by filename — which a temp file no longer has. Their sizes do
 * differ, and these two are exact.
 */
const PIVOT_SIZES = new Map([
  [3970, 'Average BIn (Week Day x Hour).xlsx'],
  [3520, 'Average BIn Mems (Week Day x Hour).xlsx'],
]);

const { config } = await import('../src/config.js');
const { initDataDb, closeDataDb, listRawFiles } = await import('../src/data/db.js');
const { readHeaderRow } = await import('../src/data/parse.js');
const { detectFileType, isHourPivotHeader, getFileType } = await import('../src/data/fileTypes.js');
const { ingestUpload } = await import('../src/data/ingest.js');
const { normalizeSiteName, siteDisplayName } = await import('../src/data/sites.js');

const pendingDir = path.join(config.data.dir, '_pending');
const site = normalizeSiteName(SITE_INPUT);

if (!site) {
  console.error(`❌ ไม่รู้จักเว็บ "${SITE_INPUT}"`);
  process.exit(1);
}

initDataDb();

const before = listRawFiles({ site });
console.log(`โหมด        : ${APPLY ? '⚠️  APPLY (เขียนจริง)' : '🔍 DRY RUN (ไม่เขียนอะไร)'}`);
console.log(`_pending    : ${pendingDir}`);
console.log(`ปลายทาง     : ${siteDisplayName(site)} เดือน ${MONTH}`);
console.log(`raw_files ก่อน: ${before.length} แถว\n`);

let candidates;
try {
  candidates = fs
    .readdirSync(pendingDir)
    .filter((name) => /\.xlsx?$/i.test(name))
    .map((name) => {
      const absPath = path.join(pendingDir, name);
      return { name, absPath, size: fs.statSync(absPath).size };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
} catch (err) {
  console.error(`❌ อ่าน ${pendingDir} ไม่ได้: ${err.message}`);
  closeDataDb();
  process.exit(1);
}

const targets = ALL_SIZES ? candidates : candidates.filter((f) => ORPHAN_SIZES.has(f.size));
const skipped = candidates.filter((f) => !targets.includes(f));

if (skipped.length > 0) {
  console.log(`ข้าม ${skipped.length} ไฟล์ที่ขนาดไม่ตรงรายการที่ต้องกู้:`);
  for (const f of skipped) console.log(`  - ${f.name} (${f.size} bytes)`);
  console.log('');
}

// Pass one: work out what each file is, without writing anything. Knowing the
// whole picture first is what makes the collision check below possible.
const plan = [];
for (const file of targets) {
  const buffer = fs.readFileSync(file.absPath);
  const headers = await readHeaderRow(buffer);

  // Resolve the type the same way ingest does, so the synthesised filename we
  // hand back to ingestUpload cannot change the answer.
  let detected = detectFileType(headers);
  let originalFilename = null;

  if (detected) {
    originalFilename = `${detected}.xlsx`;
  } else if (isHourPivotHeader(headers) && PIVOT_SIZES.has(file.size)) {
    // Size is the only thing left that separates the two pivots.
    originalFilename = PIVOT_SIZES.get(file.size);
    detected = file.size === 3520 ? 'avg_bin_mems_by_hour' : 'avg_bin_by_hour';
  }

  plan.push({ ...file, buffer, headers, fileType: detected, originalFilename });
}

/**
 * `raw_files` holds one row per (site, year_month, file_type), so two files
 * of the same type in one batch cannot both survive — the second would
 * replace the first and delete it from disk. That is exactly the kind of
 * silent loss this whole exercise is undoing, so it stops here.
 */
const byType = new Map();
for (const item of plan.filter((p) => p.fileType)) {
  byType.set(item.fileType, [...(byType.get(item.fileType) ?? []), item]);
}
const collisions = [...byType.entries()].filter(([, items]) => items.length > 1);

if (collisions.length > 0) {
  console.log('⚠️  ไฟล์ต่อไปนี้เป็น file type เดียวกัน — เก็บได้แค่ไฟล์เดียวต่อเว็บต่อเดือน');
  console.log('    ถ้ากู้ทั้งคู่ ไฟล์หลังจะทับไฟล์แรกและลบของเดิมทิ้ง:\n');
  for (const [fileType, items] of collisions) {
    console.log(`    ${getFileType(fileType)?.label ?? fileType}:`);
    for (const item of items) console.log(`      - ${item.name} (${item.size} bytes)`);
  }
  console.log('');
  if (APPLY && !args.has('--allow-collisions')) {
    console.log('หยุดไว้ก่อน ไม่ได้เขียนอะไรลงไป เลือกทางใดทางหนึ่ง:');
    console.log('  • ย้ายไฟล์ที่ไม่ต้องการออกจาก _pending แล้วรันใหม่');
    console.log('  • กู้ทีละไฟล์โดยใช้ --month ต่างกัน');
    console.log('  • ยอมรับว่าจะเหลือไฟล์เดียว แล้วรันด้วย --allow-collisions');
    closeDataDb();
    process.exit(2);
  }
}

const summary = [];

for (const file of plan) {
  const { buffer, fileType: detected, originalFilename } = file;

  if (!detected) {
    summary.push({ file: file.name, size: file.size, fileType: null, status: 'unrecognized' });
    console.log(`❓ ${file.name} (${file.size}) — ไม่รู้จัก header: ${JSON.stringify(file.headers)}`);
    continue;
  }

  if (!APPLY) {
    summary.push({ file: file.name, size: file.size, fileType: detected, status: 'would-save' });
    console.log(`🔍 ${file.name} (${file.size}) → ${getFileType(detected)?.label ?? detected}`);
    continue;
  }

  const result = await ingestUpload({
    buffer,
    originalFilename,
    fileSize: buffer.length,
    chatId: `recovery-${Date.now()}`,
    // Names both the site and the month, so ingest takes them from here
    // rather than guessing — and never has to read the sheet to date it.
    captionText: `${SITE_INPUT} ${MONTH}`,
  });

  summary.push({ file: file.name, size: file.size, fileType: detected, status: result.status });
  console.log(
    `${result.status === 'saved' ? '✅' : '⚠️ '} ${file.name} (${file.size}) → ` +
      `${getFileType(detected)?.label ?? detected} [${result.status}]`,
  );

  if (result.status === 'saved' && !KEEP_TEMP) {
    fs.rmSync(file.absPath, { force: true });
  }
}

const after = listRawFiles({ site });

console.log('\n──────── สรุป ────────');
for (const row of summary) {
  console.log(`  ${String(row.size).padStart(7)}  ${(row.fileType ?? '—').padEnd(24)} ${row.status}`);
}
console.log(`\nraw_files ${siteDisplayName(site)}: ${before.length} → ${after.length} แถว`);

if (!APPLY) {
  console.log('\nยังไม่ได้เขียนอะไรลงไป — รันซ้ำด้วย --apply เมื่อพร้อม');
} else {
  console.log(
    KEEP_TEMP
      ? '\nเก็บไฟล์ใน _pending ไว้ตามที่สั่ง (--keep-temp)'
      : '\nลบไฟล์ที่กู้สำเร็จออกจาก _pending แล้ว',
  );
}

closeDataDb();
