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

test('repairs an isolated station mishearing without corrupting รายชื่อ', () => {
  assert.equal(correctTranscript('ขอรายชื่ออ ผู้ป่วย จิตเวช ศพ กลางใหญ่ จังหวัดอุดรธานี'),
    'ขอรายชื่อ ผู้ป่วย จิตเวช สภ.กลางใหญ่ จังหวัดอุดรธานี');
  assert.equal(correctTranscript('ขอรายชื่อผู้ป่วยจิตเวช สพ กลางใหญ่ จังหวัดอุดรธานี'),
    'ขอรายชื่อผู้ป่วยจิตเวช สภ.กลางใหญ่ จังหวัดอุดรธานี');
  assert.equal(correctTranscript('ขอรายชื่อผู้ป่วยจิตเวช สภ.กลางใหญ่ จังหวัดอุดรธานี'),
    'ขอรายชื่อผู้ป่วยจิตเวช สภ.กลางใหญ่ จังหวัดอุดรธานี');
  assert.equal(correctTranscript('พบศพ กลางใหญ่'), 'พบศพ กลางใหญ่');
});

test('visit-plan station cue repairs only with a station name before the province boundary', () => {
  assert.equal(correctTranscript('ขอแผนการตรวจเยี่ยมของ ส พอร์ ทา อู เท น จังหวัดนครพนม'), 'ขอแผนการตรวจเยี่ยมของ สภ.ทา อู เท น จังหวัดนครพนม');
  assert.equal(correctTranscript('ขอแผนตรวจเยี่ยม ศพ ท่าอุเทน จังหวัดนครพนม'), 'ขอแผนตรวจเยี่ยม สภ.ท่าอุเทน จังหวัดนครพนม');
  assert.equal(correctTranscript('จัดคิวตรวจเยี่ยม สพอร์ ท่าอุเทน จังหวัดนครพนม'), 'จัดคิวตรวจเยี่ยม สภ.ท่าอุเทน จังหวัดนครพนม');
  // A cue directly followed by the province has no name to carry: leave it so
  // the route offers the province station list instead.
  assert.equal(correctTranscript('ขอแผนการตรวจเยี่ยม ศพ จังหวัดนครพนม'), 'ขอแผนการตรวจเยี่ยม ศพ จังหวัดนครพนม');
  // Corpse wording outside a visit-plan/registry request stays untouched.
  assert.equal(correctTranscript('พบศพในพื้นที่ สวนสาธารณะ'), 'พบศพในพื้นที่ สวนสาธารณะ');
  assert.equal(correctTranscript('แผนเยี่ยมชมสถานที่เกิดเหตุพบศพ ในจังหวัดอุดรธานี'), 'แผนเยี่ยมชมสถานที่เกิดเหตุพบศพ ในจังหวัดอุดรธานี');
});
