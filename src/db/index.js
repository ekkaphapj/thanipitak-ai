const path = require('path');
const fs = require('fs');
const { createConnection } = require('../db/connection');
const { seedDatabase } = require('../db/seed');
const { seedRealisticDatabase } = require('./realisticSeed');
const config = require('../config');

function ensureDataDir(dbPath) {
  if (dbPath === ':memory:') return;
  const dir = path.dirname(dbPath);
  fs.mkdirSync(dir, { recursive: true });
}

function initDatabase(dbPath = config.dbPath, { reseed = false, profile = 'realistic' } = {}) {
  ensureDataDir(dbPath);
  const db = createConnection(dbPath);

  const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  const stationCount = db.prepare('SELECT COUNT(*) AS c FROM stations').get().c;

  if (reseed || userCount === 0) {
    if (reseed && db.prepare('SELECT 1 FROM people LIMIT 1').get()) {
      db.close();
      throw new Error('Realistic data is preserved. Choose a new DB_PATH to create a fresh fixture.');
    }
    if (reseed) {
      db.exec('DELETE FROM audit_logs; DELETE FROM urine_tests; DELETE FROM visits; DELETE FROM persons; DELETE FROM users; DELETE FROM stations; DELETE FROM sqlite_sequence WHERE name IN (\'stations\',\'users\',\'persons\',\'visits\',\'urine_tests\',\'audit_logs\');');
    }
    const counts = profile === 'legacy' ? seedDatabase(db) : seedRealisticDatabase(db);
    console.log(`[init] Seeded database:
  stations:   ${counts.stations}
  users:      ${counts.users}
  persons:    ${counts.persons}
  visits:     ${counts.visits}
  urine tests:${counts.urineTests}`);
  } else {
    console.log('[init] Database already has data - skip seeding');
  }

  return db;
}

module.exports = { initDatabase };
