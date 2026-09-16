const config = require('../config');

const INTERVAL_DAYS = {
  psychiatric: 30,
  drug_user: 60,
  dealer: 15,
};

function createFollowupService(db) {
  function listOverdue(user, query = {}) {
    const stationIds =
      user.role === 'admin' ? null : user.stationId ? [user.stationId] : [];
    const limit =
      Number.parseInt(query.limit, 10) > 0
        ? Math.min(Number.parseInt(query.limit, 10), config.maxLimit)
        : config.defaultLimit;
    const offset =
      Number.parseInt(query.offset, 10) > 0 ? Number.parseInt(query.offset, 10) : 0;

    let where = `p.status != 'completed' AND (
      p.last_visit_date IS NULL OR (
        CASE p.person_type
          WHEN 'psychiatric' THEN date('now', '-30 days')
          WHEN 'drug_user' THEN date('now', '-60 days')
          WHEN 'dealer' THEN date('now', '-15 days')
        END > p.last_visit_date
      )
    )`;
    const params = [];
    if (stationIds) {
      where = `p.station_id IN (${stationIds.map(() => '?').join(',')}) AND ${where}`;
      params.push(...stationIds);
    }

    const total = db
      .prepare(`SELECT COUNT(*) AS c FROM persons p WHERE ${where}`)
      .get(...params).c;

    const rows = db
      .prepare(
        `SELECT p.*,
          CASE p.person_type
            WHEN 'psychiatric' THEN 30
            WHEN 'drug_user' THEN 60
            WHEN 'dealer' THEN 15
          END AS interval_days
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