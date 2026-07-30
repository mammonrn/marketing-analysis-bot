import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectFileType } from '../src/data/fileTypes.js';

test('detects vip from its unique Last BIn 2 Y column', () => {
  assert.equal(detectFileType(['Username', 'Real Name', 'RegDate', 'Last BIn 2 Y', 'BIn']), 'vip');
});

test('detects new_member_quality from 1st New%', () => {
  assert.equal(
    detectFileType(['Date', 'New', 'Verify%', '1st New%', '1st New Mems']),
    'new_member_quality',
  );
});

test('detects brand_game_value from GameKind, even though RTP/DAU also appear there', () => {
  assert.equal(detectFileType(['GameKind', 'CIn', 'RTP', 'DAU', 'Nw']), 'brand_game_value');
});

test('detects deposit_count_distribution from 21+ Counts', () => {
  assert.equal(
    detectFileType(['Date', 'BIn Mems', '1 Time', '2~5 Counts', '21+ Counts']),
    'deposit_count_distribution',
  );
});

test('falls back to daily_value when RTP+BIn+DAU are present and nothing more specific matches', () => {
  assert.equal(detectFileType(['CIn', 'RTP', 'BIn', 'DAU', 'R']), 'daily_value');
});

test('returns null for a header set that matches no known file type', () => {
  assert.equal(detectFileType(['Foo', 'Bar']), null);
});
