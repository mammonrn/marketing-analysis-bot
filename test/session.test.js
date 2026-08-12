import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// config.js throws on missing credentials by design, and store.js imports it, so
// the env has to exist before the module graph is evaluated — hence dynamic import.
process.env.TELEGRAM_BOT_TOKEN ??= 'test-token';
process.env.ANTHROPIC_API_KEY ??= 'test-key';

let store;
let tmpDir;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ads-analytics-test-'));
  store = await import('../src/session/store.js');
  store.initDb(path.join(tmpDir, 'test.sqlite'));
});

after(() => {
  store?.closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('creates a session once and returns the same row after', () => {
  const first = store.getOrCreateSession('chat-1', 'user-1');
  const second = store.getOrCreateSession('chat-1', 'user-1');
  assert.equal(first.chat_id, 'chat-1');
  assert.equal(first.user_id, 'user-1');
  assert.equal(first.site, null);
  assert.equal(first.created_at, second.created_at, 'no duplicate row was inserted');
});

test('remembers the site so follow-ups need not repeat it', () => {
  store.getOrCreateSession('chat-2', 'user-1');
  store.setSessionSite('chat-2', 'ubet89');
  assert.equal(store.getSession('chat-2').site, 'ubet89');

  // A null/empty site must not wipe what we already know.
  store.setSessionSite('chat-2', null);
  assert.equal(store.getSession('chat-2').site, 'ubet89');
});

test('records turns with their metrics', () => {
  store.getOrCreateSession('chat-3', 'user-1');
  store.addTurn('chat-3', {
    question: 'RTP เท่าไหร่',
    site: 'shwe666',
    metrics: [{ name: 'RTP', value: '96.1%', status: 'ปกติ' }],
    reply: 'RTP 96.1%',
    responseKind: 'metric',
  });
  store.addTurn('chat-3', { question: 'DAU ล่ะ', site: 'shwe666', metrics: [] });

  const turns = store.getTurns('chat-3');
  assert.equal(turns.length, 2);
  assert.equal(store.countTurns('chat-3'), 2);
  assert.equal(turns[0].metrics[0].name, 'RTP');
  assert.deepEqual(turns[1].metrics, []);
  assert.ok(turns[0].ts <= turns[1].ts, 'turns come back in order');
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

test('idle detection only picks sessions that have turns', async () => {
  store.getOrCreateSession('chat-idle', 'user-1');
  store.addTurn('chat-idle', { question: 'ถามอะไรไว้', site: 'shwe666', metrics: [] });
  // Nothing is idle at 20 minutes yet.
  assert.equal(store.findIdleSessions(20).some((s) => s.chat_id === 'chat-idle'), false);

  // last_active must be strictly in the past for a 0-minute cutoff to catch it.
  await tick();

  // A 0-minute threshold treats everything as idle.
  assert.equal(store.findIdleSessions(0).some((s) => s.chat_id === 'chat-idle'), true);

  // An empty session has no session to close.
  store.getOrCreateSession('chat-empty', 'user-1');
  assert.equal(store.findIdleSessions(0).some((s) => s.chat_id === 'chat-empty'), false);

  // Closing it takes it out of the sweep — this is what stops the sweeper from
  // announcing the same close every minute, now that nothing keeps a flag.
  store.clearSession('chat-idle');
  await tick();
  assert.equal(store.findIdleSessions(0).some((s) => s.chat_id === 'chat-idle'), false);

  // A new question re-arms it.
  store.addTurn('chat-idle', { question: 'ถามใหม่', site: 'shwe666', metrics: [] });
  store.touchSession('chat-idle');
  await tick();
  assert.equal(store.findIdleSessions(0).some((s) => s.chat_id === 'chat-idle'), true);
});

test('clearing a session archives its turns rather than dropping them', () => {
  store.getOrCreateSession('chat-4', 'user-1');
  // The site lives on the session, not on the turn — bot.js sets both.
  store.setSessionSite('chat-4', 'ubet89');
  store.addTurn('chat-4', { question: 'q1', site: 'ubet89', metrics: [] });
  store.addTurn('chat-4', { question: 'q2', site: 'ubet89', metrics: [] });

  store.clearSession('chat-4');

  assert.equal(store.countTurns('chat-4'), 0, 'live turns are gone');
  assert.ok(store.getSession('chat-4'), 'the session row itself survives');
  // The site is retained, so the next question continues where they left off.
  assert.equal(store.getSession('chat-4').site, 'ubet89');
});

test('summary tokens round-trip and are unguessable', () => {
  store.getOrCreateSession('chat-5', 'user-1');
  const payload = { summaryText: 'สรุป', chart: { type: 'bar', labels: ['a'], datasets: [] } };
  const token = store.createSummaryToken('chat-5', payload);

  assert.ok(token.length >= 32, 'token is long enough to not be guessable');
  assert.deepEqual(store.readSummary(token), payload);
  assert.equal(store.readSummary('not-a-real-token'), null);
});

test('an expired token reads as missing', async () => {
  const token = store.createSummaryToken('chat-5', { summaryText: 'x' });
  await tick();
  assert.equal(store.readSummary(token, { maxAgeMinutes: 0 }), null);
});
