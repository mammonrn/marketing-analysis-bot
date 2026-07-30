/**
 * End-of-session dashboard (spec §5.2, §5.3).
 *
 * Two entry points, deliberately separated:
 *   - offerSummary()  → asks first. The spec is explicit that an idle timeout
 *                       must not push a dashboard unprompted.
 *   - runSummary()    → actually builds it, on an explicit yes or /สรุป.
 */

import { config } from '../config.js';
import { logger } from '../logger.js';
import { askClaude } from '../claude/client.js';
import { sendSafe } from '../telegram/send.js';
import { siteDisplayName } from '../data/sites.js';
import { getTurns, clearSession, createSummaryToken, markSummaryPrompted } from './store.js';

export const SUMMARY_YES = 'summary:yes';
export const SUMMARY_NO = 'summary:no';

/** Ask whether the user wants a wrap-up, without generating one yet. */
export async function offerSummary(telegram, chatId, { idle = false } = {}) {
  const turns = getTurns(chatId);
  if (turns.length === 0) return false;

  const sites = [...new Set(turns.map((t) => t.site).filter(Boolean))]
    .map(siteDisplayName)
    .join(', ');

  const lead = idle
    ? `⏳ ไม่มีคำถามใหม่มา ${config.session.idleMinutes} นาทีแล้ว`
    : '📋 สรุป session';

  const text =
    `${lead}\n\n` +
    `session นี้คุยกันไป *${turns.length} คำถาม*${sites ? ` (เว็บ: ${sites})` : ''}\n` +
    'ต้องการให้สรุปภาพรวม + dashboard ไหมครับ?';

  await sendSafe(telegram, chatId, text, {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '📊 สรุปเลย', callback_data: SUMMARY_YES },
          { text: 'ยังไม่ต้อง', callback_data: SUMMARY_NO },
        ],
      ],
    },
  });

  if (idle) markSummaryPrompted(chatId);
  return true;
}

/**
 * Build the summary, send it, and reset the session.
 * The chart goes to the Mini App rather than into the chat, because Chart.js
 * rendering is the Mini App's job (spec §5.3 step 3).
 */
export async function runSummary(telegram, chatId) {
  const turns = getTurns(chatId);

  if (turns.length === 0) {
    await sendSafe(telegram, chatId, 'ยังไม่มีคำถามใน session นี้ให้สรุปครับ — ถามอะไรมาก่อนได้เลย');
    return;
  }

  await telegram.sendChatAction(chatId, 'typing').catch(() => {});

  const envelope = await askClaude({
    question: 'สรุป session',
    turns,
    isSummary: true,
  });

  const extra = {};

  if (envelope.showChart && envelope.chart) {
    const payload = {
      generatedAt: new Date().toISOString(),
      turnCount: turns.length,
      sites: [...new Set(turns.map((t) => t.site).filter(Boolean))].map(siteDisplayName),
      summaryText: envelope.replyMarkdown,
      chart: envelope.chart,
      metrics: turns.flatMap((t) => t.metrics ?? []),
    };
    const token = createSummaryToken(chatId, payload);

    if (config.http.publicUrl) {
      extra.reply_markup = {
        inline_keyboard: [
          [
            {
              text: '📊 เปิด Dashboard',
              web_app: { url: `${config.http.publicUrl}/miniapp?token=${token}` },
            },
          ],
        ],
      };
    } else {
      logger.warn('PUBLIC_URL not set — cannot attach Mini App button');
    }
  }

  const gaps = envelope.dataGaps.length
    ? `\n\n_ข้อมูลที่ยังขาด: ${envelope.dataGaps.join('; ')}_`
    : '';

  await sendSafe(telegram, chatId, `${envelope.replyMarkdown}${gaps}`, extra);

  // spec §5.3 step 4 — archive the turns and start fresh.
  clearSession(chatId);
  logger.info('session summarised and cleared', { chatId, turns: turns.length });
}

/**
 * Idle sweeper. Runs on a timer and offers a summary to sessions that went
 * quiet; `markSummaryPrompted` stops it from asking the same session twice.
 */
export function startIdleSweeper(telegram, { findIdleSessions, intervalMs = 60_000 }) {
  const timer = setInterval(async () => {
    let idleSessions;
    try {
      idleSessions = findIdleSessions(config.session.idleMinutes);
    } catch (err) {
      logger.error('idle sweep query failed', { message: err?.message });
      return;
    }

    for (const session of idleSessions) {
      try {
        await offerSummary(telegram, session.chat_id, { idle: true });
        logger.info('offered idle summary', { chatId: session.chat_id });
      } catch (err) {
        // A blocked bot or deleted chat must not kill the sweeper.
        logger.warn('could not offer idle summary', {
          chatId: session.chat_id,
          message: err?.message,
        });
        markSummaryPrompted(session.chat_id);
      }
    }
  }, intervalMs);

  timer.unref?.();
  return timer;
}
