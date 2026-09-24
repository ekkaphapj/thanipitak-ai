'use strict';

// Deterministic, read-only aggregate over recorded visits. It reads only the
// allowlisted `people`, `people_type`, `stations` and `visits` tables with the
// authenticated user token, applies the same station scope as every other
// real-data read, and never accepts a station/type/scope from the client.
const { applyPeopleStationScope, personInOwnStation } = require('./stationScope');

const MONTHS_TH = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
const TYPE_LABELS = { psychiatric: 'ผู้ป่วยจิตเวช', drug_user: 'ผู้เสพ', dealer: 'ผู้ค้า', released: 'บุคคลพ้นโทษ', other: 'อื่น ๆ' };
const TYPE_SHORT = { psychiatric: 'จิตเวช', drug_user: 'ผู้เสพ', dealer: 'ผู้ค้า', released: 'พ้นโทษ', other: 'อื่น ๆ' };
const DEFAULT_TYPES = ['psychiatric', 'drug_user', 'dealer', 'released'];
const MAX_MONTHS = 24;
const MAX_PEOPLE = 20000;
const MAX_VISITS = 20000;
const PEOPLE_PAGES = 20;
const VISIT_CHUNK = 100;

function categoryOfTypeName(name) {
  if (/จิตเวช/u.test(name)) return 'psychiatric';
  if (/ผู้เสพ|ใช้ยา|ยาเสพติด/u.test(name)) return 'drug_user';
  if (/ผู้ค้า|จำหน่าย/u.test(name)) return 'dealer';
  if (/พ้นโทษ|เรือนจำ/u.test(name)) return 'released';
  return 'other';
}

function tooLarge(message) {
  const error = new Error(message);
  error.code = 'REAL_VISIT_STATS_TOO_LARGE';
  error.answer = message;
  return error;
}

function monthsFromWindow(from, to, preset) {
  if (Array.isArray(preset) && preset.length && preset.length <= MAX_MONTHS
    && preset.every((item) => Number.isInteger(item.y) && Number.isInteger(item.m) && item.m >= 1 && item.m <= 12)) {
    return preset.map(({ y, m }) => ({ key: `${y}-${String(m).padStart(2, '0')}`, label: `${MONTHS_TH[m - 1]} ${y + 543}` }));
  }
  const start = String(from || '').slice(0, 7).split('-').map(Number);
  const end = String(to || '').slice(0, 7).split('-').map(Number);
  if (!Number.isInteger(start[0]) || !Number.isInteger(end[0])) return [];
  const months = [];
  let [y, m] = start;
  while ((y * 12 + m) <= (end[0] * 12 + (end[1] || 1)) && months.length <= MAX_MONTHS) {
    months.push({ key: `${y}-${String(m).padStart(2, '0')}`, label: `${MONTHS_TH[m - 1]} ${y + 543}` });
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return months;
}

function createRealVisitStatsTool(rows) {
  return async function readVisitStats(req, {
    stationIds = null, province = null, areaLabel = null, from, to, months = null, types = null,
  } = {}) {
    if (!req.realToken) { const error = new Error('missing authenticated session'); error.code = 'REAL_ACCESS_DENIED'; throw error; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(from)) || !/^\d{4}-\d{2}-\d{2}$/.test(String(to)) || from > to) {
      throw new Error('ช่วงเวลาไม่ถูกต้อง');
    }

    // People in scope: the station filter is resolved from the stations
    // catalogue (or the verified own-station id), never from request bodies.
    const peopleParams = new URLSearchParams({ select: 'id,type_id,station_id', order: 'id.asc', limit: '1000' });
    const ownStationId = applyPeopleStationScope(req.user, peopleParams);
    if (stationIds !== null) {
      const ids = [...new Set((stationIds || []).map(Number).filter((id) => Number.isSafeInteger(id)))];
      const allowed = ownStationId ? ids.filter((id) => id === ownStationId) : ids;
      peopleParams.set('station_id', `in.(${allowed.length ? allowed.join(',') : '0'})`);
    } else if (province && !ownStationId) {
      // A province filter follows the registered station of the person, so it
      // is resolved through stations.province — the authoritative source.
      const clean = String(province).replace(/[%*(),]/g, '').slice(0, 100);
      const stations = await rows(req, 'stations', new URLSearchParams({ select: 'station_id', province: `eq.${clean}`, limit: '1000' }));
      const ids = stations.data.map((row) => Number(row.station_id)).filter(Number.isSafeInteger);
      peopleParams.set('station_id', `in.(${ids.length ? ids.join(',') : '0'})`);
    }
    const people = [];
    let peopleTotal = null;
    for (let page = 0; page < PEOPLE_PAGES; page += 1) {
      peopleParams.set('offset', String(people.length));
      const batch = await rows(req, 'people', peopleParams);
      if (peopleTotal !== null && peopleTotal !== batch.total) { const error = new Error('ข้อมูลเปลี่ยนระหว่างนับ กรุณาถามใหม่'); error.code = 'REAL_DATA_UNVERIFIABLE'; throw error; }
      peopleTotal = batch.total;
      if (peopleTotal > MAX_PEOPLE) throw tooLarge('ขอบเขตนี้มีบุคคลในทะเบียนมากเกินกว่าจะสรุปได้ในครั้งเดียว กรุณาระบุ สภ. หรือช่วงเวลาที่สั้นลง');
      people.push(...batch.data.filter((person) => personInOwnStation(req.user, person)));
      if (people.length >= peopleTotal || !batch.data.length) break;
    }
    if (people.length < peopleTotal) throw tooLarge('ขอบเขตนี้มีบุคคลในทะเบียนมากเกินกว่าจะสรุปได้ในครั้งเดียว กรุณาระบุ สภ. หรือช่วงเวลาที่สั้นลง');

    // Registry type names → the four report categories (plus "other").
    const typeIds = [...new Set(people.map((person) => Number(person.type_id)).filter(Number.isSafeInteger))];
    const categoryById = new Map();
    if (typeIds.length) {
      const found = await rows(req, 'people_type', new URLSearchParams({ select: 'type_id,type_name', type_id: `in.(${typeIds.join(',')})`, limit: '1000' }));
      for (const row of found.data) categoryById.set(Number(row.type_id), categoryOfTypeName(String(row.type_name || '')));
    }
    const categoryOf = new Map(people.map((person) => [person.id, categoryById.get(Number(person.type_id)) || 'other']));

    const monthList = monthsFromWindow(from, to, months);
    if (!monthList.length) throw tooLarge('ช่วงเวลาที่ขอยาวเกินที่รองรับ (สูงสุด 24 เดือน) กรุณาระบุช่วงที่สั้นกว่า');
    const monthIndex = new Map(monthList.map((month) => [month.key, month]));
    const monthTotals = new Map(monthList.map((month) => [month.key, 0]));
    const monthByType = new Map(monthList.map((month) => [month.key, new Map()]));
    const totals = new Map();
    let totalAll = 0;
    let visitsCounted = 0;
    const visitedPeople = new Set();

    const ids = people.map((person) => Number(person.id)).filter(Number.isSafeInteger);
    for (let index = 0; index < ids.length; index += VISIT_CHUNK) {
      const chunk = ids.slice(index, index + VISIT_CHUNK);
      const visitParams = new URLSearchParams({
        select: 'id,person_id,visit_date', order: 'id.asc', limit: '1000', person_id: `in.(${chunk.join(',')})`,
      });
      visitParams.append('visit_date', `gte.${from}`);
      visitParams.append('visit_date', `lte.${to}`);
      let offset = 0;
      let chunkTotal = null;
      const seen = new Set();
      for (let page = 0; page < 25; page += 1) {
        visitParams.set('offset', String(offset));
        const batch = await rows(req, 'visits', visitParams);
        if (chunkTotal !== null && chunkTotal !== batch.total) { const error = new Error('ข้อมูลเปลี่ยนระหว่างนับ กรุณาถามใหม่'); error.code = 'REAL_DATA_UNVERIFIABLE'; throw error; }
        chunkTotal = batch.total;
        for (const visit of batch.data) {
          const id = Number(visit.id);
          if (!Number.isSafeInteger(id) || seen.has(id)) { const error = new Error('ข้อมูลซ้ำระหว่างนับ กรุณาถามใหม่'); error.code = 'REAL_DATA_UNVERIFIABLE'; throw error; }
          seen.add(id);
          const personId = Number(visit.person_id);
          const category = categoryOf.get(personId);
          if (!category) continue; // a visit whose person is not in the scoped registry set
          const monthKey = String(visit.visit_date || '').slice(0, 7);
          if (!/^\d{4}-\d{2}$/.test(monthKey) || !monthIndex.has(monthKey)) continue;
          totalAll += 1;
          visitedPeople.add(personId);
          totals.set(category, (totals.get(category) || 0) + 1);
          monthTotals.set(monthKey, monthTotals.get(monthKey) + 1);
          const typeMap = monthByType.get(monthKey);
          typeMap.set(category, (typeMap.get(category) || 0) + 1);
        }
        offset += batch.data.length;
        visitsCounted += batch.data.length;
        if (visitsCounted > MAX_VISITS) throw tooLarge('ช่วงเวลานี้มีบันทึกการตรวจเยี่ยมมากเกินกว่าจะสรุปได้ในครั้งเดียว กรุณาระบุ สภ. หรือช่วงเวลาที่สั้นลง');
        if (!batch.data.length || offset >= chunkTotal) break;
      }
    }

    const includeTypes = (Array.isArray(types) && types.length ? types : DEFAULT_TYPES).filter((type) => TYPE_LABELS[type]);
    const otherCount = totals.get('other') || 0;
    const byTypeRows = includeTypes.map((type) => ({ type, label: TYPE_LABELS[type], count: totals.get(type) || 0 }));
    if (otherCount > 0) byTypeRows.push({ type: 'other', label: TYPE_LABELS.other, count: otherCount });
    const shownTotal = byTypeRows.reduce((sum, row) => sum + row.count, 0);
    const monthRows = monthList.map((month) => ({
      key: month.key,
      label: month.label,
      total: monthTotals.get(month.key) || 0,
      byType: byTypeRows.map((row) => ({ type: row.type, label: TYPE_SHORT[row.type], count: monthByType.get(month.key).get(row.type) || 0 })),
    }));
    const partialMonths = !String(from).endsWith('-01') || !monthList.length ? true : String(to) < fullMonthEnd(to);

    return {
      areaLabel: areaLabel || 'พื้นที่ที่บัญชีนี้มีสิทธิ์เข้าถึง',
      from, to,
      periodPartial: partialMonths,
      typesRequested: includeTypes.length !== DEFAULT_TYPES.length,
      hasOtherType: otherCount > 0,
      total: shownTotal,
      totalAll,
      peopleTotal,
      visitedPeople: visitedPeople.size,
      byType: byTypeRows,
      months: monthRows,
      asOf: thaiNow(),
    };
  };
}

function fullMonthEnd(isoDate) {
  const [y, m] = String(isoDate).slice(0, 7).split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${y}-${String(m).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
}

function thaiNow() {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date());
}

// Plain-text answer for chat/voice; the presentation carries the same numbers
// for the card view. Every figure comes from the recorded reads above.
function formatVisitStats(data, { windowLabel } = {}) {
  const lines = [
    `สรุปการตรวจเยี่ยม • ${data.areaLabel}`,
    `ช่วง${windowLabel || `${data.from} ถึง ${data.to}`}`,
    `ตรวจเยี่ยมทั้งหมด ${data.total} ครั้ง จากบุคคล ${data.visitedPeople} คน (ทะเบียนในขอบเขต ${data.peopleTotal} คน)`,
    'แยกตามประเภท: ' + (data.byType.map((row) => `${row.label} ${row.count} ครั้ง`).join(' • ') || 'ไม่มีบันทึก'),
  ];
  if (data.months.some((month) => month.total > 0)) {
    lines.push('รายเดือน:');
    for (const month of data.months) {
      lines.push(`${month.label} — รวม ${month.total} ครั้ง${month.total ? ' (' + month.byType.filter((row) => row.count > 0).map((row) => `${row.label} ${row.count}`).join(' • ') + ')' : ''}`);
    }
  }
  if (data.periodPartial) lines.push('หมายเหตุ: เดือนแรก/เดือนสุดท้ายนับเฉพาะวันที่อยู่ในช่วงที่ระบุ');
  lines.push('อ้างอิงเฉพาะบันทึกการตรวจเยี่ยมที่ระบุวันที่ไว้ในช่วงเวลานี้');
  return lines.join('\n');
}

module.exports = { createRealVisitStatsTool, formatVisitStats };
