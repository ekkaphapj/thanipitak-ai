const {test}=require('node:test');const assert=require('node:assert/strict');
const {normalizeUtterance,placeKey,matchPlaceNames}=require('../src/ai/thaiText');

test('normalizeUtterance strips trailing politeness particles for typed and voice input',()=>{
 assert.equal(normalizeUtterance('ขอรายชื่อผู้เสพครับ'),'ขอรายชื่อผู้เสพ');
 assert.equal(normalizeUtterance('ภาพรวมหน่อยค่ะ'),'ภาพรวมหน่อย');
 assert.equal(normalizeUtterance('สั่งงานให้หน่อยนะครับ'),'สั่งงานให้หน่อย');
 assert.equal(normalizeUtterance('มีผู้เสพมั้ยคะ'),'มีผู้เสพมั้ย');
});

test('normalizeUtterance keeps place names that end like particles',()=>{
 // "บ้านนา" ends with "นา": only the particle may be removed.
 assert.equal(normalizeUtterance('ขอรายชื่อ สภ.บ้านนาครับ'),'ขอรายชื่อ สภ.บ้านนา');
 assert.equal(normalizeUtterance('ครับ'),'');
});

test('normalizeUtterance unifies Thai digits, zero-width characters and spacing',()=>{
 assert.equal(normalizeUtterance('ขอ ๕ อันดับตำบล'),'ขอ 5 อันดับตำบล');
 assert.equal(normalizeUtterance('ภาพ\u200Bรวม\uFEFFจังหวัด'),'ภาพรวมจังหวัด');
 assert.equal(normalizeUtterance('  ขอรายชื่อ   ทั้งหมด  '),'ขอรายชื่อ ทั้งหมด');
});

test('placeKey removes area prefixes and tone marks for comparison',()=>{
 assert.equal(placeKey('สภ.บ้านดุง'),'บานดุง');
 assert.equal(placeKey('จังหวัดนครพนม'),'นครพนม');
 assert.equal(placeKey('บ้านดุ่ง'),placeKey('บ้านดุง'));
 assert.equal(placeKey('ตำบลในเมือง'),'ในเมือง');
});

test('matchPlaceNames corrects a single close transcription',()=>{
 assert.deepEqual(matchPlaceNames('นครพนมม',['นครพนม','อุดรธานี']),['นครพนม']);
 assert.deepEqual(matchPlaceNames('โพนสุง',['โพนสูง','วังใหญ่']),['โพนสูง']);
 assert.deepEqual(matchPlaceNames('ท่าอุเทนน',['สภ.ท่าอุเทน','สภ.บ้านดุง']),['สภ.ท่าอุเทน']);
});

test('matchPlaceNames returns every equal-best candidate for a partial name',()=>{
 assert.deepEqual(matchPlaceNames('นคร',['นครพนม','นครสวรรค์','อุดรธานี']),['นครพนม','นครสวรรค์']);
 assert.deepEqual(matchPlaceNames('โพนทอง',['โพนทองคำ','โพนทองเจริญ']),['โพนทองคำ','โพนทองเจริญ']);
});

test('matchPlaceNames prefers an exact match over weaker candidates',()=>{
 assert.deepEqual(matchPlaceNames('นครพนม',['นครพนม','นครพนมนอก']),['นครพนม']);
});

test('matchPlaceNames never invents a candidate',()=>{
 assert.deepEqual(matchPlaceNames('กุกกุก',['นครพนม','อุดรธานี']),[]);
 assert.deepEqual(matchPlaceNames('',['นครพนม']),[]);
 assert.deepEqual(matchPlaceNames('นครพนม',[]),[]);
});
