/**
 * PIN gate for the monthly dashboard.
 *
 * Why it exists: the monthly link is now long-lived and reusable, because a
 * forwarded Telegram message loses its `web_app` button and the plain URL in
 * the message body is the only copy that survives. A link that survives
 * forwarding is a link that can end up anywhere, so the token stopped being
 * treated as the secret and a shared PIN went in front of the data instead.
 *
 * One PIN for every site, on purpose — the people who share these reports
 * share all of them, and per-site PINs would be four secrets to rotate for no
 * extra containment.
 *
 * Storage: scrypt, not bcrypt. Node ships scrypt in `node:crypto`, so the VPS
 * gets a memory-hard KDF with no native module to compile and no dependency to
 * keep patched. The hash lives in `DASHBOARD_PIN_HASH`; the PIN itself is
 * never written to the env, the database, or a log line.
 */

import crypto from 'node:crypto';
import { config } from '../config.js';
import { logger } from '../logger.js';

/* 128 * N * r = 16MB per verification — comfortably under Node's 32MB scrypt
   default, and slow enough that an offline guess costs real work. */
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

export const PIN_COOKIE = 'dash_pin';

/* Domain separator, so the cookie key is not the PIN hash itself. */
const COOKIE_KEY_INFO = 'ads-analytics-dashboard-cookie-v1';

/** `hashPin('1234')` → the value to paste into DASHBOARD_PIN_HASH. */
export function hashPin(pin, params = SCRYPT) {
  const value = String(pin ?? '');
  if (!value) throw new Error('PIN must not be empty');
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(value, salt, params.keylen, {
    N: params.N,
    r: params.r,
    p: params.p,
  });
  return [
    'scrypt',
    params.N,
    params.r,
    params.p,
    salt.toString('base64'),
    hash.toString('base64'),
  ].join('$');
}

export function isPinConfigured() {
  return Boolean(parseHash(config.dashboard.pinHash));
}

/**
 * Constant-time as far as it matters: a wrong PIN of the right shape always
 * costs a full scrypt derivation and a timing-safe comparison.
 */
export function verifyPin(pin, stored = config.dashboard.pinHash) {
  const parsed = parseHash(stored);
  if (!parsed) return false;

  const value = String(pin ?? '');
  if (!value) return false;

  let derived;
  try {
    derived = crypto.scryptSync(value, parsed.salt, parsed.hash.length, {
      N: parsed.N,
      r: parsed.r,
      p: parsed.p,
    });
  } catch (err) {
    // A malformed cost parameter in the env is a configuration error, not a
    // failed login — say so once rather than looking like a wrong PIN forever.
    logger.error('DASHBOARD_PIN_HASH could not be used', { message: err?.message });
    return false;
  }
  return crypto.timingSafeEqual(derived, parsed.hash);
}

function parseHash(stored) {
  const parts = String(stored ?? '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;

  const [, n, r, p, salt, hash] = parts;
  const parsed = {
    N: Number.parseInt(n, 10),
    r: Number.parseInt(r, 10),
    p: Number.parseInt(p, 10),
    salt: Buffer.from(salt, 'base64'),
    hash: Buffer.from(hash, 'base64'),
  };
  if (!Number.isFinite(parsed.N) || !Number.isFinite(parsed.r) || !Number.isFinite(parsed.p)) return null;
  if (!parsed.salt.length || !parsed.hash.length) return null;
  return parsed;
}

// --- browser session -------------------------------------------------------

/* Derived from the stored hash rather than from its own env var: one less
   secret to provision, and rotating the PIN invalidates every cookie that was
   issued against the old one, which is what rotating a PIN is for. */
function cookieKey() {
  return crypto.createHmac('sha256', COOKIE_KEY_INFO).update(config.dashboard.pinHash).digest();
}

function sign(body) {
  return crypto.createHmac('sha256', cookieKey()).update(body).digest('base64url');
}

/** `<expiry>.<nonce>.<hmac>` — self-contained, so nothing has to be stored. */
export function mintPinSession({ ttlMs = config.dashboard.sessionHours * 3_600_000 } = {}) {
  const body = `${Date.now() + ttlMs}.${crypto.randomBytes(9).toString('base64url')}`;
  return `${body}.${sign(body)}`;
}

export function verifyPinSession(value) {
  const raw = String(value ?? '');
  const at = raw.lastIndexOf('.');
  if (at <= 0) return false;

  const body = raw.slice(0, at);
  const provided = Buffer.from(raw.slice(at + 1), 'base64url');
  const expected = Buffer.from(sign(body), 'base64url');
  if (provided.length !== expected.length) return false;
  if (!crypto.timingSafeEqual(provided, expected)) return false;

  const expiresAt = Number.parseInt(body.split('.')[0], 10);
  return Number.isFinite(expiresAt) && expiresAt > Date.now();
}

export function hasPinSession(req) {
  if (!isPinConfigured()) return false;
  return verifyPinSession(readCookie(req, PIN_COOKIE));
}

export function setPinCookie(req, res) {
  const maxAgeSeconds = config.dashboard.sessionHours * 3600;
  const attributes = [
    `${PIN_COOKIE}=${mintPinSession()}`,
    'Path=/',
    'HttpOnly',
    // Lax, not Strict: the dashboard is reached by following a link from
    // Telegram, and Strict would drop the cookie on exactly that navigation.
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ];
  // `req.secure` is the proxy's X-Forwarded-Proto (index.js trusts Nginx);
  // the PUBLIC_URL check covers a request that reached us some other way.
  if (req.secure || config.http.publicUrl.startsWith('https://')) attributes.push('Secure');
  res.append('Set-Cookie', attributes.join('; '));
}

export function clearPinCookie(res) {
  res.append('Set-Cookie', `${PIN_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function readCookie(req, name) {
  const header = req.headers?.cookie;
  if (!header) return '';
  for (const part of header.split(';')) {
    const at = part.indexOf('=');
    if (at < 0) continue;
    if (part.slice(0, at).trim() !== name) continue;
    return decodeURIComponent(part.slice(at + 1).trim());
  }
  return '';
}

// --- brute-force protection ------------------------------------------------

/* In memory, not in SQLite: a lockout only has to outlive the attack, and a
   restart clearing it is fine — an attacker cannot cause the restart, and the
   PIN is four-ish digits, so the point is to make guessing cost wall-clock
   time rather than to keep a permanent record. */
const attempts = new Map();

function sweep(nowMs) {
  if (attempts.size < 1000) return;
  for (const [key, entry] of attempts) {
    if (entry.expiresAt <= nowMs) attempts.delete(key);
  }
}

/** Everything behind Nginx shares an IP unless `trust proxy` is on — it is. */
export function clientKey(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

export function pinLockout(req, nowMs = Date.now()) {
  const entry = attempts.get(clientKey(req));
  if (!entry?.lockedUntil || entry.lockedUntil <= nowMs) return { locked: false, retryAfterSeconds: 0 };
  return { locked: true, retryAfterSeconds: Math.ceil((entry.lockedUntil - nowMs) / 1000) };
}

export function registerPinFailure(req, nowMs = Date.now()) {
  const key = clientKey(req);
  const windowMs = config.dashboard.lockoutMinutes * 60_000;
  const previous = attempts.get(key);
  // A stale entry is a fresh start: N wrong PINs must be consecutive *and*
  // recent to lock anyone out.
  const count = previous && previous.expiresAt > nowMs ? previous.count + 1 : 1;

  const locked = count >= config.dashboard.maxPinAttempts;
  const entry = {
    count,
    expiresAt: nowMs + windowMs,
    lockedUntil: locked ? nowMs + windowMs : 0,
  };
  attempts.set(key, entry);
  sweep(nowMs);

  return {
    locked,
    attemptsLeft: Math.max(0, config.dashboard.maxPinAttempts - count),
    retryAfterSeconds: locked ? Math.ceil(windowMs / 1000) : 0,
  };
}

export function clearPinFailures(req) {
  attempts.delete(clientKey(req));
}

/** Test hook: the limiter is process-wide state and each case wants its own. */
export function resetPinFailures() {
  attempts.clear();
}
