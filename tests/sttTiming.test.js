'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { setup } = require('./helpers');
const { createApp } = require('../src/app');
const { pickTiming } = require('../src/stt/client');

async function login(app) {
  const res = await request(app).post('/api/auth/login').send({ username: 'station1_off', password: 'thanipitak123' });
  assert.equal(res.status, 200);
  return res.body.token;
}

test('pickTiming copies only whitelisted numeric/label fields from upstream', () => {
  const timing = pickTiming({
    timing: {
      audio_ms: 4200.4, ffmpeg_ms: 61.9, decode_ms: 2380.1,
      device: 'cuda', compute: 'int8_float16', beam: 5,
      text: 'คำถ้อยคำที่ห้ามหลุด', transcript: 'คำถ้อยคำ', nested: { deep: 'x' },
    },
  });
  assert.deepEqual(timing, { audio_ms: 4200, ffmpeg_ms: 62, decode_ms: 2380, device: 'cuda', compute: 'int8_float16' });
  assert.ok(!JSON.stringify(timing).includes('คำถ้อยคำ'));
});

test('pickTiming tolerates junk and absent timing', () => {
  assert.equal(pickTiming({}), undefined);
  assert.equal(pickTiming({ timing: 'fast' }), undefined);
  assert.equal(pickTiming({ timing: { text: 'x' } }), undefined);
  assert.deepEqual(pickTiming({ timing: { decode_ms: 5, device: 42 } }), { decode_ms: 5 });
  assert.equal(pickTiming({ timing: { device: 'x'.repeat(41) } }), undefined);
});

test('transcribe response carries the numbers-only timing block', async () => {
  const ctx = setup();
  try {
    const { app } = createApp(ctx.db, {
      sttCheck: async () => ({ available: true }),
      sttTranscribe: async () => ({
        text: 'มีผู้เสพกี่คน',
        quality: { accepted: true },
        timing: { audio_ms: 3100.2, ffmpeg_ms: 55.7, decode_ms: 1940.6, device: 'cpu', compute: 'int8', beam: 8 },
      }),
    });
    const token = await login(app);
    const res = await request(app)
      .post('/api/stt/transcribe')
      .set('Authorization', `Bearer ${token}`)
      .set('Content-Type', 'audio/webm')
      .send(Buffer.from('fake-webm-bytes'));
    assert.equal(res.status, 200);
    assert.equal(res.body.timing.audio_ms, 3100);
    assert.equal(res.body.timing.ffmpeg_ms, 56);
    assert.equal(res.body.timing.decode_ms, 1941);
    assert.equal(res.body.timing.device, 'cpu');
  } finally {
    ctx.cleanup();
  }
});

test('empty transcript still reports timing for field-latency diagnosis', async () => {
  const ctx = setup();
  try {
    const { app } = createApp(ctx.db, {
      sttCheck: async () => ({ available: true }),
      sttTranscribe: async () => ({ text: '', timing: { audio_ms: 2000, ffmpeg_ms: 40, decode_ms: 900, device: 'cuda' } }),
    });
    const token = await login(app);
    const res = await request(app)
      .post('/api/stt/transcribe')
      .set('Authorization', `Bearer ${token}`)
      .set('Content-Type', 'audio/webm')
      .send(Buffer.from('fake-webm-bytes'));
    assert.equal(res.status, 200);
    assert.equal(res.body.code, 'EMPTY_TRANSCRIPT');
    assert.equal(res.body.timing.decode_ms, 900);
  } finally {
    ctx.cleanup();
  }
});
