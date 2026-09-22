'use strict';

// Deterministic Thai time-window extraction. No model and no registry access:
// explicit relative phrases are converted to Asia/Bangkok calendar boundaries
// so recorded-visit reads can be filtered server-side. Anything that mentions
// a period this parser cannot resolve must stay unsupported upstream — never
// silently drop a time condition and answer the broader question.

const MONTHS_TH = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
const MONTHS_TH_SHORT = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
const THAI_NUMBER_WORDS = {
  หนึ่ง: 1, สอง: 2, สาม: 3, สี่: 4, ห้า: 5, หก: 6, เจ็ด: 7, แปด: 8, เก้า: 9,
  สิบ: 10, สิบเอ็ด: 11, 'สิบสอง': 12, 'สิบสาม': 13, 'สิบสี่': 14, 'สิบห้า': 15,
  'สิบหก': 16, 'สิบเจ็ด': 17, 'สิบแปด': 18, 'สิบเก้า': 19, ยี่สิบ: 20, ยี่สิบสี่: 24,
  สามสิบ: 30, 'สามสิบห้า': 35, หกสิบ: 60, 'เก้าสิบ': 90, 'หนึ่งร้อยแปดสิบ': 180,
};

const WORD_NUMBER_ALT = Object.keys(THAI_NUMBER_WORDS).join('|');
const THAI_DIGITS = { '๐': '0', '๑': '1', '๒': '2', '๓': '3', '๔': '4', '๕': '5', '๖': '6', '๗': '7', '๘': '8', '๙': '9' };

function thaiDigitsToArabic(text) {
  return String(text).replace(/[๐-๙]/g, (digit) => THAI_DIGITS[digit]);
}
const LAST_N_RE = new RegExp(`(\\d{1,3}|${WORD_NUMBER_ALT})\\s*(วัน|สัปดาห์|อาทิตย์|เดือน|ปี)\\s*(?:ล่าสุด|ที่ผ่านมา|ที่แล้ว|ก่อนหน้า?|ที่ผ่านมานี้)`, 'u');

// Ordered: multi-word phrases before their shorter prefixes.
const PATTERNS = [
  { re: /เมื่อวาน(?:นี้|กี้|เมื่อวาน)?/u, kind: 'yesterday' },
  { re: /วันนี้/u, kind: 'today' },
  { re: /(?:สัปดาห์|อาทิตย์)ที่แล้ว(?:นี้)?/u, kind: 'last_week' },
  { re: /(?:สัปดาห์|อาทิตย์)นี้/u, kind: 'this_week' },
  { re: /เดือน(?:ที่แล้ว|ก่อนหน้า?|ก่อน)(?:นี้)?/u, kind: 'last_month' },
  { re: /เดือน(?:นี้|เมื่อนี้|นี้นี้)/u, kind: 'this_month' },
  { re: /ปีที่แล้ว(?:นี้)?/u, kind: 'last_year' },
  { re: /ปีนี้/u, kind: 'this_year' },
  { re: LAST_N_RE, kind: 'last_n' },
];

const UNIT_DAYS = { วัน: 1, สัปดาห์: 7, อาทิตย์: 7, เดือน: 30, ปี: 365 };
const UNIT_CAP = { วัน: 365, สัปดาห์: 52, อาทิตย์: 52, เดือน: 24, ปี: 10 };

function bangkokToday(now) {
  const [y, m, d] = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(now).split('-').map(Number);
  return { y, m, d };
}

const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const addMonths = ({ y, m }, delta) => {
  const total = y * 12 + (m - 1) + delta;
  return { y: Math.floor(total / 12), m: ((total % 12) + 12) % 12 + 1 };
};
const shiftDays = ({ y, m, d }, delta) => {
  const date = new Date(Date.UTC(y, m - 1, d + delta));
  return { y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate() };
};

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
    default: return `${n} ${unit}ล่าสุด (${dateText(from)}–${dateText(to)})`;
  }
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
      const prev = addMonths(today, -1);
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
      if (unit === 'วัน') {
        from = shiftDays(today, -(delta - 1));
        to = today;
      } else {
        from = shiftDays(today, -delta + 1);
        to = today;
      }
      break;
    }
    default:
      return null;
  }
  return { from: iso(from.y, from.m, from.d), to: iso(to.y, to.m, to.d), fromParts: from, toParts: to, todayParts: today };
}

// Returns { from, to, label, matchedText } in Asia/Bangkok calendar terms, or
// null when the message carries no phrase this parser understands.
function extractTimeWindow(message, { now = new Date() } = {}) {
  const text = thaiDigitsToArabic(String(message == null ? '' : message));
  if (!text.trim()) return null;
  for (const pattern of PATTERNS) {
    const match = pattern.re.exec(text);
    if (!match) continue;
    let n = null;
    let unit = null;
    if (pattern.kind === 'last_n') {
      n = /^\d+$/.test(match[1]) ? Number(match[1]) : THAI_NUMBER_WORDS[match[1]];
      unit = match[2];
    }
    const window = buildWindow(pattern.kind, n, unit, now);
    if (!window) return null;
    return {
      from: window.from,
      to: window.to,
      label: rangeLabel(pattern.kind, n, unit, window.fromParts, window.toParts, window.todayParts),
      matchedText: match[0],
    };
  }
  return null;
}

// A message that clearly anchors a recorded period but that the parser could
// not resolve must not fall through to the broader question. This list is
// deliberately narrower than the parser: bare units ("อายุ 40 ปี") do not
// count as a period reference.
const HARD_TIME_RE = /เมื่อวาน|วันนี้|(?:สัปดาห์|อาทิตย์)(?:ที่แล้ว|นี้)|เดือน(?:ที่แล้ว|ก่อน|นี้)|ปี(?:ที่แล้ว|นี้)|ไตรมาส|ครึ่งปี|ต้นเดือน|ปลายเดือน|ย้อนหลัง|ตั้งแต่|ช่วงเวลา|หลายเดือน|หลายปี/u;

function hasHardTimeReference(message) {
  return HARD_TIME_RE.test(thaiDigitsToArabic(String(message == null ? '' : message)));
}

module.exports = { extractTimeWindow, hasHardTimeReference };
