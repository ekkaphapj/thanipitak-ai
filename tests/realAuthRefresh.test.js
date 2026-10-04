const {test}=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
const request=require('supertest');
const {createRealAuthRoutes}=require('../src/routes/realAuthRoutes');

// Mocked Supabase + Edge Function responses. No real credentials, no live
// registry: every response is synthetic and the interpreter chain is never
// called beyond the profile verification the login/refresh routes perform.
function mockSupabase(calls, sessionByGrant) {
  return async(url,opts)=>{
    calls.push({url,opts});
    if (url.includes('/token?grant_type=refresh_token')) return sessionByGrant.refresh;
    if (url.includes('/token?')) return sessionByGrant.password;
    if (url.endsWith('/user')) return {ok:true,json:async()=>({id:'uuid'})};
    if (url.includes('/ai-access-scope')) return {ok:true,json:async()=>({scope:{level:'station',read_only:true,user_id:8,provinces:['นครพนม']}})};
    if (url.includes('/stations?')) return {ok:true,json:async()=>[{station_id:2,station_name:'สภ.ท่าอุเทน',division:'ภ.จว.นครพนม',province:'นครพนม'}]};
    if (url.includes('/users?')) return {ok:true,json:async()=>[{user_id:8,username:'4648',name:'Example',user_type:'User',station_id:2}]};
    return {ok:false,json:async()=>({})};
  };
}

function buildApp(sessionByGrant) {
  const calls=[];
  const app=express();app.use(express.json());
  app.use(createRealAuthRoutes({url:'https://example.test',key:'public-test',request:mockSupabase(calls,sessionByGrant)}));
  return {app,calls};
}

test('login returns the refresh token and expiry so the session can be renewed',async()=>{
  const {app,calls}=buildApp({
    password:{ok:true,json:async()=>({access_token:'real-token',refresh_token:'rt-1',expires_in:3600})},
    refresh:{ok:false,json:async()=>({})},
  });
  const res=await request(app).post('/login').send({username:'4648',password:'test-pin'});
  assert.equal(res.status,200);
  assert.equal(res.body.token,'real-token');
  assert.equal(res.body.refreshToken,'rt-1');
  assert.equal(res.body.expiresIn,3600);
  assert.equal(res.body.user.dataSource,'real');
  assert.equal(calls.filter(c=>c.url.includes('/token?')).length,1);
});

test('refresh exchanges the grant, re-verifies the profile and returns the rotated token',async()=>{
  const {app,calls}=buildApp({
    password:{ok:false,json:async()=>({})},
    refresh:{ok:true,json:async()=>({access_token:'new-token',refresh_token:'rt-2',expires_in:3600})},
  });
  const res=await request(app).post('/refresh').send({refreshToken:'rt-1'});
  assert.equal(res.status,200);
  assert.equal(res.body.token,'new-token');
  assert.equal(res.body.refreshToken,'rt-2');
  assert.equal(res.body.expiresIn,3600);
  assert.equal(res.body.user.username,'4648');
  assert.equal(res.body.user.stationName,'สภ.ท่าอุเทน');
  // The whole profile chain ran again with the refreshed token: auth user,
  // users row, station row and the Edge Function scope.
  const afterGrant=calls.slice(calls.findIndex(c=>c.url.includes('grant_type=refresh_token'))+1);
  assert.equal(afterGrant.length,4);
  assert.ok(afterGrant.every(c=>c.opts.headers.Authorization==='Bearer new-token'));
});

test('refresh fails closed on a rejected grant without any registry or scope read',async()=>{
  const {app,calls}=buildApp({
    password:{ok:false,json:async()=>({})},
    refresh:{ok:false,status:400,json:async()=>({error:'Invalid Refresh Token'})},
  });
  const res=await request(app).post('/refresh').send({refreshToken:'revoked'});
  assert.equal(res.status,401);
  assert.equal(res.body.token,undefined);
  assert.equal(calls.filter(c=>c.url.includes('/users?')||c.url.includes('/ai-access-scope')).length,0);
});

test('refresh refuses a valid grant for an account that no longer has privileges',async()=>{
  const calls=[];
  const app=express();app.use(express.json());
  app.use(createRealAuthRoutes({url:'https://example.test',key:'public-test',request:async(url,opts)=>{
    calls.push({url,opts});
    if (url.includes('/token?grant_type=refresh_token')) return {ok:true,json:async()=>({access_token:'new-token',refresh_token:'rt-2',expires_in:3600})};
    if (url.endsWith('/user')) return {ok:true,json:async()=>({id:'uuid'})};
    if (url.includes('/users?')) return {ok:true,json:async()=>[]};
    return {ok:false,json:async()=>({})};
  }}));
  const res=await request(app).post('/refresh').send({refreshToken:'rt-1'});
  assert.equal(res.status,403);
  assert.equal(res.body.token,undefined);
  // A demoted/External account never receives the refreshed access token.
  assert.equal(JSON.stringify(res.body).includes('new-token'),false);
});

test('refresh rejects a missing refresh token and maps connection failures to 502',async()=>{
  const {app}=buildApp({
    password:{ok:false,json:async()=>({})},
    refresh:{ok:true,json:async()=>({access_token:'new-token'})},
  });
  const missing=await request(app).post('/refresh').send({});
  assert.equal(missing.status,400);
  const blank=await request(app).post('/refresh').send({refreshToken:'   '});
  assert.equal(blank.status,400);
  const down=express();down.use(express.json());
  down.use(createRealAuthRoutes({url:'https://example.test',key:'public-test',request:async()=>{throw new Error('offline');}}));
  const res=await request(down).post('/refresh').send({refreshToken:'rt-1'});
  assert.equal(res.status,502);
});
