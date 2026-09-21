const express=require('express');
const {detectFastPathIntent}=require('../ai/fastPath');
const {parseSummaryIntent}=require('../services/summaryService');
const {sanitizeTopic,topicFromIntent}=require('../ai/conversationTopic');
const {createRealRegistryRead,monitoringQuestion,selectedReasonFollowup}=require('../services/realRegistryRead');
const {detectExportIntent,reportRequestFromExport}=require('../ai/exportIntent');
const {writeSummaryPdf,writeSummaryExcel,safeReportRequest}=require('../services/reportService');
const fs=require('fs');
const {parseStationId,applyPeopleStationScope,personInOwnStation}=require('../services/stationScope');
const {detectOverview,formatOverview,TYPE_LABELS}=require('../services/overviewService');
const {hasDBIntent}=require('../ai/intentDetector');
const rag=require('../ai/rag');
const {detectDiscoveryIntent,discover}=require('../services/discoveryService');

async function ollamaJson(path,body) {
 const response=await fetch(new URL(path,process.env.OLLAMA_HOST||'http://127.0.0.1:11434'),{method:'POST',headers:{'Content-Type':'application/json'},signal:AbortSignal.timeout(120000),body:JSON.stringify(body)});
 if(!response.ok)throw new Error('Local AI knowledge service unavailable');
 return response.json();
}

function realFailure(error) {
 const code=error&&error.code;
 const location=String(error?.stack||'').split('\n')[1]?.trim()||'unknown';
 // Keep server diagnostics free of messages, requests, transcripts, and row data.
 console.error(`[real-data] failure code=${code||'none'} type=${error?.name||'Error'} at ${location}`);
 if(code==='REAL_ACCESS_DENIED'||/สิทธิ์สถานี/.test(error?.message||''))return {status:403,code:'REAL_ACCESS_DENIED',error:'บัญชีนี้ไม่มีสิทธิ์อ่านข้อมูลจริงในขอบเขตที่ร้องขอ'};
 if(code==='REAL_UNAVAILABLE'||error?.name==='TimeoutError'||error?.name==='AbortError')return {status:503,code:'REAL_UNAVAILABLE',error:'เชื่อมต่อข้อมูลจริงไม่ได้ในขณะนี้ กรุณาลองใหม่อีกครั้ง'};
 if(code==='REAL_DATA_UNVERIFIABLE'||/ข้อมูลไม่ครบ|จำนวนข้อมูลที่ตรวจสอบได้|ข้อมูลเปลี่ยนระหว่างนับ/.test(error?.message||''))return {status:502,code:'REAL_DATA_UNVERIFIABLE',error:'ข้อมูลจริงตอบกลับไม่ครบหรือกำลังเปลี่ยนแปลง จึงยังสรุปผลไม่ได้'};
 return {status:502,code:'REAL_READ_FAILED',error:'ไม่สามารถอ่านข้อมูลจริงได้ในขณะนี้ กรุณาลองใหม่อีกครั้ง'};
}

function topNFromMessage(message) {
 const matched=String(message||'').match(/(?:ขอ\s*)?(\d{1,2})\s*อันดับ/);
 if(!matched)return null;
 const value=Number(matched[1]);
 return Number.isSafeInteger(value)&&value>=1&&value<=20 ? value : null;
}

function provinceFromMessage(message) {
 // Voice transcription commonly says “เลือกจังหวัด…” rather than
 // “เปลี่ยนจังหวัด…”.  This is a local filter command, so recognise it
 // before RAG or the model sees the utterance.
 const match=String(message||'').match(/(?:เปลี่ยน(?:เป็น)?|เลือก(?:เป็น)?|ตั้ง(?:เป็น)?)\s*(?:จังหวัด)?\s*([ก-๙A-Za-z.-]{2,80})|(?:ใน|ของ)?จังหวัด\s*([ก-๙A-Za-z.-]{2,80})/u);
 const province=match?.[1]||match?.[2];
 return province ? province.trim().slice(0,100) : null;
}

function isProvinceChangeOnly(message) {
 return /^\s*(?:เปลี่ยน(?:เป็น)?|เลือก(?:เป็น)?|ตั้ง(?:เป็น)?)\s*(?:จังหวัด)?\s*[ก-๙A-Za-z.-]{2,80}\s*$/u.test(String(message||''));
}

function createRealDataRoutes(authenticate,{url=require('../realConfig').url,key=require('../realConfig').key,request=fetch,interpret=require('../ai/realIntent').interpretRealIntent}={}) {
 const router=express.Router();router.use(authenticate);
 const { createRealAiTools } = require('../services/realAiTools');
 const aiTools = createRealAiTools({ url, key, request });
 async function rows(req,table,params) {
  let response;
  try { response=await request(`${url}/rest/v1/${table}?${params}`,{headers:{apikey:key,Authorization:`Bearer ${req.realToken}`,Prefer:'count=exact'},signal:AbortSignal.timeout(15000)}); }
  catch(error) { error.code=error?.name==='TimeoutError'||error?.name==='AbortError'?'REAL_UNAVAILABLE':'REAL_READ_FAILED';throw error; }
  if(!response.ok) { const error=new Error('real registry request failed');error.code=[401,403].includes(response.status)?'REAL_ACCESS_DENIED':response.status>=500||response.status===429?'REAL_UNAVAILABLE':'REAL_READ_FAILED';throw error; }
  const data=await response.json();
  const count=response.headers.get('content-range')?.split('/')[1];
  if(!Array.isArray(data)|| !/^\d+$/.test(count||'')){const error=new Error('unverifiable registry response');error.code='REAL_DATA_UNVERIFIABLE';throw error;}
  return {data,total:Number(count)};
 }
 async function search(req,filters={},page=1,aggregate=false,pageSize=20) {
  const size=Math.min(50,Math.max(1,Number(pageSize)||20));
  const p=new URLSearchParams({select:'id,first_name,last_name,station_id,province,amphoe,tambon,type_id,status',order:'first_name.asc,id.asc',limit:String(size),offset:String((page-1)*size)});
  applyPeopleStationScope(req.user,p);
  const clean=v=>String(v).replace(/[%*(),]/g,'').slice(0,100);
  for(const [input,column] of [['province','province'],['district','amphoe'],['subdistrict','tambon']])if(filters[input])p.set(column,`ilike.*${clean(filters[input])}*`);
  if(filters.query||filters.search)p.set('first_name',`ilike.*${clean(filters.query||filters.search)}*`);
  if(filters.status)throw new Error('การแปลสถานะทะเบียนจริงยังไม่พร้อม กรุณาค้นด้วยชื่อหรือพื้นที่');
  if(filters.station){
   const own=parseStationId(req.user.stationId);
   const s=await rows(req,'stations',new URLSearchParams({select:'station_id',station_name:`ilike.*${clean(filters.station)}*`,limit:'1000'}));
   const ids=s.data.map(x=>Number(x.station_id)).filter(id=>own?id===own:req.user.role==='admin');
   if(!ids.length)return {data:[],total:0};
   p.set('station_id', own ? `eq.${own}` : `in.(${ids.join(',')})`);
  }
  if(filters.person_type){
   const terms={psychiatric:'ผู้ป่วยจิตเวช',drug_user:'ผู้เสพ',dealer:'ผู้ค้า',released:'พ้นโทษ'};
   if(!terms[filters.person_type])throw new Error('ประเภทบุคคลไม่ถูกต้อง');
   const types=await rows(req,'people_type',new URLSearchParams({select:'type_id',type_name:`ilike.*${terms[filters.person_type]}*`,limit:'1000'}));
   if(!types.data.length)return {data:[],total:0};
   p.set('type_id',`in.(${types.data.map(t=>t.type_id).join(',')})`);
  }
  if (!aggregate) {
   const found=await rows(req,'people',p);
   const scoped=found.data.filter(person=>personInOwnStation(req.user,person));
   if(scoped.length!==found.data.length) return {data:scoped,total:scoped.length};
   return found;
  }
  p.set('select','id,province,amphoe,tambon,type_id,station_id');p.set('order','id.asc');p.set('limit','1000');
  const all=[];const seen=new Set();let total=null;
  do {
   p.set('offset',String(all.length));
   const batch=await rows(req,'people',p);
   if(total!==null && total!==batch.total)throw new Error('ข้อมูลเปลี่ยนระหว่างนับ กรุณาถามใหม่');
   total=batch.total;
   if(!batch.data.length && all.length<total)throw new Error('อ่านข้อมูลไม่ครบ จึงยังสรุปอันดับไม่ได้');
   for(const row of batch.data){if(seen.has(row.id))throw new Error('ข้อมูลซ้ำระหว่างนับ กรุณาถามใหม่');seen.add(row.id);all.push(row);}
  }while(all.length<total);
  return {data:all,total};
 }
 function selectedPersonId(body) {
  const value=Number(body?.context?.personId);
  return Number.isSafeInteger(value) && value>0 ? value : null;
 }
 function isCollectionQuestion(message,intent,ranking,summary,personId) {
  if(personId && !/ใคร|มีใคร|รายชื่อ/.test(message) && /เยี่ยม|ประวัติ|ปัสสาวะ|ฉี่|เพราะ|ทำไม|อายุ|ตำบล|อำเภอ|จังหวัด|ข้อมูลเพิ่ม|เกิด|เพศ|ชื่อเล่น/.test(message)) return false;
  if(ranking)return true;
  if(summary && summary.intent!=='summary_choices')return true;
  if(intent && /^(count_|list_|group_|search_)/.test(intent.intent))return true;
  const monitor=monitoringQuestion(message);
  if(monitor && !/คนนี้|บุคคลนี้|รายนี้/.test(message) && !selectedReasonFollowup(message))return true;
  return /รายชื่อ|กี่คน|กี่ราย|มีทั้งหมด|มีมั้ย|มีไหม|แยกตาม|แจกแจง|ตำบลไหนมี|อำเภอไหนมี|จังหวัดไหนมี/.test(message);
 }
 function ageYears(birthDate) {
  const raw=String(birthDate||'').slice(0,10);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(raw))return null;
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Bangkok',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const [ty,tm,td]=today.split('-').map(Number);
  const [by,bm,bd]=raw.split('-').map(Number);
  let age=ty-by;
  if(tm<bm || (tm===bm && td<bd))age-=1;
  return Number.isInteger(age) && age>=0 && age<=130 ? age : null;
 }
 function formatSelectedPerson(person,typeName,stationName,message) {
  const name=`${person.prefix||''}${person.first_name||''} ${person.last_name||''}`.replace(/\s+/g,' ').trim()||'บุคคลที่เลือก';
  const age=ageYears(person.birth_date);
  if(/อายุ|กี่ปี/.test(message)) return age!=null ? `${name} อายุ ${age} ปี` : `ทะเบียนไม่ระบุวันเกิดของ ${name} จึงยังบอกอายุไม่ได้`;
  if(/วันเกิด|เกิดวัน|ปีเกิด/.test(message)) return person.birth_date ? `${name} วันเกิดตามทะเบียน ${String(person.birth_date).slice(0,10)}` : `ทะเบียนไม่ระบุวันเกิดของ ${name}`;
  if(/ตำบล/.test(message) && !/อำเภอ|เขต|จังหวัด/.test(message)) return person.tambon ? `${name} อยู่ในตำบล${person.tambon}` : `ทะเบียนไม่ระบุตำบลของ ${name}`;
  if(/(?:อำเภอ|เขต)/.test(message) && !/ตำบล|จังหวัด/.test(message)) return person.amphoe ? `${name} อยู่ในอำเภอ${person.amphoe}` : `ทะเบียนไม่ระบุอำเภอของ ${name}`;
  if(/จังหวัด/.test(message) && !/ตำบล|อำเภอ|เขต/.test(message)) return person.province ? `${name} อยู่ในจังหวัด${person.province}` : `ทะเบียนไม่ระบุจังหวัดของ ${name}`;
  if(/ชื่อเล่น/.test(message)) return person.nickname ? `${name} ชื่อเล่น ${person.nickname}` : `ทะเบียนไม่ระบุชื่อเล่นของ ${name}`;
  if(/เพศ/.test(message)) return person.gender ? `${name} เพศ${person.gender}` : `ทะเบียนไม่ระบุเพศของ ${name}`;
  if(/ชื่ออะไร/.test(message)) return `ชื่อในทะเบียน: ${name}`;
  if(/ประเภท/.test(message)) return `${name} เป็น${typeName||'ไม่ระบุประเภท'}`;
  if(/สถานะ/.test(message)) return `${name} สถานะทะเบียน: ${person.status||'ไม่ระบุ'}${person.custody_status?` / ${person.custody_status}`:''}`;
  const lines=[`ข้อมูลทะเบียนของ ${name}`];
  if(age!=null)lines.push(`อายุ ${age} ปี`);
  if(typeName)lines.push(`ประเภท: ${typeName}`);
  lines.push(`ตำบล${person.tambon||'ไม่ระบุ'} อำเภอ${person.amphoe||'ไม่ระบุ'} จังหวัด${person.province||'ไม่ระบุ'}`);
  if(person.moo)lines.push(`หมู่ ${person.moo}`);
  if(person.village_name)lines.push(`หมู่บ้าน ${person.village_name}`);
  if(person.house_number)lines.push(`บ้านเลขที่ ${person.house_number}`);
  if(stationName)lines.push(`สภ.${String(stationName).replace(/^สภ\.?\s*/,'')}`);
  if(person.status)lines.push(`สถานะทะเบียน: ${person.status}`);
  if(person.custody_status)lines.push(`สถานะการควบคุมตัว: ${person.custody_status}`);
  return lines.join('\n');
 }
 async function readSelectedPerson(req,personId) {
  const params=new URLSearchParams({select:'id,prefix,first_name,last_name,nickname,gender,birth_date,tambon,amphoe,province,moo,village_name,house_number,station_id,type_id,status,custody_status',id:`eq.${personId}`,limit:'1'});
  applyPeopleStationScope(req.user,params);
  const found=await rows(req,'people',params);
  const person=found.data[0];
  if(!person || !personInOwnStation(req.user,person))return null;
  let typeName=null,stationName=req.user.stationName||null;
  if(person.type_id) {
   const types=await rows(req,'people_type',new URLSearchParams({select:'type_id,type_name',type_id:`eq.${person.type_id}`,limit:'1'}));
   typeName=types.data[0]?.type_name||null;
  }
  if(person.station_id && !stationName) {
   const stations=await rows(req,'stations',new URLSearchParams({select:'station_id,station_name',station_id:`eq.${person.station_id}`,limit:'1'}));
   stationName=stations.data[0]?.station_name||null;
  }
  return {person,typeName,stationName};
 }
 async function realOverview(req,requestedScope,filters={}) {
  const found=await search(req,filters,1,true);
  const typeIds=[...new Set(found.data.map(row=>row.type_id).filter(Boolean))];
  const types=typeIds.length ? await rows(req,'people_type',new URLSearchParams({select:'type_id,type_name',type_id:`in.(${typeIds.join(',')})`,limit:'1000'})) : {data:[]};
  const typeById=new Map(types.data.map(row=>[String(row.type_id),String(row.type_name||'')]));
  const typeFor=name=>/จิตเวช/.test(name)?'psychiatric':/ผู้เสพ|ใช้ยา/.test(name)?'drug_user':/ผู้ค้า|จำหน่าย/.test(name)?'dealer':/พ้นโทษ|เรือนจำ/.test(name)?'released':null;
  const counts={psychiatric:0,drug_user:0,dealer:0,released:0};
  for(const person of found.data){const type=typeFor(typeById.get(String(person.type_id))||'');if(type)counts[type]++;}
  const groupBy=requestedScope==='province'||(!req.user.stationId&&requestedScope==='current')?'station':'subdistrict';
  const stationIds=[...new Set(found.data.map(row=>Number(row.station_id)).filter(Number.isFinite))];
  const stations=groupBy==='station'&&stationIds.length ? await rows(req,'stations',new URLSearchParams({select:'station_id,station_name',station_id:`in.(${stationIds.join(',')})`,limit:'1000'})) : {data:[]};
  const stationNames=new Map(stations.data.map(row=>[Number(row.station_id),row.station_name]));
  const groups=new Map();
  for(const person of found.data){
   const name=(groupBy==='station'?stationNames.get(Number(person.station_id)):person.tambon)||'';
   if(!String(name).trim())continue;
   const group=groups.get(name)||{name,count:0};group.count++;groups.set(name,group);
  }
  const sort=(direction)=>[...groups.values()].sort((a,b)=>{const diff=direction==='asc'?a.count-b.count:b.count-a.count;return diff||(a.name===b.name?0:(a.name<b.name?-1:1));}).slice(0,5);
  const [high,watch]=await Promise.all([
   registry.listRecordedMonitoring(req,{level:'high',personType:filters.person_type,district:filters.district,subdistrict:filters.subdistrict,pageSize:1}),
   registry.listRecordedMonitoring(req,{level:'watch',personType:filters.person_type,district:filters.district,subdistrict:filters.subdistrict,pageSize:1}),
  ]);
  const data={scopeLabel:req.user.stationName||'พื้นที่ที่บัญชีนี้มีสิทธิ์เข้าถึง',requestedScope,groupBy,total:found.total,
   filters,byType:Object.entries(TYPE_LABELS).map(([type,label])=>({type,label,count:counts[type]})),highRisk:high.total,watch:watch.total,top:sort('desc'),bottom:sort('asc')};
  return {answer:formatOverview(data),presentation:{type:'overview',...data}};
 }
 async function realDiscovery(req, options = {}) {
  const found=await search(req,{},1,true);
  const typeIds=[...new Set(found.data.map(row=>row.type_id).filter(Boolean))];
  const types=typeIds.length ? await rows(req,'people_type',new URLSearchParams({select:'type_id,type_name',type_id:`in.(${typeIds.join(',')})`,limit:'1000'})) : {data:[]};
  const typeById=new Map(types.data.map(row=>[String(row.type_id),String(row.type_name||'')]));
  const typeFor=name=>/จิตเวช/.test(name)?'psychiatric':/ผู้เสพ|ใช้ยา/.test(name)?'drug_user':/ผู้ค้า|จำหน่าย/.test(name)?'dealer':/พ้นโทษ|เรือนจำ/.test(name)?'released':'other';
  const safeRows=found.data.map(row=>({
   person_type:typeFor(typeById.get(String(row.type_id))||''),status:row.status,
   subdistrict:row.tambon,district:row.amphoe,
  }));
  return discover(safeRows,{scopeLabel:req.user.stationName||'พื้นที่ที่บัญชีนี้มีสิทธิ์เข้าถึง',kind:options.kind});
 }
 const registry=createRealRegistryRead(rows);
 router.get('/ai/status',(req,res)=>res.json({available:true,model:'ข้อมูลจริง • อ่านจาก Supabase'}));
 router.get('/ai/access-scope',(req,res)=>res.json({scope:req.user.aiScope||null,readOnly:true}));
 async function psychiatricSummary(req, province=null) {
  const result=await aiTools.psychiatricSummary(req.realToken,{province});
  const rows=result.rows.map(row=>({
   name:String(row.station_name||'ไม่ระบุ สภ.'),
   province:String(row.province||''),
   count:Number(row.patient_total)||0,
   green:Number(row.green_total)||0,
   yellow:Number(row.yellow_total)||0,
   red:Number(row.red_total)||0,
  }));
  const total=rows.reduce((sum,row)=>sum+row.count,0);
  const scope=result.scope?.level==='all'?'ทุกจังหวัดตามสิทธิ์ที่ยืนยันแล้ว':result.scope?.level==='region4'?'ทุกจังหวัดในขอบเขตที่ยืนยันแล้ว':result.scope?.province?`จังหวัด${result.scope.province}`:'พื้นที่ตามสิทธิ์ที่ยืนยันแล้ว';
  return {
   answer:`ภาพรวมผู้ป่วยจิตเวช • ${scope}\nรวม ${total} คน จาก ${rows.length} สภ.`,
   presentation:{type:'location_summary',groupBy:'station',readOnlyAggregate:true,items:rows,filters:{person_type:'psychiatric'}},
  };
 }
 async function targetPersonSummary(req, province=null) {
  const result=await aiTools.targetPersonSummary(req.realToken,{province});
  const rows=result.rows.map(row=>({stationName:String(row.station_name||'ไม่ระบุ สภ.'),province:String(row.province||''),psychiatric:Number(row.psychiatric_total)||0,drugUser:Number(row.drug_user_total)||0,dealer:Number(row.dealer_total)||0,released:Number(row.released_total)||0,total:Number(row.target_total)||0}));
  const totals=rows.reduce((sum,row)=>({psychiatric:sum.psychiatric+row.psychiatric,drugUser:sum.drugUser+row.drugUser,dealer:sum.dealer+row.dealer,released:sum.released+row.released,total:sum.total+row.total}),{psychiatric:0,drugUser:0,dealer:0,released:0,total:0});
  const scope=result.scope?.level==='all'?'ทุกจังหวัดตามสิทธิ์ที่ยืนยันแล้ว':result.scope?.level==='region4'?'ทุกจังหวัดในขอบเขตที่ยืนยันแล้ว':result.scope?.province?`จังหวัด${result.scope.province}`:'พื้นที่ตามสิทธิ์ที่ยืนยันแล้ว';
  return {answer:`ภาพรวมบุคคลเป้าหมาย • ${scope}\nรวม ${totals.total} คน • ผู้ป่วยจิตเวช ${totals.psychiatric} • ผู้เสพ ${totals.drugUser} • ผู้ค้า ${totals.dealer} • ผู้พ้นโทษ ${totals.released}`,presentation:{type:'target_person_summary',readOnlyAggregate:true,scopeLabel:scope,rows,totals}};
 }
 router.post('/ai/chat',async(req,res)=>{
  const start=Date.now();const message=req.body?.message;
  if(typeof message!=='string'||!message.trim()||message.length>2000)return res.status(400).json({error:'คำถามไม่ถูกต้อง'});
  const personId=selectedPersonId(req.body);
  let ranking=/(ตำบล|อำเภอ|จังหวัด)(?:ไหน|ใด|อะไร).*?(มากที่สุด|เยอะที่สุด|น้อยที่สุด|มากสุด|เยอะสุด|น้อยสุด)/.exec(message);
  const ordered=/(?:ตาม|แยก(?:ตาม)?|แต่ละ)(ตำบล|อำเภอ|จังหวัด)/.exec(message);
  let showAll=!!ordered;
  if(!ranking&&ordered)ranking=[message,ordered[1],/น้อยไปมาก/.test(message)?'น้อยสุด':'มากสุด'];
  let plan=null;let ollamaCalls=0;
  const incomingTopic=sanitizeTopic(req.body?.context?.topic);
  const explicitProvince=provinceFromMessage(message);
  const selectedProvince=explicitProvince||incomingTopic?.province||null;
  const selectedTopic=selectedProvince?sanitizeTopic({...(incomingTopic||{}),province:selectedProvince}):incomingTopic;
  if(isProvinceChangeOnly(message)){
   return res.json({answer:`ตั้งค่าจังหวัดที่ต้องการดูเป็นจังหวัด${selectedProvince} แล้ว คำสั่งถัดไปจะใช้จังหวัดนี้เป็นตัวกรองภายในสิทธิ์ของบัญชี`,grounded:true,dataSource:'real',conversation:{topic:selectedTopic},meta:{fastPath:true,ollamaCalls:0,responseTimeMs:Date.now()-start}});
  }
  const exportIntent=detectExportIntent(message);
  if(exportIntent){
   const reportRequest=reportRequestFromExport(exportIntent,incomingTopic);
   const bits=[];
   if(reportRequest.filters.person_type)bits.push({psychiatric:'ผู้ป่วยจิตเวช',drug_user:'ผู้เสพ',dealer:'ผู้ค้า',released:'ผู้พ้นโทษ'}[reportRequest.filters.person_type]);
   const files=exportIntent.formats.map(item=>item==='xlsx'?'Excel':'PDF').join(' และ ');
   const needsConfirm=exportIntent.confirm||Boolean(incomingTopic);
   const answer=needsConfirm
    ?'ต้องการสร้างรายงานของรายการหรือภาพรวมล่าสุดใช่หรือไม่? เลือก 1. ใช่ หรือ 2. ไม่'
    :`พร้อมสร้างรายงาน${files} จากทะเบียนจริงตามสิทธิ์บัญชีนี้ กดดาวน์โหลดด้านล่าง (ไม่รวมเลขบัตรและเบอร์โทร)`;
   return res.json({answer,grounded:true,dataSource:'real',presentation:{type:'report_offer',formats:exportIntent.formats,auto:needsConfirm?null:exportIntent.auto,confirm:needsConfirm,reportRequest},conversation:{topic:incomingTopic},meta:{fastPath:true,ollamaCalls:0,responseTimeMs:Date.now()-start}});
  }
  const summary=parseSummaryIntent(message);const intent=detectFastPathIntent(message,selectedTopic);
  const overview=detectOverview(message);
  const topN=topNFromMessage(message);
  // “ขอ 5 อันดับตำบล…” is a complete, deterministic grouping request even
  // when the general spoken-language fast path does not recognise its wording.
  if(!ranking&&topN!==null){
   const area=/(ตำบล|อำเภอ|จังหวัด)/.exec(message);
   if(area)ranking=[message,area[1],/น้อย/.test(message)?'น้อยสุด':'มากสุด'];
  }
  const intentTopic=topicFromIntent(intent)||selectedTopic;
  const conversation={topic:selectedProvince?sanitizeTopic({...(intentTopic||{}),province:selectedProvince}):intentTopic};
  const discoveryIntent=detectDiscoveryIntent(message);
  if(discoveryIntent){
   try { const result=await realDiscovery(req,discoveryIntent);return res.json({answer:result.answer,grounded:true,dataSource:'real',toolsUsed:[{name:'supabase_aggregate_discovery'}],presentation:result.presentation,conversation,meta:{fastPath:true,ollamaCalls:0,responseTimeMs:Date.now()-start}}); }
   catch(e){const failure=realFailure(e);return res.status(failure.status).json(failure);}
  }
  if(overview){
   // This is the first audited aggregate tool supplied by the primary system.
   // It returns counts only; no direct registry read is made from this app.
   if(overview.filters.person_type==='psychiatric'){
    try { const result=await psychiatricSummary(req,selectedProvince); return res.json({answer:result.answer,grounded:true,dataSource:'real',toolsUsed:[{name:'ai-summary/psychiatric_summary'}],presentation:result.presentation,conversation,meta:{fastPath:true,ollamaCalls:0,responseTimeMs:Date.now()-start}}); }
    catch(e){const failure=realFailure(e);return res.status(failure.status).json(failure);}
   }
   if(!overview.filters.person_type || ['drug_user','dealer','released'].includes(overview.filters.person_type)){
    try { const result=await targetPersonSummary(req,selectedProvince); return res.json({answer:result.answer,grounded:true,dataSource:'real',toolsUsed:[{name:'ai-summary/target_person_summary'}],presentation:result.presentation,conversation,meta:{fastPath:true,ollamaCalls:0,responseTimeMs:Date.now()-start}}); }
    catch(e){const failure=realFailure(e);return res.status(failure.status).json(failure);}
   }
   try { const result=await realOverview(req,overview.requestedScope,overview.filters);conversation.topic=sanitizeTopic(overview.filters);return res.json({answer:result.answer,grounded:true,dataSource:'real',toolsUsed:[{name:'supabase_overview_read'}],presentation:result.presentation,conversation,meta:{fastPath:true,ollamaCalls:0,responseTimeMs:Date.now()-start}}); }
   catch(e){const failure=realFailure(e);return res.status(failure.status).json(failure);}
  }
  if(personId && !isCollectionQuestion(message,intent,ranking,summary,personId)) {
   try {
    const found=await readSelectedPerson(req,personId);
    if(!found)return res.json({answer:'ไม่พบบุคคลนี้ในพื้นที่ที่ท่านมีสิทธิ์เข้าถึง',grounded:true,dataSource:'real',meta:{fastPath:true,ollamaCalls:0,responseTimeMs:Date.now()-start}});
    const dossier=await registry.readDossier(req,personId,found);
    const recorded=registry.formatDossier(dossier,message);
    return res.json({answer:recorded||formatSelectedPerson(found.person,found.typeName,found.stationName,message),grounded:true,dataSource:'real',toolsUsed:[{name:'supabase_person_read'}],meta:{fastPath:true,ollamaCalls:0,responseTimeMs:Date.now()-start}});
   } catch(e) { const failure=realFailure(e);return res.status(failure.status).json(failure); }
  }
  const monitor=monitoringQuestion(message);
  if(monitor) {
   if(monitor.unsupported)return res.json({answer:'ขณะนี้ตรวจได้เฉพาะสถานะเฝ้าระวัง/เสี่ยงสูงจากบันทึกปัจจุบัน ยังไม่รองรับคำถามแบบยกเว้นหรือย้อนช่วงเวลา',grounded:false,dataSource:'real',meta:{fastPath:true,ollamaCalls:0,responseTimeMs:Date.now()-start}});
   try {
    const result=await registry.listRecordedMonitoring(req,{level:monitor.level,personType:monitor.person_types[0]||null,page:monitor.page||1});
    const items=result.items.map(item=>({person_id:item.person_id,full_name:item.full_name,subdistrict:item.subdistrict,district:item.district,person_type:monitor.person_types[0]||null}));
    return res.json({answer:registry.formatMonitoringList(result,monitor.level),grounded:true,dataSource:'real',toolsUsed:[{name:'supabase_monitoring_read'}],presentation:{type:'person_list',total:result.total,returned:items.length,page:result.page,pageSize:result.pageSize,filters:{person_type:monitor.person_types[0]||null},items},meta:{fastPath:true,ollamaCalls:0,responseTimeMs:Date.now()-start}});
   } catch(e) { const failure=realFailure(e);return res.status(failure.status).json(failure); }
  }
  if(intent?.intent==='lookup_clarify')return res.json({answer:intent.answer,grounded:false,dataSource:'real',presentation:intent.presentation,conversation,meta:{fastPath:true,ollamaCalls:0,responseTimeMs:Date.now()-start}});
  if(intent?.intent==='group_persons' && {subdistrict:'ตำบล',district:'อำเภอ',province:'จังหวัด'}[intent.groupBy]){
   ranking=[message,{subdistrict:'ตำบล',district:'อำเภอ',province:'จังหวัด'}[intent.groupBy],intent.direction==='asc'?'น้อยสุด':'มากสุด'];
   showAll=intent.showAll||showAll;
  }
  // Non-registry questions must never enter the registry interpreter.  In
  // particular, product questions such as “ธานีพิทักษ์คืออะไร” used to be
  // misread as an incomplete people lookup and got a misleading prompt.
  if(process.env.RAG_ENABLED==='true'&&!hasDBIntent(message)){
   try {
    const found=await rag.answer(message,ollamaJson,process.env.OLLAMA_MODEL||'typhoon2:8b-q5');
    if(found)return res.json({answer:found.answer,grounded:true,dataSource:'real',conversation:{topic:incomingTopic},meta:{fastPath:false,ollamaCalls:0,responseTimeMs:Date.now()-start,ragSources:found.sources}});
   } catch(e) { console.error(`[real-rag] failure type=${e?.name||'Error'}`); }
  }
  try {
   if((!ranking&&!summary&&!intent)||summary?.intent==='summary_choices'||intent?.intent==='search_incomplete'){
    ollamaCalls=1;plan=await interpret(message);
    if(plan.action==='clarify')return res.json({answer:'ต้องการจำนวน รายชื่อ หรือแยกยอดตามพื้นที่ใดครับ? กรุณาระบุประเภทบุคคลและพื้นที่ที่ต้องการ',grounded:false,dataSource:'real',meta:{fastPath:false,ollamaCalls,responseTimeMs:Date.now()-start}});
    if(plan.action==='group'){ranking=[message,plan.group,plan.direction==='asc'?'น้อยสุด':'มากสุด'];showAll=true;}
   }
   const filters={...(summary?.filters||intent?.filters||{})};
   if(plan){for(const key of ['province','district','subdistrict','station','search'])if(plan[key])filters[key]=plan[key];if(plan.person_type!=='all')filters.person_type=plan.person_type;}
   for(const type of ['psychiatric','drug_user','dealer','released'])if(intent?.intent.endsWith('_'+type))filters.person_type=type;
   // Keep explicit subject even when the general count parser returns count_total.
   if(/จิตเวช|ผู้ป่วย/.test(message))filters.person_type='psychiatric';
   else if(/ผู้เสพ/.test(message))filters.person_type='drug_user';
   else if(/ผู้ค้า/.test(message))filters.person_type='dealer';
   else if(/พ้นโทษ/.test(message))filters.person_type='released';
   if(ranking){
    const result=await search(req,filters,1,true);
    const column={ตำบล:'tambon',อำเภอ:'amphoe',จังหวัด:'province'}[ranking[1]];
    const groups=new Map();let missing=0;
    for(const person of result.data){
     const name=person[column]?.trim();if(!name){missing++;continue;}
     const province=person.province?.trim()||'';const district=person.amphoe?.trim()||'';
     const key=JSON.stringify(column==='tambon'?[province,district,name]:column==='amphoe'?[province,name]:[name]);
     const group=groups.get(key)||{name,province,district,count:0};group.count++;groups.set(key,group);
    }
    const sorted=[...groups.values()].sort((a,b)=>{
     const difference=/น้อย/.test(ranking[2])?a.count-b.count:b.count-a.count;
     // Do not rely on optional ICU locale data being installed on the server.
     // Code-point ordering is deterministic across the supported Node runtimes.
     return difference||(a.name===b.name?0:(a.name<b.name?-1:1));
    });
    const winners=topN!==null?sorted.slice(0,topN):showAll?sorted:sorted.filter(g=>g.count===sorted[0]?.count);
    const category={psychiatric:'ผู้ป่วยจิตเวช',drug_user:'ผู้เสพ',dealer:'ผู้ค้า',released:'ผู้พ้นโทษ'}[filters.person_type]||'บุคคล';
    const scope=req.user.stationName||'พื้นที่ที่บัญชีนี้มีสิทธิ์เข้าถึง';
    const heading=topN!==null?`${topN} อันดับ${ranking[1]}${/น้อย/.test(ranking[2])?'น้อยที่สุด':'มากที่สุด'}`:'';
    const answer=`ข้อมูลจริง • ${scope}\nนับ${category}จากทะเบียนทั้งหมด ${result.total} คน\n`+(showAll||topN!==null?`${heading||`เรียง${/น้อย/.test(ranking[2])?'น้อยไปมาก':'มากไปน้อย'}`}\n`:'')+(winners.length?winners.map((g,index)=>`${showAll||topN!==null?`${index+1}. `:''}${ranking[1]}${g.name} ${column==='tambon'?g.district:''} ${column!=='province'?g.province:''} มี${category}${showAll||topN!==null?'':ranking[2]} ${g.count} คน`).join('\n'):'ไม่พบข้อมูลพื้นที่ที่จัดอันดับได้')+(!showAll&&topN===null&&winners.length>1?'\nมีหลายพื้นที่จำนวนเท่ากัน':'')+(missing?`\nอีก ${missing} คนไม่ระบุ${ranking[1]} จึงไม่รวมในอันดับ`:'')+(/น้อย/.test(ranking[2])?'\nอันดับนี้รวมเฉพาะพื้นที่ที่มีบุคคลในทะเบียน':'');
    return res.json({answer,grounded:true,dataSource:'real',toolsUsed:[{name:'supabase_area_count'}],presentation:{type:'location_summary',groupBy:{tambon:'subdistrict',amphoe:'district',province:'province'}[column],items:winners,filters:{person_type:filters.person_type||null}},conversation,meta:{fastPath:!ollamaCalls,ollamaCalls,responseTimeMs:Date.now()-start}});
   }
   const page=intent?.page||1;const result=await search(req,filters,page);
   const category={psychiatric:'ผู้ป่วยจิตเวช',drug_user:'ผู้เสพ',dealer:'ผู้ค้า',released:'ผู้พ้นโทษ'}[filters.person_type]||'บุคคล';
   const countOnly=plan?.action==='count'||(intent&&/^count_/.test(intent.intent))||(!summary?.includeList&&(/กี่|จำนวน|มีมั้ย|มีไหม|มีหรือไม่|มีรึเปล่า/.test(message)));
   const items=result.data.map(p=>({person_id:p.id,full_name:`${p.first_name||''} ${p.last_name||''}`.trim(),person_type:filters.person_type||null,subdistrict:p.tambon||'',district:p.amphoe||''}));
   const answer=countOnly
    ?(result.total?`มี${category} ${result.total} คน`:`ไม่มี${category}`)
    :`ข้อมูลจริง: พบ ${result.total} คนตามสิทธิ์และเงื่อนไขที่ค้นหา`;
   const presentation=countOnly?undefined:{type:'person_list',total:result.total,returned:items.length,page,pageSize:20,filters:{person_type:filters.person_type||null,province:filters.province||null,district:filters.district||null,subdistrict:filters.subdistrict||null},items};
   res.json({answer,grounded:true,dataSource:'real',toolsUsed:[{name:'supabase_people_read'}],presentation,conversation,meta:{fastPath:!ollamaCalls,ollamaCalls,responseTimeMs:Date.now()-start}});
  }catch(e){const failure=realFailure(e);res.status(failure.status).json(failure);}
 });
 async function collectPeople(req,filters,cap=200){
  const first=await search(req,filters,1);
  const all=[...first.data];
  const need=Math.min(first.total,cap);
  let page=2;
  while(all.length<need){
   const batch=await search(req,filters,page);
   if(!batch.data.length)break;
   all.push(...batch.data);
   page+=1;
  }
  return {data:all.slice(0,cap),total:first.total};
 }
 async function realSummary(req,raw){
  const request=safeReportRequest(raw);
  const filters=request.filters||{};
  if(filters.level==='high'||filters.level==='watch'){
   const listed=await registry.listRecordedMonitoring(req,{level:filters.level,personType:filters.person_type,page:1,pageSize:200});
   return {filters,includeCount:true,includeList:true,total:listed.total,counts:[{label:filters.level==='high'?'เสี่ยงสูง':'เฝ้าระวัง',count:listed.total}],items:listed.items.map(item=>({full_name:item.full_name,person_type:filters.person_type||'',level:item.level,subdistrict:item.subdistrict,district:item.district}))};
  }
  const found=await collectPeople(req,{person_type:filters.person_type,province:filters.province,district:filters.district,subdistrict:filters.subdistrict,query:filters.search,station:filters.station},200);
  const label={psychiatric:'จิตเวช',drug_user:'ผู้เสพ',dealer:'ผู้ค้า',released:'ผู้พ้นโทษ'}[filters.person_type]||'บุคคล';
  return {filters,includeCount:true,includeList:true,total:found.total,counts:[{label,count:found.total}],items:found.data.map(person=>({full_name:`${person.first_name||''} ${person.last_name||''}`.trim(),person_type:filters.person_type||'',subdistrict:person.tambon||'',district:person.amphoe||''}))};
 }
 function sendReportFile(res,report,downloadName){
  return res.download(report.path,downloadName,(err)=>{fs.unlink(report.path,()=>{});if(err&&!res.headersSent)res.status(500).json({error:'สร้างรายงานไม่สำเร็จ'});});
 }
 router.get('/people',async(req,res)=>{
  try{
   const page=Math.max(1,Number.parseInt(String(req.query.page||'1'),10)||1);
   const limit=Math.min(50,Math.max(1,Number.parseInt(String(req.query.limit||'20'),10)||20));
   const filters={};
   for(const key of ['person_type','province','district','subdistrict','station']){
    if(typeof req.query[key]==='string' && req.query[key].trim()) filters[key]=req.query[key].trim().slice(0,100);
   }
   if(req.query.query||req.query.search) filters.query=String(req.query.query||req.query.search).slice(0,100);
   const result=await search(req,filters,page,false,limit);
   const data=result.data.map(person=>({
    id:person.id,
    person_id:person.id,
    first_name:person.first_name,
    last_name:person.last_name,
    full_name:`${person.first_name||''} ${person.last_name||''}`.trim(),
    person_type:filters.person_type||null,
    status:person.status,
    district:person.amphoe,
    subdistrict:person.tambon,
    station_id:person.station_id,
   }));
   return res.json({data,meta:{total:result.total,page,limit}});
  }catch(e){const failure=realFailure(e);return res.status(failure.status).json(failure);}
 });
 router.post('/reports/summary.pdf',async(req,res)=>{
  try{
   const summary=await realSummary(req,req.body&&req.body.reportRequest);
   const report=await writeSummaryPdf(summary);
   return sendReportFile(res,report,'thanipitak-summary.pdf');
  }catch(e){return res.status(400).json({error:e.message||'สร้างรายงานไม่สำเร็จ',code:'REPORT_FAILED'});}
 });
 router.post('/reports/summary.xlsx',async(req,res)=>{
  try{
   const summary=await realSummary(req,req.body&&req.body.reportRequest);
   const report=writeSummaryExcel(summary);
   return sendReportFile(res,report,'thanipitak-summary.xlsx');
  }catch(e){return res.status(400).json({error:e.message||'สร้างรายงานไม่สำเร็จ',code:'REPORT_FAILED'});}
 });
 router.use((req,res)=>res.status(409).json({error:'ฟังก์ชันนี้ยังไม่เปิดใช้กับข้อมูลจริง',code:'REAL_FEATURE_UNAVAILABLE'}));
 return router;
}
module.exports={createRealDataRoutes};
