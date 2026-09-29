'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const commands = require('../frontend/chartCommands');
const context = require('../frontend/chatContext');
const { correctTranscript } = require('../src/stt/correctTranscript');
const { analyzePeriods } = require('../src/ai/timeWindow');
const { peopleChart, visitsChart } = require('../src/services/chartPresentation');

for (const verb of ['สร้าง', 'ขอ']) for (const noun of ['กราฟ', 'แผนภูมิ']) {
  test(`chart guide wording: ${verb}${noun}`, () => {
    for (const suffix of ['', 'ยังไง', 'อะไรได้บ้าง', 'ทำยังไง', 'ใช้ยังไง', ' อย่างไรครับ', ' อะไรก็ได้ที่ยังไม่รองรับ']) assert.equal(commands.detect(verb + noun + suffix).kind, 'help');
  });
}
test('guide uses the verified station/province and every button has an executable grammar', () => {
  const profile = { stationId: 73, stationName: 'สภ.เมืองร้อยเอ็ด', province: 'ร้อยเอ็ด' };
  const out = commands.guide(profile);
  assert.equal(out.presentation.choices.length, 5);
  assert.match(out.answer, /เมืองร้อยเอ็ด/);
  assert.match(out.presentation.choices[1].message, /จังหวัดร้อยเอ็ด$/);
  assert.match(out.presentation.choices[3].message, /จังหวัด นครพนม$/);
  // The last example names “จังหวัดอื่น” so the assistant asks which province.
  assert.match(out.presentation.choices[4].message, /จังหวัดอื่น$/);
  assert.deepEqual(out.presentation.choices.map(c => commands.detect(c.message).kind), ['people', 'people', 'visits', 'visits', 'people']);
  assert.equal(commands.detect(out.presentation.choices[4].message).otherProvince, true);
  assert.equal(commands.guide({ ...profile, province: 'นครพนม' }).presentation.choices[3].message, 'สร้างกราฟการตรวจเยี่ยมรายเดือนของจังหวัด ร้อยเอ็ด');
  const absent = commands.guide({});
  assert.ok(!absent.answer.includes('สภ.ของฉัน'));
  assert.ok(!absent.answer.includes('จังหวัดร้อยเอ็ด'));
  // The other-province example is available even without a complete affiliation.
  assert.ok(commands.guide({}).presentation.choices.some(c => /จังหวัดอื่น$/.test(c.message)));
});
test('chart transcript repairs are contextual and leave religious speech, names and graphics alone', () => {
  for (const alias of ['กาฟ', 'ก๊าฟ', 'คราฟ', 'กร๊าฟ', 'กราป', 'กราฟฟ์', 'กราฟ์', 'กราบ']) {
    assert.equal(commands.detect(`สร้าง${alias}`).kind, 'help');
    assert.match(correctTranscript(`สร้าง${alias}บุคคลเป้าหมาย สภ.ของฉัน แยกตามประเภท`), /^สร้างกราฟ/);
  }
  // Field-reported mishear of แผนภูมิ (“สร้างแผนธูป”) plus common ชาร์ท family.
  for (const alias of ['แผนธูป', 'แผนธุป', 'แผนทูม', 'แผนตูม', 'แผนภูม', 'แผนปูม', 'แผนดูป', 'แผนภูมิ์']) {
    assert.equal(commands.detect(`สร้าง${alias}`).kind, 'help');
    assert.match(correctTranscript(`สร้าง${alias}`), /^สร้างแผนภูมิ/);
    assert.match(correctTranscript(`ขอ${alias}อะไรได้บ้าง`), /^ขอแผนภูมิอะไรได้บ้าง$/);
  }
  for (const alias of ['ชาร์ท', 'ชาร์ต', 'ชาต์', 'ชาร์ด', 'ชาร์', 'ชาท', 'ชาด']) {
    assert.equal(commands.detect(`สร้าง${alias}`).kind, 'help');
    assert.match(correctTranscript(`สร้าง${alias}บุคคลเป้าหมายราย สภ. จังหวัดอื่น`), /^สร้างแผนภูมิ/);
  }
  for (const phrase of ['ขอกราบ', 'กราบพระ', 'กราบขอบคุณครับ', 'ขอรายชื่อนายกราฟ', 'ขอรายชื่อผู้เสพชื่อนายกราฟ', 'หาคนชื่อกราฟ', 'ขอประวัตินายกราฟ', 'สร้างกราฟิก', 'สร้างกราฟฟิก']) {
    assert.equal(commands.repair(phrase), phrase);
    assert.equal(commands.detect(phrase), null);
  }
});
test('unconsumed chart conditions return guidance instead of a broader read', () => {
  for (const suffix of [' ไม่รวมผู้ค้า', ' ปีที่แล้ว', ' จังหวัดอื่น', ' เฉพาะคนเสี่ยงสูง']) assert.equal(commands.detect('สร้างกราฟบุคคลเป้าหมาย สภ.ของฉัน แยกตามประเภท' + suffix).kind, 'help');
});
test('“จังหวัดอื่น” is a deliberate incomplete chart command', () => {
  for (const verb of ['สร้าง', 'ขอ', 'แสดง', 'ทำ']) for (const noun of ['กราฟ', 'แผนภูมิ']) {
    const out = commands.detect(`${verb}${noun}บุคคลเป้าหมายราย สภ. จังหวัดอื่น`);
    assert.equal(out.kind, 'people');
    assert.equal(out.own, false);
    assert.equal(out.otherProvince, true);
  }
  // A concrete province still builds directly; อื่น is never a province name.
  assert.equal(commands.detect('สร้างกราฟบุคคลเป้าหมายราย สภ. จังหวัดร้อยเอ็ด').otherProvince, undefined);
  // Unconsumed trailing จังหวัดอื่น on other grammars is never the
  // other-province command; the route refuses its unrecognized period.
  const trailing = commands.detect('สร้างกราฟการตรวจเยี่ยมรายเดือน สภ.ของฉัน 3 เดือนย้อนหลัง จังหวัดอื่น');
  assert.notEqual(trailing.otherProvince, true);
});
test('spoken/typed ordinal choices accept all choice heads, digits and Thai words', () => {
  for (const verb of ['เลือก', 'ขอ', 'เอา']) for (const head of ['ข้อที่', 'ข้อ', 'ลำดับที่', 'ลำดับ']) {
    for (const value of ['2', '๒', 'สอง']) assert.equal(context.ordinalCommandFromMessage(`${verb}${head}${value}`).ordinal, 2);
  }
  assert.equal(context.ordinalFromMessage('ข้อที่ 0'), null);
  assert.equal(context.ordinalFromMessage('ขอข้อกฎหมาย'), null);
  assert.equal(context.ordinalFromMessage('ขอข้อมูลเพิ่มเติมของลำดับที่ 3'), 3);
});
test('ย้อนหลัง is an explicit bounded period, with Thai spoken numbers', () => {
  for (const phrase of ['3 เดือนย้อนหลัง', '๓ เดือนย้อนหลัง', 'สามเดือนย้อนหลัง']) {
    const out = analyzePeriods(phrase, { now: new Date('2026-09-28T06:00:00Z') });
    assert.equal(out.windows.length, 1); assert.deepEqual(out.unresolved, []);
    assert.equal(out.windows[0].to, '2026-09-28'); assert.match(out.windows[0].label, /3 เดือน/);
  }
  assert.equal(analyzePeriods('25 เดือนย้อนหลัง').unresolved.length, 1);
});
test('chart counts reject missing, negative, inconsistent or invented totals; visits sum displayed categories', () => {
  const row = { station_name: 'สภ.ทดสอบ', psychiatric_total: 2, drug_user_total: 3, dealer_total: 0, released_total: 1, target_total: 6 };
  assert.equal(peopleChart({ rows: [row] }, { own: true, areaLabel: 'ทดสอบ' }).total, 6);
  for (const change of [{ target_total: 7 }, { psychiatric_total: -1 }, { psychiatric_total: null }, { psychiatric_total: undefined }]) assert.throws(() => peopleChart({ rows: [{ ...row, ...change }] }, { own: true }), { code: 'REAL_DATA_UNVERIFIABLE' });
  const chart = visitsChart({ areaLabel: 'ทดสอบ', from: '2026-09-01', to: '2026-09-28', total: 2, periodPartial: true, months: [{ label: 'กันยายน 2569', total: 999, byType: [{ count: 2 }] }] }, 'เดือนนี้');
  assert.deepEqual(chart.values, [2]); assert.equal(chart.unit, 'ครั้ง'); assert.ok(chart.note);
});
