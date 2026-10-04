#!/usr/bin/env node
'use strict';

// Frozen-corpus STT bake-off runner (docs/stt-client-first-design.md §6).
// Sends each corpus clip straight to a loopback faster-whisper server
// (never the app, never Supabase, no credentials), computes character
// error rate against the manifest text, and prints a JSON report.
//
// Raw engine output only: correctTranscript repairs are deliberately NOT
// applied, because the bake-off ranks engines/models, not post-processing.
//
// Usage:
//   node scripts/stt-bakeoff.js --corpus tests/fixtures/stt-corpus --runs 3
//   STT_BAKEOFF_URL=http://127.0.0.1:8179 node scripts/stt-bakeoff.js ...

const fs = require('fs');
const path = require('path');
const { loadCorpus, summarize } = require('../src/stt/bakeoff');
const { cer } = require('../src/stt/cer');

function argValue(name, fallback) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--' + name);
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
  return fallback;
}

function die(msg) {
  console.error(msg);
  process.exit(1);
}

function isLoopback(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:') return false;
    return ['127.0.0.1', 'localhost', '::1'].includes(u.hostname.replace(/^\[|\]$/g, ''));
  } catch {
    return false;
  }
}

async function main() {
  const url = argValue('url', process.env.STT_BAKEOFF_URL || 'http://127.0.0.1:8178');
  const corpusDir = path.resolve(argValue('corpus', path.join(__dirname, '..', 'tests', 'fixtures', 'stt-corpus')));
  const runs = Math.max(1, Math.min(10, parseInt(argValue('runs', '3'), 10) || 3));
  const label = argValue('label', 'engine');

  if (!isLoopback(url)) die('ปฏิเสธ URL ที่ไม่ใช่ loopback — คลิปเสียงห้ามส่งออกนอกเครื่อง (ใช้ --url http://127.0.0.1:PORT)');
  if (!fs.existsSync(corpusDir)) die('ไม่พบโฟลเดอร์คลังเสียง: ' + corpusDir);

  const corpus = loadCorpus(corpusDir);

  const runResults = [];
  for (let run = 1; run <= runs; run++) {
    const per = [];
    for (const phrase of corpus.phrases) {
      const bytes = fs.readFileSync(path.join(corpus.dir, phrase.file));
      const form = new FormData();
      const type = /\.wav$/i.test(phrase.file) ? 'audio/wav' : /\.mp4$/i.test(phrase.file) ? 'audio/mp4' : 'audio/webm';
      form.append('file', new Blob([bytes], { type }), phrase.file);
      form.append('language', 'th');
      form.append('response_format', 'json');
      form.append('temperature', '0');
      const t0 = Date.now();
      const res = await fetch(new URL('/v1/audio/transcriptions', url), {
        method: 'POST', body: form, signal: AbortSignal.timeout(120000),
      });
      const totalMs = Date.now() - t0;
      if (!res.ok) die('STT ตอบ ' + res.status + ' ที่ไฟล์ ' + phrase.file + ' — ยกเลิก bake-off');
      const json = await res.json();
      const text = String(json && json.text ? json.text : '');
      const decodeMs = json && json.timing && Number.isFinite(json.timing.decode_ms) ? json.timing.decode_ms : totalMs;
      per.push({ file: phrase.file, cer: cer(phrase.text, text), ms: decodeMs });
      process.stderr.write(`run ${run}/${runs} ${phrase.file} cer=${per[per.length - 1].cer.toFixed(3)} ${decodeMs}ms\n`);
    }
    runResults.push({ run, summary: summarize(per), per });
  }

  const report = {
    label,
    url,
    corpus: { dir: corpusDir, files: corpus.phrases.length, sha256: corpus.sha256 },
    generatedAt: new Date().toISOString(),
    runs: runResults.map((r) => ({ run: r.run, ...r.summary })),
    worstPhrases: worst(corpus, runResults),
  };
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}

function worst(corpus, runResults) {
  // Mean CER per file across runs, worst five, to guide prompt/repair work.
  const acc = new Map();
  for (const r of runResults) for (const p of r.per) {
    if (!acc.has(p.file)) acc.set(p.file, { file: p.file, sum: 0, n: 0 });
    const a = acc.get(p.file); a.sum += p.cer; a.n += 1;
  }
  return [...acc.values()]
    .map((a) => ({ file: a.file, cerMean: Math.round((a.sum / a.n) * 10000) / 10000 }))
    .sort((x, y) => y.cerMean - x.cerMean)
    .slice(0, 5);
}

main().catch((e) => die(e && e.message ? e.message : String(e)));
