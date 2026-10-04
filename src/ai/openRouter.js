'use strict';

// OpenRouter provider — CONTROL PLANE only. It receives exactly one
// sanitized utterance string (already passed through privacyGuard and
// assertCloudSafe) plus the PII-free interpreter system prompt, and returns
// a plan validated by the same schema as the local model. It must never be
// handed registry rows, tokens, scope objects or mapping values; there is
// deliberately no API here that would accept them.
//
// Configuration is environment-only (never frontend, never localStorage):
//   CLOUD_AI_ENABLED=true
//   OPENROUTER_API_KEY=...
//   OPENROUTER_MODEL=...            (no hardcoded fallback model)
//   OPENROUTER_TIMEOUT_MS=15000
//   OPENROUTER_BASE_URL (default https://openrouter.ai/api/v1)
//   CLOUD_AI_SAFE_DEBUG=true        (logs the sanitized outbound text only)

const { CLOUD_INTERPRETER_PROMPT } = require('./domainCatalog');
const { validatePlan } = require('./realIntent');

const CLOUD_SYSTEM_PROMPT = `${CLOUD_INTERPRETER_PROMPT}

ข้อกำหนดเพิ่มเติมสำหรับรอบนี้: ท่านเป็นตัวแปลความตั้งใจและตัวเลือกเครื่องมือเท่านั้น
ห้ามตอบคำถามด้วยข้อมูลจริง ห้ามสร้าง SQL
สัญลักษณ์ [PERSON_1] [NATIONAL_ID_1] [PHONE_1] เป็นการอ้างอิงแทนค่าจริงที่ระบบปิดไว้ ให้คงสัญลักษณ์นั้นไว้ในผลลัพธ์ตรงตามเดิม ห้ามแปลงห้ามถอดรหัสห้ามเดาค่าจริง
ห้ามเพิ่มหรือแก้ไขสิทธิ์ ขอบเขต สถานี หรือจังหวัดที่ผู้ใช้ไม่ได้พูด
ตอบเป็น JSON เท่านั้น`;

function cloudConfig(env = process.env) {
  const key = env.OPENROUTER_API_KEY || '';
  const model = env.OPENROUTER_MODEL || '';
  const enabled = env.CLOUD_AI_ENABLED === 'true';
  const base = (env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
  const timeoutMs = Math.max(3000, Math.min(60000, Number(env.OPENROUTER_TIMEOUT_MS) || 15000));
  // Fail closed: https only, every value required, no defaults for secrets.
  const ok = enabled && Boolean(key) && Boolean(model) && base.startsWith('https://');
  return { ok, key, model, base, timeoutMs };
}

function parseContent(raw) {
  let s = String(raw || '').trim();
  // Tolerate markdown fences some models wrap JSON in.
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) s = s.slice(start, end + 1);
  return JSON.parse(s);
}

// One OpenRouter attempt. `request` is injectable for tests.
async function callOnce(safeText, config, request) {
  const body = {
    model: config.model,
    temperature: 0,
    // Thinking-tier models spend tokens on reasoning before the JSON;
    // 400 truncated mid-plan in the live holdout (13 cut answers).
    max_tokens: 2000,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: CLOUD_SYSTEM_PROMPT },
      { role: 'user', content: safeText },
    ],
  };
  if (process.env.CLOUD_AI_SAFE_DEBUG === 'true') {
    // Sanitized outbound text only; secrets and mapping values never appear.
    console.log('[CLOUD SAFE REQUEST] ' + safeText);
  }
  const response = await request(`${config.base}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.key}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://ai.policeshield4.com',
      'X-Title': 'ThaniPitak AI',
    },
    signal: AbortSignal.timeout(config.timeoutMs),
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`OpenRouter HTTP ${response.status}`);
  const payload = await response.json();
  // Raw content string: the caller owns JSON parsing so one invalid answer
  // can be retried without re-issuing provider errors.
  return String(payload.choices?.[0]?.message?.content ?? '');
}

// Intent parsing via OpenRouter. Provider errors (HTTP/timeout) fail fast
// to the Local AI fallback; an invalid JSON answer is retried once, then
// throws (fail closed).
async function interpretViaCloud(safeText, { request = fetch, env = process.env } = {}) {
  const config = cloudConfig(env);
  if (!config.ok) throw new Error('Cloud AI ยังไม่ได้ตั้งค่า');
  const started = Date.now();
  let plan = null;
  for (let attempt = 1; attempt <= 2 && !plan; attempt++) {
    const raw = await callOnce(safeText, config, request);
    try {
      plan = validatePlan(parseContent(raw), 'Cloud AI');
    } catch (err) {
      if (attempt === 2) {
        console.log(`[cloud-intent] invalid-json ms=${Date.now() - started}`);
        throw err;
      }
    }
  }
  // Numbers-only audit line: provider, model, latency, chosen action. The
  // utterance, placeholders and mapping values are never logged.
  console.log(`[cloud-intent] ok ms=${Date.now() - started} model=${config.model} action=${plan.action}`);
  return plan;
}

module.exports = { cloudConfig, interpretViaCloud, CLOUD_SYSTEM_PROMPT };
