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
  stt: {
    enabled: process.env.STT_ENABLED !== 'false',
    url: process.env.STT_URL || 'http://127.0.0.1:8178',
    timeoutMs: Number(process.env.STT_TIMEOUT_MS) || 30000,
    maxBytes: Number(process.env.STT_MAX_BYTES) || 5 * 1024 * 1024,
    language: process.env.STT_LANGUAGE || 'th',
    api: process.env.STT_API || 'faster-whisper',
  },
};
