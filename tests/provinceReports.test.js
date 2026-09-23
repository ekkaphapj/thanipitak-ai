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

test('a server-verified cross-province scope lists the chosen province, not the profile station',async()=>{
 const calls=[];
 const app=makeApp({role:'officer',stationId:77,province:'อุดรธานี',aiScope:{level:'all',read_only:true,provinces:['อุดรธานี','นครพนม']}},async(url)=>{
  const u=new URL(url);calls.push(u);
  if(u.pathname.endsWith('/stations')&&u.searchParams.get('province')==='eq.นครพนม'){
   return {ok:true,headers:new Headers({'content-range':'0-1/2'}),json:async()=>[{station_id:201},{station_id:202}]};
  }
  if(u.pathname.endsWith('/people')){
   return {ok:true,headers:new Headers({'content-range':'0-1/2'}),json:async()=>[
    {id:1,first_name:'ก',last_name:'นครพนม',station_id:201,province:'นครพนม',amphoe:'เมือง',tambon:'ในเมือง',type_id:1,status:'active'},
    {id:2,first_name:'ข',last_name:'นครพนม',station_id:202,province:'นครพนม',amphoe:'ท่าอุเทน',tambon:'พนม',type_id:1,status:'active'},
   ]};
  }
  throw new Error('unexpected read '+url);
 });
 const selected=await request(app).post('/ai/chat').send({message:'เลือกจังหวัดนครพนม'});
 assert.equal(selected.status,200);
 assert.equal(selected.body.conversation.topic.province,'นครพนม');
 const listed=await request(app).post('/ai/chat').send({message:'ขอรายชื่อ',context:{topic:selected.body.conversation.topic}});
 assert.equal(listed.status,200);
 assert.equal(listed.body.presentation.type,'person_list');
 assert.equal(listed.body.presentation.total,2);
 const people=calls.find((u)=>u.pathname.endsWith('/people'));
 assert.equal(people.searchParams.get('station_id'),'in.(201,202)');
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

test('a spoken sort follow-up reorders the preceding station aggregate instead of alphabetizing it',async()=>{
 const bodies=[];
 const app=makeApp({role:'officer',stationId:77,province:'อุดรธานี',aiScope:{level:'all',read_only:true,provinces:['อุดรธานี']}},async(url,opts)=>{
  if(String(url).includes('/functions/v1/ai-summary')){
   bodies.push(JSON.parse(opts.body));
   return {ok:true,json:async()=>({report_type:'target_person_summary',scope:{level:'all',read_only:true},rows:[
    {station_name:'สภ.เมืองอุดรธานี',province:'อุดรธานี',psychiatric_total:8,drug_user_total:12,dealer_total:2,released_total:1,target_total:23},
    {station_name:'สภ.กุดจับ',province:'อุดรธานี',psychiatric_total:2,drug_user_total:3,dealer_total:1,released_total:0,target_total:6},
   ]})};
  }
  throw new Error('unexpected read '+url);
 });
 const overview=await request(app).post('/ai/chat').send({message:'ขอภาพรวมราย สภ. ในจังหวัดอุดรธานี'});
 assert.equal(overview.status,200);
 assert.equal(overview.body.presentation.type,'target_person_summary');
 assert.deepEqual(overview.body.presentation.rows.map(row=>row.stationName),['สภ.เมืองอุดรธานี','สภ.กุดจับ'],'unsorted overview keeps database row order');
 assert.equal(overview.body.conversation.topic.report_kind,'target_person_aggregate');
 const sorted=await request(app).post('/ai/chat').send({message:'ให้เรียยง (ลำดับจากมากไปน้อย)',context:{topic:overview.body.conversation.topic}});
 assert.equal(sorted.status,200);
 assert.equal(sorted.body.presentation.type,'station_ranking');
 assert.deepEqual(sorted.body.presentation.rows.map(row=>row.stationName),['สภ.เมืองอุดรธานี','สภ.กุดจับ']);
 assert.match(sorted.body.answer,/เรียงบุคคลทั้งหมดมากไปน้อย/);
 const alphabetic=await request(app).post('/ai/chat').send({message:'เรียงตามตัวอักษร',context:{topic:overview.body.conversation.topic}});
 assert.equal(alphabetic.status,200);
 assert.deepEqual(alphabetic.body.presentation.rows.map(row=>row.stationName),['สภ.กุดจับ','สภ.เมืองอุดรธานี']);
 assert.match(alphabetic.body.answer,/เรียงตามตัวอักษร/);
 assert.equal(bodies.length,3);
 assert.ok(bodies.every(body=>body.province==='อุดรธานี'));
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

test('a cross-station scope can search a station by name without own-station narrowing',async()=>{
 const calls=[];
 const app=makeApp({role:'officer',stationId:5,province:'อุดรธานี',aiScope:{level:'all',read_only:true,provinces:['อุดรธานี','นครพนม']}},async(url)=>{
  const u=new URL(url);calls.push(u);
  if(u.pathname.endsWith('/stations')&&u.searchParams.get('station_name')==='ilike.*ท่าอุเทน*'){
   return okRows([{station_id:9}]);
  }
  if(u.pathname.endsWith('/people')){
   assert.equal(u.searchParams.get('station_id'),'in.(9)');
   return okRows([{id:1,first_name:'สมชาย',last_name:'ใจดี',station_id:9,province:'นครพนม',amphoe:'เมือง',tambon:'โพนสูง',type_id:2,status:'active'}]);
  }
  throw new Error('unexpected read '+url);
 });
 const res=await request(app).get('/people?station='+encodeURIComponent('ท่าอุเทน'));
 assert.equal(res.status,200);
 assert.equal(res.body.data.length,1);
 assert.equal(res.body.data[0].station_id,9);
 assert.equal(res.body.data[0].full_name,'สมชาย ใจดี');
});
function okRows(rows){
 return {ok:true,headers:new Headers({'content-range':`0-${rows.length-1}/${rows.length}`}),json:async()=>rows};
}
