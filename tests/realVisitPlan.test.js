const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const { createRealDataRoutes } = require('../src/routes/realDataRoutes');
const { detectVisitPlanIntent } = require('../src/ai/visitPlanIntent');

const counts = Object.fromEntries(['psychiatric', 'drug_user', 'released'].map(key => [key, {
  total: 3, high: 1, watch: 1, red: 1, orange: 1, never_visited: 1,
}]));
function plan(page = 1, totalDue = 2) {
  return {
    status: 'ok', as_of: '2026-09-23', station: { station_id: 77, station_name: 'สภ.กลางใหญ่', province: 'อุดรธานี' },
    counts, priority_counts: [1, 1, 0, 0], total_due: totalDue, page, page_size: 40,
    items: page === 1 ? [
      { person_id: 11, full_name: 'นายตัวอย่าง หนึ่ง', person_type: 'psychiatric', color: 'แดง', risk_level: 'high', priority: 1, last_visit_date: '2026-09-01' },
      { person_id: 12, full_name: 'นางตัวอย่าง สอง', person_type: 'drug_user', color: 'แดง', risk_level: 'normal', priority: 2, last_visit_date: null },
    ] : [],
  };
}
function makeApp(mockRequest, token = 'verified-session') {
  const app = express(); app.use(express.json());
  app.use(createRealDataRoutes((req, res, next) => {
    req.realToken = token;
    req.user = { role: 'officer', stationId: 77, stationName: 'สภ.กลางใหญ่', province: 'อุดรธานี', aiScope: { level: 'all', read_only: true, provinces: ['อุดรธานี', 'นครพนม'] } };
    next();
  }, { url: 'https://example.test', key: 'anon', request: mockRequest, interpret: async () => { throw new Error('plan must not call the model'); } }));
  return app;
}

test('Thai visit-plan phrasings resolve current and named station without a model', async () => {
  const calls = [];
  const app = makeApp(async (url, options) => {
    assert.match(url, /\/rpc\/ai_visit_plan$/);
    calls.push({ body: JSON.parse(options.body), authorization: options.headers.Authorization });
    return { ok: true, json: async () => plan() };
  });
  for (const message of ['ขอแผนการตรวจเยี่ยม', 'สรุปแผนการตรวจเยี่ยม', 'ใครควรไปตรวจเยี่ยมก่อน', 'จัดคิวลงพื้นที่ตรวจเยี่ยม สภ.กลางใหญ่ จังหวัดอุดรธานี', 'ขอแผนตรวจเยี่ยม สภ.กลางใหญ่ จ.อุดรธานี']) {
    const res = await request(app).post('/ai/chat').send({ message });
    assert.equal(res.status, 200, message);
    assert.equal(res.body.presentation.type, 'visit_plan');
    assert.match(res.body.answer, /^แผนการตรวจเยี่ยม สภ\.กลางใหญ่ • ภ\.จว\.อุดรธานี/);
    assert.equal(res.body.presentation.items[0].priority, 1);
    assert.equal(res.body.conversation.topic.report_kind, 'visit_plan');
  }
  assert.equal(calls.length, 5);
  assert.equal(calls[0].body.p_station_name, null);
  assert.equal(calls[3].body.p_station_name, 'กลางใหญ่');
  assert.equal(calls[3].body.p_province, 'อุดรธานี');
  assert.equal(calls[4].body.p_province, 'อุดรธานี');
  assert.ok(calls.every(call => call.authorization === 'Bearer verified-session' && call.body.p_station_id === null));
});

test('unclear spoken station does not silently fall back to current station', async () => {
  let reads = 0;
  const app = makeApp(async () => { reads++; throw new Error('should not read'); });
  for (const message of ['ขอแผนการตรวจเยี่ยม สภ.', 'ขอแผนตรวจเยี่ยม ศพ กลางใหญ่ จังหวัดอุดรธานี']) {
    const res = await request(app).post('/ai/chat').send({ message });
    assert.equal(res.status, 200);
    assert.match(res.body.answer, /ได้ยินชื่อ สภ\. ไม่ชัด/);
  }
  assert.equal(reads, 0);
  assert.ok(detectVisitPlanIntent('สรุปแผนการตรวจเยี่ยม'));
});

test('plan page continuation retains verified station and province; scoped denial fails closed', async () => {
  const calls = [];
  const app = makeApp(async (_url, options) => {
    const body = JSON.parse(options.body); calls.push(body);
    if (body.p_province === 'นครพนม') return { ok: false, status: 403 };
    return { ok: true, json: async () => plan(body.p_page) };
  });
  const first = await request(app).post('/ai/chat').send({ message: 'ขอแผนการตรวจเยี่ยม' });
  const next = await request(app).post('/ai/chat').send({ message: 'หน้าถัดไป', context: { topic: first.body.conversation.topic } });
  assert.equal(next.status, 200);
  assert.equal(calls[1].p_page, 2);
  assert.equal(calls[1].p_station_name, 'สภ.กลางใหญ่');
  assert.equal(calls[1].p_province, 'อุดรธานี');
  const denied = await request(app).post('/ai/chat').send({ message: 'ขอแผนการตรวจเยี่ยม สภ.กลางใหญ่ จังหวัดนครพนม' });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.code, 'REAL_ACCESS_DENIED');
  assert.equal(denied.body.presentation, undefined);
});

test('plan and report both require the verified session token', async () => {
  let reads = 0;
  const app = makeApp(async () => { reads++; throw new Error('missing session must not reach registry'); }, null);
  const planResult = await request(app).post('/ai/chat').send({ message: 'ขอแผนการตรวจเยี่ยม' });
  assert.equal(planResult.status, 403);
  const report = await request(app).post('/reports/visit-plan.pdf').send({ reportRequest: { report_kind: 'visit_plan', station: 'สภ.กลางใหญ่', province: 'อุดรธานี' } });
  assert.equal(report.status, 403);
  assert.equal(reads, 0);
});

test('PDF follow-up is automatic and the authenticated report endpoint generates a PDF', async () => {
  const previous = process.env.REPORT_FONT_PATH;
  process.env.REPORT_FONT_PATH = process.platform === 'win32' ? 'C:\\Windows\\Fonts\\tahoma.ttf' : '/usr/share/fonts/truetype/tlwg/Garuda.ttf';
  try {
    const calls = [];
    const app = makeApp(async (_url, options) => { calls.push(JSON.parse(options.body)); return { ok: true, json: async () => plan() }; });
    const first = await request(app).post('/ai/chat').send({ message: 'ขอแผนการตรวจเยี่ยม สภ.กลางใหญ่ จังหวัดอุดรธานี' });
    const follow = await request(app).post('/ai/chat').send({ message: 'ทำเป็นรายงาน pdf ให้หน่อย', context: { topic: first.body.conversation.topic } });
    assert.equal(follow.status, 200);
    assert.equal(follow.body.presentation.auto, 'pdf');
    assert.equal(follow.body.presentation.confirm, false);
    const pdf = await request(app).post('/reports/visit-plan.pdf').send({ reportRequest: follow.body.presentation.reportRequest });
    assert.equal(pdf.status, 200);
    assert.match(pdf.headers['content-type'], /application\/pdf/);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].p_page_size, 100);
  } finally {
    if (previous === undefined) delete process.env.REPORT_FONT_PATH; else process.env.REPORT_FONT_PATH = previous;
  }
});
