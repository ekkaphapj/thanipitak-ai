'use strict';

const express = require('express');
const fs = require('fs');
const { createSummaryPdf, createSummaryExcel, safeReportRequest } = require('../services/reportService');
const { writeChartPdf } = require('../services/chartPdf');
const { createUserService } = require('../services/userService');
const { createPersonService } = require('../services/personService');
const chartPresentation = require('../services/chartPresentation');

function createReportRoutes(db, authRequired, audit) {
  // Rebuilds the fixture chart the test chat already showed. The request may
  // only name which aggregate (own station / province); the numbers come from
  // the same fixture summary, never from the browser.
  const buildFixtureChart = (user, request) => {
    if (request.chart_kind === 'visits') {
      const error = new Error('กราฟการตรวจเยี่ยมต้องใช้บันทึกจริง กรุณาเลือกโหมดข้อมูลจริงและเข้าสู่ระบบด้วยบัญชีตำรวจ');
      error.code = 'REAL_FEATURE_REQUIRED';
      throw error;
    }
    const users = createUserService(db);
    const storedUser = users.findById(user.id);
    if (!storedUser) { const error = new Error('กรุณาเข้าสู่ระบบใหม่'); error.code = 'REPORT_FAILED'; throw error; }
    const profile = users.publicProfile(storedUser);
    if (request.chart_own === true && !profile.stationId) {
      const error = new Error('บัญชีนี้ไม่ได้สังกัด สภ. จึงสร้างแผนภูมิสถานีตนเองไม่ได้');
      error.code = 'REPORT_FAILED';
      throw error;
    }
    const own = request.chart_own === true;
    const persons = createPersonService(db);
    const filters = own ? {} : { province: request.filters.province || '' };
    const summary = persons.summarizePersons(user, filters);
    if (!own && !summary.total) { const error = new Error(`ไม่พบข้อมูลของจังหวัด${filters.province || ''} ในข้อมูลทดสอบ จึงไม่สร้างไฟล์แผนภูมิ`); error.code = 'REPORT_FAILED'; throw error; }
    if (own) {
      return chartPresentation.peopleChart({ rows: [{ station_name: profile.stationName, psychiatric_total: summary.byType.psychiatric || 0, drug_user_total: summary.byType.drug_user || 0, dealer_total: summary.byType.dealer || 0, released_total: summary.byType.released || 0, target_total: summary.total }] }, { own: true, areaLabel: profile.stationName, source: 'test' });
    }
    const groups = persons.groupByLocation(user, { groupBy: 'station', ...filters });
    return { type: 'chart', chartType: 'bar', title: `บุคคลเป้าหมายราย สภ. • จังหวัด${filters.province}`, areaLabel: `จังหวัด${filters.province} (ข้อมูลตามสิทธิ์บัญชี)`, labels: groups.groups.map(g => g.name), values: groups.groups.map(g => g.count), total: summary.total, unit: 'คน', dataSource: 'test', asOf: new Date().toISOString() };
  };
  const router = express.Router();
  router.post('/summary.pdf', authRequired, async (req, res) => {
    try {
      const request = safeReportRequest(req.body && req.body.reportRequest);
      if (request.report_kind === 'chart') {
        const report = await writeChartPdf(buildFixtureChart(req.user, request));
        audit(req.user, 'chart_pdf_export', '/api/reports/summary.pdf');
        return res.download(report.path, 'thanipitak-chart.pdf', (err) => {
          fs.unlink(report.path, () => {});
          if (err && !res.headersSent) res.status(500).json({ error: 'สร้างรายงานไม่สำเร็จ' });
        });
      }
      const report = await createSummaryPdf(db, req.user, req.body && req.body.reportRequest);
      audit(req.user, 'summary_pdf_export', '/api/reports/summary.pdf');
      return res.download(report.path, 'thanipitak-summary.pdf', (err) => {
        fs.unlink(report.path, () => {});
        if (err && !res.headersSent) res.status(500).json({ error: 'สร้างรายงานไม่สำเร็จ' });
      });
    } catch (err) {
      return res.status(400).json({ error: err.message || 'สร้างรายงานไม่สำเร็จ', code: err.code === 'REAL_FEATURE_REQUIRED' ? 'REAL_FEATURE_REQUIRED' : 'REPORT_FAILED' });
    }
  });
  router.post('/summary.xlsx', authRequired, (req, res) => {
    try {
      const request = safeReportRequest(req.body && req.body.reportRequest);
      if (request.report_kind === 'chart') return res.status(400).json({ error: 'แผนภูมิรองรับการส่งออกเป็นไฟล์ PDF เท่านั้น กรุณาสั่ง “สร้าง PDF” จากแผนภูมินั้น', code: 'REPORT_FAILED' });
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
