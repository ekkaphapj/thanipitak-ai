'use strict';

// The plan is a deterministic, current-state query.  Its wording can be
// conversational, but a model must never decide the station or ranking rule.
function detectVisitPlanIntent(message) {
  const text = String(message || '').replace(/\s+/gu, ' ').trim();
  const visit = /เยี่ยม|ลง\s*พื้นที่/u.test(text);
  const planning = /แผน|ตาราง|คิว|จัด\s*ลำดับ|ลำดับ\s*ความ\s*สำคัญ|เร่ง\s*ด่วน|ควร\s*ไป|ไป\s*ก่อน|ค้าง\s*เยี่ยม/u.test(text);
  if (!visit || !planning) return null;
  const cue = /(?:สภ\.?|สถานี(?:ตำรวจ)?|(?:^|\s)(?:ศพ|สพ|สภอ)(?=\s|[ก-๙]))/u.test(text);
  const found = text.match(/(?:สภ\.?|สถานี(?:ตำรวจ)?)\s*([ก-๙A-Za-z0-9][ก-๙A-Za-z0-9 .-]{0,79}?)(?=\s*(?:จังหวัด|จ\.|อำเภอ|ตำบล|ให้หน่อย|หน่อย|ครับ|ค่ะ|$))/u);
  let station = found?.[1]?.trim().replace(/^สภ\.?\s*/u, '').replace(/^ภูธร\s*/u, '') || null;
  if (station && /^(?:ปัจจุบัน|ของฉัน|ที่สังกัด|ของผม|ของเรา)$/u.test(station)) station = null;
  return { station, missingStation: cue && !station && !/(?:สภ\.?\s*(?:ปัจจุบัน|ของฉัน|ที่สังกัด|ของผม|ของเรา))/u.test(text) };
}

module.exports = { detectVisitPlanIntent };
