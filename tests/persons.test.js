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

test('persons: default pagination returns first page', async () => {
  const ctx = setup();
  try {
    const token = await getToken(ctx.app, 'station1_off');
    const res = await request(ctx.app)
      .get('/api/persons')
      .set('Authorization', `Bearer ${token}`)
      .timeout(5000);
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.data.length > 0);
    assert.ok(res.body.data.length <= 50, 'default limit is 50');
    assert.ok(res.body.meta.total > 0);
  } finally {
    ctx.cleanup();
  }
});

test('persons: search filters by name', async () => {
  const ctx = setup();
  try {
    const all = ctx.db.prepare("SELECT first_name FROM persons WHERE station_id=1 LIMIT 1").get();
    const token = await getToken(ctx.app, 'station1_off');
    const res = await request(ctx.app)
      .get(`/api/persons?search=${all.first_name}`)
      .set('Authorization', `Bearer ${token}`)
      .timeout(5000);
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.data.length > 0, 'search should find at least 1 match');
    assert.strictEqual(res.body.meta.total, res.body.data.length, 'total should match rows');
  } finally {
    ctx.cleanup();
  }
});

test('persons: filter by person_type', async () => {
  const ctx = setup();
  try {
    const token = await getToken(ctx.app, 'station1_off');
    const res = await request(ctx.app)
      .get('/api/persons?person_type=dealer')
      .set('Authorization', `Bearer ${token}`)
      .timeout(5000);
    assert.strictEqual(res.status, 200);
    const types = [...new Set(res.body.data.map((p) => p.person_type))];
    assert.deepStrictEqual(types, ['dealer']);
  } finally {
    ctx.cleanup();
  }
});

test('persons: filter by status', async () => {
  const ctx = setup();
  try {
    const token = await getToken(ctx.app, 'station1_off');
    const res = await request(ctx.app)
      .get('/api/persons?status=completed')
      .set('Authorization', `Bearer ${token}`)
      .timeout(5000);
    assert.strictEqual(res.status, 200);
    const statuses = [...new Set(res.body.data.map((p) => p.status))];
    assert.deepStrictEqual(statuses, ['completed']);
  } finally {
    ctx.cleanup();
  }
});

test('persons: limit capped at maxLimit', async () => {
  const ctx = setup();
  try {
    const token = await getToken(ctx.app, 'station1_off');
    const res = await request(ctx.app)
      .get('/api/persons?limit=5000')
      .set('Authorization', `Bearer ${token}`)
      .timeout(5000);
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.data.length <= 200, 'should cap at 200');
  } finally {
    ctx.cleanup();
  }
});

test('persons: visits endpoint returns visit records for person', async () => {
  const ctx = setup();
  try {
    const token = await getToken(ctx.app, 'station1_off');
    const person = ctx.db.prepare('SELECT id FROM persons WHERE station_id=1 LIMIT 1').get();
    const res = await request(ctx.app)
      .get(`/api/persons/${person.id}/visits`)
      .set('Authorization', `Bearer ${token}`)
      .timeout(5000);
    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(res.body.data));
    if (res.body.data.length > 0) {
      assert.ok(res.body.data[0].visit_date);
    }
  } finally {
    ctx.cleanup();
  }
});

test('persons: urine-tests endpoint returns test records for person', async () => {
  const ctx = setup();
  try {
    const token = await getToken(ctx.app, 'station1_off');
    const person = ctx.db.prepare('SELECT id FROM persons WHERE station_id=1 LIMIT 1').get();
    const res = await request(ctx.app)
      .get(`/api/persons/${person.id}/urine-tests`)
      .set('Authorization', `Bearer ${token}`)
      .timeout(5000);
    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(res.body.data));
  } finally {
    ctx.cleanup();
  }
});