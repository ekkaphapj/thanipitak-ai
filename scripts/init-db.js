const { initDatabase } = require('../src/db');
const config = require('../src/config');

const db = initDatabase(config.dbPath);
db.close();
console.log('[init-db] Done');