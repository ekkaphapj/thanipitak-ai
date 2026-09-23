const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const { createRealDataRoutes } = require('../src/routes/realDataRoutes');

const stations = [
  { station_id: 101, station_name: 'สภ.ท่าอุเทน', province: 'นครพนม' },
  { station_id: 202, station_name: 'สภ.บ้านดุง', province: 'อุดรธานี' },
  { station_id: 301, station_name: 'สภ.เมืองร้อยเอ็ด', province: 'ร้อยเอ็ด' },
];
const people = [
  { id: 11, prefix: 'นาย', first_name: 'นคร', last_name: 'ทดสอบ', station_id: 101, province: 'นครพนม', amphoe: 'ท่าอุเทน', tambon: 'ท่าอุเทน', type_id: 3 },
  { id: 22, prefix: 'นาย', first_name: 'อุดร', last_name: 'ทดสอบ', station_id: 202, province: 'อุดรธานี', amphoe: 'บ้านดุง', tambon: 'บ้านดุง', type_id: 2 },
  { id: 33, prefix: 'นาง', first_name: 'ร้อยเอ็ด', last_name: 'ทดสอบ', station_id: 301, province: 'ร้อยเอ็ด', amphoe: 'เมือง', tambon: 'ในเมือง', type_id: 3 },
];
const reply = rows => ({ ok: true, headers: new Headers({ 'content-range': rows.length ? `0-${rows.length - 1}/${rows.length}` : '0--1/0' }), json: async () => rows });

function appWithRegistry(reads) {
  const app = express();
  app.use(express.json());
  app.use(createRealDataRoutes((req, res, next) => {
    req.realToken = 'verified-session';
    req.user = { role: 'officer', stationId: 202, stationName: 'สภ.บ้านดุง', province: 'อุดรธานี', aiScope: { level: 'all', read_only: true, provinces: ['นครพนม', 'ร้อยเอ็ด', 'อุดรธานี'] } };
    next();
  }, { url: 'https://example.test', key: 'anon', interpret: async () => { throw new Error('model unavailable'); }, request: async url => {
    const u = new URL(url); reads.push(u);
    if (u.pathname.endsWith('/stations')) {
      let found = stations;
      const province = u.searchParams.get('province');
      if (province) found = found.filter(row => row.province === province.slice(3));
      const ids = u.searchParams.get('station_id');
      if (ids) found = found.filter(row => ids.includes(String(row.station_id)));
      return reply(found);
    }
    if (u.pathname.endsWith('/people_type')) {
      const term = u.searchParams.get('type_name');
      if (term?.includes('ยาเสพติด')) return reply([
        { type_id: 3, type_name: 'ผู้ติดยาเสพติด' },
        { type_id: 4, type_name: 'ผู้ป่วยจิตเวชยาเสพติด' },
      ]);
      if (term?.includes('ผู้เสพ')) return reply([{ type_id: 2 }]);
      return reply([]);
    }
    if (u.pathname.endsWith('/people')) {
      let found = people;
      const ids = u.searchParams.get('station_id');
      if (ids?.startsWith('in.(')) found = found.filter(row => ids.includes(String(row.station_id)));
      if (ids?.startsWith('eq.')) found = found.filter(row => row.station_id === Number(ids.slice(3)));
      const types = u.searchParams.get('type_id');
      if (types) found = found.filter(row => types.includes(String(row.type_id)));
      return reply(found);
    }
    if (u.pathname.endsWith('/visits')) return reply(people.map(row => ({ id: row.id, person_id: row.id, visit_date: '2026-09-20', visit_status: 'เสี่ยงสูง' })));
    if (u.pathname.endsWith('/person_report_status')) return reply([]);
    throw new Error(`unexpected read ${u.pathname}`);
  } }));
  return app;
}

test('ขอรายชื่อผู้เสพ จังหวัดนครพนม includes the legacy drug category and stays in Nakhon Phanom', async () => {
  const reads = [];
  const res = await request(appWithRegistry(reads)).post('/ai/chat').send({ message: 'ขอรายชื่อผู้เสพ จังหวัดนครพนม' });
  assert.equal(res.status, 200);
  assert.equal(res.body.presentation?.type, 'person_list');
  assert.deepEqual(res.body.presentation.items.map(item => item.person_id), [11]);
  assert.equal(res.body.conversation.topic.province, 'นครพนม');
  const list = reads.find(u => u.pathname.endsWith('/people'));
  assert.equal(list.searchParams.get('station_id'), 'in.(101)');
  assert.equal(list.searchParams.get('type_id'), 'in.(2,3)');
});

test('ขอรายชื่อ ผู้เสพที่เสี่ยงสูงของจังหวัดร้อยเอ็ด keeps category and province on the monitoring path', async () => {
  const reads = [];
  const res = await request(appWithRegistry(reads)).post('/ai/chat').send({ message: 'ขอรายชื่อ ผู้เสพที่เสี่ยงสูงของจังหวัดร้อยเอ็ด' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.presentation?.items.map(item => item.person_id), [33]);
  assert.equal(res.body.conversation.topic.province, 'ร้อยเอ็ด');
  const list = reads.find(u => u.pathname.endsWith('/people'));
  assert.equal(list.searchParams.get('station_id'), 'in.(301)');
  assert.equal(list.searchParams.get('type_id'), 'in.(2,3)');
});

test('Nakhon Phanom high risk never includes Udon rows and keeps province on pagination', async () => {
  const reads = [];
  const app = appWithRegistry(reads);
  const first = await request(app).post('/ai/chat').send({ message: 'ขอรายชื่อผู้ที่เสี่ยงสูงของจังหวัดนครพนม' });
  assert.equal(first.status, 200);
  assert.deepEqual(first.body.presentation?.items.map(item => item.person_id), [11]);
  assert.equal(first.body.presentation?.filters.province, 'นครพนม');
  const next = await request(app).post('/ai/chat').send({ message: 'หน้าถัดไป', context: { topic: first.body.conversation.topic } });
  assert.equal(next.status, 200);
  assert.equal(next.body.presentation?.filters.province, 'นครพนม');
  assert.ok(reads.filter(u => u.pathname.endsWith('/people')).every(u => u.searchParams.get('station_id') === 'in.(101)'));
});

test('explicit province in a high-risk request overrides the previous conversation province', async () => {
  const reads = [];
  const app = appWithRegistry(reads);
  const res = await request(app).post('/ai/chat').send({ message: 'ขอรายชื่อผู้ที่เสี่ยงสูงของจังหวัดนครพนม', context: { topic: { province: 'ร้อยเอ็ด' } } });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.presentation?.items.map(item => item.person_id), [11]);
  assert.ok(reads.filter(u => u.pathname.endsWith('/people')).every(u => u.searchParams.get('station_id') === 'in.(101)'));
});

test('PDF follow-up on a recent province list proceeds without confirmation', async () => {
  const app = appWithRegistry([]);
  const first = await request(app).post('/ai/chat').send({ message: 'ขอรายชื่อผู้เสพ จังหวัดนครพนม' });
  const next = await request(app).post('/ai/chat').send({ message: 'ทำเป็นรายงาน pdf ให้หน่อย', context: { topic: first.body.conversation.topic } });
  assert.equal(next.status, 200);
  assert.equal(next.body.presentation?.type, 'report_offer');
  assert.equal(next.body.presentation?.confirm, false);
  assert.equal(next.body.presentation?.auto, 'pdf');
  assert.equal(next.body.presentation?.reportRequest.filters.province, 'นครพนม');
  assert.equal(next.body.presentation?.reportRequest.filters.person_type, 'drug_user');
});

test('PDF follow-up on a high-risk province list retains risk level and province', async () => {
  const app = appWithRegistry([]);
  const first = await request(app).post('/ai/chat').send({ message: 'ขอรายชื่อ ผู้เสพที่เสี่ยงสูงของจังหวัดร้อยเอ็ด' });
  const next = await request(app).post('/ai/chat').send({ message: 'ทำเป็นรายงาน pdf ให้หน่อย', context: { topic: first.body.conversation.topic } });
  assert.equal(next.status, 200);
  assert.equal(next.body.presentation?.confirm, false);
  assert.equal(next.body.presentation?.auto, 'pdf');
  assert.equal(next.body.presentation?.reportRequest.filters.province, 'ร้อยเอ็ด');
  assert.equal(next.body.presentation?.reportRequest.filters.person_type, 'drug_user');
  assert.equal(next.body.presentation?.reportRequest.filters.level, 'high');
});
