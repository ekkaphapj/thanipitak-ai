'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { interpretRealIntent, coercePlan } = require('../src/ai/realIntent');
const { INTERPRETER_SYSTEM_PROMPT } = require('../src/ai/domainCatalog');
const { SYSTEM_PROMPT } = require('../src/ai/systemPrompt');
const { AI_TOOLS } = require('../src/ai/tools');

function mockChat(content) {
  return async (url, options) => {
    mockChat.last = { url: String(url), body: JSON.parse(options.body) };
    return {
      ok: true,
      json: async () => ({ message: { content: JSON.stringify(content) } }),
    };
  };
}

test('interpreter prompt teaches official registry vocabulary without SQL or secrets', () => {
  assert.match(INTERPRETER_SYSTEM_PROMPT, /psychiatric/);
  assert.match(INTERPRETER_SYSTEM_PROMPT, /คนไข้/);
  assert.match(INTERPRETER_SYSTEM_PROMPT, /people\.tambon/);
  assert.match(INTERPRETER_SYSTEM_PROMPT, /ผู้พ้นโทษ/);
  assert.match(INTERPRETER_SYSTEM_PROMPT, /clarify/);
  assert.doesNotMatch(INTERPRETER_SYSTEM_PROMPT, /app_secrets|pin_code|id_card|SELECT /i);
  assert.match(SYSTEM_PROMPT, /ธานีพิทักษ์/);
  assert.match(SYSTEM_PROMPT, /ผู้ป่วย\/คนไข้หมายถึงจิตเวช/);
  const search = AI_TOOLS.find((tool) => tool.function.name === 'search_persons');
  assert.ok(search.function.parameters.properties.person_type.enum.includes('released'));
});

test('unknown phrasing is sent as the question only and returns a validated plan', async () => {
  const plan = await interpretRealIntent('ช่วยดูยอดคนไข้แต่ละตำบลแบบเยอะก่อน', {
    request: mockChat({ action: 'group', person_type: 'psychiatric', group: 'ตำบล', direction: 'desc' }),
  });
  assert.deepEqual(plan, { action: 'group', person_type: 'psychiatric', group: 'ตำบล', direction: 'desc' });
  assert.equal(mockChat.last.body.think, false);
  assert.equal(mockChat.last.body.messages[0].content, INTERPRETER_SYSTEM_PROMPT);
  assert.equal(mockChat.last.body.messages[1].content, 'ช่วยดูยอดคนไข้แต่ละตำบลแบบเยอะก่อน');
  assert.ok(!JSON.stringify(mockChat.last.body).includes('Bearer'));
});

test('unsupported schema values become clarify instead of crashing, and extra keys are rejected', async () => {
  const coerced = coercePlan({ action: 'group', person_type: 'psychiatric', group: 'หมู่บ้าน', direction: 'desc' });
  assert.equal(coerced.action, 'clarify');
  assert.equal(coerced.group, 'none');

  const plan = await interpretRealIntent('แยกตามหมู่บ้าน', {
    request: mockChat({ action: 'group', person_type: 'all', group: 'หมู่บ้าน', direction: 'desc' }),
  });
  assert.equal(plan.action, 'clarify');

  await assert.rejects(
    () => interpretRealIntent('มีกี่คน', { request: mockChat({ action: 'count', person_type: 'all', group: 'none', direction: 'desc', sql: 'SELECT 1' }) }),
    /ไม่รองรับ/
  );
  await assert.rejects(
    () => interpretRealIntent('มีกี่คน', { request: mockChat({ action: 'count', person_type: 'all', group: 'none', direction: 'desc', search: 'SELECT * FROM people' }) }),
    /พื้นที่ไม่ถูกต้อง/
  );
});
