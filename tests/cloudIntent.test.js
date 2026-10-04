'use strict';

// Cloud AI (OpenRouter) trial — CONTROL-PLANE-only intent parsing with the
// privacy guard. Every network call in this file is a mock; no key, no
// registry, no live model is used.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const { sanitizeForCloud, restoreLocalReferences, assertCloudSafe } = require('../src/ai/privacyGuard');
const { cloudConfig, interpretViaCloud } = require('../src/ai/openRouter');
const { createRealDataRoutes } = require('../src/routes/realDataRoutes');

const CLOUD_ENV = { CLOUD_AI_ENABLED: 'true', OPENROUTER_API_KEY: 'test-key', OPENROUTER_MODEL: 'test/model' };

function stripUndefined(o) { return JSON.parse(JSON.stringify(o)); }

// ---------------------------------------------------------------- guard ----

test('guard: a plain aggregate question passes through untouched (spec §24 safe case)', () => {
  const out = sanitizeForCloud('ในพื้นที่ของฉันมีทั้งหมดกี่คน');
  assert.equal(out.safeText, 'ในพื้นที่ของฉันมีทั้งหมดกี่คน');
  assert.deepEqual(out.mapping, {});
  assert.deepEqual(assertCloudSafe(out.safeText, out.mapping), { ok: true });
});

test('guard: title-prefixed person name becomes PERSON_n and never leaves (spec §24 name case)', () => {
  const out = sanitizeForCloud('ค้นหานายสมชาย ใจดี');
  assert.ok(out.safeText.includes('[PERSON_1]'), out.safeText);
  assert.ok(!out.safeText.includes('สมชาย'));
  assert.ok(!out.safeText.includes('ใจดี'));
  assert.equal(out.mapping['[PERSON_1]'], 'นายสมชาย ใจดี');
  assert.equal(assertCloudSafe(out.safeText, out.mapping).ok, true);
});

test('guard: national ID becomes NATIONAL_ID_n, phone becomes PHONE_n (Thai digits too)', () => {
  const id = sanitizeForCloud('ค้นหาเลขบัตร 1234567890123');
  assert.ok(id.safeText.includes('[NATIONAL_ID_1]'));
  assert.ok(!id.safeText.includes('1234567890123'));
  const phone = sanitizeForCloud('ค้นหา 0812345678');
  assert.ok(phone.safeText.includes('[PHONE_1]'), phone.safeText);
  assert.ok(!phone.safeText.includes('0812345678'));
  const thaiDigits = sanitizeForCloud('เลขบัตร๑๒๓๔๕๖๗๘๙๐๑๒๓');
  assert.ok(thaiDigits.safeText.includes('[NATIONAL_ID_1]'));
  const email = sanitizeForCloud('อีเมล a.b@example.com ใช่ไหม');
  assert.ok(email.safeText.includes('[EMAIL_1]'));
  assert.ok(!email.safeText.includes('example.com'));
});

test('guard: list requests keep รายชื่อ and station names intact', () => {
  const out = sanitizeForCloud('ขอรายชื่อผู้ป่วยจิตเวช สภ.บ้านดุง จังหวัดอุดรธานี');
  assert.equal(out.safeText, 'ขอรายชื่อผู้ป่วยจิตเวช สภ.บ้านดุง จังหวัดอุดรธานี');
  assert.deepEqual(out.mapping, {});
});

test('guard: name capture stops at place cues and keeps the station for the plan', () => {
  const out = sanitizeForCloud('ค้นหานายแดง ใจดี สภ.ท่าอุเทน จังหวัดนครพนม');
  assert.ok(out.safeText.includes('[PERSON_1]'));
  assert.ok(out.safeText.includes('สภ.ท่าอุเทน'));
  assert.ok(out.safeText.includes('จังหวัดนครพนม'));
  assert.equal(out.mapping['[PERSON_1]'], 'นายแดง ใจดี');
});

test('guard: a Thai-script subdistrict is never swallowed into the name (live dry-run regression)', () => {
  const out = sanitizeForCloud('ค้นหานายสมชาย ใจดี ตำบลโพนสูง');
  assert.ok(out.safeText.includes('[PERSON_1]'), out.safeText);
  assert.ok(out.safeText.includes('ตำบลโพนสูง'), out.safeText);
  assert.equal(out.mapping['[PERSON_1]'], 'นายสมชาย ใจดี');
  const cue = sanitizeForCloud('ค้นหาสมหญิง ตำบลโพนสูง');
  assert.ok(cue.safeText.includes('ตำบลโพนสูง'));
  assert.equal(cue.mapping['[PERSON_1]'], 'สมหญิง');
});

test('guard: assertCloudSafe fails closed on leaks and credential shapes', () => {
  assert.equal(assertCloudSafe('ค้นหาสมชาย ใจดี', { '[PERSON_1]': 'สมชาย ใจดี' }).reason, 'MAPPING_LEAK');
  assert.equal(assertCloudSafe('เลข 1234567890123', {}).reason, 'NATIONAL_ID');
  assert.equal(assertCloudSafe('โทร 0812345678', {}).reason, 'PHONE');
  assert.equal(assertCloudSafe('mail x@example.com', {}).reason, 'EMAIL');
  assert.equal(assertCloudSafe('tok eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload', {}).reason, 'JWT');
  assert.equal(assertCloudSafe('api_key: abc123', {}).reason, 'CREDENTIAL');
  assert.equal(assertCloudSafe('ดูนายสมชายให้ที', {}).reason, 'TITLE_NAME');
  assert.equal(assertCloudSafe('ค้นหาสมหญิง', {}).reason, 'UNCUED_NAME');
});

test('guard: restoreLocalReferences round-trips a plan and fails on unresolved refs', () => {
  const plan = { action: 'list', person_type: 'all', group: 'none', direction: 'desc', search: '[PERSON_1]', subdistrict: 'โพนสูง' };
  const out = sanitizeForCloud('ค้นหาสมชาย ใจดี ตำบลโพนสูง');
  const restored = restoreLocalReferences(plan, out.mapping);
  assert.equal(restored.search, out.mapping['[PERSON_1]']);
  assert.equal(restored.subdistrict, 'โพนสูง');
  // A model that invents a placeholder we never issued must fail closed.
  assert.equal(restoreLocalReferences({ ...plan, search: '[PERSON_9]' }, out.mapping), null);
});

// ------------------------------------------------------------ openRouter ----

function mockCloudRequest(contentByCall) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url: String(url), opts });
    const content = contentByCall[Math.min(calls.length - 1, contentByCall.length - 1)];
    if (content instanceof Error) throw content;
    return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) };
  };
  fn.calls = calls;
  return fn;
}

const VALID_PLAN_JSON = JSON.stringify({ action: 'count', person_type: 'drug_user', group: 'none', direction: 'desc' });

test('openRouter: config is env-only and fails closed without https/key/model', () => {
  assert.equal(cloudConfig({}).ok, false);
  assert.equal(cloudConfig({ CLOUD_AI_ENABLED: 'true' }).ok, false);
  assert.equal(cloudConfig({ CLOUD_AI_ENABLED: 'true', OPENROUTER_API_KEY: 'k', OPENROUTER_MODEL: 'm', OPENROUTER_BASE_URL: 'http://insecure' }).ok, false);
  const ok = cloudConfig(CLOUD_ENV);
  assert.equal(ok.ok, true);
  assert.equal(ok.base, 'https://openrouter.ai/api/v1');
  assert.equal(ok.timeoutMs, 15000);
});

test('openRouter: backend call shape, JSON mode, and no PII in the outbound body', async () => {
  const req = mockCloudRequest([VALID_PLAN_JSON]);
  const out = sanitizeForCloud('ค้นหานายสมชาย ใจดี');
  const plan = await interpretViaCloud(out.safeText, { request: req, env: CLOUD_ENV });
  assert.deepEqual(stripUndefined(plan), { action: 'count', person_type: 'drug_user', group: 'none', direction: 'desc' });
  const call = req.calls[0];
  assert.equal(call.url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(call.opts.headers.Authorization, 'Bearer test-key');
  const body = call.opts.body;
  assert.equal(JSON.parse(body).response_format.type, 'json_object');
  assert.equal(JSON.parse(body).model, 'test/model');
  // Network-level verification (spec §24): the sensitive name and the key
  // never appear in anything actually handed to the network layer —
  // including the system prompt (example names are placeholderized).
  assert.ok(!body.includes('สมชาย') && !body.includes('ใจดี') && !body.includes('สมหญิง'));
  assert.ok(body.includes('[PERSON_1]'));
  assert.ok(!body.includes('test-key'));
  assert.ok(call.opts.signal, 'request must carry an abort timeout');
});

test('openRouter: retries once on invalid JSON, then fails; provider errors throw', async () => {
  const retry = mockCloudRequest(['not json', VALID_PLAN_JSON]);
  const plan = await interpretViaCloud('มีผู้เสพกี่คน', { request: retry, env: CLOUD_ENV });
  assert.equal(plan.action, 'count');
  const bad = mockCloudRequest(['not json', 'still not json']);
  await assert.rejects(() => interpretViaCloud('มีผู้เสพกี่คน', { request: bad, env: CLOUD_ENV }));
  const httpErr = mockCloudRequest([{ ok: false }]);
  const failing = async () => ({ ok: false, json: async () => ({}) });
  failing.calls = httpErr.calls;
  await assert.rejects(() => interpretViaCloud('มีผู้เสพกี่คน', { request: failing, env: CLOUD_ENV }), /OpenRouter HTTP/);
});

// ----------------------------------------------------------------- route ----

function cloudRouteApp({ user, supabase, cloudPlan, cloudError, env = CLOUD_ENV } = {}) {
  const cloudCalls = [];
  const localCalls = [];
  const app = express();
  app.use(express.json());
  app.use(createRealDataRoutes((req, res, next) => {
    req.user = user || { role: 'officer', stationId: 77, stationName: 'สภ.บ้านดุง', province: 'อุดรธานี' };
    req.realToken = 'verified-session';
    next();
  }, {
    url: 'https://example.test',
    key: 'anon',
    request: supabase || (async () => { throw new Error('registry must not be read'); }),
    interpret: async (m) => { localCalls.push(m); return { action: 'clarify', person_type: 'all', group: 'none', direction: 'desc' }; },
    cloudInterpret: async (safeText) => {
      cloudCalls.push(safeText);
      if (cloudError) throw cloudError;
      return cloudPlan;
    },
    cloudEnv: env,
  }));
  return { app, cloudCalls, localCalls };
}

test('route: cloud flag sanitizes the name, uses the cloud plan, restores refs before the registry read', async () => {
  const reads = [];
  const { app, cloudCalls, localCalls } = cloudRouteApp({
    cloudPlan: { action: 'list', person_type: 'all', group: 'none', direction: 'desc', search: '[PERSON_1]' },
    supabase: async (url) => {
      const u = new URL(url);
      reads.push(u);
      if (u.pathname.endsWith('/people_type')) return { ok: true, headers: new Headers({ 'content-range': '0-0/1' }), json: async () => [{ type_id: 1 }] };
      return {
        ok: true,
        headers: new Headers({ 'content-range': '0-0/1' }),
        json: async () => [{ id: 9, first_name: 'สมชาย', last_name: 'ใจดี', station_id: 77, province: 'อุดรธานี', amphoe: 'เมือง', tambon: 'โพนสูง', type_id: 1, status: 'active' }],
      };
    },
  });
  const res = await request(app).post('/ai/chat').send({ message: 'ยอดรวมเป็นไงบ้าง นายสมชาย ใจดี', ai_provider: 'cloud' });
  assert.equal(res.status, 200);
  assert.equal(res.body.meta.aiProvider, 'cloud');
  // The cloud saw only the placeholder; the local model was not consulted.
  assert.equal(cloudCalls.length, 1);
  assert.ok(cloudCalls[0].includes('[PERSON_1]'), cloudCalls[0]);
  assert.ok(!cloudCalls[0].includes('สมชาย'));
  assert.equal(localCalls.length, 0);
  // The registry read received the restored real name (server-side only).
  const peopleRead = reads.find((u) => u.pathname.endsWith('/people'));
  assert.ok(peopleRead, 'registry was read with the restored name');
  assert.ok(peopleRead.searchParams.get('or') || peopleRead.searchParams.get('first_name') || decodeURIComponent(peopleRead.href).includes('สมชาย'));
});

test('route: provider failure falls back to Local AI and says so in meta', async () => {
  const { app, cloudCalls, localCalls } = cloudRouteApp({ cloudError: new Error('timeout') });
  const res = await request(app).post('/ai/chat').send({ message: 'เช็คให้หน่อย', ai_provider: 'cloud' });
  assert.equal(res.status, 200);
  assert.equal(res.body.meta.aiProvider, 'local-fallback');
  assert.equal(cloudCalls.length, 1);
  assert.equal(localCalls.length, 1);
});

test('route: without the flag nothing cloud-related runs; tampered body fields cannot force anything', async () => {
  const { app, cloudCalls, localCalls } = cloudRouteApp({ cloudPlan: { action: 'count', person_type: 'all', group: 'none', direction: 'desc' } });
  const res = await request(app).post('/ai/chat').send({ message: 'เช็คให้หน่อย' });
  assert.equal(res.status, 200);
  assert.equal(res.body.meta.aiProvider, undefined);
  assert.equal(cloudCalls.length, 0);
  assert.equal(localCalls.length, 1);
  // Extra body fields do not widen anything: same officer scope, and the
  // cloud path still only runs when explicitly selected.
  const tampered = await request(app).post('/ai/chat').send({ message: 'เช็คให้หน่อย', station_id: 999, role: 'admin' });
  assert.equal(tampered.status, 200);
  assert.equal(tampered.body.meta.aiProvider, undefined);
  assert.equal(cloudCalls.length, 0);
});

test('route: unresolved cloud references fail closed to Local AI', async () => {
  const { app, cloudCalls, localCalls } = cloudRouteApp({
    cloudPlan: { action: 'list', person_type: 'all', group: 'none', direction: 'desc', search: '[PERSON_7]' },
  });
  const res = await request(app).post('/ai/chat').send({ message: 'ยอดรวมเป็นไงบ้าง นายสมชาย ใจดี', ai_provider: 'cloud' });
  assert.equal(res.status, 200);
  assert.equal(res.body.meta.aiProvider, 'local-fallback');
  assert.equal(localCalls.length, 1);
});

test('route: status endpoint reports cloud availability and model, never the key', async () => {
  const on = cloudRouteApp({});
  const statusOn = await request(on.app).get('/ai/status');
  assert.equal(statusOn.body.cloudAvailable, true);
  assert.equal(statusOn.body.cloudModel, 'test/model');
  assert.ok(!JSON.stringify(statusOn.body).includes('test-key'));
  const off = cloudRouteApp({ env: {} });
  const statusOff = await request(off.app).get('/ai/status');
  assert.equal(statusOff.body.cloudAvailable, false);
  assert.equal(statusOff.body.cloudModel, null);
});
