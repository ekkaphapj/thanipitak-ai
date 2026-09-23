'use strict';

const TYPES = new Set(['psychiatric', 'drug_user', 'dealer', 'released']);
const LEVELS = new Set(['all', 'high', 'watch', 'risk']);
const FIELDS = ['id', 'prefix', 'first_name', 'last_name', 'station_id', 'station_name', 'province', 'amphoe', 'tambon', 'person_type', 'risk_level', 'last_visit_date'];

function invalidResponse() {
  const error = new Error('unverifiable province list response');
  error.code = 'REAL_DATA_UNVERIFIABLE';
  return error;
}

function createRealProvincePeopleTool({ url, key, request = fetch }) {
  return async function readProvincePeople(req, { province, personType = null, level = 'all', page = 1, pageSize = 20 }) {
    if (!req.realToken) { const error = new Error('missing authenticated session'); error.code = 'REAL_ACCESS_DENIED'; throw error; }
    if (typeof province !== 'string' || !province.trim() || province.length > 100 || (personType && !TYPES.has(personType)) || !LEVELS.has(level)
      || !Number.isSafeInteger(page) || page < 1 || page > 1000 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new Error('เงื่อนไขรายการไม่ถูกต้อง');
    let response;
    try {
      response = await request(`${url}/rest/v1/rpc/ai_people_province_list`, {
        method: 'POST',
        headers: { apikey: key, Authorization: `Bearer ${req.realToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_province: province.trim(), p_person_type: personType, p_level: level, p_page: page, p_page_size: pageSize }),
        signal: AbortSignal.timeout(20000),
      });
    } catch (cause) { const error = new Error('province list unavailable'); error.code = 'REAL_UNAVAILABLE'; error.cause = cause; throw error; }
    if (!response.ok) { const error = new Error('province list request failed'); error.code = [401, 403].includes(response.status) ? 'REAL_ACCESS_DENIED' : 'REAL_READ_FAILED'; throw error; }
    const result = await response.json().catch(() => null);
    if (!result || result.status !== 'ok' || result.province !== province.trim() || result.person_type !== personType || result.level !== level
      || !Array.isArray(result.items) || !Number.isSafeInteger(Number(result.total)) || Number(result.total) < 0
      || Number(result.page) !== page || Number(result.page_size) !== pageSize || result.items.length > pageSize) throw invalidResponse();
    const items = result.items.map(raw => Object.fromEntries(FIELDS.map(field => [field, raw[field] ?? null])));
    if (items.some(item => !Number.isSafeInteger(Number(item.id)) || Number(item.id) < 1 || !TYPES.has(item.person_type)
      || item.province !== province.trim() || (personType && item.person_type !== personType)
      || (level === 'high' && item.risk_level !== 'high') || (level === 'watch' && item.risk_level !== 'watch')
      || (level === 'risk' && !['high', 'watch'].includes(item.risk_level)))) throw invalidResponse();
    return { data: items, total: Number(result.total), page, pageSize };
  };
}

module.exports = { createRealProvincePeopleTool };
