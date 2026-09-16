const express = require('express');
const { createFollowupService } = require('../services/followupService');

function createFollowupRoutes(db, audit, authRequired) {
  const router = express.Router();
  const followups = createFollowupService(db);

  router.get('/overdue', authRequired, (req, res) => {
    const result = followups.listOverdue(req.user, req.query);
    audit(req.user, 'followups_overdue_access', '/api/followups/overdue');
    return res.json({ data: result.rows, meta: { total: result.total } });
  });

  return router;
}

module.exports = { createFollowupRoutes };