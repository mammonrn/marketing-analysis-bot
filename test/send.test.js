import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunk } from '../src/telegram/send.js';

test('short text stays a single message', () => {
  assert.deepEqual(chunk('สวัสดีครับ'), ['สวัสดีครับ']);
});

test('splits on paragraph boundaries when possible', () => {
  const paragraph = 'ก'.repeat(60);
  const parts = chunk([paragraph, paragraph, paragraph].join('\n\n'), 100);
  assert.ok(parts.length > 1);
  for (const part of parts) assert.ok(part.length <= 100);
});

test('an oversized single paragraph is split on line breaks', () => {
  const line = 'ข'.repeat(40);
  const body = Array.from({ length: 6 }, () => line).join('\n');
  const parts = chunk(body, 100);
  for (const part of parts) assert.ok(part.length <= 100);
  // Nothing may be silently dropped.
  assert.equal(parts.join('\n').replace(/\n/g, ''), body.replace(/\n/g, ''));
});

test('a single unbroken run longer than the limit is hard-cut, not dropped', () => {
  const body = 'ค'.repeat(250);
  const parts = chunk(body, 100);
  assert.equal(parts.length, 3);
  for (const part of parts) assert.ok(part.length <= 100);
  assert.equal(parts.join(''), body);
});

test('every chunk respects the Telegram 4096 limit by default', () => {
  const body = Array.from({ length: 400 }, (_, i) => `บรรทัดที่ ${i} ${'ง'.repeat(30)}`).join('\n');
  for (const part of chunk(body)) assert.ok(part.length <= 4096);
});

test('handles empty and nullish input', () => {
  assert.deepEqual(chunk(''), ['']);
  assert.deepEqual(chunk(null), ['']);
});
