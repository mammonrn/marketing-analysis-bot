/**
 * Canonical site names (spec §3B).
 *
 * `config/site-aliases.json` is the single source of truth for every alias —
 * spec §3B is explicit that per-file if/else chains comparing site names must
 * not exist, because they drift when a new alias shows up. Every module that
 * needs to resolve a site (upload handling, question parsing, folder paths)
 * goes through `normalizeSiteName` / `detectSite` / `getSite` here instead.
 *
 * Internal canonical keys stay the lower-case long form (`shwe666`, `ubet89`,
 * `88fed`) used throughout `transform.js` and the Claude JSON envelope; the
 * spec's own short canonical spelling (`SH666` / `U89` / `88F`) is exposed via
 * `siteDisplayName()` and used for the `DATA/{SITE}/...` folder segment.
 */

import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../paths.js';

const ALIASES_PATH = path.join(ROOT, 'config', 'site-aliases.json');

const raw = JSON.parse(fs.readFileSync(ALIASES_PATH, 'utf8'));

/**
 * `moneyFactor` used to be a single number in the JSON (787 for SH666), which
 * silently fused two unrelated things: Power BI's own ×1,000 de-scaling, which
 * is a property of the export and never changes, and the MMK→THB rate, which
 * is a market figure that goes stale. Nothing recorded which half was which,
 * or when the rate was taken.
 *
 * So the file now carries `scaleFactor`, `fxRate` and `fxRateAsOf` separately
 * and the factor is derived here. Deliberately not stored: two numbers that
 * must agree are two numbers that eventually will not.
 *
 * A site already in THB writes `fxRate: 1` rather than omitting it — an
 * absent rate would be indistinguishable from a forgotten one, and `fxRate: 1`
 * is what lets `formatContext` say "no currency conversion applies here"
 * instead of staying silent.
 *
 * `pointsScaleFactor` is the same idea for a different export. The point logs
 * (`bonus.xlsx`, `reward point.xlsx`, `other transfer.xlsx`) do not carry the
 * ×1,000 de-scaling the Power BI money columns do — SH666's `Points` column
 * has a scale of its own, so a raw `1.200` is 120 MMK, not 1.2 and not 1,200.
 * Reading it raw is what produced "Loyalty Point รวม 278.8" for a figure that
 * is really two orders of magnitude larger.
 *
 * PROVISIONAL: SH666's 100 has been stated by the operator but has *not* been
 * checked against a Power BI screenshot, and it has moved before (100,000 was
 * carried here until this commit). Treat it as the current best answer, not as
 * settled — and when it is finally confirmed, this is the one line to change.
 *
 * Unlike `scaleFactor` it is deliberately *optional*: no other site has a
 * value at all. A site with no value declared has no default — see
 * `aggregateBonusLog`, which refuses to guess. Borrowing SH666's number for
 * U89/88F would be the same mistake as the old fused `moneyFactor`: a figure
 * that looks authoritative with nothing behind it. That the number itself is
 * still unconfirmed is the strongest argument for not spreading it around.
 */
function describeSite(canonical, entry) {
  const { scaleFactor, fxRate, pointsScaleFactor } = entry;

  if (!Number.isFinite(scaleFactor) || scaleFactor <= 0) {
    throw new Error(`site ${canonical}: scaleFactor must be a positive number`);
  }
  if (!Number.isFinite(fxRate) || fxRate <= 0) {
    throw new Error(`site ${canonical}: fxRate must be a positive number`);
  }
  // Absent is allowed and meaningful ("not established yet"); present but
  // unusable is a typo in the config and must not be silently downgraded to
  // "absent", or the throw below would never fire for the site that needs it.
  if (pointsScaleFactor !== undefined && (!Number.isFinite(pointsScaleFactor) || pointsScaleFactor <= 0)) {
    throw new Error(`site ${canonical}: pointsScaleFactor must be a positive number when present`);
  }

  return {
    canonical,
    ...entry,
    /** Derived, never stored: what `toThb` multiplies a file value by. */
    moneyFactor: scaleFactor * fxRate,
    /**
     * The point-log counterpart of `moneyFactor`, or `null` when this site's
     * point scale has not been established. Null is a state callers must
     * handle, not a zero to multiply by.
     */
    pointsFactor: pointsScaleFactor === undefined ? null : pointsScaleFactor * fxRate,
    /** True when the site's figures are already baht and only need de-scaling. */
    needsFxConversion: fxRate !== 1,
  };
}

/** The config baseline. Runtime rate overrides are layered on by `getSite`. */
export const SITES = Object.fromEntries(
  Object.entries(raw).map(([canonical, entry]) => [canonical, describeSite(canonical, entry)]),
);

/**
 * Rates changed from chat, layered over the config baseline.
 *
 * Kept here, in the module every consumer of a rate already goes through, so
 * that `toThb`, `deriveMetrics` and the data-context header all pick a change
 * up with no plumbing of their own. `fxRates.js` owns loading these from
 * SQLite and writing them back; this module never imports the database —
 * `transform.js` sits below `workbook.js` on the worker thread, and
 * better-sqlite3 must never be loaded there.
 *
 * A consequence worth stating: the worker thread starts with an empty map. It
 * never converts money — it only reads and reshapes rows — so this costs
 * nothing today, but a future metric computed on the worker would silently use
 * the config rate.
 */
const fxOverrides = new Map();

/**
 * Applied by `fxRates.js` at startup and after each confirmed change.
 *
 * The merged descriptor is built here, once per change, rather than on each
 * lookup: `getSite` runs for every money column of every row, so a 600-row
 * export asks thousands of times and rebuilding the object each time would be
 * pure waste. Overrides change a handful of times a year.
 */
export function applyFxOverride(canonical, { fxRate, fxRateAsOf }) {
  const base = SITES[canonical];
  if (!base) throw new Error(`Unknown site: ${canonical}`);
  fxOverrides.set(canonical, describeSite(canonical, { ...base, fxRate, fxRateAsOf }));
}

/** Drops every override, returning each site to its config values (tests). */
export function clearFxOverrides() {
  fxOverrides.clear();
}

/** Config plus any override — the values every caller should actually use. */
function withOverride(site) {
  return fxOverrides.get(site.canonical) ?? site;
}

export const ALL_SITE_KEYS = Object.keys(SITES);

// Every alias, longest first, so a longer match (e.g. "88fed") is tried before
// a shorter one that happens to be its prefix.
const ALIAS_INDEX = Object.values(SITES)
  .flatMap((site) => site.aliases.map((alias) => ({ alias, canonical: site.canonical })))
  .sort((a, b) => b.alias.length - a.alias.length);

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Exact alias/canonical-key lookup (case-insensitive), e.g. from a folder path
 * or a clean token. Returns the site with any runtime rate override already
 * applied — this is the single point every money conversion passes through.
 */
export function getSite(input) {
  if (!input) return null;
  const needle = String(input).trim().toLowerCase();
  const hit = ALIAS_INDEX.find(({ alias }) => alias.toLowerCase() === needle);
  return hit ? withOverride(SITES[hit.canonical]) : null;
}

/** Find a site mentioned anywhere in free text (a question, a caption, a filename). */
export function detectSite(text) {
  if (!text) return null;
  const body = String(text);
  for (const { alias, canonical } of ALIAS_INDEX) {
    const re = new RegExp(`\\b${escapeRegex(alias)}\\b`, 'i');
    if (re.test(body)) return canonical;
  }
  return null;
}

/**
 * Single entry point spec §3B requires everywhere a site name is resolved:
 * an exact alias/canonical match first, falling back to a free-text search
 * (for filenames like "Daily Value SH666 มิ.ย.xlsx").
 */
export function normalizeSiteName(input) {
  return getSite(input)?.canonical ?? detectSite(input);
}

export function siteDisplayName(canonical) {
  return SITES[canonical]?.displayName ?? canonical;
}
