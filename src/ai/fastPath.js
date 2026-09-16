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
];

const COUNT_INTENTS = ['count_psychiatric', 'count_drug_user', 'count_dealer', 'count_total', 'statistics_summary'];

const LIST_TYPE = {
  list_psychiatric: 'psychiatric',
  list_drug_user: 'drug_user',
  list_dealer: 'dealer',
  list_all: null,
};

const COUNT_ANSWERS = {
  count_psychiatric: (d) => `ในพื้นที่รับผิดชอบมีผู้ป่วยจิตเวชทั้งหมด ${d.psychiatric} คน`,
  count_drug_user: (d) => `ในพื้นที่รับผิดชอบมีผู้เสพทั้งหมด ${d.drug_user} คน`,
  count_dealer: (d) => `ในพื้นที่รับผิดชอบมีผู้ค้าทั้งหมด ${d.dealer} คน`,
  count_total: (d) => `ในพื้นที่รับผิดชอบมีบุคคลทั้งหมด ${d.total} คน`,
  statistics_summary: (d) =>
    `สรุปจำนวนบุคคลแยกตามประเภท: ทั้งหมด ${d.total} คน • จิตเวช ${d.psychiatric} คน • ผู้เสพ ${d.drug_user} คน • ผู้ค้า ${d.dealer} คน`,
};

const LIST_ANSWERS = {
  list_psychiatric: (total) => `พบผู้ป่วยจิตเวชทั้งหมด ${total} คน`,
  list_drug_user: (total) => `พบผู้เสพทั้งหมด ${total} คน`,
  list_dealer: (total) => `พบผู้ค้าทั้งหมด ${total} คน`,
  list_all: (total) => `พบบุคคลทั้งหมด ${total} คน โดยแสดงรายการครั้งละ ${PAGE_SIZE} คน`,
};

function detectFastPathIntent(message) {
  if (!message || typeof message !== 'string') return null;
  const text = message.replace(/\s+/g, ' ').trim();
  if (!text) return null;

  const lower = text.toLowerCase();
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
  if (/ผู้ป่วยจิตเวช\s*(?:ทั้งหมด\s*)?กี่/.test(text)) return 'count_psychiatric';
  if (/ผู้เสพ\s*(?:ทั้งหมด\s*)?กี่/.test(text)) return 'count_drug_user';
  if (/ผู้ค้า\s*(?:ทั้งหมด\s*)?กี่/.test(text)) return 'count_dealer';
  if (/ทั้งหมด\s*กี่/.test(text)) return 'count_total';
  return null;
}

function matchStatisticsIntent(text) {
  if (/สรุปจำนวน/.test(text) && /แยกตาม/.test(text)) return 'statistics_summary';
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
  }

  if (/รายชื่อ\s*(หมด|ทั้งหมด)/.test(text) || /แสดงรายชื่อ\s*(หมด|ทั้งหมด)/.test(text)) return 'list_all';
  return null;
}

async function runFastPath(intent, currentUser, toolRouter, options = {}) {
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

  const personType = LIST_TYPE[intent];
  if (personType === undefined) return { ok: false };

  const page = Number.isFinite(options.page) && options.page > 0 ? Math.floor(options.page) : 1;
  const limit = PAGE_SIZE;
  const offset = (page - 1) * limit;

  const args = { limit, offset };
  if (personType) args.person_type = personType;

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
    answer: LIST_ANSWERS[intent](result.total),
    toolsUsed: ['search_persons'],
    toolArgs: args,
    grounded: true,
    presentation: {
      type: 'person_list',
      total: result.total,
      returned: items.length,
      page,
      pageSize: limit,
      filters: { person_type: personType || null, status: null },
      items,
    },
  };
}

module.exports = { detectFastPathIntent, runFastPath, PAGE_SIZE, MAX_PAGE_SIZE };