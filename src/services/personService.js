const personRepo = require('../repositories/personRepo');
const config = require('../config');
const { followupIntervalDays } = require('./followupRules');

const VALID_TYPES = ['psychiatric', 'drug_user', 'dealer', 'released'];
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

function stationScope(user, column = 'station_id') {
  const stationIds = allowedStationIds(user);
  if (stationIds === null) {
    return { whereSql: '', params: [], empty: false };
  }
  if (stationIds.length === 0) {
    return { whereSql: '1=0', params: [], empty: true };
  }
  return {
    whereSql: `${column} IN (${stationIds.map(() => '?').join(',')})`,
    params: [...stationIds],
    empty: false,
  };
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
    province: query.province ? String(query.province).trim().slice(0, 100) : undefined,
    station: query.station ? String(query.station).trim().slice(0, 100) : undefined,
    district: query.district ? String(query.district).slice(0, 100) : undefined,
    subdistrict: query.subdistrict ? String(query.subdistrict).slice(0, 100) : undefined,
    search: query.search ? String(query.search).trim().slice(0, 100) : undefined,
    limit: sanitizeLimit(query.limit),
    offset: sanitizeOffset(query.offset),
  };
}

const RECENT_VISITS_MAX = 5;

function toDateKey(d) {
  return d.toISOString().slice(0, 10);
}

function buildPersonSummary(person, visits, urineTests) {
  const visitCount = visits.length;
  const latestVisit = visitCount > 0 ? visits[0] : null;
  const latestVisitDate = latestVisit ? latestVisit.visit_date : person.last_visit_date || null;

  let daysSinceLastVisit = null;
  if (latestVisitDate) {
    const today = new Date(toDateKey(new Date()) + 'T00:00:00');
    const last = new Date(latestVisitDate + 'T00:00:00');
    daysSinceLastVisit = Math.floor((today - last) / 86400000);
  }

  const intervalDays = followupIntervalDays(person.person_type);
  const overdue =
    person.status === 'completed'
      ? false
      : latestVisitDate === null
        ? true
        : daysSinceLastVisit > intervalDays;

  const positiveCount = urineTests.filter((t) => t.result === 'positive').length;
  const negativeCount = urineTests.filter((t) => t.result === 'negative').length;
  const latestTest = urineTests.length > 0 ? urineTests[0] : null;

  return {
    person,
    visit_summary: {
      visit_count: visitCount,
      latest_visit: latestVisit
        ? {
            date: latestVisit.visit_date,
            result: latestVisit.result,
            note: latestVisit.note,
            officer_name: latestVisit.officer_name,
          }
        : null,
    },
    urine_summary: {
      test_count: urineTests.length,
      positive_count: positiveCount,
      negative_count: negativeCount,
      latest_test: latestTest
        ? {
            date: latestTest.test_date,
            result: latestTest.result,
            officer_name: latestTest.officer_name,
          }
        : null,
    },
    followup: {
      overdue,
      days_since_last_visit: daysSinceLastVisit,
    },
    recent_visits: visits.slice(0, RECENT_VISITS_MAX).map((v) => ({
      id: v.id,
      visit_date: v.visit_date,
      result: v.result,
      note: v.note,
      officer_name: v.officer_name,
    })),
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

  function summarizePersons(user, query = {}) {
    const opts = normalizeQuery(query);
    const stationIds = allowedStationIds(user);
    const { rows, total } = personRepo.listPersons(db, { stationIds, ...opts });
    return {
      rows,
      total,
      byType: personRepo.typeSummary(db, { stationIds, ...opts }),
    };
  }

  function groupByLocation(user, query = {}) {
    const groupBy = query.groupBy;
    if (!['subdistrict', 'district', 'province', 'station'].includes(groupBy)) {
      return { groups: [], missing: 0, total: 0, groupBy: null };
    }
    const opts = normalizeQuery(query);
    return {
      groupBy,
      ...personRepo.groupPersons(db, {
        stationIds: allowedStationIds(user),
        ...opts,
        groupBy,
      }),
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

  function getPersonSummary(user, id) {
    const person = personRepo.getPersonById(db, parseInt(id, 10));
    if (!person || !hasAccessToPerson(user, person)) {
      return { ok: false, reason: 'NOT_FOUND', data: null };
    }
    const visits = personRepo.getVisitsForPerson(db, person.id);
    const urineTests = personRepo.getUrineTestsForPerson(db, person.id);
    return { ok: true, data: buildPersonSummary(person, visits, urineTests) };
  }

  function getPersonWithVisitStats(user, id) {
    const person = personRepo.getPersonById(db, parseInt(id, 10));
    if (!person || !hasAccessToPerson(user, person)) {
      return { ok: false, reason: 'NOT_FOUND', person: null };
    }
    const stats = personRepo.getVisitStatsForPerson(db, person.id);
    return { ok: true, person, visitStats: stats };
  }

  return {
    listPersons,
    listPersonsWithSummary,
    summarizePersons,
    groupByLocation,
    getPerson,
    getVisits,
    getUrineTests,
    getPersonWithVisitStats,
    getPersonSummary,
  };
}

module.exports = {
  allowedStationIds,
  hasAccessToPerson,
  stationScope,
  buildPersonSummary,
  createPersonService,
};
