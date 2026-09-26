const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const { normalizeUtterance } = require('../src/ai/thaiText');
const { isIntroductionRequest, INTRODUCTION_TEXT } = require('../src/ai/introduction');
const { createAIGateway, willUseLocalAi } = require('../src/ai/gateway');
const { createRealDataRoutes } = require('../src/routes/realDataRoutes');

// ── deterministic detector ──

test('introduction detector accepts the spoken and typed introduction commands', () => {
  const accepted = ['ช่วยแนะนำตัวหน่อย', 'คุณคือใคร', 'เธอคือใคร', 'แนะนำตัวด้วย', 'แนะนำตัวค่ะ', 'ช่วยแนะนำตัว', 'แนะนำตัวให้ฟังหน่อย'];
  for (const phrase of accepted) {
    const normalized = normalizeUtterance(phrase) || phrase;
    assert.equal(isIntroductionRequest(normalized), true, `must match: ${phrase}`);
  }
});

test('introduction detector rejects unrelated product or registry questions', () => {
  const rejected = ['สวัสดี', 'ธานีพิทักษ์คืออะไร', 'ขอวิธีใช้', 'หาคนแนะนำตัวยา', 'ใครเป็นคนพัฒนา', 'ช่วยแนะนำหน่อย', 'ขอภาพรวม สภ.'];
  for (const phrase of rejected) {
    const normalized = normalizeUtterance(phrase) || phrase;
    assert.equal(isIntroductionRequest(normalized), false, `must NOT match: ${phrase}`);
  }
});

test('the introduction text is the owner-specified wording', () => {
  assert.match(INTRODUCTION_TEXT, /^สวัสดีค่ะ ดิฉันคือ ผู้ช่วยเอไอ ธานีพิทักษ์/);
  assert.match(INTRODUCTION_TEXT, /ขอบคุณค่ะ$/);
});

// ── test-mode gateway ──

test('test-mode gateway answers the introduction deterministically without a model call', async () => {
  const gateway = createAIGateway({ execute: async () => { throw new Error('no tool may run'); } });
  for (const phrase of ['คุณคือใคร', 'ช่วยแนะนำตัวหน่อย', 'แนะนำตัวด้วย']) {
    const res = await gateway.chatWithTools(phrase, { id: 1, username: 'officer' }, null, {});
    assert.equal(res.answer, INTRODUCTION_TEXT);
    assert.equal(res.fastPath, true);
    assert.equal(res.ollamaCalls, 0);
    assert.deepEqual(res.toolsUsed, []);
  }
  assert.equal(willUseLocalAi('คุณคือใคร'), false);
});

// ── real-mode route ──

function makeApp(mockRequest) {
  const app = express(); app.use(express.json());
  app.use(createRealDataRoutes((req, res, next) => {
    req.realToken = 'verified-session';
    req.user = { role: 'officer', stationId: 77, stationName: 'สภ.กลางใหญ่', province: 'นครพนม', aiScope: { level: 'all', read_only: true, provinces: ['นครพนม'] } };
    next();
  }, { url: 'https://example.test', key: 'anon', request: mockRequest, interpret: async () => { throw new Error('introduction must not call the model'); } }));
  return app;
}

test('real-mode chat answers the introduction with the fixed text and reads no registry row', async () => {
  let reads = 0;
  const app = makeApp(async (url) => { reads++; throw new Error(`unexpected read ${url}`); });
  for (const phrase of ['ช่วยแนะนำตัวหน่อย', 'คุณคือใครคะ', 'แนะนำตัวด้วย']) {
    const res = await request(app).post('/ai/chat').send({ message: phrase });
    assert.equal(res.status, 200);
    assert.equal(res.body.answer, INTRODUCTION_TEXT);
    assert.equal(res.body.grounded, true);
    assert.equal(res.body.dataSource, 'real');
    assert.equal(res.body.meta.fastPath, true);
    assert.equal(res.body.meta.ollamaCalls, 0);
  }
  assert.equal(reads, 0);
});
