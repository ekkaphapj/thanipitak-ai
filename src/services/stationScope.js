'use strict';

function parseStationId(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function applyPeopleStationScope(user, params) {
  const id = parseStationId(user && user.stationId);
  if (id) {
    params.set('station_id', `eq.${id}`);
    return id;
  }
  if (user && user.role === 'admin') return null;
  throw new Error('บัญชีนี้ยังไม่มีสิทธิ์สถานีสำหรับ AI');
}

function personInOwnStation(user, person) {
  const id = parseStationId(user && user.stationId);
  if (!id) return user && user.role === 'admin';
  if (person == null || person.station_id == null || person.station_id === '') return true;
  return Number(person.station_id) === id;
}

module.exports = { parseStationId, applyPeopleStationScope, personInOwnStation };
