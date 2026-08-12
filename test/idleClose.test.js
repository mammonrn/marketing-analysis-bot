/**
 * What happens when a session goes quiet.
 *
 * The behaviour changed from "ask whether to summarise" to "close it and say
 * so", and the two halves have to stay together: the message claims the session
 * is closed, so the test checks the state as well as the words. It also checks
 * what must *not* happen — no buttons, and no summary built off the back of a
 * timeout.
 */

import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

process.env.TELEGRAM_BOT_TOKEN ??= 'test-token';
process.env.ANTHROPIC_API_KEY ??= 'test-key';
process.env.SESSION_IDLE_MINUTES ??= '20';

let tmpDir;
let store;
let summary;

const CHAT = 'chat-idle-close';

/** Records what would have been sent, and can be told to fail. */
function makeTelegram({ fail = false } = {}) {
  const sent = [];
  return {
    sent,
    async sendMessage(chatId, text, options) {
      if (fail) throw new Error('Forbidden: bot was blocked by the user');
      sent.push({ chatId, text, options });
    },
    async sendChatAction() {},
  };
}

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ads-analytics-idle-'));
  store = await import('../src/session/store.js');
  summary = await import('../src/session/summary.js');
  store.initDb(path.join(tmpDir, 'test.sqlite'));
});

beforeEach(() => {
  store.getOrCreateSession(CHAT, 'user-1');
  store.clearSession(CHAT);
});

after(() => {
  store?.closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function seedTurns() {
  store.setSessionSite(CHAT, 'shwe666');
  store.addTurn(CHAT, { question: 'RTP ของ SH666 เป็นยังไง', site: 'shwe666', metrics: [] });
  store.addTurn(CHAT, { question: 'BIn เดือนนี้', site: 'shwe666', metrics: [] });
}

test('the timeout closes the session and reports it, with no question attached', async () => {
  seedTurns();
  const telegram = makeTelegram();

  assert.equal(await summary.closeIdleSession(telegram, CHAT), true);
  assert.equal(telegram.sent.length, 1, 'exactly one message, not a message per turn');

  const { text } = telegram.sent[0];
  assert.match(text, /^✅ session นี้ปิดอัตโนมัติแล้ว \(ไม่มีคำถามใหม่เกิน 20 นาที\)$/m);
  assert.match(text, /คุยกันไปทั้งหมด \*2 คำถาม\* \(เว็บ: SH666\)/);
  assert.match(text, /พิมพ์คำถามใหม่ได้เลยครับ เดี๋ยวเปิด session ใหม่ให้/);

  // The old flow ended in a question; this one must not.
  assert.equal(/ไหมครับ\?/.test(text), false);
  assert.equal(/dashboard/i.test(text), false);
});

test('no buttons come with it', async () => {
  seedTurns();
  const telegram = makeTelegram();

  await summary.closeIdleSession(telegram, CHAT);

  const { options } = telegram.sent[0];
  assert.equal(options?.reply_markup, undefined, 'nothing to leave a stale button behind');
  assert.equal(JSON.stringify(options ?? {}).includes('summary:'), false);
});

test('the session really is closed, not just described as closed', async () => {
  seedTurns();
  const telegram = makeTelegram();

  await summary.closeIdleSession(telegram, CHAT);

  assert.equal(store.countTurns(CHAT), 0, 'the live turns are gone');
  assert.equal(store.getTurns(CHAT).length, 0);
  assert.ok(store.getSession(CHAT), 'the session row survives, as /สรุป already did');
  assert.equal(store.getSession(CHAT).site, 'shwe666', 'and the remembered site with it');
});

test('the turns are archived, not thrown away', async () => {
  // Read the archive through a second connection, since the store exposes no
  // accessor for it: an auto-closed session must leave the same trail a /สรุป
  // one does, or the session reports lose every conversation nobody wrapped up.
  const db = new Database(path.join(tmpDir, 'test.sqlite'), { readonly: true });
  const questions = () =>
    db
      .prepare('SELECT question FROM turn_archive WHERE chat_id = ? ORDER BY archived_at, id')
      .all(CHAT)
      .map((row) => row.question);

  const before = questions().length;
  seedTurns();
  await summary.closeIdleSession(makeTelegram(), CHAT);

  const after = questions();
  db.close();

  assert.equal(after.length, before + 2);
  assert.deepEqual(after.slice(-2), ['RTP ของ SH666 เป็นยังไง', 'BIn เดือนนี้']);
});

test('an empty session is left alone', async () => {
  const telegram = makeTelegram();

  assert.equal(await summary.closeIdleSession(telegram, CHAT), false);
  assert.equal(telegram.sent.length, 0, 'nobody gets told a session ended that never started');
});

test('a chat that cannot be messaged still gets closed', async () => {
  seedTurns();

  await assert.rejects(() => summary.closeIdleSession(makeTelegram({ fail: true }), CHAT));

  // Closing before announcing is what makes this true, and it is what keeps the
  // sweeper from retrying a blocked chat once a minute forever.
  assert.equal(store.countTurns(CHAT), 0);
});

test('the sweeper closes each idle session once', async () => {
  seedTurns();
  const telegram = makeTelegram();

  // The real query, at a 0-minute threshold, so "idle" is whatever has turns.
  const findIdleSessions = () => store.findIdleSessions(0);
  await new Promise((resolve) => setTimeout(resolve, 5));

  const timer = summary.startIdleSweeper(telegram, { findIdleSessions, intervalMs: 10 });
  await new Promise((resolve) => setTimeout(resolve, 60));
  clearInterval(timer);

  assert.equal(telegram.sent.length, 1, 'six sweeps, one message — a closed session drops out');
  assert.match(telegram.sent[0].text, /ปิดอัตโนมัติแล้ว/);
  assert.equal(store.countTurns(CHAT), 0);
});

test('a summary is still available on request', async () => {
  // The timeout no longer builds one, so the explicit paths are the only ones
  // left — runSummary is what /สรุป, /จบ and the menu button call.
  assert.equal(typeof summary.runSummary, 'function');
  assert.equal(summary.SUMMARY_YES, undefined, 'the callback ids are gone with the buttons');
  assert.equal(summary.SUMMARY_NO, undefined);
  assert.equal(summary.offerSummary, undefined, 'and so is the ask-first entry point');
});
