'use strict';

// Opt-in paid-provider check. Only the frozen synthetic holdout is accepted;
// no app login, registry, fixture account or Supabase request is involved.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { loadCases, scoreCase, summarize } = require('./benchmark-real-intent');
const { sanitizeForCloud, assertCloudSafe, restoreLocalReferences } = require('../src/ai/privacyGuard');
const { interpretViaCloud } = require('../src/ai/openRouter');

function parseArgs(argv) {
  const out = { models: ['openai/gpt-5.4-nano', 'z-ai/glm-5.3-flash'], delayMs: 3500, limit: 150, bucket: null, output: null };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const value = argv[++i];
    if (!value) throw new Error(`Missing value for ${key}`);
    if (key === '--models') out.models = value.split(',');
    else if (key === '--delay-ms') out.delayMs = Number(value);
    else if (key === '--limit') out.limit = Number(value);
    else if (key === '--bucket') out.bucket = value;
    else if (key === '--output') out.output = path.resolve(value);
    else throw new Error(`Unknown option: ${key}`);
  }
  if (out.models.length !== 2 || new Set(out.models).size !== 2 || out.models.some(m => !/^[a-z0-9.-]+\/[a-z0-9.-]+$/i.test(m))) throw new Error('Choose exactly two distinct model IDs');
  if (!Number.isSafeInteger(out.delayMs) || out.delayMs < 0 || out.delayMs > 30000) throw new Error('Invalid delay');
  if (!Number.isSafeInteger(out.limit) || out.limit < 1 || out.limit > 150) throw new Error('Invalid limit');
  if (out.bucket && !['count', 'list', 'group', 'search', 'clarify'].includes(out.bucket)) throw new Error('Invalid bucket');
  return out;
}

function providerSummary(rows) {
  const timings = rows.filter(r => !r.error && !r.guardReason).map(r => r.elapsedMs).sort((a, b) => a - b);
  const percentile = fraction => timings.length ? timings[Math.max(0, Math.ceil(timings.length * fraction) - 1)] : null;
  const priced = rows.filter(r => r.usage.cost !== null);
  return {
    ...summarize(rows),
    cases: rows.length,
    guardBlocked: rows.filter(r => r.guardReason).length,
    errors: rows.filter(r => r.error).length,
    // Clarification prevents a registry read irrespective of inert slots.
    clarifyActionCorrect: rows.filter(r => r.bucket === 'clarify' && r.scores.actionCorrect).length,
    latencyMs: { median: percentile(0.5), p95: percentile(0.95), max: timings.at(-1) ?? null },
    usage: {
      promptTokens: rows.reduce((n, r) => n + r.usage.promptTokens, 0),
      completionTokens: rows.reduce((n, r) => n + r.usage.completionTokens, 0),
      costUsd: priced.length ? priced.reduce((n, r) => n + r.usage.cost, 0) : null,
      casesWithoutCost: rows.length - priced.length,
    },
  };
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (!process.env.OPENROUTER_API_KEY) throw new Error('Set OPENROUTER_API_KEY in process memory before running');
  const cases = loadCases().filter(c => !options.bucket || c.bucket === options.bucket).slice(0, options.limit);
  const fixture = path.join(__dirname, '../tests/fixtures/real-intent-holdout150.json');
  const result = {
    startedAt: new Date().toISOString(), complete: false,
    source: 'actual OpenRouter; frozen synthetic prompts only; no Supabase, registry, or local model',
    fixtureSha256: crypto.createHash('sha256').update(fs.readFileSync(fixture)).digest('hex'),
    models: options.models, delayMs: options.delayMs, prompt: 'existing CLOUD_SYSTEM_PROMPT; unchanged JSON mode/validation',
    results: Object.fromEntries(options.models.map(m => [m, []])), summaries: {},
  };
  const save = () => {
    for (const model of options.models) result.summaries[model] = providerSummary(result.results[model]);
    if (options.output) fs.writeFileSync(options.output, JSON.stringify(result, null, 2) + '\n');
  };
  // Preflight the whole corpus before any paid request. A detected guard
  // problem is recorded per case and never causes unsanitized egress.
  const prepared = cases.map(c => ({ c, guard: sanitizeForCloud(c.message) }));
  for (const [index, { c, guard }] of prepared.entries()) {
    for (const model of options.models) {
      let actual = null, error = null;
      const safety = assertCloudSafe(guard.safeText, guard.mapping);
      const usage = { promptTokens: 0, completionTokens: 0, cost: null };
      const started = Date.now();
      if (safety.ok) {
        try {
          const proposed = await interpretViaCloud(guard.safeText, {
            env: { ...process.env, CLOUD_AI_ENABLED: 'true', OPENROUTER_MODEL: model, CLOUD_AI_SAFE_DEBUG: 'false' },
            request: async (url, opts) => {
              const response = await fetch(url, opts);
              if (!response.ok) return response;
              const body = await response.json();
              usage.promptTokens += Number(body.usage?.prompt_tokens) || 0;
              usage.completionTokens += Number(body.usage?.completion_tokens) || 0;
              if (Number.isFinite(body.usage?.cost)) usage.cost = (usage.cost ?? 0) + body.usage.cost;
              return { ok: true, json: async () => body };
            },
          });
          actual = restoreLocalReferences(proposed, guard.mapping);
          if (!actual) error = 'unresolved-reference';
        } catch (cause) { error = String(cause.message).slice(0, 100); }
      }
      result.results[model].push({ id: c.id, bucket: c.bucket, expected: c.expected, actual,
        safeText: guard.safeText, scores: scoreCase(c, actual), elapsedMs: Date.now() - started,
        usage, ...(error ? { error } : {}), ...(!safety.ok ? { guardReason: safety.reason } : {}) });
      save();
      if (options.delayMs) await new Promise(resolve => setTimeout(resolve, options.delayMs));
    }
    if ((index + 1) % 10 === 0 || index + 1 === cases.length) {
      console.error(`progress ${index + 1}/${cases.length} ${options.models.map(m => `${m}: ${result.results[m].filter(r => r.scores.exactPlanCorrect).length} exact, ${result.summaries[m].errors} errors`).join(' | ')}`);
    }
  }
  result.complete = true;
  result.finishedAt = new Date().toISOString();
  save();
  console.log(JSON.stringify(result.summaries, null, 2));
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { parseArgs, providerSummary };
