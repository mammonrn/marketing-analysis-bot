/**
 * The PIN gate in front of the monthly dashboard.
 *
 * The reason it exists is the reason these cases are worth having: the monthly
 * URL is printed in plain text so it survives a forward, which means the token
 * is no longer a secret and the PIN is the only thing between a leaked link
 * and a month of figures.
 *
 * Driven through the real router over a real socket, because half of what is
 * being checked (the cookie attributes, the status codes the page branches on)
 * only exists at the HTTP layer.
 */

import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

process.env.TELEGRAM_BOT_TOKEN ??= 'test-token';
process.env.ANTHROPIC_API_KEY ??= 'test-key';

const PIN = '482913';

let tmpDir;
let store;
let pin;
let server;
let base;
let token;
let configuredHash;

const MONTHLY_PAYLOAD = {
  kind: 'monthly',
  site: 'shwe666',
  siteName: 'SH666',
  yearMonth: '2026-07',
  sections: [{ id: 'overview', title: 'Overview', available: true, kpis: [], charts: [], tables: [] }],
  missingFiles: [],
};

/** The bit of a Set-Cookie header a browser would send back. */
function cookieFrom(res) {
  const header = res.headers.getSetCookie?.()[0] ?? res.headers.get('set-cookie');
  return String(header ?? '').split(';')[0];
}

function submitPin(value, cookie) {
  return fetch(`${base}/api/dashboard/pin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify({ pin: value }),
  });
}

const fetchMonthly = (cookie) =>
  fetch(`${base}/api/monthly/${token}`, { headers: cookie ? { cookie } : {} });

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ads-analytics-pin-'));

  pin = await import('../src/miniapp/pin.js');
  // Hashed here rather than pasted in as a fixture: a hash checked into the
  // repo would be a real PIN sitting in git, and this also exercises the same
  // hashPin/verifyPin pair the operator runs from scripts/hash-pin.mjs.
  configuredHash = pin.hashPin(PIN);
  process.env.DASHBOARD_PIN_HASH = configuredHash;

  const { createRouter } = await import('../src/miniapp/routes.js');
  store = await import('../src/session/store.js');
  store.initDb(path.join(tmpDir, 'test.sqlite'));
  token = store.createMonthlyDashboardToken({
    site: 'shwe666',
    yearMonth: '2026-07',
    chatId: 'chat-1',
    payload: MONTHLY_PAYLOAD,
  });

  const app = express();
  app.use(createRouter());
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => {
  // The limiter is process-wide, keyed by IP, and every case here comes from
  // 127.0.0.1 — without this the lockout case would poison its neighbours.
  pin.resetPinFailures();
  process.env.DASHBOARD_PIN_HASH = configuredHash;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  store?.closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// --- the gate ---------------------------------------------------------------

test('no PIN, no data', async () => {
  const res = await fetchMonthly();
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error, 'pin_required');
});

test('the right PIN opens the dashboard and stays open for the session', async () => {
  const unlock = await submitPin(PIN);
  assert.equal(unlock.status, 200);

  const setCookie = unlock.headers.getSetCookie?.()[0] ?? unlock.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly/, 'the cookie is not readable from page scripts');
  assert.match(setCookie, /SameSite=Lax/, 'and survives arriving from a Telegram link');

  const res = await fetchMonthly(cookieFrom(unlock));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await res.json(), MONTHLY_PAYLOAD);
});

test('the wrong PIN is refused and counted', async () => {
  const first = await submitPin('000000');
  assert.equal(first.status, 401);

  const body = await first.json();
  assert.equal(body.error, 'bad_pin');
  assert.equal(body.attemptsLeft, 4);
  assert.equal(first.headers.get('set-cookie'), null, 'a failed attempt hands out nothing');

  const second = await submitPin('000001');
  assert.equal((await second.json()).attemptsLeft, 3, 'consecutive failures accumulate');
});

test('a made-up cookie does not pass', async () => {
  const forged = await fetchMonthly('dash_pin=99999999999999.abcdefg.notarealsignature');
  assert.equal(forged.status, 401);

  // A well-formed value whose expiry has passed is refused the same way.
  const expired = pin.mintPinSession({ ttlMs: -1000 });
  assert.equal(pin.verifyPinSession(expired), false);
  assert.equal((await fetchMonthly(`dash_pin=${expired}`)).status, 401);
});

test('rotating the PIN invalidates the cookies issued against the old one', async () => {
  const unlock = await submitPin(PIN);
  const cookie = cookieFrom(unlock);
  assert.equal((await fetchMonthly(cookie)).status, 200);

  process.env.DASHBOARD_PIN_HASH = pin.hashPin('999999');
  assert.equal((await fetchMonthly(cookie)).status, 401);
});

// --- brute force ------------------------------------------------------------

test('guessing gets locked out, and the lockout outranks a correct PIN', async () => {
  for (let i = 0; i < 4; i += 1) {
    assert.equal((await submitPin(`bad-${i}`)).status, 401);
  }

  const fifth = await submitPin('bad-4');
  assert.equal(fifth.status, 429, 'the fifth consecutive miss locks the client out');
  const body = await fifth.json();
  assert.equal(body.error, 'locked');
  assert.ok(body.retryAfterSeconds > 0);

  // The point of the lockout: it holds even for someone who then gets it right,
  // otherwise it would only slow down a guesser who never succeeds.
  const correct = await submitPin(PIN);
  assert.equal(correct.status, 429);
  assert.equal(correct.headers.get('set-cookie'), null);
});

test('a correct PIN clears the failures behind it', async () => {
  await submitPin('nope');
  await submitPin('nope');
  assert.equal((await submitPin(PIN)).status, 200);

  const afterSuccess = await submitPin('nope');
  assert.equal((await afterSuccess.json()).attemptsLeft, 4, 'the counter restarts, so 5 must be consecutive');
});

test('the lockout state is visible to the page without spending an attempt', async () => {
  const before = await fetch(`${base}/api/dashboard/session`);
  assert.deepEqual(await before.json(), {
    configured: true,
    authenticated: false,
    locked: false,
    retryAfterSeconds: 0,
  });

  for (let i = 0; i < 5; i += 1) await submitPin('bad');

  const during = await (await fetch(`${base}/api/dashboard/session`)).json();
  assert.equal(during.locked, true);
  assert.ok(during.retryAfterSeconds > 0);
});

// --- configuration ----------------------------------------------------------

test('an unset PIN fails closed rather than publishing the month', async () => {
  delete process.env.DASHBOARD_PIN_HASH;

  const res = await fetchMonthly();
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error, 'pin_not_configured');

  const attempt = await submitPin('anything');
  assert.equal(attempt.status, 503);
});

test('a malformed hash in the env is not a PIN that anything matches', async () => {
  process.env.DASHBOARD_PIN_HASH = 'not-a-scrypt-hash';

  assert.equal(pin.isPinConfigured(), false);
  assert.equal(pin.verifyPin(PIN), false);
  assert.equal((await fetchMonthly()).status, 503);
});

// --- the page itself --------------------------------------------------------

test('the page ships the PIN form and none of the data', async () => {
  const res = await fetch(`${base}/miniapp/monthly?token=${token}`);
  assert.equal(res.status, 200);

  const html = await res.text();
  assert.ok(html.includes('id="pin-gate"'), 'the gate is part of the shell');
  assert.ok(html.includes('id="pin-input"'));
  assert.equal(html.includes('SH666'), false, 'the shell carries no payload of its own');
});

// --- the hash ---------------------------------------------------------------

test('the PIN is stored as a salted scrypt hash, never as itself', () => {
  const hash = pin.hashPin(PIN);

  assert.match(hash, /^scrypt\$\d+\$\d+\$\d+\$[^$]+\$[^$]+$/);
  assert.equal(hash.includes(PIN), false, 'the PIN does not appear in its own hash');
  assert.notEqual(pin.hashPin(PIN), hash, 'a fresh salt every time, so equal PINs do not look equal');

  assert.equal(pin.verifyPin(PIN, hash), true);
  assert.equal(pin.verifyPin('482914', hash), false);
  assert.equal(pin.verifyPin('', hash), false);
  assert.throws(() => pin.hashPin(''));
});
