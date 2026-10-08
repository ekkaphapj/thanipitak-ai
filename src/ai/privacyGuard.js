'use strict';

// Privacy Guard for Cloud AI (OpenRouter) — CONTROL PLANE egress filter.
//
// Officer utterances may contain real registry person names, ID numbers or
// phones. Cloud AI is only allowed to see opaque placeholders. This module:
//   1. sanitizeForCloud(text)  — detect sensitive spans and replace them
//      with [PERSON_n]/[NATIONAL_ID_n]/[PHONE_n]/[EMAIL_n]/[NUMBER_n],
//      keeping the local mapping in memory only (never persisted, never
//      returned to the client, never logged).
//   2. restoreLocalReferences() — put the real values back into the
//      validated plan before the backend executes the query.
//   3. assertCloudSafe(text, mapping) — the final gate that runs on the
//      exact outbound string. Default deny: anything it cannot prove safe
//      blocks the request and the route falls back to Local AI.
//
// Detection uses explicit name/title cues and classified domain/area words.
// Ambiguous name-shaped values are refused by the final gate.

const THAI_DIGITS = '๐๑๒๓๔๕๖๗๘๙';

const TITLE_SRC = '(?:นางสาว|นาย|นาง|เด็กชาย|เด็กหญิง|ด\\.?ช\\.?|ด\\.?ญ\\.?|คุณ)';
const DOMAIN_START = /^(?:ผู้ป่วย|ผู้เสพ|ผู้ค้า|ผู้พ้นโทษ|ผู้ใช้ยา|ผู้จำหน่าย|คนไข้|คนเสพ|คนขายยา|คนใช้ยา|คนชื่อ|จิตเวช|ยาเสพติด|พ่อค้ายา|บุคคล|เป้าหมาย|รายชื่อ|เฉพาะ|ทั้งหมด|เลข|บัตร|โทร|อีเมล|ข้อมูล|คดี|ประวัติ|(?:ใน|ที่|ตาม)(?=\s|ตำบล|อำเภอ|จังหวัด|สภ)|ตำบล|อำเภอ|เขต|จังหวัด|สถานี|สภ\.?|[ตอจ]\.|ชื่ออะไร|อะไร|ไหน|ใคร|กี่)/u;
// Stop inside unspaced Thai only at explicit field cues or a connector
// introducing a field. A generic greedy Thai token used to swallow them.
const NAME_BOUNDARY = /(?:ใน|ที่|ของ)?(?:ตำบล|อำเภอ|เขต|จังหวัด|สถานี|สภ\.?|[ตอจ]\.)|(?:\s+)(?:ใน|ที่|ตาม|กับ|และ|เมื่อ|ช่วง|เดือน|ปี|ล่าสุด)(?=\s|$)|ให้หน่อย|ให้ที|ครับ|ค่ะ|\s*[,;!?\n]/u;
const PLACEHOLDER_RE = /\[(?:PERSON|NATIONAL_ID|PHONE|EMAIL|NUMBER)_\d+\]/g;

function toArabicDigits(s) {
  return String(s).replace(/[๐-๙]/g, (d) => String(THAI_DIGITS.indexOf(d)));
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function nameAfter(text, offset) {
  const tail = text.slice(offset);
  const whitespace = tail.match(/^\s*/u)[0].length;
  const start = offset + whitespace;
  const rest = text.slice(start);
  if (!rest || rest.startsWith('[') || DOMAIN_START.test(rest)) return null;
  const boundary = rest.search(NAME_BOUNDARY);
  const value = (boundary < 0 ? rest : rest.slice(0, boundary)).trimEnd();
  // Ambiguous or longer spans are left for the final gate to refuse.
  if (!/^[ก-๙]{1,30}(?:\s+[ก-๙]{1,30}){0,2}$/u.test(value)) return null;
  return { start, end: start + value.length, value };
}

function nameSpans(text) {
  const spans = [];
  // Preserve titles and cues. Never use overlapping alternatives inside a
  // cue-plus-name regex: backtracking from ค้นหา to ค้น consumed หา as a name.
  const markers = [
    new RegExp(TITLE_SRC, 'gu'),
    /(?<!ราย)(?:ใครชื่อ|คนชื่อ|ชื่อว่า|ชื่อ|นามสกุล)/gu,
    /(?:^|(?<=\s)|(?<=ช่วย)|(?<=ขอ))(?:ค้นหา|ค้น|หา)/gu,
    /(?<=เลขบัตรประชาชน|หมายเลขโทรศัพท์|เบอร์โทรศัพท์)ของ/gu,
  ];
  for (const marker of markers) {
    for (const match of text.matchAll(marker)) {
      if (marker === markers[0] && internalTitle(text, match.index, match[0])) continue;
      // คุณ in an ordinary product/help question is not a person-name cue.
      if (match[0] === 'คุณ' && /^(?:คือ|เป็น|ช่วย|ทำ|มี|ใช้)/u.test(text.slice(match.index + match[0].length))) continue;
      let offset = match.index + match[0].length;
      // A search command may be followed by stacked name cues and a title.
      // Keep that entire prefix visible, hiding just the name value.
      const prefix = text.slice(offset).match(new RegExp(`^\\s*(?:(?:ชื่อว่า|ชื่อ)\\s*)?(?:${TITLE_SRC}\\s*)?`, 'u'))[0];
      offset += prefix.length;
      const span = nameAfter(text, offset);
      if (span && !spans.some(s => span.start < s.end && s.start < span.end)) spans.push(span);
    }
  }
  return spans.sort((a, b) => a.start - b.start);
}

function internalTitle(text, index, title) {
  const before = text.slice(0, index);
  if (/(?:ตำบล|อำเภอ|เขต|จังหวัด|สถานี|สภ\.?|[ตอจ]\.)\s*[ก-๙]*$/u.test(before)) return true;
  // ดช in เสพติดชื่อ is a word-internal overlap, not a child title.
  return /^ด/.test(title) && /เสพติ$/u.test(before);
}

function sanitizeForCloud(rawText, options = {}) {
  const text = toArabicDigits(String(rawText || ''));
  const mapping = {};
  const counters = { PERSON: 0, NATIONAL_ID: 0, PHONE: 0, EMAIL: 0, NUMBER: 0 };
  let out = text;

  const addRef = (kind, value) => {
    counters[kind] += 1;
    const ref = `[${kind}_${counters[kind]}]`;
    mapping[ref] = value.trim();
    return ref;
  };

  // --- Regex layer. Long identifiers first so phone patterns cannot take
  // a substring out of them; phones before the generic long-number rule.
  out = out.replace(/\b\d{13}\b/gu, (m) => addRef('NATIONAL_ID', m));
  out = out.replace(/\b0\d{8,9}\b/gu, (m) => addRef('PHONE', m));
  out = out.replace(/\b\d{8,12}\b/gu, (m) => addRef('NUMBER', m));
  out = out.replace(/[\w.+-]+@[\w-]+\.[\w.]+/gu, (m) => addRef('EMAIL', m));

  // Replace only offsets classified as names, from left to right. Substring
  // replacement could also hide a same-spelled place or part of a category.
  let cursor = 0;
  let replaced = '';
  for (const span of nameSpans(out)) {
    replaced += out.slice(cursor, span.start) + addRef('PERSON', span.value);
    cursor = span.end;
  }
  out = replaced + out.slice(cursor);

  // Extra values the caller declares sensitive by definition (e.g. the
  // selected person display name).
  for (const extra of options.knownNames || []) {
    if (extra && out.includes(extra)) out = out.replace(new RegExp(escapeRe(extra), 'gu'), () => addRef('PERSON', extra));
  }

  return { safeText: out, mapping };
}

// Put real values back into a validated plan. A placeholder-looking token
// that no mapping resolves means the model invented or mangled a reference
// — return null so the caller fails closed to Local AI.
function restoreLocalReferences(value, mapping) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    let out = value;
    for (const [ref, real] of Object.entries(mapping || {})) out = out.split(ref).join(real);
    // Non-global literal: a shared /g regex would carry lastIndex across calls.
    if (/\[(?:PERSON|NATIONAL_ID|PHONE|EMAIL|NUMBER)_\d+\]/.test(out)) return null;
    return out;
  }
  if (Array.isArray(value)) {
    const out = [];
    for (const item of value) {
      const restored = restoreLocalReferences(item, mapping);
      if (restored === null) return null;
      out.push(restored);
    }
    return out;
  }
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const restored = restoreLocalReferences(v, mapping);
      if (restored === null) return null;
      out[k] = restored;
    }
    return out;
  }
  return value;
}

// Final egress gate on the exact outbound string. Default deny.
function assertCloudSafe(text, mapping = {}) {
  const t = toArabicDigits(String(text || ''));
  for (const real of Object.values(mapping)) {
    // A name can also be a place (นายเมือง อำเภอเมือง). Only that explicit
    // place occurrence may remain; another occurrence still blocks egress.
    const withoutPlaces = real ? t.replace(new RegExp(`(?:ตำบล|อำเภอ|เขต|จังหวัด|สถานี|สภ\\.?|[ตอจ]\\.)\\s*${escapeRe(real)}(?=$|\\s|ตำบล|อำเภอ|จังหวัด|สภ)`, 'gu'), '') : t;
    if (real && withoutPlaces.includes(real)) return { ok: false, reason: 'MAPPING_LEAK' };
  }
  // Strip placeholders, then nothing sensitive-shaped may remain.
  const bare = t.replace(PLACEHOLDER_RE, ' ');
  if (/\d{13}/.test(bare)) return { ok: false, reason: 'NATIONAL_ID' };
  if (/\b0\d{8,9}\b/.test(bare)) return { ok: false, reason: 'PHONE' };
  if (/\b\d{8,12}\b/.test(bare)) return { ok: false, reason: 'LONG_NUMBER' };
  if (/[\w.+-]+@[\w-]+\.[\w.]+/.test(bare)) return { ok: false, reason: 'EMAIL' };
  if (/eyJ[A-Za-z0-9_-]{10,}/.test(bare)) return { ok: false, reason: 'JWT' };
  if (/(?:api[_-]?key|bearer|authorization)\s*[:=]/i.test(bare)) return { ok: false, reason: 'CREDENTIAL' };
  // Check the exact outbound text, retaining placeholders as boundaries.
  // Stripping one would make a preserved title appear to introduce a place.
  if (nameSpans(t).length) return { ok: false, reason: new RegExp(TITLE_SRC, 'u').test(t) ? 'TITLE_NAME' : 'UNCUED_NAME' };
  // Malformed/overlong values must not evade nameSpans' conservative parser.
  const markers = new RegExp(`(?:${TITLE_SRC}|(?<!ราย)ชื่อ(?:ว่า)?|นามสกุล|ค้นหา|ค้น|หา)\\s*`, 'gu');
  for (const match of t.matchAll(markers)) {
    const title = match[0].trim();
    if (new RegExp(`^${TITLE_SRC}$`, 'u').test(title)) {
      if (internalTitle(t, match.index, title)) continue;
      if (title === 'คุณ' && /^(?:คือ|เป็น|ช่วย|ทำ|มี|ใช้)/u.test(t.slice(match.index + match[0].length))) continue;
    } else if (match.index > 0 && /[ก-๙]/u.test(t[match.index - 1])
      && !/(?:ค้นหา|หา|ดู|ชื่อ|ชื่อว่า|ของ|และ|กับ|คือ|บุคคล|ผู้ใช้ยาเสพติด)$/u.test(t.slice(0, match.index))) continue;
    const rest = t.slice(match.index + match[0].length);
    if (!rest || rest.startsWith('[') || DOMAIN_START.test(rest) || new RegExp(`^${TITLE_SRC}|^ชื่อ`, 'u').test(rest)) continue;
    if (/[ก-๙A-Za-z]/u.test(rest)) return { ok: false, reason: 'UNCUED_NAME' };
  }
  return { ok: true };
}

module.exports = { sanitizeForCloud, restoreLocalReferences, assertCloudSafe };
