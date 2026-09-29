'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { writeChartPdf, validatedChart } = require('../src/services/chartPdf');

test('chart PDF validation refuses empty, negative, non-integer or inconsistent data', () => {
  assert.throws(() => validatedChart({ labels: [], values: [] }), { code: 'REAL_DATA_UNVERIFIABLE' });
  assert.throws(() => validatedChart({ labels: ['ก'], values: [-1] }), { code: 'REAL_DATA_UNVERIFIABLE' });
  assert.throws(() => validatedChart({ labels: ['ก'], values: [1.5] }), { code: 'REAL_DATA_UNVERIFIABLE' });
  assert.throws(() => validatedChart({ labels: ['ก'], values: [2], total: 3 }), { code: 'REAL_DATA_UNVERIFIABLE' });
  assert.throws(() => validatedChart(null), { code: 'REAL_DATA_UNVERIFIABLE' });
  const ok = validatedChart({ title: 'ทดสอบ', labels: ['ก', 'ข'], values: [1, 2], unit: 'คน', chartType: 'bar' });
  assert.equal(ok.total, 3);
  assert.equal(ok.chartType, 'bar');
});

test('writeChartPdf renders a bar chart and a monthly line chart with the Thai font', async () => {
  for (const chart of [
    { title: 'บุคคลเป้าหมายราย สภ. • จังหวัดทดสอบ', chartType: 'bar', labels: ['สภ.เมือง', 'สภ.บ้านดุง', 'สภ.ท่าอุเทน'], values: [12, 7, 3], unit: 'คน', total: 22, areaLabel: 'จังหวัดทดสอบ', dataSource: 'real' },
    { title: 'การตรวจเยี่ยมรายเดือน • สภ.ทดสอบ', chartType: 'line', labels: ['ก.ค. 2569', 'ส.ค. 2569', 'ก.ย. 2569'], values: [5, 9, 2], unit: 'ครั้ง', total: 16, from: '2026-07-01', to: '2026-09-28', windowLabel: 'ไตรมาสล่าสุด', note: 'เดือนล่าสุดยังไม่เต็มเดือน', dataSource: 'real' },
  ]) {
    const report = await writeChartPdf(chart);
    assert.ok(fs.statSync(report.path).size > 2000, 'PDF should not be empty');
    const bytes = fs.readFileSync(report.path);
    assert.match(bytes.toString('latin1').slice(0, 2000), /%PDF-/);
    fs.unlinkSync(report.path);
  }
});
