/**
 * Whitelist (spec §8).
 *
 * Default-deny: an id must appear in ALLOWED_TELEGRAM_IDS (or be the Super
 * Admin) to get any answer at all. Adding a teammate is an env change plus a
 * pm2 restart — no redeploy — which is why the list lives in config, not code.
 */

import { config } from '../config.js';
import { logger } from '../logger.js';

export function isAllowed(userId) {
  if (userId === undefined || userId === null) return false;
  return config.access.allowedIds.has(String(userId));
}

export function isSuperAdmin(userId) {
  return String(userId) === String(config.access.superAdminId);
}

const DENIED_MESSAGE =
  '⛔ บอทนี้ใช้ได้เฉพาะทีมงานที่ได้รับอนุญาต\n' +
  'ถ้าต้องการเข้าถึง กรุณาแจ้งผู้ดูแลระบบพร้อมแจ้ง Telegram ID ของคุณ';

/** Telegraf middleware: stop unauthorised updates before they cost an API call. */
export function whitelistMiddleware() {
  return async (ctx, next) => {
    const userId = ctx.from?.id;

    if (!isAllowed(userId)) {
      logger.warn('blocked unauthorised user', {
        userId,
        username: ctx.from?.username,
        chatId: ctx.chat?.id,
      });
      try {
        await ctx.reply(`${DENIED_MESSAGE}\n\nTelegram ID ของคุณ: \`${userId}\``, {
          parse_mode: 'Markdown',
        });
      } catch (err) {
        logger.debug('could not notify blocked user', { message: err?.message });
      }
      return undefined;
    }

    return next();
  };
}
