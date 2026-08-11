#!/usr/bin/env node
/**
 * Verify the Mini App HTTP surface end-to-end, without Telegram or Anthropic.
 *
 * Boots the router on an ephemeral port, plants a summary payload, and fetches
 * every route the dashboard needs. Useful after deploying to confirm the static
 * assets and the token flow work before testing through Telegram.
 *
 *   npm run smoke
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

// The router and store only need these to satisfy config.js validation.
process.env.TELEGRAM_BOT_TOKEN ??= 'smoke-test';
process.env.ANTHROPIC_API_KEY ??= 'smoke-test';

const { createRouter } = await import('../src/miniapp/routes.js');
const store = await import('../src/session/store.js');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ads-analytics-smoke-'));
store.initDb(path.join(tmpDir, 'smoke.sqlite'));
store.getOrCreateSession('smoke-chat', 'smoke-user');

const token = store.createSummaryToken('smoke-chat', {
  generatedAt: new Date().toISOString(),
  turnCount: 3,
  sites: ['SH666'],
  summaryText: '*ภาพรวม*: RTP อยู่ในเกณฑ์ปกติ',
  chart: {
    type: 'line',
    title: 'Revenue รายวัน (THB)',
    labels: ['1 ก.ค.', '2 ก.ค.', '3 ก.ค.'],
    datasets: [{ label: 'Revenue', data: [697282, 712000, 688500] }],
  },
  metrics: [{ name: 'RTP', value: '96.1%', status: 'ปกติ' }],
});

const monthlyToken = store.createSummaryToken('smoke-chat', {
  kind: 'monthly',
  generatedAt: new Date().toISOString(),
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
      kpis: [{ label: 'BIn รวมทั้งเดือน', value: 472200, unit: 'thb' }],
      charts: [
        {
          id: 'overview-daily',
          type: 'line',
          title: 'BIn รายวัน (บาท)',
          labels: ['1', '2', '3'],
          datasets: [{ label: 'BIn', unit: 'thb', data: [78700, 157400, 236100] }],
        },
      ],
      tables: [],
    },
  ],
});

const app = express();
app.use(createRouter());
const server = app.listen(0);
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const results = [];

async function check(name, route, expectStatus, validate) {
  let line;
  try {
    const res = await fetch(base + route);
    if (res.status !== expectStatus) {
      line = `FAIL ${name} — คาดว่า ${expectStatus} ได้ ${res.status}`;
    } else if (validate) {
      const isJson = res.headers.get('content-type')?.includes('json');
      const body = isJson ? await res.json() : await res.text();
      const problem = validate(body, res);
      line = problem ? `FAIL ${name} — ${problem}` : `PASS ${name}`;
    } else {
      line = `PASS ${name}`;
    }
  } catch (err) {
    line = `FAIL ${name} — ${err.message}`;
  }
  results.push(line);
}

await check('GET /healthz', '/healthz', 200, (body) =>
  body.ok === true ? null : 'ไม่มี ok:true ใน response');

await check('GET /miniapp (html)', '/miniapp', 200, (body) =>
  body.includes('chart.umd.min.js') && body.includes('assets/app.js')
    ? null
    : 'HTML ไม่ได้อ้าง chart.js หรือ app.js');

await check('GET vendored chart.js', '/miniapp/vendor/chart.umd.min.js', 200, (body) =>
  body.length > 100_000 ? null : `ไฟล์เล็กผิดปกติ (${body.length} bytes)`);

await check('GET app.js', '/miniapp/assets/app.js', 200, (body) =>
  body.includes('renderInline') ? null : 'เนื้อหา app.js ไม่ตรงที่คาด');

await check('GET summary payload', `/api/summary/${token}`, 200, (body, res) => {
  if (res.headers.get('cache-control') !== 'no-store') return 'ขาด header Cache-Control: no-store';
  if (body.chart?.datasets?.[0]?.data?.length !== 3) return 'chart payload ผิดรูป';
  if (body.sites?.[0] !== 'SH666') return 'ไม่มีข้อมูล sites';
  return null;
});

await check('GET /miniapp/monthly (html)', '/miniapp/monthly', 200, (body) =>
  body.includes('chart.umd.min.js') && body.includes('assets/monthly.js') && body.includes('id="tabs"')
    ? null
    : 'HTML ของหน้าสรุปเดือนไม่ครบ (chart.js / monthly.js / tab strip)');

await check('GET monthly.js', '/miniapp/assets/monthly.js', 200, (body) =>
  body.includes('formatThb') ? null : 'เนื้อหา monthly.js ไม่ตรงที่คาด');

await check('GET monthly payload', `/api/summary/${monthlyToken}`, 200, (body, res) => {
  if (res.headers.get('cache-control') !== 'no-store') return 'ขาด header Cache-Control: no-store';
  if (body.kind !== 'monthly') return 'payload ไม่ได้ทำเครื่องหมายว่าเป็นสรุปเดือน';
  if (body.sections?.[0]?.kpis?.[0]?.unit !== 'thb') return 'หน่วยเงินใน payload ผิดรูป';
  return null;
});

await check('GET summary with bad token', '/api/summary/not-a-real-token', 404);

console.log(results.join('\n'));

server.close();
store.closeDb();
fs.rmSync(tmpDir, { recursive: true, force: true });

const failed = results.filter((r) => r.startsWith('FAIL'));
if (failed.length > 0) {
  console.error(`\n❌ ${failed.length}/${results.length} ไม่ผ่าน`);
  process.exit(1);
}
console.log(`\n✅ ผ่านทั้งหมด ${results.length} ข้อ`);
