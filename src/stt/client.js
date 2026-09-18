'use strict';

const http = require('http');
const net = require('net');
const config = require('../config');

function isAllowedSttUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:') return false;
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) return false;
  const port = u.port || '80';
  if (port === '11434') return false;
  return true;
}

function effectiveEnabled() {
  return Boolean(config.stt.enabled && isAllowedSttUrl(config.stt.url));
}

function warnIfDisabled() {
  if (!config.stt.enabled) {
    console.warn('[stt] disabled by STT_ENABLED');
    return;
  }
  if (!isAllowedSttUrl(config.stt.url)) {
    console.warn('[stt] refuse non-loopback');
  }
}

warnIfDisabled();

function getJson(pathname, timeoutMs) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(pathname, config.stt.url);
    } catch {
      resolve(null);
      return;
    }
    const req = http.get(u, { timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
        if (data.length > 20000) req.destroy();
      });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, json: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, json: null, text: data.slice(0, 200) });
        }
      });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.on('error', () => resolve(null));
  });
}

function tcpOpen(timeoutMs) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(config.stt.url);
    } catch {
      resolve(false);
      return;
    }
    const port = Number(u.port || 80);
    const host = u.hostname.replace(/^\[|\]$/g, '');
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeoutMs);
    socket.on('connect', () => {
      clearTimeout(timer);
      socket.end();
      resolve(true);
    });
    socket.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

async function defaultCheck() {
  if (!effectiveEnabled()) return { available: false, engine: 'faster-whisper', language: config.stt.language };
  const health = await getJson('/health', 5000);
  if (health && health.status === 200 && health.json && health.json.ok) {
    return { available: true, engine: 'faster-whisper', language: config.stt.language };
  }
  const models = await getJson('/v1/models', 5000);
  if (models && models.status === 200) {
    return { available: true, engine: 'faster-whisper', language: config.stt.language };
  }
  const root = await getJson('/', 3000);
  if (root && root.status && root.status < 500) {
    return { available: true, engine: 'faster-whisper', language: config.stt.language };
  }
  const open = await tcpOpen(3000);
  return { available: open, engine: 'faster-whisper', language: config.stt.language };
}

function parseUpstreamError(status, body) {
  let json = null;
  try {
    json = JSON.parse(body);
  } catch {
    json = null;
  }
  const code = json && json.code;
  if (code === 'AUDIO_TOO_LONG' || status === 400 && /too long/i.test(body)) {
    return { status: 400, code: 'AUDIO_TOO_LONG', error: 'เสียงยาวเกิน 45 วินาที กรุณาพูดใหม่ให้สั้นลง' };
  }
  if (code === 'STT_BAD_AUDIO' || status === 400) {
    return { status: 400, code: 'STT_BAD_AUDIO', error: 'แปลงไฟล์เสียงไม่ได้ กรุณาพูดใหม่ หรือติดตั้ง ffmpeg' };
  }
  return { status: 503, code: 'STT_UNAVAILABLE', error: 'ระบบแปลงเสียงในเครื่องยังไม่พร้อม กรุณาพิมพ์คำถามได้ตามปกติ' };
}

async function defaultTranscribe(buffer, contentType) {
  if (!effectiveEnabled()) {
    const err = new Error('stt unavailable');
    err.http = { status: 503, code: 'STT_UNAVAILABLE', error: 'ระบบแปลงเสียงในเครื่องยังไม่พร้อม กรุณาพิมพ์คำถามได้ตามปกติ' };
    throw err;
  }
  const filename = /mp4/i.test(contentType || '') ? 'clip.mp4' : /wav/i.test(contentType || '') ? 'clip.wav' : 'clip.webm';
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: contentType || 'audio/webm' }), filename);
  form.append('language', config.stt.language || 'th');
  form.append('response_format', 'json');
  form.append('temperature', '0');
  const path = config.stt.api === 'whispercpp' ? '/inference' : '/v1/audio/transcriptions';
  let response;
  try {
    response = await fetch(new URL(path, config.stt.url), {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(config.stt.timeoutMs),
    });
  } catch (e) {
    const err = new Error('stt timeout');
    err.http = {
      status: 503,
      code: e && e.name === 'TimeoutError' ? 'STT_TIMEOUT' : 'STT_UNAVAILABLE',
      error: e && e.name === 'TimeoutError'
        ? 'แปลงเสียงใช้เวลานานเกินไป กรุณาพูดใหม่ให้สั้นลง หรือพิมพ์แทน'
        : 'ระบบแปลงเสียงในเครื่องยังไม่พร้อม กรุณาพิมพ์คำถามได้ตามปกติ',
    };
    throw err;
  }
  const text = await response.text();
  if (!response.ok) {
    const mapped = parseUpstreamError(response.status, text);
    const err = new Error(mapped.error);
    err.http = mapped;
    throw err;
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    const err = new Error('stt bad response');
    err.http = { status: 503, code: 'STT_UNAVAILABLE', error: 'ระบบแปลงเสียงในเครื่องยังไม่พร้อม กรุณาพิมพ์คำถามได้ตามปกติ' };
    throw err;
  }
  return {
    text: String(json.text || json.transcript || ''),
    quality: json && json.quality && typeof json.quality === 'object'
      ? { accepted: json.quality.accepted !== false }
      : undefined,
  };
}

function createSttClient(options = {}) {
  const check = options.sttCheck || defaultCheck;
  const transcribeImpl = options.sttTranscribe || defaultTranscribe;
  let busy = false;

  return {
    async status() {
      try {
        const result = await check();
        return {
          available: Boolean(result && result.available),
          engine: (result && result.engine) || 'faster-whisper',
          language: config.stt.language,
        };
      } catch {
        return { available: false, engine: 'faster-whisper', language: config.stt.language };
      }
    },
    async transcribe(buffer, contentType) {
      if (busy) {
        const err = new Error('busy');
        err.http = { status: 429, code: 'STT_BUSY', error: 'ระบบกำลังแปลงเสียงคำขออื่นอยู่ กรุณารอแล้วพูดใหม่' };
        throw err;
      }
      busy = true;
      try {
        return await transcribeImpl(buffer, contentType);
      } finally {
        busy = false;
      }
    },
  };
}

module.exports = { isAllowedSttUrl, createSttClient };
