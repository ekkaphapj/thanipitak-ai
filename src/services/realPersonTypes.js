'use strict';

const TERMS = { psychiatric: 'ผู้ป่วยจิตเวช', drug_user: 'ผู้เสพ', dealer: 'ผู้ค้า', released: 'พ้นโทษ' };

async function realPersonTypeIds(req, personType, rows) {
  const term = TERMS[personType];
  if (!term) throw new Error('ประเภทบุคคลไม่ถูกต้อง');
  const primary = await rows(req, 'people_type', new URLSearchParams({ select: 'type_id', type_name: `ilike.*${term}*`, limit: '1000' }));
  const ids = new Set(primary.data.map(row => Number(row.type_id)).filter(Number.isSafeInteger));
  if (personType === 'drug_user') {
    // Older provincial imports use ผู้ติดยาเสพติด or ผู้ใช้ยาเสพติด.
    // The broad catalogue query can also match psychiatric subtypes, so only
    // the two exact category prefixes are admitted from its returned rows.
    const alternatives = await rows(req, 'people_type', new URLSearchParams({ select: 'type_id,type_name', type_name: 'ilike.*ยาเสพติด*', limit: '1000' }));
    for (const row of alternatives.data) {
      if (/^(?:ผู้ติดยาเสพติด|ผู้ใช้ยาเสพติด)/u.test(String(row.type_name || '').trim())) {
        const id = Number(row.type_id);
        if (Number.isSafeInteger(id)) ids.add(id);
      }
    }
  }
  return [...ids];
}

module.exports = { realPersonTypeIds };
