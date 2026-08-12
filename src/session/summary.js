/**
 * End of a session (spec §5.2, §5.3).
 *
 * Two entry points, deliberately separated:
 *   - closeIdleSession() → the timeout path. Closes the session and says so.
 *                          It builds nothing: an idle timeout must not push a
 *                          dashboard, or a model call, at someone who walked
 *                          away from their desk.
 *   - runSummary()       → builds the wrap-up, only ever on an explicit ask
 *                          (/สรุป, /จบ, or the "สรุป session นี้" menu button).
 */

import { config } from '../config.js';
import { logger } from '../logger.js';
import { askClaude } from '../claude/client.js';
import { sendSafe } from '../telegram/send.js';
import { siteDisplayName } from '../data/sites.js';
import { getTurns, clearSession, createSummaryToken } from './store.js';

/**
 * Close a session that went quiet, then tell the chat it happened.
 *
 * Closed first, announced second: the message states the session is already
 * closed, so the state has to be true before it is sent. It also means a send
 * that fails (blocked bot, deleted chat) leaves a closed session rather than
 * one the sweeper would find idle again a minute later.
 */
export async function closeIdleSession(telegram, chatId) {
  const turns = getTurns(chatId);
  // Nothing was asked, so there is no session to announce the end of.
  if (turns.length === 0) return false;

  const sites = [...new Set(turns.map((t) => t.site).filter(Boolean))]
    .map(siteDisplayName)
    .join(', ');

  const text =
    `✅ session นี้ปิดอัตโนมัติแล้ว (ไม่มีคำถามใหม่เกิน ${config.session.idleMinutes} นาที)\n` +
    `คุยกันไปทั้งหมด *${turns.length} คำถาม*${sites ? ` (เว็บ: ${sites})` : ''}\n` +
    'พิมพ์คำถามใหม่ได้เลยครับ เดี๋ยวเปิด session ใหม่ให้';

  clearSession(chatId);
  logger.info('session closed on idle', { chatId, turns: turns.length });

  // No keyboard. The old flow ended in "สรุปเลย / ยังไม่ต้อง" buttons, which
  // went stale the moment the message scrolled away; asking again by typing is
  // what /สรุป is for.
  await sendSafe(telegram, chatId, text);
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
 * Idle sweeper. Runs on a timer and closes sessions that went quiet.
 *
 * Nothing keeps a "already handled this one" flag any more: closing a session
 * archives its turns, and `findIdleSessions` only returns sessions that still
 * have turns, so a closed session cannot come back around on the next sweep.
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
        await closeIdleSession(telegram, session.chat_id);
      } catch (err) {
        // A blocked bot or deleted chat must not kill the sweeper. The session
        // is already closed by this point, so there is nothing to undo.
        logger.warn('could not announce an idle session close', {
          chatId: session.chat_id,
          message: err?.message,
        });
      }
    }
  }, intervalMs);

  timer.unref?.();
  return timer;
}
