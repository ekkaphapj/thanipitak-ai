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

test('statistics: returns valid structure', async () => {
  const ctx = setup();
  try {
    const token = await getToken(ctx.app, 'station1_off');
    const res = await request(ctx.app)
      .get('/api/statistics')
      .set('Authorization', `Bearer ${token}`)
      .timeout(5000);
    assert.strictEqual(res.status, 200);
    const d = res.body.data;
    assert.strictEqual(typeof d.total, 'number');
    assert.strictEqual(typeof d.psychiatric, 'number');
    assert.strictEqual(typeof d.drug_user, 'number');
    assert.strictEqual(typeof d.dealer, 'number');
    assert.strictEqual(typeof d.followupOverdue, 'number');
    assert.strictEqual(d.total, d.psychiatric + d.drug_user + d.dealer + 0);
  } finally {
    ctx.cleanup();
  }
});

test('statistics: officer stats match station-1 DB counts', async () => {
  const ctx = setup();
  try {
    const token = await getToken(ctx.app, 'station1_off');
    const res = await request(ctx.app)
      .get('/api/statistics')
      .set('Authorization', `Bearer ${token}`)
      .timeout(5000);
    const d = res.body.data;
    const q = (sql) => ctx.db.prepare(sql).get();
    const total = q("SELECT COUNT(*) c FROM persons WHERE station_id=1").c;
    const psych = q("SELECT COUNT(*) c FROM persons WHERE station_id=1 AND person_type='psychiatric'").c;
    const drug = q("SELECT COUNT(*) c FROM persons WHERE station_id=1 AND person_type='drug_user'").c;
    const deal = q("SELECT COUNT(*) c FROM persons WHERE station_id=1 AND person_type='dealer'").c;
    assert.strictEqual(d.total, total);
    assert.strictEqual(d.psychiatric, psych);
    assert.strictEqual(d.drug_user, drug);
    assert.strictEqual(d.dealer, deal);
  } finally {
    ctx.cleanup();
  }
});

test('statistics: admin stats equal all-stations total', async () => {
  const ctx = setup();
  try {
    const token = await getToken(ctx.app, 'admin');
    const res = await request(ctx.app)
      .get('/api/statistics')
      .set('Authorization', `Bearer ${token}`)
      .timeout(5000);
    const d = res.body.data;
    const q = (sql) => ctx.db.prepare(sql).get();
    const total = q('SELECT COUNT(*) c FROM persons').c;
    assert.strictEqual(d.total, total);
    assert.strictEqual(d.total, 500);
  } finally {
    ctx.cleanup();
  }
});

test('statistics: officer overdue count uses type-specific intervals not a flat 30 days', async () => {
  const ctx = setup();
  try {
    const token = await getToken(ctx.app, 'station1_off');
    const res = await request(ctx.app)
      .get('/api/statistics')
      .set('Authorization', `Bearer ${token}`)
      .timeout(5000);
    assert.strictEqual(res.status, 200);
    const overdue = await request(ctx.app)
      .get('/api/followups/overdue?limit=200')
      .set('Authorization', `Bearer ${token}`)
      .timeout(5000);
    assert.strictEqual(overdue.status, 200);
    assert.strictEqual(res.body.data.followupOverdue, overdue.body.meta.total);
  } finally {
    ctx.cleanup();
  }
});