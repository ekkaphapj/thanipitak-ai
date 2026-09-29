'use strict';

// Opt-in evaluation of the exact interpreter used by the real-data route.
// The 150 prompts are synthetic questions only: this script never creates an
// app session, connects to Supabase, or reads registry data.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { interpretRealIntent, schema } = require('../src/ai/realIntent');

const CASE_FILE = path.join(__dirname, '..', 'tests', 'fixtures', 'real-intent-holdout150.json');
const PLACE_FIELDS = ['province', 'district', 'subdistrict', 'station', 'search'];

function parseArgs(argv) {
  const options = { host: 'http://127.0.0.1:11434', model: 'scb10x/llama3.1-typhoon2-8b-instruct:latest', limit: Infinity, runs: 1 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') { options.help = true; continue; }
    if (!['--host', '--model', '--limit', '--runs'].includes(arg)) throw new Error(`Unknown option: ${arg}`);
    const value = argv[++i];
    if (!value) throw new Error(`Missing value for ${arg}`);
    if (arg === '--host') options.host = value;
    if (arg === '--model') options.model = value;
    if (arg === '--limit') options.limit = Number(value);
    if (arg === '--runs') options.runs = Number(value);
  }
  const host = new URL(options.host);
  if (host.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(host.hostname)) {
    throw new Error('For safety, the benchmark only connects to local Ollama on HTTP loopback.');
  }
  if (!Number.isSafeInteger(options.limit) && options.limit !== Infinity) throw new Error('--limit must be a positive integer');
  if (options.limit <= 0 || !Number.isSafeInteger(options.runs) || options.runs < 1 || options.runs > 3) throw new Error('--limit must be positive and --runs must be 1–3');
  return options;
}

function sameValue(actual, expected) {
  if (actual == null || actual === '') return expected == null || expected === '';
  if (expected == null || expected === '') return false;
  if (typeof actual === 'string' && typeof expected === 'string') {
    return actual.trim().replace(/\s+/gu, ' ') === expected.trim().replace(/\s+/gu, ' ');
  }
  return actual === expected;
}

function scoreCase(testCase, actual) {
  const expected = testCase.expected;
  const fields = ['action', 'person_type', 'group', 'direction', ...PLACE_FIELDS];
  const fieldMatches = Object.fromEntries(fields.map((field) => [field, sameValue(actual?.[field], expected[field])]));
  return {
    actionCorrect: fieldMatches.action,
    personTypeCorrect: fieldMatches.person_type,
    groupCorrect: fieldMatches.group,
    directionCorrect: fieldMatches.direction,
    placeSlotsCorrect: PLACE_FIELDS.every((field) => fieldMatches[field]),
    exactPlanCorrect: Object.values(fieldMatches).every(Boolean),
  };
}

function percent(hits, total) { return total ? Math.round((hits / total) * 10000) / 100 : null; }
function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function summarize(rows) {
  const fields = ['actionCorrect', 'personTypeCorrect', 'groupCorrect', 'directionCorrect', 'placeSlotsCorrect', 'exactPlanCorrect'];
  const totals = Object.fromEntries(fields.map((field) => [field, percent(rows.filter((row) => row.scores[field]).length, rows.length)]));
  const buckets = {};
  for (const bucket of [...new Set(rows.map((row) => row.bucket))]) {
    const cases = rows.filter((row) => row.bucket === bucket);
    buckets[bucket] = Object.fromEntries(fields.map((field) => [field, percent(cases.filter((row) => row.scores[field]).length, cases.length)]));
  }
  return { totals, buckets };
}

function loadCases() {
  const parsed = JSON.parse(fs.readFileSync(CASE_FILE, 'utf8'));
  if (parsed.version !== 1 || !Array.isArray(parsed.cases) || parsed.cases.length !== 150) throw new Error('Holdout must be version 1 with exactly 150 cases.');
  return parsed.cases;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write('Usage: npm run benchmark:real-intent -- [--model TAG] [--host http://127.0.0.1:11434] [--limit N] [--runs 1..3]\n');
    return;
  }
  const cases = loadCases().slice(0, options.limit);
  const tagsResponse = await fetch(`${options.host}/api/tags`, { signal: AbortSignal.timeout(5000) });
  if (!tagsResponse.ok) throw new Error(`Local Ollama /api/tags returned HTTP ${tagsResponse.status}`);
  const tags = await tagsResponse.json();
  if (!(tags.models || []).some((model) => model.name === options.model)) throw new Error(`Model ${options.model} is not installed in local Ollama.`);

  process.env.OLLAMA_HOST = options.host;
  process.env.OLLAMA_MODEL = options.model;
  process.env.OLLAMA_KEEP_ALIVE = process.env.OLLAMA_KEEP_ALIVE || '30m';
  const results = [];
  const latencies = [];
  const failures = [];
  const started = Date.now();
  for (let run = 1; run <= options.runs; run += 1) {
    for (let index = 0; index < cases.length; index += 1) {
      const testCase = cases[index];
      const caseStarted = Date.now();
      let actual = null;
      let error = null;
      try { actual = await interpretRealIntent(testCase.message); }
      catch (cause) { error = cause.message; }
      const elapsed = Date.now() - caseStarted;
      latencies.push(elapsed);
      const scores = scoreCase(testCase, actual);
      const row = { id: testCase.id, bucket: testCase.bucket, run, scores, ...(error ? { error } : {}) };
      results.push(row);
      if (!scores.exactPlanCorrect) failures.push({ id: testCase.id, bucket: testCase.bucket, run, expected: testCase.expected, actual, ...(error ? { error } : {}) });
      if ((index + 1) % 25 === 0 || index + 1 === cases.length) {
        process.stderr.write(`run ${run}/${options.runs}: ${index + 1}/${cases.length} prompts\n`);
      }
    }
  }
  const summary = summarize(results);
  const fixtureHash = crypto.createHash('sha256').update(fs.readFileSync(CASE_FILE)).digest('hex');
  process.stdout.write(`${JSON.stringify({
    model: options.model,
    host: options.host,
    source: 'local Ollama; synthetic prompts only; no Supabase or registry access',
    fixture: path.relative(process.cwd(), CASE_FILE).replaceAll(path.sep, '/'),
    fixtureSha256: fixtureHash,
    caseCount: cases.length,
    runs: options.runs,
    metrics: summary,
    exactPlanFailures: failures.length,
    failures: failures.slice(0, 40),
    latencyMs: { median: percentile(latencies, 0.5), p95: percentile(latencies, 0.95), max: Math.max(...latencies) },
    durationSeconds: Math.round((Date.now() - started) / 1000),
  }, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => { process.stderr.write(`Benchmark failed: ${error.message}\n`); process.exitCode = 1; });
}

module.exports = { parseArgs, sameValue, scoreCase, summarize, loadCases, PLACE_FIELDS, schema };
