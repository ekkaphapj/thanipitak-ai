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
  assert.equal(out.presentation.choices.length, 4);
  assert.match(out.answer, /เมืองร้อยเอ็ด/);
  assert.match(out.presentation.choices[1].message, /จังหวัดร้อยเอ็ด$/);
  assert.match(out.presentation.choices[3].message, /จังหวัด นครพนม$/);
  assert.deepEqual(out.presentation.choices.map(c => commands.detect(c.message).kind), ['people', 'people', 'visits', 'visits']);
  assert.equal(commands.guide({ ...profile, province: 'นครพนม' }).presentation.choices[3].message, 'สร้างกราฟการตรวจเยี่ยมรายเดือนของจังหวัด ร้อยเอ็ด');
  const absent = commands.guide({});
  assert.ok(!absent.answer.includes('สภ.ของฉัน'));
  assert.ok(!absent.answer.includes('จังหวัดร้อยเอ็ด'));
});
test('chart transcript repairs are contextual and leave religious speech, names and graphics alone', () => {
  for (const alias of ['กาฟ', 'ก๊าฟ', 'คราฟ', 'กร๊าฟ', 'กราป', 'กราฟฟ์', 'กราฟ์', 'กราบ']) {
    assert.equal(commands.detect(`สร้าง${alias}`).kind, 'help');
    assert.match(correctTranscript(`สร้าง${alias}บุคคลเป้าหมาย สภ.ของฉัน แยกตามประเภท`), /^สร้างกราฟ/);
  }
  for (const phrase of ['ขอกราบ', 'กราบพระ', 'กราบขอบคุณครับ', 'ขอรายชื่อนายกราฟ', 'สร้างกราฟิก', 'สร้างกราฟฟิก']) {
    assert.equal(commands.repair(phrase), phrase);
    assert.equal(commands.detect(phrase), null);
  }
});
test('unconsumed chart conditions return guidance instead of a broader read', () => {
  for (const suffix of [' ไม่รวมผู้ค้า', ' ปีที่แล้ว', ' จังหวัดอื่น', ' เฉพาะคนเสี่ยงสูง']) assert.equal(commands.detect('สร้างกราฟบุคคลเป้าหมาย สภ.ของฉัน แยกตามประเภท' + suffix).kind, 'help');
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
