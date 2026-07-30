import express from 'express';
import { config, isWebhookMode } from './config.js';
import { logger } from './logger.js';
import { buildSystemBlocks, inspectSkillBundle } from './prompt/loader.js';
import { initDb, findIdleSessions, pruneOldData, closeDb } from './session/store.js';
import { startIdleSweeper } from './session/summary.js';
import { createBot, launchBot } from './telegram/bot.js';
import { createRouter } from './miniapp/routes.js';
import { initDataDb, closeDataDb } from './data/db.js';
import { runMonthlyRetentionIfDue } from './data/retention.js';

async function main() {
  // Fail fast and loudly if the skill bundle is incomplete — a bot answering
  // without its benchmark files is worse than a bot that refuses to start.
  const skill = inspectSkillBundle();
  logger.info('skill bundle', {
    present: skill.present.map((p) => p.file),
    missing: skill.missing.map((m) => m.file),
  });
  buildSystemBlocks();

  initDb();
  pruneOldData();

  initDataDb();
  runMonthlyRetentionIfDue();

  const app = express();
  app.disable('x-powered-by');
  // Nginx terminates TLS and forwards; trust it for correct client IPs in logs.
  app.set('trust proxy', 1);
  app.use(createRouter());

  const bot = createBot();
  await launchBot(bot, app);

  const server = app.listen(config.http.port, config.http.bindHost, () => {
    logger.info('http server listening', {
      host: config.http.bindHost,
      port: config.http.port,
      publicUrl: config.http.publicUrl || '(not set)',
      telegramMode: config.telegram.mode,
    });
  });

  const sweeper = startIdleSweeper(bot.telegram, { findIdleSessions });
  const pruner = setInterval(() => pruneOldData(), 6 * 60 * 60 * 1000);
  pruner.unref?.();
  // Daily is frequent enough — runMonthlyRetentionIfDue() itself no-ops on every day but the 1st.
  const retentionTimer = setInterval(() => runMonthlyRetentionIfDue(), 24 * 60 * 60 * 1000);
  retentionTimer.unref?.();

  const shutdown = (signal) => {
    logger.info('shutting down', { signal });
    clearInterval(sweeper);
    clearInterval(pruner);
    clearInterval(retentionTimer);
    if (!isWebhookMode()) {
      // Throws "Bot is not running!" if polling never started (bad token, network
      // failure). Shutdown must still complete, so this is not allowed to throw.
      try {
        bot.stop(signal);
      } catch (err) {
        logger.warn('bot.stop skipped', { message: err?.message });
      }
    }
    server.close(() => {
      closeDb();
      closeDataDb();
      process.exit(0);
    });
    // Do not hang forever if a connection refuses to drain.
    setTimeout(() => process.exit(0), 10_000).unref?.();
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error('fatal startup error', { message: err?.message, stack: err?.stack });
  process.exit(1);
});
