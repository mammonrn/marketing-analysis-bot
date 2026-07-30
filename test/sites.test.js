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
