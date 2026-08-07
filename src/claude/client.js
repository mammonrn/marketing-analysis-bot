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
import { relevanceHint } from '../data/query.js';

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

/**
 * The user turn, split into a cacheable prefix and a volatile remainder.
 *
 * Order is the whole point. Caching is a prefix match, so everything stable
 * must physically precede everything that changes — and the previous version
 * had it backwards: the session's turns (which grow with every question) were
 * concatenated *ahead* of the data context (identical for a whole site+month),
 * inside one string with nowhere to put a breakpoint. ~36k tokens of unchanged
 * data were re-billed at full price on every question.
 *
 * Now: [ data context ] [ turns + hint + question ]. Only the first block is
 * marked, so a follow-up question about the same site and month reads the data
 * back from cache instead of re-sending it.
 *
 * The "which file matters most" hint lives in the volatile block on purpose —
 * it depends on the question, and putting it in the cached block is exactly
 * what used to make that block un-cacheable (see `manifestOrder` in query.js).
 */
function buildUserContent({ question, dataContext, turns, isSummary }) {
  const stable = [];
  const volatile = [];

  if (dataContext) {
    stable.push(
      '--- ข้อมูลจริงจากไฟล์ Excel ที่ทีมงานอัปโหลดเข้าบอท ---\n' +
        'ตัวเลขด้านล่างนี้เป็นค่าที่อ่านมาจากไฟล์จริง ใช้เฉพาะข้อมูลนี้ ห้ามเดาตัวเลขเพิ่ม\n' +
        dataContext,
    );
  } else if (!isSummary) {
    volatile.push(
      '--- ไม่มีข้อมูลไฟล์ที่อัปโหลดสำหรับคำถามนี้ ---\n' +
        'ยังไม่มีคนอัปโหลดไฟล์ที่เกี่ยวข้อง (เว็บ/เดือน/ประเภทไฟล์นี้) — ห้ามแต่งตัวเลขขึ้นมาเอง ' +
        'ให้บอกผู้ใช้ว่าต้องอัปโหลดไฟล์ไหนเพิ่ม และใส่เหตุผลใน data_gaps',
    );
  }

  if (isSummary) {
    volatile.push(
      'SESSION_SUMMARY_REQUEST\n' +
        'ผู้ใช้ขอสรุปท้าย session — ให้สรุปจากทุก turn ด้านล่างนี้ทั้งหมด ไม่ใช่แค่คำถามสุดท้าย\n\n' +
        `--- ประวัติการถามใน session นี้ (${turns.length} คำถาม) ---\n${renderTurns(turns)}`,
    );
  } else if (turns?.length) {
    // Light context so follow-ups like "แล้วเดือนก่อนล่ะ" resolve correctly.
    const recent = turns.slice(-6);
    volatile.push(
      `--- บริบทก่อนหน้าใน session นี้ (${recent.length} คำถามล่าสุด) ---\n${renderTurns(recent)}`,
    );
  }

  if (!isSummary) {
    if (dataContext) volatile.push(`--- คำแนะนำการอ่านข้อมูล ---\n${relevanceHint(question)}`);
    volatile.push(`--- คำถามของผู้ใช้ ---\n${question}`);
  }

  volatile.push('ตอบกลับเป็น JSON object เดียวตาม bot delivery contract เท่านั้น');

  return { stable: stable.join('\n\n'), volatile: volatile.join('\n\n') };
}

/**
 * Below this many characters the data block is sent uncached.
 *
 * The prefix at this breakpoint always clears the model's minimum on its own —
 * the system prompt ahead of it is ~27k tokens — so this is not a correctness
 * guard. It is a value one: a breakpoint costs a cache write on the tokens it
 * adds, and a data block of a few hundred characters cannot repay that. Roughly
 * 1,000 tokens at the repo's usual chars/3.2 estimate.
 */
const MIN_CACHEABLE_DATA_CHARS = 3200;

/**
 * 5 minutes by default: its write premium is 1.25x against the 1-hour tier's
 * 2x, so it breaks even after two requests where the 1-hour tier needs three.
 * That is the conservative choice while nothing has been measured — a session
 * that asks one question and stops loses 0.25x here instead of 1.0x.
 *
 * `ANTHROPIC_CACHE_TTL=1h` switches tiers. Worth doing once
 * `npm run report:cache` shows a hit rate that clears three requests per cached
 * prefix, which the 20-minute session idle window makes plausible: follow-ups
 * more than 5 minutes apart are within one session but past a 5-minute TTL.
 */
function userMessage({ stable, volatile }) {
  if (!stable) return [{ role: 'user', content: volatile }];

  const dataBlock = { type: 'text', text: stable };
  if (stable.length >= MIN_CACHEABLE_DATA_CHARS) {
    dataBlock.cache_control =
      config.anthropic.cacheTtl === '1h'
        ? { type: 'ephemeral', ttl: '1h' }
        : { type: 'ephemeral' };
  }

  return [{ role: 'user', content: [dataBlock, { type: 'text', text: volatile }] }];
}

/**
 * What the cache actually did, every call.
 *
 * A cache that never hits is invisible: the bot answers normally and the bill
 * goes up. `cache_read_input_tokens` staying at 0 across repeated questions
 * about the same site and month is the signal that something upstream became
 * non-deterministic again. Logged at info, not debug, so it is in the file
 * `npm run report:cache` reads.
 */
function logCacheUsage(usage, meta) {
  const read = usage?.cache_read_input_tokens ?? 0;
  const written = usage?.cache_creation_input_tokens ?? 0;
  const fresh = usage?.input_tokens ?? 0;
  const total = read + written + fresh;

  logger.info('anthropic usage', {
    ...meta,
    inputTokens: fresh,
    cacheReadTokens: read,
    cacheWriteTokens: written,
    totalPromptTokens: total,
    outputTokens: usage?.output_tokens ?? 0,
    cacheHitRate: total > 0 ? Number((read / total).toFixed(4)) : 0,
  });
}

/** Exposed for tests: the prompt-shaping step, with no network involved. */
export const __testing = {
  buildMessages: (args) => userMessage(buildUserContent(args)),
};

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
  const parts = buildUserContent({ question, dataContext, turns, isSummary });

  const messages = userMessage(parts);

  const response = await callWithRetry({
    model: config.anthropic.model,
    max_tokens: config.anthropic.maxTokens,
    system,
    messages,
  });

  let raw = textOf(response);
  logCacheUsage(response?.usage, { call: 'answer', isFraud, isSummary });

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
        // Same `messages` prefix, so the revision reads the data block back
        // from cache instead of re-sending it.
        messages: [
          ...messages,
          { role: 'assistant', content: raw },
          { role: 'user', content: buildFraudRevisionInstruction(check) },
        ],
      });

      logCacheUsage(revision?.usage, { call: 'fraud_revision', isFraud, isSummary });
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
