const { describe, test } = require('node:test');
const assert = require('node:assert');
const { setup } = require('./helpers');
const { createPersonService } = require('../src/services/personService');

function officerUser(stationId) {
  return { id: 100, username: 'test_off', name: 'Test Officer', role: 'officer', stationId };
}

function adminUser() {
  return { id: 1, username: 'admin', name: 'Admin', role: 'admin', stationId: null };
}

function viewerUser(stationId) {
  return { id: 200, username: 'test_view', name: 'Test Viewer', role: 'viewer', stationId };
}

function insertPerson(db, overrides = {}) {
  const row = {
    synthetic_code: overrides.synthetic_code || 'TP-TEST001',
    first_name: overrides.first_name || 'สมชาย',
    last_name: overrides.last_name || 'ใจดี',
    person_type: overrides.person_type || 'drug_user',
    district: overrides.district || 'คลองประเวศ',
    subdistrict: overrides.subdistrict || 'บึงมัน',
    station_id: overrides.station_id != null ? overrides.station_id : 1,
    status: overrides.status || 'active',
    last_visit_date: overrides.last_visit_date || null,
    created_at: overrides.created_at || '2025-01-01',
  };
  const stmt = db.prepare(
    `INSERT INTO persons (synthetic_code, first_name, last_name, person_type, district, subdistrict, station_id, status, last_visit_date, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const info = stmt.run(
    row.synthetic_code, row.first_name, row.last_name, row.person_type,
    row.district, row.subdistrict, row.station_id, row.status, row.last_visit_date, row.created_at
  );
  return { ...row, id: Number(info.lastInsertRowid) };
}

function insertVisit(db, personId, overrides = {}) {
  const row = {
    visit_date: overrides.visit_date || '2025-06-01',
    result: overrides.result || 'normal',
    note: overrides.note || null,
    officer_user_id: overrides.officer_user_id || 2,
  };
  const info = db.prepare(
    `INSERT INTO visits (person_id, visit_date, result, note, officer_user_id) VALUES (?, ?, ?, ?, ?)`
  ).run(personId, row.visit_date, row.result, row.note, row.officer_user_id);
  return { ...row, id: Number(info.lastInsertRowid) };
}

function insertUrineTest(db, personId, overrides = {}) {
  const row = {
    test_date: overrides.test_date || '2025-06-01',
    result: overrides.result || 'negative',
    officer_user_id: overrides.officer_user_id || 2,
  };
  const info = db.prepare(
    `INSERT INTO urine_tests (person_id, test_date, result, officer_user_id) VALUES (?, ?, ?, ?)`
  ).run(personId, row.test_date, row.result, row.officer_user_id);
  return { ...row, id: Number(info.lastInsertRowid) };
}

describe('getPersonSummary - authorized access', () => {
  test('returns full summary for authorized officer', () => {
    const ctx = setup();
    try {
      const person = insertPerson(ctx.db, { station_id: 1, person_type: 'psychiatric' });
      insertVisit(ctx.db, person.id, { visit_date: '2025-06-15', result: 'progress' });
      insertVisit(ctx.db, person.id, { visit_date: '2025-05-10', result: 'normal' });
      insertUrineTest(ctx.db, person.id, { test_date: '2025-06-14', result: 'negative' });
      insertUrineTest(ctx.db, person.id, { test_date: '2025-04-01', result: 'positive' });

      const service = createPersonService(ctx.db);
      const user = officerUser(1);
      const result = service.getPersonSummary(user, person.id);

      assert.strictEqual(result.ok, true);
      const data = result.data;

      assert.strictEqual(data.person.id, person.id);
      assert.strictEqual(data.visit_summary.visit_count, 2);
      assert.strictEqual(data.visit_summary.latest_visit.date, '2025-06-15');
      assert.strictEqual(data.visit_summary.latest_visit.result, 'progress');

      assert.strictEqual(data.urine_summary.test_count, 2);
      assert.strictEqual(data.urine_summary.positive_count, 1);
      assert.strictEqual(data.urine_summary.negative_count, 1);
      assert.strictEqual(data.urine_summary.latest_test.date, '2025-06-14');
      assert.strictEqual(data.urine_summary.latest_test.result, 'negative');

      assert.strictEqual(data.recent_visits.length, 2);
      assert.strictEqual(data.recent_visits[0].visit_date, '2025-06-15');
    } finally {
      ctx.cleanup();
    }
  });

  test('admin can access any station person', () => {
    const ctx = setup();
    try {
      const person = insertPerson(ctx.db, { station_id: 3 });
      insertVisit(ctx.db, person.id, { visit_date: '2025-07-01' });

      const service = createPersonService(ctx.db);
      const user = adminUser();
      const result = service.getPersonSummary(user, person.id);

      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.data.person.station_id, 3);
    } finally {
      ctx.cleanup();
    }
  });

  test('viewer can access own station person', () => {
    const ctx = setup();
    try {
      const person = insertPerson(ctx.db, { station_id: 1 });

      const service = createPersonService(ctx.db);
      const user = viewerUser(1);
      const result = service.getPersonSummary(user, person.id);

      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.data.person.station_id, 1);
    } finally {
      ctx.cleanup();
    }
  });
});

describe('getPersonSummary - visit_summary', () => {
  test('visit_count matches actual count', () => {
    const ctx = setup();
    try {
      const person = insertPerson(ctx.db, { station_id: 1 });
      for (let i = 0; i < 7; i++) {
        insertVisit(ctx.db, person.id, {
          visit_date: `2025-0${i + 1}-15`,
          result: 'normal',
        });
      }

      const service = createPersonService(ctx.db);
      const result = service.getPersonSummary(officerUser(1), person.id);

      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.data.visit_summary.visit_count, 7);
    } finally {
      ctx.cleanup();
    }
  });

  test('latest_visit is the most recent by date', () => {
    const ctx = setup();
    try {
      const person = insertPerson(ctx.db, { station_id: 1 });
      insertVisit(ctx.db, person.id, { visit_date: '2025-03-01', result: 'warning' });
      insertVisit(ctx.db, person.id, { visit_date: '2025-07-20', result: 'recovered' });
      insertVisit(ctx.db, person.id, { visit_date: '2025-05-10', result: 'normal' });

      const service = createPersonService(ctx.db);
      const result = service.getPersonSummary(officerUser(1), person.id);

      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.data.visit_summary.latest_visit.date, '2025-07-20');
      assert.strictEqual(result.data.visit_summary.latest_visit.result, 'recovered');
    } finally {
      ctx.cleanup();
    }
  });

  test('visit_count zero when no visits', () => {
    const ctx = setup();
    try {
      const person = insertPerson(ctx.db, { station_id: 1 });

      const service = createPersonService(ctx.db);
      const result = service.getPersonSummary(officerUser(1), person.id);

      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.data.visit_summary.visit_count, 0);
      assert.strictEqual(result.data.visit_summary.latest_visit, null);
    } finally {
      ctx.cleanup();
    }
  });
});

describe('getPersonSummary - urine_summary', () => {
  test('urine counts are accurate', () => {
    const ctx = setup();
    try {
      const person = insertPerson(ctx.db, { station_id: 1 });
      insertUrineTest(ctx.db, person.id, { test_date: '2025-01-10', result: 'positive' });
      insertUrineTest(ctx.db, person.id, { test_date: '2025-02-10', result: 'negative' });
      insertUrineTest(ctx.db, person.id, { test_date: '2025-03-10', result: 'positive' });
      insertUrineTest(ctx.db, person.id, { test_date: '2025-04-10', result: 'negative' });
      insertUrineTest(ctx.db, person.id, { test_date: '2025-05-10', result: 'negative' });

      const service = createPersonService(ctx.db);
      const result = service.getPersonSummary(officerUser(1), person.id);

      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.data.urine_summary.test_count, 5);
      assert.strictEqual(result.data.urine_summary.positive_count, 2);
      assert.strictEqual(result.data.urine_summary.negative_count, 3);
    } finally {
      ctx.cleanup();
    }
  });

  test('latest_test is the most recent by date', () => {
    const ctx = setup();
    try {
      const person = insertPerson(ctx.db, { station_id: 1 });
      insertUrineTest(ctx.db, person.id, { test_date: '2025-06-01', result: 'positive' });
      insertUrineTest(ctx.db, person.id, { test_date: '2025-08-15', result: 'negative' });
      insertUrineTest(ctx.db, person.id, { test_date: '2025-07-10', result: 'positive' });

      const service = createPersonService(ctx.db);
      const result = service.getPersonSummary(officerUser(1), person.id);

      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.data.urine_summary.latest_test.date, '2025-08-15');
      assert.strictEqual(result.data.urine_summary.latest_test.result, 'negative');
    } finally {
      ctx.cleanup();
    }
  });

  test('urine_summary defaults when no tests', () => {
    const ctx = setup();
    try {
      const person = insertPerson(ctx.db, { station_id: 1 });

      const service = createPersonService(ctx.db);
      const result = service.getPersonSummary(officerUser(1), person.id);

      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.data.urine_summary.test_count, 0);
      assert.strictEqual(result.data.urine_summary.positive_count, 0);
      assert.strictEqual(result.data.urine_summary.negative_count, 0);
      assert.strictEqual(result.data.urine_summary.latest_test, null);
    } finally {
      ctx.cleanup();
    }
  });
});

describe('getPersonSummary - recent_visits', () => {
  test('recent_visits limited to maximum 5', () => {
    const ctx = setup();
    try {
      const person = insertPerson(ctx.db, { station_id: 1 });
      for (let i = 1; i <= 10; i++) {
        const day = String(i).padStart(2, '0');
        insertVisit(ctx.db, person.id, {
          visit_date: `2025-01-${day}`,
          result: 'normal',
        });
      }

      const service = createPersonService(ctx.db);
      const result = service.getPersonSummary(officerUser(1), person.id);

      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.data.recent_visits.length, 5);
      assert.strictEqual(result.data.recent_visits[0].visit_date, '2025-01-10');
    } finally {
      ctx.cleanup();
    }
  });

  test('recent_visits contains all when fewer than 5', () => {
    const ctx = setup();
    try {
      const person = insertPerson(ctx.db, { station_id: 1 });
      insertVisit(ctx.db, person.id, { visit_date: '2025-06-01' });
      insertVisit(ctx.db, person.id, { visit_date: '2025-07-01' });

      const service = createPersonService(ctx.db);
      const result = service.getPersonSummary(officerUser(1), person.id);

      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.data.recent_visits.length, 2);
    } finally {
      ctx.cleanup();
    }
  });

  test('recent_visits empty array when no visits', () => {
    const ctx = setup();
    try {
      const person = insertPerson(ctx.db, { station_id: 1 });

      const service = createPersonService(ctx.db);
      const result = service.getPersonSummary(officerUser(1), person.id);

      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.data.recent_visits.length, 0);
    } finally {
      ctx.cleanup();
    }
  });
});

describe('getPersonSummary - cross-station blocked', () => {
  test('officer cannot access person from different station', () => {
    const ctx = setup();
    try {
      const person = insertPerson(ctx.db, { station_id: 2 });
      insertVisit(ctx.db, person.id, { visit_date: '2025-06-01' });

      const service = createPersonService(ctx.db);
      const user = officerUser(1);
      const result = service.getPersonSummary(user, person.id);

      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.reason, 'NOT_FOUND');
      assert.strictEqual(result.data, null);
    } finally {
      ctx.cleanup();
    }
  });

  test('viewer cannot access person from different station', () => {
    const ctx = setup();
    try {
      const person = insertPerson(ctx.db, { station_id: 2 });

      const service = createPersonService(ctx.db);
      const user = viewerUser(1);
      const result = service.getPersonSummary(user, person.id);

      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.reason, 'NOT_FOUND');
    } finally {
      ctx.cleanup();
    }
  });

  test('returns NOT_FOUND for non-existent person id', () => {
    const ctx = setup();
    try {
      const service = createPersonService(ctx.db);
      const result = service.getPersonSummary(officerUser(1), 999999);

      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.reason, 'NOT_FOUND');
      assert.strictEqual(result.data, null);
    } finally {
      ctx.cleanup();
    }
  });
});

describe('getPersonSummary - followup', () => {
  test('overdue is false when status is completed', () => {
    const ctx = setup();
    try {
      const person = insertPerson(ctx.db, {
        station_id: 1,
        status: 'completed',
        person_type: 'drug_user',
      });

      const service = createPersonService(ctx.db);
      const result = service.getPersonSummary(officerUser(1), person.id);

      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.data.followup.overdue, false);
    } finally {
      ctx.cleanup();
    }
  });

  test('days_since_last_visit is computed correctly', () => {
    const ctx = setup();
    try {
      const person = insertPerson(ctx.db, { station_id: 1, person_type: 'drug_user' });
      insertVisit(ctx.db, person.id, { visit_date: '2025-06-10' });

      const service = createPersonService(ctx.db);
      const result = service.getPersonSummary(officerUser(1), person.id);

      assert.strictEqual(result.ok, true);
      const days = result.data.followup.days_since_last_visit;
      assert.strictEqual(typeof days, 'number');
      assert.ok(days >= 0, 'days_since_last_visit should be >= 0');
    } finally {
      ctx.cleanup();
    }
  });

  test('days_since_last_visit is null when no visits and no last_visit_date', () => {
    const ctx = setup();
    try {
      const person = insertPerson(ctx.db, { station_id: 1, last_visit_date: null });

      const service = createPersonService(ctx.db);
      const result = service.getPersonSummary(officerUser(1), person.id);

      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.data.followup.days_since_last_visit, null);
      assert.strictEqual(result.data.followup.overdue, true);
    } finally {
      ctx.cleanup();
    }
  });
});
