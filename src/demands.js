// Demands in the supply-company model.
//
// Company: posts a demand with its own terms (the rate it pays the supplier, how many days after month
//   end it pays, facilities it offers). It cannot see applicants or worker contact details; it only
//   sees the workers the admin assigned to it.
// Admin (the supply company): checks the demand, confirms the terms and signs the agreement with the
//   company, then publishes a job post for workers with the worker's rate and terms (salary payment
//   days, transport inside the worker's city, accommodation and food outside it, other conditions).
//   The admin handles applications and assigns (hires) workers.
const fs = require('fs');
const path = require('path');
const { CATEGORIES, DOC_TYPES, SALARY_TYPES, APP_STATUS, REVIEW_STATUS } = require('./constants');

module.exports = function demandRoutes(app, deps) {
  const { db, flash, requireRole, handleUpload, checkCsrf, str, int, notifyUser, UPLOAD_DIR, getDemand, workerExtras, jobAlerts } = deps;
  const AGREEMENT_DIR = path.join(UPLOAD_DIR, 'agreements');
  fs.mkdirSync(AGREEMENT_DIR, { recursive: true });
  const agreementUpload = {
    dir: AGREEMENT_DIR, maxFileSize: 10 * 1024 * 1024, maxFiles: 1, allowedMimes: ['application/pdf', 'image/jpeg', 'image/png'],
    typeError: '"{file}" must be a PDF, JPG or PNG file.',
  };
  const companyOnly = requireRole('company');
  const adminOnly = requireRole('admin');
  const notFound = (res, message = 'Demand not found.') => res.status(404).render('error', { title: 'Not found', message });
  const companyLabel = (d) => (d.show_company ? d.company_name : { tr: 'a client company' });

  // ---------- Company ----------
  app.get('/company', companyOnly, (req, res) => {
    const company = db.prepare('SELECT * FROM companies WHERE user_id = ?').get(req.session.user.id);
    const demands = db.prepare(`
      SELECT d.*, (SELECT COUNT(*) FROM applications a WHERE a.demand_id = d.id AND a.status = 'hired') AS hired_count
      FROM demands d WHERE d.company_id = ? ORDER BY d.created_at DESC`).all(req.session.user.id);
    res.render('company/dashboard', { title: 'Company Dashboard', company, demands });
  });

  function demandFromBody(b) {
    const docs = [].concat(b.required_docs || []).filter((d) => DOC_TYPES[d]);
    const d = {
      title: str(b.title, 150), category: str(b.category, 100), quantity: int(b.quantity),
      salary_amount: parseFloat(b.salary_amount), salary_type: str(b.salary_type, 10),
      client_payment_days: int(b.client_payment_days, -1),
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
    else if (d.client_payment_days < 0 || d.client_payment_days > 365) error = 'Please enter in how many days you will pay (0–365).';
    else if (d.hours_per_day < 1 || d.hours_per_day > 24) error = 'Working hours per day must be between 1 and 24.';
    else if (d.days_per_week < 1 || d.days_per_week > 7) error = 'Working days per week must be between 1 and 7.';
    else if (!d.duration) error = 'Contract duration is required.';
    else if (!d.location_city) error = 'Work location is required.';
    return { d, error };
  }

  const FIELDS = ['title', 'category', 'quantity', 'salary_amount', 'salary_type', 'client_payment_days', 'hours_per_day', 'days_per_week',
    'duration', 'location_city', 'work_site', 'food', 'accommodation', 'transport', 'overtime', 'requirements', 'required_docs', 'start_date', 'deadline'];

  app.get('/company/demands/new', companyOnly, (req, res) => {
    res.render('company/demand-form', {
      title: 'Post a Demand', action: '/company/demands',
      form: { required_docs: 'iqama,passport,photo', days_per_week: 6, hours_per_day: 8, salary_type: 'hourly', client_payment_days: 30 },
    });
  });

  app.post('/company/demands', companyOnly, (req, res) => {
    const { d, error } = demandFromBody(req.body);
    if (error) return res.status(400).render('company/demand-form', { title: 'Post a Demand', form: { ...req.body, required_docs: d.required_docs }, error, action: '/company/demands' });
    const info = db.prepare(`INSERT INTO demands (company_id, ${FIELDS.join(', ')}) VALUES (@company_id, ${FIELDS.map((f) => '@' + f).join(', ')})`)
      .run({ ...d, company_id: req.session.user.id });
    flash(req, 'success', 'Demand sent. The admin will confirm the terms and the agreement with you, then publish the job for workers.');
    res.redirect('/company/demands/' + info.lastInsertRowid);
  });

  function ownDemand(req, res) {
    const demand = getDemand(req.params.id);
    if (!demand || demand.company_id !== req.session.user.id) { notFound(res); return null; }
    return demand;
  }

  app.get('/company/demands/:id/edit', companyOnly, (req, res) => {
    const demand = ownDemand(req, res); if (!demand) return;
    if (demand.review_status === 'published') {
      flash(req, 'error', 'This demand is already published. Please contact the admin to change it.');
      return res.redirect('/company/demands/' + demand.id);
    }
    res.render('company/demand-form', { title: 'Edit Demand', form: demand, action: `/company/demands/${demand.id}/edit` });
  });

  app.post('/company/demands/:id/edit', companyOnly, (req, res) => {
    const demand = ownDemand(req, res); if (!demand) return;
    if (demand.review_status === 'published') {
      flash(req, 'error', 'This demand is already published. Please contact the admin to change it.');
      return res.redirect('/company/demands/' + demand.id);
    }
    const { d, error } = demandFromBody(req.body);
    if (error) return res.status(400).render('company/demand-form', { title: 'Edit Demand', form: { ...req.body, required_docs: d.required_docs }, error, action: `/company/demands/${demand.id}/edit` });
    db.prepare(`UPDATE demands SET ${FIELDS.map((f) => `${f} = @${f}`).join(', ')}, review_status = 'pending' WHERE id = @id`).run({ ...d, id: demand.id });
    flash(req, 'success', 'Demand updated and sent to the admin again.');
    res.redirect('/company/demands/' + demand.id);
  });

  app.post('/company/demands/:id/status', companyOnly, (req, res) => {
    const demand = ownDemand(req, res); if (!demand) return;
    const status = req.body.status === 'closed' ? 'closed' : 'open';
    db.prepare('UPDATE demands SET status = ? WHERE id = ?').run(status, demand.id);
    flash(req, 'success', status === 'closed' ? 'Demand closed. Workers can no longer apply.' : 'Demand re-opened.');
    res.redirect('/company/demands/' + demand.id);
  });

  const assignedWorkers = (demandId) => db.prepare(`
    SELECT a.id AS application_id, a.updated_at, a.joined_at, w.user_id, w.full_name, w.nationality, w.profession, w.experience_years, w.iqama_number
    FROM applications a JOIN workers w ON w.user_id = a.worker_id
    WHERE a.demand_id = ? AND a.status = 'hired' ORDER BY w.full_name`).all(demandId);

  app.get('/company/demands/:id', companyOnly, (req, res) => {
    const demand = ownDemand(req, res); if (!demand) return;
    res.render('company/demand', { title: demand.title, demand, workers: assignedWorkers(demand.id) });
  });

  // A worker the admin assigned to the company: no phone or e-mail, so the company works through the supplier.
  app.get('/company/assigned/:id', companyOnly, (req, res) => {
    const a = db.prepare(`SELECT a.*, d.company_id, d.title AS demand_title, d.required_docs, d.id AS demand_id
      FROM applications a JOIN demands d ON d.id = a.demand_id WHERE a.id = ? AND a.status = 'hired'`).get(req.params.id);
    if (!a || a.company_id !== req.session.user.id) return notFound(res, 'Worker not found.');
    const worker = db.prepare('SELECT * FROM workers WHERE user_id = ?').get(a.worker_id);
    const documents = db.prepare('SELECT * FROM documents WHERE worker_id = ? ORDER BY doc_type, uploaded_at DESC').all(a.worker_id);
    res.render('application', {
      title: worker.full_name, a, worker, documents, extras: workerExtras(a.worker_id), positions: jobAlerts.workerPositions(a.worker_id),
      showContact: false, back: '/company/demands/' + a.demand_id,
    });
  });

  // ---------- Agreement file ----------
  app.get('/agreements/:id', requireRole('company', 'admin'), (req, res) => {
    const d = db.prepare('SELECT id, company_id, agreement_file, agreement_name FROM demands WHERE id = ?').get(req.params.id);
    const u = req.session.user;
    if (!d || !d.agreement_file || (u.role === 'company' && d.company_id !== u.id)) return notFound(res, 'Document not found.');
    const mime = d.agreement_file.endsWith('.pdf') ? 'application/pdf' : d.agreement_file.endsWith('.png') ? 'image/png' : 'image/jpeg';
    res.type(mime);
    res.set('Content-Disposition', `inline; filename="${String(d.agreement_name).replace(/[^\w.\- ]/g, '_')}"`);
    res.sendFile(path.join(AGREEMENT_DIR, d.agreement_file));
  });

  // ---------- Admin: review, agreement, publish ----------
  app.get('/admin/demands', adminOnly, (req, res) => {
    const filter = REVIEW_STATUS[req.query.review] ? req.query.review : '';
    const demands = db.prepare(`SELECT d.*, c.company_name, c.status AS company_status,
      (SELECT COUNT(*) FROM applications a WHERE a.demand_id = d.id AND a.status = 'applied') AS new_count,
      (SELECT COUNT(*) FROM applications a WHERE a.demand_id = d.id AND a.status != 'withdrawn') AS applicant_count,
      (SELECT COUNT(*) FROM applications a WHERE a.demand_id = d.id AND a.status = 'hired') AS hired_count
      FROM demands d JOIN companies c ON c.user_id = d.company_id ${filter ? 'WHERE d.review_status = ?' : ''}
      ORDER BY CASE d.review_status WHEN 'pending' THEN 0 WHEN 'rejected' THEN 2 ELSE 1 END, d.created_at DESC`).all(...(filter ? [filter] : []));
    res.render('admin/demands', { title: 'Demands', demands, filter });
  });

  app.get('/admin/demands/:id', adminOnly, (req, res) => {
    const demand = getDemand(req.params.id);
    if (!demand) return notFound(res);
    const filter = APP_STATUS[req.query.status] ? req.query.status : '';
    const applications = db.prepare(`
      SELECT a.*, w.full_name, w.nationality, w.profession, w.experience_years, w.city, u.phone, u.email
      FROM applications a JOIN workers w ON w.user_id = a.worker_id JOIN users u ON u.id = w.user_id
      WHERE a.demand_id = ? ${filter ? 'AND a.status = ?' : "AND a.status != 'withdrawn'"}
      ORDER BY CASE a.status WHEN 'hired' THEN 0 WHEN 'shortlisted' THEN 1 WHEN 'applied' THEN 2 ELSE 3 END, a.created_at`)
      .all(...(filter ? [demand.id, filter] : [demand.id]));
    const counts = Object.fromEntries(db.prepare('SELECT status, COUNT(*) n FROM applications WHERE demand_id = ? GROUP BY status').all(demand.id).map((r) => [r.status, r.n]));
    const form = {
      ...demand,
      worker_rate: demand.worker_rate ?? '',
      worker_rate_type: demand.worker_rate_type || demand.salary_type,
    };
    res.render('admin/demand', { title: demand.title, demand, form, applications, counts, filter });
  });

  app.post('/admin/demands/:id/publish', adminOnly, handleUpload(['agreement'], (req) => '/admin/demands/' + req.params.id, agreementUpload), checkCsrf, (req, res) => {
    const demand = getDemand(req.params.id);
    const file = req.files?.agreement?.[0];
    const removeUpload = () => { if (file) fs.rm(path.join(AGREEMENT_DIR, file.filename), { force: true }, () => {}); };
    if (!demand) { removeUpload(); return notFound(res); }
    const b = req.body;
    const back = '/admin/demands/' + demand.id;
    const v = {
      salary_amount: parseFloat(b.salary_amount), salary_type: str(b.salary_type, 10), client_payment_days: int(b.client_payment_days, -1),
      food: str(b.food, 10) || 'no', accommodation: str(b.accommodation, 10) || 'no', transport: str(b.transport, 10) || 'no',
      worker_rate: parseFloat(b.worker_rate), worker_rate_type: str(b.worker_rate_type, 10), worker_pay_days: int(b.worker_pay_days, -1),
      local_transport: b.local_transport === '1' ? 1 : 0, outside_accommodation: b.outside_accommodation === '1' ? 1 : 0,
      outside_food: b.outside_food === '1' ? 1 : 0, worker_terms: str(b.worker_terms, 3000), show_company: b.show_company === '1' ? 1 : 0,
      agreement_signed: b.agreement_signed === '1' ? 1 : 0, admin_note: str(b.admin_note, 1000),
    };
    let error = null;
    if (!Number.isFinite(v.salary_amount) || v.salary_amount < 0 || !SALARY_TYPES[v.salary_type]) error = 'Please enter the rate agreed with the company.';
    else if (v.client_payment_days < 0 || v.client_payment_days > 365) error = 'Please enter in how many days the company pays (0–365).';
    else if (!Number.isFinite(v.worker_rate) || v.worker_rate < 0 || !SALARY_TYPES[v.worker_rate_type]) error = 'Please enter the worker rate.';
    else if (v.worker_pay_days < 0 || v.worker_pay_days > 90) error = 'Please enter in how many days workers are paid (0–90).';
    else if (!v.agreement_signed) error = 'The job can only be published after the agreement with the company is signed.';
    else if (demand.company_status !== 'approved') error = 'Approve the company before publishing its demand.';
    if (error) { removeUpload(); flash(req, 'error', error); return res.redirect(back); }

    db.prepare(`UPDATE demands SET ${Object.keys(v).map((k) => `${k} = @${k}`).join(', ')}, review_status = 'published',
      published_at = COALESCE(published_at, datetime('now')) WHERE id = @id`).run({ ...v, id: demand.id });
    if (file) {
      db.prepare('UPDATE demands SET agreement_file = ?, agreement_name = ? WHERE id = ?').run(file.filename, file.originalname, demand.id);
      if (demand.agreement_file) fs.rm(path.join(AGREEMENT_DIR, demand.agreement_file), { force: true }, () => {});
    }
    if (demand.review_status !== 'published') {
      notifyUser(demand.company_id, 'ManpowerHub KSA: Your demand "{job}" is confirmed and published. We will assign workers to you.', { job: demand.title }, '/company/demands/' + demand.id);
      const told = jobAlerts.announceDemand(demand.id);
      flash(req, 'success', 'Job published. {n} workers with this position were sent a message.', { n: told });
    } else {
      flash(req, 'success', 'Job post updated.');
    }
    res.redirect(back);
  });

  app.post('/admin/demands/:id/reject', adminOnly, (req, res) => {
    const demand = getDemand(req.params.id);
    if (!demand) return notFound(res);
    const note = str(req.body.admin_note, 1000);
    if (!note) { flash(req, 'error', 'Please write what needs to be corrected.'); return res.redirect('/admin/demands/' + demand.id); }
    db.prepare("UPDATE demands SET review_status = 'rejected', admin_note = ? WHERE id = ?").run(note, demand.id);
    notifyUser(demand.company_id, 'ManpowerHub KSA: Your demand "{job}" needs changes before it can be published: {reason}', { job: demand.title, reason: note }, '/company/demands/' + demand.id);
    flash(req, 'success', 'Demand sent back to the company.');
    res.redirect('/admin/demands/' + demand.id);
  });

  // ---------- Admin: applications ----------
  function loadApplication(id) {
    return db.prepare(`SELECT a.*, d.company_id, d.title AS demand_title, d.required_docs, d.quantity, d.id AS demand_id,
      d.show_company, c.company_name FROM applications a JOIN demands d ON d.id = a.demand_id
      JOIN companies c ON c.user_id = d.company_id WHERE a.id = ?`).get(id);
  }

  app.get('/admin/applications/:id', adminOnly, (req, res) => {
    const a = loadApplication(req.params.id);
    if (!a) return notFound(res, 'Application not found.');
    const worker = db.prepare('SELECT w.*, u.email, u.phone FROM workers w JOIN users u ON u.id = w.user_id WHERE w.user_id = ?').get(a.worker_id);
    const documents = db.prepare('SELECT * FROM documents WHERE worker_id = ? ORDER BY doc_type, uploaded_at DESC').all(a.worker_id);
    res.render('application', {
      title: worker.full_name, a, worker, documents, extras: workerExtras(a.worker_id), positions: jobAlerts.workerPositions(a.worker_id),
      showContact: true, canDecide: true, back: '/admin/demands/' + a.demand_id,
    });
  });

  // The hired worker started work: from now on the worker can be put on timesheets.
  app.post('/admin/applications/:id/joined', adminOnly, (req, res) => {
    const a = loadApplication(req.params.id);
    if (!a) return notFound(res, 'Application not found.');
    const date = /^\d{4}-\d{2}-\d{2}$/.test(req.body.joined_at || '') ? req.body.joined_at : null;
    if (a.status !== 'hired' || !date) {
      flash(req, 'error', 'Please choose the date the worker joined.');
      return res.redirect('/admin/applications/' + a.id);
    }
    db.prepare('UPDATE applications SET joined_at = ? WHERE id = ?').run(date, a.id);
    const name = db.prepare('SELECT full_name FROM workers WHERE user_id = ?').get(a.worker_id).full_name;
    notifyUser(a.company_id, 'ManpowerHub KSA: {name} joined work for "{job}" on {date}.', { name, job: a.demand_title, date }, '/company/demands/' + a.demand_id);
    flash(req, 'success', 'Joining date saved.');
    res.redirect('/admin/applications/' + a.id);
  });

  app.post('/admin/applications/:id/status', adminOnly, (req, res) => {
    const a = loadApplication(req.params.id);
    if (!a) return notFound(res, 'Application not found.');
    const status = str(req.body.status, 20);
    if (!['applied', 'shortlisted', 'hired', 'rejected'].includes(status) || a.status === 'withdrawn') {
      flash(req, 'error', 'Invalid status change.');
      return res.redirect('/admin/applications/' + a.id);
    }
    if (status === 'hired' && a.status !== 'hired') {
      const hired = db.prepare("SELECT COUNT(*) n FROM applications WHERE demand_id = ? AND status = 'hired'").get(a.demand_id).n;
      if (hired >= a.quantity) {
        flash(req, 'error', 'You already hired {hired} of {quantity} workers. Increase the quantity in the demand to hire more.', { hired, quantity: a.quantity });
        return res.redirect('/admin/applications/' + a.id);
      }
    }
    const note = str(req.body.company_note, 1000);
    db.prepare("UPDATE applications SET status = ?, company_note = ?, updated_at = datetime('now') WHERE id = ?").run(status, note, a.id);
    if (status !== a.status) {
      const message = {
        shortlisted: 'ManpowerHub KSA: You have been shortlisted for "{job}" at {company}.',
        hired: 'ManpowerHub KSA: Congratulations! {company} has hired you for "{job}".',
        rejected: 'ManpowerHub KSA: Your application for "{job}" at {company} was not selected this time.',
      }[status];
      if (message) notifyUser(a.worker_id, message, { job: a.demand_title, company: companyLabel(a), note: status === 'rejected' ? '' : note }, '/worker');
      if (status === 'hired') {
        const name = db.prepare('SELECT full_name FROM workers WHERE user_id = ?').get(a.worker_id).full_name;
        notifyUser(a.company_id, 'ManpowerHub KSA: {name} has been assigned to your demand "{job}".', { name, job: a.demand_title }, '/company/demands/' + a.demand_id);
      }
    }
    flash(req, 'success', 'Applicant marked as {status}.', { status: req.t(APP_STATUS[status]) });
    res.redirect(req.body.back === 'list' ? '/admin/demands/' + a.demand_id : '/admin/applications/' + a.id);
  });
};
