'use strict';

// Descriptive discovery is deliberately aggregate-only.  It surfaces where
// recorded data is concentrated or incomplete; it never predicts behaviour,
// ranks people, or turns a pattern into a medical/legal conclusion.
const DISCOVERY_RE = /(?:knowledge\s*discovery|data\s*discovery|วิเคราะห์(?:ภาพรวม|ข้อมูล|pattern)|พบ\s*(?:อะไรใหม่|แพตเทิร์น|pattern|ข้อสังเกต)|ข้อมูล(?:มีอะไรน่าสนใจ|บอกอะไร|กระจุกตัว)|ความกระจุกตัว|วิเคราะห์ภาระงาน|ตรวจ(?:สอบ)?คุณภาพข้อมูล|เปรียบเทียบพื้นที่|วิเคราะห์ผลการดำเนินงาน)/iu;
const TYPE_LABELS = { psychiatric: 'ผู้ป่วยจิตเวช', drug_user: 'ผู้เสพ', dealer: 'ผู้ค้า', released: 'ผู้พ้นโทษ' };
const STATUS_LABELS = { registered: 'ขึ้นทะเบียน', active: 'กำลังติดตาม', followup: 'ต้องติดตาม', completed: 'เสร็จสิ้น' };
const MIN_GROUP_COUNT = 5;

function detectDiscoveryIntent(message) {
  const text = String(message || '').trim();
  if (!DISCOVERY_RE.test(text)) return null;
  if (/ภาระงาน|ค้างติดตาม/.test(text)) return { kind: 'workload' };
  if (/คุณภาพข้อมูล|ข้อมูล.*(?:ครบ|ขาด|ไม่ครบ)/.test(text)) return { kind: 'quality' };
  if (/เปรียบเทียบพื้นที่|เปรียบเทียบ.*(?:ตำบล|อำเภอ|สภ\.?)/.test(text)) return { kind: 'comparison' };
  if (/ผลการดำเนินงาน|ปิดงาน|สถานะ/.test(text)) return { kind: 'operations' };
  return { kind: 'discovery' };
}

function countBy(rows, key) {
  const counts = new Map();
  for (const row of rows) {
    const value = String(row[key] || '').trim();
    if (value) counts.set(value, (counts.get(value) || 0) + 1);
  }
  return [...counts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'th'));
}

function discover(rows, { scopeLabel = 'พื้นที่ที่มีสิทธิ์เข้าถึง', kind = 'discovery' } = {}) {
  const total = rows.length;
  const byType = countBy(rows, 'person_type');
  const byStatus = countBy(rows, 'status');
  const areaRows = rows.map((row) => ({ ...row, area: [row.subdistrict, row.district].filter(Boolean).join(' / ') }));
  const byArea = countBy(areaRows, 'area');
  const insights = [];

  if (!total) {
    return {
      answer: `ข้อสังเกตจากข้อมูล • ${scopeLabel}\nยังไม่มีข้อมูลเพียงพอสำหรับวิเคราะห์`,
      presentation: { type: 'discovery', total: 0, insights: [], byType: [], byStatus: [], topAreas: [] },
    };
  }

  const largestType = byType[0];
  if (largestType) insights.push(`ประเภทที่มีจำนวนมากที่สุดคือ ${TYPE_LABELS[largestType.name] || largestType.name} ${largestType.count} คน (${Math.round(largestType.count * 100 / total)}% ของข้อมูลที่ตรวจได้)`);

  const concentrated = byArea.find((item) => item.count >= MIN_GROUP_COUNT && item.count / total >= 0.25);
  if (concentrated) insights.push(`ข้อมูลกระจุกตัวที่${concentrated.name} ${concentrated.count} คน (${Math.round(concentrated.count * 100 / total)}%) จึงควรใช้เป็นจุดเริ่มต้นของการดูภาพรวมพื้นที่ ไม่ใช่ข้อสรุปความเสี่ยงของบุคคล`);

  const followup = byStatus.find((item) => item.name === 'followup');
  if (followup && followup.count >= MIN_GROUP_COUNT) insights.push(`มีสถานะ${STATUS_LABELS.followup} ${followup.count} คน ควรตรวจดูรายการติดตามตามขั้นตอนงานต่อไป`);

  const missingArea = rows.filter((row) => !String(row.subdistrict || '').trim() || !String(row.district || '').trim()).length;
  if (missingArea) insights.push(`พบข้อมูลพื้นที่ไม่ครบ ${missingArea} รายการ จึงอาจยังจัดอันดับตำบลหรืออำเภอได้ไม่ครบถ้วน`);
  if (kind === 'workload') {
    const pending = (byStatus.find((item) => item.name === 'followup') || { count: 0 }).count;
    const active = (byStatus.find((item) => item.name === 'active') || { count: 0 }).count;
    insights.splice(0, insights.length, `งานที่บันทึกเป็นต้องติดตาม ${pending} คน และกำลังติดตาม ${active} คน`, `ควรจัดลำดับงานจากรายการต้องติดตามตามพื้นที่และประเภทผ่านคำสั่งรายชื่อ/ภาพรวม ไม่ใช้ผลนี้แทนกำหนดการปฏิบัติงาน`);
  } else if (kind === 'quality') {
    insights.splice(0, insights.length, missingArea ? `พบข้อมูลพื้นที่ไม่ครบ ${missingArea} รายการ ควรเติมตำบลหรืออำเภอก่อนใช้จัดอันดับ` : 'ข้อมูลพื้นที่ของรายการที่ตรวจได้ครบถ้วน', `ตรวจพบประเภทข้อมูล ${byType.length} กลุ่ม และสถานะงาน ${byStatus.length} สถานะ`);
  } else if (kind === 'comparison') {
    const top = byArea.filter((item) => item.count >= MIN_GROUP_COUNT).slice(0, 3);
    insights.splice(0, insights.length, top.length ? `พื้นที่ที่มีข้อมูลมากสุด: ${top.map((item) => `${item.name} ${item.count} คน`).join(' • ')}` : 'ยังไม่มีพื้นที่ใดมีข้อมูลถึงเกณฑ์เปรียบเทียบแบบรวม', 'ใช้ผลนี้เพื่อเลือกพื้นที่ที่จะดูภาพรวมต่อ ไม่ใช่เพื่อจัดระดับความเสี่ยงของพื้นที่');
  } else if (kind === 'operations') {
    insights.splice(0, insights.length, `สถานะงานที่บันทึก: ${byStatus.map((item) => `${STATUS_LABELS[item.name] || item.name} ${item.count}`).join(' • ')}`, 'ผลนี้สะท้อนสถานะทะเบียนปัจจุบัน ไม่ใช่อัตราความสำเร็จหรือผลลัพธ์ของคดี');
  }
  if (!insights.length) insights.push('ยังไม่พบรูปแบบที่มีจำนวนมากพอสำหรับรายงานแบบรวม ควรเพิ่มข้อมูลหรือระบุพื้นที่/ประเภทที่ต้องการวิเคราะห์');

  const lines = [
    `ข้อสังเกตจากข้อมูล • ${scopeLabel}`,
    `ตรวจทะเบียนรวม ${total} คน (เป็นภาพข้อมูล ณ เวลาที่เรียกดู)`,
    ...insights.map((insight, index) => `${index + 1}. ${insight}`),
    'หมายเหตุ: เป็นการสรุปเชิงพรรณนาจากข้อมูลที่บันทึก ไม่ใช่การทำนายหรือวินิจฉัยบุคคล',
  ];
  return {
    answer: lines.join('\n'),
    presentation: { type: 'discovery', kind, total, insights, byType, byStatus, topAreas: byArea.filter((item) => item.count >= MIN_GROUP_COUNT).slice(0, 5) },
  };
}

function createDiscoveryService(persons) {
  function run(user, options = {}) {
    // The service obtains all records through the existing scoped person
    // service.  It receives no role/station input from the prompt or client.
    const result = persons.listPersonsForDiscovery(user);
    if (result.truncated) {
      return {
        answer: `ข้อสังเกตจากข้อมูล • ${user.stationName || 'พื้นที่ที่มีสิทธิ์เข้าถึง'}\nข้อมูลมีมากเกินเกณฑ์วิเคราะห์แบบรวมในหน่วยความจำ กรุณาระบุประเภทบุคคลหรือพื้นที่ก่อน`,
        presentation: { type: 'discovery', total: result.total, insights: [], byType: [], byStatus: [], topAreas: [], limited: true },
      };
    }
    return discover(result.rows, { scopeLabel: user.stationName || 'พื้นที่ที่มีสิทธิ์เข้าถึง', kind: options.kind });
  }
  return { run };
}

module.exports = { detectDiscoveryIntent, discover, createDiscoveryService, MIN_GROUP_COUNT };
