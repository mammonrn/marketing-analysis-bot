/**
 * Prompt caching only works if the prefix is byte-identical between requests,
 * so that is what these tests assert — not that a `cache_control` key exists,
 * but that the bytes ahead of it actually repeat.
 *
 * The bug they lock down: the data context used to be ordered by the question's
 * keyword match, so two questions about the same site and month produced two
 * different prefixes and ~36k tokens were re-billed at full price every turn.
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

function lastMonth(from = new Date()) {
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() - 1, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
const MONTH = lastMonth();

const FILES = [
  ['Daily Value.xlsx', ['Date', 'RTP', 'DAU', 'BIn', 'R'], (i) => ({
    Date: `${MONTH}-0${i + 1}`, RTP: 0.95, DAU: 470, BIn: 400, R: 88,
  })],
  ['Referrer.xlsx', ['Referrer', 'Ref Bonus', 'Total Mems', 'BIn', 'R'], (i) => ({
    Referrer: `r${i}`, 'Ref Bonus': 3, 'Total Mems': 40, BIn: 88, R: 14,
  })],
  ['Vip.xlsx', ['Username', 'Last BIn 2 Y', 'BIn', 'R'], (i) => ({
    Username: `m${i}`, 'Last BIn 2 Y': i, BIn: 36, R: 6,
  })],
];

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ads-analytics-cache-'));
  process.env.DATA_DIR = tmpDir;

  db = await import('../src/data/db.js');
  db.initDataDb(path.join(tmpDir, 'test.sqlite'));
  ingest = await import('../src/data/ingest.js');
  query = await import('../src/data/query.js');

  for (const [index, [name, headers, gen]] of FILES.entries()) {
    const buffer = workbookBuffer(headers, Array.from({ length: 5 }, (_, i) => gen(i)));
    const result = await ingest.ingestUpload({
      buffer,
      originalFilename: name,
      fileSize: buffer.length + index,
      chatId: 'cache-chat',
      captionText: `SH666 ${MONTH}`,
    });
    assert.equal(result.status, 'saved', `${name} uploaded`);
  }
});

after(() => {
  db?.closeDataDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// --- the cacheable prefix ----------------------------------------------------

test('the same site and month give a byte-identical context for different questions', async () => {
  const a = await query.buildDataContext('shwe666', 'referrer คนไหนสร้างมูลค่าจริง');
  const b = await query.buildDataContext('shwe666', 'VIP active เท่าไหร่');
  const c = await query.buildDataContext('shwe666', 'สรุปภาพรวมให้หน่อย');

  assert.equal(a, b, 'a keyword match must not reorder the context');
  assert.equal(a, c);
  assert.ok(a.length > 0);
});

test('a different site gives a different context — the cache should miss', async () => {
  const buffer = workbookBuffer(FILES[0][1], Array.from({ length: 5 }, (_, i) => FILES[0][2](i)));
  await ingest.ingestUpload({
    buffer,
    originalFilename: 'Daily Value U89.xlsx',
    fileSize: buffer.length + 99,
    chatId: 'cache-chat-2',
    captionText: `U89 ${MONTH}`,
  });

  const sh = await query.buildDataContext('shwe666', 'ภาพรวม');
  const u89 = await query.buildDataContext('ubet89', 'ภาพรวม');
  assert.notEqual(sh, u89, 'different sites must not share a cached prefix');
});

test('the relevance hint is a pure function of the question', async () => {
  const { relevanceHint } = query;
  assert.equal(relevanceHint('referrer คนไหนดี'), relevanceHint('referrer คนไหนดี'));
  assert.notEqual(relevanceHint('referrer คนไหนดี'), relevanceHint('VIP เป็นยังไง'));
  assert.match(relevanceHint('VIP เป็นยังไง'), /VIP Members/);
});

// --- the message the API actually receives -----------------------------------

test('the data block leads and carries the breakpoint; question and turns follow', async () => {
  const { __testing } = await import('../src/claude/client.js');
  const dataContext = await query.buildDataContext('shwe666', 'ภาพรวม');

  const messages = __testing.buildMessages({
    question: 'ภาพรวมเดือนนี้',
    dataContext,
    turns: [{ ts: Date.now(), site: 'shwe666', question: 'ก่อนหน้า', metrics: [] }],
    isSummary: false,
  });

  assert.equal(messages.length, 1);
  const blocks = messages[0].content;
  assert.ok(Array.isArray(blocks), 'the user turn is split into blocks');
  assert.equal(blocks.length, 2);

  // Stable first, marked; volatile second, unmarked.
  assert.ok(blocks[0].text.includes('ข้อมูลจริงจากไฟล์ Excel'));
  assert.deepEqual(blocks[0].cache_control, { type: 'ephemeral' });
  assert.equal(blocks[1].cache_control, undefined);

  // The question and the history must be after the breakpoint, never inside it.
  assert.ok(!blocks[0].text.includes('ภาพรวมเดือนนี้'), 'the question is not in the cached block');
  assert.ok(!blocks[0].text.includes('ก่อนหน้า'), 'session history is not in the cached block');
  assert.ok(blocks[1].text.includes('ภาพรวมเดือนนี้'));
  assert.ok(blocks[1].text.includes('ก่อนหน้า'));
});

test('two questions in one session produce an identical cached block', async () => {
  const { __testing } = await import('../src/claude/client.js');
  const dataContext = await query.buildDataContext('shwe666', 'ภาพรวม');

  const first = __testing.buildMessages({
    question: 'RTP เท่าไหร่', dataContext, turns: [], isSummary: false,
  });
  const second = __testing.buildMessages({
    question: 'แล้ว VIP ล่ะ',
    dataContext: await query.buildDataContext('shwe666', 'แล้ว VIP ล่ะ'),
    turns: [{ ts: Date.now(), site: 'shwe666', question: 'RTP เท่าไหร่', metrics: [] }],
    isSummary: false,
  });

  assert.equal(
    first[0].content[0].text,
    second[0].content[0].text,
    'the follow-up must reuse the first request cached block verbatim',
  );
  assert.notEqual(first[0].content[1].text, second[0].content[1].text);
});

test('a data context too small to repay a breakpoint is sent uncached', async () => {
  const { __testing } = await import('../src/claude/client.js');
  const messages = __testing.buildMessages({
    question: 'ภาพรวม', dataContext: 'สั้นมาก', turns: [], isSummary: false,
  });
  assert.equal(messages[0].content[0].cache_control, undefined);
  assert.ok(messages[0].content[0].text.includes('สั้นมาก'), 'but the data still goes through');
});

test('no data context at all still produces a valid single-string message', async () => {
  const { __testing } = await import('../src/claude/client.js');
  const messages = __testing.buildMessages({
    question: 'ภาพรวม', dataContext: null, turns: [], isSummary: false,
  });
  assert.equal(typeof messages[0].content, 'string');
  assert.ok(messages[0].content.includes('ภาพรวม'));
  assert.ok(messages[0].content.includes('ไม่มีข้อมูลไฟล์'));
});

test('the 1h TTL is opt-in via config', async () => {
  const { __testing } = await import('../src/claude/client.js');
  const dataContext = await query.buildDataContext('shwe666', 'ภาพรวม');
  const { config } = await import('../src/config.js');

  const original = config.anthropic.cacheTtl;
  try {
    config.anthropic.cacheTtl = '1h';
    const messages = __testing.buildMessages({
      question: 'x', dataContext, turns: [], isSummary: false,
    });
    assert.deepEqual(messages[0].content[0].cache_control, { type: 'ephemeral', ttl: '1h' });
  } finally {
    config.anthropic.cacheTtl = original;
  }
});

// --- regression: the answer must not change ---------------------------------

test('every piece of the old single-string prompt is still present', async () => {
  const { __testing } = await import('../src/claude/client.js');
  const dataContext = await query.buildDataContext('shwe666', 'ภาพรวม');

  const messages = __testing.buildMessages({
    question: 'RTP เท่าไหร่',
    dataContext,
    turns: [{ ts: Date.now(), site: 'shwe666', question: 'ก่อนหน้า', metrics: [{ name: 'RTP', value: '95%' }] }],
    isSummary: false,
  });
  const whole = messages[0].content.map((b) => b.text).join('\n\n');

  for (const fragment of [
    'ข้อมูลจริงจากไฟล์ Excel',
    'ห้ามเดาตัวเลขเพิ่ม',
    'บริบทก่อนหน้าใน session นี้',
    'RTP=95%',
    'คำถามของผู้ใช้',
    'RTP เท่าไหร่',
    'ตอบกลับเป็น JSON object เดียวตาม bot delivery contract เท่านั้น',
  ]) {
    assert.ok(whole.includes(fragment), `"${fragment}" survived the split`);
  }
});

test('a summary call keeps every turn and skips the question section', async () => {
  const { __testing } = await import('../src/claude/client.js');
  const messages = __testing.buildMessages({
    question: '',
    dataContext: null,
    turns: [
      { ts: Date.now(), site: 'shwe666', question: 'q1', metrics: [] },
      { ts: Date.now(), site: 'shwe666', question: 'q2', metrics: [] },
    ],
    isSummary: true,
  });
  const whole = typeof messages[0].content === 'string'
    ? messages[0].content
    : messages[0].content.map((b) => b.text).join('\n\n');

  assert.ok(whole.includes('SESSION_SUMMARY_REQUEST'));
  assert.ok(whole.includes('q1') && whole.includes('q2'));
  assert.ok(!whole.includes('คำถามของผู้ใช้'));
});
