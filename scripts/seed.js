// Adds demo companies, demands and a worker so you can try the portal.
// Usage: npm run seed   (safe to run once on an empty database)
const db = require('../src/db');
const { hashPassword } = require('../src/lib/password');

if (db.prepare("SELECT 1 FROM users WHERE email = 'demo.company@manpower.local'").get()) {
  console.log('Demo data already exists.');
  process.exit(0);
}

const pw = hashPassword('demo123');
const addUser = db.prepare('INSERT INTO users (role, email, phone, password_hash, name) VALUES (?,?,?,?,?)');
const addCompany = db.prepare("INSERT INTO companies (user_id, company_name, cr_number, city, address, contact_person, status) VALUES (?,?,?,?,?,?,'approved')");
const addDemand = db.prepare(`INSERT INTO demands (company_id, title, category, quantity, salary_amount, salary_type, hours_per_day, days_per_week,
  duration, location_city, work_site, food, accommodation, transport, overtime, requirements, required_docs, start_date, deadline)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

const seed = db.transaction(() => {
  const c1 = addUser.run('company', 'demo.company@manpower.local', '+966500000010', pw, 'Al Riyadh Building Contracting').lastInsertRowid;
  addCompany.run(c1, 'Al Riyadh Building Contracting', '1010456789', 'Riyadh', 'King Fahd Road', 'Mohammed Al-Qahtani');
  const c2 = addUser.run('company', 'demo.facility@manpower.local', '+966500000011', pw, 'Eastern Facility Services').lastInsertRowid;
  addCompany.run(c2, 'Eastern Facility Services', '2050112233', 'Dammam', 'Industrial Area 2', 'Faisal Al-Dossary');

  addDemand.run(c1, 'Shuttering Carpenter – Residential Tower', 'Carpenter', 25, 14, 'hourly', 10, 6, '6 months', 'Riyadh', 'Al Malqa',
    'no', 'yes', 'yes', '1.25x after 10 hours', 'Transferable Iqama. Minimum 2 years Saudi experience.', 'iqama,passport,photo', '', '');
  addDemand.run(c1, 'Electrician (Building Wiring)', 'Electrician', 10, 2200, 'monthly', 8, 6, '1 year (renewable)', 'Riyadh', 'Al Narjis',
    'allowance', 'yes', 'yes', 'Paid per hour', 'Must read drawings. Trade certificate preferred.', 'iqama,passport,photo,cv', '', '');
  addDemand.run(c1, 'General Helper', 'General Labour / Helper', 40, 10, 'hourly', 10, 6, '3 months', 'Riyadh', '',
    'yes', 'yes', 'yes', '', 'Fit and healthy. Immediate joining.', 'iqama,photo', '', '');
  addDemand.run(c2, 'Cleaner – Shopping Mall', 'Cleaner', 15, 1500, 'monthly', 8, 6, '1 year', 'Dammam', 'Al Shatea Mall',
    'yes', 'yes', 'yes', '', 'Night shift available.', 'iqama,passport,photo', '', '');
  addDemand.run(c2, 'AC Technician', 'AC Technician', 5, 180, 'daily', 9, 6, '6 months', 'Khobar', '',
    'allowance', 'no', 'yes', '1.5x', 'Split & central AC experience. Driving license is a plus.', 'iqama,passport,cv,trade_certificate', '', '');
  addDemand.run(c2, 'Heavy Driver (Trailer)', 'Heavy Driver', 8, 3500, 'monthly', 10, 6, '1 year', 'Jubail', 'Jubail Industrial City',
    'allowance', 'yes', 'no', '', 'Valid Saudi heavy license required.', 'iqama,passport,driving_license,photo', '', '');

  const w = addUser.run('worker', 'demo.worker@manpower.local', '+966500000020', pw, 'Abdul Karim').lastInsertRowid;
  db.prepare(`INSERT INTO workers (user_id, full_name, nationality, iqama_number, passport_number, profession, experience_years, skills, city)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(w, 'Abdul Karim', 'Bangladesh', '2456789012', 'EF1234567', 'Electrician', 6, 'Building wiring, panel boards; Arabic & Hindi', 'Riyadh');

  // The admin has signed agreements with both companies and published the jobs, keeping a 20% margin.
  db.prepare(`UPDATE demands SET review_status = 'published', agreement_signed = 1, published_at = datetime('now'),
    worker_rate = ROUND(salary_amount * 0.8, 2), worker_rate_type = salary_type, worker_pay_days = 7, client_payment_days = 30
    WHERE company_id IN (?, ?)`).run(c1, c2);
  db.prepare("UPDATE workers SET status = 'approved' WHERE user_id = ?").run(w);
});
seed();

console.log(`Demo data added. Log in with password "demo123":
  Company: demo.company@manpower.local
  Company: demo.facility@manpower.local
  Worker:  demo.worker@manpower.local`);
