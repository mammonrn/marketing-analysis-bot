#!/usr/bin/env node
/**
 * Cache hit rate and what it saved, from the bot's own logs.
 *
 * READ ONLY. Reads `logs/out.log` (pm2's stdout, per ecosystem.config.cjs) and
 * summarises every `anthropic usage` line `logCacheUsage` wrote.
 *
 * Why this exists: a prompt cache that never hits is completely invisible from
 * the outside. The bot answers normally, nothing errors, and the bill goes up
 * — a cache write costs 1.25x an ordinary input token, so a cache that misses
 * every time is strictly worse than not caching at all. The only way to know
 * which of those two is happening is to read the numbers back.
 *
 * Usage:  npm run report:cache [path/to/out.log]
 * Exit:   0 = caching is paying for itself, 1 = it is not (or no data yet).
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { ROOT } from '../src/paths.js';

const logPath = path.resolve(ROOT, process.argv[2] ?? 'logs/out.log');

if (!fs.existsSync(logPath)) {
  console.error(`ไม่พบไฟล์ log: ${logPath}`);
  console.error('ระบุ path เองได้: npm run report:cache -- path/to/out.log');
  process.exit(1);
}

/**
 * Sonnet 5 list price per million tokens, and the multipliers the cache
 * applies to the input rate. Override the base rates with env vars when the
 * introductory pricing window closes or the model changes.
 */
const INPUT_PER_MTOK = Number(process.env.CACHE_REPORT_INPUT_PRICE ?? 3);
const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_MULTIPLIER = process.env.ANTHROPIC_CACHE_TTL === '1h' ? 2 : 1.25;
const USD_TO_THB = Number(process.env.CACHE_REPORT_USD_THB ?? 36);

const totals = {
  calls: 0,
  fresh: 0,
  read: 0,
  written: 0,
  output: 0,
  callsWithRead: 0,
};

const rl = readline.createInterface({ input: fs.createReadStream(logPath), crlfDelay: Infinity });

for await (const line of rl) {
  if (!line.includes('anthropic usage')) continue;

  // pm2 prefixes stdout; the JSON object is whatever survives from the first brace.
  const start = line.indexOf('{');
  if (start === -1) continue;

  let entry;
  try {
    entry = JSON.parse(line.slice(start));
  } catch {
    continue;
  }
  if (entry.msg !== 'anthropic usage' && entry.message !== 'anthropic usage') continue;

  totals.calls += 1;
  totals.fresh += entry.inputTokens ?? 0;
  totals.read += entry.cacheReadTokens ?? 0;
  totals.written += entry.cacheWriteTokens ?? 0;
  totals.output += entry.outputTokens ?? 0;
  if ((entry.cacheReadTokens ?? 0) > 0) totals.callsWithRead += 1;
}

if (totals.calls === 0) {
  console.log(`ไม่พบบรรทัด "anthropic usage" ใน ${logPath}`);
  console.log('บอทอาจยังไม่ได้ตอบคำถามหลังจาก deploy เวอร์ชันที่มี logging นี้');
  process.exit(1);
}

const promptTokens = totals.fresh + totals.read + totals.written;
const hitRate = promptTokens > 0 ? totals.read / promptTokens : 0;
const callHitRate = totals.callsWithRead / totals.calls;

// What was actually paid, in input-token-equivalents.
const paid =
  totals.fresh + totals.read * CACHE_READ_MULTIPLIER + totals.written * CACHE_WRITE_MULTIPLIER;
// What the same traffic would have cost with no caching at all: every token
// that was read or written would have been an ordinary input token instead.
const uncached = promptTokens;

const cost = (tokens) => (tokens / 1_000_000) * INPUT_PER_MTOK;
const baht = (usd) => usd * USD_TO_THB;
const fmt = (n) => n.toLocaleString('en-US');

console.log(`log: ${logPath}`);
console.log(`ราคา input ที่ใช้คำนวณ: $${INPUT_PER_MTOK}/MTok, cache write ×${CACHE_WRITE_MULTIPLIER}, cache read ×${CACHE_READ_MULTIPLIER}`);
console.log(`(ปรับได้ด้วย CACHE_REPORT_INPUT_PRICE / ANTHROPIC_CACHE_TTL / CACHE_REPORT_USD_THB)\n`);

console.log(`จำนวน API call:            ${fmt(totals.calls)}`);
console.log(`  call ที่อ่านจาก cache ได้:  ${fmt(totals.callsWithRead)} (${(callHitRate * 100).toFixed(1)}%)\n`);

console.log('prompt tokens:');
console.log(`  จ่ายเต็มราคา (input):     ${fmt(totals.fresh)}`);
console.log(`  อ่านจาก cache:            ${fmt(totals.read)}`);
console.log(`  เขียน cache:              ${fmt(totals.written)}`);
console.log(`  รวม:                      ${fmt(promptTokens)}`);
console.log(`\ncache hit rate (ตาม token): ${(hitRate * 100).toFixed(1)}%\n`);

const saved = uncached - paid;
console.log(`ค่าใช้จ่ายจริง (input):        $${cost(paid).toFixed(4)}  ≈ ฿${baht(cost(paid)).toFixed(2)}`);
console.log(`ถ้าไม่ใช้ cache เลย:          $${cost(uncached).toFixed(4)}  ≈ ฿${baht(cost(uncached)).toFixed(2)}`);

if (saved > 0) {
  console.log(`\n✅ ประหยัดได้ $${cost(saved).toFixed(4)} ≈ ฿${baht(cost(saved)).toFixed(2)} (${((saved / uncached) * 100).toFixed(1)}%)`);
  const perCall = baht(cost(saved)) / totals.calls;
  console.log(`   เฉลี่ย ฿${perCall.toFixed(4)}/call — ต่อ 1,000 คำถามประหยัด ~฿${(perCall * 1000).toFixed(0)}`);
  if (CACHE_WRITE_MULTIPLIER === 1.25 && callHitRate > 0.66) {
    console.log(
      '\n💡 hit rate เกิน 2 ใน 3 ของ call แล้ว — ลองเปลี่ยนเป็น ANTHROPIC_CACHE_TTL=1h ดู\n' +
        '   (write แพงขึ้นเป็น ×2 แต่คุ้มถ้า prefix เดิมถูกใช้ซ้ำเกิน 3 ครั้ง)',
    );
  }
  process.exit(0);
}

console.log(`\n⚠️  cache กำลังทำให้แพงขึ้น $${cost(-saved).toFixed(4)} ≈ ฿${baht(cost(-saved)).toFixed(2)}`);
console.log(
  'สาเหตุที่พบบ่อย: มีอะไรใน prefix เปลี่ยนทุก request (ลำดับไฟล์ที่ขึ้นกับคำถาม,\n' +
    'timestamp, key ของ object ที่ไม่ deterministic) หรือคำถามส่วนใหญ่เป็นคำถามเดียวจบ\n' +
    'ถ้าเป็นอย่างหลัง การปิด cache จะถูกกว่า',
);
process.exit(1);
