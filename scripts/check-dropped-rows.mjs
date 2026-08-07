#!/usr/bin/env node
/**
 * Show exactly which rows a workbook loses at the read, and why.
 *
 * READ ONLY — opens the file, prints what `dropNonDataRows` would discard, and
 * writes nothing anywhere.
 *
 * This is the tool for the question "the bot says 602 rows but pandas says
 * 606 — which four went?". It answers it against the actual file rather than
 * by reasoning about the filter, and it names the rule that fired for each row,
 * so a real member deleted by the label test is distinguishable from Power BI
 * furniture that was supposed to go.
 *
 * Usage:  node scripts/check-dropped-rows.mjs <file.xlsx> [fileType]
 *         (fileType is auto-detected from the header row when omitted)
 * Exit:   0 = nothing dropped, or only furniture. 1 = a row was dropped that
 *         does not look like furniture, which is worth a human's attention.
 */

import fs from 'node:fs';
import path from 'node:path';
import { readSheet, dropNonDataRows } from '../src/data/workbook.js';
import { detectFileType, getFileType } from '../src/data/fileTypes.js';

const [, , filePath, fileTypeArg] = process.argv;

if (!filePath) {
  console.error('ใช้: node scripts/check-dropped-rows.mjs <file.xlsx> [fileType]');
  process.exit(1);
}
if (!fs.existsSync(filePath)) {
  console.error(`ไม่พบไฟล์: ${filePath}`);
  process.exit(1);
}

const { headers, rows } = await readSheet(path.resolve(filePath));

const fileType = fileTypeArg ?? detectFileType(headers);
const type = fileType ? getFileType(fileType) : null;

const dateColumn = type?.sourceDateColumn ?? type?.dateColumn ?? null;
const leadColumnIsUserText = type?.leadColumnIsUserText ?? false;
const labelColumn = headers.find((header) => header) ?? null;

console.log(`ไฟล์: ${filePath}`);
console.log(`ประเภท: ${type?.label ?? '(ไม่รู้จัก)'} (${fileType ?? '-'})`);
console.log(`คอลัมน์แรก (ใช้ทดสอบ label): ${JSON.stringify(labelColumn)}`);
console.log(`คอลัมน์วันที่: ${JSON.stringify(dateColumn)}`);
console.log(`คอลัมน์แรกเป็นข้อความที่ผู้ใช้ตั้งเอง: ${leadColumnIsUserText}`);
console.log(`\nแถวที่อ่านได้จากชีต (ไม่นับแถวว่างล้วน): ${rows.length}`);

const kept = dropNonDataRows(rows, { headers, dateColumn, leadColumnIsUserText });
const keptSet = new Set(kept);
const dropped = rows.map((row, index) => ({ row, index })).filter(({ row }) => !keptSet.has(row));

console.log(`แถวที่เก็บไว้: ${kept.length}`);
console.log(`แถวที่ถูกตัดทิ้ง: ${dropped.length}`);

if (dropped.length === 0) {
  console.log('\n✅ ไม่มีแถวไหนถูกตัดทิ้ง');
  process.exit(0);
}

// A dropped row that carries values in several columns is not furniture —
// Power BI's trailer is blank almost everywhere.
function populatedColumns(row) {
  return headers.filter((header) => {
    if (!header || header === labelColumn) return false;
    const cell = row[header];
    return cell !== null && cell !== undefined && cell !== '';
  });
}

let suspicious = 0;

console.log('\n--- แถวที่ถูกตัด ---');
for (const { row, index } of dropped) {
  const filled = populatedColumns(row);
  const isLast = index >= rows.length - dropped.length;
  const label = row[labelColumn];

  // Same judgement the filter makes, spelled out for a reader.
  const reason =
    dateColumn && headers.includes(dateColumn) && !row[dateColumn]
      ? 'ไม่มีค่าวันที่ในคอลัมน์วันที่'
      : 'คอลัมน์แรกเป็นคำที่ระบบถือว่าเป็นหัว/ท้ายตาราง';

  const looksReal = filled.length >= 3 && !isLast;
  if (looksReal) suspicious += 1;

  console.log(
    `${looksReal ? '  ⚠️ ' : '  • '}แถวที่ ${index + 1}: ` +
      `${JSON.stringify(label)} — ${reason} — มีค่าอีก ${filled.length} คอลัมน์` +
      (looksReal ? '  ← น่าจะเป็นข้อมูลจริง ไม่ใช่ furniture' : ''),
  );
}

if (suspicious > 0) {
  console.log(
    `\n⚠️  ${suspicious} แถวมีข้อมูลอยู่หลายคอลัมน์และไม่ได้อยู่ท้ายไฟล์ — ` +
      'น่าจะเป็นแถวข้อมูลจริงที่ถูกตัดทิ้งผิด\n' +
      'ถ้าเป็นไฟล์ snapshot (vip / referrer / member_detail / ad_agent) ให้เช็คว่า\n' +
      'file type นั้นตั้ง `leadColumnIsUserText: true` ไว้แล้วหรือยังใน src/data/fileTypes.js',
  );
  process.exit(1);
}

console.log('\n✅ แถวที่ถูกตัดทั้งหมดมีลักษณะเป็น furniture ของ Power BI');
process.exit(0);
