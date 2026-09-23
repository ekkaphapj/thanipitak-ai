'use strict';

const CATEGORIES = ['psychiatric', 'drug_user', 'released'];
const ITEM_FIELDS = ['person_id', 'full_name', 'person_type', 'color', 'risk_level', 'priority', 'last_visit_date', 'last_visit_status', 'guardian_source', 'missed_days', 'subdistrict', 'district'];

function createRealVisitPlanTool({ url, key, request = fetch }) {
  return async function readVisitPlan(req, { station = null, province = null, page = 1, pageSize = 40 } = {}) {
    if (!req.realToken) { const error = new Error('missing authenticated session'); error.code = 'REAL_ACCESS_DENIED'; throw error; }
    if (station !== null && (typeof station !== 'string' || !station.trim() || station.length > 100)) throw new Error('ชื่อ สภ. ไม่ถูกต้อง');
    if (province !== null && (typeof province !== 'string' || !province.trim() || province.length > 100)) throw new Error('จังหวัดไม่ถูกต้อง');
    if (!Number.isSafeInteger(page) || page < 1 || page > 1000 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new Error('หน้ารายการไม่ถูกต้อง');
    let response;
    try {
      response = await request(`${url}/rest/v1/rpc/ai_visit_plan`, {
        method: 'POST',
        headers: { apikey: key, Authorization: `Bearer ${req.realToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_station_id: null, p_station_name: station, p_province: province, p_page: page, p_page_size: pageSize }),
        signal: AbortSignal.timeout(20000),
      });
    } catch (cause) { const error = new Error('visit plan unavailable'); error.code = 'REAL_UNAVAILABLE'; error.cause = cause; throw error; }
    if (!response.ok) { const error = new Error('visit plan request failed'); error.code = [401, 403].includes(response.status) ? 'REAL_ACCESS_DENIED' : 'REAL_READ_FAILED'; throw error; }
    const result = await response.json().catch(() => null);
    if (!result || typeof result !== 'object' || !['ok', 'station_not_found', 'station_ambiguous', 'station_required'].includes(result.status)) {
      const error = new Error('unverifiable visit plan response'); error.code = 'REAL_DATA_UNVERIFIABLE'; throw error;
    }
    if (result.status !== 'ok') return { status: result.status };
    if (!result.station || !Number.isSafeInteger(Number(result.station.station_id)) || !Array.isArray(result.items) || !Array.isArray(result.priority_counts) || !result.counts || !Number.isSafeInteger(Number(result.total_due))) {
      const error = new Error('unverifiable visit plan response'); error.code = 'REAL_DATA_UNVERIFIABLE'; throw error;
    }
    const counts = {};
    for (const category of CATEGORIES) {
      const row = result.counts[category] || {};
      counts[category] = {};
      for (const field of ['total', 'high', 'watch', 'red', 'orange', 'never_visited']) counts[category][field] = Math.max(0, Number(row[field]) || 0);
    }
    const items = result.items.map(raw => Object.fromEntries(ITEM_FIELDS.map(field => [field, raw[field] ?? null])));
    if (items.some(item => !Number.isSafeInteger(Number(item.person_id)) || !CATEGORIES.includes(item.person_type) || ![1, 2, 3, 4].includes(Number(item.priority)))) {
      const error = new Error('unverifiable visit plan row'); error.code = 'REAL_DATA_UNVERIFIABLE'; throw error;
    }
    return {
      status: 'ok', asOf: result.as_of, station: { station_id: Number(result.station.station_id), station_name: String(result.station.station_name || ''), province: String(result.station.province || '') },
      counts, priorityCounts: result.priority_counts.map(value => Math.max(0, Number(value) || 0)),
      totalDue: Number(result.total_due), page: Number(result.page), pageSize: Number(result.page_size), items,
    };
  };
}

module.exports = { createRealVisitPlanTool };
