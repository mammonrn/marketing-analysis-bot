# ads-analytics-bot

Telegram bot ที่ให้ทีมงานถามคำถามภาษาไทยเกี่ยวกับผลประกอบการเว็บ **SH666 / U89 / 88F**
แล้วตอบด้วยตัวเลข + สถานะ + คำแนะนำ พร้อม dashboard สรุปท้าย session

Project 2 ต่อยอดจาก `telegram-ads-bot` (Project 1) — บอทนี้ **อ่าน** Google Sheets ชุดเดียวกัน
แบบ read-only ไม่เขียนกลับ

📖 **วิธี deploy → [`deploy/DEPLOY.md`](deploy/DEPLOY.md)**

---

## สถานะปัจจุบัน

โค้ดครบตาม scope v1 แล้ว แต่**ยังไม่ได้ deploy** และมี 2 อย่างที่ต้องเติมก่อนใช้งานจริง:

| ต้องเติม | ทำไม |
|---|---|
| `skills/thai-data-analyst/SKILL.md` + `u89-metrics.md`, `new-member-quality.md`, `vip-members.md` | system prompt คือไฟล์เหล่านี้ — บอทจะไม่ start ถ้า `SKILL.md` ขาด (ดู `npm run check:skill`) |
| `SHEETS_CONFIG` ใน `.env` | โค้ดไม่รู้ layout ของ Sheets จาก Project 1 — ต้องกรอก spreadsheet ID + ชื่อแท็บเอง |

```bash
npm run check:skill    # เช็คว่าไฟล์ skill ครบไหม
npm test               # 51 unit tests
npm run smoke          # เช็คว่า Mini App เสิร์ฟได้
```

---

## สถาปัตยกรรม

```
Telegram user
   │  พิมพ์คำถามไทย / กด /สรุป
   ▼
telegraf (polling หรือ webhook)
   ├─ whitelist            src/telegram/auth.js       ปฏิเสธคนที่ไม่อยู่ในลิสต์ก่อนเสีย API call
   ├─ session (SQLite)     src/session/store.js       จำเว็บล่าสุด + ทุก turn + idle clock
   ├─ Google Sheets        src/data/sheets.js         read-only, cache 5 นาที
   ├─ Anthropic            src/claude/client.js       system prompt = ไฟล์ skill ต่อกันแบบ verbatim
   │    └─ fraud guard     src/fraud/guard.js         บังคับโครงสร้าง 5 ส่วน + กันการฟันธง
   └─ Mini App             src/miniapp/routes.js      Chart.js (vendored) ผ่าน token ใช้ครั้งเดียว
```

### system prompt ประกอบจากไฟล์ ไม่ได้เขียนเอง

`src/prompt/loader.js` ต่อไฟล์ใน `skills/thai-data-analyst/` เข้าด้วยกัน **แบบไม่แก้แม้ตัวอักษรเดียว**
ตาม spec §4 (benchmark ต้องตรงกับที่วิเคราะห์มาแล้ว ห้าม paraphrase) แล้วปิดท้ายด้วย
[`prompt/bot-overlay.md`](prompt/bot-overlay.md) ซึ่งเป็นกฎการส่งออกของบอทที่ดึงมาจาก spec §5–§7 เท่านั้น

ถ้ากฎใน overlay ขัดกับไฟล์ skill เรื่องวิธีวิเคราะห์ → **ยึดไฟล์ skill** (เขียนไว้ในตัว overlay เอง)

ทั้งก้อนมี cache breakpoint จุดเดียวท้ายสุด คำถามที่ 2 ขึ้นไปในแต่ละ process จึงจ่ายราคา cache read

### แก้ skill แล้วต้อง sync

```bash
./scripts/sync-skill.sh /path/to/thai-data-analyst   # copy + เขียน MANIFEST.json (sha256)
git add skills/ && git commit -m "sync: update skill" && git push
# บน VPS: git pull && npm run check:skill && pm2 restart ads-analytics-bot
```

ต้อง `pm2 restart` เพราะ system prompt ถูก cache ไว้ใน process

---

## กฎที่บังคับด้วย code ไม่ได้หวังพึ่ง LLM

| กฎ | ที่มา | บังคับที่ไหน |
|---|---|---|
| ไม่สร้างกราฟทุกคำถาม | spec §1, §6 | `parseEnvelope` ทิ้ง `show_chart` ถ้า payload กราฟใช้ไม่ได้ + fraud ถูกบังคับ `false` เสมอ |
| fraud ต้องครบ 5 ส่วน | spec §7 | `validateFraudResponse` → ถ้าไม่ครบ ขอแก้ 1 รอบ → ถ้ายังไม่ผ่าน **ไม่ส่งออก** |
| ห้ามฟันธงว่ามีการโกง | spec §7 | ตรวจ verdict pattern (`ฟันธง`, `โกงแน่นอน`, …) แล้ว reject |
| สรุปเฉพาะตอนขอ/idle ไม่ใช่ทุก N คำถาม | spec §5.2 | `findIdleSessions` + `markSummaryPrompted` — idle จะ**ถามก่อน** ไม่ดัน dashboard เข้ามาเลย |
| whitelist | spec §8 | middleware default-deny ก่อนถึง handler |

ตรวจชื่อพนักงานไทยแบบอัตโนมัติ **ไม่ได้ทำ** — NER ภาษาไทยไม่แม่นพอจะเป็น safety control
ที่ทำแทนคือห้ามใน prompt + จับ verdict language ซึ่งเป็นส่วนที่สร้างความเสียหายจริง

---

## คำสั่งในบอท

| คำสั่ง | ทำอะไร |
|---|---|
| พิมพ์คำถามเลย | ตอบ 4 ส่วน: ตัวเลข+สถานะ / ข้อดี / ข้อเสีย / คำแนะนำ |
| `/สรุป` `/จบ` | สรุป session + ปุ่มเปิด dashboard แล้วเคลียร์ session |
| `/เว็บ SH666` | เปลี่ยนเว็บที่กำลังคุย (ปกติบอทจำเว็บล่าสุดให้อยู่แล้ว) |
| `/whoami` | ดู Telegram ID ตัวเอง |
| `/status` | (Super Admin) เช็ค skill files + Sheets + config |
| `/refresh` | (Super Admin) ล้าง cache Sheets |

`/สรุป` กับ `/จบ` เป็นภาษาไทย Telegram จึงไม่ tag เป็น bot_command — จับใน text handler
(`/summary`, `/end` ใช้ได้เหมือนกัน)

---

## Decisions ที่ตัดสินใจไปเอง

spec §9 ตั้งคำถามสถาปัตยกรรมไว้ 5 ข้อ ถามกลับไปแล้วแต่ยังไม่ได้คำตอบ จึงใช้ค่าที่ spec แนะนำเองเป็น default
เปลี่ยนได้ทุกข้อ:

| # | คำถาม | ที่เลือก | เหตุผล |
|---|---|---|---|
| 1 | Node.js หรือเปลี่ยน stack | Node.js 20+ ESM | เหมือน Project 1 ทีมดูแลต่อได้ |
| 2 | SQLite หรือ Redis | **SQLite** | spec แนะเอง — VPS 4GB แชร์กับ Project 1 ไม่ควรเพิ่ม service |
| 3 | whitelist มีใคร | Super Admin + `ALLOWED_TELEGRAM_IDS` | เพิ่มคนแก้ env + restart ไม่ต้อง deploy ใหม่ |
| 4 | idle timeout 20 นาที | **20 นาที** ปรับได้ที่ `SESSION_IDLE_MINUTES` | ตามที่ spec เสนอ |
| 5 | sync skill manual หรืออัตโนมัติ | `scripts/sync-skill.sh` + MANIFEST.json | กึ่งอัตโนมัติ — drift เห็นใน `git diff` |

**เปลี่ยน telegram library**: spec ไม่ได้ระบุตัวไหน — ใช้ `telegraf` แทน `node-telegram-bot-api`
เพราะตัวหลังลาก `request` (deprecated) มาด้วยและมี 2 critical CVE ตอนนี้เหลือ 0 critical / 0 high

---

## Phase 2 (ยังไม่ทำ ตาม spec §8)

- [ ] proactive fraud alert แบบ cron รายวัน
- [ ] เปรียบเทียบข้ามเว็บในคำถามเดียว
- [ ] export PDF / ส่งอีเมล
- [ ] ยืนยัน platform type ของ 88F (ตอนนี้สมมติ NCT ตาม `88fed-metrics.md`)
