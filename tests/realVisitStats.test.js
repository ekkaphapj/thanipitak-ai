const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const { createRealDataRoutes } = require('../src/routes/realDataRoutes');
const { detectVisitStatsIntent } = require('../src/ai/visitStatsIntent');

// Registry fixtures behind the mocked Supabase: three target people at
// สภ.บ้านดุง with five recorded visits across June–September 2569.
const PEOPLE = [
  { id: 1, type_id: 10, station_id: 73 },
  { id: 2, type_id: 11, station_id: 73 },
  { id: 3, type_id: 12, station_id: 73 },
];
const TYPES = [
  { type_id: 10, type_name: 'ผู้ป่วยจิตเวช' },
  { type_id: 11, type_name: 'ผู้เสพยาเสพติด' },
  { type_id: 12, type_name: 'ผู้พ้นโทษ' },
];
const VISITS = [
  { id: 101, person_id: 1, visit_date: '2026-06-05' },
  { id: 102, person_id: 2, visit_date: '2026-06-15' },
  { id: 103, person_id: 1, visit_date: '2026-07-02' },
  { id: 104, person_id: 3, visit_date: '2026-08-11' },
  { id: 105, person_id: 2, visit_date: '2026-09-09' },
];
const STATIONS = [
  { station_id: 73, station_name: 'สภ.บ้านดุง', province: 'อุดรธานี' },
  { station_id: 74, station_name: 'สภ.หนองหาปลา', province: 'อุดรธานี' },
];

function page(items) {
  return { ok: true, headers: new Headers({ 'content-range': items.length ? `0-${items.length - 1}/${items.length}` : '*/0' }), json: async () => items };
}

// Minimal PostgREST mock: filters people/visits by the query params the tool
// sends, so a scope or date filter that the app forgot to apply fails loudly.
function makeMock({ people = PEOPLE, visits = VISITS } = {}) {
  const calls = [];
  const handler = async (url) => {
    const u = new URL(url);
    calls.push({ path: u.pathname, params: u.searchParams });
    if (u.pathname.endsWith('/stations')) {
      const province = u.searchParams.get('province');
      return page(STATIONS.filter((row) => !province || row.province === province.replace('eq.', '')));
    }
    if (u.pathname.endsWith('/people_type')) return page(TYPES);
    if (u.pathname.endsWith('/people')) {
      const stationFilter = u.searchParams.get('station_id');
      const wantedStations = stationFilter ? stationFilter.replace('in.', '').replace(/[()]/g, '').split(',').map(Number) : null;
      let rows = people;
      if (wantedStations) rows = rows.filter((row) => wantedStations.includes(Number(row.station_id)));
      return page(rows.slice(0, Number(u.searchParams.get('limit'))));
    }
    if (u.pathname.endsWith('/visits')) {
      const persons = (u.searchParams.get('person_id') || '').replace('in.', '').replace('(', '').replace(')', '').split(',').map(Number);
      const gte = (u.searchParams.getAll('visit_date').find((value) => value.startsWith('gte.')) || '').slice(4);
      const lte = (u.searchParams.getAll('visit_date').find((value) => value.startsWith('lte.')) || '').slice(4);
      let rows = visits.filter((row) => persons.includes(Number(row.person_id)));
      if (gte) rows = rows.filter((row) => row.visit_date >= gte);
      if (lte) rows = rows.filter((row) => row.visit_date <= lte);
      return page(rows.slice(Number(u.searchParams.get('offset') || '0'), Number(u.searchParams.get('offset') || '0') + Number(u.searchParams.get('limit'))));
    }
    throw new Error(`unexpected read ${url}`);
  };
  return { handler, calls };
}

function makeApp(mockRequest, { crossStation = true } = {}) {
  const app = express(); app.use(express.json());
  app.use(createRealDataRoutes((req, res, next) => {
    req.realToken = 'verified-session';
    req.user = crossStation
      ? { role: 'officer', stationId: null, stationName: null, province: null, aiScope: { level: 'all', read_only: true, provinces: ['อุดรธานี', 'นครพนม'] } }
      : { role: 'officer', stationId: 77, stationName: 'สภ.กลางใหญ่', province: 'นครพนม' };
    next();
  }, { url: 'https://example.test', key: 'anon', request: mockRequest, interpret: async () => { throw new Error('visit stats must not call the model'); } }));
  return app;
}

test('the canonical visit-summary command aggregates visits by type and by month', async () => {
  const mock = makeMock();
  const app = makeApp(mock.handler);
  const res = await request(app).post('/ai/chat').send({
    message: 'ขอภาพรวม การตรวจเยี่ยม ผู้ป่วยจิตเวช ผู้เสพ บุคคลพ้นโทษ จังหวัดอุดรธานี สภ.บ้านดุง เดือนมิถุนายนถึงเดือนกันยายน 2569',
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.presentation.type, 'visit_summary');
  assert.match(res.body.answer, /^สรุปการตรวจเยี่ยม • สภ\.บ้านดุง/);
  assert.match(res.body.answer, /ช่วงเดือนมิถุนายน–กันยายน 2569/);
  assert.equal(res.body.presentation.total, 5);
  assert.deepEqual(res.body.presentation.byType.map((row) => [row.label, row.count]), [
    ['ผู้ป่วยจิตเวช', 2], ['ผู้เสพ', 2], ['บุคคลพ้นโทษ', 1],
  ]);
  assert.deepEqual(res.body.presentation.months.map((month) => [month.label, month.total]), [
    ['มิถุนายน 2569', 2], ['กรกฎาคม 2569', 1], ['สิงหาคม 2569', 1], ['กันยายน 2569', 1],
  ]);
  assert.equal(res.body.presentation.months[0].byType.find((row) => row.type === 'psychiatric').count, 1);
  assert.equal(res.body.presentation.visitedPeople, 3);
  assert.equal(res.body.meta.fastPath, true);
  assert.equal(res.body.meta.ollamaCalls, 0);
  assert.equal(res.body.conversation.topic.report_kind, 'visit_summary');
  const peopleRead = mock.calls.find((call) => call.path.endsWith('/people'));
  assert.equal(peopleRead.params.get('station_id'), 'in.(73)');
  const visitReads = mock.calls.filter((call) => call.path.endsWith('/visits'));
  assert.ok(visitReads.length >= 1);
  assert.ok(visitReads.every((call) => call.params.getAll('visit_date').includes('gte.2026-06-01') && call.params.getAll('visit_date').includes('lte.2026-09-30')));
  assert.ok(mock.calls.every((call) => call.path.startsWith('/rest/v1/')));
});

test('word order may swap: period first, type and station afterwards, until "ปัจจุบัน"', async () => {
  const mock = makeMock();
  const app = makeApp(mock.handler);
  const res = await request(app).post('/ai/chat').send({
    message: 'ขอข้อมูลการตรวจเยี่ยม เดือนเมษายน 2569 ถึง ปัจจุบัน ของผู้ป่วยจิตเวช สภ.บ้านดุง จังหวัดอุดรธานี',
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.presentation.type, 'visit_summary');
  assert.match(res.body.presentation.windowLabel, /เมษายน 2569–ปัจจุบัน/);
  assert.equal(res.body.presentation.months[0].label, 'เมษายน 2569');
  // Only the requested type is shown in the breakdown.
  assert.deepEqual(res.body.presentation.byType.map((row) => row.type), ['psychiatric']);
  assert.equal(res.body.presentation.total, 2);
  const visitReads = mock.calls.filter((call) => call.path.endsWith('/visits'));
  assert.ok(visitReads.every((call) => call.params.getAll('visit_date').includes('gte.2026-04-01')));
});

test('a visit summary without a period defaults to the current year and says so', async () => {
  const mock = makeMock();
  const app = makeApp(mock.handler);
  const res = await request(app).post('/ai/chat').send({ message: 'ขอสรุปการตรวจเยี่ยม สภ.บ้านดุง จังหวัดอุดรธานี' });
  assert.equal(res.status, 200);
  assert.equal(res.body.presentation.type, 'visit_summary');
  assert.match(res.body.answer, /ช่วงปีนี้ \(\d{4}\)/);
  const visitReads = mock.calls.filter((call) => call.path.endsWith('/visits'));
  assert.ok(visitReads.every((call) => call.params.getAll('visit_date').some((value) => /^gte\.\d{4}-01-01$/.test(value))));
});

test('a station outside the account scope answers guidance without reading the registry', async () => {
  let reads = 0;
  const app = makeApp(async (url) => { reads += 1; throw new Error(`must not read ${url}`); }, { crossStation: false });
  const res = await request(app).post('/ai/chat').send({ message: 'ขอสรุปการตรวจเยี่ยม สภ.บ้านดุง จังหวัดอุดรธานี เดือนมิถุนายนถึงเดือนกันยายน 2569' });
  assert.equal(res.status, 200);
  assert.match(res.body.answer, /ไม่พบ สภ\.บ้านดุง จังหวัดอุดรธานี ในขอบเขตที่ท่านมีสิทธิ์เข้าถึง/);
  assert.match(res.body.answer, /บัญชีนี้สังกัด สภ\.กลางใหญ่/);
  assert.equal(reads, 0);
});

test('an unclear spoken station asks again instead of summarizing a whole province', async () => {
  let reads = 0;
  const app = makeApp(async (url) => { reads += 1; throw new Error(`must not read ${url}`); });
  const res = await request(app).post('/ai/chat').send({ message: 'ขอสรุปการตรวจเยี่ยม สภ. จังหวัดอุดรธานี เดือนมิถุนายนถึงเดือนกันยายน 2569' });
  assert.equal(res.status, 200);
  assert.match(res.body.answer, /ได้ยินชื่อ สภ\. ไม่ชัด/);
  assert.equal(reads, 0);
});

test('no recorded visits in the window yields an explicit zero summary', async () => {
  const mock = makeMock({ visits: [] });
  const app = makeApp(mock.handler);
  const res = await request(app).post('/ai/chat').send({ message: 'สถิติการตรวจเยี่ยมผู้เสพ สภ.บ้านดุง จังหวัดอุดรธานี เดือนสิงหาคม 2569' });
  assert.equal(res.status, 200);
  assert.equal(res.body.presentation.type, 'visit_summary');
  assert.equal(res.body.presentation.total, 0);
  assert.match(res.body.answer, /ตรวจเยี่ยมทั้งหมด 0 ครั้ง/);
});

test('unsupported period wording and exclusions are refused, and visit plans keep their own path', async () => {
  const mock = makeMock();
  const app = makeApp(mock.handler);
  const compare = await request(app).post('/ai/chat').send({ message: 'ขอสรุปการตรวจเยี่ยม สภ.บ้านดุง จังหวัดอุดรธานี เดือนนี้เทียบกับเดือนที่แล้ว' });
  assert.equal(compare.status, 200);
  assert.match(compare.body.answer, /เปรียบเทียบสองช่วงเวลา/);
  const quarter = await request(app).post('/ai/chat').send({ message: 'ขอสรุปการตรวจเยี่ยม สภ.บ้านดุง จังหวัดอุดรธานี ไตรมาสที่แล้ว' });
  assert.equal(quarter.status, 200);
  assert.match(quarter.body.answer, /ยังไม่รองรับ/);
  const excluded = await request(app).post('/ai/chat').send({ message: 'ขอสรุปการตรวจเยี่ยม สภ.บ้านดุง จังหวัดอุดรธานี เดือนมิถุนายนถึงกันยายน 2569 ยกเว้นตำบลโพนสูง' });
  assert.equal(excluded.status, 200);
  assert.match(excluded.body.answer, /การยกเว้นพื้นที่ยังไม่รองรับกับสรุปการตรวจเยี่ยม/);
  // Plan wording must still route to the visit plan, never the summary.
  const planApp = makeApp(async (url) => {
    if (new URL(url).pathname.endsWith('/rpc/ai_visit_plan')) {
      return { ok: true, json: async () => ({ status: 'ok', as_of: '2026-09-24', station: { station_id: 73, station_name: 'สภ.บ้านดุง', province: 'อุดรธานี' }, counts: { psychiatric: { total: 1 }, drug_user: { total: 1 }, released: { total: 1 } }, priority_counts: [1, 0, 0, 0], total_due: 1, page: 1, page_size: 40, items: [{ person_id: 1, full_name: 'นายทดสอบ ระบบ', person_type: 'psychiatric', priority: 1 }] }) };
    }
    throw new Error(`unexpected read ${url}`);
  });
  const plan = await request(planApp).post('/ai/chat').send({ message: 'ขอแผนการตรวจเยี่ยม สภ.บ้านดุง จังหวัดอุดรธานี' });
  assert.equal(plan.status, 200);
  assert.equal(plan.body.presentation.type, 'visit_plan');
  assert.equal(detectVisitStatsIntent('ขอแผนการตรวจเยี่ยม สภ.บ้านดุง จังหวัดอุดรธานี'), null);
});

test('a selected person keeps ordinary visit-history wording on the person path', async () => {
  // "ขอข้อมูลการตรวจเยี่ยม" with a selected person and no area/period is a
  // person-history question; the aggregate branch must not steal it.
  const detector = detectVisitStatsIntent('ขอข้อมูลการตรวจเยี่ยม');
  assert.ok(detector && !detector.strong && !detector.station);
});
