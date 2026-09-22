'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { correctTranscript } = require('../src/stt/correctTranscript');

test('corrects the misheard ผู้ป่วย forms from small Whisper', () => {
  assert.equal(correctTranscript('ขอข้อมูลพูปไว้'), 'ขอข้อมูลผู้ป่วย');
  assert.equal(correctTranscript('ขอข้อมูลผู้ปวย'), 'ขอข้อมูลผู้ป่วย');
  assert.equal(correctTranscript('มีผู้ป่วยกี่คน'), 'มีผู้ป่วยกี่คน');
  assert.equal(correctTranscript('คนไข่จิตเวช'), 'คนไข้จิตเวช');
  assert.equal(correctTranscript('ช่วยทำเป็นรายงานพีทีเอฟให้หน่อย'), 'ช่วยทำเป็นรายงานpdfให้หน่อย');
});

test('does not invent registry terms in unrelated text', () => {
  assert.equal(correctTranscript('สวัสดีครับ'), 'สวัสดีครับ');
  assert.equal(correctTranscript('ขอข้อมูลเพิ่มเติม'), 'ขอข้อมูลเพิ่มเติม');
});

test('corrects สภ. and บุคคล mishears so ranking questions route to the registry', () => {
  assert.equal(correctTranscript('ขอสอบพอทที่มีบุลคลมากที่สุด 5 อันดับแรก'), 'ขอสภ.ที่มีบุคคลมากที่สุด 5 อันดับแรก');
  assert.equal(correctTranscript('ขอสอบพอดที่มีบุคคัลมากที่สุด 5 อันดับแรก'), 'ขอสภ.ที่มีบุคคลมากที่สุด 5 อันดับแรก');
  assert.equal(correctTranscript('สอพอทไหนมีผู้เสพมากที่สุด'), 'สภ.ไหนมีผู้เสพมากที่สุด');
  assert.equal(correctTranscript('สถานีตำรวจที่มีบุคคลมากที่สุด'), 'สถานีตำรวจที่มีบุคคลมากที่สุด');
});
