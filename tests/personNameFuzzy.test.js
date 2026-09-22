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

const CATALOGUE_SELECT='id,first_name,last_name,tambon,amphoe';
const SEARCH_SELECT='id,first_name,last_name,station_id,province,amphoe,tambon,type_id,status';

test('a close name transcription retries the single scoped match and reports it',async()=>{
 const calls=[];
 const app=makeApp({role:'officer',stationId:77,stationName:'สภ.ทดสอบ'},async(url)=>{
  const u=new URL(url);calls.push(u);
  if(u.pathname.endsWith('/people')){
   const select=u.searchParams.get('select');
   if(select===CATALOGUE_SELECT){
    assert.equal(u.searchParams.get('station_id'),'eq.77');
    return ok([{id:9,first_name:'สมชาย',last_name:'ใจดี',tambon:'โพนสูง',amphoe:'เมือง'}],'0-0/1');
   }
   if(select===SEARCH_SELECT){
    if(u.searchParams.get('id')==='eq.9')return ok([{id:9,first_name:'สมชาย',last_name:'ใจดี',station_id:77,province:'นครพนม',amphoe:'เมือง',tambon:'โพนสูง',type_id:2,status:'active'}],'0-0/1');
    // The misspelled exact search must cover both name columns.
    assert.equal(u.searchParams.get('or'),'(first_name.ilike.*สมชายย*,last_name.ilike.*สมชายย*)');
    return ok([],'0--1/0');
   }
   throw new Error('unexpected people read '+select);
  }
  throw new Error('unexpected read '+url);
 });
 const res=await request(app).post('/ai/chat').send({message:'ค้นหาชื่อสมชายย'});
 assert.equal(res.status,200);
 assert.equal(res.body.presentation.total,1);
 assert.equal(res.body.presentation.items[0].full_name,'สมชาย ใจดี');
 assert.equal(res.body.meta.fuzzy.field,'search');
 assert.equal(res.body.meta.fuzzy.from,'สมชายย');
 assert.equal(res.body.meta.fuzzy.to,'สมชาย ใจดี');
 const retried=calls.filter(u=>u.pathname.endsWith('/people')&&u.searchParams.get('id')==='eq.9');
 assert.equal(retried.length,1);
});

test('an ambiguous close name returns numbered person choices',async()=>{
 const app=makeApp({role:'officer',stationId:77,stationName:'สภ.ทดสอบ'},async(url)=>{
  const u=new URL(url);
  if(u.pathname.endsWith('/people')){
   const select=u.searchParams.get('select');
   if(select===CATALOGUE_SELECT){
    return ok([
     {id:9,first_name:'สมชาย',last_name:'ใจดี',tambon:'โพนสูง',amphoe:'เมือง'},
     {id:11,first_name:'สมชาย',last_name:'แสงทอง',tambon:'วังใหญ่',amphoe:'เมือง'},
    ],'0-1/2');
   }
   if(select===SEARCH_SELECT)return ok([],'0--1/0');
   throw new Error('unexpected people read '+select);
  }
  throw new Error('unexpected read '+url);
 });
 const res=await request(app).post('/ai/chat').send({message:'ค้นหาชื่อสมชายย'});
 assert.equal(res.status,200);
 assert.equal(res.body.presentation.type,'place_choices');
 assert.equal(res.body.presentation.field,'search');
 assert.equal(res.body.presentation.choiceLabel,'ตัวเลือกชื่อ');
 assert.equal(res.body.presentation.originalMessage,'ค้นหาชื่อสมชายย');
 const names=res.body.presentation.choices.map(choice=>choice.name);
 assert.deepEqual(names.sort(),['สมชาย ใจดี','สมชาย แสงทอง'].sort());
 for(const choice of res.body.presentation.choices)assert.match(choice.display,/ตำบล/);
 // The interface would substitute the chosen verified name into the command.
 const chosen=res.body.presentation.choices.find(choice=>choice.name==='สมชาย ใจดี');
 const followup=res.body.presentation.originalMessage.replace(chosen.replaceText||res.body.presentation.replaceText,chosen.replaceWith);
 assert.equal(followup,'ค้นหาชื่อสมชาย ใจดี');
});

test('a name with no scoped candidate stays an honest not-found list',async()=>{
 const app=makeApp({role:'officer',stationId:77,stationName:'สภ.ทดสอบ'},async(url)=>{
  const u=new URL(url);
  if(u.pathname.endsWith('/people')){
   const select=u.searchParams.get('select');
   if(select===CATALOGUE_SELECT)return ok([{id:9,first_name:'สมชาย',last_name:'ใจดี',tambon:'โพนสูง',amphoe:'เมือง'}],'0-0/1');
   if(select===SEARCH_SELECT)return ok([],'0--1/0');
   throw new Error('unexpected people read '+select);
  }
  throw new Error('unexpected read '+url);
 });
 const res=await request(app).post('/ai/chat').send({message:'ค้นหาชื่อกุกกุก'});
 assert.equal(res.status,200);
 assert.equal(res.body.presentation.total,0);
 assert.equal(res.body.meta.fuzzy,undefined);
});

test('a last-name-only search matches through the or-filter without fuzzy',async()=>{
 const calls=[];
 const app=makeApp({role:'officer',stationId:77,stationName:'สภ.ทดสอบ'},async(url)=>{
  const u=new URL(url);calls.push(u);
  if(u.pathname.endsWith('/people')){
   assert.equal(u.searchParams.get('select'),SEARCH_SELECT);
   assert.equal(u.searchParams.get('or'),'(first_name.ilike.*ใจดี*,last_name.ilike.*ใจดี*)');
   return ok([{id:9,first_name:'สมชาย',last_name:'ใจดี',station_id:77,province:'นครพนม',amphoe:'เมือง',tambon:'โพนสูง',type_id:2,status:'active'}],'0-0/1');
  }
  throw new Error('unexpected read '+url);
 });
 const res=await request(app).post('/ai/chat').send({message:'ค้นหาชื่อใจดี'});
 assert.equal(res.status,200);
 assert.equal(res.body.presentation.total,1);
 assert.equal(res.body.presentation.items[0].full_name,'สมชาย ใจดี');
 assert.equal(calls.filter(u=>u.searchParams.get('select')===CATALOGUE_SELECT).length,0);
});
