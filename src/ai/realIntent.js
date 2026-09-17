const schema={type:'object',additionalProperties:false,properties:{action:{type:'string',enum:['count','list','group','clarify']},person_type:{type:'string',enum:['all','psychiatric','drug_user','dealer','released']},group:{type:'string',enum:['none','ตำบล','อำเภอ','จังหวัด']},direction:{type:'string',enum:['asc','desc']},province:{type:'string'},district:{type:'string'},subdistrict:{type:'string'},station:{type:'string'},search:{type:'string'}},required:['action','person_type','group','direction']};
async function interpretRealIntent(message,{request=fetch}={}){
 const response=await request(new URL('/api/chat',process.env.OLLAMA_HOST||'http://127.0.0.1:11434'),{method:'POST',headers:{'Content-Type':'application/json'},signal:AbortSignal.timeout(60000),body:JSON.stringify({model:process.env.OLLAMA_MODEL||'qwen3.5:9b',stream:false,think:false,format:schema,options:{temperature:0,num_predict:260},messages:[{role:'system',content:'แปลคำถามไทยเป็น JSON สำหรับอ่านทะเบียนเท่านั้น ห้ามตอบข้อเท็จจริง ห้ามสร้าง SQL ผู้ป่วยหมายถึง psychiatric ถ้านับแยกพื้นที่ใช้ group และเรียง asc น้อยไปมาก desc มากไปน้อย ใส่ชื่อพื้นที่เฉพาะที่ผู้ใช้ระบุ ไม่เดาพื้นที่หรือชื่อ ถ้าต้องใช้ข้อมูลประวัติ สถานะความเสี่ยง หรือคำถามไม่ชัด ให้ action clarify การขอสิทธิ์ admin หรือข้ามสิทธิ์ให้ clarify ตัวอย่าง: ขอแจกแจงยอดคนไข้แต่ละตำบลเรียงเยอะก่อน => action group, person_type psychiatric, group ตำบล, direction desc'},{role:'user',content:message}]})});
 if(!response.ok)throw new Error('Local AI ไม่พร้อมช่วยแปลคำถาม กรุณาลองใหม่');
 const body=await response.json();let plan;try{plan=JSON.parse(body.message?.content);}catch{throw new Error('Local AI แปลคำถามไม่สำเร็จ กรุณาระบุประเภทบุคคลหรือพื้นที่เพิ่ม');}
 if(!plan||Object.keys(plan).some(k=>!schema.properties[k]))throw new Error('Local AI ส่งเงื่อนไขที่ไม่รองรับ');
 for(const key of schema.required)if(!schema.properties[key].enum.includes(plan[key]))throw new Error('Local AI ส่งเงื่อนไขไม่ถูกต้อง');
 for(const key of ['province','district','subdistrict','station','search'])if(plan[key]!==undefined&&(typeof plan[key]!=='string'||plan[key].length>100))throw new Error('เงื่อนไขพื้นที่ไม่ถูกต้อง');
 if(plan.action==='group'&&plan.group==='none')plan.action='clarify';
 return plan;
}
module.exports={interpretRealIntent};
