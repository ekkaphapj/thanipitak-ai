const {test}=require('node:test');const assert=require('node:assert/strict');const express=require('express');const request=require('supertest');
const {createRealDataRoutes}=require('../src/routes/realDataRoutes');
test('real registry reads bind authenticated station and token, without source writes',async()=>{
 const calls=[];const app=express();app.use(express.json());
 app.use(createRealDataRoutes((req,res,next)=>{req.user={role:'officer',stationId:77};req.realToken='real-user';next();},{url:'https://example.test',key:'anon',request:async(url,opts)=>{calls.push({url,opts});return {ok:true,headers:new Headers({'content-range':'0-0/1'}),json:async()=>[{id:1,first_name:'ตัวอย่าง',last_name:'ทดสอบ',tambon:'ตัวอย่าง'}]};}}));
 const response=await request(app).post('/ai/chat').send({message:'ขอรายชื่อ',station_id:999});
 assert.equal(response.status,200);assert.equal(response.body.dataSource,'real');assert.equal(calls.length,1);
 assert.equal(new URL(calls[0].url).searchParams.get('station_id'),'eq.77');assert.equal(calls[0].opts.headers.Authorization,'Bearer real-user');assert.equal(calls[0].opts.method,undefined);
 const risk=await request(app).post('/ai/chat').send({message:'ใครเสี่ยงสูง'});assert.equal(risk.body.grounded,false);assert.equal(calls.length,1);
});
