# Brand Value by Game Kind Reference
## ไฟล์: "Brand Value (Last 6 Months)"
## ใช้กับ shwe666 / ubet89 / 88fed

---

## คำอธิบาย Columns ทั้งหมด

| Column | คำอธิบายภาษาไทย |
|--------|-----------------|
| **GameKind** | ประเภทของเกม (SLOT, FISH, CASINO, GAMES, SPORT, ARCADE, POKER, LOTTO, PROMO) |
| **CIn** | Coin In / Turnover รวม — ยอดเดิมพันทั้งหมดของ game type นั้น (เป็นเงิน — รายงานด้วย `CIn_THB`) |
| **CIn (np)%** | % ของ CIn ที่มาจาก non-promo players (เป็น % — รายงานด้วย `CIn (np)%_pct`) |
| **Nw** | Net Win — กำไรสุทธิของ casino จาก game type นั้น (เป็นเงิน — รายงานด้วย `Nw_THB`) |
| **RTP** | Return to Player — % ที่จ่ายคืนให้ผู้เล่น (เป็น % — รายงานด้วย `RTP_pct`) |
| **DAU** | จำนวน unique players ที่เล่น game type นี้ (ช่วง 6 เดือน — ไม่ใช่รายวัน) |
| **DAU% (np)** | % ของ DAU ที่ไม่รับโปรโมชั่น (เป็น % — รายงานด้วย `DAU% (np)_pct`) |
| **Nw (np)** | Net Win จาก non-promo players (เป็นเงิน — รายงานด้วย `Nw (np)_THB`) |
| **Nw (p)** | Net Win จาก promo players (เป็นเงิน อาจติดลบ — รายงานด้วย `Nw (p)_THB`) |
| **RTP (np)** | RTP เฉพาะกลุ่ม non-promo players (เป็น % — รายงานด้วย `RTP (np)_pct`) |
| **RTP (p)** | RTP เฉพาะกลุ่ม promo players (เป็น % — รายงานด้วย `RTP (p)_pct`) |
| **Counts** | จำนวน game rounds / ครั้งที่เดิมพันทั้งหมดใน 6 เดือน |

**หมายเหตุ**: ไฟล์นี้เป็น aggregated data ของ **6 เดือนล่าสุด** — ไม่ใช่รายวัน

---

## หน่วยเงิน

> **หน่วยเงิน:** ข้อมูลที่ส่งมาถูกแปลงเป็นเงินบาทแล้วในคอลัมน์ที่ลงท้าย `_THB`
> ให้อ้างอิงคอลัมน์เหล่านั้นเมื่อพูดถึงจำนวนเงิน ห้ามคำนวณแปลงค่าเงินเอง
> (ดูรายละเอียดใน SKILL.md หัวข้อ "หน่วยเงินและการแสดงผล")

คอลัมน์เงินในไฟล์นี้: `CIn_THB`, `Nw_THB`, `Nw (np)_THB`, `Nw (p)_THB`

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

## ขนาดยอดเทียบกัน ช่วง 6 เดือน (SH666)

> 📌 ตัวเลขในตารางนี้เป็น **units ตามสเกลของไฟล์ Power BI** (ค่าดิบ) ไม่ใช่บาท —
> ถ้าเก็บเป็นบาท ตัวเลขจะผูกกับอัตราแลกเปลี่ยน ณ วันที่คำนวณ แล้วเพี้ยนทันทีที่ rate เปลี่ยน
> ใช้ตารางนี้ดู **สัดส่วนและลำดับความสำคัญ** ส่วนตัวเงินจริงให้อ่านจาก `CIn_THB` / `Nw_THB`
> ในข้อมูลที่ส่งมา

| GameKind | CIn (units) | Net Win (units) | Counts |
|----------|-------------|-----------------|--------|
| SLOT | 178,512 | 6,961 | 64,322,702 |
| FISH | 8,019 | 299 | 3,566,588 |
| CASINO | 2,894 | 139 | 16,971 |
| GAMES | 1,713 | 60 | 50,394 |
| SPORT | 1,667 | 96 | 3,989 |
| ARCADE | 539 | **-2.9** ⚠️ | 14,703 |
| POKER | 48 | 10.3 | 1,927 |
| LOTTO | 0.6 | **-4.6** 🚨 | 58 |
| **TOTAL** | **193,394** | **7,557** | **67,977,332** |

---

## Flags และ Alerts ที่สำคัญ

### 🚨 LOTTO — RTP 880% (ขาดทุนหนัก)
- CIn น้อยมาก (0.6 units) แต่ Nw ติดลบ -4.6 units
- ทุก 1 บาทที่ลูกค้าเล่น casino จ่ายคืน 8.8 บาท
- ควรตรวจสอบว่ายังเปิดให้บริการอยู่หรือไม่

### ⚠️ ARCADE — RTP 100.5% (ขาดทุนเล็กน้อย)
- Nw = -2.9 units — casino เสียเงินจาก game type นี้
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

# ไม่ต้องแปลงค่าเงิน — คอลัมน์ _THB (CIn_THB, Nw_THB, Nw (np)_THB, Nw (p)_THB)
# มาพร้อมข้อมูลที่ระบบส่งให้แล้ว ใช้คอลัมน์เหล่านั้นเมื่อรายงานจำนวนเงิน

# ไม่ต้องแปลง % — คอลัมน์ _pct (CIn (np)%_pct, DAU% (np)_pct, RTP_pct,
# RTP (np)_pct, RTP (p)_pct) มาพร้อมข้อมูลที่ระบบส่งให้แล้ว

# Market share
total_cin = df[df['GameKind'] != 'PROMO']['CIn'].sum()
df['CIn_share%'] = df['CIn'] / total_cin * 100

# Profitability (R/BIn equivalent per game)
df['Nw_margin%'] = df['Nw'] / df['CIn'] * 100
```
