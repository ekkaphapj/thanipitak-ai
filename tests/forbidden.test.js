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

test('forbidden: cross-station detail returns 404', async () => {
  const ctx = setup();
  try {
    const s2 = ctx.db.prepare('SELECT id FROM persons WHERE station_id=2 ORDER BY id LIMIT 1').get();
    const token = await getToken(ctx.app, 'station1_off');
    const res = await request(ctx.app)
      .get(`/api/persons/${s2.id}`)
      .set('Authorization', `Bearer ${token}`)
      .timeout(5000);
    assert.ok(res.status === 403 || res.status === 404);
    assert.strictEqual(res.body.error, 'ไม่พบบุคคลนี้');
  } finally {
    ctx.cleanup();
  }
});

test('forbidden: cross-station access is logged as forbidden_access_attempt', async () => {
  const ctx = setup();
  try {
    const s2 = ctx.db.prepare('SELECT id FROM persons WHERE station_id=2 ORDER BY id LIMIT 1').get();
    const token = await getToken(ctx.app, 'station1_off');
    await request(ctx.app)
      .get(`/api/persons/${s2.id}`)
      .set('Authorization', `Bearer ${token}`)
      .timeout(5000);
    const logs = ctx.db
      .prepare("SELECT * FROM audit_logs WHERE action='forbidden_access_attempt'")
      .all();
    assert.ok(logs.length > 0, 'at least one forbidden audit log');
    const match = logs.find((l) => String(l.target_id) === String(s2.id));
    assert.ok(match, 'audit log contains target_id of forbidden person');
    assert.strictEqual(match.action, 'forbidden_access_attempt');
  } finally {
    ctx.cleanup();
  }
});

test('forbidden: non-existent person also generates audit log', async () => {
  const ctx = setup();
  try {
    const before = ctx.db
      .prepare("SELECT COUNT(*) c FROM audit_logs WHERE action='forbidden_access_attempt'")
      .get().c;
    const token = await getToken(ctx.app, 'station1_off');
    await request(ctx.app)
      .get('/api/persons/99999')
      .set('Authorization', `Bearer ${token}`)
      .timeout(5000);
    const after = ctx.db
      .prepare("SELECT COUNT(*) c FROM audit_logs WHERE action='forbidden_access_attempt'")
      .get().c;
    assert.strictEqual(after, before + 1);
  } finally {
    ctx.cleanup();
  }
});