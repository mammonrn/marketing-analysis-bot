import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.TELEGRAM_BOT_TOKEN ??= 'test-token';
process.env.ANTHROPIC_API_KEY ??= 'test-key';

const { pickFileType } = await import('../src/data/query.js');

test('pickFileType routes VIP questions to vip', () => {
  assert.equal(pickFileType('VIP สัปดาห์นี้เป็นยังไง'), 'vip');
  assert.equal(pickFileType('ลูกค้าใหญ่ของ SH666'), 'vip');
  assert.equal(pickFileType('big bettor stats'), 'vip');
});

test('pickFileType routes new-member questions to new_member_quality', () => {
  assert.equal(pickFileType('สมาชิกใหม่คุณภาพดีขึ้นไหม'), 'new_member_quality');
  assert.equal(pickFileType('1st new deposit ล่าสุด'), 'new_member_quality');
  assert.equal(pickFileType('delayed deposit rate'), 'new_member_quality');
  assert.equal(pickFileType('verify rate เท่าไหร่'), 'new_member_quality');
});

test('pickFileType routes count/frequency questions to deposit_count_distribution', () => {
  assert.equal(pickFileType('power user สัดส่วนเท่าไหร่'), 'deposit_count_distribution');
  assert.equal(pickFileType('casual user กี่ %'), 'deposit_count_distribution');
  assert.equal(pickFileType('21+ counts เพิ่มไหม'), 'deposit_count_distribution');
  assert.equal(pickFileType('จำนวนครั้งฝากเงินเฉลี่ย'), 'deposit_count_distribution');
});

test('pickFileType routes game/brand questions to brand_game_value', () => {
  assert.equal(pickFileType('สล็อตไหนทำเงินสูงสุด'), 'brand_game_value');
  assert.equal(pickFileType('brand value ตามเกม'), 'brand_game_value');
  assert.equal(pickFileType('fish shooting revenue'), 'brand_game_value');
  assert.equal(pickFileType('ยิงปลา ยอดเท่าไหร่'), 'brand_game_value');
});

test('pickFileType routes English and mixed-language new-member questions', () => {
  // The exact question from the reported failure: the file was ingested and
  // stored correctly under shwe666/2026-07/new_member_quality, but this
  // routed to daily_value, so the model was handed the wrong report and
  // truthfully said the New Member Quality file had not been uploaded.
  assert.equal(pickFileType('คุณภาพ new member เดือน 7 เป็นยังไง'), 'new_member_quality');
  assert.equal(pickFileType('new member quality เดือนนี้'), 'new_member_quality');
  assert.equal(pickFileType('new mems เพิ่มขึ้นไหม'), 'new_member_quality');
  assert.equal(pickFileType('member ใหม่เดือนนี้เป็นไง'), 'new_member_quality');
  assert.equal(pickFileType('คุณภาพสมาชิกเดือน 7'), 'new_member_quality');
  assert.equal(pickFileType('คนใหม่ที่สมัครมาคุณภาพดีไหม'), 'new_member_quality');
});

test('pickFileType routes English game names to brand_game_value', () => {
  assert.equal(pickFileType('slot vs fish อันไหนดีกว่า'), 'brand_game_value');
  assert.equal(pickFileType('game type ไหนกำไรสูงสุด'), 'brand_game_value');
  assert.equal(pickFileType('เกมไหนทำเงินดีที่สุด'), 'brand_game_value');
});

test('pickFileType routes English deposit-frequency questions', () => {
  assert.equal(pickFileType('deposit frequency เดือนนี้'), 'deposit_count_distribution');
  assert.equal(pickFileType('ลูกค้าฝากกี่ครั้งต่อเดือน'), 'deposit_count_distribution');
});

test('pickFileType defaults to daily_value for general questions', () => {
  assert.equal(pickFileType('RTP เท่าไหร่'), 'daily_value');
  assert.equal(pickFileType('revenue วันนี้'), 'daily_value');
  assert.equal(pickFileType('ภาพรวมประจำวัน'), 'daily_value');
});
