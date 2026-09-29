'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { loadCases, scoreCase, summarize, schema } = require('../scripts/benchmark-real-intent');

test('real interpreter holdout is a stable 150-case synthetic Thai corpus', () => {
  const cases = loadCases();
  assert.equal(cases.length, 150);
  const fixturePath = path.join(__dirname, 'fixtures', 'real-intent-holdout150.json');
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(fixturePath)).digest('hex'), 'be9d72f4699970259106682d9ce5048cc8d5ae63f2fdfe58269647a2fc0a50b4', 'review fixture changes and update the frozen holdout hash intentionally');
  assert.equal(new Set(cases.map((item) => item.id)).size, 150);
  assert.deepEqual(Object.fromEntries([...new Set(cases.map((item) => item.bucket))].map((bucket) => [bucket, cases.filter((item) => item.bucket === bucket).length])), {
    count: 32, list: 28, group: 60, search: 20, clarify: 10,
  });
  for (const item of cases) {
    assert.equal(typeof item.message, 'string', item.id);
    assert.ok(item.message.length > 2, item.id);
    assert.ok(['count', 'list', 'group', 'clarify'].includes(item.expected.action), item.id);
    assert.ok(schema.properties.person_type.enum.includes(item.expected.person_type), item.id);
    assert.ok(schema.properties.group.enum.includes(item.expected.group), item.id);
  }
});

test('interpreter benchmark scores both wrong fields and invented location filters', () => {
  const item = { expected: { action: 'count', person_type: 'drug_user', group: 'none', direction: 'desc', district: 'เมือง' } };
  const correct = scoreCase(item, { ...item.expected });
  assert.equal(correct.exactPlanCorrect, true);
  const inventedPlace = scoreCase(item, { ...item.expected, province: 'เชียงใหม่' });
  assert.equal(inventedPlace.actionCorrect, true);
  assert.equal(inventedPlace.placeSlotsCorrect, false);
  assert.equal(inventedPlace.exactPlanCorrect, false);
  assert.deepEqual(summarize([
    { bucket: 'count', scores: correct },
    { bucket: 'count', scores: inventedPlace },
  ]).totals, {
    actionCorrect: 100, personTypeCorrect: 100, groupCorrect: 100,
    directionCorrect: 100, placeSlotsCorrect: 50, exactPlanCorrect: 50,
  });
});
