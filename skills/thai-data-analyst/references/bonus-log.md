# Bonus / Points Log Reference
## ไฟล์: "bonus.xlsx"
## ใช้กับ shwe666 / ubet89 / 88fed

log การจ่าย point/โบนัส **รายธุรกรรม**

> ⚠️ บอทไม่ได้เก็บทุกแถว — ตอน parse จะ **สรุปเป็นรายวัน** ก่อนเก็บ
> 1 แถวที่เก็บ = 1 คู่ (วันที่ × ประเภท point) ไฟล์ดิบยังอยู่บนดิสก์ตาม
> retention ปกติ 6 เดือน

---

## Columns ในไฟล์ดิบ

| Column | คำอธิบายภาษาไทย |
|--------|-----------------|
| **AddTime** | เวลาที่จ่าย point ← ใช้เป็นวันที่ของรายการ |
| **Type** | ประเภท point เช่น `Loyalty Point`, `Referrer Reward Point` |
| **Username** | บัญชีที่ได้รับ |
| **Lv** | level ของ member ตอนได้รับ (ส่วนใหญ่ว่าง) |
| **Points** | จำนวน point ที่จ่าย |
| **Memo** | เหตุผล/หมายเหตุ เช่น `Loyalty Point ( Period No : 98 )` |

## Columns หลังสรุปรายวัน (ที่บอทเก็บจริง)

| Column | ความหมาย |
|--------|----------|
| **Date** | วันที่ (จาก `AddTime`) |
| **Type** | ประเภท point |
| **total_points** | point รวมที่จ่ายในวันนั้นสำหรับประเภทนั้น |
| **transaction_count** | จำนวนครั้งที่จ่าย |

---

## Metric หลักที่ควรพูดถึงเวลามีคนถาม

1. **ต้นทุน point รวมต่อวัน** — `total_points` รวมทุก `Type`
   ควรดูคู่กับ `R` ใน Daily Value ว่าจ่าย point เพิ่มแล้วรายได้ขึ้นตามไหม
2. **ประเภทไหนกินงบมากสุด** — เทียบ `total_points` ข้าม `Type`
   `Referrer Reward Point` ที่โตเร็วผิดปกติเป็นธงแดง referral abuse
   (ดู `fraud-anomaly-detection.md`)
3. **จ่ายถี่แต่ทีละน้อย หรือจ่ายก้อนใหญ่** — `total_points / transaction_count`
   ค่าเฉลี่ยต่อครั้งที่กระโดดผิดปกติควรตรวจสอบ
4. **เทียบกับ `other transfer.xlsx`** — ไฟล์นั้นเก็บ manual credit ที่พนักงาน
   เติมให้ ส่วนไฟล์นี้เป็น point ตามระบบ ถ้าจะดูต้นทุนรวมที่ให้ลูกค้าต้องดูทั้งคู่

> คำอธิบายประเภท point แต่ละแบบอยู่ใน `casino-metrics.md` หัวข้อ
> "ประเภท Point ต่างๆ ใน reward point.xlsx / other transfer.xlsx"
