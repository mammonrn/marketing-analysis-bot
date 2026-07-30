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

function parseSheetsConfig(raw) {
  if (!raw) return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`env SHEETS_CONFIG is not valid JSON: ${err.message}`);
  }
  for (const [site, entry] of Object.entries(parsed)) {
    if (!entry?.spreadsheetId) {
      throw new Error(`env SHEETS_CONFIG.${site} is missing "spreadsheetId"`);
    }
    if (!entry.tabs || typeof entry.tabs !== 'object') {
      throw new Error(`env SHEETS_CONFIG.${site} is missing a "tabs" object`);
    }
  }
  return parsed;
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

  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    refreshToken: process.env.GOOGLE_REFRESH_TOKEN || '',
    sheets: parseSheetsConfig(process.env.SHEETS_CONFIG),
    cacheTtlSeconds: int('SHEETS_CACHE_TTL_SECONDS', 300),
  },

  skillDir: SKILL_DIR,
  promptDir: PROMPT_DIR,
};

/** True when Sheets credentials are complete enough to attempt a read. */
export function googleConfigured() {
  const { clientId, clientSecret, refreshToken } = config.google;
  return Boolean(clientId && clientSecret && refreshToken);
}

export function isWebhookMode() {
  return config.telegram.mode === 'webhook';
}
