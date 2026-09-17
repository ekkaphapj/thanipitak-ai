function sanitizeToolArgs(args = {}) {
  const safe = {};
  for (const key of ['person_id', 'person_type', 'status', 'person_types', 'level', 'page']) {
    if (args[key] !== undefined && args[key] !== null) {
      safe[key] = args[key];
    }
  }
  return safe;
}

function createAIAuditor(db) {
  const stmt = db.prepare(
    'INSERT INTO ai_audit_logs (user_id, action, tool_name, safe_arguments, created_at) VALUES (?, ?, ?, ?, ?)'
  );
  return {
    logChat(user) {
      stmt.run(user && user.id ? user.id : null, 'AI_CHAT', null, '{}', new Date().toISOString());
    },
    logToolCall(user, toolName, args) {
      stmt.run(
        user && user.id ? user.id : null,
        'AI_TOOL_CALL',
        toolName,
        JSON.stringify(sanitizeToolArgs(args)),
        new Date().toISOString()
      );
    },
    logReliability(user, meta) {
      stmt.run(
        user && user.id ? user.id : null,
        'AI_RELIABILITY',
        null,
        JSON.stringify({
          grounded: meta.grounded,
          retryCount: meta.retryCount || 0,
          toolsCount: (meta.toolsUsed || []).length,
        }),
        new Date().toISOString()
      );
    },
    logFastPath(user, meta) {
      stmt.run(
        user && user.id ? user.id : null,
        'AI_FAST_PATH',
        meta.tool || null,
        JSON.stringify({
          fastPath: true,
          intent: meta.intent || null,
          tool: meta.tool || null,
          grounded: meta.grounded,
          success: meta.success,
        }),
        new Date().toISOString()
      );
    },
  };
}

function queryAIAuditLogs(db, opts = {}) {
  const { limit = 100, offset = 0 } = opts;
  return db
    .prepare(
      `SELECT a.*, u.username FROM ai_audit_logs a
       LEFT JOIN users u ON u.id = a.user_id
       ORDER BY a.id DESC LIMIT ? OFFSET ?`
    )
    .all(limit, offset);
}

module.exports = { createAIAuditor, queryAIAuditLogs, sanitizeToolArgs };
