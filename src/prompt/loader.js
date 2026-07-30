/**
 * System prompt assembly (spec §4).
 *
 * Hard rule from the spec: the skill files are concatenated **verbatim**. We do
 * not paraphrase, reformat, or summarise them, because the benchmark numbers in
 * them are the output of real analysis and must match what the team already
 * signed off on in the claude.ai project.
 *
 * Consequence: this module only reads and orders files. If you find yourself
 * wanting to "clean up" a reference file here, change the skill file instead and
 * re-run `npm run sync:skill`.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { SKILL_DIR, PROMPT_DIR } from '../paths.js';
import { logger } from '../logger.js';

/**
 * Load order matters: SKILL.md first (it holds the routing logic), then shared
 * glossary, then per-site benchmarks, then per-report references, and fraud
 * last among the skill files so its "always report this way" rules stay salient.
 *
 * `required: true` means the bot refuses to start without it — for fraud that is
 * spec §4's explicit instruction ("ต้องรวมเข้า system prompt เสมอ"), and a bot
 * that answered fraud questions without those rules would be worse than one
 * that does not start.
 */
export const SKILL_MANIFEST = [
  { file: 'SKILL.md', required: true, label: 'หลัก + routing logic' },
  { file: 'references/casino-metrics.md', required: true, label: 'glossary + benchmark กลาง' },
  { file: 'references/u89-metrics.md', required: false, label: 'benchmark U89' },
  { file: 'references/88fed-metrics.md', required: false, label: 'benchmark 88F' },
  { file: 'references/new-member-quality.md', required: false, label: 'คุณภาพสมาชิกใหม่' },
  { file: 'references/deposit-count-distribution.md', required: false, label: 'การกระจายจำนวนครั้งฝาก' },
  { file: 'references/brand-game-value.md', required: false, label: 'มูลค่าตามประเภทเกม' },
  { file: 'references/vip-members.md', required: false, label: 'VIP' },
  { file: 'references/fraud-anomaly-detection.md', required: true, label: 'fraud / anomaly (บังคับ)' },
];

const OVERLAY_FILE = 'bot-overlay.md';

function readIfPresent(absPath) {
  try {
    return fs.readFileSync(absPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Inspect the skill directory without building a prompt.
 * Used by `npm run check:skill` and by the /skillstatus command.
 */
export function inspectSkillBundle() {
  const present = [];
  const missing = [];

  for (const entry of SKILL_MANIFEST) {
    const abs = path.join(SKILL_DIR, entry.file);
    const content = readIfPresent(abs);
    if (content === null) {
      missing.push(entry);
    } else {
      present.push({
        ...entry,
        chars: content.length,
        lines: content.split('\n').length,
        sha256: sha256(content),
      });
    }
  }

  const overlayAbs = path.join(PROMPT_DIR, OVERLAY_FILE);
  const overlay = readIfPresent(overlayAbs);

  return {
    present,
    missing,
    missingRequired: missing.filter((m) => m.required),
    overlayPresent: overlay !== null,
    totalChars: present.reduce((sum, p) => sum + p.chars, 0) + (overlay?.length ?? 0),
  };
}

let cached = null;

/**
 * Build the Anthropic `system` parameter: an array of text blocks.
 *
 * A single cache_control breakpoint sits on the final block. The whole system
 * prompt is static per process, so one breakpoint caches the entire prefix and
 * every question after the first pays the cheaper cache-read rate — this prompt
 * is ~70KB of benchmark text, so that matters.
 */
export function buildSystemBlocks({ force = false } = {}) {
  if (cached && !force) return cached;

  const report = inspectSkillBundle();

  if (report.missingRequired.length > 0) {
    const names = report.missingRequired.map((m) => m.file).join(', ');
    throw new Error(
      `System prompt incomplete — required skill file(s) missing: ${names}\n` +
        `คัดลอกไฟล์เข้า ${SKILL_DIR} แล้วรัน \`npm run check:skill\` เพื่อตรวจสอบ\n` +
        `(spec §4: ห้ามเขียน system prompt ใหม่เอง ต้องใช้ไฟล์จาก skill thai-data-analyst)`,
    );
  }

  if (report.missing.length > 0) {
    logger.warn('skill files missing — บอทจะทำงานได้แต่ขาด benchmark บางส่วน', {
      missing: report.missing.map((m) => m.file),
    });
  }

  const blocks = [];

  blocks.push({
    type: 'text',
    text:
      'คุณคือผู้ช่วยวิเคราะห์ข้อมูลของทีมงานภายใน ตอบผ่าน Telegram bot ชื่อ ads-analytics-bot\n' +
      'ด้านล่างนี้คือ skill `thai-data-analyst` ทั้งหมด (ต้นฉบับ ไม่ถูกแก้ไข) ตามด้วยกฎการส่งออกของบอท\n' +
      'ทุกตัวเลข benchmark ต้องอ้างจากไฟล์เหล่านี้เท่านั้น ห้ามใช้ความรู้ทั่วไปมาแทน',
  });

  for (const entry of report.present) {
    const abs = path.join(SKILL_DIR, entry.file);
    const content = fs.readFileSync(abs, 'utf8');
    blocks.push({
      type: 'text',
      text: `\n===== BEGIN skill file: ${entry.file} =====\n${content}\n===== END skill file: ${entry.file} =====\n`,
    });
  }

  const overlay = readIfPresent(path.join(PROMPT_DIR, OVERLAY_FILE));
  if (!overlay) {
    throw new Error(`Missing ${OVERLAY_FILE} in ${PROMPT_DIR} — bot output contract is required`);
  }
  blocks.push({
    type: 'text',
    text: `\n===== BEGIN bot delivery contract =====\n${overlay}\n===== END bot delivery contract =====\n`,
  });

  // Cache the entire static prefix.
  blocks[blocks.length - 1].cache_control = { type: 'ephemeral' };

  logger.info('system prompt assembled', {
    skillFiles: report.present.length,
    missing: report.missing.map((m) => m.file),
    totalChars: report.totalChars,
    approxTokens: Math.round(report.totalChars / 3.2),
  });

  cached = blocks;
  return cached;
}

export function resetPromptCache() {
  cached = null;
}
