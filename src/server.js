const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const db = require('./db');
const web = require('./lib/web');
const { escapeHtml } = require('./lib/template');
const { hashPassword, verifyPassword } = require('./lib/password');
const {
  CATEGORIES, DOC_TYPES, CITIES, SALARY_TYPES, APP_STATUS, NATIONALITIES,
  KAFALA_OPTIONS, DRIVING_OPTIONS, NOTIFY_CHANNELS, FIELD_TYPES, TIMESHEET_STATUS, PAYMENT_METHODS, PAYMENT_STATUS, REVIEW_STATUS,
  WORKER_CHECK, EXPENSE_CATEGORIES,
} = require('./constants');
const { notifyUser } = require('./notify');
const jobAlerts = require('./jobAlerts');
const {
  LANGUAGES, translator, pickLanguage, formatMonth, formatMoney,
} = require('./i18n');

const app = web.createApp();
const PORT = Number(process.env.PORT) || 3000;
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
const LOGO_DIR = path.join(UPLOAD_DIR, 'logos');
fs.mkdirSync(LOGO_DIR, { recursive: true });

app.set('views', path.join(__dirname, '..', 'views'));
app.use(web.serveStatic(path.join(__dirname, '..', 'public')));

// Language: chosen from the header menu, remembered in a cookie. English is the default.
app.use((req, res, next) => {
  req.lang = pickLanguage(req);
  req.t = translator(req.lang);
  next();
});
app.use(web.urlencoded());
app.use(web.sessions({ db, maxAgeMs: 1000 * 60 * 60 * 24 * 7, secure: process.env.COOKIE_SECURE === '1' }));
app.get('/lang', (req, res) => {
  const code = LANGUAGES[req.query.code] ? req.query.code : 'en';
  const nextUrl = String(req.query.next || '/');
  // Logged-in users also get their WhatsApp / SMS messages in this language.
  if (req.session.user) db.prepare('UPDATE users SET lang = ? WHERE id = ?').run(code, req.session.user.id);
  res.set('Set-Cookie', `lang=${code}; Path=/; Max-Age=${60 * 60 * 24 * 365}; SameSite=Lax`);
  res.redirect(nextUrl.startsWith('/') && !nextUrl.startsWith('//') ? nextUrl : '/');
});

// ---------- File uploads ----------
// Wrap the upload parser so upload errors become flash messages instead of error pages.
function handleUpload(fieldNames, back, opts = {}) {
  const mw = web.upload({ dir: UPLOAD_DIR, maxFileSize: 5 * 1024 * 1024, maxFiles: 10, allowedFields: fieldNames, ...opts });
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
  // Job posts and worker rates are only for approved workers and the admin (so companies never see them).
  const u = req.session.user;
  req.workerStatus = u && u.role === 'worker' ? db.prepare('SELECT status FROM workers WHERE user_id = ?').get(u.id)?.status : null;
  req.canSeeJobs = !!u && (u.role === 'admin' || req.workerStatus === 'approved');
  res.locals.workerStatus = req.workerStatus;
  res.locals.canSeeJobs = req.canSeeJobs;
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;
  res.locals.csrf = csrfToken(req);
  res.locals.path = req.path;
  res.locals.currentUrl = req.originalUrl;
  Object.assign(res.locals, {
    CATEGORIES, DOC_TYPES, CITIES, SALARY_TYPES, APP_STATUS, NATIONALITIES, LANGUAGES,
    KAFALA_OPTIONS, DRIVING_OPTIONS, NOTIFY_CHANNELS, FIELD_TYPES, TIMESHEET_STATUS, PAYMENT_METHODS, PAYMENT_STATUS, REVIEW_STATUS,
    WORKER_CHECK, EXPENSE_CATEGORIES,
  });
  res.locals.fmtMonth = (ym) => formatMonth(ym, req.lang);
  // Date and time in Saudi time (stored times are UTC).
  res.locals.fmtDateTime = (s) => (s ? new Date(s.replace(' ', 'T') + 'Z').toLocaleString(lang.locale + '-u-nu-latn', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Riyadh',
  }) : '—');
  res.locals.money = formatMoney;
  res.locals.escapeHtml = escapeHtml;
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

// Job posts: approved workers and the admin only.
function requireJobAccess(req, res, next) {
  if (req.canSeeJobs) return next();
  const u = req.session.user;
  if (!u) {
    flash(req, 'error', 'Please log in as an approved worker to see jobs.');
    return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
  }
  if (u.role === 'worker') {
    flash(req, 'error', 'Your account is waiting for approval. You can see jobs after ManpowerHub KSA approves it.');
    return res.redirect('/worker');
  }
  res.status(403).render('error', { title: 'Access denied', message: 'Job posts are only visible to approved workers.' });
}

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
    SELECT d.*, c.company_name, c.logo_file, c.city AS company_city, c.cr_number, c.contact_person, c.status AS company_status,
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
const logoUpload = {
  dir: LOGO_DIR, maxFileSize: 2 * 1024 * 1024, maxFiles: 1, allowedMimes: ['image/jpeg', 'image/png', 'image/webp'],
  typeError: '"{file}" must be a JPG, PNG or WEBP image.',
};
const removeLogo = (file) => { if (file) fs.rm(path.join(LOGO_DIR, file), { force: true }, () => {}); };
const notifyChannel = (v) => (NOTIFY_CHANNELS[v] ? v : 'whatsapp');

// ---------- Extra worker fields defined by the admin ----------
const activeFields = () => db.prepare('SELECT * FROM custom_fields WHERE active = 1 ORDER BY sort, id').all();

function fieldValues(workerId) {
  return Object.fromEntries(db.prepare('SELECT field_id, value FROM worker_field_values WHERE worker_id = ?').all(workerId).map((r) => [r.field_id, r.value]));
}

// Read and check the extra fields from a submitted form. Returns { values, error }.
function readCustomFields(req) {
  const values = [];
  for (const f of activeFields()) {
    const v = str(req.body['cf_' + f.id], 1000);
    const options = f.options.split(',').map((o) => o.trim()).filter(Boolean);
    const bad = v && ((f.field_type === 'number' && !Number.isFinite(Number(v)))
      || (f.field_type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(v))
      || (f.field_type === 'yesno' && !['yes', 'no'].includes(v))
      || (f.field_type === 'select' && !options.includes(v)));
    if (bad) return { error: req.t('Please check "{field}".', { field: f.label }) };
    if (f.required && !v) return { error: req.t('Please fill in "{field}".', { field: f.label }) };
    values.push({ id: f.id, value: v });
  }
  return { values };
}

function customFormValues(body) {
  return Object.fromEntries(Object.entries(body).filter(([k]) => k.startsWith('cf_')).map(([k, v]) => [k.slice(3), v]));
}

function saveCustomFields(workerId, values) {
  const put = db.prepare('INSERT INTO worker_field_values (worker_id, field_id, value) VALUES (?,?,?) ON CONFLICT(worker_id, field_id) DO UPDATE SET value = excluded.value');
  const del = db.prepare('DELETE FROM worker_field_values WHERE worker_id = ? AND field_id = ?');
  for (const { id, value } of values) {
    if (value) put.run(workerId, id, value);
    else del.run(workerId, id);
  }
}

// Filled-in extra fields of a worker, for companies and the admin to read.
function workerExtras(workerId) {
  return db.prepare(`SELECT f.label, f.field_type, v.value FROM worker_field_values v JOIN custom_fields f ON f.id = v.field_id
    WHERE v.worker_id = ? AND f.active = 1 ORDER BY f.sort, f.id`).all(workerId);
}

function workerExtraColumns(b) {
  return {
    iqama_expiry: str(b.iqama_expiry, 10), passport_expiry: str(b.passport_expiry, 10),
    kafala_transfer: KAFALA_OPTIONS[b.kafala_transfer] ? b.kafala_transfer : '',
    languages: str(b.languages, 300),
    driving_license: DRIVING_OPTIONS[b.driving_license] ? b.driving_license : '',
    expected_salary: str(b.expected_salary, 100), available_from: str(b.available_from, 10),
    work_history: str(b.work_history, 3000),
    bank_name: str(b.bank_name, 100), iban: str(b.iban, 34).toUpperCase().replace(/\s+/g, ''),
  };
}

// ---------- Public pages ----------
app.get('/', (req, res) => {
  const stats = {
    openDemands: db.prepare("SELECT COUNT(*) n FROM demands d JOIN companies c ON c.user_id=d.company_id WHERE d.status='open' AND c.status='approved' AND d.review_status='published'").get().n,
    positions: db.prepare("SELECT COALESCE(SUM(quantity),0) n FROM demands d JOIN companies c ON c.user_id=d.company_id WHERE d.status='open' AND c.status='approved' AND d.review_status='published'").get().n,
    companies: db.prepare("SELECT COUNT(*) n FROM companies WHERE status='approved'").get().n,
    workers: db.prepare('SELECT COUNT(*) n FROM workers').get().n,
  };
  const latest = req.canSeeJobs ? db.prepare(`
    SELECT d.*, c.company_name, c.logo_file FROM demands d JOIN companies c ON c.user_id = d.company_id
    WHERE d.status='open' AND c.status='approved' AND d.review_status='published' ORDER BY d.published_at DESC LIMIT 6`).all() : [];
  res.render('home', { title: 'Home', stats, latest });
});

app.get('/demands', requireJobAccess, (req, res) => {
  const q = str(req.query.q, 100);
  const category = str(req.query.category, 100);
  const city = str(req.query.city, 100);
  const where = ["d.status = 'open'", "c.status = 'approved'", "d.review_status = 'published'", "(d.deadline IS NULL OR d.deadline = '' OR d.deadline >= date('now'))"];
  const params = [];
  // Company names are only searchable when the admin chose to show them to workers.
  if (q) { where.push('(d.title LIKE ? OR d.requirements LIKE ? OR (d.show_company = 1 AND c.company_name LIKE ?))'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  if (category) { where.push('d.category = ?'); params.push(category); }
  if (city) { where.push('d.location_city = ?'); params.push(city); }
  const demands = db.prepare(`
    SELECT d.*, c.company_name, c.logo_file,
      (SELECT COUNT(*) FROM applications a WHERE a.demand_id = d.id AND a.status = 'hired') AS hired_count
    FROM demands d JOIN companies c ON c.user_id = d.company_id
    WHERE ${where.join(' AND ')} ORDER BY d.published_at DESC LIMIT 200`).all(...params);
  res.render('demands', { title: 'Job Demands', demands, filters: { q, category, city } });
});

app.get('/demands/:id', requireJobAccess, (req, res) => {
  const demand = getDemand(req.params.id);
  const u = req.session.user;
  const isPublic = demand && demand.status === 'open' && demand.company_status === 'approved' && demand.review_status === 'published';
  const visible = isPublic || (demand && u.role === 'admin');
  if (!visible) return res.status(404).render('error', { title: 'Not found', message: 'This demand does not exist or is no longer available.' });
  let application = null;
  let docs = [];
  let workerCity = null;
  if (u && u.role === 'worker') {
    application = db.prepare('SELECT * FROM applications WHERE demand_id = ? AND worker_id = ?').get(demand.id, u.id);
    docs = db.prepare('SELECT DISTINCT doc_type FROM documents WHERE worker_id = ?').all(u.id).map((r) => r.doc_type);
    workerCity = db.prepare('SELECT city FROM workers WHERE user_id = ?').get(u.id).city;
  }
  res.render('demand-detail', { title: demand.title, demand, application, workerDocTypes: docs, workerCity });
});

// Printable job offer from the supply company, with the worker's terms (digital version of the paper demand).
app.get('/demands/:id/letter', requireJobAccess, (req, res) => {
  const demand = getDemand(req.params.id);
  const u = req.session.user;
  if (!demand || !((demand.company_status === 'approved' && demand.review_status === 'published') || u.role === 'admin')) {
    return res.status(404).render('error', { title: 'Not found', message: 'Demand not found.' });
  }
  res.render('demand-letter', { title: 'Demand Letter', demand, layout: false });
});

// Company logos are public (they appear on job demands).
app.get('/logos/:file', (req, res) => {
  const file = req.params.file;
  if (!/^[\w.-]+$/.test(file) || !db.prepare('SELECT 1 FROM companies WHERE logo_file = ?').get(file)) {
    return res.status(404).send('Not found');
  }
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  res.sendFile(path.join(LOGO_DIR, file));
});

// ---------- Auth ----------
app.get('/register', (req, res) => res.render('register-choice', { title: 'Register' }));
app.get('/register/company', (req, res) => res.render('register-company', { title: 'Company Registration', form: {} }));
app.get('/register/worker', (req, res) => res.render('register-worker', { title: 'Worker Registration', form: {}, fields: activeFields(), values: {} }));

function validateAccount(body) {
  const email = str(body.email, 200).toLowerCase();
  const password = String(body.password || '');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return 'Please enter a valid email address.';
  if (password.length < 6) return 'Password must be at least 6 characters.';
  if (password !== body.password_confirm) return 'Passwords do not match.';
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) return 'An account with this email already exists.';
  return null;
}

app.post('/register/company', handleUpload(['logo'], '/register/company', logoUpload), checkCsrf, (req, res) => {
  const b = req.body;
  const logo = req.files?.logo?.[0]?.filename || null;
  const err = validateAccount(b)
    || (!str(b.company_name) && 'Company name is required.')
    || (!str(b.cr_number) && 'Commercial Registration (CR) number is required.')
    || (!str(b.contact_person) && 'Contact person is required.')
    || (!str(b.city) && 'City is required.')
    || (!str(b.phone) && 'Phone number is required.');
  if (err) {
    removeLogo(logo);
    return res.status(400).render('register-company', { title: 'Company Registration', form: b, error: err });
  }
  const tx = db.transaction(() => {
    const info = db.prepare('INSERT INTO users (role, email, phone, password_hash, name, lang, notify_channel) VALUES (?,?,?,?,?,?,?)')
      .run('company', str(b.email, 200).toLowerCase(), str(b.phone, 30), hashPassword(b.password), str(b.company_name, 200), req.lang, notifyChannel(b.notify_channel));
    db.prepare('INSERT INTO companies (user_id, company_name, cr_number, city, address, contact_person, logo_file) VALUES (?,?,?,?,?,?,?)')
      .run(info.lastInsertRowid, str(b.company_name, 200), str(b.cr_number, 50), str(b.city, 100), str(b.address), str(b.contact_person, 200), logo);
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
  const custom = readCustomFields(req);
  if (err || custom.error) {
    return res.status(400).render('register-worker', {
      title: 'Worker Registration', form: { ...b, job_alerts: b.job_alerts || '0' }, error: err || custom.error, fields: activeFields(), values: customFormValues(b),
    });
  }
  const tx = db.transaction(() => {
    const info = db.prepare('INSERT INTO users (role, email, phone, password_hash, name, lang, notify_channel) VALUES (?,?,?,?,?,?,?)')
      .run('worker', str(b.email, 200).toLowerCase(), str(b.phone, 30), hashPassword(b.password), str(b.full_name, 200), req.lang, notifyChannel(b.notify_channel));
    db.prepare(`INSERT INTO workers (user_id, full_name, nationality, iqama_number, passport_number, profession, experience_years, skills, city, date_of_birth)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(info.lastInsertRowid, str(b.full_name, 200), str(b.nationality, 100), str(b.iqama_number, 30),
      str(b.passport_number, 30), str(b.profession, 100), Math.max(0, int(b.experience_years)), str(b.skills, 1000), str(b.city, 100), str(b.date_of_birth, 10));
    saveCustomFields(info.lastInsertRowid, custom.values);
    jobAlerts.savePositions(info.lastInsertRowid, jobAlerts.positionsFromForm(str(b.profession, 100), b.positions));
    db.prepare('UPDATE workers SET job_alerts = ? WHERE user_id = ?').run(b.job_alerts === '1' ? 1 : 0, info.lastInsertRowid);
    return info.lastInsertRowid;
  });
  const id = tx();
  req.session.regenerate(() => {
    req.session.user = { id, role: 'worker', name: str(b.full_name, 200) };
    flash(req, 'success', 'Registration complete. ManpowerHub KSA will check your details and approve your account. Meanwhile, please upload your Iqama, passport, photo and CV.');
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

// Demands, agreements, publishing and applications (see src/demands.js).
require('./demands')(app, {
  db, flash, requireRole, handleUpload, checkCsrf, str, int, notifyUser, UPLOAD_DIR, getDemand, workerExtras, jobAlerts,
});

app.get('/company/profile', companyOnly, (req, res) => {
  const company = db.prepare('SELECT c.*, u.email, u.phone, u.notify_channel FROM companies c JOIN users u ON u.id=c.user_id WHERE c.user_id = ?').get(req.session.user.id);
  res.render('company/profile', { title: 'Company Profile', form: company });
});

app.post('/company/profile', companyOnly, handleUpload(['logo'], '/company/profile', logoUpload), checkCsrf, (req, res) => {
  const b = req.body;
  const newLogo = req.files?.logo?.[0]?.filename || null;
  if (!str(b.company_name) || !str(b.contact_person) || !str(b.city)) {
    removeLogo(newLogo);
    flash(req, 'error', 'Company name, contact person and city are required.');
    return res.redirect('/company/profile');
  }
  const oldLogo = db.prepare('SELECT logo_file FROM companies WHERE user_id = ?').get(req.session.user.id).logo_file;
  let logo = oldLogo;
  if (newLogo || b.remove_logo === '1') { removeLogo(oldLogo); logo = newLogo; }
  db.prepare('UPDATE companies SET company_name=?, city=?, address=?, contact_person=?, logo_file=? WHERE user_id=?')
    .run(str(b.company_name, 200), str(b.city, 100), str(b.address), str(b.contact_person, 200), logo, req.session.user.id);
  db.prepare('UPDATE users SET name=?, phone=?, notify_channel=? WHERE id=?')
    .run(str(b.company_name, 200), str(b.phone, 30), notifyChannel(b.notify_channel), req.session.user.id);
  req.session.user.name = str(b.company_name, 200);
  flash(req, 'success', 'Profile updated.');
  res.redirect('/company/profile');
});

// ---------- Worker area ----------
const workerOnly = requireRole('worker');

app.get('/worker', workerOnly, (req, res) => {
  const worker = db.prepare('SELECT * FROM workers WHERE user_id = ?').get(req.session.user.id);
  const applications = db.prepare(`
    SELECT a.*, d.title, d.worker_rate, d.worker_rate_type, d.location_city, d.status AS demand_status, d.show_company, c.company_name
    FROM applications a JOIN demands d ON d.id = a.demand_id JOIN companies c ON c.user_id = d.company_id
    WHERE a.worker_id = ? ORDER BY a.updated_at DESC`).all(req.session.user.id);
  const docTypes = db.prepare('SELECT DISTINCT doc_type FROM documents WHERE worker_id = ?').all(req.session.user.id).map((r) => r.doc_type);
  const recommended = req.workerStatus !== 'approved' ? [] : db.prepare(`
    SELECT d.*, c.company_name, c.logo_file FROM demands d JOIN companies c ON c.user_id = d.company_id
    WHERE d.status='open' AND c.status='approved' AND (d.deadline IS NULL OR d.deadline = '' OR d.deadline >= date('now'))
      AND d.id NOT IN (SELECT demand_id FROM applications WHERE worker_id = ?)
    ORDER BY (d.category IN (SELECT category FROM worker_positions WHERE worker_id = ?)) DESC, d.created_at DESC LIMIT 4`)
    .all(req.session.user.id, req.session.user.id);
  // Every message ManpowerHub KSA sent the worker, also shown here as notices (even when WhatsApp / SMS is off).
  const notices = db.prepare('SELECT body, created_at FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 15').all(req.session.user.id);
  res.render('worker/dashboard', { title: 'My Dashboard', worker, applications, docTypes, recommended, notices });
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
  const worker = db.prepare('SELECT w.*, u.email, u.phone, u.notify_channel FROM workers w JOIN users u ON u.id = w.user_id WHERE w.user_id = ?').get(req.session.user.id);
  worker.positions = jobAlerts.workerPositions(req.session.user.id);
  res.render('worker/profile', { title: 'My Profile', form: worker, fields: activeFields(), values: fieldValues(req.session.user.id) });
});

app.post('/worker/profile', workerOnly, (req, res) => {
  const b = req.body;
  if (!str(b.full_name) || !str(b.nationality) || !str(b.profession)) {
    flash(req, 'error', 'Name, nationality and profession are required.');
    return res.redirect('/worker/profile');
  }
  const custom = readCustomFields(req);
  if (custom.error) {
    flash(req, 'error', custom.error);
    return res.redirect('/worker/profile');
  }
  db.prepare(`UPDATE workers SET iqama_expiry=@iqama_expiry, passport_expiry=@passport_expiry, kafala_transfer=@kafala_transfer,
    languages=@languages, driving_license=@driving_license, expected_salary=@expected_salary, available_from=@available_from,
    work_history=@work_history, bank_name=@bank_name, iban=@iban WHERE user_id=@id`).run({ ...workerExtraColumns(b), id: req.session.user.id });
  saveCustomFields(req.session.user.id, custom.values);
  jobAlerts.savePositions(req.session.user.id, jobAlerts.positionsFromForm(str(b.profession, 100), b.positions));
  db.prepare('UPDATE workers SET job_alerts = ? WHERE user_id = ?').run(b.job_alerts === '1' ? 1 : 0, req.session.user.id);
  db.prepare(`UPDATE workers SET full_name=?, nationality=?, iqama_number=?, passport_number=?, profession=?, experience_years=?, skills=?, city=?, date_of_birth=? WHERE user_id=?`)
    .run(str(b.full_name, 200), str(b.nationality, 100), str(b.iqama_number, 30), str(b.passport_number, 30), str(b.profession, 100),
      Math.max(0, int(b.experience_years)), str(b.skills, 1000), str(b.city, 100), str(b.date_of_birth, 10), req.session.user.id);
  db.prepare('UPDATE users SET name=?, phone=?, notify_channel=? WHERE id=?')
    .run(str(b.full_name, 200), str(b.phone, 30), notifyChannel(b.notify_channel), req.session.user.id);
  req.session.user.name = str(b.full_name, 200);
  flash(req, 'success', 'Profile updated.');
  res.redirect('/worker/profile');
});

app.post('/demands/:id/apply', workerOnly, requireJobAccess, handleUpload(docFields, (req) => '/demands/' + req.params.id), checkCsrf, (req, res) => {
  const demand = getDemand(req.params.id);
  const workerId = req.session.user.id;
  const back = '/demands/' + req.params.id;
  if (!demand || demand.status !== 'open' || demand.company_status !== 'approved' || demand.review_status !== 'published' || (demand.deadline && demand.deadline < new Date().toISOString().slice(0, 10))) {
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
      // A company may see a worker's documents only after the admin assigned that worker to it.
      allowed = !!db.prepare(`SELECT 1 FROM applications a JOIN demands d ON d.id = a.demand_id
        WHERE a.worker_id = ? AND d.company_id = ? AND a.status = 'hired'`).get(doc.worker_id, u.id);
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
    pendingWorkers: db.prepare("SELECT COUNT(*) n FROM workers WHERE status='pending'").get().n,
    workers: db.prepare('SELECT COUNT(*) n FROM workers').get().n,
    demands: db.prepare("SELECT COUNT(*) n FROM demands WHERE status='open'").get().n,
    applications: db.prepare('SELECT COUNT(*) n FROM applications').get().n,
    hired: db.prepare("SELECT COUNT(*) n FROM applications WHERE status='hired'").get().n,
    timesheets: db.prepare("SELECT COUNT(*) n FROM timesheets WHERE status='submitted'").get().n,
    toReview: db.prepare("SELECT COUNT(*) n FROM demands WHERE review_status='pending'").get().n,
    problems: db.prepare("SELECT COUNT(*) n FROM timesheet_lines WHERE worker_status='disputed'").get().n,
  };
  const companies = db.prepare(`SELECT c.*, u.email, u.phone, u.created_at,
    (SELECT COUNT(*) FROM demands d WHERE d.company_id = c.user_id) AS demand_count
    FROM companies c JOIN users u ON u.id = c.user_id ORDER BY (c.status='pending') DESC, u.created_at DESC`).all();
  const workers = db.prepare(`SELECT w.*, u.email, u.phone, u.created_at,
    (SELECT COUNT(*) FROM documents x WHERE x.worker_id = w.user_id) AS doc_count,
    (SELECT COUNT(*) FROM applications a WHERE a.worker_id = w.user_id) AS app_count
    FROM workers w JOIN users u ON u.id = w.user_id ORDER BY (w.status = 'pending') DESC, u.created_at DESC LIMIT 200`).all();
  const demands = db.prepare(`SELECT d.*, c.company_name,
    (SELECT COUNT(*) FROM applications a WHERE a.demand_id = d.id AND a.status != 'withdrawn') AS applicant_count,
    (SELECT COUNT(*) FROM applications a WHERE a.demand_id = d.id AND a.status = 'hired') AS hired_count
    FROM demands d JOIN companies c ON c.user_id = d.company_id ORDER BY d.created_at DESC LIMIT 100`).all();
  const notifications = db.prepare(`SELECT n.*, u.name FROM notifications n LEFT JOIN users u ON u.id = n.user_id
    ORDER BY n.id DESC LIMIT 30`).all();
  res.render('admin/dashboard', { title: 'Admin', stats, companies, workers, demands, notifications });
});

app.post('/admin/companies/:id/status', adminOnly, (req, res) => {
  const status = ['approved', 'rejected', 'pending'].includes(req.body.status) ? req.body.status : 'pending';
  const before = db.prepare('SELECT company_name, status FROM companies WHERE user_id = ?').get(req.params.id);
  db.prepare('UPDATE companies SET status = ? WHERE user_id = ?').run(status, req.params.id);
  if (before && status === 'approved' && before.status !== 'approved') {
    notifyUser(Number(req.params.id), 'ManpowerHub KSA: Your company "{company}" has been approved. Your demands are now visible to workers.', { company: before.company_name }, '/company');
    jobAlerts.announceCompanyDemands(Number(req.params.id));
  }
  flash(req, 'success', { approved: 'Company approved.', rejected: 'Company rejected.', pending: 'Company set to pending.' }[status]);
  res.redirect('/admin');
});

// Admin approves (or rejects) a worker account. Only approved workers can see jobs and get job alerts.
app.post('/admin/workers/:id/status', adminOnly, (req, res) => {
  const worker = db.prepare('SELECT * FROM workers WHERE user_id = ?').get(req.params.id);
  if (!worker) return res.status(404).render('error', { title: 'Not found', message: 'Worker not found.' });
  const status = req.body.status === 'approved' ? 'approved' : 'rejected';
  const note = str(req.body.status_note, 500);
  db.prepare('UPDATE workers SET status = ?, status_note = ? WHERE user_id = ?').run(status, note || null, worker.user_id);
  if (status !== worker.status) {
    if (status === 'approved') {
      notifyUser(worker.user_id, 'ManpowerHub KSA: Your account has been approved. You can now see jobs and apply.', {}, '/demands');
    } else {
      notifyUser(worker.user_id, 'ManpowerHub KSA: Your registration could not be approved. {reason}', { reason: note }, '/worker');
    }
  }
  if (status === 'approved') flash(req, 'success', 'Worker approved.');
  else flash(req, 'success', 'Worker rejected.');
  res.redirect(req.body.back === 'list' ? '/admin' : '/admin/workers/' + worker.user_id);
});

app.get('/admin/workers/:id', adminOnly, (req, res) => {
  const worker = db.prepare('SELECT w.*, u.email, u.phone FROM workers w JOIN users u ON u.id = w.user_id WHERE w.user_id = ?').get(req.params.id);
  if (!worker) return res.status(404).render('error', { title: 'Not found', message: 'Worker not found.' });
  const documents = db.prepare('SELECT * FROM documents WHERE worker_id = ? ORDER BY doc_type').all(worker.user_id);
  res.render('admin/worker', { title: worker.full_name, worker, documents, extras: workerExtras(worker.user_id), positions: jobAlerts.workerPositions(worker.user_id) });
});

// Admin chooses extra information to ask workers for.
app.get('/admin/fields', adminOnly, (req, res) => {
  const fields = db.prepare(`SELECT f.*, (SELECT COUNT(*) FROM worker_field_values v WHERE v.field_id = f.id) AS answers
    FROM custom_fields f ORDER BY f.active DESC, f.sort, f.id`).all();
  res.render('admin/fields', { title: 'Worker profile fields', fields });
});

app.post('/admin/fields', adminOnly, (req, res) => {
  const label = str(req.body.label, 100);
  const type = FIELD_TYPES[req.body.field_type] ? req.body.field_type : 'text';
  const options = type === 'select' ? str(req.body.options, 1000).split(',').map((o) => o.trim()).filter(Boolean).join(', ') : '';
  if (!label) {
    flash(req, 'error', 'Field name is required.');
    return res.redirect('/admin/fields');
  }
  if (type === 'select' && !options) {
    flash(req, 'error', 'Please enter the choices, separated by commas.');
    return res.redirect('/admin/fields');
  }
  const sort = db.prepare('SELECT COALESCE(MAX(sort), 0) + 1 n FROM custom_fields').get().n;
  db.prepare('INSERT INTO custom_fields (label, field_type, options, required, sort) VALUES (?,?,?,?,?)')
    .run(label, type, options, req.body.required === '1' ? 1 : 0, sort);
  flash(req, 'success', 'Field added. Workers will see it in their profile.');
  res.redirect('/admin/fields');
});

app.post('/admin/fields/:id/toggle', adminOnly, (req, res) => {
  db.prepare('UPDATE custom_fields SET active = 1 - active WHERE id = ?').run(req.params.id);
  flash(req, 'success', 'Field updated.');
  res.redirect('/admin/fields');
});

app.post('/admin/fields/:id/delete', adminOnly, (req, res) => {
  db.prepare('DELETE FROM custom_fields WHERE id = ?').run(req.params.id);
  flash(req, 'success', 'Field deleted.');
  res.redirect('/admin/fields');
});

// ---------- Timesheets & payments ----------
require('./timesheets')(app, { db, flash, requireRole, handleUpload, checkCsrf, str, int, notifyUser, UPLOAD_DIR });

// ---------- Money management (admin) ----------
require('./money')(app, { db, flash, requireRole, str });

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
