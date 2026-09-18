const {test}=require('node:test');const assert=require('node:assert/strict');const express=require('express');const request=require('supertest');
const {createRealDataRoutes}=require('../src/routes/realDataRoutes');
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
 assert.equal(res.status,200);assert.match(res.body.answer,/5 อันดับตำบลมากที่สุด/);
 for(const index of [1,2,3,4,5])assert.match(res.body.answer,new RegExp(`${index}\\. ตำบล`));
 assert.equal((res.body.answer.match(/^\d+\. ตำบล/gm)||[]).length,5,'Top 5 must return exactly five areas');
 assert.match(res.body.answer,/1\. ตำบลหนึ่ง.*2 คน/);
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
 const response=await request(app).post('/ai/chat').send({message:'ขอรายชื่อ',station_id:999});
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
 const res=await request(app).post('/ai/chat').send({message:'ขอรายชื่อ'});
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
