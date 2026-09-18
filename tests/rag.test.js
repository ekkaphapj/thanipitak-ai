const { test } = require('node:test');
const assert = require('node:assert/strict');
const rag = require('../src/ai/rag');

test('RAG answers product purpose without inventing registry facts', async () => {
  const out = await rag.answer('ธานีพิทักษ์คืออะไร');
  assert.deepEqual(out.sources, ['about']);
  assert.match(out.answer, /ผู้ช่วย AI ภายใน/);
  assert.match(out.answer, /ขอบเขตสิทธิ์/);
});

test('RAG does not invent the person who developed or added the system', async () => {
  const out = await rag.answer('ใครเป็นคนเพิ่มมา');
  assert.deepEqual(out.sources, ['about']);
  assert.match(out.answer, /ไม่มีข้อมูลที่ยืนยันชื่อ/);
  assert.doesNotMatch(out.answer, /สมชาย|ผู้พัฒนา คือ/);
});
