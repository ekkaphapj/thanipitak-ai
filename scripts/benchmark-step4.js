const BASE = process.env.PORT ? `http://127.0.0.1:${process.env.PORT}` : 'http://127.0.0.1:3200';
const TIMEOUT_MS = 120000;
const PERSON_ID = 481;

async function requestJson(path, { method = 'GET', headers = {}, body } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    return { status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const login = await requestJson('/api/auth/login', {
    method: 'POST',
    body: { username: 'station1_off', password: 'thanipitak123' },
  });
  const token = login.data.token;
  if (!token) throw new Error(`login failed: ${JSON.stringify(login)}`);

  const persons = await requestJson('/api/persons?page=1&limit=200', { headers: { Authorization: `Bearer ${token}` } });
  const person = (persons.data.data || []).find((p) => p.id === PERSON_ID);
  if (!person) throw new Error(`person ${PERSON_ID} not visible to station1_off`);
  const fullName = `${person.first_name} ${person.last_name}`;

  const questions = [
    { id: 'A', message: 'วิเคราะห์ประวัติคนนี้', context: { personId: PERSON_ID } },
    { id: 'B', message: 'คนนี้มีประเด็นอะไรที่ควรติดตาม', context: { personId: PERSON_ID } },
    { id: 'C', message: `${fullName} มีประเด็นอะไรที่ควรติดตาม`, context: null },
  ];

  const runs = [];
  async function run(id, message, context, mode) {
    const t0 = Date.now();
    let res;
    try {
      res = await requestJson('/api/ai/chat', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: { message, context },
      });
    } catch (e) {
      runs.push({ question: id, mode, TIMEOUT: true, wallMs: Date.now() - t0, error: e.message });
      return false;
    }
    const d = res.data || {};
    const numbersInAnswer = (d.answer ? d.answer.match(/\d+(?:[.,]\d+)?/g) : []) || [];
    runs.push({
      question: id,
      mode,
      status: res.status,
      executionTier: d.executionTier,
      analysisMode: d.analysisMode,
      ollamaCalls: d.ollamaCalls,
      grounded: d.grounded,
      resolution: d.resolution,
      model: d.model,
      toolsUsed: d.toolsUsed,
      presentation: d.presentation,
      routingMs: d.timing && d.timing.routingMs,
      dbMs: d.timing && d.timing.dbMs,
      llmMs: d.timing && d.timing.llmMs,
      totalMs: d.timing && d.timing.totalMs,
      wallMs: Date.now() - t0,
      answer: d.answer,
      numbersInAnswer,
    });
    return true;
  }

  for (const mode of ['cold', 'warm']) {
    for (const q of questions) {
      const ok = await run(q.id, q.message, q.context, mode);
      if (!ok) {
        console.error(`TIMEOUT/FAILURE at ${q.id} ${mode}; aborting benchmark`);
        process.exitCode = 1; break;
      }
    }
  }

  console.log(JSON.stringify({ person: { id: person.id, name: fullName }, runs }, null, 2));
}

main().catch((e) => { console.error(e); process.exitCode = 1; });