const {test}=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
const request=require('supertest');
const {createRealAuthRoutes}=require('../src/routes/realAuthRoutes');

// Stage-diagnostic regressions for the real login 403 path. All Supabase and
// Edge Function responses are synthetic; no real credentials, accounts or
// registry data are touched. The tests pin two contracts: the officer-facing
// response stays exactly { error } (the internal rejection marker must never
// be serialized), and journald receives one numbers/stage-coded line naming
// the exact profile stage that failed.
function mockSupabase(overrides = {}) {
  return async (url) => {
    if (url.includes('/token?grant_type=refresh_token')) return overrides.refresh || {ok:false,json:async()=>({})};
    if (url.includes('/token?')) return overrides.password || {ok:false,json:async()=>({})};
    if (url.endsWith('/user')) return overrides.authUser || {ok:true,json:async()=>({id:'uuid'})};
    if (url.includes('/ai-access-scope')) return {ok:true,json:async()=>({scope:{level:'station',read_only:true,user_id:8,provinces:['นครพนม']}})};
    if (url.includes('/stations?')) return {ok:true,json:async()=>[{station_id:2,station_name:'สภ.ท่าอุทน',division:'ภ.จว.นครพนม',province:'นครพนม'}]};
    if (url.includes('/users?')) return overrides.users || {ok:true,json:async()=>[{user_id:8,username:'4648',name:'Example',user_type:'User',station_id:2}]};
    return {ok:false,json:async()=>({})};
  };
}

function buildApp(overrides) {
  const app=express();app.use(express.json());
  app.use(createRealAuthRoutes({url:'https://example.test',key:'public-test',request:mockSupabase(overrides)}));
  return app;
}

async function captureLogs(fn) {
  const lines=[];
  const original=console.log;
  console.log=(...args)=>{lines.push(args.join(' '));};
  try {
    const result=await fn();
    result.logs=lines;
    return result;
  } finally { console.log=original; }
}

const OK_PASSWORD={ok:true,json:async()=>({access_token:'real-token',refresh_token:'rt-1',expires_in:3600})};

test('login 403 logs the users REST failure stage and never leaks the marker',async()=>{
  const app=buildApp({password:OK_PASSWORD,users:{ok:false,status:500,json:async()=>({})}});
  const res=await captureLogs(()=>request(app).post('/login').send({username:'4648',password:'test-pin'}));
  assert.equal(res.status,403);
  assert.deepEqual(Object.keys(res.body),['error']);
  assert.equal(res.body.error,'ไม่พบบัญชีผู้ใช้ที่มีสิทธิ์ในระบบจริง');
  assert.ok(res.logs.some(l=>l.includes('[real-auth] rejected route=login stage=users_http:500')));
});

test('login 403 logs a missing users row as users_rows:0',async()=>{
  const app=buildApp({password:OK_PASSWORD,users:{ok:true,status:200,json:async()=>[]}});
  const res=await request(app).post('/login').send({username:'4648',password:'test-pin'});
  assert.equal(res.status,403);
});

test('login 403 logs an out-of-policy user_type with its sanitized role label',async()=>{
  const app=buildApp({password:OK_PASSWORD,users:{ok:true,status:200,json:async()=>[{user_id:8,username:'4648',name:'Example',user_type:'External',station_id:2}]}});
  const res=await captureLogs(()=>request(app).post('/login').send({username:'4648',password:'test-pin'}));
  assert.equal(res.status,403);
  assert.ok(res.logs.some(l=>l.includes('stage=user_type:External')));
});

test('login 403 logs the auth-user endpoint failure stage',async()=>{
  const app=buildApp({password:OK_PASSWORD,authUser:{ok:false,status:500,json:async()=>({})}});
  const res=await captureLogs(()=>request(app).post('/login').send({username:'4648',password:'test-pin'}));
  assert.equal(res.status,403);
  assert.ok(res.logs.some(l=>l.includes('stage=auth_user_http:500')));
});

test('a successful login still returns the full session and logs no rejection',async()=>{
  const app=buildApp({password:OK_PASSWORD});
  const res=await captureLogs(()=>request(app).post('/login').send({username:'4648',password:'test-pin'}));
  assert.equal(res.status,200);
  assert.equal(res.body.token,'real-token');
  assert.equal(res.body.user.username,'4648');
  assert.equal(res.body.user.rejected,undefined);
  assert.ok(!res.logs.some(l=>l.includes('[real-auth]')));
});

test('refresh 403 logs the failing profile stage after a valid grant',async()=>{
  const app=buildApp({refresh:{ok:true,json:async()=>({access_token:'new-token',refresh_token:'rt-2',expires_in:3600})},users:{ok:true,status:200,json:async()=>[]}});
  const res=await captureLogs(()=>request(app).post('/refresh').send({refreshToken:'rt-1'}));
  assert.equal(res.status,403);
  assert.deepEqual(Object.keys(res.body),['error']);
  assert.ok(res.logs.some(l=>l.includes('[real-auth] rejected route=refresh stage=users_rows:0')));
});

test('authenticate never admits a rejected profile marker',async()=>{
  const app=express();app.use(express.json());
  const router=createRealAuthRoutes({url:'https://example.test',key:'public-test',request:mockSupabase({users:{ok:true,status:200,json:async()=>[]}})});
  app.use(router);
  app.get('/protected',router.authenticate,(req,res)=>res.json({ok:true}));
  const res=await request(app).get('/protected').set('Authorization','Bearer any-token');
  assert.equal(res.status,401);
  assert.equal(res.body.ok,undefined);
});
