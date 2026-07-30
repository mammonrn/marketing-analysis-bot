import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { inspectSkillBundle, buildSystemBlocks, SKILL_MANIFEST } from '../src/prompt/loader.js';
import { findMissingSections } from '../src/fraud/guard.js';
import { SKILL_DIR, PROMPT_DIR } from '../src/paths.js';

test('the full skill bundle is present', () => {
  const report = inspectSkillBundle();
  assert.deepEqual(
    report.missing.map((m) => m.file),
    [],
    'every manifest file must be synced into skills/thai-data-analyst',
  );
  assert.equal(report.present.length, SKILL_MANIFEST.length);
  assert.equal(report.overlayPresent, true);
});

test('SKILL.md is the Conversational Mode version, not the older report-only one', () => {
  const skill = fs.readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf8');
  // These two headings are what distinguish the new SKILL.md. Re-syncing an old
  // copy would silently revert the bot to Full Report Mode behaviour.
  assert.match(skill, /## โหมดการตอบ/, 'missing the "โหมดการตอบ" section');
  assert.match(
    skill,
    /### Session และ Dashboard สรุปท้าย session/,
    'missing the session/dashboard section',
  );
  assert.match(skill, /### Conversational Mode/);
});

test('system prompt blocks are ordered and cached correctly', () => {
  const blocks = buildSystemBlocks({ force: true });

  // preamble + 9 skill files + overlay
  assert.equal(blocks.length, SKILL_MANIFEST.length + 2);

  const skillIndex = blocks.findIndex((b) => b.text.includes('BEGIN skill file: SKILL.md'));
  const casinoIndex = blocks.findIndex((b) =>
    b.text.includes('BEGIN skill file: references/casino-metrics.md'));
  const overlayIndex = blocks.findIndex((b) => b.text.includes('BEGIN bot delivery contract'));

  assert.ok(skillIndex > 0, 'SKILL.md has a block');
  assert.ok(skillIndex < casinoIndex, 'SKILL.md comes before the references');
  assert.equal(overlayIndex, blocks.length - 1, 'the overlay is last so it is not overridden');

  // One cache breakpoint, on the final block, so the whole static prefix caches.
  const cached = blocks.filter((b) => b.cache_control);
  assert.equal(cached.length, 1);
  assert.equal(cached[0], blocks.at(-1));
});

test('skill files are embedded verbatim, byte for byte', () => {
  const blocks = buildSystemBlocks({ force: true });
  // spec §4 forbids paraphrasing; assert the raw file text appears unmodified.
  for (const entry of SKILL_MANIFEST) {
    const raw = fs.readFileSync(path.join(SKILL_DIR, entry.file), 'utf8');
    const block = blocks.find((b) => b.text.includes(`BEGIN skill file: ${entry.file}`));
    assert.ok(block, `no block for ${entry.file}`);
    assert.ok(block.text.includes(raw), `${entry.file} was altered before embedding`);
  }
});

/**
 * The overlay tells the model which exact Thai headings to use, and guard.js
 * matches on those headings. If either side is reworded independently, fraud
 * replies start getting rejected in production — this test ties them together.
 */
test('the fraud headings the overlay mandates satisfy the guard', () => {
  const overlay = fs.readFileSync(path.join(PROMPT_DIR, 'bot-overlay.md'), 'utf8');

  const mandated = [
    'สิ่งที่พบ',
    'ทำไมถึงน่าสงสัย',
    'ระดับความน่าสงสัย',
    'คำอธิบายทางเลือกที่เป็นไปได้',
    'ขั้นตอนถัดไปที่แนะนำ',
  ];

  for (const heading of mandated) {
    assert.ok(overlay.includes(heading), `overlay no longer mandates the heading "${heading}"`);
  }

  // A reply using exactly those headings must pass the validator.
  const reply = mandated.map((h) => `${h}: รายละเอียด`).join('\n');
  assert.deepEqual(findMissingSections(reply), []);
});

test('the overlay defers to SKILL.md rather than restating its rules', () => {
  const overlay = fs.readFileSync(path.join(PROMPT_DIR, 'bot-overlay.md'), 'utf8');

  // It must state the precedence rule explicitly.
  assert.match(overlay, /ให้ยึดไฟล์ skill/);

  // And it must not re-specify the answer structure that SKILL.md owns — a
  // second, slightly different copy of those rules is how the two drift apart.
  // The section names are the tell: if they appear here, the structure is being
  // restated. (Naming the rule in order to defer to it is fine and expected.)
  for (const sectionName of ['ข้อดี', 'ข้อเสีย', 'คำแนะนำ']) {
    assert.equal(
      overlay.includes(sectionName),
      false,
      `the overlay restates the "${sectionName}" section — SKILL.md owns the answer structure`,
    );
  }
});
