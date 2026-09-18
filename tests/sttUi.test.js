'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const VoiceInput = require('../frontend/voiceInput.js');

test('applyTranscript appends, replaces empty, and caps at 2000', () => {
  assert.equal(VoiceInput.applyTranscript('', 'มีผู้เสพกี่คน'), 'มีผู้เสพกี่คน');
  assert.equal(VoiceInput.applyTranscript('สวัสดี', 'มีผู้เสพกี่คน'), 'สวัสดี มีผู้เสพกี่คน');
  assert.equal(VoiceInput.applyTranscript('keep', '  '), 'keep');
  const long = 'ก'.repeat(1990);
  const next = VoiceInput.applyTranscript(long, 'ข'.repeat(50));
  assert.equal(next.length, 2000);
});

test('micErrorMessage distinguishes size, duration, busy, and unavailable', () => {
  assert.match(VoiceInput.micErrorMessage('AUDIO_TOO_LARGE'), /ใหญ่เกินกำหนด/);
  assert.match(VoiceInput.micErrorMessage('AUDIO_TOO_LONG'), /45 วินาที/);
  assert.match(VoiceInput.micErrorMessage('STT_BUSY'), /คำขออื่น/);
  assert.match(VoiceInput.micErrorMessage('STT_UNAVAILABLE'), /ยังไม่พร้อม/);
  assert.match(VoiceInput.micErrorMessage('STT_LOW_CONFIDENCE'), /พูดใหม่อีกครั้ง/);
  assert.equal(VoiceInput.micErrorMessage(null, 401), 'กรุณาเข้าสู่ระบบใหม่');
});

test('list UI supports numbered ordinal follow-ups and safe empty-list feedback', () => {
  const fs = require('fs');
  const path = require('path');
  const aiJs = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'ai.js'), 'utf8');
  assert.match(aiJs, /ขอข้อมูลเพิ่มเติมของลำดับที่/);
  assert.match(aiJs, /ไม่มีรายการให้เลือก/);
  assert.match(aiJs, /renderLocationSummary/);
  assert.match(aiJs, /reference-list-bar/);
  assert.match(aiJs, /กำลังอ้างอิง/);
});
