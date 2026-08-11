/**
 * The menu as a conversation: what each tap does to the stored selection and
 * what comes back on screen.
 *
 * Driven through the real `registerMenuActions` with a stand-in Telegraf, for
 * the same reason `fxRateCommand.test.js` uses a stand-in context — the
 * behaviour being checked (cancel really clears state; a button from a dead
 * flow is refused instead of half-applied) lives in these handlers, not in the
 * library that routes to them.
 *
 * The quick flow is followed as far as the month, but not through it: its last
 * step is the ordinary question path, which calls Anthropic. The monthly flow
 * is followed to the end, because its last step is entirely local.
 */

import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.TELEGRAM_BOT_TOKEN ??= 'test-token';
process.env.ANTHROPIC_API_KEY ??= 'test-key';
// Set before bot.js is imported: config.js reads it once, at module load.
process.env.PUBLIC_URL ??= 'https://bot.example.com';

let tmpDir;
let db;
let store;
let menu;
let actions;

const CHAT = 'chat-menu';

/** Stands in for Telegraf's `bot.action(matcher, handler)` registry. */
function makeBot() {
  const handlers = [];
  return {
    action: (matcher, handler) => handlers.push({ matcher, handler }),
    async press(callbackData, ctx) {
      for (const { matcher, handler } of handlers) {
        if (typeof matcher === 'string') {
          if (matcher === callbackData) return handler(ctx);
          continue;
        }
        const match = matcher.exec(callbackData);
        // Telegraf puts the regex result on ctx.match; the handlers read [1].
        if (match) {
          ctx.match = match;
          return handler(ctx);
        }
      }
      throw new Error(`no handler for ${callbackData}`);
    },
  };
}

function makeCtx({ chatId = CHAT } = {}) {
  const sent = [];
  return {
    sent,
    chat: { id: chatId },
    from: { id: 42, username: 'tester' },
    answerCbQuery: async () => true,
    editMessageReplyMarkup: async () => true,
    telegram: {
      sendMessage: async (_chat, text, extra) => {
        sent.push({ text, extra });
        return { message_id: sent.length };
      },
      sendChatAction: async () => true,
      editMessageText: async () => true,
      deleteMessage: async () => true,
    },
  };
}

const last = (ctx) => ctx.sent[ctx.sent.length - 1] ?? { text: '', extra: {} };
const buttonsOf = (message) => (message.extra?.reply_markup?.inline_keyboard ?? []).flat();

let bot;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ads-analytics-menuflow-'));
  process.env.DATA_DIR = tmpDir;

  db = await import('../src/data/db.js');
  db.initDataDb(path.join(tmpDir, 'data.sqlite'));
  store = await import('../src/session/store.js');
  store.initDb(path.join(tmpDir, 'session.sqlite'));
  store.getOrCreateSession(CHAT, 'user-1');

  menu = await import('../src/telegram/menu.js');
  const botModule = await import('../src/telegram/bot.js');

  bot = makeBot();
  botModule.registerMenuActions(bot);

  // One month of one file, so the month picker and the monthly report both
  // have something real behind them.
  const raw = db.upsertRawFile({
    site: 'shwe666',
    yearMonth: '2026-07',
    fileType: 'daily_value',
    relPath: 'data/shwe666/2026-07/daily.xlsx',
    fileSize: 1,
    originalFilename: 'daily.xlsx',
  });
  db.insertParsedRows(raw.id, {
    fileType: 'daily_value',
    site: 'shwe666',
    yearMonth: '2026-07',
    rows: [
      { rowDate: '2026-07-01', row: { Date: '2026-07-01', BIn: 100, R: 20, RTP: 0.95, DAU: 500, 'BIn Mems': 200 } },
    ],
  });
  db.markParsed(raw.id);

  actions = {
    quick: menu.MENU_QUICK,
    monthly: menu.MENU_MONTHLY,
    cancel: menu.MENU_CANCEL,
  };
});

beforeEach(() => {
  db.clearMenuSelection(CHAT);
});

after(() => {
  store?.closeDb();
  db?.closeDataDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('the quick flow walks metric → site → month, storing one step at a time', async () => {
  const ctx = makeCtx();

  await bot.press(actions.quick, ctx);
  assert.equal(db.getMenuSelection(CHAT).flow, 'quick');
  assert.match(last(ctx).text, /ดูตัวเลขด่วน/);

  await bot.press(`${menu.METRIC_PREFIX}rtp`, ctx);
  assert.equal(db.getMenuSelection(CHAT).metric, 'rtp');
  // Step 2 asks for a site, and the site buttons are what comes back.
  assert.deepEqual(
    buttonsOf(last(ctx)).map((button) => button.callback_data),
    ['menu:site:shwe666', 'menu:site:ubet89', 'menu:site:88fed', menu.MENU_CANCEL],
  );

  await bot.press('menu:site:shwe666', ctx);
  assert.equal(db.getMenuSelection(CHAT).site, 'shwe666');
  // Only the month that has a file is offered.
  assert.deepEqual(
    buttonsOf(last(ctx)).map((button) => button.callback_data),
    ['menu:month:2026-07', menu.MENU_CANCEL],
  );
});

test('cancelling mid-flow clears the selection and reopens the main menu', async () => {
  const ctx = makeCtx();

  await bot.press(actions.quick, ctx);
  await bot.press(`${menu.METRIC_PREFIX}bin`, ctx);
  await bot.press('menu:site:shwe666', ctx);
  assert.ok(db.getMenuSelection(CHAT), 'a selection is in progress');

  await bot.press(actions.cancel, ctx);

  assert.equal(db.getMenuSelection(CHAT), null, 'the pending selection is gone');
  assert.match(last(ctx).text, /ยกเลิกแล้ว/);
  assert.deepEqual(
    buttonsOf(last(ctx)).map((button) => button.callback_data),
    [menu.MENU_QUICK, menu.MENU_MONTHLY, menu.MENU_SESSION],
  );
});

test('a month button pressed after a cancel is refused, not half-applied', async () => {
  const ctx = makeCtx();

  await bot.press(actions.quick, ctx);
  await bot.press(`${menu.METRIC_PREFIX}dau`, ctx);
  await bot.press(actions.cancel, ctx);

  // The old keyboard is still tappable in Telegram; this is that tap.
  await bot.press('menu:month:2026-07', ctx);

  assert.match(last(ctx).text, /ยกเลิกหรือหมดอายุ/);
  assert.equal(db.getMenuSelection(CHAT), null, 'no selection was conjured up');
});

test('a site button with no flow behind it is refused too', async () => {
  const ctx = makeCtx();
  await bot.press('menu:site:ubet89', ctx);
  assert.match(last(ctx).text, /ยกเลิกหรือหมดอายุ/);
  assert.equal(db.getMenuSelection(CHAT), null);
});

test('a metric button with no flow behind it restarts the quick flow', async () => {
  // Unlike a site or a month, a metric identifies itself completely — there is
  // nothing to get wrong by acting on it.
  const ctx = makeCtx();
  await bot.press(`${menu.METRIC_PREFIX}vip_active`, ctx);

  const selection = db.getMenuSelection(CHAT);
  assert.equal(selection.flow, 'quick');
  assert.equal(selection.metric, 'vip_active');
  assert.match(last(ctx).text, /เลือกเว็บ/);
});

test('a site with no uploaded file ends the flow instead of showing an empty picker', async () => {
  const ctx = makeCtx();

  await bot.press(actions.monthly, ctx);
  await bot.press('menu:site:88fed', ctx);

  assert.match(last(ctx).text, /ยังไม่มีไฟล์/);
  assert.equal(db.getMenuSelection(CHAT), null, 'a dead-ended flow does not linger');
});

test('the monthly flow ends with a Mini App link to the monthly page', async () => {
  const ctx = makeCtx();

  await bot.press(actions.monthly, ctx);
  await bot.press('menu:site:shwe666', ctx);
  await bot.press('menu:month:2026-07', ctx);

  const message = last(ctx);
  assert.match(message.text, /สรุปเดือน ก\.ค\. 2026 — SH666/);

  const button = buttonsOf(message)[0];
  assert.match(button.web_app.url, /^https:\/\/bot\.example\.com\/miniapp\/monthly\?token=/);

  // The token resolves to the payload the page will render.
  const token = new URL(button.web_app.url).searchParams.get('token');
  const payload = store.readMonthlyDashboard(token);
  assert.equal(payload.kind, 'monthly');
  assert.equal(payload.yearMonth, '2026-07');
  assert.equal(payload.siteName, 'SH666');

  // And the flow is finished, not left half-open.
  assert.equal(db.getMenuSelection(CHAT), null);
});

test('the same URL is printed in the message body, because a forward loses the button', async () => {
  const ctx = makeCtx();

  await bot.press(actions.monthly, ctx);
  await bot.press('menu:site:shwe666', ctx);
  await bot.press('menu:month:2026-07', ctx);

  const message = last(ctx);
  const url = buttonsOf(message)[0].web_app.url;

  assert.ok(message.text.includes(`🔗 ลิงก์: ${url}`), 'the link is readable without the button');
  assert.match(message.text, /ต้องกรอก PIN/, 'and says why it still asks for something');
  // Markdown-hostile characters in the token would get the URL mangled or the
  // whole message rejected — Telegram sees this text as Markdown.
  assert.match(url, /token=[0-9a-f]{64}$/);
});

test('a second run of the same month reuses the link that was already shared', async () => {
  const first = makeCtx();
  await bot.press(actions.monthly, first);
  await bot.press('menu:site:shwe666', first);
  await bot.press('menu:month:2026-07', first);

  const second = makeCtx();
  await bot.press(actions.monthly, second);
  await bot.press('menu:site:shwe666', second);
  await bot.press('menu:month:2026-07', second);

  assert.equal(
    buttonsOf(last(second))[0].web_app.url,
    buttonsOf(last(first))[0].web_app.url,
    'anyone holding the forwarded link keeps working after the report is re-run',
  );
});

test('the monthly message names the files that would fill the empty tabs', async () => {
  const ctx = makeCtx();

  await bot.press(actions.monthly, ctx);
  await bot.press('menu:site:shwe666', ctx);
  await bot.press('menu:month:2026-07', ctx);

  const text = last(ctx).text;
  // Only daily_value was uploaded, so three of eleven tabs have data.
  assert.match(text, /หมวดที่มีข้อมูล: \*3\/11\*/);
  assert.match(text, /VIP Members/);
  assert.match(text, /ไฟล์ที่ยังขาด/);
});

test('starting the other flow abandons the one in progress', async () => {
  const ctx = makeCtx();

  await bot.press(actions.quick, ctx);
  await bot.press(`${menu.METRIC_PREFIX}bonus_cost`, ctx);
  await bot.press(actions.monthly, ctx);

  const selection = db.getMenuSelection(CHAT);
  assert.equal(selection.flow, 'monthly');
  assert.equal(selection.metric, null, 'the abandoned metric must not follow into the new flow');
});

test('two chats run their flows independently', async () => {
  const one = makeCtx({ chatId: 'chat-x' });
  const two = makeCtx({ chatId: 'chat-y' });

  await bot.press(actions.quick, one);
  await bot.press(`${menu.METRIC_PREFIX}bin`, one);
  await bot.press(actions.monthly, two);
  await bot.press(actions.cancel, one);

  assert.equal(db.getMenuSelection('chat-x'), null);
  assert.equal(db.getMenuSelection('chat-y').flow, 'monthly');

  db.clearMenuSelection('chat-y');
});
