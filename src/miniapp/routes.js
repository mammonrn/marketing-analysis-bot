/**
 * Mini App HTTP surface (spec §5.3 step 3).
 *
 * Two auth models, because there are two kinds of link here.
 *
 * The session dashboard (`/api/summary/:token`) is unchanged: the token is the
 * capability. 24 random bytes, scoped to one chat's payload, expires after an
 * hour, handed to Telegram as a `web_app` button that never leaves the chat.
 *
 * The monthly dashboard (`/api/monthly/:token`) is the one people forward. Its
 * token is reusable and lives for weeks, so it is no longer treated as the
 * secret — a shared PIN sits in front of the data instead, and the token only
 * says which month is being asked for. The page itself stays public: it is an
 * empty shell that renders nothing until the fetch behind the PIN succeeds.
 */

import path from 'node:path';
import express from 'express';
import { PUBLIC_DIR as PUBLIC_ROOT } from '../paths.js';
import { logger } from '../logger.js';
import { readSummary, readMonthlyDashboard } from '../session/store.js';
import { getTelegramStatus } from '../runtime-state.js';
import {
  isPinConfigured,
  verifyPin,
  hasPinSession,
  setPinCookie,
  pinLockout,
  registerPinFailure,
  clearPinFailures,
} from './pin.js';

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

  // --- PIN gate ------------------------------------------------------------

  /* Tells the page which of three screens to show before it asks for data:
     the PIN form, the dashboard, or "nobody has set a PIN on this server". */
  router.get('/api/dashboard/session', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({
      configured: isPinConfigured(),
      authenticated: hasPinSession(req),
      ...pinLockout(req),
    });
  });

  router.post('/api/dashboard/pin', express.json({ limit: '1kb' }), (req, res) => {
    res.set('Cache-Control', 'no-store');

    if (!isPinConfigured()) {
      logger.warn('dashboard PIN attempted but DASHBOARD_PIN_HASH is not set');
      return res.status(503).json({
        error: 'pin_not_configured',
        message: 'ยังไม่ได้ตั้งค่า PIN บนเซิร์ฟเวอร์ — รบกวนแจ้งผู้ดูแลระบบ',
      });
    }

    const lockout = pinLockout(req);
    if (lockout.locked) {
      return res.status(429).json({
        error: 'locked',
        retryAfterSeconds: lockout.retryAfterSeconds,
        message: `กรอกผิดหลายครั้งเกินไป — รออีก ${Math.ceil(lockout.retryAfterSeconds / 60)} นาทีแล้วลองใหม่`,
      });
    }

    // Only ever the verdict is logged, never the PIN and never its length.
    if (!verifyPin(req.body?.pin)) {
      const failure = registerPinFailure(req);
      logger.warn('dashboard PIN rejected', {
        attemptsLeft: failure.attemptsLeft,
        locked: failure.locked,
      });
      if (failure.locked) {
        return res.status(429).json({
          error: 'locked',
          retryAfterSeconds: failure.retryAfterSeconds,
          message: `กรอกผิดหลายครั้งเกินไป — รออีก ${Math.ceil(failure.retryAfterSeconds / 60)} นาทีแล้วลองใหม่`,
        });
      }
      return res.status(401).json({
        error: 'bad_pin',
        attemptsLeft: failure.attemptsLeft,
        message: `PIN ไม่ถูกต้อง (เหลืออีก ${failure.attemptsLeft} ครั้ง)`,
      });
    }

    clearPinFailures(req);
    setPinCookie(req, res);
    return res.json({ ok: true });
  });

  function requirePin(req, res, next) {
    if (!isPinConfigured()) {
      logger.warn('monthly dashboard requested but DASHBOARD_PIN_HASH is not set');
      // Fail closed. An unset PIN must not quietly publish a month of figures
      // on a URL that was built to be forwarded.
      return res.status(503).json({
        error: 'pin_not_configured',
        message: 'ยังไม่ได้ตั้งค่า PIN บนเซิร์ฟเวอร์ — รบกวนแจ้งผู้ดูแลระบบ',
      });
    }
    if (!hasPinSession(req)) {
      return res.status(401).json({ error: 'pin_required', message: 'กรุณากรอก PIN ก่อน' });
    }
    return next();
  }

  router.get('/api/monthly/:token', requirePin, (req, res) => {
    const payload = readMonthlyDashboard(req.params.token);
    if (!payload) {
      // Eight characters is enough to match a link against a log line and far
      // too few to reconstruct the token from one.
      logger.warn('monthly dashboard token not found or expired', {
        token: String(req.params.token).slice(0, 8),
      });
      return res.status(404).json({ error: 'not_found', message: 'ลิงก์หมดอายุหรือไม่ถูกต้อง' });
    }
    res.set('Cache-Control', 'no-store');
    return res.json(payload);
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
