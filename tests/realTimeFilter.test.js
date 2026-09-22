const {test}=require('node:test');const assert=require('node:assert/strict');const express=require('express');const request=require('supertest');
const {createRealDataRoutes}=require('../src/routes/realDataRoutes');
const {extractTimeWindow}=require('../src/ai/timeWindow');

function makeApp(user,mockRequest,overrides={}){
 const app=express();app.use(express.json());
 app.use(createRealDataRoutes((req,res,next)=>{req.user=user;req.realToken='verified-session';next();},
  {url:'https://example.test',key:'anon',request:mockRequest,
   // Never touch a real Ollama from route tests: an unmocked interpreter call
   // must fail the test loudly instead of hanging on the local model.
   interpret:async(message)=>{throw new Error(`unexpected interpret call: ${message}`);},
   ...overrides}));
 return app;
}
const ok=(rows,range)=>({ok:true,headers:new Headers({'content-range':range||`0-${rows.length-1}/${rows.length}`}),json:async()=>rows});
const VISIT_SELECT='id,person_id,visit_date,visit_time,visit_status,drug_test_result,status_condition,notes,visitor_name,visitor_station,visit_category';

test('ใครเสี่ยงสูงเดือนนี้ reads only visits dated inside the requested month',async()=>{
 const window=extractTimeWindow('เดือนนี้');
 const reads=[];
 const peopleRows=[
  {id:1,prefix:'นาย',first_name:'สมชาย',last_name:'ใจดี',tambon:'โพนสูง',amphoe:'เมือง',type_id:2,station_id:77,status:'active'},
  {id:2,prefix:'นาง',first_name:'สมหญิง',last_name:'แสงทอง',tambon:'วังใหญ่',amphoe:'เมือง',type_id:2,station_id:77,status:'active'},
 ];
 const app=makeApp({role:'officer',stationId:77,stationName:'สภ.ทดสอบ'},async(url)=>{
  const u=new URL(url);reads.push(u);
  if(u.pathname.endsWith('/people')){
   if(u.searchParams.get('select')==='id,prefix,first_name,last_name,tambon,amphoe,type_id,station_id,status')return ok(peopleRows,'0-1/2');
   throw new Error('unexpected people read '+u.searchParams.get('select'));
  }
  if(u.pathname.endsWith('/visits')){
   const bounds=u.searchParams.getAll('visit_date');
   assert.deepEqual(bounds.sort(),[`gte.${window.from}`,`lte.${window.to}`].sort());
   return ok([{id:9,person_id:2,visit_date:'2026-09-10',visit_status:'เสี่ยงสูง'}],'0-0/1');
  }
  if(u.pathname.endsWith('/person_report_status')){
   const bounds=u.searchParams.getAll('last_report_date');
   assert.deepEqual(bounds.sort(),[`gte.${window.from}`,`lte.${window.to}`].sort());
   return ok([],'0--1/0');
  }
  throw new Error('unexpected read '+url);
 });
 const res=await request(app).post('/ai/chat').send({message:'ใครเสี่ยงสูงเดือนนี้'});
 assert.equal(res.status,200);
 assert.match(res.body.answer,/ช่วงเดือนนี้/);
 assert.match(res.body.answer,/สมหญิง/);
 assert.match(res.body.answer,/อ้างอิงเฉพาะบันทึกที่อยู่ในช่วง/);
 assert.equal(res.body.presentation.total,1);
 assert.equal(res.body.meta.fastPath,true);
});

test('a selected person visit count honours เดือนที่แล้ว',async()=>{
 const window=extractTimeWindow('เดือนที่แล้ว');
 const reads=[];
 const app=makeApp({role:'officer',stationId:77,stationName:'สภ.ทดสอบ'},async(url)=>{
  const u=new URL(url);reads.push(u);
  if(u.pathname.endsWith('/people')){
   const select=u.searchParams.get('select');
   if(select.startsWith('id,prefix,first_name')){
    assert.equal(u.searchParams.get('id'),'eq.5');
    return ok([{id:5,prefix:'นาย',first_name:'สมชาย',last_name:'ใจดี',nickname:'',gender:'',birth_date:'1990-01-01',tambon:'โพนสูง',amphoe:'เมือง',province:'นครพนม',moo:'',village_name:'',house_number:'',station_id:77,type_id:2,status:'active',custody_status:null}],'0-0/1');
   }
   throw new Error('unexpected people read '+select);
  }
  if(u.pathname.endsWith('/people_type'))return ok([{type_id:2,type_name:'ผู้เสพ'}],'0-0/1');
  if(u.pathname.endsWith('/visits')){
   assert.equal(u.searchParams.get('person_id'),'eq.5');
   assert.deepEqual(u.searchParams.getAll('visit_date').sort(),[`gte.${window.from}`,`lte.${window.to}`].sort());
   return ok([{id:1,person_id:5,visit_date:'2026-08-05',visit_status:'อาการปกติ'},{id:2,person_id:5,visit_date:'2026-08-20',visit_status:'ปกติ'}],'0-1/2');
  }
  if(u.pathname.endsWith('/person_report_status'))return ok([],'0--1/0');
  throw new Error('unexpected read '+url);
 });
 const res=await request(app).post('/ai/chat').send({message:'เดือนที่แล้วเยี่ยมกี่ครั้ง',context:{personId:5,topic:null}});
 assert.equal(res.status,200);
 assert.match(res.body.answer,/ในเดือนที่แล้ว/);
 assert.match(res.body.answer,/2 ครั้ง/);
 assert.ok(!/ทั้งหมด \d+ ครั้ง(?!ใน)/.test(res.body.answer));
});

test('a plain count with a period asks instead of silently answering all-time',async()=>{
 const app=makeApp({role:'officer',stationId:77},async()=>{throw new Error('a period question must not read the registry silently');});
 const res=await request(app).post('/ai/chat').send({message:'ผู้เสพเดือนนี้มีกี่คน'});
 assert.equal(res.status,200);
 assert.equal(res.body.grounded,false);
 assert.match(res.body.answer,/ช่วงเวลา/);
 assert.match(res.body.answer,/ใครเสี่ยงสูงเดือนนี้/);
});

test('an unresolvable period on a monitoring question stays unsupported',async()=>{
 const app=makeApp({role:'officer',stationId:77},async()=>{throw new Error('must not read');});
 const res=await request(app).post('/ai/chat').send({message:'ใครเสี่ยงสูงไตรมาสที่แล้ว'});
 assert.equal(res.status,200);
 assert.equal(res.body.grounded,false);
 assert.match(res.body.answer,/ช่วงเวลา/);
});

test('ผู้เสพยกเว้นตำบลโพนสูงมีกี่คน applies a server-side not-filter',async()=>{
 const calls=[];
 const peopleRows=[1,2,3].map(id=>({id,first_name:`ก${id}`,last_name:'ทดสอบ',station_id:77,province:'นครพนม',amphoe:'เมือง',tambon:'วังใหญ่',type_id:2,status:'active'}));
 const app=makeApp({role:'officer',stationId:77},async(url)=>{
  const u=new URL(url);calls.push(u);
  if(u.pathname.endsWith('/people')){
   const select=u.searchParams.get('select');
   if(select==='province,amphoe,tambon')return ok([{province:'นครพนม',amphoe:'เมือง',tambon:'โพนสูง'},{province:'นครพนม',amphoe:'เมือง',tambon:'วังใหญ่'}],'0-1/2');
   if(select.startsWith('id,first_name')){
    assert.equal(u.searchParams.get('not.tambon'),'ilike.*โพนสูง*');
    assert.equal(u.searchParams.get('station_id'),'eq.77');
    return ok(peopleRows,'0-2/3');
   }
   throw new Error('unexpected people read '+select);
  }
  if(u.pathname.endsWith('/people_type')){
   assert.match(u.searchParams.get('type_name'),/ผู้เสพ/);
   return ok([{type_id:2}],'0-0/1');
  }
  throw new Error('unexpected read '+url);
 });
 const res=await request(app).post('/ai/chat').send({message:'ผู้เสพยกเว้นตำบลโพนสูงมีกี่คน'});
 assert.equal(res.status,200);
 assert.equal(res.body.answer,'มีผู้เสพ 3 คน (ไม่รวมตำบลโพนสูง)');
});

test('an exclusion naming an unknown area fails explicitly',async()=>{
 const app=makeApp({role:'officer',stationId:77},async(url)=>{
  const u=new URL(url);
  if(u.pathname.endsWith('/people')&&u.searchParams.get('select')==='province,amphoe,tambon')return ok([{province:'นครพนม',amphoe:'เมือง',tambon:'โพนสูง'}],'0-0/1');
  throw new Error('unexpected read '+url);
 });
 const res=await request(app).post('/ai/chat').send({message:'ผู้เสพยกเว้นตำบลกุกกุกมีกี่คน'});
 assert.equal(res.status,422);
 assert.equal(res.body.code,'REAL_LOCATION_NOT_FOUND');
 assert.match(res.body.error,/ยกเว้น/);
});

test('an ambiguous exclusion offers verified choices and the follow-up resolves',async()=>{
 const areaRows=[
  {province:'นครพนม',amphoe:'เมือง',tambon:'โพนสูง'},
  {province:'นครพนม',amphoe:'เมือง',tambon:'โพนทอง'},
 ];
 const peopleRows=[{id:1,first_name:'ก',last_name:'ทดสอบ',station_id:77,province:'นครพนม',amphoe:'เมือง',tambon:'โพนทอง',type_id:2,status:'active'}];
 const serve=async(url)=>{
  const u=new URL(url);
  if(u.pathname.endsWith('/people')){
   const select=u.searchParams.get('select');
   if(select==='province,amphoe,tambon')return ok(areaRows,'0-1/2');
   if(select.startsWith('id,first_name')){
    if(u.searchParams.get('not.tambon')==='ilike.*โพนสูง*')return ok(peopleRows,'0-0/1');
    return ok([],'0--1/0');
   }
  }
  if(u.pathname.endsWith('/people_type'))return ok([{type_id:2}],'0-0/1');
  throw new Error('unexpected read '+url);
 };
 const app=makeApp({role:'officer',stationId:77},serve);
 const res=await request(app).post('/ai/chat').send({message:'ผู้เสพยกเว้นโพนมีกี่คน'});
 assert.equal(res.status,200);
 assert.equal(res.body.presentation.type,'place_choices');
 assert.equal(res.body.presentation.field,'exclude');
 assert.equal(res.body.presentation.originalMessage,'ผู้เสพยกเว้นโพนมีกี่คน');
 assert.equal(res.body.presentation.choices.length,2);
 // Choices are ordered deterministically by code point; pick the verified
 // โพนสูง option explicitly.
 const first=res.body.presentation.choices.find(choice=>choice.replaceWith==='ตำบลโพนสูง');
 assert.ok(first,'expected a ตำบลโพนสูง choice');
 const followup=res.body.presentation.originalMessage.replace(first.replaceText||res.body.presentation.replaceText,first.replaceWith);
 assert.equal(followup,'ผู้เสพยกเว้นตำบลโพนสูงมีกี่คน');
 const retry=await request(app).post('/ai/chat').send({message:followup});
 assert.equal(retry.status,200);
 assert.equal(retry.body.answer,'มีผู้เสพ 1 คน (ไม่รวมตำบลโพนสูง)');
});

test('monitoring with an exclusion excludes the area from the people read',async()=>{
 const calls=[];
 const app=makeApp({role:'officer',stationId:77,stationName:'สภ.ทดสอบ'},async(url)=>{
  const u=new URL(url);calls.push(u);
  if(u.pathname.endsWith('/people')){
   if(u.searchParams.get('select')==='id,prefix,first_name,last_name,tambon,amphoe,type_id,station_id,status'){
    assert.equal(u.searchParams.get('not.tambon'),'ilike.*โพนสูง*');
    return ok([{id:2,prefix:'นาง',first_name:'สมหญิง',last_name:'แสงทอง',tambon:'วังใหญ่',amphoe:'เมือง',type_id:2,station_id:77,status:'active'}],'0-0/1');
   }
   if(u.searchParams.get('select')==='province,amphoe,tambon')return ok([{province:'นครพนม',amphoe:'เมือง',tambon:'โพนสูง'},{province:'นครพนม',amphoe:'เมือง',tambon:'วังใหญ่'}],'0-1/2');
   throw new Error('unexpected people read');
  }
  if(u.pathname.endsWith('/visits'))return ok([{id:9,person_id:2,visit_date:'2026-09-10',visit_status:'เสี่ยงสูง'}],'0-0/1');
  if(u.pathname.endsWith('/person_report_status'))return ok([],'0--1/0');
  throw new Error('unexpected read '+url);
 });
 const res=await request(app).post('/ai/chat').send({message:'ใครเสี่ยงสูง ยกเว้นตำบลโพนสูง'});
 assert.equal(res.status,200);
 assert.match(res.body.answer,/สมหญิง/);
 assert.match(res.body.answer,/ไม่รวมตำบลโพนสูง/);
});
