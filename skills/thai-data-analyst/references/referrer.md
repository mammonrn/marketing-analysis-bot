# Referrer Reference
## ไฟล์: "Referrer.xlsx"
## ใช้กับ shwe666 / ubet89 / 88fed

สรุปผลรายผู้แนะนำ (referrer) เป็น **snapshot** — คอลัมน์ชุดเดียวกับ `AD_Agent.xlsx`
ต่างกันที่มิติแรกเป็น username ของผู้ชวน และมีคอลัมน์ `Ref Bonus` เพิ่มเข้ามา
(คอลัมน์นี้เองคือ signature ที่ใช้แยกไฟล์สองชนิดนี้ออกจากกัน)

---

## คำอธิบาย Columns

| Column | คำอธิบายภาษาไทย | หน่วย |
|--------|-----------------|-------|
| **Referrer** | username ของคนที่ชวน | — |
| **Ref Bonus** | โบนัสที่จ่ายให้ referrer คนนี้ | THB (พัน) |
| **Total Mems** | จำนวน downline ทั้งหมดที่ชวนมาได้ | คน |
| **Total BIn Mems** | จำนวน downline ที่ฝากเงินจริง | คน |
| **BIn Mems%** | สัดส่วน downline ที่ฝากจริง | สัดส่วน (0-1) |
| **BIn** | ยอดฝากรวมของ downline ทั้งหมด | THB (พัน) |
| **ARPPU** | ยอดฝากเฉลี่ยต่อ downline ที่ฝากจริง | THB (พัน) |
| **BIn (Pro)%** | สัดส่วนยอดฝากที่มาพร้อมโปรโมชั่น | สัดส่วน (0-1) |
| **Pro** / **Bonus** | ต้นทุนโปรโมชั่น / โบนัสของกลุ่ม downline | THB (พัน) |
| **R** | Revenue สุทธิที่ downline กลุ่มนี้สร้าง | THB (พัน) |
| **DAU** | Daily Active Users ในกลุ่ม downline | คน |
| **CIn** | ยอดเดิมพันรวมของ downline | THB (พัน) |
| **Pw** | Profit/Win ของบริษัทจากกลุ่มนี้ | THB (พัน) |

---

## Metric หลักที่ควรพูดถึงเวลามีคนถาม

1. **referrer คนไหนสร้างมูลค่าจริง** — เทียบ `R` กับ `Ref Bonus` ที่จ่ายไป
   ถ้า `Ref Bonus` สูงแต่ `R` ต่ำหรือติดลบ = จ่ายค่าแนะนำแพงเกินมูลค่าที่ได้
2. **คุณภาพ downline** — `BIn Mems%` ต่ำมาก (เช่น < 20%) แปลว่าชวนคนมาเยอะ
   แต่แทบไม่มีใครฝากเงินจริง
3. **ธงแดง fraud** — referrer ที่มี `Total Mems` สูงมากแต่ `BIn Mems%` ต่ำผิดปกติ
   และรับ `Ref Bonus` ต่อเนื่อง เข้าข่าย referral abuse
   → ดูวิธีตรวจละเอียดใน `fraud-anomaly-detection.md`

> ใช้คู่กับ `Member_Detail.xlsx` ได้ เพราะไฟล์นั้นมีคอลัมน์ `Referrer` ระดับราย
> member ทำให้ไล่ดู downline รายคนของ referrer คนหนึ่งได้
