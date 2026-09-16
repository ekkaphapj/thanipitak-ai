const { DatabaseSync } = require('node:sqlite');
const { SCHEMA_SQL } = require('./schema');

function createConnection(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON;');
  if (dbPath !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA busy_timeout = 5000;');
  }
  db.exec(SCHEMA_SQL);
  return db;
}

module.exports = { createConnection };