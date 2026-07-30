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

export const SITES = Object.fromEntries(
  Object.entries(raw).map(([canonical, entry]) => [canonical, { canonical, ...entry }]),
);

export const ALL_SITE_KEYS = Object.keys(SITES);

// Every alias, longest first, so a longer match (e.g. "88fed") is tried before
// a shorter one that happens to be its prefix.
const ALIAS_INDEX = Object.values(SITES)
  .flatMap((site) => site.aliases.map((alias) => ({ alias, canonical: site.canonical })))
  .sort((a, b) => b.alias.length - a.alias.length);

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Exact alias/canonical-key lookup (case-insensitive), e.g. from a folder path or a clean token. */
export function getSite(input) {
  if (!input) return null;
  const needle = String(input).trim().toLowerCase();
  const hit = ALIAS_INDEX.find(({ alias }) => alias.toLowerCase() === needle);
  return hit ? SITES[hit.canonical] : null;
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
