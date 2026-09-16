const DB_INTENT_PATTERNS = [
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

function hasDBIntent(message) {
  if (!message || typeof message !== 'string') return false;
  const text = message.trim();
  if (text.length === 0) return false;

  for (const p of NON_DB_PATTERNS) {
    if (p.test(text)) return false;
  }

  for (const p of DB_INTENT_PATTERNS) {
    if (p.test(text)) return true;
  }

  return false;
}

module.exports = { hasDBIntent };
