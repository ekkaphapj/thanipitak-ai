'use strict';
const {resolvePersonByName,stripEndParticles,normalizeCollapse}=require('./personNameResolver');
const {detectLocationGroup}=require('./spokenGeo');
const {extractTimeWindow,hasHardTimeReference}=require('./timeWindow');
const TYPE_LABELS={psychiatric:'จิตเวช',drug_user:'ผู้เสพ',dealer:'ผู้ค้า',released:'ผู้พ้นโทษ'};
const SOURCE_LABELS={visits:'ผลเยี่ยม',guardian_reports:'รายงานผู้ดูแล',people_type:'ทะเบียนประเภทบุคคล',dealer_profiles:'ทะเบียนผู้ค้า',sticky_alert:'สถานะแจ้งเตือนค้าง'};
const LOCATION_BOUNDARY='(?=\\s*(?:ใน?จังหวัด|จังหวัด|จ\\.|สภ\\.?|สถานี|อำเภอ|เขต|ตำบล|ผู้ป่วย|จิตเวช|ผู้เสพ|ผู้ค้า|ผู้พ้นโทษ|เสี่ยงสูง|เฝ้าระวัง|ที่(?:เสี่ยง|ต้อง|มี)|มีใคร|ใครบ้าง|เพราะ|$))';
function extractLocation(text, labels) {
  const escaped=labels.map(label=>label.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|');
  const match=text.match(new RegExp(`(?:ใน)?(?:${escaped})\\s*([^,]+?)${LOCATION_BOUNDARY}`,'u'));
  const value=match?.[1]?.trim();
  return !value || /^(?:ไหน|ใด|อะไร)$/u.test(value) ? null : value;
}
function displayLocation(label,name) { return String(name||'').startsWith(label) ? name : `${label}${name}`; }
function detectMonitoringIntent(message) {
  const text=normalizeCollapse(message);
  if(!/(เฝ้า\s*ระวัง|เฝ้าดู|จับตา|เสี่ยง\s*สูง|ความเสี่ยงสูง|กลุ่มเสี่ยง|ติดตามเร่งด่วน|ดูแลเป็นพิเศษ|น่าเป็นห่วง|high[ -]?risk|most\s*wanted)/i.test(text))return null;
  if(/ไม่(?:ต้อง)?เฝ้าระวัง|ไม่เสี่ยงสูง|ย้อนหลัง/.test(text))return {unsupported:true};
  // A parseable period turns into an explicit recorded-visit window; a period
  // wording we cannot resolve must stay unsupported rather than broaden the
  // question to "all time".
  const timeWindow=extractTimeWindow(text);
  if(!timeWindow&&hasHardTimeReference(text))return {unsupported:true};
  const categories=[];
  if(/จิตเวช|ผู้ป่วย/.test(text))categories.push('psychiatric');
  if(/ผู้เสพ|คนเสพ|ผู้ใช้ยาเสพติด/.test(text))categories.push('drug_user');
  if(/ผู้ค้า|คนค้า|ผู้จำหน่าย/.test(text))categories.push('dealer');
  if(/พ้นโทษ|ออกจากเรือนจำ/.test(text))categories.push('released');
  const high=/เสี่ยง\s*สูง|ความเสี่ยงสูง|high[ -]?risk/i.test(text),watch=/เฝ้า\s*ระวัง|เฝ้าดู|จับตา/.test(text);
  // Words such as "จับตา" and "เฝ้าดู" can ask for the whole monitored
  // cohort, as covered by the existing Thai routing contract.  Treat only an
  // explicit "เฝ้าระวัง" level request as the watch-only filter; exact
  // follow-up level switches are handled deterministically by the route.
  const explicitWatch=/(?:^|\s)(?:กลุ่ม\s*)?เฝ้า\s*ระวัง(?:\s|$)|เฉพาะ\s*(?:กลุ่ม\s*)?เฝ้า\s*ระวัง/u.test(text);
  const level=high&&!watch?'high':watch&&!high&&explicitWatch?'watch':'all';
  const selected=/คนนี้|บุคคลนี้|รายนี้/.test(text);
  const group_by=detectLocationGroup(text);
  const province=group_by==='province'?null:extractLocation(text,['ในจังหวัด','จังหวัด','จ.']);
  const station=group_by==='station'?null:extractLocation(text,['สภ.','สภ','สถานี']);
  const district=group_by==='district'?null:extractLocation(text,['อำเภอ','เขต']);
  const subdistrict=group_by==='subdistrict'?null:extractLocation(text,['ตำบล']);
  const count=/กี่คน|จำนวน|สรุปยอด|แยก.*ประเภท/.test(text) && !/รายชื่อ|ใครบ้าง|คนไหน|เพราะ|เหตุผล|ทำไม/.test(text);
  const page=Number(text.match(/หน้า\s*(\d+)/)?.[1]||1);
  let name=null;
  if(!selected && !categories.length && !/ใคร|คนไหน|รายชื่อ|จำนวน|กี่คน|ในพื้นที่|ทั้งหมด|ทุกสถานี|ทั้งระบบ|กลุ่มเสี่ยง/.test(text)) {
    const core=stripEndParticles(text).replace(/^(?:ช่วย|กรุณา|รบกวน)\s*/,'');
    const m=core.match(/^ทำไม\s*(.+?)\s*(?:ถึง|จึง)?(?:ต้อง)?(?:เฝ้าระวัง|เสี่ยงสูง)/) || core.match(/^(.+?)\s*(?:มีความ)?(?:เสี่ยงสูง|ต้องเฝ้าระวัง|เฝ้าระวัง)(?:เพราะอะไร|เพราะเหตุใด|อย่างไร|ไหม|หรือไม่)?$/);
    if(m && m[1].trim() && !/^(?:มี|คน|บุคคล|ผู้ใด|ระดับ)/.test(m[1].trim()))name=m[1].trim();
  }
  return {level,person_types:categories,selected,count,page,name,group_by,province,station,district,subdistrict,
    ...(timeWindow?{timeWindow}:{}),
    psychiatric_subtype:/จิตเวชยาเสพติด/.test(text)?'drug':/จิตเวชอื่น/.test(text)?'other':undefined,
    most_wanted:/most\s*wanted/i.test(text)?true:undefined};
}
function isSelectedMonitoringReasonFollowup(message) {
  const text=stripEndParticles(normalizeCollapse(message))
    .replace(/^(?:ช่วย|กรุณา|รบกวน)\s*/,'')
    .trim();
  return /^(?:ทำไม|เพราะอะไร|เพราะเหตุใด|ด้วยเหตุใด|เหตุผล(?:คืออะไร)?|อธิบายเหตุผล)$/.test(text);
}
function renderMonitoring(data,{count=false,group_by:groupBy}={}) {
  if(data.error)return 'ไม่สามารถตรวจสอบข้อมูลเฝ้าระวังได้ในขณะนี้';
  if(data.personFound===false)return 'ไม่พบบุคคลนี้ในพื้นที่ที่ท่านมีสิทธิ์เข้าถึง';
  if(data.configured===false)return 'ฐานข้อมูลชุดนี้ยังไม่มีทะเบียนและบันทึกเฝ้าระวังแบบใหม่ กรุณาใช้ชุดข้อมูลจำลอง production-shaped';
  if(!data.total)return 'ไม่พบบุคคลที่ตรงเกณฑ์จากบันทึกปัจจุบันในพื้นที่ที่ท่านมีสิทธิ์เข้าถึง (ไม่ได้หมายความว่ายืนยันว่าไม่มีความเสี่ยง)';
  if (groupBy) {
    const label={province:'จังหวัด',station:'สภ.',district:'อำเภอ',subdistrict:'ตำบล'}[groupBy]||'พื้นที่';
    const locations=data.locationSummary||[];
    return `พบ ${data.total} คนตามเกณฑ์ที่ถาม ใน ${locations.length} ${label}\n`
      +locations.map((item,index)=>`${index+1}. ${displayLocation(label,item.name)} — ${item.count} คน`).join('\n')
      +'\nหากต้องการรายชื่อในพื้นที่ใด ให้พิมพ์ชื่อพื้นที่นั้นต่อได้';
  }
  const header=`พบ ${data.total} คนตามเกณฑ์ที่ถามในพื้นที่ที่ท่านมีสิทธิ์เข้าถึง ณ ${data.asOf}`;
  if(count)return header+'\n'+Object.entries(data.byType).map(([type,n])=>`${TYPE_LABELS[type]||type} ${n} คน`).join(' • ');
  return header+` (แสดงหน้า ${data.page}, ${data.items.length} คน)\n`+data.items.map(p=>`${p.displayName} — ${p.typeName} — ${p.level}\n`+p.reasons.map(r=>`  • ${r.reason} [${SOURCE_LABELS[r.source]||r.source}${r.recordId?' #'+r.recordId:''}, ${r.date}]`).join('\n')).join('\n')+'\nระดับนี้อ้างอิงทะเบียนและบันทึก ไม่ใช่การวินิจฉัยหรือการทำนายพฤติกรรม';
}
async function runMonitoring(intent,context,router,user,onToolCall) {
  if(intent.unsupported)return {answer:'ขณะนี้ตรวจได้เฉพาะสถานะเฝ้าระวัง/เสี่ยงสูงปัจจุบัน คำถามช่วงเวลาที่ระบุไม่ชัดยังไม่รองรับ กรุณาระบุประเภทบุคคลและระดับที่ต้องการ เช่น ใครเสี่ยงสูงเดือนนี้',toolsUsed:[],grounded:false};
  // The fixture/test pipeline has no windowed monitoring operation yet; fail
  // explicitly instead of silently answering the all-time question.
  if(intent.timeWindow)return {answer:`โหมดทดสอบยังไม่รองรับการกรองเฝ้าระวัง/เสี่ยงสูงตามช่วงเวลา (${intent.timeWindow.label}) ฟีเจอร์นี้ใช้ได้กับข้อมูลจริงที่บันทึกวันที่เยี่ยมไว้`,toolsUsed:[],grounded:false};
  let personId;
  if(intent.selected) {
    const value=Number(context?.personId);
    if(!Number.isSafeInteger(value)||value<=0)return {answer:'กรุณาเลือกบุคคลหรือระบุชื่อและนามสกุลก่อนถามเหตุผลรายบุคคล',toolsUsed:[],grounded:false};
    personId=value;
  }
  const toolsUsed=[];
  if(intent.name) {
    const resolved=await resolvePersonByName(intent.name,router,user);
    for(const c of resolved.toolCalls||[])onToolCall?.({...c,userId:user.id,username:user.username});
    toolsUsed.push('search_persons');
    if(resolved.resolution==='not_found')return {answer:'ไม่พบบุคคลชื่อนี้ในพื้นที่ที่ท่านมีสิทธิ์เข้าถึง',toolsUsed,grounded:true};
    if(resolved.resolution==='ambiguous')return {answer:'พบชื่อซ้ำ กรุณาเลือกบุคคลก่อนดูเหตุผล',toolsUsed,grounded:true,presentation:{type:'person_candidates',candidates:resolved.candidates,total:resolved.totalCandidates}};
    personId=resolved.person.id;
  }
  const args={level:personId?'all':intent.level,person_types:intent.person_types,page:intent.page,
    ...(intent.psychiatric_subtype?{psychiatric_subtype:intent.psychiatric_subtype}:{}),
    ...(intent.most_wanted?{most_wanted:true}:{}),
    ...(intent.province&&!personId?{province:intent.province}:{}),...(intent.station&&!personId?{station:intent.station}:{}),
    ...(intent.district&&!personId?{district:intent.district}:{}),...(intent.subdistrict&&!personId?{subdistrict:intent.subdistrict}:{}),
    ...(intent.group_by&&!personId?{group_by:intent.group_by}:{}),...(personId?{person_id:personId}:{})};
  onToolCall?.({toolName:'get_monitoring_persons',toolArgs:args,userId:user.id,username:user.username});
  const data=await router.execute('get_monitoring_persons',args,user);
  return {answer:renderMonitoring(data,intent),toolsUsed:[...toolsUsed,'get_monitoring_persons'],grounded:!data.error,
    presentation:!data.error?{type:intent.group_by&&!personId?'monitoring_location_summary':'monitoring_list',...data,filters:args}:undefined};
}
module.exports={detectMonitoringIntent,isSelectedMonitoringReasonFollowup,runMonitoring,renderMonitoring,detectLocationGroup};
