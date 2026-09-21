const {test}=require('node:test');const assert=require('node:assert/strict');const express=require('express');const request=require('supertest');
const {createRealDataRoutes}=require('../src/routes/realDataRoutes');

function makeApp(user,mockRequest,overrides={}){
 const app=express();app.use(express.json());
 app.use(createRealDataRoutes((req,res,next)=>{req.user=user;req.realToken='verified-session';next();},
  {url:'https://example.test',key:'anon',request:mockRequest,...overrides}));
 return app;
}

test('province people lists resolve through stations so stored text mismatch cannot empty them',async()=>{
 const calls=[];
 const app=makeApp({role:'admin',stationId:null},async(url)=>{
  const u=new URL(url);calls.push(u);
  if(u.pathname.endsWith('/stations')&&u.searchParams.get('province')==='eq.ร้อยเอ็ด'){
   return {ok:true,headers:new Headers({'content-range':'0-1/2'}),json:async()=>[{station_id:201},{station_id:202}]};
  }
  if(u.pathname.endsWith('/people')){
   // Registry rows whose stored province text does not match the requested
   // name: the report must still be filled through the station mapping.
   return {ok:true,headers:new Headers({'content-range':'0-1/2'}),json:async()=>[
    {id:1,first_name:'ก',last_name:'ใจดี',station_id:201,province:'รอยเอ็ด',amphoe:'เมือง',tambon:'ค้อ',type_id:1,status:'ปกติ'},
    {id:2,first_name:'ข',last_name:'ใจดี',station_id:202,province:'',amphoe:'เมือง',tambon:'หนองใหม่',type_id:1,status:'ปกติ'}]};
  }
  throw new Error('unexpected read '+url);
 });
 const res=await request(app).get('/people?province='+encodeURIComponent('ร้อยเอ็ด'));
 assert.equal(res.status,200);
 assert.equal(res.body.data.length,2);
 const peopleCall=calls.find(u=>u.pathname.endsWith('/people'));
 assert.equal(peopleCall.searchParams.get('station_id'),'in.(201,202)');
 assert.equal(peopleCall.searchParams.get('province'),null);
});

test('an own-station account asking another province gets an explicit empty result, never other stations',async()=>{
 const app=makeApp({role:'officer',stationId:77},async(url)=>{
  const u=new URL(url);
  if(u.pathname.endsWith('/stations'))return {ok:true,headers:new Headers({'content-range':'0-1/2'}),json:async()=>[{station_id:201},{station_id:202}]};
  if(u.pathname.endsWith('/people'))throw new Error('must not query people outside the own station');
  throw new Error('unexpected read '+url);
 });
 const res=await request(app).get('/people?province='+encodeURIComponent('ร้อยเอ็ด'));
 assert.equal(res.status,200);
 assert.equal(res.body.data.length,0);
 assert.equal(res.body.meta.total,0);
});

test('the confirmed aggregate PDF asks the audited tool for the requested province and uses its rows',async()=>{
 const bodies=[];
 const app=makeApp({role:'officer',stationId:77,province:'ร้อยเอ็ด',aiScope:{level:'all',read_only:true}},async(url,opts)=>{
  if(String(url).includes('/functions/v1/ai-summary')){
   bodies.push(JSON.parse(opts.body));
   return {ok:true,json:async()=>({report_type:'target_person_summary',scope:{level:'all',read_only:true},rows:[
    {station_name:'สภ.เมือง',province:'ร้อยเอ็ด',psychiatric_total:1200,drug_user_total:2000,dealer_total:180,released_total:44,target_total:3424},
    {station_name:'สภ.จางวางภาค',province:'ร้อยเอ็ด',psychiatric_total:900,drug_user_total:1500,dealer_total:100,released_total:22,target_total:2522}]})};
  }
  throw new Error('aggregate reports must use the audited tool only');
 });
 const res=await request(app).post('/reports/summary.pdf').send({reportRequest:{report_kind:'target_person_aggregate',filters:{province:'ร้อยเอ็ด'},includeCount:true,includeList:true}});
 assert.equal(res.status,200);
 assert.match(res.headers['content-type'],/application\/pdf/);
 assert.equal(bodies.length,1);
 assert.equal(bodies[0].province,'ร้อยเอ็ด');
 assert.equal(bodies[0].summary_kind,'target_people');
});

test('an aggregate overview answers with the requested province in the heading',async()=>{
 const app=makeApp({role:'officer',stationId:77,aiScope:{level:'all',read_only:true,provinces:['ร้อยเอ็ด','นครพนม']}},async(url)=>{
  if(String(url).includes('/functions/v1/ai-summary')){
   return {ok:true,json:async()=>({report_type:'target_person_summary',scope:{level:'all',read_only:true},rows:[{station_name:'สภ.เมือง',province:'ร้อยเอ็ด',psychiatric_total:1,drug_user_total:2,dealer_total:0,released_total:0,target_total:3}]})};
  }
  throw new Error('unexpected read '+url);
 });
 const res=await request(app).post('/ai/chat').send({message:'ขอภาพรวมจังหวัดร้อยเอ็ด'});
 assert.equal(res.status,200);
 assert.equal(res.body.presentation.type,'target_person_summary');
 assert.equal(res.body.presentation.scopeLabel,'จังหวัดร้อยเอ็ด');
 assert.match(res.body.answer,/ภาพรวมบุคคลเป้าหมาย • จังหวัดร้อยเอ็ด/);
 assert.equal(res.body.conversation.topic.province,'ร้อยเอ็ด');
 assert.equal(res.body.conversation.topic.report_kind,'target_person_aggregate');
});

test('a typed aggregate request without an explicit province keeps the account default heading',async()=>{
 const app=makeApp({role:'officer',stationId:77,province:'ร้อยเอ็ด',aiScope:{level:'all',read_only:true}},async(url)=>{
  if(String(url).includes('/functions/v1/ai-summary')){
   return {ok:true,json:async()=>({report_type:'target_person_summary',scope:{level:'all',read_only:true},rows:[{station_name:'สภ.เมือง',province:'ร้อยเอ็ด',psychiatric_total:1,drug_user_total:2,dealer_total:0,released_total:0,target_total:3}]})};
  }
  throw new Error('unexpected read '+url);
 });
 const res=await request(app).post('/ai/chat').send({message:'ขอภาพรวม'});
 assert.equal(res.status,200);
 assert.equal(res.body.presentation.scopeLabel,'จังหวัดร้อยเอ็ด');
});

test('a province named without the keyword overrides the account profile province',async()=>{
 const bodies=[];
 const app=makeApp({role:'officer',stationId:77,province:'อุดรธานี',stationName:'สภ.บ้านดุง',aiScope:{level:'all',read_only:true,provinces:['อุดรธานี','ร้อยเอ็ด','นครพนม']}},async(url,opts)=>{
  if(String(url).includes('/functions/v1/ai-summary')){
   bodies.push(JSON.parse(opts.body));
   return {ok:true,json:async()=>({report_type:'target_person_summary',scope:{level:'all',read_only:true},rows:[{station_name:'สภ.เมือง',province:'ร้อยเอ็ด',psychiatric_total:1,drug_user_total:2,dealer_total:0,released_total:0,target_total:3}]})};
  }
  throw new Error('unexpected read '+url);
 });
 const res=await request(app).post('/ai/chat').send({message:'ขอภาพรวมร้อยเอ็ด'});
 assert.equal(res.status,200);
 assert.equal(res.body.presentation.scopeLabel,'จังหวัดร้อยเอ็ด');
 assert.match(res.body.answer,/จังหวัดร้อยเอ็ด/);
 assert.equal(bodies.length,1);
 assert.equal(bodies[0].province,'ร้อยเอ็ด');
 assert.equal(res.body.conversation.topic.province,'ร้อยเอ็ด');
});

test('two provinces named without a keyword ask the officer to choose',async()=>{
 const app=makeApp({role:'officer',stationId:77,province:'อุดรธานี',aiScope:{level:'all',read_only:true,provinces:['อุดรธานี','ร้อยเอ็ด','นครพนม']}},async()=>{
  throw new Error('an ambiguous province must not read data');
 });
 const res=await request(app).post('/ai/chat').send({message:'เทียบร้อยเอ็ดกับนครพนมภาพรวมใครเยอะกว่า'});
 assert.equal(res.status,200);
 assert.equal(res.body.presentation.type,'place_choices');
 assert.equal(res.body.presentation.choices.length,2);
 const first=res.body.presentation.choices[0];
 assert.equal(first.display,'จังหวัดร้อยเอ็ด');
 assert.equal(first.replaceText,'ร้อยเอ็ด');
});

test('a message without any province name keeps the conversation province',async()=>{
 const bodies=[];
 const app=makeApp({role:'officer',stationId:77,province:'อุดรธานี',aiScope:{level:'all',read_only:true,provinces:['อุดรธานี','ร้อยเอ็ด']}},async(url,opts)=>{
  if(String(url).includes('/functions/v1/ai-summary')){
   bodies.push(JSON.parse(opts.body));
   return {ok:true,json:async()=>({report_type:'target_person_summary',scope:{level:'all',read_only:true},rows:[{station_name:'สภ.เมือง',province:'อุดรธานี',psychiatric_total:1,drug_user_total:2,dealer_total:0,released_total:0,target_total:3}]})};
  }
  throw new Error('unexpected read '+url);
 });
 const res=await request(app).post('/ai/chat').send({message:'ขอภาพรวม',context:{topic:{province:'อุดรธานี'}}});
 assert.equal(res.status,200);
 assert.equal(res.body.presentation.scopeLabel,'จังหวัดอุดรธานี');
 assert.equal(bodies[0].province,'อุดรธานี');
});

test('province-scoped station ranking states the requested province in the heading',async()=>{
 const app=makeApp({role:'admin',stationId:null},async(url)=>{
  const u=new URL(url);
  if(u.pathname.endsWith('/stations')&&u.searchParams.get('province')==='eq.ร้อยเอ็ด'){
   return {ok:true,headers:new Headers({'content-range':'0-0/1'}),json:async()=>[{station_id:201}]};
  }
  if(u.pathname.endsWith('/people_type'))return {ok:true,headers:new Headers({'content-range':'0-0/1'}),json:async()=>[{type_id:9}]};
  if(u.pathname.endsWith('/people'))return {ok:true,headers:new Headers({'content-range':'0-1/2'}),json:async()=>[{id:1,tambon:'ค้อ',amphoe:'เมือง',province:'รอยเอ็ด',type_id:9},{id:2,tambon:'ค้อ',amphoe:'เมือง',province:'รอยเอ็ด',type_id:9}]};
  throw new Error('unexpected read '+url);
 });
 const res=await request(app).post('/ai/chat').send({message:'ตำบลไหนมีผู้ป่วยมากที่สุดในจังหวัดร้อยเอ็ด',context:{topic:{province:'ร้อยเอ็ด'}}});
 assert.equal(res.status,200);
 assert.match(res.body.answer,/ข้อมูลจริง • จังหวัดร้อยเอ็ด/);
 assert.match(res.body.answer,/ตำบลค้อ.*มีผู้ป่วยจิตเวชมากสุด 2 คน/);
});
