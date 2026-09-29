const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const tutorial = require('../frontend/tutorialContent');
const { detectFastPathIntent } = require('../src/ai/fastPath');
const { detectVisitPlanIntent } = require('../src/ai/visitPlanIntent');
const { detectDiscoveryIntent } = require('../src/services/discoveryService');
const chartCommands = require('../frontend/chartCommands');

const examples = { station: 'บ้านดุง', province: 'อุดรธานี', otherProvince: 'นครพนม', district: 'เมือง', subdistrict: 'โพนสูง', name: 'สมชาย' };
const fill = (prompt) => prompt.replace(/\{([a-z]+)\}/giu, (_match, key) => examples[key.toLowerCase()]);

test('tutorial lessons cover basic, complex, analysis, visit-plan, and chart workflows', () => {
  const groups = new Set(tutorial.steps.map((step) => step.group));
  for (const group of ['เริ่มต้น', 'ค้นหาและเงื่อนไข', 'วิเคราะห์ข้อมูล', 'แผนตรวจเยี่ยม', 'แผนภูมิ']) {
    assert.ok(groups.has(group), `tutorial has the ${group} section`);
  }
  assert.ok(tutorial.steps.length >= 25);
  assert.ok(tutorial.guideSections.some(([title]) => title === 'วิเคราะห์ข้อมูล'));
  assert.ok(tutorial.guideSections.some(([title]) => title === 'แผนตรวจเยี่ยม'));
  assert.ok(tutorial.guideSections.some(([title]) => title === 'แผนภูมิ'));
  assert.ok(tutorial.quickExamples.includes('วิเคราะห์ภาระงาน'));
  assert.doesNotMatch(JSON.stringify(tutorial), /ทดสอบ5|ตำบลจำลอง/);
  const html = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'ai.html'), 'utf8');
  assert.ok(html.indexOf('tutorialContent.js') < html.indexOf('ai.js'), 'tutorial data loads before the chat app');
});

test('every tutorial prompt matches its own progression pattern after filling sample values', () => {
  for (const step of tutorial.steps) {
    const prompt = fill(step.prompt);
    assert.match(prompt, step.matches, `${step.group} / ${step.title}: ${prompt}`);
    if (step.requiresMatch) assert.match(prompt, step.requiresMatch, `${step.group} / ${step.title} needs the placeholder filled`);
  }
});

test('analysis, visit-plan, and chart examples use executable command grammars', () => {
  for (const title of ['วิเคราะห์ภาระงาน', 'ตรวจคุณภาพข้อมูล', 'เปรียบเทียบพื้นที่', 'ดูสถานะผลการดำเนินงาน', 'ถามข้อสังเกตจากข้อมูล']) {
    const step = tutorial.steps.find((item) => item.title === title);
    assert.ok(step);
    assert.ok(detectDiscoveryIntent(fill(step.prompt)), `${title} routes to aggregate analysis`);
  }

  const plan = tutorial.steps.find((item) => item.title === 'ดูแผนตรวจเยี่ยมของสถานี');
  assert.ok(detectVisitPlanIntent(fill(plan.prompt)));

  const chart = (title) => tutorial.steps.find((item) => item.title === title);
  assert.equal(chartCommands.detect(fill(chart('เปิดคู่มือสร้างแผนภูมิ').prompt)).kind, 'help');
  assert.equal(chartCommands.detect(fill(chart('สร้างแผนภูมิบุคคลเป้าหมาย').prompt)).kind, 'people');
  assert.equal(chartCommands.detect(fill(chart('สร้างแผนภูมิเปรียบเทียบราย สภ.').prompt)).kind, 'people');
  assert.equal(chartCommands.detect(fill(chart('ขอแผนภูมิของจังหวัดอื่น').prompt)).otherProvince, true);
  assert.equal(chartCommands.detect(fill(chart('สร้างแผนภูมิการตรวจเยี่ยมรายเดือน').prompt)).kind, 'visits');
  assert.equal(chartCommands.detect(fill(chart('สร้างแผนภูมิการตรวจเยี่ยมรายจังหวัด').prompt)).kind, 'visits');
  assert.equal(tutorial.steps.find((item) => item.title === 'สร้าง PDF จากแผนภูมิล่าสุด').needs, 'chart');
});

test('basic and complex examples retain deterministic type, place, grouping, and prerequisite routing', () => {
  const count = detectFastPathIntent(fill(tutorial.steps.find((item) => item.title === 'นับจำนวนตามประเภท').prompt));
  assert.equal(count.intent, 'count_drug_user');

  const area = detectFastPathIntent(fill(tutorial.steps.find((item) => item.title === 'กรองด้วยอำเภอและจังหวัด').prompt));
  assert.equal(area.intent, 'list_drug_user');
  assert.equal(area.filters.district, examples.district);
  assert.equal(area.filters.province, examples.province);

  const group = detectFastPathIntent(fill(tutorial.steps.find((item) => item.title === 'แยกยอดตามตำบล').prompt));
  assert.equal(group.intent, 'group_persons');
  assert.equal(group.groupBy, 'subdistrict');

  assert.equal(tutorial.steps.find((item) => item.title === 'เลื่อนหน้าแผน').needs, 'visit_plan');
  assert.equal(tutorial.steps.find((item) => item.title === 'ส่งออกรายงานจากรายการ').needs, 'list');
  assert.equal(tutorial.steps.find((item) => item.title === 'เปิดข้อมูลรายการที่เลือก').needs, 'selection');
});
