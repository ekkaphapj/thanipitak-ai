function createAuditor(db) {
  const stmt = db.prepare(
    'INSERT INTO audit_logs (user_id, action, endpoint, target_id, created_at) VALUES (?, ?, ?, ?, ?)'
  );
  return function audit(user, action, endpoint, targetId = null) {
    const userId = user && user.id ? user.id : null;
    stmt.run(userId, action, endpoint, targetId ?? null, new Date().toISOString());
  };
}

function queryAuditLogs(db, opts = {}) {
  const { limit = 100, offset = 0 } = opts;
  return db
    .prepare(
      `SELECT a.*, u.username FROM audit_logs a
       LEFT JOIN users u ON u.id = a.user_id
       ORDER BY a.id DESC LIMIT ? OFFSET ?`
    )
    .all(limit, offset);
}

module.exports = { createAuditor, queryAuditLogs };