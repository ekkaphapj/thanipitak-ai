'use strict';

const { detectLocationGroup, normalizeSpokenConnectors } = require('./spokenGeo');
const { mergeTopicFilters, wantsExplicitAllList, listClarify } = require('./conversationTopic');
const { detectOverview } = require('../services/overviewService');

const PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;

const HARD_COMPLEX_TERMS = [
  'ประวัติ',
  'เยี่ยม',
  'ปัสสาวะ',
  'ตรวจ',
  'ฉี่',
  'ซ้ำ',
  'เปรียบเทียบ',
  'เทียบ',
  'วิเคราะห์',
  'สมมติ',
  'admin',
  'ทุกสถานี',
  'ทั้งระบบ',
  'ข้ามสถานี',
];

const LATE_COMPLEX_TERMS = [
  'ใช่ไหม',
  'ใช่หรือไม่',
  'ควร',
  'พิเศษ',
];

const LIST_INTENT_PHRASES = [
  'รายชื่อ',
  'แสดงรายชื่อ',
  'มีใครบ้าง',
  'คนไหนบ้าง',
];

const COUNT_INTENTS = [
  'count_psychiatric',
  'count_drug_user',
  'count_dealer',
  'count_released',
  'count_total',
  'statistics_summary',
];

const COUNT_TYPE = {
  count_psychiatric: 'psychiatric',
  count_drug_user: 'drug_user',
  count_dealer: 'dealer',
  count_released: 'released',
  count_total: null,
};

const LIST_TYPE = {
  list_psychiatric: 'psychiatric',
  list_drug_user: 'drug_user',
  list_dealer: 'dealer',
  list_released: 'released',
  list_all: null,
};

const TYPE_LABELS = {
  psychiatric: 'ผู้ป่วยจิตเวช',
  drug_user: 'ผู้เสพ',
  dealer: 'ผู้ค้า',
  released: 'ผู้พ้นโทษ',
};

function presenceAnswer(label, total) {
  const count = Number(total) || 0;
  if (count <= 0) return `ไม่มี${label}`;
  return `มี${label} ${count} คน`;
}

const COUNT_ANSWERS = {
  count_psychiatric: (d) => presenceAnswer('ผู้ป่วยจิตเวช', d.psychiatric),
  count_drug_user: (d) => presenceAnswer('ผู้เสพ', d.drug_user),
  count_dealer: (d) => presenceAnswer('ผู้ค้า', d.dealer),
  count_released: (d) => presenceAnswer('ผู้พ้นโทษ', d.released),
  count_total: (d) => presenceAnswer('บุคคล', d.total),
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
const SEARCH_FIELD_BOUNDARY = '(?=\\s*(?:ใน?จังหวัด|จังหวัด|จ\\.|สภ\\.?|สถานี|อำเภอ|เขต|ตำบล|ชื่อ(?:ว่า)?|ผู้ป่วย|จิตเวช|ผู้เสพ|คนเสพ|ผู้ค้า|ผู้พ้นโทษ|กำลังติดตาม|ต้องติดตาม|ค้างติดตาม|เสร็จสิ้น|ทั้งหมด|ในพื้นที่|ของฉัน|ให้หน่อย|มากที่สุด|น้อยที่สุด|เรียงตาม|แยกตาม|มี|$)|กี่)';
const GROUP_LABELS = { subdistrict: 'ตำบล', district: 'อำเภอ', station: 'สภ.', province: 'จังหวัด' };

function cleanPlaceValue(value) {
  if (!value) return null;
  const trimmed = value.trim().replace(/(?:ให้หน่อย|หน่อย|ที|ครับ|ค่ะ|นะ)$/u, '').trim();
  if (!trimmed) return null;
  if (/ไหน|ใด|อะไร|มากที่สุด|เยอะที่สุด|น้อยที่สุด|มากสุด|เยอะสุด|น้อยสุด|เรียงตาม|แยกตาม|แจกแจง/.test(trimmed)) return null;
  return trimmed;
}

function extractSpokenField(text, labels) {
  const label = labels.map((item) => item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const match = text.match(new RegExp(`(?:${label})\\s*([^,]+?)${SEARCH_FIELD_BOUNDARY}`, 'u'));
  return cleanPlaceValue(match && match[1]);
}

function detectMentionedTypes(text) {
  const types = [];
  let barePsychiatric = false;
  if (/ผู้ป่วยจิตเวช|คนไข้จิตเวช|จิตเวช/.test(text)) types.push('psychiatric');
  else if (/ผู้ป่วย|คนไข้/.test(text)) {
    types.push('psychiatric');
    barePsychiatric = true;
  }
  if (/ผู้ใช้ยาเสพติด|คนใช้ยา|ผู้เสพ|คนเสพ/.test(text) || (/ยาเสพติด/.test(text) && !/จิตเวช/.test(text))) {
    types.push('drug_user');
  }
  if (/ผู้จำหน่าย|คนขายยา|พ่อค้ายา|ผู้ค้า/.test(text)) types.push('dealer');
  if (/ออกจากเรือนจำ|ออกจากคุก|ผู้พ้นโทษ|พ้นโทษ/.test(text)) types.push('released');
  return { types, barePsychiatric };
}

function extractLookupFilters(text) {
  const { types, barePsychiatric } = detectMentionedTypes(text);
  const filters = {};
  if (types.length === 1) filters.person_type = types[0];
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
  const name = extractSpokenField(text.replace(/รายชื่อ/g, ' '), ['ชื่อว่า', 'ชื่อ']);
  if (province) filters.province = province;
  if (station) filters.station = station;
  if (district) filters.district = district;
  if (subdistrict) filters.subdistrict = subdistrict;
  if (name) filters.query = name;
  return { filters, types, barePsychiatric };
}

function hasExtraFilters(filters) {
  return Boolean(filters && (filters.province || filters.station || filters.district || filters.subdistrict || filters.status || filters.query));
}

function detectSpokenPersonSearch(message) {
  const text = normalizeSpokenConnectors(message);
  if (!SEARCH_ACTION_RE.test(text)) return null;

  const { filters } = extractLookupFilters(text);

  if (!filters.query) {
    const rest = text.replace(SEARCH_ACTION_RE, '').trim();
    const named = rest.match(new RegExp(`^(นาย|นางสาว|นาง|ด\\.ช\\.|ด\\.ญ\\.)\\s*([^,]+?)${SEARCH_FIELD_BOUNDARY}`, 'u'));
    if (named) filters.query = (named[1] + named[2]).trim();
  }

  if (Object.keys(filters).length === 1 && filters.person_type && /หา\s*ผู้/u.test(text)) return null;

  const trailing = text.replace(/[,.]+$/u, '').trim();
  const incomplete = Object.keys(filters).length === 0 ||
    /(?:ใน?จังหวัด|จังหวัด|จ\.|สภ\.?|สถานี|อำเภอ|เขต|ตำบล|ชื่อ(?:ว่า)?)\s*$/u.test(trailing);
  return { intent: incomplete ? 'search_incomplete' : 'search_persons', filters };
}

function filterLabels(filters, { barePsychiatric } = {}) {
  const labels = [];
  if (barePsychiatric) labels.push('คำว่า “ผู้ป่วย” ในคำถามนี้หมายถึงผู้ป่วยจิตเวช');
  const type = SEARCH_TYPE_MARKERS.find((item) => item.type === filters.person_type);
  if (type && !barePsychiatric) labels.push(type.words[0]);
  if (filters.status === 'followup') labels.push('ต้องติดตาม');
  if (filters.status === 'active') labels.push('กำลังติดตาม');
  if (filters.status === 'completed') labels.push('เสร็จสิ้น');
  if (filters.status === 'registered') labels.push('ขึ้นทะเบียน');
  if (filters.province) labels.push(`จังหวัด${filters.province}`);
  if (filters.station) labels.push(`สภ.${filters.station.replace(/^สภ\.?\s*/u, '')}`);
  if (filters.district) labels.push(`อำเภอ${filters.district}`);
  if (filters.subdistrict) labels.push(`ตำบล${filters.subdistrict}`);
  if (filters.query) labels.push(`ชื่อ ${filters.query}`);
  return labels;
}

function spokenSearchAnswer(total, filters, extras) {
  const labels = filterLabels(filters, extras);
  return `พบ ${total} คน${labels.length ? ' ตามเงื่อนไข: ' + labels.join(' • ') : ''}`;
}

function countAnswer(type, total, filters, extras) {
  const label = type ? TYPE_LABELS[type] : 'บุคคล';
  const labels = filterLabels(filters, extras);
  const presence = presenceAnswer(label, total);
  if (!labels.length) return presence;
  if (!total) return `ตามเงื่อนไข: ${labels.join(' • ')} ${presence}`;
  return `ตามเงื่อนไข: ${labels.join(' • ')} ${presence}`;
}

function hasCountAsk(text) {
  return /กี่\s*(?:คน|ราย)|ทั้งหมด\s*กี่|มีทั้งหมด|ขอยอด|มียอด|ยอดเท่าไหร่|มีจำนวนเท่าไหร่/.test(text);
}

function hasExistenceAsk(text) {
  return /มี(?:อยู่)?(?:มั้ย|ไหม|มะ|ปะ|ป่าว|หรือไม่|รึเปล่า|หรือเปล่า)|(?:มั้ย|ไหม|มะ|ปะ|ป่าว|หรือไม่|รึเปล่า|หรือเปล่า)\s*(?:ครับ|ค่ะ|คะ|จ้า|นะ)?\s*$/u.test(text);
}

function detectFastPathIntent(message, topic) {
  if (!message || typeof message !== 'string') return null;
  const text = normalizeSpokenConnectors(message);
  if (!text) return null;

  const lower = text.toLowerCase();
  if (HARD_COMPLEX_TERMS.some((term) => lower.includes(term))) return null;

  const overview = detectOverview(text);
  if (overview) return { intent: 'overview', page: 1, ...overview };

  const spokenSearch = detectSpokenPersonSearch(text);
  if (spokenSearch) return { ...spokenSearch, page: 1 };

  let page = 1;
  const pageMatch = text.match(/หน้า\s*(\d+)/);
  if (pageMatch) {
    const n = Number.parseInt(pageMatch[1], 10);
    if (Number.isFinite(n) && n > 0) page = n;
  }

  const groupBy = detectLocationGroup(text);
  const { filters, types, barePsychiatric } = extractLookupFilters(text);
  if (groupBy === 'subdistrict') delete filters.subdistrict;
  if (groupBy === 'district') delete filters.district;
  if (groupBy === 'province') delete filters.province;
  if (groupBy === 'station') delete filters.station;
  if (/สถานี\s*\d+/.test(text) || /station_id/i.test(text)) return null;
  const wantsList = LIST_INTENT_PHRASES.some((p) => text.includes(p)) || /หา\s*ผู้/.test(text);
  const wantsCount = (hasCountAsk(text) || (hasExistenceAsk(text) && types.length > 0)) && !wantsList;
  const desc = !/น้อยที่สุด|น้อยสุด|น้อยไปมาก|จากน้อย|น้อยขึ้น/.test(text);
  const showAll = /เรียงตาม|แยกตาม|แจกแจง|แต่ละ/.test(text) && !/มากที่สุด|เยอะที่สุด|น้อยที่สุด|มากสุด|เยอะสุด|น้อยสุด/.test(text);

  if (groupBy && (wantsCount || /ไหน|ใด|อะไรบ้าง|มากที่สุด|เยอะที่สุด|น้อยที่สุด|มากสุด|เยอะสุด|น้อยสุด|เรียงตาม|แยกตาม|แจกแจง|แต่ละ/.test(text))) {
    if (types.length > 1) {
      return {
        intent: 'lookup_clarify',
        page,
        answer: 'คำถามระบุมากกว่าหนึ่งประเภทบุคคล กรุณาถามทีละประเภท เช่น ผู้ป่วยจิตเวช หรือผู้เสพ',
      };
    }
    return {
      intent: 'group_persons',
      page,
      filters,
      groupBy,
      direction: desc ? 'desc' : 'asc',
      showAll,
      barePsychiatric,
    };
  }

  if (/สรุปจำนวน/.test(text) && /แยกตาม/.test(text) && /ประเภท/.test(text) && !groupBy) {
    return { intent: 'statistics_summary', page };
  }

  if (types.length > 1 && wantsCount) {
    return { intent: 'statistics_summary', page, mentionedTypes: types };
  }

  if (wantsCount) {
    if (types.length === 1) {
      return {
        intent: `count_${types[0]}`,
        page,
        filters: mergeTopicFilters(filters, topic),
        barePsychiatric,
      };
    }
    if (topic && Array.isArray(topic.person_types) && topic.person_types.length > 1 && !/ทั้งหมด|ทุกประเภท/.test(text)) {
      return listClarify(topic);
    }
    if (topic && topic.person_type && !/ทั้งหมด|ทุกประเภท|ทุกคน/.test(text)) {
      return {
        intent: `count_${topic.person_type}`,
        page,
        filters: mergeTopicFilters(filters, topic),
        barePsychiatric: topic.barePsychiatric || false,
      };
    }
    if (/ทั้งหมด|ในพื้นที่|บุคคล|คนทั้งหมด|มีกี่/.test(text) || /กี่\s*(?:คน|ราย)/.test(text)) {
      return { intent: 'count_total', page, filters: mergeTopicFilters(filters, topic) };
    }
  }

  if (wantsList) {
    if (!topic && /^(?:ขอ|แสดง)?\s*รายชื่อ(?:หน่อย|ด้วย|ครับ|ค่ะ)?$/.test(text)) {
      return {intent:'lookup_clarify',page,answer:'ต้องการรายชื่อแบบใดครับ? เลือกได้เลย',presentation:{type:'summary_choices',choices:[
        {label:'1. รายชื่อทั้งหมด',message:'ขอรายชื่อทั้งหมด'},
        {label:'2. แยกประเภทบุคคล',message:'ขอรายชื่อแยกตามประเภทบุคคล'},
        {label:'3. แยกตามพื้นที่',message:'ขอรายชื่อแยกตามพื้นที่'},
      ]}};
    }
    if (/รายชื่อ.*แยก.*ประเภท/.test(text)) {
      return {intent:'lookup_clarify',page,answer:'กรุณาเลือกประเภทบุคคล',presentation:{type:'summary_choices',choices:Object.entries(TYPE_LABELS).map(([type,label])=>({label:`รายชื่อ${label}`,message:`ขอรายชื่อ${label}`}))}};
    }
    if (/รายชื่อ.*แยก.*พื้นที่/.test(text)) {
      return {intent:'lookup_clarify',page,answer:'กรุณาระบุพื้นที่ เช่น “ขอรายชื่อในตำบลโพนสูง” หรือ “ขอรายชื่อในอำเภอบ้านดุง”'};
    }
    if (types.length > 1) {
      return {
        intent: 'lookup_clarify',
        page,
        answer: 'คำถามระบุมากกว่าหนึ่งประเภทบุคคล กรุณาถามทีละประเภท เช่น ผู้ป่วยจิตเวช หรือผู้เสพ',
      };
    }
    if (types[0]) {
      return { intent: `list_${types[0]}`, page, filters: mergeTopicFilters(filters, topic), barePsychiatric };
    }
    if (wantsExplicitAllList(text, types)) {
      return { intent: 'list_all', page, filters: mergeTopicFilters(filters, topic) };
    }
    if (topic && Array.isArray(topic.person_types) && topic.person_types.length > 1) {
      return listClarify(topic);
    }
    if (topic && topic.person_type) {
      return {
        intent: `list_${topic.person_type}`,
        page,
        filters: mergeTopicFilters(filters, topic),
        barePsychiatric: topic.barePsychiatric || false,
      };
    }
    return { intent: 'list_all', page, filters, barePsychiatric };
  }

  if (LATE_COMPLEX_TERMS.some((term) => lower.includes(term))) return null;
  return null;
}

function formatGroupName(groupBy, row) {
  const label = GROUP_LABELS[groupBy] || '';
  const raw = row.name || '';
  const prefixed = raw.startsWith(label) ? raw : `${label}${raw}`;
  if (groupBy === 'subdistrict' && (row.district || row.province)) {
    return `${prefixed} (${row.district} ${row.province})`.replace(/\s+/g, ' ').trim();
  }
  if ((groupBy === 'district' || groupBy === 'station') && row.province) {
    return `${prefixed} (${row.province})`;
  }
  return prefixed;
}

function renderGroupAnswer(result, options) {
  const groupBy = options.groupBy;
  const label = GROUP_LABELS[groupBy] || 'พื้นที่';
  const type = options.filters && options.filters.person_type;
  const category = type ? TYPE_LABELS[type] : 'บุคคล';
  const sorted = [...result.groups].sort((a, b) => {
    const diff = options.direction === 'asc' ? a.count - b.count : b.count - a.count;
    return diff || a.name.localeCompare(b.name, 'th');
  });
  const rows = options.showAll ? sorted : sorted.filter((row) => row.count === sorted[0]?.count);
  const notes = [];
  if (options.barePsychiatric) notes.push('คำว่า “ผู้ป่วย” ในคำถามนี้หมายถึงผู้ป่วยจิตเวช');
  notes.push(...filterLabels(options.filters || {}, { barePsychiatric: false }).filter((item) => item !== TYPE_LABELS[type]));
  const heading = `นับ${category}จากทะเบียนทั้งหมด ${result.total} คน`;
  const scope = notes.length ? `ตามเงื่อนไข: ${notes.join(' • ')}\n` : '';
  const body = rows.length
    ? rows.map((row, index) => `${index + 1}. ${formatGroupName(groupBy, row)} — ${row.count} คน`).join('\n')
    : `ไม่พบข้อมูล${label}ที่จัดอันดับได้`;
  const extra = [];
  if (!options.showAll && rows.length > 1) extra.push('มีหลายพื้นที่จำนวนเท่ากัน');
  if (result.missing) extra.push(`อีก ${result.missing} คนไม่ระบุ${label} จึงไม่รวมในอันดับ`);
  if (options.direction === 'asc') extra.push('อันดับนี้รวมเฉพาะพื้นที่ที่มีบุคคลในทะเบียน');
  return `${scope}${heading}\n${options.showAll ? `เรียง${options.direction === 'asc' ? 'น้อยไปมาก' : 'มากไปน้อย'}\n` : ''}${body}${extra.length ? `\n${extra.join('\n')}` : ''}`;
}

async function runFastPath(intent, currentUser, toolRouter, options = {}) {
  if (intent === 'overview') {
    const args = { requestedScope: options.requestedScope || 'current', filters: options.filters || {} };
    const result = await toolRouter.execute('get_overview', args, currentUser);
    if (result.error || !result.answer) return { ok: false };
    return { ok: true, answer: result.answer, toolsUsed: ['get_overview'], toolArgs: args, grounded: true, presentation: result.presentation };
  }
  if (intent === 'lookup_clarify') {
    return {
      ok: true,
      answer: options.answer || 'กรุณาระบุประเภทบุคคลที่ต้องการดู',
      toolsUsed: [],
      toolArgs: {},
      grounded: true,
      presentation: options.presentation || null,
    };
  }
  if (intent === 'search_incomplete') {
    return {
      ok: true,
      answer: SEARCH_INCOMPLETE_ANSWER,
      toolsUsed: [],
      toolArgs: {},
      grounded: true,
      presentation: null,
    };
  }

  const spokenFilters = options.filters || {};
  if (intent === 'group_persons') {
    const args = { groupBy: options.groupBy };
    if (spokenFilters.person_type) args.person_type = spokenFilters.person_type;
    for (const field of ['status', 'province', 'station', 'district', 'subdistrict', 'query']) {
      if (spokenFilters[field]) args[field === 'query' ? 'search' : field] = spokenFilters[field];
    }
    const result = toolRouter.groupPersons(currentUser, args);
    if (!result || result.groupBy == null) return { ok: false };
    return {
      ok: true,
      answer: renderGroupAnswer(result, options),
      toolsUsed: ['group_persons'],
      toolArgs: args,
      grounded: true,
      presentation: {
        type: 'location_summary',
        groupBy: result.groupBy,
        total: result.total,
        missing: result.missing,
        items: result.groups,
        filters: { person_type: spokenFilters.person_type || null, ...spokenFilters },
      },
    };
  }

  const extra = hasExtraFilters(spokenFilters);
  if (COUNT_INTENTS.includes(intent) && !extra) {
    const result = await toolRouter.execute('get_statistics', {}, currentUser);
    if (result.error || !result.data) {
      return { ok: false };
    }
    if (intent === 'statistics_summary' && Array.isArray(options.mentionedTypes) && options.mentionedTypes.length > 1) {
      const parts = options.mentionedTypes.map((type) => `${TYPE_LABELS[type]} ${result.data[type] || 0} คน`);
      return {
        ok: true,
        answer: `ในพื้นที่รับผิดชอบ ${parts.join(' • ')}`,
        toolsUsed: ['get_statistics'],
        toolArgs: {},
        grounded: true,
        presentation: null,
      };
    }
    const answer = COUNT_ANSWERS[intent](result.data);
    return {
      ok: true,
      answer: options.barePsychiatric
        ? `${answer}\nคำว่า “ผู้ป่วย” ในคำถามนี้หมายถึงผู้ป่วยจิตเวช`
        : answer,
      toolsUsed: ['get_statistics'],
      toolArgs: {},
      grounded: true,
      presentation: null,
    };
  }

  if (COUNT_INTENTS.includes(intent) && extra && intent !== 'statistics_summary') {
    const personType = COUNT_TYPE[intent];
    const args = { limit: 1, offset: 0 };
    if (personType) args.person_type = personType;
    for (const field of ['status', 'province', 'station', 'district', 'subdistrict', 'query']) {
      if (spokenFilters[field]) args[field] = spokenFilters[field];
    }
    const result = await toolRouter.execute('search_persons', args, currentUser);
    if (result.error || !Number.isFinite(result.total)) return { ok: false };
    return {
      ok: true,
      answer: countAnswer(personType, result.total, { ...spokenFilters, person_type: personType }, { barePsychiatric: options.barePsychiatric }),
      toolsUsed: ['search_persons'],
      toolArgs: args,
      grounded: true,
      presentation: null,
    };
  }

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

  const listIntent = LIST_ANSWERS[intent] ? intent : 'search_persons';
  return {
    ok: true,
    answer: listIntent === 'search_persons' || extra
      ? spokenSearchAnswer(result.total, { ...spokenFilters, person_type: personType }, { barePsychiatric: options.barePsychiatric })
      : LIST_ANSWERS[intent](result.total),
    toolsUsed: ['search_persons'],
    toolArgs: args,
    grounded: true,
    presentation: {
      type: 'person_list',
      total: result.total,
      returned: items.length,
      page,
      pageSize: limit,
      filters: {
        person_type: personType || null,
        status: spokenFilters.status || null,
        province: spokenFilters.province || null,
        station: spokenFilters.station || null,
        district: spokenFilters.district || null,
        subdistrict: spokenFilters.subdistrict || null,
      },
      items,
    },
  };
}

const SEARCH_INCOMPLETE_ANSWER = 'เงื่อนไขค้นหาไม่สมบูรณ์ กรุณาลองใหม่ เช่น “หาผู้เสพในอำเภอเมือง” หรือ “ค้นหาคนชื่อสมชาย”';

module.exports = {
  detectFastPathIntent,
  detectSpokenPersonSearch,
  extractLookupFilters,
  runFastPath,
  PAGE_SIZE,
  MAX_PAGE_SIZE,
  SEARCH_INCOMPLETE_ANSWER,
};
