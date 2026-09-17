const express=require('express');
const {detectFastPathIntent}=require('../ai/fastPath');
const {parseSummaryIntent}=require('../services/summaryService');
function createRealDataRoutes(authenticate,{url=require('../realConfig').url,key=require('../realConfig').key,request=fetch}={}) {
 const router=express.Router();router.use(authenticate);
 async function rows(req,table,params) {
  const response=await request(`${url}/rest/v1/${table}?${params}`,{headers:{apikey:key,Authorization:`Bearer ${req.realToken}`,Prefer:'count=exact'},signal:AbortSignal.timeout(15000)});
  if(!response.ok) throw new Error('ไม่สามารถอ่านข้อมูลจริงตามสิทธิ์ผู้ใช้ได้');
  const data=await response.json();
  const count=response.headers.get('content-range')?.split('/')[1];
  if(!Array.isArray(data)|| !/^\d+$/.test(count||''))throw new Error('ฐานข้อมูลไม่ส่งจำนวนข้อมูลที่ตรวจสอบได้');
  return {data,total:Number(count)};
 }
 async function search(req,filters={},page=1) {
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
   const terms={psychiatric:'จิตเวช',drug_user:'ผู้เสพ',dealer:'ผู้ค้า',released:'พ้นโทษ'};
   if(!terms[filters.person_type])throw new Error('ประเภทบุคคลไม่ถูกต้อง');
   const types=await rows(req,'people_type',new URLSearchParams({select:'type_id',type_name:`ilike.*${terms[filters.person_type]}*`,limit:'1000'}));
   if(!types.data.length)return {data:[],total:0};
   p.set('type_id',`in.(${types.data.map(t=>t.type_id).join(',')})`);
  }
  return rows(req,'people',p);
 }
 router.get('/ai/status',(req,res)=>res.json({available:true,model:'ข้อมูลจริง • อ่านจาก Supabase'}));
 router.post('/ai/chat',async(req,res)=>{
  const start=Date.now();const message=req.body?.message;
  if(typeof message!=='string'||!message.trim()||message.length>2000)return res.status(400).json({error:'คำถามไม่ถูกต้อง'});
  // Never substitute fixture risk rules or selected-person data for real records.
  if(req.body.context?.personId || /เสี่ยง|เฝ้าระวัง|จับตา|ประวัติ|เยี่ยม|ปัสสาวะ|เพราะ|ทำไม/.test(message))return res.json({answer:'โหมดข้อมูลจริงยังรองรับเฉพาะจำนวนและรายชื่อจากทะเบียน การตรวจสถานะเฝ้าระวังและประวัติอยู่ระหว่างเชื่อมต่อ',grounded:false,dataSource:'real'});
  const summary=parseSummaryIntent(message);const intent=detectFastPathIntent(message);
  if((!summary&&!intent)||summary?.intent==='summary_choices'||intent?.intent==='search_incomplete')return res.json({answer:'กรุณาระบุคำค้น เช่น “ขอรายชื่อผู้ป่วยจิตเวช” หรือ “มีทั้งหมดกี่คน”',grounded:false,dataSource:'real'});
  try {
   const filters={...(summary?.filters||intent?.filters||{})};
   for(const type of ['psychiatric','drug_user','dealer','released'])if(intent?.intent.endsWith('_'+type))filters.person_type=type;
   const page=intent?.page||1;const result=await search(req,filters,page);
   const countOnly=!summary?.includeList&&(/กี่|จำนวน/.test(message));
   const answer=`ข้อมูลจริง: พบ ${result.total} คนตามสิทธิ์และเงื่อนไขที่ค้นหา`+(countOnly?'':`\nแสดงหน้า ${page} (${result.data.length} คน)\n`+result.data.map((p,i)=>`${(page-1)*20+i+1}. ${p.first_name} ${p.last_name||''} — ${p.tambon||'ไม่ระบุตำบล'}`).join('\n'));
   res.json({answer,grounded:true,dataSource:'real',toolsUsed:[{name:'supabase_people_read'}],meta:{fastPath:true,ollamaCalls:0,responseTimeMs:Date.now()-start}});
  }catch(e){res.status(502).json({error:e.message});}
 });
 router.use((req,res)=>res.status(409).json({error:'ฟังก์ชันนี้ยังไม่เปิดใช้กับข้อมูลจริง',code:'REAL_FEATURE_UNAVAILABLE'}));
 return router;
}
module.exports={createRealDataRoutes};
