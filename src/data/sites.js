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
 */
function describeSite(canonical, entry) {
  const { scaleFactor, fxRate } = entry;

  if (!Number.isFinite(scaleFactor) || scaleFactor <= 0) {
    throw new Error(`site ${canonical}: scaleFactor must be a positive number`);
  }
  if (!Number.isFinite(fxRate) || fxRate <= 0) {
    throw new Error(`site ${canonical}: fxRate must be a positive number`);
  }

  return {
    canonical,
    ...entry,
    /** Derived, never stored: what `toThb` multiplies a file value by. */
    moneyFactor: scaleFactor * fxRate,
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

/** What config says, ignoring any override — for showing where a value came from. */
export function getConfiguredSite(canonical) {
  return SITES[canonical] ?? null;
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
