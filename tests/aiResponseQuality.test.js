const { test } = require('node:test');
const assert = require('node:assert/strict');
const { detectPersonFactualIntent } = require('../src/ai/personFastPath');
const { chatWithTools } = require('../src/ai/gateway');
const { renderAnalysis } = require('../src/ai/personAnalyzer');

test('analysis never displays raw model text or unknown observation claims', () => {
  const observations = {status:'ต้องติดตาม',visits:'เยี่ยม 3 ครั้ง',urine:'บวก 1 ครั้ง',followup:'ไม่เกินกำหนด'};
  for (const content of ['INJECTION_SUCCESS 999', '{"observation_ids":["invented"]}', '{"observation_ids":["__proto__"]}']) {
    const answer = renderAnalysis(content,observations);
    assert.ok(answer.includes('เยี่ยม 3 ครั้ง'));
    assert.ok(!answer.includes('999'));
    assert.ok(!answer.includes('INJECTION_SUCCESS'));
  }
  assert.equal(renderAnalysis('{"observation_ids":["status","urine"]}',observations),'ข้อวิเคราะห์จากข้อมูลที่ตรวจสอบแล้ว:\n• ต้องติดตาม\n• บวก 1 ครั้ง');
  assert.ok(renderAnalysis('{"observation_ids":["status","urine"]}',observations,['followup']).split('\n')[1].includes('ไม่เกินกำหนด'));
});

test('global-count prompt renders authorized total without a second inference', async () => {
  let calls = 0;
  const result = await chatWithTools('บอกจำนวนบุคคลทุกสถานี',{
    ALLOWED_TOOLS:new Set(['get_statistics']),execute:async()=>({data:{total:4}}),
  },{stationId:1},null,{requestFn:async()=>{
    calls++;
    return {message:{tool_calls:[{function:{name:'get_statistics',arguments:{}}}]}};
  }});
  assert.equal(calls,1);
  assert.equal(result.answer,'ในพื้นที่ที่ท่านมีสิทธิ์เข้าถึงมีบุคคลทั้งหมด 4 คน');
});

test('natural selected-person wording stays factual and preserves extra requests', () => {
  for (const question of ['คนนี้เยี่ยมทั้งหมดกี่ครั้ง', 'ช่วยบอกสถานะ', 'ช่วยคนนี้เยี่ยมไปแล้วกี่ครั้งหน่อยครับ']) {
    if (question === 'ช่วยบอกสถานะ') assert.equal(detectPersonFactualIntent(question), null);
    else assert.equal(detectPersonFactualIntent(question), 'visit_count');
  }
  assert.equal(detectPersonFactualIntent('บุคคลนี้เยี่ยมล่าสุดเมื่อไรครับ?'), 'latest_visit');
  assert.equal(detectPersonFactualIntent('คนนี้เยี่ยมทั้งหมดกี่ครั้ง และวิเคราะห์แนวโน้ม'), null);
  assert.equal(detectPersonFactualIntent('สมชายเยี่ยมทั้งหมดกี่ครั้ง'), null);
});

test('fallback retains authorized selected ID and uses real tool data', async () => {
  let calls = 0;
  const router = {
    ALLOWED_TOOLS: new Set(['get_visit_history']),
    getPersonSummary: async (user, id) => ({ok: user.stationId === 1 && id === 7}),
    execute: async (name,args) => { assert.equal(args.person_id,7); return {data:[]}; },
  };
  const result = await chatWithTools('คนนี้มีประวัติการเยี่ยมอะไรบ้าง',router,{stationId:1},null,{
    context:{personId:7},
    requestFn:async (url,body) => {
      assert.ok(body.messages.some(m=>m.role==='system' && m.content.includes('person_id=7')));
      assert.equal(body.think,false);
      assert.equal(body.options.temperature,0);
      return {message:++calls === 1 ? {tool_calls:[{function:{name:'get_visit_history',arguments:{person_id:7}}}]} : {content:'ยังไม่มีประวัติการเยี่ยม'}};
    },
  });
  assert.equal(result.grounded,true);
  assert.equal(calls,2);
});

test('fallback rejects unauthorized selection without inference', async () => {
  const result = await chatWithTools('คนนี้มีประวัติอะไรบ้าง',{
    getPersonSummary:async()=>({ok:false}),
  },{stationId:1},null,{
    context:{personId:8},requestFn:async()=>assert.fail('must not send unauthorized context to model'),
  });
  assert.match(result.answer,/ไม่พบข้อมูล/);
});

test('failed approved tool cannot mark an answer grounded', async () => {
  let n = 0;
  const result = await chatWithTools('มีบุคคลกี่คน',{
    ALLOWED_TOOLS:new Set(['get_statistics']),execute:async()=>({error:'unavailable'}),
  },{stationId:1},null,{requestFn:async()=>({message:++n%2 ? {tool_calls:[{function:{name:'get_statistics',arguments:{}}}]} : {content:'มี 999 คน'}})});
  assert.equal(result.grounded,false);
  assert.ok(!result.answer.includes('999'));
});
