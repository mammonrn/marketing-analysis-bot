import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.TELEGRAM_BOT_TOKEN ??= 'test-token';
process.env.ANTHROPIC_API_KEY ??= 'test-key';

const { pickTabKey } = await import('../src/data/sheets.js');

test('pickTabKey routes VIP questions to the vip tab', () => {
  assert.equal(pickTabKey('VIP สัปดาห์นี้เป็นยังไง'), 'vip');
  assert.equal(pickTabKey('ลูกค้าใหญ่ของ SH666'), 'vip');
  assert.equal(pickTabKey('big bettor stats'), 'vip');
});

test('pickTabKey routes new-member questions to newMember', () => {
  assert.equal(pickTabKey('สมาชิกใหม่คุณภาพดีขึ้นไหม'), 'newMember');
  assert.equal(pickTabKey('1st new deposit ล่าสุด'), 'newMember');
  assert.equal(pickTabKey('delayed deposit rate'), 'newMember');
  assert.equal(pickTabKey('verify rate เท่าไหร่'), 'newMember');
});

test('pickTabKey routes count/frequency questions to count', () => {
  assert.equal(pickTabKey('power user สัดส่วนเท่าไหร่'), 'count');
  assert.equal(pickTabKey('casual user กี่ %'), 'count');
  assert.equal(pickTabKey('21+ counts เพิ่มไหม'), 'count');
  assert.equal(pickTabKey('จำนวนครั้งฝากเงินเฉลี่ย'), 'count');
});

test('pickTabKey routes game/brand questions to brandValue', () => {
  assert.equal(pickTabKey('สล็อตไหนทำเงินสูงสุด'), 'brandValue');
  assert.equal(pickTabKey('brand value ตามเกม'), 'brandValue');
  assert.equal(pickTabKey('fish shooting revenue'), 'brandValue');
  assert.equal(pickTabKey('ยิงปลา ยอดเท่าไหร่'), 'brandValue');
});

test('pickTabKey defaults to daily for general questions', () => {
  assert.equal(pickTabKey('RTP เท่าไหร่'), 'daily');
  assert.equal(pickTabKey('revenue วันนี้'), 'daily');
  assert.equal(pickTabKey('ภาพรวมประจำวัน'), 'daily');
});
