'use strict';

// Deterministic parsing of area exclusions ("ยกเว้น/ไม่รวม/ไม่นับ <พื้นที่>")
// from typed or transcribed commands. This module only extracts the phrase;
// the caller resolves the name against the server-verified scope catalogue
// before applying any filter, so an exclusion can narrow a result but never
// widen access.

const UNIT_KINDS = [
  [/จังหวัด|จ\./u, 'province'],
  [/อำเภอ|เขต|อ\./u, 'district'],
  [/ตำบล|ต\./u, 'subdistrict'],
];

// Value ends at the next question keyword, another area label, or the end of
// the sentence. Lazy matching keeps a short name from swallowing the rest.
const EXCLUSION_RE = /(?:ยกเว้น|ไม่รวม|ไม่นับ)\s*(?:ที่\s*)?(จังหวัด|อำเภอ|เขต|ตำบล|จ\.|อ\.|ต\.)?\s*([ก-๙A-Za-z0-9.\- ]{2,60}?)(?=\s*(?:$|ใน|ของ|จังหวัด|อำเภอ|เขต|ตำบล|สภ\.?|สถานี|มี|กี่|รายชื่อ|ขอ|ใคร|เยี่ยม|เสี่ยง|เฝ้า|ผู้เสพ|ผู้ค้า|ผู้ป่วย|พ้นโทษ|ยกเว้น|ไม่รวม|ไม่นับ|เลือก|และ|กับ|,))/gu;

function kindForUnit(unit) {
  if (!unit) return null;
  for (const [pattern, kind] of UNIT_KINDS) if (pattern.test(unit)) return kind;
  return null;
}

// Returns [{ kind: 'province'|'district'|'subdistrict'|null, value, matchedText }].
// A null kind is resolved later against the authenticated area catalogue.
function parseAreaExclusions(message) {
  const text = String(message == null ? '' : message);
  if (!text) return [];
  const found = [];
  for (const match of text.matchAll(EXCLUSION_RE)) {
    const value = String(match[2] || '').replace(/\s+/g, ' ').trim();
    if (!value || value.length < 2) continue;
    found.push({ kind: kindForUnit(match[1]), value, matchedText: match[0].trim() });
  }
  return found;
}

// Remove consumed spans so downstream detectors and the model never see the
// excluded area as a positive filter.
function removeSpans(message, spans) {
  let text = String(message == null ? '' : message);
  for (const span of spans || []) {
    if (!span) continue;
    text = text.split(span).join(' ');
  }
  return text.replace(/\s+/g, ' ').trim();
}

module.exports = { parseAreaExclusions, removeSpans };
