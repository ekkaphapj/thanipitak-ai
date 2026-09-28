'use strict';
// Separate from fixture-user audit tables: verified Supabase actors are UUIDs.
// Only request/result metadata is stored, never JWTs or personal record rows.
function createRealReadAuditor(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS real_read_audit_logs (
    id INTEGER PRIMARY KEY, actor TEXT NOT NULL, created_at TEXT NOT NULL,
    request_type TEXT NOT NULL, requested_province TEXT, requested_station TEXT,
    result_metadata TEXT NOT NULL
  )`);
  const insert = db.prepare('INSERT INTO real_read_audit_logs (actor,created_at,request_type,requested_province,requested_station,result_metadata) VALUES (?,?,?,?,?,?)');
  const update = db.prepare('UPDATE real_read_audit_logs SET result_metadata=? WHERE id=?');
  return {
    start(req, table, params) {
      if (req.user?.id == null) throw Object.assign(new Error('audit actor missing'), { code: 'REAL_AUDIT_UNAVAILABLE' });
      const context = req.realReadContext || {};
      const entry = insert.run(String(req.user.id), new Date().toISOString(), `${req.path}:${table}`, context.province || params.get('province') || null, context.station || params.get('station_id') || null, JSON.stringify({ status: 'pending', table }));
      return metadata => update.run(JSON.stringify({ table, ...metadata }), entry.lastInsertRowid);
    },
  };
}
module.exports = { createRealReadAuditor };
