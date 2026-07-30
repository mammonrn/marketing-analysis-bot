# Brand Value by Game Kind Reference
## ไฟล์: "Brand Value (Last 6 Months)"
## ใช้กับ shwe666 / ubet89 / 88fed

---

## คำอธิบาย Columns ทั้งหมด

| Column | คำอธิบายภาษาไทย |
|--------|-----------------|
| **GameKind** | ประเภทของเกม (SLOT, FISH, CASINO, GAMES, SPORT, ARCADE, POKER, LOTTO, PROMO) |
| **CIn** | Coin In / Turnover รวม — ยอดเดิมพันทั้งหมดของ game type นั้น (MMK ตัด 3 ศูนย์) |
| **CIn (np)%** | % ของ CIn ที่มาจาก non-promo players (decimal → คูณ 100) |
| **Nw** | Net Win — กำไรสุทธิของ casino จาก game type นั้น (MMK ตัด 3 ศูนย์) |
| **RTP** | Return to Player — % ที่จ่ายคืนให้ผู้เล่น (decimal → คูณ 100) |
| **DAU** | จำนวน unique players ที่เล่น game type นี้ (ช่วง 6 เดือน — ไม่ใช่รายวัน) |
| **DAU% (np)** | % ของ DAU ที่ไม่รับโปรโมชั่น (decimal → คูณ 100) |
| **Nw (np)** | Net Win จาก non-promo players (MMK ตัด 3 ศูนย์) |
| **Nw (p)** | Net Win จาก promo players (MMK ตัด 3 ศูนย์, อาจติดลบ) |
| **RTP (np)** | RTP เฉพาะกลุ่ม non-promo players (decimal → ×100) |
| **RTP (p)** | RTP เฉพาะกลุ่ม promo players (decimal → ×100) |
| **Counts** | จำนวน game rounds / ครั้งที่เดิมพันทั้งหมดใน 6 เดือน |

**หมายเหตุ**: ไฟล์นี้เป็น aggregated data ของ **6 เดือนล่าสุด** — ไม่ใช่รายวัน

---

## การแปลงค่าเงิน (แตกต่างตามเว็บไซต์!)

| เว็บ | สกุลเงิน | สูตร |
|------|---------|------|
| **shwe666** | MMK (พม่า) | `ค่าในไฟล์ × 1,000 × 0.787` |
| **ubet89** | THB (ไทย) | `ค่าในไฟล์ × 1,000` |
| **88fed** | THB (ไทย) | `ค่าในไฟล์ × 1,000` |

---

## ประเภทเกมและความหมาย

| GameKind | ความหมาย |
|----------|----------|
| **SLOT** | สล็อตออนไลน์ — เกมหลักของ casino |
| **FISH** | ยิงปลา (Fishing games) |
| **CASINO** | Live Casino — บาคาร่า, รูเล็ต, ไฮโล ฯลฯ |
| **GAMES** | เกมอื่นๆ (มินิเกม, เกมไพ่ ฯลฯ) |
| **SPORT** | แทงบอล / กีฬา (Sports betting) |
| **ARCADE** | Arcade games |
| **POKER** | โป๊กเกอร์ |
| **LOTTO** | หวย / Lottery |
| **PROMO** | ส่วนที่มาจากโปรโมชั่น (CIn = 0, ไม่นับใน market share) |

---

## Market Share (ข้อมูล 6 เดือนล่าสุด — Benchmark จริง)

| GameKind | CIn Share | DAU Share | Count Share | RTP | CIn_np% |
|----------|-----------|-----------|-------------|-----|---------|
| **SLOT** | **92.3%** | **90.6%** | **94.6%** | 96.1% | 85.8% |
| **FISH** | 4.1% | 6.4% | 5.2% | 96.3% | 64.2% |
| **CASINO** | 1.5% | 1.0% | 0.02% | 95.2% | 99.1% |
| **GAMES** | 0.9% | 1.1% | 0.07% | 96.5% | 98.2% |
| **SPORT** | 0.9% | 0.2% | 0.006% | 94.2% | 100.0% |
| **ARCADE** | 0.3% | 0.5% | 0.02% | **100.5%** ⚠️ | 100.0% |
| **POKER** | 0.02% | 0.1% | 0.003% | **78.7%** | 100.0% |
| **LOTTO** | <0.001% | 0.04% | <0.001% | **880%** 🚨 | 100.0% |

---

## ยอดเงินจริง (THB) ช่วง 6 เดือน

| GameKind | CIn (THB) | Net Win (THB) | Counts |
|----------|-----------|---------------|--------|
| SLOT | ฿140,488,828 | ฿5,478,182 | 64,322,702 |
| FISH | ฿6,311,166 | ฿235,178 | 3,566,588 |
| CASINO | ฿2,277,943 | ฿109,060 | 16,971 |
| GAMES | ฿1,348,306 | ฿47,151 | 50,394 |
| SPORT | ฿1,312,270 | ฿75,712 | 3,989 |
| ARCADE | ฿424,465 | **-฿2,281** ⚠️ | 14,703 |
| POKER | ฿37,931 | ฿8,082 | 1,927 |
| LOTTO | ฿461 | **-฿3,600** 🚨 | 58 |
| **TOTAL** | **฿152,201,371** | **฿5,947,484** | **67,977,332** |

---

## Flags และ Alerts ที่สำคัญ

### 🚨 LOTTO — RTP 880% (ขาดทุนหนัก)
- CIn น้อยมาก (฿461) แต่ Nw ติดลบ -฿3,600
- ทุก 1 บาทที่ลูกค้าเล่น casino จ่ายคืน 8.8 บาท
- ควรตรวจสอ��ว่ายังเปิดให้บริการอยู่หรือไม่

### ⚠️ ARCADE — RTP 100.5% (ขาดทุนเล็กน้อย)
- Nw = -฿2,281 — casino เสียเงินจาก game type นี้
- volume ยังเล็ก แต่ควรติดตาม

### 📊 SLOT — Revenue Engine หลัก
- 92.3% ของ CIn ทั้งหมดมาจาก SLOT
- SLOT เป็น game ที่ต้อง monitor อย่างใกล้ชิดที่สุด
- CIn (np)% = 85.8% — ส่วนใหญ่ไม่ต้องพึ่งโปรโมชั่น

### 🎣 FISH — #2 แต่ Promo-dependent มาก
- DAU share สูงกว่า CIn share (6.4% vs 4.1%) = เล่นบ่อยแต่เดิมพันต่อครั้งน้อย
- CIn (np)% เพียง 64.2% — ผู้เล่น FISH พึ่งโปรมากที่สุดในทุก game type

### 🃏 POKER — RTP ต่ำที่สุด (78.7%)
- Casino ได้กำไรสูงสุดต่อยอดเดิมพัน แต่ volume เล็กมาก
- ทุก ฿100 ที่เล่น casino ได้กำไร ฿21.3

### ⚽ SPORT & 🃏 CASINO & 🎮 GAMES — Non-Promo ล้วน
- CIn (np)% = 98-100% — ผู้เล่น group นี้ไม่ต้องการโปรเลย
- เป็นกลุ่มที่มีคุณภาพสูงมาก

---

## วิธีวิเคราะห์ Brand Value Report

### A. Market Concentration
- SLOT dominates (92%+) → คุณภาพ SLOT provider สำคัญมากที่สุด
- ถ้า SLOT RTP เปลี่ยนแปลง → กระทบ P&L รวมทันที

### B. Game Profitability
- เรียง Net Win / CIn = R/BIn ต่อแต่ละ game type
- POKER: 21.3% margin (ดีที่สุด แต่ volume น้อย)
- SPORT: 5.8% margin
- SLOT/FISH/CASINO/GAMES: ~3.5-4.8% margin

### C. Promo Dependency by Game Type
- FISH players พึ่งโปรมากที่สุด (CIn np% เพียง 64%) → ถ้าหยุดโปร FISH, ยอด FISH อาจลดมาก
- SPORT/CASINO/GAMES/POKER: ผู้เล่น organic เกือบทั้งหมด

### D. Volume vs Value Analysis
- CIn per Count = ยอดเดิมพันเฉลี่ยต่อ round
  - SPORT: CIn/Count สูง (เดิมพันใหญ่)
  - SLOT: CIn/Count ต่ำ (เดิมพันครั้งละน้อยแต่บ่อยมาก)

---

## Python Code สำหรับโหลดและแปลงข้อมูล

```python
import pandas as pd

df = pd.read_excel("Brand Value (Last 6 Months).xlsx")

# ลบ Total row และ footer
df = df[df['GameKind'].notna()].copy()
df = df[~df['GameKind'].str.contains('Total|Applied', na=False)].copy()

# แปลงเงิน MMK → THB
# shwe666: FACTOR = 1000 * 0.787 | ubet89/88fed: FACTOR = 1000
FACTOR = 1000 * 0.787  # ปรับตามเว็บที่วิเคราะห์
for col in ['CIn', 'Nw', 'Nw (np)', 'Nw (p)']:
    if col in df.columns:
        df[col + '_THB'] = pd.to_numeric(df[col], errors='coerce') * FACTOR

# แปลง % columns (decimal → %)
pct_cols = ['CIn (np)%', 'DAU% (np)', 'RTP', 'RTP (np)', 'RTP (p)']
for col in pct_cols:
    if col in df.columns:
        df[col + '_pct'] = pd.to_numeric(df[col], errors='coerce') * 100

# Market share
total_cin = df[df['GameKind'] != 'PROMO']['CIn'].sum()
df['CIn_share%'] = df['CIn'] / total_cin * 100

# Profitability (R/BIn equivalent per game)
df['Nw_margin%'] = df['Nw'] / df['CIn'] * 100
```
