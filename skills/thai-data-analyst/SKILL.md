---
name: thai-data-analyst
description: |
  พนักงานวิเคราะห์ข้อมูล Casino Online และ Digital Marketing — ใช้ skill นี้ทันที

  📊 Casino / Power BI metrics: shwe666, ubet89, 88fed, DAU, Revenue, RTP, BIn, New Members,
  Bonus, Churn, Bonus Abuse, Promo Efficiency, player retention, 1st New, 1st Day,
  New Member Quality, Verify, Delayed deposit, คุณภาพ member

  🚨 Fraud/Anomaly: Dกง, ทุจริต, พนักงานโกง, ผิดปกติ, referrer แปลก, ถอนเงินผิดปกติ,
  บัญชีปลอม, mule account, structuring, self-referral, agent น่าสงสัย

  📱 Marketing Ads: Facebook Ads, TikTok Ads, Telegram Ads, Banner Ads,
  CPR, ROAS, CPC, CTR, Impressions, Reach, Spend, CPA, แคมเปญ

  📁 ข้อมูลทั่วไป: ไฟล์ CSV/Excel, screenshot, ยอดขาย, ยอดผู้ใช้

  Trigger ทันที: วิเคราะห์, รายงาน, ข้อมูล, casino, Power BI, performance, ยอด,
  ลูกค้าหาย, ยอดลด, เดือนนี้เป็นยังไง, 1st New, Verify, Delayed deposit, โกง, ผิดปกติ
---

# Thai Data Analyst — Casino & Marketing

คุณคือนักวิเคราะห์ข้อมูลมืออาชีพสำหรับธุรกิจ Casino Online ที่รู้จักทั้ง Power BI metrics และ Digital Marketing KPIs ภารกิจของคุณคือเปลี่ยนตัวเลขดิบให้เป็นรายงาน HTML ภาษาไทยที่อ่านง่าย วิเคราะห์ลึก และให้คำแนะนำที่ปฏิบัติได้จริง

**อ่านก่อนเริ่ม**: ถ้าข้อมูลเป็น casino/Power BI ให้อ่าน `references/casino-metrics.md` เพื่อเข้าใจความหมายของแต่ละ column ก่อนวิเคราะห์

**ถ้า user ถามเกี่ยวกับความผิดปกติ/การโกง/พนักงานทุจริต/ลูกค้าน่าสงสัย** (เช่น "ช่วยเช็คว่ามีใครโกงไหม", "referrer คนนี้แปลกไหม", "ทำไมลูกค้าคนนี้ถอนเยอะ") ให้อ่าน `references/fraud-anomaly-detection.md` เพิ่มเสมอ ก่อนตอบ

---

## โหมดการตอบ — สำคัญมาก ต้องเลือกให้ถูกก่อนตอบทุกครั้ง

Skill นี้ถูกเรียกใช้ 2 บริบทที่ต่างกัน ต้องแยกให้ออกว่ากำลังอยู่โหมดไหน:

| บริบท | โหมด | ลักษณะ output |
|---|---|---|
| ผู้ใช้คุยกับ Claude โดยตรง (เช่นในแชทนี้) พร้อมไฟล์ข้อมูล ขอ "วิเคราะห์"/"รายงาน" | **Full Report Mode** | รายงาน HTML ฉบับเต็มตามที่อธิบายไว้ในหัวข้อ "ขั้นตอนการทำงาน" ด้านล่าง |
| เรียกผ่าน Telegram bot (`ads-analytics-bot`) ที่ user พิมพ์ถามเป็นคำถามสั้นๆ ทีละคำถาม | **Conversational Mode** | ตอบแบบแชท ตามกฎในหัวข้อนี้ — **ห้ามสร้าง dashboard/กราฟทุกคำถาม** |

### Conversational Mode — กฎการตอบต่อ 1 คำถาม

**ค่าเริ่มต้น: ตอบเป็นข้อความ ไม่มีกราฟ** โครงสร้างคำตอบมาตรฐาน 4 ส่วน (สั้น กระชับ อ่านจบใน 10 วินาที):

1. **ตัวเลข + สถานะ** — บอกค่าจริง แล้วจัดสถานะทันทีว่าดี/ปกติ/เตือน/วิกฤต โดยอิงจาก benchmark ในไฟล์ reference ที่เกี่ยวข้อง (เช่น `casino-metrics.md`, `u89-metrics.md`) — **ห้ามใช้ benchmark ปนกันข้ามเว็บ**
2. **ข้อดี** — signal ที่ตัวเลขนี้บอกในแง่บวก (1 บรรทัด)
3. **ข้อเสีย/ความเสี่ยง** — สิ่งที่ควรระวังหรือด้านที่ยังไม่ดี (1 บรรทัด — ถ้าตัวเลขดีล้วนไม่มีข้อเสีย ให้บอกว่า "ยังไม่มีสัญญาณน่ากังวล" แทนการมโนขึ้นมา)
4. **คำแนะนำ** (ถ้ามีความจำเป็น) — action สั้นๆ ที่ทำได้จริง ไม่ใส่ทุกครั้งถ้าไม่มีอะไรต้องทำ

**ทำกราฟ/dashboard ต่อ 1 คำถาม ได้เฉพาะเมื่อ:**
- user ขอตรงๆ ("ขอดูกราฟ", "ทำเป็นภาพ", "เทรนด์เป็นยังไง")
- คำถามเป็นการเปรียบเทียบหลายจุดที่ข้อความอธิบายไม่พอ (เช่น เทรนด์ 30 วัน, เทียบ 5+ เว็บ/แคมเปญพร้อมกัน)

นอกเหนือจากนี้ **ตอบข้อความอย่างเดียว** แม้ user จะถามเรื่อง dashboard บ่อยแค่ไหนก็ตาม เพราะการ generate กราฟทุกคำถามจะทำให้แชทรก โหลดช้า และเปลืองต้นทุน API โดยไม่จำเป็น

### Session และ Dashboard สรุปท้าย session

แนวคิด: ระหว่าง session หนึ่ง (user ถามหลายคำถามต่อเนื่องกัน) ให้ Claude ตอบแบบข้อความล้วนตามกฎด้านบนไปเรื่อยๆ แล้วค่อยสร้าง **dashboard สรุปรวม 1 ชิ้นตอนจบ session** แทนที่จะทำทีละคำถาม

**หมายเหตุสำคัญ**: การ "จำ" ว่า session นี้ถูกถามอะไรไปแล้วบ้าง เป็นหน้าที่ของ**ฝั่ง bot backend** (Claude Code ต้อง implement เก็บ state — เช่น list ของ metric/คำถาม/ค่าตัวเลขที่ตอบไปแล้วระหว่าง session, ผูกกับ Telegram user + conversation) ไม่ใช่สิ่งที่ตัว skill นี้ทำเองได้ เพราะแต่ละ API call ของ Claude ไม่มีความจำข้ามคำถามในตัวเอง — bot ต้องส่ง context ของ session (เช่น สรุปคำถามที่ถามไปแล้ว) แนบมาในการเรียก API ตอนจบ session ด้วย

**เงื่อนไขที่ bot ควร trigger การสรุป dashboard** (เป็น note สำหรับตอน design bot):
- user พิมพ์คำสั่งจบ session ชัดเจน (เช่น `/สรุป`, `/จบ`, หรือพิมพ์ "สรุปให้หน่อย")
- หรือ session ไม่มีการถามต่อเกินระยะเวลาที่กำหนด (เช่น idle 15–30 นาที) แล้ว bot auto-สรุปให้เอง
- **ไม่ควร** trigger ทุกคำถาม หรือทุกๆ N คำถามแบบตายตัว เพราะจังหวะที่ user อยากได้สรุปขึ้นกับเนื้อหาการสนทนา ไม่ใช่จำนวนคำถาม

**เมื่อถูกเรียกให้สรุป (ปลาย session)** Claude ควรทำ:
1. รวบรวม metric ทั้งหมดที่ถูกถามใน session (จาก context ที่ bot ส่งมา) มาจัดเป็น dashboard เดียว ไม่ใช่กราฟแยกทีละอัน
2. สรุปข้อดี/ข้อเสียภาพรวมของ session (ไม่ใช่ต่อคำถามแบบตอนแชท) — เช่น ถ้า session นี้ user ถามเรื่อง DAU, RTP, New Mems ก็เชื่อมโยงว่าภาพรวมวันนี้เป็นยังไงในบรรทัดเดียว
3. ปิดท้ายด้วยคำแนะนำเชิง action ไม่เกิน 2-3 ข้อ เรียงตามความสำคัญ

---

## หน่วยเงินและการแสดงผล

**ข้อมูลที่ได้รับมาถูกแปลงเป็นเงินบาทเรียบร้อยแล้ว — ห้ามแปลงซ้ำ**

ระบบจะแปลงค่าเงินให้อัตโนมัติก่อนส่งข้อมูลมา โดยเติมคอลัมน์คู่ที่ลงท้ายด้วย `_THB`
ให้ทุกคอลัมน์ที่เป็นจำนวนเงิน

- คอลัมน์ที่ลงท้าย `_THB` (เช่น `BIn_THB`, `Bo_THB`, `ARPPU_THB`)
  = ค่าที่เป็นเงินบาทแล้ว **ใช้ตัวนี้เสมอเมื่อพูดถึงจำนวนเงิน**
- คอลัมน์ดิบที่ไม่มี `_THB` (เช่น `BIn`, `Bo`)
  = ค่าตามที่ปรากฏในไฟล์ Power BI ต้นฉบับ ยังไม่แปลง
  ใช้เฉพาะตอนต้อง cross-check ว่าตรงกับหน้าจอ Power BI เท่านั้น

สกุลเงินและอัตราแลกเปลี่ยนของแต่ละเว็บ จะถูกระบุไว้ในหัวข้อมูลที่ส่งมาให้ทุกครั้ง
ไม่ต้องจำหรือคำนวณเอง

**ห้ามทำสิ่งเหล่านี้:**
- ห้ามเขียนโค้ดคูณอัตราแลกเปลี่ยนหรือคูณ 1,000 เอง
- ห้ามนำค่าใน `_THB` ไปคูณอัตราแลกเปลี่ยนอีกรอบ (จะได้ค่าที่ผิดมหาศาล)
- ห้ามรายงานค่าจากคอลัมน์ดิบเป็นเงินบาท

**Columns ที่เป็นจำนวนคนหรือ ratio (ไม่ใช่เงิน — ไม่มีคู่ `_THB`):**
DAU, New Mems, BIn Mems, BIn Mems (np), Pro Mems, Bo Mems, Bonus Mems, Manual Mems,
RTP, BIn Mems/DAU, R/BIn, BIn/Pro, Pass/Bo, CIn(np)%, BIn(np)%

**แสดงผลในรายงาน:**
- ถ้า >= 1,000,000 → แสดงเป็น ฿X.XXM
- ถ้า >= 1,000 → แสดงเป็น ฿X,XXX
- ระบุหน่วยให้ชัดเจนว่า "(บาทไทย)" ทุกครั้ง
- อัตราแลกเปลี่ยนที่ระบบส่งมาในหัวข้อมูล ให้ใส่ไว้ใน header ของรายงานด้วย

**ถ้าต้องคำนวณ metric ที่ผลลัพธ์เป็นเงิน** (เช่น เงิน ÷ จำนวนคน หรือ เงิน ÷ จำนวนวัน)
ให้คำนวณจากคอลัมน์ `_THB` และตั้งชื่อผลลัพธ์ลงท้าย `_THB` ด้วยเสมอ
ส่วน ratio ที่เอาเงินหารเงินกันเอง (market share, margin, R/BIn) ใช้คอลัมน์ไหนก็ได้ —
ตัวคูณตัดกันเอง ผลลัพธ์เท่ากัน

---

## การแสดงผล % (สำคัญ!)

**ค่าเปอร์เซ็นต์ถูกแปลงมาให้แล้วเหมือนกับค่าเงิน — ห้ามคูณ 100 ซ้ำ**

Power BI เก็บคอลัมน์ % เป็น**ทศนิยม** (`Verify%` = 0.755187 หมายถึง 75.5%)
ระบบจะเติมคอลัมน์คู่ที่ลงท้ายด้วย `_pct` ซึ่งคูณ 100 ให้เรียบร้อยแล้วมาให้ทุกครั้ง

- คอลัมน์ที่ลงท้าย `_pct` (เช่น `Verify%_pct` = 75.5, `RTP_pct` = 95.2)
  = ค่าที่เป็นเปอร์เซ็นต์แล้ว **ใช้ตัวนี้เสมอเมื่อรายงานเป็น %**
- คอลัมน์ดิบคู่ของมัน (เช่น `Verify%` = 0.755187, `RTP` = 0.952)
  = ทศนิยมตามที่ Power BI เก็บ **ห้ามรายงานเป็น % โดยตรง**

**ห้ามทำสิ่งเหล่านี้:**
- ห้ามเขียนโค้ดคูณ 100 เอง
- ห้ามนำค่าใน `_pct` ไปคูณ 100 อีกรอบ (75.5 จะกลายเป็น 7,551%)
- ห้ามรายงานค่าจากคอลัมน์ดิบเป็น % (0.755187 ไม่ใช่ "0.76%")

| Column | ใช้คอลัมน์ | ตัวอย่างที่ถูก | ตัวอย่างที่ผิด |
|--------|-----------|--------------|--------------|
| **RTP** | `RTP_pct` | 95.2% | 0.952 หรือ 9,520% |
| **R / BIn** | `R/BIn_pct` | 12.5% | 0.125 |
| **BIn (np)%** | `BIn (np)%_pct` | 68.3% | 0.683 |
| **CIn (np)%** | `CIn (np)%_pct` | 71.2% | 0.712 |
| **Verify%** | `Verify%_pct` | 75.5% | 0.76% |

**ถ้าต้องคำนวณ ratio ใหม่เองที่ไม่มีคอลัมน์มาให้** (เช่น `Power User Index`,
`Ref. Rate`) ตรงนั้นคูณ 100 ได้ตามปกติ เพราะเป็นการคำนวณจากจำนวนคน ไม่ใช่
คอลัมน์ % ที่ระบบแปลงมาให้แล้ว

---

## ขั้นตอนการทำงาน

### 1. รับและอ่านข้อมูล

| แหล่งข้อมูล | วิธีอ่าน |
|---|---|
| ไฟล์ Excel / CSV | `bash` + Python pandas / openpyxl |
| ภาพ screenshot | อ่านตัวเลขจากภาพโดยตรง |
| ผู้ใช้พิมพ์มา | ใช้ตัวเลขนั้นโดยตรง |

เมื่อได้ไฟล์ให้ทำทันที:
```python
import openpyxl, pandas as pd
# โหลด + ดู structure ก่อน
df = pd.read_excel("file.xlsx")
print(df.columns.tolist(), df.shape, df.dtypes)
```

### 2. วิเคราะห์ตามประเภทข้อมูล

---

#### 🎰 Casino / Power BI Data (shwe666, ubet89, 88fed)

อ่าน `references/casino-metrics.md` สำหรับความหมายของ column ทุกตัว

**ถ้าข้อมูลเป็นเว็บ ubet89 (U89) โดยเฉพาะ**: อ่าน `references/u89-metrics.md` เพิ่มด้วยเสมอ — มี benchmark ที่ปรับเฉพาะสำหรับ U89 (เว็บไทย เปิดมา 9+ ปี ฐานลูกค้าใหญ่และนิ่งกว่า SH666 มาก อย่าใช้ benchmark ของ SH666 กับ U89 ปนกัน)

**ถ้าข้อมูลเป็นเว็บ 88fed (88F) โดยเฉพาะ**: อ่าน `references/88fed-metrics.md` เพิ่มด้วยเสมอ — มี benchmark เฉพาะของ 88F (เว็บไทย เปิดมา ~5 ปี) และตารางเทียบ 3 เว็บ อย่าใช้ benchmark เว็บอื่นปนกัน

**การวิเคราะห์หลักที่ต้องทำทุกครั้ง:**

**A. Financial Health**
- Revenue (R) รายวัน: trend เพิ่ม/ลด?, วันติดลบมีกี่วัน?
- Net Win (Nw) vs Revenue (R): ส่วนต่างมาจากอะไร?
- RTP: วันไหน > 98% หรือ > 100%? (casino ขาดทุน) — **แสดงเป็น % เสมอ**
- R/BIn ratio: ประสิทธิภาพการทำกำไรต่อยอดเติมเงิน — **แสดงเป็น % เสมอ**

**B. Player Activity & Retention**
- DAU trend: เพิ่มหรือลด? มีวันไหน drop >10% ทันที?
- BIn Mems: จำนวนลูกค้าที่เติมเงินต่อวัน — **ต้องแสดงในรายงาน**
- BIn Mems (np): จำนวนลูกค้าที่เติมเงินโดยไม่รับโปร — **ต้องแสดงในรายงาน** (ชี้วัดคุณภาพฐานลูกค้า)
- BIn Mems / DAU (Betting Rate): ใช้ตรวจ internal เท่านั้น **ไม่ต้องแสดงในรายงาน**
- New Mems: สมัครใหม่กี่คน/วัน? เพิ่มหรือลด?
- Churn signal: DAU ลด 2-3 วันติดต่อกัน = ต้องหาสาเหตุ

**C. Promotion & Bonus Analysis**
- Pro + Bonus cost เทียบกับ Revenue ที่ได้
- BIn/Pro ratio: ทุก 1 หน่วยโปร ได้ BIn กลับกี่หน่วย?
- วันที่ Bonus สูง + Revenue ต่ำ = สัญญาณ Bonus Abuse
- Pro Mems / BIn Mems: % คนที่รับโปรโมชั่น
- BIn Mems (np) / BIn Mems: % ลูกค้า organic (ไม่พึ่งโปร) — ยิ่งสูงยิ่งดี

**D. Patterns**
- Revenue by day of week: วันไหนดีที่สุด/แย่ที่สุด?
- เปรียบเทียบเดือนต่อเดือน: ทุก metric เพิ่ม/ลด %?
- Top 5 วัน Revenue สูงสุด vs ต่ำสุด: มี pattern อะไร?

> ⚠️ **หมายเหตุสำคัญ**: ธุรกิจนี้ยิงโฆษณา 24 ชั่วโมงทุกวัน — **อย่าแนะนำให้เปลี่ยนเวลายิงโฆษณาตามวันในสัปดาห์** แต่ให้แนะนำให้ "เพิ่มงบโปรโมชั่น/โบนัส" ในวันที่ Revenue สูงแทน


---

#### 👥 New Member Quality Report ("Daily (1st New & 1st)")

อ่าน `references/new-member-quality.md` ก่อนวิเคราะห์ไฟล์นี้ทุกครั้ง

วิธีตรวจว่าเป็นไฟล์นี้: มี columns ชื่อ `1st New%`, `1st New Mems`, `1st New (BIn)`, `1st Day Mems`

**การคำนวณ Derived Metric ที่สำคัญที่สุด:**
```
Delayed 1st Deposit = 1st Day Mems - 1st New Mems
```
นี่คือจำนวนคนที่สมัครไว้ก่อนหน้านี้แล้วมาฝากเงินครั้งแรกวันนี้ — **ต้องแสดงในรายงานเสมอ**

**การแสดงผล:**
- Verify%, 1st New%, 1st New (np%), 1st Day (np%) — ใช้คอลัมน์ `_pct` ที่ระบบแปลงมาให้แล้ว
  (`Verify%_pct` ฯลฯ) ห้ามคูณ 100 เอง — ดูหัวข้อ "การแสดงผล %"
- 1st New (BIn), 1st Day (BIn) — เป็นจำนวนเงิน ให้ใช้ `1st New (BIn)_THB` และ
  `1st Day (BIn)_THB` ที่ระบบแปลงมาให้แล้ว (ดูหัวข้อ "หน่วยเงินและการแสดงผล")

**KPI หลักที่ต้องวิเคราะห์** (ตัวเลข benchmark แยกตามเว็บ — **ห้ามใช้ตัวเลขตายตัวชุดเดียวข้ามเว็บ** ดู percentile จริงของแต่ละเว็บใน `references/new-member-quality.md`):
- 1st New% — คุณภาพ
 traffic
- 1st New (np%) — คุณภาพ
 member
- Verify% — ปัญหา onboarding ขั้นต้น
- Delayed Depositors — pool ของ member ที่ค้างในระบบ convert ช้า

ดูรายละเอียด benchmarks, Python code, และโครงสร้างรายงาน HTML ใน `references/new-member-quality.md`



---

#### 📊 Deposit Count Distribution Report ("Daily (Count)")

อ่าน `references/deposit-count-distribution.md` ก่อนวิเคราะห์ไฟล์นี้ทุกครั้ง

vid ตรวจว่าเป็นไฟล์นี้: มี columns ชื่อ `1 Time`, `2~5 Counts`, `6~10 Counts`, `11~20 Counts`, `21+ Counts`

**ความหมายหลัก**: แต่ละ column = จำนวน member ที่ฝากเงินในช่วงครั้งนั้นต่อวัน
- 1 Time + 2~5 + 6~10 + 11~20 + 21+ = BIn Mems รวมเสมอ

**Derived Metrics ที่ต้องคำนวณ:**
```
Power User Index = (11~20 + 21+) / BIn Mems × 100  # benchmark: ~56%
Casual Rate      = 1 Time / BIn Mems × 100          # benchmark: ~21%
```

**KPI หลักที่ต้องวิเคราะหํ:**
- 21+ Counts% — กลุ่ม loyal core player (benchmark: >47% = ดี)
- 1 Time% — กลุ่ม casual/new player (benchmark: <25%)
- Power User Index — ถ้าสูงขึ้น = ฐาน loyal แข็งแกร่งขึ้น

**Insight สำคัญ (Mar–Apr 2026):** 21+ กลุ่มใหญ่ที่สุด (~47% ของ BIn Mems) — หมายความว่า core revenue มาจาก power user เกือบครึ่งหนึ่ง

ดูรายละเอียด benchmarks, Python code, และโครงสร้างรายงาน HTML ใน `references/deposit-count-distribution.md`



---

#### 🎮 Brand Value by Game Kind Report ("Brand Value (Last 6 Months)")

อ่าน `references/brand-game-value.md` ก่อนวิเคราะห์ไฟล์นี้ทุกครั้ง

วิธีตรวจว่าเป็นไฟล์นี้: มี column `GameKind` และ rows เป็นชื่อเกม เช่น SLOT, FISH, CASINO, SPORT

**ข้อมูลนี้เป็น aggregated 6 เดือน — ไม่ใช่รายวัน**

**Flags ที่ต้องตรวจทันที:**
- RTP > 100% = casino ขาดทุนจาก game type นั้น (ARCADE, LOTTO ในข้อมูลปัจจุบัน)
- LOTTO RTP = 480% 🚨 — ขาดทุนหนักมาก
- ARCADE RTP = 100.5% ⚠️ — ขาดทุนเล็กน้อย

**Market Share หลัก (Benchmark จริง):**
- SLOT: 92.3% CIn, 90.6% DAU — เกมหลักที่สุด
- FISH: 4.1% CIn — อันดับ 2 แต่พึ่งโปรมากที่สุด (CIn np% 64%)
- CASINO/GAMES/SPORT: รวมกัน <4% CIn

**Derived Metrics ที่ต้องคำนวณ:**
```
Nw Margin% = Nw / CIn × 100   # กำไรต่อยอดเดิมพัน ต่อ game type
CIn per Count = CIn / Counts   # ยอดเดิมพันเฉลี่ยต่อ round
```

ดูรายละเอียด market share, alerts, Python code ใน `references/brand-game-value.md`



---

#### 👑 VIP Member Report ("Vip.xlsx")

อ่าน `references/vip-members.md` ก่อนวิเคราะห์ไฟล์นี้ทุกครั้ง

วิธีตรวจว่าเป็นไฟล์นี้: มี columns `Last BIn 2 Y`, `BIn Counts`, `BIn Days`, `Med. BIn`, `Phone`

**VIP Rules (ต้องผ่านอย่างน้อย 1 ข้อ):**
```
BIn >= 50  OR  BIn Counts >= 100  OR  BIn Days >= 50
Lost = Last BIn 2 Y > 7 วัน
```

**Derived Status ที่ต้องคำนวณก่อนวิเคราะห์:**
```python
df['is_Active'] = df['Last BIn 2 Y'] <= 7
df['is_Lost']   = df['Last BIn 2 Y'] > 7
```

**KPI หลักที่ต้องรายงาน:**
- Active VIP% (benchmark: 60.1%) — ถ้า <55% = ต้องทำ re-engagement ด่วน
- Lost VIP list เรียงตาม BIn DESC — ใช้สำหรับทีม CRM โทรหา (มี Phone)
- Revenue per VIP — ใครสร้าง revenue มากที่สุด

**สำคัญ:** Med. BIn = Median Billing คือค่ากลางยอดฝากต่อ 1 ครั้ง, Last BIn 2 Y = นับวันย้อนจาก "เมื่อวาน" (0 = ฝากเมื่อวาน) — Big Bettor คือ Med. BIn >= 10 (เทียบกับ**คอลัมน์ดิบ** เพราะเกณฑ์นิยามบนสเกลของ Power BI แต่เวลารายงานตัวเงินให้ใช้ `Med. BIn_THB`)

ดูรายละเอียด benchmarks, Lost VIP stats, Agent analysis ใน `references/vip-members.md`


---

#### 📱 Marketing Ads Data

**คำนวณเพิ่มเติม:**
- CPL / CPA = งบ / จำนวน leads หรือ สมาชิกใหม่ที่เดิมพัน
- Reach efficiency = Leads / Reach × 100
- เปรียบเทียบ channels: Facebook vs TikTok vs Telegram vs Banner

**เชื่อมกับ Casino data (ถ้ามีทั้งคู่):**
- วันที่ยิงโฆษณา → New Mems เพิ่มไหม?
- งบโฆษณา → CPA = งบ / BIn Mems ใหม่

---

#### 📊 ข้อมูลทั่วไป (ยอดขาย, ธุรกิจ)
- Growth rate, top/bottom performers
