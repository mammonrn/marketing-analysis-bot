# Deposit Count Distribution Report Reference
## ไฟล์: "Daily (Count)"
## ใช้กับ shwe666 / ubet89 / 88fed

---

## คำอธิบาย Columns ทั้งหมด

| Column | คำอธิบายภาษาไทย |
|--------|-----------------|
| **Date** | วันที่ (รายวัน หรือ drill down เป็นรายเดือน) |
| **BIn Mems** | จำนวน member ทั้งหมดที่ฝากเงินในวันนั้น — เป็นยอดรวมของทุก group ด้านล่าง |
| **1 Time** | member ที่ฝากเงินเพียง 1 ครั้งในวันนั้น (Casual players) |
| **2~5 Counts** | member ที่ฝากเงิน 2–5 ครั้งในวันนั้น (Moderate players) |
| **6~10 Counts** | member ที่ฝากเงิน 6–10 ครั้งในวันนั้น (Active players) |
| **11~20 Counts** | member ที่ฝากเงิน 11–20 ครั้งในวันนั้น (Very active players) |
| **21+ Counts** | member ที่ฝากเงิน 21 ครั้งขึ้นไปในวันนั้น (Power users / High-frequency players) |

**สำคัญ**: 1 Time + 2~5 + 6~10 + 11~20 + 21+ = BIn Mems เสมอ (ยืนยันแล้ว)

---

## Segment ความหมายและการแปลความ

| Segment | ความหมาย | Signal |
|---------|----------|--------|
| **1 Time** | เล่นครั้งเดียวแล้วหยุด — อาจเป็น new player, casual, หรือ player ที่กำลัง churn | % สูง = new player มาก หรือ retention ต่ำ |
| **2~5 Counts** | เล่นปกติ — กลุ่ม casual-regular | — |
| **6~10 Counts** | เล่นบ่อย — กลุ่ม regular player | — |
| **11~20 Counts** | เล่นถี่มาก — กลุ่ม loyal player | — |
| **21+ Counts** | เล่นถี่สูงมาก (Power users) — เป็น core revenue driver ของ casino | % สูง = ฐานลูกค้า loyal แข็งแกร่ง |

---

## การคำนวณ Derived Metrics

```python
df['1time_pct']    = df['1 Time']       / df['BIn Mems'] * 100
df['2to5_pct']     = df['2~5 Counts']   / df['BIn Mems'] * 100
df['6to10_pct']    = df['6~10 Counts']  / df['BIn Mems'] * 100
df['11to20_pct']   = df['11~20 Counts'] / df['BIn Mems'] * 100
df['21plus_pct']   = df['21+ Counts']   / df['BIn Mems'] * 100

# Power User Index (ยิ่งสูง = ฐาน loyal สูง)
df['power_user_pct'] = (df['11~20 Counts'] + df['21+ Counts']) / df['BIn Mems'] * 100

# Casual Player Index (ยิ่งสูง = มี new/casual player มาก)
df['casual_pct'] = df['1 Time'] / df['BIn Mems'] * 100
```

---

## KPI Benchmarks (อ้างอิงจากข้อมูล Mar–Apr 2026)

| Segment | ค่าเฉลี่ย/วัน | % ของ BIn Mems | หมายเหตุ |
|---------|--------------|---------------|---------|
| BIn Mems รวม | ~403 คน | 100% | |
| 1 Time | ~86 คน | **20.9%** | ถ้า > 25% = new player surge หรือ retention ต่ำ |
| 2~5 Counts | ~62 คน | **15.1%** | | 
| 6~10 Counts | ~31 คน | **7.7%** | |
| 11~20 Counts | ~37 คน | **9.0%** | |
| 21+ Counts | **~188 คน** | **47.2%** | กลุ่ม power user ใหญ่มาก — core revenue |

**Key Pattern**: 21+ Counts เป็น ~47% ของ BIn Mems ทั้งหมด — หมายความว่าเกือบครึ่งหนึ่งของคนที่ฝากเงินในแต่ละวันเป็น power user ที่ฝากถี่มาก

---

## เปรียบเทียบ Mar vs Apr 2026

| Metric | มีนาคม 2026 | เมษายน 2026* | การเปลี่ยนแปลง |
|--------|------------|-------------|--------------|
| BIn Mems | 432 | 367 | -15% |
| 1 Time | 102 (23.3%) | 66 (17.9%) | -35% (casual ลดมาก) |
| 2~5 Counts | 70 (16.2%) | 50 (13.8%) | -29% |
| 6~10 Counts | 36 (8.3%) | 26 (7.1%) | -28% |
| 11~20 Counts | 40 (9.3%) | 32 (8.7%) | -20% |
| 21+ Counts | 184 (42.8%) | 192 (52.5%) | +4% (เพิ่มขึ้น!) |

*เมษายนบางส่วน (ถึง 25 เม.ย.)

**Insight สำคัญ**:
- เมษายน BIn Mems โดยรวมลด -15%
- แต่ 21+ Counts เพิ่มขึ้น (จาก 42.8% → 52.5%) — กลุ่ม power user ยังคงเล่นและเพิ่มขึ้น
- Casual players (1 Time) ลดมากที่สุด (-35%) — new member convert น้อยลง
- สรุป: ฐาน loyal player แข็งแกร่ง แต่ขาด new casual player เข้ามาเสริม

---

## วิธีวิเคราะห์ Deposit Count Distribution

### A. Health Check ของฐานลูกค้า
- 21+% สูง (>45%) = ฐาน loyal player แข็งแกร่ง — ดีมาก
- 1 Time% สูง (>25%) = มี casual/new player เข้ามามาก — ต้องดู retention
- ถ้า 21+% เพิ่มแต่ BIn Mems รวมลด = กลุ่ม casual หายไป แต่ core ยังอยู่

### B. เปรียบเทียบกับ New Member Quality Report
- เชื่อมกับ `references/new-member-quality.md`:
  - 1st New Mems (new member ฝากวันแรก) → น่าจะตกอยู่ใน "1 Time" segment
  - ถ้า 1st New Mems มาก แต่ 1 Time% สูงมาก = new player เล่นครั้งเดียวแล้วหยุด (retention ปัญหา)

### C. Trend Analysis
- ถ้า 21+% ค่อยๆ เพิ่มขึ้น = ฐาน loyal player โตขึ้น (ดี)
- ถ้า 1 Time% ค่อยๆ เพิ่มขึ้น = new player เข้ามาแต่ไม่ return (ต้องตรวจ onboarding)
- วันไหน BIn Mems ลดฮวบ แต่ 21+ ยังสูง = casualลดแต่ core ไม่กระทบ (ไม่น่าเป็นห่วงมาก)

### D. Power User Analysis
- Power User Index = (11~20 + 21+) / BIn Mems × 100
- Benchmark: ~56% (เมษายน 2026: 61.2%)
- ถ้า Power User Index สูง = casino พึ่งพา core player มาก — ต้องระวัง churn ของกลุ่มนี้

---

## โครงสร้างรายงาน HTML สำหรับ Deposit Count Distribution

```
1. Header         — ชื่อเว็บ | ช่วงเวลา | วันที่สร้าง
2. KPI Cards       — BIn Mems เฉลี่ย, 21+ Counts เฉลี่ย, 21+%, 1 Time%
3. Stacked Bar Chart — สัดส่วน segment รายวัน (5 สี ตาม segment)
4. เปรียบเทียบเดือน — ตาราง % ของแต่ละ segment MoM พร้อม % change
5. Trend: 21+ Counts — กราฟ trend จำนวน power user รายวัน
6. Trend: 1 Time% — กราฟ trend casual player % (retention signal)
7. Key Insights   — 5-7 ข้อวิเคราะห์ + คำแนะนำ
```

---

## Python Code สำหรับโหลดและแปลงข้อมูล

```python
import pandas as pd

df = pd.read_excel("Daily (Count).xlsx")

# ลบแถว footer/filter notes
df = df[df['Date'].apply(lambda x: hasattr(x, 'year') and not isinstance(x, float))].copy()
df = df[df['BIn Mems'].notna()].copy()

# Derived % metrics
df['1time_pct']     = df['1 Time']       / df['BIn Mems'] * 100
df['2to5_pct']      = df['2~5 Counts']   / df['BIn Mems'] * 100
df['6to10_pct']     = df['6~10 Counts']  / df['BIn Mems'] * 100
df['11to20_pct']    = df['11~20 Counts'] / df['BIn Mems'] * 100
df['21plus_pct']    = df['21+ Counts']   / df['BIn Mems'] * 100
df['power_user_pct'] = (df['11~20 Counts'] + df['21+ Counts']) / df['BIn Mems'] * 100
```
