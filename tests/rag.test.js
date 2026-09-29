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
  assert.match(rag.DOCS.find((doc) => doc.id === 'core-workflows').text, /ตรวจเยี่ยม/);
  assert.match(rag.DOCS.find((doc) => doc.id === 'guardian-workflow').text, /ผู้ดูแลผู้ป่วย/);
  assert.match(rag.DOCS.find((doc) => doc.id === 'data-boundary').text, /SQL/);
  const guide = rag.DOCS.find((doc) => doc.id === 'guide-01-ai-operational-guide');
  assert.ok(guide, 'sanitized operational guide is loaded from knowledge/');
  assert.match(guide.text, /เปลี่ยนจังหวัด/);
  assert.doesNotMatch(guide.text, /eyJ[a-zA-Z0-9_-]{20,}/);
});

test('RAG gives deterministic practical help and keeps registry facts behind authorized routes', async () => {
  const help = await rag.answer('ถามอะไรได้บ้าง ใช้ยังไง');
  assert.deepEqual(help.sources, ['usage', 'question-patterns', 'unknown-question']);
  assert.match(help.answer, /ภาพรวมผู้เสพตำบลโพนสูง/);

  const concept = await rag.answer('ผู้เสพหมายถึงอะไรในระบบ');
  assert.deepEqual(concept.sources, ['target-groups', 'types', 'scope']);
  assert.match(concept.answer, /ตรวจจากทะเบียนตามสิทธิ์/);
  assert.doesNotMatch(concept.answer, /SELECT|FROM people/i);
});

test('document embeddings are cached; later questions embed only the query', async () => {
  const { retrieve, DOCS } = rag;
  const calls = [];
  const vec = (seed) => Array.from({ length: 8 }, (_, i) => ((seed + i + 1) % 7) / 7 || 0.1);
  const request = async (path, body) => {
    calls.push({ path, input: body.input, keepAlive: body.keep_alive });
    if (path === '/api/embed') return { embeddings: (Array.isArray(body.input) ? body.input : [body.input]).map((_, i) => vec(i)) };
    throw new Error('unexpected chat call');
  };
  await retrieve('คำถามแรกเกี่ยวกับธานีพิทักษ์', request);
  let embeds = calls.filter(c => c.path === '/api/embed');
  assert.equal(embeds.length, 2); // catalogue once, then the query
  assert.equal(embeds[0].input.length, DOCS.length);
  assert.equal(embeds[1].input.length, 1);
  // Models stay resident between questions instead of reloading into VRAM.
  assert.equal(embeds.every(c => c.keepAlive === (process.env.OLLAMA_KEEP_ALIVE || '30m')), true);
  await retrieve('คำถามที่สอง', request);
  embeds = calls.filter(c => c.path === '/api/embed');
  assert.equal(embeds.length, 3); // the catalogue was NOT re-embedded
  assert.equal(embeds[2].input.length, 1);
});
