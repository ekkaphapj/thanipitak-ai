'use strict';

// Character-level error metrics for Thai ASR bake-offs. Thai is written
// without inter-word spaces, so word-level WER is not meaningful; CER over
// lightly normalized text is the standard referee. Pure functions only —
// no audio, no network, no transcripts at rest.

const THAI_DIGITS = '๐๑๒๓๔๕๖๗๘๙';

function thaiNormalize(text) {
  let s = String(text || '');
  // Zero-width joiners and BOM-like noise appear in transcripts and prompts.
  s = s.replace(/[\u200b\u200c\u200d\ufeff]/g, '');
  s = s.replace(/[๐-๙]/g, (d) => String(THAI_DIGITS.indexOf(d)));
  s = s.toLowerCase();
  // Spaces in Thai are orthographic noise for CER purposes.
  s = s.replace(/\s+/g, '');
  return s;
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = new Array(b.length + 1);
  let cur = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    const swap = prev; prev = cur; cur = swap;
  }
  return prev[b.length];
}

// Character error rate in [0,1]; 0 = identical after normalization.
function cer(reference, hypothesis) {
  const ref = thaiNormalize(reference);
  const hyp = thaiNormalize(hypothesis);
  if (!ref.length && !hyp.length) return 0;
  if (!ref.length) return 1;
  return levenshtein(ref, hyp) / ref.length;
}

function percentile(sortedValues, p) {
  if (!sortedValues.length) return null;
  if (sortedValues.length === 1) return sortedValues[0];
  const idx = (sortedValues.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedValues[lo];
  return sortedValues[lo] + (sortedValues[hi] - sortedValues[lo]) * (idx - lo);
}

module.exports = { thaiNormalize, levenshtein, cer, percentile };
