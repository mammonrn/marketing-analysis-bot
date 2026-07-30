# Deploy runbook — ads-analytics-bot

> ⚠️ **ยังไม่ได้ deploy จริง** — session ที่เขียนโค้ดนี้รันอยู่ใน container ชั่วคราว
> ไม่มี SSH key และเข้าถึง VPS `45.77.47.238` ไม่ได้ ทุกขั้นตอนด้านล่างต้องรันบน VPS เอง
> (คำสั่งทั้งหมดทดสอบ syntax แล้ว แต่ยังไม่ได้รันบนเครื่องจริง)

VPS: Vultr `45.77.47.238` (hostname `expense-bot`), Ubuntu 24.04, 4GB RAM
มี `telegram-ads-bot` (Project 1) รันอยู่แล้วบน PM2 — **อย่าแตะ**

---

## 0. ก่อนเริ่ม — เช็คว่ามีอะไรพร้อมแล้ว

```bash
node --version          # ต้อง >= 20.11 (โค้ดใช้ ESM + built-in test runner)
pm2 list                # ควรเห็น telegram-ads-bot อยู่
sudo nginx -T | grep -c 'xn--22ces5gg0h4d4ae2ai'   # > 0 = มี server block อยู่แล้ว
ss -tlnp | grep 3001    # ต้องว่าง — ถ้ามีอะไรจับอยู่ ต้องเคลียร์ก่อน
```

---

## 1. Clone

```bash
cd /opt
sudo git clone https://github.com/mammonrn/marketing-analysis-bot.git ads-analytics-bot
sudo chown -R "$USER":"$USER" ads-analytics-bot
cd ads-analytics-bot
git checkout main     # หรือ branch ที่กำลังทดสอบ ก่อน merge
npm ci --omit=dev
```

## 2. ตรวจ skill files ก่อนอย่างอื่น

system prompt ของบอท **คือ** ไฟล์ใน `skills/thai-data-analyst/` — ถ้าไม่ครบ บอทจะไม่ start

```bash
npm run check:skill
```

ต้องได้ `✅ พร้อม deploy` ถ้าขาดไฟล์ที่ขึ้น 🚨 REQUIRED ให้คัดลอกมาก่อน แล้วเช็คซ้ำ

## 3. ตั้งค่า .env

```bash
cp .env.example .env
nano .env
```

ค่าที่ต้องกรอก **ให้ครบก่อน start**:

| ตัวแปร | เอามาจากไหน |
|---|---|
| `TELEGRAM_BOT_TOKEN` | BotFather — **คนละตัว** กับ telegram-ads-bot |
| `ANTHROPIC_API_KEY` | คีย์ที่มีอยู่แล้ว |
| `ALLOWED_TELEGRAM_IDS` | ID ทีมงาน คั่น comma (Super Admin `509832984` ใส่ให้อัตโนมัติแล้ว) |

ไม่มี Google/Sheets ให้กรอกแล้ว (spec §3B) — `DATA_DIR`/`RAW_FILE_RETENTION_MONTHS` มีค่า default
ใช้ได้เลย ผู้ใช้อัปโหลดไฟล์ Excel เข้าแชทบอทเองแทน

```bash
chmod 600 .env      # มี API key อยู่ในนั้น
```

## 4. Start ผ่าน PM2

```bash
mkdir -p logs data DATA
pm2 start ecosystem.config.cjs
pm2 logs ads-analytics-bot --lines 40
```

ใน log ควรเห็น (ครบ 5 บรรทัดนี้):
```
{"level":"info","msg":"system prompt assembled","skillFiles":9,"missing":[],"approxTokens":22116}
{"level":"info","msg":"session store ready",...}
{"level":"info","msg":"telegram authorised","username":"<ชื่อบอท>","botId":...}
{"level":"info","msg":"telegram polling started"}
{"level":"info","msg":"http server listening","port":3001}
```

`skillFiles` ต้องเป็น **9** และ `missing` ต้องเป็น `[]` — ถ้าไม่ใช่ แปลว่า skill file ขาด

ถ้าขึ้น `fatal startup error` ให้อ่านข้อความในบรรทัดนั้น แล้ว exit code จะเป็น 1 — สาเหตุที่พบบ่อย:
- `required skill file(s) missing: ...` → ไฟล์ใน `skills/` ไม่ครบ
- `Missing required env var ...` → `.env` ยังไม่ครบ
- `Telegram ปฏิเสธ token (401: Unauthorized)` → `TELEGRAM_BOT_TOKEN` ผิด

บอทจะ**ไม่ start ถ้า token ผิด** โดยตั้งใจ — ดีกว่ารันแล้วเงียบไม่ตอบใครโดยไม่มีใครรู้

```bash
pm2 save        # ให้รอดหลัง reboot
```

## 5. เช็คว่าเข้าถึงได้

```bash
curl -s localhost:3001/healthz | python3 -m json.tool            # จากบน VPS
curl -s https://analytics.xn--22ces5gg0h4d4ae2ai.com/healthz      # ผ่าน Nginx
npm run smoke                                                     # เช็ค Mini App ครบทุก route
```

`/healthz` ต้องได้ `ok: true` **และ** `telegram.connected: true` พร้อมชื่อบอทใน `telegram.username`

```json
{"ok": true, "service": "ads-analytics-bot",
 "telegram": {"connected": true, "mode": "polling", "username": "...", "error": null}}
```

`ok: true` แต่ `telegram.connected: false` = process รันอยู่แต่ไม่ได้ต่อ Telegram (ดู `telegram.error`)
ถ้า curl ผ่าน Nginx ไม่ได้ ให้เทียบกับ `deploy/nginx-analytics.conf` แล้ว
`sudo nginx -t && sudo systemctl reload nginx`

## 6. ทดสอบใน Telegram

1. ทักบอท → `/start` (ถ้าไม่ใช่ ID ใน whitelist ต้องถูกปฏิเสธ — ทดสอบด้วย)
2. `/whoami` → ต้องเห็น ID ตัวเอง + `Super Admin`
3. ส่งไฟล์ Excel export จริง 1 ไฟล์ (เช่น Daily Value ของ SH666 เดือนล่าสุด) เข้าแชท
   - ควรได้ข้อความยืนยันว่ารับไฟล์ประเภทอะไร เดือนไหน เว็บไหนแล้ว
   - ถ้าเดาเว็บไม่ได้ บอทจะถามกลับ — พิมพ์ชื่อเว็บ (เช่น `SH666`) ตอบไปได้เลย
4. `/status` → เช็คว่า skill files ครบ + เห็นไฟล์ที่เพิ่งอัปโหลดอยู่ในรายการ
5. ถามคำถามจริง: `RTP ของ SH666 เดือนนี้เป็นยังไง`
   - ต้องได้ข้อความ 4 ส่วน (ตัวเลข+สถานะ / ข้อดี / ข้อเสีย / คำแนะนำ)
   - **ต้องไม่มีกราฟ** — นี่คือกฎ spec §6
6. `/สรุป` → ต้องได้ข้อความสรุป + ปุ่ม 📊 เปิด Dashboard → กดแล้วกราฟขึ้น
7. ถาม fraud: `U89 มี referrer ผิดปกติไหม` → ต้องได้ครบ 5 หัวข้อ และ**ไม่ฟันธง**ว่าใครโกง

---

## Webhook (ทางเลือก — polling พอสำหรับ traffic ระดับนี้)

polling ไม่ต้องแตะ Nginx เลยและ debug ง่ายกว่า ถ้าจะเปลี่ยนเป็น webhook:

```bash
# ใน .env
TELEGRAM_MODE=webhook
WEBHOOK_SECRET=$(openssl rand -hex 32)
PUBLIC_URL=https://analytics.xn--22ces5gg0h4d4ae2ai.com

pm2 restart ads-analytics-bot
```

แอปจะ register webhook เองตอน start (path `/telegram/webhook`)

---

## งานประจำ

**อัปเดต skill (spec §4 — ต้องทำทุกครั้งที่แก้ skill ใน claude.ai)**
```bash
./scripts/sync-skill.sh /path/to/thai-data-analyst
git add skills/ && git commit -m "sync: update skill" && git push
# บน VPS:
git pull && npm run check:skill && pm2 restart ads-analytics-bot
```
ต้อง restart เพราะ system prompt ถูก cache ไว้ใน process

**เพิ่มคนใช้บอท** — แก้ `ALLOWED_TELEGRAM_IDS` ใน `.env` แล้ว `pm2 restart ads-analytics-bot`
(ให้คนนั้นส่ง `/whoami` ให้บอทตัวไหนก็ได้เพื่อดู ID — หรือดูจาก log ตอนถูกปฏิเสธ)

**ดู log / แก้ปัญหา**
```bash
pm2 logs ads-analytics-bot --lines 100
pm2 logs ads-analytics-bot --err
grep -c '"level":"error"' logs/error.log
```

| อาการ | สาเหตุที่พบบ่อย |
|---|---|
| ไม่ start, `required skill file(s) missing` | ไฟล์ใน `skills/` ไม่ครบ → `npm run check:skill` |
| ไม่ start, `Missing required env var` | ยังไม่กรอก `.env` ให้ครบ |
| ไม่ start, `Telegram ปฏิเสธ token` | `TELEGRAM_BOT_TOKEN` ผิด/ถูก revoke — ขอใหม่จาก BotFather |
| ตอบแบบ Full Report / ยัด HTML มาให้ | `SKILL.md` เป็นเวอร์ชันเก่า → `npm test` จะจับให้ (เทสเช็คหัวข้อ "โหมดการตอบ") |
| ตอบว่า "ยังไม่มีข้อมูล" ทุกคำถาม | ยังไม่มีใครอัปโหลดไฟล์ประเภท/เดือนนั้นสำหรับเว็บนี้ — เช็คด้วย `/status` |
| ไฟล์ที่ส่งเข้าไปขึ้น "ไม่รู้จักรูปแบบไฟล์นี้" | column header ไม่ตรงกับที่ระบบรู้จัก (`src/data/fileTypes.js`) — ตรวจว่าเป็น Power BI export จริง |
| ปุ่ม Dashboard กดแล้วขึ้น "ลิงก์หมดอายุ" | token อายุ 1 ชม. — สั่ง `/สรุป` ใหม่ |
| ไม่มีปุ่ม Dashboard เลย | `PUBLIC_URL` ไม่ได้ตั้ง (ดู log `PUBLIC_URL not set`) |
| กราฟไม่ขึ้นในทุกคำถาม | ไม่ใช่บั๊ก — spec §6 บังคับให้เป็นแบบนี้ |
