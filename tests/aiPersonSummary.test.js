const { describe, test } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { setup, USERS } = require('./helpers');
const { createToolRouter } = require('../src/ai/toolRouter');
const { createAIGateway } = require('../src/ai/gateway');
const { createApp } = require('../src/app');
const {
  detectPersonFactualIntent,
  validPersonId,
  sanitizePersonContext,
} = require('../src/ai/personFastPath');

const STATION1_USER = { id: 2, username: 'station1_off', name: 'เจ้าหน้าที่', role: 'officer', stationId: 1 };
const STATION2_USER = { id: 4, username: 'station2_off', name: 'เจ้าหน้าที่ 2', role: 'officer', stationId: 2 };

function make() {
  const ctx = setup();
  const toolRouter = createToolRouter(ctx.db);
  const gateway = createAIGateway(toolRouter);
  return { ...ctx, toolRouter, gateway };
}

function insertPerson(db, overrides = {}) {
  const row = {
    synthetic_code: overrides.synthetic_code || `TP-T2-${Math.floor(Math.random() * 1e9)}`,
    first_name: overrides.first_name || 'พัชราภา',
    last_name: overrides.last_name || 'ใจดี',
    person_type: overrides.person_type || 'drug_user',
    district: overrides.district || 'คลองประเวศ',
    subdistrict: overrides.subdistrict || 'บึงมัน',
    station_id: overrides.station_id != null ? overrides.station_id : 1,
    status: overrides.status || 'active',
    last_visit_date: overrides.last_visit_date || null,
    created_at: overrides.created_at || '2025-01-01',
  };
  const info = db.prepare(
    `INSERT INTO persons (synthetic_code, first_name, last_name, person_type, district, subdistrict, station_id, status, last_visit_date, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    row.synthetic_code, row.first_name, row.last_name, row.person_type,
    row.district, row.subdistrict, row.station_id, row.status, row.last_visit_date, row.created_at
  );
  return { ...row, id: Number(info.lastInsertRowid) };
}

function insertVisit(db, personId, overrides = {}) {
  const info = db.prepare(
    'INSERT INTO visits (person_id, visit_date, result, note, officer_user_id) VALUES (?, ?, ?, ?, ?)'
  ).run(
    personId,
    overrides.visit_date || '2025-06-01',
    overrides.result || 'normal',
    overrides.note || null,
    overrides.officer_user_id || 2
  );
  return Number(info.lastInsertRowid);
}

function insertUrineTest(db, personId, overrides = {}) {
  const info = db.prepare(
    'INSERT INTO urine_tests (person_id, test_date, result, officer_user_id) VALUES (?, ?, ?, ?)'
  ).run(
    personId,
    overrides.test_date || '2025-06-01',
    overrides.result || 'negative',
    overrides.officer_user_id || 2
  );
  return Number(info.lastInsertRowid);
}

function ollamaSpy() {
  const calls = [];
  return {
    calls,
    requestFn: async () => {
      calls.push(1);
      return { message: { role: 'assistant', content: 'fallback จาก Ollama', tool_calls: [] }, done: true };
    },
  };
}

async function ask(gateway, message, user, options = {}) {
  const spy = ollamaSpy();
  const result = await gateway.chatWithTools(message, user, null, {
    requestFn: spy.requestFn,
    ...options,
  });
  return { result, ollamaCalls: spy.calls.length };
}

async function login(app, username) {
  const res = await request(app)
    .post('/api/auth/login')
    .send({ username, password: USERS[username].password })
    .timeout(5000);
  return res.body.token;
}

describe('Tier-2 detector (deterministic, conservative)', () => {
  test('recognizes only selected-person factual phrases', () => {
    assert.strictEqual(detectPersonFactualIntent('คนนี้มีประวัติอย่างไร'), 'person_history');
    assert.strictEqual(detectPersonFactualIntent('บุคคลนี้มีประวัติอย่างไร'), 'person_history');
    assert.strictEqual(detectPersonFactualIntent('ขอดูประวัติคนนี้'), 'person_history');
    assert.strictEqual(detectPersonFactualIntent('สรุปประวัติคนนี้'), 'person_history');
    assert.strictEqual(detectPersonFactualIntent('เยี่ยมล่าสุดเมื่อไหร่'), 'latest_visit');
    assert.strictEqual(detectPersonFactualIntent('เยี่ยมทั้งหมดกี่ครั้ง'), 'visit_count');
    assert.strictEqual(detectPersonFactualIntent('ตรวจปัสสาวะล่าสุดเมื่อไหร่'), 'latest_urine_test');
    assert.strictEqual(detectPersonFactualIntent('เคยฉี่ม่วงกี่ครั้ง'), 'urine_positive_count');
    assert.strictEqual(detectPersonFactualIntent('สถานะล่าสุดคืออะไร'), 'latest_status');
  });

  test('analysis wording must NOT enter Tier-2', () => {
    assert.strictEqual(detectPersonFactualIntent('วิเคราะห์ประวัติคนนี้'), null);
    assert.strictEqual(detectPersonFactualIntent('คนนี้มีอะไรที่ควรติดตาม'), null);
    assert.strictEqual(detectPersonFactualIntent('ช่วยวิเคราะห์แนวโน้มคนนี้'), null);
  });

  test('personId hint parsing is strict', () => {
    assert.strictEqual(validPersonId(7), 7);
    assert.strictEqual(validPersonId('7'), 7);
    assert.strictEqual(validPersonId(0), null);
    assert.strictEqual(validPersonId(-3), null);
    assert.strictEqual(validPersonId(1.5), null);
    assert.strictEqual(validPersonId('abc'), null);
    assert.strictEqual(validPersonId(null), null);
    assert.deepStrictEqual(
      sanitizePersonContext({ personId: 7, station_id: 2, role: 'admin', user_id: 999, province_id: 8, permissions: ['x'] }),
      { personId: 7 },
      'only personId is kept, everything else is dropped'
    );
    assert.deepStrictEqual(sanitizePersonContext({}), {});
  });
});

describe('Tier-2: คนนี้มีประวัติอย่างไร', () => {
  test('routes to getPersonSummary, zero Ollama, deterministic, structured presentation', async () => {
    const ctx = make();
    try {
      const person = insertPerson(ctx.db, { station_id: 1, person_type: 'drug_user', status: 'active' });
      insertVisit(ctx.db, person.id, { visit_date: '2025-06-15', result: 'progress' });
      insertVisit(ctx.db, person.id, { visit_date: '2025-05-10', result: 'normal' });
      insertUrineTest(ctx.db, person.id, { test_date: '2025-06-14', result: 'negative' });

      const spy = ollamaSpy();
      const opts = { context: { personId: person.id }, requestFn: spy.requestFn };
      const first = await ctx.gateway.chatWithTools('คนนี้มีประวัติอย่างไร', STATION1_USER, null, opts);
      const second = await ctx.gateway.chatWithTools('คนนี้มีประวัติอย่างไร', STATION1_USER, null, opts);

      assert.strictEqual(first.executionTier, 2);
      assert.strictEqual(first.fastPath, true);
      assert.strictEqual(first.grounded, true);
      assert.strictEqual(first.intent, 'person_history');
      assert.strictEqual(spy.calls.length, 0, 'zero Ollama calls');
      assert.deepStrictEqual(first.toolsUsed, ['get_person_summary']);

      assert.deepStrictEqual(second, first, 'answer must be deterministic');

      assert.ok(first.answer.includes(`${person.first_name} ${person.last_name}`));
      assert.ok(first.answer.includes('เยี่ยมแล้วทั้งหมด 2 ครั้ง'));
      assert.ok(first.answer.includes('ตรวจปัสสาวะแล้ว 1 ครั้ง'));

      assert.strictEqual(first.presentation.type, 'person_summary');
      assert.strictEqual(first.presentation.person.id, person.id);
      assert.strictEqual(first.presentation.visitSummary.visit_count, 2);
      assert.strictEqual(first.presentation.urineSummary.positive_count, 0);
      assert.ok(Array.isArray(first.presentation.recentVisits));
    } finally {
      ctx.cleanup();
    }
  });
});

describe('Tier-2 determinism: per-question', () => {
  test('เยี่ยมล่าสุดเมื่อไหร่', async () => {
    const ctx = make();
    try {
      const person = insertPerson(ctx.db, { station_id: 1 });
      insertVisit(ctx.db, person.id, { visit_date: '2025-07-20', result: 'recovered' });
      insertVisit(ctx.db, person.id, { visit_date: '2025-06-01', result: 'normal' });

      const { result, ollamaCalls } = await ask(ctx.gateway, 'เยี่ยมล่าสุดเมื่อไหร่', STATION1_USER, {
        context: { personId: person.id },
      });

      assert.strictEqual(result.executionTier, 2);
      assert.strictEqual(result.grounded, true);
      assert.strictEqual(ollamaCalls, 0);
      assert.ok(result.answer.includes('2025-07-20'), result.answer);

      const again = await ctx.gateway.chatWithTools('เยี่ยมล่าสุดเมื่อไหร่', STATION1_USER, null, {
        context: { personId: person.id },
        requestFn: ollamaSpy().requestFn,
      });
      assert.deepStrictEqual(again, result, 'deterministic');
    } finally {
      ctx.cleanup();
    }
  });

  test('เยี่ยมทั้งหมดกี่ครั้ง', async () => {
    const ctx = make();
    try {
      const person = insertPerson(ctx.db, { station_id: 1 });
      for (let i = 1; i <= 4; i++) insertVisit(ctx.db, person.id, { visit_date: `2025-01-0${i}` });

      const { result, ollamaCalls } = await ask(ctx.gateway, 'เยี่ยมทั้งหมดกี่ครั้ง', STATION1_USER, {
        context: { personId: person.id },
      });

      assert.strictEqual(result.executionTier, 2);
      assert.strictEqual(ollamaCalls, 0);
      assert.strictEqual(result.presentation.visitSummary.visit_count, 4);
      assert.ok(result.answer.includes('เยี่ยมทั้งหมด 4 ครั้ง'), result.answer);
    } finally {
      ctx.cleanup();
    }
  });

  test('เคยฉี่ม่วงกี่ครั้ง', async () => {
    const ctx = make();
    try {
      const person = insertPerson(ctx.db, { station_id: 1 });
      insertUrineTest(ctx.db, person.id, { test_date: '2025-01-01', result: 'positive' });
      insertUrineTest(ctx.db, person.id, { test_date: '2025-02-01', result: 'positive' });
      insertUrineTest(ctx.db, person.id, { test_date: '2025-03-01', result: 'negative' });

      const { result, ollamaCalls } = await ask(ctx.gateway, 'เคยฉี่ม่วงกี่ครั้ง', STATION1_USER, {
        context: { personId: person.id },
      });

      assert.strictEqual(result.executionTier, 2);
      assert.strictEqual(ollamaCalls, 0);
      assert.strictEqual(result.presentation.urineSummary.positive_count, 2);
      assert.ok(result.answer.includes('ม่วง (positive) ทั้งหมด 2 ครั้ง'), result.answer);
    } finally {
      ctx.cleanup();
    }
  });

  test('ตรวจปัสสาวะล่าสุดเมื่อไหร่', async () => {
    const ctx = make();
    try {
      const person = insertPerson(ctx.db, { station_id: 1 });
      insertUrineTest(ctx.db, person.id, { test_date: '2025-05-10', result: 'negative' });
      insertUrineTest(ctx.db, person.id, { test_date: '2025-09-03', result: 'positive' });

      const { result, ollamaCalls } = await ask(ctx.gateway, 'ตรวจปัสสาวะล่าสุดเมื่อไหร่', STATION1_USER, {
        context: { personId: person.id },
      });

      assert.strictEqual(result.executionTier, 2);
      assert.strictEqual(ollamaCalls, 0);
      assert.strictEqual(result.presentation.urineSummary.latest_test.date, '2025-09-03');
      assert.ok(result.answer.includes('2025-09-03'), result.answer);
    } finally {
      ctx.cleanup();
    }
  });
});

describe('Tier-2 security', () => {
  test('cross-station personId is blocked without data leakage', async () => {
    const ctx = make();
    try {
      const s1 = insertPerson(ctx.db, { station_id: 1, first_name: 'ไม่รั่ว', last_name: 'ข้อมูลหนึ่ง' });
      const s2 = insertPerson(ctx.db, { station_id: 2, first_name: 'ลับสุดยอด', last_name: 'ข้ามสถานี' });
      insertVisit(ctx.db, s2.id, { visit_date: '2025-09-09', result: 'warning' });

      const { result, ollamaCalls } = await ask(ctx.gateway, 'คนนี้มีประวัติอย่างไร', STATION1_USER, {
        context: { personId: s2.id },
      });

      assert.strictEqual(result.executionTier, 2);
      assert.strictEqual(ollamaCalls, 0);
      assert.strictEqual(result.grounded, true);
      assert.strictEqual(result.intent, 'person_history');
      assert.ok(result.answer.includes('ไม่พบข้อมูลบุคคลนี้ในพื้นที่ที่รับผิดชอบ'), result.answer);
      assert.ok(!result.answer.includes('ลับสุดยอด'), 'must not leak station-2 person name');
      assert.ok(!result.answer.includes('2025-09-09'), 'must not leak station-2 visit data');
      assert.strictEqual(result.presentation, undefined, 'no data presented for blocked person');
      assert.deepStrictEqual(result.toolsUsed, ['get_person_summary']);

      const s1Res = await ctx.gateway.chatWithTools('คนนี้มีประวัติอย่างไร', STATION1_USER, null, {
        context: { personId: s1.id },
        requestFn: ollamaSpy().requestFn,
      });
      assert.ok(s1Res.answer.includes('ไม่รั่ว ข้อมูลหนึ่ง'), 'own-station query still works');
    } finally {
      ctx.cleanup();
    }
  });

  test('fake frontend station_id/role/user_id cannot escalate (gateway level)', async () => {
    const ctx = make();
    try {
      const s1 = insertPerson(ctx.db, { station_id: 1 });
      const s2 = insertPerson(ctx.db, { station_id: 2 });

      const spoofedContext = {
        personId: s1.id,
        station_id: 2,
        role: 'admin',
        user_id: 999,
        province_id: 8,
        permissions: ['read:all'],
      };

      const ok = await ctx.gateway.chatWithTools('เยี่ยมล่าสุดเมื่อไหร่', STATION1_USER, null, {
        context: spoofedContext,
        requestFn: ollamaSpy().requestFn,
      });
      assert.strictEqual(ok.executionTier, 2, 'still Tier-2 on own-station person');
      assert.ok(ok.answer.includes(`${s1.first_name} ${s1.last_name}`), 'scoped to the real station-1 person');

      const blocked = await ctx.gateway.chatWithTools('เยี่ยมล่าสุดเมื่อไหร่', STATION1_USER, null, {
        context: { ...spoofedContext, personId: s2.id },
        requestFn: ollamaSpy().requestFn,
      });
      assert.strictEqual(blocked.executionTier, 2);
      assert.ok(blocked.answer.includes('ไม่พบข้อมูลบุคคลนี้ในพื้นที่ที่รับผิดชอบ'), 'admin role spoof did not widen scope');
      assert.ok(!blocked.answer.includes(`${s2.first_name} ${s2.last_name}`));
    } finally {
      ctx.cleanup();
    }
  });

  test('fake frontend fields are ignored at the HTTP route, Tier-2 still scoped', async () => {
    const ctx = setup();
    try {
      const s1 = insertPerson(ctx.db, { station_id: 1, first_name: 'สมชาย', last_name: 'รักษ์ถิ่น' });
      const { app } = createApp(ctx.db);
      const token = await login(app, 'station1_off');

      const res = await request(app)
        .post('/api/ai/chat')
        .set('Authorization', `Bearer ${token}`)
        .send({
          message: 'สถานะล่าสุดคืออะไร',
          context: { personId: s1.id, station_id: 2, role: 'admin', user_id: 999, province_id: 8, permissions: ['x'] },
        })
        .timeout(5000);

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.executionTier, 2);
      assert.strictEqual(res.body.meta.executionTier, 2);
      assert.strictEqual(res.body.meta.fastPath, true);
      assert.strictEqual(res.body.meta.grounded, true);
      assert.deepStrictEqual(res.body.toolsUsed, [{ name: 'get_person_summary' }]);
      assert.ok(res.body.answer.includes('สมชาย รักษ์ถิ่น'), res.body.answer);
      assert.strictEqual(res.body.presentation.type, 'person_summary');
    } finally {
      ctx.cleanup();
    }
  });
});

describe('Tier-2 fallthrough (no guessing)', () => {
  test('analysis wording does NOT enter Tier-2 and falls through to existing path', async () => {
    const ctx = make();
    try {
      const person = insertPerson(ctx.db, { station_id: 1 });

      for (const q of ['วิเคราะห์ประวัติคนนี้', 'คนนี้มีอะไรที่ควรติดตาม', 'ช่วยวิเคราะห์แนวโน้มคนนี้']) {
        const spy = ollamaSpy();
        const result = await ctx.gateway.chatWithTools(q, STATION1_USER, null, {
          context: { personId: person.id },
          requestFn: spy.requestFn,
        });

        assert.notStrictEqual(result.executionTier, 2, `must not Tier-2: ${q}`);
        assert.strictEqual(result.fastPath, false, `must not fast-path: ${q}`);
        assert.ok(spy.calls.length >= 1, `fell through to Ollama path (not Tier-2): ${q}`);
        assert.strictEqual(result.presentation, undefined, `no person_summary presentation: ${q}`);
      }
    } finally {
      ctx.cleanup();
    }
  });

  test('no context.personId does not guess who "คนนี้" is', async () => {
    const ctx = make();
    try {
      const spy = ollamaSpy();
      const result = await ctx.gateway.chatWithTools('คนนี้มีประวัติอย่างไร', STATION1_USER, null, {
        requestFn: spy.requestFn,
      });

      assert.strictEqual(result.executionTier, 3, 'falls back to existing Qwen/tool path');
      assert.strictEqual(result.fastPath, false);
      assert.notStrictEqual(result.answer, undefined);
      assert.strictEqual(result.presentation, undefined, 'no person data without a personId');
      assert.ok(spy.calls.length >= 1, 'existing fallback (Ollama) behavior unchanged');
    } finally {
      ctx.cleanup();
    }
  });

  test('invalid personId hint does not guess and does not Tier-2', async () => {
    const ctx = make();
    try {
      const spy = ollamaSpy();
      const result = await ctx.gateway.chatWithTools('เยี่ยมล่าสุดเมื่อไหร่', STATION1_USER, null, {
        context: { personId: 'ไม่ใช่ตัวเลข' },
        requestFn: spy.requestFn,
      });
      assert.notStrictEqual(result.executionTier, 2);
      assert.strictEqual(result.fastPath, false);
      assert.ok(spy.calls.length >= 1);
    } finally {
      ctx.cleanup();
    }
  });
});

describe('Tier-2 HTTP route', () => {
  test('context.personId routes /api/ai/chat through Tier-2 with metadata', async () => {
    const ctx = setup();
    try {
      const s1 = insertPerson(ctx.db, { station_id: 1 });
      insertVisit(ctx.db, s1.id, { visit_date: '2025-08-08', result: 'progress' });
      const { app } = createApp(ctx.db);
      const token = await login(app, 'station1_off');

      const res = await request(app)
        .post('/api/ai/chat')
        .set('Authorization', `Bearer ${token}`)
        .send({ message: 'ขอดูประวัติคนนี้', context: { personId: s1.id } })
        .timeout(5000);

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.executionTier, 2);
      assert.strictEqual(res.body.meta.executionTier, 2);
      assert.strictEqual(res.body.meta.fastPath, true);
      assert.strictEqual(res.body.grounded, true);
      assert.deepStrictEqual(res.body.toolsUsed, [{ name: 'get_person_summary' }]);
      assert.strictEqual(res.body.presentation.type, 'person_summary');
      assert.ok(res.body.presentation.visitSummary.latest_visit.date, '2025-08-08');
    } finally {
      ctx.cleanup();
    }
  });

  test('cross-station personId at the route returns deterministic no-leak answer', async () => {
    const ctx = setup();
    try {
      const s2 = insertPerson(ctx.db, { station_id: 2, first_name: 'สืบห้าม', last_name: 'เหลื่อมสถานี' });
      insertVisit(ctx.db, s2.id, { visit_date: '2026-01-01', result: 'warning' });
      const { app } = createApp(ctx.db);
      const token = await login(app, 'station1_off');

      const res = await request(app)
        .post('/api/ai/chat')
        .set('Authorization', `Bearer ${token}`)
        .send({ message: 'สถานะล่าสุดคืออะไร', context: { personId: s2.id } })
        .timeout(5000);

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.executionTier, 2);
      assert.ok(res.body.answer.includes('ไม่พบข้อมูลบุคคลนี้ในพื้นที่ที่รับผิดชอบ'), res.body.answer);
      assert.ok(!res.body.answer.includes('สืบห้าม'), 'no name leak');
      assert.strictEqual(res.body.presentation, undefined, 'no presentation for blocked person');
    } finally {
      ctx.cleanup();
    }
  });
});