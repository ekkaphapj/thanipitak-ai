const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const { createRealDataRoutes } = require('../src/routes/realDataRoutes');
const { detectFastPathIntent } = require('../src/ai/fastPath');

function appFor(user, mockRequest, interpret) {
  const app = express();
  app.use(express.json());
  app.use(createRealDataRoutes((req, res, next) => {
    req.user = user;
    req.realToken = 'verified-session';
    next();
  }, {
    url: 'https://example.test',
    key: 'anon',
    request: mockRequest,
    interpret: interpret || (async () => { throw new Error('model must not be called'); }),
  }));
  return app;
}

function reply(rows, total = rows.length) {
  const end = rows.length ? rows.length - 1 : 0;
  return { ok: true, headers: new Headers({ 'content-range': `0-${end}/${total}` }), json: async () => rows };
}

test('an incomplete real search asks back and does not read or change the topic', async () => {
  assert.equal(detectFastPathIntent('ค้นหา').intent, 'search_incomplete');
  let reads = 0;
  const app = appFor(
    { role: 'officer', stationId: 77, province: 'อุดรธานี' },
    async () => { reads += 1; throw new Error('incomplete search must not read'); },
  );
  const topic = { person_type: 'dealer', district: 'เมือง' };
  const res = await request(app).post('/ai/chat').send({ message: 'ค้นหา', context: { topic } });
  assert.equal(res.status, 200);
  assert.match(res.body.answer, /^เงื่อนไขค้นหาไม่สมบูรณ์ กรุณาลองใหม่/);
  assert.equal(res.body.meta.ollamaCalls, 0);
  assert.equal(res.body.meta.fastPath, true);
  assert.deepEqual(res.body.conversation.topic, topic);
  assert.equal(reads, 0);
});

test('two person types in one count are answered separately and one type stays one count', async () => {
  assert.deepEqual(detectFastPathIntent('ผู้เสพกับผู้ค้ามีกี่คน').mentionedTypes, ['drug_user', 'dealer']);
  const calls = [];
  const app = appFor({ role: 'officer', stationId: 77, stationName: 'สภ.บ้านดุง' }, async (url) => {
    const u = new URL(url);
    calls.push(u);
    if (u.pathname.endsWith('/people_type')) {
      const term = u.searchParams.get('type_name') || '';
      if (term.includes('ผู้เสพ')) return reply([{ type_id: 2 }]);
      if (term.includes('ผู้ค้า')) return reply([{ type_id: 8 }]);
      return reply([]);
    }
    const type = u.searchParams.get('type_id') || '';
    const total = type.includes('(2)') ? 4 : type.includes('(8)') ? 1 : 0;
    return reply(total ? [{ id: 1, station_id: 77, first_name: 'ก', last_name: 'ข', type_id: type.includes('(2)') ? 2 : 8 }] : [], total);
  });
  const both = await request(app).post('/ai/chat').send({ message: 'ผู้เสพกับผู้ค้ามีกี่คน' });
  assert.equal(both.status, 200);
  assert.equal(both.body.meta.ollamaCalls, 0);
  assert.equal(both.body.answer, 'ผู้เสพ 4 คน • ผู้ค้า 1 คน');
  assert.ok(calls.filter((u) => u.pathname.endsWith('/people')).every((u) => u.searchParams.get('station_id') === 'eq.77'));
  calls.length = 0;
  const placed = await request(app).post('/ai/chat').send({ message: 'ผู้เสพกับผู้ค้าในอำเภอเมืองมีกี่คน' });
  assert.equal(placed.status, 200);
  assert.equal(placed.body.answer, 'ในอำเภอเมือง ผู้เสพ 4 คน • ผู้ค้า 1 คน');
  assert.ok(calls.filter((u) => u.pathname.endsWith('/people')).every((u) => u.searchParams.get('amphoe') === 'ilike.*เมือง*'));
  calls.length = 0;
  const one = await request(app).post('/ai/chat').send({ message: 'ผู้ค้ามีกี่คน' });
  assert.equal(one.status, 200);
  assert.equal(one.body.answer, 'มีผู้ค้า 1 คน');
  assert.ok(!one.body.answer.includes('ผู้เสพ'));
  const people = calls.filter((u) => u.pathname.endsWith('/people'));
  assert.equal(people.length, 1);
  assert.equal(people[0].searchParams.get('type_id'), 'in.(8)');
});

test('a missed sentence borrows only topic slots it did not name', async () => {
  assert.equal(detectFastPathIntent('ช่วยดูยอดแยกตามหมู่บ้านแบบที่เยอะก่อน'), null);
  const seen = [];
  const app = appFor(
    { role: 'officer', stationId: 77, province: 'อุดรธานี' },
    async (url) => {
      const u = new URL(url);
      seen.push(u);
      if (u.pathname.endsWith('/people_type')) {
        const term = u.searchParams.get('type_name') || '';
        if (term.includes('ผู้ค้า')) return reply([{ type_id: 8 }]);
        if (term.includes('ผู้เสพ')) return reply([{ type_id: 2 }]);
        return reply([]);
      }
      return reply([{ id: 1, station_id: 77, first_name: 'ก', last_name: 'ข', tambon: 'ก', amphoe: 'เมือง' }], 3);
    },
    async () => ({ action: 'count', person_type: 'all', group: 'none', direction: 'desc' }),
  );
  const topic = { person_type: 'dealer', district: 'ท่าอุเทน' };
  const borrowed = await request(app).post('/ai/chat').send({
    message: 'ช่วยดูยอดแยกตามหมู่บ้านแบบที่เยอะก่อน',
    context: { topic },
  });
  assert.equal(borrowed.status, 200);
  assert.equal(borrowed.body.meta.ollamaCalls, 1);
  const people = seen.filter((u) => u.pathname.endsWith('/people'));
  assert.equal(people.length, 1);
  assert.equal(people[0].searchParams.get('type_id'), 'in.(8)');
  assert.equal(people[0].searchParams.get('amphoe'), 'ilike.*ท่าอุเทน*');
  assert.equal(people[0].searchParams.get('province'), null);
  seen.length = 0;
  const explicit = await request(app).post('/ai/chat').send({
    message: 'ช่วยดูยอดผู้เสพแยกตามหมู่บ้านแบบที่เยอะก่อน',
    context: { topic },
  });
  assert.equal(explicit.status, 200);
  const explicitPeople = seen.filter((u) => u.pathname.endsWith('/people'));
  assert.equal(explicitPeople[0].searchParams.get('type_id'), 'in.(2)');
  assert.equal(explicitPeople[0].searchParams.get('amphoe'), 'ilike.*ท่าอุเทน*');
  seen.length = 0;
  const namedPlace = await request(app).post('/ai/chat').send({
    message: 'ช่วยดูยอดแยกตามหมู่บ้านในอำเภอเมืองแบบที่เยอะก่อน',
    context: { topic },
  });
  assert.equal(namedPlace.status, 200);
  const namedPeople = seen.filter((u) => u.pathname.endsWith('/people'));
  assert.equal(namedPeople[0].searchParams.get('amphoe'), null);
  assert.equal(namedPeople[0].searchParams.get('type_id'), 'in.(8)');
});

test('a model place wins over the previous topic and a fast-path count does not borrow it', async () => {
  const seen = [];
  const app = appFor(
    { role: 'officer', stationId: 77, province: 'อุดรธานี' },
    async (url) => {
      const u = new URL(url);
      seen.push(u);
      if (u.pathname.endsWith('/people_type')) {
        const term = u.searchParams.get('type_name') || '';
        if (term.includes('ผู้เสพ')) return reply([{ type_id: 2 }]);
        return reply([{ type_id: 8 }]);
      }
      return reply([{ id: 1, station_id: 77, first_name: 'ก', last_name: 'ข' }], 2);
    },
    async () => ({ action: 'count', person_type: 'all', group: 'none', direction: 'desc', district: 'โพนสวรรค์' }),
  );
  const planned = await request(app).post('/ai/chat').send({
    message: 'ช่วยดูยอดแยกตามหมู่บ้านแบบที่เยอะก่อน',
    context: { topic: { person_type: 'dealer', district: 'ท่าอุเทน' } },
  });
  assert.equal(planned.status, 200);
  const plannedPeople = seen.filter((u) => u.pathname.endsWith('/people'));
  assert.equal(plannedPeople[0].searchParams.get('amphoe'), 'ilike.*โพนสวรรค์*');
  assert.equal(plannedPeople[0].searchParams.get('type_id'), 'in.(8)');
  seen.length = 0;
  const fast = await request(app).post('/ai/chat').send({
    message: 'ผู้เสพมีกี่คน',
    context: { topic: { person_type: 'dealer', district: 'ท่าอุเทน' } },
  });
  assert.equal(fast.status, 200);
  assert.equal(fast.body.answer, 'มีผู้เสพ 2 คน ในพื้นที่ อำเภอท่าอุเทน');
  assert.equal(fast.body.meta.ollamaCalls, 0);
  const fastPeople = seen.filter((u) => u.pathname.endsWith('/people'));
  assert.equal(fastPeople.length, 1);
  assert.equal(fastPeople[0].searchParams.get('type_id'), 'in.(2)');
  assert.equal(fastPeople[0].searchParams.get('amphoe'), 'ilike.*ท่าอุเทน*');
});
