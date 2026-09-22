'use strict';

function parseStationId(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

// Only the primary system's authenticated access-scope response can allow a
// real-data read beyond the profile station. Browser context, prompt text and
// a locally assigned role never widen this boundary. Test-mode users have no
// aiScope and therefore retain the historic station-only behaviour.
function hasCrossStationRead(user) {
  const scope = user && user.aiScope;
  return Boolean(scope && scope.read_only === true && ['province', 'region4', 'all'].includes(scope.level));
}

function applyPeopleStationScope(user, params) {
  if (hasCrossStationRead(user)) return null;
  const id = parseStationId(user && user.stationId);
  if (id) {
    params.set('station_id', `eq.${id}`);
    return id;
  }
  if (user && user.role === 'admin') return null;
  throw new Error('บัญชีนี้ยังไม่มีสิทธิ์สถานีสำหรับ AI');
}

function personInOwnStation(user, person) {
  if (hasCrossStationRead(user)) return true;
  const id = parseStationId(user && user.stationId);
  if (!id) return user && user.role === 'admin';
  if (person == null || person.station_id == null || person.station_id === '') return true;
  return Number(person.station_id) === id;
}

module.exports = { parseStationId, hasCrossStationRead, applyPeopleStationScope, personInOwnStation };
