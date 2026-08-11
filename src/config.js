import 'dotenv/config';
import path from 'node:path';
import { ROOT, SKILL_DIR, PROMPT_DIR } from './paths.js';

export { ROOT };

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name} — see .env.example`);
  return value;
}

function int(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) throw new Error(`env ${name} must be an integer, got "${raw}"`);
  return parsed;
}

function idList(raw) {
  return String(raw ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

const superAdminId = process.env.SUPER_ADMIN_TELEGRAM_ID || '509832984';

export const config = {
  telegram: {
    token: required('TELEGRAM_BOT_TOKEN'),
    mode: (process.env.TELEGRAM_MODE || 'polling').toLowerCase(),
    webhookSecret: process.env.WEBHOOK_SECRET || '',
    webhookPath: '/telegram/webhook',
  },

  access: {
    superAdminId,
    // Super Admin is always allowed even if left out of ALLOWED_TELEGRAM_IDS.
    allowedIds: new Set([superAdminId, ...idList(process.env.ALLOWED_TELEGRAM_IDS)]),
  },

  anthropic: {
    apiKey: required('ANTHROPIC_API_KEY'),
    model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5',
    maxTokens: int('ANTHROPIC_MAX_TOKENS', 4096),
    // '5m' (default) or '1h' — see `userMessage` in src/claude/client.js for
    // why 5m is the conservative starting point and what evidence justifies 1h.
    cacheTtl: (process.env.ANTHROPIC_CACHE_TTL || '5m').toLowerCase(),
  },

  http: {
    port: int('PORT', 3001),
    // Bind to loopback by default: Nginx is the only thing that should reach us.
    bindHost: process.env.BIND_HOST || '127.0.0.1',
    publicUrl: (process.env.PUBLIC_URL || '').replace(/\/+$/, ''),
  },

  session: {
    idleMinutes: int('SESSION_IDLE_MINUTES', 20),
    sqlitePath: path.resolve(ROOT, process.env.SQLITE_PATH || './data/sessions.sqlite'),
  },

  // The monthly dashboard link is meant to be forwarded, so it outlives the
  // chat message it came in — which is exactly why it needs a PIN in front of
  // it. See src/miniapp/pin.js for the hash format and scripts/hash-pin.mjs to
  // produce one.
  dashboard: {
    // A getter, not a snapshot: rotating the PIN then restarting is the normal
    // path, but reading it per call also lets the tests exercise the
    // "not configured" branch without re-importing the whole config module.
    get pinHash() {
      return process.env.DASHBOARD_PIN_HASH || '';
    },
    // How long a correct PIN is remembered in the browser.
    sessionHours: int('DASHBOARD_SESSION_HOURS', 12),
    // Wrong PINs in a row before that client is locked out.
    maxPinAttempts: int('DASHBOARD_PIN_MAX_ATTEMPTS', 5),
    lockoutMinutes: int('DASHBOARD_PIN_LOCKOUT_MINUTES', 15),
    // How long a forwarded monthly link keeps working.
    monthlyLinkDays: int('MONTHLY_LINK_DAYS', 60),
  },

  // Raw Excel files users upload in chat (spec §3B) — replaces the old
  // Google Sheets/Drive read integration entirely.
  data: {
    dir: path.resolve(ROOT, process.env.DATA_DIR || './DATA'),
    retentionMonths: int('RAW_FILE_RETENTION_MONTHS', 6),
  },

  skillDir: SKILL_DIR,
  promptDir: PROMPT_DIR,
};

export function isWebhookMode() {
  return config.telegram.mode === 'webhook';
}
