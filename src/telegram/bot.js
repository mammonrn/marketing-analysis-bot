import { Telegraf } from 'telegraf';
import { config, isWebhookMode } from '../config.js';
import { logger } from '../logger.js';
import { whitelistMiddleware, isSuperAdmin } from './auth.js';
import { sendSafe } from './send.js';
import { startProgressReporter } from './progress.js';
import { askClaude } from '../claude/client.js';
import { detectFraudIntent } from '../fraud/guard.js';
import { detectSite, siteDisplayName, ALL_SITE_KEYS } from '../data/sites.js';
import { buildDataContext, fileInventory } from '../data/query.js';
import { getFileType, FILE_TYPES } from '../data/fileTypes.js';
import {
  ingestUpload,
  resolvePendingSite,
  resolvePendingDuplicate,
  hasPendingUpload,
} from '../data/ingest.js';
import {
  currentFxRate,
  validateFxRate,
  applyFxRateUpdate,
  checkFxRateStale,
  alertDue,
  markAlerted,
  formatStaleWarning,
  MIN_FX_RATE,
  MAX_FX_RATE,
  LARGE_CHANGE_RATIO,
} from '../data/fxRates.js';
import { setPendingFxUpdate, getPendingFxUpdate, clearPendingFxUpdate } from '../data/db.js';
import { inspectSkillBundle } from '../prompt/loader.js';
import {
  getOrCreateSession,
  touchSession,
  setSessionSite,
  addTurn,
  countTurns,
  getTurns,
  createSummaryToken,
} from '../session/store.js';
import { runSummary, offerSummary, SUMMARY_YES, SUMMARY_NO } from '../session/summary.js';
import { setTelegramStatus } from '../runtime-state.js';

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
  '`/fxrate` — ดูอัตราแลกเปลี่ยนที่ใช้อยู่ (เปลี่ยนได้เฉพาะ Super Admin)',
  '`/whoami` — ดู Telegram ID ของคุณ',
  '',
  `เว็บที่รองรับ: ${ALL_SITE_KEYS.map(siteDisplayName).join(' / ')}`,
  '',
  '📎 ส่งไฟล์ Excel (.xlsx) เข้ามาในแชทได้เลยเพื่ออัปโหลดข้อมูลสิ้นเดือน — บอทจะเดาว่าเป็นไฟล์',
  'ประเภทไหนและเว็บไหนให้เอง ถ้าเดาเว็บไม่ได้จะถามกลับ',
  '',
  '_บอทจะไม่สร้างกราฟทุกคำถาม — กราฟจะขึ้นตอนสรุปหรือตอนที่จำเป็นจริง ๆ_',
].join('\n');

const UPLOAD_CONFIRM_YES = 'upload:yes';
const UPLOAD_CONFIRM_NO = 'upload:no';
const FX_CONFIRM_YES = 'fx:yes';
const FX_CONFIRM_NO = 'fx:no';

function fileTypeLabel(fileType) {
  return getFileType(fileType)?.label ?? fileType;
}

const DUPLICATE_KEYBOARD = {
  reply_markup: {
    inline_keyboard: [
      [
        { text: '✅ ใช่ อัปเดตทับ', callback_data: UPLOAD_CONFIRM_YES },
        { text: '❌ ไม่ ยกเลิก', callback_data: UPLOAD_CONFIRM_NO },
      ],
    ],
  },
};

const FX_KEYBOARD = {
  reply_markup: {
    inline_keyboard: [
      [
        { text: '✅ ยืนยันเปลี่ยน', callback_data: FX_CONFIRM_YES },
        { text: '❌ ยกเลิก', callback_data: FX_CONFIRM_NO },
      ],
    ],
  },
};

const FX_REJECTION = {
  empty: 'ไม่ได้ระบุอัตรามาครับ',
  not_a_number: 'อัตราต้องเป็นตัวเลขเท่านั้นครับ',
  not_positive: 'อัตราต้องมากกว่า 0 ครับ',
  too_small: `อัตราต่ำกว่า ${MIN_FX_RATE} — น้อยเกินกว่าจะเป็นอัตราจริงครับ`,
  // Named explicitly because it is the mistake this check exists for: the
  // ×1,000 de-scaling and the FX rate look alike, and 787 for 0.787 would
  // inflate every reported figure a thousandfold.
  too_large:
    `อัตราสูงกว่า ${MAX_FX_RATE} — น่าจะพิมพ์ตัวคูณ 1,000 มารวมด้วย ` +
    'ให้ใส่เฉพาะอัตราแลกเปลี่ยน เช่น `0.787` ไม่ใช่ `787` ครับ',
};

/**
 * Checks whether this site's rate has fallen behind its data, and says so at
 * most once a week.
 *
 * Runs after an upload lands because that is the moment the newest data date
 * can move — which is the only thing on either side of the comparison that
 * changes on its own.
 */
async function warnIfFxRateStale(telegram, chatId, site) {
  if (!site) return;
  try {
    const check = checkFxRateStale(site);
    if (!check.stale || !alertDue(site)) return;
    markAlerted(site);
    logger.info('fx rate staleness warning sent', {
      site,
      gapDays: check.gapDays,
      fxRateAsOf: check.fxRateAsOf,
      dataDate: check.dataDate,
    });
    await sendSafe(telegram, chatId, formatStaleWarning(check));
  } catch (err) {
    // A missing warning must never cost the user their upload confirmation.
    logger.warn('fx staleness check failed', { site, message: err?.message });
  }
}

/**
 * Reports on a whole batch at once.
 *
 * A single site name (or a single yes/no) now answers for every file that was
 * waiting, so the reply has to account for all of them — a per-file message
 * would be eleven notifications for one answer.
 */
async function respondToBatchResult(ctx, batch) {
  const chatId = ctx.chat.id;
  if (batch.status !== 'resolved') return respondToUploadResult(ctx, batch);

  const results = batch.results ?? [];
  const saved = results.filter((r) => r.status === 'saved');
  const needsConfirm = results.filter((r) => r.status === 'needs_confirm');
  const kept = results.filter((r) => r.status === 'kept_existing');
  const failed = results.filter((r) => r.status === 'missing_temp');

  const lines = [];

  if (saved.length > 0) {
    const site = siteDisplayName(saved[0].site);
    lines.push(`✅ บันทึก *${saved.length}* ไฟล์ของ *${site}* แล้วครับ`);
    lines.push(...saved.map((r) => `• ${fileTypeLabel(r.fileType)} — ${r.yearMonth}`));
  }

  if (kept.length > 0) {
    lines.push('', `↩️ ไม่อัปเดตทับ ${kept.length} ไฟล์ (เก็บของเดิมไว้)`);
  }

  if (failed.length > 0) {
    lines.push('', `⚠️ อ่านไฟล์ที่พักไว้ไม่ได้ ${failed.length} ไฟล์ — รบกวนส่งใหม่ครับ`);
    lines.push(...failed.map((r) => `• ${r.originalFilename}`));
  }

  if (needsConfirm.length > 0) {
    lines.push(
      '',
      `⚠️ อีก *${needsConfirm.length}* ไฟล์เหมือนกับที่เคยส่งมาแล้ว (ชื่อไฟล์และขนาดตรงกัน)`,
      ...needsConfirm.map((r) => `• ${fileTypeLabel(r.fileType)} — ${r.yearMonth}`),
      '',
      'ต้องการอัปเดตทับไหมครับ',
    );
    return sendSafe(ctx.telegram, chatId, lines.join('\n'), DUPLICATE_KEYBOARD);
  }

  if (lines.length === 0) return undefined;
  await sendSafe(ctx.telegram, chatId, lines.join('\n'));
  // One site answers for the whole batch, so one check covers it.
  return warnIfFxRateStale(ctx.telegram, chatId, saved[0]?.site);
}

/** Shared by the document handler, the pending-site text reply, and the duplicate-confirm buttons. */
async function respondToUploadResult(ctx, result) {
  const chatId = ctx.chat.id;

  switch (result.status) {
    case 'unrecognized':
      return sendSafe(
        ctx.telegram,
        chatId,
        'ไม่รู้จักรูปแบบไฟล์นี้ครับ — ตรวจว่าเป็น Power BI export ที่มี column ตรงกับที่ระบบรู้จัก\n\n' +
          `ประเภทไฟล์ที่รองรับตอนนี้ (${FILE_TYPES.length} ชนิด):\n` +
          // Built from the manifest so it cannot drift out of date the way the
          // hardcoded list of five did. One per line rather than slash-joined:
          // several labels ("AD / Agent", "Brand / Game Value") contain a
          // slash themselves, so a slash separator would read as more types
          // than there are.
          FILE_TYPES.map((type) => `• ${type.label}`).join('\n'),
      );
    case 'needs_site':
      return sendSafe(
        ctx.telegram,
        chatId,
        `รับไฟล์ *${fileTypeLabel(result.fileType)}* แล้ว (เดือน ${result.yearMonth}) แต่ไม่แน่ใจว่าเว็บไหนครับ\n` +
          `พิมพ์ชื่อเว็บมาได้เลย เช่น SH666 / U89 / 88F`,
      );
    case 'invalid_site':
      return sendSafe(
        ctx.telegram,
        chatId,
        `ไม่รู้จักเว็บนี้ครับ — ใช้ได้: ${ALL_SITE_KEYS.map(siteDisplayName).join(' / ')}`,
      );
    case 'needs_confirm':
      return sendSafe(
        ctx.telegram,
        chatId,
        `ไฟล์นี้เหมือนกับที่เคยส่งมาแล้ว (${siteDisplayName(result.site)} เดือน ${result.yearMonth}, ` +
          `ประเภท ${fileTypeLabel(result.fileType)}, ชื่อไฟล์และขนาดตรงกัน) ต้องการอัปเดตทับไหมครับ`,
        DUPLICATE_KEYBOARD,
      );
    case 'saved':
      await sendSafe(
        ctx.telegram,
        chatId,
        `✅ รับไฟล์ *${fileTypeLabel(result.fileType)}* ของ *${siteDisplayName(result.site)}* เดือน ${result.yearMonth} แล้วครับ`,
      );
      // Here, because a new upload is the only thing that moves the newest
      // data date — the other side of the staleness comparison.
      return warnIfFxRateStale(ctx.telegram, chatId, result.site);
    case 'kept_existing':
      return sendSafe(ctx.telegram, chatId, 'โอเคครับ ไม่อัปเดตทับไฟล์เดิม');
    case 'no_pending':
      return undefined;
    default:
      return sendSafe(ctx.telegram, chatId, '⚠️ เกิดข้อผิดพลาดไม่ทราบสาเหตุระหว่างรับไฟล์ครับ');
  }
}

async function handleDocumentUpload(ctx) {
  const chatId = ctx.chat.id;
  const doc = ctx.message.document;
  const filename = doc.file_name || 'upload.xlsx';

  if (!/\.xlsx?$/i.test(filename)) {
    return sendSafe(ctx.telegram, chatId, '⚠️ รองรับเฉพาะไฟล์ Excel (.xlsx) ครับ');
  }

  await ctx.telegram.sendChatAction(chatId, 'upload_document').catch(() => {});

  let buffer;
  try {
    const link = await ctx.telegram.getFileLink(doc.file_id);
    const res = await fetch(link.href ?? link);
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
    buffer = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    logger.error('failed to download uploaded file', { chatId, message: err?.message });
    return sendSafe(ctx.telegram, chatId, '⚠️ ดาวน์โหลดไฟล์ไม่สำเร็จ ลองส่งใหม่อีกครั้งครับ');
  }

  // A big transaction log takes tens of seconds to read. That read runs on a
  // worker thread, so this handler stays free to report how it is going —
  // and to answer anyone else in the meantime.
  const progress = startProgressReporter(ctx.telegram, chatId, {
    label: filename.replace(/\.xlsx?$/i, ''),
  });

  let result;
  try {
    result = await ingestUpload({
      buffer,
      originalFilename: filename,
      fileSize: doc.file_size ?? buffer.length,
      chatId,
      captionText: ctx.message.caption ?? '',
      onProgress: progress.onProgress,
    });
  } catch (err) {
    logger.error('ingest failed', {
      chatId,
      message: err?.message,
      stack: err?.stack?.split('\n').slice(0, 3).join(' | '),
    });
    return sendSafe(
      ctx.telegram,
      chatId,
      '⚠️ อ่านไฟล์ไม่สำเร็จ — ตรวจว่าเป็นไฟล์ Excel export จาก Power BI ที่ถูกต้องครับ',
    );
  } finally {
    // Runs on the error path too: a crashed worker must not leave a "⏳ กำลัง
    // ประมวลผล" message sitting there for ever.
    await progress.finish();
  }

  return respondToUploadResult(ctx, result);
}

/** Every site's rate, where it came from, and how to change one. */
function fxRateOverview() {
  const lines = ['*อัตราแลกเปลี่ยนที่ใช้อยู่*', ''];
  for (const key of ALL_SITE_KEYS) {
    const rate = currentFxRate(key);
    if (!rate) continue;
    const origin = rate.source === 'override' ? 'ตั้งผ่านแชท' : 'ค่าตั้งต้นใน config';
    lines.push(
      `*${siteDisplayName(key)}* — ${rate.currency} → THB`,
      `  อัตรา: \`${rate.fxRate}\`  (ณ ${rate.fxRateAsOf}, ${origin})`,
    );
  }
  lines.push('', 'เปลี่ยนค่า: `/fxrate SH666 0.812` (Super Admin เท่านั้น)');
  return lines.join('\n');
}

/**
 * Stages a rate change. Nothing is written here — the write happens only when
 * the confirm button comes back.
 */
export async function handleFxRateCommand(ctx, argText) {
  const chatId = ctx.chat.id;
  const userId = ctx.from.id;
  const args = String(argText ?? '').trim().split(/\s+/).filter(Boolean);

  // Reading the current rates is not a privileged action; changing one is.
  if (args.length === 0) return sendSafe(ctx.telegram, chatId, fxRateOverview());

  // Checked on the numeric Telegram id only. A username can be changed by its
  // owner at any time, so authorising on one would let anyone who claims a
  // freed handle inherit the permission.
  if (!isSuperAdmin(userId)) {
    logger.warn('non-admin attempted to change an fx rate', {
      userId,
      username: ctx.from?.username,
      chatId,
      attempted: args.join(' '),
    });
    return sendSafe(
      ctx.telegram,
      chatId,
      '⛔ การเปลี่ยนอัตราแลกเปลี่ยนทำได้เฉพาะ Super Admin ครับ\n' +
        'ดูอัตราปัจจุบันได้ด้วย `/fxrate` เฉย ๆ',
    );
  }

  const [siteArg, rateArg, ...rest] = args;
  if (!rateArg || rest.length > 0) {
    return sendSafe(ctx.telegram, chatId, 'รูปแบบ: `/fxrate <เว็บ> <อัตรา>` เช่น `/fxrate SH666 0.812`');
  }

  const site = detectSite(siteArg);
  if (!site) {
    return sendSafe(
      ctx.telegram,
      chatId,
      `ไม่รู้จักเว็บ "${siteArg}" ครับ — ใช้ได้: ${ALL_SITE_KEYS.map(siteDisplayName).join(' / ')}`,
    );
  }

  const current = currentFxRate(site);
  const check = validateFxRate(rateArg, current.fxRate);
  if (!check.ok) {
    return sendSafe(
      ctx.telegram,
      chatId,
      `⚠️ ${FX_REJECTION[check.reason] ?? 'อัตราไม่ถูกต้องครับ'}\n\n` +
        `ค่าที่ใส่มา: \`${rateArg}\`\nอัตราปัจจุบันของ ${siteDisplayName(site)}: \`${current.fxRate}\``,
    );
  }

  setPendingFxUpdate(chatId, {
    site,
    fxRate: check.value,
    previousRate: current.fxRate,
    requestedBy: userId,
  });

  const lines = [
    `*ยืนยันการเปลี่ยนอัตราแลกเปลี่ยน*`,
    '',
    `เว็บ: *${siteDisplayName(site)}* (${current.currency} → THB)`,
    `จาก: \`${current.fxRate}\` (ณ ${current.fxRateAsOf})`,
    `เป็น: \`${check.value}\``,
  ];

  if (check.largeChange) {
    const pct = Math.round((Math.abs(check.value - current.fxRate) / current.fxRate) * 100);
    lines.push(
      '',
      `🚨 *ค่าใหม่ต่างจากเดิม ${pct}%* (เกิน ${LARGE_CHANGE_RATIO * 100}%)`,
      'ตรวจอีกครั้งว่าไม่ได้พิมพ์ทศนิยมผิดตำแหน่งครับ',
    );
  }

  lines.push(
    '',
    `ตัวเลขเงินบาททั้งหมดของ ${siteDisplayName(site)} จะคิดด้วยอัตราใหม่ทันทีหลังยืนยัน`,
    'ยืนยันไหมครับ',
  );

  return sendSafe(ctx.telegram, chatId, lines.join('\n'), FX_KEYBOARD);
}

/**
 * Writes a staged rate change, once someone entitled to has confirmed it.
 *
 * Exported for tests: this is the only path in the bot that changes how every
 * reported amount of money is scaled, so the two gates on it — a staged record
 * must exist, and the person pressing the button must be Super Admin — are
 * worth asserting directly rather than through Telegraf.
 */
export async function confirmFxRateUpdate(ctx) {
  const chatId = ctx.chat.id;
  const pending = getPendingFxUpdate(chatId);
  if (!pending) {
    return sendSafe(ctx.telegram, chatId, 'ไม่พบรายการที่รอยืนยันครับ — อาจยืนยันไปแล้วหรือหมดอายุ');
  }

  // Re-checked at the moment of the write, not only when the button was drawn:
  // the message carrying it is visible to everyone in the chat, so the person
  // who pressed it need not be the one who asked.
  if (!isSuperAdmin(ctx.from.id)) {
    logger.warn('non-admin pressed the fx confirm button', {
      userId: ctx.from.id,
      username: ctx.from?.username,
      chatId,
      site: pending.site,
    });
    return sendSafe(ctx.telegram, chatId, '⛔ ยืนยันได้เฉพาะ Super Admin ครับ');
  }

  clearPendingFxUpdate(chatId);
  const applied = applyFxRateUpdate({
    site: pending.site,
    fxRate: pending.fx_rate,
    updatedBy: ctx.from.id,
  });

  return sendSafe(
    ctx.telegram,
    chatId,
    `✅ เปลี่ยนอัตราแลกเปลี่ยนของ *${siteDisplayName(applied.site)}* แล้วครับ\n` +
      `\`${applied.previousRate}\` → \`${applied.fxRate}\` (ณ ${applied.fxRateAsOf})\n\n` +
      '_ตัวเลขเงินบาทหลังจากนี้คิดด้วยอัตราใหม่ทั้งหมด_',
  );
}

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
  // Slash required: "เรท" and "อัตราแลกเปลี่ยน" both turn up inside ordinary
  // questions, which must still reach Claude.
  { re: /^\/\s*(?:อัตราแลกเปลี่ยน|เรท)\s*(.*)$/, action: 'fxRate' },
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
    // Parsing a not-yet-parsed upload happens on the first question that needs
    // it, which can be the slow one — report it the same way an upload does.
    const parseProgress = startProgressReporter(ctx.telegram, chatId);
    let dataContext;
    try {
      dataContext = site
        ? await buildDataContext(site, question, { onProgress: parseProgress.onProgress })
        : null;
    } finally {
      await parseProgress.finish();
    }
    const pastTurns = getTurns(chatId);

    const envelope = await askClaude({
      question,
      dataContext,
      turns: pastTurns,
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

  bot.command(['fxrate', 'rate'], (ctx) =>
    handleFxRateCommand(ctx, ctx.message.text.split(/\s+/).slice(1).join(' ')),
  );

  bot.command('status', async (ctx) => {
    if (!isSuperAdmin(ctx.from.id)) {
      return sendSafe(ctx.telegram, ctx.chat.id, 'คำสั่งนี้ใช้ได้เฉพาะ Super Admin ครับ');
    }
    const skill = inspectSkillBundle();
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
      `*ไฟล์ข้อมูลที่อัปโหลดแล้ว* (retention ${config.data.retentionMonths} เดือน)`,
      ...ALL_SITE_KEYS.map((site) => {
        const present = fileInventory(site).filter((i) => i.file);
        const detail = present.length
          ? present
              .map((i) => `${i.label} ${i.file.year_month}${i.file.parsed ? '' : ' (ยังไม่ parse)'}`)
              .join(', ')
          : 'ยังไม่มีไฟล์';
        return `_${siteDisplayName(site)}_: ${detail}`;
      }),
    ];
    return sendSafe(ctx.telegram, ctx.chat.id, lines.join('\n'));
  });

  bot.on('document', handleDocumentUpload);

  bot.action(UPLOAD_CONFIRM_YES, async (ctx) => {
    await ctx.answerCbQuery('กำลังอัปเดต...').catch(() => {});
    await ctx.editMessageReplyMarkup(undefined).catch(() => {});
    return respondToBatchResult(ctx, resolvePendingDuplicate(ctx.chat.id, true));
  });

  bot.action(UPLOAD_CONFIRM_NO, async (ctx) => {
    await ctx.answerCbQuery('ยกเลิกแล้ว').catch(() => {});
    await ctx.editMessageReplyMarkup(undefined).catch(() => {});
    return respondToBatchResult(ctx, resolvePendingDuplicate(ctx.chat.id, false));
  });

  bot.action(FX_CONFIRM_YES, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    await ctx.editMessageReplyMarkup(undefined).catch(() => {});
    return confirmFxRateUpdate(ctx);
  });

  bot.action(FX_CONFIRM_NO, async (ctx) => {
    await ctx.answerCbQuery('ยกเลิกแล้ว').catch(() => {});
    await ctx.editMessageReplyMarkup(undefined).catch(() => {});
    clearPendingFxUpdate(ctx.chat.id);
    return sendSafe(ctx.telegram, ctx.chat.id, 'โอเคครับ ไม่เปลี่ยนอัตราแลกเปลี่ยน');
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

    // A file we couldn't guess the site for is waiting on this exact reply (spec §3B step 1).
    if (hasPendingUpload(ctx.chat.id)) {
      return respondToBatchResult(ctx, resolvePendingSite(ctx.chat.id, text));
    }

    const command = matchThaiCommand(text);
    if (command?.action === 'summary') return runSummary(ctx.telegram, ctx.chat.id);
    if (command?.action === 'help') return sendSafe(ctx.telegram, ctx.chat.id, HELP_TEXT);
    if (command?.action === 'setSite') return applySiteChange(ctx, command.arg);
    if (command?.action === 'fxRate') return handleFxRateCommand(ctx, command.arg);

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
  // Verify the token before wiring anything up. getMe() is the cheapest
  // definitive check that the token is valid and Telegram is reachable; without
  // it a bad token leaves the process running and silently deaf, which is much
  // harder to notice than a startup failure.
  let me;
  try {
    me = await bot.telegram.getMe();
  } catch (err) {
    setTelegramStatus({ connected: false, mode: config.telegram.mode, error: err?.message });
    throw new Error(
      `Telegram ปฏิเสธ token — ตรวจ TELEGRAM_BOT_TOKEN ใน .env (${err?.message ?? 'unknown error'})`,
    );
  }

  logger.info('telegram authorised', { username: me.username, botId: me.id });

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
    // launch() only settles once polling stops, so it must not be awaited here.
    bot.launch({ dropPendingUpdates: false }).catch((err) => {
      setTelegramStatus({ connected: false, error: err?.message });
      logger.error('polling stopped with an error', { message: err?.message });
    });
    logger.info('telegram polling started');
  }

  setTelegramStatus({
    connected: true,
    mode: config.telegram.mode,
    username: me.username,
    error: null,
  });
}
