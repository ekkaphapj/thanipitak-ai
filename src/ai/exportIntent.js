'use strict';

const { normalizeSpokenConnectors } = require('./spokenGeo');
const { mergeTopicFilters } = require('./conversationTopic');

function detectMentionedTypes(text) {
  const types = [];
  if (/ผู้ป่วยจิตเวช|คนไข้จิตเวช|จิตเวช/.test(text)) types.push('psychiatric');
  else if (/ผู้ป่วย|คนไข้/.test(text)) types.push('psychiatric');
  if (/ผู้ใช้ยาเสพติด|คนใช้ยา|ผู้เสพ|คนเสพ/.test(text) || (/ยาเสพติด/.test(text) && !/จิตเวช/.test(text))) types.push('drug_user');
  if (/ผู้จำหน่าย|คนขายยา|พ่อค้ายา|ผู้ค้า/.test(text)) types.push('dealer');
  if (/ออกจากเรือนจำ|ออกจากคุก|ผู้พ้นโทษ|พ้นโทษ/.test(text)) types.push('released');
  return types;
}

function normalizeExportSpeak(text) {
  return String(text || '')
    .replace(/พี\s*ที\s*เอฟ/g, 'pdf')
    .replace(/พี\s*ทิ\s*เอฟ/g, 'pdf')
    .replace(/พี\s*ทียฟ/g, 'pdf')
    .replace(/พี\s*ดี\s*เอฟ/g, 'pdf')
    .replace(/พี\s*ดียฟ/g, 'pdf')
    .replace(/พีดีเอ็ฟ/g, 'pdf')
    .replace(/บีดีเอฟ/g, 'pdf')
    .replace(/พีดีเอฟ/g, 'pdf')
    .replace(/พีทีเอฟ/g, 'pdf');
}

function detectExportIntent(message) {
  const text = normalizeExportSpeak(normalizeSpokenConnectors(message));
  if (!text) return null;
  const wantsExcel = /excel|xlsx|เอ็กเซล|เอ็กเซลล์|ซีเอสวี|\bcsv\b|ไฟล์ตาราง/i.test(text);
  const wantsPdf = /\bpdf\b|พีดีเอฟ/i.test(text);
  const makeFile = /(?:ช่วย)?(?:ทำ|สร้าง|ออก|ขอ|แปลง|เซฟ|เซฟเป็น|ทำเป็น)(?:เป็น)?(?:รายงาน|ไฟล์)/.test(text);
  const reportSpeak = /รายงาน(?:ให้หน่อย|หน่อย)|ขอรายงาน|สร้างรายงาน|ทำรายงาน|ออกรายงาน|ทำเป็นรายงาน/.test(text);
  const fileSpeak = /ไฟล์(?:รายงาน|พี|pdf)|รายงาน(?:ไฟล์|พี)/i.test(text);
  const peePrefix = /รายงานพี|ไฟล์พี|เป็นพี|เป็น\s*พี/.test(text);
  if (!wantsExcel && !wantsPdf && !makeFile && !reportSpeak && !fileSpeak && !peePrefix) return null;
  if (/รายงานผู้ดูแล/.test(text) && !makeFile && !wantsPdf && !wantsExcel) return null;
  const formats = [];
  if (wantsExcel && !wantsPdf && !peePrefix) formats.push('xlsx');
  else {
    if (wantsPdf || peePrefix || makeFile || reportSpeak || fileSpeak) formats.push('pdf');
    if (wantsExcel) formats.push('xlsx');
  }
  if (!formats.length) formats.push('pdf');
  const ambiguous = !wantsPdf && !wantsExcel && (makeFile || reportSpeak || fileSpeak || peePrefix);
  const heardPee = /พี/.test(message || '') && !/\bpdf\b/i.test(message || '');
  const confirm = Boolean(ambiguous || peePrefix || (wantsPdf && heardPee));
  const types = detectMentionedTypes(text);
  const filters = {};
  if (types.length === 1) filters.person_type = types[0];
  if (/เสี่ยงสูง/.test(text)) filters.level = 'high';
  else if (/เฝ้าระวัง/.test(text)) filters.level = 'watch';
  return {
    intent: 'export_report',
    formats,
    auto: confirm || formats.length !== 1 ? null : formats[0],
    confirm,
    filters,
  };
}

function reportRequestFromExport(intent, topic) {
  const filters = mergeTopicFilters(intent.filters || {}, topic);
  if (!filters.level) filters.level = 'all';
  return {
    filters,
    includeCount: true,
    includeList: true,
    sort: 'name_asc',
  };
}

module.exports = { detectExportIntent, reportRequestFromExport };
