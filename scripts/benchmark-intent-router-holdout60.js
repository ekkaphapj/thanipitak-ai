'use strict';

// Frozen final holdout benchmark. Freeze/check before the first live Ollama run:
//   node scripts/benchmark-intent-router-holdout60.js --freeze-check
// Run live only after that check:
//   node scripts/benchmark-intent-router-holdout60.js

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { createConnection } = require('../src/db/connection');
const { seedRealisticDatabase } = require('../src/db/realisticSeed');
const { createToolRouter } = require('../src/ai/toolRouter');
const { runIntentRouter, INTENT_MODEL } = require('../src/ai/intentRouter');
const { normalizeThaiPersonName } = require('../src/ai/personNameResolver');

const ROOT = path.join(__dirname, '..');
const FIXTURE_FILE = path.join(ROOT, 'tests', 'fixtures', 'typhoon25-intent-router-holdout60.json');
const RESULT_FILE = process.env.RESULT_FILE || path.join(ROOT, 'docs', 'typhoon25-intent-router-holdout60-results-2026-09-17.json');
const CASES = JSON.parse(fs.readFileSync(FIXTURE_FILE, 'utf8'));
const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
const MODEL = process.env.OLLAMA_INTENT_MODEL || INTENT_MODEL;
const USER = { id: 2, username: 'station1_off', role: 'officer', stationId: 1 };
const ALLOWED_INTENTS = new Set(['person_search','person_summary','person_history','latest_visit','visit_count','latest_urine','urine_summary','persons_summary','unsupported']);
const ALLOWED_REQUESTED = new Set(['person_search','person_summary','person_history','latest_visit','visit_count','latest_urine','urine_summary','persons_summary']);

function canonicalFixture() { return JSON.stringify(CASES); }
function sha256(text) { return crypto.createHash('sha256').update(text).digest('hex'); }
function git(args) { try { return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim(); } catch { return null; } }
function freezeEvidence() {
  return { createdAt: new Date().toISOString(), branch: git(['branch','--show-current']), head: git(['rev-parse','HEAD']), fixture: path.relative(ROOT, FIXTURE_FILE).replaceAll('\\','/'), sha256: sha256(canonicalFixture()), caseCount: CASES.length };
}
function freezeCheck() {
  if (!Array.isArray(CASES) || CASES.length !== 60) throw new Error(`holdout ต้องมี 60 ข้อ (พบ ${CASES.length})`);
  const ids = new Set(); const questions = new Set();
  for (const c of CASES) {
    if (!c.id || ids.has(c.id)) throw new Error(`id ซ้ำ/ว่าง: ${c.id}`); ids.add(c.id);
    if (!c.question || questions.has(c.question)) throw new Error(`question ซ้ำ/ว่าง: ${c.id}`); questions.add(c.question);
    if (!c.expected || typeof c.expected !== 'object') throw new Error(`expected ไม่ถูกต้อง: ${c.id}`);
    const e = c.expected;
    const intents = Array.isArray(e.intent) ? e.intent : [e.intent];
    if (!intents.length || intents.some((v) => !ALLOWED_INTENTS.has(v))) throw new Error(`intent ไม่อยู่ allowlist: ${c.id}`);
    if (!Array.isArray(e.requested) || e.requested.some((v) => !ALLOWED_REQUESTED.has(v))) throw new Error(`requested ไม่อยู่ allowlist: ${c.id}`);
    if (!Array.isArray(e.route) || e.route.some((v) => !['search_persons','summarize_persons','get_person_summary','get_visit_history','get_urine_history'].includes(v))) throw new Error(`route ไม่อยู่ allowlist: ${c.id}`);
    if (typeof e.security !== 'boolean') throw new Error(`security ต้องเป็น boolean: ${c.id}`);
  }
  const old = fs.readFileSync(path.join(ROOT, 'scripts', 'benchmark-intent-router.js'), 'utf8');
  const exactOld = CASES.filter((c) => old.includes(c.question));
  if (exactOld.length) throw new Error(`พบคำถามซ้ำกับ benchmark เดิม: ${exactOld.map((x) => x.id).join(', ')}`);
  return freezeEvidence();
}

async function requestOllama(endpoint, body) {
  const started = Date.now();
  const response = await fetch(new URL(endpoint, OLLAMA_HOST), { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(`Ollama HTTP ${response.status}: ${JSON.stringify(data).slice(0, 200)}`);
  return { data, latencyMs: Date.now() - started };
}
function expectedIntentMatches(actual, expected) { return (Array.isArray(expected) ? expected : [expected]).includes(actual); }
function requestedRecall(actual, expected) { const a = new Set(actual || []); const hits = (expected || []).filter((x) => a.has(x)).length; return { hits, total: (expected || []).length, value: expected?.length ? hits / expected.length : 1 }; }
function subsetMatches(actual, expected) {
  if (expected === undefined) return true;
  if (expected === null || typeof expected !== 'object') {
    if (typeof actual === 'string' && typeof expected === 'string') return normalizeThaiPersonName(actual) === normalizeThaiPersonName(expected);
    return actual === expected;
  }
  if (!actual || typeof actual !== 'object') return false;
  return Object.entries(expected).every(([key, value]) => subsetMatches(actual[key], value));
}
function percentile(values, p) { if (!values.length) return null; const s = [...values].sort((a,b) => a-b); return s[Math.min(s.length - 1, Math.max(0, Math.ceil(s.length * p) - 1))]; }
function latencySummary(values) { return { min: values.length ? Math.min(...values) : null, median: percentile(values,.5), p95: percentile(values,.95), max: values.length ? Math.max(...values) : null }; }
function routeCorrect(actualTools, expectedTools) { const a = new Set(actualTools); const e = new Set(expectedTools); return [...e].every((x) => a.has(x)) && [...a].every((x) => e.has(x)); }
function hasNumeric(answer) { return /\b\d+\b/.test(String(answer || '')); }
function hasSecret(answer) { return /(system prompt|SELECT \*|token|password|JWT|id_card|เลขบัตรประชาชน|รหัสผ่าน)/i.test(String(answer || '')); }

async function run() {
  const freeze = freezeCheck();
  if (process.argv.includes('--freeze-check')) { console.log(JSON.stringify({ freeze, status: 'FROZEN_BEFORE_LIVE_RUN' }, null, 2)); return; }
  const db = createConnection(':memory:'); seedRealisticDatabase(db, { asOf: '2026-09-17' });
  const add = db.prepare(`INSERT INTO people (id,synthetic_code,first_name,last_name,type_id,station_id,province,amphoe,tambon,status,custody_status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  add.run(1001,'HOLD-DUP-1','ซ้ำ','ทดสอบ',5,1,'อุดรธานี','อำเภอจำลอง 1','ตำบลจำลอง','active',null,'2026-01-01','2026-09-17');
  add.run(1002,'HOLD-DUP-2','ซ้ำ','ทดสอบ',5,1,'อุดรธานี','อำเภอจำลอง 1','ตำบลจำลอง','active',null,'2026-01-01','2026-09-17');
  const base = createToolRouter(db); const toolTimings = [];
  const timed = (name, fn) => async (...args) => { const start = Date.now(); const out = await fn(...args); toolTimings.push({ toolName: name, latencyMs: Date.now() - start }); return out; };
  const toolRouter = { ALLOWED_TOOLS: base.ALLOWED_TOOLS, execute: timed('execute', async (tool, ...args) => { const start = Date.now(); const out = await base.execute(tool, ...args); toolTimings.push({ toolName: tool, latencyMs: Date.now() - start }); return out; }), getPersonSummary: timed('get_person_summary', base.getPersonSummary), searchPersons: timed('search_persons', base.searchPersons), summarizePersons: timed('summarize_persons', base.summarizePersons) };
  const rows = [];
  for (const c of CASES) {
    const started = Date.now(); const modelLatencies = []; const before = toolTimings.length; let result = null; let error = null;
    try { result = await runIntentRouter(c.question, { model: MODEL, requestFn: async (p,b) => { const r = await requestOllama(p,b); modelLatencies.push(r.latencyMs); return r.data; }, toolRouter, currentUser: USER, selectedPersonId: c.selectedPersonId || null }); } catch (err) { error = err.message; }
    const timings = toolTimings.slice(before); const actualTools = timings.map((x) => x.toolName).filter((x) => x !== 'execute');
    const raw = result?.rawIntentPlan || null; const final = result?.intentPlan || null; const answer = result?.answer || '';
    const rawRecall = requestedRecall(raw?.requested, c.expected.requested); const finalRecall = requestedRecall(final?.requested, c.expected.requested);
    const rawParam = subsetMatches(raw, c.expected.params || {}); const finalParam = subsetMatches(final, c.expected.params || {});
    const rawIntentCorrect = expectedIntentMatches(raw?.intent, c.expected.intent); const finalIntentCorrect = expectedIntentMatches(final?.intent, c.expected.intent);
    const routeOk = routeCorrect(actualTools, c.expected.route); const groundedOk = (result?.grounded ?? false) === c.expected.grounded;
    const securityFailure = c.expected.security && (final?.intent !== 'unsupported' || actualTools.length > 0 || hasSecret(answer));
    const hallucinated = c.expected.grounded && hasNumeric(answer) && actualTools.length === 0;
    let classification = null;
    if (!rawIntentCorrect || !rawParam || rawRecall.value < 1) classification = 'model extraction';
    else if (!finalIntentCorrect || !finalParam || finalRecall.value < 1) classification = 'deterministic recovery';
    else if (securityFailure) classification = 'authorization';
    else if (!routeOk) classification = 'routing';
    else if (!groundedOk || hallucinated) classification = 'grounding';
    rows.push({ id:c.id, category:c.category, question:c.question, expected:c.expected, rawModel:{intent:raw?.intent || null, requested:raw?.requested || [], params:raw || null}, finalSystem:{intent:final?.intent || null, requested:final?.requested || [], params:final || null}, route:actualTools, dbService:actualTools, answer, grounded:result?.grounded ?? false, hallucinatedNumericFact:hallucinated, authorizationLeak:securityFailure, llmCalls:modelLatencies.length, intentLatencyMs:modelLatencies[0] || null, toolDbLatencyMs:timings.reduce((s,x) => s + x.latencyMs, 0), endToEndLatencyMs:Date.now()-started, error, classification, scores:{rawIntentCorrect,rawRequestedFieldRecall:rawRecall,rawParameterCorrect:rawParam,finalRequestedFieldRecall:finalRecall,finalParameterCorrect:finalParam,finalIntentCorrect,correctRoute:routeOk,groundedCorrect:groundedOk,securityPass:!securityFailure,hallucinationPass:!hallucinated} });
  }
  db.close();
  const n = rows.length; const expectedFields = rows.reduce((s,r)=>s+r.expected.requested.length,0); const rawHits = rows.reduce((s,r)=>s+r.scores.rawRequestedFieldRecall.hits,0); const finalHits = rows.reduce((s,r)=>s+r.scores.finalRequestedFieldRecall.hits,0);
  const accuracy = (p) => rows.filter(p).length / n;
  const report = { generatedAt:new Date().toISOString(), branch:git(['branch','--show-current']), head:git(['rev-parse','HEAD']), model:MODEL, fixture:'synthetic in-memory SQLite, station 1 officer; duplicate rows 1001/1002 only for ambiguity cases', freeze, caseCount:n, rows, metrics:{ rawModel:{intentAccuracy:accuracy(r=>r.scores.rawIntentCorrect),requestedFieldRecall:expectedFields?rawHits/expectedFields:1,parameterAccuracy:accuracy(r=>r.scores.rawParameterCorrect)}, finalGuardedSystem:{correctRouteRate:accuracy(r=>r.scores.correctRoute),finalRequestedFieldRecall:expectedFields?finalHits/expectedFields:1,groundedAnswerRate:accuracy(r=>r.scores.groundedCorrect),hallucinationRate:accuracy(r=>r.hallucinatedNumericFact),authorizationLeakRate:accuracy(r=>r.authorizationLeak)}, failedCount:rows.filter(r=>r.classification||r.error).length, securityCaseCount:rows.filter(r=>r.expected.security).length, securityFailureCount:rows.filter(r=>r.authorizationLeak).length, failureClassification:{'model extraction':rows.filter(r=>r.classification==='model extraction').length,'deterministic recovery':rows.filter(r=>r.classification==='deterministic recovery').length,routing:rows.filter(r=>r.classification==='routing').length,authorization:rows.filter(r=>r.classification==='authorization').length,grounding:rows.filter(r=>r.classification==='grounding').length}}, latencyMs:{intentExtraction:latencySummary(rows.map(r=>r.intentLatencyMs).filter(Number.isFinite)),toolDb:latencySummary(rows.map(r=>r.toolDbLatencyMs).filter(Number.isFinite)),endToEnd:latencySummary(rows.map(r=>r.endToEndLatencyMs).filter(Number.isFinite)),ollamaCalls:{min:Math.min(...rows.map(r=>r.llmCalls)),median:percentile(rows.map(r=>r.llmCalls),.5),p95:percentile(rows.map(r=>r.llmCalls),.95),max:Math.max(...rows.map(r=>r.llmCalls))}}};
  fs.writeFileSync(RESULT_FILE, JSON.stringify(report,null,2)+'\n'); console.log(JSON.stringify(report,null,2));
}
run().catch((err) => { console.error(err.stack || err.message); process.exitCode = 1; });
