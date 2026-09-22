'use strict';

const { createStatisticsService } = require('./statisticService');
const { createMonitoringService } = require('./monitoringService');
const { createPersonService } = require('./personService');

const TYPE_LABELS = { psychiatric: 'ผู้ป่วยจิตเวช', drug_user: 'ผู้เสพ', dealer: 'ผู้ค้า', released: 'ผู้พ้นโทษ' };
const GROUP_LABELS = { station: 'สภ.', subdistrict: 'ตำบล' };

function detectOverview(message) {
  const text = String(message || '').replace(/\s+/g, ' ').trim();
  const person_type=/ผู้ป่วยจิตเวช|จิตเวช|ผู้ป่วย/.test(text)?'psychiatric':/ผู้เสพ|ผู้ใช้ยา|ยาเสพติด/.test(text)?'drug_user':/ผู้ค้า|ผู้จำหน่าย/.test(text)?'dealer':/ผู้พ้นโทษ|พ้นโทษ/.test(text)?'released':null;
  // Spoken “ขอข้อมูลผู้เสพ” is a category overview, not an open-ended
  // person lookup. A known explicit category is required for this shortcut.
  const overviewWords = /(?:ข้อมูล)?ภาพรวม|ภาพรวมข้อมูล|สรุปภาพรวม/.test(text);
  const typeDataRequest = Boolean(person_type && /(?:ขอ|แสดง|ดู)\s*(?:ข้อมูล|รายละเอียด)(?:ของ)?/.test(text));
  if (!overviewWords && !typeDataRequest) return null;
  const subdistrict=text.match(/ตำบล\s*([^\s,]+)/u)?.[1];
  const district=text.match(/(?:อำเภอ|เขต)\s*([^\s,]+)/u)?.[1];
  // Speech-to-text commonly renders สภ. as "สพ", "สอพอ" or "สภอ".  A
  // named station is more specific than a province mentioned in the same
  // sentence, so keep it as a filter and never let the province win.
  const stationCandidate=text.match(/(?:สภ\.?|สพ\.?|สอพอ\.?|สภอ\.?|สถานี(?:ตำรวจ)?)\s*([ก-๙A-Za-z0-9.-]{2,80}?)(?=\s*(?:จังหวัด|จ\.|อำเภอ|เขต|ตำบล|มี|กี่|ทั้งหมด|$))/u)?.[1];
  const station=stationCandidate&&!/^(?:ใน|ของ|แต่ละ|ราย|ทั้งหมด)$/u.test(stationCandidate)?stationCandidate:null;
  const filters={};if(person_type)filters.person_type=person_type;if(subdistrict&&!/^(?:ไหน|ใด|ต่างๆ)$/u.test(subdistrict))filters.subdistrict=subdistrict;if(district)filters.district=district;if(station)filters.station=station;
  if (station) return { requestedScope: 'station',filters };
  if (/จังหวัด|ภ\.จว\.?/.test(text)) return { requestedScope: 'province',filters };
  return { requestedScope: 'current',filters };
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

  function summarize(user, request = {}) {
    const requestedScope=typeof request==='string'?request:(request.requestedScope||'current');
    const filters=(typeof request==='object'&&request.filters)||{};
    if(filters.subdistrict&&!filters.district){
      const matches=persons.groupByLocation(user,{groupBy:'subdistrict'}).groups.filter(row=>row.name===filters.subdistrict);
      if(matches.length>1){
        const choices=matches.slice(0,5).map((row,index)=>({label:`${index+1}. ตำบล${row.name} อำเภอ${row.district||'ไม่ระบุ'} จังหวัด${row.province||'ไม่ระบุ'}`,message:`ขอภาพรวม${filters.person_type?TYPE_LABELS[filters.person_type]:''} ตำบล${row.name} อำเภอ${row.district}`}));
        return {answer:'พบชื่อตำบลซ้ำ กรุณาเลือกพื้นที่ที่ต้องการ',presentation:{type:'summary_choices',choices,pendingOverview:true}};
      }
    }
    const groupBy = requestedScope === 'province' || (!user.stationId && requestedScope === 'current') ? 'station' : 'subdistrict';
    const group = persons.groupByLocation(user, { groupBy,...filters });
    const summary=persons.summarizePersons(user,{...filters,limit:1,offset:0});
    const high = monitoring.list(user, { ...filters,level: 'high', pageSize: 1 });
    const watch = monitoring.list(user, { ...filters,level: 'watch', pageSize: 1 });
    const byType = Object.entries(TYPE_LABELS).map(([type, label]) => ({ type, label, count: Number(summary.byType[type]) || 0 }));
    const scopeLabel = filters.subdistrict?`ตำบล${filters.subdistrict}${filters.district?` อำเภอ${filters.district}`:''}`:(user.stationName || (user.stationId ? `สภ. ${user.stationId}` : 'พื้นที่ที่บัญชีนี้มีสิทธิ์เข้าถึง'));
    const data = {
      scopeLabel,
      requestedScope,
      groupBy,
      total: Number(summary.total) || 0,filters,
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
