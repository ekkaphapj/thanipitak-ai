'use strict';

// Tier-2 deterministic fast path for selected-person factual questions.
// Only an exact phrase match (after whitespace normalization) plus a backend
// re-authorization via getPersonSummary(user, personId) may enter this path.
// No Ollama, no arbitrary SQL, no role/station hints from the frontend.

const PERSON_TYPE_LABELS = {
  psychiatric: 'ผู้ป่วยจิตเวช',
  drug_user: 'ผู้เสพ',
  dealer: 'ผู้ค้า',
  released: 'ผู้พ้นโทษ',
};

const STATUS_LABELS = {
  registered: 'ขึ้นทะเบียน',
  active: 'กำลังติดตาม',
  followup: 'ต้องติดตาม',
  completed: 'เสร็จสิ้น',
};

const URINE_RESULT_LABELS = {
  negative: 'ปกติ (ไม่ม่วง)',
  positive: 'ม่วง (positive)',
};

const VISIT_RESULT_LABELS = {
  normal: 'ปกติ',
  progress: 'มีพัฒนาการ',
  warning: 'น่าห่วง',
  recovered: 'หายดีแล้ว',
};

// Order matters for determinism (first exact phrase wins).
const PERSON_FACTUAL_PHRASES = [
  ['person_history', 'คนนี้มีประวัติอย่างไร'],
  ['person_history', 'บุคคลนี้มีประวัติอย่างไร'],
  ['person_history', 'ขอดูประวัติคนนี้'],
  ['person_history', 'สรุปประวัติคนนี้'],
  ['latest_visit', 'เยี่ยมล่าสุดเมื่อไหร่'],
  ['visit_count', 'เยี่ยมทั้งหมดกี่ครั้ง'],
  ['latest_urine_test', 'ตรวจปัสสาวะล่าสุดเมื่อไหร่'],
  ['urine_positive_count', 'เคยฉี่ม่วงกี่ครั้ง'],
  ['latest_status', 'สถานะล่าสุดคืออะไร'],
];

function normalizeText(message) {
  if (!message || typeof message !== 'string') return '';
  return message.replace(/\s+/g, ' ').trim();
}

function detectPersonFactualIntent(message) {
  let text = normalizeText(message);
  text = text.replace(/[?？]+$/, '').trim();
  text = text.replace(/^(?:(?:รบกวน|กรุณา|ช่วย)\s*)+/, '');
  text = text.replace(/\s*(?:ให้หน่อย|หน่อย)?\s*(?:นะครับ|นะคะ|ครับผม|ครับ|ค่ะ|คะ)$/, '').trim();
  text = text.replace(/\s*(?:ให้หน่อย|หน่อย)$/, '').trim();
  if (!text) return null;
  // Ordinal detail rewrites produce these forms (“ขอข้อมูลบุคคลลำดับที่ 2” →
  // “ขอข้อมูลบุคคลคนนี้”, “ขอข้อมูลเพิ่มเติมของลำดับที่ 3” → “ขอข้อมูลเพิ่มเติมของคนนี้”).
  // They ask for the selected person's summary card; resolving them here keeps
  // the answer deterministic instead of falling through to the model, which
  // used to answer with a privacy refusal after a long wait.
  if (/^ขอข้อมูล(?:\s*เพิ่มเติม)?(?:\s*ของ)?(?:\s*(?:บุคคล|รายการ|คน))?\s*(?:คน)?นี้$/u.test(text)) return 'person_history';
  for (const [intent, phrase] of PERSON_FACTUAL_PHRASES) {
    if (text === phrase) return intent;
  }
  // Strip only selected-person pronouns, never an explicit name or extra clauses.
  text = text.replace(/^(?:คนนี้|บุคคลนี้)\s*/, '').replace(/\s*(?:ของคนนี้|ของบุคคลนี้)$/, '').trim();
  const aliases = [
    ['visit_count', /^(?:ถูก)?เยี่ยม(?:ไปแล้ว|ไป|แล้ว)?(?:ทั้งหมด)?กี่ครั้ง$/],
    ['latest_visit', /^(?:ถูก)?เยี่ยม(?:ครั้ง)?ล่าสุด(?:เมื่อไหร่|เมื่อไร|วันไหน)$/],
    ['latest_urine_test', /^ตรวจ(?:ปัสสาวะ|ฉี่)(?:ครั้ง)?ล่าสุด(?:เมื่อไหร่|เมื่อไร|วันไหน)$/],
    ['urine_positive_count', /^(?:เคย)?(?:ฉี่ม่วง|ตรวจพบปัสสาวะม่วง)(?:ทั้งหมด)?กี่ครั้ง$/],
    ['latest_status', /^(?:ตอนนี้)?สถานะ(?:ล่าสุด)?(?:คืออะไร|เป็นอะไร|เป็นอย่างไร)$/],
  ];
  for (const [intent, pattern] of aliases) if (pattern.test(text)) return intent;
  return null;
}

// context.personId is only an identifier hint: a strictly positive integer.
// Any other frontend field (station_id, role, user_id, province_id,
// permissions, ...) is ignored entirely.
function validPersonId(value) {
  if (value === undefined || value === null) return null;
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number') return null;
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

function sanitizePersonContext(context) {
  if (!context || typeof context !== 'object' || Array.isArray(context)) return {};
  const out = {};
  const personId = validPersonId(context.personId);
  if (personId !== null) out.personId = personId;
  const { sanitizeTopic } = require('./conversationTopic');
  const topic = sanitizeTopic(context.topic);
  if (topic) out.topic = topic;
  return out;
}

function label(map, key, fallback) {
  return (key && map[key]) || fallback || 'ไม่ทราบ';
}

function personName(p) {
  return `${p.first_name} ${p.last_name}`;
}

function latestVisitText(latestVisit) {
  if (!latestVisit) return 'ยังไม่เคยถูกเยี่ยม';
  const out = `วันที่ ${latestVisit.date} (ผล: ${label(VISIT_RESULT_LABELS, latestVisit.result, latestVisit.result)})`;
  return latestVisit.note ? `${out} หมายเหตุ: ${latestVisit.note}` : out;
}

function latestTestText(latestTest) {
  if (!latestTest) return 'ยังไม่เคยตรวจปัสสาวะ';
  return `วันที่ ${latestTest.date} (ผล: ${label(URINE_RESULT_LABELS, latestTest.result, latestTest.result)})`;
}

function buildAnswer(intent, data) {
  const p = data.person;
  const name = personName(p);
  const v = data.visit_summary;
  const u = data.urine_summary;
  const displayStatus=p.registry_status ? `สีทะเบียน ${p.registry_status}${p.custody_status?' / '+p.custody_status:''}` : p.custody_status || label(STATUS_LABELS,p.status,p.status);

  switch (intent) {
    case 'person_history': {
      const visitTail = v.latest_visit ? `ล่าสุด ${latestVisitText(v.latest_visit)}` : 'ยังไม่เคยถูกเยี่ยม';
      const urineTail = u.latest_test ? `ล่าสุด ${latestTestText(u.latest_test)}` : 'ยังไม่เคยตรวจปัสสาวะ';
      return (
        `${name} (${p.synthetic_code}) เป็น${p.type_name || label(PERSON_TYPE_LABELS, p.person_type, p.person_type)} ` +
        `สถานะ ${displayStatus} อยู่ในเขต ${p.district}/${p.subdistrict} • ` +
        `เยี่ยมแล้วทั้งหมด ${v.visit_count} ครั้ง ${visitTail} • ` +
        `ตรวจปัสสาวะแล้ว ${u.test_count} ครั้ง ${urineTail}`
      );
    }
    case 'latest_visit':
      return v.latest_visit
        ? `${name} เยี่ยมล่าสุด${latestVisitText(v.latest_visit)}`
        : `${name} ยังไม่เคยถูกเยี่ยม`;
    case 'visit_count':
      return `${name} มีการเยี่ยมทั้งหมด ${v.visit_count} ครั้ง`;
    case 'latest_urine_test':
      return u.latest_test
        ? `${name} ตรวจปัสสาวะล่าสุด${latestTestText(u.latest_test)}`
        : `${name} ยังไม่เคยตรวจปัสสาวะ`;
    case 'urine_positive_count':
      return `${name} เคยตรวจพบปัสสาวะม่วง (positive) ทั้งหมด ${u.positive_count} ครั้ง จากที่ตรวจทั้งหมด ${u.test_count} ครั้ง`;
    case 'latest_status':
      return `สถานะล่าสุดของ ${name} คือ ${displayStatus}`;
    default:
      return null;
  }
}

async function runPersonFastPath(intent, personId, toolRouter, currentUser) {
  // Authorization always comes from the backend user; personId is only a hint.
  const result = await toolRouter.getPersonSummary(currentUser, personId);
  if (!result.ok) {
    return {
      ok: true,
      blocked: true,
      intent,
      answer: 'ไม่พบข้อมูลบุคคลนี้ในพื้นที่ที่รับผิดชอบ',
      toolsUsed: ['get_person_summary'],
      toolArgs: { person_id: personId },
      grounded: true,
      presentation: null,
    };
  }

  const data = result.data;
  const answer = buildAnswer(intent, data);
  if (!answer) return { ok: false };

  return {
    ok: true,
    intent,
    answer,
    toolsUsed: ['get_person_summary'],
    toolArgs: { person_id: personId },
    grounded: true,
    presentation: {
      type: 'person_summary',
      person: data.person,
      visitSummary: data.visit_summary,
      urineSummary: data.urine_summary,
      followup: data.followup,
      recentVisits: data.recent_visits,
    },
  };
}

module.exports = {
  detectPersonFactualIntent,
  validPersonId,
  sanitizePersonContext,
  runPersonFastPath,
  PERSON_FACTUAL_PHRASES,
  buildAnswer,
  personName,
};
