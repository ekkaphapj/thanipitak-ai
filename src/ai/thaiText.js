'use strict';

// Shared Thai text helpers for typed prompts and transcribed voice commands.
// Deterministic processing only: no model call, no registry access, and
// matching can only ever return names from a caller-supplied list.

const THAI_DIGITS = { '๐': '0', '๑': '1', '๒': '2', '๓': '3', '๔': '4', '๕': '5', '๖': '6', '๗': '7', '๘': '8', '๙': '9' };
const ZERO_WIDTH = /[\u200B\u200C\u200D\uFEFF]/g;
// Trailing politeness particles. "นา" is deliberately NOT treated as a
// pre-particle because many place names end with it ("บ้านนาครับ" must keep
// its name and only lose "ครับ").
const TRAILING_PARTICLE = /(?:\s*(?:นะ)?\s*(?:ครับ|ค่ะ|คะ))+$/u;
const TONE_MARKS = /[\u0E48-\u0E4B]/gu;
const AREA_PREFIX = /^(?:สภ\.?\s*|สถานี(?:ตำรวจ)?\s*|จังหวัด|อำเภอ|เขต|ตำบล|ต\.|อ\.|จ\.|หมู่(?:ที่)?\s*\d+\s*)+/u;

// Canonical form for routing: strip zero-width noise, unify digits and
// spacing, and drop trailing politeness particles. Empty input stays empty so
// callers can decide whether that means "no command".
function normalizeUtterance(value) {
  let text = String(value == null ? '' : value);
  if (!text) return '';
  text = text.replace(ZERO_WIDTH, '');
  text = text.replace(/[๐-๙]/g, (digit) => THAI_DIGITS[digit]);
  text = text.replace(/\s+/g, ' ').trim();
  text = text.replace(TRAILING_PARTICLE, '');
  return text.trim();
}

// Comparison key for place names: forgiving to transcription drift (dropped
// tone marks, doubled characters) and to typed variants ("สภ.บ้านดุง",
// "จังหวัดนครพนม").
function placeKey(value) {
  let text = String(value == null ? '' : value);
  if (!text) return '';
  text = text.replace(ZERO_WIDTH, '').replace(/\s+/g, '');
  text = text.replace(/[๐-๙]/g, (digit) => THAI_DIGITS[digit]);
  text = text.replace(TRAILING_PARTICLE, '');
  text = text.replace(TONE_MARKS, '');
  text = text.replace(AREA_PREFIX, '');
  return text.trim();
}

function editDistanceWithin(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return false;
  let previous = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) previous[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let rowBest = i;
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = previous[j - 1] + (a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1);
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, substitution);
      if (current[j] < rowBest) rowBest = current[j];
    }
    if (rowBest > max) return false;
    previous = current;
  }
  return previous[b.length] <= max;
}

function fuzzyAllowance(length) {
  if (length >= 8) return 3;
  if (length >= 5) return 2;
  if (length >= 3) return 1;
  return 0;
}

// Match `input` against an explicit candidate list and return the names in
// the best-scoring tier, ordered deterministically. Containment and edit
// distance operate only on these candidates, so a caller that passes a
// server-verified scope list can never widen access through this function.
function matchPlaceNames(input, candidates) {
  const key = placeKey(input);
  if (!key) return [];
  const scored = [];
  const seen = new Set();
  for (const candidate of candidates || []) {
    const name = String(candidate == null ? '' : candidate).trim();
    if (!name || seen.has(name)) continue;
    const candidateKey = placeKey(name);
    if (!candidateKey) continue;
    let score = 0;
    if (candidateKey === key) score = 3;
    else if (key.length >= 3 && candidateKey.includes(key)) score = 2;
    else if (candidateKey.length >= 3 && key.includes(candidateKey)) score = 2;
    else if (Math.min(key.length, candidateKey.length) >= 3) {
      if (editDistanceWithin(key, candidateKey, fuzzyAllowance(Math.max(key.length, candidateKey.length)))) score = 1;
    }
    if (score > 0) {
      scored.push({ name, score });
      seen.add(name);
    }
  }
  if (!scored.length) return [];
  const best = scored.reduce((top, item) => (item.score > top ? item.score : top), 0);
  return scored
    .filter((item) => item.score === best)
    .map((item) => item.name)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

module.exports = { normalizeUtterance, placeKey, matchPlaceNames };
