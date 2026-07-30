import { Telegraf } from 'telegraf';
import { config, isWebhookMode } from '../config.js';
import { logger } from '../logger.js';
import { whitelistMiddleware, isSuperAdmin } from './auth.js';
import { sendSafe } from './send.js';
import { askClaude } from '../claude/client.js';
import { detectFraudIntent } from '../fraud/guard.js';
import { detectSite, siteDisplayName, ALL_SITE_KEYS } from '../data/sites.js';
import { buildDataContext, sheetsStatus, clearSheetsCache } from '../data/sheets.js';
import { inspectSkillBundle } from '../prompt/loader.js';
import {
  getOrCreateSession,
  touchSession,
  setSessionSite,
  addTurn,
  countTurns,
  createSummaryToken,
} from '../session/store.js';
import { runSummary, offerSummary, SUMMARY_YES, SUMMARY_NO } from '../session/summary.js';

const HELP_TEXT = [
  '*ads-analytics-bot* — ผู้ช่วยวิเคราะห์ผลประกอบการ',
  '',
  'พิมพ์คำถามเป็นภาษาไทยได้เลย เช่น',
  '• `RTP ของ SH666 เดือนนี้เป็นยังไง`',
  '• `U89 สมาชิกใหม่คุณภาพดีขึ้นไหม`',
  '• `88F มี referrer ผิดปกติไหม`',
  '',
  '*คำสั่ง*',
  '`/สรุป` — สรุปภาพรวม session + dashboard',
  '`/จบ` — จบ session แล้วสรุป',
  '`/เว็บ SH666` — เปลี่ยนเว็บที่กำลังคุย',
  '`/whoami` — ดู Telegram ID ของคุณ',
  '',
  `เว็บที่รองรับ: ${ALL_SITE_KEYS.map(siteDisplayName).join(' / ')}`,
  '',
  '_บอทจะไม่สร้างกราฟทุกคำถาม — กราฟจะขึ้นตอนสรุปหรือตอนที่จำเป็นจริง ๆ_',
].join('\n');

/**
 * Thai slash-commands have to be matched by hand.
 * Telegram only tags `/word` as a bot_command entity when the word is ASCII, so
 * `/สรุป` arrives as ordinary text and `bot.command()` never fires for it —
 * hence this router runs before the question handler.
 */
const THAI_COMMANDS = [
  { re: /^\/?\s*(สรุป|สรุปหน่อย|ขอสรุป)\s*$/, action: 'summary' },
  { re: /^\/?\s*(จบ|จบเลย|จบ session|ปิด session)\s*$/i, action: 'summary' },
  { re: /^\/?\s*(ช่วยเหลือ|วิธีใช้)\s*$/, action: 'help' },
  { re: /^\/?\s*เว็บ\s+(.+)$/, action: 'setSite' },
];

function matchThaiCommand(text) {
  const body = String(text ?? '').trim();
  for (const entry of THAI_COMMANDS) {
    const match = body.match(entry.re);
    if (match) return { action: entry.action, arg: match[match.length - 1] };
  }
  return null;
}

/** Attach a Mini App button for a single-question chart (spec §6). */
function chartKeyboard(chatId, envelope) {
  if (!envelope.showChart || !envelope.chart) return {};
  if (!config.http.publicUrl) {
    logger.warn('PUBLIC_URL not set — chart requested but no Mini App link possible');
    return {};
  }

  const token = createSummaryToken(chatId, {
    generatedAt: new Date().toISOString(),
    turnCount: 1,
    sites: envelope.site ? [siteDisplayName(envelope.site)] : [],
    summaryText: envelope.replyMarkdown,
    chart: envelope.chart,
    metrics: envelope.metrics,
  });

  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: '📊 ดูกราฟ', web_app: { url: `${config.http.publicUrl}/miniapp?token=${token}` } }],
      ],
    },
  };
}

async function handleQuestion(ctx, question) {
  const chatId = ctx.chat.id;
  const userId = ctx.from.id;

  getOrCreateSession(chatId, userId);
  touchSession(chatId);

  const session = getOrCreateSession(chatId, userId);
  // Remember the last site so follow-ups need not repeat it (spec §5.1).
  const site = detectSite(question) ?? session.site ?? null;
  if (site) setSessionSite(chatId, site);

  const isFraud = detectFraudIntent(question);

  const typing = setInterval(() => {
    ctx.telegram.sendChatAction(chatId, 'typing').catch(() => {});
  }, 5000);
  ctx.telegram.sendChatAction(chatId, 'typing').catch(() => {});

  try {
    const dataContext = site ? await buildDataContext(site, question) : null;

    const envelope = await askClaude({
      question,
      dataContext,
      turns: [],
      isFraud,
    });

    if (envelope.showChart && envelope.responseKind !== 'summary') {
      logger.info('chart requested for a single question', { chatId, site });
    }

    addTurn(chatId, {
      question,
      site: envelope.site ?? site,
      metrics: envelope.metrics,
      reply: envelope.replyMarkdown,
      responseKind: envelope.responseKind,
    });
    if (envelope.site) setSessionSite(chatId, envelope.site);

    const gaps = envelope.dataGaps.length
      ? `\n\n_ข้อมูลที่ยังขาด: ${envelope.dataGaps.join('; ')}_`
      : '';

    await sendSafe(
      ctx.telegram,
      chatId,
      `${envelope.replyMarkdown}${gaps}`,
      chartKeyboard(chatId, envelope),
    );

    logger.info('answered', {
      chatId,
      site: envelope.site ?? site,
      kind: envelope.responseKind,
      isFraud,
      showChart: envelope.showChart,
      fraudBlocked: envelope.fraudBlocked,
      turns: countTurns(chatId),
    });
  } finally {
    clearInterval(typing);
  }
}

export function createBot() {
  const bot = new Telegraf(config.telegram.token, { handlerTimeout: 120_000 });

  bot.use(whitelistMiddleware());

  bot.start((ctx) => sendSafe(ctx.telegram, ctx.chat.id, HELP_TEXT));
  bot.help((ctx) => sendSafe(ctx.telegram, ctx.chat.id, HELP_TEXT));

  bot.command('whoami', (ctx) =>
    sendSafe(
      ctx.telegram,
      ctx.chat.id,
      `Telegram ID ของคุณ: \`${ctx.from.id}\`\nChat ID: \`${ctx.chat.id}\`` +
        (isSuperAdmin(ctx.from.id) ? '\nสิทธิ์: *Super Admin*' : ''),
    ),
  );

  // ASCII aliases for the Thai commands, for anyone typing on a English keyboard.
  bot.command(['summary', 'sarup'], (ctx) => runSummary(ctx.telegram, ctx.chat.id));
  bot.command(['end', 'job'], (ctx) => runSummary(ctx.telegram, ctx.chat.id));

  bot.command('site', (ctx) => {
    const arg = ctx.message.text.split(/\s+/).slice(1).join(' ');
    return applySiteChange(ctx, arg);
  });

  bot.command('status', async (ctx) => {
    if (!isSuperAdmin(ctx.from.id)) {
      return sendSafe(ctx.telegram, ctx.chat.id, 'คำสั่งนี้ใช้ได้เฉพาะ Super Admin ครับ');
    }
    const skill = inspectSkillBundle();
    const sheets = sheetsStatus();
    const lines = [
      '*สถานะระบบ*',
      '',
      `โมเดล: \`${config.anthropic.model}\``,
      `idle timeout: ${config.session.idleMinutes} นาที`,
      `ผู้ใช้ที่อนุญาต: ${config.access.allowedIds.size} คน`,
      '',
      `*Skill files* (${skill.present.length}/${skill.present.length + skill.missing.length})`,
      ...skill.present.map((p) => `✅ ${p.file} — ${p.lines} บรรทัด`),
      ...skill.missing.map((m) => `${m.required ? '🚨' : '⚠️'} ขาด: ${m.file} (${m.label})`),
      '',
      '*Google Sheets*',
      `credentials: ${sheets.credentialsConfigured ? '✅ ตั้งค่าแล้ว' : '❌ ยังไม่ได้ตั้งค่า'}`,
      ...(Object.keys(sheets.sites).length
        ? Object.entries(sheets.sites).map(([s, v]) => `• ${s}: ${v.tabs.join(', ') || 'ไม่มีแท็บ'}`)
        : ['• ยังไม่ได้ตั้ง SHEETS_CONFIG']),
    ];
    return sendSafe(ctx.telegram, ctx.chat.id, lines.join('\n'));
  });

  bot.command('refresh', async (ctx) => {
    if (!isSuperAdmin(ctx.from.id)) {
      return sendSafe(ctx.telegram, ctx.chat.id, 'คำสั่งนี้ใช้ได้เฉพาะ Super Admin ครับ');
    }
    clearSheetsCache();
    return sendSafe(ctx.telegram, ctx.chat.id, '🔄 ล้าง cache ข้อมูล Sheets แล้ว');
  });

  bot.action(SUMMARY_YES, async (ctx) => {
    await ctx.answerCbQuery('กำลังสรุป...').catch(() => {});
    await ctx.editMessageReplyMarkup(undefined).catch(() => {});
    return runSummary(ctx.telegram, ctx.chat.id);
  });

  bot.action(SUMMARY_NO, async (ctx) => {
    await ctx.answerCbQuery('โอเคครับ').catch(() => {});
    await ctx.editMessageReplyMarkup(undefined).catch(() => {});
    return sendSafe(ctx.telegram, ctx.chat.id, 'โอเคครับ ถามต่อได้เลย — พิมพ์ `/สรุป` เมื่อไหร่ก็ได้');
  });

  bot.on('text', async (ctx) => {
    const text = ctx.message.text?.trim();
    if (!text) return undefined;

    const command = matchThaiCommand(text);
    if (command?.action === 'summary') return runSummary(ctx.telegram, ctx.chat.id);
    if (command?.action === 'help') return sendSafe(ctx.telegram, ctx.chat.id, HELP_TEXT);
    if (command?.action === 'setSite') return applySiteChange(ctx, command.arg);

    // An unrecognised ASCII slash-command should not be sent to Claude as a question.
    if (/^\//.test(text) && /^\/[a-z0-9_]+/i.test(text)) {
      return sendSafe(ctx.telegram, ctx.chat.id, `ไม่รู้จักคำสั่งนี้ครับ\n\n${HELP_TEXT}`);
    }

    return handleQuestion(ctx, text);
  });

  bot.catch((err, ctx) => {
    logger.error('unhandled bot error', {
      chatId: ctx?.chat?.id,
      updateType: ctx?.updateType,
      message: err?.message,
      stack: err?.stack?.split('\n').slice(0, 4).join(' | '),
    });
    ctx?.telegram
      ?.sendMessage(
        ctx.chat.id,
        '⚠️ เกิดข้อผิดพลาดในระบบ ลองถามใหม่อีกครั้งครับ — ถ้ายังไม่หายให้แจ้งผู้ดูแล',
      )
      .catch(() => {});
  });

  return bot;
}

async function applySiteChange(ctx, arg) {
  const site = detectSite(arg);
  if (!site) {
    return sendSafe(
      ctx.telegram,
      ctx.chat.id,
      `ไม่รู้จักเว็บ "${arg}" ครับ — ใช้ได้: ${ALL_SITE_KEYS.map(siteDisplayName).join(' / ')}`,
    );
  }
  getOrCreateSession(ctx.chat.id, ctx.from.id);
  setSessionSite(ctx.chat.id, site);
  return sendSafe(ctx.telegram, ctx.chat.id, `✅ เปลี่ยนไปคุยเรื่อง *${siteDisplayName(site)}* แล้ว`);
}

export async function launchBot(bot, app) {
  if (isWebhookMode()) {
    if (!config.http.publicUrl) throw new Error('TELEGRAM_MODE=webhook requires PUBLIC_URL');
    if (!config.telegram.webhookSecret) throw new Error('TELEGRAM_MODE=webhook requires WEBHOOK_SECRET');

    const path = config.telegram.webhookPath;
    app.use(await bot.createWebhook({
      domain: config.http.publicUrl,
      path,
      secret_token: config.telegram.webhookSecret,
    }));
    logger.info('telegram webhook registered', { url: `${config.http.publicUrl}${path}` });
  } else {
    // Long polling: nothing to expose publicly, which keeps Nginx untouched.
    await bot.telegram.deleteWebhook({ drop_pending_updates: false }).catch(() => {});
    bot.launch({ dropPendingUpdates: false }).catch((err) => {
      logger.error('polling failed', { message: err?.message });
    });
    logger.info('telegram polling started');
  }
}
