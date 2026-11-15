const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const { hashPassword } = require('./lib/password');

const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(path.join(dataDir, 'manpower.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

// Run fn inside a transaction; rolls back if it throws.
db.transaction = (fn) => (...args) => {
  db.exec('BEGIN');
  try {
    const out = fn(...args);
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
};

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL CHECK (role IN ('company','worker','admin')),
  email TEXT NOT NULL UNIQUE,
  phone TEXT,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS companies (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  company_name TEXT NOT NULL,
  cr_number TEXT NOT NULL,
  city TEXT NOT NULL,
  address TEXT,
  contact_person TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected'))
);

CREATE TABLE IF NOT EXISTS workers (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  full_name TEXT NOT NULL,
  nationality TEXT NOT NULL,
  iqama_number TEXT,
  passport_number TEXT,
  profession TEXT NOT NULL,
  experience_years INTEGER NOT NULL DEFAULT 0,
  skills TEXT,
  city TEXT,
  date_of_birth TEXT
);

CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  worker_id INTEGER NOT NULL REFERENCES workers(user_id) ON DELETE CASCADE,
  doc_type TEXT NOT NULL,
  file_name TEXT NOT NULL,
  original_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS demands (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(user_id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  salary_amount REAL NOT NULL CHECK (salary_amount >= 0),
  salary_type TEXT NOT NULL CHECK (salary_type IN ('hourly','daily','monthly')),
  hours_per_day INTEGER NOT NULL,
  days_per_week INTEGER NOT NULL DEFAULT 6,
  duration TEXT NOT NULL,
  location_city TEXT NOT NULL,
  work_site TEXT,
  food TEXT NOT NULL DEFAULT 'no',
  accommodation TEXT NOT NULL DEFAULT 'no',
  transport TEXT NOT NULL DEFAULT 'no',
  overtime TEXT,
  requirements TEXT,
  required_docs TEXT NOT NULL DEFAULT '',
  start_date TEXT,
  deadline TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  demand_id INTEGER NOT NULL REFERENCES demands(id) ON DELETE CASCADE,
  worker_id INTEGER NOT NULL REFERENCES workers(user_id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'applied'
    CHECK (status IN ('applied','shortlisted','hired','rejected','withdrawn')),
  cover_note TEXT,
  company_note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (demand_id, worker_id)
);

CREATE INDEX IF NOT EXISTS idx_demands_status ON demands(status);
CREATE INDEX IF NOT EXISTS idx_applications_demand ON applications(demand_id);
CREATE INDEX IF NOT EXISTS idx_applications_worker ON applications(worker_id);
CREATE INDEX IF NOT EXISTS idx_documents_worker ON documents(worker_id);

-- Extra worker profile fields defined by the admin (e.g. "Height", "Shoe size", "Last employer").
CREATE TABLE IF NOT EXISTS custom_fields (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL,
  field_type TEXT NOT NULL CHECK (field_type IN ('text','number','date','yesno','select')),
  options TEXT NOT NULL DEFAULT '',
  required INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS worker_field_values (
  worker_id INTEGER NOT NULL REFERENCES workers(user_id) ON DELETE CASCADE,
  field_id INTEGER NOT NULL REFERENCES custom_fields(id) ON DELETE CASCADE,
  value TEXT NOT NULL,
  PRIMARY KEY (worker_id, field_id)
);

-- Every WhatsApp / SMS message the system tried to send.
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  channel TEXT NOT NULL,
  recipient TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed','not_sent')),
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

db.exec(`
-- Monthly timesheet a company uploads for the workers it hired on one demand.
CREATE TABLE IF NOT EXISTS timesheets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(user_id) ON DELETE CASCADE,
  demand_id INTEGER NOT NULL REFERENCES demands(id) ON DELETE CASCADE,
  month TEXT NOT NULL,
  file_name TEXT NOT NULL,
  original_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  payment_method TEXT NOT NULL CHECK (payment_method IN ('bank','cash')),
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','confirmed','rejected')),
  admin_note TEXT,
  submitted_at TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_at TEXT,
  UNIQUE (demand_id, month)
);

-- One worker's hours and pay in a timesheet.
CREATE TABLE IF NOT EXISTS timesheet_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timesheet_id INTEGER NOT NULL REFERENCES timesheets(id) ON DELETE CASCADE,
  worker_id INTEGER NOT NULL REFERENCES workers(user_id) ON DELETE CASCADE,
  days_worked INTEGER NOT NULL DEFAULT 0,
  hours REAL NOT NULL DEFAULT 0,
  amount REAL NOT NULL DEFAULT 0,
  payment_status TEXT NOT NULL DEFAULT 'pending' CHECK (payment_status IN ('pending','paid')),
  paid_at TEXT,
  payment_ref TEXT,
  proof_file TEXT,
  proof_name TEXT,
  proof_mime TEXT,
  UNIQUE (timesheet_id, worker_id)
);
CREATE INDEX IF NOT EXISTS idx_timesheet_lines_worker ON timesheet_lines(worker_id);
`);

db.exec(`
-- Positions a worker can work in (main profession plus others). Used for new-job alerts.
CREATE TABLE IF NOT EXISTS worker_positions (
  worker_id INTEGER NOT NULL REFERENCES workers(user_id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  PRIMARY KEY (worker_id, category)
);
CREATE INDEX IF NOT EXISTS idx_worker_positions_category ON worker_positions(category);
`);

// Add columns introduced after the first release (safe to run on every start).
function addColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
addColumn('users', 'lang', "TEXT NOT NULL DEFAULT 'en'");
addColumn('users', 'notify_channel', "TEXT NOT NULL DEFAULT 'whatsapp'");
addColumn('companies', 'logo_file', 'TEXT');
addColumn('workers', 'iqama_expiry', 'TEXT');
addColumn('workers', 'passport_expiry', 'TEXT');
addColumn('workers', 'kafala_transfer', "TEXT NOT NULL DEFAULT ''");
addColumn('workers', 'languages', 'TEXT');
addColumn('workers', 'driving_license', "TEXT NOT NULL DEFAULT ''");
addColumn('workers', 'expected_salary', 'TEXT');
addColumn('workers', 'available_from', 'TEXT');
addColumn('workers', 'work_history', 'TEXT');
addColumn('workers', 'bank_name', 'TEXT');
addColumn('workers', 'iban', 'TEXT');
addColumn('workers', 'job_alerts', 'INTEGER NOT NULL DEFAULT 1');
addColumn('demands', 'announced_at', 'TEXT');
// Workers registered before positions existed: their main profession is their position.
db.exec('INSERT OR IGNORE INTO worker_positions (worker_id, category) SELECT user_id, profession FROM workers');

// Seed an admin account on first run.
const adminEmail = (process.env.ADMIN_EMAIL || 'admin@manpower.local').toLowerCase();
if (!db.prepare('SELECT 1 FROM users WHERE role = ?').get('admin')) {
  const password = process.env.ADMIN_PASSWORD || 'admin123';
  db.prepare('INSERT INTO users (role, email, password_hash, name) VALUES (?,?,?,?)')
    .run('admin', adminEmail, hashPassword(password), 'Administrator');
  console.log(`Created admin account: ${adminEmail} (change the password via ADMIN_PASSWORD before production use)`);
}

module.exports = db;
