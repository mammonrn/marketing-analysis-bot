/**
 * The button surface: `/menu` and everything reachable from it.
 *
 * Two flows share one shape — pick something, pick a site, pick a month — and
 * they differ only in what happens at the end:
 *
 *   quick   → assemble the question a person would have typed and send it down
 *             the existing `buildDataContext` → `askClaude` path, so the answer
 *             is the ordinary Conversational Mode reply, unchanged.
 *   monthly → build the whole-month payload and hand back a Mini App link.
 *
 * The questions in `QUICK_METRICS` are not free text. Each one is worded to
 * match the route its file type already has in `query.js` — "New Mems" hits
 * `/\bnew\s*mem/i`, "VIP" hits `/\bvip\b/i`, "Bonus" hits `/\bbonus\b/i` — so a
 * button lands on the same file the typed question would have. Changing the
 * wording without checking those patterns silently sends the question to
 * `daily_value`, which answers plausibly about the wrong report.
 *
 * Which six metrics: SKILL.md marks these "ต้องแสดงในรายงาน" (§B activity, the
 * VIP and bonus sections). The `turns` table is still empty, so there is no
 * usage data to choose from — once `npm run report:sessions` has something in
 * it, these should be revisited against what people actually ask.
 */

import { ALL_SITE_KEYS, siteDisplayName } from '../data/sites.js';

export const MENU_QUICK = 'menu:quick';
export const MENU_MONTHLY = 'menu:monthly';
export const MENU_SESSION = 'menu:session';
export const MENU_CANCEL = 'menu:cancel';

export const METRIC_PREFIX = 'menu:metric:';
export const SITE_PREFIX = 'menu:site:';
export const MONTH_PREFIX = 'menu:month:';

/** Flow names, as stored in `menu_selections.flow`. */
export const FLOW_QUICK = 'quick';
export const FLOW_MONTHLY = 'monthly';

export const QUICK_METRICS = [
  {
    id: 'bin',
    label: '💰 BIn',
    // No route in query.js matches, so this falls through to `daily_value` —
    // which is where BIn lives. Deliberate, not an oversight.
    question: (siteName, yearMonth) => `${siteName} BIn เดือน ${yearMonth} เท่าไหร่`,
  },
  {
    id: 'dau',
    label: '👥 DAU',
    question: (siteName, yearMonth) => `${siteName} DAU เดือน ${yearMonth} เป็นยังไง`,
  },
  {
    id: 'rtp',
    label: '🎯 RTP',
    question: (siteName, yearMonth) => `${siteName} RTP เดือน ${yearMonth} เป็นยังไง`,
  },
  {
    id: 'new_mems',
    label: '🆕 New Mems',
    // "new mem" — the `new_member_quality` route.
    question: (siteName, yearMonth) =>
      `${siteName} New Mems เดือน ${yearMonth} เป็นยังไง คุณภาพสมาชิกใหม่ดีไหม`,
  },
  {
    id: 'vip_active',
    label: '👑 VIP Active%',
    // "VIP" — the `vip` route.
    question: (siteName, yearMonth) =>
      `${siteName} VIP Active% เดือน ${yearMonth} เท่าไหร่ ต้องทำ re-engagement ไหม`,
  },
  {
    id: 'bonus_cost',
    label: '🎁 Bonus Cost',
    // "bonus" — the `bonus_log` route.
    question: (siteName, yearMonth) =>
      `${siteName} Bonus Cost เดือน ${yearMonth} จ่ายโบนัสไปเท่าไหร่`,
  },
];

export function getQuickMetric(id) {
  return QUICK_METRICS.find((metric) => metric.id === id) ?? null;
}

/**
 * The cancel row, appended to every submenu.
 *
 * A function rather than a shared constant because Telegraf is free to mutate
 * the markup it is handed, and one shared array reaching every keyboard is one
 * edit away from being a bug in all of them at once.
 */
const cancelRow = () => [{ text: '❌ ยกเลิก', callback_data: MENU_CANCEL }];

/** Rows of `size`, preserving order — the submenus are all "2 per row". */
function chunk(items, size) {
  const rows = [];
  for (let i = 0; i < items.length; i += size) rows.push(items.slice(i, i + size));
  return rows;
}

/**
 * The main menu has no cancel button on purpose: there is nothing in progress
 * to cancel at the top, and a button that returns you to the screen you are
 * already looking at reads as broken.
 */
export function mainMenuKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: '📊 ดูตัวเลขด่วน', callback_data: MENU_QUICK }],
        [{ text: '📈 สรุปเดือน (Dashboard เต็ม)', callback_data: MENU_MONTHLY }],
        [{ text: '📋 สรุป session นี้', callback_data: MENU_SESSION }],
      ],
    },
  };
}

export function quickMetricsKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        ...chunk(
          QUICK_METRICS.map((metric) => ({
            text: metric.label,
            callback_data: `${METRIC_PREFIX}${metric.id}`,
          })),
          2,
        ),
        cancelRow(),
      ],
    },
  };
}

export function siteKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        ...chunk(
          ALL_SITE_KEYS.map((site) => ({
            text: siteDisplayName(site),
            callback_data: `${SITE_PREFIX}${site}`,
          })),
          3,
        ),
        cancelRow(),
      ],
    },
  };
}

const THAI_MONTHS = [
  'ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.',
  'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.',
];

/** `2026-07` → `ก.ค. 2026`, with the raw value kept for anything unparseable. */
export function monthLabel(yearMonth) {
  const match = /^(\d{4})-(\d{2})$/.exec(String(yearMonth ?? ''));
  if (!match) return String(yearMonth ?? '');
  const month = THAI_MONTHS[Number(match[2]) - 1];
  return month ? `${month} ${match[1]}` : String(yearMonth);
}

/**
 * Built from the months that actually have files, newest first — see
 * `listRawFileMonths`. An empty list is the caller's cue to say so rather than
 * to draw a keyboard with only a cancel button on it.
 */
export function monthKeyboard(yearMonths) {
  return {
    reply_markup: {
      inline_keyboard: [
        ...chunk(
          yearMonths.map((yearMonth) => ({
            text: monthLabel(yearMonth),
            callback_data: `${MONTH_PREFIX}${yearMonth}`,
          })),
          2,
        ),
        cancelRow(),
      ],
    },
  };
}

export const MENU_TEXT = [
  '*เมนูหลัก*',
  '',
  'เลือกสิ่งที่อยากดูได้เลยครับ — หรือพิมพ์คำถามเป็นภาษาไทยมาตรง ๆ ก็ได้เหมือนเดิม',
].join('\n');
