'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const PDFDocument = require('pdfkit');
const { createSummaryService, TYPE_LABELS } = require('./summaryService');
const { createXlsxBuffer } = require('./excelReport');

const REPORT_DIR = path.join(__dirname, '..', '..', 'output', 'pdf');
const DEFAULT_FONT = 'C:\\Windows\\Fonts\\tahoma.ttf';

function safeReportRequest(input) {
  const request = input && typeof input === 'object' ? input : {};
  const rawFilters = request.filters && typeof request.filters === 'object' ? request.filters : {};
  const filters = {};
  for (const key of ['person_type', 'level', 'province', 'station', 'district', 'subdistrict', 'search']) {
    if (typeof rawFilters[key] === 'string' && rawFilters[key].trim()) filters[key] = rawFilters[key].trim().slice(0, 100);
  }
  if (!['psychiatric', 'drug_user', 'dealer', 'released'].includes(filters.person_type)) delete filters.person_type;
  if (!['all', 'watch', 'high'].includes(filters.level)) filters.level = 'all';
  return {
    filters,
    includeList: !!request.includeList,
    includeCount: request.includeCount !== false,
    sort: ['name_asc', 'name_desc', 'count_asc', 'count_desc'].includes(request.sort) ? request.sort : 'name_asc',
  };
}

function writeSummaryPdf(summary) {
  summary = summary || {};
  summary.filters = summary.filters || {};
  summary.counts = summary.counts || [];
  summary.items = summary.items || [];
  const fontPath = process.env.REPORT_FONT_PATH || DEFAULT_FONT;
  if (!fs.existsSync(fontPath)) throw new Error('ไม่พบฟอนต์ภาษาไทยสำหรับสร้างรายงาน');
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const filename = `summary-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(4).toString('hex')}.pdf`;
  const outputPath = path.join(REPORT_DIR, filename);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 42, bufferPages: true });
    const stream = fs.createWriteStream(outputPath);
    doc.pipe(stream);
    doc.registerFont('Thai', fontPath);
    doc.font('Thai');
    doc.fontSize(18).text('รายงานสรุปข้อมูลบุคคล', { align: 'center' });
    doc.moveDown(0.5);
    doc.fontSize(10).text(`จัดทำเมื่อ ${new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Bangkok' }).format(new Date())}`);
    doc.text(`ขอบเขต: ${summary.filters.level === 'high' ? 'เสี่ยงสูง' : summary.filters.level === 'watch' ? 'เฝ้าระวัง' : 'ทั้งหมด'} • จำนวน ${summary.total} คน`);
    const labels = [];
    for (const [key, label] of [['province', 'จังหวัด'], ['station', 'สภ.'], ['district', 'อำเภอ'], ['subdistrict', 'ตำบล'], ['search', 'ชื่อ']]) {
      if (summary.filters[key]) labels.push(`${label}${summary.filters[key]}`);
    }
    if (summary.filters.person_type) labels.unshift(TYPE_LABELS[summary.filters.person_type]);
    if (labels.length) doc.text(`เงื่อนไข: ${labels.join(' • ')}`);
    doc.moveDown();

    if (summary.includeCount) {
      doc.fontSize(13).text('สรุปจำนวนตามประเภท');
      doc.moveDown(0.25);
      for (const row of summary.counts) doc.fontSize(10).text(`• ${row.label} ${row.count} คน`);
      doc.moveDown();
    }
    if (summary.includeList) {
      doc.fontSize(13).text('รายชื่อ');
      doc.moveDown(0.25);
      summary.items.forEach((row, index) => {
        if (doc.y > 760) doc.addPage().font('Thai');
        doc.fontSize(9).text(`${index + 1}. ${row.full_name} — ${TYPE_LABELS[row.person_type] || row.person_type}${row.level ? ` — ${row.level}` : ''}`);
      });
    }
    const pages = doc.bufferedPageRange();
    for (let index = 0; index < pages.count; index += 1) {
      doc.switchToPage(index);
      doc.font('Thai').fontSize(8).text(`หน้า ${index + 1} / ${pages.count}`, 42, 785, { align: 'center', lineBreak: false });
    }
    doc.end();
    stream.on('finish', () => resolve({ path: outputPath, filename, summary }));
    stream.on('error', reject);
    doc.on('error', reject);
  });
}

function createSummaryPdf(db, user, input) {
  const request = safeReportRequest(input);
  const summary = createSummaryService(db).summarize(user, request).presentation;
  return writeSummaryPdf(summary);
}

function summaryRows(summary) {
  const when = new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Bangkok' }).format(new Date());
  const labels = [];
  if (summary.filters.person_type) labels.push(TYPE_LABELS[summary.filters.person_type]);
  if (summary.filters.level === 'high') labels.push('เสี่ยงสูง');
  if (summary.filters.level === 'watch') labels.push('เฝ้าระวัง');
  for (const [key, label] of [['province', 'จังหวัด'], ['station', 'สภ.'], ['district', 'อำเภอ'], ['subdistrict', 'ตำบล']]) {
    if (summary.filters[key]) labels.push(`${label}${summary.filters[key]}`);
  }
  const rows = [
    ['รายงานสรุปข้อมูลบุคคลธานีพิทักษ์'],
    [`จัดทำเมื่อ ${when}`],
    [`จำนวน ${summary.total} คน${labels.length ? ` • เงื่อนไข: ${labels.join(' • ')}` : ''}`],
    [],
  ];
  if (summary.includeCount && Array.isArray(summary.counts)) {
    rows.push(['สรุปจำนวนตามประเภท']);
    rows.push(['ประเภท', 'จำนวน']);
    for (const row of summary.counts) rows.push([row.label, String(row.count)]);
    rows.push([]);
  }
  if (summary.includeList) {
    rows.push(['รายชื่อ']);
    rows.push(['ลำดับ', 'ชื่อ', 'ประเภท', 'ระดับ', 'ตำบล', 'อำเภอ']);
    (summary.items || []).forEach((row, index) => {
      rows.push([
        String(index + 1),
        row.full_name || '',
        TYPE_LABELS[row.person_type] || row.person_type || '',
        row.level || '',
        row.subdistrict || '',
        row.district || '',
      ]);
    });
  }
  return rows;
}

function writeSummaryExcel(summary) {
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const filename = `summary-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(4).toString('hex')}.xlsx`;
  const outputPath = path.join(REPORT_DIR, filename);
  fs.writeFileSync(outputPath, createXlsxBuffer(summaryRows(summary)));
  return { path: outputPath, filename, summary };
}

function createSummaryExcel(db, user, input) {
  const request = safeReportRequest(input);
  const summary = createSummaryService(db).summarize(user, request).presentation;
  return writeSummaryExcel(summary);
}

module.exports = { createSummaryPdf, createSummaryExcel, writeSummaryPdf, writeSummaryExcel, safeReportRequest, REPORT_DIR, summaryRows };
