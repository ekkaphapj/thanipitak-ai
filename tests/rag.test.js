const { test } = require('node:test');
const assert = require('node:assert/strict');
const rag = require('../src/ai/rag');

test('RAG answers product purpose without inventing registry facts', async () => {
  const out = await rag.answer('ธานีพิทักษ์คืออะไร');
  assert.deepEqual(out.sources, ['about', 'coverage']);
  assert.match(out.answer, /ระบบจัดการบุคคลเป้าหมายอัจฉริยะ/);
  assert.match(out.answer, /ภ\.จว\.อุดรธานี/);
});

test('RAG identifies only the source-controlled project maintainer', async () => {
  const out = await rag.answer('ใครเป็นคนเพิ่มมา');
  assert.deepEqual(out.sources, ['developer']);
  assert.match(out.answer, /พ\.ต\.ท\.ดร\.เอกภาพ จุลโนนยาง/);
  assert.match(out.answer, /สว\.อก\.สภ\.บ้านดุง/);
  assert.doesNotMatch(out.answer, /สมชาย/);
});

test('RAG catalog covers pilot geography, workflows, and local voice privacy', () => {
  assert.match(rag.DOCS.find((doc) => doc.id === 'target-groups').text, /5 กลุ่ม/);
  assert.match(rag.DOCS.find((doc) => doc.id === 'coverage').text, /ร้อยเอ็ด/);
  assert.match(rag.DOCS.find((doc) => doc.id === 'usage').text, /PDF หรือ Excel/);
  assert.match(rag.DOCS.find((doc) => doc.id === 'voice').text, /ไม่ส่งเสียงไปยัง Ollama/);
  assert.match(rag.DOCS.find((doc) => doc.id === 'integration').text, /Shield\+/);
});
