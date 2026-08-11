#!/usr/bin/env node
/**
 * Re-parse a stored file, to clear a stale `parsed_rows` cache.
 *
 * Why this exists: `dropNonDataRows` has discarded Power BI's `Total` and
 * `Applied filters:` rows at the read since PR #9, but `parsed = 1` means a
 * file parsed *before* that is never read again — its furniture rows sit in
 * `parsed_rows` for ever. PR #19 stopped those rows being *read*, so every
 * figure is already correct; this script is what actually removes them.
 *
 * THE DANGER, and why the checks below are not optional:
 *
 *   Retention deletes the raw workbook from disk but leaves `parsed_rows`
 *   alone on purpose (see `db.js`), because the parsed cache is much lighter
 *   than the workbook and worth keeping after the source ages out. So for an
 *   older month the parsed rows can be the ONLY copy of that data left. Delete
 *   them when the workbook is gone and it is gone for good.
 *
 * Hence: the workbook must exist, and it must parse successfully into memory,
 * BEFORE a single row is deleted. If the parse throws, nothing is touched and
 * the old rows stay exactly where they were.
 *
 * Safe by default — reports what it would do and changes nothing without
 * --apply.
 *
 *   node scripts/reparse.mjs --id=9                        # dry run
 *   node scripts/reparse.mjs --id=9 --apply                # re-parse now
 *   node scripts/reparse.mjs --site=SH666 --month=2026-07 --type=daily_value
 *   node scripts/reparse.mjs --stale                       # find every affected file
 *
 * Options:
 *   --id=9                  target one raw_files row by id
 *   --site= --month= --type=  target by the natural key instead
 *   --stale                 list every file holding dateless rows on a dated
 *                           type, across all sites and months
 *   --apply                 do it (default is a dry run)
 *   --lazy                  with --apply: clear the cache and set parsed = 0,
 *                           leaving the re-parse to the next question that
 *                           needs the file, instead of parsing here and now
 */

import fs from 'node:fs';
import path from 'node:path';

// config.js validates these at import time; a maintenance script has no
// Telegram or Anthropic work to do, so placeholders are enough.
process.env.TELEGRAM_BOT_TOKEN ??= 'reparse-script';
process.env.ANTHROPIC_API_KEY ??= 'reparse-script';

const { ROOT } = await import('../src/paths.js');
const db = await import('../src/data/db.js');
const { getFileType } = await import('../src/data/fileTypes.js');
const { normalizeSiteName, siteDisplayName } = await import('../src/data/sites.js');
const { parseWorkbookRows } = await import('../src/data/parseRunner.js');
const { normaliseDate } = await import('../src/data/dates.js');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

const APPLY = flag('apply');
const LAZY = flag('lazy');

db.initDataDb();

/** Files on a dated type that still hold rows with no date — the ones at issue. */
function findStale() {
  return db
    .listRawFiles({})
    .map((file) => ({ file, counts: db.countParsedRows(file.id) }))
    .filter(({ file, counts }) => getFileType(file.file_type)?.dateColumn && counts.dateless > 0);
}

function resolveTarget() {
  const id = value('id');
  if (id) {
    const file = db.getRawFile(Number(id));
    if (!file) throw new Error(`ไม่พบ raw_files id=${id}`);
    return file;
  }

  const siteArg = value('site');
  const month = value('month');
  const type = value('type');
  if (!siteArg || !month || !type) {
    throw new Error('ต้องระบุ --id หรือ --site + --month + --type (ดู --help ที่หัวไฟล์)');
  }

  const site = normalizeSiteName(siteArg);
  if (!site) throw new Error(`ไม่รู้จักเว็บ "${siteArg}"`);
  if (!getFileType(type)) throw new Error(`ไม่รู้จัก file_type "${type}"`);

  const file = db.findRawFile({ site, yearMonth: month, fileType: type });
  if (!file) throw new Error(`ไม่พบไฟล์ ${siteDisplayName(site)} / ${month} / ${type} ใน raw_files`);
  return file;
}

function describe(file, counts) {
  const type = getFileType(file.file_type);
  console.log(`raw_files id      : ${file.id}`);
  console.log(`เว็บ / เดือน / ชนิด : ${siteDisplayName(file.site)} / ${file.year_month} / ${file.file_type}`);
  console.log(`เป็น time series  : ${type?.dateColumn ? `ใช่ (คอลัมน์ ${type.dateColumn})` : 'ไม่ใช่ — เป็น snapshot'}`);
  console.log(`parsed flag       : ${file.parsed}`);
  console.log(`parsed_rows       : ${counts.total} แถว (มีวันที่ ${counts.dated}, ไม่มีวันที่ ${counts.dateless})`);
}

async function main() {
  if (flag('stale')) {
    const stale = findStale();
    if (stale.length === 0) {
      console.log('✅ ไม่มีไฟล์ไหนที่มีแถวไร้วันที่ค้างอยู่');
      return;
    }
    console.log(`พบ ${stale.length} ไฟล์ที่ยังมีแถวไร้วันที่ค้างอยู่:\n`);
    for (const { file, counts } of stale) {
      console.log(
        `  id=${String(file.id).padEnd(4)} ${siteDisplayName(file.site).padEnd(6)} ` +
          `${file.year_month}  ${file.file_type.padEnd(28)} ` +
          `${counts.total} แถว (ขยะ ${counts.dateless})`,
      );
    }
    console.log('\nสั่งแก้ทีละไฟล์ด้วย: node scripts/reparse.mjs --id=<id> --apply');
    return;
  }

  const file = resolveTarget();
  const counts = db.countParsedRows(file.id);
  const type = getFileType(file.file_type);

  describe(file, counts);

  // --- the guard ------------------------------------------------------------
  const absPath = path.join(ROOT, file.path);
  const onDisk = fs.existsSync(absPath);
  console.log(`ไฟล์ต้นฉบับ       : ${file.path} ${onDisk ? '✅ มีอยู่' : '❌ ไม่พบบนดิสก์'}`);

  if (!onDisk) {
    console.error(
      '\n🚫 ไม่ทำต่อ — ไฟล์ต้นฉบับหายไปแล้ว\n' +
        '   retention ลบไฟล์ดิบแต่เก็บ parsed_rows ไว้โดยตั้งใจ แถวที่อยู่ใน DB ตอนนี้\n' +
        '   จึงอาจเป็นสำเนาสุดท้ายของข้อมูลเดือนนี้ ถ้าลบทิ้งจะกู้ไม่ได้\n' +
        '   ถ้าต้องการ re-parse จริง ให้อัปโหลดไฟล์ Excel เดิมเข้าบอทใหม่แทน',
    );
    process.exitCode = 1;
    return;
  }

  if (counts.dateless === 0 && type?.dateColumn) {
    console.log('\nℹ️  ไฟล์นี้ไม่มีแถวไร้วันที่ค้างอยู่แล้ว — re-parse ได้ แต่ไม่ได้แก้อะไร');
  }

  if (!APPLY) {
    console.log(
      '\n(dry run) จะทำ: ' +
        (LAZY
          ? 'ลบ parsed_rows แล้วตั้ง parsed = 0 ให้ re-parse รอบถัดไปที่มีคนถาม'
          : 'อ่านไฟล์ใหม่ทั้งไฟล์ก่อน แล้วค่อยลบของเก่าและเขียนของใหม่ทับ') +
        '\nใส่ --apply เพื่อทำจริง',
    );
    return;
  }

  // --- lazy path ------------------------------------------------------------
  if (LAZY) {
    // Still behind the on-disk check above: without it this is the same data
    // loss, just deferred to whenever someone next asks a question.
    const removed = db.deleteParsedRows(file.id);
    db.markUnparsed(file.id);
    console.log(`\n🗑️  ลบ parsed_rows ${removed} แถว และตั้ง parsed = 0 แล้ว`);
    console.log('   ไฟล์จะถูก parse ใหม่ตอนมีคำถามแรกที่ต้องใช้ไฟล์นี้');
    console.log('   ⚠️ ระหว่างนี้ยังไม่มีใครยืนยันได้ว่าไฟล์ parse ผ่าน — รันซ้ำโดยไม่ใส่ --lazy เพื่อตรวจเลยก็ได้');
    return;
  }

  // --- verified path (default) ---------------------------------------------
  // Parse into memory FIRST. Nothing below the old rows is deleted until this
  // has succeeded, so a corrupt or unreadable workbook costs nothing.
  console.log('\n⏳ กำลังอ่านไฟล์ใหม่ (ยังไม่แตะข้อมูลเดิม)...');
  let parsedRows;
  try {
    const rows = await parseWorkbookRows({
      filePath: absPath,
      fileType: file.file_type,
      site: file.site,
    });
    const dateColumn = type?.dateColumn;
    parsedRows = rows.map((row) => ({
      row,
      rowDate: dateColumn ? normaliseDate(row[dateColumn]) : null,
    }));
  } catch (err) {
    console.error(
      `\n🚫 อ่านไฟล์ไม่สำเร็จ — ไม่ได้ลบอะไรเลย ข้อมูลเดิมยังอยู่ครบ\n   ${err?.message}`,
    );
    process.exitCode = 1;
    return;
  }

  const dateless = parsedRows.filter((r) => !r.rowDate).length;
  console.log(`   อ่านได้ ${parsedRows.length} แถว (ไม่มีวันที่ ${dateless})`);

  const removed = db.deleteParsedRows(file.id);
  db.insertParsedRows(file.id, {
    fileType: file.file_type,
    site: file.site,
    yearMonth: file.year_month,
    rows: parsedRows,
  });
  db.markParsed(file.id);

  const after = db.countParsedRows(file.id);
  console.log('\n✅ เขียนทับเรียบร้อย');
  console.log(`   ก่อน: ${counts.total} แถว (ขยะ ${counts.dateless})`);
  console.log(`   หลัง: ${after.total} แถว (ขยะ ${after.dateless})`);
  console.log(`   ลบของเก่า ${removed} แถว, เขียนใหม่ ${parsedRows.length} แถว`);

  if (after.dateless > 0 && type?.dateColumn) {
    console.log(
      '\n⚠️ ยังมีแถวไร้วันที่เหลืออยู่หลัง re-parse — แปลว่า dropNonDataRows จับรูปแบบนี้ไม่ได้\n' +
        '   ตัวเลขยังถูกต้องเพราะ queryParsedRows กรองให้ แต่ควรแจ้งเพื่อดู workbook.js ต่อ',
    );
  }
}

try {
  await main();
} catch (err) {
  console.error(`\n❌ ${err.message}`);
  process.exitCode = 1;
} finally {
  db.closeDataDb();
}
