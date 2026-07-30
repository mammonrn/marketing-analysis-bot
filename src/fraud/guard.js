/**
 * Fraud-response enforcement (spec §7).
 *
 * The spec is explicit that the bot must not rely on the LLM alone here, so this
 * module is the code-side check: it decides when a question is a fraud question,
 * verifies the 5-part structure that `references/fraud-anomaly-detection.md`
 * mandates, and catches language that convicts someone outright.
 *
 * What it deliberately does NOT do: try to detect Thai employee names. Name
 * recognition on Thai text is not reliable enough to be a safety control, and a
 * check that half-works would be worse than an honest one — the prompt forbids
 * naming staff, and the verdict-language check below catches the accusations
 * that actually cause harm.
 */

const FRAUD_INTENT_PATTERNS = [
  /โกง/, /ทุจริต/, /ฉ้อโกง/, /ยักยอก/, /ปั่นยอด/, /ปั่นเงิน/,
  /ผิดปกติ/, /น่าสงสัย/, /สงสัยว่า/, /ตรวจสอบพนักงาน/,
  /บัญชีปลอม/, /บัญชีม้า/, /สมัครหลายบัญชี/, /self.?referral/i,
  /referrer.*(ปลอม|ผิดปกติ|เยอะผิด)/, /(ปลอม|ผิดปกติ).*referrer/,
  /bonus.?abuse/i, /โบนัส.*(เอาเปรียบ|ช่องโหว่)/, /abuse/i,
  /manual.?credit/i, /เติมเครดิตมือ/, /ปรับยอดมือ.*ผิดปกติ/,
  /structuring/i, /ฟอกเงิน/, /หลบเลี่ยง/,
  /fraud/i, /anomaly/i, /suspicious/i,
];

/** Does this question put us in fraud-reporting mode? */
export function detectFraudIntent(text) {
  if (!text) return false;
  return FRAUD_INTENT_PATTERNS.some((re) => re.test(text));
}

/**
 * The 5 sections from `fraud-anomaly-detection.md` → "วิธีนำเสนอผลตรวจสอบ".
 * Each has several accepted spellings because the model paraphrases headings.
 */
const REQUIRED_SECTIONS = [
  { key: 'findings', label: 'สิ่งที่พบ', patterns: [/สิ่งที่พบ/, /สิ่งที่ตรวจพบ/, /ข้อมูลที่พบ/] },
  { key: 'reasoning', label: 'ทำไมถึงน่าสงสัย', patterns: [/ทำไม.{0,12}น่าสงสัย/, /เหตุผล(ที่|ว่า)?น่าสงสัย/, /เหตุผล/] },
  { key: 'level', label: 'ระดับความน่าสงสัย', patterns: [/ระดับความน่าสงสัย/, /ระดับ.{0,8}สงสัย/] },
  {
    key: 'alternatives',
    label: 'คำอธิบายทางเลือก',
    patterns: [/คำอธิบายทางเลือก/, /คำอธิบายอื่น/, /ที่ไม่ใช่การโกง/, /สาเหตุอื่นที่เป็นไปได้/],
  },
  { key: 'nextSteps', label: 'ขั้นตอนถัดไป', patterns: [/ขั้นตอนถัดไป/, /ขั้นตอนต่อไป/, /สิ่งที่ควรทำต่อ/, /ข้อเสนอแนะ/] },
];

/**
 * Phrases that state fraud as established fact.
 * The reference file allows "ควรตรวจสอบเพิ่มเติม" / "สัญญาณที่ควรเฝ้าระวัง" and
 * forbids a verdict, so these are the patterns worth failing on.
 */
const VERDICT_PATTERNS = [
  /โกงแน่นอน/, /โกงชัดเจน/, /ทุจริตแน่นอน/, /ทุจริตชัดเจน/,
  /ฟันธง/, /สรุปได้ว่า.{0,20}โกง/, /ยืนยันว่า.{0,20}(โกง|ทุจริต)/,
  /พิสูจน์.{0,15}(โกง|ทุจริต)/, /เป็นการโกง(แน่|ชัด|100)/,
  /มีการโกงเกิดขึ้นแน่/, /คนที่โกงคือ/, /ผู้กระทำคือ/,
];

/**
 * Reduce each line to just its heading part, so a section only counts as present
 * when it is actually a heading.
 *
 * Searching the whole body is too loose: a line like
 * "ระดับความน่าสงสัย: กลาง — ยังมีคำอธิบายอื่นได้" contains the phrase
 * "คำอธิบายอื่น" and would satisfy the alternatives section without the reply
 * ever offering one. Headings are short and precede a colon, so cutting at the
 * first colon and stripping markdown gives a reliable candidate.
 */
function headingsOf(text) {
  return String(text ?? '')
    .split('\n')
    .map((line) => {
      const beforeColon = line.split(/[:：]/)[0];
      return beforeColon.replace(/^[\s>*_#\-–—•\d.)(]+/, '').replace(/[\s*_#]+$/, '');
    })
    .filter(Boolean);
}

export function findMissingSections(text) {
  const headings = headingsOf(text);
  return REQUIRED_SECTIONS.filter(
    (section) => !headings.some((heading) => section.patterns.some((re) => re.test(heading))),
  ).map((section) => section.label);
}

export function findVerdictLanguage(text) {
  const body = String(text ?? '');
  return VERDICT_PATTERNS.filter((re) => re.test(body)).map((re) => re.source);
}

/**
 * Validate a fraud-mode reply.
 * Returns what is wrong so the caller can ask the model to revise once before
 * falling back — see `src/claude/client.js`.
 */
export function validateFraudResponse(text) {
  const missingSections = findMissingSections(text);
  const verdictHits = findVerdictLanguage(text);
  return {
    ok: missingSections.length === 0 && verdictHits.length === 0,
    missingSections,
    verdictHits,
  };
}

/** Instruction appended when asking the model to fix a rejected fraud reply. */
export function buildFraudRevisionInstruction({ missingSections, verdictHits }) {
  const parts = [
    'คำตอบก่อนหน้ายังไม่ผ่านเกณฑ์ของ references/fraud-anomaly-detection.md กรุณาแก้แล้วส่ง JSON ใหม่ทั้งก้อน',
  ];
  if (missingSections.length > 0) {
    parts.push(
      `- ขาดหัวข้อที่บังคับต้องมี: ${missingSections.join(', ')} — ` +
        'ต้องมีครบทั้ง 5 ส่วน และเขียนหัวข้อเป็นภาษาไทยตามชื่อนี้ตรง ๆ',
    );
  }
  if (verdictHits.length > 0) {
    parts.push(
      '- มีการฟันธงว่ามีการโกง ซึ่งห้ามเด็ดขาด — ให้เปลี่ยนเป็น "ควรตรวจสอบเพิ่มเติม" ' +
        'หรือ "เป็นสัญญาณที่ควรเฝ้าระวัง" และคงระดับความน่าสงสัยไว้เป็น สูง/กลาง/ต่ำ',
    );
  }
  return parts.join('\n');
}

/** Shown when even the revision fails — better to say nothing than to accuse. */
export const FRAUD_FALLBACK_MESSAGE =
  '⚠️ ระบบตรวจพบว่าคำตอบเรื่องความผิดปกติที่สร้างขึ้นไม่ผ่านเกณฑ์ความปลอดภัย ' +
  '(ต้องมีครบ 5 ส่วน และห้ามฟันธงว่ามีการโกง) จึงไม่ส่งคำตอบนั้นออกมา\n\n' +
  'กรุณาลองถามใหม่โดยระบุเว็บและช่วงเวลาให้ชัดเจน เช่น ' +
  '"ตรวจ referrer ผิดปกติของ U89 เดือน ก.ค." — หรือแจ้งผู้ดูแลระบบให้ตรวจสอบ log';
