import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

process.env.TELEGRAM_BOT_TOKEN ??= 'test-token';
process.env.ANTHROPIC_API_KEY ??= 'test-key';

let tmpDir;
let store;
let server;
let base;

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

test('a monthly payload round-trips through the existing token route unchanged', async () => {
  // The point of this test: the monthly dashboard adds no auth of its own. It
  // reuses `createSummaryToken` and `/api/summary/:token` exactly as the
  // session dashboard does.
  const token = store.createSummaryToken('chat-1', MONTHLY_PAYLOAD);

  const res = await fetch(`${base}/api/summary/${token}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await res.json(), MONTHLY_PAYLOAD);
});

test('a bad or expired monthly token is refused the same way as any other', async () => {
  const res = await fetch(`${base}/api/summary/not-a-real-token`);
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error, 'not_found');
});

test('the monthly page needs no token of its own to be served', async () => {
  // The HTML is public; the data behind it is not. Keeping the page itself
  // unauthenticated is what lets Telegram open it before the fetch runs.
  const res = await fetch(`${base}/miniapp/monthly?token=`);
  assert.equal(res.status, 200);
});
