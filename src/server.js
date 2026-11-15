const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const db = require('./db');
const web = require('./lib/web');
const { hashPassword, verifyPassword } = require('./lib/password');
const { CATEGORIES, DOC_TYPES, CITIES, SALARY_TYPES, APP_STATUS, NATIONALITIES } = require('./constants');
const { LANGUAGES, translator, pickLanguage } = require('./i18n');

const app = web.createApp();
const PORT = Number(process.env.PORT) || 3000;
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

app.set('views', path.join(__dirname, '..', 'views'));
app.use(web.serveStatic(path.join(__dirname, '..', 'public')));

// Language: chosen from the header menu, remembered in a cookie. English is the default.
app.use((req, res, next) => {
  req.lang = pickLanguage(req);
  req.t = translator(req.lang);
  next();
});
app.get('/lang', (req, res) => {
  const code = LANGUAGES[req.query.code] ? req.query.code : 'en';
  const nextUrl = String(req.query.next || '/');
  res.set('Set-Cookie', `lang=${code}; Path=/; Max-Age=${60 * 60 * 24 * 365}; SameSite=Lax`);
  res.redirect(nextUrl.startsWith('/') && !nextUrl.startsWith('//') ? nextUrl : '/');
});
app.use(web.urlencoded());
app.use(web.sessions({ db, maxAgeMs: 1000 * 60 * 60 * 24 * 7, secure: process.env.COOKIE_SECURE === '1' }));

// ---------- File uploads ----------
// Wrap the upload parser so upload errors become flash messages instead of error pages.
function handleUpload(fieldNames, back) {
  const mw = web.upload({ dir: UPLOAD_DIR, maxFileSize: 5 * 1024 * 1024, maxFiles: 10, allowedFields: fieldNames });
  return (req, res, next) => mw(req, res, (err) => {
    if (!err) return next();
    if (!err.userError) return next(err);
    flash(req, 'error', err.message, err.params);
    res.redirect(typeof back === 'function' ? back(req) : back);
  });
}

// ---------- Helpers ----------
// Flash messages are translated when created; the next page is shown in the same language.
function flash(req, type, message, params) {
  req.session.flash = { type, message: req.t(message, params) };
}

function csrfToken(req) {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
  return req.session.csrf;
}

app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;
  res.locals.csrf = csrfToken(req);
  res.locals.path = req.path;
  res.locals.currentUrl = req.originalUrl;
  Object.assign(res.locals, { CATEGORIES, DOC_TYPES, CITIES, SALARY_TYPES, APP_STATUS, NATIONALITIES, LANGUAGES });
  const t = req.t;
  const lang = LANGUAGES[req.lang];
  Object.assign(res.locals, { t, lang: req.lang, dir: lang.dir });
  res.locals.fmtDate = (s) => (s ? new Date(s.replace(' ', 'T') + (s.length > 10 ? 'Z' : '')).toLocaleDateString(lang.locale + '-u-nu-latn', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
  res.locals.yesNo = (v) => t({ yes: 'Provided by company', no: 'Not provided', allowance: 'Allowance paid' }[v] || v);
  next();
});

// CSRF check for every state-changing request. Multipart forms are checked after the upload parser runs.
function checkCsrf(req, res, next) {
  if (req.method !== 'POST') return next();
  if (req.body && req.body._csrf === req.session.csrf) return next();
  res.status(403).render('error', { title: 'Session expired', message: 'Your form session expired. Please go back, reload the page and try again.' });
}
app.use((req, res, next) => {
  if (req.method === 'POST' && !req.is('multipart/form-data')) return checkCsrf(req, res, next);
  next();
});

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session.user) {
      flash(req, 'error', 'Please log in first.');
      return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
    }
    if (!roles.includes(req.session.user.role)) {
      return res.status(403).render('error', { title: 'Access denied', message: 'You do not have access to this page.' });
    }
    next();
  };
}

const str = (v, max = 500) => String(v ?? '').trim().slice(0, max);
const int = (v, def = 0) => (Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : def);

function getDemand(id) {
  return db.prepare(`
    SELECT d.*, c.company_name, c.city AS company_city, c.cr_number, c.contact_person, c.status AS company_status,
      (SELECT COUNT(*) FROM applications a WHERE a.demand_id = d.id AND a.status != 'withdrawn') AS applicant_count,
      (SELECT COUNT(*) FROM applications a WHERE a.demand_id = d.id AND a.status = 'hired') AS hired_count
    FROM demands d JOIN companies c ON c.user_id = d.company_id
    WHERE d.id = ?`).get(id);
}

function saveDocuments(workerId, files) {
  const insert = db.prepare('INSERT INTO documents (worker_id, doc_type, file_name, original_name, mime_type) VALUES (?,?,?,?,?)');
  let count = 0;
  for (const [field, list] of Object.entries(files || {})) {
    const type = field.replace(/^doc_/, '');
    if (!DOC_TYPES[type]) continue;
    for (const f of list) {
      insert.run(workerId, type, f.filename, f.originalname.slice(0, 200), f.mimetype);
      count++;
    }
  }
  return count;
}

const docFields = Object.keys(DOC_TYPES).map((k) => 'doc_' + k);

// ---------- Public pages ----------
app.get('/', (req, res) => {
  const stats = {
    openDemands: db.prepare("SELECT COUNT(*) n FROM demands d JOIN companies c ON c.user_id=d.company_id WHERE d.status='open' AND c.status='approved'").get().n,
    positions: db.prepare("SELECT COALESCE(SUM(quantity),0) n FROM demands d JOIN companies c ON c.user_id=d.company_id WHERE d.status='open' AND c.status='approved'").get().n,
    companies: db.prepare("SELECT COUNT(*) n FROM companies WHERE status='approved'").get().n,
    workers: db.prepare('SELECT COUNT(*) n FROM workers').get().n,
  };
  const latest = db.prepare(`
    SELECT d.*, c.company_name FROM demands d JOIN companies c ON c.user_id = d.company_id
    WHERE d.status='open' AND c.status='approved' ORDER BY d.created_at DESC LIMIT 6`).all();
  res.render('home', { title: 'Home', stats, latest });
});

app.get('/demands', (req, res) => {
  const q = str(req.query.q, 100);
  const category = str(req.query.category, 100);
  const city = str(req.query.city, 100);
  const where = ["d.status = 'open'", "c.status = 'approved'", "(d.deadline IS NULL OR d.deadline = '' OR d.deadline >= date('now'))"];
  const params = [];
  if (q) { where.push('(d.title LIKE ? OR d.requirements LIKE ? OR c.company_name LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  if (category) { where.push('d.category = ?'); params.push(category); }
  if (city) { where.push('d.location_city = ?'); params.push(city); }
  const demands = db.prepare(`
    SELECT d.*, c.company_name,
      (SELECT COUNT(*) FROM applications a WHERE a.demand_id = d.id AND a.status = 'hired') AS hired_count
    FROM demands d JOIN companies c ON c.user_id = d.company_id
    WHERE ${where.join(' AND ')} ORDER BY d.created_at DESC LIMIT 200`).all(...params);
  res.render('demands', { title: 'Job Demands', demands, filters: { q, category, city } });
});

app.get('/demands/:id', (req, res) => {
  const demand = getDemand(req.params.id);
  const u = req.session.user;
  const isOwner = u && u.role === 'company' && demand && demand.company_id === u.id;
  const visible = demand && ((demand.status === 'open' && demand.company_status === 'approved') || isOwner || (u && u.role === 'admin'));
  if (!visible) return res.status(404).render('error', { title: 'Not found', message: 'This demand does not exist or is no longer available.' });
  let application = null;
  let docs = [];
  if (u && u.role === 'worker') {
    application = db.prepare('SELECT * FROM applications WHERE demand_id = ? AND worker_id = ?').get(demand.id, u.id);
    docs = db.prepare('SELECT DISTINCT doc_type FROM documents WHERE worker_id = ?').all(u.id).map((r) => r.doc_type);
  }
  res.render('demand-detail', { title: demand.title, demand, application, workerDocTypes: docs, isOwner });
});

// Printable demand letter (digital version of the paper demand).
app.get('/demands/:id/letter', (req, res) => {
  const demand = getDemand(req.params.id);
  const u = req.session.user;
  const isOwner = u && u.role === 'company' && demand && demand.company_id === u.id;
  if (!demand || !(demand.company_status === 'approved' || isOwner || (u && u.role === 'admin'))) {
    return res.status(404).render('error', { title: 'Not found', message: 'Demand not found.' });
  }
  res.render('demand-letter', { title: 'Demand Letter', demand, layout: false });
});

// ---------- Auth ----------
app.get('/register', (req, res) => res.render('register-choice', { title: 'Register' }));
app.get('/register/company', (req, res) => res.render('register-company', { title: 'Company Registration', form: {} }));
app.get('/register/worker', (req, res) => res.render('register-worker', { title: 'Worker Registration', form: {} }));

function validateAccount(body) {
  const email = str(body.email, 200).toLowerCase();
  const password = String(body.password || '');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return 'Please enter a valid email address.';
  if (password.length < 6) return 'Password must be at least 6 characters.';
  if (password !== body.password_confirm) return 'Passwords do not match.';
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) return 'An account with this email already exists.';
  return null;
}

app.post('/register/company', (req, res) => {
  const b = req.body;
  const err = validateAccount(b)
    || (!str(b.company_name) && 'Company name is required.')
    || (!str(b.cr_number) && 'Commercial Registration (CR) number is required.')
    || (!str(b.contact_person) && 'Contact person is required.')
    || (!str(b.city) && 'City is required.')
    || (!str(b.phone) && 'Phone number is required.');
  if (err) return res.status(400).render('register-company', { title: 'Company Registration', form: b, error: err });
  const tx = db.transaction(() => {
    const info = db.prepare('INSERT INTO users (role, email, phone, password_hash, name) VALUES (?,?,?,?,?)')
      .run('company', str(b.email, 200).toLowerCase(), str(b.phone, 30), hashPassword(b.password), str(b.company_name, 200));
    db.prepare('INSERT INTO companies (user_id, company_name, cr_number, city, address, contact_person) VALUES (?,?,?,?,?,?)')
      .run(info.lastInsertRowid, str(b.company_name, 200), str(b.cr_number, 50), str(b.city, 100), str(b.address), str(b.contact_person, 200));
    return info.lastInsertRowid;
  });
  const id = tx();
  req.session.regenerate(() => {
    req.session.user = { id, role: 'company', name: str(b.company_name, 200) };
    flash(req, 'success', 'Registration complete. Your company will be verified by the admin before your demands become public.');
    res.redirect('/company');
  });
});

app.post('/register/worker', (req, res) => {
  const b = req.body;
  const err = validateAccount(b)
    || (!str(b.full_name) && 'Full name is required.')
    || (!str(b.nationality) && 'Nationality is required.')
    || (!str(b.profession) && 'Profession is required.')
    || (!str(b.phone) && 'Phone number is required.');
  if (err) return res.status(400).render('register-worker', { title: 'Worker Registration', form: b, error: err });
  const tx = db.transaction(() => {
    const info = db.prepare('INSERT INTO users (role, email, phone, password_hash, name) VALUES (?,?,?,?,?)')
      .run('worker', str(b.email, 200).toLowerCase(), str(b.phone, 30), hashPassword(b.password), str(b.full_name, 200));
    db.prepare(`INSERT INTO workers (user_id, full_name, nationality, iqama_number, passport_number, profession, experience_years, skills, city, date_of_birth)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(info.lastInsertRowid, str(b.full_name, 200), str(b.nationality, 100), str(b.iqama_number, 30),
      str(b.passport_number, 30), str(b.profession, 100), Math.max(0, int(b.experience_years)), str(b.skills, 1000), str(b.city, 100), str(b.date_of_birth, 10));
    return info.lastInsertRowid;
  });
  const id = tx();
  req.session.regenerate(() => {
    req.session.user = { id, role: 'worker', name: str(b.full_name, 200) };
    flash(req, 'success', 'Welcome! Upload your documents (Iqama, Passport, Photo, CV) so you can apply to jobs quickly.');
    res.redirect('/worker/documents');
  });
});

app.get('/login', (req, res) => res.render('login', { title: 'Login', next: str(req.query.next, 300) }));

app.post('/login', (req, res) => {
  const email = str(req.body.email, 200).toLowerCase();
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !verifyPassword(req.body.password || '', user.password_hash)) {
    return res.status(401).render('login', { title: 'Login', next: str(req.body.next, 300), error: 'Wrong email or password.', email });
  }
  const next = str(req.body.next, 300);
  req.session.regenerate(() => {
    req.session.user = { id: user.id, role: user.role, name: user.name };
    const home = { company: '/company', worker: '/worker', admin: '/admin' }[user.role];
    res.redirect(next.startsWith('/') && !next.startsWith('//') ? next : home);
  });
});

app.post('/logout', (req, res) => req.session.destroy(() => res.redirect('/')));

// ---------- Company area ----------
const companyOnly = requireRole('company');

app.get('/company', companyOnly, (req, res) => {
  const company = db.prepare('SELECT * FROM companies WHERE user_id = ?').get(req.session.user.id);
  const demands = db.prepare(`
    SELECT d.*,
      (SELECT COUNT(*) FROM applications a WHERE a.demand_id=d.id AND a.status != 'withdrawn') AS applicant_count,
      (SELECT COUNT(*) FROM applications a WHERE a.demand_id=d.id AND a.status = 'applied') AS new_count,
      (SELECT COUNT(*) FROM applications a WHERE a.demand_id=d.id AND a.status = 'hired') AS hired_count
    FROM demands d WHERE d.company_id = ? ORDER BY d.created_at DESC`).all(req.session.user.id);
  res.render('company/dashboard', { title: 'Company Dashboard', company, demands });
});

function demandFromBody(b) {
  const docs = [].concat(b.required_docs || []).filter((d) => DOC_TYPES[d]);
  const d = {
    title: str(b.title, 150), category: str(b.category, 100), quantity: int(b.quantity),
    salary_amount: parseFloat(b.salary_amount), salary_type: str(b.salary_type, 10),
    hours_per_day: int(b.hours_per_day), days_per_week: int(b.days_per_week, 6), duration: str(b.duration, 100),
    location_city: str(b.location_city, 100), work_site: str(b.work_site, 200),
    food: str(b.food, 10) || 'no', accommodation: str(b.accommodation, 10) || 'no', transport: str(b.transport, 10) || 'no',
    overtime: str(b.overtime, 200), requirements: str(b.requirements, 3000), required_docs: docs.join(','),
    start_date: str(b.start_date, 10), deadline: str(b.deadline, 10),
  };
  let error = null;
  if (!d.title) error = 'Job title is required.';
  else if (!CATEGORIES.includes(d.category)) error = 'Please choose a category.';
  else if (d.quantity < 1 || d.quantity > 10000) error = 'Number of workers must be between 1 and 10000.';
  else if (!Number.isFinite(d.salary_amount) || d.salary_amount < 0) error = 'Please enter a valid salary / rate.';
  else if (!SALARY_TYPES[d.salary_type]) error = 'Please choose the salary type.';
  else if (d.hours_per_day < 1 || d.hours_per_day > 24) error = 'Working hours per day must be between 1 and 24.';
  else if (d.days_per_week < 1 || d.days_per_week > 7) error = 'Working days per week must be between 1 and 7.';
  else if (!d.duration) error = 'Contract duration is required.';
  else if (!d.location_city) error = 'Work location is required.';
  return { d, error };
}

app.get('/company/demands/new', companyOnly, (req, res) => {
  res.render('company/demand-form', { title: 'Post a Demand', form: { required_docs: 'iqama,passport,photo', days_per_week: 6, hours_per_day: 8, salary_type: 'hourly' }, action: '/company/demands' });
});

app.post('/company/demands', companyOnly, (req, res) => {
  const { d, error } = demandFromBody(req.body);
  if (error) return res.status(400).render('company/demand-form', { title: 'Post a Demand', form: { ...req.body, required_docs: d.required_docs }, error, action: '/company/demands' });
  const info = db.prepare(`INSERT INTO demands (company_id, title, category, quantity, salary_amount, salary_type, hours_per_day, days_per_week,
    duration, location_city, work_site, food, accommodation, transport, overtime, requirements, required_docs, start_date, deadline)
    VALUES (@company_id,@title,@category,@quantity,@salary_amount,@salary_type,@hours_per_day,@days_per_week,@duration,@location_city,
    @work_site,@food,@accommodation,@transport,@overtime,@requirements,@required_docs,@start_date,@deadline)`).run({ ...d, company_id: req.session.user.id });
  flash(req, 'success', 'Demand posted. Workers can now see and apply to it.');
  res.redirect('/company/demands/' + info.lastInsertRowid);
});

function ownDemand(req, res) {
  const demand = getDemand(req.params.id);
  if (!demand || demand.company_id !== req.session.user.id) {
    res.status(404).render('error', { title: 'Not found', message: 'Demand not found.' });
    return null;
  }
  return demand;
}

app.get('/company/demands/:id/edit', companyOnly, (req, res) => {
  const demand = ownDemand(req, res); if (!demand) return;
  res.render('company/demand-form', { title: 'Edit Demand', form: demand, action: `/company/demands/${demand.id}/edit` });
});

app.post('/company/demands/:id/edit', companyOnly, (req, res) => {
  const demand = ownDemand(req, res); if (!demand) return;
  const { d, error } = demandFromBody(req.body);
  if (error) return res.status(400).render('company/demand-form', { title: 'Edit Demand', form: { ...req.body, required_docs: d.required_docs }, error, action: `/company/demands/${demand.id}/edit` });
  db.prepare(`UPDATE demands SET title=@title, category=@category, quantity=@quantity, salary_amount=@salary_amount, salary_type=@salary_type,
    hours_per_day=@hours_per_day, days_per_week=@days_per_week, duration=@duration, location_city=@location_city, work_site=@work_site,
    food=@food, accommodation=@accommodation, transport=@transport, overtime=@overtime, requirements=@requirements,
    required_docs=@required_docs, start_date=@start_date, deadline=@deadline WHERE id=@id`).run({ ...d, id: demand.id });
  flash(req, 'success', 'Demand updated.');
  res.redirect('/company/demands/' + demand.id);
});

app.post('/company/demands/:id/status', companyOnly, (req, res) => {
  const demand = ownDemand(req, res); if (!demand) return;
  const status = req.body.status === 'closed' ? 'closed' : 'open';
  db.prepare('UPDATE demands SET status = ? WHERE id = ?').run(status, demand.id);
  flash(req, 'success', status === 'closed' ? 'Demand closed. Workers can no longer apply.' : 'Demand re-opened.');
  res.redirect('/company/demands/' + demand.id);
});

app.get('/company/demands/:id', companyOnly, (req, res) => {
  const demand = ownDemand(req, res); if (!demand) return;
  const filter = APP_STATUS[req.query.status] ? req.query.status : '';
  const applications = db.prepare(`
    SELECT a.*, w.full_name, w.nationality, w.profession, w.experience_years, w.iqama_number, w.city, u.phone, u.email
    FROM applications a JOIN workers w ON w.user_id = a.worker_id JOIN users u ON u.id = w.user_id
    WHERE a.demand_id = ? ${filter ? 'AND a.status = ?' : "AND a.status != 'withdrawn'"}
    ORDER BY CASE a.status WHEN 'hired' THEN 0 WHEN 'shortlisted' THEN 1 WHEN 'applied' THEN 2 ELSE 3 END, a.created_at`)
    .all(...(filter ? [demand.id, filter] : [demand.id]));
  const counts = Object.fromEntries(db.prepare('SELECT status, COUNT(*) n FROM applications WHERE demand_id = ? GROUP BY status').all(demand.id).map((r) => [r.status, r.n]));
  res.render('company/demand-applicants', { title: demand.title, demand, applications, counts, filter });
});

function companyApplication(req, res) {
  const a = db.prepare(`SELECT a.*, d.company_id, d.title AS demand_title, d.required_docs, d.quantity, d.id AS demand_id
    FROM applications a JOIN demands d ON d.id = a.demand_id WHERE a.id = ?`).get(req.params.id);
  if (!a || a.company_id !== req.session.user.id) {
    res.status(404).render('error', { title: 'Not found', message: 'Application not found.' });
    return null;
  }
  return a;
}

app.get('/company/applications/:id', companyOnly, (req, res) => {
  const a = companyApplication(req, res); if (!a) return;
  const worker = db.prepare('SELECT w.*, u.email, u.phone FROM workers w JOIN users u ON u.id = w.user_id WHERE w.user_id = ?').get(a.worker_id);
  const documents = db.prepare('SELECT * FROM documents WHERE worker_id = ? ORDER BY doc_type, uploaded_at DESC').all(a.worker_id);
  res.render('company/application', { title: worker.full_name, a, worker, documents });
});

app.post('/company/applications/:id/status', companyOnly, (req, res) => {
  const a = companyApplication(req, res); if (!a) return;
  const status = str(req.body.status, 20);
  if (!['applied', 'shortlisted', 'hired', 'rejected'].includes(status) || a.status === 'withdrawn') {
    flash(req, 'error', 'Invalid status change.');
    return res.redirect('/company/applications/' + a.id);
  }
  if (status === 'hired' && a.status !== 'hired') {
    const hired = db.prepare("SELECT COUNT(*) n FROM applications WHERE demand_id = ? AND status = 'hired'").get(a.demand_id).n;
    if (hired >= a.quantity) {
      flash(req, 'error', 'You already hired {hired} of {quantity} workers. Increase the quantity in the demand to hire more.', { hired, quantity: a.quantity });
      return res.redirect('/company/applications/' + a.id);
    }
  }
  db.prepare("UPDATE applications SET status = ?, company_note = ?, updated_at = datetime('now') WHERE id = ?")
    .run(status, str(req.body.company_note, 1000), a.id);
  flash(req, 'success', 'Applicant marked as {status}.', { status: req.t(APP_STATUS[status]) });
  res.redirect(req.body.back === 'list' ? '/company/demands/' + a.demand_id : '/company/applications/' + a.id);
});

app.get('/company/profile', companyOnly, (req, res) => {
  const company = db.prepare('SELECT c.*, u.email, u.phone FROM companies c JOIN users u ON u.id=c.user_id WHERE c.user_id = ?').get(req.session.user.id);
  res.render('company/profile', { title: 'Company Profile', form: company });
});

app.post('/company/profile', companyOnly, (req, res) => {
  const b = req.body;
  if (!str(b.company_name) || !str(b.contact_person) || !str(b.city)) {
    flash(req, 'error', 'Company name, contact person and city are required.');
    return res.redirect('/company/profile');
  }
  db.prepare('UPDATE companies SET company_name=?, city=?, address=?, contact_person=? WHERE user_id=?')
    .run(str(b.company_name, 200), str(b.city, 100), str(b.address), str(b.contact_person, 200), req.session.user.id);
  db.prepare('UPDATE users SET name=?, phone=? WHERE id=?').run(str(b.company_name, 200), str(b.phone, 30), req.session.user.id);
  req.session.user.name = str(b.company_name, 200);
  flash(req, 'success', 'Profile updated.');
  res.redirect('/company/profile');
});

// ---------- Worker area ----------
const workerOnly = requireRole('worker');

app.get('/worker', workerOnly, (req, res) => {
  const worker = db.prepare('SELECT * FROM workers WHERE user_id = ?').get(req.session.user.id);
  const applications = db.prepare(`
    SELECT a.*, d.title, d.salary_amount, d.salary_type, d.location_city, d.status AS demand_status, c.company_name
    FROM applications a JOIN demands d ON d.id = a.demand_id JOIN companies c ON c.user_id = d.company_id
    WHERE a.worker_id = ? ORDER BY a.updated_at DESC`).all(req.session.user.id);
  const docTypes = db.prepare('SELECT DISTINCT doc_type FROM documents WHERE worker_id = ?').all(req.session.user.id).map((r) => r.doc_type);
  const recommended = db.prepare(`
    SELECT d.*, c.company_name FROM demands d JOIN companies c ON c.user_id = d.company_id
    WHERE d.status='open' AND c.status='approved' AND (d.deadline IS NULL OR d.deadline = '' OR d.deadline >= date('now'))
      AND d.id NOT IN (SELECT demand_id FROM applications WHERE worker_id = ?)
    ORDER BY (d.category = ?) DESC, d.created_at DESC LIMIT 4`).all(req.session.user.id, worker.profession);
  res.render('worker/dashboard', { title: 'My Dashboard', worker, applications, docTypes, recommended });
});

app.get('/worker/documents', workerOnly, (req, res) => {
  const documents = db.prepare('SELECT * FROM documents WHERE worker_id = ? ORDER BY uploaded_at DESC').all(req.session.user.id);
  res.render('worker/documents', { title: 'My Documents', documents });
});

app.post('/worker/documents', workerOnly, handleUpload(docFields, '/worker/documents'), checkCsrf, (req, res) => {
  const n = saveDocuments(req.session.user.id, req.files);
  if (n) flash(req, 'success', '{n} document(s) uploaded.', { n });
  else flash(req, 'error', 'Please choose at least one file.');
  res.redirect('/worker/documents');
});

app.post('/worker/documents/:id/delete', workerOnly, (req, res) => {
  const doc = db.prepare('SELECT * FROM documents WHERE id = ? AND worker_id = ?').get(req.params.id, req.session.user.id);
  if (doc) {
    db.prepare('DELETE FROM documents WHERE id = ?').run(doc.id);
    fs.rm(path.join(UPLOAD_DIR, doc.file_name), { force: true }, () => {});
    flash(req, 'success', 'Document deleted.');
  }
  res.redirect('/worker/documents');
});

app.get('/worker/profile', workerOnly, (req, res) => {
  const worker = db.prepare('SELECT w.*, u.email, u.phone FROM workers w JOIN users u ON u.id = w.user_id WHERE w.user_id = ?').get(req.session.user.id);
  res.render('worker/profile', { title: 'My Profile', form: worker });
});

app.post('/worker/profile', workerOnly, (req, res) => {
  const b = req.body;
  if (!str(b.full_name) || !str(b.nationality) || !str(b.profession)) {
    flash(req, 'error', 'Name, nationality and profession are required.');
    return res.redirect('/worker/profile');
  }
  db.prepare(`UPDATE workers SET full_name=?, nationality=?, iqama_number=?, passport_number=?, profession=?, experience_years=?, skills=?, city=?, date_of_birth=? WHERE user_id=?`)
    .run(str(b.full_name, 200), str(b.nationality, 100), str(b.iqama_number, 30), str(b.passport_number, 30), str(b.profession, 100),
      Math.max(0, int(b.experience_years)), str(b.skills, 1000), str(b.city, 100), str(b.date_of_birth, 10), req.session.user.id);
  db.prepare('UPDATE users SET name=?, phone=? WHERE id=?').run(str(b.full_name, 200), str(b.phone, 30), req.session.user.id);
  req.session.user.name = str(b.full_name, 200);
  flash(req, 'success', 'Profile updated.');
  res.redirect('/worker/profile');
});

app.post('/demands/:id/apply', workerOnly, handleUpload(docFields, (req) => '/demands/' + req.params.id), checkCsrf, (req, res) => {
  const demand = getDemand(req.params.id);
  const workerId = req.session.user.id;
  const back = '/demands/' + req.params.id;
  if (!demand || demand.status !== 'open' || demand.company_status !== 'approved' || (demand.deadline && demand.deadline < new Date().toISOString().slice(0, 10))) {
    flash(req, 'error', 'This demand is no longer accepting applications.');
    return res.redirect('/demands');
  }
  const existing = db.prepare('SELECT * FROM applications WHERE demand_id = ? AND worker_id = ?').get(demand.id, workerId);
  if (existing && existing.status !== 'withdrawn') {
    flash(req, 'error', 'You have already applied to this demand.');
    return res.redirect(back);
  }
  saveDocuments(workerId, req.files);
  const have = new Set(db.prepare('SELECT DISTINCT doc_type FROM documents WHERE worker_id = ?').all(workerId).map((r) => r.doc_type));
  const missing = demand.required_docs.split(',').filter((d) => d && !have.has(d));
  if (missing.length) {
    flash(req, 'error', 'Please upload the required documents: {docs}', { docs: missing.map((m) => req.t(DOC_TYPES[m])).join(', ') });
    return res.redirect(back);
  }
  if (existing) {
    db.prepare("UPDATE applications SET status='applied', cover_note=?, company_note=NULL, created_at=datetime('now'), updated_at=datetime('now') WHERE id=?")
      .run(str(req.body.cover_note, 1000), existing.id);
  } else {
    db.prepare('INSERT INTO applications (demand_id, worker_id, cover_note) VALUES (?,?,?)').run(demand.id, workerId, str(req.body.cover_note, 1000));
  }
  flash(req, 'success', 'Application submitted! The company will review your documents. Track the status from your dashboard.');
  res.redirect('/worker');
});

app.post('/worker/applications/:id/withdraw', workerOnly, (req, res) => {
  const r = db.prepare("UPDATE applications SET status='withdrawn', updated_at=datetime('now') WHERE id=? AND worker_id=? AND status IN ('applied','shortlisted')")
    .run(req.params.id, req.session.user.id);
  flash(req, r.changes ? 'success' : 'error', r.changes ? 'Application withdrawn.' : 'This application cannot be withdrawn.');
  res.redirect('/worker');
});

// ---------- Secure document download ----------
app.get('/documents/:id', requireRole('worker', 'company', 'admin'), (req, res) => {
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  const u = req.session.user;
  let allowed = false;
  if (doc) {
    if (u.role === 'admin') allowed = true;
    else if (u.role === 'worker') allowed = doc.worker_id === u.id;
    else if (u.role === 'company') {
      // A company may see a worker's documents only if that worker applied to one of its demands.
      allowed = !!db.prepare(`SELECT 1 FROM applications a JOIN demands d ON d.id = a.demand_id
        WHERE a.worker_id = ? AND d.company_id = ? AND a.status != 'withdrawn'`).get(doc.worker_id, u.id);
    }
  }
  if (!allowed) return res.status(404).render('error', { title: 'Not found', message: 'Document not found.' });
  res.type(doc.mime_type);
  res.set('Content-Disposition', `inline; filename="${doc.original_name.replace(/[^\w.\- ]/g, '_')}"`);
  res.set('X-Content-Type-Options', 'nosniff');
  res.sendFile(path.join(UPLOAD_DIR, doc.file_name));
});

// ---------- Admin ----------
const adminOnly = requireRole('admin');

app.get('/admin', adminOnly, (req, res) => {
  const stats = {
    companies: db.prepare('SELECT COUNT(*) n FROM companies').get().n,
    pending: db.prepare("SELECT COUNT(*) n FROM companies WHERE status='pending'").get().n,
    workers: db.prepare('SELECT COUNT(*) n FROM workers').get().n,
    demands: db.prepare("SELECT COUNT(*) n FROM demands WHERE status='open'").get().n,
    applications: db.prepare('SELECT COUNT(*) n FROM applications').get().n,
    hired: db.prepare("SELECT COUNT(*) n FROM applications WHERE status='hired'").get().n,
  };
  const companies = db.prepare(`SELECT c.*, u.email, u.phone, u.created_at,
    (SELECT COUNT(*) FROM demands d WHERE d.company_id = c.user_id) AS demand_count
    FROM companies c JOIN users u ON u.id = c.user_id ORDER BY (c.status='pending') DESC, u.created_at DESC`).all();
  const workers = db.prepare(`SELECT w.*, u.email, u.phone, u.created_at,
    (SELECT COUNT(*) FROM documents x WHERE x.worker_id = w.user_id) AS doc_count,
    (SELECT COUNT(*) FROM applications a WHERE a.worker_id = w.user_id) AS app_count
    FROM workers w JOIN users u ON u.id = w.user_id ORDER BY u.created_at DESC LIMIT 100`).all();
  const demands = db.prepare(`SELECT d.*, c.company_name,
    (SELECT COUNT(*) FROM applications a WHERE a.demand_id = d.id AND a.status != 'withdrawn') AS applicant_count,
    (SELECT COUNT(*) FROM applications a WHERE a.demand_id = d.id AND a.status = 'hired') AS hired_count
    FROM demands d JOIN companies c ON c.user_id = d.company_id ORDER BY d.created_at DESC LIMIT 100`).all();
  res.render('admin/dashboard', { title: 'Admin', stats, companies, workers, demands });
});

app.post('/admin/companies/:id/status', adminOnly, (req, res) => {
  const status = ['approved', 'rejected', 'pending'].includes(req.body.status) ? req.body.status : 'pending';
  db.prepare('UPDATE companies SET status = ? WHERE user_id = ?').run(status, req.params.id);
  flash(req, 'success', { approved: 'Company approved.', rejected: 'Company rejected.', pending: 'Company set to pending.' }[status]);
  res.redirect('/admin');
});

app.get('/admin/workers/:id', adminOnly, (req, res) => {
  const worker = db.prepare('SELECT w.*, u.email, u.phone FROM workers w JOIN users u ON u.id = w.user_id WHERE w.user_id = ?').get(req.params.id);
  if (!worker) return res.status(404).render('error', { title: 'Not found', message: 'Worker not found.' });
  const documents = db.prepare('SELECT * FROM documents WHERE worker_id = ? ORDER BY doc_type').all(worker.user_id);
  res.render('admin/worker', { title: worker.full_name, worker, documents });
});

// ---------- Errors ----------
app.use((req, res) => res.status(404).render('error', { title: 'Not found', message: 'Page not found.' }));
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error(err);
  res.status(500).render('error', { title: 'Error', message: 'Something went wrong. Please try again.' });
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`Manpower portal running on http://localhost:${PORT}`));
}

module.exports = app;
