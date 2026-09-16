const express = require('express');
const { createStatisticsService } = require('../services/statisticService');

function createStatisticRoutes(db, audit, authRequired) {
  const router = express.Router();
  const stats = createStatisticsService(db);

  router.get('/', authRequired, (req, res) => {
    const result = stats.getStatistics(req.user);
    audit(req.user, 'statistics_access', '/api/statistics');
    return res.json({ data: result });
  });

  return router;
}

module.exports = { createStatisticRoutes };