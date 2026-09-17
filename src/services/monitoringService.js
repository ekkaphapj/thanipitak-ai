'use strict';

const LEVELS = ['ปกติ', 'เฝ้าระวัง', 'เสี่ยงสูง'];
const EXCLUDED = new Set(['เสียชีวิต','เสียชีวิตแล้ว','อยู่ในเรือนจำ','ออกนอกพื้นที่','ออกนอกพื้นที่ (อยู่ในเรือนจำ)','ออกนอกพื้นที่ (ไปทำงาน)','ยุติบทบาท']);
const CATEGORIES = ['psychiatric','drug_user','dealer','released'];
function thaiToday() { return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Bangkok',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()); }
function daysBetween(from,to) { return Math.max(0,Math.floor((Date.parse(to+'T00:00:00Z')-Date.parse(from+'T00:00:00Z'))/86400000)); }
function scopedPerson(db,user,id) {
  if (!user || (user.role !== 'admin' && !Number.isInteger(user.stationId))) return null;
  return db.prepare(`SELECT p.*,t.type_name,t.category FROM people p JOIN people_type t USING(type_id)
    WHERE p.id=? ${user.role==='admin'?'':'AND p.station_id=?'}`).get(...(user.role==='admin'?[id]:[id,user.stationId]));
}
function latestVisit(db,id,category) {
  return db.prepare(`SELECT * FROM visits WHERE person_id=? AND
    ${category==='drug_user'?"visit_category='drug'":category==='released'?"visit_category='released'":"COALESCE(visit_category,'general')='general'"}
    ORDER BY visit_date DESC,COALESCE(visit_time,'') DESC,id DESC LIMIT 1`).get(id);
}

// Mirrors color thresholds + sticky alerts in the source migrations. No LLM scoring.
function refreshGuardianStatus(db, person, today, { persist = true } = {}) {
  const stored = db.prepare('SELECT * FROM person_report_status WHERE person_id=?').get(person.id);
  if (!stored || person.category!=='psychiatric') return null;
  const settings = db.prepare('SELECT * FROM guardian_report_settings WHERE color IN (?,\'*\') ORDER BY color=\'*\' LIMIT 1').get(person.status || '*');
  const links = db.prepare("SELECT * FROM guardian_patient_links WHERE person_id=? AND approval_status='approved' AND revoked_at IS NULL AND reporting_paused_at IS NULL ORDER BY created_at").all(person.id);
  const reports = db.prepare('SELECT * FROM guardian_reports WHERE person_id=? AND cancelled_at IS NULL AND report_date<=? ORDER BY report_date DESC,id DESC').all(person.id,today);
  const last = reports[0];
  const missed = links.length ? daysBetween(last?.report_date || links[0].created_at.slice(0,10),today) : 0;
  let streak=0;
  for (const r of reports) { if (!r.abnormal_count) break; streak++; }
  const maxCategories = Math.max(0,...reports.slice(0,settings.recover_after_normal_days).map(r=>r.abnormal_count));
  const missingLevel = !links.length ? 0 : missed>=settings.high_risk_after_missed_days ? 2 : missed>=settings.watch_after_missed_days ? 1 : 0;
  const abnormalLevel = !links.length || !last || missed>=settings.watch_after_missed_days ? 0
    : streak>=settings.high_risk_consecutive_abnormal || maxCategories>=settings.abnormal_high_risk_min_categories ? 2 : maxCategories>0 ? 1 : 0;
  const computed=Math.max(missingLevel,abnormalLevel), previous=LEVELS.indexOf(stored.alert_level);
  const level=Math.max(previous,computed);
  let evidence=JSON.parse(stored.evidence_json);
  let source=stored.alert_source;
  if (computed>=previous) {
    evidence=[];
    if (missingLevel) evidence.push({source:'guardian_reports',date:today,reason:`ขาดรายงานผู้ดูแล ${missed} วัน ถึงเกณฑ์${LEVELS[missingLevel]}ของสี ${person.status || 'ค่ากลาง'} (${missingLevel===2?settings.high_risk_after_missed_days:settings.watch_after_missed_days} วัน)`});
    if (abnormalLevel) {
      const evidenceReport=reports.slice(0,settings.recover_after_normal_days).find(r=>r.abnormal_count===maxCategories)||last;
      const categories=[];
      if(evidenceReport.met_patient==='ไม่พบตัว')categories.push('การพบตัว');
      if(evidenceReport.medication!=='ครบ')categories.push('การรับประทานยา');
      if(JSON.parse(evidenceReport.symptoms).length)categories.push('อาการที่ผู้ดูแลรายงาน');
      if(JSON.parse(evidenceReport.risk_behaviors).length)categories.push('พฤติกรรมที่ผู้ดูแลรายงาน');
      evidence.push({source:'guardian_reports',recordId:evidenceReport.id,date:evidenceReport.report_date,
        reason:`ผู้ดูแลรายงานผิดปกติ ${maxCategories} หมวด (${categories.join(', ')}) ในช่วง ${settings.recover_after_normal_days} รายงานล่าสุด เกณฑ์สี ${person.status || 'ค่ากลาง'} กำหนดเสี่ยงสูงเมื่อผิดปกติอย่างน้อย ${settings.abnormal_high_risk_min_categories} หมวด หรือมีรายงานผิดปกติต่อเนื่อง ${settings.high_risk_consecutive_abnormal} รายงาน`});
      if(streak>=settings.high_risk_consecutive_abnormal)evidence.push({source:'guardian_reports',recordId:last.id,date:last.report_date,reason:`พบรายงานผิดปกติต่อเนื่อง ${streak} รายงาน ถึงเกณฑ์ ${settings.high_risk_consecutive_abnormal} รายงาน`});
    }
    source=computed===0?'none':abnormalLevel>=missingLevel?'abnormal':'missing';
  } else if (level) {
    evidence=evidence.filter(e=>e.source!=='sticky_alert');
    evidence.push({source:'sticky_alert',date:today,reason:'ระดับแจ้งเตือนเดิมยังค้างอยู่ ต้องรอผลเยี่ยมปกติจากเจ้าหน้าที่ ไม่ลดระดับจากรายงานปกติเพียงอย่างเดียว'});
  }
  // Only explicit simulation writes persist status; AI reads calculate in memory.
  if (persist) db.prepare(`UPDATE person_report_status SET alert_level=?,alert_source=?,missed_days=?,last_report_date=?,since=?,updated_at=?,evidence_json=? WHERE person_id=?`)
    .run(LEVELS[level],source,missed,last?.report_date||null,level?(stored.since||today):null,today,JSON.stringify(evidence),person.id);
  return {level,evidence};
}

function classify(db,p,today) {
  const visit=latestVisit(db,p.id,p.category);
  const visitStatus = p.category==='drug_user' ? visit?.status_condition || visit?.drug_test_result : visit?.visit_status;
  const dealer=db.prepare('SELECT * FROM dealer_profiles WHERE person_id=?').get(p.id);
  if (EXCLUDED.has(p.custody_status) || EXCLUDED.has(visitStatus) || (p.category==='dealer' && EXCLUDED.has(dealer?.current_status))) return null;
  let level=0; const reasons=[];
  const add=(lv,source,date,reason,recordId)=>{level=Math.max(level,lv);reasons.push({source,date,reason,...(recordId?{recordId}:{})});};
  if (['psychiatric','released'].includes(p.category) && ['เฝ้าระวัง','เสี่ยงสูง'].includes(visitStatus)) {
    add(LEVELS.indexOf(visitStatus),'visits',visit.visit_date,`ผลเยี่ยมล่าสุดที่เจ้าหน้าที่บันทึก: ${visitStatus}`,visit.id);
  }
  const guardian=refreshGuardianStatus(db,p,today,{persist:false});
  if (guardian?.level) { level=Math.max(level,guardian.level);reasons.push(...guardian.evidence); }
  if (p.category==='drug_user' && ['พบสารเสพติด / เฝ้าระวัง','พบสารเสพติด / ส่งบำบัด','พบสารเสพติด / ดำเนินคดี','พบสารเสพติด','พบการใช้สารเสพติด'].includes(visitStatus)) {
    add(1,'visits',visit.visit_date,`ผลติดตามผู้เสพล่าสุด: ${visitStatus} จัดเป็นรายการติดตาม ไม่ยกระดับเป็นเสี่ยงสูงจากผลบวกเพียงอย่างเดียว`,visit.id);
  }
  if (p.type_name.includes('Most Wanted')) add(1,'people_type',p.updated_at,`มีป้ายประเภท ${p.type_name} ในทะเบียน เป็นเหตุให้ติดตามตามทะเบียน ไม่ใช่การทำนายพฤติกรรม`);
  if (p.category==='dealer' && dealer?.current_status==='ยังไม่พบตัว') add(1,'dealer_profiles',dealer.recorded_at,'ทะเบียนผู้ค้าระบุว่ายังไม่พบตัว ต้องติดตามสถานะตามหน้าที่',p.id);
  if (!level) return null;
  return {personId:p.id,displayName:`${p.first_name} ${p.last_name||''}`.trim(),personType:p.category,typeName:p.type_name,
    province:p.station_province||null,station:p.station_name||null,district:p.amphoe||null,subdistrict:p.tambon||null,
    level:LEVELS[level],reasons,latestVisitDate:visit?.visit_date||null};
}

function createMonitoringService(db, {today=thaiToday}={}) {
  function list(user, query={}) {
    const category=query.person_type;
    if (category && !CATEGORIES.includes(category)) throw new Error('INVALID_PERSON_TYPE');
    if (query.level && !['watch','high','all'].includes(query.level)) throw new Error('INVALID_LEVEL');
    if (query.group_by && !['province','station','district','subdistrict'].includes(query.group_by)) throw new Error('INVALID_GROUP_BY');
    if (user?.role!=='admin' && !Number.isInteger(user?.stationId)) return {total:0,items:[],byType:{},page:1,pageSize:20,asOf:today(),scope:'พื้นที่ที่มีสิทธิ์เข้าถึง'};
    const params=[];const conditions=[];
    if (user.role!=='admin') { conditions.push('p.station_id=?');params.push(user.stationId); }
    if (category) { conditions.push('t.category=?');params.push(category); }
    if (query.province) { conditions.push('s.province LIKE ?'); params.push(`%${query.province}%`); }
    if (query.station) { conditions.push('s.name LIKE ?'); params.push(`%${query.station}%`); }
    if (query.district) { conditions.push('p.amphoe LIKE ?'); params.push(`%${query.district}%`); }
    if (query.subdistrict) { conditions.push('p.tambon LIKE ?'); params.push(`%${query.subdistrict}%`); }
    if (query.search) {
      conditions.push("(p.first_name LIKE ? OR p.last_name LIKE ? OR p.synthetic_code LIKE ?)");
      params.push(`%${query.search}%`,`%${query.search}%`,`%${query.search}%`);
    }
    if(query.psychiatric_subtype!==undefined){
      if(!['drug','other'].includes(query.psychiatric_subtype))throw new Error('INVALID_SUBTYPE');
      conditions.push("(t.category<>'psychiatric' OR t.type_name LIKE ?)");params.push(query.psychiatric_subtype==='drug'?'ผู้ป่วยจิตเวชยาเสพติด%':'ผู้ป่วยจิตเวชอื่นๆ%');
    }
    if(query.most_wanted!==undefined){
      if(query.most_wanted!==true)throw new Error('INVALID_MOST_WANTED');
      conditions.push("t.type_name LIKE '%(Most Wanted)%'");
    }
    if (query.person_types!==undefined) {
      if (!Array.isArray(query.person_types)||query.person_types.some(t=>!CATEGORIES.includes(t)))throw new Error('INVALID_PERSON_TYPES');
      if(query.person_types.length){conditions.push(`t.category IN (${query.person_types.map(()=>'?').join(',')})`);params.push(...query.person_types);}
    }
    if (query.person_id!==undefined) {
      if (!Number.isSafeInteger(Number(query.person_id)) || Number(query.person_id)<=0) throw new Error('INVALID_PERSON_ID');
      conditions.push('p.id=?');params.push(Number(query.person_id));
    }
    const people=db.prepare(`SELECT p.*,t.type_name,t.category,s.name AS station_name,s.province AS station_province FROM people p JOIN people_type t USING(type_id) JOIN stations s ON s.id=p.station_id ${conditions.length?'WHERE '+conditions.join(' AND '):''} ORDER BY p.id`).all(...params);
    const asOf=today();
    const all=people.map(p=>classify(db,p,asOf)).filter(Boolean)
      .filter(p=>!query.level || query.level==='all' || p.level===(query.level==='high'?'เสี่ยงสูง':'เฝ้าระวัง'));
    if (query.sort === 'name_desc') all.sort((a,b)=>b.displayName.localeCompare(a.displayName,'th'));
    else if (query.sort === 'name_asc') all.sort((a,b)=>a.displayName.localeCompare(b.displayName,'th'));
    else all.sort((a,b)=>LEVELS.indexOf(b.level)-LEVELS.indexOf(a.level)||a.personId-b.personId);
    const page=Math.max(1,Number.isSafeInteger(Number(query.page))?Number(query.page):1);
    const pageSize=Math.min(200,Math.max(1,Number.isSafeInteger(Number(query.pageSize))?Number(query.pageSize):20));
    const byType={};for(const p of all)byType[p.personType]=(byType[p.personType]||0)+1;
    const groupField={province:'province',station:'station',district:'district',subdistrict:'subdistrict'}[query.group_by];
    const locationSummary=groupField ? Object.entries(all.reduce((groups,p)=>{
      const name=p[groupField]||'ไม่ระบุ';groups[name]=(groups[name]||0)+1;return groups;
    },{})).map(([name,count])=>({name,count})).sort((a,b)=>b.count-a.count||a.name.localeCompare(b.name,'th')) : undefined;
    return {total:all.length,items:all.slice((page-1)*pageSize,page*pageSize),byType,page,pageSize,asOf,scope:'พื้นที่ที่มีสิทธิ์เข้าถึง',
      configured:!!db.prepare('SELECT 1 FROM people LIMIT 1').get(),
      personFound:query.person_id===undefined?undefined:people.length>0,
      ...(locationSummary?{locationSummary}:{})};
  }
  return {list};
}
module.exports={createMonitoringService,refreshGuardianStatus,scopedPerson,latestVisit,thaiToday,LEVELS};
