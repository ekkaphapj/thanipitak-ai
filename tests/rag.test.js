const { test } = require('node:test');
const assert = require('node:assert/strict');
const rag = require('../src/ai/rag');

test('RAG answers product purpose without inventing registry facts', async () => {
  const out = await rag.answer('ธานีพิทักษ์คืออะไร');
  assert.deepEqual(out.sources, ['about', 'coverage']);
  assert.match(out.answer, /ผู้ช่วย AI ภายใน/);
  assert.match(out.answer, /ขอบเขตสิทธิ์/);
});

test('RAG identifies only the source-controlled project maintainer', async () => {
  const out = await rag.answer('ใครเป็นคนเพิ่มมา');
  assert.deepEqual(out.sources, ['developer']);
  assert.match(out.answer, /Ekkaphap/);
  assert.match(out.answer, /ไม่มีข้อมูลตำแหน่งงาน/);
  assert.doesNotMatch(out.answer, /สมชาย/);
});

test('RAG catalog covers pilot geography, workflows, and local voice privacy', () => {
  assert.match(rag.DOCS.find((doc) => doc.id === 'coverage').text, /อุดรธานี/);
  assert.match(rag.DOCS.find((doc) => doc.id === 'usage').text, /PDF หรือ Excel/);
  assert.match(rag.DOCS.find((doc) => doc.id === 'voice').text, /ไม่ส่งเสียงไปยัง Ollama/);
});
