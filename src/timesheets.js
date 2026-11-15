// Monthly timesheets and payments (supply-company model).
//
// 1. A company uploads a timesheet file (PDF / Excel / CSV) for one demand and month, and enters days
//    and hours for each worker assigned to it. The amount it owes is calculated from the company rate.
// 2. The admin checks it, sets each worker's pay (from the worker rate) and the payment method, and
//    confirms it — or sends it back for correction. The company's payment due date is set from the
//    agreed payment days.
// 3. On confirmation every worker is told (WhatsApp / SMS) their days, hours and pay, and has 48 hours
//    to check: confirm it, or write the problem. The admin replies (solved — possibly with corrected
//    numbers — or cannot be solved) and the worker gets another 48 hours. Without an answer the line
//    confirms itself when the time is up. Only worker-confirmed lines can be paid.
// 4. The admin (the supply company) sends a notice before paying (planned date) and pays the workers,
//    marks them paid — optionally with a receipt — and the worker is told again and can print a
//    payment slip. The admin also records when the company has paid.
const fs = require('fs');
const path = require('path');
const web = require('./lib/web');
const { TIMESHEET_STATUS, PAYMENT_METHODS, PAYMENT_STATUS } = require('./constants');

const CHECK_HOURS = Number(process.env.WORKER_CHECK_HOURS) || 48;
const { formatMoney } = require('./i18n');

// Worker pay for a timesheet line from the worker rate.
function defaultWorkerPay(line, rate, type) {
  if (!rate) return 0;
  if (type === 'hourly') return line.hours * rate;
  if (type === 'daily') return line.days_worked * rate;
  return Math.min(line.days_worked, 30) / 30 * rate;
}

// Last day of "YYYY-MM" plus n days, as YYYY-MM-DD.
function dueDate(month, days) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m, 0)); // last day of the month
  d.setUTCDate(d.getUTCDate() + (Number(days) || 0));
  return d.toISOString().slice(0, 10);
}

module.exports = function timesheetRoutes(app, { db, flash, requireRole, handleUpload, checkCsrf, str, int, notifyUser, UPLOAD_DIR }) {
  const TS_DIR = path.join(UPLOAD_DIR, 'timesheets');
  fs.mkdirSync(TS_DIR, { recursive: true });
  const removeFile = (file) => { if (file) fs.rm(path.join(TS_DIR, file), { force: true }, () => {}); };

  const timesheetUpload = {
    dir: TS_DIR, maxFileSize: 10 * 1024 * 1024, maxFiles: 1,
    allowedMimes: ['application/pdf', web.XLSX, web.XLS, 'text/csv'],
    typeError: '"{file}" must be a PDF, Excel (.xlsx, .xls) or CSV file.',
  };
  const proofUpload = { dir: TS_DIR, maxFileSize: 5 * 1024 * 1024, maxFiles: 1 };

  const companyOnly = requireRole('company');
  const adminOnly = requireRole('admin');
  const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
  const thisMonth = () => new Date().toISOString().slice(0, 7);
  const today = () => new Date().toISOString().slice(0, 10);

  // Hired workers who have joined work (only they can be on a timesheet).
  const hiredWorkers = (demandId) => db.prepare(`
    SELECT w.user_id, w.full_name, w.iqama_number, a.joined_at FROM applications a JOIN workers w ON w.user_id = a.worker_id
    WHERE a.demand_id = ? AND a.status = 'hired' AND a.joined_at IS NOT NULL ORDER BY w.full_name`).all(demandId);

  // Lines the worker did not answer in time are confirmed automatically.
  const sweep = db.prepare(`UPDATE timesheet_lines SET worker_status = 'confirmed', worker_confirmed_at = datetime('now'), auto_confirmed = 1
    WHERE worker_status IN ('awaiting', 'answered') AND worker_deadline IS NOT NULL AND worker_deadline <= datetime('now')`);
  const autoConfirm = () => sweep.run();
  setInterval(autoConfirm, 10 * 60 * 1000).unref();
  app.use((req, res, next) => { if (req.path.includes('timesheet') || req.path.includes('payment') || req.path.includes('money')) autoConfirm(); next(); });

  const loadTimesheet = (id) => db.prepare(`
    SELECT t.*, d.title AS demand_title, d.salary_amount, d.salary_type, d.worker_rate, d.worker_rate_type,
      d.client_payment_days, d.show_company, c.company_name, c.logo_file,
      (SELECT COALESCE(SUM(l.amount), 0) FROM timesheet_lines l WHERE l.timesheet_id = t.id) AS total_amount,
      (SELECT COALESCE(SUM(COALESCE(l.worker_amount, 0)), 0) FROM timesheet_lines l WHERE l.timesheet_id = t.id) AS total_worker,
      (SELECT COALESCE(SUM(l.hours), 0) FROM timesheet_lines l WHERE l.timesheet_id = t.id) AS total_hours
    FROM timesheets t JOIN demands d ON d.id = t.demand_id JOIN companies c ON c.user_id = t.company_id
    WHERE t.id = ?`).get(id);

  const loadLines = (timesheetId) => db.prepare(`
    SELECT l.*, COALESCE(l.worker_amount, l.amount) AS pay, w.full_name, w.iqama_number, w.bank_name, w.iban FROM timesheet_lines l JOIN workers w ON w.user_id = l.worker_id
    WHERE l.timesheet_id = ? ORDER BY w.full_name`).all(timesheetId);

  const listQuery = (where) => `
    SELECT t.*, d.title AS demand_title, c.company_name,
      (SELECT COUNT(*) FROM timesheet_lines l WHERE l.timesheet_id = t.id) AS worker_count,
      (SELECT COUNT(*) FROM timesheet_lines l WHERE l.timesheet_id = t.id AND l.payment_status = 'paid') AS paid_count,
      (SELECT COALESCE(SUM(l.amount), 0) FROM timesheet_lines l WHERE l.timesheet_id = t.id) AS total_amount,
      (SELECT COALESCE(SUM(l.hours), 0) FROM timesheet_lines l WHERE l.timesheet_id = t.id) AS total_hours,
      (SELECT COALESCE(SUM(l.worker_amount), 0) FROM timesheet_lines l WHERE l.timesheet_id = t.id) AS total_worker
    FROM timesheets t JOIN demands d ON d.id = t.demand_id JOIN companies c ON c.user_id = t.company_id
    ${where} ORDER BY CASE t.status WHEN 'submitted' THEN 0 WHEN 'rejected' THEN 1 ELSE 2 END, t.month DESC, t.id DESC`;

  const canManage = (user, ts) => ts && (user.role === 'admin' || (user.role === 'company' && ts.company_id === user.id));
  const notFound = (res, message = 'Timesheet not found.') => res.status(404).render('error', { title: 'Not found', message });

  // ---------- Company ----------
  app.get('/company/timesheets', companyOnly, (req, res) => {
    const timesheets = db.prepare(listQuery('WHERE t.company_id = ?')).all(req.session.user.id);
    const demands = db.prepare(`SELECT d.id, d.title,
      (SELECT COUNT(*) FROM applications a WHERE a.demand_id = d.id AND a.status = 'hired' AND a.joined_at IS NOT NULL) AS hired_count
      FROM demands d WHERE d.company_id = ? ORDER BY d.created_at DESC`).all(req.session.user.id).filter((d) => d.hired_count > 0);
    res.render('company/timesheets', { title: 'Timesheets', timesheets, demands });
  });

  function renderForm(req, res, demand, form, error) {
    res.status(error ? 400 : 200).render('company/timesheet-form', {
      title: 'Upload timesheet', demand, workers: hiredWorkers(demand.id), form, error,
    });
  }

  function ownDemand(req, id) {
    return db.prepare('SELECT * FROM demands WHERE id = ? AND company_id = ?').get(id, req.session.user.id);
  }

  app.get('/company/timesheets/new', companyOnly, (req, res) => {
    const demand = ownDemand(req, req.query.demand);
    if (!demand) return notFound(res, 'Demand not found.');
    const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : thisMonth();
    // Editing a timesheet that is waiting for review or was sent back: start from its values.
    const existing = db.prepare('SELECT * FROM timesheets WHERE demand_id = ? AND month = ?').get(demand.id, month);
    const form = { month, existing };
    if (existing) {
      for (const l of loadLines(existing.id)) Object.assign(form, { ['days_' + l.worker_id]: l.days_worked, ['hours_' + l.worker_id]: l.hours, ['amount_' + l.worker_id]: l.amount });
    }
    renderForm(req, res, demand, form);
  });

  app.post('/company/timesheets', companyOnly, handleUpload(['file'], (req) => '/company/timesheets', timesheetUpload), checkCsrf, (req, res) => {
    const b = req.body;
    const file = req.files?.file?.[0];
    const demand = ownDemand(req, b.demand_id);
    if (!demand) { removeFile(file?.filename); return notFound(res, 'Demand not found.'); }
    const fail = (error) => { removeFile(file?.filename); renderForm(req, res, demand, b, error); };

    const month = str(b.month, 7);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return fail('Please choose the month.');
    if (month > thisMonth()) return fail('The month cannot be in the future.');

    const lines = [];
    for (const w of hiredWorkers(demand.id)) {
      const days = int(b['days_' + w.user_id]);
      const hours = num(b['hours_' + w.user_id]);
      const amount = num(b['amount_' + w.user_id]);
      if (days < 0 || days > 31 || hours < 0 || hours > 744 || amount < 0 || amount > 1e7) {
        return fail(req.t('Please check the numbers for {name}.', { name: w.full_name }));
      }
      if (days || hours || amount) lines.push({ worker_id: w.user_id, days, hours, amount: Math.round(amount * 100) / 100 });
    }
    if (!lines.length) return fail('Enter hours or amount for at least one worker.');

    const existing = db.prepare('SELECT * FROM timesheets WHERE demand_id = ? AND month = ?').get(demand.id, month);
    if (existing && existing.status === 'confirmed') return fail('A confirmed timesheet for this month already exists.');
    if (!existing && !file) return fail('Please upload the timesheet file (PDF or Excel).');

    const save = db.transaction(() => {
      let id;
      if (existing) {
        id = existing.id;
        db.prepare(`UPDATE timesheets SET status = 'submitted', admin_note = NULL, reviewed_at = NULL,
          submitted_at = datetime('now') WHERE id = ?`).run(id);
        if (file) {
          db.prepare('UPDATE timesheets SET file_name = ?, original_name = ?, mime_type = ? WHERE id = ?').run(file.filename, file.originalname, file.mimetype, id);
          removeFile(existing.file_name);
        }
        db.prepare('DELETE FROM timesheet_lines WHERE timesheet_id = ?').run(id);
      } else {
        id = db.prepare(`INSERT INTO timesheets (company_id, demand_id, month, file_name, original_name, mime_type, payment_method)
          VALUES (?,?,?,?,?,?,'bank')`).run(req.session.user.id, demand.id, month, file.filename, file.originalname, file.mimetype).lastInsertRowid;
      }
      const insert = db.prepare('INSERT INTO timesheet_lines (timesheet_id, worker_id, days_worked, hours, amount) VALUES (?,?,?,?,?)');
      for (const l of lines) insert.run(id, l.worker_id, l.days, l.hours, l.amount);
      return id;
    });
    const id = save();
    flash(req, 'success', 'Timesheet submitted. The admin will check it and then the workers will be informed.');
    res.redirect('/company/timesheets/' + id);
  });

  app.get('/company/timesheets/:id', companyOnly, (req, res) => {
    const ts = loadTimesheet(req.params.id);
    if (!canManage(req.session.user, ts)) return notFound(res);
    res.render('timesheet', { title: 'Timesheet', ts, lines: loadLines(ts.id), back: '/company/timesheets' });
  });

  // ---------- Admin ----------
  app.get('/admin/timesheets', adminOnly, (req, res) => {
    const filter = TIMESHEET_STATUS[req.query.status] ? req.query.status : '';
    const timesheets = db.prepare(listQuery(filter ? 'WHERE t.status = ?' : '')).all(...(filter ? [filter] : []));
    res.render('admin/timesheets', { title: 'Timesheets', timesheets, filter });
  });

  app.get('/admin/timesheets/:id', adminOnly, (req, res) => {
    const ts = loadTimesheet(req.params.id);
    if (!ts) return notFound(res);
    res.render('timesheet', { title: 'Timesheet', ts, lines: loadLines(ts.id), back: '/admin/timesheets' });
  });

  app.post('/admin/timesheets/:id/review', adminOnly, (req, res) => {
    const ts = loadTimesheet(req.params.id);
    if (!ts) return notFound(res);
    const back = '/admin/timesheets/' + ts.id;
    if (ts.status !== 'submitted') { flash(req, 'error', 'This timesheet was already reviewed.'); return res.redirect(back); }
    const note = str(req.body.admin_note, 1000);
    const month = { month: ts.month };
    if (req.body.action === 'reject') {
      if (!note) { flash(req, 'error', 'Please write what needs to be corrected.'); return res.redirect(back); }
      db.prepare("UPDATE timesheets SET status = 'rejected', admin_note = ?, reviewed_at = datetime('now') WHERE id = ?").run(note, ts.id);
      notifyUser(ts.company_id, 'ManpowerHub KSA: Your timesheet for {month} ("{job}") needs correction: {reason}', { month, job: ts.demand_title, reason: note }, '/company/timesheets/' + ts.id);
      flash(req, 'success', 'Timesheet sent back to the company for correction.');
      return res.redirect(back);
    }
    const method = req.body.payment_method;
    if (!PAYMENT_METHODS[method]) { flash(req, 'error', 'Please choose the payment method.'); return res.redirect(back); }
    const lines = loadLines(ts.id);
    const pays = {};
    for (const l of lines) {
      const typed = req.body['pay_' + l.id];
      const v = typed === undefined || typed === '' ? defaultWorkerPay(l, ts.worker_rate, ts.worker_rate_type) : parseFloat(typed);
      if (!Number.isFinite(v) || v < 0 || v > 1e7) {
        flash(req, 'error', 'Please check the numbers for {name}.', { name: l.full_name });
        return res.redirect(back);
      }
      pays[l.id] = Math.round(v * 100) / 100;
    }
    db.transaction(() => {
      db.prepare(`UPDATE timesheets SET status = 'confirmed', admin_note = ?, reviewed_at = datetime('now'), payment_method = ?,
        client_due_date = ? WHERE id = ?`).run(note || null, method, dueDate(ts.month, ts.client_payment_days), ts.id);
      const setPay = db.prepare(`UPDATE timesheet_lines SET worker_amount = ?, worker_status = 'awaiting',
        worker_deadline = datetime('now', '+${CHECK_HOURS} hours') WHERE id = ?`);
      for (const l of lines) setPay.run(pays[l.id], l.id);
    })();
    const company = ts.show_company ? ts.company_name : { tr: 'a client company' };
    for (const l of lines) {
      notifyUser(l.worker_id, 'ManpowerHub KSA: Your timesheet for {month} at {company}: {days} days, {hours} hours, {amount} SAR (payment by {method}). Please check it within {h} hours: confirm it, or write the problem.', {
        month, company, days: l.days_worked, hours: l.hours, amount: formatMoney(pays[l.id]), method: { tr: PAYMENT_METHODS[method] }, h: CHECK_HOURS,
      }, '/worker/payments');
    }
    notifyUser(ts.company_id, 'ManpowerHub KSA: Your timesheet for {month} ("{job}") has been confirmed by the admin.', { month, job: ts.demand_title }, '/company/timesheets/' + ts.id);
    flash(req, 'success', 'Timesheet confirmed. The workers have been informed.');
    res.redirect(back);
  });

  // Admin answers a problem a worker reported, optionally correcting the numbers.
  app.post('/admin/timesheet-lines/:id/reply', adminOnly, (req, res) => {
    const line = loadLine(req.params.id);
    if (!line) return notFound(res);
    const back = '/admin/timesheets/' + line.timesheet_id;
    const reply = str(req.body.admin_reply, 1000);
    const result = req.body.reply_result === 'unresolvable' ? 'unresolvable' : 'resolved';
    if (!reply) { flash(req, 'error', 'Please write your answer to the worker.'); return res.redirect(back); }
    const fix = {};
    for (const [field, max] of [['days_worked', 31], ['hours', 744], ['worker_amount', 1e7], ['amount', 1e7]]) {
      const v = req.body[field];
      if (v === undefined || v === '') continue;
      const n = parseFloat(v);
      if (!Number.isFinite(n) || n < 0 || n > max) { flash(req, 'error', 'Please check the numbers for {name}.', { name: line.full_name }); return res.redirect(back); }
      fix[field] = field === 'days_worked' ? Math.round(n) : Math.round(n * 100) / 100;
    }
    db.prepare(`UPDATE timesheet_lines SET ${Object.keys(fix).map((k) => `${k} = @${k}, `).join('')}admin_reply = @reply, reply_result = @result,
      worker_status = 'answered', worker_deadline = datetime('now', '+${CHECK_HOURS} hours') WHERE id = @id`).run({ ...fix, reply, result, id: line.id });
    const updated = loadLine(line.id);
    notifyUser(line.worker_id, result === 'resolved'
      ? 'ManpowerHub KSA: Your problem with the timesheet for {month} has been solved: {reply} Now: {days} days, {hours} hours, {amount} SAR. Please confirm within {h} hours.'
      : 'ManpowerHub KSA: Your problem with the timesheet for {month} could not be solved: {reply} Please confirm within {h} hours.', {
      month: { month: line.month }, reply, days: updated.days_worked, hours: updated.hours, amount: formatMoney(updated.pay), h: CHECK_HOURS,
    }, '/worker/payments');
    flash(req, 'success', 'Answer sent to the worker.');
    res.redirect(back);
  });

  // Notice to workers before paying: "your salary will be paid on <date>".
  app.post('/admin/timesheets/:id/pay-notice', adminOnly, (req, res) => {
    const ts = loadTimesheet(req.params.id);
    if (!ts) return notFound(res);
    const date = /^\d{4}-\d{2}-\d{2}$/.test(req.body.pay_date || '') ? req.body.pay_date : null;
    if (!date) { flash(req, 'error', 'Please choose the payment date.'); return res.redirect('/admin/timesheets/' + ts.id); }
    const lines = loadLines(ts.id).filter((l) => l.worker_status === 'confirmed' && l.payment_status !== 'paid');
    const set = db.prepare('UPDATE timesheet_lines SET pay_planned_at = ? WHERE id = ?');
    for (const l of lines) {
      set.run(date, l.id);
      notifyUser(l.worker_id, 'ManpowerHub KSA: Your salary of {amount} SAR for {month} will be paid on {date} by {method}.', {
        amount: formatMoney(l.pay), month: { month: ts.month }, date, method: { tr: PAYMENT_METHODS[ts.payment_method] },
      }, '/worker/payments');
    }
    flash(req, 'success', 'Payment notice sent to {n} workers.', { n: lines.length });
    res.redirect('/admin/timesheets/' + ts.id);
  });

  // The company paid the supply company for this timesheet.
  app.post('/admin/timesheets/:id/client-paid', adminOnly, (req, res) => {
    const ts = loadTimesheet(req.params.id);
    if (!ts) return notFound(res);
    if (ts.status === 'confirmed') {
      const paidAt = /^\d{4}-\d{2}-\d{2}$/.test(req.body.paid_at || '') ? req.body.paid_at : new Date().toISOString().slice(0, 10);
      db.prepare('UPDATE timesheets SET client_paid_at = ? WHERE id = ?').run(paidAt, ts.id);
      flash(req, 'success', 'Company payment recorded.');
    }
    res.redirect('/admin/timesheets/' + ts.id);
  });

  // ---------- Payments ----------
  const loadLine = (id) => db.prepare(`
    SELECT l.*, COALESCE(l.worker_amount, l.amount) AS pay, t.company_id, t.status AS ts_status, t.month, t.payment_method,
      t.demand_id, c.company_name, d.show_company, w.full_name
    FROM timesheet_lines l JOIN timesheets t ON t.id = l.timesheet_id JOIN companies c ON c.user_id = t.company_id
    JOIN demands d ON d.id = t.demand_id JOIN workers w ON w.user_id = l.worker_id
    WHERE l.id = ?`).get(id);

  // ManpowerHub KSA pays the worker.
  app.post('/timesheet-lines/:id/paid', adminOnly, handleUpload(['proof'], '/admin/timesheets', proofUpload), checkCsrf, (req, res) => {
      const line = loadLine(req.params.id);
      const proof = req.files?.proof?.[0];
      if (!canManage(req.session.user, line)) { removeFile(proof?.filename); return notFound(res); }
      const back = '/admin/timesheets/' + line.timesheet_id;
      if (line.ts_status !== 'confirmed') {
        removeFile(proof?.filename);
        flash(req, 'error', 'The admin must confirm the timesheet before payments are recorded.');
        return res.redirect(back);
      }
      if (line.worker_status !== 'confirmed') {
        removeFile(proof?.filename);
        flash(req, 'error', 'The worker has not confirmed this timesheet yet.');
        return res.redirect(back);
      }
      const paidAt = /^\d{4}-\d{2}-\d{2}$/.test(req.body.paid_at || '') ? req.body.paid_at : new Date().toISOString().slice(0, 10);
      db.prepare("UPDATE timesheet_lines SET payment_status = 'paid', paid_at = ?, payment_ref = ? WHERE id = ?").run(paidAt, str(req.body.payment_ref, 100), line.id);
      if (proof) {
        db.prepare('UPDATE timesheet_lines SET proof_file = ?, proof_name = ?, proof_mime = ? WHERE id = ?').run(proof.filename, proof.originalname, proof.mimetype, line.id);
        removeFile(line.proof_file);
      }
      if (line.payment_status !== 'paid') {
        notifyUser(line.worker_id, 'ManpowerHub KSA: Your payment of {amount} SAR for {month} from {company} has been made by {method}. Your payment slip is ready.', {
          amount: formatMoney(line.pay), month: { month: line.month }, company: line.show_company ? line.company_name : { tr: 'a client company' },
          method: { tr: PAYMENT_METHODS[line.payment_method] },
        }, '/worker/payments');
      }
      flash(req, 'success', 'Payment recorded. The worker has been informed.');
      res.redirect(back);
    });

  // ---------- Worker ----------
  app.get('/worker/payments', requireRole('worker'), (req, res) => {
    const lines = db.prepare(`
      SELECT l.*, COALESCE(l.worker_amount, l.amount) AS pay, t.month, t.payment_method, d.title AS demand_title, d.show_company,
        c.company_name, c.logo_file
      FROM timesheet_lines l JOIN timesheets t ON t.id = l.timesheet_id JOIN demands d ON d.id = t.demand_id
      JOIN companies c ON c.user_id = t.company_id
      WHERE l.worker_id = ? AND t.status = 'confirmed' ORDER BY t.month DESC, l.id DESC`).all(req.session.user.id);
    const totals = { hours: 0, paid: 0, pending: 0, checking: 0 };
    for (const l of lines) {
      totals.hours += l.hours;
      if (l.payment_status === 'paid') totals.paid += l.pay;
      else if (l.worker_status === 'confirmed') totals.pending += l.pay;
      else totals.checking += l.pay;
    }
    res.render('worker/payments', { title: 'My payments', lines, totals, checkHours: CHECK_HOURS });
  });

  function ownLine(req, res) {
    const line = loadLine(req.params.id);
    if (!line || line.worker_id !== req.session.user.id || line.ts_status !== 'confirmed') { notFound(res); return null; }
    if (line.worker_status === 'confirmed') {
      flash(req, 'error', 'This timesheet is already confirmed.');
      res.redirect('/worker/payments');
      return null;
    }
    return line;
  }

  app.post('/worker/timesheet-lines/:id/confirm', requireRole('worker'), (req, res) => {
    const line = ownLine(req, res); if (!line) return;
    db.prepare("UPDATE timesheet_lines SET worker_status = 'confirmed', worker_confirmed_at = datetime('now') WHERE id = ?").run(line.id);
    flash(req, 'success', 'Thank you. Your timesheet is confirmed and your salary will be paid.');
    res.redirect('/worker/payments');
  });

  app.post('/worker/timesheet-lines/:id/problem', requireRole('worker'), (req, res) => {
    const line = ownLine(req, res); if (!line) return;
    const note = str(req.body.worker_note, 2000);
    if (!note) { flash(req, 'error', 'Please write the problem.'); return res.redirect('/worker/payments'); }
    db.prepare("UPDATE timesheet_lines SET worker_status = 'disputed', worker_note = ?, worker_deadline = NULL WHERE id = ?").run(note, line.id);
    flash(req, 'success', 'Your problem was sent to ManpowerHub KSA. You will get an answer.');
    res.redirect('/worker/payments');
  });

  // ---------- Files ----------
  function sendStored(res, file, name, mime) {
    res.type(mime);
    const safe = String(name).replace(/[^\w.\- ]/g, '_');
    // Only PDFs and images open in the browser; spreadsheets are always downloaded.
    const inline = mime === 'application/pdf' || mime.startsWith('image/');
    res.set('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${safe}"`);
    res.sendFile(path.join(TS_DIR, file));
  }

  app.get('/timesheets/:id/file', requireRole('company', 'admin'), (req, res) => {
    const ts = db.prepare('SELECT * FROM timesheets WHERE id = ?').get(req.params.id);
    if (!canManage(req.session.user, ts)) return notFound(res);
    sendStored(res, ts.file_name, ts.original_name, ts.mime_type);
  });

  // Worker pay is between ManpowerHub KSA and the worker: companies do not see slips or receipts.
  const canSeeLine = (user, line) => line && (user.role === 'admin' || (user.role === 'worker' && line.worker_id === user.id && line.ts_status === 'confirmed'));

  app.get('/timesheet-lines/:id/proof', requireRole('worker', 'admin'), (req, res) => {
    const line = loadLine(req.params.id);
    if (!canSeeLine(req.session.user, line) || !line.proof_file) return notFound(res, 'Document not found.');
    sendStored(res, line.proof_file, line.proof_name, line.proof_mime);
  });

  // Printable payment slip for one worker and month.
  app.get('/payslips/:id', requireRole('worker', 'admin'), (req, res) => {
    const line = loadLine(req.params.id);
    if (!canSeeLine(req.session.user, line) || line.ts_status !== 'confirmed') return notFound(res, 'Payment slip not found.');
    const ts = loadTimesheet(line.timesheet_id);
    const worker = db.prepare('SELECT w.*, u.phone FROM workers w JOIN users u ON u.id = w.user_id WHERE w.user_id = ?').get(line.worker_id);
    res.render('payslip', { title: 'Payment slip', line, ts, worker });
  });
};
