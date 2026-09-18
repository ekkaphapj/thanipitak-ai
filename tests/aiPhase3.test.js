const { test } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { setup, USERS } = require('./helpers');
const { createToolRouter } = require('../src/ai/toolRouter');
const { SYSTEM_PROMPT } = require('../src/ai/systemPrompt');

const STATION1_USER = { id: 2, username: 'station1_off', name: 'เจ้าหน้าที่', role: 'officer', stationId: 1 };

function makeToolRouter() {
  const ctx = setup();
  return { ...ctx, toolRouter: createToolRouter(ctx.db) };
}

async function login(app, username = 'station1_off') {
  const res = await request(app)
    .post('/api/auth/login')
    .send({ username, password: USERS[username].password })
    .timeout(5000);
  return res.body.token;
}

function fakeGatewayApp(ctx, gateway) {
  const { createApp } = require('../src/app');
  return createApp(ctx.db, {
    gateway: gateway || { chatWithTools: async () => ({ answer: 'คำตอบ', toolsUsed: [] }) },
    ollamaCheck: async () => ({ available: true }),
  });
}

test('ai phase3: /api/ai/status requires JWT', async () => {
  const ctx = setup();
  try {
    const res = await request(ctx.app).get('/api/ai/status').timeout(5000);
    assert.strictEqual(res.status, 401);
  } finally {
    ctx.cleanup();
  }
});

test('ai phase3: /api/ai/status returns availability and model', async () => {
  const ctx = setup();
  try {
    const { app } = createApp2(ctx, { ollamaCheck: async () => ({ available: true }) });
    const token = await login(app);
    const res = await request(app).get('/api/ai/status').set('Authorization', `Bearer ${token}`).timeout(5000);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.available, true);
    assert.strictEqual(res.body.model, 'scb10x/llama3.1-typhoon2-8b-instruct:latest');
  } finally {
    ctx.cleanup();
  }
});

test('ai phase3: /api/ai/status returns unavailable when Ollama is down', async () => {
  const ctx = setup();
  try {
    const { app } = createApp2(ctx, { ollamaCheck: async () => ({ available: false }) });
    const token = await login(app);
    const res = await request(app).get('/api/ai/status').set('Authorization', `Bearer ${token}`).timeout(5000);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.available, false);
  } finally {
    ctx.cleanup();
  }
});

test('ai phase3: /api/ai/status does not expose Ollama URL/config', async () => {
  const ctx = setup();
  try {
    const { app } = createApp2(ctx, { ollamaCheck: async () => ({ available: true }) });
    const token = await login(app);
    const res = await request(app).get('/api/ai/status').set('Authorization', `Bearer ${token}`).timeout(5000);
    const serialized = JSON.stringify(res.body);
    assert.ok(!serialized.includes('11434'), 'must not expose Ollama port/URL');
    assert.ok(!serialized.includes('OLLAMA_HOST'), 'must not expose env var name');
  } finally {
    ctx.cleanup();
  }
});

test('ai phase3: station_id from frontend is rejected', async () => {
  const ctx = setup();
  try {
    const { app } = fakeGatewayApp(ctx);
    const token = await login(app);
    const res = await request(app)
      .post('/api/ai/chat')
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'มีกี่คน', station_id: 2 })
      .timeout(5000);
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.code, 'FORBIDDEN_FIELD');
  } finally {
    ctx.cleanup();
  }
});

test('ai phase3: allowedStationIds from frontend is rejected', async () => {
  const ctx = setup();
  try {
    const { app } = fakeGatewayApp(ctx);
    const token = await login(app);
    const res = await request(app)
      .post('/api/ai/chat')
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'มีกี่คน', allowedStationIds: [1, 2, 3] })
      .timeout(5000);
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.code, 'FORBIDDEN_FIELD');
  } finally {
    ctx.cleanup();
  }
});

test('ai phase3: user_id override is rejected', async () => {
  const ctx = setup();
  try {
    const { app } = fakeGatewayApp(ctx);
    const token = await login(app);
    const res = await request(app)
      .post('/api/ai/chat')
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'มีกี่คน', user_id: 999 })
      .timeout(5000);
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.code, 'FORBIDDEN_FIELD');
  } finally {
    ctx.cleanup();
  }
});

test('ai phase3: role override is rejected', async () => {
  const ctx = setup();
  try {
    const { app } = fakeGatewayApp(ctx);
    const token = await login(app);
    const res = await request(app)
      .post('/api/ai/chat')
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'มีกี่คน', role: 'admin' })
      .timeout(5000);
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.code, 'FORBIDDEN_FIELD');
  } finally {
    ctx.cleanup();
  }
});

test('ai phase3: tool name / sql from frontend is rejected', async () => {
  const ctx = setup();
  try {
    const { app } = fakeGatewayApp(ctx);
    const token = await login(app);
    for (const field of ['tool', 'system_prompt', 'sql']) {
      const res = await request(app)
        .post('/api/ai/chat')
        .set('Authorization', `Bearer ${token}`)
        .send({ message: 'มีกี่คน', [field]: 'x' })
        .timeout(5000);
      assert.strictEqual(res.status, 400, `${field} must be rejected`);
      assert.strictEqual(res.body.code, 'FORBIDDEN_FIELD');
    }
  } finally {
    ctx.cleanup();
  }
});

test('ai phase3: response contains no internal system prompt', async () => {
  const ctx = setup();
  try {
    const { app } = fakeGatewayApp(ctx);
    const token = await login(app);
    const res = await request(app)
      .post('/api/ai/chat')
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'สวัสดี' })
      .timeout(5000);
    assert.strictEqual(res.status, 200);
    const serialized = JSON.stringify(res.body);
    assert.ok(!serialized.includes(SYSTEM_PROMPT.slice(0, 60)), 'system prompt must not be returned');
    assert.ok(!serialized.toLowerCase().includes('คุณคือผู้ช่วย ai'), 'prompt text must not leak');
  } finally {
    ctx.cleanup();
  }
});

test('ai phase3: response contains no JWT and no credentials', async () => {
  const ctx = setup();
  try {
    const { app } = fakeGatewayApp(ctx);
    const token = await login(app);
    const res = await request(app)
      .post('/api/ai/chat')
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'สวัสดี' })
      .timeout(5000);
    assert.strictEqual(res.status, 200);
    const serialized = JSON.stringify(res.body);
    assert.ok(!serialized.includes(token), 'JWT must not be returned');
    assert.ok(!serialized.includes(token.slice(10, 30)), 'JWT substring must not leak');
    assert.ok(!serialized.includes('thanipitak123'), 'password must not leak');
    assert.ok(!serialized.toLowerCase().includes('sqlite'), 'db driver must not leak');
    assert.ok(!serialized.includes('jwt_secret'), 'jwt secret key must not leak');
    assert.ok(!serialized.includes('DB_PATH'), 'db path env name must not leak');
  } finally {
    ctx.cleanup();
  }
});

test('ai phase3: chat response has extended safe format', async () => {
  const ctx = setup();
  try {
    const gateway = {
      chatWithTools: async () => ({ answer: 'พบทั้งหมด 100 คน', toolsUsed: ['get_statistics'] }),
    };
    const { app } = fakeGatewayApp(ctx, gateway);
    const token = await login(app);
    const res = await request(app)
      .post('/api/ai/chat')
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'ทั้งหมดกี่คน' })
      .timeout(5000);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.answer, 'พบทั้งหมด 100 คน');
    assert.deepStrictEqual(res.body.toolsUsed, [{ name: 'get_statistics' }]);
    assert.strictEqual(res.body.model, 'scb10x/llama3.1-typhoon2-8b-instruct:latest');
    assert.ok(typeof res.body.meta.responseTimeMs === 'number');
  } finally {
    ctx.cleanup();
  }
});

test('ai phase3: get_person_detail latest_visit follows real date ordering', async () => {
  const ctx = makeToolRouter();
  try {
    const pid = ctx.db.prepare('SELECT id FROM persons WHERE station_id=1 ORDER BY id LIMIT 1').get().id;
    ctx.db.prepare('DELETE FROM visits WHERE person_id = ?').run(pid);
    const officer = ctx.db.prepare("SELECT id FROM users WHERE role='officer' AND station_id=1 LIMIT 1").get().id;
    const stmt = ctx.db.prepare(
      'INSERT INTO visits (person_id, visit_date, result, note, officer_user_id) VALUES (?, ?, ?, ?, ?)'
    );
    stmt.run(pid, '2024-12-01', 'warning', 'เยี่ยมก่อนหน้า', officer);
    stmt.run(pid, '2025-01-10', 'normal', 'เยี่ยมกลาง', officer);
    stmt.run(pid, '2025-02-15', 'progress', 'เยี่ยมล่าสุดจริง', officer);

    const res = await ctx.toolRouter.execute('get_person_detail', { person_id: pid }, STATION1_USER);
    assert.strictEqual(res.error, undefined);
    assert.strictEqual(res.data.visit_count, 3);
    assert.strictEqual(res.data.full_name, res.data.first_name + ' ' + res.data.last_name);
    assert.strictEqual(res.data.latest_visit.date, '2025-02-15');
    assert.strictEqual(res.data.latest_visit.result, 'progress');
    assert.strictEqual(res.data.latest_visit.note, 'เยี่ยมล่าสุดจริง');
    assert.ok(res.data.latest_visit.officer_name.startsWith('เจ้าหน้าที่'), 'officer name from DB join');
  } finally {
    ctx.cleanup();
  }
});

test('ai phase3: get_visit_history exposes deterministic latest_visit', async () => {
  const ctx = makeToolRouter();
  try {
    const pid = ctx.db.prepare('SELECT id FROM persons WHERE station_id=1 ORDER BY id LIMIT 1').get().id;
    ctx.db.prepare('DELETE FROM visits WHERE person_id = ?').run(pid);
    const officer = ctx.db.prepare("SELECT id FROM users WHERE role='officer' AND station_id=1 LIMIT 1").get().id;
    const stmt = ctx.db.prepare(
      'INSERT INTO visits (person_id, visit_date, result, note, officer_user_id) VALUES (?, ?, ?, ?, ?)'
    );
    stmt.run(pid, '2023-01-01', 'normal', 'เก่า', officer);
    stmt.run(pid, '2023-06-30', 'warning', 'กลาง', officer);
    stmt.run(pid, '2023-12-31', 'recovered', 'ใหม่สุด', officer);

    const res = await ctx.toolRouter.execute('get_visit_history', { person_id: pid }, STATION1_USER);
    assert.strictEqual(res.error, undefined);
    assert.strictEqual(res.visit_count, 3);
    assert.strictEqual(res.latest_visit.date, '2023-12-31');
    assert.strictEqual(res.latest_visit.result, 'recovered');
    assert.strictEqual(res.latest_visit.note, 'ใหม่สุด');
    assert.ok(Array.isArray(res.data));
  } finally {
    ctx.cleanup();
  }
});

test('ai phase3: get_person_detail latest_visit is null when no visits', async () => {
  const ctx = makeToolRouter();
  try {
    const pid = ctx.db.prepare('SELECT id FROM persons WHERE station_id=1 ORDER BY id LIMIT 1').get().id;
    ctx.db.prepare('DELETE FROM visits WHERE person_id = ?').run(pid);
    const res = await ctx.toolRouter.execute('get_person_detail', { person_id: pid }, STATION1_USER);
    assert.strictEqual(res.error, undefined);
    assert.strictEqual(res.data.visit_count, 0);
    assert.strictEqual(res.data.latest_visit, null);
  } finally {
    ctx.cleanup();
  }
});

test('ai phase3: get_statistics provides deterministic counts', async () => {
  const ctx = makeToolRouter();
  try {
    const res = await ctx.toolRouter.execute('get_statistics', {}, STATION1_USER);
    assert.strictEqual(res.error, undefined);
    const d = res.data;
    assert.strictEqual(typeof d.total, 'number');
    assert.strictEqual(typeof d.psychiatric, 'number');
    assert.strictEqual(typeof d.drug_user, 'number');
    assert.strictEqual(typeof d.dealer, 'number');
    assert.strictEqual(typeof d.followupOverdue, 'number');
    const dbTotal = ctx.db.prepare('SELECT COUNT(*) c FROM persons WHERE station_id=1').get().c;
    const dbPsych = ctx.db
      .prepare("SELECT COUNT(*) c FROM persons WHERE station_id=1 AND person_type='psychiatric'").get().c;
    assert.strictEqual(d.total, dbTotal);
    assert.strictEqual(d.psychiatric, dbPsych);
  } finally {
    ctx.cleanup();
  }
});

test('ai phase3: get_overdue_followups provides deterministic returned/total', async () => {
  const ctx = makeToolRouter();
  try {
    const res = await ctx.toolRouter.execute('get_overdue_followups', {}, STATION1_USER);
    assert.strictEqual(res.error, undefined);
    assert.strictEqual(typeof res.total, 'number');
    assert.ok(Array.isArray(res.data));
    assert.strictEqual(res.data.length, Math.min(res.total, 20));
    assert.ok(res.data.length <= 20);
  } finally {
    ctx.cleanup();
  }
});

function createApp2(ctx, options) {
  const { createApp } = require('../src/app');
  return createApp(ctx.db, options);
}