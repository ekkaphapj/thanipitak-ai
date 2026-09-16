const { test } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { setup, USERS } = require('./helpers');

async function getToken(app, username) {
  const res = await request(app)
    .post('/api/auth/login')
    .send({ username, password: USERS[username].password })
    .timeout(5000);
  return res.body.token;
}

test('audit: login action is recorded', async () => {
  const ctx = setup();
  try {
    const before = ctx.db.prepare("SELECT COUNT(*) c FROM audit_logs WHERE action='login'").get().c;
    await getToken(ctx.app, 'station1_off');
    const after = ctx.db.prepare("SELECT COUNT(*) c FROM audit_logs WHERE action='login'").get().c;
    assert.strictEqual(after, before + 1);
  } finally {
    ctx.cleanup();
  }
});

test('audit: login_failed action is recorded', async () => {
  const ctx = setup();
  try {
    const before = ctx.db.prepare("SELECT COUNT(*) c FROM audit_logs WHERE action='login_failed'").get().c;
    await request(ctx.app)
      .post('/api/auth/login')
      .send({ username: 'station1_off', password: 'wrong' })
      .timeout(5000);
    const after = ctx.db.prepare("SELECT COUNT(*) c FROM audit_logs WHERE action='login_failed'").get().c;
    assert.strictEqual(after, before + 1);
  } finally {
    ctx.cleanup();
  }
});

test('audit: person_list_access is recorded', async () => {
  const ctx = setup();
  try {
    const token = await getToken(ctx.app, 'station1_off');
    const before = ctx.db.prepare("SELECT COUNT(*) c FROM audit_logs WHERE action='person_list_access'").get().c;
    await request(ctx.app)
      .get('/api/persons')
      .set('Authorization', `Bearer ${token}`)
      .timeout(5000);
    const after = ctx.db.prepare("SELECT COUNT(*) c FROM audit_logs WHERE action='person_list_access'").get().c;
    assert.strictEqual(after, before + 1);
  } finally {
    ctx.cleanup();
  }
});

test('audit: statistics_access is recorded', async () => {
  const ctx = setup();
  try {
    const token = await getToken(ctx.app, 'station1_off');
    const before = ctx.db.prepare("SELECT COUNT(*) c FROM audit_logs WHERE action='statistics_access'").get().c;
    await request(ctx.app)
      .get('/api/statistics')
      .set('Authorization', `Bearer ${token}`)
      .timeout(5000);
    const after = ctx.db.prepare("SELECT COUNT(*) c FROM audit_logs WHERE action='statistics_access'").get().c;
    assert.strictEqual(after, before + 1);
  } finally {
    ctx.cleanup();
  }
});

test('audit: forbidden_access_attempt contains correct metadata', async () => {
  const ctx = setup();
  try {
    const s2 = ctx.db.prepare('SELECT id FROM persons WHERE station_id=2 ORDER BY id LIMIT 1').get();
    const token = await getToken(ctx.app, 'station1_off');
    await request(ctx.app)
      .get(`/api/persons/${s2.id}`)
      .set('Authorization', `Bearer ${token}`)
      .timeout(5000);
    const log = ctx.db
      .prepare("SELECT * FROM audit_logs WHERE action='forbidden_access_attempt' ORDER BY id DESC LIMIT 1")
      .get();
    assert.strictEqual(log.user_id, 2);
    assert.strictEqual(log.endpoint, `/api/persons/${s2.id}`);
    assert.strictEqual(Number(log.target_id), s2.id);
    assert.ok(log.created_at, 'created_at must be present');
  } finally {
    ctx.cleanup();
  }
});

test('audit: audit log does NOT store password or token', async () => {
  const ctx = setup();
  try {
    const token = await getToken(ctx.app, 'station1_off');
    const res = await request(ctx.app)
      .get('/api/persons')
      .set('Authorization', `Bearer ${token}`)
      .timeout(5000);
    assert.strictEqual(res.status, 200);
    const logs = ctx.db.prepare('SELECT * FROM audit_logs').all();
    const serialized = JSON.stringify(logs);
    assert.ok(!serialized.includes('thanipitak123'), 'password must not appear in audit logs');
    assert.ok(!serialized.includes(token.slice(10, 30)), 'JWT token substring must not appear in audit logs');
  } finally {
    ctx.cleanup();
  }
});