'use strict';
const bcrypt=require('bcryptjs');
const {createSimulationService}=require('../services/simulationService');
const {thaiToday}=require('../services/monitoringService');
const TYPES=[
  ['ผู้ป่วยจิตเวชยาเสพติด','psychiatric'],['ผู้ป่วยจิตเวชอื่นๆ','psychiatric'],
  ['ผู้ป่วยจิตเวชยาเสพติด (Most Wanted)','psychiatric'],['ผู้ป่วยจิตเวชอื่นๆ (Most Wanted)','psychiatric'],
  ['ผู้เสพ','drug_user'],['ผู้เสพ (Most Wanted)','drug_user'],['ผู้ค้า','dealer'],['ผู้ค้า (Most Wanted)','dealer'],['บุคคลพ้นโทษ','released'],
];
function seedRealisticDatabase(db,{asOf=thaiToday()}={}) {
  if(db.prepare('SELECT count(*) AS n FROM users').get().n)throw new Error('Realistic seed requires an empty database; existing data is preserved');
  const ago=n=>new Date(Date.parse(asOf+'T00:00:00Z')-n*86400000).toISOString().slice(0,10);
  const hash=bcrypt.hashSync('thanipitak123',10);
  db.prepare('INSERT INTO users(id,username,password_hash,name,role) VALUES(1,?,?,?,?)').run('admin',hash,'ผู้ดูแลข้อมูลจำลอง','admin');
  TYPES.forEach(([name,category],i)=>db.prepare('INSERT INTO people_type VALUES(?,?,?)').run(i+1,name,category));
  const scenarios=[];
  for(let station=1;station<=5;station++) {
    db.prepare('INSERT INTO stations VALUES(?,?,?,?)').run(station,`สภ.จำลอง ${station}`,`อำเภอจำลอง ${station}`,station<=3?'อุดรธานี':'ขอนแก่น');
    for(const [offset,suffix,role] of [[0,'off','officer'],[1,'view','viewer']]) db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?)').run(station*2+offset,`station${station}_${suffix}`,hash,`เจ้าหน้าที่จำลอง ${station} ${suffix}`,role,station);
    const user={id:station*2,role:'officer',stationId:station};
    const service=createSimulationService(db,{today:()=>asOf});
    const specs=[
      [1,'แดง','visit-high'],[2,'ส้ม','visit-watch'],[1,'เขียว','guardian-high'],[2,'แดง','guardian-missing'],
      [2,'เขียว','psy-normal'],[3,'ส้ม','most-wanted'],[5,null,'drug-watch'],[5,null,'drug-normal'],
      [7,null,'dealer-missing'],[8,null,'dealer-prison'],[9,null,'released-high'],[9,null,'released-watch'],
      [9,null,'released-normal'],[1,'แดง','deceased'],[5,null,'drug-old-positive'],[2,'เขียว','no-visits'],
    ];
    specs.forEach(([type,color,scenario],index)=>{
      const id=(station-1)*specs.length+index+1;
      db.prepare('INSERT INTO people(id,synthetic_code,first_name,last_name,type_id,station_id,province,amphoe,tambon,status,custody_status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,`SIM-${station}-${index+1}`,`ทดสอบ${index+1}`,`สถานี${station}`,type,station,station<=3?'อุดรธานี':'ขอนแก่น',`อำเภอจำลอง ${station}`,'ตำบลจำลอง',color,scenario==='deceased'?'เสียชีวิต':null,ago(180),asOf);
      scenarios.push({id,station,scenario});
      const visit=(status,days=2)=>service.recordVisit(user,id,{date:ago(days),status,note:`บันทึกสังเคราะห์สำหรับสถานการณ์ ${scenario} ไม่ใช่ข้อมูลบุคคลจริง`});
      if(scenario==='visit-high')visit('เสี่ยงสูง');
      if(scenario==='visit-watch')visit('เฝ้าระวัง');
      if(scenario==='psy-normal')visit('อาการปกติ');
      if(scenario==='drug-watch')visit('พบสารเสพติด / เฝ้าระวัง');
      if(scenario==='drug-normal')visit('ไม่พบสารเสพติด');
      if(scenario==='drug-old-positive'){visit('พบสารเสพติด / เฝ้าระวัง',30);visit('ไม่พบสารเสพติด');}
      if(scenario==='dealer-missing')visit('ยังไม่พบตัว');
      if(scenario==='dealer-prison')visit('อยู่ในเรือนจำ');
      if(scenario==='released-high')visit('เสี่ยงสูง');
      if(scenario==='released-watch')visit('เฝ้าระวัง');
      if(scenario==='released-normal')visit('ปกติ');
      if(scenario==='deceased')visit('เสียชีวิต');
      if(scenario.startsWith('guardian-')) {
        visit('อาการปกติ',10);
        db.prepare('INSERT INTO guardian_patient_links(person_id,created_at) VALUES(?,?)').run(id,ago(10));
        db.prepare('INSERT INTO person_report_status(person_id,updated_at) VALUES(?,?)').run(id,asOf);
        service.recordGuardianReport(user,id,{date:scenario==='guardian-missing'?ago(4):asOf,met_patient:'พบตัว',medication:scenario==='guardian-high'?'ไม่ได้กิน':'ครบ',symptoms:scenario==='guardian-high'?['มีอาการผิดปกติตามรายงานจำลอง']:[],risk_behaviors:[]});
      }
    });
  }
  db.prepare('INSERT INTO fixture_metadata VALUES(?,?)').run('profile','production-shaped-v1');
  db.prepare('INSERT INTO fixture_metadata VALUES(?,?)').run('as_of',asOf);
  return {persons:80,stations:5,users:11,visits:db.prepare('SELECT count(*) AS n FROM visits').get().n,urineTests:db.prepare('SELECT count(*) AS n FROM urine_tests').get().n,scenarios,asOf};
}
module.exports={seedRealisticDatabase,TYPES};
