/**
 * Threshold counts for the summary block (`config/summary-thresholds.json`).
 *
 * Why this exists: asked "Active VIP% เท่าไหร่", the bot replied that it had no
 * count of members with `Last BIn 2 Y <= 7` and so could not work the
 * percentage out — while holding every row needed to count them. The summary
 * block already reports sum/avg/min/max over all 600-odd rows; a count of the
 * rows meeting a condition is the same kind of arithmetic, and just as wrong to
 * leave to a model that can only see the fifteen-row sample.
 *
 * The thresholds themselves are data, not code, and live in the JSON beside the
 * site aliases. `vip-members.md` remains the authority on what "Lost" means;
 * the JSON is how that definition gets evaluated, and each entry names the doc
 * line it came from so the two can be kept in step.
 *
 * Deliberately not parsed out of the reference Markdown at load time: those
 * files are prose written for a reader, they are synced byte-for-byte from the
 * claude.ai project, and a rewording ("7 วัน" to "เจ็ดวัน") would silently drop
 * the counts with nothing to notice it had happened.
 */

import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../paths.js';
import { toNumber } from './transform.js';

const CONFIG_PATH = path.join(ROOT, 'config', 'summary-thresholds.json');

const OPERATORS = {
  lte: (value, limit) => value <= limit,
  lt: (value, limit) => value < limit,
  gte: (value, limit) => value >= limit,
  gt: (value, limit) => value > limit,
};

function loadConfig() {
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const out = {};

  for (const [fileType, groups] of Object.entries(raw)) {
    // `_comment` carries the file's own documentation; it is not a file type.
    if (fileType.startsWith('_')) continue;

    out[fileType] = groups.map((group) => {
      if (!group.column) throw new Error(`summary-thresholds: ${fileType} group has no column`);
      for (const bucket of group.buckets ?? []) {
        if (!OPERATORS[bucket.op]) {
          throw new Error(
            `summary-thresholds: ${fileType}/${group.column} uses unknown op "${bucket.op}" ` +
              `(valid: ${Object.keys(OPERATORS).join(', ')})`,
          );
        }
        if (!Number.isFinite(bucket.value)) {
          throw new Error(`summary-thresholds: ${fileType}/${group.column} bucket needs a numeric value`);
        }
      }
      return group;
    });
  }

  return out;
}

// Read once. The file ships with the deploy and does not change under a
// running process, the same way `config/site-aliases.json` does not.
const THRESHOLDS = loadConfig();

export function thresholdGroupsFor(fileType) {
  return THRESHOLDS[fileType] ?? [];
}

/**
 * Counts, per bucket, the records whose `column` satisfies the condition.
 *
 * `missing` is reported rather than hidden: it is the difference between the
 * row count at the top of the summary and the denominator these percentages
 * use, and without it a reader has two totals that disagree and no reason why.
 */
export function countByThresholds(records, group) {
  const values = [];
  let missing = 0;

  for (const record of records) {
    const raw = record[group.column];
    const value = raw === null || raw === undefined || raw === '' ? null : toNumber(raw);
    if (value === null) missing += 1;
    else values.push(value);
  }

  const buckets = group.buckets.map((bucket) => {
    const count = values.filter((value) => OPERATORS[bucket.op](value, bucket.value)).length;
    return {
      label: bucket.label,
      count,
      pct: values.length > 0 ? (count / values.length) * 100 : null,
    };
  });

  return { column: group.column, counted: values.length, missing, buckets };
}
