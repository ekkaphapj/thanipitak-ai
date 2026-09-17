const express=require('express');
const {detectFastPathIntent}=require('../ai/fastPath');
const {parseSummaryIntent}=require('../services/summaryService');
function createRealDataRoutes(authenticate,{url=require('../realConfig').url,key=require('../realConfig').key,request=fetch,interpret=require('../ai/realIntent').interpretRealIntent}={}) {
 const router=express.Router();router.use(authenticate);
 async function rows(req,table,params) {
  const response=await request(`${url}/rest/v1/${table}?${params}`,{headers:{apikey:key,Authorization:`Bearer ${req.realToken}`,Prefer:'count=exact'},signal:AbortSignal.timeout(15000)});
  if(!response.ok) throw new Error('ไม่สามารถอ่านข้อมูลจริงตามสิทธิ์ผู้ใช้ได้');
  const data=await response.json();
  const count=response.headers.get('content-range')?.split('/')[1];
  if(!Array.isArray(data)|| !/^\d+$/.test(count||''))throw new Error('ฐานข้อมูลไม่ส่งจำนวนข้อมูลที่ตรวจสอบได้');
  return {data,total:Number(count)};
 }
 async function search(req,filters={},page=1,aggregate=false) {
  const p=new URLSearchParams({select:'id,first_name,last_name,station_id,province,amphoe,tambon,type_id,status',order:'first_name.asc,id.asc',limit:'20',offset:String((page-1)*20)});
  // Fail closed for stationless non-admins; RLS is also evaluated by Supabase.
  if(req.user.role!=='admin') {
   if(!Number.isSafeInteger(req.user.stationId))throw new Error('บัญชีนี้ยังไม่มีสิทธิ์สถานีสำหรับ AI');
   p.set('station_id',`eq.${req.user.stationId}`);
  }
  const clean=v=>String(v).replace(/[%*(),]/g,'').slice(0,100);
  for(const [input,column] of [['province','province'],['district','amphoe'],['subdistrict','tambon']])if(filters[input])p.set(column,`ilike.*${clean(filters[input])}*`);
  if(filters.query||filters.search)p.set('first_name',`ilike.*${clean(filters.query||filters.search)}*`);
  if(filters.status)throw new Error('การแปลสถานะทะเบียนจริงยังไม่พร้อม กรุณาค้นด้วยชื่อหรือพื้นที่');
  if(filters.station){
   const s=await rows(req,'stations',new URLSearchParams({select:'station_id',station_name:`ilike.*${clean(filters.station)}*`,limit:'1000'}));
   const ids=s.data.map(x=>x.station_id).filter(id=>req.user.role==='admin'||id===req.user.stationId);
   if(!ids.length)return {data:[],total:0};
   p.set('station_id',`in.(${ids.join(',')})`);
  }
  if(filters.person_type){
   const terms={psychiatric:'ผู้ป่วยจิตเวช',drug_user:'ผู้เสพ',dealer:'ผู้ค้า',released:'พ้นโทษ'};
   if(!terms[filters.person_type])throw new Error('ประเภทบุคคลไม่ถูกต้อง');
   const types=await rows(req,'people_type',new URLSearchParams({select:'type_id',type_name:`ilike.*${terms[filters.person_type]}*`,limit:'1000'}));
   if(!types.data.length)return {data:[],total:0};
   p.set('type_id',`in.(${types.data.map(t=>t.type_id).join(',')})`);
  }
  if (!aggregate) return rows(req,'people',p);
  p.set('select','id,province,amphoe,tambon');p.set('order','id.asc');p.set('limit','1000');
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
 router.get('/ai/status',(req,res)=>res.json({available:true,model:'ข้อมูลจริง • อ่านจาก Supabase'}));
 router.post('/ai/chat',async(req,res)=>{
  const start=Date.now();const message=req.body?.message;
  if(typeof message!=='string'||!message.trim()||message.length>2000)return res.status(400).json({error:'คำถามไม่ถูกต้อง'});
  // Never substitute fixture risk rules or selected-person data for real records.
  if(req.body.context?.personId || /เสี่ยง|เฝ้าระวัง|จับตา|ประวัติ|เยี่ยม|ปัสสาวะ|เพราะ|ทำไม/.test(message))return res.json({answer:'โหมดข้อมูลจริงยังรองรับเฉพาะจำนวนและรายชื่อจากทะเบียน การตรวจสถานะเฝ้าระวังและประวัติอยู่ระหว่างเชื่อมต่อ',grounded:false,dataSource:'real'});
  let ranking=/(ตำบล|อำเภอ|จังหวัด)(?:ไหน|ใด|อะไร).*?(มากที่สุด|เยอะที่สุด|น้อยที่สุด|มากสุด|เยอะสุด|น้อยสุด)/.exec(message);
  const ordered=/(?:ตาม|แยก(?:ตาม)?|แต่ละ)(ตำบล|อำเภอ|จังหวัด)/.exec(message);
  let showAll=!!ordered;
  if(!ranking&&ordered)ranking=[message,ordered[1],/น้อยไปมาก/.test(message)?'น้อยสุด':'มากสุด'];
  let plan=null;let ollamaCalls=0;
  const summary=parseSummaryIntent(message);const intent=detectFastPathIntent(message);
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
    const sorted=[...groups.values()].sort((a,b)=>/น้อย/.test(ranking[2])?a.count-b.count:b.count-a.count);
    const winners=showAll?sorted:sorted.filter(g=>g.count===sorted[0]?.count);
    const category={psychiatric:'ผู้ป่วยจิตเวช',drug_user:'ผู้เสพ',dealer:'ผู้ค้า',released:'ผู้พ้นโทษ'}[filters.person_type]||'บุคคล';
    const scope=req.user.stationName||'พื้นที่ที่บัญชีนี้มีสิทธิ์เข้าถึง';
    const answer=`ข้อมูลจริง • ${scope}\nนับ${category}จากทะเบียนทั้งหมด ${result.total} คน\n`+(showAll?`เรียง${/น้อย/.test(ranking[2])?'น้อยไปมาก':'มากไปน้อย'}\n`:'')+(winners.length?winners.map(g=>`${ranking[1]}${g.name} ${column==='tambon'?g.district:''} ${column!=='province'?g.province:''} มี${category}${showAll?'':ranking[2]} ${g.count} คน`).join('\n'):'ไม่พบข้อมูลพื้นที่ที่จัดอันดับได้')+(!showAll&&winners.length>1?'\nมีหลายพื้นที่จำนวนเท่ากัน':'')+(missing?`\nอีก ${missing} คนไม่ระบุ${ranking[1]} จึงไม่รวมในอันดับ`:'')+(/น้อย/.test(ranking[2])?'\nอันดับนี้รวมเฉพาะพื้นที่ที่มีบุคคลในทะเบียน':'');
    return res.json({answer,grounded:true,dataSource:'real',toolsUsed:[{name:'supabase_area_count'}],meta:{fastPath:!ollamaCalls,ollamaCalls,responseTimeMs:Date.now()-start}});
   }
   const page=intent?.page||1;const result=await search(req,filters,page);
   const countOnly=plan?plan.action==='count':!summary?.includeList&&(/กี่|จำนวน/.test(message));
   const answer=`ข้อมูลจริง: พบ ${result.total} คนตามสิทธิ์และเงื่อนไขที่ค้นหา`+(countOnly?'':`\nแสดงหน้า ${page} (${result.data.length} คน)\n`+result.data.map((p,i)=>`${(page-1)*20+i+1}. ${p.first_name} ${p.last_name||''} — ${p.tambon||'ไม่ระบุตำบล'}`).join('\n'));
   res.json({answer,grounded:true,dataSource:'real',toolsUsed:[{name:'supabase_people_read'}],meta:{fastPath:!ollamaCalls,ollamaCalls,responseTimeMs:Date.now()-start}});
  }catch(e){res.status(502).json({error:e.message});}
 });
 router.use((req,res)=>res.status(409).json({error:'ฟังก์ชันนี้ยังไม่เปิดใช้กับข้อมูลจริง',code:'REAL_FEATURE_UNAVAILABLE'}));
 return router;
}
module.exports={createRealDataRoutes};
