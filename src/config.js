const path = require('path');
require('dotenv').config();

const dbPath = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(__dirname, '..', 'data', 'thanipitak-realistic.db');

module.exports = {
  port: Number(process.env.PORT) || 3100,
  host: process.env.HOST || '0.0.0.0',
  jwtSecret: process.env.JWT_SECRET || 'dev-only-secret-thanipitak-sandbox-change-in-prod',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '8h',
  bcryptRounds: 10,
  dbPath,
  defaultLimit: 50,
  maxLimit: 200,
};
