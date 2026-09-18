'use strict';

const express = require('express');
const config = require('../config');
const { createSttClient } = require('../stt/client');
const { correctTranscript } = require('../stt/correctTranscript');

const MAX_MESSAGE_LENGTH = 2000;
const AUDIO_TYPE = /^audio\/(webm|mp4|mpeg|wav|ogg|x-wav|wave)(;.*)?$/i;

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
    try {
      const result = await client.transcribe(body, type);
      const transcript = correctTranscript(String(result && result.text ? result.text : '')).slice(0, MAX_MESSAGE_LENGTH);
      if (!transcript) {
        return res.json({ transcript: '', language: config.stt.language, code: 'EMPTY_TRANSCRIPT' });
      }
      return res.json({ transcript, language: config.stt.language });
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
