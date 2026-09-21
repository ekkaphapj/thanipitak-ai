const {test}=require('node:test');const assert=require('node:assert/strict');const express=require('express');const request=require('supertest');
const {createRealDataRoutes}=require('../src/routes/realDataRoutes');
test('real mode routes product questions to RAG instead of registry clarification',async()=>{
 const previous=process.env.RAG_ENABLED;process.env.RAG_ENABLED='true';
 try {
  const app=express();app.use(express.json());
  app.use(createRealDataRoutes((req,res,next)=>{req.user={role:'officer',stationId:77};req.realToken='t';next();},{url:'https://example.test',key:'anon',request:async()=>{throw new Error('registry must not be read');}}));
  const res=await request(app).post('/ai/chat').send({message:'ธานีพิทักษ์คืออะไร'});
  assert.equal(res.status,200);assert.match(res.body.answer,/ระบบจัดการบุคคลเป้าหมายอัจฉริยะ/);assert.doesNotMatch(res.body.answer,/ต้องการจำนวน|รายชื่อ หรือแยกยอด/);
 } finally { if(previous===undefined)delete process.env.RAG_ENABLED;else process.env.RAG_ENABLED=previous; }
});
test('psychiatric overview uses the audited primary AI summary tool, not a direct registry read',async()=>{
 const app=express();app.use(express.json());const calls=[];
 app.use(createRealDataRoutes((req,res,next)=>{req.user={role:'officer',stationId:77,aiScope:{level:'region4',read_only:true}};req.realToken='verified-session';next();},{url:'https://example.test',key:'anon',request:async(url,opts)=>{
  calls.push({url,opts});
  assert.match(url,/\/functions\/v1\/ai-summary$/);
  assert.equal(opts.headers.Authorization,'Bearer verified-session');
  return {ok:true,json:async()=>({report_type:'psychiatric_summary',scope:{level:'region4',read_only:true},rows:[{station_id:77,station_name:'สภ.บ้านดุง',province:'อุดรธานี',patient_total:4,green_total:1,yellow_total:2,red_total:1}]})};
 }}));
 const res=await request(app).post('/ai/chat').send({message:'ขอภาพรวมผู้ป่วยจิตเวช'});
 assert.equal(res.status,200);assert.match(res.body.answer,/รวม 4 คน/);assert.equal(res.body.presentation.readOnlyAggregate,true);
 assert.equal(res.body.presentation.items[0].red,1);assert.equal(calls.length,1);
});
test('target-person overview uses the audited aggregate tool for every supported person type',async()=>{
 const app=express();app.use(express.json());const calls=[];
 app.use(createRealDataRoutes((req,res,next)=>{req.user={role:'officer',stationId:77,aiScope:{level:'region4',read_only:true}};req.realToken='verified-session';next();},{url:'https://example.test',key:'anon',request:async(url,opts)=>{
  calls.push({url,opts});assert.match(url,/\/functions\/v1\/ai-summary$/);
  assert.equal(JSON.parse(opts.body).summary_kind,'target_people');
  return {ok:true,json:async()=>({report_type:'target_person_summary',scope:{level:'region4',read_only:true},rows:[{station_id:77,station_name:'สภ.บ้านดุง',province:'อุดรธานี',psychiatric_total:4,drug_user_total:3,dealer_total:2,released_total:1,target_total:10}]})};
 }}));
 const res=await request(app).post('/ai/chat').send({message:'ขอภาพรวมผู้เสพ'});
 assert.equal(res.status,200);assert.match(res.body.answer,/ผู้เสพ 3/);assert.equal(res.body.presentation.type,'target_person_summary');assert.equal(res.body.presentation.totals.total,10);assert.equal(res.body.conversation.topic.report_kind,'target_person_aggregate');assert.equal(calls.length,1);
});
test('aggregate overview PDF reuses the audited summary rows instead of the legacy people query',async()=>{
 const previous=process.env.REPORT_FONT_PATH;process.env.REPORT_FONT_PATH='C:\\Windows\\Fonts\\tahoma.ttf';
 try {
  const app=express();app.use(express.json());const bodies=[];
  app.use(createRealDataRoutes((req,res,next)=>{req.user={role:'officer',stationId:77,province:'นครพนม',aiScope:{level:'all',read_only:true}};req.realToken='verified-session';next();},{url:'https://example.test',key:'anon',request:async(url,opts)=>{
   bodies.push(JSON.parse(opts.body));
   return {ok:true,json:async()=>({report_type:'target_person_summary',scope:{level:'all',read_only:true},rows:[{station_name:'สภ.ท่าอุเทน',province:'นครพนม',psychiatric_total:303,drug_user_total:0,dealer_total:0,released_total:0,target_total:303}]})};
  }}));
  const res=await request(app).post('/reports/summary.pdf').send({reportRequest:{report_kind:'target_person_aggregate',filters:{province:'นครพนม'},includeCount:true,includeList:true}});
  assert.equal(res.status,200);assert.match(res.headers['content-type'],/application\/pdf/);assert.equal(bodies.length,1);assert.equal(bodies[0].summary_kind,'target_people');assert.equal(bodies[0].province,'นครพนม');
 } finally { if(previous===undefined)delete process.env.REPORT_FONT_PATH;else process.env.REPORT_FONT_PATH=previous; }
});
test('province change is a local conversation filter and the audited tool receives it',async()=>{
 const app=express();app.use(express.json());const bodies=[];
 app.use(createRealDataRoutes((req,res,next)=>{req.user={role:'officer',stationId:77,aiScope:{level:'region4',read_only:true}};req.realToken='verified-session';next();},{url:'https://example.test',key:'anon',request:async(url,opts)=>{
  bodies.push(JSON.parse(opts.body));
  return {ok:true,json:async()=>({report_type:'target_person_summary',scope:{level:'region4',read_only:true},rows:[]})};
 }}));
 const changed=await request(app).post('/ai/chat').send({message:'เปลี่ยนจังหวัดนครพนม'});
 assert.equal(changed.status,200);assert.equal(changed.body.conversation.topic.province,'นครพนม');assert.equal(bodies.length,0);
 const summary=await request(app).post('/ai/chat').send({message:'ขอภาพรวมผู้เสพ',context:{topic:changed.body.conversation.topic}});
 assert.equal(summary.status,200);assert.equal(bodies.length,1);assert.equal(bodies[0].province,'นครพนม');
});
test('select province wording is handled as a local filter before RAG or the model',async()=>{
 const app=express();app.use(express.json());let reads=0;
 app.use(createRealDataRoutes((req,res,next)=>{req.user={role:'officer',stationId:77,aiScope:{level:'all',read_only:true}};req.realToken='verified-session';next();},{url:'https://example.test',key:'anon',request:async()=>{reads++;throw new Error('a province selection must not read the registry');}}));
 const res=await request(app).post('/ai/chat').send({message:'เลือกจังหวัดนครพนม'});
 assert.equal(res.status,200);assert.equal(res.body.conversation.topic.province,'นครพนม');assert.match(res.body.answer,/ตั้งค่าจังหวัด/);assert.equal(reads,0);
});
test('common voice transcription for Nakhon Phanom is normalized before the audited summary call',async()=>{
 const app=express();app.use(express.json());const bodies=[];
 app.use(createRealDataRoutes((req,res,next)=>{req.user={role:'officer',stationId:77,aiScope:{level:'all',read_only:true,provinces:['นครพนม']}};req.realToken='verified-session';next();},{url:'https://example.test',key:'anon',request:async(url,opts)=>{
  bodies.push(JSON.parse(opts.body));
  return {ok:true,json:async()=>({report_type:'target_person_summary',scope:{level:'all',read_only:true},rows:[{station_name:'สภ.ท่าอุเทน',province:'นครพนม',psychiatric_total:303,drug_user_total:0,dealer_total:0,released_total:0,target_total:303}]})};
 }}));
 const res=await request(app).post('/ai/chat').send({message:'ขอภาพรวมจังหวัดนะครับพนม'});
 assert.equal(res.status,200);assert.equal(bodies.length,1);assert.equal(bodies[0].province,'นครพนม');assert.equal(res.body.conversation.topic.province,'นครพนม');assert.equal(res.body.presentation.totals.total,303);
});
test('station ranking uses the audited aggregate tool, selected province, type and requested limit',async()=>{
 const app=express();app.use(express.json());const bodies=[];
 app.use(createRealDataRoutes((req,res,next)=>{req.user={role:'officer',stationId:77,province:'อุดรธานี',aiScope:{level:'all',read_only:true}};req.realToken='verified-session';next();},{url:'https://example.test',key:'anon',request:async(url,opts)=>{
  bodies.push(JSON.parse(opts.body));
  return {ok:true,json:async()=>({report_type:'target_person_summary',scope:{level:'all',read_only:true},rows:[
   {station_name:'สภ.ก',province:'นครพนม',psychiatric_total:2,drug_user_total:3,dealer_total:1,released_total:0,target_total:6},
   {station_name:'สภ.ข',province:'นครพนม',psychiatric_total:1,drug_user_total:9,dealer_total:2,released_total:1,target_total:13},
   {station_name:'สภ.ค',province:'นครพนม',psychiatric_total:4,drug_user_total:5,dealer_total:0,released_total:0,target_total:9},
  ]})};
 }}));
 const res=await request(app).post('/ai/chat').send({message:'สภ.ที่มีผู้เสพเยอะที่สุด 2 อันดับแรก',context:{topic:{province:'นครพนม'}}});
 assert.equal(res.status,200);assert.equal(bodies.length,1);assert.equal(bodies[0].summary_kind,'target_people');assert.equal(bodies[0].province,'นครพนม');
 assert.equal(res.body.presentation.type,'station_ranking');assert.equal(res.body.presentation.personType,'drug_user');assert.equal(res.body.presentation.rows.length,2);assert.equal(res.body.presentation.rows[0].stationName,'สภ.ข');assert.equal(res.body.presentation.rows[1].stationName,'สภ.ค');
});
test('station ranking without a limit returns every station with each target-person type',async()=>{
 const app=express();app.use(express.json());
 app.use(createRealDataRoutes((req,res,next)=>{req.user={role:'officer',stationId:77,province:'อุดรธานี',aiScope:{level:'all',read_only:true}};req.realToken='verified-session';next();},{url:'https://example.test',key:'anon',request:async()=>({ok:true,json:async()=>({report_type:'target_person_summary',scope:{level:'all',read_only:true},rows:[
  {station_name:'สภ.มาก',province:'อุดรธานี',psychiatric_total:2,drug_user_total:3,dealer_total:1,released_total:0,target_total:6},
  {station_name:'สภ.น้อย',province:'อุดรธานี',psychiatric_total:1,drug_user_total:0,dealer_total:0,released_total:0,target_total:1},
]})})}));
 const res=await request(app).post('/ai/chat').send({message:'สภ.ที่มีข้อมูลน้อยที่สุด'});
 assert.equal(res.status,200);assert.equal(res.body.presentation.limit,null);assert.equal(res.body.presentation.rows.length,2);assert.equal(res.body.presentation.rows[0].stationName,'สภ.น้อย');assert.equal(res.body.presentation.rows[0].drugUser,0);
});
test('processing preflight identifies only local-model requests and does not read data',async()=>{
 const app=express();app.use(express.json());let reads=0;
 app.use(createRealDataRoutes((req,res,next)=>{req.user={role:'officer',stationId:77,province:'อุดรธานี'};req.realToken='verified-session';next();},{url:'https://example.test',key:'anon',request:async()=>{reads++;throw new Error('preflight must not call data');}}));
 const direct=await request(app).post('/ai/chat/processing').send({message:'สภ.ที่มีข้อมูลมากที่สุด 5 อันดับแรก'});
 assert.equal(direct.status,200);assert.equal(direct.body.willUseLocalAi,false);
 const model=await request(app).post('/ai/chat/processing').send({message:'ช่วยวิเคราะห์คำถามแปลกใหม่ให้หน่อย'});
 assert.equal(model.status,200);assert.equal(model.body.willUseLocalAi,true);assert.equal(reads,0);
});
test('real mode treats registry terminology explanations as knowledge, not a people lookup',async()=>{
 const previous=process.env.RAG_ENABLED;process.env.RAG_ENABLED='true';
 try {
  const app=express();app.use(express.json());
  app.use(createRealDataRoutes((req,res,next)=>{req.user={role:'officer',stationId:77};req.realToken='t';next();},{url:'https://example.test',key:'anon',request:async()=>{throw new Error('registry must not be read for a terminology question');}}));
  const res=await request(app).post('/ai/chat').send({message:'ผู้เสพหมายถึงอะไรในระบบ'});
  assert.equal(res.status,200);assert.match(res.body.answer,/ตรวจจากทะเบียนตามสิทธิ์/);
  assert.doesNotMatch(res.body.answer,/ต้องการจำนวน|รายชื่อ หรือแยกยอด/);
 } finally { if(previous===undefined)delete process.env.RAG_ENABLED;else process.env.RAG_ENABLED=previous; }
});
test('real aggregate discovery reads only scoped rows and returns no names',async()=>{
 const app=express();app.use(express.json());const calls=[];
 app.use(createRealDataRoutes((req,res,next)=>{req.user={role:'officer',stationId:77,stationName:'สภ.บ้านดุง'};req.realToken='t';next();},{url:'https://example.test',key:'anon',request:async url=>{
  const u=new URL(url);calls.push(u);
  if(u.pathname.endsWith('/people_type'))return {ok:true,headers:new Headers({'content-range':'0-1/2'}),json:async()=>[{type_id:5,type_name:'ผู้เสพ'},{type_id:9,type_name:'ผู้ป่วยจิตเวช'}]};
  return {ok:true,headers:new Headers({'content-range':'0-5/6'}),json:async()=>[
   {id:1,station_id:77,type_id:5,tambon:'ก',amphoe:'เมือง',status:'active'}, {id:2,station_id:77,type_id:5,tambon:'ก',amphoe:'เมือง',status:'active'},
   {id:3,station_id:77,type_id:5,tambon:'ก',amphoe:'เมือง',status:'active'}, {id:4,station_id:77,type_id:5,tambon:'ก',amphoe:'เมือง',status:'active'},
   {id:5,station_id:77,type_id:5,tambon:'ก',amphoe:'เมือง',status:'active'}, {id:6,station_id:77,type_id:9,tambon:'ข',amphoe:'เมือง',status:'followup'},
  ]};
 }}));
 const res=await request(app).post('/ai/chat').send({message:'พบ pattern อะไรบ้าง'});
 assert.equal(res.status,200);assert.equal(res.body.presentation.type,'discovery');assert.equal(res.body.presentation.total,6);assert.match(res.body.answer,/ข้อมูลกระจุกตัว/);assert.doesNotMatch(res.body.answer,/สมชาย|first_name/);
 const people=calls.find(call=>call.pathname.endsWith('/people'));assert.equal(people.searchParams.get('station_id'),'eq.77');
});
test('unknown spoken question invokes local interpreter and executes scoped grouping',async()=>{
 let interpretations=0;const app=express();app.use(express.json());
 app.use(createRealDataRoutes((req,res,next)=>{req.user={role:'officer',stationId:77};req.realToken='t';next();},{
  interpret:async()=>{interpretations++;return {action:'group',person_type:'psychiatric',group:'ตำบล',direction:'desc'};},url:'https://example.test',key:'anon',request:async url=>{
   const u=new URL(url);const types=u.pathname.endsWith('people_type');
   if(!types){assert.equal(u.searchParams.get('station_id'),'eq.77');assert.equal(u.searchParams.get('type_id'),'in.(9)');}
   return {ok:true,headers:new Headers({'content-range':types?'0-0/1':'0-2/3'}),json:async()=>types?[{type_id:9}]:[{id:1,tambon:'ก'},{id:2,tambon:'ข'},{id:3,tambon:'ข'}]};
  }}));
 const res=await request(app).post('/ai/chat').send({message:'อยากเห็นยอดคนไข้แจกแจงรายตำบล เอาที่เยอะขึ้นก่อน'});
 assert.equal(res.status,200);assert.equal(interpretations,0);assert.equal(res.body.meta.ollamaCalls,0);assert.equal(res.body.meta.fastPath,true);
 assert.ok(res.body.answer.indexOf('ตำบลข')<res.body.answer.indexOf('ตำบลก'));
 const direct=await request(app).post('/ai/chat').send({message:'ขอจำนวนผู้ป่วยเรียงตามตำบล จากมากไปน้อย'});
 assert.equal(direct.status,200);assert.equal(direct.body.meta.ollamaCalls,0);assert.match(direct.body.answer,/ตำบลก/);
 const fallback=await request(app).post('/ai/chat').send({message:'ช่วยดูยอดแยกตามหมู่บ้านแบบที่เยอะก่อน'});
 assert.equal(fallback.status,200);assert.equal(interpretations,1);assert.equal(fallback.body.meta.ollamaCalls,1);
});
test('spoken patient ranking counts every server page and preserves psychiatric subject',async()=>{
 const app=express();app.use(express.json());const calls=[];
 const people=[{id:1,tambon:'ก',amphoe:'เมือง',province:'นครพนม'},{id:2,tambon:'ข',amphoe:'เมือง',province:'นครพนม'},{id:3,tambon:'ข',amphoe:'เมือง',province:'นครพนม'}];
 app.use(createRealDataRoutes((req,res,next)=>{req.user={role:'officer',stationId:77};req.realToken='t';next();},{url:'https://example.test',key:'anon',request:async(url)=>{
  const u=new URL(url);calls.push(u);const types=u.pathname.endsWith('/people_type');const offset=Number(u.searchParams.get('offset')||0);
  return {ok:true,headers:new Headers({'content-range':types?'0-0/1':'0-1/3'}),json:async()=>types?[{type_id:9}]:people.slice(offset,offset+2)};
 }}));
 const r=await request(app).post('/ai/chat').send({message:'ตำบลไหนมีผู้ป่วยมากที่สุด'});
 assert.equal(r.status,200);assert.match(r.body.answer,/ตำบลข.*2 คน/);assert.match(r.body.answer,/ทั้งหมด 3 คน/);
 assert.equal(calls.filter(u=>u.pathname.endsWith('/people')).length,2);
 for(const u of calls.filter(u=>u.pathname.endsWith('/people'))){assert.equal(u.searchParams.get('type_id'),'in.(9)');assert.equal(u.searchParams.get('station_id'),'eq.77');}
 calls.length=0;
 await request(app).post('/ai/chat').send({message:'ผู้ป่วยจิตเวชมีทั้งหมดกี่คน'});
 assert.equal(calls[0].searchParams.get('type_name'),'ilike.*ผู้ป่วยจิตเวช*');
});
test('real registry ranking honors an explicit Top N and returns deterministic numbered rows',async()=>{
 const app=express();app.use(express.json());
 const people=[
  {id:1,tambon:'หนึ่ง',amphoe:'เมือง',province:'นครพนม'},{id:2,tambon:'หนึ่ง',amphoe:'เมือง',province:'นครพนม'},
  {id:3,tambon:'สอง',amphoe:'เมือง',province:'นครพนม'},{id:4,tambon:'สาม',amphoe:'เมือง',province:'นครพนม'},
  {id:5,tambon:'สี่',amphoe:'เมือง',province:'นครพนม'},{id:6,tambon:'ห้า',amphoe:'เมือง',province:'นครพนม'},
  {id:7,tambon:'หก',amphoe:'เมือง',province:'นครพนม'},
 ];
 app.use(createRealDataRoutes((req,res,next)=>{req.user={role:'officer',stationId:77,stationName:'สภ.บ้านดุง'};req.realToken='t';next();},{url:'https://example.test',key:'anon',request:async url=>{
  const types=new URL(url).pathname.endsWith('/people_type');
  return {ok:true,status:200,headers:new Headers({'content-range':types?'0-0/1':'0-6/7'}),json:async()=>types?[{type_id:9}]:people};
 }}));
 const res=await request(app).post('/ai/chat').send({message:'ขอ 5 อันดับตำบลที่มีผู้ป่วยเยอะที่สุด'});
 assert.equal(res.status,200);assert.equal(res.body.meta.fastPath,true);assert.equal(res.body.meta.ollamaCalls,0);assert.equal(res.body.presentation.type,'location_summary');assert.equal(res.body.presentation.items.length,5);assert.match(res.body.answer,/5 อันดับตำบลมากที่สุด/);
 for(const index of [1,2,3,4,5])assert.match(res.body.answer,new RegExp(`${index}\\. ตำบล`));
 assert.equal((res.body.answer.match(/^\d+\. ตำบล/gm)||[]).length,5,'Top 5 must return exactly five areas');
 assert.match(res.body.answer,/1\. ตำบลหนึ่ง.*2 คน/);
});
test('real overview without a category uses the audited target-person aggregate',async()=>{
 const app=express();app.use(express.json());
 const people=[
  {id:1,station_id:77,type_id:9,tambon:'ก'},{id:2,station_id:77,type_id:5,tambon:'ก'},
  {id:3,station_id:77,type_id:9,tambon:'ข'},{id:4,station_id:77,type_id:7,tambon:'ค'},
 ];
 app.use(createRealDataRoutes((req,res,next)=>{req.user={role:'officer',stationId:77,stationName:'สภ.บ้านดุง'};req.realToken='t';next();},{url:'https://example.test',key:'anon',request:async url=>{
  const u=new URL(url); const path=u.pathname;
  if(path.endsWith('/functions/v1/ai-summary'))return {ok:true,json:async()=>({report_type:'target_person_summary',scope:{level:'station',read_only:true,station_id:77},rows:[{station_id:77,station_name:'สภ.บ้านดุง',province:'อุดรธานี',psychiatric_total:2,drug_user_total:1,dealer_total:1,released_total:0,target_total:4}]})};
  if(path.endsWith('/people_type')) return {ok:true,headers:new Headers({'content-range':'0-2/3'}),json:async()=>[{type_id:9,type_name:'ผู้ป่วยจิตเวช'},{type_id:5,type_name:'ผู้เสพ'},{type_id:7,type_name:'ผู้ค้า'}]};
  if(path.endsWith('/stations')) return {ok:true,headers:new Headers({'content-range':'0-0/1'}),json:async()=>[{station_id:77,station_name:'สภ.บ้านดุง'}]};
  if(path.endsWith('/visits')) return {ok:true,headers:new Headers({'content-range':'0-1/2'}),json:async()=>[{id:1,person_id:1,visit_status:'เสี่ยงสูง',visit_date:'2026-09-01'},{id:2,person_id:2,visit_status:'เฝ้าระวัง',visit_date:'2026-09-01'}]};
  if(path.endsWith('/person_report_status')) return {ok:true,headers:new Headers({'content-range':'0--1/0'}),json:async()=>[]};
  assert.equal(u.searchParams.get('station_id'),'eq.77');
  return {ok:true,headers:new Headers({'content-range':'0-3/4'}),json:async()=>people};
 }}));
 const station=await request(app).post('/ai/chat').send({message:'ภาพรวม สภ.'});
 assert.equal(station.status,200);assert.equal(station.body.presentation.type,'target_person_summary');
 assert.equal(station.body.presentation.totals.total,4);assert.match(station.body.answer,/ผู้ป่วยจิตเวช 2/);assert.match(station.body.answer,/ผู้ค้า 1/);
 const province=await request(app).post('/ai/chat').send({message:'ภาพรวมจังหวัด'});
 assert.equal(province.status,200);assert.equal(province.body.presentation.type,'target_person_summary');
 assert.equal(province.body.presentation.rows[0].stationName,'สภ.บ้านดุง');
});
test('real registry failures have safe categories and never expose upstream details',async()=>{
 const app=express();app.use(express.json());
 app.use(createRealDataRoutes((req,res,next)=>{req.user={role:'officer',stationId:77};req.realToken='t';next();},{url:'https://example.test',key:'anon',request:async()=>({ok:false,status:403,headers:new Headers(),json:async()=>({message:'private upstream detail'})})}));
 const denied=await request(app).post('/ai/chat').send({message:'ผู้ป่วยมีกี่คน'});
 assert.equal(denied.status,403);assert.equal(denied.body.code,'REAL_ACCESS_DENIED');assert.equal(denied.body.error,'บัญชีนี้ไม่มีสิทธิ์อ่านข้อมูลจริงในขอบเขตที่ร้องขอ');
 const failedApp=express();failedApp.use(express.json());
 failedApp.use(createRealDataRoutes((req,res,next)=>{req.user={role:'officer',stationId:77};req.realToken='t';next();},{url:'https://example.test',key:'anon',request:async()=>{throw new Error('raw database record: Somchai');}}));
 const failed=await request(failedApp).post('/ai/chat').send({message:'ผู้ป่วยมีกี่คน'});
 assert.equal(failed.status,502);assert.equal(failed.body.code,'REAL_READ_FAILED');assert.ok(!JSON.stringify(failed.body).includes('Somchai'));
});
test('real registry reads bind authenticated station and token, without source writes',async()=>{
 const calls=[];const app=express();app.use(express.json());
 app.use(createRealDataRoutes((req,res,next)=>{req.user={role:'officer',stationId:77};req.realToken='real-user';next();},{url:'https://example.test',key:'anon',request:async(url,opts)=>{calls.push({url,opts});return {ok:true,headers:new Headers({'content-range':'0-0/1'}),json:async()=>[{id:1,first_name:'ตัวอย่าง',last_name:'ทดสอบ',tambon:'ตัวอย่าง'}]};}}));
 const response=await request(app).post('/ai/chat').send({message:'ขอรายชื่อทั้งหมด',station_id:999});
 assert.equal(response.status,200);assert.equal(response.body.dataSource,'real');assert.equal(calls.length,1);
 assert.equal(response.body.presentation.type,'person_list');
 assert.equal(response.body.presentation.items[0].person_id,1);
 assert.equal(response.body.presentation.items[0].full_name,'ตัวอย่าง ทดสอบ');
 assert.equal(new URL(calls[0].url).searchParams.get('station_id'),'eq.77');assert.equal(calls[0].opts.headers.Authorization,'Bearer real-user');assert.equal(calls[0].opts.method,undefined);
});
test('station-assigned admin still lists only their own station',async()=>{
 const calls=[];const app=express();app.use(express.json());
 app.use(createRealDataRoutes((req,res,next)=>{req.user={role:'admin',stationId:'2',stationName:'สภ.ท่าอุเทน',division:'ภ.จว.นครพนม'};req.realToken='t';next();},{url:'https://example.test',key:'anon',request:async url=>{
  const u=new URL(url);calls.push(u);
  return {ok:true,headers:new Headers({'content-range':'0-1/2'}),json:async()=>[{id:1,first_name:'ก',last_name:'ข',station_id:2,tambon:'ท่าอุเทน'},{id:2,first_name:'ค',last_name:'ง',station_id:2,tambon:'ท่าอุเทน'}]};
 }}));
 const res=await request(app).post('/ai/chat').send({message:'ขอรายชื่อทั้งหมด'});
 assert.equal(res.status,200);
 assert.equal(new URL(calls[0]).searchParams.get('station_id'),'eq.2');
 assert.ok(res.body.presentation.items.every(item=>item.full_name));
 assert.equal(res.body.presentation.items.length,2);
});
test('real people pagination requests the next offset in station scope',async()=>{
 const calls=[];const app=express();app.use(express.json());
 app.use(createRealDataRoutes((req,res,next)=>{req.user={role:'officer',stationId:2,stationName:'สภ.ท่าอุเทน'};req.realToken='t';next();},{url:'https://example.test',key:'anon',request:async url=>{
  calls.push(new URL(url));
  return {ok:true,headers:new Headers({'content-range':'20-39/45'}),json:async()=>[{id:21,first_name:'คน',last_name:'หน้าสอง',station_id:2,tambon:'ท่าอุเทน',amphoe:'ท่าอุเทน'}]};
 }}));
 const res=await request(app).get('/people?page=2&limit=20&person_type=drug_user');
 assert.equal(res.status,200);
 assert.equal(res.body.data[0].person_id,21);
 assert.equal(res.body.meta.total,45);
 const people=calls.find(u=>u.pathname.endsWith('/people'));
 assert.equal(people.searchParams.get('offset'),'20');
 assert.equal(people.searchParams.get('limit'),'20');
 assert.equal(people.searchParams.get('station_id'),'eq.2');
 const risk=await request(app).post('/ai/chat').send({message:'ใครเสี่ยงสูง'});
 assert.equal(risk.status,200);assert.equal(risk.body.grounded,true);
 assert.ok(!String(risk.body.answer).includes('อยู่ระหว่างเชื่อมต่อ'));
});
test('selected real person answers registry facts in station scope and still blocks visits',async()=>{
 const calls=[];const app=express();app.use(express.json());
 app.use(createRealDataRoutes((req,res,next)=>{req.user={role:'officer',stationId:77,stationName:'สภ.บ้านดุง'};req.realToken='real-user';next();},{url:'https://example.test',key:'anon',request:async(url,opts)=>{
  const u=new URL(url);calls.push({url:u,opts});
  if(u.pathname.endsWith('/people_type'))return {ok:true,headers:new Headers({'content-range':'0-0/1'}),json:async()=>[{type_id:5,type_name:'ผู้เสพ'}]};
  return {ok:true,headers:new Headers({'content-range':'0-0/1'}),json:async()=>[{id:9,prefix:'นาย',first_name:'สมหมาย',last_name:'ใจดี',birth_date:'1990-01-15',tambon:'บ้านดุง',amphoe:'บ้านดุง',province:'อุดรธานี',type_id:5,station_id:77,status:'สีเขียว',custody_status:'ปกติ/กำลังรักษาตัว'}]};
 }}));
 const tambon=await request(app).post('/ai/chat').send({message:'อยู่ตำบลอะไร',context:{personId:9}});
 assert.equal(tambon.status,200);assert.equal(tambon.body.grounded,true);
 assert.match(tambon.body.answer,/ตำบลบ้านดุง/);
 const people=calls.find(c=>c.url.pathname.endsWith('/people'));
 assert.equal(people.url.searchParams.get('id'),'eq.9');
 assert.equal(people.url.searchParams.get('station_id'),'eq.77');
 assert.equal(people.opts.headers.Authorization,'Bearer real-user');
 assert.ok(!String(people.url.searchParams.get('select')||'').includes('id_card'));
 const extra=await request(app).post('/ai/chat').send({message:'ขอข้อมูลเพิ่มเติม',context:{personId:9}});
 assert.match(extra.body.answer,/สมหมาย/);
 assert.match(extra.body.answer,/ตำบลบ้านดุง/);
 const age=await request(app).post('/ai/chat').send({message:'อายุเท่าไหร่',context:{personId:9}});
 assert.equal(age.status,200);assert.equal(age.body.grounded,true);
 assert.match(age.body.answer,/อายุ \d+ ปี/);
 assert.ok(!age.body.answer.includes('ต้องการจำนวน'));
 assert.ok(people.url.searchParams.get('select').includes('birth_date'));
 const visit=await request(app).post('/ai/chat').send({message:'เยี่ยมล่าสุดเมื่อไหร่',context:{personId:9}});
 assert.equal(visit.body.grounded,true);
 assert.ok(!visit.body.answer.includes('อยู่ระหว่างเชื่อมต่อ'));
});
test('real visits and recorded risk levels are read in station scope',async()=>{
 const calls=[];const app=express();app.use(express.json());
 app.use(createRealDataRoutes((req,res,next)=>{req.user={role:'officer',stationId:77,stationName:'สภ.บ้านดุง'};req.realToken='t';next();},{url:'https://example.test',key:'anon',request:async(url,opts)=>{
  const u=new URL(url);calls.push(u);
  if(u.pathname.endsWith('/people_type'))return {ok:true,headers:new Headers({'content-range':'0-0/1'}),json:async()=>[{type_id:5,type_name:'ผู้เสพ'}]};
  if(u.pathname.endsWith('/person_report_status'))return {ok:true,headers:new Headers({'content-range':'0-0/1'}),json:async()=>[{person_id:9,alert_level:'เสี่ยงสูง',alert_source:'abnormal',missed_days:2,last_report_date:'2026-09-10'}]};
  if(u.pathname.endsWith('/visits'))return {ok:true,headers:new Headers({'content-range':'0-0/1'}),json:async()=>[{id:3,person_id:9,visit_date:'2026-09-12',visit_time:'10:15:00',visit_status:'เฝ้าระวัง',drug_test_result:'ไม่พบสารเสพติด',notes:'ติดตามต่อ',visitor_name:'ร.ต.ท. ทดสอบ'}]};
  return {ok:true,headers:new Headers({'content-range':'0-0/1'}),json:async()=>[{id:9,prefix:'นาย',first_name:'สมหมาย',last_name:'ใจดี',tambon:'บ้านดุง',amphoe:'บ้านดุง',province:'อุดรธานี',type_id:5,station_id:77}]};
 }}));
 const history=await request(app).post('/ai/chat').send({message:'ขอดูประวัติการเยี่ยม',context:{personId:9}});
 assert.equal(history.status,200);assert.equal(history.body.grounded,true);
 assert.match(history.body.answer,/2026-09-12/);
 assert.match(history.body.answer,/เฝ้าระวัง/);
 const visitCall=calls.find(u=>u.pathname.endsWith('/visits'));
 assert.equal(visitCall.searchParams.get('person_id'),'eq.9');
 assert.ok(!String(visitCall.searchParams.get('select')).includes('visitor_phone'));
 const why=await request(app).post('/ai/chat').send({message:'เสี่ยงสูงเพราะอะไร',context:{personId:9}});
 assert.match(why.body.answer,/เสี่ยงสูง/);
 assert.match(why.body.answer,/รายงานผู้ดูแล/);
 const list=await request(app).post('/ai/chat').send({message:'ใครเสี่ยงสูง'});
 assert.equal(list.body.grounded,true);
 assert.equal(list.body.presentation.type,'person_list');
 assert.equal(list.body.presentation.items[0].person_id,9);
 const people=calls.find(u=>u.pathname.endsWith('/people') && u.searchParams.get('station_id')==='eq.77');
 assert.ok(people);
});
test('existence questions answer with a count or none, without asking for more detail',async()=>{
 let interpretations=0;
 const app=express();app.use(express.json());
 app.use(createRealDataRoutes((req,res,next)=>{req.user={role:'officer',stationId:77,stationName:'สภ.บ้านดุง'};req.realToken='t';next();},{
  interpret:async()=>{interpretations++;return {action:'clarify',person_type:'all',group:'none',direction:'desc'};},
  url:'https://example.test',key:'anon',request:async url=>{
   const u=new URL(url);const types=u.pathname.endsWith('people_type');
   return {ok:true,headers:new Headers({'content-range':types?'0-0/1':'0-2/3'}),json:async()=>types?[{type_id:5}]:[{id:1},{id:2},{id:3}]};
  }}));
 const present=await request(app).post('/ai/chat').send({message:'ผู้เสพมีมั้ย'});
 assert.equal(present.status,200);
 assert.equal(interpretations,0);
 assert.equal(present.body.meta.fastPath,true);
 assert.equal(present.body.answer,'มีผู้เสพ 3 คน');
 const emptyApp=express();emptyApp.use(express.json());
 emptyApp.use(createRealDataRoutes((req,res,next)=>{req.user={role:'officer',stationId:77};req.realToken='t';next();},{
  url:'https://example.test',key:'anon',request:async url=>{
   const types=new URL(url).pathname.endsWith('people_type');
   return {ok:true,headers:new Headers({'content-range':types?'0-0/1':'0--1/0'}),json:async()=>types?[{type_id:5}]:[]};
  }}));
 const absent=await request(emptyApp).post('/ai/chat').send({message:'ผู้เสพมีไหม'});
 assert.equal(absent.status,200);
 assert.equal(absent.body.answer,'ไม่มีผู้เสพ');
});
