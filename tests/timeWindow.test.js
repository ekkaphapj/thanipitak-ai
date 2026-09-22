const {test}=require('node:test');const assert=require('node:assert/strict');
const {extractTimeWindow,hasHardTimeReference}=require('../src/ai/timeWindow');

// 2026-09-22 10:00 Asia/Bangkok (UTC+7).
const NOW=new Date('2026-09-22T03:00:00.000Z');

test('เดือนนี้ resolves to the Bangkok calendar month to date',()=>{
 const w=extractTimeWindow('ใครเสี่ยงสูงเดือนนี้',{now:NOW});
 assert.equal(w.from,'2026-09-01');
 assert.equal(w.to,'2026-09-22');
 assert.match(w.label,/เดือนนี้ \(กันยายน 2569\)/);
 assert.equal(w.matchedText,'เดือนนี้');
});

test('เดือนที่แล้ว resolves to the full previous month',()=>{
 const w=extractTimeWindow('เดือนที่แล้วเยี่ยมกี่ครั้ง',{now:NOW});
 assert.equal(w.from,'2026-08-01');
 assert.equal(w.to,'2026-08-31');
 assert.match(w.label,/เดือนที่แล้ว \(สิงหาคม 2569\)/);
});

test('วันนี้ and เมื่อวาน resolve to single days',()=>{
 const today=extractTimeWindow('เยี่ยมวันนี้',{now:NOW});
 assert.equal(today.from,'2026-09-22');assert.equal(today.to,'2026-09-22');
 const yesterday=extractTimeWindow('เมื่อวานนี้',{now:NOW});
 assert.equal(yesterday.from,'2026-09-21');assert.equal(yesterday.to,'2026-09-21');
});

test('N วันล่าสุด resolves to an inclusive trailing window',()=>{
 const w=extractTimeWindow('7 วันล่าสุดมีเยี่ยมกี่ครั้ง',{now:NOW});
 assert.equal(w.from,'2026-09-16');
 assert.equal(w.to,'2026-09-22');
 assert.match(w.label,/7 วันล่าสุด/);
});

test('Thai digits and number words are accepted for N-unit windows',()=>{
 const w=extractTimeWindow('๓ เดือนล่าสุด',{now:NOW});
 assert.equal(w.from,'2026-06-25');
 assert.equal(w.to,'2026-09-22');
 const words=extractTimeWindow('สามเดือนที่ผ่านมา',{now:NOW});
 assert.equal(words.from,'2026-06-25');
});

test('สัปดาห์นี้ starts on Monday and ends today',()=>{
 const w=extractTimeWindow('สัปดาห์นี้ใครเสี่ยงสูง',{now:NOW});
 assert.match(w.label,/สัปดาห์นี้/);
 assert.equal(new Date(`${w.from}T00:00:00Z`).getUTCDay(),1);
 assert.equal(w.to,'2026-09-22');
});

test('ปีที่แล้ว resolves to the whole previous year',()=>{
 const w=extractTimeWindow('ปีที่แล้วมีผู้เสพกี่คน',{now:NOW});
 assert.equal(w.from,'2025-01-01');
 assert.equal(w.to,'2025-12-31');
});

test('unrecognized period wording returns null but stays a hard time reference',()=>{
 assert.equal(extractTimeWindow('ไตรมาสที่แล้ว',{now:NOW}),null);
 assert.equal(hasHardTimeReference('ไตรมาสที่แล้ว'),true);
 assert.equal(hasHardTimeReference('เดือนที่แล้ว'),true);
});

test('durations without a period suffix are not time windows',()=>{
 assert.equal(extractTimeWindow('อายุ 40 ปี',{now:NOW}),null);
 assert.equal(hasHardTimeReference('อายุ 40 ปี'),false);
 assert.equal(extractTimeWindow('ผู้เสพมีกี่คน',{now:NOW}),null);
 assert.equal(hasHardTimeReference('ผู้เสพมีกี่คน'),false);
});
