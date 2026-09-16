const { initDatabase } = require('./db');
const { createApp } = require('./app');
const config = require('./config');

const db = initDatabase(config.dbPath);
const { app } = createApp(db);

const server = app.listen(config.port, config.host, () => {
  console.log(`[server] Thanipithak AI Sandbox running at http://${config.host}:${config.port}`);
  console.log(`[server] Dashboard: http://localhost:${config.port}/`);
});

function shutdown() {
  console.log('\n[server] Shutting down...');
  server.close(() => {
    try {
      db.close();
    } catch (_) {
      /* ignore */
    }
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

module.exports = { server, db };