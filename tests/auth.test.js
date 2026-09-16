const { test } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { setup, USERS } = require('./helpers');

test('authentication: login success returns token and user profile', async () => {
  const ctx = setup();
  try {
    const res = await request(ctx.app)
      .post('/api/auth/login')
      .send({ username: USERS.station1_off.username, password: USERS.station1_off.password })
      .timeout(5000);
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.token, 'token should be present');
    assert.strictEqual(res.body.user.username, 'station1_off');
    assert.strictEqual(res.body.user.role, 'officer');
    assert.strictEqual(res.body.user.stationId, 1);
  } finally {
    ctx.cleanup();
  }
});

test('authentication: login with wrong password fails', async () => {
  const ctx = setup();
  try {
    const res = await request(ctx.app)
      .post('/api/auth/login')
      .send({ username: 'station1_off', password: 'wrong-password' })
      .timeout(5000);
    assert.strictEqual(res.status, 401);
  } finally {
    ctx.cleanup();
  }
});

test('authentication: admin can login and has no station scope', async () => {
  const ctx = setup();
  try {
    const res = await request(ctx.app)
      .post('/api/auth/login')
      .send({ username: USERS.admin.username, password: USERS.admin.password })
      .timeout(5000);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.user.role, 'admin');
    assert.strictEqual(res.body.user.stationId, null);
  } finally {
    ctx.cleanup();
  }
});

test('authentication: missing credentials returns 400', async () => {
  const ctx = setup();
  try {
    const res = await request(ctx.app).post('/api/auth/login').send({}).timeout(5000);
    assert.strictEqual(res.status, 400);
  } finally {
    ctx.cleanup();
  }
});

test('authentication: protected route without token returns 401', async () => {
  const ctx = setup();
  try {
    const res = await request(ctx.app).get('/api/persons').timeout(5000);
    assert.strictEqual(res.status, 401);
  } finally {
    ctx.cleanup();
  }
});

test('authentication: /api/auth/me returns current user', async () => {
  const ctx = setup();
  try {
    const login = await request(ctx.app)
      .post('/api/auth/login')
      .send({ username: USERS.station1_off.username, password: USERS.station1_off.password })
      .timeout(5000);
    const res = await request(ctx.app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${login.body.token}`)
      .timeout(5000);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.user.username, 'station1_off');
  } finally {
    ctx.cleanup();
  }
});