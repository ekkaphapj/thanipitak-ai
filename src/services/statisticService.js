function createStatisticsService(db) {
  function getStatistics(user) {
    const stationIds =
      user.role === 'admin' ? null : user.stationId ? [user.stationId] : [];

    const where = stationIds
      ? `WHERE station_id IN (${stationIds.map(() => '?').join(',')})`
      : '';
    const params = stationIds || [];

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

    const overdueWhere = stationIds
      ? `WHERE p.station_id IN (${stationIds.map(() => '?').join(',')}) AND p.status != 'completed' AND (p.last_visit_date IS NULL OR p.last_visit_date < date('now', '-30 days'))`
      : `WHERE p.status != 'completed' AND (p.last_visit_date IS NULL OR p.last_visit_date < date('now', '-30 days'))`;
    const overdueTotal = db
      .prepare(`SELECT COUNT(*) AS c FROM persons p ${overdueWhere}`)
      .get(...params).c;

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
