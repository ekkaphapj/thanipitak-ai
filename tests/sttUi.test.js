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
  assert.equal(VoiceInput.micErrorMessage(null, 401), 'กรุณาเข้าสู่ระบบใหม่');
});
