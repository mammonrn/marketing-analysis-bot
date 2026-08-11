/**
 * The monthly dashboard link.
 *
 * What makes it different from the session token next door: it is keyed by
 * (site, month) so the same URL comes back every time, it lives for weeks
 * instead of an hour, and it survives being copied out of a forwarded message.
 * Each of those is a property someone could quietly undo, so each is pinned
 * here.
 */

import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.TELEGRAM_BOT_TOKEN ??= 'test-token';
process.env.ANTHROPIC_API_KEY ??= 'test-key';

let tmpDir;
let store;

const payloadFor = (yearMonth, bin) => ({ kind: 'monthly', yearMonth, sections: [], bin });

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ads-analytics-monthly-token-'));
  store = await import('../src/session/store.js');
  store.initDb(path.join(tmpDir, 'test.sqlite'));
});

/* A negative TTL means "everything is already expired" — used instead of 0 so
   a row written in the same millisecond as the sweep still counts as stale. */
beforeEach(() => {
  store.pruneOldData({ monthlyLinkDays: -1 });
});

after(() => {
  store?.closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('the same site and month hand back the same token', () => {
  const first = store.createMonthlyDashboardToken({
    site: 'shwe666',
    yearMonth: '2026-07',
    chatId: 'chat-1',
    payload: payloadFor('2026-07', 1),
  });
  const second = store.createMonthlyDashboardToken({
    site: 'shwe666',
    yearMonth: '2026-07',
    chatId: 'chat-2',
    payload: payloadFor('2026-07', 2),
  });

  assert.equal(second, first, 'a second run must not invalidate the link already forwarded');
  assert.equal(store.readMonthlyDashboard(first).bin, 2, 'and the data behind it is the fresh run');
});

test('a different site or a different month is a different link', () => {
  const july = store.createMonthlyDashboardToken({
    site: 'shwe666',
    yearMonth: '2026-07',
    payload: payloadFor('2026-07'),
  });
  const august = store.createMonthlyDashboardToken({
    site: 'shwe666',
    yearMonth: '2026-08',
    payload: payloadFor('2026-08'),
  });
  const otherSite = store.createMonthlyDashboardToken({
    site: 'ubet89',
    yearMonth: '2026-07',
    payload: payloadFor('2026-07'),
  });

  assert.notEqual(july, august);
  assert.notEqual(july, otherSite);
  assert.equal(store.readMonthlyDashboard(august).yearMonth, '2026-08');
});

test('the token is long, unguessable, and safe to print into a Markdown message', () => {
  const token = store.createMonthlyDashboardToken({
    site: 'shwe666',
    yearMonth: '2026-07',
    payload: payloadFor('2026-07'),
  });

  // 32 random bytes as hex. Hex specifically: base64url's `_` and `-` are what
  // Telegram's Markdown parser mangles when the URL is printed as text.
  assert.equal(token.length, 64);
  assert.match(token, /^[0-9a-f]{64}$/);
});

test('a link stops resolving once it is past its TTL', () => {
  const token = store.createMonthlyDashboardToken({
    site: 'shwe666',
    yearMonth: '2026-07',
    payload: payloadFor('2026-07'),
  });

  assert.ok(store.readMonthlyDashboard(token, { ttlDays: 60 }));
  assert.equal(store.readMonthlyDashboard(token, { ttlDays: -1 }), null);
});

test('an expired link is replaced rather than revived', () => {
  const original = store.createMonthlyDashboardToken(
    { site: 'shwe666', yearMonth: '2026-07', payload: payloadFor('2026-07') },
    { ttlDays: 60 },
  );
  const reissued = store.createMonthlyDashboardToken(
    { site: 'shwe666', yearMonth: '2026-07', payload: payloadFor('2026-07') },
    { ttlDays: 0 },
  );

  assert.notEqual(reissued, original);
  assert.equal(store.readMonthlyDashboard(original), null, 'the old URL must not come back to life');
  assert.ok(store.readMonthlyDashboard(reissued));
});

test('an unknown token reads as nothing, not as an error', () => {
  assert.equal(store.readMonthlyDashboard('not-a-real-token'), null);
  assert.equal(store.readMonthlyDashboard(undefined), null);
});

test('a site and a month are both required', () => {
  assert.throws(() => store.createMonthlyDashboardToken({ site: 'shwe666', payload: {} }));
  assert.throws(() => store.createMonthlyDashboardToken({ yearMonth: '2026-07', payload: {} }));
});

test('pruning keeps live links and drops dead ones', () => {
  const token = store.createMonthlyDashboardToken({
    site: 'shwe666',
    yearMonth: '2026-07',
    payload: payloadFor('2026-07'),
  });

  store.pruneOldData({ monthlyLinkDays: 60 });
  assert.ok(store.readMonthlyDashboard(token), 'a link inside its TTL survives housekeeping');

  store.pruneOldData({ monthlyLinkDays: -1 });
  assert.equal(store.readMonthlyDashboard(token), null);
});

test('the session token is untouched: still single-purpose and short-lived', () => {
  // The per-question "ดูกราฟ" button shares none of the above and must not
  // have picked any of it up.
  store.getOrCreateSession('chat-9', 'user-9');
  const first = store.createSummaryToken('chat-9', { summaryText: 'a' });
  const second = store.createSummaryToken('chat-9', { summaryText: 'b' });

  assert.notEqual(second, first, 'session tokens stay per-request');
  assert.equal(store.readSummary(first).summaryText, 'a');
  assert.equal(store.readSummary(first, { maxAgeMinutes: -1 }), null, 'and still expire on a clock');
});
