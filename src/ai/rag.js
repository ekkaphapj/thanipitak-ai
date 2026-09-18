'use strict';

// Knowledge-only RAG.  It deliberately contains no registry rows, SQL, credentials,
// PINs, identifiers, phones, or writable operations.
const MODEL = process.env.RAG_EMBEDDING_MODEL || 'qwen3-embedding:0.6b';
const DOCS = [
  { id:'about', text:'ธานีพิทักษ์เป็นระบบจัดการบุคคลเป้าหมายอัจฉริยะและผู้ช่วย AI ภายใน สำหรับค้นหา สรุป และจัดทำรายงานจากทะเบียนตามสิทธิ์ของผู้ใช้ ระบบอ่านข้อมูลได้เท่านั้นและไม่ใช่ระบบตัดสินใจหรือวินิจฉัยบุคคล.' },
  { id:'target-groups', text:'ระบบธานีพิทักษ์รองรับการจัดการบุคคลเป้าหมาย 5 กลุ่ม คือ 1 ผู้ป่วยจิตเวชยาเสพติดและผู้ป่วยจิตเวชอื่น ๆ 2 ผู้เสพ 3 ผู้ค้า 4 บุคคลพ้นโทษ และ 5 บุคคลเป้าหมายอื่น ๆ ปัจจุบันคำสั่งค้นหา AI ที่กำหนดเป็นมาตรฐานรองรับ 4 ประเภทแรก; หากถามกลุ่มอื่นให้ตรวจสอบข้อมูลและสิทธิ์ก่อนตอบ.' },
  { id:'history', text:'ระบบธานีพิทักษ์พัฒนาขึ้นครั้งแรกเพื่อใช้งานในตำรวจภูธรจังหวัดอุดรธานี ในสมัย พล.ต.ท.สันติ ชัยนิรามัย เป็น ผบช.ภ.4 และ พล.ต.ต.ธวัชชัย ถุงเป้า เป็น ผบก.ภ.จว.อุดรธานี ณ ขณะนั้น เริ่มพัฒนาและใช้งานครั้งแรกประมาณเดือนกุมภาพันธ์ 2569 โดยยึดหลักใช้งานง่าย ยืดหยุ่นตามความต้องการผู้ใช้ และไม่เป็นภาระทางงบประมาณ.' },
  { id:'developer', text:'ผู้พัฒนาระบบธานีพิทักษ์คือ พ.ต.ท.ดร.เอกภาพ จุลโนนยาง ในตำแหน่ง สว.อก.สภ.บ้านดุง ณ ช่วงเวลาที่เริ่มพัฒนา โครงการ source code ดูแลใน GitHub repository ekkaphapj/thanipitak-ai ห้ามเดาตำแหน่งหรือข้อมูลส่วนบุคคลนอกเหนือจากข้อมูลนี้.' },
  { id:'coverage', text:'ธานีพิทักษ์เริ่มใช้งานครั้งแรกที่ ภ.จว.อุดรธานี ต่อมาที่ สภ.ท่าอุเทน ในสมัย พ.ต.อ.ประลอง พรหมศร เป็น ผกก.สภ.ท่าอุเทน ณ ขณะนั้น และ ภ.จว.ร้อยเอ็ดได้นำไปใช้ทั้งจังหวัดจนได้ผลเป็นที่น่าพอใจ การตอบข้อมูลทะเบียนจริงยังถูกจำกัดตาม สภ. ของบัญชีผู้ใช้ จึงไม่ใช่สิทธิ์ดูข้อมูลทั้งจังหวัดโดยอัตโนมัติ.' },
  { id:'benefits', text:'จุดเด่นของธานีพิทักษ์คือรองรับการทำงานของเจ้าหน้าที่หน่วยนอก ทำให้ทำงานร่วมกับตำรวจ ลดภาระงานเจ้าหน้าที่ตำรวจ ส่งเสริมความร่วมมือ และช่วยให้การแก้ปัญหาในชุมชนมีประสิทธิภาพมากขึ้น.' },
  { id:'integration', text:'ธานีพิทักษ์สามารถเชื่อมต่อกับระบบ Shield+ เพื่อสนับสนุนการป้องกันและปราบปรามเหตุที่เกี่ยวข้องกับบุคคลเป้าหมาย การเชื่อมต่อไม่ขยายสิทธิ์การอ่านข้อมูล: สิทธิ์และขอบเขต สภ. ยังบังคับที่ระบบต้นทาง.' },
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
      answer: 'หากหมายถึงผู้พัฒนาระบบธานีพิทักษ์: คือ พ.ต.ท.ดร.เอกภาพ จุลโนนยาง ซึ่งเป็น สว.อก.สภ.บ้านดุง ณ ช่วงเวลาที่เริ่มพัฒนาระบบครับ หากหมายถึงบุคคลในทะเบียน กรุณาระบุชื่อหรือเงื่อนไขค้นหาเพิ่ม',
      sources: ['developer'],
    };
  }
  if (ABOUT_RE.test(text)) {
    return {
      answer: 'ธานีพิทักษ์เป็นระบบจัดการบุคคลเป้าหมายอัจฉริยะ พร้อมผู้ช่วย AI สำหรับค้นหา สรุป และจัดทำรายงานจากทะเบียนตามสิทธิ์ของผู้ใช้ เริ่มใช้ที่ ภ.จว.อุดรธานี และไม่ใช้เพื่อตัดสินใจหรือวินิจฉัยบุคคลครับ',
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
