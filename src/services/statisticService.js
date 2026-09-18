const { stationScope } = require('./personService');
const { overduePredicateSql } = require('./followupRules');

function emptyStatistics() {
  return {
    total: 0,
    psychiatric: 0,
    drug_user: 0,
    dealer: 0,
    released: 0,
    byStatus: {},
    followupOverdue: 0,
  };
}

function createStatisticsService(db) {
  function getStatistics(user) {
    const scope = stationScope(user);
    if (scope.empty) return emptyStatistics();

    const where = scope.whereSql ? `WHERE ${scope.whereSql}` : '';
    const params = scope.params;

    const total = db.prepare(`SELECT COUNT(*) AS c FROM persons ${where}`).get(...params).c;

    const typeCounts = db
      .prepare(`SELECT person_type, COUNT(*) AS c FROM persons ${where} GROUP BY person_type`)
      .all(...params);
    const byType = {};
    for (const row of typeCounts) byType[row.person_type] = row.c;

    const statusCounts = db
      .prepare(`SELECT status, COUNT(*) AS c FROM persons ${where} GROUP BY status`)
      .all(...params);
    const byStatus = {};
    for (const row of statusCounts) byStatus[row.status] = row.c;

    const overdueScope = stationScope(user, 'p.station_id');
    const overdueWhere = overdueScope.whereSql
      ? `WHERE ${overdueScope.whereSql} AND ${overduePredicateSql('p')}`
      : `WHERE ${overduePredicateSql('p')}`;
    const overdueTotal = db
      .prepare(`SELECT COUNT(*) AS c FROM persons p ${overdueWhere}`)
      .get(...overdueScope.params).c;

    return {
      total,
      psychiatric: byType.psychiatric || 0,
      drug_user: byType.drug_user || 0,
      dealer: byType.dealer || 0,
      released: byType.released || 0,
      byStatus,
      followupOverdue: overdueTotal,
    };
  }

  return { getStatistics };
}

module.exports = { createStatisticsService };
