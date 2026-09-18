'use strict';

const { createStatisticsService } = require('./statisticService');
const { createMonitoringService } = require('./monitoringService');
const { createPersonService } = require('./personService');

const TYPE_LABELS = { psychiatric: 'ผู้ป่วยจิตเวช', drug_user: 'ผู้เสพ', dealer: 'ผู้ค้า', released: 'ผู้พ้นโทษ' };
const GROUP_LABELS = { station: 'สภ.', subdistrict: 'ตำบล' };

function detectOverview(message) {
  const text = String(message || '').replace(/\s+/g, ' ').trim();
  if (!/(?:ข้อมูล)?ภาพรวม|ภาพรวมข้อมูล|สรุปภาพรวม/.test(text)) return null;
  if (/จังหวัด|ภ\.จว\.?/.test(text)) return { requestedScope: 'province' };
  if (/สภ\.?|สถานี/.test(text)) return { requestedScope: 'station' };
  return { requestedScope: 'current' };
}

function sortedGroups(groups, direction) {
  return [...groups].sort((a, b) => {
    const count = direction === 'asc' ? a.count - b.count : b.count - a.count;
    return count || String(a.name).localeCompare(String(b.name), 'th');
  });
}

function formatOverview(data) {
  const lines = [
    `ภาพรวมข้อมูล • ${data.scopeLabel}`,
    `บุคคลเป้าหมายทั้งหมด ${data.total} คน`,
    'แยกตามประเภท: ' + data.byType.map((row) => `${row.label} ${row.count} คน`).join(' • '),
    `จากบันทึกปัจจุบัน: เสี่ยงสูง ${data.highRisk} คน • เฝ้าระวัง ${data.watch} คน`,
  ];
  const label = GROUP_LABELS[data.groupBy];
  lines.push(`5 อันดับ${label}ที่มีบุคคลเป้าหมายมากที่สุด:`);
  lines.push(...data.top.map((row, i) => `${i + 1}. ${label}${row.name} — ${row.count} คน`));
  lines.push(`5 อันดับ${label}ที่มีบุคคลเป้าหมายน้อยที่สุด (เฉพาะ${label}ที่มีข้อมูล):`);
  lines.push(...data.bottom.map((row, i) => `${i + 1}. ${label}${row.name} — ${row.count} คน`));
  lines.push('สถานะเสี่ยงสูงและเฝ้าระวังอ้างอิงผลเยี่ยมล่าสุดและรายงานผู้ดูแล ไม่ใช่การวินิจฉัยหรือการทำนาย');
  return lines.join('\n');
}

function createOverviewService(db) {
  const statistics = createStatisticsService(db);
  const monitoring = createMonitoringService(db);
  const persons = createPersonService(db);

  function summarize(user, requestedScope = 'current') {
    const groupBy = requestedScope === 'province' || (!user.stationId && requestedScope === 'current') ? 'station' : 'subdistrict';
    const group = persons.groupByLocation(user, { groupBy });
    const stats = statistics.getStatistics(user);
    const high = monitoring.list(user, { level: 'high', pageSize: 1 });
    const watch = monitoring.list(user, { level: 'watch', pageSize: 1 });
    const byType = Object.entries(TYPE_LABELS).map(([type, label]) => ({ type, label, count: Number(stats[type]) || 0 }));
    const scopeLabel = user.stationName || (user.stationId ? `สภ. ${user.stationId}` : 'พื้นที่ที่บัญชีนี้มีสิทธิ์เข้าถึง');
    const data = {
      scopeLabel,
      requestedScope,
      groupBy,
      total: Number(stats.total) || 0,
      byType,
      highRisk: Number(high.total) || 0,
      watch: Number(watch.total) || 0,
      top: sortedGroups(group.groups || [], 'desc').slice(0, 5),
      bottom: sortedGroups(group.groups || [], 'asc').slice(0, 5),
    };
    return { answer: formatOverview(data), presentation: { type: 'overview', ...data } };
  }

  return { summarize };
}

module.exports = { detectOverview, createOverviewService, formatOverview, TYPE_LABELS };
