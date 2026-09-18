'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createConnection } = require('../src/db/connection');
const { seedRealisticDatabase } = require('../src/db/realisticSeed');
const { createToolRouter } = require('../src/ai/toolRouter');
const { createAIGateway } = require('../src/ai/gateway');

const OFFICER = { id: 2, username: 'station1_off', role: 'officer', stationId: 1 };

function fixture(t) {
  const db = createConnection(':memory:');
  seedRealisticDatabase(db, { asOf: '2026-09-17' });
  t.after(() => db.close());
  return createAIGateway(createToolRouter(db));
}

function noModel() {
  return async () => assert.fail('initial workflow must stay deterministic and must not call Ollama');
}

test('initial workflow: count then ranked area breakdown remains station-scoped and model-free', async (t) => {
  const gateway = fixture(t);
  const count = await gateway.chatWithTools('ผู้เสพมีกี่คน', OFFICER, null, { requestFn: noModel() });
  assert.equal(count.fastPath, true);
  assert.equal(count.intent, 'count_drug_user');
  assert.deepEqual(count.toolsUsed, ['get_statistics']);
  assert.match(count.answer, /ผู้เสพ 3 คน/);
  assert.deepEqual(count.conversation.topic, { person_type: 'drug_user' });

  const ranked = await gateway.chatWithTools('ผู้เสพตำบลไหนมากที่สุด', OFFICER, null, { requestFn: noModel() });
  assert.equal(ranked.fastPath, true);
  assert.equal(ranked.intent, 'group_persons');
  assert.deepEqual(ranked.toolsUsed, ['group_persons']);
  assert.equal(ranked.presentation.groupBy, 'subdistrict');
  assert.equal(ranked.presentation.total, 3);
  assert.ok(ranked.presentation.items.every((item) => item.count <= ranked.presentation.total));
});

test('initial workflow: filtered summary keeps its filters when offering an Excel report', async (t) => {
  const gateway = fixture(t);
  const summary = await gateway.chatWithTools('สรุปรายชื่อผู้เสพในตำบลจำลอง เรียงตามชื่อ', OFFICER, null, { requestFn: noModel() });
  assert.equal(summary.fastPath, true);
  assert.equal(summary.intent, 'summary_persons');
  assert.equal(summary.presentation.type, 'summary_result');
  assert.deepEqual(summary.presentation.filters, { person_type: 'drug_user', level: 'all', subdistrict: 'จำลอง' });
  assert.equal(summary.presentation.sort, 'name_asc');
  assert.ok(summary.presentation.items.every((item) => item.person_type === 'drug_user'));

  const report = await gateway.chatWithTools('สร้าง Excel ให้หน่อย', OFFICER, null, {
    requestFn: noModel(),
    context: { topic: { person_type: 'drug_user', subdistrict: 'จำลอง' } },
  });
  assert.equal(report.fastPath, true);
  assert.equal(report.intent, 'export_report');
  assert.equal(report.presentation.type, 'report_offer');
  assert.deepEqual(report.presentation.formats, ['xlsx']);
  assert.equal(report.presentation.reportRequest.filters.person_type, 'drug_user');
  assert.equal(report.presentation.reportRequest.filters.subdistrict, 'จำลอง');
  assert.equal(report.presentation.reportRequest.sort, 'name_asc');
});
