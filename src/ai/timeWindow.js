'use strict';

// Deterministic Thai time-period analysis. No model and no registry access:
// explicit relative phrases are converted to Asia/Bangkok calendar boundaries
// so recorded-visit reads can be filtered server-side. A mention that cannot
// be resolved is reported (not dropped) so callers can refuse the request
// instead of silently answering a broader question.

const MONTHS_TH = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
const MONTHS_TH_SHORT = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
const THAI_DIGITS = { '๐': '0', '๑': '1', '๒': '2', '๓': '3', '๔': '4', '๕': '5', '๖': '6', '๗': '7', '๘': '8', '๙': '9' };

function thaiDigitsToArabic(text) {
  return String(text).replace(/[๐-๙]/g, (digit) => THAI_DIGITS[digit]);
}

// Thai cardinal words for 1-999, built from tens + units ("ยี่สิบเอ็ด" = 21).
// Alternatives are ordered longest-first so "ยี่สิบเอ็ด" is never read as
// "สิบเอ็ด" (11).
const THAI_UNITS = { เอ็ด: 1, หนึ่ง: 1, สอง: 2, สาม: 3, สี่: 4, ห้า: 5, หก: 6, เจ็ด: 7, แปด: 8, เก้า: 9 };
const THAI_TENS = { สิบ: 10, ยี่สิบ: 20, สามสิบ: 30, สี่สิบ: 40, ห้าสิบ: 50, หกสิบ: 60, เจ็ดสิบ: 70, แปดสิบ: 80, เก้าสิบ: 90, ร้อย: 100 };

function thaiNumberWords() {
  const words = [];
  for (const [word, value] of Object.entries(THAI_TENS)) words.push([word, value]);
  for (const [unitWord, unitValue] of Object.entries(THAI_UNITS)) {
    words.push([unitWord, unitValue]);
    for (const [tensWord, tensValue] of Object.entries(THAI_TENS)) {
      if (tensValue === 100) continue;
      words.push([tensWord + unitWord, tensValue + unitValue]);
    }
  }
  return words.sort((a, b) => b[0].length - a[0].length);
}
const THAI_NUMBER_WORDS = thaiNumberWords();
const WORD_NUMBER_ALT = THAI_NUMBER_WORDS.map(([word]) => word).join('|');

const UNITS_ALT = 'วัน|สัปดาห์|อาทิตย์|เดือน|ปี';
const LAST_N_RE = new RegExp(`(\\d{1,4}|${WORD_NUMBER_ALT})\\s*(${UNITS_ALT})\\s*(?:ล่าสุด|ที่ผ่านมา|ที่แล้ว|ก่อนหน้า?|ก่อน)(?:นี้)?`, 'u');

const UNIT_DAYS = { วัน: 1, สัปดาห์: 7, อาทิตย์: 7, เดือน: 30, ปี: 365 };
const UNIT_CAP = { วัน: 365, สัปดาห์: 52, อาทิตย์: 52, เดือน: 24, ปี: 10 };
const UNIT_LABEL = { วัน: 'วัน', สัปดาห์: 'สัปดาห์', อาทิตย์: 'อาทิตย์', เดือน: 'เดือน', ปี: 'ปี' };

// Comparison wording means two periods in one question; there is no
// comparison tool, so the request must be refused, never half-answered.
const COMPARISON_RE = /(?:เทียบ(?:กับ|กัน|กับกัน)?|เปรียบเทียบ|กับ(?:เดือน|ปี|สัปดาห์|อาทิตย์|วัน|ช่วง))/u;

const PATTERNS = [
  { re: /เมื่อวาน(?:นี้|กี้)?/u, kind: 'yesterday' },
  { re: /วันนี้/u, kind: 'today' },
  { re: /(?:สัปดาห์|อาทิตย์)ที่แล้ว(?:นี้)?/u, kind: 'last_week' },
  { re: /(?:สัปดาห์|อาทิตย์)นี้/u, kind: 'this_week' },
  { re: /เดือน(?:ที่แล้ว|ก่อนหน้า?|ก่อน)(?:นี้|ล่ะ)?/u, kind: 'last_month' },
  { re: /เดือนนี้/u, kind: 'this_month' },
  { re: /ปีที่แล้ว(?:นี้)?/u, kind: 'last_year' },
  { re: /ปีนี้/u, kind: 'this_year' },
  { re: LAST_N_RE, kind: 'last_n' },
];

// A message that clearly anchors a recorded period but that the parser cannot
// resolve must stay unsupported: named months, quarter words, open ranges.
const HARD_TIME_RE = new RegExp(
  'เมื่อวาน|วันนี้|(?:สัปดาห์|อาทิตย์)(?:ที่แล้ว|นี้)|เดือน(?:ที่แล้ว|ก่อน|นี้)|ปี(?:ที่แล้ว|นี้)'
  + `|(?:\\d{1,4}|${WORD_NUMBER_ALT})\\s*(?:${UNITS_ALT})\\s*(?:ล่าสุด|ที่ผ่านมา|ที่แล้ว|ก่อน)`
  + `|เดือน\\s*(?:${MONTHS_TH.join('|')}|${MONTHS_TH_SHORT.map((name) => name.replace('.', '\\.')).join('|')})`
  + `|${MONTHS_TH.join('|')}|ไตรมาส|ครึ่งปี|ต้นเดือน|ปลายเดือน|ย้อนหลัง|ตั้งแต่|ช่วงเวลา|หลายเดือน|หลายปี|เทียบ|เปรียบเทียบ`,
  'u',
);

function bangkokToday(now) {
  const [y, m, d] = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(now).split('-').map(Number);
  return { y, m, d };
}

const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const shiftDays = ({ y, m, d }, delta) => {
  const date = new Date(Date.UTC(y, m - 1, d + delta));
  return { y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate() };
};

function parseThaiNumberWord(word) {
  const found = THAI_NUMBER_WORDS.find(([candidate]) => candidate === word);
  return found ? found[1] : null;
}

function parseYear(raw) {
  const value = Number(raw);
  if (!Number.isInteger(value)) return null;
  if (value >= 2400) return value - 543; // พ.ศ.
  if (value >= 1900 && value <= 2200) return value; // ค.ศ.
  return null;
}

function buildWindow(kind, n, unit, now) {
  const today = bangkokToday(now);
  let from;
  let to;
  switch (kind) {
    case 'today':
      from = to = today;
      break;
    case 'yesterday':
      from = to = shiftDays(today, -1);
      break;
    case 'this_week':
    case 'last_week': {
      const weekday = new Date(Date.UTC(today.y, today.m - 1, today.d)).getUTCDay(); // 0=Sun
      const monday = shiftDays(today, -((weekday + 6) % 7));
      from = kind === 'this_week' ? monday : shiftDays(monday, -7);
      to = kind === 'this_week' ? today : shiftDays(monday, -1);
      break;
    }
    case 'this_month':
      from = { y: today.y, m: today.m, d: 1 };
      to = today;
      break;
    case 'last_month': {
      const total = today.y * 12 + today.m - 2;
      const prev = { y: Math.floor(total / 12), m: (total % 12) + 1 };
      from = { y: prev.y, m: prev.m, d: 1 };
      to = { y: prev.y, m: prev.m, d: daysInMonth(prev.y, prev.m) };
      break;
    }
    case 'this_year':
      from = { y: today.y, m: 1, d: 1 };
      to = today;
      break;
    case 'last_year':
      from = { y: today.y - 1, m: 1, d: 1 };
      to = { y: today.y - 1, m: 12, d: 31 };
      break;
    case 'last_n': {
      if (!Number.isFinite(n) || n < 1) return null;
      if (n > UNIT_CAP[unit]) return null;
      const delta = n * UNIT_DAYS[unit];
      from = shiftDays(today, -(delta - 1));
      to = today;
      break;
    }
    default:
      return null;
  }
  return { from: iso(from.y, from.m, from.d), to: iso(to.y, to.m, to.d), fromParts: from, toParts: to, todayParts: today };
}

function rangeLabel(kind, n, unit, from, to, today) {
  const dateText = (p) => `${p.d} ${MONTHS_TH_SHORT[p.m - 1]}`;
  switch (kind) {
    case 'today': return `วันนี้ (${dateText(today)})`;
    case 'yesterday': return `เมื่อวาน (${dateText(to)})`;
    case 'this_week': return `สัปดาห์นี้ (${dateText(from)}–${dateText(to)})`;
    case 'last_week': return `สัปดาห์ที่แล้ว (${dateText(from)}–${dateText(to)})`;
    case 'this_month': return `เดือนนี้ (${MONTHS_TH[from.m - 1]} ${from.y + 543})`;
    case 'last_month': return `เดือนที่แล้ว (${MONTHS_TH[from.m - 1]} ${from.y + 543})`;
    case 'this_year': return `ปีนี้ (${from.y + 543})`;
    case 'last_year': return `ปีที่แล้ว (${from.y + 543})`;
    default: return `${n} ${UNIT_LABEL[unit] || unit}ล่าสุด (${dateText(from)}–${dateText(to)})`;
  }
}

// Resolves one matched period phrase into a window, or null when it cannot be
// honored. Oversized trailing windows return null; the caller treats any
// matched-but-unresolved mention as unsupported.

// Named calendar months ("เดือนสิงหาคม 2569", "ส.ค. 2569", "เดือน 8").
// A missing year means the most recent August: this year when the month has
// already begun, otherwise last year. The window always covers the whole
// calendar month, never a 30-day approximation.
function resolveNamedMonth(text, now) {
  const normalized = thaiDigitsToArabic(text);
  const match = /(?:เดือน\s*)?(มกราคม|กุมภาพันธ์|มีนาคม|เมษายน|พฤษภาคม|มิถุนายน|กรกฎาคม|สิงหาคม|กันยายน|ตุลาคม|พฤศจิกายน|ธันวาคม|ม\.ค\.|ก\.พ\.|มี\.ค\.|เม\.ย\.|พ\.ค\.|มิ\.ย\.|ก\.ค\.|ส\.ค\.|ก\.ย\.|ต\.ค\.|พ\.ย\.|ธ\.ค\.)(?:\s*ปี\s*)?(\d{4})?/u.exec(normalized);
  if (!match) return null;
  const nameToken = match[1];
  let month = MONTHS_TH.indexOf(nameToken);
  if (month < 0) {
    const shortIndex = MONTHS_TH_SHORT.findIndex((name) => name.replace('.', '') === nameToken.replace('.', ''));
    month = shortIndex;
  }
  if (month < 0) return null;
  const today = bangkokToday(now);
  let year = match[2] ? parseYear(match[2]) : null;
  if (year === null) {
    year = month + 1 <= today.m ? today.y : today.y - 1;
  }
  if (year === null || year < 1900 || year > 2200) return { unsupported: true, label: match[0] };
  const from = { y: year, m: month + 1, d: 1 };
  const to = { y: year, m: month + 1, d: daysInMonth(year, month + 1) };
  const label = `เดือน${MONTHS_TH[month]} ${year + 543} (${from.d} ${MONTHS_TH_SHORT[month]}–${to.d} ${MONTHS_TH_SHORT[month]} ${year + 543})`;
  return { window: { from: iso(from.y, from.m, from.d), to: iso(to.y, to.m, to.d) }, label };
}

// Scans a message for every period mention. Returns resolvable windows, the
// matched text of every mention that could NOT be resolved, and whether the
// wording compares two periods. Comparison and unresolved mentions must stop
// the request; they are never silently dropped.
function analyzePeriods(message, { now = new Date() } = {}) {
  const text = thaiDigitsToArabic(String(message == null ? '' : message));
  if (!text.trim()) return { windows: [], unresolved: [], comparison: false };
  const comparison = COMPARISON_RE.test(text);
  const windows = [];
  const unresolved = [];
  const claimed = [];
  const claim = (start, end) => {
    for (const span of claimed) if (start < span.end && end > span.start) return false;
    claimed.push({ start, end });
    return true;
  };
  for (const pattern of PATTERNS) {
    const re = new RegExp(pattern.re.source, pattern.re.flags.includes('g') ? pattern.re.flags : pattern.re.flags + 'g');
    let match;
    while ((match = re.exec(text)) !== null) {
      if (!claim(match.index, match.index + match[0].length)) continue;
      if (pattern.kind === 'last_n') {
        const inner = LAST_N_RE.exec(match[0]);
        if (!inner) { unresolved.push(match[0]); continue; }
        const n = /^\d+$/.test(inner[1]) ? Number(inner[1]) : parseThaiNumberWord(inner[1]);
        const unit = inner[2];
        if (!Number.isFinite(n) || n < 1) { unresolved.push(match[0]); continue; }
        if (n > UNIT_CAP[unit]) { unresolved.push(match[0]); continue; }
        const window = buildWindow('last_n', n, unit, now);
        if (!window) { unresolved.push(match[0]); continue; }
        windows.push({ from: window.from, to: window.to, label: rangeLabel('last_n', n, unit, window.fromParts, window.toParts, window.todayParts), matchedText: match[0] });
        continue;
      }
      const window = buildWindow(pattern.kind, null, null, now);
      if (!window) { unresolved.push(match[0]); continue; }
      windows.push({ from: window.from, to: window.to, label: rangeLabel(pattern.kind, null, null, window.fromParts, window.toParts, window.todayParts), matchedText: match[0] });
    }
  }
  const monthMatch = resolveNamedMonth(text, now);
  if (monthMatch) {
    const span = /(?:เดือน\s*)?(?:มกราคม|กุมภาพันธ์|มีนาคม|เมษายน|พฤษภาคม|มิถุนายน|กรกฎาคม|สิงหาคม|กันยายน|ตุลาคม|พฤศจิกายน|ธันวาคม|ม\.ค\.|ก\.พ\.|มี\.ค\.|เม\.ย\.|พ\.ค\.|มิ\.ย\.|ก\.ค\.|ส\.ค\.|ก\.ย\.|ต\.ค\.|พ\.ย\.|ธ\.ค\.)(?:\s*ปี\s*)?\d{0,4}/u.exec(text);
    const start = span ? span.index : 0;
    const end = span ? span.index + span[0].length : text.length;
    if (claim(start, end)) {
      if (monthMatch.unsupported) unresolved.push(span ? span[0] : text);
      else windows.push({ ...monthMatch.window, label: monthMatch.label, matchedText: span ? span[0] : text });
    }
  }
  return { windows, unresolved, comparison };
}

// Back-compat single-window API: the first resolvable window, or null.
function extractTimeWindow(message, options) {
  const analysis = analyzePeriods(message, options);
  return analysis.windows[0] || null;
}

function hasHardTimeReference(message) {
  return HARD_TIME_RE.test(thaiDigitsToArabic(String(message == null ? '' : message)));
}

module.exports = { analyzePeriods, extractTimeWindow, hasHardTimeReference, parseThaiNumberWord };
