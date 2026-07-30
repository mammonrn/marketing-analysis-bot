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
git checkout claude/new-session-9kqg5f     # หรือ main หลัง merge แล้ว
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
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REFRESH_TOKEN` | credential เดียวกับ Project 1 (read-only) |
| `SHEETS_CONFIG` | JSON แผนผัง spreadsheet ต่อเว็บ — ดูข้อ 4 |

```bash
chmod 600 .env      # มี API key อยู่ในนั้น
```

## 4. SHEETS_CONFIG — ต้องกรอกเอง

โค้ดนี้ไม่รู้ layout ของ Sheets ที่ Project 1 เขียนไว้ จึงทำเป็น config ทั้งหมด
เอา spreadsheet ID จาก URL: `docs.google.com/spreadsheets/d/`**`<ID>`**`/edit`

```bash
SHEETS_CONFIG={"shwe666":{"spreadsheetId":"1AbC...","tabs":{"daily":"Daily","newMember":"Daily (1st New & 1st)","count":"Daily (Count)","brandValue":"Brand Value","vip":"Vip"}},"ubet89":{"spreadsheetId":"1DeF...","tabs":{"daily":"Daily"}},"88fed":{"spreadsheetId":"1GhI...","tabs":{"daily":"Daily"}}}
```

- ชื่อแท็บต้องตรงกับใน Google Sheets **ทุกตัวอักษรและเว้นวรรค**
- แท็บไหนยังไม่มีก็ไม่ต้องใส่ — บอทจะตอบว่าไม่มีข้อมูลส่วนนั้น ดีกว่าเดา
- `tabs` ที่รองรับ: `daily`, `newMember`, `count`, `brandValue`, `vip`

## 5. Start ผ่าน PM2

```bash
mkdir -p logs data
pm2 start ecosystem.config.cjs
pm2 logs ads-analytics-bot --lines 40
```

ใน log ควรเห็น:
```
{"level":"info","msg":"system prompt assembled","skillFiles":9,...}
{"level":"info","msg":"session store ready",...}
{"level":"info","msg":"telegram polling started"}
{"level":"info","msg":"http server listening","port":3001}
```

ถ้าขึ้น `fatal startup error` ให้อ่านบรรทัดนั้น — ปกติคือ env ขาดหรือ skill file ขาด

```bash
pm2 save        # ให้รอดหลัง reboot
```

## 6. เช็คว่าเข้าถึงได้

```bash
curl -s localhost:3001/healthz                                   # จากบน VPS
curl -s https://analytics.xn--22ces5gg0h4d4ae2ai.com/healthz      # ผ่าน Nginx
```

ทั้งสองคำสั่งต้องได้ `{"ok":true,...}` ถ้าอันที่สองไม่ได้ ให้เทียบ Nginx กับ
`deploy/nginx-analytics.conf` แล้ว `sudo nginx -t && sudo systemctl reload nginx`

## 7. ทดสอบใน Telegram

1. ทักบอท → `/start` (ถ้าไม่ใช่ ID ใน whitelist ต้องถูกปฏิเสธ — ทดสอบด้วย)
2. `/whoami` → ต้องเห็น ID ตัวเอง + `Super Admin`
3. `/status` → เช็คว่า skill files ครบ + Sheets เชื่อมแล้ว
4. ถามคำถามจริง: `RTP ของ SH666 เดือนนี้เป็นยังไง`
   - ต้องได้ข้อความ 4 ส่วน (ตัวเลข+สถานะ / ข้อดี / ข้อเสีย / คำแนะนำ)
   - **ต้องไม่มีกราฟ** — นี่คือกฎ spec §6
5. `/สรุป` → ต้องได้ข้อความสรุป + ปุ่ม 📊 เปิด Dashboard → กดแล้วกราฟขึ้น
6. ถาม fraud: `U89 มี referrer ผิดปกติไหม` → ต้องได้ครบ 5 หัวข้อ และ**ไม่ฟันธง**ว่าใครโกง

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
| ตอบว่า "ยังไม่ได้เชื่อมข้อมูล" ทุกคำถาม | `SHEETS_CONFIG` ผิด / ชื่อแท็บไม่ตรง / refresh token หมดอายุ |
| ปุ่ม Dashboard กดแล้วขึ้น "ลิงก์หมดอายุ" | token อายุ 1 ชม. — สั่ง `/สรุป` ใหม่ |
| ไม่มีปุ่ม Dashboard เลย | `PUBLIC_URL` ไม่ได้ตั้ง (ดู log `PUBLIC_URL not set`) |
| กราฟไม่ขึ้นในทุกคำถาม | ไม่ใช่บั๊ก — spec §6 บังคับให้เป็นแบบนี้ |
