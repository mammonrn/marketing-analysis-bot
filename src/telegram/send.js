/**
 * Message delivery helpers.
 *
 * Telegram rejects a whole message when Markdown is malformed, and the model
 * writes Thai prose containing `_`, `*`, `(` and `.` freely. Rather than trying
 * to escape MarkdownV2 perfectly, send as Markdown and fall back to plain text —
 * the user gets the content either way, which matters more than the bold.
 */

import { logger } from '../logger.js';

const TELEGRAM_LIMIT = 4096;

/** Split on paragraph, then line, then hard-cut — never mid-message-silently. */
export function chunk(text, limit = TELEGRAM_LIMIT) {
  const body = String(text ?? '');
  if (body.length <= limit) return [body];

  const chunks = [];
  let current = '';

  for (const paragraph of body.split('\n\n')) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length <= limit) {
      current = candidate;
      continue;
    }
    if (current) {
      chunks.push(current);
      current = '';
    }
    if (paragraph.length <= limit) {
      current = paragraph;
      continue;
    }
    // Single oversized paragraph: break it on lines, then by force.
    let rest = paragraph;
    while (rest.length > limit) {
      const cut = rest.lastIndexOf('\n', limit);
      const at = cut > limit * 0.5 ? cut : limit;
      chunks.push(rest.slice(0, at));
      rest = rest.slice(at).replace(/^\n/, '');
    }
    current = rest;
  }

  if (current) chunks.push(current);
  return chunks;
}

/**
 * Send text, retrying once without Markdown if Telegram rejects the entities.
 * `extra` (keyboards etc.) is attached to the final chunk only, so buttons land
 * under the whole answer.
 */
export async function sendSafe(telegram, chatId, text, extra = {}) {
  const parts = chunk(text);

  for (let i = 0; i < parts.length; i += 1) {
    const isLast = i === parts.length - 1;
    const options = isLast ? { ...extra } : {};

    try {
      await telegram.sendMessage(chatId, parts[i], { parse_mode: 'Markdown', ...options });
    } catch (err) {
      const description = err?.response?.description ?? err?.message ?? '';
      if (/parse|entit|markdown/i.test(description)) {
        logger.warn('markdown rejected, resending as plain text', { chatId, description });
        await telegram.sendMessage(chatId, parts[i], options);
      } else {
        throw err;
      }
    }
  }
}
