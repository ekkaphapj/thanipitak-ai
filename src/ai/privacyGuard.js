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
// Detection combines regex, known field classification and application
// context (the deterministic `filters.query` name extraction).

const THAI_DIGITS = '๐๑๒๓๔๕๖๗๘๙';

const TITLE_SRC = '(?:นาย|นางสาว|นาง|ด\\.?ช\\.?|ด\\.?ญ\\.?|เด็กชาย|เด็กหญิง)';
// Cue words that introduce a bare spoken name. ชื่อ must not match the
// รายชื่อ of a list request (lookbehind) nor ชื่ออะไร / ชื่อ สภ.
const CUE_SRC = '(?:ค้นหา|ค้น|หาคน|หา|ใครชื่อ|คนชื่อ|ชื่อว่า|(?<!ราย)ชื่อ|นามสกุล)';
// A name token never starts with a place cue, so "ค้นหานายสมชาย ใจดี
// ตำบลโพนสูง" captures only the person and leaves the subdistrict for
// the plan (regression: the live dry-run swallowed ตำบลโพนสูง).
const TOKEN_SRC = '(?:(?!ตำบล|อำเภอ|เขต|จังหวัด|สถานี)[ก-๙]{1,30})';
// A captured name span ends at a place cue / connector / end of utterance.
const BOUNDARY_SRC = '(?=\\s*(?:ตำบล|ต\\.|อำเภอ|อ\\.|เขต|จังหวัด|จ\\.|สภ\\.?|สถานี|ใน|ที่|ตาม|กับ|และ|เมื่อ|ช่วง|เดือน|ปี|ล่าสุด|$))';
const PLACEHOLDER_RE = /\[(?:PERSON|NATIONAL_ID|PHONE|EMAIL|NUMBER)_\d+\]/g;

function toArabicDigits(s) {
  return String(s).replace(/[๐-๙]/g, (d) => String(THAI_DIGITS.indexOf(d)));
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function contextNameCandidates(text) {
  try {
    const { extractLookupFilters } = require('./fastPath');
    const q = extractLookupFilters(String(text)).filters?.query;
    return q ? [q] : [];
  } catch {
    return [];
  }
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
    out = out.replace(new RegExp(escapeRe(value.trim()), 'gu'), ref);
    return ref;
  };

  // --- Regex layer. Long identifiers first so phone patterns cannot take
  // a substring out of them; phones before the generic long-number rule.
  out = out.replace(/\b\d{13}\b/gu, (m) => addRef('NATIONAL_ID', m));
  out = out.replace(/\b0\d{8,9}\b/gu, (m) => addRef('PHONE', m));
  out = out.replace(/\b\d{8,12}\b/gu, (m) => addRef('NUMBER', m));
  out = out.replace(/[\w.+-]+@[\w-]+\.[\w.]+/gu, (m) => addRef('EMAIL', m));

  // --- Title-prefixed names: นายแดง ใจดี (1–3 Thai tokens).
  out = out.replace(new RegExp(`${TITLE_SRC}\\s*${TOKEN_SRC}(?:\\s+${TOKEN_SRC}){0,2}${BOUNDARY_SRC}`, 'gu'),
    (m) => addRef('PERSON', m));

  // --- Cue + name: ค้นหาสมชาย / ใครชื่อสมหญิง. Placeholder text inserted
  // by the digit/email rules is skipped automatically ([ is not [ก-๙]).
  out = out.replace(new RegExp(`${CUE_SRC}(?!อะไร)(?!\\s*สภ)\\s*${TOKEN_SRC}(?:\\s+${TOKEN_SRC}){0,2}${BOUNDARY_SRC}`, 'gu'),
    (m) => addRef('PERSON', m.replace(new RegExp(`^${CUE_SRC}\\s*`, 'u'), '')));

  // --- Application context: a name the deterministic routing layer itself
  // classifies as filters.query (belt and braces for uncued spellings).
  for (const candidate of contextNameCandidates(text)) {
    if (candidate && out.includes(candidate)) addRef('PERSON', candidate);
  }

  // Extra values the caller declares sensitive by definition (e.g. the
  // selected person display name).
  for (const extra of options.knownNames || []) {
    if (extra && out.includes(extra)) addRef('PERSON', extra);
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
    if (real && t.includes(real)) return { ok: false, reason: 'MAPPING_LEAK' };
  }
  // Strip placeholders, then nothing sensitive-shaped may remain.
  const bare = t.replace(PLACEHOLDER_RE, ' ');
  if (/\d{13}/.test(bare)) return { ok: false, reason: 'NATIONAL_ID' };
  if (/\b0\d{8,9}\b/.test(bare)) return { ok: false, reason: 'PHONE' };
  if (/\b\d{8,12}\b/.test(bare)) return { ok: false, reason: 'LONG_NUMBER' };
  if (/[\w.+-]+@[\w-]+\.[\w.]+/.test(bare)) return { ok: false, reason: 'EMAIL' };
  if (/eyJ[A-Za-z0-9_-]{10,}/.test(bare)) return { ok: false, reason: 'JWT' };
  if (/(?:api[_-]?key|bearer|authorization)\s*[:=]/i.test(bare)) return { ok: false, reason: 'CREDENTIAL' };
  if (new RegExp(`${TITLE_SRC}\\s*[ก-๙]{2,}`, 'u').test(bare)) return { ok: false, reason: 'TITLE_NAME' };
  if (/รายชื่อ/.test(t)) return { ok: true };
  // A cue that still introduces Thai text after placeholder stripping is
  // suspicious — unless that text is a place cue legitimately following
  // the stripped placeholder (ค้นหา[PERSON_1] ตำบลโพนสูง).
  if (new RegExp(`(?:ค้นหา|ใครชื่อ|คนชื่อ|ชื่อว่า|นามสกุล)\\s*(?!ตำบล|อำเภอ|เขต|จังหวัด|สถานี|สภ\\.?)[ก-๙]`, 'u').test(bare)) {
    return { ok: false, reason: 'UNCUED_NAME' };
  }
  return { ok: true };
}

module.exports = { sanitizeForCloud, restoreLocalReferences, assertCloudSafe };
