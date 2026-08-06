/**
 * "Still working on it" reporting for the slow file paths.
 *
 * Reading a six-month export takes tens of seconds. That work now happens on
 * a worker thread (`data/parseRunner.js`), which is precisely what makes this
 * module possible: the main thread's timers keep firing, so it can narrate
 * progress while the worker grinds.
 *
 * One message, edited in place. Sending a fresh message every few seconds
 * would bury the chat, and the whole point is that the user can keep talking
 * to the bot meanwhile.
 *
 * Nothing here is allowed to break the operation it is describing — every
 * Telegram call is best-effort, and a failure to report is logged and dropped.
 */

import { logger } from '../logger.js';

const UPDATE_INTERVAL_MS = 6000;

const nf = new Intl.NumberFormat('en-US');

function describe(latest) {
  switch (latest?.phase) {
    case 'aggregating':
      return `สรุปแล้ว ${nf.format(latest.processed)}/${nf.format(latest.total)} แถว`;
    case 'read':
      return `อ่านได้ ${nf.format(latest.rowsRead)} แถว กำลังสรุป`;
    default:
      // The SheetJS read is a single opaque call, so there is genuinely
      // nothing to report but the fact that it is running.
      return 'กำลังอ่านไฟล์';
  }
}

/**
 * Starts reporting. The first message is only sent once the work has already
 * been running for `UPDATE_INTERVAL_MS`, so the ordinary small uploads — which
 * finish in milliseconds — never produce one at all.
 *
 * Returns an `onProgress` to hand to the parser and a `finish` to call in a
 * `finally`, which stops the timer and clears the message away so the real
 * reply is the last thing in the chat.
 */
export function startProgressReporter(telegram, chatId, { label } = {}) {
  const startedAt = Date.now();
  let latest = null;
  let currentLabel = label;
  let messageId = null;
  let stopped = false;
  let sending = false;

  const text = () => {
    const seconds = Math.round((Date.now() - startedAt) / 1000);
    const name = currentLabel ? ` *${currentLabel}*` : '';
    return `⏳ กำลังประมวลผลไฟล์${name} — ${describe(latest)} (${seconds} วิ)`;
  };

  const tick = async () => {
    // Skip rather than queue: a slow edit must not pile up behind the timer.
    if (stopped || sending) return;
    sending = true;
    try {
      if (messageId === null) {
        const sent = await telegram.sendMessage(chatId, text(), { parse_mode: 'Markdown' });
        messageId = sent?.message_id ?? null;
      } else {
        await telegram.editMessageText(chatId, messageId, undefined, text(), {
          parse_mode: 'Markdown',
        });
      }
    } catch (err) {
      // "message is not modified" is routine when nothing changed between ticks.
      const description = err?.response?.description ?? err?.message ?? '';
      if (!/not modified/i.test(description)) {
        logger.warn('progress update failed', { chatId, description });
      }
    } finally {
      sending = false;
    }
  };

  const timer = setInterval(tick, UPDATE_INTERVAL_MS);
  timer.unref?.();

  return {
    onProgress(update) {
      latest = update;
      if (update?.label) currentLabel = update.label;
    },
    async finish() {
      stopped = true;
      clearInterval(timer);
      if (messageId !== null) {
        await telegram.deleteMessage(chatId, messageId).catch(() => {});
      }
    },
  };
}
