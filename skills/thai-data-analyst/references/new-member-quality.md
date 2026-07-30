# New Member Quality Report Reference
## ไฟล์: "Daily (1st New & 1st) (Click drilldown icon can get monthly)"
## ใช้กับ shwe666 / ubet89 / 88fed

---

## คำอธิบาย Columns ทั้งหมด

| Column | ชื่อเต็ม | คำอธิบายภาษาไทย |
|--------|----------|-----------------|
| **Date** | Date | วันที่ (รายวัน หรือ drill down เป็นรายเดือนได้) |
| **New** | New Members | สมาชิกใหม่ที่สมัครทั้งหมดในวันนั้น |
| **New (Ref.)** | New Members (Referral) | สมาชิกใหม่ที่มาจากการชวนเพื่อน (Referral/Invite) — เพื่อนที่ชวนจะได้รางวัล/โบนัสเป็นการตอบแทน |
| **Verify** | Verified Members | จำนวน member ที่ผ่านการยืนยันตัวตนแล้ว |
| **Verify%** | Verification Rate | % ของ New ที่ผ่านการยืนยันตัวตน — ค่าจาก Power BI เป็น decimal ต้องคูณ 100 ก่อนแสดง |
| **1st New%** | 1st Deposit Same-Day Rate | % ของ New ที่สมัครแล้วฝากเงินเล่นในวันเดียวกันกับที่สมัคร — ยิ่งสูงยิ่งดี แสดงถึงคุณภาพ traffic |
| **1st New Mems** | 1st Deposit Same-Day Members | จำนวนจริงของ member ที่สมัครแล้วฝากเงินเล่นในวันเดียวกัน |
| **1st New (BIn)** | 1st New Billing In | ยอดเงินฝากรวมของ 1st New Mems — หน่วยเป็น MMK (ตัด 3 ศูนย์) ต้องแปลงเป็น THB ก่อนแสดงในรายงาน |
| **1st New (np%)** | 1st New No-Promo Rate | % ของ 1st New Mems ที่ฝากเงินโดยไม่รับโปรโมชั่น — ยิ่งสูงแสดงว่า member มีคุณภาพสูง ไม่ได้มาเพื่อล่าโปร |
| **1st Day Mems** | 1st Day Deposit Members | จำนวน member ทั้งหมดที่ฝากเงินเป็นครั้งแรกในวันนั้น (ไม่ว่าจะสมัครวันไหน) |
| **1st Day (BIn)** | 1st Day Billing In | ยอดเงินฝากรวมของ 1st Day Mems — หน่วยเป็น MMK (ตัด 3 ศูนย์) ต้องแปลงเป็น THB |
| **1st Day (np%)** | 1st Day No-Promo Rate | % ของ 1st Day Mems ที่ฝากเงินโดยไม่รับโปรโมชั่น |

---

## การแปลงค่าเงิน (แตกต่างตามเว็บไซต์!)

| เว็บ | สกุลเงิน | สูตร |
|------|---------|------|
| **shwe666** | MMK (พม่า) | `ค่าในไฟล์ × 1,000 × 0.787` |
| **ubet89** | THB (ไทย) | `ค่าในไฟล์ × 1,000` |
| **88fed** | THB (ไทย) | `ค่าในไฟล์ × 1,000` |

ตัวอย่าง (shwe666 / MMK):
- ไฟล์แสดง 1st New (BIn) = 8.98 → 8,980 MMK → ฿7,067
- ไฟล์แสดง 1st Day (BIn) = 10.9 → 10,900 MMK → ฿8,578

ตัวอย่าง (ubet89 / 88fed / THB):
- ไฟล์แสดง 1st New (BIn) = 8.98 → ฿8,980 (ไม่ต้องแปลง)

---

## การแสดงผล % (สำคัญ!)

ค่าต่อไปนี้จาก Power BI เป็น decimal ต้องคูณ 100 ก่อนแสดงเสมอ:

| Column | ค่าในไฟล์ | แสดงเป็น |
|--------|-----------|---------|
| Verify% | 0.7193 | 71.9% |
| 1st New% | 0.0982 | 9.8% |
| 1st New (np%) | 0.9321 | 93.2% |
| 1st Day (np%) | 0.8908 | 89.1% |

---

## การคำนวณที่สำคัญ (ต้องทำทุกครั้ง)

### Delayed First Depositors (สมาชิกที่สมัครแล้วค่อยมาฝากทีหลัง)

```
Delayed 1st Deposit = 1st Day Mems - 1st New Mems
```

ความหมาย:
- 1st New Mems = สมัครวันนี้ + ฝากวันนี้ (same-day conversion)
- 1st Day Mems = ฝากเงินเป็นครั้งแรกวันนี้ (อาจสมัครมาก่อนหน้าหลายวัน)
- ส่วนต่าง (Delayed) = คนที่สมัครไว้ก่อนหน้านี้ แล้วมาฝากเงินครั้งแรกในวันนี้

การวิเคราะห์:
- Delayed Depositors มาก = มี member ค้างในระบบที่ยังไม่ convert จำนวนมาก
- วันที่ Delayed สูงผิดปกติ = น่าจะมีแคมเปญ re-engagement หรือ push notification กระตุ้น

### Referral Rate

```
Ref. Rate = New (Ref.) / New × 100
```
- Benchmark: ~1.5-2% (ถ้าสูงกว่า = โปรชวนเพื่อนได้ผลดี)

### BIn per Member (คุณภาพเงินฝากต่อคน)

```
BIn per 1st New Mem = 1st New (BIn) THB / 1st New Mems
BIn per 1st Day Mem = 1st Day (BIn) THB / 1st Day Mems
```
- ถ้า BIn per Member สูงขึ้น = แต่ละคนฝากเงินมากขึ้น (คุณภาพ member ดีขึ้น)

---

## KPI Benchmarks — คำนวณจากข้อมูลจริงทั้งปี 2026 (210 วัน, 1 ม.ค. – 29 ก.ค.)

> ⚠️ **แยก benchmark ตามเว็บ — อย่าใช้ปนกัน** เพราะ SH666 กับ U89 มีคุณภาพ traffic ต่างกันชัดเจนคนละทิศทาง

| KPI | SH666 (เฉลี่ย/median) | U89 (เฉลี่ย/median) |
|-----|------------------------|----------------------|
| Verify% | 74.8% / 75% | 66.0% / 66% |
| 1st New% | 11.0% / 11% | 18.4% / 18% |
| 1st New (np%) | 85.2% / 87% | 91.7% / 95% |
| Delayed Depositors ต่อวัน | ~32 คน | ~7 คน |

**ข้อสังเกตสำคัญ**: ตัวเลขสวนทางกับที่คาดไว้ตอนแรก —
- **SH666 verify ดีกว่า** (75% vs 66%) แต่ **1st New% ต่ำกว่า** (11% vs 18%) — คนสมัครผ่าน verify เยอะ แต่เปลี่ยนเป็นคนฝากเงินวันแรกได้น้อยกว่า
- **U89 มี 1st New(np%) สูงกว่ามาก** (91.7% vs 85.2%) — ลูกค้าใหม่ของ U89 ที่ฝากเงินวันแรก ส่วนใหญ่ไม่พึ่งโปรโมชั่น สะท้อนฐานลูกค้าที่มี intent ชัดเจนกว่า (เว็บเก่า มีคนรู้จักแบรนด์อยู่แล้วมาสมัครเอง)
- **SH666 มี Delayed Depositors สูงกว่า U89 ถึง 4.5 เท่า** (32 vs 7 คน/วัน) — มีคนสมัครไว้ก่อนแล้วมาฝากทีหลังเยอะกว่ามาก อาจเป็นเป้าหมายที่ดีสำหรับแคมเปญกระตุ้นให้ฝากเงิน (reactivation)

**เกณฑ์ใช้งาน (ใช้ percentile ของแต่ละเว็บเป็นหลัก แทนตัวเลขตายตัว)**:
- ดี: สูงกว่า median ของเว็บนั้นๆ ต่อเนื่องหลายวัน
- เตือน: ต่ำกว่า median ต่อเนื่อง 3+ วัน — ควรเช็คว่าช่องทางโฆษณาหรือ landing page มีปัญหาไหม
| New (Ref.) ต่อวัน | ~13.5 คน | — | < 8 (โปร referral อ่อนแอ) |

---

## เปรียบเทียบเดือนต่อเดือน (Mar vs Apr 2026)

| Metric | มีนาคม 2026 | เมษายน 2026* |
|--------|------------|-------------|
| Avg New | 773 | 680 |
| Avg 1st New% | 10.3% | 8.1% |
| Avg 1st New Mems | 80 | 53 |
| Avg 1st Day Mems | 127 | 85 |
| Avg 1st New (BIn) | ฿9,764 | ฿5,548 |
| Avg 1st New (np%) | 78.4% | 85.7% |

*เมษายนเป็นข้อมูลบางส่วน (ถึง 25 เม.ย.)

Insight หลัก: เมษายน 2026 New Members ลดลง ~12% และ same-day conversion (1st New%) ลดจาก 10.3% เป็น 8.1% แต่คุณภาพ member ดีขึ้น (1st New (np%) เพิ่มจาก 78.4% เป็น 85.7% — member ที่มาฝากเงินส่วนใหญ่ไม่ต้องการโปร)

---

## วิธีวิเคราะห์ New Member Quality Report

### A. Traffic Quality Analysis
- 1st New% สูง = traffic คุณภาพดี คนสมัครแล้วอยากเล่นจริง
- 1st New (np%) สูง = member ไม่ได้มาเพราะโปร เป็นฐานลูกค้าที่แข็งแกร่ง
- Verify% ต่ำ = ปัญหาที่ funnel ขั้นต้น (คนสมัครแล้วไม่ยืนยันตัวตน)
- เปรียบเทียบ Verify% กับ 1st New% — ถ้า Verify สูงแต่ 1st New ต่ำ = มีปัญหา onboarding หรือ UX หลัง verify

### B. Conversion Funnel
```
New → Verify → 1st New Mems → 1st Day Mems
```
วิเคราะห์ drop-off แต่ละขั้น:
- New → Verify: คนที่ไม่ยืนยันตัวตน
- Verify → 1st New Mems: คนที่ verify แล้วแต่ไม่ฝากวันเดียวกัน (อาจมาฝากทีหลัง)
- 1st New Mems vs 1st Day Mems: Delayed depositors (มาจาก pool สมาชิกเก่า)

### C. Delayed Depositor Analysis
- 1st Day Mems - 1st New Mems = จำนวนคนที่สมัครก่อนหน้านี้มาฝากครั้งแรกวันนี้
- ถ้าค่านี้สูง = มีฐาน member ที่ convert ช้า ควรทำ re-engagement campaign

### D. Monthly Quality Trend
- ติดตาม 1st New% และ 1st New (np%) เป็นรายเดือน
- ถ้า 1st New% ลด = traffic คุณภาพลดลง หรือ onboarding มีปัญหา
- ถ้า 1st New (np%) เพิ่ม = member ที่ได้มามีคุณภาพดีขึ้น

---

## โครงสร้างรายงาน HTML สำหรับ New Member Quality

```
1. Header         — ชื่อเว็บ | ช่วงเวลา | วันที่สร้าง | อัตราแปลง MMK→THB
2. Alert Banner    — วัน 1st New% ต่ำกว่า 7%, วัน BIn ต่ำผิดปกติ
3. KPI Cards       — New รวม, 1st New Mems รวม, 1st New% เฉลี่ย,
                     Verify% เฉลี่ย, 1st New (BIn) รวม (THB), 1st New (np%) เฉลี่ย
4. Conversion Funnel — New → Verify → 1st New Mems (แสดงเป็น % drop-off แต่ละขั้น)
5. เปรียบเทียบเดือน — ตาราง KPI เปรียบเทียบ MoM พร้อม % change
6. Daily Trend     — กราฟ trend: New, 1st New%, 1st New Mems รายวัน
7. Delayed Depositors — กราฟ: 1st Day Mems vs 1st New Mems (แสดงส่วนต่าง Delayed)
8. Quality Metrics — BIn per member, np% trend (คุณภาพ member)
9. Referral Analysis — New (Ref.) trend, Referral Rate % รายวัน
10. Key Insights   — 6-8 ข้อวิเคราะห์ + คำแนะนำ
```

---

## Python Code สำหรับโหลดและแปลงข้อมูล

```python
import pandas as pd

df = pd.read_excel("Daily (1st New & 1st)  (Click drilldown icon can get monthly).xlsx")

# ลบแถว footer/filter notes (แถวสุดท้ายมี filter description)
df = df[df['Date'].apply(lambda x: hasattr(x, 'year') and not isinstance(x, float))].copy()
df = df[df['New'].notna()].copy()

# แปลง % columns (decimal → %)
pct_cols = ['Verify%', '1st New%', '1st New (np%)', '1st Day (np%)']
for col in pct_cols:
    if col in df.columns:
        df[col] = df[col] * 100

# แปลงเงิน MMK → THB (ตัด 3 ศูนย์ แล้ว × 0.787)
# shwe666: FACTOR = 1000 * 0.787 | ubet89/88fed: FACTOR = 1000
FACTOR = 1000 * 0.787  # ปรับตามเว็บที่วิเคราะห์
df['1st New (BIn) THB'] = df['1st New (BIn)'] * FACTOR
df['1st Day (BIn) THB'] = df['1st Day (BIn)'] * FACTOR

# Derived metrics
df['Delayed 1st Deposit'] = df['1st Day Mems'] - df['1st New Mems']
df['Ref. Rate%'] = df['New (Ref.)'] / df['New'] * 100
df['BIn per 1st New Mem THB'] = df['1st New (BIn) THB'] / df['1st New Mems']
df['BIn per 1st Day Mem THB'] = df['1st Day (BIn) THB'] / df['1st Day Mems']
```
