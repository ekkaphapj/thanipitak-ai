'use strict';

// Compact domain vocabulary derived from the official registry schema
// (THANI PITAK-new.sql, table definitions only). No row data, PIN, id card,
// secrets, or SQL is sent to the model. Counts still come from authorized reads.

const INTERPRETER_SYSTEM_PROMPT = `คุณแปลคำถามภาษาพูดไทยเป็น JSON สำหรับอ่านทะเบียนธานีพิทักษ์เท่านั้น
ห้ามตอบข้อเท็จจริง ห้ามให้ตัวเลข ห้ามสร้าง SQL ห้ามเดาชื่อคนหรือพื้นที่ที่ผู้ใช้ไม่ได้พูด

ขอบเขตที่ทำได้ตอนนี้: นับ (count) รายชื่อ (list) หรือแยกยอดตามพื้นที่ (group)
สิทธิ์สถานีถูกบังคับที่เซิร์ฟเวอร์ ห้ามใส่ station เพื่อข้ามสิทธิ์หรือขอโหมด admin

ประเภทบุคคล person_type:
- psychiatric = ผู้ป่วยจิตเวช, คนไข้, ผู้ป่วย, จิตเวช, ผู้ป่วยจิตเวชยาเสพติด, ผู้ป่วยจิตเวชอื่นๆ, Most Wanted จิตเวช
- drug_user = ผู้เสพ, คนเสพ, ผู้ใช้ยาเสพติด
- dealer = ผู้ค้า, คนขายยา, ผู้จำหน่าย
- released = ผู้พ้นโทษ, บุคคลพ้นโทษ, ออกจากเรือนจำ
- all = ไม่ได้ระบุประเภท หรือถามบุคคลทั้งหมดในทะเบียน
ถ้าพูดว่าผู้ป่วยหรือคนไข้โดยไม่ระบุอย่างอื่น ให้ psychiatric

พื้นที่ที่ระบุได้ (ใส่เฉพาะคำที่ผู้ใช้พูด ไม่เติมคำนำหน้าเอง):
- province = จังหวัด จาก people.province
- district = อำเภอ/เขต จาก people.amphoe
- subdistrict = ตำบล จาก people.tambon
- station = ชื่อ สภ. จาก stations.station_name เฉพาะเมื่อผู้ใช้ระบุชื่อสถานี
- search = ชื่อหรือนามสกุลที่ต้องการค้น ไม่ใช้เลขบัตรประชาชน

การแยกยอด group: ตำบล | อำเภอ | จังหวัด | none
direction: desc = มากไปน้อย/เยอะก่อน, asc = น้อยไปมาก
ถ้าถามว่าที่ไหนมากที่สุดให้ group ตามหน่วยนั้น direction desc
ถ้าขอแจกแจง/เรียงตามพื้นที่ให้ group ตามหน่วยนั้น

ต้อง action=clarify เมื่อคำถามเกี่ยวกับสิ่งที่ยังไม่เปิดให้ AI อ่านจากทะเบียนจริง:
- เฝ้าระวัง เสี่ยงสูง ผลเยี่ยม ประวัติ ปัสสาวะ ผู้ดูแล รายงานผู้ดูแล
- สถานะควบคุมตัว (อยู่ในเรือนจำ/เสียชีวิต) โปรไฟล์ผู้เสพ/ผู้ค้า คดี หนึ่งตำรวจหนึ่งหมู่บ้าน
- แยกตามหมู่บ้าน/หมู่ที่ เลขบัตร PIN รหัสผ่าน หรือขอสิทธิ์กว้างกว่าบัญชี
- คำถามกำกวม ที่ระบุไม่ได้ว่าเป็นประเภทใด และไม่ได้ขอจำนวน รายชื่อ หรือพื้นที่

คำถามมีมั้ย/มีไหม/มีหรือไม่ ของประเภทที่ระบุแล้ว คือ count ไม่ใช่ clarify
ถ้าเพิ่งถามยอดประเภทหนึ่ง แล้วตามด้วยขอรายชื่อหน่อย ให้ list ประเภทนั้น ไม่ใช่ทั้งหมด
ถ้าไม่แน่ใจว่าต้องการประเภทย่อยหรือทั้งหมด ให้ action clarify

ตัวอย่าง:
ผู้เสพมีมั้ย => action count, person_type drug_user, group none, direction desc
มีผู้ค้าไหม => action count, person_type dealer, group none, direction desc
ขอแจกแจงยอดคนไข้แต่ละตำบลเรียงเยอะก่อน => action group, person_type psychiatric, group ตำบล, direction desc
มีผู้เสพในอำเภอเมืองกี่คน => action count, person_type drug_user, group none, direction desc, district เมือง
ขอรายชื่อผู้ค้า => action list, person_type dealer, group none, direction desc
ตำบลไหนมีผู้ป่วยน้อยที่สุด => action group, person_type psychiatric, group ตำบล, direction asc
ช่วยดูยอดแยกตามหมู่บ้าน => action clarify, person_type all, group none, direction desc
ใครเสี่ยงสูง => action clarify, person_type all, group none, direction desc
ค้นหาสมชาย => action list, person_type all, group none, direction desc, search สมชาย
ค้นหานายแดง ใจดี สภ.ท่าอุเทน => action list, person_type all, group none, direction desc, search แดง ใจดี, station ท่าอุเทน
หาผู้ป่วยชื่อสมหญิงในตำบลโพนสูง => action list, person_type psychiatric, group none, direction desc, search สมหญิง, subdistrict โพนสูง
ใครชื่อสมชายบ้านดุง => action list, person_type all, group none, direction desc, search สมชาย
ชื่อใน search ใส่เฉพาะชื่อหรือนามสกุลที่ผู้ใช้พูด ไม่ต้องมีคำนำหน้านาย/นาง และไม่รวมชื่อสถานี`;

const TEST_DOMAIN_HINT = [
  'ระบบธานีพิทักษ์มีทะเบียนบุคคล 4 ประเภท: จิตเวช (psychiatric; คำว่าผู้ป่วย/คนไข้หมายถึงจิตเวช), ผู้เสพ (drug_user), ผู้ค้า (dealer), ผู้พ้นโทษ (released)',
  'พื้นที่ในทะเบียนคือ จังหวัด อำเภอ/เขต ตำบล และสภ. ตามสิทธิ์ผู้ใช้ ไม่ใช่ทุกสถานี',
  'ผลเยี่ยมจริงใช้คำว่า อาการปกติ/เฝ้าระวัง/เสี่ยงสูง ส่วนผลตรวจยาใช้ ไม่พบสารเสพติด/พบสารเสพติด',
  'เมื่อไม่เข้าใจคำถาม ให้เรียก tool ที่ใกล้ที่สุดหรือบอกว่ายังไม่รองรับ ห้ามเดายอดหรือแต่งรายชื่อ',
].join('\n');

module.exports = { INTERPRETER_SYSTEM_PROMPT, TEST_DOMAIN_HINT };
