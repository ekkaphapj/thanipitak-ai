'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const PDFDocument = require('pdfkit');

const OUTPUT = path.join(__dirname, '..', '..', 'output', 'pdf');
const FONT = 'C:\\Windows\\Fonts\\tahoma.ttf';
const LOGO = path.join(__dirname, '..', '..', 'frontend', 'thanipitak-logo.png');
const COLORS = { navy: '#172B46', ink: '#203247', muted: '#66788E', line: '#DCE5EF', red: '#AE2938', orange: '#D77A1D', amber: '#AF8119', pale: '#F4F8FC' };
const TYPE = { psychiatric: 'ผู้ป่วยจิตเวช', drug_user: 'ผู้เสพ', released: 'บุคคลพ้นโทษ' };
const PRIORITY = [
  { title: '1  เสี่ยงสูง - ไม่มีการเยี่ยมใน 7 วัน', color: COLORS.red },
  { title: '2  สีแดง - ยังไม่เคยตรวจเยี่ยม', color: '#C94754' },
  { title: '3  เฝ้าระวัง - ไม่มีการเยี่ยมใน 14 วัน', color: COLORS.amber },
  { title: '4  สีส้ม - ยังไม่เคยตรวจเยี่ยม', color: COLORS.orange },
];

function writeVisitPlanPdf(plan) {
  if (!plan || plan.status !== 'ok' || !plan.station || !Array.isArray(plan.items)) throw new Error('ข้อมูลแผนการตรวจเยี่ยมไม่ครบ');
  const font = process.env.REPORT_FONT_PATH || FONT;
  if (!fs.existsSync(font)) throw new Error('ไม่พบฟอนต์ภาษาไทยสำหรับสร้างรายงาน');
  fs.mkdirSync(OUTPUT, { recursive: true });
  const filename = `visit-plan-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(4).toString('hex')}.pdf`;
  const outputPath = path.join(OUTPUT, filename);
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margins: { top: 130, left: 40, right: 40, bottom: 62 }, bufferPages: true,
      info: { Title: 'แผนการตรวจเยี่ยม - ธานีพิทักษ์ AI', Author: 'ธานีพิทักษ์ AI' } });
    const stream = fs.createWriteStream(outputPath);
    doc.pipe(stream);
    doc.registerFont('Thai', font);
    doc.font('Thai');
    function header(continuation = false) {
      doc.rect(0, 0, 595.28, 112).fill(COLORS.navy);
      doc.rect(0, 108, 595.28, 4).fill(COLORS.red);
      if (fs.existsSync(LOGO)) doc.image(LOGO, 40, 22, { fit: [62, 62] });
      doc.fillColor('#FFFFFF').fontSize(9).text('THANIPITAK INTELLIGENCE DESK', 115, 27);
      doc.fontSize(19).text(continuation ? 'แผนการตรวจเยี่ยม (ต่อ)' : 'แผนการตรวจเยี่ยม', 115, 45, { width: 440 });
      doc.fontSize(10).fillColor('#D9E5F1').text(`${plan.station.station_name}  •  ภ.จว.${plan.station.province}`, 115, 77, { width: 440 });
      doc.x = 40; doc.y = 130;
    }
    function ensure(height) { if (doc.y + height > doc.page.height - 105) doc.addPage(); }
    function section(text) { ensure(31); doc.x = 40; doc.fontSize(12).fillColor(COLORS.ink).text(text, 40, doc.y); doc.moveDown(0.35); }
    function footer(page, total) {
      const y = doc.page.height - 85;
      doc.strokeColor(COLORS.line).lineWidth(0.7).moveTo(40, y).lineTo(555, y).stroke();
      doc.fontSize(8).fillColor(COLORS.muted).text('ข้อมูลตามสิทธิ์บัญชี • ไม่รวมเลขบัตรประชาชนและหมายเลขโทรศัพท์', 40, y + 8, { width: 420, lineBreak: false });
      doc.text(`หน้า ${page} / ${total}`, 487, y + 8, { width: 68, align: 'right', lineBreak: false });
    }
    doc.on('pageAdded', () => header(true));
    header();
    const when = new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Bangkok' }).format(new Date());
    doc.roundedRect(40, doc.y, 515, 55, 10).fillAndStroke('#FFFFFF', COLORS.line);
    doc.fontSize(9).fillColor(COLORS.muted).text(`ข้อมูล ณ ${plan.asOf || '-'}  •  จัดทำ ${when}`, 54, doc.y + 10, { width: 367 });
    doc.fontSize(11).fillColor(COLORS.ink).text('เรียงลำดับตามผลเยี่ยมและสถานะที่บันทึก', 54, doc.y + 4, { width: 367 });
    doc.fontSize(19).fillColor(COLORS.red).text(`${plan.totalDue} คน`, 448, doc.y - 30, { width: 91, align: 'right' });
    doc.y = 199;

    section('ภาพรวม 3 ประเภท');
    const col = [155, 72, 72, 72, 72, 72];
    const headY = doc.y;
    doc.roundedRect(40, headY, 515, 27, 5).fill(COLORS.navy);
    let x = 40;
    ['ประเภท', 'เสี่ยงสูง', 'เฝ้าระวัง', 'สีแดง', 'สีส้ม', 'ไม่เคยเยี่ยม'].forEach((label, i) => {
      doc.fontSize(8.3).fillColor('#FFFFFF').text(label, x + 6, headY + 8, { width: col[i] - 9, align: i ? 'right' : 'left', lineBreak: false }); x += col[i];
    });
    doc.y = headY + 29;
    ['psychiatric', 'drug_user', 'released'].forEach((key, index) => {
      const counts = plan.counts?.[key] || {};
      const rowY = doc.y;
      doc.rect(40, rowY, 515, 29).fill(index % 2 ? '#FFFFFF' : COLORS.pale);
      x = 40;
      [TYPE[key], counts.high || 0, counts.watch || 0, counts.red || 0, counts.orange || 0, counts.never_visited || 0].forEach((value, i) => {
        doc.fontSize(9).fillColor(i === 1 ? COLORS.red : COLORS.ink).text(String(value), x + 6, rowY + 8, { width: col[i] - 9, align: i ? 'right' : 'left', lineBreak: false }); x += col[i];
      });
      doc.y = rowY + 29;
    });
    doc.y += 18;
    section('ลำดับงานเร่งด่วน');
    PRIORITY.forEach((entry, index) => {
      ensure(28); const y = doc.y;
      doc.roundedRect(40, y, 515, 25, 5).fill(index % 2 ? '#FFFFFF' : COLORS.pale);
      doc.rect(40, y, 4, 25).fill(entry.color);
      doc.fontSize(9).fillColor(COLORS.ink).text(entry.title, 53, y + 7, { width: 420, lineBreak: false });
      doc.fontSize(10).fillColor(entry.color).text(`${plan.priorityCounts?.[index] || 0} คน`, 478, y + 6, { width: 64, align: 'right', lineBreak: false });
      doc.y = y + 26;
    });
    doc.y += 18;
    section(`รายชื่อที่ต้องตรวจเยี่ยม (${plan.items.length} คน)`);
    if (!plan.items.length) doc.fontSize(10).fillColor(COLORS.muted).text('ไม่พบผู้ที่เข้าเกณฑ์เร่งด่วนในขณะนี้', 40, doc.y, { width: 515 });
    let previousPriority = null;
    plan.items.forEach((item, index) => {
      const priority = Number(item.priority);
      if (priority !== previousPriority) {
        ensure(33);
        doc.x = 40; doc.fontSize(10).fillColor(PRIORITY[priority - 1]?.color || COLORS.ink).text(PRIORITY[priority - 1]?.title || `ลำดับ ${priority}`, 40, doc.y);
        doc.moveDown(0.25); previousPriority = priority;
      }
      const area = [item.subdistrict && `ต.${item.subdistrict}`, item.district && `อ.${item.district}`].filter(Boolean).join('  ');
      const line1 = `${index + 1}. ${item.full_name || 'ไม่ระบุชื่อ'}`;
      const line2 = `${TYPE[item.person_type] || '-'}  •  ${item.risk_level === 'high' ? 'เสี่ยงสูง' : item.risk_level === 'watch' ? 'เฝ้าระวัง' : 'ไม่ระบุระดับ'}${item.color ? `  •  สี${item.color}` : ''}`;
      const line3 = `เยี่ยมล่าสุด ${item.last_visit_date || 'ยังไม่เคย'}${area ? `  •  ${area}` : ''}`;
      doc.font('Thai').fontSize(9);
      const rowHeight = Math.max(44, doc.heightOfString(line1, { width: 450 }) + doc.heightOfString(line2, { width: 450 }) + doc.heightOfString(line3, { width: 450 }) + 15);
      ensure(rowHeight + 4);
      const y = doc.y;
      doc.roundedRect(40, y, 515, rowHeight, 7).fillAndStroke(index % 2 ? '#FFFFFF' : COLORS.pale, COLORS.line);
      doc.rect(40, y + 5, 4, rowHeight - 10).fill(PRIORITY[priority - 1]?.color || COLORS.navy);
      doc.fontSize(9.5).fillColor(COLORS.ink).text(line1, 53, y + 6, { width: 487 });
      doc.fontSize(8.5).fillColor(COLORS.muted).text(line2, 53, doc.y + 2, { width: 487 });
      doc.text(line3, 53, doc.y + 1, { width: 487 });
      doc.y = y + rowHeight + 4;
    });
    ensure(42);
    doc.moveDown(0.8).fontSize(8).fillColor(COLORS.muted).text('แผนนี้อ้างอิงผลตรวจเยี่ยมและรายงานผู้ดูแลที่บันทึกไว้ ณ เวลาจัดทำ ระดับความเสี่ยงไม่ใช่การวินิจฉัย', 40, doc.y, { width: 515 });
    const pages = doc.bufferedPageRange();
    for (let i = 0; i < pages.count; i += 1) { doc.switchToPage(i); footer(i + 1, pages.count); }
    doc.end();
    stream.on('finish', () => resolve({ path: outputPath, filename }));
    stream.on('error', reject); doc.on('error', reject);
  });
}

module.exports = { writeVisitPlanPdf };
