const {test}=require('node:test');const assert=require('node:assert/strict');const express=require('express');const request=require('supertest');
const {createRealDataRoutes}=require('../src/routes/realDataRoutes');
const {detectOverview}=require('../src/services/overviewService');

function makeApp(user,mockRequest,overrides={}){
 const app=express();app.use(express.json());
 app.use(createRealDataRoutes((req,res,next)=>{req.user=user;req.realToken='verified-session';next();},
  {url:'https://example.test',key:'anon',request:mockRequest,...overrides}));
 return app;
}

test('a close province transcription is corrected inside the authenticated scope and reported',async()=>{
 const reads=[];
 const app=makeApp({role:'officer',stationId:77,aiScope:{level:'all',read_only:true,provinces:['นครพนม','อุดรธานี']}},
  async(url)=>{reads.push(String(url));throw new Error('a province correction must not read the registry');});
 const res=await request(app).post('/ai/chat').send({message:'เปลี่ยนจังหวัดนครพนมม'});
 assert.equal(res.status,200);
 assert.equal(res.body.conversation.topic.province,'นครพนม');
 assert.equal(res.body.meta.fuzzy.field,'province');
 assert.equal(res.body.meta.fuzzy.from,'นครพนมม');
 assert.equal(res.body.meta.fuzzy.to,'นครพนม');
 assert.match(res.body.answer,/ตั้งค่าจังหวัด/);
 assert.equal(reads.length,0);
});

test('a partial province name asks the officer to choose instead of guessing',async()=>{
 const app=makeApp({role:'officer',stationId:77,aiScope:{level:'all',read_only:true,provinces:['นครพนม','นครสวรรค์']}},
  async()=>{throw new Error('an ambiguous province must not read the registry');});
 const res=await request(app).post('/ai/chat').send({message:'เปลี่ยนจังหวัดนคร'});
 assert.equal(res.status,200);
 assert.equal(res.body.presentation.type,'place_choices');
 assert.equal(res.body.presentation.field,'province');
 assert.equal(res.body.presentation.choices.length,2);
 const first=res.body.presentation.choices[0];
 assert.equal(first.display,'จังหวัดนครพนม');
 assert.equal(first.replaceWith,'นครพนม');
 // The follow-up the interface would send for the first choice resolves cleanly.
 assert.equal(res.body.presentation.originalMessage.replace(res.body.presentation.replaceText,first.replaceWith),'เปลี่ยนจังหวัดนครพนม');
 const retry=await request(app).post('/ai/chat').send({message:'เปลี่ยนจังหวัดนครพนม'});
 assert.equal(retry.status,200);assert.equal(retry.body.conversation.topic.province,'นครพนม');
});

test('an unrelated province name is still rejected instead of being fuzzed',async()=>{
 const app=makeApp({role:'officer',stationId:77,aiScope:{level:'all',read_only:true,provinces:['นครพนม']}},
  async()=>{throw new Error('must not read');});
 const res=await request(app).post('/ai/chat').send({message:'เปลี่ยนจังหวัดกุกกุก'});
 assert.equal(res.status,422);assert.equal(res.body.code,'REAL_LOCATION_NOT_FOUND');assert.match(res.body.error,/ไม่พบชื่อจังหวัด/);
});

test('a misspelled subdistrict is fuzzy-corrected from scoped registry areas',async()=>{
 const calls=[];
 const rows=[{id:1,first_name:'ก',last_name:'ใจดี',station_id:77,province:'นครพนม',amphoe:'เมือง',tambon:'โพนสูง',type_id:1,status:'ปกติ'},
  {id:2,first_name:'ข',last_name:'ใจดี',station_id:77,province:'นครพนม',amphoe:'เมือง',tambon:'โพนสูง',type_id:1,status:'ปกติ'}];
 const app=makeApp({role:'officer',stationId:77},async(url)=>{
  const u=new URL(url);calls.push(u);
  if(u.pathname.endsWith('/people')){
   if(u.searchParams.get('select')==='province,amphoe,tambon'){
    return {ok:true,headers:new Headers({'content-range':'0-1/2'}),json:async()=>[{province:'นครพนม',amphoe:'เมือง',tambon:'โพนสูง'},{province:'นครพนม',amphoe:'เมือง',tambon:'วังใหญ่'}]};
   }
   const tambon=u.searchParams.get('tambon')||'';
   if(tambon==='ilike.*โพนสุง*')return {ok:true,headers:new Headers({'content-range':'0--1/0'}),json:async()=>[]};
   return {ok:true,headers:new Headers({'content-range':'0-1/2'}),json:async()=>rows};
  }
  throw new Error('unexpected read '+url);
 });
 const res=await request(app).get('/people?subdistrict='+encodeURIComponent('โพนสุง'));
 assert.equal(res.status,200);
 assert.equal(res.body.data.length,2);
 assert.equal(res.body.meta.fuzzy.field,'subdistrict');
 assert.equal(res.body.meta.fuzzy.from,'โพนสุง');
 assert.equal(res.body.meta.fuzzy.to,'โพนสูง');
 const retried=calls.filter(u=>u.pathname.endsWith('/people')&&u.searchParams.get('tambon')==='ilike.*โพนสูง*');
 assert.equal(retried.length,1);
 assert.equal(retried[0].searchParams.get('amphoe'),'ilike.*เมือง*');
 assert.equal(retried[0].searchParams.get('station_id'),'eq.77');
});

test('a truncated subdistrict name returns numbered choices instead of a wrong list',async()=>{
 const app=makeApp({role:'admin',stationId:null},async(url)=>{
  const u=new URL(url);
  if(u.pathname.endsWith('/people')){
   if(u.searchParams.get('select')==='province,amphoe,tambon'){
    return {ok:true,headers:new Headers({'content-range':'0-1/2'}),json:async()=>[
     {province:'นครพนม',amphoe:'เมือง',tambon:'โพนทองคำ'},{province:'นครพนม',amphoe:'ธาตุพนม',tambon:'โพนทองเจริญ'}]};
   }
   return {ok:true,headers:new Headers({'content-range':'0--1/0'}),json:async()=>[]};
  }
  throw new Error('unexpected read '+url);
 });
 const res=await request(app).get('/people?subdistrict='+encodeURIComponent('โพนทอง'));
 assert.equal(res.status,200);
 assert.equal(res.body.presentation.type,'place_choices');
 assert.equal(res.body.presentation.field,'subdistrict');
 assert.equal(res.body.presentation.choices.length,2);
 assert.match(res.body.presentation.choices[0].display,/อำเภอเมือง/);
 assert.equal(res.body.presentation.choices[0].filters.district,'เมือง');
 assert.match(res.body.answer,/กรุณาเลือก/);
});

test('an unknown subdistrict still fails with the explicit check-and-retry error',async()=>{
 const app=makeApp({role:'officer',stationId:77},async(url)=>{
  const u=new URL(url);
  if(u.pathname.endsWith('/people')){
   if(u.searchParams.get('select')==='province,amphoe,tambon'){
    return {ok:true,headers:new Headers({'content-range':'0-0/1'}),json:async()=>[{province:'นครพนม',amphoe:'เมือง',tambon:'วังใหญ่'}]};
   }
   return {ok:true,headers:new Headers({'content-range':'0--1/0'}),json:async()=>[]};
  }
  throw new Error('unexpected read '+url);
 });
 const res=await request(app).get('/people?subdistrict='+encodeURIComponent('โพนสุง'));
 assert.equal(res.status,422);assert.equal(res.body.code,'REAL_LOCATION_NOT_FOUND');assert.match(res.body.error,/ไม่พบข้อมูลตามชื่อตำบล “โพนสุง”/);
});

test('a mistyped station name resolves to the officer own station and never to another',async()=>{
 const calls=[];
 const app=makeApp({role:'officer',stationId:77},async(url)=>{
  const u=new URL(url);calls.push(u);
  if(u.pathname.endsWith('/stations')){
   if(u.searchParams.get('station_name')==='ilike.*ท่าอุเทนน*'){
    return {ok:true,headers:new Headers({'content-range':'0--1/0'}),json:async()=>[]};
   }
   return {ok:true,headers:new Headers({'content-range':'0-1/2'}),json:async()=>[{station_id:77,station_name:'สภ.ท่าอุเทน'},{station_id:78,station_name:'สภ.อื่น'}]};
  }
  if(u.pathname.endsWith('/people')){
   return {ok:true,headers:new Headers({'content-range':'0-0/1'}),json:async()=>[{id:1,first_name:'ก',last_name:'ใจดี',station_id:77,province:'นครพนม',amphoe:'เมือง',tambon:'โพนสูง',type_id:1,status:'ปกติ'}]};
  }
  throw new Error('unexpected read '+url);
 });
 const res=await request(app).get('/people?station='+encodeURIComponent('ท่าอุเทนน'));
 assert.equal(res.status,200);
 assert.equal(res.body.data.length,1);
 assert.equal(res.body.meta.fuzzy.field,'station');
 assert.equal(res.body.meta.fuzzy.from,'ท่าอุเทนน');
 assert.equal(res.body.meta.fuzzy.to,'สภ.ท่าอุเทน');
 const peopleCall=calls.find(u=>u.pathname.endsWith('/people'));
 assert.equal(peopleCall.searchParams.get('station_id'),'eq.77');
});

test('overview gives a named station precedence over its province, including spoken station prefixes',async()=>{
 for(const prefix of ['สภ.','สพ','สอพอ','สภอ']){
  const parsed=detectOverview(`ขอภาพรวมของ ${prefix} ธวัชบุรี จังหวัดร้อยเอ็ด`);
  assert.equal(parsed.requestedScope,'station');
  assert.equal(parsed.filters.station,'ธวัชบุรี');
 }
 const calls=[];
 const app=makeApp({role:'officer',stationId:77,aiScope:{level:'all',read_only:true,provinces:['ร้อยเอ็ด']}},async(url)=>{
  const u=new URL(url);calls.push(u);
  if(u.pathname.endsWith('/stations')){
   if(u.searchParams.get('station_name')==='ilike.*ธวัชบูรี*'){
    assert.equal(u.searchParams.get('province'),'eq.ร้อยเอ็ด');
    return {ok:true,headers:new Headers({'content-range':'0--1/0'}),json:async()=>[]};
   }
   if(u.searchParams.get('select')==='station_id,station_name'){
    assert.equal(u.searchParams.get('province'),'eq.ร้อยเอ็ด');
    return {ok:true,headers:new Headers({'content-range':'0-0/1'}),json:async()=>[{station_id:201,station_name:'สภ.ธวัชบุรี'}]};
   }
   if(u.searchParams.get('province')==='eq.ร้อยเอ็ด')return {ok:true,headers:new Headers({'content-range':'0-0/1'}),json:async()=>[{station_id:201}]};
  }
  if(u.pathname.endsWith('/people_type'))return {ok:true,headers:new Headers({'content-range':'0-0/1'}),json:async()=>[{type_id:1,type_name:'ผู้ป่วยจิตเวช'}]};
  if(u.pathname.endsWith('/people')){
   if(u.searchParams.get('select')==='id,province,amphoe,tambon,type_id,station_id'){
    assert.equal(u.searchParams.get('station_id'),'in.(201)');
    return {ok:true,headers:new Headers({'content-range':'0-0/1'}),json:async()=>[{id:1,station_id:201,province:'ร้อยเอ็ด',amphoe:'ธวัชบุรี',tambon:'นิเวศน์',type_id:1}]};
   }
   // The two recorded-monitoring reads must keep the same selected station.
   assert.equal(u.searchParams.get('station_id'),'in.(201)');
   return {ok:true,headers:new Headers({'content-range':'0--1/0'}),json:async()=>[]};
  }
  throw new Error('unexpected read '+url);
 });
 const res=await request(app).post('/ai/chat').send({message:'ขอภาพรวมของ สอพอ ธวัชบูรี จังหวัดร้อยเอ็ด'});
 assert.equal(res.status,200);
 assert.equal(res.body.presentation.type,'overview');
 assert.equal(res.body.presentation.scopeLabel,'สภ.ธวัชบุรี');
 assert.equal(res.body.presentation.filters.station,'สภ.ธวัชบุรี');
 assert.equal(res.body.conversation.topic.station,'สภ.ธวัชบุรี');
 assert.ok(calls.some(u=>u.pathname.endsWith('/stations')&&u.searchParams.get('select')==='station_id,station_name'));
});

test('voice-style politeness particles and Thai digits work on the real chat path',async()=>{
 const people=[
  {id:1,tambon:'หนึ่ง',amphoe:'เมือง',province:'นครพนม'},{id:2,tambon:'หนึ่ง',amphoe:'เมือง',province:'นครพนม'},
  {id:3,tambon:'สอง',amphoe:'เมือง',province:'นครพนม'},{id:4,tambon:'สาม',amphoe:'เมือง',province:'นครพนม'},
  {id:5,tambon:'สี่',amphoe:'เมือง',province:'นครพนม'},{id:6,tambon:'ห้า',amphoe:'เมือง',province:'นครพนม'},
  {id:7,tambon:'หก',amphoe:'เมือง',province:'นครพนม'},
 ];
 const app=makeApp({role:'officer',stationId:77,stationName:'สภ.บ้านดุง'},async url=>{
  const types=new URL(url).pathname.endsWith('/people_type');
  return {ok:true,status:200,headers:new Headers({'content-range':types?'0-0/1':'0-6/7'}),json:async()=>types?[{type_id:9}]:people};
 });
 const res=await request(app).post('/ai/chat').send({message:'ขอ ๕ อันดับตำบลที่มีผู้ป่วยเยอะที่สุดครับ'});
 assert.equal(res.status,200);
 assert.equal(res.body.presentation.type,'location_summary');
 assert.equal(res.body.presentation.items.length,5);
 assert.match(res.body.answer,/5 อันดับตำบลมากที่สุด/);
 assert.equal(res.body.meta.fuzzy,undefined);
});

test('processing preflight classifies the normalized utterance without data access',async()=>{
 const app=makeApp({role:'officer',stationId:77},async()=>{throw new Error('preflight must not call data');});
 const res=await request(app).post('/ai/chat/processing').send({message:'เปลี่ยนจังหวัดนครพนมครับ'});
 assert.equal(res.status,200);
 assert.equal(res.body.willUseLocalAi,false);
});
