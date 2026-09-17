'use strict';

// STEP 3 — Deterministic person-name resolution (Tier 2).
//
// Natural Thai factual queries that include an explicit person name are
// routed deterministically with ZERO Ollama:
//   - search ONLY within the authenticated user's station scope
//     (personService.listPersons -> allowedStationIds -> repository)
//   - 0 exact matches   -> deterministic safe not-found (no leak)
//   - 1 exact match     -> getPersonSummary -> Tier-2 deterministic answer
//   - >1 exact matches  -> person_candidates (never auto-select)
//
// station_id / role / user_id / province_id / permissions are NEVER read
// from the prompt or the frontend. Authorization is always JWT -> backend
// user -> station scope -> repository.

const { buildAnswer } = require('./personFastPath');

const NOT_FOUND_ANSWER = 'ไม่พบบุคคลชื่อนี้ในพื้นที่ที่ท่านมีสิทธิ์รับผิดชอบ';

const NAME_SEARCH_LIMIT = 100;
const CANDIDATE_MAX = 10;

// Thai honorific / title prefixes. Stripped only as a retry (a) when the raw
// candidate does not resolve, so a real literal name is never mis-selected.
const THAI_TITLES = ['คุณ', 'นาย', 'นาง', 'นางสาว', 'น.ส.', 'นส.', 'ด.ช.', 'ด.ญ.', 'ทนพ.', 'ทนท.'];

// Leading politeness / request words that may precede the actual phrase.
const POLITE_LEADERS = ['รบกวนช่วย', 'รบกวน', 'กรุณา', 'อยากได้', 'อยากให้', 'ช่วย', 'ขอ'];

// Sentence-final politeness particles that never belong to a name.
const POLITE_PARTICLES = [
  'หน่อยครับ',
  'หน่อยค่ะ',
  'นะครับ',
  'นะคะ',
  'ครับผม',
  'ครับ',
  'ค่ะ',
  'คะ',
  'จ้า',
  'นะ',
];

// Politeness tails that follow the name after a prefix ("... <name> ให้หน่อย").
const POLITE_TAILS = ['ให้หน่อย', 'ให้ด้วย', 'หน่อย', 'ด้วย'];

// Pronouns / placeholders that are NOT a real name. These questions
// ("คนนี้...", "ขอดูประวัติคนนี้") belong to the STEP 2.5 selected-person
// flow or the normal fallback and must not be resolved by name.
const PROHIBITED_NAMES = ['คนนี้', 'บุคคลนี้', 'เค้า', 'เขา', 'ผู้ป่วยรายนี้', 'ผู้เสพรายนี้', 'ผู้ค้ารายนี้'];

// Factual intents that can carry an explicit name. Suffixes appear AFTER the
// name; prefixes appear BEFORE the name. Lists are longest-first so that
// "ขอดูประวัติของ" wins over "ขอดูประวัติ" for determinism.
const PERSON_FACTUAL_TEMPLATES = [
  {
    intent: 'person_history',
    suffixes: [
      'มีประวัติความเป็นมาอย่างไร',
      'มีประวัติอย่างไร',
      'ประวัติเป็นอย่างไร',
      'เป็นมาอย่างไร',
      'มีประวัติเป็นมาอย่างไร',
    ],
    prefixes: [
      'ช่วยดูสรุปประวัติของ',
      'ช่วยดูสรุปประวัติ',
      'ขอดูสรุปประวัติของ',
      'ขอดูสรุปประวัติ',
      'ขอสรุปประวัติของ',
      'ขอสรุปประวัติ',
      'ช่วยดูประวัติของ',
      'ช่วยดูประวัติ',
      'ขอดูข้อมูลประวัติของ',
      'ขอดูข้อมูลประวัติ',
      'ขอข้อมูลประวัติของ',
      'ขอข้อมูลประวัติ',
      'ขอดูประวัติของ',
      'ขอดูประวัติ',
      'ขอประวัติของ',
      'ขอประวัติ',
      'ดูประวัติของ',
      'ดูประวัติ',
      'สรุปประวัติของ',
      'สรุปประวัติ',
    ],
  },
  {
    intent: 'latest_visit',
    suffixes: [
      'เยี่ยมครั้งล่าสุดเมื่อไหร่',
      'ถูกเยี่ยมครั้งล่าสุดเมื่อไหร่',
      'เยี่ยมล่าสุดเมื่อไหร่',
      'ถูกเยี่ยมล่าสุดเมื่อไหร่',
    ],
    prefixes: [
      'ขอดูการเยี่ยมครั้งล่าสุดของ',
      'การเยี่ยมครั้งล่าสุดของ',
      'ขอดูการเยี่ยมล่าสุดของ',
      'การเยี่ยมล่าสุดของ',
    ],
  },
  {
    intent: 'visit_count',
    suffixes: [
      'เยี่ยมไปแล้วทั้งหมดกี่ครั้ง',
      'ถูกเยี่ยมไปแล้วทั้งหมดกี่ครั้ง',
      'เยี่ยมไปทั้งหมดกี่ครั้ง',
      'ถูกเยี่ยมไปทั้งหมดกี่ครั้ง',
      'เยี่ยมทั้งหมดกี่ครั้ง',
      'ถูกเยี่ยมทั้งหมดกี่ครั้ง',
      'เยี่ยมไปแล้วกี่ครั้ง',
    ],
    prefixes: [
      'ขอดูจำนวนครั้งการเยี่ยมของ',
      'จำนวนครั้งการเยี่ยมของ',
      'จำนวนครั้งที่เยี่ยมของ',
    ],
  },
  {
    intent: 'latest_urine_test',
    suffixes: [
      'ตรวจปัสสาวะครั้งล่าสุดเมื่อไหร่',
      'ตรวจฉี่ครั้งล่าสุดเมื่อไหร่',
      'ตรวจปัสสาวะล่าสุดเมื่อไหร่',
      'ตรวจฉี่ล่าสุดเมื่อไหร่',
    ],
    prefixes: ['ขอดูการตรวจปัสสาวะล่าสุดของ', 'การตรวจปัสสาวะล่าสุดของ'],
  },
  {
    intent: 'urine_positive_count',
    suffixes: [
      'เคยฉี่ม่วงทั้งหมดกี่ครั้ง',
      'เคยฉี่ม่วงกี่ครั้ง',
      'เคยตรวจพบปัสสาวะม่วงกี่ครั้ง',
      'เคยตรวจพบฉี่ม่วงกี่ครั้ง',
      'เคยตรวจปัสสาวะม่วงกี่ครั้ง',
      'ฉี่ม่วงกี่ครั้ง',
      'เคยเป็นม่วงกี่ครั้ง',
    ],
    prefixes: [
      'ขอดูจำนวนครั้งที่ฉี่ม่วงของ',
      'จำนวนครั้งที่ฉี่ม่วงของ',
      'ขอดูจำนวนครั้งปัสสาวะม่วงของ',
      'จำนวนครั้งปัสสาวะม่วงของ',
    ],
  },
  {
    intent: 'latest_status',
    suffixes: [
      'สถานะล่าสุดคืออะไร',
      'สถานะล่าสุดเป็นอะไร',
      'สถานะล่าสุดเป็นอย่างไร',
      'ตอนนี้สถานะเป็นอะไร',
      'ตอนนี้สถานะเป็นอย่างไร',
      'สถานะตอนนี้เป็นอะไร',
    ],
    prefixes: ['ขอดูสถานะล่าสุดของ', 'สถานะล่าสุดของ'],
  },
];

function normalizeCollapse(text) {
  if (text === undefined || text === null) return '';
  return String(text).replace(/[\s\u00A0]+/g, ' ').trim();
}

function stripLeadingPoliteness(text) {
  let t = text;
  let changed = true;
  while (changed && t) {
    changed = false;
    for (const w of POLITE_LEADERS) {
      if (t === w) return '';
      if (t.startsWith(w + ' ')) {
        t = t.slice(w.length).trim();
        changed = true;
        break;
      }
    }
  }
  return t;
}

function stripEndParticles(text) {
  let t = text;
  let changed = true;
  while (changed && t) {
    changed = false;
    for (const w of POLITE_PARTICLES) {
      if (t === w) return '';
      if (t.endsWith(w)) {
        t = t.slice(0, t.length - w.length).trim();
        changed = true;
        break;
      }
    }
  }
  return t;
}

function stripTrailingTails(text) {
  let t = text;
  let changed = true;
  while (changed && t) {
    changed = false;
    for (const w of POLITE_TAILS) {
      if (t === w) return '';
      if (t.endsWith(w)) {
        t = t.slice(0, t.length - w.length).trim();
        changed = true;
        break;
      }
    }
  }
  return t;
}

// Turns the "rest" of a matched phrase into the candidate name portion.
function extractNamePortion(preNameText) {
  let t = String(preNameText || '').trim();
  if (t.startsWith('ของ')) t = t.slice('ของ'.length).trim();
  t = stripTrailingTails(t);
  t = stripEndParticles(t);
  if (t.startsWith('ของ')) t = t.slice('ของ'.length).trim();
  return t;
}

function isProhibitedName(name) {
  if (!name) return true;
  return PROHIBITED_NAMES.includes(name);
}

// Detect a conservative factual question that includes an explicit name.
// Returns { intent, name } or null.
function detectPersonNameIntent(message) {
  let text = normalizeCollapse(message);
  if (!text) return null;
  text = stripLeadingPoliteness(text);
  if (!text) return null;
  text = stripEndParticles(text);
  if (!text) return null;

  for (const tmpl of PERSON_FACTUAL_TEMPLATES) {
    for (const suffix of tmpl.suffixes) {
      if (text === suffix) continue;
      if (text.endsWith(suffix)) {
        const pre = text.slice(0, text.length - suffix.length).trim();
        if (!pre) continue;
        const name = extractNamePortion(pre);
        if (!name || isProhibitedName(name)) continue;
        return { intent: tmpl.intent, name };
      }
    }
    for (const prefix of tmpl.prefixes) {
      if (text === prefix) continue;
      if (text.startsWith(prefix)) {
        const rest = text.slice(prefix.length).trim();
        if (!rest) continue;
        const name = extractNamePortion(rest);
        if (!name || isProhibitedName(name)) continue;
        return { intent: tmpl.intent, name };
      }
    }
  }
  return null;
}

// Shared deterministic search trunk used by both the STEP-3 factual resolver
// and the STEP-4 analysis resolver. Returns exact (station-scoped) matches and
// the effective search name actually used.
async function searchExactPerson(name, toolRouter, currentUser, limit = NAME_SEARCH_LIMIT) {
  const attempts = buildNameAttempts(name);
  let exactMatches = [];
  let usedName = name;
  for (const attempt of attempts) {
    const res = await toolRouter.searchPersons(currentUser, attempt, limit);
    const rows = (res && res.rows) || [];
    const tokens = attempt.split(/\s+/).filter(Boolean);
    const exact = rows.filter((p) => isExactMatch(p, tokens));
    if (exact.length > 0) {
      exactMatches = uniqueById(exact);
      usedName = attempt;
      break;
    }
  }
  return { exactMatches, usedName };
}

// Deterministic station-scoped person resolution for an explicit Thai name.
// NEVER asks the model to choose. Reserved outcomes:
//   not_found  -> no exact match in the user's station scope
//   ambiguous  -> more than one exact match (candidates returned, no auto-select)
//   unique     -> exactly one person (caller must still run getPersonSummary)
async function resolvePersonByName(name, toolRouter, currentUser, limit = NAME_SEARCH_LIMIT) {
  const { exactMatches, usedName } = await searchExactPerson(name, toolRouter, currentUser, limit);
  const searchToolCall = { toolName: 'search_persons', toolArgs: { query: usedName } };

  if (exactMatches.length === 0) {
    return {
      resolution: 'not_found',
      name: usedName,
      toolCalls: [searchToolCall],
      toolsUsed: ['search_persons'],
      totalCandidates: 0,
      candidates: null,
    };
  }

  if (exactMatches.length === 1) {
    return {
      resolution: 'unique',
      name: usedName,
      person: exactMatches[0],
      toolCalls: [searchToolCall],
      toolsUsed: ['search_persons'],
      totalCandidates: 1,
      candidates: null,
    };
  }

  const totalCandidates = exactMatches.length;
  const candidates = exactMatches.slice(0, CANDIDATE_MAX).map((p) => ({
    personId: p.id,
    displayName: (p.first_name + ' ' + (p.last_name || '')).trim(),
    personType: p.person_type,
    status: p.status,
  }));
  return {
    resolution: 'ambiguous',
    name: usedName,
    toolCalls: [searchToolCall],
    toolsUsed: ['search_persons'],
    totalCandidates,
    candidates,
  };
}

// Build search attempts: the raw candidate first, then (only as a retry) the
// candidate with a leading Thai title prefix stripped.
function titleStrippedTokens(tokens) {
  if (tokens.length === 0) return null;
  const copy = tokens.slice();
  let first = copy[0];
  let changed = false;
  if (THAI_TITLES.includes(first)) {
    copy.shift();
    changed = true;
  } else {
    for (const t of THAI_TITLES) {
      if (first.length > t.length && first.startsWith(t)) {
        copy[0] = first.slice(t.length);
        changed = true;
        break;
      }
    }
  }
  if (!changed) return null;
  if (copy.length > 0) return copy;
  return null;
}

function buildNameAttempts(name) {
  const attempts = [name];
  const tokens = name.split(/\s+/).filter(Boolean);
  const stripped = titleStrippedTokens(tokens);
  if (stripped) {
    const alt = stripped.join(' ');
    if (alt && alt !== name && !isProhibitedName(alt)) attempts.push(alt);
  }
  return attempts;
}

function isExactMatch(person, tokens) {
  const first = person.first_name || '';
  const last = person.last_name || '';
  if (tokens.length <= 1) {
    const tok = tokens[0];
    return first === tok || last === tok;
  }
  const full = (first + ' ' + last).trim();
  const joined = tokens.join(' ');
  const reversed = tokens.slice().reverse().join(' ');
  return full === joined || full === reversed;
}

function uniqueById(rows) {
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    if (!seen.has(r.id)) {
      seen.add(r.id);
      out.push(r);
    }
  }
  return out;
}

async function runPersonNameResolution(query, toolRouter, currentUser) {
  const { intent, name } = query;
  const found = await resolvePersonByName(name, toolRouter, currentUser);

  if (found.resolution === 'not_found') {
    return {
      ok: true,
      resolution: 'not_found',
      intent,
      name: found.name,
      answer: NOT_FOUND_ANSWER,
      toolsUsed: found.toolsUsed,
      toolCalls: found.toolCalls,
      grounded: true,
      presentation: null,
    };
  }

  if (found.resolution === 'ambiguous') {
    return {
      ok: true,
      resolution: 'ambiguous',
      intent,
      name: found.name,
      answer: `พบ ${found.totalCandidates} คนที่ชื่อตรงกันในพื้นที่รับผิดชอบ กรุณาเลือกบุคคลที่ต้องการจากรายการด้านล่าง`,
      toolsUsed: found.toolsUsed,
      toolCalls: found.toolCalls,
      grounded: true,
      presentation: {
        type: 'person_candidates',
        total: found.totalCandidates,
        candidates: found.candidates,
      },
    };
  }

  const person = found.person;
  const searchToolCall = found.toolCalls[0];
  const summary = await toolRouter.getPersonSummary(currentUser, person.id);
  if (!summary.ok) {
    // Should not normally happen (search is already station-scoped), but
    // keeps the authorization guard in the authoritative service layer.
    return {
      ok: true,
      resolution: 'not_found',
      intent,
      name: found.name,
      answer: NOT_FOUND_ANSWER,
      toolsUsed: ['search_persons'],
      toolCalls: [searchToolCall],
      grounded: true,
      presentation: null,
    };
  }
  const answer = buildAnswer(intent, summary.data);
  if (!answer) return { ok: false };
  const summaryCall = { toolName: 'get_person_summary', toolArgs: { person_id: person.id } };
  return {
    ok: true,
    resolution: 'unique_name',
    intent,
    personId: person.id,
    name: (person.first_name + ' ' + (person.last_name || '')).trim(),
    answer,
    toolsUsed: ['search_persons', 'get_person_summary'],
    toolCalls: [searchToolCall, summaryCall],
    grounded: true,
    presentation: {
      type: 'person_summary',
      person: summary.data.person,
      visitSummary: summary.data.visit_summary,
      urineSummary: summary.data.urine_summary,
      followup: summary.data.followup,
      recentVisits: summary.data.recent_visits,
    },
  };
}

module.exports = {
  detectPersonNameIntent,
  runPersonNameResolution,
  searchExactPerson,
  resolvePersonByName,
  stripLeadingPoliteness,
  stripEndParticles,
  isProhibitedName,
  normalizeCollapse,
  buildNameAttempts,
  isExactMatch,
  extractNamePortion,
  NOT_FOUND_ANSWER,
  PERSON_FACTUAL_TEMPLATES,
  THAI_TITLES,
};