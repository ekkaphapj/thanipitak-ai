'use strict';

// Knowledge-only RAG.  It deliberately contains no registry rows, SQL, credentials,
// PINs, identifiers, phones, or writable operations.
const MODEL = process.env.RAG_EMBEDDING_MODEL || 'qwen3-embedding:0.6b';
const DOCS = [
  { id:'about', text:'ธานีพิทักษ์เป็นผู้ช่วย AI ภายในสำหรับค้นหา สรุป และจัดทำรายงานจากทะเบียนบุคคลตามสิทธิ์ของผู้ใช้ ระบบอ่านข้อมูลได้เท่านั้นและไม่ใช่ระบบตัดสินใจหรือวินิจฉัยบุคคล.' },
  { id:'history', text:'ระบบธานีพิทักษ์อยู่ระหว่างทดลองใช้แบบ pilot เชื่อมการเข้าสู่ระบบและการอ่านทะเบียนจริงแบบ read-only ผ่าน Supabase ควบคู่กับฐานข้อมูลทดสอบ SQLite การแสดงผลแยกชัดเจนว่าเป็นข้อมูลทดสอบหรือข้อมูลจริง และไม่ควรอ้างว่าเป็นระบบพร้อมเผยแพร่ทั่วไป.' },
  { id:'developer', text:'โครงการ source code Thanipithak AI ดูแลใน GitHub repository ekkaphapj/thanipitak-ai โดยผู้จัดทำและผู้ดูแลที่ระบุในประวัติ repository คือ Ekkaphap (บัญชี ekkaphapj). ฐานความรู้นี้ไม่มีข้อมูลตำแหน่งงานหรือชื่อทางราชการที่ยืนยันแล้ว จึงห้ามเดารายละเอียดเพิ่มเติม.' },
  { id:'coverage', text:'พื้นที่นำร่องและระบบต้นทางเกี่ยวข้องกับจังหวัดอุดรธานี ผ่านโครงการ udonpolice-datacenter การตอบข้อมูลทะเบียนจริงยังถูกจำกัดตาม สภ. ของบัญชีผู้ใช้ จึงไม่ใช่สิทธิ์ดูข้อมูลทั้งจังหวัดโดยอัตโนมัติ.' },
  { id:'usage', text:'การใช้งานหลักคือเข้าสู่ระบบ เลือกข้อมูลทดสอบหรือข้อมูลจริง แล้วถามเป็นภาษาพูดเพื่อดูจำนวน รายชื่อ ภาพรวม จัดอันดับพื้นที่ หรือรายละเอียดของบุคคลที่เลือกไว้ สามารถขอ PDF หรือ Excel ต่อจากรายการหรือภาพรวมล่าสุด โดยต้องยืนยันเมื่อบริบทไม่ชัดเจน.' },
  { id:'voice', text:'ระบบเสียงของธานีพิทักษ์เป็นแบบกดค้างเพื่อพูด เสียงถูกส่งผ่าน backend ที่ยืนยันตัวตนไปยังระบบแปลงเสียงภายในเครื่อง แล้ววางข้อความลงในช่องพิมพ์เพื่อให้ผู้ใช้ตรวจและแก้ไขก่อนกดส่ง ระบบไม่ส่งเสียงไปยัง Ollama หรือบริการคลาวด์ และหากฟังไม่ชัดจะขอให้พูดใหม่.' },
  { id:'people', text:'ทะเบียนบุคคล people เก็บข้อมูลพื้นฐานและพื้นที่ จังหวัด อำเภอ ตำบล สภ. ประเภทบุคคลเชื่อม people_type. ห้ามตอบหรือค้นหาเลขบัตร เบอร์โทร ที่อยู่ละเอียด หรือ PIN.' },
  { id:'monitor', text:'สถานะเฝ้าระวังและเสี่ยงสูงต้องอ้างอิงผลเยี่ยมล่าสุดและรายงานผู้ดูแลที่บันทึกไว้ ไม่ใช่การวินิจฉัยหรือการทำนาย.' },
  { id:'scope', text:'ข้อมูลจริงเป็นแบบอ่านอย่างเดียวและบังคับขอบเขต สภ. จากบัญชีที่เข้าสู่ระบบ ผู้ใช้ที่มี station_id ห้ามเห็นข้อมูล สภ. อื่นแม้เป็น admin.' },
  { id:'report', text:'รายงาน PDF และ Excel สร้างจากรายการหรือภาพรวมที่ยืนยันแล้ว ไม่รวมเลขบัตรประชาชน เบอร์โทร หรือข้อมูลอ่อนไหว.' },
  { id:'types', text:'ประเภทบุคคลที่ระบบรองรับคือ ผู้ป่วยจิตเวช ผู้เสพ ผู้ค้า และผู้พ้นโทษ. คำว่า ผู้ป่วย หรือ คนไข้ หมายถึงผู้ป่วยจิตเวชเมื่อไม่มีบริบทอื่น.' },
];
const ABOUT_RE = /(?:ธานีพิทักษ์|ระบบนี้|ผู้ช่วย\s*AI|ทำอะไรได้|คืออะไร)/u;
const BUILDER_RE = /(?:ใคร(?:เป็นคน)?(?:ทำ|สร้าง|พัฒนา|เพิ่ม)|ผู้(?:พัฒนา|จัดทำ|สร้าง))/u;

// Product identity and maintainer information are source-controlled facts.
// Keep these deterministic so the model cannot turn a repository account into
// an unverified title, role, or personal detail.
function directAnswer(query) {
  const text = String(query || '').replace(/\s+/g, ' ').trim();
  if (BUILDER_RE.test(text)) {
    return {
      answer: 'หากหมายถึงผู้พัฒนาหรือผู้เพิ่มระบบธานีพิทักษ์: ฐานความรู้ระบุผู้จัดทำและผู้ดูแล repository ว่า Ekkaphap (บัญชี GitHub: ekkaphapj) แต่ไม่มีข้อมูลตำแหน่งงานหรือรายละเอียดเพิ่มเติมที่ยืนยันแล้วครับ หากหมายถึงบุคคลในทะเบียน กรุณาระบุชื่อหรือเงื่อนไขค้นหาเพิ่ม',
      sources: ['developer'],
    };
  }
  if (ABOUT_RE.test(text)) {
    return {
      answer: 'ธานีพิทักษ์เป็นผู้ช่วย AI ภายในสำหรับค้นหา สรุป และจัดทำรายงานจากทะเบียนบุคคล โดยอ่านข้อมูลได้เฉพาะในขอบเขตสิทธิ์ของบัญชีผู้ใช้ ใช้งานในลักษณะ pilot ที่เกี่ยวข้องกับจังหวัดอุดรธานี และไม่ใช้เพื่อตัดสินใจหรือวินิจฉัยบุคคลครับ',
      sources: ['about','coverage'],
    };
  }
  return null;
}
function cosine(a,b){let dot=0,aa=0,bb=0;for(let i=0;i<Math.min(a.length,b.length);i++){dot+=a[i]*b[i];aa+=a[i]*a[i];bb+=b[i]*b[i];}return dot/(Math.sqrt(aa)*Math.sqrt(bb)||1);}
function keywords(text){return new Set(String(text).toLowerCase().match(/[\p{L}\p{N}]{2,}/gu)||[]);}
function lexical(query){const q=keywords(query);return DOCS.map(doc=>{const d=keywords(doc.text);let n=0;for(const x of q)if(d.has(x))n++;return {doc,score:n/Math.max(q.size,1)};}).filter(x=>x.score>0).sort((a,b)=>b.score-a.score).slice(0,3);}
async function retrieve(query, request){
  const fallback=lexical(query); if(!request)return fallback;
  try { const out=await request('/api/embed',{model:MODEL,input:[query,...DOCS.map(d=>d.text)]});const vectors=out.embeddings||[];if(vectors.length!==DOCS.length+1)return fallback;
    return DOCS.map((doc,i)=>({doc,score:cosine(vectors[0],vectors[i+1])})).filter(x=>x.score>=0.35).sort((a,b)=>b.score-a.score).slice(0,3);
  } catch { return fallback; }
}
async function answer(query, request, model){
  const direct=directAnswer(query);if(direct)return direct;
  const hits=await retrieve(query,request);if(!hits.length)return null;const sources=hits.map(x=>x.doc.text).join('\n\n');const out=await request('/api/chat',{model,messages:[{role:'system',content:'ตอบภาษาไทยจากความรู้ที่ให้เท่านั้น ถ้าไม่มีคำตอบให้บอกว่าไม่พบในคู่มือ ห้ามให้ SQL ห้ามอ้างข้อมูลบุคคลจริง ห้ามเดาหรือแนะนำให้ข้ามสิทธิ์.'},{role:'user',content:`คำถาม: ${query}\n\nความรู้:\n${sources}`}],stream:false,think:false,options:{temperature:0,num_predict:220}});return out?.message?.content?{answer:out.message.content,sources:hits.map(x=>x.doc.id)}:null;
}
module.exports={answer,retrieve,directAnswer,DOCS,MODEL};
