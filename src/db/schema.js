const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS stations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  district TEXT NOT NULL,
  province TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','officer','viewer')),
  station_id INTEGER REFERENCES stations(id)
);

CREATE TABLE IF NOT EXISTS persons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  synthetic_code TEXT NOT NULL UNIQUE,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  person_type TEXT NOT NULL CHECK (person_type IN ('psychiatric','drug_user','dealer','released')),
  district TEXT NOT NULL,
  subdistrict TEXT NOT NULL,
  station_id INTEGER NOT NULL REFERENCES stations(id),
  status TEXT NOT NULL CHECK (status IN ('registered','active','followup','completed')),
  last_visit_date TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS visits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id INTEGER NOT NULL REFERENCES persons(id),
  visit_date TEXT NOT NULL,
  result TEXT NOT NULL,
  note TEXT,
  officer_user_id INTEGER REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS urine_tests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id INTEGER NOT NULL REFERENCES persons(id),
  test_date TEXT NOT NULL,
  result TEXT NOT NULL,
  officer_user_id INTEGER REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  action TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  target_id INTEGER,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  action TEXT NOT NULL,
  tool_name TEXT,
  safe_arguments TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_persons_station ON persons(station_id);
CREATE INDEX IF NOT EXISTS idx_persons_type ON persons(person_type);
CREATE INDEX IF NOT EXISTS idx_persons_status ON persons(status);
CREATE INDEX IF NOT EXISTS idx_persons_code ON persons(synthetic_code);
CREATE INDEX IF NOT EXISTS idx_visits_person ON visits(person_id);
CREATE INDEX IF NOT EXISTS idx_urine_tests_person ON urine_tests(person_id);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action);
`;

module.exports = { SCHEMA_SQL };
