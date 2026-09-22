'use strict';

// Deterministic parsing of area exclusions ("ยกเว้น/ไม่รวม/ไม่นับ <พื้นที่>")
// from typed or transcribed commands. A trigger may chain several areas with
// "และ/กับ"; later segments inherit the area unit of the first named one
// ("ยกเว้นตำบลโพนสูงและวังใหญ่" excludes both subdistricts). This module only
// extracts the phrases; the caller resolves every name against the
// server-verified scope catalogue before applying any filter, so an exclusion
// can narrow a result but never widen access.

const UNIT = '(?:จังหวัด|อำเภอ|เขต|ตำบล|จ\\.|อ\\.|ต\\.)';
// Values end at the next question keyword, connector, or another trigger so a
// name never swallows the rest of the sentence.
const VALUE_STOP = '(?=\\s*(?:$|ใน|ของ|มี|กี่|รายชื่อ|ขอ|ใคร|เยี่ยม|เสี่ยง|เฝ้า|ผู้เสพ|ผู้ค้า|ผู้ป่วย|พ้นโทษ|ยกเว้น|ไม่รวม|ไม่นับ|เลือก|ทั้งหมด|ทั้งระบบ|,|\\n))';
const SEGMENT = `${UNIT}?\\s*[ก-๙A-Za-z0-9.\\-]{2,60}?${VALUE_STOP}`;
const CHAIN_RE = new RegExp(`(?:ยกเว้น|ไม่รวม|ไม่นับ)\\s*(?:ที่\\s*)?${SEGMENT}(?:\\s*(?:และ|กับ)\\s*${SEGMENT})*`, 'gu');
const UNIT_KINDS = [
  [/จังหวัด|จ\./u, 'province'],
  [/อำเภอ|เขต|อ\./u, 'district'],
  [/ตำบล|ต\./u, 'subdistrict'],
];

function kindForUnit(unit) {
  if (!unit) return null;
  for (const [pattern, kind] of UNIT_KINDS) if (pattern.test(unit)) return kind;
  return null;
}

// Returns [{ kind, value, matchedText }]. A null kind is resolved later
// against the authenticated area catalogue; matchedText spans the whole chain
// so callers can strip it from the text passed to detectors and the model.
function parseAreaExclusions(message) {
  const text = String(message == null ? '' : message);
  if (!text) return [];
  const found = [];
  for (const chain of text.matchAll(CHAIN_RE)) {
    const body = chain[0].replace(/^(?:ยกเว้น|ไม่รวม|ไม่นับ)\s*(?:ที่\s*)?/u, '');
    let inherited = null;
    for (const segment of body.split(/\s*(?:และ|กับ)\s*/u)) {
      if (!segment.trim()) continue;
      const unitMatch = segment.match(new RegExp(`^(${UNIT})\\s*`, 'u'));
      const kind = unitMatch ? kindForUnit(unitMatch[1]) : inherited;
      const value = (unitMatch ? segment.slice(unitMatch[0].length) : segment).replace(/\s+/g, ' ').trim();
      if (value.length >= 2) found.push({ kind, value, matchedText: chain[0] });
      if (unitMatch) inherited = kind;
    }
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
