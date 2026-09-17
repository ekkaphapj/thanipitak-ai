'use strict';

const { createPersonService, allowedStationIds } = require('./personService');
const { createMonitoringService } = require('./monitoringService');

const TYPE_LABELS = { psychiatric: 'จิตเวช', drug_user: 'ผู้เสพ', dealer: 'ผู้ค้า', released: 'ผู้พ้นโทษ' };
const TYPE_MARKERS = [
  { type: 'psychiatric', words: ['ผู้ป่วยจิตเวช', 'คนไข้จิตเวช', 'จิตเวช', 'ผู้ป่วย'] },
  { type: 'drug_user', words: ['ผู้ใช้ยาเสพติด', 'คนใช้ยา', 'ผู้เสพ', 'คนเสพ', 'ยาเสพติด'] },
  { type: 'dealer', words: ['ผู้จำหน่าย', 'คนขายยา', 'พ่อค้ายา', 'ผู้ค้า'] },
  { type: 'released', words: ['ออกจากเรือนจำ', 'ออกจากคุก', 'ผู้พ้นโทษ', 'พ้นโทษ'] },
];
const BOUNDARY = '(?=\\s*(?:ใน?จังหวัด|จังหวัด|จ\\.|สภ\\.?|สถานี|อำเภอ|เขต|ตำบล|ชื่อ(?:ว่า)?|ผู้ป่วย|จิตเวช|ผู้เสพ|คนเสพ|ผู้ค้า|ผู้พ้นโทษ|เสี่ยงสูง|เฝ้าระวัง|ทั้งหมด|รายชื่อ|จำนวน|เรียง|$))';

function compact(text) { return String(text || '').replace(/\s+/g, ' ').trim(); }
function extract(text, labels) {
  const escaped = labels.map((item) => item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const match = text.match(new RegExp(`(?:${escaped})\\s*([^,]+?)${BOUNDARY}`, 'u'));
  return match && match[1] ? match[1].trim().replace(/(?:ให้หน่อย|หน่อย|ที|ครับ|ค่ะ|นะ)$/u, '').trim() : null;
}
function parseSummaryIntent(message) {
  const text = compact(message);
  if (!/(?:ช่วย\s*)?สรุป/u.test(text)) return null;
  // Existing compact statistics command stays on get_statistics, which is
  // faster and keeps its established response shape.
  if (/^สรุปจำนวนบุคคลแยกตามประเภท$/u.test(text)) return null;
  const filters = {};
  for (const marker of TYPE_MARKERS) {
    if (marker.words.some((word) => text.includes(word))) { filters.person_type = marker.type; break; }
  }
  if (/เสี่ยง\s*สูง/u.test(text)) filters.level = 'high';
  else if (/เฝ้า\s*ระวัง|เฝ้าดู|จับตา/u.test(text)) filters.level = 'watch';
  else filters.level = 'all';

  const province = extract(text, ['ในจังหวัด', 'จังหวัด', 'จ.']);
  const station = extract(text, ['สภ.', 'สภ', 'สถานี']);
  const district = extract(text, ['อำเภอ', 'เขต']);
  const subdistrict = extract(text, ['ตำบล']);
  // “รายชื่อ” requests a list; it is not a name filter.
  const search = extract(text.replace(/รายชื่อ/g, ''), ['ชื่อว่า', 'ชื่อ']);
  if (province) filters.province = province;
  if (station) filters.station = station;
  if (district) filters.district = district;
  if (subdistrict) filters.subdistrict = subdistrict;
  if (search) filters.search = search;

  const wantsList = /รายชื่อ|มีใครบ้าง/u.test(text);
  const wantsCount = /จำนวน|กี่คน|ยอด|ทั้งหมด/u.test(text) || !wantsList;
  const sort = /เรียง.*(?:มากไปน้อย|จากมาก|สูงไปต่ำ)/u.test(text) ? 'count_desc'
    : /เรียง.*(?:น้อยไปมาก|จากน้อย|ต่ำไปสูง)/u.test(text) ? 'count_asc'
      : /เรียง.*ชื่อ|ตามชื่อ/u.test(text) ? 'name_asc' : 'name_asc';
  const trailing = text.replace(/[,.]+$/u, '').trim();
  const fieldIncomplete = /(?:ใน?จังหวัด|จังหวัด|จ\.|สภ\.?|สถานี|อำเภอ|เขต|ตำบล|ชื่อว่า|คนชื่อ)\s*$/u.test(trailing);
  const bare = /^(?:ช่วย\s*)?สรุป(?:\s*(?:ให้หน่อย|หน่อย|ที|ครับ|ค่ะ|นะ))?$/u.test(text);
  return {
    intent: bare || fieldIncomplete ? 'summary_choices' : 'summary_persons',
    filters,
    includeList: wantsList,
    includeCount: wantsCount,
    sort,
  };
}

function sortCounts(byType, direction) {
  return Object.entries(byType)
    .map(([type, count]) => ({ type, label: TYPE_LABELS[type] || type, count }))
    .sort((a, b) => direction === 'count_asc' ? a.count - b.count || a.label.localeCompare(b.label, 'th') : direction === 'count_desc' ? b.count - a.count || a.label.localeCompare(b.label, 'th') : a.label.localeCompare(b.label, 'th'));
}
function filterLabels(filters) {
  const out = [];
  if (filters.person_type) out.push(TYPE_LABELS[filters.person_type] || filters.person_type);
  if (filters.level === 'high') out.push('เสี่ยงสูง');
  if (filters.level === 'watch') out.push('เฝ้าระวัง');
  if (filters.province) out.push(`จังหวัด${filters.province}`);
  if (filters.station) out.push(`สภ.${filters.station.replace(/^สภ\.?\s*/u, '')}`);
  if (filters.district) out.push(`อำเภอ${filters.district}`);
  if (filters.subdistrict) out.push(`ตำบล${filters.subdistrict}`);
  if (filters.search) out.push(`ชื่อ ${filters.search}`);
  return out;
}
function formatSummary(result) {
  const scope = filterLabels(result.filters);
  const heading = `สรุป${scope.length ? 'ตามเงื่อนไข: ' + scope.join(' • ') : 'บุคคลในพื้นที่ที่ท่านมีสิทธิ์เข้าถึง'}`;
  const lines = [heading, `จำนวนทั้งหมด ${result.total} คน`];
  if (result.includeCount) lines.push(...result.counts.map((item) => `• ${item.label} ${item.count} คน`));
  if (result.includeList) {
    lines.push('', `รายชื่อ${result.items.length < result.total ? ` (แสดง ${result.items.length} จาก ${result.total} คน)` : ''}:`);
    lines.push(...result.items.map((item, index) => `${index + 1}. ${item.full_name} — ${TYPE_LABELS[item.person_type] || item.person_type}${item.level ? ` — ${item.level}` : ''}`));
  }
  lines.push('', 'ต้องการให้สร้างเป็นรายงาน PDF หรือไม่?');
  return lines.join('\n');
}

function createSummaryService(db) {
  const persons = createPersonService(db);
  const monitoring = createMonitoringService(db);

  function locationOptions(user) {
    const ids = allowedStationIds(user);
    const where = ids === null ? '' : ids && ids.length ? `WHERE p.station_id IN (${ids.map(() => '?').join(',')})` : 'WHERE 1=0';
    const params = ids === null ? [] : ids;
    const rows = db.prepare(`SELECT DISTINCT s.name AS station, p.district, p.subdistrict FROM persons p JOIN stations s ON s.id=p.station_id ${where} ORDER BY s.name,p.district,p.subdistrict`).all(...params);
    return {
      stations: [...new Set(rows.map((row) => row.station))],
      districts: [...new Set(rows.map((row) => row.district))],
      subdistricts: [...new Set(rows.map((row) => row.subdistrict))],
    };
  }

  function choices(user, prompt) {
    return {
      answer: prompt || 'ต้องการสรุปแบบใด? เลือกจำนวน รายชื่อ หรือระบุพื้นที่เพิ่มได้',
      toolsUsed: [],
      grounded: true,
      presentation: {
        type: 'summary_choices',
        choices: [
          { label: 'สรุปจำนวนตามประเภท', message: 'สรุปจำนวนบุคคลทุกประเภท' },
          { label: 'สรุปรายชื่อทั้งหมด', message: 'สรุปรายชื่อบุคคลทั้งหมด เรียงตามชื่อ' },
          { label: 'สรุปเสี่ยงสูง', message: 'สรุปจำนวนบุคคลเสี่ยงสูงตามประเภท' },
        ],
        locations: locationOptions(user),
      },
    };
  }

  function summarize(user, request) {
    const filters = { ...(request.filters || {}) };
    const includeList = !!request.includeList;
    const includeCount = request.includeCount !== false;
    const sort = request.sort === 'count_desc' || request.sort === 'count_asc' ? request.sort : 'name_asc';
    const level = filters.level || 'all';
    let total;
    let counts;
    let items;
    if (level === 'high' || level === 'watch') {
      const monitored = monitoring.list(user, {
        level,
        person_type: filters.person_type,
        province: filters.province,
        station: filters.station,
        district: filters.district,
        subdistrict: filters.subdistrict,
        search: filters.search,
        sort: includeList ? 'name_asc' : undefined,
        pageSize: 200,
      });
      total = monitored.total;
      const byType = {};
      for (const item of monitored.items) byType[item.personType] = (byType[item.personType] || 0) + 1;
      counts = sortCounts(byType, sort);
      items = monitored.items.map((item) => ({ full_name: item.displayName, person_type: item.personType, level: item.level }));
    } else {
      const normal = persons.summarizePersons(user, {
        person_type: filters.person_type,
        province: filters.province,
        station: filters.station,
        district: filters.district,
        subdistrict: filters.subdistrict,
        search: filters.search,
        limit: 200,
        offset: 0,
      });
      total = normal.total;
      counts = sortCounts(normal.byType, sort);
      items = normal.rows
        .map((item) => ({ full_name: `${item.first_name} ${item.last_name}`.trim(), person_type: item.person_type }))
        .sort((a, b) => sort === 'name_desc' ? b.full_name.localeCompare(a.full_name, 'th') : a.full_name.localeCompare(b.full_name, 'th'));
    }
    const result = { total, counts, items, filters, includeList, includeCount, sort };
    return {
      answer: formatSummary(result),
      toolsUsed: ['summarize_persons'],
      grounded: true,
      presentation: {
        type: 'summary_result',
        ...result,
        reportRequest: { filters, includeList, includeCount, sort },
      },
    };
  }

  return { choices, summarize };
}

module.exports = { parseSummaryIntent, createSummaryService, TYPE_LABELS };
