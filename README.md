# ads-analytics-bot

Telegram bot ที่ให้ทีมงานถามคำถามภาษาไทยเกี่ยวกับผลประกอบการเว็บ **SH666 / U89 / 88F**
แล้วตอบด้วยตัวเลข + สถานะ + คำแนะนำ พร้อม dashboard สรุปท้าย session

Project 2 ต่อยอดจาก `telegram-ads-bot` (Project 1) แต่มีแหล่งข้อมูลของตัวเอง — **ทีมงานอัปโหลดไฟล์
Excel ดิบเข้าแชทบอทโดยตรงทุกสิ้นเดือน** (spec §3B) ไม่ใช้ Google Sheets/Drive ร่วมกับ Project 1

📖 **วิธี deploy → [`deploy/DEPLOY.md`](deploy/DEPLOY.md)**

---

## สถานะปัจจุบัน

โค้ดครบตาม scope v1 (รวม file ingestion ตาม spec §3B) และ **skill files ครบทั้ง 9 ไฟล์แล้ว**
(ตรงกับ Google Drive ทุกไบต์ — ดู `skills/thai-data-analyst/MANIFEST.json`) บอท start ได้เลย
ไม่ต้องเติม config อะไรเพิ่มนอกจาก token/API key พื้นฐาน

> **แก้ไขจากรุ่นก่อน**: `.gitignore` เดิมมี `data/` (ไม่มี `/` นำหน้า) ซึ่งดันไปกลืน `src/data/`
> ด้วย ทำให้โมดูล site-normalization/ข้อมูลของรุ่นก่อนหน้าไม่เคย commit เข้า git และหายไปตอน
> container ถูกเก็บกวาด — เปลี่ยนเป็น `/data/` (root-only) แล้ว ห้ามแก้กลับ

```bash
npm run check:skill    # ต้องได้ "✅ พร้อม deploy" (9/9 ไฟล์)
npm test               # unit tests (sites/transform/fileTypes/query/ingest/fraud/envelope/...)
npm run smoke          # เช็คว่า Mini App เสิร์ฟได้ครบทุก route (รวม PIN gate)
npm run hash:pin       # สร้าง DASHBOARD_PIN_HASH สำหรับ PIN ของ dashboard สรุปเดือน
```

---

## สถาปัตยกรรม

```
Telegram user
   │  พิมพ์คำถามไทย / กด /menu / กด /สรุป
   ▼
telegraf (polling หรือ webhook)
   ├─ whitelist            src/telegram/auth.js       ปฏิเสธคนที่ไม่อยู่ในลิสต์ก่อนเสีย API call
   ├─ menu (ปุ่ม)          src/telegram/menu.js       เมนูหลัก + flow เลือก metric/เว็บ/เดือน
   ├─ session (SQLite)     src/session/store.js       จำเว็บล่าสุด + ทุก turn + idle clock
   ├─ file ingestion       src/data/ingest.js         รับไฟล์ Excel → เก็บดิบ + metadata (spec §3B)
   ├─ parse-on-demand      src/data/parse.js          แปลงไฟล์ → parsed_rows เฉพาะตอนมีคำถามใช้จริง
   ├─ data context         src/data/query.js          เลือก file_type ตามคำถาม + format ให้ Claude
   ├─ Anthropic            src/claude/client.js       system prompt = ไฟล์ skill ต่อกันแบบ verbatim
   │    └─ fraud guard     src/fraud/guard.js         บังคับโครงสร้าง 5 ส่วน + กันการฟันธง
   ├─ monthly report       src/session/monthlyReport.js  รวม raw_files ทั้งเดือน → payload 11 หมวด
   └─ Mini App             src/miniapp/routes.js      Chart.js (vendored)
        ├─ /miniapp            สรุป session (public/miniapp/index.html) — token ใช้ครั้งเดียว อายุ 1 ชม.
        ├─ /miniapp/monthly    สรุปเดือนแบบ tab (public/miniapp/monthly.html) — ลิงก์ส่งต่อได้ + PIN
        └─ PIN gate            src/miniapp/pin.js         scrypt hash + cookie + ล็อกเมื่อเดา PIN
```

### เมนูปุ่ม (`/menu` หรือ `/start`)

ทางเข้าแบบไม่ต้องพิมพ์ 3 ทาง:

| ปุ่ม | ทำอะไร |
|---|---|
| 📊 ดูตัวเลขด่วน | เลือก 1 ใน 6 metric (BIn / DAU / RTP / New Mems / VIP Active% / Bonus Cost) → เว็บ → เดือน → ตอบแบบ Conversational Mode ปกติ |
| 📈 สรุปเดือน | เลือกเว็บ → เดือน → ปุ่มเปิด Dashboard เต็ม 11 หมวด + ลิงก์ที่ forward ต่อได้ (ต้องกรอก PIN) |
| 📋 สรุป session นี้ | เท่ากับ `/สรุป` เดิม |

ทุกเมนูย่อยมีปุ่ม **❌ ยกเลิก** อยู่แถวสุดท้ายเสมอ กดแล้วเคลียร์ตัวเลือกที่ค้างอยู่
(`menu_selections` ใน SQLite) แล้วกลับเมนูหลัก การพิมพ์คำถามใหม่ก็เคลียร์เหมือนกัน

**ปุ่มไม่ได้เป็นทางลัดใหม่ — มันประกอบคำถามแล้วส่งเข้า pipeline เดิม** ข้อความที่ประกอบ
ถูกเขียนให้ตรงกับ regex ที่ `src/data/query.js` มีอยู่แล้ว (เช่น `New Mems` → `new_member_quality`,
`VIP` → `vip`, `Bonus` → `bonus_log`) — `test/menu.test.js` ยืนยันเรื่องนี้ผ่าน `pickFileType()`
ถ้าแก้ข้อความปุ่มโดยไม่ดู regex คำถามจะตกไปที่ `daily_value` แล้วตอบจากไฟล์ผิดอย่างแนบเนียน

เมนูเลือกเดือนสร้างจากเดือนที่**มีไฟล์อยู่จริง** (`listRawFileMonths`) ไม่ใช่จากปฏิทิน
และคำถามจากปุ่มส่ง `yearMonths` ตรง ๆ เข้า `buildDataContext` แทนหน้าต่าง 3 เดือนย้อนหลัง
เพราะเดือนที่ผู้ใช้เลือกอาจเก่ากว่านั้น

### Dashboard สรุปเดือน

`src/session/monthlyReport.js` แยกจาก `src/session/summary.js` เพราะอ่านคนละแหล่ง —
`summary.js` สรุป *บทสนทนา* (อ่านจาก `turns`) ส่วนตัวนี้สรุป *เดือน* (อ่าน `raw_files`
ทั้งหมดของ site+year_month ไม่ว่าจะเคยมีใครถามหรือไม่) และคำนวณตัวเลขเองใน JS ไม่ผ่านโมเดล

11 หมวด: Overview, Finance, Activity, New Member, Deposit Count, Brand/Game, VIP,
Referrer & Agent, Hours, Deposit Detail, Bonus — หมวดที่ยังไม่มีไฟล์จะขึ้น tab ไว้พร้อมบอกว่า
ต้องอัปโหลดไฟล์ไหน (ไม่ซ่อน เพราะ tab ที่หายไปอ่านเหมือน bug)

แต่ละหมวดมี 5 ส่วน: **alert banner** (เฉพาะเมื่อมีเรื่องต้องเตือนจริง — ไม่มีก็ขึ้น
"ไม่มีสัญญาณวิกฤต" ให้ชัด), **KPI** พร้อม benchmark และสีสถานะ, **กราฟ**, **ตาราง**,
และ **Key Insights** เป็นประโยคที่ประกอบจากตัวเลขจริงของเดือนนั้น

หมวดหนึ่งอ่านได้มากกว่าไฟล์เดียว: `fileType` คือไฟล์ที่ต้องมี tab ถึงจะมีข้อมูล ส่วน
`also` คือไฟล์เสริมที่ถ้ามีก็เล่าได้ละเอียดขึ้น ถ้าไม่มีก็แค่เล่าน้อยลง (Overview อ่าน
VIP + Deposit Count มาด้วย, Referrer อ่าน AD/Agent, Hours จับคู่ตารางเงินกับตารางจำนวนคน
เพื่อตอบว่า "เงินเยอะเพราะคนเยอะ หรือเพราะรายใหญ่ฝากหนัก") — ไฟล์เสริมที่ขาดไม่ทำให้
ทั้ง tab ว่าง ทุกไฟล์อ่านครั้งเดียวแล้วใช้ร่วมกัน ถึงจะมี 3 หมวดที่อ่าน `daily_value` เหมือนกัน

### Benchmark แยกรายเว็บ

`config/report-benchmarks.json` ดึงตัวเลขมาจากไฟล์ reference โดยตรง **แยกตามเว็บ** เพราะ
SKILL.md ห้ามใช้ปนกัน — "RTP เกิน 100% 14% ของวันถือว่าปกติ" จริงกับ SH666 แต่ของ U89 คือ 3%
ซึ่งแปลว่าผิดปกติจริง KPI ที่เว็บนั้นไม่มีตัวเลขบันทึกไว้จะ **ไม่แสดง benchmark และไม่แสดงสี**
แทนที่จะไปหยิบของเว็บอื่นมาใช้ (`test/monthlyReport.test.js` เช็คว่าเลขของ U89 ไม่หลุดเข้ารายงาน
SH666 และกลับกัน)

หน้าเว็บแยกเป็น `/miniapp/monthly` ไม่ได้ยัดรวมกับ `/miniapp` เดิม: หน้าเดิมเป็น layout
ตายตัวหน้าเดียว (ข้อความสรุป + กราฟ 1 อัน + ตาราง metric) ส่วนหน้านี้เป็น tab 11 หมวด
ที่แต่ละหมวดมี KPI/กราฟ/ตารางของตัวเอง — รวมกันแปลว่าต้องมี `if (payload.kind)` อยู่หัวทุก
ฟังก์ชันใน `app.js` และแบก CSS สองชุดในไฟล์เดียวโดยไม่มี markup ร่วมกันเลย ส่วนที่ควรใช้ร่วม
ใช้ร่วมอยู่แล้ว: Chart.js ที่ vendor ไว้ และหน้า HTML ที่เป็นเปลือกเปล่าจนกว่า fetch จะสำเร็จ

### ลิงก์สรุปเดือนที่ forward ได้ + PIN

Telegram **ตัดปุ่ม `web_app` ทิ้งเวลามีคน forward ข้อความต่อ** คนที่รับต่อจึงกดเปิด dashboard
ไม่ได้เลย — เป็นที่มาของสามอย่างที่ต้องอ่านคู่กัน:

| ของเดิม | ตอนนี้ | เพราะ |
|---|---|---|
| token สุ่มใหม่ทุกครั้ง ใช้ครั้งเดียว อายุ 1 ชม. | token ผูกกับ (เว็บ, เดือน) ใช้ซ้ำได้ อายุ `MONTHLY_LINK_DAYS` = 60 วัน (`createMonthlyDashboardToken`) | ลิงก์ที่ forward ไปแล้วต้องยังเปิดได้ และสั่งสรุปเดือนใหม่ต้องไม่ทำให้ลิงก์เก่าตาย (payload อัปเดตทับ token เดิม) |
| มีแต่ปุ่ม | ปุ่ม + บรรทัด `🔗 ลิงก์: https://...` ในเนื้อข้อความ | URL ที่เป็นข้อความคือทางเดียวที่รอดจากการ forward — token เลยเป็น hex ไม่ใช่ base64url เพราะ `_` ทำให้ Markdown ของ Telegram เพี้ยน |
| token = ความลับ | PIN = ความลับ (`src/miniapp/pin.js`) | ลิงก์ที่ส่งต่อได้ = ลิงก์ที่หลุดไปไหนก็ได้ |

PIN ตัวเดียวใช้ร่วมทุกเว็บ เก็บเป็น scrypt hash ใน `DASHBOARD_PIN_HASH` (สร้างด้วย
`npm run hash:pin` — ไม่มีที่ไหนเก็บ PIN ตรง ๆ และ log ไม่เคยพิมพ์ทั้ง PIN และ token เต็ม)
scrypt ไม่ใช่ bcrypt เพราะ `node:crypto` มีมาให้แล้ว ไม่ต้องเพิ่ม dependency หรือ compile
native module บน VPS กรอกถูกแล้วได้ cookie HttpOnly อายุ 12 ชม. ที่เซ็นด้วยคีย์ซึ่ง derive
มาจากตัว hash เอง — เปลี่ยน PIN ทีเดียว cookie เก่าตายทั้งหมด กรอกผิดติดกัน 5 ครั้งล็อก IP
นั้น 15 นาที และระหว่างล็อกกรอกถูกก็ยังไม่ให้เข้า (ไม่งั้นการล็อกจะกันได้แค่คนที่เดาไม่ถูก)

ข้อมูลเดือนอยู่หลัง `/api/monthly/:token` ซึ่งผ่าน PIN ส่วน `/api/summary/:token` ของสรุป
session ไม่แตะเลย — token ของมันยังใช้ครั้งเดียวและอยู่ในแชทเสมอ ทั้งสอง route อ่านคนละตาราง
เพื่อให้ token สรุปเดือนไม่มีทางลอดออกทาง route ที่ไม่มี PIN (`test/miniappMonthly.test.js`)

หน่วยเงิน/เปอร์เซ็นต์อ่านจากคอลัมน์ `_THB` / `_pct` ที่ pipeline แปลงให้แล้วเท่านั้น
(รวม `total_points_THB` ของ point log ที่แปลงด้วย `pointsScaleFactor` ของแต่ละเว็บ) ไม่มี
การคูณอัตราแลกเปลี่ยนหรือคูณ 100 ที่ไหนในโมดูลนี้หรือในหน้าเว็บ ratio ที่ pipeline
ไม่มีคอลัมน์แปลงให้ (เช่น Power User Index, ฝากจริง% ของ referrer, Referral Rate) คำนวณจาก
**จำนวนคน**เท่านั้น ซึ่งเป็นกรณีเดียวที่ SKILL.md อนุญาต

### แถว Total ของ Power BI ที่ค้างอยู่ใน parsed_rows

`dropNonDataRows` ตัดแถว `Total` / `Applied filters:` ทิ้งตั้งแต่ตอน parse มาตั้งแต่ PR #9
แต่ไฟล์ที่ parse **ก่อน** PR นั้นยังมีแถวพวกนี้ค้างอยู่ และ `parsed = 1` ทำให้ไม่มีวัน parse ใหม่
— เดือนนั้นจะมี "วันที่ 32" ที่ค่าเท่ากับ 31 วันรวมกัน ทำให้ทุก sum เกือบสองเท่าและ max ≈ 31 เท่าของวันจริง

กันไว้ที่ `queryParsedRows` ใน `src/data/db.js` ซึ่งเป็นจุดเดียวที่ `query.js` กับ
`monthlyReport.js` ใช้ร่วมกัน — เพราะ**ทั้งสองทางมีปัญหานี้** ไม่ใช่แค่ dashboard
(ทางแชทรอดมาเพราะไฟล์ 33 แถว ≤ `DETAIL_ROW_LIMIT` เลยไปทางส่งดิบ ไม่ได้ไปทางสถิติ)

filter ทำงาน**เฉพาะ file type ที่มี `dateColumn`** ซึ่งเป็นส่วนที่พลาดไม่ได้ — ไฟล์ snapshot
(vip / brand_game_value / referrer / ad_agent / hour pivot) ไม่มีแกนวันที่เลย `row_date` เป็น
null ทุกแถวโดยปกติ ถ้ากรองแบบไม่มีเงื่อนไขจะได้ 0 แถวและ dashboard หายไปครึ่งหนึ่ง
`test/staleTotalRow.test.js` เช็คครบทั้ง 15 ประเภท

filter กันไม่ให้แถวขยะถูก**อ่าน** แต่มันยังอยู่ใน DB — ล้างจริงด้วย `npm run reparse`:

```bash
npm run reparse -- --stale                # หาว่าไฟล์ไหนยังมีแถวขยะค้าง
npm run reparse -- --id=9                 # dry run (ไม่แตะอะไร)
npm run reparse -- --id=9 --apply         # อ่านไฟล์ใหม่แล้วเขียนทับ
npm run reparse -- --id=9 --apply --lazy  # แค่ล้าง cache ให้ parse ใหม่ตอนมีคำถาม
```

⚠️ สคริปต์จะ**ปฏิเสธถ้าไฟล์ Excel ต้นฉบับหายไปจากดิสก์แล้ว** เพราะ retention ลบไฟล์ดิบ
แต่เก็บ `parsed_rows` ไว้โดยตั้งใจ — แถวใน DB จึงอาจเป็นสำเนาสุดท้ายของเดือนนั้น ลบแล้วกู้ไม่ได้
และในโหมดปกติมันจะ**อ่านไฟล์ให้สำเร็จก่อน** ถึงจะลบของเก่า ไฟล์เสียจึงไม่ทำให้ข้อมูลหาย

หมวดที่ไฟล์โหลดไม่ได้จะบอกเหตุผล**ตามที่ parser โยนมาจริง** ถ้าเป็นการปฏิเสธที่ตั้งใจ
(เช่น point log ของเว็บที่ยังไม่ได้ตั้ง `pointsScaleFactor`) เพราะข้อความ "อ่านไฟล์ไม่ได้"
เฉย ๆ จะทำให้คนไปอัปโหลดไฟล์ใหม่ทั้งที่ไฟล์ไม่ได้ผิด — ส่วน error ระดับระบบ (ไฟล์หาย,
permission) ใช้ข้อความกลางแทน ไม่ปล่อย path ของเครื่องออกหน้าเว็บ

**ไม่มีข้อมูลติดต่อลูกค้าใน payload เลย** — ไฟล์ VIP มีคอลัมน์ `Phone` และรายงานตัวอย่าง
ที่หน้านี้มาแทนก็พิมพ์เบอร์ออกมา แต่หน้านี้เปิดได้ด้วย URL ลิงก์ที่ถูก forward/screenshot
ไปแล้วเรียกคืนไม่ได้ ตาราง Lost VIP จึงมีแค่ username ซึ่งพอให้เปิดดูในระบบหลังบ้านได้
`test/monthlyReport.test.js` เช็คทั้ง payload ที่ serialize แล้วว่าไม่มีเบอร์หลุดออกมา
ทั้งทางคอลัมน์ ชื่อหัวตาราง ค่าในแถว หรือประโยค insight

### File ingestion (spec §3B) — แทนที่ Google Sheets เดิม

ผู้ใช้ส่งไฟล์ `.xlsx` เข้าแชทได้เลย บอทจะ:

1. เดา **ประเภทไฟล์** จาก column header (`src/data/fileTypes.js` เป็น source of truth เดียว —
   `Last BIn 2 Y`→VIP, `1st New%`→New Member Quality, `GameKind`→Brand/Game Value,
   `21+ Counts`→Deposit Count Distribution, มี `RTP`+`BIn`+`DAU`→Daily Value)
2. เดา **เว็บ** จากข้อความ/แคปชันที่แนบมา หรือชื่อไฟล์ ผ่าน `normalizeSiteName()` เดียว
   (`src/data/sites.js`, ตาราง alias อยู่ที่ `config/site-aliases.json`) — เดาไม่ได้จะถามกลับ
3. เดา **เดือนที่ข้อมูลนี้เป็นของเดือนไหน** จาก column วันที่ในไฟล์เอง (ถ้ามี) หรือจากข้อความที่แนบมา
   ไม่งั้น fallback เป็นเดือนก่อนหน้าเดือนที่อัปโหลด (`src/data/ingest.js`)
4. เก็บไฟล์ดิบที่ `DATA/{SITE}/{YYYY}/{MM}/{file_type}_{timestamp}.xlsx` + metadata ใน SQLite
   ตาราง `raw_files` — ไฟล์ซ้ำ (site+เดือน+ประเภทตรงกัน **และ** ชื่อไฟล์+ขนาดตรงกัน) จะถามก่อน
   ทับ ส่วนไฟล์ที่ต่างกันแค่ชื่อ/ขนาดถือเป็นอัปเดต บันทึกทับเงียบ ๆ (spec §3B/§10)
5. Parse จริง (`src/data/parse.js`) เกิดขึ้นครั้งแรกที่มีคำถามต้องใช้ไฟล์นั้นเท่านั้น แล้ว cache ไว้ใน
   ตาราง `parsed_rows` (schema เดียวกันทุก file type — เก็บแถวดิบเป็น JSON แล้วให้
   `transform.js` แปลงหน่วย/สกุลเงินตอน query แทนที่จะ hard-code คอลัมน์ต่อ file type)
6. Retention: ลบไฟล์ดิบ (ไม่ลบ `parsed_rows`) ที่เก่ากว่า `RAW_FILE_RETENTION_MONTHS` เดือน
   (default 6) — เช็คทุกวัน ทำงานจริงเฉพาะวันที่ 1 (`src/data/retention.js`)

### system prompt ประกอบจากไฟล์ ไม่ได้เขียนเอง

`src/prompt/loader.js` ต่อไฟล์ทั้ง 9 ใน `skills/thai-data-analyst/` เข้าด้วยกัน
**แบบไม่แก้แม้ตัวอักษรเดียว** ตาม spec §4 (benchmark ต้องตรงกับที่วิเคราะห์มาแล้ว ห้าม paraphrase)
มีเทสยืนยันว่าเนื้อไฟล์ถูกฝังลงไปครบทุกไบต์ แล้วปิดท้ายด้วย
[`prompt/bot-overlay.md`](prompt/bot-overlay.md)

**`SKILL.md` เป็นเจ้าของกฎ Conversational Mode ทั้งหมด** — โครงสร้างคำตอบ 4 ส่วน, เงื่อนไขทำกราฟ,
และเนื้อหาสรุปท้าย session อยู่ในหัวข้อ "โหมดการตอบ" กับ "Session และ Dashboard สรุปท้าย session"
ของไฟล์นั้น

`bot-overlay.md` จึงแคบลงเหลือแค่**สัญญาฝั่งเครื่อง** ที่ `SKILL.md` ไม่รู้:
schema ของ JSON envelope, ชื่อหัวข้อ fraud 5 ส่วนที่ code ใช้ตรวจ, และ marker `SESSION_SUMMARY_REQUEST`
— ไม่พูดซ้ำกฎที่ skill กำหนดไว้แล้ว เพราะกฎชุดที่สองที่ต่างกันเล็กน้อยคือต้นเหตุที่ทำให้สองไฟล์เพี้ยนกัน
(มีเทสกันไว้ทั้งสองทาง: หัวข้อ fraud ที่ overlay สั่ง ต้องผ่าน validator ได้, และ overlay ต้องไม่ระบุ
โครงสร้าง 4 ส่วนซ้ำ)

ถ้ากฎใน overlay ขัดกับไฟล์ skill → **ยึดไฟล์ skill เสมอ** (เขียน priority rule ไว้ในตัว overlay เอง)

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
| ไม่สร้างกราฟทุกคำถาม | `SKILL.md` + spec §1, §6 | `parseEnvelope` ทิ้ง `show_chart` ถ้า payload กราฟใช้ไม่ได้ + fraud ถูกบังคับ `false` เสมอ |
| fraud ต้องครบ 5 ส่วน | `fraud-anomaly-detection.md` + spec §7 | `validateFraudResponse` → ถ้าไม่ครบ ขอแก้ 1 รอบ → ถ้ายังไม่ผ่าน **ไม่ส่งออก** |
| ห้ามฟันธงว่ามีการโกง | เดียวกัน | ตรวจ verdict pattern (`ฟันธง`, `โกงแน่นอน`, …) แล้ว reject |
| สรุปเฉพาะตอนขอ/idle ไม่ใช่ทุก N คำถาม | `SKILL.md` + spec §5.2 | `findIdleSessions` + `markSummaryPrompted` — idle จะ**ถามก่อน** ไม่ดัน dashboard เข้ามาเลย |
| whitelist | spec §8 | middleware default-deny ก่อนถึง handler |
| token ผิด = ไม่ต้อง start | — | `getMe()` ตอน boot → ถ้า 401 ตายทันที ดีกว่ารันแล้วเงียบ |

การตรวจหัวข้อ fraud ผูกกับ**ตำแหน่งหัวข้อ** ไม่ใช่ค้นทั้งข้อความ — ตอนแรกใช้ค้นทั้งข้อความแล้วเจอว่า
คำว่า "คำอธิบายอื่น" ที่โผล่ในประโยคบรรยาย ทำให้คำตอบที่**ขาด**หัวข้อ "คำอธิบายทางเลือก" ผ่านการตรวจได้

ตรวจชื่อพนักงานไทยแบบอัตโนมัติ **ไม่ได้ทำ** — NER ภาษาไทยไม่แม่นพอจะเป็น safety control
ที่ทำแทนคือห้ามใน prompt + จับ verdict language ซึ่งเป็นส่วนที่สร้างความเสียหายจริง

---

## คำสั่งในบอท

| คำสั่ง | ทำอะไร |
|---|---|
| ส่งไฟล์ `.xlsx` | อัปโหลดข้อมูลสิ้นเดือน — บอทเดาประเภทไฟล์/เว็บ/เดือนให้ (spec §3B) |
| พิมพ์คำถามเลย | ตอบ 4 ส่วน: ตัวเลข+สถานะ / ข้อดี / ข้อเสีย / คำแนะนำ |
| `/menu` `/start` `/เมนู` | เมนูปุ่ม 3 ทาง (ดูตัวเลขด่วน / สรุปเดือน / สรุป session) |
| `/สรุป` `/จบ` | สรุป session + ปุ่มเปิด dashboard แล้วเคลียร์ session |
| `/เว็บ SH666` | เปลี่ยนเว็บที่กำลังคุย (ปกติบอทจำเว็บล่าสุดให้อยู่แล้ว) |
| `/whoami` | ดู Telegram ID ตัวเอง |
| `/status` | (Super Admin) เช็ค skill files + ไฟล์ข้อมูลที่อัปโหลดแล้วต่อเว็บ/ประเภท |
| `/fxrate` | ดูอัตราแลกเปลี่ยนที่ใช้อยู่ทุกเว็บ + ที่มาของค่า (config หรือตั้งผ่านแชท) |
| `/fxrate SH666 0.812` | (Super Admin) เปลี่ยนอัตรา — ต้องกดยืนยันก่อนถึงจะมีผล |

`/สรุป` `/จบ` `/เมนู` เป็นภาษาไทย Telegram จึงไม่ tag เป็น bot_command — จับใน text handler
(`/summary`, `/end`, `/menu` ใช้ได้เหมือนกัน)

### อัตราแลกเปลี่ยน

`config/site-aliases.json` แยกเป็น `scaleFactor` (ตัด 3 ศูนย์ของ Power BI — ไม่เปลี่ยน),
`fxRate` (อัตราสกุลเงินท้องถิ่น → THB) และ `fxRateAsOf` (วันที่บันทึกอัตรานั้น)
ตัวคูณจริงคำนวณจาก `scaleFactor × fxRate` ตอนอ่าน config ไม่ได้เก็บเป็นตัวเลขไว้

### สเกลของคอลัมน์ Points (ไฟล์ point log)

คอลัมน์ `Points` ใน `bonus.xlsx` / `reward point.xlsx` / `other transfer.xlsx`
**ไม่ได้ใช้สเกลเดียวกับคอลัมน์เงินอื่น** จึงมี `pointsScaleFactor` แยกไว้ใน config
ไฟล์เดียวกัน (SH666 = 100 — ค่าดิบ `1.200` = 120 MMK)
`pointsFactor` = `pointsScaleFactor × fxRate` คำนวณตอนอ่าน config เหมือน `moneyFactor`

มีแค่ SH666 ที่ตั้งค่าไว้ เว็บที่ยังไม่ได้ตั้งค่า ถ้ามีไฟล์ point log
เข้ามาจะ throw ตอน parse (`ยังไม่ได้ตั้งค่า pointsScaleFactor สำหรับเว็บนี้`)
ตั้งใจให้พังเสียงดังแทนที่จะยืมสเกลของเว็บอื่นมาใช้แล้วรายงานผิดเงียบๆ
รายละเอียดอยู่ใน `skills/thai-data-analyst/references/bonus-log.md`

> ⏳ **ค่า 100 ยังไม่ยืนยันขั้นสุดท้าย** — มาจากคำยืนยันของผู้ใช้ ยังไม่ได้เทียบกับ
> ภาพหน้าจอ Power BI จริง และเคยเปลี่ยนไปมาแล้วหลายรอบ (เคยเป็น 100,000)
> ถ้าจะแก้ แก้ที่ `config/site-aliases.json` จุดเดียว

> ข้อจำกัดที่รู้ตัว: `total_points_THB` คำนวณตอน parse แล้วเก็บลง `parsed_rows`
> ต่างจากคอลัมน์ `_THB` อื่นที่แปลงตอน query — ถ้าเปลี่ยน `/fxrate` ทีหลัง
> แถวที่ parse ไว้แล้วจะยังใช้อัตราเดิม ต้อง re-parse ไฟล์นั้นถึงจะขยับตาม

ค่าที่เปลี่ยนผ่าน `/fxrate` **ไม่ได้เขียนทับไฟล์ config** แต่เก็บเป็นแถวใหม่ใน SQLite
(`fx_rate_overrides`, append เท่านั้น มีประวัติครบ) แล้ว layer ทับตอน runtime —
เพราะไฟล์ config อยู่ใน git ถ้าบอทเขียนทับจะชนกับ `git pull` และอาจถูก checkout ทับหายเงียบ

หลังอัปโหลดไฟล์สำเร็จ บอทจะเทียบ `fxRateAsOf` กับวันที่ข้อมูลล่าสุดของเว็บนั้น
ถ้าข้อมูลใหม่กว่าอัตราเกิน 90 วันจะเตือน (เตือนซ้ำไม่เกินสัปดาห์ละครั้งต่อเว็บ)
พออัปเดตอัตราแล้ว `fxRateAsOf` ขยับมาเป็นวันที่อัปเดต การเตือนจึงหยุดเอง

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

### Decisions เพิ่มเติมจาก file ingestion (spec §3B)

| หัวข้อ | ที่เลือก | เหตุผล |
|---|---|---|
| ไลบรารีอ่าน `.xlsx` | `xlsx` (SheetJS) | เดิมเลือก `exceljs` เพราะยัง publish บน npm ปกติ แต่เปลี่ยนแล้ว (2026-08): ไฟล์ export บางแบบเขียน `xl/workbook.xml` โดยใส่ namespace prefix (`<x:workbook>` แทน `<workbook>`) ซึ่งถูกต้องตาม OOXML spec แต่ exceljs มองหา tag แบบไม่มี prefix เลยหา `<sheets>` ไม่เจอ แล้ว throw `Cannot read properties of undefined (reading 'sheets')` — SheetJS ทนกับรูปแบบนี้ได้ ติดตั้งจาก CDN ของ SheetJS โดยตรง (`https://cdn.sheetjs.com/...`) ไม่ใช่ npm registry เพราะเวอร์ชันบน registry ค้างที่ 0.18.5 และมีช่องโหว่ high severity ที่ไม่มีแพตช์ |
| schema ตาราง parsed | ตารางเดียว `parsed_rows` (คอลัมน์ `site`/`file_type`/`year_month`/`row_date`/`row_json`) แทนตารางแยกต่อ file type | คอลัมน์จริงในไฟล์มี 15–30 คอลัมน์ต่อ file type และเปลี่ยนได้ตามที่ Power BI export เพิ่ม — เก็บเป็น JSON ตามชื่อคอลัมน์เดิม แล้วให้ `transform.js` (`normaliseRow`/`deriveMetrics`) แปลงหน่วยตอน query ใช้ shape เดียวกับที่เทสอยู่แล้ว ไม่ต้อง hard-code SQL column ต่อ file type |
| เดือนของข้อมูล (`year_month`) เมื่อไฟล์ไม่มี column วันที่ (VIP, Brand/Game Value) | หาจากข้อความ/แคปชันที่แนบมาก่อน (`2026-06`, `มิถุนายน`) ไม่งั้น fallback เป็นเดือนก่อนหน้าเดือนอัปโหลด | spec ไม่ได้ระบุไว้ตรง ๆ — ตัวอย่าง path ในสเปคเอง (`.../2026/06/..._20260701...`) บ่งบอกว่าอัปโหลดวันที่ 1 ก.ค. แต่เก็บเป็นข้อมูลเดือน มิ.ย. ตรงกับ pattern "อัปโหลดข้อมูลที่เพิ่งจบเดือน" |

## Phase 2 (ยังไม่ทำ ตาม spec §8)

- [ ] proactive fraud alert แบบ cron รายวัน
- [ ] เปรียบเทียบข้ามเว็บในคำถามเดียว
- [ ] export PDF / ส่งอีเมล
- [ ] ยืนยัน platform type ของ 88F (ตอนนี้สมมติ NCT ตาม `88fed-metrics.md`)
