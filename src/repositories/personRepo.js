function buildFilter(opts) {
  const { stationIds, personType, status, province, station, district, subdistrict, search } = opts;
  const where = [];
  const params = [];

  if (Array.isArray(stationIds) && stationIds.length === 0) where.push('1=0');

  if (stationIds && stationIds.length > 0) {
    const ph = stationIds.map(() => '?').join(',');
    where.push(`p.station_id IN (${ph})`);
    params.push(...stationIds);
  }

  if (personType) {
    where.push('p.person_type = ?');
    params.push(personType);
  }
  if (status) {
    where.push('p.status = ?');
    params.push(status);
  }
  if (province) {
    where.push('s.province LIKE ?');
    params.push(`%${province}%`);
  }
  if (station) {
    where.push('s.name LIKE ?');
    params.push(`%${station}%`);
  }
  if (district) {
    where.push('p.district LIKE ?');
    params.push(`%${district}%`);
  }
  if (subdistrict) {
    where.push('p.subdistrict LIKE ?');
    params.push(`%${subdistrict}%`);
  }
  if (search) {
    const like = `%${search}%`;
    const conds = ['p.first_name LIKE ?', 'p.last_name LIKE ?', 'p.synthetic_code LIKE ?'];
    const vals = [like, like, like];
    if (/\s/.test(search)) {
      const fullName = search.trim().split(/\s+/);
      const joined = fullName.join(' ');
      const reversed = fullName.slice().reverse().join(' ');
      conds.push(`p.first_name || ' ' || p.last_name LIKE ?`);
      vals.push(`%${joined}%`);
      if (joined !== reversed) {
        conds.push(`p.first_name || ' ' || p.last_name LIKE ?`);
        vals.push(`%${reversed}%`);
      }
    }
    where.push(`(${conds.join(' OR ')})`);
    params.push(...vals);
  }

  return { whereSql: where.length > 0 ? `WHERE ${where.join(' AND ')}` : '', params };
}

function listPersons(db, opts) {
  const { limit, offset } = opts;
  const { whereSql, params } = buildFilter(opts);

  const total = db
    .prepare(`SELECT COUNT(*) AS c FROM persons p JOIN stations s ON s.id=p.station_id ${whereSql}`)
    .get(...params).c;
  const rows = db
    .prepare(`SELECT p.*,r.status AS registry_status,r.custody_status,t.type_name FROM persons p JOIN stations s ON s.id=p.station_id LEFT JOIN people r ON r.id=p.id LEFT JOIN people_type t ON t.type_id=r.type_id ${whereSql} ORDER BY p.id DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset);

  return { rows, total };
}

function statusSummary(db, opts) {
  const { whereSql, params } = buildFilter(opts);
  const rows = db
    .prepare(`SELECT p.status, COUNT(*) AS c FROM persons p JOIN stations s ON s.id=p.station_id ${whereSql} GROUP BY p.status`)
    .all(...params);
  const summary = {};
  for (const row of rows) summary[row.status] = row.c;
  return summary;
}

function typeSummary(db, opts) {
  const { whereSql, params } = buildFilter(opts);
  const rows = db
    .prepare(`SELECT p.person_type, COUNT(*) AS c FROM persons p JOIN stations s ON s.id=p.station_id ${whereSql} GROUP BY p.person_type`)
    .all(...params);
  const summary = {};
  for (const row of rows) summary[row.person_type] = row.c;
  return summary;
}

function getPersonById(db, id) {
  return db.prepare('SELECT p.*,r.status AS registry_status,r.custody_status,t.type_name FROM persons p LEFT JOIN people r ON r.id=p.id LEFT JOIN people_type t ON t.type_id=r.type_id WHERE p.id = ?').get(id);
}

function getVisitsForPerson(db, personId) {
  return db
    .prepare(
      `SELECT v.*, COALESCE(v.visit_status,v.status_condition,v.result) AS result, u.name AS officer_name FROM visits v
       LEFT JOIN users u ON u.id = v.officer_user_id
       WHERE v.person_id = ? ORDER BY v.visit_date DESC,COALESCE(v.visit_time,'') DESC,v.id DESC`
    )
    .all(personId);
}

function getUrineTestsForPerson(db, personId) {
  return db
    .prepare(
      `SELECT u.*, o.name AS officer_name FROM urine_tests u
       LEFT JOIN users o ON o.id = u.officer_user_id
       WHERE u.person_id = ? ORDER BY u.test_date DESC`
    )
    .all(personId);
}

function getVisitStatsForPerson(db, personId) {
  const row = db
    .prepare(
      `SELECT
        COUNT(*) AS visit_count,
        v.visit_date AS latest_date,
        v.result AS latest_result,
        v.note AS latest_note,
        u.name AS latest_officer_name
      FROM visits v
      LEFT JOIN users u ON u.id = v.officer_user_id
      WHERE v.person_id = ?
      GROUP BY v.person_id`
    )
    .get(personId);

  if (!row || row.visit_count === 0) {
    return { visit_count: 0, latest_visit: null };
  }

  const latest = db
    .prepare(
      `SELECT v.visit_date, COALESCE(v.visit_status,v.status_condition,v.result) AS result, v.note, u.name AS officer_name
       FROM visits v
       LEFT JOIN users u ON u.id = v.officer_user_id
       WHERE v.person_id = ?
       ORDER BY v.visit_date DESC, COALESCE(v.visit_time,'') DESC,v.id DESC
       LIMIT 1`
    )
    .get(personId);

  return {
    visit_count: row.visit_count,
    latest_visit: latest
      ? { date: latest.visit_date, result: latest.result, note: latest.note, officer_name: latest.officer_name }
      : null,
  };
}

function getStationPersonIds(db, stationIds) {
  if (!stationIds || stationIds.length === 0) return [];
  const ph = stationIds.map(() => '?').join(',');
  return db
    .prepare(`SELECT id FROM persons WHERE station_id IN (${ph})`)
    .all(...stationIds)
    .map((r) => r.id);
}

module.exports = { buildFilter, listPersons, statusSummary, typeSummary, getPersonById, getVisitsForPerson, getUrineTestsForPerson, getVisitStatsForPerson, getStationPersonIds };
