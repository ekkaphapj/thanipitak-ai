const express=require('express');
const {detectFastPathIntent}=require('../ai/fastPath');
const {parseSummaryIntent}=require('../services/summaryService');
const {sanitizeTopic,topicFromIntent,matchPersonType}=require('../ai/conversationTopic');
const {createRealRegistryRead,monitoringQuestion,selectedReasonFollowup}=require('../services/realRegistryRead');
const {detectExportIntent,reportRequestFromExport}=require('../ai/exportIntent');
const {detectVisitPlanIntent}=require('../ai/visitPlanIntent');
const {writeSummaryPdf,writeSummaryExcel,safeReportRequest}=require('../services/reportService');
const {createRealVisitPlanTool}=require('../services/realVisitPlanTool');
const {createRealProvincePeopleTool}=require('../services/realProvincePeopleTool');
const {writeVisitPlanPdf}=require('../services/visitPlanPdf');
const fs=require('fs');
const {parseStationId,hasCrossStationRead,applyPeopleStationScope,personInOwnStation}=require('../services/stationScope');
const {detectOverview,formatOverview,TYPE_LABELS}=require('../services/overviewService');
const {hasDBIntent}=require('../ai/intentDetector');
rag=require('../ai/rag');
const {detectDiscoveryIntent,discover}=require('../services/discoveryService');
const {normalizeUtterance,matchPlaceNames,placeKey}=require('../ai/thaiText');
const {realPersonTypeIds}=require('../services/realPersonTypes');
const {correctTranscript}=require('../stt/correctTranscript');
const {analyzePeriods,extractTimeWindow,hasHardTimeReference}=require('../ai/timeWindow');
const {parseAreaExclusions,removeSpans}=require('../ai/areaExclusion');
const {normalizeQuerySpec,describeQuerySpec,filtersFromSpec}=require('../ai/querySpec');

async function ollamaJson(path,body) {
 const response=await fetch(new URL(path,process.env.OLLAMA_HOST||'http://127.0.0.1:11434'),{method:'POST',headers:{'Content-Type':'application/json'},signal:AbortSignal.timeout(120000),body:JSON.stringify(body)});
 if(!response.ok)throw new Error('Local AI knowledge service unavailable');
 return response.json();
}

function realFailure(error) {
 const code=error&&error.code;
 // Non-chat callers (for example the pagination fetch) keep the explicit
 // error contract; the chat layer converts the guidance to a 200 answer.
 if(code==='REAL_AREA_GUIDANCE')return {status:422,code:'REAL_LOCATION_NOT_FOUND',error:error.message||'ไม่พบพื้นที่ที่ระบุ'};
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
 const match=String(message||'').match(/(?:เปลี่ยน(?:เป็น)?|เลือก(?:เป็น)?|ตั้ง(?:เป็น)?)\s*(?:จังหวัด|จ\.)?\s*([ก-๙A-Za-z.-]{2,80})|(?:ใน|ของ)?(?:จังหวัด|จ\.)\s*([ก-๙A-Za-z.-]{2,80})/u);
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
// positive filter. Every period mention is accounted for: one resolvable
// window flows through, while comparisons, multiple periods, or unresolvable
// wording set periodBlocked so the caller refuses instead of broadening.
function prepareRoutingMessage(message) {
  const periods=analyzePeriods(message);
  const exclusions=parseAreaExclusions(message);
  const messageNoExclusion=exclusions.length?removeSpans(message,exclusions.map(item=>item.matchedText)):String(message);
  let routingMessage=messageNoExclusion;
  for(const window of periods.windows)routingMessage=removeSpans(routingMessage,[window.matchedText]);
  for(const span of periods.unresolved)routingMessage=removeSpans(routingMessage,[span]);
  if(periods.comparison)routingMessage=removeSpans(routingMessage,[/เดือนนี้เทียบกับเดือนที่แล้ว|เทียบกับ|เทียบกัน|เปรียบเทียบ/.exec(routingMessage)?.[0]].filter(Boolean));
  routingMessage=routingMessage||messageNoExclusion||String(message);
  let periodBlocked=null;
  if(periods.comparison)periodBlocked={reason:'comparison'};
  else if(periods.unresolved.length)periodBlocked={reason:'unresolved',text:periods.unresolved[0]};
  else if(periods.windows.length>1)periodBlocked={reason:'multiple'};
  // Some explicit periods (for example “ไตรมาสที่แล้ว”) deliberately have
  // no resolver yet. They must still block every read/export path.
  else if(!periods.windows.length&&hasHardTimeReference(messageNoExclusion))periodBlocked={reason:'unresolved',text:'ช่วงเวลาที่ระบุ'};
  return {
    timeWindow:periods.windows[0]||null,
    exclusions,
    periodBlocked,
    hardTimeReference:!periods.windows.length&&(periods.unresolved.length>0||periods.comparison||hasHardTimeReference(messageNoExclusion)),
    // Monitoring detection still needs the period wording, but never the
    // excluded area (which must not become a positive filter).
    messageNoExclusion,
    routingMessage,
  };
}

const PERIOD_HINT='ช่วงเวลาที่เข้าใจได้คือ วันนี้ เมื่อวาน สัปดาห์นี้/ที่แล้ว เดือนนี้/ที่แล้ว เดือนสิงหาคม 2569 ปีนี้/ที่แล้ว และ N วัน/สัปดาห์/เดือน/ปี ล่าสุด (ไม่เกิน 365 วัน)';
function periodBlockedMessage(blocked){
 if(blocked?.reason==='comparison')return 'ยังไม่รองรับการเปรียบเทียบสองช่วงเวลาในคำถามเดียว กรุณาถามทีละช่วง เช่น “ใครเสี่ยงสูงเดือนนี้” แล้วตามด้วย “เดือนก่อนล่ะ”';
 if(blocked?.reason==='unresolved'&&/\d+\s*วัน|เกิน/.test(blocked.text||''))return `ช่วงเวลา “${blocked.text}” ยาวเกินที่รองรับ (สูงสุด 365 วันล่าสุด) กรุณาระบุช่วงที่สั้นกว่า`;
 if(blocked?.reason==='unresolved')return `ช่วงเวลา “${blocked.text}” ยังไม่รองรับ ${PERIOD_HINT}`;
 return 'คำถามนี้มีหลายช่วงเวลา กรุณาถามทีละช่วง';
}
// The people registry exposes no registration date to AI reads, so a period
// on a plain count/list is genuinely ambiguous. Ask exactly what is missing
// and remember the pending choice so a short reply can fill only the gap.
function periodIntentQuestion(message,window){
 const type=PERSON_TYPE_PATTERNS.find(([pattern])=>pattern.test(message))?.[1]||null;
 const typeLabel=type?{psychiatric:'ผู้ป่วยจิตเวช',drug_user:'ผู้เสพ',dealer:'ผู้ค้า',released:'ผู้พ้นโทษ'}[type]:'บุคคล';
 return {
  answer:`ทะเบียนบุคคลไม่เปิดวันที่ลงทะเบียนให้อ่าน จึงนับ${typeLabel}ตามช่วงเวลาตรงๆ ไม่ได้ ต้องการแบบใด?\n1. นับจากทะเบียนปัจจุบัน (ไม่กรองช่วงเวลา)\n2. รายการเฝ้าระวัง/เสี่ยงสูงที่บันทึกไว้ใน${window?window.label:'ช่วงเวลานั้น'}`,
  presentation:{type:'summary_choices',choices:[
   {label:`นับ${typeLabel}จากทะเบียนปัจจุบัน`,message:'นับจากทะเบียนปัจจุบัน'},
   {label:'เฝ้าระวัง/เสี่ยงสูงในช่วงนี้',message:'เฝ้าระวังหรือเสี่ยงสูงช่วงนี้'},
  ]},
  pending:{type:'period_intent',person_type:type,window:window?{from:window.from,to:window.to,label:window.label}:undefined},
 };
}
function periodIntentAreas(message){
 const text=String(message||'');const area={};
 // The value must stop before the next area label or any period/connector
 // wording, so "ตำบลโพนสูงอำเภอเมืองเดือนนี้" never captures "โพนสูงอำเภอเมือง".
 const stop='มี|กี่|รายชื่อ|ทั้งหมด|ใน|ของ|ช่วง|เดือน|สัปดาห์|ล่าสุด|ยกเว้น|และ|หน่อย|ด้วย|ครับ|ค่ะ|คะ|จังหวัด|อำเภอ|เขต|ตำบล|สภ|$';
 const specs=[['province',new RegExp(`จังหวัด\\s*([ก-๙A-Za-z0-9.-]{2,60}?)(?=\\s*(?:${stop}))`,'u')],['district',new RegExp(`(?:อำเภอ|เขต)\\s*([ก-๙A-Za-z0-9.-]{2,60}?)(?=\\s*(?:${stop}))`,'u')],['subdistrict',new RegExp(`ตำบล\\s*([ก-๙A-Za-z0-9.-]{2,60}?)(?=\\s*(?:${stop}))`,'u')]];
 for(const [key,re] of specs){const match=re.exec(text);if(match)area[key]=match[1].trim();}
 return area;
}
const PERSON_TYPE_PATTERNS=[
 [/จิตเวช|ผู้ป่วย/,'psychiatric'],
 [/ผู้เสพ/,'drug_user'],
 [/ผู้ค้า/,'dealer'],
 [/พ้นโทษ/,'released'],
];
const RESET_RE=/^(?:เริ่ม(?:ใหม่|ต้นใหม่|คุยใหม่|คำถามใหม่)|ล้างบริบท|ล้างการเลือก)(?:\s*(?:ครับ|ค่ะ|คะ|หน่อย))?$/u;
const NEXT_PAGE_RE=/^(?:หน้าถัดไป|หน้าต่อไป|ต่อไป|ถัดไป|โชว์(?:หน้า)?ถัดไป|แสดงหน้าถัดไป)$/u;
const PREV_PAGE_RE=/^(?:หน้าก่อน(?:หน้า)?|ก่อนหน้านี้|ย้อน(?:กลับ|หน้า))$/u;
const UNDERSPECIFIED_RE = /^(?:(?:ขอ)?ดูข้อมูล(?:หน่อย|บ้าง)?|มี(?:ข้อมูล)?อะไร(?:บ้าง|ให้ดู(?:บ้าง)?|ดูได้บ้าง)?|สถานการณ์(?:เป็นยังไง|ตอนนี้|ปัจจุบัน)|ขอข้อมูลหน่อย|ช่วย(?:แนะนำ)?หน่อย)(?:\s*(?:ครับ|ค่ะ|คะ))?$/u;

function isUnderspecifiedQuestion(message) {
 const text = String(message || '').replace(/\s+/g, ' ').trim();
 if (UNDERSPECIFIED_RE.test(text)) return true;
 if (/^ขอดูข้อมูล$/u.test(text)) return true;
 if (/^มีอะไรบ้าง$/u.test(text)) return true;
 return false;
}

const LIST_REQUEST_RE = /^(?:ขอ(?:ดู)?รายชื่อ(?:หน่อย|ด้วย|ทั้งหมด)?|มีใครบ้าง|ใครบ้าง|คนไหนบ้าง|แสดงรายชื่อ(?:หน่อย|ด้วย)?)(?:\s*(?:ครับ|ค่ะ|คะ))?$/u;
const LEVEL_SWITCH_RE = /^(?:(?:แล้ว|และ|ส่วน)\s*)?(?:เอา(?:แค่)?\s*|แค่\s*)?(?:เฉพาะ\s*)?(?:ที่|กลุ่ม)?(เสี่ยงสูง|เฝ้าระวัง)(?:\s*ล่ะ|\s*มีกี่คน|\s*หน่อย|\s*ด้วย)?(?:\s*(?:ครับ|ค่ะ|คะ))?$/u;
const HAS_AREA_RE = /(?:จังหวัด|อำเภอ|เขต|ตำบล|สภ\.?|สถานีตำรวจ|ที่\s*ตำบล|ใน\s*ตำบล)/u;
const TYPE_SWITCH_RE = /^(?:แล้ว|และ|ส่วน|ขอ(?:ดู|ยอด)?)?\s*(?:ผู้ป่วยจิตเวช|จิตเวช|ผู้ป่วย|ผู้เสพ|ผู้ใช้ยา|ผู้ค้า|ผู้จำหน่าย|ผู้พ้นโทษ|พ้นโทษ)(?:\s*(?:ล่ะ|มีกี่คน|กี่คน|มีมั้ย|มีไหม|รวมกี่คน|ด้วย|หน่อย))?(?:\s*(?:ครับ|ค่ะ|คะ))?$/u;

// Detects a follow-up that adjusts the previous query: another period
// ("เดือนก่อนล่ะ"), an area refinement ("เอาเฉพาะตำบลโพนสูง"), a person type
// change ("แล้วผู้เสพล่ะ"), risk level change ("เอาเฉพาะเสี่ยงสูง"),
// count-to-list ("ขอรายชื่อด้วย"), or the next page.
function detectContinuation(message,topic){
 if(!topic||typeof topic!=='object')return null;
 if(!topic.kind&&!topic.level&&!topic.person_type&&!topic.subdistrict&&!topic.district&&!topic.station&&!topic.province)return null;
 const text=String(message||'').replace(/\s+/g,' ').trim();
 if(!text)return null;
 if(NEXT_PAGE_RE.test(text))return {type:'next_page',page:(Number(topic.page)||1)+1};
 if(PREV_PAGE_RE.test(text))return {type:'next_page',page:Math.max(1,(Number(topic.page)||2)-1)};
 if(LIST_REQUEST_RE.test(text))return {type:'count_to_list'};
 const levelMatch=LEVEL_SWITCH_RE.exec(text);
 if(levelMatch){
  const level=levelMatch[1]==='เสี่ยงสูง'?'high':'watch';
  const wantList=/รายชื่อ|ใคร/.test(text)||(topic.kind==='monitoring_list'||topic.kind==='people_list');
  return {type:'level_switch',level,wantList};
 }
 if(!HAS_AREA_RE.test(text)&&TYPE_SWITCH_RE.test(text)){
  const personType=matchPersonType(text);
  if(personType){
   const wantList=/รายชื่อ|ใคร/.test(text)||(!/กี่คน|จำนวน|ยอด|มีมั้ย|มีไหม/.test(text)&&topic.kind==='people_list');
   return {type:'type_switch',personType,wantList};
  }
 }
 const periods=analyzePeriods(text);
 let residue=text;
 for(const window of periods.windows)residue=removeSpans(residue,[window.matchedText]);
 for(const span of periods.unresolved)residue=removeSpans(residue,[span]);
 residue=residue.replace(/(?:นะ)?(?:ครับ|ค่ะ|คะ)/gu,'').replace(/ล่ะ|ด้วย|หน่อย|จ้า|จ้ะ|อีก/gu,'').replace(/\s+/g,' ').trim();
 if(residue===''){
  if(periods.comparison)return {type:'period_block',blocked:{reason:'comparison'}};
  if(periods.unresolved.length)return {type:'period_block',blocked:{reason:'unresolved',text:periods.unresolved[0]}};
  if(periods.windows.length===1)return {type:'window_change',window:periods.windows[0]};
 }
 const area=/^(?:เอา(?:แค่)?\s*|แค่\s*)?เฉพาะ\s*(จังหวัด|อำเภอ|เขต|ตำบล|จ\.|อ\.|ต\.|สภ\.?|สถานี)?\s*([ก-๙A-Za-z0-9.\-]{2,60})$/u.exec(text);
 if(area){
  const unit=area[1]?(/จังหวัด|จ\./.test(area[1])?'province':/อำเภอ|เขต|อ\./.test(area[1])?'district':/ตำบล|ต\./.test(area[1])?'subdistrict':'station'):null;
  return {type:'area_refine',unit,value:area[2].trim()};
 }
 return null;
}

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
 const sortBy=/(?:ตัวอักษร|ก\s*ถึง\s*ฮ|ก-ฮ)/u.test(text)?'name':null;
 const direction=/น้อย|ต่ำ|เบา/u.test(text)?'asc':/มาก|เยอะ|สูง|อันดับ/u.test(text)?'desc':null;
 if(!direction&&!sortBy)return null;
 const matched=STATION_RANK_TYPES.find(([,pattern])=>pattern.test(text));
 return {direction:direction||'asc',sortBy,personType:matched?.[0]||null,limit:rankLimitFromMessage(text)};
}

// A station aggregate already shown to the officer is a safe, display-only
// conversation marker.  Allow a short spoken follow-up to sort that same
// authorised aggregate instead of treating it as an unrelated model prompt.
function detectAggregateSortContinuation(message, topic) {
 const saved=sanitizeTopic(topic);
 if(saved?.report_kind!=='target_person_aggregate')return null;
 const text=String(message||'').replace(/\s+/g,' ').trim();
 if(!/(?:เรี(?:ย)+ง|จัด\s*ลำดับ|ลำดับ)/u.test(text))return null;
 if(/(?:ตัวอักษร|ก\s*ถึง\s*ฮ|ก-ฮ)/u.test(text))return {direction:'asc',sortBy:'name',personType:null,limit:null};
 const direction=/น้อย\s*(?:ไป|สุด)|ต่ำ\s*(?:ไป|สุด)/u.test(text)?'asc':/มาก\s*(?:ไป|สุด)|สูง\s*(?:ไป|สุด)/u.test(text)?'desc':null;
 if(!direction)return null;
 const matched=STATION_RANK_TYPES.find(([,pattern])=>pattern.test(text));
 return {direction,sortBy:null,personType:matched?.[0]||saved.person_type||null,limit:null};
}

function likelyUsesLocalAi(message, topic, hasSelectedPerson) {
 if(isProvinceChangeOnly(message)||detectVisitPlanIntent(message)||detectExportIntent(message)||detectStationRanking(message)||detectAggregateSortContinuation(message,topic)||detectDiscoveryIntent(message)||detectOverview(message)||hasSelectedPerson||isUnderspecifiedQuestion(message))return false;
 if(detectContinuation(message, topic))return false;
 const summary=parseSummaryIntent(message);const intent=detectFastPathIntent(message,topic);
 if(summary||intent||/(ตำบล|อำเภอ|จังหวัด)(?:ไหน|ใด|อะไร).*?(มากที่สุด|เยอะที่สุด|น้อยที่สุด|มากสุด|เยอะสุด|น้อยสุด)/u.test(message))return false;
 if(process.env.RAG_ENABLED==='true'&&!hasDBIntent(message)&&rag.directAnswer(message))return false;
 return true;
}

function createRealDataRoutes(authenticate,{url=require('../realConfig').url,key=require('../realConfig').key,request=fetch,interpret=require('../ai/realIntent').interpretRealIntent}={}) {
 const router=express.Router();router.use(authenticate);
 const { createRealAiTools } = require('../services/realAiTools');
 const aiTools = createRealAiTools({ url, key, request });
 const readVisitPlan=createRealVisitPlanTool({url,key,request});
 const readProvincePeople=createRealProvincePeopleTool({url,key,request});
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
  // A province list must follow the registered province of the person, just
  // like the primary registry. This caller-bound RPC also audits the read.
  if(filters.province&&!filters.station&&!filters.district&&!filters.subdistrict
     &&!filters.query&&!filters.search&&!filters.status&&!filters.person_id
     &&!(filters.exclude||[]).length&&!aggregate){
   return readProvincePeople(req,{province:filters.province,personType:filters.person_type||null,page,pageSize:size});
  }
  let fuzzyApplied=null;
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
   p.set('province',`eq.${clean(filters.province)}`);
  }
  if(filters.station){
   const own=hasCrossStationRead(req.user)?null:parseStationId(req.user.stationId);
   // With an explicit province, resolve a spoken/typed station name only
   // against that province's catalogue. A same-named station elsewhere must
   // not turn a precise request into an ambiguous or empty answer.
   const stationParams=new URLSearchParams({select:'station_id',station_name:`ilike.*${clean(filters.station)}*`,limit:'1000'});
   if(filters.province)stationParams.set('province',`eq.${clean(filters.province)}`);
   const s=await rows(req,'stations',stationParams);
   let ids=s.data.map(x=>Number(x.station_id)).filter(id=>own?id===own:(hasCrossStationRead(req.user)||req.user.role==='admin'));
   if(!ids.length && allowFuzzy){
    // A station name that matches nothing exactly may still be a close
    // transcription. Candidates come from the stations catalogue this account
    // can already read, and an own-station account can never resolve to
    // another station, so this can narrow a typo but never widen scope.
    const catalogueParams=new URLSearchParams({select:'station_id,station_name',limit:'1000'});
    if(filters.province)catalogueParams.set('province',`eq.${clean(filters.province)}`);
    const all=await rows(req,'stations',catalogueParams);
    const allowed=all.data.filter(row=>{
     const id=Number(row.station_id);
     return own ? id===own : (hasCrossStationRead(req.user)||req.user.role==='admin');
    });
    const matches=matchPlaceNames(filters.station,allowed.map(row=>String(row.station_name||'').trim()).filter(Boolean));
    if(matches.length===1){
     const row=allowed.find(item=>String(item.station_name||'').trim()===matches[0]);
     ids.push(Number(row.station_id));
     fuzzyApplied={field:'station',from:filters.station,to:matches[0]};
     filters.station=matches[0];
    } else if(matches.length>1)throw stationChoicesError(filters.station,matches);
   }
   if(!ids.length){const error=new Error(`ไม่พบชื่อ สภ. “${filters.station}” กรุณาตรวจสอบชื่อและลองใหม่`);error.code='REAL_LOCATION_NOT_FOUND';throw error;}
   if(!own&&ids.length>1){const error=new Error(`พบชื่อ สภ. “${filters.station}” มากกว่าหนึ่งแห่ง กรุณาระบุจังหวัดเพิ่ม`);error.code='REAL_LOCATION_AMBIGUOUS';throw error;}
   p.set('station_id', own ? `eq.${own}` : `in.(${ids.join(',')})`);
  }
  if(filters.person_type){
   const typeIds=await realPersonTypeIds(req,filters.person_type,rows);
   if(!typeIds.length)return {data:[],total:0};
   p.set('type_id',`in.(${typeIds.join(',')})`);
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
    const error=areaGuidanceError(req.user,label,value);error.code='REAL_AREA_GUIDANCE';throw error;
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
   registry.listRecordedMonitoring(req,{level:'high',personType:filters.person_type,district:filters.district,subdistrict:filters.subdistrict,stationIds,pageSize:1}),
   registry.listRecordedMonitoring(req,{level:'watch',personType:filters.person_type,district:filters.district,subdistrict:filters.subdistrict,stationIds,pageSize:1}),
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
 // An area the officer names but that cannot be found in the working scope is
 // answered with guidance (200), never a dead-end error: ตำบล references are
 // checked against the officer's own สภ. and the message says so; อำเภอ
 // references ask which province — but only for accounts whose verified scope
 // actually spans multiple provinces.
 function areaGuidance(user,label,value){
  const stationLabel=user&&user.stationName?`สภ.${String(user.stationName).replace(/^สภ\.?\s*/u,'')}`:'พื้นที่ที่ท่านสังกัด';
  const provinceNote=user&&user.province?` (จังหวัด${user.province})`:'';
  if(label==='อำเภอ'&&hasCrossStationRead(user)){
   return `ไม่พบอำเภอ“${value}”ในพื้นที่ที่ท่านสังกัดอยู่${provinceNote} อำเภอนี้อยู่จังหวัดอะไร กรุณาระบุจังหวัดในคำสั่งเดียวกัน เช่น “อำเภอ${value}จังหวัด...มีกี่คน”`;
  }
  return `ไม่พบ${label}“${value}” หรือไม่มีบุคคลเป้าหมายในเขต ${stationLabel}${provinceNote} กรุณาระบุ${label} อำเภอ และจังหวัด เพื่อดำเนินการต่อไป`;
 }
 function areaGuidanceError(user,label,value){
  const error=new Error(areaGuidance(user,label,value));
  error.code='REAL_AREA_GUIDANCE';
  error.answer=error.message;
  return error;
 }
 function exclusionNotFound(label,value,user) {
  const error=areaGuidanceError(user,label,value);
  error.answer=label==='จังหวัด'
   ?`ไม่พบจังหวัด“${value}” ที่ต้องการยกเว้น กรุณาระบุชื่อจังหวัดให้ถูกต้อง`
   :`ไม่พบ${label}“${value}” ที่ต้องการยกเว้น ${areaGuidance(user,label,value)}`;
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
  throw exclusionNotFound('จังหวัด',item.value,req.user); }
 async function excludeArea(req,item,label) {
  const catalogue=await areaCatalogue(req);
  const list=item.kind==='subdistrict'?catalogue.subdistricts:catalogue.districts;
  const matches=matchPlaceNames(item.value,list);
  if(matches.length===1)return {column:item.kind==='subdistrict'?'tambon':'amphoe',value:matches[0],label:`${label}${matches[0]}`};
  if(matches.length>1)throw exclusionChoices(item.value,matches.map(name=>({prefix:label,value:name})));
  throw exclusionNotFound(label,item.value,req.user);
 }
 async function resolveExclusions(req,exclusions) {  const resolved=[];
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
 // Shared monitoring-list answer used by the direct question, conversation
 // continuations, and pending-period replies. Conditions travel as explicit
 // arguments; the registry read applies the station scope itself.
 async function monitoringStationIds(req,area={}){
  if(!area.province&&!area.station)return undefined;
  if(area.province&&!area.station&&hasCrossStationRead(req.user))return undefined;
  if(!hasCrossStationRead(req.user)){
   const own=parseStationId(req.user.stationId);
   if(own&&area.station&&req.user.stationName&&!matchPlaceNames(area.station,[req.user.stationName]).length)return [];
   if(own&&area.province&&req.user.province&&placeKey(area.province)!==placeKey(req.user.province))return [];
   if(own&&(!area.province||req.user.province)&&(!area.station||req.user.stationName))return [own];
  }
  const clean=value=>String(value).replace(/[%*(),]/g,'').slice(0,100);
  const params=new URLSearchParams({select:'station_id,station_name,province',limit:'1000'});
  if(area.province)params.set('province',`eq.${clean(area.province)}`);
  const catalogue=await rows(req,'stations',params);
  if(!area.station)return catalogue.data.map(row=>Number(row.station_id)).filter(Number.isSafeInteger);
  const matches=matchPlaceNames(area.station,catalogue.data.map(row=>String(row.station_name||'').trim()).filter(Boolean));
  if(!matches.length){const error=new Error(`ไม่พบชื่อ สภ. “${area.station}” กรุณาตรวจสอบชื่อและลองใหม่`);error.code='REAL_LOCATION_NOT_FOUND';throw error;}
  if(matches.length>1){const error=new Error(`พบชื่อ สภ. “${area.station}” มากกว่าหนึ่งแห่ง กรุณาระบุจังหวัดเพิ่ม`);error.code='REAL_LOCATION_AMBIGUOUS';throw error;}
  return catalogue.data.filter(row=>String(row.station_name||'').trim()===matches[0]).map(row=>Number(row.station_id)).filter(Number.isSafeInteger);
 }
 async function runMonitoringAnswer(req,{level,personType,area={},window=null,exclude=[],page=1}){
  let result;
  if(area.province&&!area.station&&!area.district&&!area.subdistrict&&!window&&!exclude.length){
   const found=await readProvincePeople(req,{province:area.province,personType:personType||null,level:level==='all'?'risk':level,page});
   result={total:found.total,page:found.page,pageSize:found.pageSize,
    asOf:new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Bangkok',dateStyle:'short',timeStyle:'short'}).format(new Date()),
    scope:{stationName:null,district:null,province:area.province},
    items:found.data.map(person=>({person_id:person.id,full_name:`${person.prefix||''}${person.first_name||''} ${person.last_name||''}`.trim(),
     person_type:person.person_type,subdistrict:person.tambon||'',district:person.amphoe||'',province:person.province,
     station_name:person.station_name||null,level:person.risk_level==='high'?'เสี่ยงสูง':'เฝ้าระวัง',
     latestVisit:person.last_visit_date?{visit_date:person.last_visit_date}:null}))};
  }else{
   const stationIds=await monitoringStationIds(req,area);
   result=await registry.listRecordedMonitoring(req,{level,personType,page,
    ...(stationIds!==undefined?{stationIds}:{}),
    ...(area.province?{province:area.province}:{}),
    ...(area.district?{district:area.district}:{}),...(area.subdistrict?{subdistrict:area.subdistrict}:{}),
    ...(window?{from:window.from,to:window.to}:{}),
    ...(exclude.length?{exclude}:{})});
  }
  result.appliedArea=area;
  const items=result.items.map(item=>({person_id:item.person_id,full_name:item.full_name,subdistrict:item.subdistrict,district:item.district,province:item.province||null,station_name:item.station_name||null,person_type:personType||item.person_type||null,level:item.level||null}));
  const excludeNote=exclude.length?` (ไม่รวม${exclude.map(filter=>filter.label).join(' ')})`:'';
  const areaNote=[area.station?`สภ.${String(area.station).replace(/^สภ\.?\s*/u,'')}`:null,area.province?`จังหวัด${area.province}`:null].filter(Boolean).join(' • ');
  const answer=registry.formatMonitoringList(result,level,{windowLabel:window?.label})+(areaNote?`\nเงื่อนไขพื้นที่: ${areaNote}`:'')+excludeNote;
  return {result,items,answer};
 }
 function monitoringPresentation(result,items,personType,area=result.appliedArea||{}){
  return {type:'person_list',total:result.total,returned:items.length,page:result.page,pageSize:result.pageSize,filters:{person_type:personType||null,province:area.province||null,station:area.station||null,district:area.district||null,subdistrict:area.subdistrict||null},items};
 }
 function monitoringSpec({level,personType,area,window,exclude,page}){
  return normalizeQuerySpec({kind:'monitoring',person_type:personType||null,area,level,window,exclude,page});
 }
 function peopleListSpec({filters,page}){
  return normalizeQuerySpec({kind:'list',person_type:filters.person_type||null,area:{province:filters.province,district:filters.district,subdistrict:filters.subdistrict,station:filters.station},exclude:filters.exclude||[],page});
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
  // Aggregate rows arrive in database order. Preserve it for ties and
  // unsorted overviews; alphabetic order is an explicit user choice.
  const sorted=request.sortBy==='name'
   ? [...summary.presentation.rows].sort((left,right)=>String(left.stationName).localeCompare(String(right.stationName),'th'))
   : request.direction
    ? [...summary.presentation.rows].sort((left,right)=>request.direction==='asc'?left[field]-right[field]:right[field]-left[field])
    : [...summary.presentation.rows];
  const rows=request.limit===null?sorted:sorted.slice(0,request.limit);
  const directionLabel=request.direction==='asc'?'น้อยไปมาก':'มากไปน้อย';
  const amountLabel=request.limit===null?`แสดงทั้งหมด ${rows.length} สภ.`:`${rows.length} อันดับแรก`;
  const sortLabel=request.sortBy==='name'?'ตามตัวอักษร':`${label}${directionLabel}`;
  const answer=`จัดอันดับ สภ. • ${summary.presentation.scopeLabel}\nเรียง${sortLabel} • ${amountLabel}`;
  return {answer,presentation:{type:'station_ranking',scopeLabel:summary.presentation.scopeLabel,rows,personType:request.personType,direction:request.direction,sortBy:request.sortBy||null,limit:request.limit}};
 }
 router.post('/ai/chat/processing',(req,res)=>{
  const raw=req.body?.message;
  if(typeof raw!=='string'||!raw.trim()||raw.length>2000)return res.status(400).json({error:'คำถามไม่ถูกต้อง'});
  const message=normalizeUtterance(correctTranscript(raw))||raw;
  const topic=sanitizeTopic(req.body?.context?.topic);
  return res.json({willUseLocalAi:likelyUsesLocalAi(prepareRoutingMessage(message).routingMessage,topic,Boolean(selectedPersonId(req.body)))});
 });
 router.post('/ai/chat',async(req,res)=>{
  const start=Date.now();const raw=req.body?.message;
  if(typeof raw!=='string'||!raw.trim()||raw.length>2000)return res.status(400).json({error:'คำถามไม่ถูกต้อง'});
  // Typed and transcribed commands share one canonical form: politeness
  // particles, Thai digits, zero-width characters, and spacing are normalized
  // before every detector and before the model sees the request.
  const message=normalizeUtterance(correctTranscript(raw))||raw;
  const personId=selectedPersonId(req.body);
  let incomingTopic=sanitizeTopic(req.body?.context?.topic);
  // Server-side session reset mirrors the client's own "เริ่มใหม่" so no
  // condition survives an explicit restart, whatever client sent the text.
  if(RESET_RE.test(message)){
   return res.json({answer:'เริ่มบทสนทนาใหม่แล้ว เงื่อนไขที่เลือกไว้ทั้งหมดถูกล้างแล้ว',grounded:true,dataSource:'real',conversation:{topic:null},meta:{fastPath:true,ollamaCalls:0,responseTimeMs:Date.now()-start}});
  }
  if(isUnderspecifiedQuestion(message)){
   return res.json({
    answer:'ผู้ช่วยธานีพิทักษ์ เอไอ พร้อมให้บริการสืบค้นข้อมูลทะเบียนและติดตามบุคคลเป้าหมายตามสิทธิ์ของท่าน สามารถเลือกดูข้อมูลที่สนใจได้ดังนี้:',
    grounded:true,
    dataSource:'real',
    presentation:{
     type:'summary_choices',
     choices:[
      {label:'ภาพรวมบุคคลเป้าหมาย',message:'ขอภาพรวมบุคคลเป้าหมาย'},
      {label:'รายชื่อผู้มีความเสี่ยงสูง',message:'ใครเสี่ยงสูง'},
      {label:'สถิติผู้ป่วยจิตเวชในพื้นที่',message:'ผู้ป่วยจิตเวชมีกี่คน'},
      {label:'วิธีใช้งานระบบ',message:'ขอวิธีใช้'},
     ]
    },
    conversation:{topic:incomingTopic},
    meta:{fastPath:true,ollamaCalls:0,responseTimeMs:Date.now()-start}
   });
  }
  const prepared=prepareRoutingMessage(message);
  const routingMessage=prepared.routingMessage;
  const visitPlanIntent=detectVisitPlanIntent(routingMessage);
  // A named station is a narrowing condition. If a voice transcript still
  // contains a station-like cue that our deterministic parsers cannot keep,
  // stop before any registry read rather than silently showing a whole province.
  let requestedStation=null;
  const stationCue=/(?:^|[\s,])(?:สภ\.?|สถานี(?:ตำรวจ)?|ศพ|สพ|สอพอ|สภอ)(?=\s|[ก-๙]|$)/u.test(routingMessage);
  const namedStationBeforeProvince=/(?:สภ\.?|สถานี(?:ตำรวจ)?)\s*[ก-๙A-Za-z0-9.-]{2,80}\s*(?:จังหวัด|จ\.)/u.test(routingMessage);
  const genericStationOverview=/ภาพรวม/u.test(routingMessage)&&/(?:ราย\s*)?สภ\.?\s*(?:ใน?จังหวัด|$)/u.test(routingMessage);
  if(stationCue&&!visitPlanIntent&&!genericStationOverview&&/(?:รายชื่อ|ภาพรวม|สรุป|ผู้ป่วย|จิตเวช|ผู้เสพ|ผู้ค้า|ผู้พ้นโทษ)/u.test(routingMessage)&&(!detectStationRanking(routingMessage)||namedStationBeforeProvince)){
   requestedStation=detectFastPathIntent(routingMessage)?.filters?.station
    ||parseSummaryIntent(routingMessage)?.filters?.station
    ||detectOverview(routingMessage)?.filters?.station||null;
   if(!requestedStation)return res.json({answer:'ได้ยินชื่อ สภ. ไม่ชัด กรุณาพูดหรือพิมพ์ชื่อสถานีอีกครั้ง เช่น “ขอรายชื่อผู้ป่วยจิตเวช สภ.กลางใหญ่ จังหวัดอุดรธานี”',grounded:false,dataSource:'real',conversation:{topic:incomingTopic},meta:{fastPath:true,ollamaCalls:0,responseTimeMs:Date.now()-start}});
  }
  const periodRequested=Boolean(prepared.timeWindow||prepared.periodBlocked||prepared.hardTimeReference);
  // Choice follow-ups re-send the original command with the chosen verified
  // name substituted, so every choices presentation carries that text.
  const sendFailure=(e)=>{
   if(e&&e.code==='REAL_AREA_GUIDANCE')return res.json({answer:e.answer,grounded:true,dataSource:'real',meta:{fastPath:true,ollamaCalls:0,responseTimeMs:Date.now()-start}});
   if(e&&e.code==='REAL_LOCATION_CHOICES'&&e.presentation&&!e.presentation.originalMessage)e.presentation={...e.presentation,originalMessage:message};
   return sendRealFailure(res,e,start);
  };
  let ranking=/(ตำบล|อำเภอ|จังหวัด)(?:ไหน|ใด|อะไร).*?(มากที่สุด|เยอะที่สุด|น้อยที่สุด|มากสุด|เยอะสุด|น้อยสุด)/.exec(routingMessage);
  if(ranking)ranking=[routingMessage,ranking[1],/น้อย/.test(ranking[2])?'น้อยสุด':'มากสุด'];
  const ordered=/(?:ตาม|แยก(?:ตาม)?|แต่ละ)(ตำบล|อำเภอ|จังหวัด)/.exec(routingMessage);
  let showAll=!!ordered;
  const alphaOrder=/(?:ตัวอักษร|ก\s*ถึง\s*ฮ|ก-ฮ)/u.test(routingMessage);
  const explicitCountOrder=/น้อย|ต่ำ|เบา/u.test(routingMessage)?'น้อยสุด':/มาก|เยอะ|สูง/u.test(routingMessage)?'มากสุด':null;
  if(!ranking&&ordered)ranking=[routingMessage,ordered[1],alphaOrder?'alpha':explicitCountOrder||'alpha'];
  let plan=null;let ollamaCalls=0;
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
  const planResultResponse=result=>{
   if(result.status!=='ok'){
    const answer={station_not_found:'ไม่พบ สภ. ที่ระบุ กรุณาตรวจสอบชื่อ สภ. และจังหวัด',station_ambiguous:'พบชื่อ สภ. ซ้ำ กรุณาระบุจังหวัดและชื่อ สภ. ให้ชัดเจน',station_required:'กรุณาระบุ สภ. ที่ต้องการจัดแผนในจังหวัดนี้'}[result.status]||'ไม่สามารถจัดแผนการตรวจเยี่ยมได้';
    return respond({answer,grounded:true,dataSource:'real',conversation:{topic:incomingTopic},meta:{fastPath:true,ollamaCalls:0,responseTimeMs:Date.now()-start}});
   }
   const typeLabel={psychiatric:'ผู้ป่วยจิตเวช',drug_user:'ผู้เสพ',released:'บุคคลพ้นโทษ'};
   const counts=['psychiatric','drug_user','released'].map(type=>`${typeLabel[type]}: เสี่ยงสูง ${result.counts[type].high} • เฝ้าระวัง ${result.counts[type].watch} • สีแดง ${result.counts[type].red} • สีส้ม ${result.counts[type].orange} • ยังไม่เคยเยี่ยม ${result.counts[type].never_visited}`).join('\n');
   const title=`แผนการตรวจเยี่ยม ${result.station.station_name} • ภ.จว.${result.station.province}`;
   const answer=`${title}\n${counts}\nต้องไปตรวจเยี่ยมตามลำดับ ${result.totalDue} คน (แสดงหน้า ${result.page})`;
   const topic=sanitizeTopic({report_kind:'visit_plan',station:result.station.station_name,province:result.station.province,page:result.page});
   return respond({answer,grounded:true,dataSource:'real',toolsUsed:[{name:'ai_visit_plan'}],presentation:{type:'visit_plan',...result},conversation:{topic},meta:{fastPath:true,ollamaCalls:0,responseTimeMs:Date.now()-start}});
  };
  const planExport=incomingTopic?.report_kind==='visit_plan'?detectExportIntent(routingMessage):null;
  if(planExport){
   if(planExport.formats.length!==1||planExport.formats[0]!=='pdf')return respond({answer:'แผนการตรวจเยี่ยมรองรับรายงาน PDF กรุณาระบุ “ทำเป็นรายงาน PDF”',grounded:false,dataSource:'real',conversation:{topic:incomingTopic},meta:{fastPath:true,ollamaCalls:0,responseTimeMs:Date.now()-start}});
   const reportRequest={report_kind:'visit_plan',station:incomingTopic.station||null,province:incomingTopic.province||null};
   return respond({answer:`กำลังสร้างรายงาน PDF แผนการตรวจเยี่ยม ${incomingTopic.station||''} • ภ.จว.${incomingTopic.province||''}`,grounded:true,dataSource:'real',presentation:{type:'report_offer',formats:['pdf'],auto:'pdf',confirm:false,reportRequest},conversation:{topic:incomingTopic},meta:{fastPath:true,ollamaCalls:0,responseTimeMs:Date.now()-start}});
  }
  if(incomingTopic?.report_kind==='visit_plan'&&/^(?:หน้า\s*ถัดไป|หน้าต่อไป|หน้าก่อนหน้า|ย้อน\s*หน้า)$/u.test(routingMessage)){
   const page=/ก่อน|ย้อน/u.test(routingMessage)?Math.max(1,(incomingTopic.page||1)-1):Math.min(1000,(incomingTopic.page||1)+1);
   try{return planResultResponse(await readVisitPlan(req,{station:incomingTopic.station||null,province:incomingTopic.province||null,page}));}
   catch(e){return sendFailure(e);}
  }
  if(visitPlanIntent){
   if(prepared.periodBlocked||prepared.timeWindow||prepared.hardTimeReference)return respond({answer:'แผนการตรวจเยี่ยมแสดงสถานะปัจจุบันเท่านั้น กรุณาขอแผนโดยไม่ระบุช่วงเวลา',grounded:false,dataSource:'real',conversation:{topic:incomingTopic},meta:{fastPath:true,ollamaCalls:0,responseTimeMs:Date.now()-start}});
   if(visitPlanIntent.missingStation)return respond({answer:'ได้ยินชื่อ สภ. ไม่ชัด กรุณาระบุอีกครั้ง เช่น “ขอแผนการตรวจเยี่ยม สภ.กลางใหญ่ จังหวัดอุดรธานี”',grounded:false,dataSource:'real',conversation:{topic:incomingTopic},meta:{fastPath:true,ollamaCalls:0,responseTimeMs:Date.now()-start}});
   try{return planResultResponse(await readVisitPlan(req,{station:visitPlanIntent.station,province:explicitProvince||null}));}
   catch(e){return sendFailure(e);}
  }
  // A pending period question accepts short answers that fill exactly the
  // missing piece (registry count without the period, or windowed monitoring).
  if(incomingTopic?.pending?.type==='period_intent'){
   const pending=incomingTopic.pending;
   const stripped=message.replace(/(?:นะ)?(?:ครับ|ค่ะ|คะ)/gu,'').replace(/\s+/g,' ').trim();
   if(/^(?:ยกเลิก|เอาไว้ก่อน|ไม่(?:ละ|ครับ|ค่ะ)?)$/u.test(stripped)){
    const {pending:_drop,...rest}=incomingTopic;
    incomingTopic=sanitizeTopic(rest);
   } else {
    const choice=/^(?:(1|2|หนึ่ง|สอง)|นับ(?:จาก)?ทะเบียนปัจจุบัน|ทะเบียนปัจจุบัน|ปัจจุบัน|ทั้งหมด|เฝ้าระวังหรือเสี่ยงสูง(?:ช่วงนี้)?|เฝ้าระวัง|เสี่ยงสูง|ช่วงนี้)$/u.exec(stripped);
    if(choice){
     const pickRegistry=/^(?:1|หนึ่ง|นับ|ทะเบียน|ปัจจุบัน|ทั้งหมด)/.test(choice[0]);
     const window=pending.window||null;
     const type=pending.person_type||null;
     const {pending:_drop,...baseTopic}=incomingTopic;
     if(pickRegistry){
      try{
       const result=await search(req,{...(type?{person_type:type}:{}),...(baseTopic.province?{province:baseTopic.province}:{}),...(baseTopic.district?{district:baseTopic.district}:{}),...(baseTopic.subdistrict?{subdistrict:baseTopic.subdistrict}:{}),...(baseTopic.station?{station:baseTopic.station}:{}),...(baseTopic.exclude?.length?{exclude:baseTopic.exclude}:{})},1);
       const category={psychiatric:'ผู้ป่วยจิตเวช',drug_user:'ผู้เสพ',dealer:'ผู้ค้า',released:'ผู้พ้นโทษ'}[type]||'บุคคล';
       const answer=(result.total?`มี${category} ${result.total} คน`:`ไม่มี${category}`)+' (นับจากทะเบียนปัจจุบัน ไม่ได้กรองตามช่วงเวลา)';
       return respond({answer,grounded:true,dataSource:'real',toolsUsed:[{name:'supabase_people_read'}],conversation:{topic:sanitizeTopic(baseTopic)},meta:{fastPath:true,ollamaCalls:0,responseTimeMs:Date.now()-start}});
      }catch(e){return sendFailure(e);}
     }
     try{
      const area={province:baseTopic.province,station:baseTopic.station,district:baseTopic.district,subdistrict:baseTopic.subdistrict};
      const {result,items,answer}=await runMonitoringAnswer(req,{level:'all',personType:type,area,window,exclude:baseTopic.exclude||[]});
      const topic=sanitizeTopic({...baseTopic,person_type:type||undefined,level:'all',kind:'monitoring_list',window:window||undefined,page:result.page});
      return respond({answer,grounded:true,dataSource:'real',toolsUsed:[{name:'supabase_monitoring_read'}],presentation:monitoringPresentation(result,items,type),conversation:{topic},meta:{fastPath:true,ollamaCalls:0,responseTimeMs:Date.now()-start,querySummary:describeQuerySpec(monitoringSpec({level:'all',personType:type,area,window,exclude:baseTopic.exclude||[],page:result.page}))}});
     }catch(e){return sendFailure(e);}
    }
    // Anything longer is a new request; the pending question no longer
    // applies, so it must not leak into unrelated answers.
    const {pending:_drop,...rest}=incomingTopic;
    incomingTopic=sanitizeTopic(rest);
   }
  }
  // Conversation continuations adjust the most recent list/monitoring query.
  // Detection runs on the full normalized message because a bare period
  // follow-up is the whole text; every condition is then re-applied through
  // the same authorized read path as the original question.
  const continuation=detectContinuation(message,incomingTopic);
  if(continuation){
   const t=incomingTopic;
   const kind=t?.kind||((t?.level==='high'||t?.level==='watch'||t?.level==='all')?'monitoring_list':null);
   if(continuation.type==='period_block'){
    return respond({answer:periodBlockedMessage(continuation.blocked),grounded:false,dataSource:'real',conversation:{topic:t},meta:{fastPath:true,ollamaCalls:0,responseTimeMs:Date.now()-start}});
   }
   if(continuation.type==='count_to_list'){
    try{
     if(kind==='monitoring_list'||t.level){
      const area={province:t.province,station:t.station,district:t.district,subdistrict:t.subdistrict};
      const {result,items,answer}=await runMonitoringAnswer(req,{level:t.level||'all',personType:t.person_type||null,area,window:t.window||null,exclude:t.exclude||[],page:1});
      const topic=sanitizeTopic({...t,kind:'monitoring_list',page:result.page});
      return respond({answer,grounded:true,dataSource:'real',toolsUsed:[{name:'supabase_monitoring_read'}],presentation:monitoringPresentation(result,items,t.person_type),conversation:{topic},meta:{fastPath:true,ollamaCalls:0,responseTimeMs:Date.now()-start,querySummary:describeQuerySpec(monitoringSpec({level:t.level||'all',personType:t.person_type,area,window:t.window,exclude:t.exclude,page:result.page}))}});
     }
     const filters={...(t.person_type?{person_type:t.person_type}:{}),...(t.province?{province:t.province}:{}),...(t.district?{district:t.district}:{}),...(t.subdistrict?{subdistrict:t.subdistrict}:{}),...(t.station?{station:t.station}:{}),...(t.exclude?.length?{exclude:t.exclude}:{})};
     const result=await search(req,filters,1);
     const items=result.data.map(p=>({person_id:p.id,full_name:`${p.first_name||''} ${p.last_name||''}`.trim(),person_type:t.person_type||null,subdistrict:p.tambon||'',district:p.amphoe||'',province:p.province||null,station_name:p.station_name||(Number(p.station_id)===parseStationId(req.user.stationId)?req.user.stationName||null:null)}));
     const topic=sanitizeTopic({...t,kind:'people_list',page:1});
     const excludeNote=t.exclude?.length?` (ไม่รวม${t.exclude.map(filter=>filter.label).join(' ')})`:'';
     return respond({answer:`ข้อมูลจริง: พบ ${result.total} คนตามสิทธิ์และเงื่อนไขที่ค้นหา${excludeNote}`,grounded:true,dataSource:'real',toolsUsed:[{name:'supabase_people_read'}],presentation:{type:'person_list',total:result.total,returned:items.length,page:1,pageSize:20,filters:{person_type:t.person_type||null},items},conversation:{topic},meta:{fastPath:true,ollamaCalls:0,responseTimeMs:Date.now()-start,querySummary:describeQuerySpec(peopleListSpec({filters,page:1}))}});
    }catch(e){return sendFailure(e);}
   }
   if(continuation.type==='level_switch'){
    try{
     const area={province:t.province,station:t.station,district:t.district,subdistrict:t.subdistrict};
     const level=continuation.level;
     const {result,items,answer}=await runMonitoringAnswer(req,{level,personType:t.person_type||null,area,window:t.window||null,exclude:t.exclude||[],page:1});
     const topic=sanitizeTopic({...t,level,kind:'monitoring_list',page:result.page});
     return respond({answer,grounded:true,dataSource:'real',toolsUsed:[{name:'supabase_monitoring_read'}],presentation:monitoringPresentation(result,items,t.person_type),conversation:{topic},meta:{fastPath:true,ollamaCalls:0,responseTimeMs:Date.now()-start,querySummary:describeQuerySpec(monitoringSpec({level,personType:t.person_type,area,window:t.window,exclude:t.exclude,page:result.page}))}});
    }catch(e){return sendFailure(e);}
   }
   if(continuation.type==='type_switch'){
    try{
     const type=continuation.personType;
     const category={psychiatric:'ผู้ป่วยจิตเวช',drug_user:'ผู้เสพ',dealer:'ผู้ค้า',released:'ผู้พ้นโทษ'}[type]||'บุคคล';
     const filters={...(t.province?{province:t.province}:{}),...(t.district?{district:t.district}:{}),...(t.subdistrict?{subdistrict:t.subdistrict}:{}),...(t.station?{station:t.station}:{}),...(t.exclude?.length?{exclude:t.exclude}:{}),person_type:type};
     const result=await search(req,filters,1);
     const areaParts=[];
     if(t.subdistrict)areaParts.push(`ตำบล${t.subdistrict}`);
     if(t.district)areaParts.push(`อำเภอ${t.district}`);
     if(t.station)areaParts.push(`สภ.${t.station}`);
     const areaLabel=areaParts.length?` ในพื้นที่ ${areaParts.join(' ')}`:'';
     const excludeNote=t.exclude?.length?` (ไม่รวม${t.exclude.map(filter=>filter.label).join(' ')})`:'';
     if(continuation.wantList){
      const items=result.data.map(p=>({person_id:p.id,full_name:`${p.first_name||''} ${p.last_name||''}`.trim(),person_type:type,subdistrict:p.tambon||'',district:p.amphoe||'',province:p.province||null,station_name:p.station_name||(Number(p.station_id)===parseStationId(req.user.stationId)?req.user.stationName||null:null)}));
      const topic=sanitizeTopic({...t,person_type:type,kind:'people_list',page:1});
      return respond({answer:`ข้อมูลจริง: พบ ${result.total} คนตามสิทธิ์และเงื่อนไขที่ค้นหา${excludeNote}`,grounded:true,dataSource:'real',toolsUsed:[{name:'supabase_people_read'}],presentation:{type:'person_list',total:result.total,returned:items.length,page:1,pageSize:20,filters:{person_type:type},items},conversation:{topic},meta:{fastPath:true,ollamaCalls:0,responseTimeMs:Date.now()-start,querySummary:describeQuerySpec(peopleListSpec({filters,page:1}))}});
     }
     const answer=result.total?`มี${category} ${result.total} คน${areaLabel}${excludeNote}`:`ไม่มี${category}${areaLabel}${excludeNote}`;
     const topic=sanitizeTopic({...t,person_type:type,page:1});
     return respond({answer,grounded:true,dataSource:'real',toolsUsed:[{name:'supabase_people_read'}],conversation:{topic},meta:{fastPath:true,ollamaCalls:0,responseTimeMs:Date.now()-start}});
    }catch(e){return sendFailure(e);}
   }
   if(!kind){
    return respond({answer:'ไม่มีรายการล่าสุดให้ปรับ กรุณาถามใหม่ เช่น “ใครเสี่ยงสูงเดือนนี้” หรือ “ขอรายชื่อผู้เสพ”',grounded:false,dataSource:'real',conversation:{topic:t},meta:{fastPath:true,ollamaCalls:0,responseTimeMs:Date.now()-start}});
   }
   if(continuation.type==='window_change'){
    if(kind!=='monitoring_list'){
     return respond({answer:'การกรองช่วงเวลาใช้ได้กับรายการเฝ้าระวัง/เสี่ยงสูง หรือประวัติเยี่ยมของบุคคลที่เลือกเท่านั้น (ทะเบียนทั่วไปไม่มีวันที่ให้กรอง)',grounded:false,dataSource:'real',conversation:{topic:t},meta:{fastPath:true,ollamaCalls:0,responseTimeMs:Date.now()-start}});
    }
    try{
     const window=continuation.window;
     const {result,items,answer}=await runMonitoringAnswer(req,{level:t.level||'all',personType:t.person_type||null,area:{province:t.province,station:t.station,district:t.district,subdistrict:t.subdistrict},window,exclude:t.exclude||[],page:1});
     const topic=sanitizeTopic({...t,window:window||undefined,page:result.page});
     return respond({answer,grounded:true,dataSource:'real',toolsUsed:[{name:'supabase_monitoring_read'}],presentation:monitoringPresentation(result,items,t.person_type),conversation:{topic},meta:{fastPath:true,ollamaCalls:0,responseTimeMs:Date.now()-start,querySummary:describeQuerySpec(monitoringSpec({level:t.level||'all',personType:t.person_type,area:{province:t.province,station:t.station,district:t.district,subdistrict:t.subdistrict},window,exclude:t.exclude,page:result.page}))}});
    }catch(e){return sendFailure(e);}
   }
   if(continuation.type==='area_refine'){
    if(continuation.unit==='province'||continuation.unit==='station'){
     const label=continuation.unit==='station'?'สภ.':'จังหวัด';
     return respond({answer:`การจำกัดรายการเฝ้าระวัง/เสี่ยงสูงตาม${label} กรุณาถามใหม่โดยระบุ${label}ในคำถาม`,grounded:false,dataSource:'real',conversation:{topic:t},meta:{fastPath:true,ollamaCalls:0,responseTimeMs:Date.now()-start}});
    }
    let areaPatch={};
    if(continuation.unit)areaPatch[continuation.unit==='station'?'station':continuation.unit]=continuation.value;
    else{
     try{
      const catalogue=await areaCatalogue(req);
      const sub=matchPlaceNames(continuation.value,catalogue.subdistricts);
      const dis=matchPlaceNames(continuation.value,catalogue.districts);
      if(sub.length===1)areaPatch.subdistrict=sub[0];
      else if(sub.length>1)throw areaChoicesError('ตำบล',continuation.value,sub,catalogue.pairs);
      else if(dis.length===1)areaPatch.district=dis[0];
      else if(dis.length>1)throw areaChoicesError('อำเภอ',continuation.value,dis,catalogue.pairs);
      else return respond({answer:`ไม่พบพื้นที่ “${continuation.value}” ในขอบเขตที่ท่านมีสิทธิ์เข้าถึง`,grounded:true,dataSource:'real',conversation:{topic:t},meta:{fastPath:true,ollamaCalls:0,responseTimeMs:Date.now()-start}});
     }catch(e){return sendFailure(e);}
    }
    try{
     if(kind==='monitoring_list'){
      const area={province:t.province,station:t.station,district:t.district,subdistrict:t.subdistrict,...areaPatch};
      const {result,items,answer}=await runMonitoringAnswer(req,{level:t.level||'all',personType:t.person_type||null,area,window:t.window||null,exclude:t.exclude||[],page:1});
      const topic=sanitizeTopic({...t,...areaPatch,page:result.page});
      return respond({answer,grounded:true,dataSource:'real',toolsUsed:[{name:'supabase_monitoring_read'}],presentation:monitoringPresentation(result,items,t.person_type),conversation:{topic},meta:{fastPath:true,ollamaCalls:0,responseTimeMs:Date.now()-start,querySummary:describeQuerySpec(monitoringSpec({level:t.level||'all',personType:t.person_type,area,window:t.window,exclude:t.exclude,page:result.page}))}});
     }
     const filters={...(t.person_type?{person_type:t.person_type}:{}),...(t.province?{province:t.province}:{}),...(t.district?{district:t.district}:{}),...(t.subdistrict?{subdistrict:t.subdistrict}:{}),...(t.station?{station:t.station}:{}),...(t.exclude?.length?{exclude:t.exclude}:{}),...areaPatch};
     const result=await search(req,filters,1);
     const items=result.data.map(p=>({person_id:p.id,full_name:`${p.first_name||''} ${p.last_name||''}`.trim(),person_type:t.person_type||null,subdistrict:p.tambon||'',district:p.amphoe||'',province:p.province||null,station_name:p.station_name||(Number(p.station_id)===parseStationId(req.user.stationId)?req.user.stationName||null:null)}));
     const topic=sanitizeTopic({...t,...areaPatch,page:1});
     return respond({answer:`ข้อมูลจริง: พบ ${result.total} คนตามสิทธิ์และเงื่อนไขที่ค้นหา`,grounded:true,dataSource:'real',toolsUsed:[{name:'supabase_people_read'}],presentation:{type:'person_list',total:result.total,returned:items.length,page:1,pageSize:20,filters:{person_type:t.person_type||null},items},conversation:{topic},meta:{fastPath:true,ollamaCalls:0,responseTimeMs:Date.now()-start,querySummary:describeQuerySpec(peopleListSpec({filters,page:1}))}});
    }catch(e){return sendFailure(e);}
   }
   if(continuation.type==='next_page'){
    const page=Math.min(continuation.page,50);
    try{
     if(kind==='monitoring_list'){
      const {result,items,answer}=await runMonitoringAnswer(req,{level:t.level||'all',personType:t.person_type||null,area:{province:t.province,station:t.station,district:t.district,subdistrict:t.subdistrict},window:t.window||null,exclude:t.exclude||[],page});
      const topic=sanitizeTopic({...t,page:result.page});
      return respond({answer,grounded:true,dataSource:'real',toolsUsed:[{name:'supabase_monitoring_read'}],presentation:monitoringPresentation(result,items,t.person_type),conversation:{topic},meta:{fastPath:true,ollamaCalls:0,responseTimeMs:Date.now()-start,querySummary:describeQuerySpec(monitoringSpec({level:t.level||'all',personType:t.person_type,area:{province:t.province,station:t.station,district:t.district,subdistrict:t.subdistrict},window:t.window,exclude:t.exclude,page:result.page}))}});
     }
     const filters={...(t.person_type?{person_type:t.person_type}:{}),...(t.province?{province:t.province}:{}),...(t.district?{district:t.district}:{}),...(t.subdistrict?{subdistrict:t.subdistrict}:{}),...(t.station?{station:t.station}:{}),...(t.exclude?.length?{exclude:t.exclude}:{})};
     const result=await search(req,filters,page);
     const items=result.data.map(p=>({person_id:p.id,full_name:`${p.first_name||''} ${p.last_name||''}`.trim(),person_type:t.person_type||null,subdistrict:p.tambon||'',district:p.amphoe||'',province:p.province||null,station_name:p.station_name||(Number(p.station_id)===parseStationId(req.user.stationId)?req.user.stationName||null:null)}));
     const topic=sanitizeTopic({...t,page});
     return respond({answer:`ข้อมูลจริง: พบ ${result.total} คนตามสิทธิ์และเงื่อนไขที่ค้นหา (หน้า ${page})`,grounded:true,dataSource:'real',toolsUsed:[{name:'supabase_people_read'}],presentation:{type:'person_list',total:result.total,returned:items.length,page,pageSize:20,filters:{person_type:t.person_type||null},items},conversation:{topic},meta:{fastPath:true,ollamaCalls:0,responseTimeMs:Date.now()-start,querySummary:describeQuerySpec(peopleListSpec({filters,page}))}});
    }catch(e){return sendFailure(e);}
   }
  }
  const stationRank=requestedStation?null:(detectStationRanking(routingMessage)||detectAggregateSortContinuation(routingMessage,incomingTopic));
  if(stationRank){
   if(prepared.exclusions.length)return respond({answer:'การยกเว้นพื้นที่ยังไม่รองรับกับการจัดอันดับ สภ. กรุณาถามแยกตามพื้นที่ที่ต้องการดู',grounded:false,dataSource:'real',conversation:{topic:selectedTopic},meta:{fastPath:true,ollamaCalls:0,responseTimeMs:Date.now()-start}});
   if(prepared.periodBlocked)return respond({answer:periodBlockedMessage(prepared.periodBlocked),grounded:false,dataSource:'real',conversation:{topic:selectedTopic},meta:{fastPath:true,ollamaCalls:0,responseTimeMs:Date.now()-start}});
   if(prepared.timeWindow)return respond({answer:periodIntentQuestion(routingMessage,prepared.timeWindow).answer,grounded:false,dataSource:'real',conversation:{topic:selectedTopic},meta:{fastPath:true,ollamaCalls:0,responseTimeMs:Date.now()-start}});
   try { const result=await stationRanking(req,selectedProvince,stationRank);return respond({answer:result.answer,grounded:true,dataSource:'real',toolsUsed:[{name:'ai-summary/target_person_summary'}],presentation:result.presentation,conversation:{topic:selectedTopic},meta:{fastPath:true,ollamaCalls:0,responseTimeMs:Date.now()-start}}); }
   catch(e){return sendFailure(e);}
  }
  const exportIntent=detectExportIntent(routingMessage);
  if(exportIntent){
   if(prepared.periodBlocked)return respond({answer:periodBlockedMessage(prepared.periodBlocked),grounded:false,dataSource:'real',conversation:{topic:incomingTopic},meta:{fastPath:true,ollamaCalls:0,responseTimeMs:Date.now()-start}});
   // Fresh in-message exclusions ride along; the report must carry exactly
   // the conditions the officer named, never a silently wider list.
   let freshExclude=[];
   if(prepared.exclusions.length){
    try{freshExclude=await resolveExclusions(req,prepared.exclusions);}catch(e){return sendFailure(e);}
   }
   const topicWindow=incomingTopic?.window||null;
   const topicLevel=incomingTopic?.level||null;
   const monitoringContext=topicLevel==='high'||topicLevel==='watch';
   // A window is exportable only on the recorded-monitoring path; for plain
   // people lists there is no date field, so refuse instead of dropping it.
   if((prepared.timeWindow||topicWindow)&&!monitoringContext){
    return respond({answer:'รายงานทะเบียนทั่วไปยังกรองตามช่วงเวลาไม่ได้ เพราะทะเบียนบุคคลไม่เปิดวันที่ลงทะเบียนให้อ่าน จึงไม่สร้างไฟล์ที่เงื่อนไขหายไป ' + PERIOD_HINT + ' ส่วนรายการเฝ้าระวัง/เสี่ยงสูงตามช่วงเวลาส่งออกเป็นไฟล์ได้',grounded:false,dataSource:'real',conversation:{topic:incomingTopic},meta:{fastPath:true,ollamaCalls:0,responseTimeMs:Date.now()-start}});
   }
   const reportRequest=reportRequestFromExport(exportIntent,incomingTopic);
   if(prepared.timeWindow)reportRequest.filters.window={from:prepared.timeWindow.from,to:prepared.timeWindow.to,label:prepared.timeWindow.label};
   const mergedExclude=[...(reportRequest.filters.exclude||[])];
   for(const filter of freshExclude)if(!mergedExclude.some(item=>item.column===filter.column&&(item.value===filter.value||item.ids===filter.ids)))mergedExclude.push(filter);
   if(mergedExclude.length)reportRequest.filters.exclude=mergedExclude;
   const files=exportIntent.formats.map(item=>item==='xlsx'?'Excel':'PDF').join(' และ ');
   const hasRecentResult=Boolean(incomingTopic&&(incomingTopic.kind==='people_list'||incomingTopic.kind==='monitoring_list'||incomingTopic.report_kind==='target_person_aggregate'));
   const explicitSingleFormat=exportIntent.formats.length===1&&exportIntent.explicitFormat;
   const needsConfirm=!hasRecentResult||!explicitSingleFormat;
   const spec=normalizeQuerySpec({kind:'report',person_type:reportRequest.filters.person_type||null,area:{province:reportRequest.filters.province,district:reportRequest.filters.district,subdistrict:reportRequest.filters.subdistrict,station:reportRequest.filters.station},level:reportRequest.filters.level,window:reportRequest.filters.window||null,exclude:reportRequest.filters.exclude||[]});
   const summaryText=describeQuerySpec(spec);
   const answer=needsConfirm
    ?`ต้องการสร้างรายงาน${files}ของรายการหรือภาพรวมล่าสุดใช่หรือไม่? เลือก 1. ใช่ หรือ 2. ไม่${summaryText?`\nเงื่อนไขรายงาน: ${summaryText}`:''}`
    :`พร้อมสร้างรายงาน${files} จากทะเบียนจริงตามสิทธิ์บัญชีนี้ กดดาวน์โหลดด้านล่าง (ไม่รวมเลขบัตรและเบอร์โทร)${summaryText?`\nเงื่อนไขรายงาน: ${summaryText}`:''}`;
   return respond({answer,grounded:true,dataSource:'real',presentation:{type:'report_offer',formats:exportIntent.formats,auto:needsConfirm?null:exportIntent.formats[0],confirm:needsConfirm,reportRequest},conversation:{topic:incomingTopic},meta:{fastPath:true,ollamaCalls:0,responseTimeMs:Date.now()-start}});
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
   if(prepared.periodBlocked)return respond({answer:periodBlockedMessage(prepared.periodBlocked),grounded:false,dataSource:'real',conversation,meta:{fastPath:true,ollamaCalls:0,responseTimeMs:Date.now()-start}});
   if(prepared.timeWindow)return respond({answer:periodIntentQuestion(routingMessage,prepared.timeWindow).answer,grounded:false,dataSource:'real',conversation,meta:{fastPath:true,ollamaCalls:0,responseTimeMs:Date.now()-start}});
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
   const overviewGuard=prepared.exclusions.length
    ?'การยกเว้นพื้นที่ยังไม่รองรับกับภาพรวมจากระบบกลาง กรุณาถามแยกตามพื้นที่'
    :prepared.periodBlocked?periodBlockedMessage(prepared.periodBlocked)
    :prepared.timeWindow?periodIntentQuestion(routingMessage,prepared.timeWindow).answer
    :null;
   if(overview.filters.person_type==='psychiatric'&&!overview.filters.station&&!overview.filters.district&&!overview.filters.subdistrict){
    if(overviewGuard)return respond({answer:overviewGuard,grounded:false,dataSource:'real',conversation,meta:{fastPath:true,ollamaCalls:0,responseTimeMs:Date.now()-start}});
    try { const result=await psychiatricSummary(req,selectedProvince); return respond({answer:result.answer,grounded:true,dataSource:'real',toolsUsed:[{name:'ai-summary/psychiatric_summary'}],presentation:result.presentation,conversation,meta:{fastPath:true,ollamaCalls:0,responseTimeMs:Date.now()-start}}); }
    catch(e){return sendFailure(e);}
   }
   if((!overview.filters.person_type || ['drug_user','dealer','released'].includes(overview.filters.person_type))&&!overview.filters.station&&!overview.filters.district&&!overview.filters.subdistrict){
    if(overviewGuard)return respond({answer:overviewGuard,grounded:false,dataSource:'real',conversation,meta:{fastPath:true,ollamaCalls:0,responseTimeMs:Date.now()-start}});
    try { const result=await targetPersonSummary(req,selectedProvince);const reportTopic=sanitizeTopic({...(conversation.topic||{}),report_kind:'target_person_aggregate'}); return respond({answer:result.answer,grounded:true,dataSource:'real',toolsUsed:[{name:'ai-summary/target_person_summary'}],presentation:result.presentation,conversation:{topic:reportTopic},meta:{fastPath:true,ollamaCalls:0,responseTimeMs:Date.now()-start}}); }
    catch(e){return sendFailure(e);}
   }
   try {
    if(prepared.periodBlocked)return respond({answer:periodBlockedMessage(prepared.periodBlocked),grounded:false,dataSource:'real',conversation,meta:{fastPath:true,ollamaCalls:0,responseTimeMs:Date.now()-start}});
    if(prepared.timeWindow)return respond({answer:periodIntentQuestion(routingMessage,prepared.timeWindow).answer,grounded:false,dataSource:'real',conversation,meta:{fastPath:true,ollamaCalls:0,responseTimeMs:Date.now()-start}});
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
   if(prepared.periodBlocked)return respond({answer:periodBlockedMessage(prepared.periodBlocked),grounded:false,dataSource:'real',meta:{fastPath:true,ollamaCalls:0,responseTimeMs:Date.now()-start}});
   if(prepared.hardTimeReference&&/เยี่ยม|ประวัติ|ปัสสาวะ|ฉี่|ตรวจยา|เสี่ยง|เฝ้าระวัง/.test(routingMessage))return respond({answer:`ช่วงเวลาที่ระบุยังไม่รองรับ ${PERIOD_HINT}`,grounded:false,dataSource:'real',meta:{fastPath:true,ollamaCalls:0,responseTimeMs:Date.now()-start}});
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
   if(prepared.periodBlocked)return respond({answer:periodBlockedMessage(prepared.periodBlocked),grounded:false,dataSource:'real',meta:{fastPath:true,ollamaCalls:0,responseTimeMs:Date.now()-start}});
   if(monitor.unsupported)return respond({answer:`ช่วงเวลาที่ระบุยังไม่รองรับ ${PERIOD_HINT}`,grounded:false,dataSource:'real',meta:{fastPath:true,ollamaCalls:0,responseTimeMs:Date.now()-start}});
   try {
    // A fresh monitoring question replaces the previous window/exclusion; the
    // area (subdistrict/district) may persist from the conversation topic.
    const monitorArea={province:selectedProvince,station:monitor.station||(!explicitProvince?incomingTopic?.station:null),district:monitor.district,subdistrict:monitor.subdistrict};
    const {result,items,answer}=await runMonitoringAnswer(req,{level:monitor.level,personType:monitor.person_types[0]||null,area:monitorArea,window:prepared.timeWindow,exclude:excludeFilters,page:monitor.page||1});
    const monitoringTopic=sanitizeTopic({
     province:monitorArea.province||undefined,station:monitorArea.station||undefined,
     ...(incomingTopic?{exclude:incomingTopic.exclude}:{}),
     person_type:monitor.person_types[0]||undefined,
     level:monitor.level,kind:'monitoring_list',page:result.page,
     ...(prepared.timeWindow?{window:prepared.timeWindow}:{}),
     ...(excludeFilters.length?{exclude:excludeFilters}:{}),
     ...(monitor.district?{district:monitor.district}:{}),...(monitor.subdistrict?{subdistrict:monitor.subdistrict}:{}),
    });
    return respond({answer,grounded:true,dataSource:'real',toolsUsed:[{name:'supabase_monitoring_read'}],presentation:monitoringPresentation(result,items,monitor.person_types[0]),conversation:{topic:monitoringTopic},meta:{fastPath:true,ollamaCalls:0,responseTimeMs:Date.now()-start,querySummary:describeQuerySpec(monitoringSpec({level:monitor.level,personType:monitor.person_types[0],area:monitorArea,window:prepared.timeWindow,exclude:excludeFilters,page:result.page}))}});
   } catch(e){return sendFailure(e);}
  }
  if(intent?.intent==='lookup_clarify')return respond({answer:intent.answer,grounded:false,dataSource:'real',presentation:intent.presentation,conversation,meta:{fastPath:true,ollamaCalls:0,responseTimeMs:Date.now()-start}});
  if(intent?.intent==='group_persons' && {subdistrict:'ตำบล',district:'อำเภอ',province:'จังหวัด'}[intent.groupBy]){
   if(!ranking)ranking=[message,{subdistrict:'ตำบล',district:'อำเภอ',province:'จังหวัด'}[intent.groupBy],alphaOrder?'alpha':explicitCountOrder||'alpha'];
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
   // A period on a plain count/list is genuinely ambiguous (the registry has
   // no readable registration date), so ask exactly what is missing and keep
   // the pending choice for a short reply.
   if(prepared.periodBlocked)return respond({answer:periodBlockedMessage(prepared.periodBlocked),grounded:false,dataSource:'real',conversation,meta:{fastPath:!ollamaCalls,ollamaCalls,responseTimeMs:Date.now()-start}});
   if(prepared.timeWindow){
    const question=periodIntentQuestion(routingMessage,prepared.timeWindow);
    const pendingTopic=sanitizeTopic({...(selectedTopic||{}),...periodIntentAreas(routingMessage),pending:question.pending});
    return respond({answer:question.answer,grounded:false,dataSource:'real',presentation:question.presentation,conversation:{topic:pendingTopic},meta:{fastPath:!ollamaCalls,ollamaCalls,responseTimeMs:Date.now()-start}});
   }
   if((!ranking&&!summary&&!intent)||summary?.intent==='summary_choices'||intent?.intent==='search_incomplete'){
    ollamaCalls=1;plan=await interpret(routingMessage);
    if(plan.action==='clarify')return respond({answer:'ต้องการจำนวน รายชื่อ หรือแยกยอดตามพื้นที่ใดครับ? กรุณาระบุประเภทบุคคลและพื้นที่ที่ต้องการ',grounded:false,dataSource:'real',meta:{fastPath:false,ollamaCalls,responseTimeMs:Date.now()-start}});
    if(plan.action==='group'){ranking=[routingMessage,plan.group,alphaOrder?'alpha':explicitCountOrder||'alpha'];showAll=true;}
   }
   const filters={...(summary?.filters||intent?.filters||{})};
   if(plan){for(const key of ['province','district','subdistrict','station','search'])if(plan[key])filters[key]=plan[key];if(plan.person_type!=='all')filters.person_type=plan.person_type;}
   if(requestedStation)filters.station=requestedStation;
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
     const difference=ranking[2]==='alpha'?0:/น้อย/.test(ranking[2])?a.count-b.count:b.count-a.count;
     // Do not rely on optional ICU locale data being installed on the server.
     // Code-point ordering is deterministic across the supported Node runtimes.
     return difference||(a.name===b.name?0:(a.name<b.name?-1:1));
    });
    const winners=topN!==null?sorted.slice(0,topN):showAll?sorted:sorted.filter(g=>g.count===sorted[0]?.count);
    const category={psychiatric:'ผู้ป่วยจิตเวช',drug_user:'ผู้เสพ',dealer:'ผู้ค้า',released:'ผู้พ้นโทษ'}[filters.person_type]||'บุคคล';
    const scope=filters.station?`สภ.${String(filters.station).replace(/^สภ\.?\s*/u,'')}`:filters.province?`จังหวัด${filters.province}`:filters.district?`อำเภอ${filters.district}`:filters.subdistrict?`ตำบล${filters.subdistrict}`:(req.user.stationName||'พื้นที่ที่บัญชีนี้มีสิทธิ์เข้าถึง');
    const heading=topN!==null?`${topN} อันดับ${ranking[1]}${/น้อย/.test(ranking[2])?'น้อยที่สุด':'มากที่สุด'}`:'';
    const orderLabel=ranking[2]==='alpha'?'เรียงตามตัวอักษร':`เรียง${/น้อย/.test(ranking[2])?'น้อยไปมาก':'มากไปน้อย'}`;
    const answer=`ข้อมูลจริง • ${scope}\nนับ${category}จากทะเบียนทั้งหมด ${result.total} คน\n`+(showAll||topN!==null?`${heading||orderLabel}\n`:'')+(winners.length?winners.map((g,index)=>`${showAll||topN!==null?`${index+1}. `:''}${ranking[1]}${g.name} ${column==='tambon'?g.district:''} ${column!=='province'?g.province:''} มี${category}${showAll||topN!==null?'':ranking[2]} ${g.count} คน`).join('\n'):'ไม่พบข้อมูลพื้นที่ที่จัดอันดับได้')+(!showAll&&topN===null&&winners.length>1?'\nมีหลายพื้นที่จำนวนเท่ากัน':'')+(missing?`\nอีก ${missing} คนไม่ระบุ${ranking[1]} จึงไม่รวมในอันดับ`:'')+(/น้อย/.test(ranking[2])?'\nอันดับนี้รวมเฉพาะพื้นที่ที่มีบุคคลในทะเบียน':'')+(excludeNote||'');
    return respond({answer,grounded:true,dataSource:'real',toolsUsed:[{name:'supabase_area_count'}],presentation:{type:'location_summary',groupBy:{tambon:'subdistrict',amphoe:'district',province:'province'}[column],items:winners,filters:{person_type:filters.person_type||null}},conversation,meta:{fastPath:!ollamaCalls,ollamaCalls,responseTimeMs:Date.now()-start}});
   }
   const page=intent?.page||1;const result=await search(req,filters,page);
   if(result.fuzzy)fuzzyNote=result.fuzzy;
   const category={psychiatric:'ผู้ป่วยจิตเวช',drug_user:'ผู้เสพ',dealer:'ผู้ค้า',released:'ผู้พ้นโทษ'}[filters.person_type]||'บุคคล';
   const countOnly=plan?.action==='count'||(intent&&/^count_/.test(intent.intent))||(!summary?.includeList&&(/กี่|จำนวน|มีมั้ย|มีไหม|มีหรือไม่|มีรึเปล่า/.test(routingMessage)));
   // สภ./อำเภอ/จังหวัด context for the shown page: one shared source goes in
   // the answer header, mixed sources stay per row in the presentation.
   const ownStationId=countOnly?null:parseStationId(req.user.stationId);
   const stationNames=new Map();
   if(ownStationId&&req.user.stationName)stationNames.set(ownStationId,String(req.user.stationName).trim());
   for(const person of result.data)if(person.station_name&&Number.isSafeInteger(Number(person.station_id)))stationNames.set(Number(person.station_id),String(person.station_name).trim());
   const unknownStationIds=countOnly?[]:[...new Set(result.data.map(p=>Number(p.station_id)).filter(id=>Number.isSafeInteger(id)&&id>0&&!stationNames.has(id)))];
   if(unknownStationIds.length){
    const st=await rows(req,'stations',new URLSearchParams({select:'station_id,station_name',station_id:`in.(${unknownStationIds.join(',')})`,limit:'1000'}));
    for(const row of st.data)stationNames.set(Number(row.station_id),String(row.station_name||'').trim());
   }
   const stationNameOf=(p)=>{const id=Number(p.station_id);return Number.isFinite(id)?(stationNames.get(id)||null):null;};
   const single=(values)=>{const set=new Set(values);return set.size===1?[...set][0]:null;};
   const uniformStation=single(result.data.map(p=>stationNameOf(p)).filter(Boolean));
   const uniformDistrict=single(result.data.map(p=>String(p.amphoe||'').trim()).filter(Boolean));
   const uniformProvince=single(result.data.map(p=>String(p.province||'').trim()).filter(Boolean));
   let uniform='';
   if(!countOnly&&(filters.station||uniformStation))uniform+=` • สังกัด สภ.${String(filters.station||uniformStation).replace(/^สภ\.?\s*/u,'')}`;
   if(!countOnly&&uniformDistrict)uniform+=` • อำเภอ${uniformDistrict}`;
   if(!countOnly&&uniformProvince)uniform+=` • จังหวัด${uniformProvince}`;
   const items=result.data.map(p=>({person_id:p.id,full_name:`${p.first_name||''} ${p.last_name||''}`.trim(),person_type:filters.person_type||null,subdistrict:p.tambon||'',district:p.amphoe||'',station_name:stationNameOf(p),province:String(p.province||'').trim()||null}));
   const answer=countOnly
    ?(result.total?`มี${category} ${result.total} คน${excludeNote||''}`:`ไม่มี${category}${excludeNote||''}`)
    :`ข้อมูลจริง: พบ ${result.total} คนตามสิทธิ์และเงื่อนไขที่ค้นหา${uniform||''}${excludeNote||''}`;
   const presentation=countOnly?undefined:{type:'person_list',total:result.total,returned:items.length,page,pageSize:20,filters:{person_type:filters.person_type||null,province:filters.province||null,station:filters.station||null,district:filters.district||null,subdistrict:filters.subdistrict||null},items};
   // The topic for a fresh people query carries only this message's own
   // conditions plus inherited area — never the previous query's window,
   // level, or exclusions.
   const peopleTopic=sanitizeTopic({
    ...(selectedTopic?{province:selectedTopic.province,station:selectedTopic.station}:{}),
    person_type:filters.person_type||undefined,
    district:filters.district||undefined,subdistrict:filters.subdistrict||undefined,station:filters.station||undefined,
    kind:'people_list',page,
    ...(excludeFilters.length?{exclude:excludeFilters}:{}),
   });
   const conversationOut=countOnly?conversation:{topic:peopleTopic||conversation.topic};
   respond({answer,grounded:true,dataSource:'real',toolsUsed:[{name:'supabase_people_read'}],presentation,conversation:conversationOut,meta:{fastPath:!ollamaCalls,ollamaCalls,responseTimeMs:Date.now()-start,...(countOnly?{}:{querySummary:describeQuerySpec(peopleListSpec({filters,page}))})}});
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
  if(filters.kind==='monitoring_list'||filters.level==='high'||filters.level==='watch'){
   // Same path as the chat answer: recorded monitoring, windowed when the
   // conversation carried an explicit period, with the same area filters.
   if(filters.province&&!filters.station&&!filters.district&&!filters.subdistrict&&!filters.window&&!(filters.exclude||[]).length){
    const wanted=filters.level==='all'?'risk':filters.level;
    const first=await readProvincePeople(req,{province:filters.province,personType:filters.person_type||null,level:wanted,page:1,pageSize:100});
    const people=[...first.data];
    for(let page=2;people.length<Math.min(first.total,200);page++){
     const next=await readProvincePeople(req,{province:filters.province,personType:filters.person_type||null,level:wanted,page,pageSize:100});
     if(next.total!==first.total||!next.data.length){const error=new Error('ข้อมูลเปลี่ยนระหว่างนับ');error.code='REAL_DATA_UNVERIFIABLE';throw error;}
     people.push(...next.data);
    }
    return {filters,includeCount:true,includeList:true,total:first.total,
     counts:[{label:filters.level==='high'?'เสี่ยงสูง':filters.level==='watch'?'เฝ้าระวัง':'เฝ้าระวังหรือเสี่ยงสูง',count:first.total}],
     items:people.slice(0,200).map(person=>({full_name:`${person.prefix||''}${person.first_name||''} ${person.last_name||''}`.trim(),person_type:person.person_type,level:person.risk_level==='high'?'เสี่ยงสูง':'เฝ้าระวัง',subdistrict:person.tambon||'',district:person.amphoe||''}))};
   }
   const stationIds=await monitoringStationIds(req,filters);
   const listed=await registry.listRecordedMonitoring(req,{level:filters.level,personType:filters.person_type,page:1,pageSize:200,
    ...(stationIds!==undefined?{stationIds}:{}),
    ...(filters.province?{province:filters.province}:{}),
    ...(filters.district?{district:filters.district}:{}),...(filters.subdistrict?{subdistrict:filters.subdistrict}:{}),
    ...(filters.window?{from:filters.window.from,to:filters.window.to}:{}),
    ...(filters.exclude?.length?{exclude:filters.exclude}:{})});
   return {filters,includeCount:true,includeList:true,total:listed.total,counts:[{label:filters.level==='high'?'เสี่ยงสูง':filters.level==='watch'?'เฝ้าระวัง':'เฝ้าระวังหรือเสี่ยงสูง',count:listed.total}],items:listed.items.map(item=>({full_name:item.full_name,person_type:filters.person_type||'',level:item.level,subdistrict:item.subdistrict,district:item.district}))};
  }
  // A window on a plain people report can never be honored (no registration
  // date is readable), so refuse rather than silently drop the condition.
  if(filters.window){
   const error=new Error('รายงานทะเบียนทั่วไปยังกรองตามช่วงเวลาไม่ได้ จึงไม่สร้างไฟล์ที่เงื่อนไขหายไป');
   error.code='REPORT_CONDITION_UNSUPPORTED';
   throw error;
  }
  const found=await collectPeople(req,{person_type:filters.person_type,province:filters.province,district:filters.district,subdistrict:filters.subdistrict,query:filters.search,station:filters.station,exclude:filters.exclude},200);
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
 router.post('/reports/visit-plan.pdf',async(req,res)=>{
  try{
   const input=req.body?.reportRequest;
   if(!input||input.report_kind!=='visit_plan')return res.status(400).json({error:'คำขอรายงานไม่ถูกต้อง',code:'REPORT_FAILED'});
   const station=typeof input.station==='string'?input.station:null;
   const province=typeof input.province==='string'?input.province:null;
   if(!station||!province)return res.status(400).json({error:'กรุณาระบุ สภ. และจังหวัด',code:'REPORT_FAILED'});
   const first=await readVisitPlan(req,{station,province,page:1,pageSize:100});
   if(first.status!=='ok')return res.status(422).json({error:'ไม่พบ สภ. สำหรับรายงานนี้',code:'REPORT_FAILED'});
   if(first.totalDue>10000)return res.status(422).json({error:'รายการมากเกินขนาดรายงาน กรุณาติดต่อผู้ดูแลระบบ',code:'REPORT_TOO_LARGE'});
   const items=[...first.items];
   for(let page=2;items.length<first.totalDue;page++){
    const next=await readVisitPlan(req,{station:first.station.station_name,province:first.station.province,page,pageSize:100});
    if(next.status!=='ok'||next.station.station_id!==first.station.station_id||next.totalDue!==first.totalDue||next.asOf!==first.asOf||!next.items.length){
     const error=new Error('ข้อมูลเปลี่ยนระหว่างจัดทำรายงาน');error.code='REAL_DATA_UNVERIFIABLE';throw error;
    }
    items.push(...next.items);
   }
   if(items.length!==first.totalDue||new Set(items.map(item=>item.person_id)).size!==items.length){
    const error=new Error('ข้อมูลเปลี่ยนระหว่างจัดทำรายงาน');error.code='REAL_DATA_UNVERIFIABLE';throw error;
   }
   const report=await writeVisitPlanPdf({...first,items});
   return sendReportFile(res,report,'thanipitak-visit-plan.pdf');
  }catch(e){return sendRealFailure(res,e);}
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
