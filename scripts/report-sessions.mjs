#!/usr/bin/env node
/**
 * Session shape, from the bot's own `turns` table — the input the TTL decision
 * needs.
 *
 * READ ONLY. Opens the SQLite file read-only and writes nothing.
 *
 * Whether prompt caching pays for itself is a question about traffic, not about
 * code: a cache write costs 1.25x an ordinary input token (2x at the 1-hour
 * tier), so it only pays back if the same prefix is reused before it expires.
 * The three numbers that decide it are how many questions a session asks, how
 * far apart they are, and how often a session switches site or month mid-way
 * (which changes the prefix and forces a fresh write).
 *
 * This reads them from `turns` rather than from the pm2 log, because `turns`
 * records `chat_id`, `site` and `ts` per question — the log does not.
 *
 * Usage:  npm run report:sessions [path/to/sessions.sqlite]
 */

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { ROOT } from '../src/paths.js';

const sqlitePath = path.resolve(
  ROOT,
  process.argv[2] ?? process.env.SQLITE_PATH ?? './data/sessions.sqlite',
);

if (!fs.existsSync(sqlitePath)) {
  console.error(`ไม่พบไฟล์ฐานข้อมูล: ${sqlitePath}`);
  process.exit(1);
}

const db = new Database(sqlitePath, { readonly: true });

const hasTurns = db
  .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'turns'")
  .get();
if (!hasTurns) {
  console.error('ไม่พบตาราง turns ในฐานข้อมูลนี้');
  process.exit(1);
}

// One row per question, oldest first, so gaps can be walked per chat.
const rows = db
  .prepare('SELECT chat_id, site, ts FROM turns ORDER BY chat_id, ts')
  .all();

if (rows.length === 0) {
  console.log('ตาราง turns ยังว่าง — ยังไม่มีคำถามให้วิเคราะห์');
  process.exit(1);
}

const byChat = new Map();
for (const row of rows) {
  if (!byChat.has(row.chat_id)) byChat.set(row.chat_id, []);
  byChat.get(row.chat_id).push(row);
}

/**
 * A run of questions with no gap longer than `idleMinutes` — the same rule
 * `findIdleSessions` uses to decide a session has ended, so these buckets match
 * what the bot itself calls a session.
 */
const IDLE_MINUTES = Number(process.env.SESSION_IDLE_MINUTES ?? 20);
const idleMs = IDLE_MINUTES * 60_000;

const sessions = [];
for (const turns of byChat.values()) {
  let current = [turns[0]];
  for (let i = 1; i < turns.length; i += 1) {
    if (turns[i].ts - turns[i - 1].ts > idleMs) {
      sessions.push(current);
      current = [];
    }
    current.push(turns[i]);
  }
  sessions.push(current);
}

const gapsMin = [];
let siteSwitches = 0;
for (const session of sessions) {
  for (let i = 1; i < session.length; i += 1) {
    gapsMin.push((session[i].ts - session[i - 1].ts) / 60_000);
    if (session[i].site !== session[i - 1].site) siteSwitches += 1;
  }
}

const pct = (arr, p) => {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};

const lengths = sessions.map((s) => s.length);
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const multi = sessions.filter((s) => s.length >= 2).length;
const threePlus = sessions.filter((s) => s.length >= 3).length;
const within5 = gapsMin.filter((g) => g <= 5).length;
const within60 = gapsMin.filter((g) => g <= 60).length;

console.log(`ฐานข้อมูล: ${sqlitePath}`);
console.log(`นิยาม session: คำถามที่ห่างกันไม่เกิน ${IDLE_MINUTES} นาที (ตาม SESSION_IDLE_MINUTES)\n`);

console.log(`คำถามทั้งหมด:              ${rows.length.toLocaleString('en-US')}`);
console.log(`จำนวน session:             ${sessions.length.toLocaleString('en-US')}`);
console.log(`คำถามต่อ session — เฉลี่ย:  ${mean(lengths).toFixed(2)}`);
console.log(`                    median: ${pct(lengths, 50)}`);
console.log(`                    p90:    ${pct(lengths, 90)}`);
console.log(`session ที่มี >= 2 คำถาม:    ${multi} (${((multi / sessions.length) * 100).toFixed(1)}%)  ← จุดคุ้มทุนของ TTL 5 นาที`);
console.log(`session ที่มี >= 3 คำถาม:    ${threePlus} (${((threePlus / sessions.length) * 100).toFixed(1)}%)  ← จุดคุ้มทุนของ TTL 1 ชั่วโมง\n`);

if (gapsMin.length > 0) {
  console.log(`ระยะห่างระหว่างคำถาม (นาที) — median: ${pct(gapsMin, 50).toFixed(1)}, p90: ${pct(gapsMin, 90).toFixed(1)}`);
  console.log(`  ห่างไม่เกิน 5 นาที:  ${within5}/${gapsMin.length} (${((within5 / gapsMin.length) * 100).toFixed(1)}%)  ← จะ hit ด้วย TTL 5 นาที`);
  console.log(`  ห่างไม่เกิน 60 นาที: ${within60}/${gapsMin.length} (${((within60 / gapsMin.length) * 100).toFixed(1)}%)  ← จะ hit ด้วย TTL 1 ชั่วโมง`);
  console.log(`\nเปลี่ยนเว็บกลาง session:     ${siteSwitches}/${gapsMin.length} (${((siteSwitches / gapsMin.length) * 100).toFixed(1)}%) — ทุกครั้งที่เปลี่ยนคือ cache miss + write ใหม่`);
}

console.log('\n--- สรุปเชิงตัดสินใจ ---');
if (multi / sessions.length < 0.5) {
  console.log('ส่วนใหญ่เป็น session คำถามเดียว — cache จะทำให้แพงขึ้น ไม่ควรเปิด');
} else if (within60 > 0 && within5 / gapsMin.length < 0.5 && threePlus / sessions.length > 0.4) {
  console.log('คำถามส่วนใหญ่ห่างกันเกิน 5 นาที แต่ session ยาวพอ — TTL 1h น่าจะคุ้มกว่า 5m');
} else {
  console.log('TTL 5 นาทีน่าจะเพียงพอ — คำถามส่วนใหญ่ตามติดกันเร็ว');
}

db.close();
