const {test}=require('node:test');const assert=require('node:assert/strict');const express=require('express');const request=require('supertest');
const {createRealDataRoutes}=require('../src/routes/realDataRoutes');
const {extractTimeWindow,analyzePeriods}=require('../src/ai/timeWindow');

function makeApp(user,mockRequest,overrides={}){
 const app=express();app.use(express.json());
 app.use(createRealDataRoutes((req,res,next)=>{req.user=user;req.realToken='verified-session';next();},
  {url:'https://example.test',key:'anon',request:mockRequest,
   // Never touch a real Ollama from route tests: an unmocked interpreter call
   // must fail the test loudly instead of hanging on the local model.
   interpret:async(message)=>{throw new Error(`unexpected interpret call: ${message}`);},
   ...overrides}));
 return app;
}
const ok=(rows,range)=>({ok:true,headers:new Headers({'content-range':range||`0-${rows.length-1}/${rows.length}`}),json:async()=>rows});
const VISIT_SELECT='id,person_id,visit_date,visit_time,visit_status,drug_test_result,status_condition,notes,visitor_name,visitor_station,visit_category';
const MONITOR_SELECT='id,prefix,first_name,last_name,tambon,amphoe,province,type_id,station_id,status';

test('ใครเสี่ยงสูงเดือนนี้ reads only visits dated inside the requested month',async()=>{
 const window=extractTimeWindow('เดือนนี้');
 const reads=[];
 const peopleRows=[
  {id:1,prefix:'นาย',first_name:'สมชาย',last_name:'ใจดี',tambon:'โพนสูง',amphoe:'เมือง',type_id:2,station_id:77,status:'active'},
  {id:2,prefix:'นาง',first_name:'สมหญิง',last_name:'แสงทอง',tambon:'วังใหญ่',amphoe:'เมือง',type_id:2,station_id:77,status:'active'},
 ];
 const app=makeApp({role:'officer',stationId:77,stationName:'สภ.ทดสอบ'},async(url)=>{
  const u=new URL(url);reads.push(u);
  if(u.pathname.endsWith('/people')){
   if(u.searchParams.get('select')===MONITOR_SELECT)return ok(peopleRows,'0-1/2');
   throw new Error('unexpected people read '+u.searchParams.get('select'));
  }
  if(u.pathname.endsWith('/visits')){
   const bounds=u.searchParams.getAll('visit_date');
   assert.deepEqual(bounds.sort(),[`gte.${window.from}`,`lte.${window.to}`].sort());
   return ok([{id:9,person_id:2,visit_date:'2026-09-10',visit_status:'เสี่ยงสูง'}],'0-0/1');
  }
  if(u.pathname.endsWith('/person_report_status')){
   const bounds=u.searchParams.getAll('last_report_date');
   assert.deepEqual(bounds.sort(),[`gte.${window.from}`,`lte.${window.to}`].sort());
   return ok([],'0--1/0');
  }
  throw new Error('unexpected read '+url);
 });
 const res=await request(app).post('/ai/chat').send({message:'ใครเสี่ยงสูงเดือนนี้'});
 assert.equal(res.status,200);
 assert.match(res.body.answer,/ช่วงเดือนนี้/);
 assert.match(res.body.answer,/สมหญิง/);
 assert.match(res.body.answer,/อ้างอิงเฉพาะบันทึกที่อยู่ในช่วง/);
 assert.equal(res.body.presentation.total,1);
 assert.equal(res.body.meta.fastPath,true);
});

test('a selected person visit count honours เดือนที่แล้ว',async()=>{
 const window=extractTimeWindow('เดือนที่แล้ว');
 const reads=[];
 const app=makeApp({role:'officer',stationId:77,stationName:'สภ.ทดสอบ'},async(url)=>{
  const u=new URL(url);reads.push(u);
  if(u.pathname.endsWith('/people')){
   const select=u.searchParams.get('select');
   if(select.startsWith('id,prefix,first_name')){
    assert.equal(u.searchParams.get('id'),'eq.5');
    return ok([{id:5,prefix:'นาย',first_name:'สมชาย',last_name:'ใจดี',nickname:'',gender:'',birth_date:'1990-01-01',tambon:'โพนสูง',amphoe:'เมือง',province:'นครพนม',moo:'',village_name:'',house_number:'',station_id:77,type_id:2,status:'active',custody_status:null}],'0-0/1');
   }
   throw new Error('unexpected people read '+select);
  }
  if(u.pathname.endsWith('/people_type'))return ok([{type_id:2,type_name:'ผู้เสพ'}],'0-0/1');
  if(u.pathname.endsWith('/visits')){
   assert.equal(u.searchParams.get('person_id'),'eq.5');
   assert.deepEqual(u.searchParams.getAll('visit_date').sort(),[`gte.${window.from}`,`lte.${window.to}`].sort());
   return ok([{id:1,person_id:5,visit_date:'2026-08-05',visit_status:'อาการปกติ'},{id:2,person_id:5,visit_date:'2026-08-20',visit_status:'ปกติ'}],'0-1/2');
  }
  if(u.pathname.endsWith('/person_report_status'))return ok([],'0--1/0');
  throw new Error('unexpected read '+url);
 });
 const res=await request(app).post('/ai/chat').send({message:'เดือนที่แล้วเยี่ยมกี่ครั้ง',context:{personId:5,topic:null}});
 assert.equal(res.status,200);
 assert.match(res.body.answer,/ในเดือนที่แล้ว/);
 assert.match(res.body.answer,/2 ครั้ง/);
 assert.ok(!/ทั้งหมด \d+ ครั้ง(?!ใน)/.test(res.body.answer));
});

test('a plain count with a period asks instead of silently answering all-time',async()=>{
 const app=makeApp({role:'officer',stationId:77},async()=>{throw new Error('a period question must not read the registry silently');});
 const res=await request(app).post('/ai/chat').send({message:'ผู้เสพเดือนนี้มีกี่คน'});
 assert.equal(res.status,200);
 assert.equal(res.body.grounded,false);
 assert.match(res.body.answer,/วันที่ลงทะเบียน/);
 assert.match(res.body.answer,/นับจากทะเบียนปัจจุบัน/);
 assert.equal(res.body.presentation.type,'summary_choices');
 assert.equal(res.body.conversation.topic.pending.type,'period_intent');
 assert.equal(res.body.conversation.topic.pending.person_type,'drug_user');
 assert.ok(res.body.conversation.topic.pending.window.from);
});

test('an unresolvable period on a monitoring question stays unsupported',async()=>{
 const app=makeApp({role:'officer',stationId:77},async()=>{throw new Error('must not read');});
 const res=await request(app).post('/ai/chat').send({message:'ใครเสี่ยงสูงไตรมาสที่แล้ว'});
 assert.equal(res.status,200);
 assert.equal(res.body.grounded,false);
 assert.match(res.body.answer,/ช่วงเวลา/);
});

test('ผู้เสพยกเว้นตำบลโพนสูงมีกี่คน applies a server-side not-filter',async()=>{
 const calls=[];
 const peopleRows=[1,2,3].map(id=>({id,first_name:`ก${id}`,last_name:'ทดสอบ',station_id:77,province:'นครพนม',amphoe:'เมือง',tambon:'วังใหญ่',type_id:2,status:'active'}));
 const app=makeApp({role:'officer',stationId:77},async(url)=>{
  const u=new URL(url);calls.push(u);
  if(u.pathname.endsWith('/people')){
   const select=u.searchParams.get('select');
   if(select==='province,amphoe,tambon')return ok([{province:'นครพนม',amphoe:'เมือง',tambon:'โพนสูง'},{province:'นครพนม',amphoe:'เมือง',tambon:'วังใหญ่'}],'0-1/2');
   if(select.startsWith('id,first_name')){
    assert.equal(u.searchParams.get('not.tambon'),'ilike.*โพนสูง*');
    assert.equal(u.searchParams.get('station_id'),'eq.77');
    return ok(peopleRows,'0-2/3');
   }
   throw new Error('unexpected people read '+select);
  }
  if(u.pathname.endsWith('/people_type')){
   assert.match(u.searchParams.get('type_name'),/ผู้เสพ/);
   return ok([{type_id:2}],'0-0/1');
  }
  throw new Error('unexpected read '+url);
 });
 const res=await request(app).post('/ai/chat').send({message:'ผู้เสพยกเว้นตำบลโพนสูงมีกี่คน'});
 assert.equal(res.status,200);
 assert.equal(res.body.answer,'มีผู้เสพ 3 คน (ไม่รวมตำบลโพนสูง)');
});

test('an exclusion naming an unknown ตำบล guides with the officer station and asks for ตำบล/อำเภอ/จังหวัด',async()=>{
 const app=makeApp({role:'officer',stationId:77,stationName:'สภ.ทดสอบ',province:'นครพนม'},async(url)=>{
  const u=new URL(url);
  if(u.pathname.endsWith('/people')&&u.searchParams.get('select')==='province,amphoe,tambon')return ok([{province:'นครพนม',amphoe:'เมือง',tambon:'โพนสูง'}],'0-0/1');
  throw new Error('unexpected read '+url);
 });
 const res=await request(app).post('/ai/chat').send({message:'ผู้เสพยกเว้นตำบลกุกกุกมีกี่คน'});
 assert.equal(res.status,200);
 assert.equal(res.body.grounded,true);
 assert.match(res.body.answer,/ไม่พบตำบล“กุกกุก”/);
 assert.match(res.body.answer,/เขต สภ\.ทดสอบ/);
 assert.match(res.body.answer,/จังหวัดนครพนม/);
 assert.match(res.body.answer,/ระบุตำบล อำเภอ และจังหวัด/);
});

test('an unknown อำเภอ on a multi-province account asks which province instead of erroring',async()=>{
 const app=makeApp({role:'admin',stationId:null,aiScope:{level:'all',read_only:true,provinces:['นครพนม','ขอนแก่น']},province:'นครพนม'},async(url)=>{
  const u=new URL(url);
  if(u.pathname.endsWith('/people')){
   const select=u.searchParams.get('select');
   if(select==='province,amphoe,tambon')return ok([{province:'นครพนม',amphoe:'เมือง',tambon:'โพนสูง'}],'0-0/1');
   if(select&&select.startsWith('id,first_name'))return ok([],'0--1/0');
   throw new Error('unexpected people read '+select);
  }
  if(u.pathname.endsWith('/stations')&&u.searchParams.get('province')==='eq.นครพนม')return ok([{station_id:77}],'0-0/1');
  if(u.pathname.endsWith('/people_type'))return ok([{type_id:2}],'0-0/1');
  throw new Error('unexpected read '+url);
 });
 const res=await request(app).post('/ai/chat').send({message:'ผู้เสพในอำเภอกุกกุกมีกี่คน'});
 assert.equal(res.status,200);
 assert.equal(res.body.grounded,true);
 assert.match(res.body.answer,/อำเภอนี้อยู่จังหวัดอะไร/);
 assert.match(res.body.answer,/ระบุจังหวัดในคำสั่งเดียวกัน/);
});

test('an unknown ตำบล on a positive filter guides instead of erroring',async()=>{
 const app=makeApp({role:'officer',stationId:77,stationName:'สภ.ทดสอบ',province:'นครพนม'},async(url)=>{
  const u=new URL(url);
  if(u.pathname.endsWith('/people')){
   const select=u.searchParams.get('select');
   if(select==='province,amphoe,tambon')return ok([{province:'นครพนม',amphoe:'เมือง',tambon:'โพนสูง'}],'0-0/1');
   if(select&&select.startsWith('id,first_name'))return ok([],'0--1/0');
   throw new Error('unexpected people read '+select);
  }
  if(u.pathname.endsWith('/stations')&&u.searchParams.get('province')==='eq.นครพนม')return ok([{station_id:77}],'0-0/1');
  if(u.pathname.endsWith('/people_type'))return ok([{type_id:2}],'0-0/1');
  throw new Error('unexpected read '+url);
 });
 const res=await request(app).post('/ai/chat').send({message:'ผู้เสพในตำบลกุกกุกมีกี่คน'});
 assert.equal(res.status,200);
 assert.equal(res.body.grounded,true);
 assert.match(res.body.answer,/ไม่พบตำบล“กุกกุก”/);
 assert.match(res.body.answer,/เขต สภ\.ทดสอบ/);
});

test('an ambiguous exclusion offers verified choices and the follow-up resolves',async()=>{
 const areaRows=[
  {province:'นครพนม',amphoe:'เมือง',tambon:'โพนสูง'},
  {province:'นครพนม',amphoe:'เมือง',tambon:'โพนทอง'},
 ];
 const peopleRows=[{id:1,first_name:'ก',last_name:'ทดสอบ',station_id:77,province:'นครพนม',amphoe:'เมือง',tambon:'โพนทอง',type_id:2,status:'active'}];
 const serve=async(url)=>{
  const u=new URL(url);
  if(u.pathname.endsWith('/people')){
   const select=u.searchParams.get('select');
   if(select==='province,amphoe,tambon')return ok(areaRows,'0-1/2');
   if(select.startsWith('id,first_name')){
    if(u.searchParams.get('not.tambon')==='ilike.*โพนสูง*')return ok(peopleRows,'0-0/1');
    return ok([],'0--1/0');
   }
  }
  if(u.pathname.endsWith('/people_type'))return ok([{type_id:2}],'0-0/1');
  throw new Error('unexpected read '+url);
 };
 const app=makeApp({role:'officer',stationId:77},serve);
 const res=await request(app).post('/ai/chat').send({message:'ผู้เสพยกเว้นโพนมีกี่คน'});
 assert.equal(res.status,200);
 assert.equal(res.body.presentation.type,'place_choices');
 assert.equal(res.body.presentation.field,'exclude');
 assert.equal(res.body.presentation.originalMessage,'ผู้เสพยกเว้นโพนมีกี่คน');
 assert.equal(res.body.presentation.choices.length,2);
 // Choices are ordered deterministically by code point; pick the verified
 // โพนสูง option explicitly.
 const first=res.body.presentation.choices.find(choice=>choice.replaceWith==='ตำบลโพนสูง');
 assert.ok(first,'expected a ตำบลโพนสูง choice');
 const followup=res.body.presentation.originalMessage.replace(first.replaceText||res.body.presentation.replaceText,first.replaceWith);
 assert.equal(followup,'ผู้เสพยกเว้นตำบลโพนสูงมีกี่คน');
 const retry=await request(app).post('/ai/chat').send({message:followup});
 assert.equal(retry.status,200);
 assert.equal(retry.body.answer,'มีผู้เสพ 1 คน (ไม่รวมตำบลโพนสูง)');
});

test('monitoring with an exclusion excludes the area from the people read',async()=>{
 const calls=[];
 const app=makeApp({role:'officer',stationId:77,stationName:'สภ.ทดสอบ'},async(url)=>{
  const u=new URL(url);calls.push(u);
  if(u.pathname.endsWith('/people')){
   if(u.searchParams.get('select')===MONITOR_SELECT){
    assert.equal(u.searchParams.get('not.tambon'),'ilike.*โพนสูง*');
    return ok([{id:2,prefix:'นาง',first_name:'สมหญิง',last_name:'แสงทอง',tambon:'วังใหญ่',amphoe:'เมือง',type_id:2,station_id:77,status:'active'}],'0-0/1');
   }
   if(u.searchParams.get('select')==='province,amphoe,tambon')return ok([{province:'นครพนม',amphoe:'เมือง',tambon:'โพนสูง'},{province:'นครพนม',amphoe:'เมือง',tambon:'วังใหญ่'}],'0-1/2');
   throw new Error('unexpected people read');
  }
  if(u.pathname.endsWith('/visits'))return ok([{id:9,person_id:2,visit_date:'2026-09-10',visit_status:'เสี่ยงสูง'}],'0-0/1');
  if(u.pathname.endsWith('/person_report_status'))return ok([],'0--1/0');
  throw new Error('unexpected read '+url);
 });
 const res=await request(app).post('/ai/chat').send({message:'ใครเสี่ยงสูง ยกเว้นตำบลโพนสูง'});
 assert.equal(res.status,200);
 assert.match(res.body.answer,/สมหญิง/);
 assert.match(res.body.answer,/ไม่รวมตำบลโพนสูง/);
});

test('ขอ Excel ผู้เสพไม่รวมตำบลโพนสูง carries the exclusion into the report request and file',async()=>{
 const calls=[];
 const areaRows=[{province:'นครพนม',amphoe:'เมือง',tambon:'โพนสูง'},{province:'นครพนม',amphoe:'เมือง',tambon:'วังใหญ่'}];
 const peopleRows=[{id:1,first_name:'ก',last_name:'ทดสอบ',station_id:77,province:'นครพนม',amphoe:'เมือง',tambon:'วังใหญ่',type_id:2,status:'active'}];
 const serve=(url)=>{
  const u=new URL(url);calls.push(u);
  if(u.pathname.endsWith('/people_type'))return ok([{type_id:2}],'0-0/1');
  if(u.pathname.endsWith('/people')){
   const select=u.searchParams.get('select');
   if(select==='province,amphoe,tambon')return ok(areaRows,'0-1/2');
   if(select.startsWith('id,first_name')){
    assert.equal(u.searchParams.get('not.tambon'),'ilike.*โพนสูง*');
    return ok(peopleRows,'0-0/1');
   }
  }
  throw new Error('unexpected read '+url);
 };
 const app=makeApp({role:'officer',stationId:77},serve);
 const offer=await request(app).post('/ai/chat').send({message:'ขอ Excel ผู้เสพไม่รวมตำบลโพนสูง'});
 assert.equal(offer.status,200);
 assert.equal(offer.body.presentation.type,'report_offer');
 const reportRequest=offer.body.presentation.reportRequest;
 assert.equal(reportRequest.filters.person_type,'drug_user');
 assert.deepEqual(reportRequest.filters.exclude.map(item=>[item.column,item.value]),[['tambon','โพนสูง']]);
 assert.match(offer.body.answer,/ยกเว้น|ไม่รวม/);
 const file=await request(app).post('/reports/summary.xlsx').send({reportRequest});
 assert.equal(file.status,200);
 assert.match(file.headers['content-type'],/spreadsheetml/);
 const filtered=calls.filter(u=>u.pathname.endsWith('/people')&&u.searchParams.get('not.tambon'));
 assert.ok(filtered.length>=1);
});

test('ขอ Excel ผู้เสพเดือนนี้ states the limitation instead of offering a file',async()=>{
 const app=makeApp({role:'officer',stationId:77},async(url)=>{
  const u=new URL(url);
  if(u.pathname.endsWith('/people_type'))return ok([{type_id:2}],'0-0/1');
  throw new Error('no registry read may back an unsupported report: '+url);
 });
 const res=await request(app).post('/ai/chat').send({message:'ขอ Excel ผู้เสพเดือนนี้'});
 assert.equal(res.status,200);
 assert.equal(res.body.grounded,false);
 assert.equal(res.body.presentation,undefined);
 assert.match(res.body.answer,/ช่วงเวลา/);
 assert.match(res.body.answer,/ไม่สร้างไฟล์|ไม่ได้/);
});

test('ใครเสี่ยงสูงเดือนสิงหาคม 2569 filters the whole named calendar month',async()=>{
 const app=makeApp({role:'officer',stationId:77,stationName:'สภ.ทดสอบ'},async(url)=>{
  const u=new URL(url);
  if(u.pathname.endsWith('/people')&&u.searchParams.get('select')===MONITOR_SELECT)return ok([{id:2,prefix:'นาง',first_name:'สมหญิง',last_name:'แสงทอง',tambon:'วังใหญ่',amphoe:'เมือง',type_id:2,station_id:77,status:'active'}],'0-0/1');
  if(u.pathname.endsWith('/visits')){
   assert.deepEqual(u.searchParams.getAll('visit_date').sort(),['gte.2026-08-01','lte.2026-08-31']);
   return ok([{id:9,person_id:2,visit_date:'2026-08-10',visit_status:'เสี่ยงสูง'}],'0-0/1');
  }
  if(u.pathname.endsWith('/person_report_status')){
   assert.deepEqual(u.searchParams.getAll('last_report_date').sort(),['gte.2026-08-01','lte.2026-08-31']);
   return ok([],'0--1/0');
  }
  throw new Error('unexpected read '+url);
 });
 const res=await request(app).post('/ai/chat').send({message:'ใครเสี่ยงสูงเดือนสิงหาคม 2569'});
 assert.equal(res.status,200);
 assert.match(res.body.answer,/สิงหาคม 2569/);
 assert.match(res.body.answer,/สมหญิง/);
});

test('เดือนนี้เทียบกับเดือนที่แล้ว is refused as a comparison, never half-answered',async()=>{
 const app=makeApp({role:'officer',stationId:77},async(url)=>{throw new Error('comparison must not read the registry: '+url);});
 const res=await request(app).post('/ai/chat').send({message:'ใครเสี่ยงสูงเดือนนี้เทียบกับเดือนที่แล้ว'});
 assert.equal(res.status,200);
 assert.equal(res.body.grounded,false);
 assert.match(res.body.answer,/เปรียบเทียบ/);
 assert.match(res.body.answer,/ทีละช่วง/);
});

test('ใครเสี่ยงสูงยี่สิบเอ็ดวันล่าสุด reads a 21-day window',async()=>{
 const expected=analyzePeriods('ยี่สิบเอ็ดวันล่าสุด').windows[0];
 const app=makeApp({role:'officer',stationId:77,stationName:'สภ.ทดสอบ'},async(url)=>{
  const u=new URL(url);
  if(u.pathname.endsWith('/people')&&u.searchParams.get('select')===MONITOR_SELECT)return ok([],'0--1/0');
  if(u.pathname.endsWith('/visits')){
   assert.deepEqual(u.searchParams.getAll('visit_date').sort(),[`gte.${expected.from}`,`lte.${expected.to}`].sort());
   return ok([],'0--1/0');
  }
  if(u.pathname.endsWith('/person_report_status'))return ok([],'0--1/0');
  throw new Error('unexpected read '+url);
 });
 const res=await request(app).post('/ai/chat').send({message:'ใครเสี่ยงสูงยี่สิบเอ็ดวันล่าสุด'});
 assert.equal(res.status,200);
 assert.match(res.body.answer,/21 วันล่าสุด/);
});

test('two chained exclusions both become server-side not-filters',async()=>{
 const peopleRows=[{id:1,first_name:'ก',last_name:'ทดสอบ',station_id:77,province:'นครพนม',amphoe:'เมือง',tambon:'บ้านคุ้ง',type_id:2,status:'active'}];
 const app=makeApp({role:'officer',stationId:77},async(url)=>{
  const u=new URL(url);
  if(u.pathname.endsWith('/people')){
   const select=u.searchParams.get('select');
   if(select==='province,amphoe,tambon')return ok([{province:'นครพนม',amphoe:'เมือง',tambon:'โพนสูง'},{province:'นครพนม',amphoe:'เมือง',tambon:'วังใหญ่'},{province:'นครพนม',amphoe:'เมือง',tambon:'บ้านคุ้ง'}],'0-2/3');
   if(select.startsWith('id,first_name')){
    const excluded=u.searchParams.getAll('not.tambon');
    assert.deepEqual(excluded.sort(),['ilike.*วังใหญ่*','ilike.*โพนสูง*'].sort());
    return ok(peopleRows,'0-0/1');
   }
  }
  if(u.pathname.endsWith('/people_type'))return ok([{type_id:2}],'0-0/1');
  throw new Error('unexpected read '+url);
 });
 const res=await request(app).post('/ai/chat').send({message:'ผู้เสพยกเว้นตำบลโพนสูงและตำบลวังใหญ่มีกี่คน'});
 assert.equal(res.status,200);
 assert.equal(res.body.answer,'มีผู้เสพ 1 คน (ไม่รวมตำบลโพนสูง ตำบลวังใหญ่)');
});

test('ใครเสี่ยงสูง 400 วันล่าสุด is refused without any registry read',async()=>{
 const app=makeApp({role:'officer',stationId:77},async(url)=>{throw new Error('oversized window must not read: '+url);});
 const res=await request(app).post('/ai/chat').send({message:'ใครเสี่ยงสูง 400 วันล่าสุด'});
 assert.equal(res.status,200);
 assert.equal(res.body.grounded,false);
 assert.match(res.body.answer,/400 วันล่าสุด/);
 assert.match(res.body.answer,/365/);
});

test('a windowed people report is refused at the report endpoint too',async()=>{
 const app=makeApp({role:'officer',stationId:77},async(url)=>{throw new Error('must not read '+url);});
 const res=await request(app).post('/reports/summary.xlsx').send({reportRequest:{filters:{person_type:'drug_user',window:{from:'2026-09-01',to:'2026-09-22',label:'เดือนนี้'}},includeList:true}});
 assert.equal(res.status,400);
 assert.match(res.body.error,/ช่วงเวลา/);
});

test('a windowed monitoring report keeps the window in the file request',async()=>{
 const window=extractTimeWindow('เดือนนี้');
 const app=makeApp({role:'officer',stationId:77,stationName:'สภ.ทดสอบ'},async(url)=>{
  const u=new URL(url);
  if(u.pathname.endsWith('/people')&&u.searchParams.get('select')===MONITOR_SELECT)return ok([],'0--1/0');
  if(u.pathname.endsWith('/visits')){
   assert.deepEqual(u.searchParams.getAll('visit_date').sort(),[`gte.${window.from}`,`lte.${window.to}`].sort());
   return ok([],'0--1/0');
  }
  if(u.pathname.endsWith('/person_report_status'))return ok([],'0--1/0');
  throw new Error('unexpected read '+url);
 });
 const res=await request(app).post('/reports/summary.xlsx').send({reportRequest:{filters:{level:'high',window:{from:window.from,to:window.to,label:window.label}},includeCount:true,includeList:true}});
 assert.equal(res.status,200);
 assert.match(res.headers['content-type'],/spreadsheetml/);
 assert.ok(res.headers['content-length']&&Number(res.headers['content-length'])>100);
});

test('a single-source monitoring list names สภ./อำเภอ/จังหวัด in the header',async()=>{
 const app=makeApp({role:'officer',stationId:77,stationName:'สภ.ทดสอบ'},async(url)=>{
  const u=new URL(url);
  if(u.pathname.endsWith('/people')&&u.searchParams.get('select')===MONITOR_SELECT)return ok([{id:2,prefix:'นาง',first_name:'สมหญิง',last_name:'แสงทอง',tambon:'วังใหญ่',amphoe:'เมือง',province:'นครพนม',type_id:2,station_id:77,status:'active'}],'0-0/1');
  if(u.pathname.endsWith('/visits'))return ok([{id:9,person_id:2,visit_date:'2026-09-10',visit_status:'เสี่ยงสูง'}],'0-0/1');
  if(u.pathname.endsWith('/person_report_status'))return ok([],'0--1/0');
  throw new Error('unexpected read '+url);
 });
 const res=await request(app).post('/ai/chat').send({message:'ใครเสี่ยงสูง'});
 assert.equal(res.status,200);
 assert.match(res.body.answer,/สังกัด สภ\.ทดสอบ • อำเภอเมือง • จังหวัดนครพนม/);
 // Uniform context stays in the header; rows keep the level and visit line.
 assert.match(res.body.answer,/1\. .*สมหญิง แสงทอง — เสี่ยงสูง • ตำบลวังใหญ่/);
});

test('a mixed-source monitoring list keeps สภ./จังหวัด details per row',async()=>{
 const calls=[];
 const app=makeApp({role:'admin',stationId:null,stationName:null},async(url)=>{
  const u=new URL(url);calls.push(u);
  if(u.pathname.endsWith('/people')&&u.searchParams.get('select')===MONITOR_SELECT)return ok([
   {id:1,prefix:'นาย',first_name:'สมชาย',last_name:'ใจดี',tambon:'โพนสูง',amphoe:'เมือง',province:'นครพนม',type_id:2,station_id:9,status:'active'},
   {id:2,prefix:'นาง',first_name:'สมหญิง',last_name:'แสงทอง',tambon:'โพนสูง',amphoe:'วาริน',province:'ร้อยเอ็ด',type_id:2,station_id:11,status:'active'},
  ],'0-1/2');
  if(u.pathname.endsWith('/stations')&&u.searchParams.get('select')==='station_id,station_name')return ok([{station_id:9,station_name:'สภ.ท่าอุเทน'},{station_id:11,station_name:'สภ.ธาตุพนม'}],'0-1/2');
  if(u.pathname.endsWith('/visits'))return ok([
   {id:9,person_id:1,visit_date:'2026-09-10',visit_status:'เสี่ยงสูง'},
   {id:10,person_id:2,visit_date:'2026-09-11',visit_status:'เสี่ยงสูง'},
  ],'0-1/2');
  if(u.pathname.endsWith('/person_report_status'))return ok([],'0--1/0');
  throw new Error('unexpected read '+url);
 });
 const res=await request(app).post('/ai/chat').send({message:'ใครเสี่ยงสูง'});
 assert.equal(res.status,200);
 assert.doesNotMatch(res.body.answer,/สังกัด สภ\./);
 assert.match(res.body.answer,/1\. .*สมชาย ใจดี — เสี่ยงสูง • ตำบลโพนสูง • สภ\.ท่าอุเทน • อำเภอเมือง • จังหวัดนครพนม/);
 assert.match(res.body.answer,/2\. .*สมหญิง แสงทอง — เสี่ยงสูง • ตำบลโพนสูง • สภ\.ธาตุพนม • อำเภอวาริน • จังหวัดร้อยเอ็ด/);
});
