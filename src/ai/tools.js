const AI_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_statistics',
      description: 'ดูสถิติภาพรวมของบุคคลในพื้นที่ที่รับผิดชอบ เช่น จำนวนบุคคลตามประเภท สถานะ และจำนวนที่เลยกำหนดติดตาม ใช้เมื่อผู้ใช้ถามเกี่ยวกับจำนวน สถิติ หรือสรุปภาพรวม',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_persons',
      description: 'ค้นหาบุคคลในพื้นที่ที่รับผิดชอบ สามารถค้นได้ตามชื่อ ประเภทบุคคล (psychiatric=จิตเวช, drug_user=ผู้เสพ, dealer=ผู้ค้า) หรือสถานะ (registered=ขึ้นทะเบียน, active=กำลังติดตาม, followup=ต้องติดตาม, completed=เสร็จสิ้น) ผลลัพธ์ประกอบด้วย total (จำนวนทั้งหมด), summary (ตัวเลขสรุปตามสถานะทั้งชุด คำนวณโดยระบบแล้ว) และ persons (รายการบุคคล มากสุด 20 ราย) ใช้ตัวเลข total และ summary จากผลลัพธ์ตรงๆ ห้ามคำนวณเอง ใช้เมื่อต้องการหารายชื่อบุคคลหรือต้องการจำนวนบุคคล',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'คำค้นหาชื่อบุคคล (ชื่อจริง นามสกุล หรือรหัสบุคคล)',
          },
          person_type: {
            type: 'string',
            enum: ['psychiatric', 'drug_user', 'dealer'],
            description: 'ประเภทบุคคล: psychiatric (จิตเวช), drug_user (ผู้เสพ), dealer (ผู้ค้า)',
          },
          status: {
            type: 'string',
            enum: ['registered', 'active', 'followup', 'completed'],
            description: 'สถานะ: registered (ขึ้นทะเบียน), active (กำลังติดตาม), followup (ต้องติดตาม), completed (เสร็จสิ้น)',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_person_detail',
      description: 'ดูรายละเอียดบุคคลหนึ่งคน เช่น ชื่อ ประเภท สถานะ พื้นที่ รหัสบุคคล ใช้เมื่อผู้ใช้ถามรายละเอียดของบุคคลเฉพาะเจาะจง',
      parameters: {
        type: 'object',
        properties: {
          person_id: {
            type: 'number',
            description: 'รหัสบุคคล (person id) ที่ต้องการดูรายละเอียด',
          },
        },
        required: ['person_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_visit_history',
      description: 'ดูประวัติการเยี่ยมของบุคคลหนึ่งคน ใช้เมื่อผู้ใช้ถามว่ามีการเยี่ยมอย่างไร หรือประวัติการเยี่ยมล่าสุด',
      parameters: {
        type: 'object',
        properties: {
          person_id: {
            type: 'number',
            description: 'รหัสบุคคล (person id) ที่ต้องการดูประวัติการเยี่ยม',
          },
        },
        required: ['person_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_urine_history',
      description: 'ดูประวัติการตรวจปัสสาวะของบุคคลหนึ่งคน ใช้เมื่อผู้ใช้ถามเกี่ยวกับผลตรวจปัสสาวะ',
      parameters: {
        type: 'object',
        properties: {
          person_id: {
            type: 'number',
            description: 'รหัสบุคคล (person id) ที่ต้องการดูประวัติการตรวจปัสสาวะ',
          },
        },
        required: ['person_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_overdue_followups',
      description: 'หาบุคคลที่ถึงกำหนดหรือเลยกำหนดติดตามแล้ว (จิตเวช=ทุก 30 วัน, ผู้เสพ=ทุก 60 วัน, ผู้ค้า=ทุก 15 วัน) ใช้เมื่อผู้ใช้ถามว่าใครที่ยังไม่ได้รับการเยี่ยม หรือเลยกำหนดติดตาม',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
];

module.exports = { AI_TOOLS };
