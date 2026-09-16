const express = require('express');
const { queryAuditLogs } = require('../repositories/auditRepo');
const { queryAIAuditLogs } = require('../repositories/aiAuditRepo');

function createAdminRoutes(db, audit, authRequired, adminOnly) {
  const router = express.Router();

  router.get('/audit-logs', authRequired, adminOnly, (req, res) => {
    const logs = queryAuditLogs(db, { limit: 200 });
    audit(req.user, 'audit_logs_access', '/api/admin/audit-logs');
    return res.json({ data: logs });
  });

  router.get('/ai-audit-logs', authRequired, adminOnly, (req, res) => {
    const logs = queryAIAuditLogs(db, { limit: 200 });
    audit(req.user, 'ai_audit_logs_access', '/api/admin/ai-audit-logs');
    return res.json({ data: logs });
  });

  return router;
}

module.exports = { createAdminRoutes };