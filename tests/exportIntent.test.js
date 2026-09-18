'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { detectExportIntent } = require('../src/ai/exportIntent');
const { createXlsxBuffer } = require('../src/services/excelReport');
const { createConnection } = require('../src/db/connection');
const { seedRealisticDatabase } = require('../src/db/realisticSeed');
const { createToolRouter } = require('../src/ai/toolRouter');
const { createAIGateway } = require('../src/ai/gateway');
const { createApp } = require('../src/app');

test('spoken export phrases select pdf, excel, or both', () => {
  assert.deepEqual(detectExportIntent('สร้าง pdf ให้หน่อย').formats, ['pdf']);
  assert.equal(detectExportIntent('สร้าง pdf ให้หน่อย').auto, 'pdf');
  assert.deepEqual(detectExportIntent('สร้าง excel ให้หน่อย').formats, ['xlsx']);
  const spoken = detectExportIntent('ช่วยทำเป็นรายงานพีทีเอฟให้หน่อย');
  assert.ok(spoken.formats.includes('pdf'));
  assert.equal(spoken.confirm, true);
  assert.equal(spoken.auto, null);
  const report = detectExportIntent('สร้างรายงานให้หน่อย');
  assert.ok(report.formats.includes('pdf'));
  assert.equal(report.confirm, true);
  assert.equal(detectExportIntent('สร้าง pdf ผู้เสพ').filters.person_type, 'drug_user');
  assert.equal(detectExportIntent('มีผู้เสพกี่คน'), null);
});

test('xlsx buffer is a zip archive excel can open', () => {
  const buf = createXlsxBuffer([['ชื่อ', 'ประเภท'], ['ทดสอบ', 'ผู้เสพ']]);
  assert.ok(buf.subarray(0, 2).equals(Buffer.from('PK')));
  assert.ok(buf.length > 200);
});

test('export chat is deterministic and uses conversation topic', async () => {
  const db = createConnection(':memory:');
  seedRealisticDatabase(db, { asOf: '2026-09-17' });
  const gateway = createAIGateway(createToolRouter(db));
  const officer = { id: 2, username: 'station1_off', role: 'officer', stationId: 1 };
  const out = await gateway.chatWithTools('สร้าง excel ให้หน่อย', officer, null, {
    requestFn: async () => assert.fail('export must not call Ollama'),
    context: { topic: { person_type: 'drug_user' } },
  });
  assert.equal(out.fastPath, true);
  assert.equal(out.presentation.type, 'report_offer');
  assert.deepEqual(out.presentation.formats, ['xlsx']);
  assert.equal(out.presentation.auto, 'xlsx');
  assert.equal(out.presentation.reportRequest.filters.person_type, 'drug_user');
  db.close();
});

test('summary excel endpoint returns an xlsx for the authorized station', async () => {
  const db = createConnection(':memory:');
  seedRealisticDatabase(db, { asOf: '2026-09-17' });
  const { app } = createApp(db);
  const login = await request(app).post('/api/auth/login').send({ username: 'station1_off', password: 'thanipitak123' });
  const response = await request(app)
    .post('/api/reports/summary.xlsx')
    .set('Authorization', `Bearer ${login.body.token}`)
    .send({ reportRequest: { filters: { person_type: 'drug_user' }, includeCount: true, includeList: true } })
    .buffer(true)
    .parse((res, done) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => done(null, Buffer.concat(chunks)));
    });
  assert.equal(response.status, 200);
  assert.match(response.headers['content-type'], /spreadsheetml|octet-stream|zip/);
  assert.ok(response.body.subarray(0, 2).equals(Buffer.from('PK')));
  db.close();
});
