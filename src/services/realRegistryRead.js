'use strict';

const { detectMonitoringIntent, isSelectedMonitoringReasonFollowup } = require('../ai/monitoring');
const { applyPeopleStationScope } = require('./stationScope');

const VISIT_SELECT = 'id,person_id,visit_date,visit_time,visit_status,drug_test_result,status_condition,notes,visitor_name,visitor_station,visit_category';
const HIGH = 'เสี่ยงสูง';
const WATCH = 'เฝ้าระวัง';

function personName(person) {
  return `${person.prefix || ''}${person.first_name || ''} ${person.last_name || ''}`.replace(/\s+/g, ' ').trim() || 'บุคคลที่เลือก';
}

function visitWhen(visit) {
  return `${visit.visit_date || '-'}${visit.visit_time ? ` ${String(visit.visit_time).slice(0, 5)}` : ''}`;
}

function clipNote(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  return text.length > 180 ? `${text.slice(0, 180)}…` : text;
}

function normalizeVisitLevel(status) {
  const value = String(status || '').trim();
  if (value === 'อาการปกติ') return 'ปกติ';
  return value || '';
}

function recordedLevel(latestVisit, report) {
  const visitLevel = normalizeVisitLevel(latestVisit && latestVisit.visit_status);
  const reportLevel = report && report.alert_level;
  if (visitLevel === HIGH || reportLevel === HIGH) return HIGH;
  if (visitLevel === WATCH || reportLevel === WATCH) return WATCH;
  return visitLevel || reportLevel || 'ไม่ระบุจากบันทึกปัจจุบัน';
}

function matchesLevel(level, wanted) {
  if (!wanted || wanted === 'all') return level === HIGH || level === WATCH;
  if (wanted === 'high') return level === HIGH;
  if (wanted === 'watch') return level === WATCH;
  return false;
}

async function optionalRows(rows, req, table, params) {
  try {
    return await rows(req, table, params);
  } catch {
    return { data: [], total: 0 };
  }
}

function createRealRegistryRead(rows) {
  async function readVisits(req, personId, limit = 20) {
    const params = new URLSearchParams({
      select: VISIT_SELECT,
      person_id: `eq.${personId}`,
      order: 'visit_date.desc,visit_time.desc,id.desc',
      limit: String(limit),
    });
    return optionalRows(rows, req, 'visits', params);
  }

  async function readReport(req, personId) {
    const params = new URLSearchParams({
      select: 'person_id,alert_level,alert_source,missed_days,last_report_date,since',
      person_id: `eq.${personId}`,
      limit: '1',
    });
    const found = await optionalRows(rows, req, 'person_report_status', params);
    return found.data[0] || null;
  }

  async function readDossier(req, personId, personMeta) {
    const [visits, report] = await Promise.all([readVisits(req, personId, 20), readReport(req, personId)]);
    return {
      ...personMeta,
      visits: visits.data,
      visitTotal: visits.total,
      report,
      latestVisit: visits.data[0] || null,
      level: recordedLevel(visits.data[0], report),
    };
  }

  function formatVisitLine(visit) {
    const bits = [visitWhen(visit)];
    if (visit.visit_status) bits.push(normalizeVisitLevel(visit.visit_status));
    if (visit.drug_test_result) bits.push(`ผลตรวจยา: ${visit.drug_test_result}`);
    if (visit.status_condition) bits.push(clipNote(visit.status_condition));
    const note = clipNote(visit.notes);
    if (note) bits.push(`หมายเหตุ: ${note}`);
    if (visit.visitor_name) bits.push(`ผู้เยี่ยม ${visit.visitor_name}`);
    return bits.join(' — ');
  }

  function formatDossier(dossier, message) {
    const name = personName(dossier.person);
    const latest = dossier.latestVisit;
    const report = dossier.report;
    const wantsVisits = /เยี่ยม|ประวัติ|ครั้ง/.test(message);
    const wantsDrug = /ปัสสาวะ|ฉี่|ตรวจยา|สารเสพติด/.test(message);
    const wantsRisk = /เสี่ยง|เฝ้าระวัง|เพราะ|ทำไม|เหตุผล|สถานะ/.test(message);

    if (wantsDrug && !wantsVisits) {
      if (!latest || !latest.drug_test_result) return `ทะเบียนยังไม่มีผลตรวจยาของ ${name}`;
      return `${name} ผลตรวจยาล่าสุด ${latest.drug_test_result} เมื่อ ${visitWhen(latest)}`;
    }
    if (wantsVisits && !wantsRisk) {
      if (!dossier.visits.length) return `ทะเบียนยังไม่มีประวัติการตรวจเยี่ยมของ ${name}`;
      const lines = [`ประวัติการตรวจเยี่ยมของ ${name} (แสดง ${dossier.visits.length} รายการล่าสุด จาก ${dossier.visitTotal} ครั้ง)`];
      dossier.visits.slice(0, 8).forEach((visit, index) => lines.push(`${index + 1}. ${formatVisitLine(visit)}`));
      lines.push('ข้อมูลนี้มาจากบันทึกการเยี่ยม ไม่ใช่การวินิจฉัย');
      return lines.join('\n');
    }
    if (wantsRisk || /เพราะ|ทำไม|เหตุผล/.test(message)) {
      const lines = [`${name} สถานะจากบันทึกปัจจุบัน: ${dossier.level}`];
      if (latest) lines.push(`ผลเยี่ยมล่าสุด ${visitWhen(latest)}: ${normalizeVisitLevel(latest.visit_status) || 'ไม่ระบุ'}${latest.drug_test_result ? ` • ผลตรวจยา ${latest.drug_test_result}` : ''}`);
      else lines.push('ยังไม่มีผลเยี่ยมในทะเบียน');
      if (report && report.alert_level && report.alert_level !== 'ปกติ') {
        lines.push(`สถานะจากรายงานผู้ดูแล: ${report.alert_level}${report.alert_source && report.alert_source !== 'none' ? ` (แหล่ง ${report.alert_source})` : ''}${report.missed_days ? ` • ขาดรายงาน ${report.missed_days} วัน` : ''}${report.last_report_date ? ` • รายงานล่าสุด ${report.last_report_date}` : ''}`);
      } else if (report) {
        lines.push(`สถานะจากรายงานผู้ดูแล: ${report.alert_level || 'ปกติ'}`);
      }
      lines.push('ระดับนี้อ้างอิงทะเบียนและบันทึก ไม่ใช่การวินิจฉัยหรือการทำนายพฤติกรรม');
      return lines.join('\n');
    }
    return null;
  }

  async function listRecordedMonitoring(req, { level, personType, page = 1, pageSize = 20 } = {}) {
    const peopleParams = new URLSearchParams({
      select: 'id,prefix,first_name,last_name,tambon,amphoe,type_id,station_id,status',
      order: 'first_name.asc,id.asc',
      limit: '1000',
    });
    applyPeopleStationScope(req.user, peopleParams);
    if (personType) {
      const terms = { psychiatric: 'ผู้ป่วยจิตเวช', drug_user: 'ผู้เสพ', dealer: 'ผู้ค้า', released: 'พ้นโทษ' };
      const types = await rows(req, 'people_type', new URLSearchParams({ select: 'type_id', type_name: `ilike.*${terms[personType]}*`, limit: '1000' }));
      const ids = types.data.map((row) => row.type_id);
      if (!ids.length) return { total: 0, items: [], page, pageSize, asOf: thaiNow() };
      peopleParams.set('type_id', `in.(${ids.join(',')})`);
    }
    const people = await rows(req, 'people', peopleParams);
    const ids = people.data.map((row) => row.id);
    const byId = new Map(people.data.map((row) => [row.id, row]));
    const latest = new Map();
    const reports = new Map();
    for (let i = 0; i < ids.length; i += 80) {
      const chunk = ids.slice(i, i + 80);
      const visitParams = new URLSearchParams({
        select: VISIT_SELECT,
        person_id: `in.(${chunk.join(',')})`,
        order: 'visit_date.desc,visit_time.desc,id.desc',
        limit: '1000',
      });
      const visitBatch = await optionalRows(rows, req, 'visits', visitParams);
      for (const visit of visitBatch.data) {
        if (!latest.has(visit.person_id)) latest.set(visit.person_id, visit);
      }
      const reportParams = new URLSearchParams({
        select: 'person_id,alert_level,alert_source,missed_days,last_report_date',
        person_id: `in.(${chunk.join(',')})`,
        limit: '1000',
      });
      const reportBatch = await optionalRows(rows, req, 'person_report_status', reportParams);
      for (const row of reportBatch.data) reports.set(row.person_id, row);
    }
    const matched = [];
    for (const id of ids) {
      const visit = latest.get(id);
      const report = reports.get(id);
      const current = recordedLevel(visit, report);
      if (!matchesLevel(current, level)) continue;
      const person = byId.get(id);
      matched.push({
        person_id: id,
        full_name: personName(person),
        subdistrict: person.tambon || '',
        district: person.amphoe || '',
        level: current,
        latestVisit: visit || null,
        report: report || null,
      });
    }
    const start = (page - 1) * pageSize;
    return {
      total: matched.length,
      page,
      pageSize,
      asOf: thaiNow(),
      items: matched.slice(start, start + pageSize),
    };
  }

  function formatMonitoringList(result, wanted) {
    const label = wanted === 'high' ? 'เสี่ยงสูง' : wanted === 'watch' ? 'เฝ้าระวัง' : 'เฝ้าระวังหรือเสี่ยงสูง';
    if (!result.total) {
      return `ไม่พบบุคคลที่บันทึกว่า${label}ในพื้นที่ที่ท่านมีสิทธิ์เข้าถึง (อ้างอิงผลเยี่ยมล่าสุดและรายงานผู้ดูแล ไม่ใช่การยืนยันว่าไม่มีความเสี่ยง)`;
    }
    const lines = [`พบ ${result.total} คนที่บันทึกว่า${label} ณ ${result.asOf} (แสดงหน้า ${result.page})`];
    result.items.forEach((item, index) => {
      const bits = [`${index + 1 + (result.page - 1) * result.pageSize}. ${item.full_name} — ${item.level}`];
      if (item.subdistrict) bits.push(`ตำบล${item.subdistrict}`);
      if (item.latestVisit) bits.push(`เยี่ยมล่าสุด ${visitWhen(item.latestVisit)}`);
      lines.push(bits.join(' • '));
    });
    lines.push('ระดับนี้อ้างอิงทะเบียนและบันทึก ไม่ใช่การวินิจฉัยหรือการทำนายพฤติกรรม');
    return lines.join('\n');
  }

  return { readDossier, formatDossier, listRecordedMonitoring, formatMonitoringList };
}

function thaiNow() {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date());
}

function monitoringQuestion(message) {
  return detectMonitoringIntent(message);
}

function selectedReasonFollowup(message) {
  return isSelectedMonitoringReasonFollowup(message);
}

module.exports = {
  createRealRegistryRead,
  monitoringQuestion,
  selectedReasonFollowup,
  recordedLevel,
};
