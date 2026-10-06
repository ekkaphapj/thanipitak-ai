const {test}=require('node:test');const assert=require('node:assert/strict');const express=require('express');const request=require('supertest');
const {createRealDataRoutes}=require('../src/routes/realDataRoutes');
const {validatePlan,coercePlan}=require('../src/ai/realIntent');
const {correctTranscript}=require('../src/stt/correctTranscript');

// Audited aggregate rows the ai-summary tool returns in every case below.
const ROWS=[
 {station_name:'สภ.ข',province:'อุดรธานี',psychiatric_total:1,drug_user_total:9,dealer_total:2,released_total:1,target_total:13},
 {station_name:'สภ.ก',province:'อุดรธานี',psychiatric_total:2,drug_user_total:3,dealer_total:1,released_total:0,target_total:6},
 {station_name:'สภ.ค',province:'อุดรธานี',psychiatric_total:4,drug_user_total:5,dealer_total:0,released_total:0,target_total:9},
];
function buildApp({rows=ROWS,interpret}={}){
 const calls=[];
 const app=express();app.use(express.json());
 app.use(createRealDataRoutes((req,res,next)=>{req.user={role:'officer',stationId:77,province:'อุดรธานี',aiScope:{level:'all',read_only:true}};req.realToken='verified-session';next();},
  {url:'https://example.test',key:'anon',request:async(url)=>{
   calls.push(String(url));
   return {ok:true,json:async()=>({report_type:'target_person_summary',scope:{level:'all',read_only:true},rows})};
  },interpret:interpret||(async()=>{throw new Error('model must not be called');})}));
 return {app,calls};
}

test('interpreter schema accepts group สภ. and still coerces unknown groups',()=>{
 const plan=validatePlan({action:'group',person_type:'drug_user',group:'สภ.',direction:'desc'});
 assert.equal(plan.group,'สภ.');assert.equal(plan.action,'group');
 const coerced=coercePlan({action:'group',person_type:'all',group:'สถานี',direction:'desc'});
 assert.equal(coerced.group,'none');assert.equal(coerced.action,'clarify');
});

test('spoken “สภ.ไหนมีผู้เสพเยอะที่สุด” answers with the deterministic audited station ranking',async()=>{
 const {app,calls}=buildApp();
 const res=await request(app).post('/ai/chat').send({message:'สภ.ไหนมีผู้เสพเยอะที่สุด'});
 assert.equal(res.status,200);
 assert.equal(res.body.presentation.type,'station_ranking');
 assert.equal(res.body.presentation.personType,'drug_user');
 assert.equal(res.body.presentation.rows[0].stationName,'สภ.ข');
 assert.equal(res.body.meta.fastPath,true);assert.equal(res.body.meta.ollamaCalls,0);
 assert.equal(res.body.toolsUsed[0].name,'ai-summary/target_person_summary');
 assert.match(res.body.answer,/สภ\.ข มีผู้เสพมากที่สุด 9 คน/);
 assert.equal(calls.length,1);assert.match(calls[0],/\/functions\/v1\/ai-summary/);
});

test('a model-proposed station grouping runs the audited ranking, never a province people scan',async()=>{
 const interpret=async(message)=>{
  assert.equal(message,'ที่ไหนมีผู้เสพเยอะที่สุด');
  return validatePlan({action:'group',person_type:'drug_user',group:'สภ.',direction:'desc'});
 };
 const {app,calls}=buildApp({interpret});
 const res=await request(app).post('/ai/chat').send({message:'ที่ไหนมีผู้เสพเยอะที่สุด'});
 assert.equal(res.status,200);
 assert.equal(calls.length,1);assert.match(calls[0],/\/functions\/v1\/ai-summary/);
 assert.equal(res.body.presentation.type,'station_ranking');
 assert.equal(res.body.presentation.personType,'drug_user');
 assert.equal(res.body.presentation.rows[0].stationName,'สภ.ข');
 assert.equal(res.body.toolsUsed[0].name,'ai-summary/target_person_summary');
 assert.equal(res.body.meta.fastPath,false);assert.equal(res.body.meta.ollamaCalls,1);
 assert.match(res.body.answer,/สภ\.ข มีผู้เสพมากที่สุด 9 คน/);
 assert.equal(JSON.stringify(res.body.toolsUsed).includes('supabase_area_count'),false);
});

test('tied stations are both named as the leader',async()=>{
 const tie=[
  {station_name:'สภ.มาก',province:'อุดรธานี',psychiatric_total:1,drug_user_total:9,dealer_total:0,released_total:0,target_total:10},
  {station_name:'สภ.เท่ากัน',province:'อุดรธานี',psychiatric_total:2,drug_user_total:9,dealer_total:1,released_total:0,target_total:12},
  {station_name:'สภ.น้อย',province:'อุดรธานี',psychiatric_total:2,drug_user_total:1,dealer_total:0,released_total:0,target_total:3},
 ];
 const {app}=buildApp({rows:tie});
 const res=await request(app).post('/ai/chat').send({message:'สภ.ไหนมีผู้เสพเยอะที่สุด'});
 assert.equal(res.status,200);
 assert.match(res.body.answer,/สภ\.มาก และ สภ\.เท่ากัน มีผู้เสพมากที่สุด 9 คน/);
});

test('garbled spoken station question cues are repaired to the สภ. ranking path',async()=>{
 assert.equal(correctTranscript('สอบพอไหนมีผู้เสพเยอะที่สุด'),'สภ.ไหนมีผู้เสพเยอะที่สุด');
 assert.equal(correctTranscript('สอพอที่ไหนมีผู้ป่วยมากที่สุด'),'สภ.ที่ไหนมีผู้ป่วยมากที่สุด');
 assert.equal(correctTranscript('สภอไหนมีผู้ค้าน้อยที่สุด'),'สภ.ไหนมีผู้ค้าน้อยที่สุด');
 // Real words keep their spelling.
 assert.equal(correctTranscript('วันสอบไม่ผ่าน'),'วันสอบไม่ผ่าน');
 assert.equal(correctTranscript('สภาไหนน่าสนใจ'),'สภาไหนน่าสนใจ');
 const {app}=buildApp();
 const res=await request(app).post('/ai/chat').send({message:'สอบพอไหนมีผู้เสพเยอะที่สุด'});
 assert.equal(res.status,200);
 assert.equal(res.body.presentation.type,'station_ranking');
 assert.equal(res.body.meta.fastPath,true);assert.equal(res.body.meta.ollamaCalls,0);
});

test('model group สภ. with a spoken limit keeps the limit and audit stays single-call',async()=>{
 const interpret=async()=>validatePlan({action:'group',person_type:'all',group:'สภ.',direction:'desc'});
 const {app}=buildApp({interpret});
 const res=await request(app).post('/ai/chat').send({message:'ที่ไหนมีบุคคลเยอะที่สุด 2 อันดับแรก'});
 assert.equal(res.status,200);
 assert.equal(res.body.presentation.type,'station_ranking');
 assert.equal(res.body.presentation.limit,2);
 assert.equal(res.body.presentation.rows.length,2);
 assert.equal(res.body.presentation.personType,null);
 assert.match(res.body.answer,/สภ\.ข มีบุคคลทั้งหมดมากที่สุด 13 คน/);
});
