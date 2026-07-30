/**
 * Mini App HTTP surface (spec §5.3 step 3).
 *
 * Auth model: the summary token is the capability. It is 24 random bytes, scoped
 * to one chat's payload, and expires after an hour, so the URL can be handed to
 * Telegram without the page needing to know anything about the user. Nothing
 * here reads chat history — only the one payload the bot chose to publish.
 */

import path from 'node:path';
import express from 'express';
import { PUBLIC_DIR as PUBLIC_ROOT } from '../paths.js';
import { logger } from '../logger.js';
import { readSummary } from '../session/store.js';

const PUBLIC_DIR = path.join(PUBLIC_ROOT, 'miniapp');

export function createRouter() {
  const router = express.Router();

  router.get('/healthz', (req, res) => {
    res.json({ ok: true, service: 'ads-analytics-bot', ts: new Date().toISOString() });
  });

  router.get('/miniapp', (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  });

  router.get('/api/summary/:token', (req, res) => {
    const payload = readSummary(req.params.token);
    if (!payload) {
      logger.warn('summary token not found or expired', {
        token: String(req.params.token).slice(0, 8),
      });
      return res.status(404).json({ error: 'not_found', message: 'ลิงก์หมดอายุหรือไม่ถูกต้อง' });
    }
    // Never cache a capability-scoped payload at any hop.
    res.set('Cache-Control', 'no-store');
    return res.json(payload);
  });

  router.use('/miniapp/vendor', express.static(path.join(PUBLIC_DIR, 'vendor'), {
    maxAge: '7d',
    immutable: true,
  }));
  router.use('/miniapp/assets', express.static(path.join(PUBLIC_DIR, 'assets')));

  return router;
}
