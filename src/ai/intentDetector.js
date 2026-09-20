const DB_INTENT_PATTERNS = [
  /เฝ้าระวัง|เสี่ยงสูง|จับตา|กลุ่มเสี่ยง|พ้นโทษ|high[ -]?risk/i,
  /จำนวน/,
  /กี่คน/,
  /มีใครบ้าง/,
  /รายชื่อ/,
  /ค้นหา/,
  /หา/,
  /ประวัติ/,
  /เยี่ยม/,
  /ตรวจปัสสาวะ/,
  /ปัสสาวะ/,
  /ฉี่\s*ม่วง/,
  /ผู้ป่วยจิตเวช/,
  /จิตเวช/,
  /ผู้เสพ/,
  /ผู้ค้า/,
  /ติดตาม/,
  /ค้างติดตาม/,
  /สถิติ/,
  /เลยกำหนด/,
  /เกินกำหนด/,
  /ขึ้นทะเบียน/,
  /เสร็จสิ้น/,
  /จะได้\d/,
  /มีกี่/,
  /ทั้งหมดกี่/,
  /กี่ราย/,
  /กี่case/,
  /total/i,
  /count/i,
  /how many/i,
  /search/i,
  /visit/i,
  /follow.?up/i,
  /overdue/i,
  /statistic/i,
  /drug/i,
  /psychiatric/i,
  /dealer/i,
];

const NON_DB_PATTERNS = [
  /^สวัสดี/,
  /^หวัดดี/,
  /^hi\b/i,
  /^hello\b/i,
  /^hey\b/i,
  /^คุณคือใคร/,
  /^คุณชื่ออะไร/,
  /^ทำอะไรได้/,
  /^ช่วยอธิบาย/,
  /^ขอบคุณ/,
  /^thank/i,
  /^bye/i,
  /^ลาก่อน/,
];

// These are questions *about* the system or a registry concept, rather than a
// request to read a row.  Check them before the data-word patterns below: for
// example "ผู้เสพหมายถึงอะไร" must go to the safe knowledge catalogue, not
// start a people search merely because it contains "ผู้เสพ".
const PRODUCT_KNOWLEDGE_PATTERNS = [
  /(?:ระบบธานีพิทักษ์|ธานีพิทักษ์|ผู้ช่วย\s*AI).*(?:คืออะไร|ทำอะไร|ทำงาน|รองรับ|มีอะไร|ใช้ยังไง|ใช้อย่างไร|ถามอะไร|คำถาม|ปลอดภัย|สิทธิ์|ขอบเขต)/u,
  /(?:ผู้ป่วยจิตเวช|ผู้เสพ|ผู้ค้า|ผู้พ้นโทษ|บุคคลเป้าหมาย).*(?:คืออะไร|หมายถึง|ต่างกันอย่างไร|ต่างกันไหม|ใช้ทำอะไร)/u,
  /(?:ข้อมูลจริง|ข้อมูลทดสอบ|สิทธิ์|ขอบเขต\s*สภ\.?|RAG|รายงานผู้ดูแล|ผู้ดูแลผู้ป่วย|dashboard|แดชบอร์ด|แผนที่).*(?:คืออะไร|หมายถึง|ทำงาน|ใช้อย่างไร|ปลอดภัย|ต่างกัน)/iu,
  /(?:อธิบาย|สอน|แนะนำ).*(?:ระบบ|การใช้งาน|การค้นหา|การสรุป|รายงาน|คำถาม)/u,
];

function isProductKnowledgeQuestion(message) {
  const text = String(message || '').trim();
  return Boolean(text) && PRODUCT_KNOWLEDGE_PATTERNS.some((pattern) => pattern.test(text));
}

function hasDBIntent(message) {
  if (!message || typeof message !== 'string') return false;
  const text = message.trim();
  if (text.length === 0) return false;

  for (const p of NON_DB_PATTERNS) {
    if (p.test(text)) return false;
  }

  if (isProductKnowledgeQuestion(text)) return false;

  for (const p of DB_INTENT_PATTERNS) {
    if (p.test(text)) return true;
  }

  return false;
}

module.exports = { hasDBIntent, isProductKnowledgeQuestion };
