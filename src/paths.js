/**
 * Filesystem locations, deliberately free of any env requirements.
 *
 * Kept separate from config.js so tooling that only inspects files — like
 * `npm run check:skill` — works before .env exists (on a fresh clone, or in CI).
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(here, '..');
export const SKILL_DIR = path.join(ROOT, 'skills', 'thai-data-analyst');
export const PROMPT_DIR = path.join(ROOT, 'prompt');
export const PUBLIC_DIR = path.join(ROOT, 'public');
