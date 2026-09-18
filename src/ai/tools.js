const AI_TOOLS = [
  {
    type: 'function', function: {
      name: 'summarize_persons',
      description: 'สรุปจำนวนหรือรายชื่อบุคคลตามประเภท ระดับเฝ้าระวัง จังหวัด สภ. อำเภอ ตำบล หรือชื่อ ภายในสิทธิ์ของผู้ใช้',
      parameters: { type: 'object', properties: {
        filters: { type: 'object' }, includeList: { type: 'boolean' }, includeCount: { type: 'boolean' }, sort: { type: 'string', enum: ['name_asc','name_desc','count_asc','count_desc'] },
      }, required: [] },
    },
  },
  {
    type:'function',function:{name:'get_monitoring_persons',
      description:'ดูบุคคลที่เฝ้าระวังหรือเสี่ยงสูงพร้อมเหตุผลจากผลเยี่ยม รายงานผู้ดูแล และทะเบียนจริงในพื้นที่ที่มีสิทธิ์เท่านั้น ไม่ทำนายความเสี่ยงเอง รองรับจิตเวช ผู้เสพ ผู้ค้า ผู้พ้นโทษ',
      parameters:{type:'object',properties:{
        person_types:{type:'array',items:{type:'string',enum:['psychiatric','drug_user','dealer','released']}},
        level:{type:'string',enum:['all','watch','high']},person_id:{type:'integer'},page:{type:'integer',minimum:1},
        psychiatric_subtype:{type:'string',enum:['drug','other']},most_wanted:{type:'boolean'}
      },required:[]}
    }
  },
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
      description: 'ค้นหาบุคคลในพื้นที่ที่รับผิดชอบตามชื่อ ประเภท สถานะ จังหวัด สภ. อำเภอ หรือตำบล ผลลัพธ์ประกอบด้วย total (จำนวนทั้งหมด), summary (ตัวเลขสรุปตามสถานะทั้งชุด คำนวณโดยระบบแล้ว) และ persons (รายการบุคคล มากสุด 20 ราย) ใช้ตัวเลข total และ summary จากผลลัพธ์ตรงๆ ห้ามคำนวณเอง',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'คำค้นหาชื่อบุคคล (ชื่อจริง นามสกุล หรือรหัสบุคคล)',
          },
          person_type: {
            type: 'string',
            enum: ['psychiatric', 'drug_user', 'dealer', 'released'],
            description: 'ประเภทบุคคล: psychiatric (จิตเวช/ผู้ป่วย/คนไข้), drug_user (ผู้เสพ), dealer (ผู้ค้า), released (ผู้พ้นโทษ)',
          },
          status: {
            type: 'string',
            enum: ['registered', 'active', 'followup', 'completed'],
            description: 'สถานะ: registered (ขึ้นทะเบียน), active (กำลังติดตาม), followup (ต้องติดตาม), completed (เสร็จสิ้น)',
          },
          province: { type: 'string', description: 'จังหวัด' },
          station: { type: 'string', description: 'ชื่อ สภ. หรือสถานีตำรวจ' },
          district: { type: 'string', description: 'อำเภอ' },
          subdistrict: { type: 'string', description: 'ตำบล' },
          limit: {
            type: 'integer',
            description: 'จำนวนรายการที่ต้องการต่อหน้า (มากสุด 50 ค่าเริ่มต้น 20)',
          },
          offset: {
            type: 'integer',
            description: 'จำนวนรายการที่ข้ามไปก่อนหน้า (ใช้แบ่งหน้า เช่น หน้า 2 = offset 20)',
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
