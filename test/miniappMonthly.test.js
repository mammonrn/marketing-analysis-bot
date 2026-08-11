import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

process.env.TELEGRAM_BOT_TOKEN ??= 'test-token';
process.env.ANTHROPIC_API_KEY ??= 'test-key';

const PIN = '135790';

let tmpDir;
let store;
let server;
let base;
let unlocked;

const MONTHLY_PAYLOAD = {
  kind: 'monthly',
  generatedAt: '2026-08-08T00:00:00.000Z',
  site: 'shwe666',
  siteName: 'SH666',
  yearMonth: '2026-07',
  currency: { currency: 'MMK', scaleFactor: 1000, fxRate: 0.787, fxRateAsOf: '2026-08-07', needsFxConversion: true },
  missingFiles: [{ fileType: 'referrer', label: 'Referrer' }],
  sections: [
    {
      id: 'overview',
      title: 'Overview',
      fileType: 'daily_value',
      fileLabel: 'Daily Value',
      available: true,
      rowCount: 31,
      kpis: [{ label: 'BIn รวมทั้งเดือน', value: 472200, unit: 'thb' }],
      charts: [
        {
          id: 'overview-daily',
          type: 'line',
          title: 'BIn รายวัน',
          labels: ['1', '2'],
          datasets: [{ label: 'BIn', unit: 'thb', data: [78700, 157400] }],
        },
      ],
      tables: [],
    },
  ],
};

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ads-analytics-miniapp-'));
  process.env.DATA_DIR = tmpDir;

  // The monthly data route is behind the PIN gate; dashboardPin.test.js owns
  // the gate's own behaviour, this file just needs to be able to get past it.
  const pin = await import('../src/miniapp/pin.js');
  process.env.DASHBOARD_PIN_HASH = pin.hashPin(PIN);
  unlocked = `dash_pin=${pin.mintPinSession()}`;

  const { createRouter } = await import('../src/miniapp/routes.js');
  store = await import('../src/session/store.js');
  store.initDb(path.join(tmpDir, 'test.sqlite'));
  store.getOrCreateSession('chat-1', 'user-1');

  const app = express();
  app.use(createRouter());
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  store?.closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('/miniapp/monthly serves the monthly page, not the session one', async () => {
  const res = await fetch(`${base}/miniapp/monthly`);
  assert.equal(res.status, 200);

  const html = await res.text();
  assert.ok(html.includes('assets/monthly.js'), 'the monthly renderer is loaded');
  assert.ok(html.includes('vendor/chart.umd.min.js'), 'the existing vendored Chart.js is reused');
  assert.ok(html.includes('id="tabs"'), 'the tab strip is present');
  assert.equal(html.includes('assets/app.js'), false, 'the session renderer is not pulled in');
});

test('the session dashboard is untouched by the new route', async () => {
  const res = await fetch(`${base}/miniapp`);
  assert.equal(res.status, 200);

  const html = await res.text();
  assert.ok(html.includes('assets/app.js'));
  assert.equal(html.includes('assets/monthly.js'), false);
});

test('the monthly renderer is served as a static asset', async () => {
  const res = await fetch(`${base}/miniapp/assets/monthly.js`);
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.ok(body.includes('formatThb'), 'money formatting is in the bundle');
});

test('a monthly payload round-trips through the monthly route unchanged', async () => {
  const token = store.createMonthlyDashboardToken({
    site: 'shwe666',
    yearMonth: '2026-07',
    chatId: 'chat-1',
    payload: MONTHLY_PAYLOAD,
  });

  const res = await fetch(`${base}/api/monthly/${token}`, { headers: { cookie: unlocked } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await res.json(), MONTHLY_PAYLOAD);
});

test('a bad or expired monthly token is refused even by an unlocked browser', async () => {
  const res = await fetch(`${base}/api/monthly/not-a-real-token`, { headers: { cookie: unlocked } });
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error, 'not_found');
});

test('the session route is not a way around the monthly PIN gate', async () => {
  // The two stores are separate on purpose: a monthly token must not resolve
  // through `/api/summary/:token`, which has no PIN in front of it.
  const token = store.createMonthlyDashboardToken({
    site: 'ubet89',
    yearMonth: '2026-07',
    payload: MONTHLY_PAYLOAD,
  });

  assert.equal((await fetch(`${base}/api/summary/${token}`)).status, 404);
});

test('the session dashboard keeps its own token route, ungated', async () => {
  const token = store.createSummaryToken('chat-1', { summaryText: 'ok' });

  const res = await fetch(`${base}/api/summary/${token}`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { summaryText: 'ok' });
});

test('the monthly page needs no token of its own to be served', async () => {
  // The HTML is public; the data behind it is not. Keeping the page itself
  // unauthenticated is what lets Telegram open it before the fetch runs.
  const res = await fetch(`${base}/miniapp/monthly?token=`);
  assert.equal(res.status, 200);
});
