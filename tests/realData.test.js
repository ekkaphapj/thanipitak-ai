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
 assert.equal(res.status,200);assert.equal(interpretations,1);assert.equal(res.body.meta.ollamaCalls,1);assert.equal(res.body.meta.fastPath,false);
 assert.ok(res.body.answer.indexOf('ตำบลข')<res.body.answer.indexOf('ตำบลก'));
 const direct=await request(app).post('/ai/chat').send({message:'ขอจำนวนผู้ป่วยเรียงตามตำบล จากมากไปน้อย'});
 assert.equal(direct.status,200);assert.equal(direct.body.meta.ollamaCalls,0);assert.match(direct.body.answer,/ตำบลก/);
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
test('real count answers disclose station scope and effective filters',async()=>{
 const app=express();app.use(express.json());
 app.use(createRealDataRoutes((req,res,next)=>{req.user={role:'officer',stationId:77,stationName:'สภ.บ้านดุง',division:'อุดรธานี',province:'อุดรธานี'};req.realToken='t';next();},{url:'https://example.test',key:'anon',request:async url=>{
  const u=new URL(url);const types=u.pathname.endsWith('people_type');
  return {ok:true,headers:new Headers({'content-range':types?'0-0/1':'0-0/154'}),json:async()=>types?[{type_id:9}]:[]};
 }}));
 const r=await request(app).post('/ai/chat').send({message:'ผู้ป่วยจิตเวชมีทั้งหมดกี่คน'});
 assert.equal(r.status,200);assert.match(r.body.answer,/ข้อมูลจริง • สภ\.บ้านดุง/);assert.match(r.body.answer,/ผู้ป่วยจิตเวช/);assert.match(r.body.answer,/พบ 154 คน/);assert.doesNotMatch(r.body.answer,/ตามสิทธิ์และเงื่อนไขที่ค้นหา/);
});
test('real registry reads bind authenticated station and token, without source writes',async()=>{
 const calls=[];const app=express();app.use(express.json());
 app.use(createRealDataRoutes((req,res,next)=>{req.user={role:'officer',stationId:77};req.realToken='real-user';next();},{url:'https://example.test',key:'anon',request:async(url,opts)=>{calls.push({url,opts});return {ok:true,headers:new Headers({'content-range':'0-0/1'}),json:async()=>[{id:1,first_name:'ตัวอย่าง',last_name:'ทดสอบ',tambon:'ตัวอย่าง'}]};}}));
 const response=await request(app).post('/ai/chat').send({message:'ขอรายชื่อ',station_id:999});
 assert.equal(response.status,200);assert.equal(response.body.dataSource,'real');assert.equal(calls.length,1);
 assert.equal(new URL(calls[0].url).searchParams.get('station_id'),'eq.77');assert.equal(calls[0].opts.headers.Authorization,'Bearer real-user');assert.equal(calls[0].opts.method,undefined);
 const risk=await request(app).post('/ai/chat').send({message:'ใครเสี่ยงสูง'});assert.equal(risk.body.grounded,false);assert.equal(calls.length,1);
});
