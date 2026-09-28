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
  for (const choice of guide.body.presentation.choices.slice(2)) {
    const visits = await send(choice.message); assert.equal(visits.body.code, 'REAL_FEATURE_REQUIRED'); assert.equal(visits.body.presentation, undefined);
  }
  const hint = await request(app).post('/api/ai/chat/processing').auth(token, { type: 'bearer' }).send({ message: 'สร้างกาฟ' });
  assert.equal(hint.body.willUseLocalAi, false);
  const denied = await request(app).post('/api/ai/chat').send({ message: 'สร้างกราฟ' }); assert.equal(denied.status, 401);
  const forged = await request(app).post('/api/ai/chat').auth(token, { type: 'bearer' }).send({ message: 'สร้างกราฟ', station_id: 999 }); assert.equal(forged.body.code, 'FORBIDDEN_FIELD');
});
