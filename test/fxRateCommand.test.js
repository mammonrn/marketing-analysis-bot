/**
 * The chat surface of a rate change: who may make one, and what has to happen
 * before it lands.
 *
 * These go through the real handlers with a stand-in Telegram context rather
 * than testing the policy layer again, because the gates being checked live
 * here — the Super Admin test and the requirement for an explicit confirm are
 * properties of the conversation, not of `fxRates.js`.
 */

import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.TELEGRAM_BOT_TOKEN ??= 'test-token';
process.env.ANTHROPIC_API_KEY ??= 'test-key';
// Fixed so the admin check is testing the configured id, not a default that
// might change underneath it.
process.env.SUPER_ADMIN_TELEGRAM_ID = '509832984';

const ADMIN = 509832984;
const OUTSIDER = 111222333;

let tmpDir;
let db;
let handle;
let sites;
let bot;

/** Collects what the bot sent, in place of a Telegram connection. */
function makeCtx(userId, { chatId = 'chat-fx' } = {}) {
  const sent = [];
  return {
    sent,
    chat: { id: chatId },
    from: { id: userId, username: `user${userId}` },
    telegram: {
      sendMessage: async (_chat, text) => {
        sent.push(text);
        return { message_id: sent.length };
      },
    },
  };
}

const lastMessage = (ctx) => ctx.sent[ctx.sent.length - 1] ?? '';

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ads-analytics-fxcmd-'));
  process.env.DATA_DIR = tmpDir;

  db = await import('../src/data/db.js');
  handle = db.initDataDb(path.join(tmpDir, 'test.sqlite'));
  sites = await import('../src/data/sites.js');
  bot = await import('../src/telegram/bot.js');
});

beforeEach(() => {
  sites.clearFxOverrides();
  handle.exec('DELETE FROM fx_rate_overrides; DELETE FROM pending_fx_updates;');
});

after(() => {
  db?.closeDataDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// --- authorisation ----------------------------------------------------------

test('a non-admin cannot change a rate, and the attempt is recorded', async () => {
  const ctx = makeCtx(OUTSIDER);
  await bot.handleFxRateCommand(ctx, 'SH666 0.812');

  assert.match(lastMessage(ctx), /Super Admin/);
  // Nothing staged, nothing written, rate untouched.
  assert.equal(db.getPendingFxUpdate(ctx.chat.id), undefined);
  assert.equal(db.listFxRateHistory('shwe666').length, 0);
  assert.equal(sites.getSite('shwe666').fxRate, 0.787);
});

test('reading the rates needs no privilege', async () => {
  const ctx = makeCtx(OUTSIDER);
  await bot.handleFxRateCommand(ctx, '');

  const text = lastMessage(ctx);
  assert.match(text, /SH666/);
  assert.match(text, /0\.787/);
  assert.match(text, /Super Admin/, 'it still says who may change one');
});

test('a non-admin pressing the confirm button cannot complete an admin request', async () => {
  // The button lives in a message everyone in the chat can see, so whoever
  // staged the change is not necessarily whoever presses it.
  const admin = makeCtx(ADMIN);
  await bot.handleFxRateCommand(admin, 'SH666 0.812');
  assert.ok(db.getPendingFxUpdate(admin.chat.id), 'staged by the admin');

  const outsider = makeCtx(OUTSIDER);
  await bot.confirmFxRateUpdate(outsider);

  assert.match(lastMessage(outsider), /Super Admin/);
  assert.equal(sites.getSite('shwe666').fxRate, 0.787, 'the rate must not have moved');
  assert.equal(db.listFxRateHistory('shwe666').length, 0);
  assert.ok(db.getPendingFxUpdate(admin.chat.id), 'and the request is still waiting');
});

// --- the confirm gate -------------------------------------------------------

test('a valid rate is staged, not written, until it is confirmed', async () => {
  const ctx = makeCtx(ADMIN);
  await bot.handleFxRateCommand(ctx, 'SH666 0.812');

  const text = lastMessage(ctx);
  assert.match(text, /ยืนยัน/);
  assert.match(text, /0\.787/, 'the message shows what it is changing from');
  assert.match(text, /0\.812/, 'and what to');

  // Staged only.
  assert.equal(db.getPendingFxUpdate(ctx.chat.id).fx_rate, 0.812);
  assert.equal(sites.getSite('shwe666').fxRate, 0.787, 'the live rate has not moved');
  assert.equal(db.listFxRateHistory('shwe666').length, 0, 'nothing written yet');

  await bot.confirmFxRateUpdate(ctx);

  assert.equal(sites.getSite('shwe666').fxRate, 0.812, 'now it has');
  assert.equal(db.listFxRateHistory('shwe666').length, 1);
  assert.equal(db.getPendingFxUpdate(ctx.chat.id), undefined, 'and the request is cleared');
});

test('confirming with nothing staged writes nothing', async () => {
  const ctx = makeCtx(ADMIN);
  await bot.confirmFxRateUpdate(ctx);

  assert.match(lastMessage(ctx), /ไม่พบรายการที่รอยืนยัน/);
  assert.equal(db.listFxRateHistory('shwe666').length, 0);
  assert.equal(sites.getSite('shwe666').fxRate, 0.787);
});

test('a confirmed change records who made it and what it displaced', async () => {
  const ctx = makeCtx(ADMIN);
  await bot.handleFxRateCommand(ctx, 'SH666 0.812');
  await bot.confirmFxRateUpdate(ctx);

  const [row] = db.listFxRateHistory('shwe666');
  assert.equal(row.fx_rate, 0.812);
  assert.equal(row.previous_rate, 0.787);
  assert.equal(row.updated_by, String(ADMIN));
  assert.ok(row.updated_at > 0);
  assert.match(row.fx_rate_as_of, /^\d{4}-\d{2}-\d{2}$/);
});

// --- rejected input never gets as far as a confirm ---------------------------

test('a rate missing its decimal point is refused outright, with the reason', async () => {
  const ctx = makeCtx(ADMIN);
  await bot.handleFxRateCommand(ctx, 'SH666 787');

  // The specific correction, not a bare "invalid".
  assert.match(lastMessage(ctx), /787/);
  assert.match(lastMessage(ctx), /0\.787/);
  assert.equal(db.getPendingFxUpdate(ctx.chat.id), undefined, 'nothing may be staged');
});

test('zero, negative and non-numeric rates are all refused before staging', async () => {
  for (const bad of ['0', '-1', 'abc', '0.00000001']) {
    const ctx = makeCtx(ADMIN);
    await bot.handleFxRateCommand(ctx, `SH666 ${bad}`);
    assert.match(lastMessage(ctx), /⚠️/, `"${bad}" should be refused`);
    assert.equal(db.getPendingFxUpdate(ctx.chat.id), undefined, `"${bad}" must not be staged`);
  }
  assert.equal(sites.getSite('shwe666').fxRate, 0.787);
});

test('a move of more than half is flagged in the confirm, but still offered', async () => {
  const ctx = makeCtx(ADMIN);
  await bot.handleFxRateCommand(ctx, 'SH666 2.5');

  const text = lastMessage(ctx);
  assert.match(text, /🚨/, 'the jump is called out');
  assert.match(text, /%/);
  // Flagged, not blocked — a rate really can move this far.
  assert.equal(db.getPendingFxUpdate(ctx.chat.id).fx_rate, 2.5);
});

test('an unknown site and a malformed command are both refused', async () => {
  const unknown = makeCtx(ADMIN);
  await bot.handleFxRateCommand(unknown, 'NOPE 0.8');
  assert.match(lastMessage(unknown), /ไม่รู้จักเว็บ/);

  const malformed = makeCtx(ADMIN);
  await bot.handleFxRateCommand(malformed, 'SH666');
  assert.match(lastMessage(malformed), /รูปแบบ/);

  assert.equal(db.getPendingFxUpdate(unknown.chat.id), undefined);
  assert.equal(db.getPendingFxUpdate(malformed.chat.id), undefined);
});

// --- the change reaches the money -------------------------------------------

test('a confirmed rate changes what the data context reports', async () => {
  const { formatContext } = await import('../src/data/query.js');
  const rows = [{ row: { Date: '2026-07-01', BIn: 1000 }, row_date: '2026-07-01', year_month: '2026-07' }];
  const render = () =>
    formatContext({ site: 'shwe666', fileType: 'daily_value', availableMonths: ['2026-07'], rows });

  assert.ok(render().includes('"BIn_THB":787000'), 'starts on the config rate');

  const ctx = makeCtx(ADMIN);
  await bot.handleFxRateCommand(ctx, 'SH666 0.812');
  await bot.confirmFxRateUpdate(ctx);

  const after = render();
  assert.ok(after.includes('"BIn_THB":812000'), 'the converted column follows the new rate');
  assert.ok(after.includes('× 0.812'), 'and so does the rate quoted in the header');
});
