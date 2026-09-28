'use strict';
const TYPES = [['psychiatric_total', 'ผู้ป่วยจิตเวช'], ['drug_user_total', 'ผู้เสพ'], ['dealer_total', 'ผู้ค้า'], ['released_total', 'ผู้พ้นโทษ']];
function count(value) {
  if (value === null || value === '' || !['number', 'string'].includes(typeof value) || !Number.isSafeInteger(Number(value)) || Number(value) < 0) {
    const error = new Error('invalid aggregate count'); error.code = 'REAL_DATA_UNVERIFIABLE'; throw error;
  }
  return Number(value);
}
function presentation(title, labels, values, unit, extra = {}) {
  const total = count(values.reduce((a, b) => a + b, 0));
  return { type: 'chart', chartType: unit === 'ครั้ง' ? 'line' : 'bar', title, labels, values, unit, total, asOf: new Date().toISOString(), ...extra };
}
function peopleChart(result, { own, areaLabel, source = 'real' }) {
  const rows = result.rows.map(row => {
    const values = TYPES.map(([field]) => count(row[field]));
    const total = count(row.target_total);
    if (values.reduce((a, b) => a + b, 0) !== total) { const e = new Error('aggregate total mismatch'); e.code = 'REAL_DATA_UNVERIFIABLE'; throw e; }
    return { label: String(row.station_name || 'ไม่ระบุ สภ.'), values, total };
  });
  const labels = own ? TYPES.map(([, label]) => label) : rows.map(row => row.label);
  const values = own ? TYPES.map((_, index) => rows.reduce((sum, row) => sum + row.values[index], 0)) : rows.map(row => row.total);
  return presentation(`บุคคลเป้าหมาย${own ? 'แยกตามประเภท' : 'ราย สภ.'} • ${areaLabel}`, labels, values, 'คน', { dataSource: source, areaLabel });
}
function visitsChart(data, windowLabel) {
  const values = data.months.map(month => month.byType.reduce((sum, row) => sum + count(row.count), 0));
  if (values.reduce((a, b) => a + b, 0) !== count(data.total)) { const e = new Error('visit aggregate mismatch'); e.code = 'REAL_DATA_UNVERIFIABLE'; throw e; }
  return presentation(`การตรวจเยี่ยมรายเดือน • ${data.areaLabel}`, data.months.map(m => m.label), values, 'ครั้ง', {
    dataSource: 'real', areaLabel: data.areaLabel, from: data.from, to: data.to, windowLabel,
    note: data.periodPartial ? 'เดือนต้นช่วงหรือเดือนล่าสุดอาจยังไม่เต็มเดือน' : '',
  });
}
function response(chart) {
  return { answer: `${chart.title}\nรวม ${chart.total} ${chart.unit}${chart.from ? `\nช่วง ${chart.from} ถึง ${chart.to}` : ''}${chart.dataSource === 'test' ? '\nข้อมูลทดสอบ' : ''}`, presentation: chart, grounded: true, dataSource: chart.dataSource, meta: { fastPath: true, ollamaCalls: 0 } };
}
module.exports = { peopleChart, visitsChart, response };
