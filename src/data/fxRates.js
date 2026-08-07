/**
 * Exchange-rate policy: when a rate has gone stale, and what it takes to
 * change one.
 *
 * Two rules govern where a rate lives. `config/site-aliases.json` is the
 * baseline that ships with the deploy; a change made from chat goes to SQLite
 * and is layered over it. The config file is never written back to, because it
 * is in git — a bot editing it would collide with the next `git pull` and could
 * be reverted by a checkout without anyone noticing the rate had moved.
 *
 * This module holds the decisions. `db.js` holds the rows, `sites.js` holds
 * the in-memory layering, and `telegram/bot.js` holds the conversation.
 */

import { getSite, applyFxOverride, siteDisplayName, ALL_SITE_KEYS } from './sites.js';
import {
  latestFxRateOverride,
  latestFxRateOverrides,
  insertFxRateOverride,
  getFxRateAlert,
  recordFxRateAlert,
  latestDataDate,
} from './db.js';
import { logger } from '../logger.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How far the newest data may run ahead of the rate before it is worth saying
 * something. A quarter is long enough that ordinary month-end uploads never
 * trip it, short enough that a rate cannot drift a whole year unmentioned.
 */
export const STALE_AFTER_DAYS = 90;

/** One reminder a week per site. Uploads arrive in batches; warnings should not. */
export const ALERT_COOLDOWN_DAYS = 7;

/**
 * Plausible range for "one unit of local currency, in baht".
 *
 * The upper bound is the one doing real work: it rejects 787 typed where
 * 0.787 was meant, which is the mistake this validation exists for — the
 * ×1,000 de-scaling and the FX rate look alike enough to be confused, and
 * 787 would silently inflate every reported figure a thousandfold. 100 clears
 * the strongest currency this business plausibly touches (USD is around 36
 * baht) by a wide margin while still catching that.
 *
 * The lower bound rejects zero and negatives, and leaves room for the weak
 * regional currencies (VND, LAK and IDR all sit near 0.002).
 */
export const MIN_FX_RATE = 0.0001;
export const MAX_FX_RATE = 100;

/** A change this large is legitimate but rare — worth a second look before it lands. */
export const LARGE_CHANGE_RATIO = 0.5;

const today = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);

/**
 * Replays the stored overrides over the config baseline.
 *
 * Called once at startup. Without it a restart would quietly revert every rate
 * to what shipped, which is the failure mode that made writing to the config
 * file look attractive in the first place.
 */
export function loadFxOverrides() {
  const rows = latestFxRateOverrides();
  for (const row of rows) {
    if (!ALL_SITE_KEYS.includes(row.site)) {
      // A site dropped from config since the override was written.
      logger.warn('ignoring fx override for an unknown site', { site: row.site });
      continue;
    }
    applyFxOverride(row.site, { fxRate: row.fx_rate, fxRateAsOf: row.fx_rate_as_of });
  }
  if (rows.length > 0) {
    logger.info('fx overrides loaded', {
      sites: rows.map((r) => `${r.site}=${r.fx_rate}@${r.fx_rate_as_of}`),
    });
  }
  return rows.length;
}

/** The rate in force, and whether it came from chat or from the deployed config. */
export function currentFxRate(siteKey) {
  const site = getSite(siteKey);
  if (!site) return null;
  const override = latestFxRateOverride(site.canonical);
  return {
    site: site.canonical,
    fxRate: site.fxRate,
    fxRateAsOf: site.fxRateAsOf,
    currency: site.currency,
    source: override ? 'override' : 'config',
    updatedBy: override?.updated_by ?? null,
  };
}

/**
 * Checks a rate against the input a person actually types.
 *
 * Returns a reason rather than a boolean: "ต้องเป็นตัวเลข" and "น่าจะลืมใส่จุด
 * ทศนิยม" call for different corrections, and a bare rejection teaches nobody
 * which one they made.
 */
export function validateFxRate(input, currentRate = null) {
  const raw = String(input ?? '').trim().replace(/,/g, '');

  if (raw === '') return { ok: false, reason: 'empty' };
  // Rejected here rather than by Number(): Number('') is 0, Number(' 1 ') is 1,
  // and Number('1e5') is 100000 — none of which should pass for a typed rate.
  if (!/^\d*\.?\d+$/.test(raw)) return { ok: false, reason: 'not_a_number' };

  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value)) return { ok: false, reason: 'not_a_number' };
  if (value <= 0) return { ok: false, reason: 'not_positive' };
  if (value < MIN_FX_RATE) return { ok: false, reason: 'too_small' };
  if (value > MAX_FX_RATE) return { ok: false, reason: 'too_large' };

  // Not a rejection — a rate genuinely can move this far — but it is also what
  // a slipped decimal point looks like, so it must not land unremarked.
  const largeChange =
    currentRate > 0 && Math.abs(value - currentRate) / currentRate > LARGE_CHANGE_RATIO;

  return { ok: true, value, largeChange };
}

/**
 * Whether this site's rate is older than its data by more than the threshold.
 *
 * The comparison is rate-date against newest-data-date, not against today, on
 * purpose. The question being asked is "am I pricing new data with an old
 * rate", so a site that simply has not been uploaded to in months stays quiet,
 * and updating the rate moves `fxRateAsOf` forward and ends the warning by
 * itself rather than needing anything cleared.
 */
export function checkFxRateStale(siteKey, { now = Date.now() } = {}) {
  const site = getSite(siteKey);
  if (!site) return { stale: false, reason: 'unknown_site' };
  // Nothing to go stale: the figures are already baht.
  if (!site.needsFxConversion) return { stale: false, reason: 'no_conversion' };

  const dataDate = latestDataDate(site.canonical);
  if (!dataDate) return { stale: false, reason: 'no_data' };

  const gapDays = Math.floor(
    (Date.parse(`${dataDate}T00:00:00Z`) - Date.parse(`${site.fxRateAsOf}T00:00:00Z`)) / DAY_MS,
  );

  return {
    stale: gapDays > STALE_AFTER_DAYS,
    site: site.canonical,
    gapDays,
    dataDate,
    fxRate: site.fxRate,
    fxRateAsOf: site.fxRateAsOf,
    currency: site.currency,
    now,
  };
}

/** True when this site has not been warned inside the cooldown. */
export function alertDue(siteKey, { now = Date.now() } = {}) {
  const last = getFxRateAlert(siteKey)?.last_alerted_at;
  if (!last) return true;
  return now - last > ALERT_COOLDOWN_DAYS * DAY_MS;
}

export function markAlerted(siteKey, { now = Date.now() } = {}) {
  recordFxRateAlert(siteKey, now);
}

/**
 * The warning itself. Says what the rate is, when it was taken, how far behind
 * the data it has fallen, and how to fix it — a warning that omits the last
 * one just repeats every week.
 */
export function formatStaleWarning(check) {
  return [
    `⚠️ *อัตราแลกเปลี่ยนอาจเก่าเกินไป — ${siteDisplayName(check.site)}*`,
    '',
    `อัตราที่ใช้อยู่: \`${check.fxRate}\` (${check.currency} → THB)`,
    `บันทึกไว้เมื่อ: ${check.fxRateAsOf}`,
    `ข้อมูลล่าสุดในระบบ: ${check.dataDate}`,
    `ห่างกัน: *${check.gapDays} วัน* (เกินเกณฑ์ ${STALE_AFTER_DAYS} วัน)`,
    '',
    'กำลังใช้เรทเก่าคิดข้อมูลใหม่ ตัวเลขเงินบาทที่รายงานอาจคลาดเคลื่อนครับ',
    '',
    `อัปเดตด้วยคำสั่ง: \`/fxrate ${siteDisplayName(check.site)} <อัตราใหม่>\``,
    `เช่น \`/fxrate ${siteDisplayName(check.site)} 0.812\` (Super Admin เท่านั้น)`,
  ].join('\n');
}

/**
 * Writes a confirmed change: one appended row, then the in-memory layer.
 *
 * `fxRateAsOf` becomes today rather than anything the user supplies. The field
 * means "when this rate was taken", and the moment someone types a rate in is
 * the only date the bot can actually vouch for — it is also what ends the
 * staleness warning, so letting it be backdated would let a warning be
 * silenced without the rate really being refreshed.
 */
export function applyFxRateUpdate({ site, fxRate, updatedBy, now = Date.now() }) {
  const resolved = getSite(site);
  if (!resolved) throw new Error(`Unknown site: ${site}`);

  const previousRate = resolved.fxRate;
  const fxRateAsOf = today(now);

  insertFxRateOverride({
    site: resolved.canonical,
    fxRate,
    fxRateAsOf,
    previousRate,
    updatedBy,
  });
  applyFxOverride(resolved.canonical, { fxRate, fxRateAsOf });

  logger.info('fx rate changed', {
    site: resolved.canonical,
    previousRate,
    fxRate,
    fxRateAsOf,
    updatedBy: String(updatedBy),
    at: new Date(now).toISOString(),
  });

  return { site: resolved.canonical, previousRate, fxRate, fxRateAsOf };
}
