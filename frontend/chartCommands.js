(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ChartCommands = factory();
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  // Repairs are confined to a chart command head. กราบ in ordinary speech,
  // person names and กราฟิก must remain untouched.
  function repair(text) {
    return String(text || '').replace(/((?:สร้าง|ขอ|แสดง|ทำ)\s*)(?:กาฟ|ก๊าฟ|คราฟ|กร๊าฟ|กราป|กราฟฟ์|กราฟ์)(?=\s|$|ยังไง|ทำยังไง|ใช้ยังไง|อะไร|บุคคล|การตรวจ|ผู้ป่วย|รายเดือน|สภ\.)/gu, '$1กราฟ')
      .replace(/((?:สร้าง|แสดง|ทำ)\s*)กราบ(?=\s|$|ยังไง|ทำยังไง|ใช้ยังไง|อะไร|บุคคล|การตรวจ)/gu, '$1กราฟ')
      .replace(/(ขอ\s*)กราบ(?=\s*(?:บุคคล|การตรวจ|สภ\.|แยกตาม))/gu, '$1กราฟ');
  }
  function detect(text) {
    const value = repair(text).replace(/[\u200b-\u200d\ufeff]/g, '').replace(/\s+/g, ' ').trim();
    if (!/(?:กราฟ(?!ิก|ฟิก|ฟิค)|แผนภูมิ|\b(?:graph|chart)\b)/iu.test(value)) return null;
    // A named person containing กราฟ isn't a request to draw a chart.
    if (/^(?:หา|ค้นหา|ขอรายชื่อ|ข้อมูล|ประวัติ)\s*(?:นาย|นาง|นางสาว|คุณ)?\s*กราฟ/u.test(value)) return null;
    let clean = value.replace(/^(?:ช่วย\s*)?(?:สร้าง|ขอ|แสดง|ทำ)?\s*(?:กราฟ|แผนภูมิ|graph|chart)\s*/iu, '')
      .replace(/\s*(?:ให้หน่อย|หน่อย|ด้วย)?\s*(?:ครับ|ค่ะ|คะ|นะครับ|นะคะ)?[?!？]*$/u, '').trim();
    if (!clean || /ยังไง|อย่างไร|อะไรได้บ้าง|ทำไง|ใช้ไง|วิธ[ีิ]ใช้|วิธีสร้าง|วิธีทำ|ใช้งาน/u.test(value)) return { kind: 'help' };
    // Only these complete grammars are executable. Unconsumed conditions
    // return the guide, never a broader query with silently dropped filters.
    if (/^บุคคลเป้าหมาย\s*สภ\.?\s*ของ(?:ฉัน|ผม|เรา)\s*แยก(?:ตาม)?ประเภท$/u.test(clean)) return { kind: 'people', own: true };
    let m = clean.match(/^บุคคลเป้าหมาย\s*ราย\s*สภ\.?\s*(?:ของ\s*)?จังหวัด\s*([ก-๙]+)$/u);
    if (m) return { kind: 'people', own: false, province: m[1] };
    m = clean.match(/^การตรวจเยี่ยม\s*รายเดือน\s*(?:ของ\s*)?(สภ\.?\s*ของ(?:ฉัน|ผม|เรา)|จังหวัด\s*[ก-๙]+)(?:\s+(.+))?$/u);
    if (m) return { kind: 'visits', own: /^สภ/u.test(m[1]), province: m[1].match(/จังหวัด\s*([ก-๙]+)/u)?.[1] || null, period: m[2] || null };
    return { kind: 'help', unknown: true };
  }
  function guide(user = {}, source = 'real') {
    const province = typeof user.province === 'string' ? user.province.trim() : '';
    const station = user.stationId && user.stationName ? String(user.stationName).replace(/^สภ\.?\s*/u, '') : '';
    const other = province === 'นครพนม' ? 'ร้อยเอ็ด' : 'นครพนม';
    const commands = [];
    if (station) commands.push('สร้างกราฟบุคคลเป้าหมาย สภ.ของฉัน แยกตามประเภท');
    if (province) commands.push(`สร้างกราฟบุคคลเป้าหมายราย สภ. จังหวัด${province}`);
    if (station) commands.push('สร้างกราฟการตรวจเยี่ยมรายเดือน สภ.ของฉัน 3 เดือนย้อนหลัง');
    commands.push(`สร้างกราฟการตรวจเยี่ยมรายเดือนของจังหวัด ${other}`);
    const affiliation = [station && `สภ.${station}`, province && `จังหวัด${province}`].filter(Boolean).join(' • ');
    const choices = commands.map((message, index) => ({ ordinal: index + 1, label: message, message }));
    const answer = ['วิธีใช้คำสั่งกราฟ' + (affiliation ? ` • ${affiliation}` : ''),
      'กรุณาเลือกปุ่ม หรือพิมพ์/พูด “เลือกข้อที่ 1”, “ขอลำดับที่สอง” หรือ “เอาข้อ 3” แล้วระบบจะทำคำสั่งนั้นทันที',
      ...choices.map(c => `${c.ordinal}. ${c.message}`),
      'การตรวจเยี่ยมนับจากบันทึกจริง ถ้าไม่ระบุช่วงเวลาจะใช้ปีปัจจุบันถึงวันนี้',
      ...(!station || !province ? ['บัญชีนี้มีข้อมูลสังกัดไม่ครบ ตัวอย่างจะแสดงเฉพาะพื้นที่ที่ระบุได้'] : []),
      ...(source === 'test' ? ['ขณะนี้ใช้ข้อมูลทดสอบ กราฟการตรวจเยี่ยมต้องเข้าสู่โหมดข้อมูลจริง'] : []),
      'ตัวอย่างจังหวัดอื่นจะแสดงผลเมื่อบัญชีมีสิทธิ์อ่านพื้นที่นั้น'].join('\n');
    return { answer, grounded: true, dataSource: source, presentation: { type: 'chart_help', affiliation, choices }, meta: { fastPath: true, ollamaCalls: 0 } };
  }
  return { repair, detect, guide };
});
