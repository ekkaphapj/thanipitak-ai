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

  return {
    validPersonId,
    normalizeSelectedPerson,
    sanitizeTopic,
    buildChatBody,
    indicatorText,
    clearSelection,
    FORBIDDEN_FIELDS,
  };
});