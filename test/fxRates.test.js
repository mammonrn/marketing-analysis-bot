/**
 * Exchange-rate staleness warnings and the chat-driven rate change.
 *
 * Two things are being pinned here. First, that a rate cannot go quietly stale
 * while new data keeps arriving — and that fixing it silences the warning by
 * itself, rather than needing anything cleared. Second, that changing a rate
 * takes an admin, a plausible number, and an explicit confirmation, because a
 * wrong rate is wrong in a way nobody can see: every figure the bot reports
 * stays perfectly self-consistent at the wrong scale.
 */

import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.TELEGRAM_BOT_TOKEN ??= 'test-token';
process.env.ANTHROPIC_API_KEY ??= 'test-key';

let tmpDir;
let db;
let handle;
let sites;
let fx;

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-08-07T00:00:00Z');

/** Puts a month of data on the books for a site, the way an upload would. */
function giveSiteData(site, yearMonth) {
  db.upsertRawFile({
    site,
    yearMonth,
    fileType: 'daily_value',
    relPath: `DATA/${site}/${yearMonth}.xlsx`,
    fileSize: 100,
    originalFilename: 'daily.xlsx',
  });
}

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ads-analytics-fx-'));
  process.env.DATA_DIR = tmpDir;

  db = await import('../src/data/db.js');
  // Kept so beforeEach can clear the tables without opening a second
  // connection per test.
  handle = db.initDataDb(path.join(tmpDir, 'test.sqlite'));
  sites = await import('../src/data/sites.js');
  fx = await import('../src/data/fxRates.js');
});

beforeEach(() => {
  // Each test starts from the shipped config, with no history behind it.
  sites.clearFxOverrides();
  handle.exec(
    'DELETE FROM fx_rate_overrides; DELETE FROM fx_rate_alerts;' +
      ' DELETE FROM pending_fx_updates; DELETE FROM raw_files; DELETE FROM parsed_rows;',
  );
});

after(() => {
  db?.closeDataDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// --- validation -------------------------------------------------------------

test('a rate typed without its decimal point is rejected, not stored', () => {
  // The mistake the range exists for: 787 is the ×1,000 de-scaling and the FX
  // rate multiplied together, and it would inflate every figure a thousandfold.
  const check = fx.validateFxRate('787', 0.787);
  assert.equal(check.ok, false);
  assert.equal(check.reason, 'too_large');
});

test('validation rejects zero, negatives and non-numbers with distinct reasons', () => {
  assert.equal(fx.validateFxRate('0', 0.787).reason, 'not_positive');
  assert.equal(fx.validateFxRate('-0.5', 0.787).reason, 'not_a_number');
  assert.equal(fx.validateFxRate('abc', 0.787).reason, 'not_a_number');
  assert.equal(fx.validateFxRate('', 0.787).reason, 'empty');
  assert.equal(fx.validateFxRate(null, 0.787).reason, 'empty');
  // Exponent notation is not how anyone types a rate, and Number() would
  // happily turn it into 100000.
  assert.equal(fx.validateFxRate('1e5', 0.787).reason, 'not_a_number');
  assert.equal(fx.validateFxRate('0.00000001', 0.787).reason, 'too_small');
});

test('a plausible rate passes, and a big move is flagged rather than blocked', () => {
  const small = fx.validateFxRate('0.812', 0.787);
  assert.equal(small.ok, true);
  assert.equal(small.value, 0.812);
  assert.equal(small.largeChange, false);

  // A rate really can move this far, so this is a warning, not a rejection.
  const big = fx.validateFxRate('2.5', 0.787);
  assert.equal(big.ok, true);
  assert.equal(big.largeChange, true);

  // Thousands separators are what a person types.
  assert.equal(fx.validateFxRate('1,5', 1).ok, true);
});

// --- staleness --------------------------------------------------------------

test('a rate older than the data by more than 90 days is stale', () => {
  // Config rate is dated 2026-08-07; data from 2027-01 is ~150 days newer.
  giveSiteData('shwe666', '2027-01');

  const check = fx.checkFxRateStale('shwe666', { now: NOW });
  assert.equal(check.stale, true);
  assert.ok(check.gapDays > 90, `expected a gap over 90 days, got ${check.gapDays}`);
  assert.equal(check.dataDate, '2027-01-31', 'a month counts as its last day');
});

test('a rate within 90 days of the data is not stale', () => {
  giveSiteData('shwe666', '2026-09');

  const check = fx.checkFxRateStale('shwe666', { now: NOW });
  assert.equal(check.stale, false);
  assert.ok(check.gapDays <= 90);
});

test('data older than the rate never warns — the gap only counts one way', () => {
  // The question is "am I pricing new data with an old rate", so a site nobody
  // has uploaded to in months must stay quiet.
  giveSiteData('shwe666', '2025-01');

  const check = fx.checkFxRateStale('shwe666', { now: NOW });
  assert.equal(check.stale, false);
  assert.ok(check.gapDays < 0);
});

test('a baht site has no rate to go stale', () => {
  giveSiteData('ubet89', '2030-01');
  const check = fx.checkFxRateStale('ubet89', { now: NOW });
  assert.equal(check.stale, false);
  assert.equal(check.reason, 'no_conversion');
});

test('a site with no data at all does not warn', () => {
  assert.equal(fx.checkFxRateStale('shwe666', { now: NOW }).reason, 'no_data');
});

test('the warning names the site, the rate, its date, the gap and the fix', () => {
  giveSiteData('shwe666', '2027-01');
  const text = fx.formatStaleWarning(fx.checkFxRateStale('shwe666', { now: NOW }));

  assert.match(text, /SH666/);
  assert.match(text, /0\.787/);
  assert.match(text, /2026-08-07/);
  assert.match(text, /\d+ วัน/);
  // A warning that does not say how to fix it just repeats every week.
  assert.match(text, /\/fxrate SH666/);
});

// --- alert cooldown ---------------------------------------------------------

test('the same site is not warned twice inside a week', () => {
  assert.equal(fx.alertDue('shwe666', { now: NOW }), true, 'first warning is due');

  fx.markAlerted('shwe666', { now: NOW });

  assert.equal(fx.alertDue('shwe666', { now: NOW + 6 * DAY_MS }), false, 'still inside the cooldown');
  assert.equal(fx.alertDue('shwe666', { now: NOW + 8 * DAY_MS }), true, 'cooldown has passed');
  // The cooldown is per site.
  assert.equal(fx.alertDue('ubet89', { now: NOW }), true);
});

// --- override storage and precedence ---------------------------------------

test('an override in SQLite wins over the config value', () => {
  assert.equal(sites.getSite('shwe666').fxRate, 0.787, 'config value to begin with');

  fx.applyFxRateUpdate({ site: 'shwe666', fxRate: 0.812, updatedBy: '509832984', now: NOW });

  const site = sites.getSite('shwe666');
  assert.equal(site.fxRate, 0.812);
  assert.equal(site.fxRateAsOf, '2026-08-07', 'the rate is dated when it was entered');
  // And the derived factor moves with it — this is what actually converts money.
  assert.equal(site.moneyFactor, 1000 * 0.812);
});

test('with no override the config value is used', () => {
  const rate = fx.currentFxRate('shwe666');
  assert.equal(rate.fxRate, 0.787);
  assert.equal(rate.source, 'config');

  fx.applyFxRateUpdate({ site: 'shwe666', fxRate: 0.9, updatedBy: '1', now: NOW });
  assert.equal(fx.currentFxRate('shwe666').source, 'override');
});

test('rate changes are appended, never overwritten, so the history survives', () => {
  fx.applyFxRateUpdate({ site: 'shwe666', fxRate: 0.8, updatedBy: '111', now: NOW });
  fx.applyFxRateUpdate({ site: 'shwe666', fxRate: 0.82, updatedBy: '222', now: NOW + DAY_MS });

  const history = db.listFxRateHistory('shwe666');
  assert.equal(history.length, 2, 'both changes are on record');
  // Newest first, and each row explains its own change.
  assert.equal(history[0].fx_rate, 0.82);
  assert.equal(history[0].previous_rate, 0.8, 'the row records what it displaced');
  assert.equal(history[0].updated_by, '222', 'and who made it');
  assert.equal(history[1].fx_rate, 0.8);
  assert.equal(history[1].previous_rate, 0.787, 'the first change displaced the config value');
});

test('overrides survive a restart', () => {
  fx.applyFxRateUpdate({ site: 'shwe666', fxRate: 0.812, updatedBy: '509832984', now: NOW });

  // What a process restart looks like: in-memory layer gone, database intact.
  sites.clearFxOverrides();
  assert.equal(sites.getSite('shwe666').fxRate, 0.787, 'back to config before loading');

  fx.loadFxOverrides();
  assert.equal(sites.getSite('shwe666').fxRate, 0.812, 'the stored rate is restored');
});

test('updating the rate stops the warning by itself', () => {
  giveSiteData('shwe666', '2027-01');
  assert.equal(fx.checkFxRateStale('shwe666', { now: NOW }).stale, true);

  // Dated the day it was entered, which is after the data — so the gap the
  // warning measures becomes negative and nothing has to be cleared.
  fx.applyFxRateUpdate({
    site: 'shwe666',
    fxRate: 0.812,
    updatedBy: '509832984',
    now: Date.parse('2027-02-15T00:00:00Z'),
  });

  const after = fx.checkFxRateStale('shwe666', { now: Date.parse('2027-02-15T00:00:00Z') });
  assert.equal(after.stale, false);
  assert.equal(after.fxRateAsOf, '2027-02-15');
});

test('a change is only visible once applied — validation alone writes nothing', () => {
  const check = fx.validateFxRate('0.9', 0.787);
  assert.equal(check.ok, true);

  // Validation is a pure check. Nothing may reach the database or the rate in
  // force until the confirm handler calls applyFxRateUpdate.
  assert.equal(db.listFxRateHistory('shwe666').length, 0);
  assert.equal(sites.getSite('shwe666').fxRate, 0.787);
});

// --- the pending-confirm record --------------------------------------------

test('a staged change waits in the database and does not touch the live rate', () => {
  db.setPendingFxUpdate('chat-1', {
    site: 'shwe666',
    fxRate: 0.812,
    previousRate: 0.787,
    requestedBy: '509832984',
  });

  const pending = db.getPendingFxUpdate('chat-1');
  assert.equal(pending.site, 'shwe666');
  assert.equal(pending.fx_rate, 0.812);
  // Staged, not applied.
  assert.equal(sites.getSite('shwe666').fxRate, 0.787);
  assert.equal(db.listFxRateHistory('shwe666').length, 0);

  db.clearPendingFxUpdate('chat-1');
  assert.equal(db.getPendingFxUpdate('chat-1'), undefined);
});

test('a second request replaces the first rather than queueing behind it', () => {
  db.setPendingFxUpdate('chat-1', { site: 'shwe666', fxRate: 0.8, previousRate: 0.787, requestedBy: '1' });
  db.setPendingFxUpdate('chat-1', { site: 'shwe666', fxRate: 0.9, previousRate: 0.787, requestedBy: '1' });

  assert.equal(db.getPendingFxUpdate('chat-1').fx_rate, 0.9, 'the newest request is the live one');
});

// --- the newest-data date ---------------------------------------------------

test('the newest data date comes from raw files and parsed rows alike', () => {
  // Parsing is lazy, so a file uploaded seconds ago has only its year_month.
  giveSiteData('shwe666', '2026-06');
  assert.equal(db.latestDataDate('shwe666'), '2026-06-30');

  // And retention deletes old raw files while keeping the parsed rows, so the
  // parsed side has to count too.
  const raw = db.findRawFile({ site: 'shwe666', yearMonth: '2026-06', fileType: 'daily_value' });
  db.insertParsedRows(raw.id, {
    fileType: 'daily_value',
    site: 'shwe666',
    yearMonth: '2026-07',
    rows: [{ row: { Date: '2026-07-15' }, rowDate: '2026-07-15' }],
  });
  assert.equal(db.latestDataDate('shwe666'), '2026-07-15', 'whichever source is newer wins');

  assert.equal(db.latestDataDate('88fed'), null, 'a site with nothing has no date');
});
