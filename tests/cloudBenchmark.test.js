'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseArgs, providerSummary } = require('../scripts/benchmark-cloud-intent');
const { scoreCase } = require('../scripts/benchmark-real-intent');

test('cloud benchmark refuses unbounded runs and ambiguous provider choices', () => {
  assert.throws(() => parseArgs(['--limit', '151']));
  assert.throws(() => parseArgs(['--models', 'x/a,x/a']));
  assert.throws(() => parseArgs(['--models', 'x/a']));
  assert.throws(() => parseArgs(['--bucket', 'registry']));
  assert.throws(() => parseArgs(['--delay-ms', '-1']));
  assert.throws(() => parseArgs(['--input', 'people.json']));
});

test('cloud benchmark distinguishes safe clarification from exact-plan mismatches', () => {
  const expected = { action: 'clarify', person_type: 'all', group: 'none', direction: 'desc' };
  const actual = { ...expected, person_type: 'drug_user' };
  const summary = providerSummary([{ bucket: 'clarify', scores: scoreCase({ expected }, actual), elapsedMs: 1000,
    usage: { promptTokens: 20, completionTokens: 5, cost: null } }]);
  assert.equal(summary.totals.exactPlanCorrect, 0);
  assert.equal(summary.clarifyActionCorrect, 1);
  assert.equal(summary.usage.costUsd, null); // Unreported cost is not free.
  assert.equal(summary.usage.casesWithoutCost, 1);
});

test('cloud benchmark counts transport/guard failures but excludes them from success latency', () => {
  const expected = { action: 'count', person_type: 'all', group: 'none', direction: 'desc' };
  const row = (extra) => ({ bucket: 'count', scores: scoreCase({ expected }, null), elapsedMs: 15000,
    usage: { promptTokens: 0, completionTokens: 0, cost: null }, ...extra });
  const good = row({ scores: scoreCase({ expected }, expected), elapsedMs: 900,
    usage: { promptTokens: 20, completionTokens: 5, cost: 0.001 } });
  const summary = providerSummary([good, row({ error: 'timeout' }), row({ guardReason: 'UNCUED_NAME' })]);
  assert.equal(summary.totals.exactPlanCorrect, 33.33);
  assert.equal(summary.errors, 1);
  assert.equal(summary.guardBlocked, 1);
  assert.equal(summary.latencyMs.median, 900);
  assert.equal(summary.usage.costUsd, 0.001);
});
