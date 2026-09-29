'use strict';

// Renders an aggregate chart presentation (frontend/charts.js shape) as a
// branded PDF. The chart must already come from an authenticated, audited
// read; this module only draws numbers it is given and never reads data.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const PDFDocument = require('pdfkit');

const REPORT_DIR = path.join(__dirname, '..', '..', 'output', 'pdf');
const DEFAULT_FONT = 'C:\\Windows\\Fonts\\tahoma.ttf';
const LOGO_PATH = path.join(__dirname, '..', '..', 'frontend', 'thanipitak-logo.png');
const COLORS = { navy: '#172B46', blue: '#315A87', red: '#9E2532', pale: '#F4F8FC', line: '#DCE5EF', muted: '#64748B', ink: '#203247' };
const MAX_ROWS = 60;

// Same honesty rule as the chat chart: refuse anything that is not a complete,
// consistent set of non-negative integers instead of printing a broken graph.
function validatedChart(chart) {
  if (!chart || typeof chart !== 'object') throw badChart();
  const labels = Array.isArray(chart.labels) ? chart.labels : null;
  const values = Array.isArray(chart.values) ? chart.values : null;
  if (!labels || !values || !labels.length || labels.length !== values.length || labels.length > MAX_ROWS) throw badChart();
  const clean = labels.map((label, index) => {
    const value = Number(values[index]);
    if (!Number.isSafeInteger(value) || value < 0) throw badChart();
    return { label: String(label ?? '').trim().slice(0, 80) || '-', value };
  });
  const total = clean.reduce((sum, row) => sum + row.value, 0);
  if (chart.total !== undefined && Number(chart.total) !== total) {
    const error = new Error('chart totals do not match plotted values');
    error.code = 'REAL_DATA_UNVERIFIABLE';
    throw error;
  }
  return {
    title: String(chart.title || 'แผนภูมิ').slice(0, 160),
    rows: clean,
    total,
    unit: String(chart.unit || 'คน').slice(0, 20),
    chartType: chart.chartType === 'line' ? 'line' : 'bar',
    from: typeof chart.from === 'string' ? chart.from.slice(0, 10) : null,
    to: typeof chart.to === 'string' ? chart.to.slice(0, 10) : null,
    windowLabel: typeof chart.windowLabel === 'string' ? chart.windowLabel.slice(0, 100) : null,
    note: typeof chart.note === 'string' ? chart.note.slice(0, 160) : '',
  };
}

function badChart() {
  const error = new Error('แผนภูมิที่ขอส่งออกไม่มีข้อมูลตัวเลขที่ตรวจสอบได้');
  error.code = 'REAL_DATA_UNVERIFIABLE';
  return error;
}

function drawHeader(doc, continuation) {
  const { width } = doc.page;
  doc.rect(0, 0, width, 112).fill(COLORS.navy);
  doc.rect(0, 108, width, 4).fill(COLORS.red);
  if (fs.existsSync(LOGO_PATH)) doc.image(LOGO_PATH, 42, 24, { fit: [62, 62] });
  doc.fillColor('#FFFFFF').font('Thai').fontSize(10).text('THANIPITAK INTELLIGENCE DESK', 118, 29, { characterSpacing: 1.1 });
  doc.fontSize(20).text(continuation ? 'รายงานแผนภูมิ (ต่อ)' : 'รายงานแผนภูมิข้อมูล', 118, 47);
  doc.fontSize(9).fillColor('#D9E5F1').text('ข้อมูลตามสิทธิ์การเข้าถึงของผู้ใช้งาน', 118, 76);
  doc.fillColor(COLORS.ink);
  doc.x = 42;
  doc.y = 132;
}

function drawFooter(doc, pageNumber, pageCount) {
  const { width, height } = doc.page;
  doc.strokeColor(COLORS.line).lineWidth(0.7).moveTo(42, height - 43).lineTo(width - 42, height - 43).stroke();
  const bottomMargin = doc.page.margins.bottom;
  doc.page.margins.bottom = 0;
  doc.font('Thai').fontSize(8).fillColor(COLORS.muted)
    .text('ธานีพิทักษ์ AI • เอกสารนี้ไม่รวมเลขบัตรประชาชนและหมายเลขโทรศัพท์', 42, height - 32, { lineBreak: false })
    .text(`หน้า ${pageNumber} / ${pageCount}`, width - 115, height - 32, { width: 73, align: 'right', lineBreak: false });
  doc.page.margins.bottom = bottomMargin;
}

function ensureSpace(doc, height) {
  if (doc.y + height <= doc.page.height - 58) return false;
  doc.addPage();
  return true;
}

function drawBarRows(doc, chart) {
  const labelWidth = 170;
  const barLeft = 42 + labelWidth + 10;
  const barMax = doc.page.width - 42 - 60 - barLeft;
  const max = Math.max(1, ...chart.rows.map((row) => row.value));
  chart.rows.forEach((row, index) => {
    ensureSpace(doc, 26);
    const y = doc.y;
    if (index % 2 === 0) doc.rect(42, y - 3, 511, 24).fill('#F8FAFC');
    doc.font('Thai').fontSize(8.5).fillColor(COLORS.ink)
      .text(row.label, 42, y + 2, { width: labelWidth, align: 'right', ellipsis: true, lineBreak: false });
    const barWidth = Math.max(row.value > 0 ? 2 : 0, Math.round((row.value / max) * barMax));
    doc.roundedRect(barLeft, y, barWidth, 13, 2).fill(index === 0 && chart.chartType === 'bar' ? COLORS.red : COLORS.blue);
    doc.fontSize(8.5).fillColor(COLORS.muted).text(String(row.value), barLeft + barWidth + 6, y + 2, { lineBreak: false });
    doc.y = y + 22;
  });
}

function drawLineChart(doc, chart) {
  const left = 70;
  const right = doc.page.width - 60;
  const top = doc.y + 6;
  const height = Math.min(200, doc.page.height - doc.y - 150);
  const max = Math.max(1, ...chart.rows.map((row) => row.value));
  const stepX = chart.rows.length > 1 ? (right - left) / (chart.rows.length - 1) : 0;
  const pointAt = (index) => ({
    x: left + stepX * index,
    y: top + height - (chart.rows[index].value / max) * (height - 24),
  });
  doc.strokeColor(COLORS.line).lineWidth(0.7);
  for (const fraction of [0, 0.5, 1]) {
    const y = top + height - fraction * (height - 24);
    doc.moveTo(left, y).lineTo(right, y).stroke();
    doc.font('Thai').fontSize(8).fillColor(COLORS.muted).text(String(Math.round(max * fraction)), 34, y - 4, { width: 30, align: 'right', lineBreak: false });
  }
  doc.moveTo(left, top + height).lineTo(right, top + height).stroke();
  const first = pointAt(0);
  doc.strokeColor(COLORS.blue).lineWidth(2).moveTo(first.x, first.y);
  chart.rows.forEach((_, index) => {
    const point = pointAt(index);
    doc.lineTo(point.x, point.y);
  });
  doc.stroke();
  chart.rows.forEach((row, index) => {
    const point = pointAt(index);
    doc.circle(point.x, point.y, 2.6).fill(COLORS.blue);
    doc.font('Thai').fontSize(7).fillColor(COLORS.muted)
      .text(row.label, point.x - 22, top + height + 6, { width: 44, align: 'center', angle: index % 2 ? -45 : 0 });
  });
  doc.y = top + height + 46;
}

function drawValueTable(doc, chart) {
  ensureSpace(doc, 40);
  doc.moveDown(0.6);
  doc.x = 42;
  doc.font('Thai').fontSize(13).fillColor(COLORS.ink).text(`ตัวเลขแผนภูมิ (${chart.rows.length} รายการ)`);
  doc.moveDown(0.3);
  const columns = [32, 379, 100];
  const headerY = doc.y;
  doc.roundedRect(42, headerY, 511, 24, 6).fill(COLORS.blue);
  doc.font('Thai').fontSize(8.5).fillColor('#FFFFFF')
    .text('ลำดับ', 49, headerY + 7, { width: columns[0] - 10, lineBreak: false })
    .text('รายการ', 42 + columns[0] + 7, headerY + 7, { width: columns[1] - 12, lineBreak: false })
    .text(`จำนวน (${chart.unit})`, 42 + columns[0] + columns[1] + 7, headerY + 7, { width: columns[2] - 12, align: 'right', lineBreak: false });
  doc.y = headerY + 28;
  chart.rows.forEach((row, index) => {
    const rowHeight = Math.max(20, doc.heightOfString(row.label, { width: columns[1] - 12 }) + 10);
    if (ensureSpace(doc, rowHeight + 24)) {
      // page header redraw consumed the space; table header repeats for reading
    }
    const y = doc.y;
    doc.rect(42, y, 511, rowHeight).fill(index % 2 ? '#FFFFFF' : '#F8FAFC');
    doc.font('Thai').fontSize(8.5)
      .fillColor(COLORS.muted).text(String(index + 1), 49, y + 5, { width: columns[0] - 10, lineBreak: false })
      .fillColor(COLORS.ink).text(row.label, 42 + columns[0] + 7, y + 5, { width: columns[1] - 12, lineGap: 1 })
      .fillColor(COLORS.muted).text(String(row.value), 42 + columns[0] + columns[1] + 7, y + 5, { width: columns[2] - 12, align: 'right', lineBreak: false });
    doc.y = y + rowHeight;
  });
}

async function writeChartPdf(input) {
  const chart = validatedChart(input);
  const fontPath = process.env.REPORT_FONT_PATH || DEFAULT_FONT;
  if (!fs.existsSync(fontPath)) throw new Error('ไม่พบฟอนต์ภาษาไทยสำหรับสร้างรายงาน');
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const filename = `chart-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(4).toString('hex')}.pdf`;
  const outputPath = path.join(REPORT_DIR, filename);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 42, bufferPages: true, info: { Title: `${chart.title} - ธานีพิทักษ์ AI`, Author: 'ธานีพิทักษ์ AI' } });
    const stream = fs.createWriteStream(outputPath);
    doc.pipe(stream);
    doc.registerFont('Thai', fontPath);
    doc.font('Thai');
    doc.on('pageAdded', () => drawHeader(doc, true));
    drawHeader(doc, false);
    const when = new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Bangkok' }).format(new Date());
    const metaTop = doc.y;
    doc.roundedRect(42, metaTop, 511, 74, 10).fillAndStroke('#FFFFFF', COLORS.line);
    doc.fontSize(9).fillColor(COLORS.muted).text('แผนภูมิ', 56, metaTop + 11);
    doc.fontSize(12).fillColor(COLORS.ink).text(chart.title, 56, metaTop + 26, { width: 380, ellipsis: true, lineBreak: false });
    const period = chart.windowLabel || (chart.from ? `${chart.from} ถึง ${chart.to}` : '');
    doc.fontSize(8.5).fillColor(COLORS.muted).text(`จัดทำเมื่อ ${when}${period ? ` • ช่วง ${period}` : ''}`, 56, metaTop + 45, { width: 380, ellipsis: true, lineBreak: false });
    if (chart.note) doc.fontSize(8).fillColor(COLORS.muted).text(chart.note, 56, metaTop + 58, { width: 380, ellipsis: true, lineBreak: false });
    doc.fontSize(20).fillColor(COLORS.red).text(String(chart.total), 440, metaTop + 16, { width: 96, align: 'right', lineBreak: false });
    doc.fontSize(9).fillColor(COLORS.muted).text(chart.unit, 440, metaTop + 44, { width: 96, align: 'right', lineBreak: false });
    doc.x = 42;
    doc.y = metaTop + 92;
    if (chart.chartType === 'line' && chart.rows.length > 1) drawLineChart(doc, chart);
  else drawBarRows(doc, chart);
    drawValueTable(doc, chart);
    ensureSpace(doc, 40);
    doc.x = 42;
    doc.moveDown(0.6).fontSize(8.5).fillColor(COLORS.muted)
      .text('หมายเหตุ: รายงานนี้สร้างจากข้อมูลที่ระบบอนุญาตให้เข้าถึง ณ เวลาจัดทำ และควรตรวจสอบข้อมูลอ้างอิงก่อนนำไปใช้', { width: 511, lineGap: 2 });
    const pages = doc.bufferedPageRange();
    for (let index = 0; index < pages.count; index += 1) {
      doc.switchToPage(index);
      drawFooter(doc, index + 1, pages.count);
    }
    doc.end();
    stream.on('finish', () => resolve({ path: outputPath, filename, chart }));
    stream.on('error', reject);
    doc.on('error', reject);
  });
}

module.exports = { writeChartPdf, validatedChart };
