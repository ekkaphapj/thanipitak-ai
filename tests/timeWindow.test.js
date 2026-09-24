const {test}=require('node:test');const assert=require('node:assert/strict');
const {analyzePeriods,extractTimeWindow,hasHardTimeReference}=require('../src/ai/timeWindow');

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

test('เดือนสิงหาคม 2569 resolves to the full named calendar month',()=>{
 const w=extractTimeWindow('ใครเสี่ยงสูงเดือนสิงหาคม 2569',{now:NOW});
 assert.equal(w.from,'2026-08-01');
 assert.equal(w.to,'2026-08-31');
 assert.match(w.label,/สิงหาคม 2569/);
});

test('a named month without a year means the most recent one',()=>{
 const w=extractTimeWindow('ใครเสี่ยงสูงเดือนสิงหาคม',{now:NOW});
 assert.equal(w.from,'2026-08-01');
 assert.equal(w.to,'2026-08-31');
});

test('ยี่สิบเอ็ดวันล่าสุด is 21 days, never 11',()=>{
 const w=extractTimeWindow('ใครเสี่ยงสูงยี่สิบเอ็ดวันล่าสุด',{now:NOW});
 assert.equal(w.from,'2026-09-02');
 assert.equal(w.to,'2026-09-22');
 assert.match(w.label,/21 วันล่าสุด/);
});

test('compound hundreds and named years keep every Thai number and year digit',()=>{
 const days=extractTimeWindow('หนึ่งร้อยแปดสิบวันล่าสุด',{now:NOW});
 assert.equal(days.from,'2026-03-27');
 assert.match(days.label,/180 วันล่าสุด/);
 const month=extractTimeWindow('เดือนสิงหาคม 2568',{now:NOW});
 assert.equal(month.from,'2025-08-01');
 assert.equal(month.to,'2025-08-31');
});

test('two named months are both surfaced so callers refuse a partial answer',()=>{
 const analysis=analyzePeriods('เดือนสิงหาคมและกันยายน 2569',{now:NOW});
 assert.equal(analysis.windows.length,2);
 assert.deepEqual(analysis.windows.map((item)=>item.from),['2026-08-01','2026-09-01']);
});

test('an oversized trailing window stays an unresolved period mention',()=>{
 const analysis=analyzePeriods('ใครเสี่ยงสูง 400 วันล่าสุด',{now:NOW});
 assert.equal(analysis.windows.length,0);
 assert.deepEqual(analysis.unresolved,['400 วันล่าสุด']);
 assert.equal(extractTimeWindow('ใครเสี่ยงสูง 400 วันล่าสุด',{now:NOW}),null);
 assert.equal(hasHardTimeReference('ใครเสี่ยงสูง 400 วันล่าสุด'),true);
});

test('a comparison question reports two windows and comparison wording',()=>{
 const analysis=analyzePeriods('ใครเสี่ยงสูงเดือนนี้เทียบกับเดือนที่แล้ว',{now:NOW});
 assert.equal(analysis.comparison,true);
 assert.equal(analysis.windows.length,2);
 const labels=analysis.windows.map(w=>w.label).join(' ');
 assert.match(labels,/เดือนนี้/);
 assert.match(labels,/เดือนที่แล้ว/);
});

test('durations without a period suffix are not time windows',()=>{
 assert.equal(extractTimeWindow('อายุ 40 ปี',{now:NOW}),null);
 assert.equal(hasHardTimeReference('อายุ 40 ปี'),false);
 assert.equal(extractTimeWindow('ผู้เสพมีกี่คน',{now:NOW}),null);
 assert.equal(hasHardTimeReference('ผู้เสพมีกี่คน'),false);
});

test('a Thai month-to-month range is one window over whole calendar months',()=>{
 const analysis=analyzePeriods('ขอสรุปการตรวจเยี่ยม เดือนมิถุนายนถึงเดือนกันยายน 2569',{now:NOW});
 assert.equal(analysis.windows.length,1);
 assert.equal(analysis.unresolved.length,0);
 const w=analysis.windows[0];
 assert.equal(w.from,'2026-06-01');
 assert.equal(w.to,'2026-09-30');
 assert.match(w.label,/เดือนมิถุนายน–กันยายน 2569/);
 assert.deepEqual(w.months.map((m)=>`${m.y}-${String(m.m).padStart(2,'0')}`),['2026-06','2026-07','2026-08','2026-09']);
});

test('a named month range ending at ปัจจุบัน runs from the month to today',()=>{
 const analysis=analyzePeriods('ขอข้อมูลการตรวจเยี่ยม เดือนเมษายน 2569 ถึง ปัจจุบัน',{now:NOW});
 assert.equal(analysis.windows.length,1);
 assert.equal(analysis.windows[0].from,'2026-04-01');
 assert.equal(analysis.windows[0].to,'2026-09-22');
 assert.equal(analysis.windows[0].months.length,6);
 assert.match(analysis.windows[0].label,/เมษายน 2569–ปัจจุบัน/);
});

test('ตั้งแต่เดือน… opens a window that runs to today',()=>{
 const analysis=analyzePeriods('ตั้งแต่เดือนพฤษภาคม 2569 มีการเยี่ยมกี่ครั้ง',{now:NOW});
 assert.equal(analysis.windows.length,1);
 assert.equal(analysis.windows[0].from,'2026-05-01');
 assert.equal(analysis.windows[0].to,'2026-09-22');
});

test('a month range crossing a year boundary keeps both endpoints',()=>{
 const analysis=analyzePeriods('สรุปการตรวจเยี่ยม พฤศจิกายน 2568 ถึง กุมภาพันธ์ 2569',{now:NOW});
 assert.equal(analysis.windows.length,1);
 assert.equal(analysis.windows[0].from,'2025-11-01');
 assert.equal(analysis.windows[0].to,'2026-02-28');
 assert.equal(analysis.windows[0].months.length,4);
});

test('a month range without years defaults to the most recent span',()=>{
 const noYears=analyzePeriods('เดือนมิถุนายน ถึง กันยายน',{now:NOW});
 assert.equal(noYears.windows.length,1);
 assert.equal(noYears.windows[0].from,'2026-06-01');
 assert.equal(noYears.windows[0].to,'2026-09-30');
 // An end month before the start month without explicit years wraps forward.
 const wrapped=analyzePeriods('เดือนพฤศจิกายน ถึง มกราคม',{now:NOW});
 assert.equal(wrapped.windows.length,1);
 assert.equal(wrapped.windows[0].from,'2025-11-01');
 assert.equal(wrapped.windows[0].to,'2026-01-31');
});

test('an oversized month range stays unresolved instead of half-resolving',()=>{
 const analysis=analyzePeriods('สรุปการตรวจเยี่ยม มกราคม 2020 ถึง ธันวาคม 2022',{now:NOW});
 assert.equal(analysis.windows.length,0);
 assert.equal(analysis.unresolved.length,1);
 assert.equal(hasHardTimeReference('สรุปการตรวจเยี่ยม มกราคม 2020 ถึง ธันวาคม 2022'),true);
});

test('currentYearWindow spans January 1 to today in Bangkok time',()=>{
 const w=require('../src/ai/timeWindow').currentYearWindow(NOW);
 assert.equal(w.from,'2026-01-01');
 assert.equal(w.to,'2026-09-22');
 assert.match(w.label,/ปีนี้ \(2569\)/);
});
