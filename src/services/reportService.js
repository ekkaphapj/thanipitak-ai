'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const PDFDocument = require('pdfkit');
const { createSummaryService, TYPE_LABELS } = require('./summaryService');
const { createXlsxBuffer } = require('./excelReport');

const REPORT_DIR = path.join(__dirname, '..', '..', 'output', 'pdf');
const DEFAULT_FONT = 'C:\\Windows\\Fonts\\tahoma.ttf';
const LOGO_PATH = path.join(__dirname, '..', '..', 'frontend', 'thanipitak-logo.png');
const REPORT_COLORS = { navy: '#172B46', blue: '#315A87', red: '#9E2532', pale: '#F4F8FC', line: '#DCE5EF', muted: '#64748B', ink: '#203247' };

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
    report_kind: request.report_kind === 'target_person_aggregate' ? 'target_person_aggregate' : undefined,
    filters,
    includeList: !!request.includeList,
    includeCount: request.includeCount !== false,
    sort: ['name_asc', 'name_desc', 'count_asc', 'count_desc'].includes(request.sort) ? request.sort : 'name_asc',
  };
}

function reportFilterLabels(filters) {
  const labels = [];
  if (filters.person_type) labels.push(TYPE_LABELS[filters.person_type] || filters.person_type);
  if (filters.level === 'high') labels.push('เสี่ยงสูง');
  if (filters.level === 'watch') labels.push('เฝ้าระวัง');
  for (const [key, label] of [['province', 'จังหวัด'], ['station', 'สภ.'], ['district', 'อำเภอ'], ['subdistrict', 'ตำบล'], ['search', 'ชื่อ']]) {
    if (filters[key]) labels.push(`${label}${filters[key]}`);
  }
  return labels;
}

function drawReportHeader(doc, summary, continuation = false) {
  const { width } = doc.page;
  doc.rect(0, 0, width, 112).fill(REPORT_COLORS.navy);
  doc.rect(0, 108, width, 4).fill(REPORT_COLORS.red);
  if (fs.existsSync(LOGO_PATH)) doc.image(LOGO_PATH, 42, 24, { fit: [62, 62] });
  doc.fillColor('#FFFFFF').font('Thai').fontSize(10).text('THANIPITAK INTELLIGENCE DESK', 118, 29, { characterSpacing: 1.1 });
  doc.fontSize(20).text(continuation ? 'รายงานสรุปข้อมูลบุคคล (ต่อ)' : 'รายงานสรุปข้อมูลบุคคล', 118, 47);
  doc.fontSize(9).fillColor('#D9E5F1').text('ข้อมูลตามสิทธิ์การเข้าถึงของผู้ใช้งาน', 118, 76);
  doc.fillColor(REPORT_COLORS.ink);
  doc.x = 42;
  doc.y = 132;
}

function drawReportFooter(doc, pageNumber, pageCount) {
  const { width, height } = doc.page;
  doc.strokeColor(REPORT_COLORS.line).lineWidth(0.7).moveTo(42, height - 43).lineTo(width - 42, height - 43).stroke();
  const bottomMargin = doc.page.margins.bottom;
  doc.page.margins.bottom = 0;
  doc.font('Thai').fontSize(8).fillColor(REPORT_COLORS.muted)
    .text('ธานีพิทักษ์ AI • เอกสารนี้ไม่รวมเลขบัตรประชาชนและหมายเลขโทรศัพท์', 42, height - 32, { lineBreak: false })
    .text(`หน้า ${pageNumber} / ${pageCount}`, width - 115, height - 32, { width: 73, align: 'right', lineBreak: false });
  doc.page.margins.bottom = bottomMargin;
}

function ensureReportSpace(doc, summary, height) {
  if (doc.y + height <= doc.page.height - 58) return false;
  doc.addPage();
  return true;
}

function drawReportSectionTitle(doc, summary, title) {
  ensureReportSpace(doc, summary, 30);
  doc.x = 42;
  doc.font('Thai').fontSize(13).fillColor(REPORT_COLORS.ink).text(title);
  doc.moveDown(0.35);
}

function drawCountCards(doc, summary) {
  if (!summary.includeCount || !summary.counts.length) return;
  drawReportSectionTitle(doc, summary, 'สรุปจำนวนตามประเภท');
  const gap = 8;
  const count = Math.min(summary.counts.length, 4);
  const width = (511 - gap * (count - 1)) / count;
  const top = doc.y;
  summary.counts.slice(0, 4).forEach((row, index) => {
    const x = 42 + index * (width + gap);
    doc.roundedRect(x, top, width, 60, 8).fillAndStroke(REPORT_COLORS.pale, REPORT_COLORS.line);
    doc.font('Thai').fontSize(9).fillColor(REPORT_COLORS.muted).text(row.label, x + 10, top + 10, { width: width - 20, height: 16, ellipsis: true });
    doc.fontSize(22).fillColor(index === 0 ? REPORT_COLORS.red : REPORT_COLORS.ink).text(String(row.count), x + 10, top + 27, { width: width - 35, lineBreak: false });
    doc.fontSize(9).fillColor(REPORT_COLORS.muted).text('คน', x + width - 26, top + 37, { width: 16, lineBreak: false });
  });
  doc.y = top + 72;
}

function drawListHeader(doc) {
  const x = 42; const y = doc.y;
  const columns = [32, 188, 90, 74, 127];
  const labels = ['ลำดับ', 'ชื่อ - นามสกุล', 'ประเภท', 'ระดับ', 'พื้นที่'];
  doc.roundedRect(x, y, 511, 25, 6).fill(REPORT_COLORS.blue);
  let cursor = x;
  labels.forEach((label, index) => {
    doc.font('Thai').fontSize(8.5).fillColor('#FFFFFF').text(label, cursor + 7, y + 8, { width: columns[index] - 10, lineBreak: false });
    cursor += columns[index];
  });
  doc.y = y + 31;
}

function drawListRow(doc, summary, row, index) {
  const x = 42; const columns = [32, 188, 90, 74, 127];
  const type = TYPE_LABELS[row.person_type] || row.person_type || '-';
  const place = [row.subdistrict && `ต.${row.subdistrict}`, row.district && `อ.${row.district}`].filter(Boolean).join(' ')
    || (row.station ? `สภ.${row.station}` : '-');
  const values = [String(index + 1), row.full_name || '-', type, row.level || '-', place];
  const heights = values.map((value, column) => doc.heightOfString(value, { width: columns[column] - 12, lineGap: 1 }));
  const rowHeight = Math.max(25, ...heights.map((height) => height + 12));
  if (ensureReportSpace(doc, summary, rowHeight + 28)) drawListHeader(doc);
  const y = doc.y;
  doc.rect(x, y, 511, rowHeight).fill(index % 2 ? '#FFFFFF' : '#F8FAFC');
  doc.strokeColor(REPORT_COLORS.line).lineWidth(0.5).moveTo(x, y + rowHeight).lineTo(x + 511, y + rowHeight).stroke();
  let cursor = x;
  values.forEach((value, column) => {
    doc.font('Thai').fontSize(column === 0 ? 8 : 8.5).fillColor(column === 1 ? REPORT_COLORS.ink : REPORT_COLORS.muted)
      .text(value, cursor + 7, y + 6, { width: columns[column] - 12, lineGap: 1 });
    cursor += columns[column];
  });
  doc.y = y + rowHeight;
}

function drawAggregateStationHeader(doc) {
  const x = 42; const y = doc.y;
  const columns = [30, 126, 72, 57, 57, 57, 57, 55];
  const labels = ['ลำดับ', 'สภ.', 'จังหวัด', 'จิตเวช', 'ผู้เสพ', 'ผู้ค้า', 'พ้นโทษ', 'รวม'];
  doc.roundedRect(x, y, 511, 25, 6).fill(REPORT_COLORS.blue);
  let cursor = x;
  labels.forEach((label, index) => { doc.font('Thai').fontSize(8).fillColor('#FFFFFF').text(label, cursor + 5, y + 8, { width: columns[index] - 7, align: index > 2 ? 'right' : 'left', lineBreak: false }); cursor += columns[index]; });
  doc.y = y + 31;
}

function drawAggregateStationRow(doc, summary, row, index) {
  const x = 42; const columns = [30, 126, 72, 57, 57, 57, 57, 55];
  const values = [String(index + 1), row.stationName || '-', row.province || '-', row.psychiatric || 0, row.drugUser || 0, row.dealer || 0, row.released || 0, row.total || 0];
  const rowHeight = Math.max(25, ...values.map((value, column) => doc.heightOfString(String(value), { width: columns[column] - 10, lineGap: 1 }) + 12));
  if (ensureReportSpace(doc, summary, rowHeight + 28)) drawAggregateStationHeader(doc);
  const y = doc.y; doc.rect(x, y, 511, rowHeight).fill(index % 2 ? '#FFFFFF' : '#F8FAFC');
  doc.strokeColor(REPORT_COLORS.line).lineWidth(0.5).moveTo(x, y + rowHeight).lineTo(x + 511, y + rowHeight).stroke();
  let cursor = x;
  values.forEach((value, column) => { doc.font('Thai').fontSize(8).fillColor(column === 1 ? REPORT_COLORS.ink : REPORT_COLORS.muted).text(String(value), cursor + 5, y + 6, { width: columns[column] - 9, align: column > 2 ? 'right' : 'left', lineGap: 1 }); cursor += columns[column]; });
  doc.y = y + rowHeight;
}

function writeSummaryPdf(summary) {
  summary = summary || {};
  summary.filters = summary.filters || {};
  summary.counts = summary.counts || [];
  summary.items = summary.items || [];
  summary.aggregateRows = summary.aggregateRows || [];
  const fontPath = process.env.REPORT_FONT_PATH || DEFAULT_FONT;
  if (!fs.existsSync(fontPath)) throw new Error('ไม่พบฟอนต์ภาษาไทยสำหรับสร้างรายงาน');
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const filename = `summary-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(4).toString('hex')}.pdf`;
  const outputPath = path.join(REPORT_DIR, filename);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 42, bufferPages: true, info: { Title: 'รายงานสรุปข้อมูลบุคคล - ธานีพิทักษ์ AI', Author: 'ธานีพิทักษ์ AI' } });
    const stream = fs.createWriteStream(outputPath);
    doc.pipe(stream);
    doc.registerFont('Thai', fontPath);
    doc.font('Thai');
    doc.on('pageAdded', () => drawReportHeader(doc, summary, true));
    drawReportHeader(doc, summary);
    const when = new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Bangkok' }).format(new Date());
    const labels = reportFilterLabels(summary.filters);
    const metaTop = doc.y;
    doc.roundedRect(42, metaTop, 511, 62, 10).fillAndStroke('#FFFFFF', REPORT_COLORS.line);
    doc.fontSize(9).fillColor(REPORT_COLORS.muted).text('ขอบเขตข้อมูล', 56, metaTop + 11);
    doc.fontSize(11).fillColor(REPORT_COLORS.ink).text(labels.length ? labels.join(' • ') : 'ข้อมูลในพื้นที่ที่ผู้ใช้งานมีสิทธิ์เข้าถึง', 56, metaTop + 26, { width: 474, ellipsis: true });
    doc.fontSize(8.5).fillColor(REPORT_COLORS.muted).text(`จัดทำเมื่อ ${when}`, 56, metaTop + 45);
    doc.fontSize(17).fillColor(REPORT_COLORS.red).text(`${summary.total} คน`, 450, metaTop + 19, { width: 86, align: 'right' });
    doc.x = 42;
    doc.y = metaTop + 78;
    drawCountCards(doc, summary);
    if (summary.report_kind === 'target_person_aggregate') {
      drawReportSectionTitle(doc, summary, `ข้อมูลแยกตาม สภ. (${summary.aggregateRows.length} สภ.)`);
      drawAggregateStationHeader(doc);
      summary.aggregateRows.forEach((row, index) => drawAggregateStationRow(doc, summary, row, index));
    } else if (summary.includeList) {
      drawReportSectionTitle(doc, summary, `รายชื่อที่อยู่ในขอบเขต (${summary.items.length} รายการ)`);
      drawListHeader(doc);
      summary.items.forEach((row, index) => drawListRow(doc, summary, row, index));
    }
    ensureReportSpace(doc, summary, 40);
    doc.x = 42;
    doc.moveDown(0.6).fontSize(8.5).fillColor(REPORT_COLORS.muted)
      .text('หมายเหตุ: รายงานนี้สร้างจากข้อมูลที่ระบบอนุญาตให้เข้าถึง ณ เวลาจัดทำ และควรตรวจสอบข้อมูลอ้างอิงก่อนนำไปใช้', { width: 511, lineGap: 2 });
    const pages = doc.bufferedPageRange();
    for (let index = 0; index < pages.count; index += 1) {
      doc.switchToPage(index);
      drawReportFooter(doc, index + 1, pages.count);
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
  if (summary.report_kind === 'target_person_aggregate') {
    rows.push(['ข้อมูลแยกตาม สภ.']);
    rows.push(['ลำดับ', 'สภ.', 'จังหวัด', 'จิตเวช', 'ผู้เสพ', 'ผู้ค้า', 'ผู้พ้นโทษ', 'รวม']);
    (summary.aggregateRows || []).forEach((row, index) => rows.push([String(index + 1), row.stationName || '', row.province || '', String(row.psychiatric || 0), String(row.drugUser || 0), String(row.dealer || 0), String(row.released || 0), String(row.total || 0)]));
  } else if (summary.includeList) {
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
