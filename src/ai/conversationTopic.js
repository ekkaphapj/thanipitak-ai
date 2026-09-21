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

function cleanText(value) {
  if (typeof value !== 'string') return '';
  const text = value.trim().slice(0, 100);
  if (!text || /select\s|insert\s|drop\s|;|--/i.test(text)) return '';
  return text;
}

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
  sanitizeTopic,
  mergeTopicFilters,
  wantsExplicitAllList,
  listClarify,
  topicFromIntent,
};
