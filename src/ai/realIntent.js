'use strict';

const { INTERPRETER_SYSTEM_PROMPT } = require('./domainCatalog');

const schema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: { type: 'string', enum: ['count', 'list', 'group', 'clarify'] },
    person_type: { type: 'string', enum: ['all', 'psychiatric', 'drug_user', 'dealer', 'released'] },
    group: { type: 'string', enum: ['none', 'ตำบล', 'อำเภอ', 'จังหวัด'] },
    direction: { type: 'string', enum: ['asc', 'desc'] },
    province: { type: 'string' },
    district: { type: 'string' },
    subdistrict: { type: 'string' },
    station: { type: 'string' },
    search: { type: 'string' },
  },
  required: ['action', 'person_type', 'group', 'direction'],
};

const PLACE_KEYS = ['province', 'district', 'subdistrict', 'station', 'search'];

function coercePlan(plan) {
  const out = { ...plan };
  if (!schema.properties.action.enum.includes(out.action)) out.action = 'clarify';
  if (!schema.properties.person_type.enum.includes(out.person_type)) out.person_type = 'all';
  if (!schema.properties.group.enum.includes(out.group)) {
    out.group = 'none';
    out.action = 'clarify';
  }
  if (!schema.properties.direction.enum.includes(out.direction)) out.direction = 'desc';
  if (out.action === 'group' && out.group === 'none') out.action = 'clarify';
  return out;
}

async function interpretRealIntent(message, { request = fetch } = {}) {
  const response = await request(new URL('/api/chat', process.env.OLLAMA_HOST || 'http://127.0.0.1:11434'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(60000),
    body: JSON.stringify({
      model: process.env.OLLAMA_MODEL || 'scb10x/llama3.1-typhoon2-8b-instruct:latest',
      stream: false,
      think: false,
      format: schema,
      options: { temperature: 0, num_predict: 260 },
      messages: [
        { role: 'system', content: INTERPRETER_SYSTEM_PROMPT },
        { role: 'user', content: message },
      ],
    }),
  });
  if (!response.ok) throw new Error('Local AI ไม่พร้อมช่วยแปลคำถาม กรุณาลองใหม่');
  const body = await response.json();
  let plan;
  try {
    plan = JSON.parse(body.message?.content);
  } catch {
    throw new Error('Local AI แปลคำถามไม่สำเร็จ กรุณาระบุประเภทบุคคลหรือพื้นที่เพิ่ม');
  }
  if (!plan || typeof plan !== 'object' || Object.keys(plan).some((key) => !schema.properties[key])) {
    throw new Error('Local AI ส่งเงื่อนไขที่ไม่รองรับ');
  }
  plan = coercePlan(plan);
  for (const key of schema.required) {
    if (!schema.properties[key].enum.includes(plan[key])) throw new Error('Local AI ส่งเงื่อนไขไม่ถูกต้อง');
  }
  for (const key of PLACE_KEYS) {
    if (plan[key] === undefined) continue;
    if (typeof plan[key] !== 'string' || plan[key].length > 100) throw new Error('เงื่อนไขพื้นที่ไม่ถูกต้อง');
    if (/select\s|insert\s|drop\s|;|--/i.test(plan[key])) throw new Error('เงื่อนไขพื้นที่ไม่ถูกต้อง');
  }
  return plan;
}

module.exports = { interpretRealIntent, schema, coercePlan };
