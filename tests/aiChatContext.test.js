const { describe, test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { setup, USERS } = require('./helpers');
const ChatContext = require('../frontend/chatContext');
const { createApp } = require('../src/app');

const AI_JS = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'ai.js'), 'utf8');

const FORBIDDEN_KEY = (key) => /station_id|allowedStationIds|user_id|role|province_id|permissions/.test(key);

async function login(app, username) {
  const res = await request(app)
    .post('/api/auth/login')
    .send({ username, password: USERS[username].password })
    .timeout(5000);
  return res.body.token;
}

function makePerson(db) {
  const info = db.prepare(
    `INSERT INTO persons (synthetic_code, first_name, last_name, person_type, district, subdistrict, station_id, status, last_visit_date, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run('TP-S25-001', 'สมศรี', 'รักษ์ถิ่น', 'drug_user', 'คลองประเวศ', 'บึงมัน', 1, 'active', null, '2025-01-01');
  return { id: Number(info.lastInsertRowid), first_name: 'สมศรี', last_name: 'รักษ์ถิ่น' };
}

describe('STEP 2.5 selected-person context (pure logic)', () => {
  test('selected personId IS included in the chat request body', () => {
    const body = ChatContext.buildChatBody('คนนี้มีประวัติอย่างไร', { personId: 42, displayName: 'สมชาย ใจดี' });
    assert.strictEqual(body.message, 'คนนี้มีประวัติอย่างไร');
    assert.deepStrictEqual(body.context, { personId: 42 });
  });

  test('selected from a person-list item shape works (person_id / full_name)', () => {
    const body = ChatContext.buildChatBody('สถานะล่าสุดคืออะไร', {
      person_id: 7,
      full_name: 'นางสาวปรางค์ ทองดี',
      person_type: 'dealer',
      status: 'active',
    });
    assert.deepStrictEqual(body.context, { personId: 7 });
  });

  test('forbidden authorization fields are NEVER included', () => {
    const cases = [
      { personId: 5, displayName: 'ก' },
      { person_id: 5, full_name: 'ข', station_id: 2, role: 'admin', user_id: 999 },
      { personId: 5, displayName: 'ค', province_id: 8, permissions: ['read:all'], allowedStationIds: [1, 2] },
    ];
    for (const sel of cases) {
      const body = ChatContext.buildChatBody('คนนี้มีประวัติอย่างไร', sel);
      const flatKeys = JSON.stringify(body);
      assert.strictEqual(
        Object.keys(body).filter((k) => FORBIDDEN_KEY(k)).length,
        0,
        'top level must have no forbidden keys'
      );
      assert.ok(!FORBIDDEN_KEY(flatKeys), 'no forbidden field may appear anywhere: ' + flatKeys);
      const ctxKeys = body.context ? Object.keys(body.context) : [];
      assert.deepStrictEqual(ctxKeys, ['personId'], 'context may only contain personId');
    }
  });

  test('context.personId may be a numeric string but must be a positive integer', () => {
    assert.deepStrictEqual(ChatContext.buildChatBody('q', { personId: '12', displayName: 'ง' }).context, { personId: 12 });
    assert.strictEqual(ChatContext.buildChatBody('q', { personId: 0 }).context, undefined);
    assert.strictEqual(ChatContext.buildChatBody('q', { personId: -5 }).context, undefined);
    assert.strictEqual(ChatContext.buildChatBody('q', { personId: 1.5 }).context, undefined);
    assert.strictEqual(ChatContext.buildChatBody('q', { personId: 'abc' }).context, undefined);
  });

  test('invalid/missing personId does not break chat (context simply omitted)', () => {
    for (const sel of [null, undefined, {}, { personId: null }, { personId: 'x' }, { displayName: 'ไม่รู้จัก' }]) {
      const body = ChatContext.buildChatBody('สวัสดีครับ', sel);
      assert.strictEqual(body.context, undefined, 'no context when selection invalid');
      assert.strictEqual(body.message, 'สวัสดีครับ');
    }
  });

  test('clear selection removes personId from the request', () => {
    const selected = ChatContext.normalizeSelectedPerson({ personId: 9, displayName: 'จ' });
    const before = ChatContext.buildChatBody('q', selected);
    assert.deepStrictEqual(before.context, { personId: 9 });

    const cleared = ChatContext.clearSelection();
    const after = ChatContext.buildChatBody('q', cleared);
    assert.strictEqual(after.context, undefined);
  });

  test('logout clears selection (selection is memory-only, never persisted)', () => {
    // Selection must not be written to localStorage. Only the token is persisted.
    const setItems = [...AI_JS.matchAll(/localStorage\.setItem\(/g)];
    assert.ok(setItems.length >= 1, 'token is persisted');
    for (const m of setItems) {
      const snippet = AI_JS.slice(m.index, m.index + 40);
      assert.ok(/^localStorage\.setItem\((TOKEN_KEY|SOURCE_KEY)/.test(snippet), 'only token and source preference may be persisted: ' + snippet);
    }
    assert.ok(!/localStorage[^;\n]*selectedPerson/.test(AI_JS), 'selection must never touch localStorage');
    // Logout path must clear the selection.
    assert.ok(AI_JS.includes("$('#logout-btn').addEventListener('click'"), 'logout handler exists');
    assert.ok(AI_JS.includes('clearSelectedPerson'), 'logout clears selection');
  });

  test('indicator text is rendered from the selection', () => {
    assert.strictEqual(ChatContext.indicatorText({ personId: 3, displayName: 'ปกรณ์ สว่าง' }), 'กำลังสอบถามข้อมูลของ: ปกรณ์ สว่าง');
    assert.strictEqual(ChatContext.indicatorText(null), null);
  });
});

describe('STEP 2.5 frontend wiring (static)', () => {
  test('chat body always built through ChatContext.buildChatBody', () => {
    assert.ok(AI_JS.includes('ChatContext.buildChatBody(message, state.selectedPerson)'));
  });

  test('person_summary presentation renders compact fields', () => {
    assert.ok(AI_JS.includes("=== 'person_summary'"), 'ai.js renders person_summary presentations');
    const labels = [
      'ชื่อ', 'ประเภท', 'สถานะ', 'จำนวนครั้งที่เยี่ยม', 'เยี่ยมล่าสุด',
      'จำนวนครั้งตรวจปัสสาวะ', 'ผลบวก (ม่วง)', 'ตรวจล่าสุด', 'สถานะการติดตาม', 'หมายเหตุล่าสุด',
    ];
    for (const label of labels) {
      assert.ok(AI_JS.includes("'" + label + "'") || AI_JS.includes('`' + label + '`'), 'missing label: ' + label);
    }
  });

  test('person-list rows are selectable and highlight the current selection', () => {
    assert.ok(AI_JS.includes("selectPerson({ personId: item.person_id, displayName: item.full_name })"));
    assert.ok(AI_JS.includes('pl-selected'));
    assert.ok(AI_JS.includes('clear-selection-btn'));
  });

  test('typing เริ่มใหม่ resets the conversation and selected person locally', () => {
    assert.ok(AI_JS.includes('function isStartOverCommand(message)'), 'start-over command detector exists');
    assert.ok(AI_JS.includes("return text === 'เริ่มใหม่';"), 'start-over command is exact after polite suffix cleanup');
    assert.ok(AI_JS.includes('function resetConversation()'), 'shared reset behavior exists');
    assert.ok(AI_JS.includes('if (isStartOverCommand(message))'), 'start-over is handled before the API request');
    assert.ok(AI_JS.includes('clearSelectedPerson();'), 'start-over clears the selected person');
  });

  test('a one-person monitoring result becomes the selected chat context', () => {
    assert.ok(AI_JS.includes('if (items.length === 1)'), 'single monitoring result is detected');
    assert.ok(AI_JS.includes('selectPerson({ personId: person.personId, displayName: person.displayName })'), 'single monitoring result is selected');
  });
});

describe('STEP 2.5 end-to-end via real HTTP app (no Ollama needed)', () => {
  test('body built by buildChatBody hits Tier-2 person_summary for the selected authorized person', async () => {
    const ctx = setup();
    try {
      const person = makePerson(ctx.db);
      const { app } = createApp(ctx.db);
      const token = await login(app, 'station1_off');

      const body = ChatContext.buildChatBody('คนนี้มีประวัติอย่างไร', { personId: person.id, displayName: person.first_name + ' ' + person.last_name });
      const res = await request(app)
        .post('/api/ai/chat')
        .set('Authorization', `Bearer ${token}`)
        .send(body)
        .timeout(5000);

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.executionTier, 2);
      assert.strictEqual(res.body.meta.fastPath, true);
      assert.strictEqual(res.body.grounded, true);
      assert.deepStrictEqual(res.body.toolsUsed, [{ name: 'get_person_summary' }]);

      const pres = res.body.presentation;
      assert.strictEqual(pres.type, 'person_summary');
      assert.strictEqual(pres.person.id, person.id);
      assert.strictEqual(pres.person.station_id, 1);
      assert.ok(pres.person.first_name, 'has name (ชื่อ)');
      assert.ok(pres.person.person_type, 'has type (ประเภท)');
      assert.ok(pres.person.status, 'has status (สถานะ)');
      assert.ok(pres.visitSummary && typeof pres.visitSummary.visit_count === 'number');
      assert.ok(pres.urineSummary && typeof pres.urineSummary.positive_count === 'number');
      assert.ok(pres.followup && typeof pres.followup.overdue === 'boolean');
    } finally {
      ctx.cleanup();
    }
  });

  test('person_list pagination still works (Tier-1 list), including page 2', async () => {
    const ctx = setup();
    try {
      const { app } = createApp(ctx.db);
      const token = await login(app, 'station1_off');

      const page1 = await request(app)
        .post('/api/ai/chat')
        .set('Authorization', `Bearer ${token}`)
        .send({ message: 'ขอรายชื่อผู้ค้า' })
        .timeout(5000);
      assert.strictEqual(page1.status, 200);
      assert.strictEqual(page1.body.presentation.type, 'person_list');
      assert.strictEqual(page1.body.presentation.page, 1);
      assert.strictEqual(page1.body.presentation.pageSize, 20);
      assert.ok(page1.body.presentation.total > 0);
      assert.ok(Array.isArray(page1.body.presentation.items));
      assert.strictEqual(page1.body.presentation.items.length, 20, 'first page is full page size');

      const page2 = await request(app)
        .post('/api/ai/chat')
        .set('Authorization', `Bearer ${token}`)
        .send({ message: 'ขอรายชื่อผู้ค้า หน้า 2' })
        .timeout(5000);
      assert.strictEqual(page2.body.presentation.page, 2);
      assert.ok(page2.body.presentation.total > 20, 'total spans beyond page 1');
    } finally {
      ctx.cleanup();
    }
  });

  test('existing Tier-1 behavior unchanged (count fast path)', async () => {
    const ctx = setup();
    try {
      const { app } = createApp(ctx.db);
      const token = await login(app, 'station1_off');
      const res = await request(app)
        .post('/api/ai/chat')
        .set('Authorization', `Bearer ${token}`)
        .send({ message: 'มีผู้เสพกี่คน' })
        .timeout(5000);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.executionTier, 1);
      assert.strictEqual(res.body.meta.fastPath, true);
      assert.deepStrictEqual(res.body.toolsUsed, [{ name: 'get_statistics' }]);
    } finally {
      ctx.cleanup();
    }
  });

  test('existing Tier-2 behavior unchanged (selected-person factual path)', async () => {
    const ctx = setup();
    try {
      const person = makePerson(ctx.db);
      const { app } = createApp(ctx.db);
      const token = await login(app, 'station1_off');
      const body = ChatContext.buildChatBody('เยี่ยมล่าสุดเมื่อไหร่', { personId: person.id, displayName: 'a b' });
      const res = await request(app)
        .post('/api/ai/chat')
        .set('Authorization', `Bearer ${token}`)
        .send(body)
        .timeout(5000);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.executionTier, 2);
      assert.strictEqual(res.body.grounded, true);
      assert.deepStrictEqual(res.body.toolsUsed, [{ name: 'get_person_summary' }]);
    } finally {
      ctx.cleanup();
    }
  });

  test('chat still works when personId is missing/invalid (no context sent)', async () => {
    const ctx = setup();
    try {
      const { app } = createApp(ctx.db);
      const token = await login(app, 'station1_off');
      // Tier-1 count path requires no context; invalid selection must not break it.
      const body = ChatContext.buildChatBody('มีผู้ค้ากี่คน', { personId: 'ไม่ใช่รหัส' });
      assert.strictEqual(body.context, undefined);
      const res = await request(app)
        .post('/api/ai/chat')
        .set('Authorization', `Bearer ${token}`)
        .send(body)
        .timeout(5000);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.executionTier, 1);
    } finally {
      ctx.cleanup();
    }
  });
});
