const express = require('express');
const cors = require('cors');
const path = require('path');

const { authRequired, adminOnly } = require('./middleware/auth');
const { attachAuditor } = require('./middleware/audit');
const { createAuthRoutes } = require('./routes/authRoutes');
const { createPersonRoutes } = require('./routes/personRoutes');
const { createStatisticRoutes } = require('./routes/statisticRoutes');
const { createFollowupRoutes } = require('./routes/followupRoutes');
const { createAdminRoutes } = require('./routes/adminRoutes');
const { createAIRoutes } = require('./routes/aiRoutes');

function createApp(db, options = {}) {
  const app = express();
  const audit = attachAuditor(db);

  app.use(cors());
  app.use(express.json());

  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', service: 'thanipitak-ai-sandbox' });
  });

  app.use('/api/auth', createAuthRoutes(db, audit));
  app.use('/api/persons', createPersonRoutes(db, audit, authRequired));
  app.use('/api/statistics', createStatisticRoutes(db, audit, authRequired));
  app.use('/api/followups', createFollowupRoutes(db, audit, authRequired));
  app.use('/api/ai', createAIRoutes(db, authRequired, options));
  app.use('/api/admin', createAdminRoutes(db, audit, authRequired, adminOnly));

  app.use(express.static(path.join(__dirname, '..', 'frontend')));

  app.use('/api', (req, res) => {
    res.status(404).json({ error: 'ไม่พบ endpoint นี้', code: 'NOT_FOUND' });
  });

  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: 'เกิดข้อผิดพลาดภายในระบบ', code: 'INTERNAL_ERROR' });
  });

  return { app, audit };
}

module.exports = { createApp };