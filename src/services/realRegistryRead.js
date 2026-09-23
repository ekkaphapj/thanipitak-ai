'use strict';

const { detectMonitoringIntent, isSelectedMonitoringReasonFollowup } = require('../ai/monitoring');
const { parseStationId, applyPeopleStationScope } = require('./stationScope');
const { realPersonTypeIds } = require('./realPersonTypes');

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

function dateInRange(value, { from, to } = {}) {
  const raw = String(value == null ? '' : value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return false;
  if (from && raw < from) return false;
  if (to && raw > to) return false;
  return true;
}

async function optionalRows(rows, req, table, params) {
  try {
    return await rows(req, table, params);
  } catch {
    return { data: [], total: 0 };
  }
}

function createRealRegistryRead(rows) {
  // A time window is applied as server-side date filters on recorded visits.
  // It can only narrow what is read; the station scope stays untouched.
  function applyVisitWindow(params, { from, to } = {}) {
    if (from) params.append('visit_date', `gte.${from}`);
    if (to) params.append('visit_date', `lte.${to}`);
  }

  async function readVisits(req, personId, limit = 20, window = {}) {
    const params = new URLSearchParams({
      select: VISIT_SELECT,
      person_id: `eq.${personId}`,
      order: 'visit_date.desc,visit_time.desc,id.desc',
      limit: String(limit),
    });
    applyVisitWindow(params, window);
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

  async function readDossier(req, personId, personMeta, window = {}) {
    const [visits, report] = await Promise.all([readVisits(req, personId, 20, window), readReport(req, personId)]);
    // With a time window, a guardian report dated outside it must not raise
    // the level shown for that period.
    const windowed = Boolean(window.from || window.to);
    const reportUsable = !windowed || !report || dateInRange(report.last_report_date, window) ? report : null;
    return {
      ...personMeta,
      visits: visits.data,
      visitTotal: visits.total,
      report,
      reportOutsideWindow: Boolean(windowed && report && !reportUsable),
      latestVisit: visits.data[0] || null,
      level: recordedLevel(visits.data[0], reportUsable),
      window: windowed ? window : null,
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
    const window = dossier.window;
    const windowLabel = window?.label || '';
    const wantsVisits = /เยี่ยม|ประวัติ|ครั้ง/.test(message);
    const wantsDrug = /ปัสสาวะ|ฉี่|ตรวจยา|สารเสพติด/.test(message);
    const wantsRisk = /เสี่ยง|เฝ้าระวัง|เพราะ|ทำไม|เหตุผล|สถานะ/.test(message);

    if (wantsDrug && !wantsVisits) {
      if (!latest || !latest.drug_test_result) return `ทะเบียน${window ? `ใน${windowLabel}` : 'ยัง'}ไม่มีผลตรวจยาของ ${name}`;
      return `${name} ผลตรวจยาล่าสุด${window ? `ใน${windowLabel}` : ''} ${latest.drug_test_result} เมื่อ ${visitWhen(latest)}`;
    }
    if (wantsVisits && !wantsRisk) {
      if (window) {
        if (!dossier.visits.length) return `ไม่มีบันทึกการเยี่ยมของ ${name} ใน${windowLabel}`;
        const lines = [`บันทึกการเยี่ยมของ ${name} ใน${windowLabel}: ${dossier.visitTotal} ครั้ง`];
        dossier.visits.slice(0, 8).forEach((visit, index) => lines.push(`${index + 1}. ${formatVisitLine(visit)}`));
        lines.push('ข้อมูลนี้มาจากบันทึกการเยี่ยมในช่วงเวลาที่ระบุเท่านั้น ไม่ใช่การวินิจฉัย');
        return lines.join('\n');
      }
      if (!dossier.visits.length) return `ทะเบียนยังไม่มีประวัติการตรวจเยี่ยมของ ${name}`;
      const lines = [`ประวัติการตรวจเยี่ยมของ ${name} (แสดง ${dossier.visits.length} รายการล่าสุด จาก ${dossier.visitTotal} ครั้ง)`];
      dossier.visits.slice(0, 8).forEach((visit, index) => lines.push(`${index + 1}. ${formatVisitLine(visit)}`));
      lines.push('ข้อมูลนี้มาจากบันทึกการเยี่ยม ไม่ใช่การวินิจฉัย');
      return lines.join('\n');
    }
    if (wantsRisk || /เพราะ|ทำไม|เหตุผล/.test(message)) {
      const lines = [`${name} สถานะจากบันทึก${window ? `ใน${windowLabel}` : 'ปัจจุบัน'}: ${dossier.level}`];
      if (latest) lines.push(`ผลเยี่ยมล่าสุด${window ? `ใน${windowLabel}` : ''} ${visitWhen(latest)}: ${normalizeVisitLevel(latest.visit_status) || 'ไม่ระบุ'}${latest.drug_test_result ? ` • ผลตรวจยา ${latest.drug_test_result}` : ''}`);
      else lines.push(window ? `ยังไม่มีผลเยี่ยมใน${windowLabel}` : 'ยังไม่มีผลเยี่ยมในทะเบียน');
      if (dossier.reportOutsideWindow) lines.push('รายงานผู้ดูแลล่าสุดอยู่นอกช่วงเวลาที่ถาม จึงไม่นำมาพิจารณา');
      else if (report && report.alert_level && report.alert_level !== 'ปกติ') {
        lines.push(`สถานะจากรายงานผู้ดูแล: ${report.alert_level}${report.alert_source && report.alert_source !== 'none' ? ` (แหล่ง ${report.alert_source})` : ''}${report.missed_days ? ` • ขาดรายงาน ${report.missed_days} วัน` : ''}${report.last_report_date ? ` • รายงานล่าสุด ${report.last_report_date}` : ''}`);
      } else if (report) {
        lines.push(`สถานะจากรายงานผู้ดูแล: ${report.alert_level || 'ปกติ'}`);
      }
      lines.push('ระดับนี้อ้างอิงทะเบียนและบันทึก ไม่ใช่การวินิจฉัยหรือการทำนายพฤติกรรม');
      return lines.join('\n');
    }
    return null;
  }

  async function listRecordedMonitoring(req, { level, personType, district, subdistrict, stationIds, page = 1, pageSize = 20, from, to, exclude } = {}) {
    const peopleParams = new URLSearchParams({
      select: 'id,prefix,first_name,last_name,tambon,amphoe,province,type_id,station_id,status',
      order: 'first_name.asc,id.asc',
      limit: '1000',
    });
    const scopedStationId=applyPeopleStationScope(req.user, peopleParams);
    const clean=value=>String(value||'').replace(/[%*(),]/g,'').slice(0,100);
    const narrowedStationIds=[...new Set((stationIds||[]).map(Number).filter(Number.isSafeInteger))];
    if(stationIds!==undefined){
      const allowedIds=scopedStationId?narrowedStationIds.filter(id=>id===scopedStationId):narrowedStationIds;
      peopleParams.set('station_id',`in.(${allowedIds.length?allowedIds.join(','):'0'})`);
    }
    if(district)peopleParams.set('amphoe',`ilike.*${clean(district)}*`);
    if(subdistrict)peopleParams.set('tambon',`ilike.*${clean(subdistrict)}*`);
    for(const ex of exclude||[]){
      if(ex.column==='station_id')peopleParams.append('not.station_id',`in.(${ex.ids.join(',')})`);
      else peopleParams.append(`not.${ex.column}`,`ilike.*${clean(ex.value)}*`);
    }
    if (personType) {
      const ids = await realPersonTypeIds(req, personType, rows);
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
      applyVisitWindow(visitParams, { from, to });
      const visitBatch = await optionalRows(rows, req, 'visits', visitParams);
      for (const visit of visitBatch.data) {
        if (!latest.has(visit.person_id)) latest.set(visit.person_id, visit);
      }
      const reportParams = new URLSearchParams({
        select: 'person_id,alert_level,alert_source,missed_days,last_report_date',
        person_id: `in.(${chunk.join(',')})`,
        limit: '1000',
      });
      // A windowed question counts only guardian reports dated inside it;
      // PostgREST comparisons also drop undated rows, which is the
      // conservative result for a period question.
      if (from) reportParams.append('last_report_date', `gte.${from}`);
      if (to) reportParams.append('last_report_date', `lte.${to}`);
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
        province: (person.province || '').trim(),
        station_id: Number.isFinite(Number(person.station_id)) ? Number(person.station_id) : null,
        level: current,
        latestVisit: visit || null,
        report: report || null,
      });
    }
    // สภ./อำเภอ/จังหวัด context for the list: when every matched person shares
    // one station/area it goes in the header, otherwise it stays per row.
    const stationNames = new Map();
    const ownId = parseStationId(req.user && req.user.stationId);
    if (ownId && req.user.stationName) stationNames.set(ownId, String(req.user.stationName).trim());
    const unknownIds = [...new Set(matched.map((m) => m.station_id).filter((id) => Number.isFinite(id) && !stationNames.has(id)))];
    if (unknownIds.length) {
      const st = await rows(req, 'stations', new URLSearchParams({ select: 'station_id,station_name', station_id: `in.(${unknownIds.join(',')})`, limit: '1000' }));
      for (const row of st.data) stationNames.set(Number(row.station_id), String(row.station_name || '').trim());
    }
    for (const m of matched) m.station_name = m.station_id != null ? (stationNames.get(m.station_id) || null) : null;
    const single = (values) => { const set = new Set(values); return set.size === 1 ? [...set][0] : null; };
    const uniformStationId = single(matched.map((m) => m.station_id).filter((id) => Number.isFinite(id)));
    const scope = {
      stationName: uniformStationId != null && matched.length ? (stationNames.get(uniformStationId) || null) : null,
      district: single(matched.map((m) => (m.district || '').trim()).filter(Boolean)),
      province: single(matched.map((m) => m.province).filter(Boolean)),
    };
    const start = (page - 1) * pageSize;
    return {
      total: matched.length,
      page,
      pageSize,
      asOf: thaiNow(),
      scope,
      ...(from || to ? { window: { from: from || null, to: to || null } } : {}),
      items: matched.slice(start, start + pageSize),
    };
  }

  function formatMonitoringList(result, wanted, { windowLabel } = {}) {
    const label = wanted === 'high' ? 'เสี่ยงสูง' : wanted === 'watch' ? 'เฝ้าระวัง' : 'เฝ้าระวังหรือเสี่ยงสูง';
    if (!result.total) {
      return `ไม่พบบุคคลที่บันทึกว่า${label}${windowLabel ? `ใน${windowLabel}` : ''}ในพื้นที่ที่ท่านมีสิทธิ์เข้าถึง (อ้างอิง${windowLabel ? `บันทึกใน${windowLabel}` : 'ผลเยี่ยมล่าสุดและรายงานผู้ดูแล'} ไม่ใช่การยืนยันว่าไม่มีความเสี่ยง)`;
    }
    const scope = result.scope || {};
    let uniform = '';
    if (scope.stationName) uniform += ` • สังกัด สภ.${String(scope.stationName).replace(/^สภ\.?\s*/u, '')}`;
    if (scope.district) uniform += ` • อำเภอ${scope.district}`;
    if (scope.province) uniform += ` • จังหวัด${scope.province}`;
    const lines = [`พบ ${result.total} คนที่บันทึกว่า${label} ณ ${result.asOf}${uniform}${windowLabel ? ` • ช่วง${windowLabel}` : ''} (แสดงหน้า ${result.page})`];
    result.items.forEach((item, index) => {
      const bits = [`${index + 1 + (result.page - 1) * result.pageSize}. ${item.full_name} — ${item.level}`];
      if (item.subdistrict) bits.push(`ตำบล${item.subdistrict}`);
      // Fields that vary inside the list are shown per row instead.
      const rowPlace = [];
      if (!scope.stationName && item.station_name) rowPlace.push(`สภ.${String(item.station_name).replace(/^สภ\.?\s*/u, '')}`);
      if (!scope.district && item.district) rowPlace.push(`อำเภอ${item.district}`);
      if (!scope.province && item.province) rowPlace.push(`จังหวัด${item.province}`);
      if (rowPlace.length) bits.push(rowPlace.join(' • '));
      if (item.latestVisit) bits.push(`เยี่ยมล่าสุด ${visitWhen(item.latestVisit)}`);
      lines.push(bits.join(' • '));
    });
    lines.push('ระดับนี้อ้างอิงทะเบียนและบันทึก ไม่ใช่การวินิจฉัยหรือการทำนายพฤติกรรม');
    if (windowLabel) lines.push(`อ้างอิงเฉพาะบันทึกที่อยู่ในช่วง${windowLabel} บันทึกนอกช่วงเวลาไม่ถูกนำมาพิจารณา`);
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
