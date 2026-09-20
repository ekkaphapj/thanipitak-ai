const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers');
const { createToolRouter } = require('../src/ai/toolRouter');
const { createAIGateway } = require('../src/ai/gateway');

test('aggregate discovery is deterministic, scoped, and does not invoke a model', async () => {
  const ctx = setup();
  const STATION1_USER = { id: 2, username: 'station1_off', role: 'officer', stationId: 1, stationName: 'สภ.จำลอง 1' };
  const gateway = createAIGateway(createToolRouter(ctx.db));
  const result = await gateway.chatWithTools('จากข้อมูลที่มี พบ pattern อะไรบ้าง', STATION1_USER, null, {
    requestFn: async () => assert.fail('discovery must not call a model'),
  });
  assert.equal(result.intent, 'aggregate_discovery');
  assert.equal(result.grounded, true);
  assert.equal(result.ollamaCalls, 0);
  assert.equal(result.presentation.type, 'discovery');
  assert.equal(result.presentation.total, 100);
  assert.match(result.answer, /สรุปเชิงพรรณนา/);
  assert.doesNotMatch(result.answer, /สมชาย/);
  ctx.cleanup();
});

test('aggregate discovery does not widen a station-scoped officer view', async () => {
  const ctx = setup();
  const STATION1_USER = { id: 2, username: 'station1_off', role: 'officer', stationId: 1, stationName: 'สภ.จำลอง 1' };
  const gateway = createAIGateway(createToolRouter(ctx.db));
  const result = await gateway.chatWithTools('วิเคราะห์ภาพรวมข้อมูล', STATION1_USER, null, {
    requestFn: async () => assert.fail('discovery must not call a model'),
  });
  assert.equal(result.presentation.total, 100);
  assert.doesNotMatch(result.answer, /ทุก สภ\.|ทั้งระบบ/);
  ctx.cleanup();
});
