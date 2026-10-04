'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { thaiNormalize, levenshtein, cer, percentile } = require('../src/stt/cer');
const { loadCorpus, summarize } = require('../src/stt/bakeoff');

test('thaiNormalize strips zero-width noise, unifies digits, drops spaces', () => {
  assert.equal(thaiNormalize('มี ผู้\u200bเสพ กี่คน'), 'มีผู้เสพกี่คน');
  assert.equal(thaiNormalize('ตำบล๒'), 'ตำบล2');
  assert.equal(thaiNormalize('๕๖'), '56');
  assert.equal(thaiNormalize('ABC def'), 'abcdef');
  assert.equal(thaiNormalize(null), '');
});

test('levenshtein handles empty and substitution cases', () => {
  assert.equal(levenshtein('', ''), 0);
  assert.equal(levenshtein('กข', ''), 2);
  assert.equal(levenshtein('กข', 'กข'), 0);
  assert.equal(levenshtein('กค', 'กข'), 1);
  assert.equal(levenshtein('kitten', 'sitting'), 3);
});

test('cer is 0 for identical text after normalization and scales by ref length', () => {
  assert.equal(cer('มีผู้เสพกี่คน', 'มี ผู้\u200bเสพกี่คน'), 0);
  assert.equal(cer('ทดสอบ', 'ทดสอก'), 0.2);
  assert.equal(cer('ทดสอบ', ''), 1);
  assert.equal(cer('', ''), 0);
});

test('percentile interpolates and summarizes bake-off results', () => {
  assert.equal(percentile([], 0.5), null);
  assert.equal(percentile([7], 0.95), 7);
  const s = summarize([
    { cer: 0.1, ms: 900 }, { cer: 0.3, ms: 1200 }, { cer: 0.2, ms: 1500 },
  ]);
  assert.equal(s.count, 3);
  assert.equal(s.cerMean, 0.2);
  assert.equal(s.accuracy, 0.8);
  assert.equal(s.msMedian, 1200);
  assert.equal(summarize([{ cer: Number.NaN }, null]).count, 0);
  assert.deepEqual(summarize([]), { count: 0 });
});

test('loadCorpus validates manifest shape, files and pins a frozen sha', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stt-corpus-'));
  try {
    assert.throws(() => loadCorpus(dir), /manifest/);
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ phrases: [] }));
    assert.throws(() => loadCorpus(dir), /phrases/);
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ phrases: [{ file: 'p01.webm' }] }));
    assert.throws(() => loadCorpus(dir), /file และ text/);
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ phrases: [
      { file: 'p01.webm', text: 'มีผู้เสพกี่คน' },
      { file: 'p01.webm', text: 'ซ้ำ' },
    ] }));
    assert.throws(() => loadCorpus(dir), /ซ้ำ/);
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ phrases: [{ file: 'gone.webm', text: 'ไม่มีไฟล์' }] }));
    assert.throws(() => loadCorpus(dir), /ไม่พบไฟล์เสียง/);

    const good = JSON.stringify({ phrases: [{ file: 'p01.webm', text: 'มีผู้เสพกี่คน' }] });
    fs.writeFileSync(path.join(dir, 'manifest.json'), good);
    fs.writeFileSync(path.join(dir, 'p01.webm'), Buffer.from([1, 2, 3]));
    const corpus = loadCorpus(dir);
    assert.equal(corpus.phrases.length, 1);
    assert.equal(corpus.phrases[0].text, 'มีผู้เสพกี่คน');
    assert.match(corpus.sha256, /^[0-9a-f]{64}$/);
    // Same manifest bytes → same pinned corpus identity.
    assert.equal(loadCorpus(dir).sha256, corpus.sha256);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
