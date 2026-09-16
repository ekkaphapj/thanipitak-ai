const bcrypt = require('bcryptjs');

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST_SYLLABLES = [
  'กร', 'ชา', 'ธี', 'สุ', 'ปร', 'วิ', 'มน', 'กิต', 'วร', 'ธน',
  'พัช', 'ณัช', 'ชล', 'นที', 'ปภา', 'ศิริ', 'รติ', 'วารี', 'เจน', 'อัญ',
  'พราว', 'ขวัญ', 'มัส', 'ชนา', 'นิช', 'ปุญ', 'กานต์', 'วิน', 'อภิ', 'สา',
  'ธัน', 'ภัส', 'ญดา', 'พิมพ์', 'ณัฐ', 'ธนัช', 'รุ่ง', 'สาย', 'อร', 'ปริ',
];

const SURNAME_PREFIX = [
  'แก้ว', 'ทอง', 'ศรี', 'บุญ', 'สม', 'แสง', 'วง', 'ไชย', 'อยู่', 'ชัย',
  'คำ', 'เมือง', 'พล', 'เพชร', 'สวัสดิ์', 'โชติ', 'บำรุง', 'เดช', 'คง', 'ทศ',
];

const SURNAME_SUFFIX = [
  'ศักดิ์', 'ชัย', 'มิตร', 'สุวรรณ', 'กุล', 'วงษ์', 'เดช', 'ราม', 'สิทธิ์',
  'ธวัช', 'ดวง', 'พฤกษ์', 'ษา', 'ประเสริฐ', 'สกุล', 'เลิศ', 'อรุณ', 'เพ็ญ',
  'วิทย์', 'นคร',
];

const DISTRICTS = [
  { district: 'คลองประเวศ', subs: ['บึงมัน', 'สวนกุหลาบ', 'หนองตะไก้', 'ทุ่งโปร่ง', 'คลองเจริญ'] },
  { district: 'วัดอรุณ', subs: ['บางไผ่', 'ท่าช้าง', 'สวนหลวง', 'สามแยก', 'นาเกลือ'] },
  { district: 'หนองบัวแดง', subs: ['โคกสำโรง', 'บ้านกล้วย', 'หัวถนน', 'ท่าแร่', 'วังหิน'] },
  { district: 'ศรีสำราญ', subs: ['หนองปลาไหล', 'สระบัว', 'ทุ่งนางาม', 'หนองลิง', 'กุดจิก'] },
  { district: 'วังทอง', subs: ['นาโพธิ์', 'ไร่แดง', 'หนองไผ่', 'ห้วยใหญ่', 'ดอนกลาง'] },
  { district: 'บางสะพานน้อย', subs: ['ทุ่งสง', 'คลองตาล', 'หนองราง', 'โคกทราย', 'ปากน้ำ'] },
  { district: 'มโนรมย์', subs: ['บัวขาว', 'ดงละคร', 'ท่าพลับ', 'หนองบอน', 'คลองน้ำ'] },
  { district: 'นครเกษม', subs: ['แหลมทอง', 'ไทรน้อย', 'บึงมะขาม', 'พรหมแดน', 'ทุ่งยาว'] },
  { district: 'บ้านโขง', subs: ['หนองกรวด', 'ดอนทราย', 'บางแก้ว', 'นาแสน', 'กุดน้อย'] },
  { district: 'สระสอง', subs: ['โคกสูง', 'ทับใต้', 'หนองกวาง', 'วังไทร', 'บึงทอง'] },
  { district: 'เพชรบูรณะ', subs: ['ลำปลาย', 'ดอนซุย', 'หนองแวง', 'ห้วยม่วง', 'โพธิ์ทอง'] },
  { district: 'สะแกราช', subs: ['ทุ่งไผ่', 'ดงสุข', 'บ้านนอก', 'หนองน้ำ', 'คลองเพรียว'] },
  { district: 'ยางโทน', subs: ['ดอนแดง', 'ท่าเรือ', 'วังจิก', 'หนองยาง', 'กุดหว้า'] },
  { district: 'สามพรานน้อย', subs: ['บึงจระเข้', 'ห้วยเดื่อ', 'ทุ่งบาน', 'หนองช้าง', 'โพนงาม'] },
  { district: 'เขาสมิง', subs: ['ดงขวาง', 'วังนก', 'หนองบัว', 'ท่าข้าม', 'คลองสาม'] },
];

const STATIONS = [
  { name: 'สภ.คลองประเวศ', district: 'คลองประเวศ', province: 'กรุงเทพมหานคร' },
  { name: 'สภ.วัดอรุณ', district: 'วัดอรุณ', province: 'กรุงเทพมหานคร' },
  { name: 'สภ.หนองบัวแดง', district: 'หนองบัวแดง', province: 'ขอนแก่น' },
  { name: 'สภ.ศรีสำราญ', district: 'ศรีสำราญ', province: 'นครราชสีมา' },
  { name: 'สภ.วังทอง', district: 'วังทอง', province: 'พิษณุโลก' },
];

const PERSON_TYPE = ['psychiatric', 'drug_user', 'dealer'];
const STATUS = ['registered', 'active', 'followup', 'completed'];
const VISIT_RESULTS = ['normal', 'progress', 'warning', 'recovered'];
const URINE_RESULT = ['negative', 'positive'];
const NOTES_POOL = [
  'เข้ารับการตรวจครบตามนัด',
  'ให้คำแนะนำด้านการใช้ยา',
  'ส่งต่อศูนย์บำบัด',
  'ผู้รับบริการมีอาการดีขึ้นตามลำดับ',
  'จัดทำแผนติดตามรายบุคคล',
];

const CODE_BASE = 100000;

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function seedDatabase(db, seed = 20240901) {
  const rnd = mulberry32(seed);
  const rand = (n) => Math.floor(rnd() * n);
  const pick = (arr) => arr[rand(arr.length)];
  const chance = (p) => rnd() < p;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const counts = { stations: 0, users: 0, persons: 0, visits: 0, urineTests: 0, auditLogs: 0 };

  const makeName = () => {
    const first = pick(FIRST_SYLLABLES);
    const second = pick(FIRST_SYLLABLES).toLowerCase();
    const last = pick(SURNAME_PREFIX) + pick(SURNAME_SUFFIX);
    return { first: first + second, last };
  };

  const districtSubs = {};
  for (const d of DISTRICTS) districtSubs[d.district] = d.subs;

  db.exec('BEGIN');
  let stationIds = [];
  try {
    const stationStmt = db.prepare('INSERT INTO stations (name, district, province) VALUES (?, ?, ?)');
    for (const s of STATIONS) {
      const info = stationStmt.run(s.name, s.district, s.province);
      stationIds.push(Number(info.lastInsertRowid));
      counts.stations += 1;
    }

    const hash = bcrypt.hashSync('thanipitak123', 10);
    const userStmt = db.prepare('INSERT INTO users (username, password_hash, name, role, station_id) VALUES (?, ?, ?, ?, ?)');
    userStmt.run('admin', hash, 'ผู้ดูแลระบบกลาง', 'admin', null);
    counts.users += 1;

    for (const sid of stationIds) {
      const offName = makeName();
      const viewName = makeName();
      userStmt.run(`station${sid}_off`, hash, `เจ้าหน้าที่ ${offName.first} ${offName.last}`, 'officer', sid);
      counts.users += 1;
      userStmt.run(`station${sid}_view`, hash, `พนักงาน ${viewName.first} ${viewName.last}`, 'viewer', sid);
      counts.users += 1;
    }

    const personStmt = db.prepare(
      'INSERT INTO persons (synthetic_code, first_name, last_name, person_type, district, subdistrict, station_id, status, last_visit_date, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );

    const personPids = [];
    for (let i = 0; i < 500; i++) {
      const sid = stationIds[i % stationIds.length];
      const district = pick(DISTRICTS);
      const sub = pick(district.subs);
      const type = pick(PERSON_TYPE);
      const status = pick(STATUS);
      const nm = makeName();
      const created = new Date(today);
      created.setDate(created.getDate() - (rand(720) + 30));
      const code = `TP-${CODE_BASE + i + 1}`;

      const pinfo = personStmt.run(
        code,
        nm.first,
        nm.last,
        type,
        district.district,
        sub,
        sid,
        status,
        null,
        isoDate(created)
      );
      personPids.push(Number(pinfo.lastInsertRowid));
      counts.persons += 1;
    }

    const officers = db.prepare('SELECT id, station_id FROM users WHERE role = ?').all('officer');

    const visitStmt = db.prepare(
      'INSERT INTO visits (person_id, visit_date, result, note, officer_user_id) VALUES (?, ?, ?, ?, ?)'
    );
    for (let v = 0; v < 1500; v++) {
      const pid = personPids[rand(personPids.length)];
      const d = new Date(today);
      d.setDate(d.getDate() - rand(365));
      const officer = officers[rand(officers.length)].id;
      visitStmt.run(pid, isoDate(d), pick(VISIT_RESULTS), chance(0.4) ? pick(NOTES_POOL) : null, officer);
      counts.visits += 1;
    }

    db.prepare(
      'UPDATE persons SET last_visit_date = (SELECT MAX(visit_date) FROM visits WHERE visits.person_id = persons.id)'
    ).run();

    const urineStmt = db.prepare(
      'INSERT INTO urine_tests (person_id, test_date, result, officer_user_id) VALUES (?, ?, ?, ?)'
    );
    for (let u = 0; u < 500; u++) {
      const pid = personPids[rand(personPids.length)];
      const d = new Date(today);
      d.setDate(d.getDate() - rand(365));
      const officer = officers[rand(officers.length)].id;
      urineStmt.run(pid, isoDate(d), chance(0.72) ? 'negative' : 'positive', officer);
      counts.urineTests += 1;
    }

    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch (_) {
      /* ignore */
    }
    throw err;
  }

  return counts;
}

module.exports = { seedDatabase, STATIONS };