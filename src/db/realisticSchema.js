'use strict';

// Production-shaped subset; persons remains a read compatibility projection.
function installRealisticSchema(db) {
  const columns = new Set(db.prepare('PRAGMA table_info(visits)').all().map(c => c.name));
  for (const [name, type] of Object.entries({visit_time:'TEXT',visit_category:'TEXT',visit_status:'TEXT',status_condition:'TEXT',drug_test_result:'TEXT'})) {
    if (!columns.has(name)) db.exec(`ALTER TABLE visits ADD COLUMN ${name} ${type}`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS people_type (
      type_id INTEGER PRIMARY KEY, type_name TEXT NOT NULL UNIQUE,
      category TEXT NOT NULL CHECK(category IN ('psychiatric','drug_user','dealer','released'))
    );
    CREATE TABLE IF NOT EXISTS people (
      id INTEGER PRIMARY KEY, synthetic_code TEXT UNIQUE NOT NULL,
      first_name TEXT NOT NULL, last_name TEXT,
      type_id INTEGER NOT NULL REFERENCES people_type(type_id),
      station_id INTEGER NOT NULL REFERENCES stations(id),
      province TEXT, amphoe TEXT, tambon TEXT,
      status TEXT, custody_status TEXT, created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, is_synthetic INTEGER NOT NULL DEFAULT 1 CHECK(is_synthetic=1)
    );
    CREATE TABLE IF NOT EXISTS guardian_report_settings (
      color TEXT PRIMARY KEY, watch_after_missed_days INTEGER NOT NULL,
      high_risk_after_missed_days INTEGER NOT NULL,
      high_risk_consecutive_abnormal INTEGER NOT NULL,
      abnormal_high_risk_min_categories INTEGER NOT NULL,
      recover_after_normal_days INTEGER NOT NULL
    );
    INSERT OR IGNORE INTO guardian_report_settings VALUES ('แดง',2,3,2,1,3),('ส้ม',3,5,2,2,3),('*',6,8,3,2,2);
    CREATE TABLE IF NOT EXISTS guardian_patient_links (
      id INTEGER PRIMARY KEY, person_id INTEGER NOT NULL REFERENCES people(id),
      approval_status TEXT NOT NULL DEFAULT 'approved', created_at TEXT NOT NULL,
      revoked_at TEXT, reporting_paused_at TEXT
    );
    CREATE TABLE IF NOT EXISTS guardian_reports (
      id INTEGER PRIMARY KEY, person_id INTEGER NOT NULL REFERENCES people(id),
      report_date TEXT NOT NULL, met_patient TEXT NOT NULL,
      medication TEXT NOT NULL, symptoms TEXT NOT NULL DEFAULT '[]',
      risk_behaviors TEXT NOT NULL DEFAULT '[]', abnormal_count INTEGER NOT NULL,
      cancelled_at TEXT, UNIQUE(person_id,report_date)
    );
    CREATE TABLE IF NOT EXISTS person_report_status (
      person_id INTEGER PRIMARY KEY REFERENCES people(id),
      alert_level TEXT NOT NULL DEFAULT 'ปกติ' CHECK(alert_level IN ('ปกติ','เฝ้าระวัง','เสี่ยงสูง')),
      alert_source TEXT NOT NULL DEFAULT 'none', missed_days INTEGER NOT NULL DEFAULT 0,
      last_report_date TEXT, since TEXT, updated_at TEXT NOT NULL,
      evidence_json TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE IF NOT EXISTS dealer_profiles (
      person_id INTEGER PRIMARY KEY REFERENCES people(id), current_status TEXT NOT NULL,
      recorded_at TEXT NOT NULL, reason TEXT
    );
    CREATE TABLE IF NOT EXISTS fixture_metadata (key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS people_scope_type ON people(station_id,type_id);
    CREATE INDEX IF NOT EXISTS visits_latest_domain ON visits(person_id,visit_date DESC,visit_time DESC,id DESC);
    CREATE INDEX IF NOT EXISTS guardian_reports_latest ON guardian_reports(person_id,report_date DESC);
    CREATE TRIGGER IF NOT EXISTS people_compat_insert AFTER INSERT ON people BEGIN
      INSERT INTO persons (id,synthetic_code,first_name,last_name,person_type,district,subdistrict,station_id,status,created_at)
      VALUES (NEW.id,NEW.synthetic_code,NEW.first_name,COALESCE(NEW.last_name,''),
        (SELECT category FROM people_type WHERE type_id=NEW.type_id),COALESCE(NEW.amphoe,''),COALESCE(NEW.tambon,''),NEW.station_id,
        CASE WHEN NEW.custody_status IN ('เสียชีวิต','อยู่ในเรือนจำ','ยุติบทบาท') THEN 'completed' ELSE 'active' END,NEW.created_at);
    END;
    CREATE TRIGGER IF NOT EXISTS people_compat_update AFTER UPDATE ON people BEGIN
      UPDATE persons SET first_name=NEW.first_name,last_name=COALESCE(NEW.last_name,''),
        person_type=(SELECT category FROM people_type WHERE type_id=NEW.type_id),station_id=NEW.station_id,
        district=COALESCE(NEW.amphoe,''),subdistrict=COALESCE(NEW.tambon,''),
        status=CASE WHEN NEW.custody_status IN ('เสียชีวิต','อยู่ในเรือนจำ','ยุติบทบาท') THEN 'completed' ELSE 'active' END
      WHERE id=NEW.id;
    END;
    CREATE TRIGGER IF NOT EXISTS visits_sync_latest_insert AFTER INSERT ON visits BEGIN
      UPDATE persons SET last_visit_date=(SELECT MAX(visit_date) FROM visits WHERE person_id=NEW.person_id) WHERE id=NEW.person_id;
    END;
    CREATE TRIGGER IF NOT EXISTS visits_sync_latest_update AFTER UPDATE ON visits BEGIN
      UPDATE persons SET last_visit_date=(SELECT MAX(visit_date) FROM visits WHERE person_id=persons.id) WHERE id IN (OLD.person_id,NEW.person_id);
    END;
    CREATE TRIGGER IF NOT EXISTS visits_sync_latest_delete AFTER DELETE ON visits BEGIN
      UPDATE persons SET last_visit_date=(SELECT MAX(visit_date) FROM visits WHERE person_id=OLD.person_id) WHERE id=OLD.person_id;
    END;
  `);
}
module.exports = { installRealisticSchema };
