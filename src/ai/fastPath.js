'use strict';

const PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;

const COMPLEX_TERMS = [
  'ประวัติ',
  'เยี่ยม',
  'ปัสสาวะ',
  'ตรวจ',
  'ฉี่',
  'ซ้ำ',
  'และ',
  'หรือ',
  'เปรียบเทียบ',
  'เทียบ',
  'คนที่',
  'หาคน',
  'สมมติ',
  'admin',
  'ทุกสถานี',
  'ทั้งระบบ',
  'ข้ามสถานี',
  'ใช่ไหม',
  'ใช่หรือไม่',
  'ติดตาม',
  'ควร',
  'วิเคราะห์',
  'พิเศษ',
];

// Semantic components for conservative high-confidence list intents.
const LIST_INTENT_PHRASES = [
  'รายชื่อ',
  'แสดงรายชื่อ',
  'มีใครบ้าง',
  'คนไหนบ้าง',
];

const PERSON_TYPE_MARKERS = [
  { type: 'psychiatric', keywords: ['ผู้ป่วยจิตเวช'], listIntent: 'list_psychiatric' },
  { type: 'drug_user', keywords: ['ผู้เสพ'], listIntent: 'list_drug_user' },
  { type: 'dealer', keywords: ['ผู้ค้า'], listIntent: 'list_dealer' },
  { type: 'released', keywords: ['ผู้พ้นโทษ'], listIntent: 'list_released' },
];

const COUNT_INTENTS = ['count_psychiatric', 'count_drug_user', 'count_dealer', 'count_total', 'statistics_summary'];

const LIST_TYPE = {
  list_psychiatric: 'psychiatric',
  list_drug_user: 'drug_user',
  list_dealer: 'dealer',
  list_released: 'released',
  list_all: null,
};

const COUNT_ANSWERS = {
  count_psychiatric: (d) => `ในพื้นที่รับผิดชอบมีผู้ป่วยจิตเวชทั้งหมด ${d.psychiatric} คน`,
  count_drug_user: (d) => `ในพื้นที่รับผิดชอบมีผู้เสพทั้งหมด ${d.drug_user} คน`,
  count_dealer: (d) => `ในพื้นที่รับผิดชอบมีผู้ค้าทั้งหมด ${d.dealer} คน`,
  count_total: (d) => `ในพื้นที่รับผิดชอบมีบุคคลทั้งหมด ${d.total} คน`,
  statistics_summary: (d) =>
    `สรุปจำนวนบุคคลแยกตามประเภท: ทั้งหมด ${d.total} คน • จิตเวช ${d.psychiatric} คน • ผู้เสพ ${d.drug_user} คน • ผู้ค้า ${d.dealer} คน` + (d.released ? ` • ผู้พ้นโทษ ${d.released} คน` : ''),
};

const LIST_ANSWERS = {
  list_psychiatric: (total) => `พบผู้ป่วยจิตเวชทั้งหมด ${total} คน`,
  list_drug_user: (total) => `พบผู้เสพทั้งหมด ${total} คน`,
  list_dealer: (total) => `พบผู้ค้าทั้งหมด ${total} คน`,
  list_released: (total) => `พบผู้พ้นโทษทั้งหมด ${total} คน`,
  list_all: (total) => `พบบุคคลทั้งหมด ${total} คน โดยแสดงรายการครั้งละ ${PAGE_SIZE} คน`,
};

const SEARCH_ACTION_RE = /^(?:ช่วย\s*)?(?:ค้นหา|ค้น|หา)(?:\s*(?:บุคคล|คน|รายชื่อ))?\s*/;
const SEARCH_TYPE_MARKERS = [
  { type: 'psychiatric', words: ['ผู้ป่วยจิตเวช', 'คนไข้จิตเวช', 'จิตเวช', 'ผู้ป่วย'] },
  { type: 'drug_user', words: ['ผู้ใช้ยาเสพติด', 'คนใช้ยา', 'ผู้เสพ', 'คนเสพ', 'ยาเสพติด'] },
  { type: 'dealer', words: ['ผู้จำหน่าย', 'คนขายยา', 'พ่อค้ายา', 'ผู้ค้า'] },
  { type: 'released', words: ['ออกจากเรือนจำ', 'ออกจากคุก', 'ผู้พ้นโทษ', 'พ้นโทษ'] },
];
const SEARCH_STATUS_MARKERS = [
  { status: 'followup', words: ['ค้างติดตาม', 'ต้องติดตาม'] },
  { status: 'active', words: ['กำลังติดตาม', 'ยังติดตาม'] },
  { status: 'completed', words: ['เสร็จสิ้น', 'จบแล้ว', 'ยุติแล้ว'] },
  { status: 'registered', words: ['ขึ้นทะเบียน'] },
];
const SEARCH_FIELD_BOUNDARY = '(?=\\s*(?:ใน?จังหวัด|จังหวัด|จ\\.|สภ\\.?|สถานี|อำเภอ|เขต|ตำบล|ชื่อ(?:ว่า)?|ผู้ป่วย|จิตเวช|ผู้เสพ|คนเสพ|ผู้ค้า|ผู้พ้นโทษ|กำลังติดตาม|ต้องติดตาม|ค้างติดตาม|เสร็จสิ้น|$))';

function extractSpokenField(text, labels) {
  const label = labels.map((item) => item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const match = text.match(new RegExp(`(?:${label})\\s*([^,]+?)${SEARCH_FIELD_BOUNDARY}`, 'u'));
  return match && match[1] ? match[1].trim().replace(/(?:ให้หน่อย|หน่อย|ที|ครับ|ค่ะ|นะ)$/u, '').trim() : null;
}

function detectSpokenPersonSearch(message) {
  const text = message.replace(/\s+/g, ' ').trim();
  if (!SEARCH_ACTION_RE.test(text)) return null;

  const filters = {};
  for (const marker of SEARCH_TYPE_MARKERS) {
    if (marker.words.some((word) => text.includes(word))) {
      filters.person_type = marker.type;
      break;
    }
  }
  for (const marker of SEARCH_STATUS_MARKERS) {
    if (marker.words.some((word) => text.includes(word))) {
      filters.status = marker.status;
      break;
    }
  }

  const province = extractSpokenField(text, ['ในจังหวัด', 'จังหวัด', 'จ.']);
  const station = extractSpokenField(text, ['สภ.', 'สภ', 'สถานี']);
  const district = extractSpokenField(text, ['อำเภอ', 'เขต']);
  const subdistrict = extractSpokenField(text, ['ตำบล']);
  const name = extractSpokenField(text, ['ชื่อว่า', 'ชื่อ']);
  if (province) filters.province = province;
  if (station) filters.station = station;
  if (district) filters.district = district;
  if (subdistrict) filters.subdistrict = subdistrict;
  if (name) filters.query = name;

  // “หานายสมชาย” is a common spoken shorthand for “หาคนชื่อนายสมชาย”.
  if (!filters.query) {
    const rest = text.replace(SEARCH_ACTION_RE, '').trim();
    const named = rest.match(new RegExp(`^(นาย|นางสาว|นาง|ด\\.ช\\.|ด\\.ญ\\.)\\s*([^,]+?)${SEARCH_FIELD_BOUNDARY}`, 'u'));
    if (named) filters.query = (named[1] + named[2]).trim();
  }

  // Preserve the established type-only list intents (for example
  // “หาผู้เสพ”) while using the richer intent as soon as another condition
  // is supplied.
  if (Object.keys(filters).length === 1 && filters.person_type && /หา\s*ผู้/u.test(text)) return null;

  const trailing = text.replace(/[,.]+$/u, '').trim();
  const incomplete = Object.keys(filters).length === 0 ||
    /(?:ใน?จังหวัด|จังหวัด|จ\.|สภ\.?|สถานี|อำเภอ|เขต|ตำบล|ชื่อ(?:ว่า)?)\s*$/u.test(trailing);
  return { intent: incomplete ? 'search_incomplete' : 'search_persons', filters };
}

function spokenSearchAnswer(total, filters) {
  const labels = [];
  const type = SEARCH_TYPE_MARKERS.find((item) => item.type === filters.person_type);
  if (type) labels.push(type.words[0]);
  if (filters.province) labels.push(`จังหวัด${filters.province}`);
  if (filters.station) labels.push(`สภ.${filters.station.replace(/^สภ\.?\s*/u, '')}`);
  if (filters.district) labels.push(`อำเภอ${filters.district}`);
  if (filters.subdistrict) labels.push(`ตำบล${filters.subdistrict}`);
  if (filters.query) labels.push(`ชื่อ ${filters.query}`);
  return `พบ ${total} คน${labels.length ? ' ตามเงื่อนไข: ' + labels.join(' • ') : ''}`;
}

function detectFastPathIntent(message) {
  if (!message || typeof message !== 'string') return null;
  const text = message.replace(/\s+/g, ' ').trim();
  if (!text) return null;

  const lower = text.toLowerCase();
  // These need joins, histories, or reasoning beyond the supported filters.
  // Keep them on the existing reliable tool/model path instead of treating
  // them as an incomplete ordinary search.
  if (['ประวัติ', 'เยี่ยม', 'ปัสสาวะ', 'ฉี่', 'ซ้ำ', 'และ', 'หรือ', 'เปรียบเทียบ', 'เทียบ', 'วิเคราะห์'].some((term) => lower.includes(term))) return null;
  const spokenSearch = detectSpokenPersonSearch(text);
  if (spokenSearch) return { ...spokenSearch, page: 1 };
  if (COMPLEX_TERMS.some((t) => lower.includes(t))) return null;

  let page = 1;
  const pageMatch = text.match(/หน้า\s*(\d+)/);
  if (pageMatch) {
    const n = Number.parseInt(pageMatch[1], 10);
    if (Number.isFinite(n) && n > 0) page = n;
  }

  const intent = matchCountIntent(text) || matchStatisticsIntent(text) || matchListIntent(text);
  if (!intent) return null;
  return { intent, page };
}

function matchCountIntent(text) {
  const countTail = String.raw`\s*(?:มี\s+)?(?:ทั้งหมด\s+)?กี่`;
  if (new RegExp(`ผู้ป่วยจิตเวช${countTail}`).test(text)) return 'count_psychiatric';
  if (new RegExp(`ผู้เสพ${countTail}`).test(text)) return 'count_drug_user';
  if (new RegExp(`ผู้ค้า${countTail}`).test(text)) return 'count_dealer';
  if (/ทั้งหมด\s*กี่/.test(text)) return 'count_total';
  return null;
}

function isTypeBreakdownRequest(text) {
  if (/แยกตาม(?:ตำบล|อำเภอ|จังหวัด)/u.test(text)) return false;
  if (/แยกตาม(?:ประเภท|ประเภทบุคคล)/u.test(text)) return true;
  if (/สรุปจำนวน/u.test(text) && /แยกตาม/u.test(text)) return true;
  return false;
}

function matchStatisticsIntent(text) {
  if (isTypeBreakdownRequest(text)) return 'statistics_summary';
  return null;
}

function matchListIntent(text) {
  const hasListPhrase =
    LIST_INTENT_PHRASES.some((p) => text.includes(p)) ||
    /หา\s*ผู้/.test(text);

  if (hasListPhrase) {
    for (const marker of PERSON_TYPE_MARKERS) {
      if (marker.keywords.some((k) => text.includes(k))) return marker.listIntent;
    }
    // A bare request such as “ขอรายชื่อ” is an unambiguous request for the
    // authorized station's person list. It must not wait for Ollama merely
    // because the earlier turn supplied the count rather than a type filter.
    return 'list_all';
  }

  return null;
}

async function runFastPath(intent, currentUser, toolRouter, options = {}) {
  if (intent === 'search_incomplete') {
    return {
      ok: true,
      answer: 'เงื่อนไขค้นหาไม่สมบูรณ์ กรุณาลองใหม่ เช่น “หาผู้เสพในอำเภอเมือง” หรือ “ค้นหาคนชื่อสมชาย”',
      toolsUsed: [],
      toolArgs: {},
      grounded: true,
      presentation: null,
    };
  }
  if (COUNT_INTENTS.includes(intent)) {
    const result = await toolRouter.execute('get_statistics', {}, currentUser);
    if (result.error || !result.data) {
      return { ok: false };
    }
    return {
      ok: true,
      answer: COUNT_ANSWERS[intent](result.data),
      toolsUsed: ['get_statistics'],
      toolArgs: {},
      grounded: true,
      presentation: null,
    };
  }

  const spokenFilters = intent === 'search_persons' ? (options.filters || {}) : {};
  const personType = intent === 'search_persons' ? spokenFilters.person_type : LIST_TYPE[intent];
  if (intent !== 'search_persons' && personType === undefined) return { ok: false };

  const page = Number.isFinite(options.page) && options.page > 0 ? Math.floor(options.page) : 1;
  const limit = PAGE_SIZE;
  const offset = (page - 1) * limit;

  const args = { limit, offset };
  if (personType) args.person_type = personType;
  for (const field of ['status', 'province', 'station', 'district', 'subdistrict', 'query']) {
    if (spokenFilters[field]) args[field] = spokenFilters[field];
  }

  const result = await toolRouter.execute('search_persons', args, currentUser);
  if (result.error || !Array.isArray(result.persons)) {
    return { ok: false };
  }

  const items = result.persons.map((p) => ({
    person_id: p.id,
    full_name: `${p.first_name} ${p.last_name}`,
    person_type: p.person_type,
    status: p.status,
    district: p.district,
    subdistrict: p.subdistrict,
  }));

  return {
    ok: true,
    answer: intent === 'search_persons' ? spokenSearchAnswer(result.total, spokenFilters) : LIST_ANSWERS[intent](result.total),
    toolsUsed: ['search_persons'],
    toolArgs: args,
    grounded: true,
    presentation: {
      type: 'person_list',
      total: result.total,
      returned: items.length,
      page,
      pageSize: limit,
      filters: { person_type: personType || null, status: spokenFilters.status || null },
      items,
    },
  };
}

module.exports = { detectFastPathIntent, detectSpokenPersonSearch, isTypeBreakdownRequest, runFastPath, PAGE_SIZE, MAX_PAGE_SIZE };
