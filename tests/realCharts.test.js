'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const { DatabaseSync } = require('node:sqlite');
const { createRealDataRoutes } = require('../src/routes/realDataRoutes');
const { createRealReadAuditor } = require('../src/repositories/realReadAuditRepo');
const { currentYearWindow } = require('../src/ai/timeWindow');
const USER = { id: 'verified-real-actor', role: 'User', stationId: 73, stationName: 'สภ.เมืองร้อยเอ็ด', province: 'ร้อยเอ็ด', aiScope: { level: 'all', read_only: true, provinces: ['ร้อยเอ็ด', 'นครพนม'] } };
const GUIDE = 'สร้างกราฟ';
function page(data, total = data.length) { return { ok: true, headers: new Headers({ 'content-range': `*/${total}` }), json: async () => data }; }
function harness(t, options = {}) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const readAudit = options.readAudit === undefined ? createRealReadAuditor(db) : options.readAudit;
  const calls = [];
  const fetchMock = async (url, opts) => {
    const u = new URL(url); const body = opts.body && JSON.parse(opts.body); calls.push({ u, body, opts });
    if (options.request) return options.request(u, body, opts);
    if (u.pathname.endsWith('/ai-summary')) return { ok: true, json: async () => ({ report_type: 'target_person_summary', scope: { level: 'all' }, rows: [{ station_name: 'สภ.เมืองร้อยเอ็ด', psychiatric_total: 1, drug_user_total: 1, dealer_total: 0, released_total: 0, target_total: 2 }] }) };
    if (u.pathname.endsWith('/stations')) return page([{ station_id: 73 }]);
    if (u.pathname.endsWith('/people')) return page([{ id: 1, station_id: 73, type_id: 10 }, { id: 2, station_id: 73, type_id: 11 }]);
    if (u.pathname.endsWith('/people_type')) return page([{ type_id: 10, type_name: 'ผู้ป่วยจิตเวช' }, { type_id: 11, type_name: 'ผู้เสพ' }]);
    if (u.pathname.endsWith('/visits')) return page([{ id: 1, person_id: 1, visit_date: currentYearWindow().to }, { id: 2, person_id: 2, visit_date: currentYearWindow().to }]);
    assert.fail(`unexpected registry read ${u.pathname}`);
  };
  const app = express(); app.use(express.json());
  app.use(createRealDataRoutes((req, res, next) => { req.user = options.user || USER; req.realToken = 'mock-caller-session'; next(); }, { url: 'https://registry.example.test', key: 'mock-anon', request: fetchMock, readAudit, interpret: async () => assert.fail('charts/help must never call the model') }));
  return { app, db, calls };
}
test('real guide is personalized without a registry or model read; browser profile cannot replace affiliation', async t => {
  const { app, calls } = harness(t);
  for (const message of [GUIDE, 'ขอแผนภูมิอะไรได้บ้าง', 'สร้างกราบยังไง', 'สร้างกราฟคะแนนที่ไม่รู้จัก']) {
    const out = await request(app).post('/ai/chat').send({ message, context: { stationId: 999, province: 'เชียงใหม่' }, station_id: 999, role: 'admin' });
    assert.equal(out.status, 200); assert.equal(out.body.presentation.type, 'chart_help'); assert.equal(out.body.meta.ollamaCalls, 0);
    assert.match(out.body.answer, /เมืองร้อยเอ็ด/); assert.ok(!out.body.answer.includes('เชียงใหม่'));
  }
  assert.equal(calls.length, 0);
});
test('all four guide buttons run audited, caller-bound aggregate paths', async t => {
  const { app, calls, db } = harness(t);
  const guide = await request(app).post('/ai/chat').send({ message: GUIDE });
  for (const choice of guide.body.presentation.choices) {
    const out = await request(app).post('/ai/chat').send({ message: choice.message, context: { personId: 99, topic: { province: 'เชียงใหม่' } }, station_id: 999, allowedStationIds: [999] });
    assert.equal(out.status, 200, choice.message); assert.equal(out.body.presentation.type, 'chart', choice.message);
    assert.equal(out.body.presentation.total, 2); assert.equal(out.body.meta.ollamaCalls, 0);
    assert.ok(!JSON.stringify(out.body).includes('person_id'));
  }
  const summaries = calls.filter(c => c.u.pathname.endsWith('/ai-summary'));
  assert.deepEqual(summaries.map(c => c.body.station_id), [73, null]);
  assert.deepEqual(summaries.map(c => c.body.province), ['ร้อยเอ็ด', 'ร้อยเอ็ด']);
  assert.ok(calls.every(c => c.opts.headers.Authorization === 'Bearer mock-caller-session'));
  const ownPeople = calls.find(c => c.u.pathname.endsWith('/people'));
  assert.equal(ownPeople.u.searchParams.get('station_id'), 'in.(73)');
  const audits = db.prepare('SELECT * FROM real_read_audit_logs').all();
  assert.equal(audits.length, calls.length - summaries.length);
  assert.ok(audits.every(a => a.actor === USER.id && a.created_at && JSON.parse(a.result_metadata).status === 'success'));
  assert.ok(audits.some(a => a.requested_station === '73'));
  assert.ok(audits.some(a => a.requested_province === 'นครพนม'));
  assert.ok(!JSON.stringify(audits).includes('mock-caller-session'));
});
test('unknown filters, competing/unsupported/oversized periods show the guide without reads', async t => {
  const { app, calls } = harness(t);
  for (const message of ['สร้างกราฟบุคคลเป้าหมาย สภ.ของฉัน แยกตามประเภท ไม่รวมผู้ค้า', 'สร้างกราฟการตรวจเยี่ยมรายเดือน สภ.ของฉัน ไตรมาสที่แล้ว', 'สร้างกราฟการตรวจเยี่ยมรายเดือน สภ.ของฉัน เดือนนี้เทียบกับเดือนที่แล้ว', 'สร้างกราฟการตรวจเยี่ยมรายเดือน สภ.ของฉัน 25 เดือนย้อนหลัง', 'สร้างกราฟการตรวจเยี่ยมรายเดือน สภ.ของฉัน 3 เดือนย้อนหลัง ไม่รวมผู้ค้า']) {
    const out = await request(app).post('/ai/chat').send({ message });
    assert.equal(out.status, 200); assert.equal(out.body.presentation.type, 'chart_help', message);
  }
  assert.equal(calls.length, 0);
});
test('station-only users cannot request a different province', async t => {
  const { app, calls } = harness(t, { user: { ...USER, aiScope: { level: 'station', read_only: true } } });
  const out = await request(app).post('/ai/chat').send({ message: 'สร้างกราฟการตรวจเยี่ยมรายเดือนของจังหวัด นครพนม' });
  assert.equal(out.status, 403); assert.equal(out.body.code, 'REAL_ACCESS_DENIED'); assert.equal(calls.length, 0);
});
test('audit failure or unavailable audit blocks chart data before reading', async t => {
  for (const readAudit of [null, { start() { throw new Error('disk unavailable'); } }]) {
    const { app, calls } = harness(t, { readAudit });
    const out = await request(app).post('/ai/chat').send({ message: 'สร้างกราฟการตรวจเยี่ยมรายเดือน สภ.ของฉัน 3 เดือนย้อนหลัง' });
    assert.equal(out.status, 503); assert.equal(out.body.code, 'REAL_AUDIT_UNAVAILABLE'); assert.equal(calls.length, 0);
  }
});
test('partial visit pages never produce a chart and failed reads retain audit metadata', async t => {
  const { app, db } = harness(t, { request(u) {
    if (u.pathname.endsWith('/people')) return page([{ id: 1, station_id: 73, type_id: 10 }]);
    if (u.pathname.endsWith('/people_type')) return page([{ type_id: 10, type_name: 'ผู้ป่วยจิตเวช' }]);
    if (u.pathname.endsWith('/visits')) return page([], 10);
    assert.fail('unexpected read');
  } });
  const out = await request(app).post('/ai/chat').send({ message: 'สร้างกราฟการตรวจเยี่ยมรายเดือน สภ.ของฉัน' });
  assert.equal(out.status, 502); assert.equal(out.body.code, 'REAL_DATA_UNVERIFIABLE'); assert.equal(out.body.presentation, undefined);
  assert.equal(db.prepare('SELECT count(*) AS n FROM real_read_audit_logs').get().n, 3);
});
test('registry denial is explicit, audited and cannot fall back to fixture data', async t => {
  const { app, db } = harness(t, { request: () => ({ ok: false, status: 403 }) });
  const out = await request(app).post('/ai/chat').send({ message: 'สร้างกราฟการตรวจเยี่ยมรายเดือน สภ.ของฉัน' });
  assert.equal(out.status, 403); assert.equal(out.body.code, 'REAL_ACCESS_DENIED'); assert.ok(!out.body.presentation);
  const audit = db.prepare('SELECT * FROM real_read_audit_logs').get();
  assert.equal(JSON.parse(audit.result_metadata).code, 'REAL_ACCESS_DENIED');
});
test('processing hints never claim local model work for chart guides/commands', async t => {
  const { app } = harness(t);
  for (const message of ['สร้างกราฟ', 'ขอแผนภูมิทำยังไง', 'สร้างกราฟการตรวจเยี่ยมรายเดือน สภ.ของฉัน 3 เดือนย้อนหลัง']) {
    const out = await request(app).post('/ai/chat/processing').send({ message });
    assert.equal(out.body.willUseLocalAi, false);
  }
});
