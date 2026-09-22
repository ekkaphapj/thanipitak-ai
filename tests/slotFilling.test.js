'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const { createRealDataRoutes } = require('../src/routes/realDataRoutes');

function makeApp(user, mockRequest, overrides = {}) {
  const app = express();
  app.use(express.json());
  app.use(createRealDataRoutes(
    (req, res, next) => {
      req.user = user;
      req.realToken = 'verified-session';
      next();
    },
    {
      url: 'https://example.test',
      key: 'anon',
      request: mockRequest,
      interpret: async (message) => {
        throw new Error(`unexpected interpret call: ${message}`);
      },
      ...overrides,
    }
  ));
  return app;
}

const ok = (rows, range) => ({
  ok: true,
  headers: new Headers({ 'content-range': range || `0-${rows.length - 1}/${rows.length}` }),
  json: async () => rows,
});

const PEOPLE_SEARCH_SELECT = 'id,first_name,last_name,station_id,province,amphoe,tambon,type_id,status';
const PEOPLE_MONITOR_SELECT = 'id,prefix,first_name,last_name,tambon,amphoe,province,type_id,station_id,status';

test('underspecified question returns smart suggestion choices', async () => {
  const app = makeApp({ role: 'officer', stationId: 77, stationName: 'สภ.ทดสอบ' }, async () => {
    throw new Error('should not call database');
  });

  const res1 = await request(app).post('/ai/chat').send({ message: 'ขอดูข้อมูลหน่อย' });
  assert.equal(res1.status, 200);
  assert.match(res1.body.answer, /พร้อมให้บริการสืบค้นข้อมูล/);
  assert.equal(res1.body.presentation.type, 'summary_choices');
  assert.ok(Array.isArray(res1.body.presentation.choices));
  assert.ok(res1.body.presentation.choices.some((c) => c.label === 'ภาพรวมบุคคลเป้าหมาย'));

  const res2 = await request(app).post('/ai/chat').send({ message: 'มีอะไรบ้าง' });
  assert.equal(res2.status, 200);
  assert.match(res2.body.answer, /พร้อมให้บริการสืบค้นข้อมูล/);
});

test('multi-turn slot filling: inherits area when switching person type', async () => {
  const calls = [];
  const serve = (url) => {
    const u = new URL(url);
    calls.push(u);
    if (u.pathname.endsWith('/people_type')) {
      const typeName = u.searchParams.get('type_name') || '';
      if (/จิตเวช/.test(typeName)) return ok([{ type_id: 1 }], '0-0/1');
      if (/ผู้เสพ/.test(typeName)) return ok([{ type_id: 2 }], '0-0/1');
      if (/ผู้ค้า/.test(typeName)) return ok([{ type_id: 3 }], '0-0/1');
      return ok([{ type_id: 99 }], '0-0/1');
    }
    if (u.pathname.endsWith('/people')) {
      return ok([{ id: 10, first_name: 'สมชาย', last_name: 'ใจดี', station_id: 77, province: 'อุดรธานี', amphoe: 'บ้านดุง', tambon: 'บ้านดุง', type_id: 1, status: 'active' }], '0-0/1');
    }
    throw new Error('unexpected read ' + url);
  };

  const app = makeApp({ role: 'officer', stationId: 77, stationName: 'สภ.บ้านดุง' }, serve);

  // Turn 1: ถามยอดผู้ป่วยจิตเวชตำบลบ้านดุง
  const turn1 = await request(app).post('/ai/chat').send({ message: 'ผู้ป่วยจิตเวชตำบลบ้านดุงมีกี่คน' });
  assert.equal(turn1.status, 200);
  assert.match(turn1.body.answer, /มีผู้ป่วยจิตเวช 1 คน/);
  const topic1 = turn1.body.conversation.topic;
  assert.equal(topic1.subdistrict, 'บ้านดุง');
  assert.equal(topic1.person_type, 'psychiatric');

  // Turn 2: ถามสลับประเภท "แล้วผู้เสพล่ะ" -> ต้องสืบทอดตำบลบ้านดุง
  calls.length = 0;
  const turn2 = await request(app).post('/ai/chat').send({ message: 'แล้วผู้เสพล่ะ', context: { topic: topic1 } });
  assert.equal(turn2.status, 200);
  assert.match(turn2.body.answer, /ผู้เสพ/);
  const peopleCall2 = calls.find((u) => u.pathname.endsWith('/people'));
  assert.ok(peopleCall2);
  assert.equal(peopleCall2.searchParams.get('tambon'), 'ilike.*บ้านดุง*');
  assert.equal(peopleCall2.searchParams.get('station_id'), 'eq.77');
  const topic2 = turn2.body.conversation.topic;
  assert.equal(topic2.person_type, 'drug_user');
  assert.equal(topic2.subdistrict, 'บ้านดุง');

  // Turn 3: ถามสลับประเภท "ผู้ค้ามีกี่คน"
  calls.length = 0;
  const turn3 = await request(app).post('/ai/chat').send({ message: 'ผู้ค้ามีกี่คน', context: { topic: topic2 } });
  assert.equal(turn3.status, 200);
  assert.match(turn3.body.answer, /ผู้ค้า/);
  const peopleCall3 = calls.find((u) => u.pathname.endsWith('/people'));
  assert.ok(peopleCall3);
  assert.equal(peopleCall3.searchParams.get('tambon'), 'ilike.*บ้านดุง*');
  assert.equal(turn3.body.conversation.topic.person_type, 'dealer');
});

test('multi-turn slot filling: transition from count to list', async () => {
  const calls = [];
  const serve = (url) => {
    const u = new URL(url);
    calls.push(u);
    if (u.pathname.endsWith('/people_type')) {
      return ok([{ type_id: 1 }], '0-0/1');
    }
    if (u.pathname.endsWith('/people')) {
      return ok([{ id: 10, first_name: 'สมชาย', last_name: 'ใจดี', station_id: 77, province: 'อุดรธานี', amphoe: 'บ้านดุง', tambon: 'บ้านดุง', type_id: 1, status: 'active' }], '0-0/1');
    }
    throw new Error('unexpected read ' + url);
  };

  const app = makeApp({ role: 'officer', stationId: 77, stationName: 'สภ.บ้านดุง' }, serve);

  // Turn 1: ถามยอด
  const turn1 = await request(app).post('/ai/chat').send({ message: 'ผู้ป่วยจิตเวชตำบลบ้านดุงมีกี่คน' });
  assert.equal(turn1.status, 200);
  const topic1 = turn1.body.conversation.topic;

  // Turn 2: "ขอรายชื่อด้วย"
  calls.length = 0;
  const turn2 = await request(app).post('/ai/chat').send({ message: 'ขอรายชื่อด้วย', context: { topic: topic1 } });
  assert.equal(turn2.status, 200);
  assert.equal(turn2.body.presentation.type, 'person_list');
  assert.equal(turn2.body.presentation.items.length, 1);
  assert.equal(turn2.body.presentation.items[0].full_name, 'สมชาย ใจดี');
  assert.equal(turn2.body.conversation.topic.kind, 'people_list');
  assert.equal(turn2.body.conversation.topic.person_type, 'psychiatric');
  assert.equal(turn2.body.conversation.topic.subdistrict, 'บ้านดุง');
});

test('multi-turn slot filling: risk level switching', async () => {
  const calls = [];
  const serve = (url) => {
    const u = new URL(url);
    calls.push(u);
    if (u.pathname.endsWith('/people') && u.searchParams.get('select') === PEOPLE_MONITOR_SELECT) {
      return ok([{ id: 2, prefix: 'นาย', first_name: 'สมหมาย', last_name: 'มั่นคง', tambon: 'โพนสูง', amphoe: 'เมือง', type_id: 2, station_id: 77, status: 'active' }], '0-0/1');
    }
    if (u.pathname.endsWith('/visits')) {
      return ok([{ id: 9, person_id: 2, visit_date: '2026-09-10', visit_status: 'เฝ้าระวัง' }], '0-0/1');
    }
    if (u.pathname.endsWith('/person_report_status')) return ok([], '0--1/0');
    throw new Error('unexpected read ' + url);
  };

  const app = makeApp({ role: 'officer', stationId: 77, stationName: 'สภ.ทดสอบ' }, serve);

  // Turn 1: ใครเสี่ยงสูงตำบลโพนสูง
  const turn1 = await request(app).post('/ai/chat').send({ message: 'ใครเสี่ยงสูงตำบลโพนสูง' });
  assert.equal(turn1.status, 200);
  const topic1 = turn1.body.conversation.topic;
  assert.equal(topic1.level, 'high');
  assert.equal(topic1.subdistrict, 'โพนสูง');

  // Turn 2: "แล้วกลุ่มเฝ้าระวังล่ะ" -> สลับ level เป็น watch โดยยังคงตำบลโพนสูง
  calls.length = 0;
  const turn2 = await request(app).post('/ai/chat').send({ message: 'แล้วกลุ่มเฝ้าระวังล่ะ', context: { topic: topic1 } });
  assert.equal(turn2.status, 200);
  assert.equal(turn2.body.conversation.topic.level, 'watch');
  assert.equal(turn2.body.conversation.topic.subdistrict, 'โพนสูง');
  const peopleCall2 = calls.find((u) => u.pathname.endsWith('/people') && u.searchParams.get('select') === PEOPLE_MONITOR_SELECT);
  assert.ok(peopleCall2);
  assert.equal(peopleCall2.searchParams.get('tambon'), 'ilike.*โพนสูง*');
});
