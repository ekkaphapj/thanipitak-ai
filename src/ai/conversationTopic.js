'use strict';

const VALID_TYPES = ['psychiatric', 'drug_user', 'dealer', 'released'];
const VALID_STATUS = ['registered', 'active', 'followup', 'completed'];
const PLACE_KEYS = ['province', 'district', 'subdistrict', 'station'];
const TYPE_LABELS = {
  psychiatric: 'ผู้ป่วยจิตเวช',
  drug_user: 'ผู้เสพ',
  dealer: 'ผู้ค้า',
  released: 'ผู้พ้นโทษ',
};
const VALID_LEVELS = ['all', 'high', 'watch'];
const VALID_KINDS = ['monitoring_list', 'people_list'];
const VALID_EXCLUDE_COLUMNS = ['tambon', 'amphoe', 'station_id'];
const MAX_TOPIC_EXCLUDES = 3;
const MAX_TOPIC_EXCLUDE_IDS = 1000;

const COUNT_TYPE = {
  count_psychiatric: 'psychiatric',
  count_drug_user: 'drug_user',
  count_dealer: 'dealer',
  count_released: 'released',
};

const LIST_TYPE = {
  list_psychiatric: 'psychiatric',
  list_drug_user: 'drug_user',
  list_dealer: 'dealer',
  list_released: 'released',
};

const PERSON_TYPE_PATTERNS = [
  [/จิตเวช|ผู้ป่วย/u, 'psychiatric'],
  [/ผู้เสพ|ผู้ใช้ยา/u, 'drug_user'],
  [/ผู้ค้า|ผู้จำหน่าย/u, 'dealer'],
  [/ผู้พ้นโทษ|พ้นโทษ/u, 'released'],
];

function matchPersonType(text) {
  if (!text || typeof text !== 'string') return null;
  for (const [re, type] of PERSON_TYPE_PATTERNS) {
    if (re.test(text)) return type;
  }
  return null;
}

function cleanText(value) {
  if (typeof value !== 'string') return '';
  const text = value.trim().slice(0, 100);
  if (!text || /select\s|insert\s|drop\s|;|--/i.test(text)) return '';
  return text;
}

function cleanIsoDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

// Every topic extension is a narrowing filter or a UI marker only: the topic
// can never carry authorization data, and a forged value can shrink results
// but never widen them.
function sanitizeTopic(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const topic = {};
  if (VALID_TYPES.includes(raw.person_type)) topic.person_type = raw.person_type;
  if (Array.isArray(raw.person_types)) {
    const types = [...new Set(raw.person_types.filter((item) => VALID_TYPES.includes(item)))];
    if (types.length === 1) topic.person_type = types[0];
    else if (types.length > 1) topic.person_types = types;
  }
  if (VALID_STATUS.includes(raw.status)) topic.status = raw.status;
  for (const key of PLACE_KEYS) {
    const value = cleanText(raw[key]);
    if (value) topic[key] = value;
  }
  if (raw.barePsychiatric === true) topic.barePsychiatric = true;
  if (raw.scope === 'all') topic.scope = 'all';
  if (VALID_LEVELS.includes(raw.level)) topic.level = raw.level;
  if (VALID_KINDS.includes(raw.kind)) topic.kind = raw.kind;
  if (Number.isSafeInteger(raw.page) && raw.page >= 1 && raw.page <= 1000) topic.page = raw.page;
  if (raw.window && typeof raw.window === 'object' && !Array.isArray(raw.window)) {
    const from = cleanIsoDate(raw.window.from);
    const to = cleanIsoDate(raw.window.to);
    if (from && to && from <= to) {
      topic.window = { from, to, label: cleanText(raw.window.label) || `${from} ถึง ${to}` };
    }
  }
  if (Array.isArray(raw.exclude)) {
    const exclude = [];
    for (const entry of raw.exclude.slice(0, MAX_TOPIC_EXCLUDES)) {
      if (!entry || typeof entry !== 'object') continue;
      if (!VALID_EXCLUDE_COLUMNS.includes(entry.column)) continue;
      if (entry.column === 'station_id') {
        const ids = Array.isArray(entry.ids)
          ? [...new Set(entry.ids.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))].slice(0, MAX_TOPIC_EXCLUDE_IDS)
          : [];
        if (ids.length) exclude.push({ column: 'station_id', ids, label: cleanText(entry.label) || 'พื้นที่ที่ยกเว้น' });
      } else {
        const value = cleanText(entry.value);
        if (value) exclude.push({ column: entry.column, value, label: cleanText(entry.label) || value });
      }
    }
    if (exclude.length) topic.exclude = exclude;
  }
  if (raw.pending && typeof raw.pending === 'object' && raw.pending.type === 'period_intent') {
    const pending = { type: 'period_intent' };
    if (VALID_TYPES.includes(raw.pending.person_type)) pending.person_type = raw.pending.person_type;
    if (raw.pending.window && typeof raw.pending.window === 'object') {
      const from = cleanIsoDate(raw.pending.window.from);
      const to = cleanIsoDate(raw.pending.window.to);
      if (from && to && from <= to) pending.window = { from, to, label: cleanText(raw.pending.window.label) || `${from} ถึง ${to}` };
    }
    topic.pending = pending;
  }
  // This is a display/report format marker, not an authorization field.  The
  // real export endpoint still obtains every aggregate through the caller's
  // authenticated token and server-verified scope.
  if (raw.report_kind === 'target_person_aggregate') topic.report_kind = raw.report_kind;
  return Object.keys(topic).length ? topic : null;
}

function mergeTopicFilters(filters, topic) {
  const out = { ...(filters || {}) };
  const safe = sanitizeTopic(topic);
  if (!safe) return out;
  for (const key of ['status', ...PLACE_KEYS]) {
    if (!out[key] && safe[key]) out[key] = safe[key];
  }
  if (!out.person_type && safe.person_type) out.person_type = safe.person_type;
  // Only an explicit level in the message wins over the conversation topic;
  // the export must carry the same level the officer is looking at.
  if ((!out.level || out.level === 'all') && safe.level && safe.level !== 'all') out.level = safe.level;
  if (!out.exclude?.length && safe.exclude?.length) out.exclude = safe.exclude;
  if (!out.window && safe.window) out.window = safe.window;
  return out;
}

function wantsExplicitAllList(text, types) {
  if (types.length) return false;
  return /รายชื่อ|มีใครบ้าง|คนไหนบ้าง/.test(text) && /ทั้งหมด|ทุกประเภท|ทุกชนิด|ทุกคน/.test(text);
}

function listClarify(topic) {
  const types = topic && Array.isArray(topic.person_types) ? topic.person_types : [];
  const labels = types.map((type) => TYPE_LABELS[type]).filter(Boolean);
  const focus = labels[0] || 'ผู้เสพ';
  const answer = labels.length
    ? `ต้องการรายชื่อ${labels.join(' หรือรายชื่อ')} หรือรายชื่อทั้งหมด`
    : `ต้องการรายชื่อ${focus} หรือ รายชื่อทั้งหมด`;
  const choices = [
    ...types.map((type) => ({ label: 'รายชื่อ' + TYPE_LABELS[type], message: 'ขอรายชื่อ' + TYPE_LABELS[type] })),
    { label: 'รายชื่อทั้งหมด', message: 'ขอรายชื่อทั้งหมด' },
  ];
  return { intent: 'lookup_clarify', page: 1, answer, presentation: { type: 'summary_choices', choices } };
}

function topicFromIntent(intentResult) {
  if (!intentResult || !intentResult.intent) return null;
  if (intentResult.intent === 'lookup_clarify' || intentResult.intent === 'search_incomplete') return null;
  const topic = {};
  if (intentResult.intent === 'overview') Object.assign(topic, intentResult.filters || {});
  const type = COUNT_TYPE[intentResult.intent] || LIST_TYPE[intentResult.intent] || intentResult.filters?.person_type;
  if (VALID_TYPES.includes(type)) topic.person_type = type;
  if (intentResult.intent === 'statistics_summary') {
    if (Array.isArray(intentResult.mentionedTypes) && intentResult.mentionedTypes.length > 1) {
      topic.person_types = intentResult.mentionedTypes.filter((item) => VALID_TYPES.includes(item));
      delete topic.person_type;
    } else if (!intentResult.mentionedTypes) {
      topic.person_types = VALID_TYPES.slice();
      delete topic.person_type;
    }
  }
  if (intentResult.intent === 'count_total' || intentResult.intent === 'list_all') topic.scope = 'all';
  const filters = intentResult.filters || {};
  for (const key of ['status', ...PLACE_KEYS]) {
    if (filters[key]) topic[key] = String(filters[key]).slice(0, 100);
  }
  if (intentResult.barePsychiatric) topic.barePsychiatric = true;
  return sanitizeTopic(topic);
}

module.exports = {
  VALID_TYPES,
  TYPE_LABELS,
  PERSON_TYPE_PATTERNS,
  matchPersonType,
  sanitizeTopic,
  mergeTopicFilters,
  wantsExplicitAllList,
  listClarify,
  topicFromIntent,
};
