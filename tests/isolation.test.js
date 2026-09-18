const { test } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { setup, USERS } = require('./helpers');
const config = require('../src/config');

async function getToken(app, username) {
  const res = await request(app)
    .post('/api/auth/login')
    .send({ username, password: USERS[username].password })
    .timeout(5000);
  return res.body.token;
}

test('isolation: officer sees only own station persons', async () => {
  const ctx = setup();
  try {
    const token = await getToken(ctx.app, 'station1_off');
    const res = await request(ctx.app)
      .get('/api/persons?limit=200')
      .set('Authorization', `Bearer ${token}`)
      .timeout(5000);
    assert.strictEqual(res.status, 200);
    const stations = [...new Set(res.body.data.map((p) => p.station_id))];
    assert.deepStrictEqual(stations, [1]);
    assert.strictEqual(res.body.data.length, 100);
  } finally {
    ctx.cleanup();
  }
});

test('isolation: station_id query param is ignored for officer', async () => {
  const ctx = setup();
  try {
    const token = await getToken(ctx.app, 'station1_off');
    const res = await request(ctx.app)
      .get('/api/persons?station_id=2&limit=200')
      .set('Authorization', `Bearer ${token}`)
      .timeout(5000);
    assert.strictEqual(res.status, 200);
    const stations = [...new Set(res.body.data.map((p) => p.station_id))];
    assert.deepStrictEqual(stations, [1]);
  } finally {
    ctx.cleanup();
  }
});

test('isolation: admin sees all stations', async () => {
  const ctx = setup();
  try {
    const token = await getToken(ctx.app, 'admin');
    const res = await request(ctx.app)
      .get('/api/persons?limit=200')
      .set('Authorization', `Bearer ${token}`)
      .timeout(5000);
    assert.strictEqual(res.status, 200);
    const stations = [...new Set(res.body.data.map((p) => p.station_id))].sort();
    assert.deepStrictEqual(stations, [1, 2, 3, 4, 5]);
  } finally {
    ctx.cleanup();
  }
});

test('isolation: cross-station person detail returns 404', async () => {
  const ctx = setup();
  try {
    const station2Person = ctx.db
      .prepare('SELECT id FROM persons WHERE station_id=2 ORDER BY id LIMIT 1')
      .get();
    const token = await getToken(ctx.app, 'station1_off');
    const res = await request(ctx.app)
      .get(`/api/persons/${station2Person.id}`)
      .set('Authorization', `Bearer ${token}`)
      .timeout(5000);
    assert.ok(res.status === 403 || res.status === 404, `Expected 403/404, got ${res.status}`);
  } finally {
    ctx.cleanup();
  }
});

test('isolation: cross-station visits returns 404', async () => {
  const ctx = setup();
  try {
    const station2Person = ctx.db
      .prepare('SELECT id FROM persons WHERE station_id=2 ORDER BY id LIMIT 1')
      .get();
    const token = await getToken(ctx.app, 'station1_off');
    const res = await request(ctx.app)
      .get(`/api/persons/${station2Person.id}/visits`)
      .set('Authorization', `Bearer ${token}`)
      .timeout(5000);
    assert.ok(res.status === 403 || res.status === 404, `Expected 403/404, got ${res.status}`);
  } finally {
    ctx.cleanup();
  }
});

test('isolation: cross-station urine-tests returns 404', async () => {
  const ctx = setup();
  try {
    const station2Person = ctx.db
      .prepare('SELECT id FROM persons WHERE station_id=2 ORDER BY id LIMIT 1')
      .get();
    const token = await getToken(ctx.app, 'station1_off');
    const res = await request(ctx.app)
      .get(`/api/persons/${station2Person.id}/urine-tests`)
      .set('Authorization', `Bearer ${token}`)
      .timeout(5000);
    assert.ok(res.status === 403 || res.status === 404, `Expected 403/404, got ${res.status}`);
  } finally {
    ctx.cleanup();
  }
});

test('isolation: viewer cannot see data beyond station', async () => {
  const ctx = setup();
  try {
    const token = await getToken(ctx.app, 'station1_view');
    const res = await request(ctx.app)
      .get('/api/persons?limit=200')
      .set('Authorization', `Bearer ${token}`)
      .timeout(5000);
    assert.strictEqual(res.status, 200);
    const stations = [...new Set(res.body.data.map((p) => p.station_id))];
    assert.deepStrictEqual(stations, [1]);
  } finally {
    ctx.cleanup();
  }
});

test('isolation: officer without station sees no persons, stats, or overdue rows', async () => {
  const ctx = setup();
  try {
    const token = jwt.sign(
      { id: 99, username: 'nostation_off', name: 'No Station', role: 'officer', stationId: null },
      config.jwtSecret,
      { expiresIn: '1h' }
    );
    const persons = await request(ctx.app)
      .get('/api/persons?limit=200')
      .set('Authorization', `Bearer ${token}`)
      .timeout(5000);
    assert.strictEqual(persons.status, 200);
    assert.deepStrictEqual(persons.body.data, []);
    assert.strictEqual(persons.body.meta.total, 0);

    const stats = await request(ctx.app)
      .get('/api/statistics')
      .set('Authorization', `Bearer ${token}`)
      .timeout(5000);
    assert.strictEqual(stats.status, 200);
    assert.strictEqual(stats.body.data.total, 0);
    assert.strictEqual(stats.body.data.followupOverdue, 0);
    assert.strictEqual(stats.body.data.psychiatric, 0);

    const overdue = await request(ctx.app)
      .get('/api/followups/overdue?limit=200')
      .set('Authorization', `Bearer ${token}`)
      .timeout(5000);
    assert.strictEqual(overdue.status, 200);
    assert.deepStrictEqual(overdue.body.data, []);
    assert.strictEqual(overdue.body.meta.total, 0);
  } finally {
    ctx.cleanup();
  }
});