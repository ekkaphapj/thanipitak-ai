'use strict';

const express = require('express');
const fs = require('fs');
const { createSummaryPdf, createSummaryExcel } = require('../services/reportService');

function createReportRoutes(db, authRequired, audit) {
  const router = express.Router();
  router.post('/summary.pdf', authRequired, async (req, res) => {
    try {
      const report = await createSummaryPdf(db, req.user, req.body && req.body.reportRequest);
      audit(req.user, 'summary_pdf_export', '/api/reports/summary.pdf');
      return res.download(report.path, 'thanipitak-summary.pdf', (err) => {
        fs.unlink(report.path, () => {});
        if (err && !res.headersSent) res.status(500).json({ error: 'สร้างรายงานไม่สำเร็จ' });
      });
    } catch (err) {
      return res.status(400).json({ error: err.message || 'สร้างรายงานไม่สำเร็จ', code: 'REPORT_FAILED' });
    }
  });
  router.post('/summary.xlsx', authRequired, async (req, res) => {
    try {
      const report = createSummaryExcel(db, req.user, req.body && req.body.reportRequest);
      audit(req.user, 'summary_xlsx_export', '/api/reports/summary.xlsx');
      return res.download(report.path, 'thanipitak-summary.xlsx', (err) => {
        fs.unlink(report.path, () => {});
        if (err && !res.headersSent) res.status(500).json({ error: 'สร้างรายงานไม่สำเร็จ' });
      });
    } catch (err) {
      return res.status(400).json({ error: err.message || 'สร้างรายงานไม่สำเร็จ', code: 'REPORT_FAILED' });
    }
  });
  return router;
}

module.exports = { createReportRoutes };
