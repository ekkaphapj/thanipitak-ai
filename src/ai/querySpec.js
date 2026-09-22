'use strict';

// Normalized query specification shared by counts, name lists, recorded
// monitoring lists, and PDF/Excel reports in real mode. One structure, one
// validation, one description line — so the answer and the exported file can
// never be built from different conditions.
//
// The spec contains only narrowing query filters. Authorization (station
// scope, authenticated token) is applied separately by the data adapters and
// is never part of the spec, so a forged spec from the browser or the model
// can shrink a result but never widen access.

const PERSON_TYPES = ['psychiatric', 'drug_user', 'dealer', 'released'];
const LEVELS = ['all', 'high', 'watch'];
const KINDS = ['count', 'list', 'monitoring', 'report'];
const EXCLUDE_COLUMNS = ['tambon', 'amphoe', 'station_id'];
const MAX_EXCLUDES = 3;
const MAX_EXCLUDE_IDS = 1000;

const TYPE_LABELS = { psychiatric: 'ผู้ป่วยจิตเวช', drug_user: 'ผู้เสพ', dealer: 'ผู้ค้า', released: 'ผู้พ้นโทษ' };
const AREA_LABELS = { province: 'จังหวัด', district: 'อำเภอ', subdistrict: 'ตำบล', station: 'สภ.' };

function cleanText(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim().slice(0, 100);
  if (!text || /select\s|insert\s|drop\s|;|--/i.test(text)) return null;
  return text;
}

function isIsoDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

// Accepts untrusted input (conversation topic from the browser, detector
// output, report requests) and returns a validated spec or the closest valid
// form. Unknown fields are dropped; invalid ones become null.
function normalizeQuerySpec(input) {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const spec = {
    kind: KINDS.includes(raw.kind) ? raw.kind : null,
    person_type: PERSON_TYPES.includes(raw.person_type) ? raw.person_type : null,
    area: {},
    exclude: [],
    window: null,
    level: LEVELS.includes(raw.level) && raw.level !== 'all' ? raw.level : null,
    page: Number.isSafeInteger(raw.page) && raw.page >= 1 && raw.page <= 1000 ? raw.page : 1,
    person_id: null,
  };
  for (const key of ['province', 'district', 'subdistrict', 'station']) {
    const value = cleanText(raw.area?.[key] ?? raw[key]);
    if (value) spec.area[key] = value;
  }
  if (Number.isSafeInteger(raw.person_id) && raw.person_id > 0) spec.person_id = raw.person_id;
  for (const entry of Array.isArray(raw.exclude) ? raw.exclude.slice(0, MAX_EXCLUDES) : []) {
    if (!entry || typeof entry !== 'object') continue;
    if (!EXCLUDE_COLUMNS.includes(entry.column)) continue;
    if (entry.column === 'station_id') {
      const ids = Array.isArray(entry.ids)
        ? [...new Set(entry.ids.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))].slice(0, MAX_EXCLUDE_IDS)
        : [];
      if (ids.length) spec.exclude.push({ column: 'station_id', ids, label: cleanText(entry.label) || 'พื้นที่ที่ยกเว้น' });
    } else {
      const value = cleanText(entry.value);
      if (value) spec.exclude.push({ column: entry.column, value, label: cleanText(entry.label) || value });
    }
  }
  if (raw.window && typeof raw.window === 'object' && isIsoDate(raw.window.from) && isIsoDate(raw.window.to) && raw.window.from <= raw.window.to) {
    spec.window = { from: raw.window.from, to: raw.window.to, label: cleanText(raw.window.label) || `${raw.window.from} ถึง ${raw.window.to}` };
  }
  return spec;
}

// Short Thai line naming what is being searched. Safe for answers and report
// headers: it contains only filters, never authorization internals.
function describeQuerySpec(spec) {
  const bits = [];
  if (spec.person_type) bits.push(TYPE_LABELS[spec.person_type]);
  else if (spec.kind === 'monitoring') bits.push('บุคคลเป้าหมาย');
  for (const [key, label] of Object.entries(AREA_LABELS)) {
    if (spec.area[key]) bits.push(`${label}${spec.area[key]}`);
  }
  if (spec.level === 'high') bits.push('เสี่ยงสูง');
  if (spec.level === 'watch') bits.push('เฝ้าระวัง');
  if (spec.level === 'all' && spec.kind === 'monitoring') bits.push('เฝ้าระวังหรือเสี่ยงสูง');
  if (spec.window) bits.push(`ช่วง${spec.window.label}`);
  if (spec.exclude.length) bits.push(`ยกเว้น ${spec.exclude.map((entry) => entry.label).join(', ')}`);
  if (spec.page > 1) bits.push(`หน้า ${spec.page}`);
  return bits.join(' • ');
}

// Narrowing filters for the search() adapter. Station scope is applied by
// search() itself and is deliberately not here.
function filtersFromSpec(spec) {
  const filters = {};
  for (const key of ['province', 'district', 'subdistrict', 'station']) {
    if (spec.area[key]) filters[key] = spec.area[key];
  }
  if (spec.person_type) filters.person_type = spec.person_type;
  if (spec.exclude.length) filters.exclude = spec.exclude;
  return filters;
}

module.exports = {
  PERSON_TYPES,
  EXCLUDE_COLUMNS,
  MAX_EXCLUDES,
  normalizeQuerySpec,
  describeQuerySpec,
  filtersFromSpec,
  TYPE_LABELS,
};
