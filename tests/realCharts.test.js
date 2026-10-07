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
  app.use(createRealDataRoutes((req, res, next) => { req.user = options.user || USER; req.realToken = 'mock-caller-session'; next(); }, { url: 'https://registry.example.test', key: 'mock-anon', request: fetchMock, readAudit, interpret: options.interpret || (async () => assert.fail('charts/help must never call the model')) }));
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
test('all four executable guide buttons run audited, caller-bound aggregate paths; the fifth asks a province', async t => {
  const { app, calls, db } = harness(t);
  const guide = await request(app).post('/ai/chat').send({ message: GUIDE });
  const executable = guide.body.presentation.choices.filter(choice => !choice.message.endsWith('จังหวัดอื่น'));
  assert.equal(executable.length, 4);
  for (const choice of executable) {
    const out = await request(app).post('/ai/chat').send({ message: choice.message, context: { personId: 99, topic: { province: 'เชียงใหม่' } }, station_id: 999, allowedStationIds: [999] });
    assert.equal(out.status, 200, choice.message); assert.equal(out.body.presentation.type, 'chart', choice.message);
    assert.equal(out.body.presentation.total, 2); assert.equal(out.body.meta.ollamaCalls, 0);
    // A verified chart topic marks which aggregate an export must re-render.
    assert.equal(out.body.conversation.topic.report_kind, 'chart');
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
test('the other-province example asks which province, then the spoken answer builds the chart immediately', async t => {
  const { app, calls } = harness(t);
  const ask = await request(app).post('/ai/chat').send({ message: 'สร้างแผนภูมิบุคคลเป้าหมายราย สภ. จังหวัดอื่น' });
  assert.equal(ask.status, 200);
  assert.match(ask.body.answer, /ของจังหวัดใด/);
  assert.equal(ask.body.conversation.topic.pending.type, 'chart_province');
  // Server-verified scope provinces (minus the own province) become buttons.
  assert.deepEqual(ask.body.presentation.choices.map(c => c.message), ['จังหวัดนครพนม']);
  assert.equal(calls.length, 0);
  // A bare spoken province name completes the chart on the next turn.
  const chart = await request(app).post('/ai/chat').send({ message: 'นครพนม', context: { topic: ask.body.conversation.topic } });
  assert.equal(chart.status, 200);
  assert.equal(chart.body.presentation.type, 'chart');
  assert.match(chart.body.presentation.title, /นครพนม/);
  assert.equal(chart.body.conversation.topic.report_kind, 'chart');
  assert.equal(chart.body.conversation.topic.province, 'นครพนม');
  assert.equal(chart.body.conversation.topic.pending, undefined);
  const summary = calls.find(c => c.u.pathname.endsWith('/ai-summary'));
  assert.equal(summary.body.province, 'นครพนม');
  assert.equal(summary.body.station_id, null);
});
test('the pending chart question only accepts scope provinces and cancels cleanly', async t => {
  const { app, calls } = harness(t, { interpret: async () => ({ action: 'clarify', person_type: 'all', group: 'none', direction: 'desc' }) });
  const ask = await request(app).post('/ai/chat').send({ message: 'สร้างกราฟบุคคลเป้าหมายราย สภ. จังหวัดอื่น' });
  const topic = ask.body.conversation.topic;
  assert.equal(topic.pending.type, 'chart_province');
  // A non-province answer never builds a chart and drops the pending marker:
  // the following bare province word is an ordinary question, not a chart.
  const moved = await request(app).post('/ai/chat').send({ message: 'ใช่', context: { topic } });
  assert.equal(moved.status, 200);
  assert.notEqual(moved.body.presentation && moved.body.presentation.type, 'chart');
  assert.equal(calls.length, 0);
  const after = await request(app).post('/ai/chat').send({ message: 'นครพนม', context: { topic: moved.body.conversation && moved.body.conversation.topic } });
  assert.equal(after.status, 200);
  assert.notEqual(after.body.presentation && after.body.presentation.type, 'chart');
  const cancel = await request(app).post('/ai/chat').send({ message: 'ยกเลิก', context: { topic } });
  assert.equal(cancel.status, 200);
  assert.match(cancel.body.answer, /ยกเลิก/);
});
test('chart export: “สร้าง PDF ต่อ” re-renders the same audited aggregate, never the name list', async t => {
  const { app, calls } = harness(t);
  const chart = await request(app).post('/ai/chat').send({ message: 'สร้างกราฟบุคคลเป้าหมายราย สภ. จังหวัดร้อยเอ็ด' });
  const topic = chart.body.conversation.topic;
  const readsBefore = calls.length;
  const offer = await request(app).post('/ai/chat').send({ message: 'สร้าง pdf ต่อ', context: { topic } });
  assert.equal(offer.status, 200);
  assert.equal(offer.body.presentation.type, 'report_offer');
  assert.equal(offer.body.presentation.auto, 'pdf');
  assert.equal(offer.body.presentation.reportRequest.report_kind, 'chart');
  assert.equal(offer.body.presentation.reportRequest.chart_kind, 'people');
  assert.equal(offer.body.presentation.reportRequest.filters.province, 'ร้อยเอ็ด');
  assert.equal(calls.length, readsBefore); // the offer itself reads nothing
  const pdf = await request(app).post('/reports/summary.pdf').send({ reportRequest: offer.body.presentation.reportRequest });
  assert.equal(pdf.status, 200);
  assert.match(pdf.headers['content-type'], /application\/pdf/);
  // The endpoint re-read the audited aggregate for the printed numbers.
  const after = calls.filter(c => c.u.pathname.endsWith('/ai-summary')).length;
  assert.equal(after, 2);
  // A chart topic never produces the old full name-list report.
  assert.ok(!calls.some(c => c.u.pathname.endsWith('/people') && c.u.searchParams.get('province')));
  const xlsx = await request(app).post('/reports/summary.xlsx').send({ reportRequest: offer.body.presentation.reportRequest });
  assert.equal(xlsx.status, 400);
  assert.match(xlsx.body.error, /PDF เท่านั้น/);
});
test('monthly chart export re-reads recorded visits and prints the same window', async t => {
  const { app, calls, db } = harness(t);
  const chart = await request(app).post('/ai/chat').send({ message: 'สร้างกราฟการตรวจเยี่ยมรายเดือน สภ.ของฉัน 3 เดือนย้อนหลัง' });
  assert.equal(chart.body.conversation.topic.report_kind, 'chart');
  assert.equal(chart.body.conversation.topic.chart_kind, 'visits');
  const offer = await request(app).post('/ai/chat').send({ message: 'ทำเป็น pdf', context: { topic: chart.body.conversation.topic } });
  assert.equal(offer.body.presentation.reportRequest.chart_kind, 'visits');
  assert.equal(offer.body.presentation.reportRequest.chart_own, true);
  assert.ok(offer.body.presentation.reportRequest.filters.window.from);
  const visitsBefore = calls.filter(c => c.u.pathname.endsWith('/visits')).length;
  const pdf = await request(app).post('/reports/summary.pdf').send({ reportRequest: offer.body.presentation.reportRequest });
  assert.equal(pdf.status, 200);
  assert.match(pdf.headers['content-type'], /application\/pdf/);
  assert.ok(calls.filter(c => c.u.pathname.endsWith('/visits')).length > visitsBefore);
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
test('field report: misheard chart word still draws the chart instead of answering a visit total', async t => {
  const { app } = harness(t);
  const mangled = await request(app).post('/ai/chat').send({ message: 'สร้างก๊าบการตรวจเยี่ยมรายเดือนของจังหวัดร้อยเอ็ด' });
  assert.equal(mangled.status, 200);
  assert.equal(mangled.body.presentation.type, 'chart');
  assert.equal(mangled.body.presentation.unit, 'ครั้ง');
  assert.equal(mangled.body.conversation.topic.chart_kind, 'visits');
  assert.equal(mangled.body.meta.ollamaCalls, 0);
  // The สถิติ-prefixed phrasing is the same chart, not the summary card.
  const stats = await request(app).post('/ai/chat').send({ message: 'สร้างกราฟสถิติการตรวจเยี่ยมรายเดือนของจังหวัดร้อยเอ็ด' });
  assert.equal(stats.status, 200);
  assert.equal(stats.body.presentation.type, 'chart');
  assert.notEqual(stats.body.presentation.type, 'visit_summary');
});
