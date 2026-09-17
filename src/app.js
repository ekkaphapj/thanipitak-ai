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
  const realAuth = require('./routes/realAuthRoutes').createRealAuthRoutes(options.realAuth);
  app.use('/api/auth', (req, res, next) => req.get('X-Data-Source') === 'real' ? realAuth(req, res, next) : next());
  const realData = require('./routes/realDataRoutes').createRealDataRoutes(realAuth.authenticate,options.realAuth);
  app.use('/api', (req,res,next) => req.get('X-Data-Source') === 'real' ? realData(req,res,next) : next());

  app.get('/api/data-sources', (req, res) => res.json({
    current: 'test',
    sources: [{ id: 'test', label: 'ข้อมูลทดสอบ', available: true },
      { id: 'real', label: 'ข้อมูลจริง', available: true,
        reason: 'รองรับเข้าสู่ระบบและอ่านทะเบียน รายงานและเฝ้าระวังยังไม่เปิดใช้' }],
  }));
  // Never silently serve fixtures when a client requested real records.
  app.use('/api', (req, res, next) => {
    const source = req.get('X-Data-Source') || 'test';
    if (source !== 'test') return res.status(409).json({
      code: 'DATA_SOURCE_UNAVAILABLE', error: 'ยังไม่พร้อมใช้ข้อมูลจริง กรุณาเลือกข้อมูลทดสอบ',
    });
    next();
  });

  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', service: 'thanipitak-ai-sandbox' });
  });

  app.use('/api/auth', createAuthRoutes(db, audit));
  app.use('/api/persons', createPersonRoutes(db, audit, authRequired));
  app.use('/api/statistics', createStatisticRoutes(db, audit, authRequired));
  app.use('/api/followups', createFollowupRoutes(db, audit, authRequired));
  app.use('/api/ai', createAIRoutes(db, authRequired, options));
  app.use('/api/monitoring', require('./routes/monitoringRoutes').createMonitoringRoutes(db,authRequired,audit));
  app.use('/api/reports', require('./routes/reportRoutes').createReportRoutes(db,authRequired,audit));
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
