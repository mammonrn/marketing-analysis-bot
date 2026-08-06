/**
 * Detection tests for the seven file types added in this change.
 *
 * Every header array below is copied verbatim from the real Power BI export
 * it names — including oddities like the double space in `BIn  (Pro)%` — so a
 * signature that only works against a tidied-up fixture cannot pass here.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectFileType,
  isHourPivotHeader,
  resolvePivotFileType,
} from '../src/data/fileTypes.js';

const REAL_HEADERS = {
  vip: ['Username', 'Real Name', 'RegDate', 'Lv', 'Referrer', 'AD', 'Agent', 'Last Login 2 Y',
    'Last BIn 2 Y', 'BIn', 'BIn Counts', 'BIn Days', 'Bo', 'R', 'Pro Counts', 'Pro', 'Pass',
    'Bonus', 'Med. BIn', 'Phone'],
  adAgent: ['AD / Agent', 'Agent', 'Total Mems', 'Total BIn Mems', 'BIn Mems%', 'BIn', 'ARPPU',
    'BIn  (Pro)%', 'Pro', 'Bonus', 'R', 'DAU', 'CIn', 'Pw'],
  referrer: ['Referrer', 'Ref Bonus', 'Total Mems', 'Total BIn Mems', 'BIn Mems%', 'BIn', 'ARPPU',
    'BIn  (Pro)%', 'Pro', 'Bonus', 'R', 'DAU', 'CIn', 'Pw'],
  memberDetail: ['Username', 'Referrer', 'BIn', 'Pro', 'R', 'BIn Days', 'BIn  (Pro)%',
    'Last BIn Date', 'Prefer Game'],
  depositDetail: ['Username', 'Type', 'TypeName', 'PayName', 'AddTime', 'Confirm Time',
    'Duration (m)', 'Points', 'Modifier', 'Status', 'UserTrueName (Info)', 'UserAccount (Info)',
    'UserBank (Info)', 'UserAccount (Manual Deposit)', 'CompanyAccount (Manual Deposit)'],
  bonusLog: ['AddTime', 'Type', 'Username', 'Lv', 'Points', 'Memo'],
  dailyCount: ['Date', 'BIn Mems', '1 Time', '2~5 Counts', '6~10 Counts', '11~20 Counts',
    '21+ Counts'],
  dailyFirstNew: ['Date', 'New', 'New (Ref.)', 'Verify', 'Verify%', '1st New%', '1st New Mems',
    '1st New (BIn)', '1st New (np%)', '1st Day Mems', '1st Day (BIn)', '1st Day (np%)'],
  dailyValue: ['Date', 'CIn', 'CIn (np)%', 'Nw', 'Nw (np)', 'RTP', 'BIn', 'BIn (np)%', 'Bo', 'R',
    'BIn (P)', 'Pro', 'Pass', 'Pro R', 'Bonus', 'Manual', 'R / BIn', 'BIn / Pro', 'Pass / Bo',
    'New Mems', 'DAU', 'BIn Mems', 'BIn Mems / DAU', 'BIn Mems (np)', 'Pro Mems',
    'Pro Counts / Pro Mems', 'Bo Mems', 'Bonus Mems', 'Manual Mems'],
  // The variant that motivated relaxing the daily_value signature: RTP and DAU
  // but no BIn column at all.
  dailyValueSixMonths: ['Date', 'CIn', 'CIn (np)%', 'Nw', 'RTP', 'DAU', 'DAU% (np)', 'Nw (np)',
    'Nw (p)', 'RTP (np)', 'RTP (p)'],
  hourPivot: ['Hour', 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
    21, 22, 23],
};

test('detects the three new snapshot types from their signature columns', () => {
  assert.equal(detectFileType(REAL_HEADERS.adAgent), 'ad_agent');
  assert.equal(detectFileType(REAL_HEADERS.referrer), 'referrer');
  assert.equal(detectFileType(REAL_HEADERS.memberDetail), 'member_detail');
});

test('detects the two transaction logs', () => {
  assert.equal(detectFileType(REAL_HEADERS.depositDetail), 'deposit_detail');
  assert.equal(detectFileType(REAL_HEADERS.bonusLog), 'bonus_log');
});

test('daily_value no longer requires BIn, so the 6-month variant is recognised', () => {
  assert.equal(detectFileType(REAL_HEADERS.dailyValueSixMonths), 'daily_value');
  assert.equal(detectFileType(REAL_HEADERS.dailyValue), 'daily_value');
});

test('relaxing daily_value does not swallow files that carry DAU for another reason', () => {
  // ad_agent and referrer both have DAU. Neither has RTP, and both are checked
  // before daily_value anyway — this pins both halves of that reasoning.
  assert.equal(detectFileType(REAL_HEADERS.adAgent), 'ad_agent');
  assert.equal(detectFileType(REAL_HEADERS.referrer), 'referrer');
  // brand_game_value does have both RTP and DAU, and must still win.
  assert.equal(detectFileType(['GameKind', 'CIn', 'RTP', 'DAU', 'Nw']), 'brand_game_value');
});

test('the existing four types still resolve from their real header rows', () => {
  assert.equal(detectFileType(REAL_HEADERS.vip), 'vip');
  assert.equal(detectFileType(REAL_HEADERS.dailyCount), 'deposit_count_distribution');
  assert.equal(detectFileType(REAL_HEADERS.dailyFirstNew), 'new_member_quality');
});

test('member_detail is not mistaken for vip, which has a different last-deposit column', () => {
  // Member_Detail has `Last BIn Date`; vip has `Last BIn 2 Y`. Both also carry
  // a Referrer column, so only the deposit column tells them apart.
  assert.equal(detectFileType(REAL_HEADERS.memberDetail), 'member_detail');
  assert.equal(detectFileType(REAL_HEADERS.vip), 'vip');
});

test('deposit_detail and bonus_log do not claim each other', () => {
  // Both carry Points, and Detail also carries Type — but only bonus.xlsx has
  // Memo+Lv, and only Detail has Confirm Time+PayName.
  assert.equal(detectFileType(REAL_HEADERS.depositDetail), 'deposit_detail');
  assert.equal(detectFileType(REAL_HEADERS.bonusLog), 'bonus_log');
});

test('the hour pivots are invisible to signature detection', () => {
  // They share a byte-identical header row, so detectFileType must decline and
  // leave the choice to the filename fallback.
  assert.equal(detectFileType(REAL_HEADERS.hourPivot), null);
  assert.ok(isHourPivotHeader(REAL_HEADERS.hourPivot));
});

test('the filename decides which hour pivot a file is', () => {
  assert.equal(
    resolvePivotFileType('Average BIn Mems (Week Day x Hour).xlsx'),
    'avg_bin_mems_by_hour',
  );
  assert.equal(resolvePivotFileType('Average BIn (Week Day x Hour).xlsx'), 'avg_bin_by_hour');
  // Real uploads arrive with the underscored names Telegram/Power BI produce.
  assert.equal(
    resolvePivotFileType('Average_BIn_Mems__Week_Day_Week_begins_on_Monday_x_Hour.xlsx'),
    'avg_bin_mems_by_hour',
  );
});

test('isHourPivotHeader rejects anything that is not the 25-column hour grid', () => {
  assert.equal(isHourPivotHeader(REAL_HEADERS.dailyValue), false);
  assert.equal(isHourPivotHeader(['Hour', 0, 1, 2]), false); // too few columns
  assert.equal(isHourPivotHeader(['Date', ...Array.from({ length: 24 }, (_, i) => i)]), false);
});

test('an unrecognised header set is still null', () => {
  assert.equal(detectFileType(['Foo', 'Bar']), null);
  assert.equal(isHourPivotHeader(['Foo', 'Bar']), false);
});
