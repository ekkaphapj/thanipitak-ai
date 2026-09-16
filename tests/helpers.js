const os = require('os');
const path = require('path');
const fs = require('fs');
const { createConnection } = require('../src/db/connection');
const { seedDatabase } = require('../src/db/seed');
const { createApp } = require('../src/app');

function makeTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-sandbox-'));
  const dbPath = path.join(dir, 'test.db');
  const connection = createConnection(dbPath);
  const counts = seedDatabase(connection);
  return { dir, dbPath, connection, counts };
}

function setup() {
  const { dir, connection, counts } = makeTempDb();
  const { app, audit } = createApp(connection);
  return {
    db: connection,
    app,
    audit,
    counts,
    cleanup() {
      try {
        connection.close();
      } catch (_) {
        /* ignore */
      }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

const USERS = {
  admin: { username: 'admin', password: 'thanipitak123', role: 'admin', stationId: null },
  station1_off: { username: 'station1_off', password: 'thanipitak123', role: 'officer', stationId: 1 },
  station1_view: { username: 'station1_view', password: 'thanipitak123', role: 'viewer', stationId: 1 },
  station2_off: { username: 'station2_off', password: 'thanipitak123', role: 'officer', stationId: 2 },
};

module.exports = { setup, USERS };