import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectSite, getSite, siteDisplayName, SITES } from '../src/data/sites.js';

test('detects the spec spellings (SH666 / U89 / 88F)', () => {
  assert.equal(detectSite('RTP ของ SH666 เดือนนี้เป็นยังไง'), 'shwe666');
  assert.equal(detectSite('U89 สมาชิกใหม่เป็นไง'), 'ubet89');
  assert.equal(detectSite('88F มี referrer ผิดปกติไหม'), '88fed');
});

test('detects the skill spellings (shwe666 / ubet89 / 88fed)', () => {
  assert.equal(detectSite('ดู shwe666 หน่อย'), 'shwe666');
  assert.equal(detectSite('ubet89 revenue'), 'ubet89');
  assert.equal(detectSite('88fed DAU'), '88fed');
});

test('is case insensitive', () => {
  assert.equal(detectSite('sh666 rtp'), 'shwe666');
  assert.equal(detectSite('Sh666 RTP'), 'shwe666');
});

test('prefers the longer alias when one contains another', () => {
  // "88fed" contains "88"; the longer match must win.
  assert.equal(detectSite('88fed เดือนนี้'), '88fed');
});

test('returns null when no site is named, so the session fallback applies', () => {
  assert.equal(detectSite('RTP คืออะไร'), null);
  assert.equal(detectSite(''), null);
  assert.equal(detectSite(null), null);
});

test('currency factors match casino-metrics.md', () => {
  // SH666 is MMK: drop 3 zeros, then MMK→THB at 0.787.
  assert.equal(SITES.shwe666.moneyFactor, 787);
  // U89 and 88F are already THB: only drop the 3 zeros.
  assert.equal(SITES.ubet89.moneyFactor, 1000);
  assert.equal(SITES['88fed'].moneyFactor, 1000);
});

test('moneyFactor is derived from scaleFactor × fxRate, not stored', () => {
  // The regression that matters: splitting the number apart must not move it.
  for (const site of Object.values(SITES)) {
    assert.equal(
      site.moneyFactor,
      site.scaleFactor * site.fxRate,
      `${site.canonical} moneyFactor must equal scaleFactor × fxRate`,
    );
  }

  // And each half is separately readable, which is the point of the split.
  assert.equal(SITES.shwe666.scaleFactor, 1000);
  assert.equal(SITES.shwe666.fxRate, 0.787);
  assert.equal(SITES.shwe666.currency, 'MMK');
  assert.equal(SITES.shwe666.needsFxConversion, true);
});

test('pointsScaleFactor is separate from scaleFactor, not a rename of it', () => {
  // The point logs carry their own scale: SH666's `Points` column is ÷100,000
  // where its money columns are ÷1,000. Fusing the two is the bug.
  assert.equal(SITES.shwe666.scaleFactor, 1000);
  assert.equal(SITES.shwe666.pointsScaleFactor, 100000);
  assert.equal(SITES.shwe666.pointsFactor, 100000 * 0.787);
});

test('pointsFactor is derived from pointsScaleFactor × fxRate, not stored', () => {
  for (const site of Object.values(SITES)) {
    if (site.pointsScaleFactor === undefined) continue;
    assert.equal(
      site.pointsFactor,
      site.pointsScaleFactor * site.fxRate,
      `${site.canonical} pointsFactor must equal pointsScaleFactor × fxRate`,
    );
  }
});

test('a site with no verified point scale reports null rather than a default', () => {
  // Only SH666's scale has been checked against a real file. `null` is what
  // makes `aggregateBonusLog` throw instead of quietly reusing 100,000.
  assert.equal(SITES.ubet89.pointsFactor, null);
  assert.equal(SITES['88fed'].pointsFactor, null);
  assert.equal(SITES.ubet89.pointsScaleFactor, undefined);
  assert.equal(SITES['88fed'].pointsScaleFactor, undefined);
});

test('every site declares a currency, an fxRate and the date it was taken', () => {
  for (const site of Object.values(SITES)) {
    assert.ok(site.currency, `${site.canonical} must name its source currency`);
    assert.ok(Number.isFinite(site.fxRate) && site.fxRate > 0, `${site.canonical} needs a positive fxRate`);
    // A rate with no date is a rate nobody can tell is stale.
    assert.match(
      site.fxRateAsOf,
      /^\d{4}-\d{2}-\d{2}$/,
      `${site.canonical} fxRateAsOf must be YYYY-MM-DD`,
    );
  }
});

test('a THB site is marked as needing no conversion, not merely left blank', () => {
  // fxRate: 1 rather than an absent field — an absent rate cannot be told
  // apart from a forgotten one.
  assert.equal(SITES.ubet89.fxRate, 1);
  assert.equal(SITES.ubet89.needsFxConversion, false);
  assert.equal(SITES['88fed'].needsFxConversion, false);
});

test('getSite resolves aliases and canonical keys alike', () => {
  assert.equal(getSite('sh666').canonical, 'shwe666');
  assert.equal(getSite('shwe666').canonical, 'shwe666');
  assert.equal(getSite('nope'), null);
  assert.equal(getSite(null), null);
});

test('display names use the spec spelling', () => {
  assert.equal(siteDisplayName('shwe666'), 'SH666');
  assert.equal(siteDisplayName('ubet89'), 'U89');
  assert.equal(siteDisplayName('88fed'), '88F');
});
