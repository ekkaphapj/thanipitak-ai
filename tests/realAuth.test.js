const {test}=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
const request=require('supertest');
const {createRealAuthRoutes}=require('../src/routes/realAuthRoutes');
test('real login verifies credentials remotely then reads only the authenticated profile',async()=>{
 const calls=[];const app=express();app.use(express.json());
 app.use(createRealAuthRoutes({url:'https://example.test',key:'public-test',request:async(url,opts)=>{
  calls.push({url,opts});
  return {ok:true,json:async()=>url.includes('/token?')?{access_token:'real-token'}:url.endsWith('/user')?{id:'uuid'}:url.includes('/stations?')?[{station_id:2,station_name:'สภ.ท่าอุเทน',division:'ภ.จว.นครพนม',province:'นครพนม'}]:[{user_id:8,username:'4648',name:'Example',user_type:'User',station_id:2}]};
 }}));
 const res=await request(app).post('/login').send({username:'4648',password:'test-pin'});
 assert.equal(res.status,200);assert.equal(res.body.user.dataSource,'real');
 assert.equal(JSON.parse(calls[0].opts.body).email,'4648@thaniphitak.local');
 assert.equal(calls[2].opts.headers.Authorization,'Bearer real-token');
 assert.equal(calls.length,4);
 assert.equal(new URL(calls[3].url).searchParams.get('station_id'),'eq.2');
 assert.equal(calls[3].opts.headers.Authorization,'Bearer real-token');
 assert.equal(res.body.user.stationName,'สภ.ท่าอุเทน');
 assert.equal(res.body.user.division,'ภ.จว.นครพนม');
 const me=await request(app).get('/me').set('Authorization','Bearer real-token');
 assert.equal(me.body.user.stationName,'สภ.ท่าอุเทน');
});
test('real login never falls back to test accounts on rejection',async()=>{
 const app=express();app.use(express.json());app.use(createRealAuthRoutes({url:'https://example.test',key:'public-test',request:async()=>({ok:false})}));
 const res=await request(app).post('/login').send({username:'station1_off',password:'thanipitak123'});
 assert.equal(res.status,401);assert.equal(res.body.token,undefined);
});
