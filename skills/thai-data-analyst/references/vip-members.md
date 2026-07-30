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
| **BIn** | ยอดเงินฝากรวมทั้งหมด (MMK ตัด 3 ศูนย์) — **ใช้ตรวจ VIP** | MMK |
| **BIn Counts** | จำนวนครั้งที่ฝากเงินทั้งหมด — **ใช้ตรวจ VIP** | ครั้ง |
| **BIn Days** | จำนวนวันที่มีการฝากเงิน (ไม่ซ้ำกัน) — **ใช้ตรวจ VIP** | วัน |
| **Bo** | ยอดที่ casino จ่ายออก (Bet Out / Winnings) | MMK |
| **R** | Revenue จาก member คนนี้ (BIn - Bo - Bonus - Pro - Pass) | MMK |
| **Pro Counts** | จำนวนครั้งที่รับโปรโมชั่น | ครั้ง |
| **Pro** | ยอดโปรโมชั่นที่ได้รับรวม | MMK |
| **Pass** | ยอด Passive/Cashback ที่ได้รับ | MMK |
| **Bonus** | ยอด Bonus ที่ได้รับรวม | MMK |
| **Med. BIn** | Median Billing — ค่ากลางของยอดฝากเงินต่อ 1 ครั้ง ของ member คนนั้น — ใช้วัดขนาดการฝากปกติ เช่น Med. BIn = 1.5 แปลว่าปกติฝากครั้งละ 1,500 MMK (฿1,181) | MMK |
| **Phone** | เบอร์โทรศัพท์ (สำหรับติดต่อ) | — |

---

## การแปลงค่าเงิน (แตกต่างตามเว็บไซต์!)

| เว็บ | สกุลเงิน | สูตร |
|------|---------|------|
| **shwe666** | MMK (พม่า) | `ค่าในไฟล์ × 1,000 × 0.787` |
| **ubet89** | THB (ไทย) | `ค่าในไฟล์ × 1,000` |
| **88fed** | THB (ไทย) | `ค่าในไฟล์ × 1,000` |

**ตัวอย่าง shwe666 (MMK):**
- BIn = 926.6 → 926,600 MMK → ฿729,034
- Med. BIn = 18 → 18,000 MMK → ฿14,166 ต่อครั้ง (high roller)

**ตัวอย่าง ubet89 / 88fed (THB):**
- BIn = 926.6 → ฿926,600 (ไม่ต้องแปลง)
- Med. BIn = 18 → ฿18,000 ต่อครั้ง

---

## การตรวจสอบ VIP Status (Python)

```python
import pandas as pd

df = pd.read_excel("Vip.xlsx")
df = df[df['Username'].notna()].copy()
df = df[~df['Username'].astype(str).str.contains('Applied|filter', case=False, na=False)].copy()

# VIP qualification check
df['qual_BIn']    = df['BIn'] >= 50          # ฝากรวม >= 50 units MMK
df['qual_Counts'] = df['BIn Counts'] >= 100  # ฝาก >= 100 ครั้ง
df['qual_Days']   = df['BIn Days'] >= 50     # ฝาก >= 50 วัน

# Status
df['is_Lost']   = df['Last BIn 2 Y'] > 7    # ไม่ได้ฝากนาน > 7 วัน
df['is_Active'] = df['Last BIn 2 Y'] <= 7   # ฝากล่าสุดภายใน 7 วัน

# Convert money
# shwe666: FACTOR = 1000 * 0.787 | ubet89/88fed: FACTOR = 1000
FACTOR = 1000 * 0.787  # ปรับตามเว็บที่วิเคราะห์
for col in ['BIn', 'Bo', 'R', 'Pro', 'Pass', 'Bonus', 'Med. BIn']:
    df[col + '_THB'] = df[col] * FACTOR

# Revenue per BIn day (loyalty efficiency)
df['R_per_BInDay'] = df['R'] / df['BIn Days']
```

---

## KPI Benchmarks (อ้างอิงจากข้อมูลจริง 318 VIP members)

| KPI | ค่าเฉลี่ย | หมายเหตุ |
|-----|-----------|---------|
| **VIP ทั้งหมด** | 318 คน | — |
| **Active VIP** (Last BIn ≤7 วัน) | **191 คน (60.1%)** | — |
| **Lost VIP** (Last BIn >7 วัน) | **127 คน (39.9%)** | นานเฉลี่ย 48 วัน |
| BIn เฉลี่ย | ฿28,961 ต่อคน | — |
| BIn Counts เฉลี่ย | 244 ครั้ง | — |
| BIn Days เฉลี่ย | 57 วัน | — |
| Revenue เฉลี่ย | ฿5,324 ต่อคน | — |
| Med. BIn (median) | ฿114 ต่อครั้ง | 75% < ฿287, Max ฿14,166 |
| **BIn รวมทั้งกลุ่ม** | **฿9,209,474** | 6 เดือน+ |
| **Revenue รวมทั้งกลุ่ม** | **฿1,693,129** | |

### Lost VIP Stats (ควรทำ re-engagement)

| KPI | ค่าเฉลี่ย |
|-----|-----------|
| วันที่หายไป (Last BIn) | 48 วัน |
| BIn เฉลี่ย | ฿22,231 |
| BIn Counts เฉลี่ย | 198 ครั้ง |
| Revenue เฉลี่ย | ฿3,892 |

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
Big Bettor = Med. BIn >= 10 (Median Billing ≥ 10 units = ฝากครั้งละ ≥ 7,870 THB)
```

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
