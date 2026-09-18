'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createConnection } = require('../src/db/connection');
const { seedRealisticDatabase } = require('../src/db/realisticSeed');
const { createToolRouter } = require('../src/ai/toolRouter');
const { createAIGateway } = require('../src/ai/gateway');
const { detectFastPathIntent } = require('../src/ai/fastPath');
const { setup } = require('./helpers');
const { createApp } = require('../src/app');
const request = require('supertest');

const DAY = '2026-09-17';
const officer = { id: 2, username: 'station1_off', role: 'officer', stationId: 1 };
const admin = { id: 1, username: 'admin', role: 'admin', stationId: null };

function fixture(t) {
  const db = createConnection(':memory:');
  seedRealisticDatabase(db, { asOf: DAY });
  t.after(() => db.close());
  const gateway = createAIGateway(createToolRouter(db));
  const ask = (message, user = officer) =>
    gateway.chatWithTools(message, user, null, {
      requestFn: async () => assert.fail(`must not call Ollama: ${message}`),
    });
  return { db, gateway, ask };
}

test('spoken count variants keep the subject and do not fall back to the total', async (t) => {
  const { ask } = fixture(t);
  const psych = [
    'มีผู้ป่วยจิตเวชกี่คน',
    'ผู้ป่วยจิตเวชมีทั้งหมดกี่คน',
    'มีจิตเวชกี่คน',
    'คนไข้จิตเวชมีกี่ราย',
    'ขอยอดผู้ป่วยจิตเวช',
    'ผู้ป่วยจิตเวชในพื้นที่มีกี่คน',
  ];
  for (const q of psych) {
    const out = await ask(q);
    assert.equal(out.fastPath, true, q);
    assert.match(out.answer, /8 คน/, q);
    assert.ok(!out.answer.includes('มีบุคคลทั้งหมด 16 คน'), q);
  }
  const bare = await ask('มีผู้ป่วยกี่คน');
  assert.match(bare.answer, /8 คน/);
  assert.match(bare.answer, /หมายถึงผู้ป่วยจิตเวช/);

  assert.match((await ask('มีผู้เสพกี่คน')).answer, /3 คน/);
  assert.match((await ask('ผู้ค้ามียอดเท่าไหร่')).answer, /2 คน/);
  assert.match((await ask('พ้นโทษมีกี่คน')).answer, /3 คน/);
  assert.match((await ask('มีทั้งหมดกี่คน')).answer, /16 คน/);

  for (const q of ['ผู้เสพมีมั้ย', 'มีผู้เสพไหม', 'ผู้เสพมีไหมครับ']) {
    const out = await ask(q);
    assert.equal(out.fastPath, true, q);
    assert.equal(out.intent, 'count_drug_user', q);
    assert.equal(out.answer, 'มีผู้เสพ 3 คน', q);
  }
  assert.equal((await ask('ผู้ค้ามีมั้ย')).answer, 'มีผู้ค้า 2 คน');
});

test('spoken location filters apply to counts and lists', async (t) => {
  const { ask } = fixture(t);
  const count = await ask('มีผู้ป่วยจิตเวชในตำบลจำลองกี่คน');
  assert.equal(count.fastPath, true);
  assert.match(count.answer, /8 คน/);
  assert.match(count.answer, /ตำบลจำลอง/);

  const andConnector = await ask('มีผู้เสพในจังหวัดอุดรธานีและอำเภอจำลอง 1 กี่คน');
  assert.equal(andConnector.fastPath, true);
  assert.match(andConnector.answer, /3 คน/);
  assert.match(andConnector.answer, /จังหวัดอุดรธานี/);
  assert.match(andConnector.answer, /อำเภอจำลอง 1/);

  const list = await ask('ขอรายชื่อผู้ป่วยจิตเวชในตำบลจำลอง');
  assert.equal(list.presentation.type, 'person_list');
  assert.equal(list.presentation.total, 8);
  assert.ok(list.presentation.items.every((item) => item.subdistrict === 'ตำบลจำลอง'));

  const search = await ask('ค้นหาผู้เสพ ในจังหวัดอุดรธานี อำเภอจำลอง 1');
  assert.equal(search.presentation.total, 3);
  assert.ok(search.presentation.items.every((item) => item.person_type === 'drug_user'));
});

test('ranking questions return places not people and keep the subject', async (t) => {
  const { db, ask } = fixture(t);
  db.prepare(`INSERT INTO people(id,synthetic_code,first_name,last_name,type_id,station_id,province,amphoe,tambon,status,created_at,updated_at)
    VALUES(901,'SIM-RANK-1','เพิ่ม1','ตำบลข',1,1,'อุดรธานี','อำเภอจำลอง 1','ตำบลข','เขียว',?,?),
          (902,'SIM-RANK-2','เพิ่ม2','ตำบลข',1,1,'อุดรธานี','อำเภอจำลอง 1','ตำบลข','เขียว',?,?)`).run(DAY, DAY, DAY, DAY);

  const winner = await ask('ตำบลไหนมีผู้ป่วยมากที่สุด');
  assert.equal(winner.fastPath, true);
  assert.equal(winner.presentation.type, 'location_summary');
  assert.match(winner.answer, /ตำบลจำลอง/);
  assert.match(winner.answer, /8 คน/);
  assert.ok(!winner.answer.includes('ทดสอบ1 สถานี1'), 'must not dump person names');
  assert.match(winner.answer, /หมายถึงผู้ป่วยจิตเวช/);

  const ordered = await ask('ขอจำนวนผู้ป่วยเรียงตามตำบล จากมากไปน้อย');
  assert.ok(ordered.answer.indexOf('ตำบลจำลอง') < ordered.answer.indexOf('ตำบลข'));
  assert.match(ordered.answer, /มากไปน้อย/);
  assert.match(ordered.answer, /ตำบลข/);
  assert.match(ordered.answer, /2 คน/);

  const spoken = await ask('อยากเห็นยอดคนไข้แจกแจงรายตำบล เอาที่เยอะขึ้นก่อน');
  assert.equal(spoken.presentation.type, 'location_summary');
  assert.ok(spoken.answer.indexOf('ตำบลจำลอง') < spoken.answer.indexOf('ตำบลข'));
});

test('summary-style ranking and monitoring grouping stay on place counts', async (t) => {
  const { ask } = fixture(t);
  const summaryRank = await ask('สรุปจำนวนผู้ป่วยเรียงตามตำบล');
  assert.equal(summaryRank.presentation.type, 'location_summary');
  assert.match(summaryRank.answer, /ตำบลจำลอง/);
  assert.ok(!summaryRank.answer.includes('ต้องการให้สร้างเป็นรายงาน PDF'));

  const monitored = await ask('ผู้ป่วยจิตเวชเสี่ยงสูงแยกตามตำบล');
  assert.equal(monitored.presentation.type, 'monitoring_location_summary');
  assert.match(monitored.answer, /ตำบลจำลอง — 3 คน/);
  assert.ok(!monitored.answer.includes('ทดสอบ1 สถานี1'));
});

test('list follow-up inherits the previous person type from conversation', async (t) => {
  const { ask, gateway } = fixture(t);
  const count = await ask('มีผู้เสพกี่คน');
  assert.equal(count.conversation.topic.person_type, 'drug_user');
  const names = await gateway.chatWithTools('ขอรายชื่อหน่อย', officer, null, {
    requestFn: async () => assert.fail('follow-up list must not call Ollama'),
    context: { topic: count.conversation.topic },
  });
  assert.equal(names.fastPath, true);
  assert.equal(names.intent, 'list_drug_user');
  assert.equal(names.presentation.type, 'person_list');
  assert.equal(names.presentation.total, 3);
  assert.ok(names.presentation.items.every((item) => item.person_type === 'drug_user'));
  assert.match(names.answer, /ผู้เสพ/);

  const all = await gateway.chatWithTools('ขอรายชื่อทั้งหมด', officer, null, {
    requestFn: async () => assert.fail('explicit all-list must not call Ollama'),
    context: { topic: count.conversation.topic },
  });
  assert.equal(all.intent, 'list_all');
  assert.equal(all.presentation.total, 16);

  const mixed = await ask('มีผู้ป่วยจิตเวชและผู้เสพกี่คน');
  const askWhich = await gateway.chatWithTools('ขอรายชื่อหน่อย', officer, null, {
    requestFn: async () => assert.fail('ambiguous list must not call Ollama'),
    context: { topic: mixed.conversation.topic },
  });
  assert.equal(askWhich.intent, 'lookup_clarify');
  assert.match(askWhich.answer, /รายชื่อผู้เสพ/);
  assert.match(askWhich.answer, /รายชื่อทั้งหมด/);
});

test('two types in one count are answered separately instead of picking one', async (t) => {
  const { ask } = fixture(t);
  const out = await ask('มีผู้ป่วยจิตเวชและผู้เสพกี่คน');
  assert.equal(out.fastPath, true);
  assert.match(out.answer, /ผู้ป่วยจิตเวช 8 คน/);
  assert.match(out.answer, /ผู้เสพ 3 คน/);
});

test('admin ranking separates identically named subdistricts by district', async (t) => {
  const { ask } = fixture(t);
  const out = await ask('ตำบลไหนมีผู้ป่วยจิตเวชมากที่สุด', admin);
  assert.equal(out.presentation.type, 'location_summary');
  assert.ok(out.presentation.items.length >= 2);
  assert.ok(out.presentation.items.every((item) => item.name === 'ตำบลจำลอง'));
  assert.match(out.answer, /อำเภอจำลอง 1/);
  assert.match(out.answer, /อำเภอจำลอง 2/);
});

test('legacy phrasing ผู้ป่วยจิตเวชมีทั้งหมดกี่คน is psychiatric not the station total', async () => {
  const ctx = setup();
  try {
    const { app } = createApp(ctx.db, {
      gateway: {
        chatWithTools: (msg, user, onToolCall) =>
          createAIGateway(require('../src/ai/toolRouter').createToolRouter(ctx.db)).chatWithTools(msg, user, onToolCall, {
            requestFn: async () => {
              throw new Error('Ollama must not be called');
            },
          }),
      },
    });
    const login = await request(app).post('/api/auth/login').send({ username: 'station1_off', password: 'thanipitak123' });
    const res = await request(app)
      .post('/api/ai/chat')
      .set('Authorization', `Bearer ${login.body.token}`)
      .send({ message: 'ผู้ป่วยจิตเวชมีทั้งหมดกี่คน' });
    assert.equal(res.status, 200);
    assert.equal(res.body.meta.fastPath, true);
    assert.match(res.body.answer, /37 คน/);
    assert.ok(!res.body.answer.includes('บุคคลทั้งหมด 100 คน'));
    assert.equal(detectFastPathIntent('ผู้ป่วยจิตเวชมีทั้งหมดกี่คน').intent, 'count_psychiatric');
    assert.equal(detectFastPathIntent('มีทั้งหมดกี่คน').intent, 'count_total');
  } finally {
    ctx.cleanup();
  }
});
