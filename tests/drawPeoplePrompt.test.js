const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'deploy', 'draw-server', 'index.html'), 'utf8');
const start = html.indexOf('const personPositions=');
const end = html.indexOf('function renderPersonRows()');
assert.ok(start >= 0 && end > start, 'portrait prompt builder is present');

function build(count, people) {
  return vm.runInNewContext(
    html.slice(start, end) + '\nmakePeoplePrompt(count,"เต็มตัว","สตูดิโอพื้นหลังสีเทา",people)',
    { count, people },
  );
}

test('portrait helper keeps the exact count, person positions, and each pose', () => {
  const prompt = build(3, [
    { description: 'ผู้หญิงเสื้อแดง', pose: 'ยืนกอดอก' },
    { description: 'ผู้ชายเสื้อน้ำเงิน', pose: 'นั่งมือวางบนหัวเข่า' },
    { description: 'ผู้หญิงเสื้อเหลือง', pose: 'ยืนถือร่ม' },
  ]);
  assert.match(prompt, /เพียงสามคนเท่านั้น/);
  assert.match(prompt, /คนที่หนึ่งอยู่ด้านซ้าย: ผู้หญิงเสื้อแดง, ยืนกอดอก/);
  assert.match(prompt, /คนที่สองอยู่ตรงกลาง: ผู้ชายเสื้อน้ำเงิน, นั่งมือวางบนหัวเข่า/);
  assert.match(prompt, /คนที่สามอยู่ด้านขวา: ผู้หญิงเสื้อเหลือง, ยืนถือร่ม/);
  assert.match(prompt, /ไม่มีบุคคลอื่น/);
});

test('one-person prompt is placed in the center', () => {
  const prompt = build(1, [{ description: 'ชายเสื้อดำ', pose: 'ยืนชูมือขวา' }]);
  assert.match(prompt, /เพียงหนึ่งคนเท่านั้น/);
  assert.match(prompt, /คนที่หนึ่งอยู่ตรงกลาง: ชายเสื้อดำ, ยืนชูมือขวา/);
});
