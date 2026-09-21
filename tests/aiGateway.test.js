const { test } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { setup, USERS } = require('./helpers');
const { createToolRouter } = require('../src/ai/toolRouter');
const { chatWithTools, MAX_TOOL_ITERATIONS } = require('../src/ai/gateway');

const STATION1_USER = { id: 2, username: 'station1_off', name: 'เจ้าหน้าที่', role: 'officer', stationId: 1 };
const STATION2_USER = { id: 4, username: 'station2_off', name: 'เจ้าหน้าที่ 2', role: 'officer', stationId: 2 };

function station1PersonId(db) {
  return db.prepare('SELECT id FROM persons WHERE station_id=1 ORDER BY id LIMIT 1').get().id;
}

function station2PersonId(db) {
  return db.prepare('SELECT id FROM persons WHERE station_id=2 ORDER BY id LIMIT 1').get().id;
}

function finalResponse(content = 'เสร็จสิ้น', toolCalls = []) {
  return { message: { role: 'assistant', content, tool_calls: toolCalls }, done: true };
}

function make() {
  const ctx = setup();
  const toolRouter = createToolRouter(ctx.db);
  return { ...ctx, toolRouter };
}

test('ai gateway: get_statistics routes and scopes to station 1', async () => {
  const ctx = make();
  try {
    const res = await ctx.toolRouter.execute('get_statistics', {}, STATION1_USER);
    assert.strictEqual(res.error, undefined);
    assert.strictEqual(res.data.total, 100, 'station1 should have 100 persons');
  } finally {
    ctx.cleanup();
  }
});

test('ai gateway: search_persons scopes results to station 1', async () => {
  const ctx = make();
  try {
    const res = await ctx.toolRouter.execute('search_persons', { person_type: 'psychiatric' }, STATION1_USER);
    assert.strictEqual(res.error, undefined);
    assert.ok(res.persons.length <= 20, 'paged to 20 rows');
    const dbCount = ctx.db
      .prepare("SELECT COUNT(*) c FROM persons WHERE station_id=1 AND person_type='psychiatric'")
      .get().c;
    assert.strictEqual(res.total, dbCount, 'total must equal station1 psychiatric count');
  } finally {
    ctx.cleanup();
  }
});

test('ai gateway: search_persons ignores client-supplied station_id argument', async () => {
  const ctx = make();
  try {
    const res = await ctx.toolRouter.execute(
      'search_persons',
      { person_type: 'psychiatric', station_id: 2 },
      STATION1_USER
    );
    assert.strictEqual(res.error, undefined);
    assert.ok(res.persons.length <= 20, 'station_id arg must not widen scope');
  } finally {
    ctx.cleanup();
  }
});

test('ai gateway: get_person_detail returns station1 person', async () => {
  const ctx = make();
  try {
    const pid = station1PersonId(ctx.db);
    const res = await ctx.toolRouter.execute('get_person_detail', { person_id: pid }, STATION1_USER);
    assert.strictEqual(res.error, undefined);
    assert.strictEqual(res.data.id, pid);
    assert.strictEqual(res.data.station_id, 1);
  } finally {
    ctx.cleanup();
  }
});

test('ai gateway: get_visit_history returns visits for station1 person', async () => {
  const ctx = make();
  try {
    const pid = station1PersonId(ctx.db);
    const res = await ctx.toolRouter.execute('get_visit_history', { person_id: pid }, STATION1_USER);
    assert.strictEqual(res.error, undefined);
    assert.ok(Array.isArray(res.data));
  } finally {
    ctx.cleanup();
  }
});

test('ai gateway: get_urine_history returns urine tests for station1 person', async () => {
  const ctx = make();
  try {
    const pid = station1PersonId(ctx.db);
    const res = await ctx.toolRouter.execute('get_urine_history', { person_id: pid }, STATION1_USER);
    assert.strictEqual(res.error, undefined);
    assert.ok(Array.isArray(res.data));
  } finally {
    ctx.cleanup();
  }
});

test('ai gateway: get_overdue_followups returns scoped rows', async () => {
  const ctx = make();
  try {
    const res = await ctx.toolRouter.execute('get_overdue_followups', {}, STATION1_USER);
    assert.strictEqual(res.error, undefined);
    assert.ok(Array.isArray(res.data));
    assert.strictEqual(typeof res.total, 'number');
  } finally {
    ctx.cleanup();
  }
});

test('ai gateway: forbidden station override returns error, not data', async () => {
  const ctx = make();
  try {
    const pid = station2PersonId(ctx.db);
    const res = await ctx.toolRouter.execute('get_person_detail', { person_id: pid }, STATION1_USER);
    assert.strictEqual(res.data, undefined);
    assert.ok(res.error, 'must not leak station2 person to station1 user');
  } finally {
    ctx.cleanup();
  }
});

test('ai gateway: cross-station visit history is blocked', async () => {
  const ctx = make();
  try {
    const pid = station2PersonId(ctx.db);
    const res = await ctx.toolRouter.execute('get_visit_history', { person_id: pid }, STATION1_USER);
    assert.ok(res.error, 'must not leak visits of station2 person');
  } finally {
    ctx.cleanup();
  }
});

test('ai gateway: unknown tool is rejected', async () => {
  const ctx = make();
  try {
    const res = await ctx.toolRouter.execute('execute_sql', { sql: 'SELECT * FROM persons' }, STATION1_USER);
    assert.ok(res.error, 'execute_sql must be rejected');
    assert.ok(res.error.includes('ไม่ได้รับอนุญาต'));

    const res2 = await ctx.toolRouter.execute('run_shell', { cmd: 'ls' }, STATION1_USER);
    assert.ok(res2.error, 'run_shell must be rejected');
  } finally {
    ctx.cleanup();
  }
});

test('ai gateway: multi-step tool calling loop works', async () => {
  const ctx = make();
  try {
    const calls = [];
    let step = 0;
    const requestFn = async () => {
      step += 1;
      if (step === 1) {
        return finalResponse('', [
          { id: 'call_1', function: { name: 'search_persons', arguments: { person_type: 'psychiatric' } } },
        ]);
      }
      if (step === 2) {
        return finalResponse('', [
          { id: 'call_2', function: { name: 'get_person_detail', arguments: { person_id: station1PersonId(ctx.db) } } },
        ]);
      }
      return finalResponse('พบบุคคลแล้ว');
    };

    const result = await chatWithTools('หาบุคคล', ctx.toolRouter, STATION1_USER, (c) => calls.push(c), { requestFn });
    assert.deepStrictEqual(result.toolsUsed, ['search_persons', 'get_person_detail']);
    assert.strictEqual(result.answer, 'พบบุคคลแล้ว');
    assert.strictEqual(calls.length, 2);
  } finally {
    ctx.cleanup();
  }
});

test('ai gateway: enforced maximum tool iterations stops loop', async () => {
  const ctx = make();
  try {
    const requestFn = async () => {
      return finalResponse('', [
        { id: 'call_x', function: { name: 'get_statistics', arguments: {} } },
      ]);
    };

    const result = await chatWithTools('ถามซ้ำไม่จบ', ctx.toolRouter, STATION1_USER, null, { requestFn });
    assert.strictEqual(result.answer, '');
    assert.strictEqual(result.toolsUsed.length, MAX_TOOL_ITERATIONS);
  } finally {
    ctx.cleanup();
  }
});

test('ai gateway: Ollama timeout/error rejects and does not crash', async () => {
  const ctx = make();
  try {
    const requestFn = async () => {
      throw new Error('Ollama request timeout');
    };
    await assert.rejects(
      () => chatWithTools('สวัสดี', ctx.toolRouter, STATION1_USER, null, { requestFn }),
      /timeout/
    );
  } finally {
    ctx.cleanup();
  }
});

test('ai route: /api/ai/chat requires authentication', async () => {
  const ctx = setup();
  try {
    const res = await request(ctx.app)
      .post('/api/ai/chat')
      .send({ message: 'สวัสดี' })
      .timeout(5000);
    assert.strictEqual(res.status, 401);
  } finally {
    ctx.cleanup();
  }
});

test('ai route: /api/ai/chat rejects missing message', async () => {
  const ctx = setup();
  try {
    const login = await request(ctx.app)
      .post('/api/auth/login')
      .send({ username: USERS.station1_off.username, password: USERS.station1_off.password })
      .timeout(5000);
    const res = await request(ctx.app)
      .post('/api/ai/chat')
      .set('Authorization', `Bearer ${login.body.token}`)
      .send({})
      .timeout(5000);
    assert.strictEqual(res.status, 400);
  } finally {
    ctx.cleanup();
  }
});

test('ai processing preflight does not invoke a tool and marks only non-fast-path questions', async () => {
  const ctx = setup();
  try {
    const login = await request(ctx.app)
      .post('/api/auth/login')
      .send({ username: USERS.station1_off.username, password: USERS.station1_off.password });
    const direct = await request(ctx.app).post('/api/ai/chat/processing')
      .set('Authorization', `Bearer ${login.body.token}`).send({ message: 'มีผู้เสพกี่คน' });
    assert.strictEqual(direct.status, 200);
    assert.strictEqual(direct.body.willUseLocalAi, false);
    const model = await request(ctx.app).post('/api/ai/chat/processing')
      .set('Authorization', `Bearer ${login.body.token}`).send({ message: 'ช่วยวิเคราะห์เชิงลึกให้หน่อย' });
    assert.strictEqual(model.status, 200);
    assert.strictEqual(model.body.willUseLocalAi, true);
  } finally {
    ctx.cleanup();
  }
});

test('ai route: returns answer and toolsUsed from injected gateway', async () => {
  const ctx = setup();
  try {
    const fakeGateway = {
      chatWithTools: async () => ({ answer: 'พบผู้ป่วยจิตเวช 36 คน', toolsUsed: ['get_statistics'] }),
    };
    const { createApp } = require('../src/app');
    const { app } = createApp(ctx.db, { gateway: fakeGateway });

    const login = await request(app)
      .post('/api/auth/login')
      .send({ username: USERS.station1_off.username, password: USERS.station1_off.password })
      .timeout(5000);
    const res = await request(app)
      .post('/api/ai/chat')
      .set('Authorization', `Bearer ${login.body.token}`)
      .send({ message: 'มีผู้ป่วยจิตเวชกี่คน' })
      .timeout(5000);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.answer, 'พบผู้ป่วยจิตเวช 36 คน');
    assert.deepStrictEqual(res.body.toolsUsed, [{ name: 'get_statistics' }]);
    assert.strictEqual(res.body.model, 'scb10x/llama3.1-typhoon2-8b-instruct:latest');
    assert.ok(typeof res.body.meta.responseTimeMs === 'number');
  } finally {
    ctx.cleanup();
  }
});

test('ai route: gateway error returns 502 (controlled)', async () => {
  const ctx = setup();
  try {
    const fakeGateway = {
      chatWithTools: async () => {
        throw new Error('Ollama request timeout');
      },
    };
    const { createApp } = require('../src/app');
    const { app } = createApp(ctx.db, { gateway: fakeGateway });

    const login = await request(app)
      .post('/api/auth/login')
      .send({ username: USERS.station1_off.username, password: USERS.station1_off.password })
      .timeout(5000);
    const res = await request(app)
      .post('/api/ai/chat')
      .set('Authorization', `Bearer ${login.body.token}`)
      .send({ message: 'สวัสดี' })
      .timeout(5000);
    assert.strictEqual(res.status, 502);
    assert.strictEqual(res.body.code, 'AI_UNAVAILABLE');
  } finally {
    ctx.cleanup();
  }
});

test('ai route: AI_CHAT and AI_TOOL_CALL audit logs recorded without prompt/token', async () => {
  const ctx = setup();
  try {
    const seenTools = [];
    const fakeGateway = {
      chatWithTools: async (_msg, _user, onToolCall) => {
        onToolCall({ toolName: 'get_statistics', toolArgs: undefined, userId: 2 });
        seenTools.push('get_statistics');
        return { answer: 'ok', toolsUsed: ['get_statistics'] };
      },
    };
    const { createApp } = require('../src/app');
    const { app } = createApp(ctx.db, { gateway: fakeGateway });

    const login = await request(app)
      .post('/api/auth/login')
      .send({ username: USERS.station1_off.username, password: USERS.station1_off.password })
      .timeout(5000);
    const token = login.body.token;
    await request(app)
      .post('/api/ai/chat')
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'มีผู้ป่วยจิตเวชกี่คน' })
      .timeout(5000);

    const logs = ctx.db.prepare('SELECT * FROM ai_audit_logs ORDER BY id ASC').all();
    const serialized = JSON.stringify(logs);
    assert.ok(logs.some((l) => l.action === 'AI_CHAT'), 'AI_CHAT must be logged');
    assert.ok(logs.some((l) => l.action === 'AI_TOOL_CALL' && l.tool_name === 'get_statistics'), 'AI_TOOL_CALL must be logged');
    assert.ok(!serialized.includes('มีผู้ป่วยจิตเวชกี่คน'), 'raw prompt must not be stored');
    assert.ok(!serialized.includes(token.slice(10, 30)), 'jwt must not be stored');
    assert.ok(seenTools.length === 1);
  } finally {
    ctx.cleanup();
  }
});

test('ai gateway: search_persons summary counts match DB across full result set', async () => {
  const ctx = make();
  try {
    const res = await ctx.toolRouter.execute('search_persons', { person_type: 'drug_user' }, STATION1_USER);
    assert.strictEqual(res.error, undefined);
    const rows = ctx.db
      .prepare("SELECT status, COUNT(*) c FROM persons WHERE station_id=1 AND person_type='drug_user' GROUP BY status")
      .all();
    const dbSummary = {};
    for (const r of rows) dbSummary[r.status] = r.c;
    assert.deepStrictEqual(res.summary, {
      registered: dbSummary.registered || 0,
      active: dbSummary.active || 0,
      followup: dbSummary.followup || 0,
      completed: dbSummary.completed || 0,
    });
  } finally {
    ctx.cleanup();
  }
});

test('ai gateway: search_persons summary is station-scoped', async () => {
  const ctx = make();
  try {
    const res = await ctx.toolRouter.execute('search_persons', { person_type: 'drug_user' }, STATION1_USER);
    assert.strictEqual(res.error, undefined);
    const station2Count = ctx.db
      .prepare("SELECT COUNT(*) c FROM persons WHERE station_id=2 AND person_type='drug_user'")
      .get().c;
    assert.ok(station2Count > 0, 'precondition: station2 has drug users');
    const station1Count = ctx.db
      .prepare("SELECT COUNT(*) c FROM persons WHERE station_id=1 AND person_type='drug_user'")
      .get().c;
    assert.strictEqual(res.total, station1Count, 'summary/total must NOT include station2');
    assert.notStrictEqual(res.total, station2Count);
  } finally {
    ctx.cleanup();
  }
});

test('ai gateway: search_persons summary represents full filtered set, not the 20-row page', async () => {
  const ctx = make();
  try {
    const res = await ctx.toolRouter.execute('search_persons', { person_type: 'drug_user' }, STATION1_USER);
    assert.strictEqual(res.error, undefined);
    const station1Total = ctx.db
      .prepare("SELECT COUNT(*) c FROM persons WHERE station_id=1 AND person_type='drug_user'")
      .get().c;
    assert.ok(station1Total > 20, 'precondition: station1 drug users exceed one page (36)');
    assert.strictEqual(res.returned, 20, 'page is capped at 20');
    assert.strictEqual(res.total, station1Total, 'total is full-set, not page size');
  } finally {
    ctx.cleanup();
  }
});

test('ai gateway: search_persons summary categories are internally consistent with total', async () => {
  const ctx = make();
  try {
    const res = await ctx.toolRouter.execute('search_persons', { person_type: 'drug_user' }, STATION1_USER);
    assert.strictEqual(res.error, undefined);
    const sum = res.summary.registered + res.summary.active + res.summary.followup + res.summary.completed;
    assert.strictEqual(sum, res.total, 'registered+active+followup+completed must equal total');
  } finally {
    ctx.cleanup();
  }
});

test('ai gateway: search_persons summary respects status filter', async () => {
  const ctx = make();
  try {
    const res = await ctx.toolRouter.execute('search_persons', { person_type: 'drug_user', status: 'active' }, STATION1_USER);
    assert.strictEqual(res.error, undefined);
    const dbCount = ctx.db
      .prepare("SELECT COUNT(*) c FROM persons WHERE station_id=1 AND person_type='drug_user' AND status='active'")
      .get().c;
    assert.strictEqual(res.total, dbCount);
    assert.strictEqual(res.summary.active, dbCount);
    assert.strictEqual(
      res.summary.registered + res.summary.followup + res.summary.completed,
      0,
      'other statuses must be zero under a status filter'
    );
  } finally {
    ctx.cleanup();
  }
});
