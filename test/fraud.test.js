import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectFraudIntent,
  validateFraudResponse,
  findMissingSections,
  findVerdictLanguage,
} from '../src/fraud/guard.js';

test('recognises fraud questions in Thai', () => {
  assert.equal(detectFraudIntent('มีพนักงานโกงไหม'), true);
  assert.equal(detectFraudIntent('U89 มี referrer ผิดปกติไหม'), true);
  assert.equal(detectFraudIntent('สงสัยว่ามีบัญชีม้า'), true);
  assert.equal(detectFraudIntent('เช็ค manual credit ผิดปกติ'), true);
  assert.equal(detectFraudIntent('มี bonus abuse ไหม'), true);
  assert.equal(detectFraudIntent('ตัวเลขนี้ผิดปกติไหม'), true);
});

test('recognises fraud questions in English', () => {
  assert.equal(detectFraudIntent('any suspicious referrer?'), true);
  assert.equal(detectFraudIntent('check for fraud'), true);
  assert.equal(detectFraudIntent('anomaly detection please'), true);
});

test('leaves ordinary metric questions alone', () => {
  assert.equal(detectFraudIntent('RTP ของ SH666 เดือนนี้เป็นยังไง'), false);
  assert.equal(detectFraudIntent('DAU เพิ่มขึ้นไหม'), false);
  assert.equal(detectFraudIntent(''), false);
  assert.equal(detectFraudIntent(null), false);
});

const COMPLETE_REPLY = `
*สิ่งที่พบ*: referrer ABC123 มี downline 240 คน แต่ BIn Mems% เพียง 0.8%
*ทำไมถึงน่าสงสัย*: สัดส่วนคนที่ฝากจริงต่ำกว่า percentile 95 ของ referrer ทั้งหมดมาก
*ระดับความน่าสงสัย*: กลาง — ปริมาณผิดปกติแต่ยังมีคำอธิบายอื่นได้
*คำอธิบายทางเลือก*: อาจเป็นแคมเปญที่ได้ traffic คุณภาพต่ำ หรือ tracking ซ้ำ
*ขั้นตอนถัดไป*: ควรตรวจสอบเพิ่มเติมโดยดู log การสมัครของ downline กลุ่มนี้
`;

test('accepts a reply carrying all 5 required sections', () => {
  const result = validateFraudResponse(COMPLETE_REPLY);
  assert.equal(result.ok, true);
  assert.deepEqual(result.missingSections, []);
  assert.deepEqual(result.verdictHits, []);
});

test('reports exactly which sections are missing', () => {
  const missing = findMissingSections('*สิ่งที่พบ*: มีอะไรแปลก ๆ');
  assert.ok(missing.includes('ระดับความน่าสงสัย'));
  assert.ok(missing.includes('คำอธิบายทางเลือก'));
  assert.ok(missing.includes('ขั้นตอนถัดไป'));
  assert.equal(missing.includes('สิ่งที่พบ'), false);
});

test('the alternative-explanation section cannot be skipped', () => {
  const withoutAlternatives = COMPLETE_REPLY.replace(
    /\*คำอธิบายทางเลือก\*.*\n/,
    '',
  );
  const result = validateFraudResponse(withoutAlternatives);
  assert.equal(result.ok, false);
  assert.deepEqual(result.missingSections, ['คำอธิบายทางเลือก']);
});

test('catches verdict language that convicts someone', () => {
  assert.ok(findVerdictLanguage('สรุปว่าพนักงานคนนี้โกงแน่นอน').length > 0);
  assert.ok(findVerdictLanguage('ฟันธงได้เลยว่าทุจริต').length > 0);
  assert.ok(findVerdictLanguage('ยืนยันว่ามีการโกง').length > 0);
  assert.ok(findVerdictLanguage('คนที่โกงคือ user นี้').length > 0);
});

test('permitted hedged wording passes', () => {
  assert.deepEqual(findVerdictLanguage('ควรตรวจสอบเพิ่มเติม'), []);
  assert.deepEqual(findVerdictLanguage('เป็นสัญญาณที่ควรเฝ้าระวัง'), []);
  // The word "โกง" alone is fine — it is the certainty that is forbidden.
  assert.deepEqual(findVerdictLanguage('อาจเกี่ยวข้องกับการโกงได้ ควรตรวจสอบ'), []);
});

test('a complete reply that still convicts is rejected', () => {
  const result = validateFraudResponse(`${COMPLETE_REPLY}\nสรุปคือโกงแน่นอน`);
  assert.equal(result.ok, false);
  assert.deepEqual(result.missingSections, []);
  assert.ok(result.verdictHits.length > 0);
});
