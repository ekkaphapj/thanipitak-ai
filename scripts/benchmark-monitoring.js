'use strict';
// Opt-in real Ollama integration, isolated synthetic DB, no production access.
process.env.OLLAMA_HOST='http://127.0.0.1:11434';process.env.OLLAMA_MODEL='qwen3.5:9b';
const fs=require('fs');const path=require('path');const assert=require('node:assert/strict');const request=require('supertest');
const {createConnection}=require('../src/db/connection');
const {seedRealisticDatabase}=require('../src/db/realisticSeed');
const {createApp}=require('../src/app');const {createToolRouter}=require('../src/ai/toolRouter');
const {chatWithToolsWithFastPath}=require('../src/ai/gateway');
async function main(){
  const db=createConnection(':memory:');const seeded=seedRealisticDatabase(db);
  const router=createToolRouter(db);let calls=[],forceQwen=false;
  const transport=async(url,body)=>{
    const t=Date.now();const call={model:body.model};calls.push(call);
    const res=await fetch(process.env.OLLAMA_HOST+url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(120000)});
    if(!res.ok)throw new Error(`Ollama ${res.status}`);const out=await res.json();
    Object.assign(call,{wallMs:Date.now()-t,evalCount:out.eval_count,toolCalls:out.message?.tool_calls,doneReason:out.done_reason});return out;
  };
  const gateway={chatWithTools:(message,user,audit,options)=>chatWithToolsWithFastPath(message,router,user,audit,{...options,requestFn:transport,forceQwen})};
  const {app}=createApp(db,{gateway});
  const login=await request(app).post('/api/auth/login').send({username:'station1_off',password:'thanipitak123'});
  assert.equal(login.status,200);const auth='Bearer '+login.body.token;
  const cases=[
    {q:'ใครบ้างที่ต้องเฝ้าระวัง พร้อมเหตุผล',total:9},
    {q:'ผู้ป่วยจิตเวชเสี่ยงสูงมีใครบ้าง เพราะอะไร',total:3},
    {q:'ขอดูผู้เสพที่ควรจับตาหน่อยครับ',total:1},
    {q:'ผู้ค้ารายไหนต้องเฝ้าระวัง',total:1},
    {q:'ผู้พ้นโทษความเสี่ยงสูงมีใครบ้าง',total:1},
    {q:'สรุปจำนวนคนกลุ่มเสี่ยงแยกตามประเภท',total:9},
    {q:'ทำไมทดสอบ1 สถานี1ถึงเสี่ยงสูง',total:1},
    {q:'คนนี้เสี่ยงสูงเพราะอะไร',context:{personId:3},total:1},
    {q:'คนนี้เสี่ยงสูงไหม',context:{personId:2},total:1},
    {q:'คนนี้ควรเฝ้าระวังเพราะอะไร',context:{personId:17},blocked:true},
    {q:'ขอรายชื่อผู้เสพเสี่ยงสูง',total:0},
    {q:'ขอรายชื่อจิตเวชและผู้พ้นโทษที่ต้องเฝ้าระวัง',total:7},
    {q:'ขอรายชื่อบุคคลเฝ้าระวังหรือเสี่ยงสูงพร้อมเหตุผล',force:true,total:9},
    {q:'ขอรายชื่อผู้ป่วยจิตเวชเสี่ยงสูงพร้อมเหตุผลจากข้อมูล',force:true,total:3},
    {q:'คนนี้เสี่ยงสูงเพราะอะไร',context:{personId:1},force:true,total:1},
  ];
  const results={startedAt:new Date().toISOString(),model:'qwen3.5:9b',asOf:seeded.asOf,fixture:{people:80,station1:16,watchOrHigh:9,highPsychiatric:3},runs:[]};
  const output=path.join(__dirname,'..','docs','monitoring-real-results.json');fs.mkdirSync(path.dirname(output),{recursive:true});
  for(const c of cases){
    calls=[];forceQwen=!!c.force;console.log(`START ${c.force?'MODEL':'FAST'} ${c.q}`);const start=Date.now();
    const entry={...c};
    try{
      const res=await request(app).post('/api/ai/chat').set('Authorization',auth).send({message:c.q,...(c.context?{context:c.context}:{})});
      Object.assign(entry,{status:res.status,wallMs:Date.now()-start,calls,answer:res.body.answer,presentation:res.body.presentation});
      assert.equal(res.status,200);
      if(c.blocked)assert.match(res.body.answer,/ไม่พบบุคคล/);
      else if(c.force){
        assert.ok(calls.length>0,'must call real model');
        assert.ok(calls.some(x=>x.toolCalls?.some(y=>y.function.name==='get_monitoring_persons')),'must use monitoring tool');
        assert.match(res.body.answer,new RegExp(`พบ ${c.total} คน`));
      }else assert.equal(res.body.presentation.total,c.total);
      assert.ok(!res.body.answer.includes('สถานี2'),'no cross-station leak');
      if(!c.force)assert.equal(calls.length,0);
      entry.pass=true;
    }catch(e){entry.pass=false;entry.error=e.message;}
    results.runs.push(entry);fs.writeFileSync(output,JSON.stringify(results,null,2));
    console.log(`${entry.pass?'PASS':'FAIL'} ${entry.wallMs}ms, ${calls.length} model calls ${entry.error||''}`);
  }
  results.passed=results.runs.filter(r=>r.pass).length;results.total=results.runs.length;
  fs.writeFileSync(output,JSON.stringify(results,null,2));db.close();console.log(`RESULT ${results.passed}/${results.total}: ${output}`);
  if(results.passed!==results.total)process.exitCode=1;
}
main().catch(e=>{console.error(e);process.exitCode=1;});
