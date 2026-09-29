'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { setup, USERS } = require('./helpers');
const { createApp } = require('../src/app');
test('fixture guide/profile and aggregate charts stay separate from real recorded visits', async t => {
  const ctx = setup(); t.after(() => ctx.cleanup());
  const { app } = createApp(ctx.db, { gateway: { chatWithTools() { assert.fail('chart requests must bypass the model'); } } });
  const login = await request(app).post('/api/auth/login').send(USERS.station1_off);
  const token = login.body.token;
  const send = message => request(app).post('/api/ai/chat').auth(token, { type: 'bearer' }).send({ message, context: { province: 'ปลอม', stationName: 'ปลอม' } });
  const guide = await send('สร้างกราฟใช้ยังไง');
  assert.equal(guide.status, 200); assert.equal(guide.body.presentation.type, 'chart_help');
  assert.ok(!guide.body.answer.includes('ปลอม')); assert.equal(guide.body.dataSource, 'test');
  const out = await send(guide.body.presentation.choices[0].message);
  assert.equal(out.status, 200); assert.equal(out.body.presentation.type, 'chart'); assert.equal(out.body.dataSource, 'test');
  const count = ctx.db.prepare('SELECT count(*) AS n FROM persons WHERE station_id=1').get().n;
  assert.equal(out.body.presentation.total, count);
  assert.equal(out.body.presentation.values.reduce((a, b) => a + b, 0), count);
  const provincial = await send(guide.body.presentation.choices[1].message);
  assert.equal(provincial.body.presentation.type, 'chart'); assert.equal(provincial.body.presentation.total, count);
  assert.equal(provincial.body.conversation.topic.report_kind, 'chart');
  for (const choice of guide.body.presentation.choices.slice(2, 4)) {
    const visits = await send(choice.message); assert.equal(visits.body.code, 'REAL_FEATURE_REQUIRED'); assert.equal(visits.body.presentation, undefined);
  }
  const hint = await request(app).post('/api/ai/chat/processing').auth(token, { type: 'bearer' }).send({ message: 'สร้างกาฟ' });
  assert.equal(hint.body.willUseLocalAi, false);
  const denied = await request(app).post('/api/ai/chat').send({ message: 'สร้างกราฟ' }); assert.equal(denied.status, 401);
  const forged = await request(app).post('/api/ai/chat').auth(token, { type: 'bearer' }).send({ message: 'สร้างกราฟ', station_id: 999 }); assert.equal(forged.body.code, 'FORBIDDEN_FIELD');
});
test('fixture charts export as chart PDFs; “สร้าง PDF ต่อ” never returns the name list', async t => {
  const ctx = setup(); t.after(() => ctx.cleanup());
  // The chart topic export is a deterministic gateway branch: it builds the
  // offer without calling Ollama or any fixture registry read.
  const { app } = createApp(ctx.db);
  const login = await request(app).post('/api/auth/login').send(USERS.station1_off);
  const token = login.body.token;
  const send = (message, topic) => request(app).post('/api/ai/chat').auth(token, { type: 'bearer' }).send({ message, ...(topic ? { context: { topic } } : {}) });
  const chart = await send('สร้างกราฟบุคคลเป้าหมาย สภ.ของฉัน แยกตามประเภท');
  assert.equal(chart.body.presentation.type, 'chart');
  const topic = chart.body.conversation.topic;
  assert.equal(topic.report_kind, 'chart'); assert.equal(topic.chart_own, true);
  const offer = await send('สร้าง pdf ต่อ', topic);
  assert.equal(offer.status, 200);
  assert.equal(offer.body.presentation.type, 'report_offer');
  assert.equal(offer.body.presentation.auto, 'pdf');
  assert.equal(offer.body.presentation.reportRequest.report_kind, 'chart');
  const pdf = await request(app).post('/api/reports/summary.pdf').auth(token, { type: 'bearer' }).send({ reportRequest: offer.body.presentation.reportRequest });
  assert.equal(pdf.status, 200); assert.match(pdf.headers['content-type'], /application\/pdf/);
  const xlsx = await request(app).post('/api/reports/summary.xlsx').auth(token, { type: 'bearer' }).send({ reportRequest: offer.body.presentation.reportRequest });
  assert.equal(xlsx.status, 400); assert.match(xlsx.body.error, /PDF เท่านั้น/);
});
test('fixture other-province example asks the province, then builds from fixture data', async t => {
  const ctx = setup(); t.after(() => ctx.cleanup());
  const { app } = createApp(ctx.db, { gateway: { chatWithTools() { assert.fail('chart requests must bypass the model'); } } });
  const login = await request(app).post('/api/auth/login').send(USERS.station1_off);
  const token = login.body.token;
  const send = (message, topic) => request(app).post('/api/ai/chat').auth(token, { type: 'bearer' }).send({ message, ...(topic ? { context: { topic } } : {}) });
  const ask = await send('สร้างแผนภูมิบุคคลเป้าหมายราย สภ. จังหวัดอื่น');
  assert.equal(ask.status, 200);
  assert.match(ask.body.answer, /ของจังหวัดใด/);
  assert.equal(ask.body.conversation.topic.pending.type, 'chart_province');
  // Fixture stations sit in กรุงเทพมหานคร/ขอนแก่น/นครราชสีมา/พิษณุโลก; a
  // province with no fixture rows is refused honestly instead of drawn empty.
  const none = await send('อุดรธานี', ask.body.conversation.topic);
  assert.equal(none.status, 200); assert.match(none.body.answer, /ไม่พบข้อมูลของจังหวัดอุดรธานี/);
  const own = await send('กรุงเทพมหานคร', ask.body.conversation.topic);
  assert.equal(own.status, 200); assert.equal(own.body.presentation.type, 'chart');
  assert.equal(own.body.conversation.topic.province, 'กรุงเทพมหานคร');
  assert.equal(own.body.conversation.topic.pending, undefined);
  const cancel = await send('ยกเลิก', ask.body.conversation.topic);
  assert.equal(cancel.status, 200); assert.match(cancel.body.answer, /ยกเลิก/);
});
