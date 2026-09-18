'use strict';

const {
  resolvePersonByName,
  detectPersonNameIntent,
  isProhibitedName,
} = require('./personNameResolver');

const INTENT_MODEL = 'hf.co/typhoon-ai/typhoon2.5-qwen3-4b-gguf:Q4_K_M';
const INTENTS = Object.freeze([
  'person_search',
  'person_summary',
  'person_history',
  'latest_visit',
  'visit_count',
  'latest_urine',
  'urine_summary',
  'persons_summary',
  'unsupported',
]);
const REQUESTED = Object.freeze([
  'person_search',
  'person_summary',
  'person_history',
  'latest_visit',
  'visit_count',
  'latest_urine',
  'urine_summary',
  'persons_summary',
]);
const FILTERS = Object.freeze([
  'person_type',
  'status',
  'province',
  'station',
  'district',
  'subdistrict',
  'previous_urine_positive',
]);
const FILTER_ENUMS = Object.freeze({
  person_type: new Set(['psychiatric', 'drug_user', 'dealer', 'released']),
  status: new Set(['registered', 'active', 'followup', 'completed']),
});

const intentSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    intent: { type: 'string', enum: [...INTENTS] },
    person_hint: { type: 'string' },
    station_hint: { type: 'string' },
    filters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        person_type: { type: 'string', enum: ['psychiatric', 'drug_user', 'dealer', 'released'] },
        status: { type: 'string', enum: ['registered', 'active', 'followup', 'completed'] },
        province: { type: 'string' },
        station: { type: 'string' },
        district: { type: 'string' },
        subdistrict: { type: 'string' },
        previous_urine_positive: { type: 'boolean' },
      },
    },
    requested: { type: 'array', items: { type: 'string', enum: [...REQUESTED] }, maxItems: 8 },
  },
  required: ['intent'],
};

const INTENT_SYSTEM_PROMPT = `คุณเป็นตัวแยกเจตนาอย่างเดียวสำหรับระบบทะเบียนธานีพิทักษ์
ตอบเป็น JSON ตาม schema เท่านั้น ห้ามตอบข้อเท็จจริง ห้ามสร้าง SQL ห้ามระบุ personId ห้ามเลือกสิทธิ์ สถานี หรือ role
station_hint เป็นเพียงคำค้นช่วยหา ไม่ใช่ขอบเขตสิทธิ์จริง
ถ้าถามประวัติ/ผลตรวจ/ข้อมูลบุคคล ให้ใส่ person_hint เมื่อมีชื่อ ถ้าไม่เข้าใจให้ intent unsupported
ผู้ป่วย/คนไข้หมายถึง psychiatric ผู้เสพหมายถึง drug_user ผู้ค้าหมายถึง dealer ผู้พ้นโทษหมายถึง released
intent ที่ใช้: person_search=ค้นหรือขอรายชื่อ, persons_summary=ถามจำนวน/สรุปภาพรวม, person_summary=ข้อมูลพื้นฐานคนเดียว,
person_history=ประวัติการเยี่ยม, latest_visit=เยี่ยมล่าสุด, visit_count=จำนวนครั้งที่เยี่ยม,
latest_urine=ผลตรวจปัสสาวะล่าสุด, urine_summary=สรุปผลตรวจปัสสาวะ
ตัวอย่าง: 
คำถาม: ขอรายชื่อผู้เสพ -> {"intent":"person_search","filters":{"person_type":"drug_user"}}
คำถาม: ผู้ป่วยจิตเวชมีกี่คน -> {"intent":"persons_summary","filters":{"person_type":"psychiatric"}}
คำถาม: สมชายมีประวัติอย่างไร -> {"intent":"person_history","person_hint":"สมชาย"}
คำถาม: คนนี้ตรวจปัสสาวะล่าสุดเมื่อไหร่ -> {"intent":"latest_urine","person_hint":"คนนี้"}
คำถาม: สมชายบ้านดุงคนที่เคยฉี่ม่วงอะ ช่วงนี้ไปหามันกี่รอบแล้ว ล่าสุดยังม่วงอยู่บ่ -> {"intent":"person_history","person_hint":"สมชาย","station_hint":"บ้านดุง","filters":{"previous_urine_positive":true},"requested":["visit_count","latest_urine"]}
คำถาม: สมชายบ้านดุงล่าสุดสายตรวจไปหามื้อได๋ -> {"intent":"latest_visit","person_hint":"สมชาย","station_hint":"บ้านดุง"}
คำถาม: ช่วงนี้สมชายเป็นจั่งได๋ -> {"intent":"person_summary","person_hint":"สมชาย"}
คำถาม: ขอประวัติผลตรวจปัสสาวะของนายสมชาย -> {"intent":"urine_summary","person_hint":"สมชาย"}
คำถามที่ไม่ใช่ทะเบียนหรือขอข้อมูลที่รองรับไม่ได้ -> {"intent":"unsupported"}
อย่าเดาชื่อหรือข้อมูลที่ผู้ใช้ไม่ได้พูด และอย่าใส่ฟิลด์นอก schema`;

function cleanHint(value, field) {
  // Ollama sometimes emits null for an optional string despite the schema.
  // Treat it as omitted; never coerce arbitrary objects into a query string.
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error(`${field} ต้องเป็นข้อความ`);
  const text = value.trim();
  if (!text || text.length > 100) throw new Error(`${field} ไม่ถูกต้อง`);
  if (/select\s|insert\s|update\s|delete\s|drop\s|;|--/i.test(text)) throw new Error(`${field} ไม่ถูกต้อง`);
  return text;
}

function validateIntentPlan(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Intent JSON ไม่ถูกต้อง');
  const allowed = new Set(['intent', 'person_hint', 'station_hint', 'filters', 'requested']);
  for (const key of Object.keys(raw)) if (!allowed.has(key)) throw new Error('Intent JSON มีฟิลด์ที่ไม่รองรับ');
  if (!INTENTS.includes(raw.intent)) throw new Error('Intent ไม่รองรับ');
  const plan = { intent: raw.intent };
  const personHint = cleanHint(raw.person_hint, 'person_hint');
  const stationHint = cleanHint(raw.station_hint, 'station_hint');
  if (personHint) plan.person_hint = personHint;
  if (stationHint) plan.station_hint = stationHint;
  if (raw.filters !== undefined) {
    if (!raw.filters || typeof raw.filters !== 'object' || Array.isArray(raw.filters)) throw new Error('filters ไม่ถูกต้อง');
    const filters = {};
    for (const key of Object.keys(raw.filters)) {
      if (!FILTERS.includes(key)) throw new Error('filters มีฟิลด์ที่ไม่รองรับ');
      const value = raw.filters[key];
      if (key === 'previous_urine_positive') {
        if (typeof value !== 'boolean') throw new Error('previous_urine_positive ไม่ถูกต้อง');
        filters[key] = value;
      } else {
        filters[key] = cleanHint(value, `filters.${key}`);
        if (FILTER_ENUMS[key] && !FILTER_ENUMS[key].has(filters[key])) {
          throw new Error(`filters.${key} ไม่ถูกต้อง`);
        }
      }
    }
    plan.filters = filters;
  }
  if (raw.requested !== undefined) {
    if (!Array.isArray(raw.requested) || raw.requested.length > 8 || raw.requested.some((item) => !REQUESTED.includes(item))) {
      throw new Error('requested ไม่ถูกต้อง');
    }
    plan.requested = [...new Set(raw.requested)];
  }
  return plan;
}

function parseIntentContent(content) {
  if (typeof content !== 'string' || !content.trim()) throw new Error('โมเดลไม่ส่ง Intent JSON');
  let raw;
  try {
    raw = JSON.parse(content);
  } catch {
    throw new Error('โมเดลส่ง Intent JSON ไม่ถูกต้อง');
  }
  return validateIntentPlan(raw);
}

function isScopeOverrideAttempt(message) {
  return /\badmin\b|เป็น\s*(แอดมิน|ผู้ดูแล)|อีก\s*(สภ\.?|สถานี)|สถานีอื่น|ข้ามสถานี|ทุก\s*(สถานี|สภ\.?|โรงพัก)|ทั้งระบบ|ผู้กำกับ.*(?:ทุก|ทั้งหมด)|(?:ทุก|ทั้งหมด).*(?:โรงพัก|สภ\.?)/i.test(String(message || ''));
}

function safeFilters(plan) {
  const filters = { ...(plan.filters || {}) };
  // previous_urine_positive requires per-person history and must never become
  // a broad database predicate supplied by the model.
  delete filters.previous_urine_positive;
  return filters;
}

function queryFilters(plan) {
  const filters = safeFilters(plan);
  // A station_hint may narrow a query, but it can never replace the
  // authenticated station scope enforced by the service layer.
  if (plan.station_hint && !filters.station) filters.station = plan.station_hint;
  return filters;
}

function emitToolCall(onToolCall, currentUser, toolName, toolArgs) {
  onToolCall?.({ toolName, toolArgs, userId: currentUser.id, username: currentUser.username });
}

function isLocalScopeReference(value) {
  return /^(?:เขตนี้|พื้นที่นี้|ในพื้นที่นี้|ของเรา|เขตเรา)$/i.test(String(value || '').trim());
}

// This extracts only an explicit, contiguous name phrase from common Thai
// question forms. It is a search hint, never an identity: resolution remains
// exact and station-scoped in resolvePersonByName().
function extractExplicitPersonHint(text) {
  const source = String(text || '').replace(/[\s\u00a0]+/g, ' ').trim();
  if (!source) return null;
  const named = source.match(/(?:ข้อมูล|ประวัติ(?:การเยี่ยม)?|(?:สรุป)?ผล(?:ตรวจ)?(?:ฉี่|ปัสสาวะ)(?:ที่เคยตรวจ)?)ของ\s*(.+?)(?=\s*(?:ที่(?:ไม่มี|ไม่เคย)|ไม่ใช่|ให้|หน่อย|ครับ|ค่ะ|$))/i);
  if (named?.[1]) return named[1].trim();
  const marker = /ถูกเยี่ยม|มีประวัติ|ช่วงนี้|ผล(?:ตรวจ)?(?:ฉี่|ปัสสาวะ)|ไปเยี่ยม|เยี่ยม|ตรวจ(?:ฉี่|ปัสสาวะ)|ขอแค่|อยากทราบ|สถานะ(?:ปัจจุบัน|ล่าสุด)/i.exec(source);
  if (!marker || marker.index === 0) return null;
  let candidate = source.slice(0, marker.index).trim();
  candidate = candidate.replace(/^(?:รบกวน(?:ช่วย)?|กรุณา|ช่วย(?:เช็ก|ตรวจ|ดู)?|ขอ)\s*/i, '');
  candidate = candidate.replace(/^(?:สรุปผล(?:ตรวจ)?(?:ฉี่|ปัสสาวะ)(?:ที่เคยตรวจ)?ของ)\s*/i, '');
  candidate = candidate.replace(/^ของ\s*/i, '').trim();
  return candidate && !isProhibitedName(candidate) ? candidate : null;
}

function formatLatestVisit(value) {
  if (!value || typeof value !== 'object') return value || 'ไม่มีข้อมูล';
  const date = value.visit_date || value.date || value.visited_at || value.created_at;
  const status = value.visit_status || value.status || value.result;
  const details = [date, status].filter(Boolean);
  return details.length ? details.join(' — ') : 'มีข้อมูลบันทึกการเยี่ยมล่าสุด';
}

async function enrichPeopleWithLatestUrine(rows, toolRouter, currentUser, onToolCall) {
  const capped = rows.slice(0, 20);
  const enriched = [];
  for (const person of capped) {
    const args = { person_id: person.id };
    const urine = await toolRouter.execute('get_urine_history', args, currentUser);
    emitToolCall(onToolCall, currentUser, 'get_urine_history', args);
    enriched.push({
      ...person,
      latest_urine: urine.error ? 'ไม่พร้อมใช้งาน' : (urine.data || [])[0]?.result || 'ไม่มีข้อมูล',
    });
  }
  return enriched;
}

function normalizePlanForMessage(rawPlan, message) {
  const text = String(message || '').replace(/[\s\u00a0]+/g, ' ').trim();
  const plan = {
    ...rawPlan,
    filters: rawPlan.filters ? { ...rawPlan.filters } : undefined,
    requested: rawPlan.requested ? [...rawPlan.requested] : [],
  };
  const requested = new Set(plan.requested);
  const hasUrine = /ฉี่|ปัสสาวะ|ตรวจ.*(ฉี่|ปัสสาวะ)|ผล.*(ฉี่|ปัสสาวะ)|ม่วง|ผ่านบ่|เป็นหยัง/i.test(text);
  const hasPositiveUrine = /ฉี่ม่วง|ผล.*(?:ม่วง|เป็นบวก)|ตรวจ.*พบสาร|ตรวจฉี่เป็นบวก/i.test(text);
  const hasVisitCount = /กี่รอบ|กี่ครั้ง|จักเทื่อ|จักครั้ง|กี่เที่ยว|ไปหา.*กี่|ไปเยี่ยม.*กี่|เยี่ยม.*กี่/i.test(text);
  const hasLatestVisit = /(?:เยี่ยม|ไปหา|สายตรวจ)\s*(?:ครั้ง)?\s*ล่าสุด|ล่าสุด\s*(?:ไปหา|เยี่ยม|สายตรวจ)|สายตรวจ.*(?:หา|เยี่ยม)/i.test(text)
    || (/(มื้อได๋|เมื่อไหร่|วันไหน)/i.test(text) && /(เยี่ยม|ไปหา|สายตรวจ)/i.test(text));
  const hasLatestUrine = /(?:ฉี่|ปัสสาวะ).*ล่าสุด|ล่าสุด.*(?:ฉี่|ปัสสาวะ)|ผล.*(?:ฉี่|ปัสสาวะ).*(?:เป็นยังไง|ผ่านบ่|เป็นหยัง)/i.test(text);
  const hasUrineSummary = /ประวัติ.*(ฉี่|ปัสสาวะ)|สรุป.*(ผล.*)?(ฉี่|ปัสสาวะ)|ผลตรวจ.*(ทั้งหมด|กี่ครั้ง|ที่ผ่านมา)/i.test(text);
  const hasPersonSummary = /ข้อมูลพื้นฐาน|รายละเอียด|ข้อมูลเพิ่มเติม|สรุปข้อมูล(ของ|บุคคล)/i.test(text);
  const populationLatestUrine = /รายชื่อ.*(?:ผล(?:ตรวจ)?(?:ฉี่|ปัสสาวะ)).*(?:ล่าสุด|แต่ละคน)|(?:ผล(?:ตรวจ)?(?:ฉี่|ปัสสาวะ)).*(?:ล่าสุด|แต่ละคน).*รายชื่อ/i.test(text);
  const collectionUrine = /^(?:คนที่|ใคร|ผู้เสพ(?:ที่|รายใด)|ผู้ป่วย(?:ที่|รายใด)).*(?:ฉี่|ปัสสาวะ|ตรวจ|ผล).*?(?:ม่วง|บวก|พบสาร|ล่าสุด)|^(?:คนที่|ใคร).*(?:ผลม่วง|ยังมีชื่อ)/i.test(text);
  const unsupportedRecentCollection = /^(คนที่|ใคร).*(สายตรวจ|เยี่ยม|ไปหา).*(เพิ่ง|ล่าสุด)/i.test(text);
  const incompleteSummaryRequest = /^(?:ขอ\s*)?(?:จำนวน|กี่คน|สรุป)\s*(?:ของ)?\s*$/i.test(text);

  if (incompleteSummaryRequest) {
    plan.intent = 'unsupported';
    delete plan.person_hint;
  }

  // High-confidence collection language is safer and more useful as a
  // deterministic search than treating the whole phrase as a person's name.
  if (isLocalScopeReference(plan.station_hint)) {
    delete plan.station_hint;
    if (isLocalScopeReference(plan.filters?.station)) delete plan.filters.station;
  }
  if (collectionUrine && (!plan.person_hint || isProhibitedName(plan.person_hint) || /^(คนที่|ใคร)/i.test(plan.person_hint))) {
    plan.intent = 'person_search';
    delete plan.person_hint;
  }
  if (unsupportedRecentCollection && !plan.person_hint) {
    plan.intent = 'unsupported';
    delete plan.person_hint;
  }
  if (plan.intent === 'unsupported' && !incompleteSummaryRequest && !isScopeOverrideAttempt(text)) {
    if (/รายชื่อ|ค้นหา|หา(คน|บุคคล)/i.test(text)) plan.intent = 'person_search';
    else if (/กี่คน|จำนวน|สรุป/i.test(text)) plan.intent = 'persons_summary';
  }
  if (plan.intent === 'person_search' && /(จำนวน|กี่คน).*(รายชื่อ|ชื่อ)|รายชื่อ.*(จำนวน|กี่คน)/i.test(text)) {
    plan.intent = 'persons_summary';
  }
  if (populationLatestUrine) {
    plan.intent = 'person_search';
    plan.include_latest_urine_for_each = true;
  }
  if (plan.intent === 'unsupported' && !incompleteSummaryRequest && !isScopeOverrideAttempt(text)) {
    const detectedName = detectPersonNameIntent(text);
    if (detectedName) {
      plan.intent = detectedName.intent === 'latest_urine_test' ? 'latest_urine'
        : detectedName.intent === 'latest_visit' ? 'latest_visit'
          : detectedName.intent === 'visit_count' ? 'visit_count'
            : detectedName.intent === 'urine_positive_count' ? 'urine_summary'
              : detectedName.intent === 'person_history' ? 'person_history' : 'person_summary';
      plan.person_hint = detectedName.name;
    }
  }
  if (!plan.person_hint && !isScopeOverrideAttempt(text) && plan.intent !== 'unsupported') {
    const detectedName = detectPersonNameIntent(text);
    if (detectedName) plan.person_hint = detectedName.name;
  }
  const explicitHint = !isScopeOverrideAttempt(text) ? extractExplicitPersonHint(text) : null;
  if (explicitHint && (plan.intent !== 'person_search' && plan.intent !== 'persons_summary')) {
    if (plan.intent === 'unsupported') {
      plan.intent = hasUrine ? 'latest_urine' : /ประวัติ|เยี่ยม/i.test(text) ? 'person_history' : 'person_summary';
    }
    if (!plan.person_hint || /^\d+$/.test(plan.person_hint) || /(?:ถูก|มี)$/.test(plan.person_hint)) plan.person_hint = explicitHint;
  }
  if (REQUESTED.includes(plan.intent)) requested.add(plan.intent);
  if (hasVisitCount) requested.add('visit_count');
  if (hasLatestVisit) requested.add('latest_visit');
  if (hasUrine && (!hasUrineSummary || hasLatestUrine)) requested.add('latest_urine');
  if (hasUrineSummary && !hasLatestUrine) requested.add('urine_summary');
  if (hasPersonSummary) requested.add('person_summary');
  if (hasPositiveUrine) {
    plan.filters = { ...(plan.filters || {}), previous_urine_positive: true };
  }
  plan.requested = REQUESTED.filter((item) => requested.has(item));
  return plan;
}

function personLabel(person) {
  return `${person.first_name || ''} ${person.last_name || ''}`.trim() || 'บุคคลที่เลือก';
}

async function resolvePerson(plan, toolRouter, currentUser, selectedPersonId) {
  if (selectedPersonId !== null) {
    const selected = await toolRouter.getPersonSummary(currentUser, selectedPersonId);
    if (!selected.ok) return { resolution: 'not_found', toolsUsed: ['get_person_summary'] };
    return { resolution: 'unique', person: selected.data.person || selected.data, toolsUsed: ['get_person_summary'] };
  }
  if (!plan.person_hint || isProhibitedName(plan.person_hint)) return { resolution: 'ambiguous', candidates: [] };
  const filters = queryFilters(plan);
  if (plan.station_hint && !plan.person_hint.includes(plan.station_hint)) {
    const combined = await resolvePersonByName(`${plan.person_hint} ${plan.station_hint}`, toolRouter, currentUser, 100, {});
    if (combined.resolution !== 'not_found') return combined;
  }
  const first = await resolvePersonByName(plan.person_hint, toolRouter, currentUser, 100, filters);
  if (first.resolution === 'not_found' && Object.keys(filters).length) {
    // Model-derived filters are only search hints. Retrying the explicit name
    // without them remains inside the authenticated station scope and avoids
    // a false “not found” caused by a malformed station/status hint.
    return resolvePersonByName(plan.person_hint, toolRouter, currentUser, 100, {});
  }
  return first;
}

function urineResultIsPositive(result) {
  return /positive|พบสาร|ม่วง/i.test(String(result || ''));
}

async function searchPersonsWithUrineAttribute(plan, toolRouter, currentUser, onToolCall) {
  const filters = queryFilters(plan);
  const wantPositive = plan.filters?.previous_urine_positive === true;
  delete filters.previous_urine_positive;
  const pageSize = 50;
  const maxScan = 200;
  const all = [];
  let total = 0;
  let offset = 0;
  do {
    const args = { ...filters, limit: pageSize, offset };
    const result = await toolRouter.execute('search_persons', args, currentUser);
    emitToolCall(onToolCall, currentUser, 'search_persons', args);
    if (result.error) return { error: result.error, toolsUsed: ['search_persons'] };
    total = Number(result.total) || 0;
    all.push(...(result.persons || []));
    offset += pageSize;
  } while (all.length < Math.min(total, maxScan) && offset < total);

  const matching = [];
  for (const person of all.slice(0, maxScan)) {
    const args = { person_id: person.id };
    const urine = await toolRouter.execute('get_urine_history', args, currentUser);
    emitToolCall(onToolCall, currentUser, 'get_urine_history', args);
    if (urine.error) continue;
    const hasPositive = (urine.data || []).some((item) => urineResultIsPositive(item.result));
    if (hasPositive === wantPositive) matching.push(person);
  }
  return {
    persons: matching.slice(0, 20),
    total: matching.length,
    returned: Math.min(matching.length, 20),
    page: 1,
    pageSize: 20,
    toolsUsed: ['search_persons', 'get_urine_history'],
    scanned: all.length,
    truncated: total > maxScan,
  };
}

function personPresentation(rows, total, page = 1, pageSize = 20) {
  const items = rows.map((person) => ({
    person_id: person.id,
    full_name: personLabel(person),
    person_type: person.person_type,
    status: person.status,
    district: person.district,
    subdistrict: person.subdistrict,
    ...(Object.hasOwn(person, 'latest_urine') ? { latest_urine: person.latest_urine } : {}),
  }));
  return { type: 'person_list', total, returned: items.length, page, pageSize, filters: {}, items };
}

function candidatePresentation(found) {
  return {
    type: 'person_candidates',
    total: found.totalCandidates || found.candidates?.length || 0,
    candidates: (found.candidates || []).map((item) => ({
      personId: item.personId,
      displayName: item.displayName,
      personType: item.personType,
      status: item.status,
    })),
  };
}

function resultBase({ answer, toolsUsed = [], grounded = true, presentation, resolution, intent, ollamaCalls = 1 }) {
  return { answer, toolsUsed, grounded, presentation, resolution, intent, ollamaCalls, executionTier: 3, fastPath: false };
}

async function runIntentPlan(plan, { toolRouter, currentUser, selectedPersonId = null, onToolCall } = {}) {
  const intent = plan.intent;
  if (intent === 'unsupported') return resultBase({ answer: 'คำถามนี้ยังไม่อยู่ในความสามารถของโหมดทดลอง Intent JSON', grounded: false, intent });

  if (intent === 'person_search') {
    let result;
    let toolsUsed = ['search_persons'];
    if (plan.filters?.previous_urine_positive !== undefined) {
      result = await searchPersonsWithUrineAttribute(plan, toolRouter, currentUser, onToolCall);
      toolsUsed = result.toolsUsed || toolsUsed;
    } else {
      const filters = queryFilters(plan);
      const args = { ...filters };
      if (plan.person_hint) args.query = plan.person_hint;
      result = await toolRouter.execute('search_persons', args, currentUser);
      if (!result.error) emitToolCall(onToolCall, currentUser, 'search_persons', args);
    }
    if (result.error) return resultBase({ answer: 'ไม่สามารถค้นข้อมูลบุคคลตามสิทธิ์ได้', grounded: false, intent, toolsUsed });
    let rows = result.persons || [];
    if (plan.include_latest_urine_for_each) {
      rows = await enrichPeopleWithLatestUrine(rows, toolRouter, currentUser, onToolCall);
      toolsUsed = [...new Set([...toolsUsed, 'get_urine_history'])];
    }
    return resultBase({
      answer: result.total ? `พบบุคคล ${result.total} คนในพื้นที่ที่ท่านมีสิทธิ์เข้าถึง${plan.include_latest_urine_for_each ? ` พร้อมผลตรวจปัสสาวะล่าสุดของ ${rows.length} คนแรก` : ''}` : 'ไม่พบบุคคลในพื้นที่ที่ท่านมีสิทธิ์เข้าถึง',
      toolsUsed,
      presentation: personPresentation(rows, result.total, result.page, result.pageSize),
      intent,
    });
  }

  if (intent === 'persons_summary') {
    const request = { filters: queryFilters(plan), includeCount: true, includeList: true, sort: 'name_asc' };
    const result = toolRouter.summarizePersons(currentUser, request);
    onToolCall?.({ toolName: 'summarize_persons', toolArgs: request, userId: currentUser.id, username: currentUser.username });
    if (!result || result.error) return resultBase({ answer: 'ไม่สามารถสรุปข้อมูลตามสิทธิ์ได้', grounded: false, intent, toolsUsed: ['summarize_persons'] });
    const count = Number(result.presentation?.total) || 0;
    return resultBase({
      answer: `สรุปข้อมูลในพื้นที่ที่ท่านมีสิทธิ์เข้าถึงทั้งหมด ${count} คน`,
      toolsUsed: ['summarize_persons'],
      presentation: result.presentation,
      intent,
    });
  }

  const found = await resolvePerson(plan, toolRouter, currentUser, selectedPersonId);
  if (found.resolution === 'ambiguous') {
    return resultBase({ answer: plan.person_hint ? 'พบหลายบุคคลที่ตรงกัน กรุณาเลือกบุคคลก่อน' : 'กรุณาระบุชื่อบุคคลหรือเลือกบุคคลก่อน', grounded: true, intent, resolution: 'ambiguous', presentation: candidatePresentation(found), toolsUsed: found.toolsUsed || [] });
  }
  if (found.resolution === 'not_found' || !found.person) {
    return resultBase({ answer: 'ไม่พบบุคคลนี้ในพื้นที่ที่ท่านมีสิทธิ์รับผิดชอบ', grounded: true, intent, resolution: 'not_found', toolsUsed: found.toolsUsed || [] });
  }
  const personId = Number(found.person.id);
  if (!Number.isSafeInteger(personId) || personId <= 0) return resultBase({ answer: 'ไม่สามารถยืนยันบุคคลได้', grounded: false, intent });
  const name = personLabel(found.person);
  const requested = new Set(plan.requested || []);
  if (intent === 'person_summary') requested.add('person_summary');
  if (intent === 'person_history') requested.add('person_history');
  if (intent === 'latest_visit') requested.add('latest_visit');
  if (intent === 'visit_count') requested.add('visit_count');
  if (intent === 'latest_urine') requested.add('latest_urine');
  if (intent === 'urine_summary') requested.add('urine_summary');

  const lines = [`ข้อมูลของ ${name}`];
  const toolsUsed = [];
  let presentation;
  let urineTests;
  if (requested.has('person_summary')) {
    const result = await toolRouter.getPersonSummary(currentUser, personId);
    onToolCall?.({ toolName: 'get_person_summary', toolArgs: { person_id: personId }, userId: currentUser.id, username: currentUser.username });
    if (!result.ok) return resultBase({ answer: 'ไม่พบบุคคลนี้ในพื้นที่ที่ท่านมีสิทธิ์รับผิดชอบ', grounded: true, intent, resolution: 'not_found', toolsUsed: ['search_persons'] });
    toolsUsed.push('get_person_summary');
    presentation = { type: 'person_summary', person: result.data.person, visitSummary: result.data.visit_summary, urineSummary: result.data.urine_summary, followup: result.data.followup, recentVisits: result.data.recent_visits };
    lines.push(`ประเภท: ${result.data.person?.person_type || 'ไม่ระบุ'}`);
    lines.push(`สถานะ: ${result.data.person?.status || 'ไม่ระบุ'}`);
  }
  if (requested.has('person_history') || requested.has('latest_visit') || requested.has('visit_count')) {
    const result = await toolRouter.execute('get_visit_history', { person_id: personId }, currentUser);
    onToolCall?.({ toolName: 'get_visit_history', toolArgs: { person_id: personId }, userId: currentUser.id, username: currentUser.username });
    toolsUsed.push('get_visit_history');
    if (result.error) return resultBase({ answer: 'ไม่สามารถอ่านประวัติการเยี่ยมตามสิทธิ์ได้', grounded: false, intent, toolsUsed });
    if (requested.has('visit_count')) lines.push(`จำนวนครั้งที่เยี่ยม: ${result.visit_count || 0} ครั้ง`);
    if (requested.has('latest_visit')) lines.push(`เยี่ยมล่าสุด: ${formatLatestVisit(result.latest_visit)}`);
    if (requested.has('person_history')) lines.push(`ประวัติการเยี่ยมที่บันทึกไว้ ${Array.isArray(result.data) ? result.data.length : 0} รายการ`);
  }
  if (requested.has('latest_urine') || requested.has('urine_summary')) {
    const result = await toolRouter.execute('get_urine_history', { person_id: personId }, currentUser);
    emitToolCall(onToolCall, currentUser, 'get_urine_history', { person_id: personId });
    toolsUsed.push('get_urine_history');
    if (result.error) return resultBase({ answer: 'ไม่สามารถอ่านผลตรวจปัสสาวะตามสิทธิ์ได้', grounded: false, intent, toolsUsed });
    urineTests = Array.isArray(result.data) ? result.data : [];
    if (requested.has('latest_urine')) lines.push(`ผลตรวจปัสสาวะล่าสุด: ${urineTests[0]?.result || 'ไม่มีข้อมูล'}`);
    if (requested.has('urine_summary')) lines.push(`มีบันทึกผลตรวจปัสสาวะ ${urineTests.length} รายการ`);
  }
  if (plan.filters?.previous_urine_positive !== undefined && !urineTests) {
    const result = await toolRouter.execute('get_urine_history', { person_id: personId }, currentUser);
    emitToolCall(onToolCall, currentUser, 'get_urine_history', { person_id: personId });
    toolsUsed.push('get_urine_history');
    if (result.error) return resultBase({ answer: 'ไม่สามารถอ่านผลตรวจปัสสาวะตามสิทธิ์ได้', grounded: false, intent, toolsUsed });
    urineTests = Array.isArray(result.data) ? result.data : [];
  }
  if (plan.filters?.previous_urine_positive !== undefined) {
    const positive = urineTests.some((item) => urineResultIsPositive(item.result));
    const expected = plan.filters.previous_urine_positive === true;
    if (expected) lines.push(`เคยมีผลตรวจปัสสาวะเป็นบวก: ${positive ? 'มี' : 'ไม่พบจากบันทึก'}`);
    else lines.push(`ไม่พบประวัติผลตรวจปัสสาวะเป็นบวก: ${positive ? 'ยังมีประวัติ' : 'ไม่พบจากบันทึก'}`);
  }
  return resultBase({ answer: lines.join('\n'), toolsUsed: [...new Set(toolsUsed)], grounded: true, presentation, resolution: 'unique', intent });
}

async function runIntentRouter(message, { requestFn, model = INTENT_MODEL, toolRouter, currentUser, selectedPersonId = null, onToolCall } = {}) {
  if (typeof requestFn !== 'function') throw new Error('Intent Router ต้องการ requestFn');
  const response = await requestFn('/api/chat', {
    model,
    stream: false,
    think: false,
    format: intentSchema,
    options: { temperature: 0, num_predict: 220 },
    messages: [{ role: 'system', content: INTENT_SYSTEM_PROMPT }, { role: 'user', content: message }],
  });
  const rawPlan = parseIntentContent(response?.message?.content);
  const plan = normalizePlanForMessage(rawPlan, message);
  if (isScopeOverrideAttempt(message)) {
    return {
      ...resultBase({
        answer: 'ไม่สามารถเปลี่ยนสิทธิ์หรือขอบเขตสถานีจากข้อความได้ กรุณาใช้ข้อมูลในพื้นที่ที่บัญชีมีสิทธิ์',
        grounded: false,
        intent: 'unsupported',
      }),
      rawIntentPlan: rawPlan,
      intentPlan: { intent: 'unsupported' },
      model,
    };
  }
  const result = await runIntentPlan(plan, { toolRouter, currentUser, selectedPersonId, onToolCall });
  return { ...result, rawIntentPlan: rawPlan, intentPlan: plan, model };
}

module.exports = {
  INTENT_MODEL,
  INTENTS,
  REQUESTED,
  FILTERS,
  intentSchema,
  INTENT_SYSTEM_PROMPT,
  validateIntentPlan,
  parseIntentContent,
  runIntentPlan,
  runIntentRouter,
};
