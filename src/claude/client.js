import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { buildSystemBlocks } from '../prompt/loader.js';
import { parseEnvelope } from './envelope.js';
import {
  validateFraudResponse,
  buildFraudRevisionInstruction,
  FRAUD_FALLBACK_MESSAGE,
} from '../fraud/guard.js';
import { siteDisplayName } from '../data/sites.js';

const client = new Anthropic({ apiKey: config.anthropic.apiKey });

const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504, 529]);
const MAX_ATTEMPTS = 4;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isRetryable(err) {
  if (RETRYABLE_STATUS.has(err?.status)) return true;
  const code = err?.cause?.code ?? err?.code;
  return ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED'].includes(code);
}

async function callWithRetry(params) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      return await client.messages.create(params);
    } catch (err) {
      lastError = err;
      if (!isRetryable(err) || attempt === MAX_ATTEMPTS) throw err;
      const delay = 2 ** (attempt - 1) * 1000;
      logger.warn('anthropic call failed, retrying', {
        attempt,
        delayMs: delay,
        status: err?.status,
        message: err?.message,
      });
      await sleep(delay);
    }
  }
  throw lastError;
}

function textOf(response) {
  return (response?.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

/**
 * Render the session's turns for the summary call.
 * spec §5.3 step 1 is explicit that the whole session goes in, not just the
 * latest question.
 */
function renderTurns(turns) {
  return turns
    .map((turn, index) => {
      const when = new Date(turn.ts).toISOString();
      const metrics = (turn.metrics ?? [])
        .map((m) => `${m.name}=${m.value}${m.status ? ` (${m.status})` : ''}`)
        .join(', ');
      return [
        `${index + 1}. [${when}] เว็บ: ${turn.site ? siteDisplayName(turn.site) : 'ไม่ระบุ'}`,
        `   คำถาม: ${turn.question}`,
        metrics ? `   ค่าที่ตอบไป: ${metrics}` : '   ค่าที่ตอบไป: (ไม่มีตัวเลข)',
      ].join('\n');
    })
    .join('\n');
}

function buildUserContent({ question, dataContext, turns, isSummary }) {
  const parts = [];

  if (isSummary) {
    parts.push(
      'SESSION_SUMMARY_REQUEST\n' +
        'ผู้ใช้ขอสรุปท้าย session — ให้สรุปจากทุก turn ด้านล่างนี้ทั้งหมด ไม่ใช่แค่คำถามสุดท้าย\n\n' +
        `--- ประวัติการถามใน session นี้ (${turns.length} คำถาม) ---\n${renderTurns(turns)}`,
    );
  } else if (turns?.length) {
    // Light context so follow-ups like "แล้วเดือนก่อนล่ะ" resolve correctly.
    const recent = turns.slice(-6);
    parts.push(
      `--- บริบทก่อนหน้าใน session นี้ (${recent.length} คำถามล่าสุด) ---\n${renderTurns(recent)}`,
    );
  }

  if (dataContext) {
    parts.push(
      '--- ข้อมูลจริงจากไฟล์ Excel ที่ทีมงานอัปโหลดเข้าบอท ---\n' +
        'ตัวเลขด้านล่างนี้เป็นค่าที่อ่านมาจากไฟล์จริง ใช้เฉพาะข้อมูลนี้ ห้ามเดาตัวเลขเพิ่ม\n' +
        dataContext,
    );
  } else if (!isSummary) {
    parts.push(
      '--- ไม่มีข้อมูลไฟล์ที่อัปโหลดสำหรับคำถามนี้ ---\n' +
        'ยังไม่มีคนอัปโหลดไฟล์ที่เกี่ยวข้อง (เว็บ/เดือน/ประเภทไฟล์นี้) — ห้ามแต่งตัวเลขขึ้นมาเอง ' +
        'ให้บอกผู้ใช้ว่าต้องอัปโหลดไฟล์ไหนเพิ่ม และใส่เหตุผลใน data_gaps',
    );
  }

  if (!isSummary) parts.push(`--- คำถามของผู้ใช้ ---\n${question}`);

  parts.push('ตอบกลับเป็น JSON object เดียวตาม bot delivery contract เท่านั้น');
  return parts.join('\n\n');
}

/**
 * Ask Claude one question.
 *
 * When `isFraud` is set, the reply must satisfy the 5-part structure before it
 * leaves the process. One revision attempt is allowed; if that also fails the
 * caller gets a refusal message rather than an unvetted accusation.
 */
export async function askClaude({
  question,
  dataContext = null,
  turns = [],
  isFraud = false,
  isSummary = false,
}) {
  const system = buildSystemBlocks();
  const userContent = buildUserContent({ question, dataContext, turns, isSummary });

  const messages = [{ role: 'user', content: userContent }];

  const response = await callWithRetry({
    model: config.anthropic.model,
    max_tokens: config.anthropic.maxTokens,
    system,
    messages,
  });

  let raw = textOf(response);
  logger.debug('anthropic usage', { usage: response?.usage, isFraud, isSummary });

  let envelope = parseEnvelope(raw);

  if (isFraud || envelope.responseKind === 'fraud') {
    let check = validateFraudResponse(envelope.replyMarkdown);

    if (!check.ok) {
      logger.warn('fraud response failed validation — asking for one revision', {
        missingSections: check.missingSections,
        verdictHits: check.verdictHits,
      });

      const revision = await callWithRetry({
        model: config.anthropic.model,
        max_tokens: config.anthropic.maxTokens,
        system,
        messages: [
          ...messages,
          { role: 'assistant', content: raw },
          { role: 'user', content: buildFraudRevisionInstruction(check) },
        ],
      });

      raw = textOf(revision);
      const revised = parseEnvelope(raw);
      check = validateFraudResponse(revised.replyMarkdown);

      if (check.ok) {
        envelope = revised;
      } else {
        logger.error('fraud response still invalid after revision — refusing to send', {
          missingSections: check.missingSections,
          verdictHits: check.verdictHits,
        });
        return {
          ...revised,
          replyMarkdown: FRAUD_FALLBACK_MESSAGE,
          responseKind: 'fraud',
          showChart: false,
          chart: null,
          fraudBlocked: true,
        };
      }
    }

    // Fraud answers are text to be read, never a chart (spec §7 + overlay §4).
    envelope.showChart = false;
    envelope.chart = null;
    envelope.responseKind = 'fraud';
  }

  return { ...envelope, fraudBlocked: false };
}
