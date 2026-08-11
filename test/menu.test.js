import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.TELEGRAM_BOT_TOKEN ??= 'test-token';
process.env.ANTHROPIC_API_KEY ??= 'test-key';

let tmpDir;
let db;
let menu;
let query;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ads-analytics-menu-'));
  process.env.DATA_DIR = tmpDir;

  db = await import('../src/data/db.js');
  db.initDataDb(path.join(tmpDir, 'test.sqlite'));
  menu = await import('../src/telegram/menu.js');
  query = await import('../src/data/query.js');
});

after(() => {
  db?.closeDataDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const rowsOf = (keyboard) => keyboard.reply_markup.inline_keyboard;
const lastRow = (keyboard) => rowsOf(keyboard)[rowsOf(keyboard).length - 1];

// --- keyboards ---------------------------------------------------------------

test('the main menu offers exactly the three documented entry points', () => {
  const rows = rowsOf(menu.mainMenuKeyboard());
  assert.deepEqual(
    rows.flat().map((button) => button.callback_data),
    [menu.MENU_QUICK, menu.MENU_MONTHLY, menu.MENU_SESSION],
  );
});

test('the main menu has no cancel button — there is nothing in progress to cancel', () => {
  const buttons = rowsOf(menu.mainMenuKeyboard()).flat();
  assert.equal(buttons.some((button) => button.callback_data === menu.MENU_CANCEL), false);
});

test('every submenu ends with the cancel button, on its own final row', () => {
  const submenus = [
    menu.quickMetricsKeyboard(),
    menu.siteKeyboard(),
    menu.monthKeyboard(['2026-07', '2026-06', '2026-05']),
  ];

  for (const keyboard of submenus) {
    const row = lastRow(keyboard);
    assert.equal(row.length, 1, 'cancel sits alone on the last row');
    assert.equal(row[0].callback_data, menu.MENU_CANCEL);
    assert.match(row[0].text, /ยกเลิก/);

    // Exactly one — a second cancel button anywhere would be a duplicated row.
    const cancels = rowsOf(keyboard)
      .flat()
      .filter((button) => button.callback_data === menu.MENU_CANCEL);
    assert.equal(cancels.length, 1);
  }
});

test('the six quick metrics are laid out two per row above the cancel row', () => {
  const rows = rowsOf(menu.quickMetricsKeyboard());
  const metricRows = rows.slice(0, -1);

  assert.equal(metricRows.length, 3);
  for (const row of metricRows) assert.equal(row.length, 2);
  assert.deepEqual(
    metricRows.flat().map((button) => button.callback_data.replace(menu.METRIC_PREFIX, '')),
    ['bin', 'dau', 'rtp', 'new_mems', 'vip_active', 'bonus_cost'],
  );
});

test('every callback_data fits the 64-byte limit Telegram enforces', () => {
  const keyboards = [
    menu.mainMenuKeyboard(),
    menu.quickMetricsKeyboard(),
    menu.siteKeyboard(),
    menu.monthKeyboard(['2026-07']),
  ];
  for (const keyboard of keyboards) {
    for (const button of rowsOf(keyboard).flat()) {
      assert.ok(
        Buffer.byteLength(button.callback_data, 'utf8') <= 64,
        `${button.callback_data} is too long for Telegram`,
      );
    }
  }
});

test('the site keyboard offers every configured site by its display name', () => {
  const buttons = rowsOf(menu.siteKeyboard()).flat().filter((b) => b.callback_data !== menu.MENU_CANCEL);
  assert.deepEqual(buttons.map((button) => button.text), ['SH666', 'U89', '88F']);
  assert.deepEqual(
    buttons.map((button) => button.callback_data),
    ['menu:site:shwe666', 'menu:site:ubet89', 'menu:site:88fed'],
  );
});

test('month buttons carry the machine value and show the Thai label', () => {
  const buttons = rowsOf(menu.monthKeyboard(['2026-07', '2026-01']))
    .flat()
    .filter((button) => button.callback_data !== menu.MENU_CANCEL);

  assert.deepEqual(buttons.map((b) => b.callback_data), ['menu:month:2026-07', 'menu:month:2026-01']);
  assert.deepEqual(buttons.map((b) => b.text), ['ก.ค. 2026', 'ม.ค. 2026']);
});

test('an unparseable month falls back to its raw value rather than showing undefined', () => {
  assert.equal(menu.monthLabel('not-a-month'), 'not-a-month');
  assert.equal(menu.monthLabel(null), '');
});

// --- the button → question mapping ------------------------------------------

test('each quick metric maps to a question the existing router sends to the right file', () => {
  // This is the whole contract of the quick flow: a button must reach the same
  // file type the typed question would. A reworded label that stops matching
  // its route silently lands on daily_value and gets answered plausibly from
  // the wrong report.
  const expected = {
    bin: 'daily_value',
    dau: 'daily_value',
    rtp: 'daily_value',
    new_mems: 'new_member_quality',
    vip_active: 'vip',
    bonus_cost: 'bonus_log',
  };

  for (const metric of menu.QUICK_METRICS) {
    const question = metric.question('SH666', '2026-07');
    assert.equal(query.pickFileType(question), expected[metric.id], `${metric.id}: ${question}`);
  }
});

test('the assembled question names the site and month it was built from', () => {
  for (const metric of menu.QUICK_METRICS) {
    const question = metric.question('U89', '2026-06');
    assert.match(question, /U89/);
    assert.match(question, /2026-06/);
  }
});

test('getQuickMetric refuses an id that is not on the keyboard', () => {
  assert.equal(menu.getQuickMetric('bin').id, 'bin');
  assert.equal(menu.getQuickMetric('nonsense'), null);
  assert.equal(menu.getQuickMetric(''), null);
});

// --- flow state --------------------------------------------------------------

test('a flow records its steps one at a time', () => {
  db.startMenuSelection('chat-1', { flow: menu.FLOW_QUICK, metric: 'rtp' });
  assert.equal(db.getMenuSelection('chat-1').flow, 'quick');
  assert.equal(db.getMenuSelection('chat-1').site, null);

  db.updateMenuSelection('chat-1', { site: 'shwe666' });
  db.updateMenuSelection('chat-1', { yearMonth: '2026-07' });

  const selection = db.getMenuSelection('chat-1');
  assert.equal(selection.metric, 'rtp');
  assert.equal(selection.site, 'shwe666');
  assert.equal(selection.year_month, '2026-07');
});

test('cancelling clears the half-made selection outright', () => {
  db.startMenuSelection('chat-2', { flow: menu.FLOW_MONTHLY });
  db.updateMenuSelection('chat-2', { site: 'ubet89' });
  assert.ok(db.getMenuSelection('chat-2'));

  assert.equal(db.clearMenuSelection('chat-2'), 1);
  assert.equal(db.getMenuSelection('chat-2'), null);
  // Idempotent: a second cancel from a stale keyboard must not throw.
  assert.equal(db.clearMenuSelection('chat-2'), 0);
});

test('a button from a cancelled flow updates nothing instead of half-creating one', () => {
  db.clearMenuSelection('chat-3');
  // This is the case the bot turns into "รายการที่เลือกไว้ถูกยกเลิก" — a month
  // with no flow behind it cannot be acted on, and inventing a selection here
  // would attach the tap to whatever the user picks next.
  assert.equal(db.updateMenuSelection('chat-3', { yearMonth: '2026-07' }), null);
  assert.equal(db.getMenuSelection('chat-3'), null);
});

test('starting a flow discards whatever was in progress before it', () => {
  db.startMenuSelection('chat-4', { flow: menu.FLOW_QUICK, metric: 'bin' });
  db.updateMenuSelection('chat-4', { site: 'shwe666', yearMonth: '2026-07' });

  db.startMenuSelection('chat-4', { flow: menu.FLOW_MONTHLY });

  const selection = db.getMenuSelection('chat-4');
  assert.equal(selection.flow, 'monthly');
  assert.equal(selection.metric, null, 'the previous metric must not leak into the new flow');
  assert.equal(selection.site, null);
  assert.equal(selection.year_month, null);
});

test('a selection that has aged out reads as absent and is cleaned up', () => {
  // The keyboard that made it stays tappable for ever, so the selection must
  // not: a site button pressed out of a week-old message would otherwise
  // resume a flow the user has long forgotten.
  db.startMenuSelection('chat-old', { flow: menu.FLOW_QUICK, metric: 'bin' });
  assert.ok(db.getMenuSelection('chat-old'), 'live at the default TTL');

  assert.equal(db.getMenuSelection('chat-old', { ttlMs: -1 }), null);
  // Gone from the table, not merely hidden from that one read.
  assert.equal(db.clearMenuSelection('chat-old'), 0);
  // And a button press against it is refused rather than half-applied.
  assert.equal(db.updateMenuSelection('chat-old', { site: 'shwe666' }), null);
});

test('flow state is per chat', () => {
  db.startMenuSelection('chat-a', { flow: menu.FLOW_QUICK, metric: 'dau' });
  db.startMenuSelection('chat-b', { flow: menu.FLOW_MONTHLY });
  db.clearMenuSelection('chat-a');

  assert.equal(db.getMenuSelection('chat-a'), null);
  assert.equal(db.getMenuSelection('chat-b').flow, 'monthly');
});

// --- the month picker's source ----------------------------------------------

test('the month picker is built from months that actually have files, newest first', () => {
  for (const yearMonth of ['2026-05', '2026-07', '2026-06']) {
    db.upsertRawFile({
      site: 'shwe666',
      yearMonth,
      fileType: 'daily_value',
      relPath: `data/shwe666/${yearMonth}/daily.xlsx`,
      fileSize: 1,
      originalFilename: 'daily.xlsx',
    });
  }
  // A second file type in a month it already has must not produce a duplicate.
  db.upsertRawFile({
    site: 'shwe666',
    yearMonth: '2026-07',
    fileType: 'vip',
    relPath: 'data/shwe666/2026-07/vip.xlsx',
    fileSize: 1,
    originalFilename: 'vip.xlsx',
  });

  assert.deepEqual(db.listRawFileMonths('shwe666'), ['2026-07', '2026-06', '2026-05']);
  // A site with nothing uploaded ends the flow rather than drawing an empty keyboard.
  assert.deepEqual(db.listRawFileMonths('88fed'), []);
});

test('listRawFiles can be scoped to one month, which is what the report reads', () => {
  const files = db.listRawFiles({ site: 'shwe666', yearMonth: '2026-07' });
  assert.deepEqual(files.map((file) => file.file_type).sort(), ['daily_value', 'vip']);
  assert.equal(db.listRawFiles({ site: 'shwe666', yearMonth: '2026-06' }).length, 1);
});
