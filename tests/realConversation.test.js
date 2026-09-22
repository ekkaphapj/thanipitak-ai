const {test}=require('node:test');const assert=require('node:assert/strict');const express=require('express');const request=require('supertest');
const {createRealDataRoutes}=require('../src/routes/realDataRoutes');

function makeApp(user,mockRequest,overrides={}){
 const app=express();app.use(express.json());
 app.use(createRealDataRoutes((req,res,next)=>{req.user=user;req.realToken='verified-session';next();},
  {url:'https://example.test',key:'anon',request:mockRequest,
   interpret:async(message)=>{throw new Error(`unexpected interpret call: ${message}`);},
   ...overrides}));
 return app;
}
const ok=(rows,range)=>({ok:true,headers:new Headers({'content-range':range||`0-${rows.length-1}/${rows.length}`}),json:async()=>rows});
const PEOPLE_MONITOR_SELECT='id,prefix,first_name,last_name,tambon,amphoe,type_id,station_id,status';
const PEOPLE_SEARCH_SELECT='id,first_name,last_name,station_id,province,amphoe,tambon,type_id,status';

test('multi-turn monitoring: window, area refine, window replace, then export with the same conditions',async()=>{
 const calls=[];
 const serve=(url)=>{
  const u=new URL(url);calls.push(u);
  if(u.pathname.endsWith('/people')&&u.searchParams.get('select')===PEOPLE_MONITOR_SELECT){
   return ok([{id:2,prefix:'นาง',first_name:'สมหญิง',last_name:'แสงทอง',tambon:'โพนสูง',amphoe:'เมือง',type_id:2,station_id:77,status:'active'}],'0-0/1');
  }
  if(u.pathname.endsWith('/visits'))return ok([{id:9,person_id:2,visit_date:'2026-08-10',visit_status:'เสี่ยงสูง'}],'0-0/1');
  if(u.pathname.endsWith('/person_report_status'))return ok([],'0--1/0');
  throw new Error('unexpected read '+url);
 };
 const app=makeApp({role:'officer',stationId:77,stationName:'สภ.ทดสอบ'},serve);

 // Turn 1: explicit named month
 const turn1=await request(app).post('/ai/chat').send({message:'ใครเสี่ยงสูงเดือนสิงหาคม 2569'});
 assert.equal(turn1.status,200);
 assert.match(turn1.body.answer,/สิงหาคม 2569/);
 let topic=turn1.body.conversation.topic;
 assert.equal(topic.level,'high');
 assert.equal(topic.kind,'monitoring_list');
 assert.equal(topic.window.from,'2026-08-01');
 assert.equal(topic.window.to,'2026-08-31');

 // Turn 2: area-only refinement keeps the window
 calls.length=0;
 const turn2=await request(app).post('/ai/chat').send({message:'เอาเฉพาะตำบลโพนสูง',context:{topic}});
 assert.equal(turn2.status,200);
 assert.match(turn2.body.answer,/สมหญิง/);
 const monitored=calls.filter(u=>u.pathname.endsWith('/people')&&u.searchParams.get('select')===PEOPLE_MONITOR_SELECT);
 assert.ok(monitored.length>=1);
 assert.equal(monitored[0].searchParams.get('tambon'),'ilike.*โพนสูง*');
 assert.equal(monitored[0].searchParams.get('station_id'),'eq.77');
 const visits2=calls.find(u=>u.pathname.endsWith('/visits'));
 assert.deepEqual(visits2.searchParams.getAll('visit_date').sort(),['gte.2026-08-01','lte.2026-08-31']);
 assert.equal(turn2.body.conversation.topic.subdistrict,'โพนสูง');
 assert.equal(turn2.body.conversation.topic.window.to,'2026-08-31');
 topic=turn2.body.conversation.topic;

 // Turn 3: a bare period follow-up replaces only the window
 calls.length=0;
 const turn3=await request(app).post('/ai/chat').send({message:'เดือนกรกฎาคมล่ะ',context:{topic}});
 assert.equal(turn3.status,200);
 const visits3=calls.find(u=>u.pathname.endsWith('/visits'));
 assert.deepEqual(visits3.searchParams.getAll('visit_date').sort(),['gte.2026-07-01','lte.2026-07-31']);
 assert.equal(calls.find(u=>u.pathname.endsWith('/people')&&u.searchParams.get('select')===PEOPLE_MONITOR_SELECT).searchParams.get('tambon'),'ilike.*โพนสูง*');
 assert.equal(turn3.body.conversation.topic.window.from,'2026-07-01');
 assert.equal(turn3.body.conversation.topic.subdistrict,'โพนสูง');
 topic=turn3.body.conversation.topic;

 // Turn 4: export must reference the exact conditions of the latest list
 const turn4=await request(app).post('/ai/chat').send({message:'ส่งรายการนี้เป็น Excel',context:{topic}});
 assert.equal(turn4.status,200);
 assert.equal(turn4.body.presentation.type,'report_offer');
 const reportRequest=turn4.body.presentation.reportRequest;
 assert.equal(reportRequest.filters.level,'high');
 assert.equal(reportRequest.filters.subdistrict,'โพนสูง');
 assert.equal(reportRequest.filters.window.from,'2026-07-01');
 assert.equal(reportRequest.filters.window.to,'2026-07-31');
 assert.match(turn4.body.answer,/เงื่อนไขรายงาน/);
 calls.length=0;
 const file=await request(app).post('/reports/summary.xlsx').send({reportRequest});
 assert.equal(file.status,200);
 assert.match(file.headers['content-type'],/spreadsheetml/);
 const fileVisits=calls.find(u=>u.pathname.endsWith('/visits'));
 assert.deepEqual(fileVisits.searchParams.getAll('visit_date').sort(),['gte.2026-07-01','lte.2026-07-31']);
 assert.equal(calls.find(u=>u.pathname.endsWith('/people')&&u.searchParams.get('select')===PEOPLE_MONITOR_SELECT).searchParams.get('tambon'),'ilike.*โพนสูง*');
});

test('multi-turn list: exclusion survives pagination and is carried into the report',async()=>{
 const calls=[];
 const peopleRows=[
  {id:11,first_name:'ก',last_name:'ทดสอบ',station_id:77,province:'นครพนม',amphoe:'เมือง',tambon:'วังใหญ่',type_id:2,status:'active'},
 ];
 const serve=(url)=>{
  const u=new URL(url);calls.push(u);
  if(u.pathname.endsWith('/people_type'))return ok([{type_id:2}],'0-0/1');
  if(u.pathname.endsWith('/people')&&u.searchParams.get('select')===PEOPLE_SEARCH_SELECT)return ok(peopleRows,'0-0/1');
  if(u.pathname.endsWith('/people')&&u.searchParams.get('select')==='province,amphoe,tambon')return ok([{province:'นครพนม',amphoe:'เมือง',tambon:'โพนสูง'}],'0-0/1');
  throw new Error('unexpected read '+url);
 };
 const app=makeApp({role:'officer',stationId:77},serve);
 const turn1=await request(app).post('/ai/chat').send({message:'ขอรายชื่อผู้เสพไม่รวมตำบลโพนสูง'});
 assert.equal(turn1.status,200);
 assert.equal(turn1.body.presentation.type,'person_list');
 let topic=turn1.body.conversation.topic;
 assert.equal(topic.kind,'people_list');
 assert.equal(topic.person_type,'drug_user');
 assert.deepEqual(topic.exclude.map(item=>item.value),['โพนสูง']);

 calls.length=0;
 const turn2=await request(app).post('/ai/chat').send({message:'หน้าถัดไป',context:{topic}});
 assert.equal(turn2.status,200);
 assert.equal(turn2.body.presentation.page,2);
 const listReads=calls.filter(u=>u.pathname.endsWith('/people')&&u.searchParams.get('select')===PEOPLE_SEARCH_SELECT);
 assert.equal(listReads[0].searchParams.get('not.tambon'),'ilike.*โพนสูง*');
 assert.match(listReads[0].searchParams.get('type_id'),/^in\.\(\d+\)$/);
 topic=turn2.body.conversation.topic;
 assert.equal(topic.page,2);

 const turn3=await request(app).post('/ai/chat').send({message:'ส่งรายการนี้เป็น PDF',context:{topic}});
 assert.equal(turn3.status,200);
 assert.equal(turn3.body.presentation.type,'report_offer');
 const reportRequest=turn3.body.presentation.reportRequest;
 assert.equal(reportRequest.filters.person_type,'drug_user');
 assert.deepEqual(reportRequest.filters.exclude.map(item=>item.value),['โพนสูง']);
 assert.equal(reportRequest.filters.window,undefined);
 calls.length=0;
 const file=await request(app).post('/reports/summary.xlsx').send({reportRequest});
 assert.equal(file.status,200);
 assert.match(file.headers['content-type'],/spreadsheetml/);
 const fileReads=calls.filter(u=>u.pathname.endsWith('/people')&&u.searchParams.get('select')===PEOPLE_SEARCH_SELECT);
 assert.ok(fileReads.length>=1);
 assert.equal(fileReads[0].searchParams.get('not.tambon'),'ilike.*โพนสูง*');
});

test('a short reply fills only the pending period question (registry or monitoring)',async()=>{
 const build=()=>makeApp({role:'officer',stationId:77,stationName:'สภ.ทดสอบ'},async(url)=>{
  const u=new URL(url);
  if(u.pathname.endsWith('/people')){
   if(u.searchParams.get('select')==='province,amphoe,tambon')return ok([{province:'นครพนม',amphoe:'เมือง',tambon:'โพนสูง'}],'0-0/1');
   if(u.searchParams.get('select')==='id,prefix,first_name,last_name,tambon,amphoe,type_id,station_id,status')return ok([{id:3,prefix:'นาย',first_name:'สมชาย',last_name:'ใจดี',tambon:'โพนสูง',amphoe:'เมือง',type_id:2,station_id:77,status:'active'}],'0-0/1');
   if(u.searchParams.get('select')===PEOPLE_SEARCH_SELECT)return ok([{id:3,first_name:'สมชาย',last_name:'ใจดี',station_id:77,province:'นครพนม',amphoe:'เมือง',tambon:'โพนสูง',type_id:2,status:'active'}],'0-0/1');
   throw new Error('unexpected people read');
  }
  if(u.pathname.endsWith('/people_type'))return ok([{type_id:2}],'0-0/1');
  if(u.pathname.endsWith('/visits'))return ok([{id:9,person_id:3,visit_date:'2026-09-05',visit_status:'เสี่ยงสูง'}],'0-0/1');
  if(u.pathname.endsWith('/person_report_status'))return ok([],'0--1/0');
  throw new Error('unexpected read '+url);
 });

 // Option 1: plain registry count, period explicitly dropped and stated
 const app1=build();
 const first=await request(app1).post('/ai/chat').send({message:'ผู้เสพเดือนนี้มีกี่คน'});
 assert.equal(first.status,200);
 assert.equal(first.body.conversation.topic.pending.type,'period_intent');
 const countRes=await request(app1).post('/ai/chat').send({message:'1',context:{topic:first.body.conversation.topic}});
 assert.equal(countRes.status,200);
 assert.match(countRes.body.answer,/นับจากทะเบียนปัจจุบัน/);
 assert.ok(!countRes.body.conversation.topic||!countRes.body.conversation.topic.pending);

 // Option 2: windowed monitoring within the period from the question
 const app2=build();
 const first2=await request(app2).post('/ai/chat').send({message:'ผู้เสพเดือนนี้มีกี่คน'});
 const window=first2.body.conversation.topic.pending.window;
 const second=await request(app2).post('/ai/chat').send({message:'2',context:{topic:first2.body.conversation.topic}});
 assert.equal(second.status,200);
 assert.match(second.body.answer,/เฝ้าระวังหรือเสี่ยงสูง/);
 assert.equal(second.body.presentation.type,'person_list');
 assert.equal(second.body.conversation.topic.level,'all');
 assert.equal(second.body.conversation.topic.window.from,window.from);
});

test('a pending period choice retains the original area filters',async()=>{
 const reads=[];
 const app=makeApp({role:'officer',stationId:77},async(url)=>{
  const u=new URL(url);reads.push(u);
  if(u.pathname.endsWith('/people_type'))return ok([{type_id:2}],'0-0/1');
  if(u.pathname.endsWith('/people')&&u.searchParams.get('select')===PEOPLE_SEARCH_SELECT)return ok([],'0--1/0');
  if(u.pathname.endsWith('/people')&&u.searchParams.get('select')===PEOPLE_MONITOR_SELECT)return ok([],'0--1/0');
  if(u.pathname.endsWith('/visits')||u.pathname.endsWith('/person_report_status'))return ok([],'0--1/0');
  throw new Error('unexpected read '+url);
 });
 const first=await request(app).post('/ai/chat').send({message:'ผู้เสพตำบลโพนสูงเดือนนี้มีกี่คน'});
 const topic=first.body.conversation.topic;
 assert.equal(topic.subdistrict,'โพนสูง');
 reads.length=0;
 const second=await request(app).post('/ai/chat').send({message:'2',context:{topic}});
 assert.equal(second.status,200);
 const people=reads.find((u)=>u.pathname.endsWith('/people')&&u.searchParams.get('select')===PEOPLE_MONITOR_SELECT);
 assert.equal(people.searchParams.get('tambon'),'ilike.*โพนสูง*');
});

test('an unresolved period blocks plain reads and exports',async()=>{
 const app=makeApp({role:'officer',stationId:77},async()=>{throw new Error('must not read');});
 for(const message of ['ผู้เสพไตรมาสที่แล้วมีกี่คน','ขอ Excel ผู้เสพไตรมาสที่แล้ว']){
  const res=await request(app).post('/ai/chat').send({message});
  assert.equal(res.status,200);
  assert.equal(res.body.grounded,false);
  assert.match(res.body.answer,/ช่วงเวลา/);
 }
});

test('เริ่มใหม่ clears every condition server-side',async()=>{
 const app=makeApp({role:'officer',stationId:77},async()=>{throw new Error('reset must not read');});
 const res=await request(app).post('/ai/chat').send({message:'เริ่มใหม่',context:{topic:{person_type:'drug_user',level:'high',kind:'monitoring_list',window:{from:'2026-08-01',to:'2026-08-31',label:'x'}}}});
 assert.equal(res.status,200);
 assert.equal(res.body.conversation.topic,null);
 assert.match(res.body.answer,/เริ่มบทสนทนาใหม่/);
});

test('two conversations keep their conditions separate (stateless per request)',async()=>{
 const reads=[];
 const serve=(url)=>{
  const u=new URL(url);reads.push(u);
  if(u.pathname.endsWith('/people')&&u.searchParams.get('select')===PEOPLE_MONITOR_SELECT)return ok([],'0--1/0');
  if(u.pathname.endsWith('/visits'))return ok([],'0--1/0');
  if(u.pathname.endsWith('/person_report_status'))return ok([],'0--1/0');
  throw new Error('unexpected read '+url);
 };
 const app=makeApp({role:'officer',stationId:77},serve);
 const topicA={level:'high',kind:'monitoring_list',page:1,subdistrict:'โพนสูง',window:{from:'2026-08-01',to:'2026-08-31',label:'สิงหาคม'}};
 const topicB={level:'high',kind:'monitoring_list',page:1,subdistrict:'วังใหญ่',window:{from:'2026-08-01',to:'2026-08-31',label:'สิงหาคม'}};
 const resA=await request(app).post('/ai/chat').send({message:'หน้าถัดไป',context:{topic:topicA}});
 const resB=await request(app).post('/ai/chat').send({message:'หน้าถัดไป',context:{topic:topicB}});
 assert.equal(resA.status,200);assert.equal(resB.status,200);
 const tambons=reads.filter(u=>u.pathname.endsWith('/people')&&u.searchParams.get('select')===PEOPLE_MONITOR_SELECT).map(u=>u.searchParams.get('tambon'));
 assert.deepEqual(tambons.sort(),['ilike.*โพนสูง*','ilike.*วังใหญ่*'].sort());
});

test('a forged topic can narrow but never widen: station scope stays enforced',async()=>{
 const reads=[];
 const app=makeApp({role:'officer',stationId:77,stationName:'สภ.ทดสอบ'},async(url)=>{
  const u=new URL(url);reads.push(u);
  if(u.pathname.endsWith('/people')&&u.searchParams.get('select')===PEOPLE_MONITOR_SELECT){
   assert.equal(u.searchParams.get('station_id'),'eq.77');
   assert.equal(u.searchParams.get('station'),null);
   return ok([],'0--1/0');
  }
  if(u.pathname.endsWith('/visits'))return ok([],'0--1/0');
  if(u.pathname.endsWith('/person_report_status'))return ok([],'0--1/0');
  throw new Error('unexpected read '+url);
 });
 const forged={level:'high',kind:'monitoring_list',page:1,station:'สภ.อื่นที่ไม่มีสิทธิ์',
  exclude:[{column:'station_id',ids:[1,2,3]}],
  window:{from:'2000-01-01',to:'2099-12-31',label:'ปลอม'}};
 const res=await request(app).post('/ai/chat').send({message:'หน้าถัดไป',context:{topic:forged}});
 assert.equal(res.status,200);
 const peopleRead=reads.find(u=>u.pathname.endsWith('/people')&&u.searchParams.get('select')===PEOPLE_MONITOR_SELECT);
 assert.equal(peopleRead.searchParams.get('station_id'),'eq.77');
 // A forged exclusion is narrowing-only, so it is applied but cannot reveal rows.
 assert.equal(peopleRead.searchParams.get('not.station_id'),'in.(1,2,3)');
});

test('model failure on an incomplete search fails closed with a server error',async()=>{
 const app=makeApp({role:'officer',stationId:77},async(url)=>{throw new Error('must not read '+url);},
  {interpret:async()=>{throw new Error('ollama down');}});
 const res=await request(app).post('/ai/chat').send({message:'ค้นหา'});
 assert.equal(res.status,502);
 assert.equal(res.body.code,'REAL_READ_FAILED');
});
