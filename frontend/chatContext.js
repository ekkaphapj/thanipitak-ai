/* Selected-person UI context (STEP 2.5).
 * Pure logic shared between the browser (frontend/ai.js) and Node tests.
 * Frontend selection is NOT authorization: it only adds context.personId
 * as an identifier hint. Backend always re-authorizes via getPersonSummary.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.ChatContext = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Fields that must NEVER be sent from the frontend, neither top-level
  // nor inside context. buildChatBody() can only ever produce context.personId.
  const FORBIDDEN_FIELDS = [
    'station_id',
    'allowedStationIds',
    'user_id',
    'role',
    'province_id',
    'permissions',
    'tool',
    'system_prompt',
    'sql',
  ];

  function validPersonId(value) {
    if (value === undefined || value === null) return null;
    const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
    if (typeof n !== 'number') return null;
    if (!Number.isInteger(n) || n <= 0) return null;
    return n;
  }

  function toDisplayName(raw, personId) {
    if (raw && typeof raw.displayName === 'string' && raw.displayName.trim() !== '') {
      return raw.displayName.trim();
    }
    if (raw && typeof raw.full_name === 'string' && raw.full_name.trim() !== '') {
      return raw.full_name.trim();
    }
    if (raw && typeof raw.name === 'string' && raw.name.trim() !== '') {
      return raw.name.trim();
    }
    if (raw && typeof raw.first_name === 'string') {
      const last = raw && typeof raw.last_name === 'string' ? ' ' + raw.last_name : '';
      return (raw.first_name + last).trim();
    }
    return String(personId);
  }

  // Accepts either { personId, displayName } or a person-list item shape
  // ({ person_id, full_name, ... }). Returns null when invalid.
  function normalizeSelectedPerson(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const candidate = raw.personId != null ? raw.personId : raw.person_id;
    const personId = validPersonId(candidate);
    if (personId === null) return null;
    return { personId, displayName: toDisplayName(raw, personId) };
  }

  const TOPIC_TYPES = ['psychiatric', 'drug_user', 'dealer', 'released'];
  const TOPIC_PLACES = ['province', 'district', 'subdistrict', 'station'];
  const TOPIC_LEVELS = ['all', 'high', 'watch'];
  const TOPIC_KINDS = ['monitoring_list', 'people_list'];
  const TOPIC_EXCLUDE_COLUMNS = ['tambon', 'amphoe', 'station_id'];
  const MAX_TOPIC_EXCLUDES = 3;
  const MAX_TOPIC_EXCLUDE_IDS = 1000;

  // Narrowing query conditions that survive across turns (display context
  // only — the backend re-authorizes and re-applies everything).
  function sanitizeTopic(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const topic = {};
    if (TOPIC_TYPES.includes(raw.person_type)) topic.person_type = raw.person_type;
    if (Array.isArray(raw.person_types)) {
      const types = raw.person_types.filter((item) => TOPIC_TYPES.includes(item));
      if (types.length === 1) topic.person_type = types[0];
      else if (types.length > 1) topic.person_types = types;
    }
    for (const key of TOPIC_PLACES) {
      if (typeof raw[key] === 'string' && raw[key].trim()) topic[key] = raw[key].trim().slice(0, 100);
    }
    if (raw.scope === 'all') topic.scope = 'all';
    if (raw.report_kind === 'target_person_aggregate') topic.report_kind = raw.report_kind;
    if (TOPIC_LEVELS.includes(raw.level)) topic.level = raw.level;
    if (TOPIC_KINDS.includes(raw.kind)) topic.kind = raw.kind;
    if (Number.isSafeInteger(raw.page) && raw.page >= 1 && raw.page <= 1000) topic.page = raw.page;
    if (raw.window && typeof raw.window === 'object' && !Array.isArray(raw.window)) {
      const from = typeof raw.window.from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.window.from) ? raw.window.from : null;
      const to = typeof raw.window.to === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.window.to) ? raw.window.to : null;
      if (from && to && from <= to) {
        topic.window = { from, to, label: typeof raw.window.label === 'string' && raw.window.label.trim() ? raw.window.label.trim().slice(0, 100) : `${from} ถึง ${to}` };
      }
    }
    if (Array.isArray(raw.exclude)) {
      const exclude = [];
      for (const entry of raw.exclude.slice(0, MAX_TOPIC_EXCLUDES)) {
        if (!entry || typeof entry !== 'object') continue;
        if (!TOPIC_EXCLUDE_COLUMNS.includes(entry.column)) continue;
        if (entry.column === 'station_id') {
          const ids = Array.isArray(entry.ids)
            ? [...new Set(entry.ids.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))].slice(0, MAX_TOPIC_EXCLUDE_IDS)
            : [];
          if (ids.length) exclude.push({ column: 'station_id', ids, label: typeof entry.label === 'string' && entry.label.trim() ? entry.label.trim().slice(0, 100) : 'พื้นที่ที่ยกเว้น' });
        } else if (typeof entry.value === 'string' && entry.value.trim()) {
          const value = entry.value.trim().slice(0, 100);
          exclude.push({ column: entry.column, value, label: typeof entry.label === 'string' && entry.label.trim() ? entry.label.trim().slice(0, 100) : value });
        }
      }
      if (exclude.length) topic.exclude = exclude;
    }
    if (raw.pending && typeof raw.pending === 'object' && raw.pending.type === 'period_intent') {
      const pending = { type: 'period_intent' };
      if (TOPIC_TYPES.includes(raw.pending.person_type)) pending.person_type = raw.pending.person_type;
      if (raw.pending.window && typeof raw.pending.window === 'object') {
        const from = typeof raw.pending.window.from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.pending.window.from) ? raw.pending.window.from : null;
        const to = typeof raw.pending.window.to === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.pending.window.to) ? raw.pending.window.to : null;
        if (from && to && from <= to) pending.window = { from, to, label: typeof raw.pending.window.label === 'string' && raw.pending.window.label.trim() ? raw.pending.window.label.trim().slice(0, 100) : `${from} ถึง ${to}` };
      }
      topic.pending = pending;
    }
    return Object.keys(topic).length ? topic : null;
  }

  // Build the AI chat request body. context may contain personId and/or topic.
  // It never includes station_id, role, or other authorization fields.
  function buildChatBody(message, selected, topic) {
    const body = { message: String(message == null ? '' : message) };
    const sel = normalizeSelectedPerson(selected);
    const safeTopic = sanitizeTopic(topic);
    if (sel || safeTopic) {
      body.context = {};
      if (sel) body.context.personId = sel.personId;
      if (safeTopic) body.context.topic = safeTopic;
    }
    return body;
  }

  function indicatorText(selected) {
    const sel = normalizeSelectedPerson(selected);
    if (!sel) return null;
    return 'กำลังสอบถามข้อมูลของ: ' + sel.displayName;
  }

  function clearSelection() {
    return null;
  }

  const THAI_DIGITS = { '๐': '0', '๑': '1', '๒': '2', '๓': '3', '๔': '4', '๕': '5', '๖': '6', '๗': '7', '๘': '8', '๙': '9' };
  const THAI_UNITS = { 'ศูนย์': 0, 'หนึ่ง': 1, 'เอ็ด': 1, 'สอง': 2, 'สาม': 3, 'สี่': 4, 'ห้า': 5, 'หก': 6, 'เจ็ด': 7, 'แปด': 8, 'เก้า': 9 };
  const THAI_TENS = { 'สิบ': 10, 'ยี่สิบ': 20, 'สามสิบ': 30, 'สี่สิบ': 40, 'ห้าสิบ': 50, 'หกสิบ': 60, 'เจ็ดสิบ': 70, 'แปดสิบ': 80, 'เก้าสิบ': 90 };

  function parseOrdinalValue(value) {
    const raw = String(value == null ? '' : value).replace(/[๐-๙]/g, (digit) => THAI_DIGITS[digit]).trim();
    if (/^\d{1,3}$/.test(raw)) return Number(raw);
    const word = raw.replace(/^(?:ที่)?/, '');
    for (const [tensWord, tensValue] of Object.entries(THAI_TENS).sort((a, b) => b[0].length - a[0].length)) {
      if (!word.startsWith(tensWord)) continue;
      const suffix = word.slice(tensWord.length);
      if (!suffix) return tensValue;
      for (const [unitWord, unitValue] of Object.entries(THAI_UNITS).sort((a, b) => b[0].length - a[0].length)) {
        if (suffix.startsWith(unitWord)) return tensValue + unitValue;
      }
      return null;
    }
    for (const [unitWord, unitValue] of Object.entries(THAI_UNITS).sort((a, b) => b[0].length - a[0].length)) {
      if (word.startsWith(unitWord)) return unitValue;
    }
    return null;
  }

  function ordinalMatch(message) {
    const text = String(message == null ? '' : message).replace(/\s+/g, ' ').trim();
    const match = text.match(/(?:ของ\s*)?(?:ลำดับ|อันดับ|รายการ|คน)\s*(?:ที่)?\s*([0-9๐-๙]+|[ก-๙]+)/u);
    if (!match) return null;
    const ordinal = parseOrdinalValue(match[1]);
    return Number.isSafeInteger(ordinal) && ordinal > 0 ? { ordinal, matchedText: match[0], index: match.index, text } : null;
  }

  // Ordinal references are resolved only against the most recently rendered
  // list in the browser. They never become an authorization field.
  function ordinalFromMessage(message) {
    const match = ordinalMatch(message);
    return match ? match.ordinal : null;
  }

  // Classifies an ordinal request without turning it into authorization data.
  // Explicit “เลือก…” means the same as pressing a visible Select button;
  // “ขอข้อมูล…” retains the request and uses the ordinal only as local UI
  // context. A bare ordinal remains the historic “request more information”.
  function ordinalCommandFromMessage(message) {
    const match = ordinalMatch(message);
    if (!match) return null;
    const before = match.text.slice(0, match.index);
    const action = /เลือก\s*$/u.test(before) ? 'select' : /ขอ(?:ข้อมูล|รายละเอียด|ประวัติ)\s*$/u.test(before) ? 'info' : 'info';
    return { ordinal: match.ordinal, action, matchedText: match.matchedText };
  }

  function isClearSelectionCommand(message) {
    return /^ยกเลิก\s*การเลือก(?:\s*(?:คน|รายการ|บุคคล))?(?:\s*(?:ครับ|ค่ะ|คะ|หน่อย|ที|นะ))?$/u.test(String(message == null ? '' : message).trim());
  }

  function isReferenceListQuestion(message) {
    const text = String(message == null ? '' : message).replace(/\s+/g, '').trim();
    return /กำลังอ้างอิง(?:รายการ|บุคคล)?(?:ไหน)?/.test(text) || /(?:ขอ|แสดง)?(?:รายชื่อ|รายการ)ที่กำลังอ้างอิง(?:อีกครั้ง)?/.test(text);
  }

  return {
    validPersonId,
    normalizeSelectedPerson,
    sanitizeTopic,
    buildChatBody,
    indicatorText,
    clearSelection,
    ordinalFromMessage,
    ordinalCommandFromMessage,
    isClearSelectionCommand,
    isReferenceListQuestion,
    FORBIDDEN_FIELDS,
  };
});
