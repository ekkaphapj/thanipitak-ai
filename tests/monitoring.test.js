'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const request=require('supertest');
const {createConnection}=require('../src/db/connection');
const {seedRealisticDatabase}=require('../src/db/realisticSeed');
const {createMonitoringService}=require('../src/services/monitoringService');
const {createSimulationService}=require('../src/services/simulationService');
const {createPersonService}=require('../src/services/personService');
const {createToolRouter}=require('../src/ai/toolRouter');
const {createAIGateway}=require('../src/ai/gateway');
const {createApp}=require('../src/app');
const {detectMonitoringIntent}=require('../src/ai/monitoring');
const DAY='2026-09-17';const officer={id:2,username:'station1_off',role:'officer',stationId:1};
function fixture(t){const db=createConnection(':memory:');t.after(()=>db.close());seedRealisticDatabase(db,{asOf:DAY});return {db,service:createMonitoringService(db,{today:()=>DAY}),write:createSimulationService(db,{today:()=>DAY})};}

test('realistic fixture relationships and independently specified risk totals',t=>{
  const {db,service}=fixture(t);
  assert.equal(db.prepare('SELECT count(*) n FROM people').get().n,80);
  assert.equal(db.prepare('SELECT count(*) n FROM people_type').get().n,9);
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0);
  assert.equal(service.list(officer).total,9);
  assert.deepEqual(service.list(officer).byType,{psychiatric:5,released:2,drug_user:1,dealer:1});
  assert.deepEqual(service.list(officer,{level:'high'}).items.map(p=>p.personId),[1,3,4,11]);
  assert.deepEqual(service.list(officer,{person_type:'psychiatric',level:'high'}).items.map(p=>p.personId),[1,3,4]);
  assert.equal(service.list(officer,{person_type:'drug_user',level:'high'}).total,0);
  assert.ok(service.list(officer,{person_id:3}).items[0].reasons[0].reason.includes('การรับประทานยา'));
  assert.equal(service.list(officer,{person_types:['dealer','released']}).total,3);
  assert.equal(service.list(officer,{person_types:['psychiatric'],psychiatric_subtype:'drug',level:'high'}).total,2);
  assert.equal(service.list(officer,{most_wanted:true}).total,1);
});

test('monitoring reads leave source rows unchanged',t=>{
  const {db,service}=fixture(t);
  const before=db.prepare('SELECT * FROM person_report_status ORDER BY person_id').all();
  service.list(officer,{level:'high'});
  assert.deepEqual(db.prepare('SELECT * FROM person_report_status ORDER BY person_id').all(),before);
});

test('unavailable real source cannot silently return fixture data',async t=>{
  const {db}=fixture(t);const {app}=createApp(db);
  const result=await request(app).post('/api/ai/chat').set('X-Data-Source','real').send({message:'รายชื่อ'});
  assert.equal(result.status,401);
  assert.equal(result.body.answer,undefined);
});

test('scope and counts remain correct across pages; no-station fails closed',t=>{
  const {db,service}=fixture(t);
  assert.equal(service.list({role:'officer',stationId:null}).total,0);
  assert.equal(createPersonService(db).listPersons({role:'officer',stationId:null}).total,0);
  assert.equal(service.list(officer,{person_id:17}).personFound,false);
  assert.ok(service.list({role:'officer',stationId:2}).items.every(p=>p.personId>16&&p.personId<=32));
  const admin={role:'admin'};const p1=service.list(admin),p2=service.list(admin,{page:2}),p3=service.list(admin,{page:3});
  assert.equal(p1.total,45);assert.equal(p2.total,45);assert.equal(p3.items.length,5);
  assert.equal(new Set([...p1.items,...p2.items,...p3.items].map(p=>p.personId)).size,45);
});

test('latest visit by date/time/id supersedes historical flags without changing other people',t=>{
  const {service,write}=fixture(t);
  write.recordVisit(officer,1,{date:'2026-09-16',time:'10:00',status:'อาการปกติ'});
  assert.equal(service.list(officer,{person_id:1}).total,0);
  write.recordVisit(officer,1,{date:'2026-09-01',status:'เสี่ยงสูง'});
  assert.equal(service.list(officer,{person_id:1}).total,0,'backdated high does not replace latest normal');
  write.recordVisit(officer,1,{date:'2026-09-16',time:'11:00',status:'เสี่ยงสูง'});
  assert.equal(service.list(officer,{person_id:1}).items[0].level,'เสี่ยงสูง');
  assert.equal(service.list(officer,{person_id:2}).items[0].level,'เฝ้าระวัง');
});

test('old positive, deceased and prison records are not active risk matches',t=>{
  const {service,write}=fixture(t);
  for(const id of [10,14,15,16])assert.equal(service.list(officer,{person_id:id}).total,0);
  write.recordVisit(officer,7,{date:DAY,status:'ไม่พบสารเสพติด'});
  assert.equal(service.list(officer,{person_id:7}).total,0);
  write.recordVisit(officer,11,{date:DAY,status:'อยู่ในเรือนจำ'});
  assert.equal(service.list(officer,{person_id:11}).total,0);
});

test('guardian alerts are sticky until normal officer visit; paused links do not generate new alerts',t=>{
  const {db,service,write}=fixture(t);
  write.recordGuardianReport(officer,3,{date:DAY,met_patient:'พบตัว',medication:'ครบ',symptoms:[],risk_behaviors:[]});
  assert.equal(service.list(officer,{person_id:3}).items[0].level,'เสี่ยงสูง');
  assert.ok(service.list(officer,{person_id:3}).items[0].reasons.some(r=>r.source==='sticky_alert'));
  write.recordVisit(officer,3,{date:DAY,status:'อาการปกติ'});
  assert.equal(service.list(officer,{person_id:3}).total,0);
  db.prepare("UPDATE guardian_patient_links SET reporting_paused_at=? WHERE person_id=4").run(DAY);
  write.recordVisit(officer,4,{date:DAY,status:'อาการปกติ'});
  assert.equal(service.list(officer,{person_id:4}).total,0);
});

test('color-specific missed-report thresholds and cancelled reports',t=>{
  const {db,service}=fixture(t);
  db.prepare("UPDATE person_report_status SET alert_level='ปกติ',evidence_json='[]' WHERE person_id=4").run();
  db.prepare("UPDATE people SET status='เขียว' WHERE id=4").run();
  assert.equal(service.list(officer,{person_id:4}).total,0,'4 missed days below green threshold 6');
  db.prepare("UPDATE guardian_reports SET cancelled_at=? WHERE person_id=4").run(DAY);
  assert.equal(service.list(officer,{person_id:4}).items[0].level,'เสี่ยงสูง','cancelled report ignored; link began 10 days ago');
});

test('simulation writes validate domain, scope, role, dates and rollback',t=>{
  const {db,write}=fixture(t);const before=db.prepare('SELECT count(*) n FROM visits').get().n;
  assert.throws(()=>write.recordVisit(officer,17,{date:DAY,status:'เสี่ยงสูง'}),/NOT_FOUND/);
  assert.throws(()=>write.recordVisit({...officer,role:'viewer'},1,{date:DAY,status:'เสี่ยงสูง'}),/FORBIDDEN/);
  assert.throws(()=>write.recordVisit(officer,7,{date:DAY,status:'เสี่ยงสูง'}),/INVALID_VISIT_STATUS/);
  assert.throws(()=>write.recordVisit(officer,1,{date:'2026-02-30',status:'เสี่ยงสูง'}),/INVALID_DATE/);
  assert.throws(()=>write.recordVisit(officer,1,{date:'2099-01-01',status:'เสี่ยงสูง'}),/INVALID_DATE/);
  assert.throws(()=>write.recordGuardianReport(officer,7,{}),/GUARDIAN_PSYCHIATRIC_ONLY/);
  assert.equal(db.prepare('SELECT count(*) n FROM visits').get().n,before);
});

test('multiple Thai phrasings route deterministically with type and level filters',async t=>{
  const {db}=fixture(t);const gateway=createAIGateway(createToolRouter(db));
  const variants=[
    ['ผู้ป่วยจิตเวชที่เสี่ยงสูงมีใครบ้าง เพราะอะไร','psychiatric','high'],
    ['ช่วยดูให้หน่อยครับว่าผู้เสพคนไหนต้องจับตา','drug_user','all'],
    ['ขอรายชื่อผู้ค้าที่ควรเฝ้าระวังพร้อมเหตุผล','dealer','all'],
    ['มีผู้พ้นโทษกลุ่มเสี่ยงไหม','released','all'],
    ['ใครบ้างที่มีความเสี่ยงสูง','', 'high'],
    ['บุคคลที่ต้องดูแลเป็นพิเศษมีใครบ้าง','','all'],
    ['ขอคนที่น่าเป็นห่วงพร้อมสาเหตุ','','all'],
    ['กลุ่ม high-risk มีใครบ้าง','','high'],
    ['เฝ้าระวังหรือเสี่ยงสูง แยกตามประเภทมีกี่คน','','all'],
    ['ผู้ป่วยจิตเวชเฉพาะเฝ้าระวังมีใครบ้าง','psychiatric','watch'],
  ];
  for(const [q,category,level] of variants) {
    const intent=detectMonitoringIntent(q);assert.equal(intent.level,level,q);
    if(category)assert.ok(intent.person_types.includes(category),q);
    const out=await gateway.chatWithTools(q,officer,null,{requestFn:async()=>assert.fail('No LLM needed for monitored facts')});
    assert.equal(out.ollamaCalls,0,q);assert.equal(out.grounded,true,q);
    assert.ok(out.toolsUsed.includes('get_monitoring_persons'),q);
    if(category)assert.ok(out.presentation.items.every(p=>p.personType===category),q);
  }
});

test('location questions return locations and counts instead of every matching person',async t=>{
  const {db}=fixture(t);const gateway=createAIGateway(createToolRouter(db));
  const question='ตำบลไหนมีผู้ป่วยจิตเวชเสี่ยงสูงบ้าง';
  const intent=detectMonitoringIntent(question);
  assert.equal(intent.group_by,'subdistrict');
  const out=await gateway.chatWithTools(question,officer,null,{requestFn:async()=>assert.fail('location question must not call Ollama')});
  assert.equal(out.ollamaCalls,0);
  assert.equal(out.presentation.type,'monitoring_location_summary');
  assert.equal(out.presentation.total,3);
  assert.deepEqual(out.presentation.locationSummary,[{name:'ตำบลจำลอง',count:3}]);
  assert.match(out.answer,/ตำบลจำลอง — 3 คน/);
  assert.ok(!out.answer.includes('ทดสอบ1 สถานี1'));
  const people=await gateway.chatWithTools('ผู้ป่วยจิตเวช ในตำบลจำลอง ที่เสี่ยงสูงมีใครบ้าง',officer,null,{requestFn:async()=>assert.fail('filtered list must not call Ollama')});
  assert.equal(people.presentation.total,3);
  assert.ok(people.presentation.items.every(item=>item.subdistrict==='ตำบลจำลอง'));
});

test('person-specific questions use selected/name identity and never fall back to global list',async t=>{
  const {db}=fixture(t);const gateway=createAIGateway(createToolRouter(db));
  const ask=(q,context)=>gateway.chatWithTools(q,officer,null,{context,requestFn:async()=>assert.fail('unexpected LLM')});
  assert.match((await ask('คนนี้เสี่ยงสูงเพราะอะไร')).answer,/กรุณาเลือก/);
  assert.match((await ask('คนนี้เสี่ยงสูงเพราะอะไร',{personId:17})).answer,/ไม่พบบุคคล/);
  for(const q of ['ทดสอบ1 สถานี1 เสี่ยงสูงเพราะอะไร','ทำไมทดสอบ1 สถานี1ถึงเสี่ยงสูง','ทำไมทดสอบ1ถึงเสี่ยงสูง']) {
    const out=await ask(q);assert.equal(out.presentation.total,1,q);assert.equal(out.presentation.items[0].personId,1,q);
  }
  const actual=await ask('คนนี้เสี่ยงสูงไหม',{personId:2});assert.equal(actual.presentation.items[0].level,'เฝ้าระวัง');
  assert.match((await ask('คนที่ไม่เสี่ยงสูงมีใครบ้าง')).answer,/ยังไม่รองรับ/);
});

test('selected person takes precedence over list wording and type filters', async t => {
  const { db } = fixture(t);
  const gateway = createAIGateway(createToolRouter(db));
  for (const question of [
    'เสี่ยงสูงเพราะอะไร',
    'เพราะอะไร',
    'ผู้ป่วยจิตเวชที่เสี่ยงสูงมีใครบ้าง เพราะอะไร',
    'ผู้พ้นโทษที่ต้องเฝ้าระวังมีใครบ้าง',
    'สรุปจำนวนคนกลุ่มเสี่ยงแยกตามประเภท',
  ]) {
    const out = await gateway.chatWithTools(question, officer, null, {
      context: { personId: 3 },
      requestFn: async () => assert.fail('selected monitoring questions must not call the model'),
    });
    assert.equal(out.presentation.total, 1, question);
    assert.equal(out.presentation.items[0].personId, 3, question);
    assert.ok(out.answer.includes('ทดสอบ3 สถานี1'), question);
    assert.ok(!out.answer.includes('ทดสอบ1 สถานี1'), question);
  }
});

test('authenticated API and AI audit contain scoped evidence; forged scope rejected',async t=>{
  const {db}=fixture(t);const {app}=createApp(db);
  const login=await request(app).post('/api/auth/login').send({username:'station1_off',password:'thanipitak123'});
  assert.equal(login.status,200);const auth='Bearer '+login.body.token;
  assert.equal((await request(app).get('/api/monitoring')).status,401);
  assert.equal((await request(app).get('/api/monitoring?station_id=2').set('Authorization',auth)).status,400);
  const res=await request(app).post('/api/ai/chat').set('Authorization',auth).send({message:'ผู้ป่วยจิตเวชเสี่ยงสูงมีใครบ้าง เพราะอะไร'});
  assert.equal(res.status,200);assert.equal(res.body.presentation.total,3);
  assert.ok(!res.body.answer.includes('สถานี2'));
  assert.ok(res.body.presentation.items.every(p=>p.reasons.length&&p.reasons.every(r=>r.date&&r.source)));
  assert.ok(db.prepare("SELECT * FROM ai_audit_logs WHERE tool_name='get_monitoring_persons'").get());
});

test('fallback monitoring binds selected identity even when model omits or changes it',async t=>{
  const {db}=fixture(t);const gateway=createAIGateway(createToolRouter(db));
  for(const args of [{level:'high'},{person_id:3,level:'high'}]) {
    const out=await gateway.chatWithTools('คนนี้เสี่ยงสูงเพราะอะไร',officer,null,{
      forceQwen:true,context:{personId:1},requestFn:async()=>({message:{tool_calls:[{function:{name:'get_monitoring_persons',arguments:args}}]}}),
    });
    assert.match(out.answer,/พบ 1 คน/);
    assert.ok(out.answer.includes('ทดสอบ1 สถานี1'));
    assert.ok(!out.answer.includes('ทดสอบ3 สถานี1'));
  }
});
