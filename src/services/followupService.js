const config = require('../config');
const { stationScope } = require('./personService');
const { overduePredicateSql, intervalDaysSelectSql } = require('./followupRules');

function createFollowupService(db) {
  function listOverdue(user, query = {}) {
    const scope = stationScope(user, 'p.station_id');
    if (scope.empty) return { rows: [], total: 0 };

    const limit =
      Number.parseInt(query.limit, 10) > 0
        ? Math.min(Number.parseInt(query.limit, 10), config.maxLimit)
        : config.defaultLimit;
    const offset =
      Number.parseInt(query.offset, 10) > 0 ? Number.parseInt(query.offset, 10) : 0;

    const where = scope.whereSql
      ? `${scope.whereSql} AND ${overduePredicateSql('p')}`
      : overduePredicateSql('p');
    const params = scope.params;

    const total = db
      .prepare(`SELECT COUNT(*) AS c FROM persons p WHERE ${where}`)
      .get(...params).c;

    const rows = db
      .prepare(
        `SELECT p.*,
          ${intervalDaysSelectSql('p')} AS interval_days
        FROM persons p
        WHERE ${where}
        ORDER BY p.last_visit_date ASC NULLS FIRST
        LIMIT ? OFFSET ?`
      )
      .all(...params, limit, offset);

    return { rows, total };
  }

  return { listOverdue };
}

module.exports = { createFollowupService };