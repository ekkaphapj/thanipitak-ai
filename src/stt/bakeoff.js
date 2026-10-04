'use strict';

// Pure bake-off machinery for the frozen Thai STT corpus
// (docs/stt-client-first-design.md §6). The CLI wrapper lives in
// scripts/stt-bakeoff.js; everything testable without audio lives here.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { cer, percentile } = require('./cer');

const MANIFEST_NAME = 'manifest.json';

// manifest.json: { "phrases": [ { "file": "p01.webm", "text": "ขอรายชื่อ..." } ] }
// Audio files and the real manifest stay untracked (see the corpus README);
// only the schema travels in git via manifest.example.json.
function loadCorpus(dir) {
  const manifestPath = path.join(dir, MANIFEST_NAME);
  if (!fs.existsSync(manifestPath)) {
    const err = new Error('ไม่พบ manifest.json ในโฟลเดอร์คลังเสียง กรุณาอ่าน README ก่อนอัดเสียง');
    err.code = 'CORPUS_MISSING_MANIFEST';
    throw err;
  }
  const raw = fs.readFileSync(manifestPath);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const err = new Error('manifest.json อ่านไม่ได้ (JSON ไม่ถูกต้อง)');
    err.code = 'CORPUS_BAD_MANIFEST';
    throw err;
  }
  const phrases = parsed && Array.isArray(parsed.phrases) ? parsed.phrases : null;
  if (!phrases || !phrases.length) {
    const err = new Error('manifest.json ต้องมี phrases อย่างน้อย 1 รายการ');
    err.code = 'CORPUS_EMPTY';
    throw err;
  }
  const seen = new Set();
  for (const item of phrases) {
    if (!item || typeof item.file !== 'string' || !item.file.trim()
      || typeof item.text !== 'string' || !item.text.trim()) {
      const err = new Error('ทุกรายการต้องมี file และ text ที่ไม่ว่าง');
      err.code = 'CORPUS_BAD_ENTRY';
      throw err;
    }
    if (seen.has(item.file)) {
      const err = new Error('พบไฟล์ซ้ำใน manifest: ' + item.file);
      err.code = 'CORPUS_DUPLICATE_FILE';
      throw err;
    }
    seen.add(item.file);
  }
  for (const item of phrases) {
    if (!fs.existsSync(path.join(dir, item.file))) {
      const err = new Error('ไม่พบไฟล์เสียง: ' + item.file);
      err.code = 'CORPUS_MISSING_AUDIO';
      throw err;
    }
  }
  return {
    dir,
    phrases,
    // Pin the frozen corpus like the intent holdouts: record this SHA in
    // the bake-off report so numbers are attributable to one corpus state.
    sha256: crypto.createHash('sha256').update(raw).digest('hex'),
  };
}

function summarize(results) {
  const list = (results || []).filter((r) => r && Number.isFinite(r.cer));
  if (!list.length) return { count: 0 };
  const cers = list.map((r) => r.cer).sort((a, b) => a - b);
  const ms = list.map((r) => r.ms).filter(Number.isFinite).sort((a, b) => a - b);
  return {
    count: list.length,
    cerMean: round(list.reduce((s, r) => s + r.cer, 0) / list.length),
    cerP95: round(percentile(cers, 0.95)),
    // "Accuracy" here = 1 - CER, the comparable headline number.
    accuracy: round(1 - list.reduce((s, r) => s + r.cer, 0) / list.length),
    msMedian: ms.length ? Math.round(percentile(ms, 0.5)) : null,
    msP95: ms.length ? Math.round(percentile(ms, 0.95)) : null,
  };
}

function round(x) {
  return Math.round(x * 10000) / 10000;
}

module.exports = { loadCorpus, summarize };
