const { test } = require('node:test');
const assert = require('node:assert');
const { setup } = require('./helpers');
const { createPersonService } = require('../src/services/personService');
const { createStatisticsService } = require('../src/services/statisticService');
const { createFollowupService } = require('../src/services/followupService');
const { FOLLOWUP_INTERVAL_DAYS } = require('../src/services/followupRules');

const OFFICER = { id: 2, username: 'station1_off', role: 'officer', stationId: 1 };
const NO_STATION = { id: 99, username: 'nostation', role: 'officer', stationId: null };

function sqliteDaysAgo(db, days) {
  return db.prepare(`SELECT date('now', ?) AS d`).get(`-${days} days`).d;
}

function insertPerson(db, overrides) {
  const row = {
    synthetic_code: overrides.synthetic_code,
    first_name: overrides.first_name || 'ทดสอบ',
    last_name: overrides.last_name || 'เกณฑ์ติดตาม',
    person_type: overrides.person_type,
    district: 'คลองประเวศ',
    subdistrict: 'บึงมัน',
    station_id: overrides.station_id != null ? overrides.station_id : 1,
    status: overrides.status || 'active',
    last_visit_date: overrides.last_visit_date,
    created_at: '2025-01-01',
  };
  const info = db
    .prepare(
      `INSERT INTO persons (synthetic_code, first_name, last_name, person_type, district, subdistrict, station_id, status, last_visit_date, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      row.synthetic_code,
      row.first_name,
      row.last_name,
      row.person_type,
      row.district,
      row.subdistrict,
      row.station_id,
      row.status,
      row.last_visit_date,
      row.created_at
    );
  return { ...row, id: Number(info.lastInsertRowid) };
}

test('followup: stationless officer is denied statistics and overdue lists', () => {
  const ctx = setup();
  try {
    const stats = createStatisticsService(ctx.db).getStatistics(NO_STATION);
    const overdue = createFollowupService(ctx.db).listOverdue(NO_STATION, { limit: 200 });
    const persons = createPersonService(ctx.db).listPersons(NO_STATION, { limit: 200 });
    assert.strictEqual(stats.total, 0);
    assert.strictEqual(stats.followupOverdue, 0);
    assert.deepStrictEqual(overdue.rows, []);
    assert.strictEqual(overdue.total, 0);
    assert.strictEqual(persons.total, 0);
    assert.deepStrictEqual(persons.rows, []);
  } finally {
    ctx.cleanup();
  }
});

test('followup: statistics overdue count matches overdue list using type-specific intervals', () => {
  const ctx = setup();
  try {
    const drugInside = insertPerson(ctx.db, {
      synthetic_code: 'TP-FU-DRUG-IN',
      person_type: 'drug_user',
      last_visit_date: sqliteDaysAgo(ctx.db, 45),
    });
    const dealerOverdue = insertPerson(ctx.db, {
      synthetic_code: 'TP-FU-DEAL-OUT',
      person_type: 'dealer',
      last_visit_date: sqliteDaysAgo(ctx.db, 20),
    });
    const releasedOverdue = insertPerson(ctx.db, {
      synthetic_code: 'TP-FU-REL-OUT',
      person_type: 'released',
      last_visit_date: sqliteDaysAgo(ctx.db, 45),
    });
    const completed = insertPerson(ctx.db, {
      synthetic_code: 'TP-FU-DONE',
      person_type: 'psychiatric',
      status: 'completed',
      last_visit_date: sqliteDaysAgo(ctx.db, 90),
    });

    const stats = createStatisticsService(ctx.db).getStatistics(OFFICER);
    const overdue = createFollowupService(ctx.db).listOverdue(OFFICER, { limit: 200 });
    const ids = new Set(overdue.rows.map((row) => row.id));

    assert.strictEqual(stats.followupOverdue, overdue.total);
    assert.equal(ids.has(drugInside.id), false, 'drug_user at 45 days is within 60-day interval');
    assert.equal(ids.has(dealerOverdue.id), true, 'dealer at 20 days exceeds 15-day interval');
    assert.equal(ids.has(releasedOverdue.id), true, 'released uses default 30-day interval');
    assert.equal(ids.has(completed.id), false, 'completed status is never overdue');

    const dealerRow = overdue.rows.find((row) => row.id === dealerOverdue.id);
    assert.strictEqual(dealerRow.interval_days, FOLLOWUP_INTERVAL_DAYS.dealer);

    const summary = createPersonService(ctx.db);
    assert.strictEqual(summary.getPersonSummary(OFFICER, drugInside.id).data.followup.overdue, false);
    assert.strictEqual(summary.getPersonSummary(OFFICER, dealerOverdue.id).data.followup.overdue, true);
    assert.strictEqual(summary.getPersonSummary(OFFICER, releasedOverdue.id).data.followup.overdue, true);
  } finally {
    ctx.cleanup();
  }
});
