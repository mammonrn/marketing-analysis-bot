#!/usr/bin/env node
/**
 * Verify the skill bundle before deploying (spec §4).
 *
 * Runs without .env on purpose, so it works on a fresh clone and in CI.
 * Exit codes: 0 = complete, 1 = a required file is missing.
 */

import { inspectSkillBundle } from '../src/prompt/loader.js';
import { SKILL_DIR } from '../src/paths.js';

const report = inspectSkillBundle();

console.log(`skill dir: ${SKILL_DIR}\n`);

for (const entry of report.present) {
  console.log(
    `  ✅ ${entry.file.padEnd(46)} ${String(entry.lines).padStart(4)} บรรทัด  ${entry.sha256.slice(0, 12)}`,
  );
}

for (const entry of report.missing) {
  const mark = entry.required ? '🚨 REQUIRED' : '⚠️  optional';
  console.log(`  ${mark} ขาดไฟล์: ${entry.file}  (${entry.label})`);
}

console.log(`\n  overlay (prompt/bot-overlay.md): ${report.overlayPresent ? '✅' : '🚨 ขาด'}`);
console.log(
  `  รวม ${report.totalChars.toLocaleString('en-US')} ตัวอักษร ` +
    `(~${Math.round(report.totalChars / 3.2).toLocaleString('en-US')} tokens ต่อ 1 call ก่อน cache)`,
);

if (report.missingRequired.length > 0 || !report.overlayPresent) {
  console.error(
    '\n❌ ยังขาดไฟล์ที่บังคับ — บอทจะไม่ start จนกว่าจะครบ\n' +
      '   คัดลอกไฟล์จาก claude.ai project (หรือ /mnt/skills/user/thai-data-analyst/) เข้ามาก่อน',
  );
  process.exit(1);
}

if (report.missing.length > 0) {
  console.warn(
    '\n⚠️  ไฟล์ optional บางตัวยังขาด — บอท start ได้ แต่จะไม่มี benchmark ส่วนนั้น\n' +
      '   ถ้าถามถึงเว็บ/รายงานที่ขาดไฟล์ บอทจะตอบว่า "ยังไม่มี benchmark ของเว็บนี้ในระบบ"',
  );
}

console.log('\n✅ พร้อม deploy');
