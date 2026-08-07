# VIP Member Report Reference
## ไฟล์: "Vip.xlsx"
## ใช้กับ shwe666 / ubet89 / 88fed

---

## เงื่อนไข VIP (Rules)

```
[ VIP ]  BIn >= 50  OR  BIn Times (BIn Counts) >= 100  OR  BIn Days >= 50
         ถ้าผ่านเงื่อนไขใดเงื่อนไขหนึ่ง = เป็น VIP

[ Lost ] Last BIn 2 Yesterday > 7 days
         ถ้าไม่ได้ฝากเงินมานานกว่า 7 วัน = VIP ที่หายไปแล้ว (Lost VIP)
```

---

## คำอธิบาย Columns ทั้งหมด

| Column | คำอธิบายภาษาไทย | หน่วย |
|--------|-----------------|-------|
| **Username** | ชื่อบัญชีของ member | — |
| **Real Name** | ชื่อจริง | — |
| **RegDate** | วันที่สมัครสมาชิก | datetime |
| **Lv** | Level (ปัจจุบัน = ว่างทั้งหมด) | — |
| **Referrer** | ผู้ชวน (Referral) | — |
| **AD** | แหล่งโฆษณา/traffic source | — |
| **Agent** | Agent หรือช่องทางที่ member มาจาก | — |
| **Last Login 2 Y** | Last Login to Yesterday — จำนวนวันที่ห่างจาก "เมื่อวาน" ถึงวัน login ล่าสุด เช่น = 0 คือ login เมื่อวาน, = 5 คือ login เมื่อ 5 วันก่อนเมื่อวาน | วัน |
| **Last BIn 2 Y** | Last Billing to Yesterday — จำนวนวันที่ห่างจาก "เมื่อวาน" ถึงวันที่ฝากล่าสุด เช่น = 0 คือฝากเมื่อวาน, = 3 คือฝากเมื่อ 3 วันก่อนเมื่อวาน — **ใช้ตรวจ Lost** | วัน |
| **BIn** | ยอดเงินฝากรวมทั้งหมด — **ใช้ตรวจ VIP (เทียบค่าดิบ)** | เงิน → ใช้ `BIn_THB` |
| **BIn Counts** | จำนวนครั้งที่ฝากเงินทั้งหมด — **ใช้ตรวจ VIP** | ครั้ง |
| **BIn Days** | จำนวนวันที่มีการฝากเงิน (ไม่ซ้ำกัน) — **ใช้ตรวจ VIP** | วัน |
| **Bo** | ยอดที่ casino จ่ายออก (Bet Out / Winnings) | เงิน → ใช้ `Bo_THB` |
| **R** | Revenue จาก member คนนี้ (BIn - Bo - Bonus - Pro - Pass) | เงิน → ใช้ `R_THB` |
| **Pro Counts** | จำนวนครั้งที่รับโปรโมชั่น | ครั้ง |
| **Pro** | ยอดโปรโมชั่นที่ได้รับรวม | เงิน → ใช้ `Pro_THB` |
| **Pass** | ยอด Passive/Cashback ที่ได้รับ | เงิน → ใช้ `Pass_THB` |
| **Bonus** | ยอด Bonus ที่ได้รับรวม | เงิน → ใช้ `Bonus_THB` |
| **Med. BIn** | Median Billing — ค่ากลางของยอดฝากเงินต่อ 1 ครั้ง ของ member คนนั้น — ใช้วัดขนาดการฝากปกติ เช่น Med. BIn = 1.5 แปลว่าปกติฝากครั้งละ 1.5 units ตามสเกลไฟล์ (ดูจำนวนเงินจริงที่ `Med. BIn_THB`) | เงิน → ใช้ `Med. BIn_THB` |
| **Phone** | เบอร์โทรศัพท์ (สำหรับติดต่อ) | — |

---

## หน่วยเงิน

> **หน่วยเงิน:** ข้อมูลที่ส่งมาถูกแปลงเป็นเงินบาทแล้วในคอลัมน์ที่ลงท้าย `_THB`
> ให้อ้างอิงคอลัมน์เหล่านั้นเมื่อพูดถึงจำนวนเงิน ห้ามคำนวณแปลงค่าเงินเอง
> (ดูรายละเอียดใน SKILL.md หัวข้อ "หน่วยเงินและการแสดงผล")

คอลัมน์เงินในไฟล์นี้ที่มีคู่ `_THB` ให้ใช้: `BIn_THB`, `Bo_THB`, `R_THB`,
`Pro_THB`, `Pass_THB`, `Bonus_THB`, `Med. BIn_THB`

⚠️ **ยกเว้นเกณฑ์ VIP** — `BIn >= 50` และ `Med. BIn >= 10` นิยามไว้บน**สเกลของ Power BI**
ต้องเทียบกับคอลัมน์ดิบ (`BIn`, `Med. BIn`) ต่อไป ถ้าเปลี่ยนไปเทียบกับ `_THB` เกณฑ์จะเพี้ยน
แต่เวลา**รายงานตัวเลขเงิน** ให้ใช้ `_THB` เสมอ

---

## การตรวจสอบ VIP Status (Python)

```python
import pandas as pd

df = pd.read_excel("Vip.xlsx")
df = df[df['Username'].notna()].copy()
df = df[~df['Username'].astype(str).str.contains('Applied|filter', case=False, na=False)].copy()

# VIP qualification check — เทียบกับคอลัมน์ดิบเสมอ (เกณฑ์นิยามบนสเกลของ Power BI)
df['qual_BIn']    = df['BIn'] >= 50          # ฝากรวม >= 50 units (ค่าดิบตามไฟล์)
df['qual_Counts'] = df['BIn Counts'] >= 100  # ฝาก >= 100 ครั้ง
df['qual_Days']   = df['BIn Days'] >= 50     # ฝาก >= 50 วัน

# Status
df['is_Lost']   = df['Last BIn 2 Y'] > 7    # ไม่ได้ฝากนาน > 7 วัน
df['is_Active'] = df['Last BIn 2 Y'] <= 7   # ฝากล่าสุดภายใน 7 วัน

# ไม่ต้องแปลงค่าเงิน — คอลัมน์ _THB มาพร้อมข้อมูลแล้ว

# Revenue per BIn day (loyalty efficiency) — เงินหารจำนวนวัน ผลลัพธ์เป็นเงิน
# ต้องคำนวณจาก R_THB และตั้งชื่อลงท้าย _THB
df['R_per_BInDay_THB'] = df['R_THB'] / df['BIn Days']
```

---

## KPI Benchmarks (อ้างอิงจากข้อมูลจริง SH666 318 VIP members)

> 📌 ตัวเลขเงินในตารางนี้เป็น **units ตามสเกลของไฟล์ Power BI** (ค่าดิบ) ไม่ใช่บาท
> ตั้งใจให้เป็นแบบนี้ เพราะถ้าเก็บเป็นบาทไว้ ตัวเลขจะผูกกับอัตราแลกเปลี่ยน ณ วันที่คำนวณ
> แล้วเพี้ยนทันทีที่ rate เปลี่ยน — ให้เทียบกับ**คอลัมน์ดิบ** แต่เวลารายงานตัวเงินใช้ `_THB`

| KPI | ค่าเฉลี่ย | หมายเหตุ |
|-----|-----------|---------|
| **VIP ทั้งหมด** | 318 คน | — |
| **Active VIP** (Last BIn ≤7 วัน) | **191 คน (60.1%)** | — |
| **Lost VIP** (Last BIn >7 วัน) | **127 คน (39.9%)** | นานเฉลี่ย 48 วัน |
| BIn เฉลี่ย | 36.8 units ต่อคน | เทียบเกณฑ์ VIP `BIn >= 50` ได้ตรงๆ |
| BIn Counts เฉลี่ย | 244 ครั้ง | — |
| BIn Days เฉลี่ย | 57 วัน | — |
| Revenue เฉลี่ย | 6.8 units ต่อคน | — |
| Med. BIn (median) | 0.14 units ต่อครั้ง | 75% < 0.36 units, Max 18.0 units |
| **BIn รวมทั้งกลุ่ม** | **~11,700 units** | 6 เดือน+ |
| **Revenue รวมทั้งกลุ่ม** | **~2,150 units** | |

### Lost VIP Stats (ควรทำ re-engagement)

| KPI | ค่าเฉลี่ย |
|-----|-----------|
| วันที่หายไป (Last BIn) | 48 วัน |
| BIn เฉลี่ย | 28.3 units |
| BIn Counts เฉลี่ย | 198 ครั้ง |
| Revenue เฉลี่ย | 4.9 units |

---

## Agent / Channel Breakdown (Top agents)

| Agent | จำนวน VIP |
|-------|-----------|
| Company (direct) | 116 |
| agbk10kein | 26 |
| mookbk9 | 24 |
| MMR88 | 17 |
| FbDD | 17 |
| shanbet777 | 14 |
| fbmkt | 10 |
| Shwe Entertainment | 9 |

---

## การกระจาย RegDate (วันที่สมัคร)

| เดือน | จำนวน VIP |
|-------|-----------|
| Sep 2025 | 38 |
| Oct 2025 | 56 |
| Nov 2025 | 55 |
| Dec 2025 | 73 |
| Jan 2026 | 45 |
| Feb 2026 | 30 |
| Mar 2026 | 21 |

---

## วิธีวิเคราะห์ VIP Report

### A. VIP Health Check
- Active% = Active VIP / Total VIP × 100 — benchmark: 60.1%
- ถ้า Active% ต่ำกว่า 55% = Lost VIP มากเกินไป ต้องทำ re-engagement
- ดู Last BIn 2 Y distribution: กี่วันที่ Lost VIP หายไป

### B. Revenue per VIP
- Revenue รวม / Total VIP = มูลค่าเฉลี่ยต่อ VIP
- Top VIP by R = member ที่ทำ revenue ให้มากที่สุด → ต้องดูแลเป็นพิเศษ

### C. VIP Segmentation
```
High BIn   = BIn >= 200 (top tier)
Medium BIn = BIn 50-199
High Count = BIn Counts >= 500 (active player)
Big Bettor = Med. BIn >= 10 (Median Billing ≥ 10 units)
```

⚠️ เกณฑ์ทั้ง 4 ข้อนี้นิยามบน**สเกลของ Power BI** ให้เทียบกับคอลัมน์ดิบ (`BIn`, `Med. BIn`)
ไม่ใช่ `_THB` — แต่ตอนรายงานว่ากลุ่มนี้มียอดเท่าไหร่ ให้ใช้ `BIn_THB` / `Med. BIn_THB`

### D. Lost VIP Priority
- เรียง Lost VIP ตาม BIn DESC → คนที่เคยฝากมาก = ต้องติดต่อก่อน
- Lost VIP ที่ Last BIn 2 Y = 8-14 วัน = เพิ่งหาย → โอกาส re-engage สูง
- Lost VIP ที่ Last BIn 2 Y > 30 วัน = หายนาน → ต้องใช้ incentive แรงขึ้น

### E. Agent Performance
- Agent ไหนส่ง VIP มาเยอะ?
- VIP จาก Agent ไหนมี Revenue สูงกว่า?
- Agent ไหนมี Lost VIP% สูง? (คุณภาพ traffic ต่ำ)

---

## โครงสร้างรายงาน HTML สำหรับ VIP Report

```
1. Header         — ชื่อเว็บ | วันที่สร้าง
2. Alert Banner    — Lost VIP % สูงหรือไม่ (>40% = เตือน)
3. KPI Cards       — Total VIP, Active VIP, Lost VIP, BIn รวม, Revenue รวม, Active%
4. VIP Status Pie  — Active vs Lost (แสดงสัดส่วน)
5. Lost VIP List   — ตาราง: เรียงตาม BIn DESC, แสดง Last BIn, Phone (สำหรับติดต่อ)
6. Top VIP by Revenue — Top 10 VIP สร้าง revenue สูงสุด
7. Agent Analysis  — จำนวน VIP และ Revenue เฉลี่ยต่อ Agent
8. Med. BIn Distribution — ขนาดการเดิมพัน (ดู big bettor)
9. RegDate Trend   — VIP สมัครรายเดือน
10. Key Insights   — 5-7 ข้อ + คำแนะนำ re-engagement
```
