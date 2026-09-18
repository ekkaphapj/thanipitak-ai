'use strict';

function detectLocationGroup(text) {
  const value = String(text || '');
  if (/(?:ตำบล\s*ไหน|อยู่(?:ใน)?ตำบลไหน|ตำบล(?:ใด|อะไร)บ้าง|แยก(?:ตาม)?ตำบล|เรียงตามตำบล|แจกแจง(?:ราย)?ตำบล|แต่ละตำบล)/u.test(value)) {
    return 'subdistrict';
  }
  if (/(?:อำเภอ\s*ไหน|เขต\s*ไหน|อยู่(?:ใน)?(?:อำเภอ|เขต)ไหน|(?:อำเภอ|เขต)(?:ใด|อะไร)บ้าง|แยก(?:ตาม)?(?:อำเภอ|เขต)|เรียงตาม(?:อำเภอ|เขต)|แจกแจง(?:ราย)?(?:อำเภอ|เขต)|แต่ละ(?:อำเภอ|เขต))/u.test(value)) {
    return 'district';
  }
  if (/(?:สภ\.?\s*ไหน|สถานี\s*ไหน|อยู่(?:ที่)?(?:สภ\.?|สถานี)ไหน|(?:สภ\.?|สถานี)(?:ใด|อะไร)บ้าง|แยก(?:ตาม)?(?:สภ\.?|สถานี)|เรียงตาม(?:สภ\.?|สถานี)|แต่ละสถานี)/u.test(value)) {
    return 'station';
  }
  if (/(?:จังหวัด\s*ไหน|อยู่(?:ใน)?จังหวัดไหน|จังหวัด(?:ใด|อะไร)บ้าง|แยก(?:ตาม)?จังหวัด|เรียงตามจังหวัด|แจกแจง(?:ราย)?จังหวัด|แต่ละจังหวัด)/u.test(value)) {
    return 'province';
  }
  return null;
}

function normalizeSpokenConnectors(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .replace(/และ\s*(?=ใน?จังหวัด|จังหวัด|จ\.|สภ\.?|สถานี|อำเภอ|เขต|ตำบล)/gu, ' ')
    .trim();
}

module.exports = { detectLocationGroup, normalizeSpokenConnectors };
