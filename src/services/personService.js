const personRepo = require('../repositories/personRepo');
const config = require('../config');

const VALID_TYPES = ['psychiatric', 'drug_user', 'dealer'];
const VALID_STATUSES = ['registered', 'active', 'followup', 'completed'];

function allowedStationIds(user) {
  if (!user) return [];
  if (user.role === 'admin') return null;
  if (!user.stationId) return [];
  return [user.stationId];
}

function hasAccessToPerson(user, person) {
  const stationIds = allowedStationIds(user);
  if (stationIds === null) return true;
  return stationIds.includes(person.station_id);
}

function sanitizeLimit(rawLimit) {
  const parsed = Number.parseInt(rawLimit, 10);
  if (Number.isNaN(parsed) || parsed < 1) return config.defaultLimit;
  return Math.min(parsed, config.maxLimit);
}

function sanitizeOffset(rawOffset) {
  const parsed = Number.parseInt(rawOffset, 10);
  if (Number.isNaN(parsed) || parsed < 0) return 0;
  return parsed;
}

function normalizeQuery(query) {
  return {
    personType: VALID_TYPES.includes(query.person_type || query.type)
      ? (query.person_type || query.type)
      : undefined,
    status: VALID_STATUSES.includes(query.status) ? query.status : undefined,
    district: query.district ? String(query.district).slice(0, 100) : undefined,
    subdistrict: query.subdistrict ? String(query.subdistrict).slice(0, 100) : undefined,
    search: query.search ? String(query.search).trim().slice(0, 100) : undefined,
    limit: sanitizeLimit(query.limit),
    offset: sanitizeOffset(query.offset),
  };
}

function createPersonService(db) {
  function listPersons(user, query = {}) {
    const opts = normalizeQuery(query);
    return personRepo.listPersons(db, {
      stationIds: allowedStationIds(user),
      ...opts,
    });
  }

  function listPersonsWithSummary(user, query = {}) {
    const opts = normalizeQuery(query);
    const stationIds = allowedStationIds(user);
    const { rows, total } = personRepo.listPersons(db, { stationIds, ...opts });
    const summary = personRepo.statusSummary(db, { stationIds, ...opts });
    return {
      rows,
      total,
      summary: {
        registered: summary.registered || 0,
        active: summary.active || 0,
        followup: summary.followup || 0,
        completed: summary.completed || 0,
      },
    };
  }

  function getPerson(user, id) {
    const person = personRepo.getPersonById(db, parseInt(id, 10));
    if (!person || !hasAccessToPerson(user, person)) {
      return { ok: false, reason: 'NOT_FOUND', person: null };
    }
    return { ok: true, person };
  }

  function getVisits(user, id) {
    const check = getPerson(user, id);
    if (!check.ok) return { ok: false, reason: check.reason };
    return { ok: true, visits: personRepo.getVisitsForPerson(db, check.person.id) };
  }

  function getUrineTests(user, id) {
    const check = getPerson(user, id);
    if (!check.ok) return { ok: false, reason: check.reason };
    return { ok: true, tests: personRepo.getUrineTestsForPerson(db, check.person.id) };
  }

  function getPersonWithVisitStats(user, id) {
    const person = personRepo.getPersonById(db, parseInt(id, 10));
    if (!person || !hasAccessToPerson(user, person)) {
      return { ok: false, reason: 'NOT_FOUND', person: null };
    }
    const stats = personRepo.getVisitStatsForPerson(db, person.id);
    return { ok: true, person, visitStats: stats };
  }

  return { listPersons, listPersonsWithSummary, getPerson, getVisits, getUrineTests, getPersonWithVisitStats };
}

module.exports = {
  allowedStationIds,
  hasAccessToPerson,
  createPersonService,
};