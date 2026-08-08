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
import { getTelegramStatus } from '../runtime-state.js';

const PUBLIC_DIR = path.join(PUBLIC_ROOT, 'miniapp');

export function createRouter() {
  const router = express.Router();

  // `ok` reports that this process is serving HTTP. Telegram connectivity is
  // reported alongside rather than folded into `ok`, so a monitor can tell
  // "process down" apart from "process up but not talking to Telegram".
  router.get('/healthz', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({
      ok: true,
      service: 'ads-analytics-bot',
      telegram: getTelegramStatus(),
      ts: new Date().toISOString(),
    });
  });

  router.get('/miniapp', (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  });

  // A second page rather than a mode of the first.
  //
  // `index.html` renders one payload: a block of summary text, at most one
  // chart, and a metrics table — a fixed layout with no navigation. The monthly
  // report is eleven tabbed sections, each with its own KPI grid, charts and
  // tables, and it is reached from a different button with a different payload
  // shape. Merging them would put a `payload.kind` branch at the top of every
  // function in `app.js` and carry two disjoint stylesheets in one file, for no
  // shared markup at all. They already share what is worth sharing: the token,
  // the `/api/summary/:token` route below, and the vendored Chart.js.
  //
  // Registered before the static handlers so the path is served as a page, not
  // looked up as a file.
  router.get('/miniapp/monthly', (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'monthly.html'));
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
