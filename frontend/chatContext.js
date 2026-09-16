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

  // Build the AI chat request body. context contains ONLY { personId } and is
  // omitted entirely when the selection is invalid/cleared.
  function buildChatBody(message, selected) {
    const body = { message: String(message == null ? '' : message) };
    const sel = normalizeSelectedPerson(selected);
    if (sel) {
      body.context = { personId: sel.personId };
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
    buildChatBody,
    indicatorText,
    clearSelection,
    FORBIDDEN_FIELDS,
  };
});