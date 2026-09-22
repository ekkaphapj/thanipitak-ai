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
rag=require('../ai/rag');
const {detectDiscoveryIntent,discover}=require('../services/discoveryService');
const {normalizeUtterance,matchPlaceNames,placeKey}=require('../ai/thaiText');
const {extractTimeWindow,hasHardTimeReference}=require('../ai/timeWindow');
const {parseAreaExclusions,removeSpans}=require('../ai/areaExclusion');

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
 if(code==='REAL_LOCATION_NOT_FOUND')return {status:422,code,error:error.message||'ไม่พบชื่อพื้นที่ที่ระบุ กรุณาตรวจสอบชื่อและลองใหม่'};
 if(code==='REAL_LOCATION_AMBIGUOUS')return {status:422,code,error:error.message||'พบชื่อพื้นที่มากกว่าหนึ่งแห่ง กรุณาระบุจังหวัดหรืออำเภอเพิ่ม'};
 if(code==='REAL_UNAVAILABLE'||error?.name==='TimeoutError'||error?.name==='AbortError')return {status:503,code:'REAL_UNAVAILABLE',error:'เชื่อมต่อข้อมูลจริงไม่ได้ในขณะนี้ กรุณาลองใหม่อีกครั้ง'};
 if(code==='REAL_DATA_UNVERIFIABLE'||/ข้อมูลไม่ครบ|จำนวนข้อมูลที่ตรวจสอบได้|ข้อมูลเปลี่ยนระหว่างนับ/.test(error?.message||''))return {status:502,code:'REAL_DATA_UNVERIFIABLE',error:'ข้อมูลจริงตอบกลับไม่ครบหรือกำลังเปลี่ยนแปลง จึงยังสรุปผลไม่ได้'};
 return {status:502,code:'REAL_READ_FAILED',error:'ไม่สามารถอ่านข้อมูลจริงได้ในขณะนี้ กรุณาลองใหม่อีกครั้ง'};
}

// A place-name match that is close but not unique is a question back to the
// officer, not an error: it is returned as a successful choice presentation.
function sendRealFailure(res,error,start) {
 if(error&&error.code==='REAL_LOCATION_CHOICES'){
  return res.json({answer:error.message,grounded:true,dataSource:'real',presentation:error.presentation,meta:{fastPath:true,ollamaCalls:0,responseTimeMs:Date.now()-(start||Date.now())}});
 }
 const failure=realFailure(error);
 return res.status(failure.status).json(failure);
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

// These are high-confidence Whisper variants heard in field use.  Province
// resolution remains a server-side filter and is reconciled with the
// authenticated scope list when it is available; it never changes scope.
const TRANSCRIPT_PROVINCE_ALIASES = new Map([
 ['นะครับพนม', 'นครพนม'],
 ['นะคะพนม', 'นครพนม'],
 ['นะค่ะพนม', 'นครพนม'],
]);
function canonicalProvince(req, value) {
 if(!value)return {value:null};
 const raw=String(value).trim().replace(/(?:ครับ|ค่ะ|คะ)$/u,'');
 const requested=TRANSCRIPT_PROVINCE_ALIASES.get(raw)||raw;
 const provinces=Array.isArray(req.user?.aiScope?.provinces)?req.user.aiScope.provinces.filter(item=>typeof item==='string'):[];
 const matched=provinces.find(item=>item.trim()===requested);
 if(matched)return {value:matched};
 // Without a server-verified list there is nothing to match against, so the
 // request keeps the historical behavior of passing through unchanged.
 if(!provinces.length)return {value:requested};
 // Fuzzy matching may only return names from the authenticated scope list,
 // so a close transcription can be corrected without ever widening scope.
 const candidates=matchPlaceNames(requested,provinces);
 if(candidates.length===1)return {value:candidates[0],fuzzy:{field:'province',from:requested,to:candidates[0]}};
 if(candidates.length>1)return {requested,choices:candidates.slice(0,6)};
 return {value:null,error:`ไม่พบชื่อจังหวัด “${requested}” ในข้อมูลที่เลือกได้ กรุณาตรวจสอบชื่อและลองใหม่`};
}

// Voice commands often drop the word "จังหวัด" ("ขอภาพรวมร้อยเอ็ด").  When
// the keyword extraction finds nothing, a province whose server-verified name
// occurs inside the sentence is treated as the requested filter instead of
// silently falling back to the account profile province.  Matching is limited
// to the authenticated scope list, so this can narrow a request but never
// widen access.
function bareProvincesFromMessage(user,message) {
 const provinces=Array.isArray(user?.aiScope?.provinces)?user.aiScope.provinces.filter(item=>typeof item==='string'&&item.trim()):[];
 const haystack=placeKey(message);
 if(!provinces.length||!haystack)return [];
 return provinces.filter(name=>{
  const key=placeKey(name);
  return key.length>=4&&haystack.includes(key);
 });
}

function isProvinceChangeOnly(message) {
  return /^\s*(?:เปลี่ยน(?:เป็น)?|เลือก(?:เป็น)?|ตั้ง(?:เป็น)?)\s*(?:จังหวัด)?\s*[ก-๙A-Za-z.-]{2,80}\s*$/u.test(String(message||''));
}

// Time windows and area exclusions are deterministic query modifiers. They are
// extracted once per request and removed from the text handed to detectors and
// the model, so an excluded area or a period can never re-enter the plan as a
// positive filter. Period wording the parser cannot resolve is surfaced as
// hardTimeReference so the caller can refuse instead of silently broadening.
function prepareRoutingMessage(message) {
  const timeWindow=extractTimeWindow(message);
  const exclusions=parseAreaExclusions(message);
  const messageNoExclusion=exclusions.length?removeSpans(message,exclusions.map(item=>item.matchedText)):String(message);
  const routingMessage=(timeWindow?removeSpans(messageNoExclusion,[timeWindow.matchedText]):messageNoExclusion)||messageNoExclusion||String(message);
  return {
    timeWindow,
    exclusions,
    hardTimeReference:!timeWindow&&hasHardTimeReference(message),
    // Monitoring detection still needs the period wording, but never the
    // excluded area (which must not become a positive filter).
    messageNoExclusion,
    routingMessage,
  };
}

const PERIOD_CLARIFY='ขออภัย ช่วงเวลาที่ระบุขณะนี้ใช้ตรวจได้กับบันทึกการเยี่ยมและสถานะเฝ้าระวัง/เสี่ยงสูงเท่านั้น เช่น “ใครเสี่ยงสูงเดือนนี้” หรือ “เยี่ยมกี่ครั้งเดือนที่แล้ว” เมื่อเลือกบุคคลไว้ ช่วงเวลาที่เข้าใจได้คือ วันนี้ เมื่อวาน สัปดาห์นี้/ที่แล้ว เดือนนี้/ที่แล้ว ปีนี้/ที่แล้ว และ N วัน/สัปดาห์/เดือน/ปี ล่าสุด หากต้องการจำนวนหรือรายชื่อทั่วไป กรุณาถามโดยไม่ระบุช่วงเวลา';

const STATION_RANK_TYPES = [
  ['psychiatric', /ผู้ป่วยจิตเวช|จิตเวช|ผู้ป่วย/u],
  ['drug_user', /ผู้เสพ|ผู้ใช้ยา|ยาเสพติด/u],
  ['dealer', /ผู้ค้า|ผู้จำหน่าย/u],
  ['released', /ผู้พ้นโทษ|พ้นโทษ/u],
];
const THAI_RANK_NUMBERS = { 'หนึ่ง':1, 'สอง':2, 'สาม':3, 'สี่':4, 'ห้า':5, 'หก':6, 'เจ็ด':7, 'แปด':8, 'เก้า':9, 'สิบ':10 };

function rankLimitFromMessage(message) {
 const text=String(message||'').replace(/\s+/g,' ').trim();
 const arabic=text.match(/(?:^|\s)(\d{1,2})\s*อันดับ|อันดับ(?:แรก)?\s*(\d{1,2})/u);
 const raw=arabic?.[1]||arabic?.[2];
 if(raw){const number=Number(raw);return number>=1&&number<=100?number:null;}
 for(const [word,number] of Object.entries(THAI_RANK_NUMBERS))if(new RegExp(`${word}\\s*อันดับ|อันดับ(?:แรก)?\\s*${word}`, 'u').test(text))return number;
 return null;
}

function detectStationRanking(message) {
 const text=String(message||'').replace(/\s+/g,' ').trim();
 if(!/(?:สภ\.?|สถานีตำรวจ|สถานี)/u.test(text))return null;
 const direction=/น้อย|ต่ำ|เบา/u.test(text)?'asc':/มาก|เยอะ|สูง|อันดับ/u.test(text)?'desc':null;
 if(!direction)return null;
 const matched=STATION_RANK_TYPES.find(([,pattern])=>pattern.test(text));
 return {direction,personType:matched?.[0]||null,limit:rankLimitFromMessage(text)};
}

function likelyUsesLocalAi(message, topic, hasSelectedPerson) {
 if(isProvinceChangeOnly(message)||detectExportIntent(message)||detectStationRanking(message)||detectDiscoveryIntent(message)||detectOverview(message)||hasSelectedPerson)return false;
 const summary=parseSummaryIntent(message);const intent=detectFastPathIntent(message,topic);
 if(summary||intent||/(ตำบล|อำเภอ|จังหวัด)(?:ไหน|ใด|อะไร).*?(มากที่สุด|เยอะที่สุด|น้อยที่สุด|มากสุด|เยอะสุด|น้อยสุด)/u.test(message))return false;
 if(process.env.RAG_ENABLED==='true'&&!hasDBIntent(message)&&rag.directAnswer(message))return false;
 return true;
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
 async function search(req,filters={},page=1,aggregate=false,pageSize=20,allowFuzzy=true) {
  const size=Math.min(50,Math.max(1,Number(pageSize)||20));
  let fuzzyApplied=null;
  let provinceStationIds=null;
  const p=new URLSearchParams({select:'id,first_name,last_name,station_id,province,amphoe,tambon,type_id,status',order:'first_name.asc,id.asc',limit:String(size),offset:String((page-1)*size)});
  applyPeopleStationScope(req.user,p);
  const clean=v=>String(v).replace(/[%*(),]/g,'').slice(0,100);
  for(const [input,column] of [['district','amphoe'],['subdistrict','tambon']])if(filters[input])p.set(column,`ilike.*${clean(filters[input])}*`);
  if(filters.person_id)p.set('id',`eq.${Number(filters.person_id)||0}`);
  // Exclusions are server-resolved names applied as PostgREST not-filters;
  // they intersect the station scope and can only narrow a result.
  for(const ex of filters.exclude||[]){
   if(ex.column==='station_id')p.append('not.station_id',`in.(${ex.ids.join(',')})`);
   else p.append(`not.${ex.column}`,`ilike.*${clean(ex.value)}*`);
  }
  if(filters.query||filters.search)p.set('or',`(first_name.ilike.*${clean(filters.query||filters.search)}*,last_name.ilike.*${clean(filters.query||filters.search)}*)`);
  if(filters.status)throw new Error('การแปลสถานะทะเบียนจริงยังไม่พร้อม กรุณาค้นด้วยชื่อหรือพื้นที่');
  if(filters.province){
   // Province names are resolved against stations.province — the same source
   // the audited aggregate uses — and applied as a station filter.  Matching
   // on free-text people.province made province-scoped lists and reports come
   // back silently empty whenever the stored text differed from the request.
   const scopedId=applyPeopleStationScope(req.user,new URLSearchParams());
   const st=await rows(req,'stations',new URLSearchParams({select:'station_id',province:`eq.${clean(filters.province)}`,limit:'1000'}));
   const ids=st.data.map(x=>Number(x.station_id)).filter(id=>scopedId? id===scopedId : req.user.role==='admin');
   if(!ids.length)return {data:[],total:0};
   provinceStationIds=ids;
   p.set('station_id', scopedId ? `eq.${scopedId}` : `in.(${ids.join(',')})`);
  }
  if(filters.station){
   const own=parseStationId(req.user.stationId);
   const s=await rows(req,'stations',new URLSearchParams({select:'station_id',station_name:`ilike.*${clean(filters.station)}*`,limit:'1000'}));
   let ids=s.data.map(x=>Number(x.station_id)).filter(id=>own?id===own:req.user.role==='admin');
   if(!ids.length && allowFuzzy){
    // A station name that matches nothing exactly may still be a close
    // transcription. Candidates come from the stations catalogue this account
    // can already read, and an own-station account can never resolve to
    // another station, so this can narrow a typo but never widen scope.
    const all=await rows(req,'stations',new URLSearchParams({select:'station_id,station_name',limit:'1000'}));
    const allowed=all.data.filter(row=>{
     const id=Number(row.station_id);
     return own ? id===own : req.user.role==='admin';
    });
    const matches=matchPlaceNames(filters.station,allowed.map(row=>String(row.station_name||'').trim()).filter(Boolean));
    if(matches.length===1){
     const row=allowed.find(item=>String(item.station_name||'').trim()===matches[0]);
     ids.push(Number(row.station_id));
     fuzzyApplied={field:'station',from:filters.station,to:matches[0]};
    } else if(matches.length>1)throw stationChoicesError(filters.station,matches);
   }
   if(!ids.length){const error=new Error(`ไม่พบชื่อ สภ. “${filters.station}” กรุณาตรวจสอบชื่อและลองใหม่`);error.code='REAL_LOCATION_NOT_FOUND';throw error;}
   if(provinceStationIds){
    ids=ids.filter(id=>provinceStationIds.includes(id));
    if(!ids.length)return {data:[],total:0};
   }
   if(!own&&ids.length>1){const error=new Error(`พบชื่อ สภ. “${filters.station}” มากกว่าหนึ่งแห่ง กรุณาระบุจังหวัดเพิ่ม`);error.code='REAL_LOCATION_AMBIGUOUS';throw error;}
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
   let found=await rows(req,'people',p);
   if(!found.data.length&&(filters.district||filters.subdistrict)&&allowFuzzy){
    const fix=await fuzzyAreaFix(req,filters);
    if(fix){
     for(const key of ['district','subdistrict'])if(fix.filters[key])filters[key]=fix.filters[key];
     fuzzyApplied=fix.fuzzy;
     const retried=await search(req,filters,page,false,pageSize,false);
     if(fuzzyApplied)retried.fuzzy=fuzzyApplied;
     return retried;
    }
   }
   if(!found.data.length&&(filters.query||filters.search)&&allowFuzzy){
    // A name that returns nothing may be a close transcription. Candidates
    // come only from people this account can already read; one match retries
    // the exact record, several ask the officer to choose.
    const fix=await fuzzyNameFix(req,String(filters.query||filters.search));
    if(fix&&fix.person){
     const retried=await search(req,{...filters,query:undefined,search:undefined,person_id:fix.person.id},page,false,pageSize,false);
     retried.fuzzy={field:'search',from:String(filters.query||filters.search),to:fix.person.name};
     return retried;
    }
    if(fix&&fix.choices)throw personChoicesError(String(filters.query||filters.search),fix.choices);
   }
   const scoped=found.data.filter(person=>personInOwnStation(req.user,person));
   const result=scoped.length!==found.data.length?{data:scoped,total:scoped.length}:found;
   if(result.total===0&&(filters.district||filters.subdistrict)){
    const label=filters.subdistrict?'ตำบล':'อำเภอ';const value=filters.subdistrict||filters.district;
    const error=new Error(`ไม่พบข้อมูลตามชื่อ${label} “${value}” กรุณาตรวจสอบชื่อและลองใหม่`);error.code='REAL_LOCATION_NOT_FOUND';throw error;
   }
   if(fuzzyApplied)result.fuzzy=fuzzyApplied;
   return result;
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
  const requestedArea=filters.station?`สภ.${String(filters.station).replace(/^สภ\.?\s*/u,'')}`:filters.province?`จังหวัด${filters.province}`:filters.district?`อำเภอ${filters.district}`:filters.subdistrict?`ตำบล${filters.subdistrict}`:null;
  const data={scopeLabel:requestedArea||req.user.stationName||'พื้นที่ที่บัญชีนี้มีสิทธิ์เข้าถึง',requestedScope,groupBy,total:found.total,
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
 function stationChoicesError(input,names) {
  const error=new Error(`พบชื่อ สภ. ที่ใกล้เคียงกับ “${input}” หลายแห่ง กรุณาเลือก`);
  error.code='REAL_LOCATION_CHOICES';
  error.presentation={type:'place_choices',field:'station',replaceText:input,
   choices:names.slice(0,6).map((name,index)=>({index:index+1,name,replaceWith:String(name).replace(/^สภ\.?\s*/u,''),display:`สภ.${String(name).replace(/^สภ\.?\s*/u,'')}`,filters:{station:name}}))};
  return error;
 }
 function areaChoicesError(label,input,matches,pairs) {
  const isSubdistrict=label==='ตำบล';
  const error=new Error(`พบ${label}ที่ใกล้เคียงกับ “${input}” หลายรายการ กรุณาเลือก`);
  error.code='REAL_LOCATION_CHOICES';
  error.presentation={type:'place_choices',field:isSubdistrict?'subdistrict':'district',replaceText:input,
   choices:matches.slice(0,6).map((name,index)=>{
    const filters={};let suffix='';
    if(isSubdistrict){
     filters.subdistrict=name;
     const districts=[...new Set(pairs.filter(pair=>pair.subdistrict===name).map(pair=>pair.district).filter(Boolean))];
     if(districts.length===1){filters.district=districts[0];suffix=` อำเภอ${districts[0]}`;}
    } else {
     filters.district=name;
     const provinces=[...new Set(pairs.filter(pair=>pair.district===name).map(pair=>pair.province).filter(Boolean))];
     if(provinces.length===1){filters.province=provinces[0];suffix=` จังหวัด${provinces[0]}`;}
    }
    return {index:index+1,name,replaceWith:name,display:`${label}${name}${suffix}`,filters};
   })};
  return error;
 }
 // Distinct area names observed inside the authenticated scope. The catalogue
 // is only consulted to correct a misspelled area that returned zero rows, so
 // every candidate is a value the officer's account can already read.
 async function areaCatalogue(req) {
  const params=new URLSearchParams({select:'province,amphoe,tambon',order:'id.asc',limit:'1000'});
  applyPeopleStationScope(req.user,params);
  const provinces=new Set(),districts=new Set(),subdistricts=new Set();
  const pairs=new Map();
  let offset=0;
  for(let page=0;page<20;page++){
   params.set('offset',String(offset));
   const batch=await rows(req,'people',params);
   for(const row of batch.data){
    const province=String(row.province||'').trim();
    const district=String(row.amphoe||'').trim();
    const subdistrict=String(row.tambon||'').trim();
    if(province)provinces.add(province);
    if(district)districts.add(district);
    if(subdistrict){subdistricts.add(subdistrict);pairs.set(`${subdistrict}\u0000${district}\u0000${province}`,{subdistrict,district,province});}
   }
   offset+=batch.data.length;
   if(offset>=batch.total)break;
  }
  return {provinces:[...provinces],districts:[...districts],subdistricts:[...subdistricts],pairs:[...pairs.values()]};
 }
 async function fuzzyAreaFix(req,filters) {
  const catalogue=await areaCatalogue(req);
  if(filters.subdistrict){
   const matches=matchPlaceNames(filters.subdistrict,catalogue.subdistricts);
   if(matches.length===1){
    const name=matches[0];
    const districts=[...new Set(catalogue.pairs.filter(pair=>pair.subdistrict===name).map(pair=>pair.district).filter(Boolean))];
    const fix={filters:{subdistrict:name},fuzzy:{field:'subdistrict',from:filters.subdistrict,to:name}};
    if(districts.length===1)fix.filters.district=districts[0];
    return fix;
   }
   if(matches.length>1)throw areaChoicesError('ตำบล',filters.subdistrict,matches,catalogue.pairs);
   return null;
  }
  const matches=matchPlaceNames(filters.district,catalogue.districts);
  if(matches.length===1){
   const name=matches[0];
   const provinces=[...new Set(catalogue.pairs.filter(pair=>pair.district===name).map(pair=>pair.province).filter(Boolean))];
   const fix={filters:{district:name},fuzzy:{field:'district',from:filters.district,to:name}};
   if(provinces.length===1)fix.filters.province=provinces[0];
   return fix;
  }
  if(matches.length>1)throw areaChoicesError('อำเภอ',filters.district,matches,catalogue.pairs);
  return null;
 }
 // Distinct person names observed inside the authenticated scope. Consulted
 // only when an exact name search returned zero rows, so every candidate is a
 // person the officer's account can already read.
 async function nameCatalogue(req) {
  const params=new URLSearchParams({select:'id,first_name,last_name,tambon,amphoe',order:'id.asc',limit:'1000'});
  applyPeopleStationScope(req.user,params);
  const people=[];let offset=0;
  for(let page=0;page<20;page++){
   params.set('offset',String(offset));
   const batch=await rows(req,'people',params);
   people.push(...batch.data);
   offset+=batch.data.length;
   if(offset>=batch.total)break;
  }
  return people.map(person=>({
   id:Number(person.id),first_name:String(person.first_name||'').trim(),last_name:String(person.last_name||'').trim(),
   tambon:String(person.tambon||'').trim(),amphoe:String(person.amphoe||'').trim(),
  })).filter(person=>Number.isInteger(person.id)&&person.id>0&&(person.first_name||person.last_name));
 }
 function fullNameOf(person){return `${person.first_name} ${person.last_name}`.replace(/\s+/g,' ').trim();}
 const NAME_TITLES=/^(?:นาย|นางสาว|นาง|ดช\.?|ดญ\.?|ดร\.|พ\.ต\.ท\.|พ\.ต\.ต\.|พ\.ต\.ค\.|ร\.ต\.อ\.|ร\.ต\.ต\.|ร\.ต\.ค\.|ส\.ต\.อ\.|ส\.ต\.ต\.|ส\.ต\.ค\.)\s*/u;
 async function fuzzyNameFix(req,input) {
  const people=await nameCatalogue(req);
  const stripped=String(input||'').replace(NAME_TITLES,'').trim();
  if(placeKey(stripped).length<2)return null;
  // A name tier maps each distinct name to every scoped person carrying it,
  // so a shared first name stays an ambiguity instead of collapsing onto the
  // first row.
  const byFull=new Map(),byFirst=new Map(),byLast=new Map();
  for(const person of people){
   const full=fullNameOf(person);
   if(full){const bucket=byFull.get(full)||[];bucket.push(person);byFull.set(full,bucket);}
   if(person.first_name){const bucket=byFirst.get(person.first_name)||[];bucket.push(person);byFirst.set(person.first_name,bucket);}
   if(person.last_name){const bucket=byLast.get(person.last_name)||[];bucket.push(person);byLast.set(person.last_name,bucket);}
  }
  const pick=(map)=>{
   const matches=matchPlaceNames(stripped,[...map.keys()]);
   const found=[];const seen=new Set();
   for(const name of matches)for(const person of map.get(name)||[])if(!seen.has(person.id)){seen.add(person.id);found.push(person);}
   return found;
  };
  let found=pick(byFull);
  if(!found.length)found=pick(byFirst);
  if(!found.length)found=pick(byLast);
  found=found.slice(0,6);
  if(found.length===1)return {person:{id:found[0].id,name:fullNameOf(found[0])}};
  if(found.length>1)return {choices:found.map(person=>({id:person.id,name:fullNameOf(person),display:`${fullNameOf(person)}${person.tambon?` • ตำบล${person.tambon}`:''}${person.amphoe?` อ.${person.amphoe}`:''}`}))};
  return null;
 }
 function personChoicesError(input,choices) {
  const error=new Error(`พบชื่อที่ใกล้เคียงกับ “${input}” หลายคน กรุณาเลือก`);
  error.code='REAL_LOCATION_CHOICES';
  error.presentation={type:'place_choices',field:'search',choiceLabel:'ตัวเลือกชื่อ',replaceText:input,
   choices:choices.map((choice,index)=>({index:index+1,name:choice.name,replaceWith:choice.name,display:choice.display}))};
  return error;
 }
 function exclusionChoices(input,options) {
  const error=new Error(`พบพื้นที่ที่ใกล้เคียงกับ “${input}” ที่ต้องการยกเว้นหลายรายการ กรุณาเลือก`);
  error.code='REAL_LOCATION_CHOICES';
  error.presentation={type:'place_choices',field:'exclude',replaceText:input,
   choices:options.slice(0,6).map((option,index)=>({index:index+1,name:option.value,replaceWith:option.replaceWith||option.value,display:`${option.prefix}${option.value}`}))};
  return error;
 }
 function exclusionNotFound(label,value) {
  const error=new Error(`ไม่พบชื่อ${label} “${value}” ที่ต้องการยกเว้น กรุณาตรวจสอบชื่อและลองใหม่`);
  error.code='REAL_LOCATION_NOT_FOUND';
  return error;
 }
 // Each exclusion becomes either a not.<area column> filter or, for provinces,
 // a not.station_id filter resolved through stations.province — the same
 // authoritative source the positive province filter uses.
 async function excludeProvince(req,item) {
  const st=await rows(req,'stations',new URLSearchParams({select:'station_id,province',limit:'1000'}));
  const names=[...new Set(st.data.map(row=>String(row.province||'').trim()).filter(Boolean))];
  const exact=names.find(name=>placeKey(name)===placeKey(item.value));
  const province=exact||(matchPlaceNames(item.value,names).length===1?matchPlaceNames(item.value,names)[0]:null);
  if(province){
   const ids=st.data.filter(row=>placeKey(String(row.province||''))===placeKey(province)).map(row=>Number(row.station_id)).filter(Number.isFinite);
   if(ids.length)return {column:'station_id',ids,label:`จังหวัด${province}`};
  }
  const fuzzy=matchPlaceNames(item.value,names);
  if(fuzzy.length>1)throw exclusionChoices(item.value,fuzzy.map(name=>({prefix:'จังหวัด',value:name})));
  throw exclusionNotFound('จังหวัด',item.value); }
 async function excludeArea(req,item,label) {
  const catalogue=await areaCatalogue(req);
  const list=item.kind==='subdistrict'?catalogue.subdistricts:catalogue.districts;
  const matches=matchPlaceNames(item.value,list);
  if(matches.length===1)return {column:item.kind==='subdistrict'?'tambon':'amphoe',value:matches[0],label:`${label}${matches[0]}`};
  if(matches.length>1)throw exclusionChoices(item.value,matches.map(name=>({prefix:label,value:name})));
  throw exclusionNotFound(label,item.value);
 }
 async function resolveExclusions(req,exclusions) {
  const resolved=[];
  for(const item of exclusions.slice(0,3)){
   if(item.kind==='province')resolved.push(await excludeProvince(req,item));
   else if(item.kind==='subdistrict')resolved.push(await excludeArea(req,item,'ตำบล'));
   else if(item.kind==='district')resolved.push(await excludeArea(req,item,'อำเภอ'));
   else{
    const catalogue=await areaCatalogue(req);
    const sub=matchPlaceNames(item.value,catalogue.subdistricts);
    const dis=matchPlaceNames(item.value,catalogue.districts);
    const options=[...sub.map(name=>({prefix:'ตำบล',value:name,column:'tambon',replaceWith:`ตำบล${name}`})),...dis.map(name=>({prefix:'อำเภอ',value:name,column:'amphoe',replaceWith:`อำเภอ${name}`}))];
    if(options.length===1)resolved.push({column:options[0].column,value:options[0].value,label:`${options[0].prefix}${options[0].value}`});
    else if(options.length>1)throw exclusionChoices(item.value,options);
    else resolved.push(await excludeProvince(req,item));
   }
  }
  return resolved;
 }
 router.get('/ai/status',(req,res)=>res.json({available:true,model:'ข้อมูลจริง • อ่านจาก Supabase'}));
 router.get('/ai/access-scope',(req,res)=>res.json({scope:req.user.aiScope||null,readOnly:true}));
 // The Edge Function scope object describes the account's authority (for
 // example level "all"), never the requested filter, so the heading must name
 // the area the officer asked for whenever one was applied.
 function scopeHeading(requestedLabel,result){
  if(requestedLabel)return requestedLabel;
  const level=result?.scope?.level;
  if(level==='all')return 'ทุกจังหวัดตามสิทธิ์ที่ยืนยันแล้ว';
  if(level==='region4')return 'ทุกจังหวัดในขอบเขตที่ยืนยันแล้ว';
  if(result?.scope?.province)return `จังหวัด${result.scope.province}`;
  return 'พื้นที่ตามสิทธิ์ที่ยืนยันแล้ว';
 }
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
  const scope=scopeHeading(province?`จังหวัด${province}`:null,result);
  return {
   answer:`ภาพรวมผู้ป่วยจิตเวช • ${scope}\nรวม ${total} คน จาก ${rows.length} สภ.`,
   presentation:{type:'location_summary',groupBy:'station',readOnlyAggregate:true,items:rows,filters:{person_type:'psychiatric'}},
  };
 }
 async function targetPersonSummary(req, province=null) {
  const result=await aiTools.targetPersonSummary(req.realToken,{province});
  const rows=result.rows.map(row=>({stationName:String(row.station_name||'ไม่ระบุ สภ.'),province:String(row.province||''),psychiatric:Number(row.psychiatric_total)||0,drugUser:Number(row.drug_user_total)||0,dealer:Number(row.dealer_total)||0,released:Number(row.released_total)||0,total:Number(row.target_total)||0}));
  const totals=rows.reduce((sum,row)=>({psychiatric:sum.psychiatric+row.psychiatric,drugUser:sum.drugUser+row.drugUser,dealer:sum.dealer+row.dealer,released:sum.released+row.released,total:sum.total+row.total}),{psychiatric:0,drugUser:0,dealer:0,released:0,total:0});
  const scope=scopeHeading(province?`จังหวัด${province}`:null,result);
  return {answer:`ภาพรวมบุคคลเป้าหมาย • ${scope}\nรวม ${totals.total} คน • ผู้ป่วยจิตเวช ${totals.psychiatric} • ผู้เสพ ${totals.drugUser} • ผู้ค้า ${totals.dealer} • ผู้พ้นโทษ ${totals.released}`,presentation:{type:'target_person_summary',readOnlyAggregate:true,scopeLabel:scope,rows,totals}};
 }
 async function stationRanking(req, province, request) {
  const summary=await targetPersonSummary(req,province);
  const field={psychiatric:'psychiatric',drug_user:'drugUser',dealer:'dealer',released:'released'}[request.personType]||'total';
  const label={psychiatric:'ผู้ป่วยจิตเวช',drug_user:'ผู้เสพ',dealer:'ผู้ค้า',released:'ผู้พ้นโทษ'}[request.personType]||'บุคคลทั้งหมด';
  const sorted=[...summary.presentation.rows].sort((left,right)=>{
   const difference=request.direction==='asc'?left[field]-right[field]:right[field]-left[field];
   return difference||(left.stationName===right.stationName?0:(left.stationName<right.stationName?-1:1));
  });
  const rows=request.limit===null?sorted:sorted.slice(0,request.limit);
  const directionLabel=request.direction==='asc'?'น้อยไปมาก':'มากไปน้อย';
  const amountLabel=request.limit===null?`แสดงทั้งหมด ${rows.length} สภ.`:`${rows.length} อันดับแรก`;
  const answer=`จัดอันดับ สภ. • ${summary.presentation.scopeLabel}\nเรียง${label}${directionLabel} • ${amountLabel}`;
  return {answer,presentation:{type:'station_ranking',scopeLabel:summary.presentation.scopeLabel,rows,personType:request.personType,direction:request.direction,limit:request.limit}};
 }
 router.post('/ai/chat/processing',(req,res)=>{
  const raw=req.body?.message;
  if(typeof raw!=='string'||!raw.trim()||raw.length>2000)return res.status(400).json({error:'คำถามไม่ถูกต้อง'});
  const message=normalizeUtterance(raw)||raw;
  const topic=sanitizeTopic(req.body?.context?.topic);
  return res.json({willUseLocalAi:likelyUsesLocalAi(prepareRoutingMessage(message).routingMessage,topic,Boolean(selectedPersonId(req.body)))});
 });
 router.post('/ai/chat',async(req,res)=>{
  const start=Date.now();const raw=req.body?.message;
  if(typeof raw!=='string'||!raw.trim()||raw.length>2000)return res.status(400).json({error:'คำถามไม่ถูกต้อง'});
  // Typed and transcribed commands share one canonical form: politeness
  // particles, Thai digits, zero-width characters, and spacing are normalized
  // before every detector and before the model sees the request.
  const message=normalizeUtterance(raw)||raw;
  const personId=selectedPersonId(req.body);
  const prepared=prepareRoutingMessage(message);
  const routingMessage=prepared.routingMessage;
  const periodRequested=Boolean(prepared.timeWindow||prepared.hardTimeReference);
  // Choice follow-ups re-send the original command with the chosen verified
  // name substituted, so every choices presentation carries that text.
  const sendFailure=(e)=>{
   if(e&&e.code==='REAL_LOCATION_CHOICES'&&e.presentation&&!e.presentation.originalMessage)e.presentation={...e.presentation,originalMessage:message};
   return sendRealFailure(res,e,start);
  };
  let ranking=/(ตำบล|อำเภอ|จังหวัด)(?:ไหน|ใด|อะไร).*?(มากที่สุด|เยอะที่สุด|น้อยที่สุด|มากสุด|เยอะสุด|น้อยสุด)/.exec(routingMessage);
  const ordered=/(?:ตาม|แยก(?:ตาม)?|แต่ละ)(ตำบล|อำเภอ|จังหวัด)/.exec(routingMessage);
  let showAll=!!ordered;
  if(!ranking&&ordered)ranking=[routingMessage,ordered[1],/น้อยไปมาก/.test(routingMessage)?'น้อยสุด':'มากสุด'];
  let plan=null;let ollamaCalls=0;
  const incomingTopic=sanitizeTopic(req.body?.context?.topic);
  const provinceResolution=canonicalProvince(req,provinceFromMessage(routingMessage));
  if(provinceResolution.error)return res.status(422).json({error:provinceResolution.error,code:'REAL_LOCATION_NOT_FOUND',dataSource:'real',conversation:{topic:incomingTopic},meta:{fastPath:true,ollamaCalls:0,responseTimeMs:Date.now()-start}});
  if(provinceResolution.choices){
   return res.json({answer:`พบจังหวัดที่ใกล้เคียงกับ “${provinceResolution.requested}” หลายจังหวัด กรุณาเลือก`,grounded:true,dataSource:'real',
    presentation:{type:'place_choices',field:'province',replaceText:provinceResolution.requested,originalMessage:message,
     choices:provinceResolution.choices.map((name,index)=>({index:index+1,name,replaceWith:name,display:`จังหวัด${name}`,filters:{province:name}}))},
    conversation:{topic:incomingTopic},meta:{fastPath:true,ollamaCalls:0,responseTimeMs:Date.now()-start}});
  }
  const explicitProvince=provinceResolution.value;
  let fuzzyNote=provinceResolution.fuzzy||null;
  let bareResolution=null;
  if(!explicitProvince){
   const bare=bareProvincesFromMessage(req.user,routingMessage);
   if(bare.length===1)bareResolution={value:bare[0]};
   else if(bare.length>1)bareResolution={choices:bare};
  }
  if(bareResolution?.choices){
   return res.json({answer:`พบชื่อจังหวัดในคำสั่งหลายจังหวัด กรุณาเลือก`,grounded:true,dataSource:'real',
    presentation:{type:'place_choices',field:'province',replaceText:'',originalMessage:message,
     choices:bareResolution.choices.map((name,index)=>({index:index+1,name,replaceText:name,replaceWith:name,display:`จังหวัด${name}`,filters:{province:name}}))},
    conversation:{topic:incomingTopic},meta:{fastPath:true,ollamaCalls:0,responseTimeMs:Date.now()-start}});
  }
  // The authenticated profile is server-verified.  It supplies the initial
  // province filter only when the officer did not name one in this command.
  const selectedProvince=explicitProvince||bareResolution?.value||incomingTopic?.province||req.user.province||null;
  // Attach the applied correction to every successful answer of this request
  // so the interface can show what the system understood.
  const respond=(payload)=>{
   if(fuzzyNote&&!(payload.meta&&payload.meta.fuzzy))payload.meta={...(payload.meta||{}),fuzzy:fuzzyNote};
   return res.json(payload);
  };
  const selectedTopic=selectedProvince?sanitizeTopic({...(incomingTopic||{}),province:selectedProvince}):incomingTopic;
  if(isProvinceChangeOnly(routingMessage)){
   return respond({answer:`ตั้งค่าจังหวัดที่ต้องการดูเป็นจังหวัด${selectedProvince} แล้ว คำสั่งถัดไปจะใช้จังหวัดนี้เป็นตัวกรองภายในสิทธิ์ของบัญชี`,grounded:true,dataSource:'real',conversation:{topic:selectedTopic},meta:{fastPath:true,ollamaCalls:0,responseTimeMs:Date.now()-start}});
  }
  const stationRank=detectStationRanking(routingMessage);
  if(stationRank){
   if(prepared.exclusions.length)return respond({answer:'การยกเว้นพื้นที่ยังไม่รองรับกับการจัดอันดับ สภ. กรุณาถามแยกตามพื้นที่ที่ต้องการดู',grounded:false,dataSource:'real',conversation:{topic:selectedTopic},meta:{fastPath:true,ollamaCalls:0,responseTimeMs:Date.now()-start}});
   if(periodRequested)return respond({answer:PERIOD_CLARIFY,grounded:false,dataSource:'real',conversation:{topic:selectedTopic},meta:{fastPath:true,ollamaCalls:0,responseTimeMs:Date.now()-start}});
   try { const result=await stationRanking(req,selectedProvince,stationRank);return respond({answer:result.answer,grounded:true,dataSource:'real',toolsUsed:[{name:'ai-summary/target_person_summary'}],presentation:result.presentation,conversation:{topic:selectedTopic},meta:{fastPath:true,ollamaCalls:0,responseTimeMs:Date.now()-start}}); }
   catch(e){return sendFailure(e);}
  }
  const exportIntent=detectExportIntent(routingMessage);
  if(exportIntent){
   const reportRequest=reportRequestFromExport(exportIntent,incomingTopic);
   const bits=[];
   if(reportRequest.filters.person_type)bits.push({psychiatric:'ผู้ป่วยจิตเวช',drug_user:'ผู้เสพ',dealer:'ผู้ค้า',released:'ผู้พ้นโทษ'}[reportRequest.filters.person_type]);
   const files=exportIntent.formats.map(item=>item==='xlsx'?'Excel':'PDF').join(' และ ');
   const needsConfirm=exportIntent.confirm||Boolean(incomingTopic);
   const answer=needsConfirm
    ?'ต้องการสร้างรายงานของรายการหรือภาพรวมล่าสุดใช่หรือไม่? เลือก 1. ใช่ หรือ 2. ไม่'
    :`พร้อมสร้างรายงาน${files} จากทะเบียนจริงตามสิทธิ์บัญชีนี้ กดดาวน์โหลดด้านล่าง (ไม่รวมเลขบัตรและเบอร์โทร)`;
   return respond({answer,grounded:true,dataSource:'real',presentation:{type:'report_offer',formats:exportIntent.formats,auto:needsConfirm?null:exportIntent.auto,confirm:needsConfirm,reportRequest},conversation:{topic:incomingTopic},meta:{fastPath:true,ollamaCalls:0,responseTimeMs:Date.now()-start}});
  }
  const summary=parseSummaryIntent(routingMessage);const intent=detectFastPathIntent(routingMessage,selectedTopic);
  const overview=detectOverview(routingMessage);
  const topN=topNFromMessage(routingMessage);
  // “ขอ 5 อันดับตำบล…” is a complete, deterministic grouping request even
  // when the general spoken-language fast path does not recognise its wording.
  if(!ranking&&topN!==null){
   const area=/(ตำบล|อำเภอ|จังหวัด)/.exec(routingMessage);
   if(area)ranking=[routingMessage,area[1],/น้อย/.test(routingMessage)?'น้อยสุด':'มากสุด'];
  }
  const intentTopic=topicFromIntent(intent)||selectedTopic;
  const conversation={topic:selectedProvince?sanitizeTopic({...(intentTopic||{}),province:selectedProvince}):intentTopic};
  const discoveryIntent=detectDiscoveryIntent(routingMessage);
  if(discoveryIntent){
   if(prepared.exclusions.length)return respond({answer:'การยกเว้นพื้นที่ยังไม่รองรับกับการวิเคราะห์ภาพรวมอัตโนมัติ กรุณาถามแยกตามพื้นที่ที่ต้องการดู',grounded:false,dataSource:'real',conversation,meta:{fastPath:true,ollamaCalls:0,responseTimeMs:Date.now()-start}});
   if(periodRequested)return respond({answer:PERIOD_CLARIFY,grounded:false,dataSource:'real',conversation,meta:{fastPath:true,ollamaCalls:0,responseTimeMs:Date.now()-start}});
   try { const result=await realDiscovery(req,discoveryIntent);return respond({answer:result.answer,grounded:true,dataSource:'real',toolsUsed:[{name:'supabase_aggregate_discovery'}],presentation:result.presentation,conversation,meta:{fastPath:true,ollamaCalls:0,responseTimeMs:Date.now()-start}}); }
   catch(e){return sendFailure(e);}
  }
  // Exclusions are resolved against the server-verified scope catalogue only
  // for questions that will actually read the registry.
  let excludeFilters=[];let excludeNote='';
  if(prepared.exclusions.length&&hasDBIntent(routingMessage)){
   try {
    excludeFilters=await resolveExclusions(req,prepared.exclusions);
    excludeNote=` (ไม่รวม${excludeFilters.map(filter=>filter.label).join(' ')})`;
   } catch(e){return sendFailure(e);}
  }
  if(overview){
   // This is the first audited aggregate tool supplied by the primary system.
   // It returns counts only; no direct registry read is made from this app.
   if(overview.filters.person_type==='psychiatric'){
    if(prepared.exclusions.length||periodRequested)return respond({answer:prepared.exclusions.length?'การยกเว้นพื้นที่ยังไม่รองรับกับภาพรวมจากระบบกลาง กรุณาถามแยกตามพื้นที่':PERIOD_CLARIFY,grounded:false,dataSource:'real',conversation,meta:{fastPath:true,ollamaCalls:0,responseTimeMs:Date.now()-start}});
    try { const result=await psychiatricSummary(req,selectedProvince); return respond({answer:result.answer,grounded:true,dataSource:'real',toolsUsed:[{name:'ai-summary/psychiatric_summary'}],presentation:result.presentation,conversation,meta:{fastPath:true,ollamaCalls:0,responseTimeMs:Date.now()-start}}); }
    catch(e){return sendFailure(e);}
   }
   if(!overview.filters.person_type || ['drug_user','dealer','released'].includes(overview.filters.person_type)){
    if(prepared.exclusions.length||periodRequested)return respond({answer:prepared.exclusions.length?'การยกเว้นพื้นที่ยังไม่รองรับกับภาพรวมจากระบบกลาง กรุณาถามแยกตามพื้นที่':PERIOD_CLARIFY,grounded:false,dataSource:'real',conversation,meta:{fastPath:true,ollamaCalls:0,responseTimeMs:Date.now()-start}});
    try { const result=await targetPersonSummary(req,selectedProvince);const reportTopic=sanitizeTopic({...(conversation.topic||{}),report_kind:'target_person_aggregate'}); return respond({answer:result.answer,grounded:true,dataSource:'real',toolsUsed:[{name:'ai-summary/target_person_summary'}],presentation:result.presentation,conversation:{topic:reportTopic},meta:{fastPath:true,ollamaCalls:0,responseTimeMs:Date.now()-start}}); }
    catch(e){return sendFailure(e);}
   }
   try {
    if(periodRequested)return respond({answer:PERIOD_CLARIFY,grounded:false,dataSource:'real',conversation,meta:{fastPath:true,ollamaCalls:0,responseTimeMs:Date.now()-start}});
    const overviewFilters={...overview.filters};
    if(!overviewFilters.province&&selectedProvince)overviewFilters.province=selectedProvince;
    if(excludeFilters.length)overviewFilters.exclude=excludeFilters;
    const result=await realOverview(req,overview.requestedScope,overviewFilters);
    conversation.topic=sanitizeTopic(overviewFilters);
    return respond({answer:result.answer+(excludeNote||''),grounded:true,dataSource:'real',toolsUsed:[{name:'supabase_overview_read'}],presentation:result.presentation,conversation,meta:{fastPath:true,ollamaCalls:0,responseTimeMs:Date.now()-start}});
   }
   catch(e){return sendFailure(e);}
  }
  if(personId && !isCollectionQuestion(routingMessage,intent,ranking,summary,personId)) {
   if(prepared.hardTimeReference&&/เยี่ยม|ประวัติ|ปัสสาวะ|ฉี่|ตรวจยา|เสี่ยง|เฝ้าระวัง/.test(routingMessage))return respond({answer:PERIOD_CLARIFY,grounded:false,dataSource:'real',meta:{fastPath:true,ollamaCalls:0,responseTimeMs:Date.now()-start}});
   try {
    const found=await readSelectedPerson(req,personId);
    if(!found)return respond({answer:'ไม่พบบุคคลนี้ในพื้นที่ที่ท่านมีสิทธิ์เข้าถึง',grounded:true,dataSource:'real',meta:{fastPath:true,ollamaCalls:0,responseTimeMs:Date.now()-start}});
    const dossier=await registry.readDossier(req,personId,found,prepared.timeWindow||{});
    const recorded=registry.formatDossier(dossier,routingMessage);
    return respond({answer:recorded||formatSelectedPerson(found.person,found.typeName,found.stationName,routingMessage),grounded:true,dataSource:'real',toolsUsed:[{name:'supabase_person_read'}],meta:{fastPath:true,ollamaCalls:0,responseTimeMs:Date.now()-start}});
   } catch(e) { return sendFailure(e); }
  }
  const monitor=monitoringQuestion(prepared.messageNoExclusion);
  if(monitor) {
   if(monitor.unsupported)return respond({answer:'ขณะนี้ตรวจได้เฉพาะสถานะเฝ้าระวัง/เสี่ยงสูงจากบันทึกที่มีวันที่ชัดเจน ช่วงเวลาที่เข้าใจได้คือ วันนี้ เมื่อวาน สัปดาห์นี้/ที่แล้ว เดือนนี้/ที่แล้ว ปีนี้/ที่แล้ว และ N วัน/สัปดาห์/เดือน/ปี ล่าสุด',grounded:false,dataSource:'real',meta:{fastPath:true,ollamaCalls:0,responseTimeMs:Date.now()-start}});
   try {
    const result=await registry.listRecordedMonitoring(req,{level:monitor.level,personType:monitor.person_types[0]||null,page:monitor.page||1,
     ...(monitor.district?{district:monitor.district}:{}),...(monitor.subdistrict?{subdistrict:monitor.subdistrict}:{}),
     ...(monitor.timeWindow?{from:monitor.timeWindow.from,to:monitor.timeWindow.to}:{}),
     ...(excludeFilters.length?{exclude:excludeFilters}:{})});
    const items=result.items.map(item=>({person_id:item.person_id,full_name:item.full_name,subdistrict:item.subdistrict,district:item.district,person_type:monitor.person_types[0]||null}));
    return respond({answer:registry.formatMonitoringList(result,monitor.level,{windowLabel:monitor.timeWindow?.label})+(excludeNote||''),grounded:true,dataSource:'real',toolsUsed:[{name:'supabase_monitoring_read'}],presentation:{type:'person_list',total:result.total,returned:items.length,page:result.page,pageSize:result.pageSize,filters:{person_type:monitor.person_types[0]||null},items},meta:{fastPath:true,ollamaCalls:0,responseTimeMs:Date.now()-start}});
   } catch(e){return sendFailure(e);}
  }
  if(intent?.intent==='lookup_clarify')return respond({answer:intent.answer,grounded:false,dataSource:'real',presentation:intent.presentation,conversation,meta:{fastPath:true,ollamaCalls:0,responseTimeMs:Date.now()-start}});
  if(intent?.intent==='group_persons' && {subdistrict:'ตำบล',district:'อำเภอ',province:'จังหวัด'}[intent.groupBy]){
   ranking=[message,{subdistrict:'ตำบล',district:'อำเภอ',province:'จังหวัด'}[intent.groupBy],intent.direction==='asc'?'น้อยสุด':'มากสุด'];
   showAll=intent.showAll||showAll;
  }
  // Non-registry questions must never enter the registry interpreter.  In
  // particular, product questions such as “ธานีพิทักษ์คืออะไร” used to be
  // misread as an incomplete people lookup and got a misleading prompt.
  if(process.env.RAG_ENABLED==='true'&&!hasDBIntent(routingMessage)){
   try {
    const found=await rag.answer(routingMessage,ollamaJson,process.env.OLLAMA_MODEL||'typhoon2:8b-q5');
    if(found)return respond({answer:found.answer,grounded:true,dataSource:'real',conversation:{topic:incomingTopic},meta:{fastPath:false,ollamaCalls:0,responseTimeMs:Date.now()-start,ragSources:found.sources}});
   } catch(e) { console.error(`[real-rag] failure type=${e?.name||'Error'}`); }
  }
  try {
   // Any period wording that reached this point belongs to a plain count,
   // list, or ranking: the registry question itself is not time-filterable,
   // so ask instead of silently answering the all-time variant.
   if(periodRequested)return respond({answer:PERIOD_CLARIFY,grounded:false,dataSource:'real',conversation,meta:{fastPath:!ollamaCalls,ollamaCalls,responseTimeMs:Date.now()-start}});
   if((!ranking&&!summary&&!intent)||summary?.intent==='summary_choices'||intent?.intent==='search_incomplete'){
    ollamaCalls=1;plan=await interpret(routingMessage);
    if(plan.action==='clarify')return respond({answer:'ต้องการจำนวน รายชื่อ หรือแยกยอดตามพื้นที่ใดครับ? กรุณาระบุประเภทบุคคลและพื้นที่ที่ต้องการ',grounded:false,dataSource:'real',meta:{fastPath:false,ollamaCalls,responseTimeMs:Date.now()-start}});
    if(plan.action==='group'){ranking=[routingMessage,plan.group,plan.direction==='asc'?'น้อยสุด':'มากสุด'];showAll=true;}
   }
   const filters={...(summary?.filters||intent?.filters||{})};
   if(plan){for(const key of ['province','district','subdistrict','station','search'])if(plan[key])filters[key]=plan[key];if(plan.person_type!=='all')filters.person_type=plan.person_type;}
   for(const type of ['psychiatric','drug_user','dealer','released'])if(intent?.intent.endsWith('_'+type))filters.person_type=type;
   // Keep explicit subject even when the general count parser returns count_total.
   if(/จิตเวช|ผู้ป่วย/.test(routingMessage))filters.person_type='psychiatric';
   else if(/ผู้เสพ/.test(routingMessage))filters.person_type='drug_user';
   else if(/ผู้ค้า/.test(routingMessage))filters.person_type='dealer';
   else if(/พ้นโทษ/.test(routingMessage))filters.person_type='released';
   if(excludeFilters.length)filters.exclude=excludeFilters;
   if(ranking){
    const result=await search(req,filters,1,true);
    if(result.fuzzy)fuzzyNote=result.fuzzy;
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
    const scope=filters.station?`สภ.${String(filters.station).replace(/^สภ\.?\s*/u,'')}`:filters.province?`จังหวัด${filters.province}`:filters.district?`อำเภอ${filters.district}`:filters.subdistrict?`ตำบล${filters.subdistrict}`:(req.user.stationName||'พื้นที่ที่บัญชีนี้มีสิทธิ์เข้าถึง');
    const heading=topN!==null?`${topN} อันดับ${ranking[1]}${/น้อย/.test(ranking[2])?'น้อยที่สุด':'มากที่สุด'}`:'';
    const answer=`ข้อมูลจริง • ${scope}\nนับ${category}จากทะเบียนทั้งหมด ${result.total} คน\n`+(showAll||topN!==null?`${heading||`เรียง${/น้อย/.test(ranking[2])?'น้อยไปมาก':'มากไปน้อย'}`}\n`:'')+(winners.length?winners.map((g,index)=>`${showAll||topN!==null?`${index+1}. `:''}${ranking[1]}${g.name} ${column==='tambon'?g.district:''} ${column!=='province'?g.province:''} มี${category}${showAll||topN!==null?'':ranking[2]} ${g.count} คน`).join('\n'):'ไม่พบข้อมูลพื้นที่ที่จัดอันดับได้')+(!showAll&&topN===null&&winners.length>1?'\nมีหลายพื้นที่จำนวนเท่ากัน':'')+(missing?`\nอีก ${missing} คนไม่ระบุ${ranking[1]} จึงไม่รวมในอันดับ`:'')+(/น้อย/.test(ranking[2])?'\nอันดับนี้รวมเฉพาะพื้นที่ที่มีบุคคลในทะเบียน':'')+(excludeNote||'');
    return respond({answer,grounded:true,dataSource:'real',toolsUsed:[{name:'supabase_area_count'}],presentation:{type:'location_summary',groupBy:{tambon:'subdistrict',amphoe:'district',province:'province'}[column],items:winners,filters:{person_type:filters.person_type||null}},conversation,meta:{fastPath:!ollamaCalls,ollamaCalls,responseTimeMs:Date.now()-start}});
   }
   const page=intent?.page||1;const result=await search(req,filters,page);
   if(result.fuzzy)fuzzyNote=result.fuzzy;
   const category={psychiatric:'ผู้ป่วยจิตเวช',drug_user:'ผู้เสพ',dealer:'ผู้ค้า',released:'ผู้พ้นโทษ'}[filters.person_type]||'บุคคล';
   const countOnly=plan?.action==='count'||(intent&&/^count_/.test(intent.intent))||(!summary?.includeList&&(/กี่|จำนวน|มีมั้ย|มีไหม|มีหรือไม่|มีรึเปล่า/.test(routingMessage)));
   const items=result.data.map(p=>({person_id:p.id,full_name:`${p.first_name||''} ${p.last_name||''}`.trim(),person_type:filters.person_type||null,subdistrict:p.tambon||'',district:p.amphoe||''}));
   const answer=countOnly
    ?(result.total?`มี${category} ${result.total} คน${excludeNote||''}`:`ไม่มี${category}${excludeNote||''}`)
    :`ข้อมูลจริง: พบ ${result.total} คนตามสิทธิ์และเงื่อนไขที่ค้นหา${excludeNote||''}`;
   const presentation=countOnly?undefined:{type:'person_list',total:result.total,returned:items.length,page,pageSize:20,filters:{person_type:filters.person_type||null,province:filters.province||null,district:filters.district||null,subdistrict:filters.subdistrict||null},items};
   respond({answer,grounded:true,dataSource:'real',toolsUsed:[{name:'supabase_people_read'}],presentation,conversation,meta:{fastPath:!ollamaCalls,ollamaCalls,responseTimeMs:Date.now()-start}});
  }catch(e){
   // Ambiguous-name choices re-send the corrected request, so the interface
   // needs the routing text this answer was built from.
   if(e&&e.code==='REAL_LOCATION_CHOICES'&&e.presentation&&!e.presentation.originalMessage)e.presentation={...e.presentation,originalMessage:routingMessage};
   return sendFailure(e);
  }
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
  if(request.report_kind==='target_person_aggregate'){
   const aggregate=await targetPersonSummary(req,filters.province||req.user.province||null);
   const totals=aggregate.presentation.totals;
   return {report_kind:'target_person_aggregate',filters:{...filters,province:filters.province||req.user.province||undefined},includeCount:true,includeList:false,total:totals.total,counts:[{label:'ผู้ป่วยจิตเวช',count:totals.psychiatric},{label:'ผู้เสพ',count:totals.drugUser},{label:'ผู้ค้า',count:totals.dealer},{label:'ผู้พ้นโทษ',count:totals.released}],aggregateRows:aggregate.presentation.rows};
  }
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
   return res.json({data,meta:{total:result.total,page,limit,...(result.fuzzy?{fuzzy:result.fuzzy}:{})}});
  }catch(e){return sendRealFailure(res,e);}
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
