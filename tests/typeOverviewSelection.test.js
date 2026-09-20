'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { setup } = require('./helpers');
const { createToolRouter } = require('../src/ai/toolRouter');
const { createAIGateway } = require('../src/ai/gateway');

const OFFICER = { id: 2, username: 'station1_off', role: 'officer', stationId: 1 };
const noModel = async () => assert.fail('deterministic type overview must not call Ollama');

test('root URL redirects directly to the AI assistant page', async (t) => {
  const ctx = setup();
  t.after(() => ctx.cleanup());
  const response = await request(ctx.app).get('/').redirects(0);
  assert.equal(response.status, 302);
  assert.equal(response.headers.location, '/ai.html');
});

test('spoken-style request for category data renders its deterministic overview', async (t) => {
  const ctx = setup();
  t.after(() => ctx.cleanup());
  const gateway = createAIGateway(createToolRouter(ctx.db));

  const out = await gateway.chatWithTools('ขอข้อมูลผู้เสพ', OFFICER, null, { requestFn: noModel });
  assert.equal(out.fastPath, true);
  assert.equal(out.presentation.type, 'overview');
  assert.equal(out.presentation.filters.person_type, 'drug_user');
  assert.deepEqual(out.toolsUsed, ['get_overview']);
});

test('selected person of another category produces a safe choice instead of silently changing scope', async (t) => {
  const ctx = setup();
  t.after(() => ctx.cleanup());
  const gateway = createAIGateway(createToolRouter(ctx.db));
  const selected = ctx.db.prepare("SELECT id FROM persons WHERE station_id = 1 AND person_type = 'psychiatric' LIMIT 1").get();
  assert.ok(selected && selected.id);

  const out = await gateway.chatWithTools('ขอข้อมูลผู้เสพ', OFFICER, null, {
    context: { personId: selected.id }, requestFn: noModel,
  });
  assert.equal(out.fastPath, true);
  assert.equal(out.presentation.type, 'summary_choices');
  assert.equal(out.presentation.selectionConflict, true);
  assert.equal(out.presentation.choices[1].clearSelection, true);
  assert.match(out.answer, /ผู้เสพ/);
  assert.deepEqual(out.toolsUsed, ['get_person_summary']);
});
