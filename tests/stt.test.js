'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { setup } = require('./helpers');
const { createApp } = require('../src/app');
const { isAllowedSttUrl } = require('../src/stt/client');

async function login(app) {
  const res = await request(app).post('/api/auth/login').send({ username: 'station1_off', password: 'thanipitak123' });
  assert.equal(res.status, 200);
  return res.body.token;
}

function mockRealAuth() {
  return {
    url: 'https://example.test',
    key: 'anon',
    request: async (url) => ({
      ok: true,
      json: async () => {
        if (String(url).endsWith('/user')) return { id: 'uuid' };
        if (String(url).includes('/functions/v1/ai-access-scope')) return { scope: { level: 'station', read_only: true, user_id: 8, station_id: 2, province: 'อุดรธานี' } };
        if (String(url).includes('/stations?')) return [{ station_id: 2, station_name: 'สภ.ทดสอบ', division: 'ภ.จว.', province: 'อุดรธานี' }];
        return [{ user_id: 8, username: '4648', name: 'ตัวอย่าง', user_type: 'User', station_id: 2 }];
      },
    }),
  };
}

test('stt status requires auth', async () => {
  const ctx = setup();
  try {
    const res = await request(ctx.app).get('/api/stt/status');
    assert.equal(res.status, 401);
  } finally {
    ctx.cleanup();
  }
});

test('stt transcribe with test JWT calls injected helper and writes no audit row', async () => {
  const ctx = setup();
  try {
    const before = ctx.db.prepare('SELECT COUNT(*) AS c FROM ai_audit_logs').get().c;
    const { app } = createApp(ctx.db, {
      sttCheck: async () => ({ available: true, engine: 'faster-whisper' }),
      sttTranscribe: async () => ({ text: 'มีผู้เสพกี่คน' }),
    });
    const token = await login(app);
    const res = await request(app)
      .post('/api/stt/transcribe')
      .set('Authorization', `Bearer ${token}`)
      .set('Content-Type', 'audio/webm')
      .send(Buffer.from('fake-webm-bytes'));
    assert.equal(res.status, 200);
    assert.equal(res.body.transcript, 'มีผู้เสพกี่คน');
    assert.equal(res.body.language, 'th');
    assert.ok(!JSON.stringify(res.body).includes('8178'));
    const after = ctx.db.prepare('SELECT COUNT(*) AS c FROM ai_audit_logs').get().c;
    assert.equal(after, before);
  } finally {
    ctx.cleanup();
  }
});

test('stt does not return a low-confidence transcript and asks the officer to repeat', async () => {
  const ctx = setup();
  try {
    const { app } = createApp(ctx.db, {
      sttCheck: async () => ({ available: true }),
      sttTranscribe: async () => ({ text: 'คำที่ฟังไม่ชัด', quality: { accepted: false } }),
    });
    const token = await login(app);
    const res = await request(app)
      .post('/api/stt/transcribe')
      .set('Authorization', `Bearer ${token}`)
      .set('Content-Type', 'audio/webm')
      .send(Buffer.from('fake-webm-bytes'));
    assert.equal(res.status, 422);
    assert.equal(res.body.code, 'STT_LOW_CONFIDENCE');
    assert.match(res.body.error, /พูดใหม่อีกครั้ง/);
    assert.ok(!JSON.stringify(res.body).includes('คำที่ฟังไม่ชัด'));
  } finally {
    ctx.cleanup();
  }
});

test('stt transcribe without token still 401 for a large audio body', async () => {
  const ctx = setup();
  try {
    const { app } = createApp(ctx.db, {
      sttCheck: async () => ({ available: true }),
      sttTranscribe: async () => ({ text: 'x' }),
    });
    const res = await request(app)
      .post('/api/stt/transcribe')
      .set('Content-Type', 'audio/webm')
      .send(Buffer.alloc(1024 * 1024, 1))
      .timeout(5000);
    assert.equal(res.status, 401);
  } finally {
    ctx.cleanup();
  }
});

test('stt real-mode transcribe is 200 and does not 409', async () => {
  const ctx = setup();
  let called = false;
  try {
    const { app } = createApp(ctx.db, {
      realAuth: mockRealAuth(),
      sttCheck: async () => ({ available: true }),
      sttTranscribe: async () => {
        called = true;
        return { text: 'อยู่ตำบลอะไร' };
      },
    });
    const res = await request(app)
      .post('/api/stt/transcribe')
      .set('Authorization', 'Bearer real-token')
      .set('X-Data-Source', 'real')
      .set('Content-Type', 'audio/webm')
      .send(Buffer.from('clip'));
    assert.equal(res.status, 200);
    assert.equal(res.body.transcript, 'อยู่ตำบลอะไร');
    assert.equal(called, true);
  } finally {
    ctx.cleanup();
  }
});

test('stt overlapping transcribe returns STT_BUSY', async () => {
  const ctx = setup();
  try {
    let release;
    let started;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const startedP = new Promise((resolve) => {
      started = resolve;
    });
    const { app } = createApp(ctx.db, {
      sttCheck: async () => ({ available: true }),
      sttTranscribe: async () => {
        started();
        await gate;
        return { text: 'หนึ่ง' };
      },
    });
    const token = await login(app);
    const firstPromise = request(app)
      .post('/api/stt/transcribe')
      .set('Authorization', `Bearer ${token}`)
      .set('Content-Type', 'audio/webm')
      .send(Buffer.from('one'));
    firstPromise.catch(() => {});
    await startedP;
    const second = await request(app)
      .post('/api/stt/transcribe')
      .set('Authorization', `Bearer ${token}`)
      .set('Content-Type', 'audio/webm')
      .send(Buffer.from('two'));
    assert.equal(second.status, 429);
    assert.equal(second.body.code, 'STT_BUSY');
    release();
    const done = await firstPromise;
    assert.equal(done.status, 200);
  } finally {
    ctx.cleanup();
  }
});

test('stt loopback guard refuses cloud and ollama ports', () => {
  assert.equal(isAllowedSttUrl('https://api.openai.com'), false);
  assert.equal(isAllowedSttUrl('http://127.0.0.1:11434'), false);
  assert.equal(isAllowedSttUrl('http://8.8.8.8:8178'), false);
  assert.equal(isAllowedSttUrl('http://127.0.0.1:8178'), true);
  assert.equal(isAllowedSttUrl('http://localhost:8178'), true);
});

test('stt html includes hold-to-talk mic button', () => {
  const fs = require('fs');
  const html = fs.readFileSync(require('path').join(__dirname, '..', 'frontend', 'ai.html'), 'utf8');
  assert.match(html, /id="mic-btn"/);
  assert.match(html, /id="voice-assistant-btn"/);
  assert.match(html, /id="voice-command-status"/);
  assert.match(html, /id="voice-showcase-title"/);
  assert.match(html, /ผู้ช่วยเอไอธานีพิทักษ์/);
  assert.match(html, /voiceInput\.js/);
  const js = fs.readFileSync(require('path').join(__dirname, '..', 'frontend', 'ai.js'), 'utf8');
  assert.match(js, /pointerdown/);
  assert.match(js, /loadSttStatus/);
  assert.match(js, /รับคำสั่งแล้ว กำลังประมวลผล/);
  assert.match(js, /sendMessage\(autoSendMessage, \{ voice: true \}\)/);
  assert.match(js, /Voice mode is a turn-based interface/);
  assert.match(js, /if \(voiceTurn\) clearChatInput\(\)/);
  assert.match(js, /voice-acknowledge\.mp3/);
  assert.match(js, /voice-answer-question\.mp3/);
  assert.match(js, /voice-introduce\.mp3/);
  assert.match(js, /voice-finish-job\.mp3/);
  assert.match(js, /กำลังแปลงเสียงเป็นข้อความ/);
  assert.match(js, /พร้อมรับคำสั่งต่อไป/);
  assert.match(js, /openVoiceAssistant/);
  assert.match(js, /voice-result-reveal/);
  assert.match(js, /ต้องการให้สอนการใช้งานหรือไม่/);
  assert.match(js, /ทำยังไง(?:ต่อ)?/);
  assert.match(js, /TUTORIAL_STEPS/);
  assert.match(js, /speechSynthesis/);
  assert.match(js, /ขอภาพรวม สภ\./);
  assert.match(js, /เลือกคนที่ 1/);
  assert.match(js, /วิเคราะห์ภาระงาน/);
  const css = fs.readFileSync(require('path').join(__dirname, '..', 'frontend', 'ai-refresh.css'), 'utf8');
  assert.match(css, /thanipitak-ai-voice-sprite-v2\.png/);
  assert.match(css, /voice-mouth/);
  assert.match(css, /voice-command-status/);
  assert.match(css, /voice-mode-open \.input-row/);
  assert.match(css, /voice-showcase-title/);
  assert.match(css, /@keyframes voice-result-reveal/);
  for (const asset of ['thanipitak-ai-voice-sprite-v2.png', 'voice-hello.mp3', 'voice-greeting-2.mp3', 'voice-how-to-use.mp3', 'voice-acknowledge.mp3', 'voice-answer-question.mp3', 'voice-introduce.mp3', 'voice-not-clear.mp3', 'voice-not-understand-question.mp3', 'voice-finish-job.mp3']) {
    assert.equal(fs.existsSync(require('path').join(__dirname, '..', 'frontend', asset)), true, asset + ' is packaged');
  }
});
