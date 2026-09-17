'use strict';
const {scopedPerson,latestVisit,refreshGuardianStatus,thaiToday}=require('./monitoringService');
const RESULTS={
  psychiatric:['อาการปกติ','เฝ้าระวัง','เสี่ยงสูง','เสียชีวิต','ออกนอกพื้นที่','ส่งบำบัด','ดำเนินคดี'],
  released:['ปกติ','เฝ้าระวัง','เสี่ยงสูง','เสียชีวิต','อยู่ในเรือนจำ','ออกนอกพื้นที่','ดำเนินคดี'],
  drug_user:['ไม่พบสารเสพติด','พบสารเสพติด / เฝ้าระวัง','พบสารเสพติด / ส่งบำบัด','พบสารเสพติด / ดำเนินคดี','ออกนอกพื้นที่ (ไปทำงาน)','ออกนอกพื้นที่ (อยู่ในเรือนจำ)','เสียชีวิต'],
  dealer:['ยังไม่พบตัว','พบตัว','ออกนอกพื้นที่','อยู่ในเรือนจำ','เสียชีวิต','ยุติบทบาท'],
};
function validDate(value,today) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value||'') || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0,10)!==value || value>today) throw new Error('INVALID_DATE');
}
function transaction(db,fn) { db.exec('BEGIN');try {const out=fn();db.exec('COMMIT');return out;}catch(e){db.exec('ROLLBACK');throw e;} }
function createSimulationService(db,{today=thaiToday}={}) {
  function personForWrite(user,id) { const p=scopedPerson(db,user,id);if(!p)throw new Error('NOT_FOUND');if(!['admin','officer'].includes(user.role))throw new Error('FORBIDDEN');return p; }
  function recordVisit(user,id,input) {
    const p=personForWrite(user,id);validDate(input.date,today());
    if(!RESULTS[p.category].includes(input.status))throw new Error('INVALID_VISIT_STATUS');
    if(input.time && !/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(input.time))throw new Error('INVALID_TIME');
    return transaction(db,()=>{
      if(p.category==='dealer') {
        db.prepare(`INSERT INTO dealer_profiles(person_id,current_status,recorded_at,reason) VALUES(?,?,?,?) ON CONFLICT(person_id) DO UPDATE SET current_status=excluded.current_status,recorded_at=excluded.recorded_at,reason=excluded.reason WHERE excluded.recorded_at>=dealer_profiles.recorded_at`).run(id,input.status,input.date,String(input.note||'').slice(0,500));
        return {personId:id};
      }
      const category=p.category==='drug_user'?'drug':p.category==='released'?'released':'general';
      const drug=category==='drug';
      const legacyResult=drug ? input.status.startsWith('พบสาร')?'warning':'normal' : ['เสี่ยงสูง','เฝ้าระวัง'].includes(input.status)?'warning':'normal';
      const info=db.prepare(`INSERT INTO visits(person_id,visit_date,result,note,officer_user_id,visit_time,visit_category,visit_status,status_condition,drug_test_result) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id,input.date,legacyResult,String(input.note||'').slice(0,500),user.id,input.time||'09:00',category,drug?null:input.status,drug?input.status:null,drug?(input.status.startsWith('พบสาร')?'พบสารเสพติด':input.status):null);
      if(drug && ['ไม่พบสารเสพติด','พบสารเสพติด / เฝ้าระวัง','พบสารเสพติด / ส่งบำบัด','พบสารเสพติด / ดำเนินคดี'].includes(input.status)) db.prepare('INSERT INTO urine_tests(person_id,test_date,result,officer_user_id) VALUES(?,?,?,?)').run(id,input.date,input.status.startsWith('พบสาร')?'positive':'negative',user.id);
      const latest=latestVisit(db,id,p.category);
      if(latest.id===Number(info.lastInsertRowid)) {
        const custody=['เสียชีวิต','อยู่ในเรือนจำ','ออกนอกพื้นที่','ส่งบำบัด','ดำเนินคดี'].includes(input.status)?input.status:input.status==='ออกนอกพื้นที่ (อยู่ในเรือนจำ)'?'อยู่ในเรือนจำ':input.status==='ออกนอกพื้นที่ (ไปทำงาน)'?'ออกนอกพื้นที่':null;
        db.prepare('UPDATE people SET custody_status=?,updated_at=? WHERE id=?').run(custody,today(),id);
        if(p.category==='psychiatric' && input.status==='อาการปกติ') db.prepare("UPDATE person_report_status SET alert_level='ปกติ',alert_source='none',since=NULL,evidence_json='[]',updated_at=? WHERE person_id=?").run(today(),id);
      }
      return {visitId:Number(info.lastInsertRowid)};
    });
  }
  function recordGuardianReport(user,id,input) {
    const p=personForWrite(user,id);if(p.category!=='psychiatric')throw new Error('GUARDIAN_PSYCHIATRIC_ONLY');validDate(input.date,today());
    if(!['พบตัว','ไม่พบตัว'].includes(input.met_patient)||!['ครบ','ขาดบางมื้อ','ไม่ได้กิน'].includes(input.medication))throw new Error('INVALID_REPORT');
    for(const key of ['symptoms','risk_behaviors'])if(!Array.isArray(input[key])||input[key].some(s=>typeof s!=='string'))throw new Error('INVALID_REPORT');
    const abnormal=Number(input.met_patient==='ไม่พบตัว')+Number(input.medication!=='ครบ')+Number(input.symptoms.length>0)+Number(input.risk_behaviors.length>0);
    return transaction(db,()=>{
      refreshGuardianStatus(db,p,today());
      db.prepare(`INSERT INTO guardian_reports(person_id,report_date,met_patient,medication,symptoms,risk_behaviors,abnormal_count) VALUES(?,?,?,?,?,?,?) ON CONFLICT(person_id,report_date) DO UPDATE SET met_patient=excluded.met_patient,medication=excluded.medication,symptoms=excluded.symptoms,risk_behaviors=excluded.risk_behaviors,abnormal_count=excluded.abnormal_count,cancelled_at=NULL`).run(id,input.date,input.met_patient,input.medication,JSON.stringify(input.symptoms),JSON.stringify(input.risk_behaviors),abnormal);
      db.prepare('INSERT OR IGNORE INTO person_report_status(person_id,updated_at) VALUES(?,?)').run(id,today());
      return refreshGuardianStatus(db,p,today());
    });
  }
  return {recordVisit,recordGuardianReport};
}
module.exports={createSimulationService,RESULTS};
