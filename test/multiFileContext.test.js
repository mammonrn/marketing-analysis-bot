/**
 * The context now carries every file the bot holds for a site, not the one a
 * keyword picked, plus an inventory of what exists either way.
 *
 * The failure this replaces: "ตรวจสอบการแจก bonus และ commission โปรแนะนำเพื่อน"
 * needs referrer + member_detail + bonus_log at once and could only ever get
 * one of them, and when the keywords missed entirely the model was handed the
 * wrong report and said the file had not been uploaded.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as XLSX from 'xlsx';

process.env.TELEGRAM_BOT_TOKEN ??= 'test-token';
process.env.ANTHROPIC_API_KEY ??= 'test-key';

let tmpDir;
let db;
let ingest;
let query;

function workbookBuffer(headers, rows) {
  const wb = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([headers, ...rows.map((r) => headers.map((h) => r[h] ?? null))]);
  XLSX.utils.book_append_sheet(wb, sheet, 'Sheet1');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

/** Last month — inside the three-month window buildDataContext looks at. */
function lastMonth(from = new Date()) {
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() - 1, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
const MONTH = lastMonth();
const day = (i) => `${MONTH}-${String(i + 1).padStart(2, '0')}`;

const FILES = {
  daily_value: {
    name: 'Daily Value.xlsx',
    headers: ['Date', 'RTP', 'DAU', 'BIn', 'R'],
    rows: Array.from({ length: 5 }, (_, i) => ({ Date: day(i), RTP: 0.95, DAU: 470, BIn: 400, R: 88 })),
  },
  referrer: {
    name: 'Referrer.xlsx',
    headers: ['Referrer', 'Ref Bonus', 'Total Mems', 'BIn', 'R'],
    rows: Array.from({ length: 5 }, (_, i) => ({ Referrer: `ref${i}`, 'Ref Bonus': 3, 'Total Mems': 40, BIn: 88, R: 14 })),
  },
  member_detail: {
    name: 'Member_Detail.xlsx',
    headers: ['Username', 'Referrer', 'BIn', 'R', 'Prefer Game'],
    rows: Array.from({ length: 5 }, (_, i) => ({ Username: `m${i}`, Referrer: 'ref0', BIn: 12, R: 2, 'Prefer Game': 'JILI_SLOT' })),
  },
  bonus_log: {
    name: 'bonus.xlsx',
    headers: ['AddTime', 'Type', 'Username', 'Lv', 'Points', 'Memo'],
    rows: Array.from({ length: 5 }, (_, i) => ({
      AddTime: `${day(i)} 10:00:00`, Type: 'Loyalty Point', Username: `m${i}`, Lv: null, Points: 12, Memo: 'x',
    })),
  },
};

async function upload(key, chatId) {
  const spec = FILES[key];
  const buffer = workbookBuffer(spec.headers, spec.rows);
  return ingest.ingestUpload({
    buffer,
    originalFilename: spec.name,
    fileSize: buffer.length + key.length,
    chatId,
    captionText: `SH666 ${MONTH}`,
  });
}

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ads-analytics-multi-'));
  process.env.DATA_DIR = tmpDir;

  db = await import('../src/data/db.js');
  db.initDataDb(path.join(tmpDir, 'test.sqlite'));
  ingest = await import('../src/data/ingest.js');
  query = await import('../src/data/query.js');

  for (const key of Object.keys(FILES)) {
    const result = await upload(key, `chat-${key}`);
    assert.equal(result.status, 'saved', `${key} uploaded`);
    assert.equal(result.fileType, key, `${key} classified as itself`);
  }
});

after(() => {
  db?.closeDataDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('a question spanning three reports gets all three', async () => {
  const context = await query.buildDataContext(
    'shwe666',
    'ตรวจสอบการแจก bonus และ commission โปรแนะนำเพื่อน',
  );
  assert.ok(context);

  for (const fileType of ['referrer', 'member_detail', 'bonus_log']) {
    assert.match(context, new RegExp(`\\(${fileType}\\)`), `${fileType} data is in the context`);
  }
});

test('a question with no keyword match still gets every file', async () => {
  // Routes to daily_value by default; the other three used to be unreachable.
  const context = await query.buildDataContext('shwe666', 'สรุปภาพรวมให้หน่อย');
  assert.ok(context);
  for (const fileType of Object.keys(FILES)) {
    assert.match(context, new RegExp(`\\(${fileType}\\)`));
  }
});

test('the keyword still decides which file leads', async () => {
  const context = await query.buildDataContext('shwe666', 'referrer คนไหนสร้างมูลค่าจริง');
  const first = context.indexOf('########## ไฟล์ที่ 1');
  const referrerAt = context.indexOf('ประเภทไฟล์: Referrer (referrer)');
  const dailyAt = context.indexOf('ประเภทไฟล์: Daily Value (daily_value)');

  assert.ok(referrerAt > first, 'referrer is inside the file blocks');
  assert.ok(referrerAt < dailyAt, 'and it leads, because the question named it');
});

test('the inventory lists every file in the system, always', async () => {
  const context = await query.buildDataContext('shwe666', 'อะไรก็ได้');
  assert.match(context, /ไฟล์ทั้งหมดที่มีอยู่ในระบบของ SH666/);
  for (const fileType of Object.keys(FILES)) {
    assert.match(context, new RegExp(`✅ .*\\(${fileType}\\) — เดือน ${MONTH} — ส่งข้อมูลมาด้วยแล้ว`));
  }
  // And the instruction that stops "ไฟล์นี้ยังไม่ถูกอัปโหลด" for a file that is there.
  assert.match(context, /ห้ามตอบว่ายังไม่ได้อัปโหลด/);
});

test('a site with nothing uploaded still returns null', async () => {
  assert.equal(await query.buildDataContext('88fed', 'ภาพรวม'), null);
});

test('blocks are separated and the model is told not to mix them', async () => {
  const context = await query.buildDataContext('shwe666', 'ภาพรวม');
  assert.match(context, /ห้ามเอาตัวเลขข้ามไฟล์มาปนกัน/);
  assert.match(context, /########## ไฟล์ที่ 4 จาก 4 ##########/);
});

// --- file classification -----------------------------------------------------

test('Member Referrer Detail is its own type, not Member Detail', async () => {
  const { detectFileType, refineFileTypeByFilename } = await import('../src/data/fileTypes.js');
  const headers = ['Username', 'Referrer', 'BIn', 'Pro', 'R', 'BIn Days', 'Prefer Game'];

  // The columns alone cannot tell them apart — that is the whole problem.
  assert.equal(detectFileType(headers), 'member_detail');
  assert.equal(
    refineFileTypeByFilename('member_detail', 'Member Referrer Detail.xlsx'),
    'member_referrer_detail',
  );
  assert.equal(
    refineFileTypeByFilename('member_detail', 'Member_Detail.xlsx'),
    'member_detail',
    'the ordinary member file is untouched',
  );
});

test('reward point and other transfer are their own types, not bonus_log', async () => {
  const { detectFileType, refineFileTypeByFilename } = await import('../src/data/fileTypes.js');
  const headers = ['AddTime', 'Type', 'Username', 'Lv', 'Points', 'Memo'];

  assert.equal(detectFileType(headers), 'bonus_log');
  assert.equal(refineFileTypeByFilename('bonus_log', 'reward point.xlsx'), 'reward_point');
  assert.equal(refineFileTypeByFilename('bonus_log', 'other transfer.xlsx'), 'other_transfer');
  assert.equal(refineFileTypeByFilename('bonus_log', 'bonus.xlsx'), 'bonus_log');
});

test('a filename never invents a type the columns disagree with', async () => {
  const { refineFileTypeByFilename } = await import('../src/data/fileTypes.js');
  // A vip export that happens to be named "... reward point ..." stays vip:
  // the override only fires for the type it is registered against.
  assert.equal(refineFileTypeByFilename('vip', 'vip reward point.xlsx'), 'vip');
  assert.equal(refineFileTypeByFilename(null, 'reward point.xlsx'), null);
});

test('the two files no longer overwrite each other in storage', async () => {
  const memberHeaders = ['Username', 'Referrer', 'BIn', 'R', 'Prefer Game'];
  const rows = Array.from({ length: 3 }, (_, i) => ({
    Username: `x${i}`, Referrer: 'r0', BIn: 5, R: 1, 'Prefer Game': 'PG',
  }));

  const a = workbookBuffer(memberHeaders, rows);
  const first = await ingest.ingestUpload({
    buffer: a,
    originalFilename: 'Member Referrer Detail.xlsx',
    fileSize: a.length + 1,
    chatId: 'chat-collide',
    captionText: `U89 ${MONTH}`,
  });
  assert.equal(first.status, 'saved');
  assert.equal(first.fileType, 'member_referrer_detail');

  const b = workbookBuffer(memberHeaders, rows);
  const second = await ingest.ingestUpload({
    buffer: b,
    originalFilename: 'Member_Detail.xlsx',
    fileSize: b.length + 2,
    chatId: 'chat-collide',
    captionText: `U89 ${MONTH}`,
  });
  assert.equal(second.status, 'saved');
  assert.equal(second.fileType, 'member_detail');

  // Both survive: before the split, the second replaced the first outright.
  assert.ok(db.findRawFile({ site: 'ubet89', yearMonth: MONTH, fileType: 'member_referrer_detail' }));
  assert.ok(db.findRawFile({ site: 'ubet89', yearMonth: MONTH, fileType: 'member_detail' }));
});
