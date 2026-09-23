'use strict';

// Longest-first exact repairs for common small-Whisper Thai mishears.
// Do not fuzzy-match unsegmented Thai: it eats neighboring syllables (มีผู้เสพ → ผู้เสพ).
const EXACT = [
  ['พูปไว้', 'ผู้ป่วย'],
  ['พู่ป่วย', 'ผู้ป่วย'],
  ['ผู่ป่วย', 'ผู้ป่วย'],
  ['ผู้ปวย', 'ผู้ป่วย'],
  ['ผู้ป่าย', 'ผู้ป่วย'],
  ['ผู้บ่าย', 'ผู้ป่วย'],
  ['ผู้ป้วย', 'ผู้ป่วย'],
  ['ผุ้ป่วย', 'ผู้ป่วย'],
  ['ผู้ปั่วย', 'ผู้ป่วย'],
  ['ผู้ปวาย', 'ผู้ป่วย'],
  ['พู่ปวย', 'ผู้ป่วย'],
  ['พูป่วย', 'ผู้ป่วย'],
  ['คนไข่', 'คนไข้'],
  ['จิตเวส', 'จิตเวช'],
  ['จิตเวจ', 'จิตเวช'],
  ['จิตเวชฯ', 'จิตเวช'],
  ['ผู้แซบ', 'ผู้เสพ'],
  ['ผู้แซ็บ', 'ผู้เสพ'],
  ['ผู้เสบ', 'ผู้เสพ'],
  ['ผู้แสบ', 'ผู้เสพ'],
  ['ผู้พ้นโทด', 'ผู้พ้นโทษ'],
  ['ผู้พ้นโทย', 'ผู้พ้นโทษ'],
  ['รายชือ', 'รายชื่อ'],
  ['เฝ้าระวังค์', 'เฝ้าระวัง'],
  ['เสี่ยงสูญ', 'เสี่ยงสูง'],
  ['เสี่ยงซูง', 'เสี่ยงสูง'],
  ['พีทีเอฟ', 'pdf'],
  ['พีทิเอฟ', 'pdf'],
  ['พีทียฟ', 'pdf'],
  ['พีดียฟ', 'pdf'],
  ['พีดีเอฟ', 'pdf'],
  ['พีดีเอ็ฟ', 'pdf'],
  ['พีดีเอฟ', 'pdf'],
  ['บีดีเอฟ', 'pdf'],
  ['พีดีเอฟ', 'pdf'],
  // สภ. — Whisper commonly expands the abbreviation into สอบพอท/สอบพอด ฯลฯ
  ['สอบพอท', 'สภ.'],
  ['สอบพอด', 'สภ.'],
  ['สอบพอต', 'สภ.'],
  ['สอปพอท', 'สภ.'],
  ['สอพอท', 'สภ.'],
  ['สายพอท', 'สภ.'],
  ['สถานีพอท', 'สภ.'],
  // บุคคล — dropped consonant after the ค cluster.
  ['บุลคล', 'บุคคล'],
  ['บุคคัล', 'บุคคล'],
  ['บุคลคล', 'บุคคล'],
];

function correctTranscript(text) {
  let out = String(text || '').trim();
  if (!out) return '';
  const pairs = EXACT.slice().sort((a, b) => b[0].length - a[0].length);
  for (const [bad, good] of pairs) {
    if (out.includes(bad)) out = out.split(bad).join(good);
  }
  // A partial "รายชื่" is repaired only as a complete spoken token.  Replacing
  // it inside "รายชื่อ" used to append a second อ to every correct request.
  out = out.replace(/รายชื่(?=\s|$|[,.!?])/gu, 'รายชื่อ');
  out = out.replace(/รายชื่ออ(?=\s+(?:ผู้ป่วย|ผู้เสพ|ผู้ค้า|ผู้พ้นโทษ|บุคคล))/gu, 'รายชื่อ');
  out = repairStationCue(out);
  out = repairVisitPlanStationCue(out);
  return out.replace(/\s+/g, ' ').trim();
}

function repairStationCue(text) {
  const value = String(text || '');
  // "ศพ" can mean a corpse. Repair it only as a separate word in a registry
  // request with a named place and an explicit area boundary.
  if (!/(?:รายชื่อ|ภาพรวม|สรุป|ผู้ป่วย|จิตเวช|ผู้เสพ|ผู้ค้า|ผู้พ้นโทษ|บุคคล)/u.test(value)) return value;
  return value.replace(/(^|[\s,])(?:ศพ|สพ|สอพอ|สภอ)\s+(?!(?:จังหวัด|จ\.|อำเภอ|เขต|ตำบล))(?=[ก-๙A-Za-z0-9.-]{2,80}\s*(?:จังหวัด|จ\.|อำเภอ|เขต|ตำบล|$))/gu, '$1สภ.');
}

// A spoken visit-plan request ("ขอแผนการตรวจเยี่ยม ... จังหวัด...") often
// transcribes สภ. as spaced syllables ("ส พอร์") or other near-homophones.
// Whisper keeps the station name as separate short tokens ("ทา อู เท น"), so
// the name slot here allows spaces and must end at the named area boundary.
function repairVisitPlanStationCue(text) {
  const value = String(text || '');
  const visit = /เยี่ยม|ลง\s*พื้นที่/u.test(value);
  const planning = /แผน|ตาราง|คิว/u.test(value);
  if (!visit || !planning) return value;
  return value.replace(/(^|[\s,])(?:ส\s*พอร์|สพอร์|ส\s*พอท|สพอท|ส\s*พอ|สพอ|สถานี\s*พอร์|สถานี\s*พอ|ศพ|สพ|สอพอ|สภอ)\s+(?=[ก-๙A-Za-z0-9.-][ก-๙A-Za-z0-9. -]{1,79}?\s*(?:จังหวัด|จ\.|อำเภอ|เขต|ตำบล))/gu, '$1สภ.');
}

module.exports = { correctTranscript, repairStationCue };
