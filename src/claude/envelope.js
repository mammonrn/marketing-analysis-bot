/**
 * Parsing Claude's JSON envelope (spec §6).
 *
 * The bot must not depend on the model formatting things perfectly, so parsing
 * always degrades to "plain text, no chart" rather than throwing — that is the
 * spec's own default response mode, which makes the failure mode a safe one.
 */

import { logger } from '../logger.js';
import { ALL_SITE_KEYS } from '../data/sites.js';

const VALID_KINDS = new Set(['metric', 'fraud', 'summary', 'other']);
const VALID_CHART_TYPES = new Set(['line', 'bar', 'doughnut', 'pie']);

/**
 * Pull the first complete JSON object out of a model response.
 * Brace counting has to respect string literals, otherwise a `{` inside Thai
 * prose (or an escaped quote) ends the scan in the wrong place.
 */
export function extractJsonObject(text) {
  if (typeof text !== 'string') return null;

  let body = text.trim();
  // Strip a ```json fence if the model added one despite instructions.
  const fence = body.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) body = fence[1].trim();

  const start = body.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < body.length; i += 1) {
    const ch = body[i];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      if (inString) escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        const candidate = body.slice(start, i + 1);
        try {
          return JSON.parse(candidate);
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function coerceChart(chart) {
  if (!chart || typeof chart !== 'object') return null;

  const type = VALID_CHART_TYPES.has(chart.type) ? chart.type : 'bar';
  const labels = Array.isArray(chart.labels) ? chart.labels.map((l) => String(l)) : [];
  const rawSets = Array.isArray(chart.datasets) ? chart.datasets : [];

  const datasets = rawSets
    .map((set) => ({
      label: String(set?.label ?? ''),
      data: Array.isArray(set?.data)
        ? set.data.map((v) => {
            const n = typeof v === 'number' ? v : Number.parseFloat(v);
            return Number.isFinite(n) ? n : null;
          })
        : [],
    }))
    .filter((set) => set.data.length > 0);

  if (labels.length === 0 || datasets.length === 0) return null;

  return {
    type,
    title: String(chart.title ?? ''),
    labels,
    datasets,
  };
}

function coerceMetrics(metrics) {
  if (!Array.isArray(metrics)) return [];
  return metrics
    .filter((m) => m && typeof m === 'object')
    .map((m) => ({
      name: String(m.name ?? '').slice(0, 80),
      value: String(m.value ?? '').slice(0, 80),
      status: String(m.status ?? '').slice(0, 40),
    }))
    .filter((m) => m.name);
}

/**
 * Normalise a raw model response into the shape the rest of the bot relies on.
 * Every field gets a defined value so downstream code never guards for absence.
 */
export function parseEnvelope(rawText) {
  const parsed = extractJsonObject(rawText);

  if (!parsed) {
    logger.warn('envelope parse failed — falling back to text-only', {
      preview: String(rawText ?? '').slice(0, 200),
    });
    return {
      replyMarkdown: String(rawText ?? '').trim() || 'ขออภัย ระบบไม่สามารถประมวลผลคำตอบได้ ลองถามใหม่อีกครั้งครับ',
      site: null,
      responseKind: 'other',
      metrics: [],
      showChart: false,
      chart: null,
      dataGaps: [],
      parseOk: false,
    };
  }

  const site = ALL_SITE_KEYS.includes(parsed.site) ? parsed.site : null;
  const responseKind = VALID_KINDS.has(parsed.response_kind) ? parsed.response_kind : 'other';
  const chart = coerceChart(parsed.chart);

  return {
    replyMarkdown: String(parsed.reply_markdown ?? '').trim(),
    site,
    responseKind,
    metrics: coerceMetrics(parsed.metrics),
    // A chart is only real if the payload is usable, regardless of the flag.
    showChart: parsed.show_chart === true && chart !== null,
    chart,
    dataGaps: Array.isArray(parsed.data_gaps) ? parsed.data_gaps.map((g) => String(g)) : [],
    parseOk: true,
  };
}
