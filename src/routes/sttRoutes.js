'use strict';

const express = require('express');
const config = require('../config');
const { createSttClient } = require('../stt/client');
const { correctTranscript } = require('../stt/correctTranscript');

const MAX_MESSAGE_LENGTH = 2000;
const AUDIO_TYPE = /^audio\/(webm|mp4|mpeg|wav|ogg|x-wav|wave)(;.*)?$/i;

// Second whitelist at the route: even an injected/custom client can only
// ever emit round numbers and short labels here.
function responseTiming(t) {
  if (!t || typeof t !== 'object') return undefined;
  const out = {};
  for (const key of ['audio_ms', 'ffmpeg_ms', 'decode_ms']) {
    if (Number.isFinite(t[key])) out[key] = Math.round(t[key]);
  }
  for (const key of ['device', 'compute']) {
    if (typeof t[key] === 'string' && t[key].length > 0 && t[key].length <= 40) out[key] = t[key];
  }
  return Object.keys(out).length ? out : undefined;
}

function createSttRoutes(options = {}) {
  const client = createSttClient(options);
  const router = express.Router();

  router.get('/status', async (req, res) => {
    const status = await client.status();
    return res.json({
      available: status.available,
      engine: status.engine,
      language: status.language || config.stt.language,
    });
  });

  async function transcribe(req, res) {
    const type = req.headers['content-type'] || '';
    if (type && !AUDIO_TYPE.test(type)) {
      return res.status(415).json({ error: 'ชนิดไฟล์เสียงนี้ยังไม่รองรับ', code: 'UNSUPPORTED_AUDIO' });
    }
    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      return res.status(400).json({ error: 'กรุณาส่งไฟล์เสียง', code: 'MISSING_AUDIO' });
    }
    if (body.length > config.stt.maxBytes) {
      return res.status(413).json({ error: 'ไฟล์เสียงใหญ่เกินกำหนด กรุณาพูดใหม่ให้สั้นลง', code: 'AUDIO_TOO_LARGE' });
    }
    const startedAt = Date.now();
    try {
      const result = await client.transcribe(body, type);
      const transcript = correctTranscript(String(result && result.text ? result.text : '')).slice(0, MAX_MESSAGE_LENGTH);
      // Numbers-only latency line for field diagnosis; transcript text never
      // enters the log.
      if (result && result.timing) {
        console.log('[stt] ok bytes=' + body.length
          + ' total_ms=' + (Date.now() - startedAt)
          + ' decode_ms=' + (Number.isFinite(result.timing.decode_ms) ? result.timing.decode_ms : '?')
          + ' ffmpeg_ms=' + (Number.isFinite(result.timing.ffmpeg_ms) ? result.timing.ffmpeg_ms : '?')
          + ' device=' + (result.timing.device || '?'));
      }
      const timing = responseTiming(result && result.timing);
      if (!transcript) {
        return res.json({ transcript: '', language: config.stt.language, code: 'EMPTY_TRANSCRIPT', timing });
      }
      if (result && result.quality && result.quality.accepted === false) {
        return res.status(422).json({
          error: 'ฟังเสียงไม่ชัดพอ กรุณาพูดใหม่อีกครั้งให้ชัดและใกล้ไมโครโฟน',
          code: 'STT_LOW_CONFIDENCE',
        });
      }
      return res.json({ transcript, language: config.stt.language, timing });
    } catch (err) {
      const http = err && err.http;
      if (http && http.status) {
        console.error('[stt] transcribe failed code=' + http.code + ' bytes=' + body.length);
        return res.status(http.status).json({ error: http.error, code: http.code });
      }
      console.error('[stt] transcribe failed code=STT_UNAVAILABLE bytes=' + body.length);
      return res.status(503).json({
        error: 'ระบบแปลงเสียงในเครื่องยังไม่พร้อม กรุณาพิมพ์คำถามได้ตามปกติ',
        code: 'STT_UNAVAILABLE',
      });
    }
  }

  return { router, transcribe };
}

module.exports = { createSttRoutes };
