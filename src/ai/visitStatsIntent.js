'use strict';

// "ขอภาพรวม/ข้อมูล/สรุป/สถิติ การตรวจเยี่ยม" is a deterministic aggregate
// question over recorded visits. The wording may put the period, the person
// types, the สภ. and the province in any order; a model never decides the
// station, the period or the types shown.
const TYPE_PATTERNS = [
  ['psychiatric', /ผู้ป่วยจิตเวช|จิตเวช|ผู้ป่วย|คนไข้/u],
  ['drug_user', /ผู้เสพ|ผู้ใช้ยา|ยาเสพติด/u],
  ['dealer', /ผู้ค้า|ผู้จำหน่าย/u],
  ['released', /บุคคลพ้นโทษ|ผู้พ้นโทษ|พ้นโทษ|พ้นโทษมาแล้ว/u],
];

const STATION_STOP = 'จังหวัด|จ\\.|อำเภอ|เขต|ตำบล|เดือน|ปี|ตั้งแต่|ถึง|ช่วง|ของ|ใน|กับ|และ|ทั้งหมด|รวม|ยอด|มี|กี่|หน่อย|ครับ|ค่ะ|คะ|$';

function detectVisitStatsIntent(message) {
  const text = String(message || '').replace(/\s+/gu, ' ').trim();
  if (!text) return null;
  const visits = /ตรวจ\s*เยี่ยม|การเยี่ยม|ผลการเยี่ยม|ยอดการเยี่ยม|เยี่ยมบ้าน/u.test(text);
  if (!visits) return null;
  const summaryWords = /ภาพรวม|สรุป|สถิติ|ยอด|จำนวน|ข้อมูล|แจกแจง|รายเดือน|แยกตามเดือน/u.test(text);
  // Plan wording (แผน/ตาราง/คิว…) stays on the visit-plan path.
  const planWords = /แผน|ตาราง|คิว|จัด\s*ลำดับ|ลำดับความสำคัญ|เร่งด่วน|ควรไป|ไปก่อน|ค้างเยี่ยม|ใครควร/u.test(text);
  if (!summaryWords || planWords) return null;
  const types = [];
  for (const [type, pattern] of TYPE_PATTERNS) if (pattern.test(text) && !types.includes(type)) types.push(type);
  // The cue must start at a word boundary, so the "สพ" inside "ผู้เสพ" is
  // never mistaken for a station cue and the following words for its name.
  const stationMatch = text.match(new RegExp(`(?:^|[\\s,(])(?:สภ\\.?|สถานี(?:ตำรวจ)?|สพ\\.?|สอพอ\\.?|สภอ\\.?)\\s*([ก-๙A-Za-z0-9][ก-๙A-Za-z0-9 .-]{0,79}?)(?=\\s*(?:${STATION_STOP}))`, 'u'));
  let station = stationMatch?.[1]?.trim().replace(/^สภ\.?\s*/u, '').replace(/^ภูธร\s*/u, '') || null;
  // "สภ. จังหวัดอุดรธานี" must read as a cue with no name, never a station
  // called "จังหวัดอุดรธานี": a capture that itself starts with a stop word is
  // the next area/period clause, not a station name.
  if (station && /^(?:จังหวัด|จ\.|อำเภอ|เขต|ตำบล|เดือน|ปี|ตั้งแต่|ถึง|ช่วง|ของ|ใน|กับ|และ|ทั้งหมด|รวม|ยอด|มี|กี่|หน่อย)/u.test(station)) station = null;
  if (station && /^(?:ปัจจุบัน|ของฉัน|ที่สังกัด|ของผม|ของเรา|ทั้งหมด|ในพื้นที่)$/u.test(station)) station = null;
  const cue = /(?:สภ\.?|สถานี(?:ตำรวจ)?|(?:^|\s)(?:ศพ|สพ|สอพอ|สภอ)(?=\s|[ก-๙]))/u.test(text);
  // "strong" wording marks an unambiguous aggregate request even when a
  // person is currently selected in the UI.
  const strong = /ภาพรวม|สรุป|สถิติ|รายเดือน|แยกตามเดือน|ทั้งหมด|รวมทั้งหมด/u.test(text);
  return { types: types.length ? types : null, station, missingStation: cue && !station, strong };
}

module.exports = { detectVisitStatsIntent };
