'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createConnection } = require('../src/db/connection');
const { seedRealisticDatabase } = require('../src/db/realisticSeed');
const { createToolRouter } = require('../src/ai/toolRouter');
const { createAIGateway } = require('../src/ai/gateway');
const { parseSummaryIntent } = require('../src/services/summaryService');
const { createApp } = require('../src/app');

const DAY = '2026-09-17';
const officer = { id: 2, username: 'station1_off', role: 'officer', stationId: 1 };

function fixture(t) {
  const db = createConnection(':memory:');
  seedRealisticDatabase(db, { asOf: DAY });
  t.after(() => db.close());
  return db;
}

test('spoken summaries parse type, monitoring level, locations, list and sort', () => {
  const result = parseSummaryIntent('ช่วยสรุปจำนวนและรายชื่อผู้ป่วยจิตเวชที่เสี่ยงสูง ในจังหวัดอุดรธานี อำเภอจำลอง 1 เรียงตามชื่อ');
  assert.equal(result.intent, 'summary_persons');
  assert.deepEqual(result.filters, { person_type: 'psychiatric', level: 'high', province: 'อุดรธานี', district: 'จำลอง 1' });
  assert.equal(result.includeCount, true);
  assert.equal(result.includeList, true);
  assert.equal(result.sort, 'name_asc');
  assert.equal(parseSummaryIntent('ช่วยสรุป').intent, 'summary_choices');
  assert.equal(parseSummaryIntent('สรุปผู้เสพในจังหวัด').intent, 'summary_choices');
});

test('summary fast path is grounded, scoped and never calls Ollama', async (t) => {
  const db = fixture(t);
  const gateway = createAIGateway(createToolRouter(db));
  const out = await gateway.chatWithTools('สรุปจำนวนและรายชื่อผู้ป่วยจิตเวชที่เสี่ยงสูง เรียงตามชื่อ', officer, null, {
    requestFn: async () => assert.fail('summary must not call Ollama'),
  });
  assert.equal(out.fastPath, true);
  assert.equal(out.presentation.type, 'summary_result');
  assert.equal(out.presentation.total, 3);
  assert.deepEqual(out.presentation.counts, [{ type: 'psychiatric', label: 'จิตเวช', count: 3 }]);
  assert.deepEqual(out.presentation.items.map((item) => item.full_name), ['ทดสอบ1 สถานี1', 'ทดสอบ3 สถานี1', 'ทดสอบ4 สถานี1']);
  assert.ok(out.presentation.items.every((item) => Number.isInteger(item.person_id) && item.person_id > 0));
  assert.match(out.answer, /ต้องการให้สร้างเป็นรายงาน PDF หรือไม่/);

  const choices = await gateway.chatWithTools('สรุป', officer, null, {
    requestFn: async () => assert.fail('summary choices must not call Ollama'),
  });
  assert.equal(choices.presentation.type, 'summary_choices');
  assert.ok(choices.presentation.locations.stations.includes('สภ.จำลอง 1'));
});

test('summary PDF endpoint returns a Thai PDF for the authorized summary', async (t) => {
  const db = fixture(t);
  const { app } = createApp(db);
  const login = await request(app).post('/api/auth/login').send({ username: 'station1_off', password: 'thanipitak123' });
  const response = await request(app)
    .post('/api/reports/summary.pdf')
    .set('Authorization', `Bearer ${login.body.token}`)
    .send({ reportRequest: { filters: { person_type: 'psychiatric', level: 'high' }, includeCount: true, includeList: true, sort: 'name_asc' } })
    .buffer(true)
    .parse((res, done) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => done(null, Buffer.concat(chunks)));
    });
  assert.equal(response.status, 200);
  assert.match(response.headers['content-type'], /application\/pdf/);
  assert.ok(response.body.subarray(0, 4).equals(Buffer.from('%PDF')));
});
