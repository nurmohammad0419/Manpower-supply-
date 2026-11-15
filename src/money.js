// Money management for the supply company (admin).
//
// Everything comes from timesheets the admin confirmed:
//   billed      = what companies owe (company rate × hours/days)     received  = company payments recorded
//   worker pay  = what workers earn (worker rate × hours/days)       paid      = worker payments made
// plus the supply company's own expenses (kafala/Iqama fees, visas, accommodation, staff, ...).
//   profit (on work done) = billed − worker pay − expenses
//   cash profit           = received − paid to workers − expenses
const { EXPENSE_CATEGORIES } = require('./constants');

module.exports = function moneyRoutes(app, { db, flash, requireRole, str }) {
  const adminOnly = requireRole('admin');
  const round = (n) => Math.round((n || 0) * 100) / 100;

  // One row per worker per confirmed timesheet.
  const LINES = `
    SELECT l.id, l.worker_id, l.amount AS billed, COALESCE(l.worker_amount, l.amount) AS pay, l.payment_status, l.paid_at,
      l.worker_status, l.pay_planned_at, t.id AS timesheet_id, t.month, t.company_id, t.client_paid_at, t.client_due_date,
      c.company_name, w.full_name, d.title AS demand_title
    FROM timesheet_lines l JOIN timesheets t ON t.id = l.timesheet_id JOIN companies c ON c.user_id = t.company_id
    JOIN workers w ON w.user_id = l.worker_id JOIN demands d ON d.id = t.demand_id
    WHERE t.status = 'confirmed'`;

  function summarize() {
    const lines = db.prepare(LINES + ' ORDER BY t.month DESC, c.company_name, w.full_name').all();
    const expenses = db.prepare(`SELECT e.*, c.company_name, w.full_name FROM expenses e
      LEFT JOIN companies c ON c.user_id = e.company_id LEFT JOIN workers w ON w.user_id = e.worker_id
      ORDER BY e.spent_on DESC, e.id DESC`).all();
    const todayStr = new Date().toISOString().slice(0, 10);

    const total = { billed: 0, received: 0, overdue: 0, pay: 0, paid: 0, checking: 0, expenses: 0 };
    const companies = new Map();
    const workers = new Map();
    const months = new Map();
    const month = (m) => {
      if (!months.has(m)) months.set(m, { month: m, billed: 0, pay: 0, expenses: 0 });
      return months.get(m);
    };

    for (const l of lines) {
      const received = l.client_paid_at ? l.billed : 0;
      const overdue = !l.client_paid_at && l.client_due_date && l.client_due_date < todayStr ? l.billed : 0;
      const paid = l.payment_status === 'paid' ? l.pay : 0;
      total.billed += l.billed; total.received += received; total.overdue += overdue;
      total.pay += l.pay; total.paid += paid;
      if (l.worker_status !== 'confirmed') total.checking += l.pay;

      if (!companies.has(l.company_id)) companies.set(l.company_id, { company_id: l.company_id, name: l.company_name, billed: 0, received: 0, overdue: 0, pay: 0, unpaidWorkers: 0 });
      const c = companies.get(l.company_id);
      c.billed += l.billed; c.received += received; c.overdue += overdue; c.pay += l.pay;
      if (l.payment_status !== 'paid') c.unpaidWorkers += l.pay;

      if (!workers.has(l.worker_id)) workers.set(l.worker_id, { worker_id: l.worker_id, name: l.full_name, earned: 0, paid: 0, companies: new Set() });
      const w = workers.get(l.worker_id);
      w.earned += l.pay; w.paid += paid;
      if (l.payment_status !== 'paid') w.companies.add(l.company_name);

      const m = month(l.month);
      m.billed += l.billed; m.pay += l.pay;
    }
    for (const e of expenses) {
      total.expenses += e.amount;
      month(e.spent_on.slice(0, 7)).expenses += e.amount;
    }

    total.outstanding = total.billed - total.received;
    total.unpaid = total.pay - total.paid;
    total.margin = total.billed - total.pay;
    total.profit = total.billed - total.pay - total.expenses;
    total.cashProfit = total.received - total.paid - total.expenses;
    for (const k of Object.keys(total)) total[k] = round(total[k]);

    return {
      total,
      companies: [...companies.values()].map((c) => ({ ...c, outstanding: round(c.billed - c.received), margin: round(c.billed - c.pay) }))
        .sort((a, b) => b.billed - a.billed),
      workers: [...workers.values()].map((w) => ({ ...w, pending: round(w.earned - w.paid), companies: [...w.companies].join(', ') }))
        .sort((a, b) => b.pending - a.pending),
      unpaidLines: lines.filter((l) => l.payment_status !== 'paid'),
      months: [...months.values()].map((m) => ({ ...m, profit: round(m.billed - m.pay - m.expenses) })).sort((a, b) => (a.month < b.month ? 1 : -1)),
      expenses,
    };
  }

  app.get('/admin/money', adminOnly, (req, res) => {
    const data = summarize();
    const companies = db.prepare('SELECT user_id, company_name FROM companies ORDER BY company_name').all();
    const workerList = db.prepare("SELECT user_id, full_name FROM workers WHERE status = 'approved' ORDER BY full_name").all();
    res.render('admin/money', { title: 'Money', ...data, companyList: companies, workerList, tab: ['companies', 'workers', 'expenses', 'months'].includes(req.query.tab) ? req.query.tab : 'companies' });
  });

  app.post('/admin/expenses', adminOnly, (req, res) => {
    const b = req.body;
    const amount = parseFloat(b.amount);
    const date = /^\d{4}-\d{2}-\d{2}$/.test(b.spent_on || '') ? b.spent_on : null;
    if (!date || !EXPENSE_CATEGORIES[b.category] || !Number.isFinite(amount) || amount <= 0 || amount > 1e8) {
      flash(req, 'error', 'Please enter the date, type and amount of the expense.');
      return res.redirect('/admin/money?tab=expenses');
    }
    const companyId = db.prepare('SELECT user_id FROM companies WHERE user_id = ?').get(String(b.company_id || ''))?.user_id ?? null;
    const workerId = db.prepare('SELECT user_id FROM workers WHERE user_id = ?').get(String(b.worker_id || ''))?.user_id ?? null;
    db.prepare('INSERT INTO expenses (spent_on, category, amount, note, company_id, worker_id) VALUES (?,?,?,?,?,?)')
      .run(date, b.category, round(amount), str(b.note, 500), companyId, workerId);
    flash(req, 'success', 'Expense added.');
    res.redirect('/admin/money?tab=expenses');
  });

  app.post('/admin/expenses/:id/delete', adminOnly, (req, res) => {
    db.prepare('DELETE FROM expenses WHERE id = ?').run(req.params.id);
    flash(req, 'success', 'Expense deleted.');
    res.redirect('/admin/money?tab=expenses');
  });

  return { summarize };
};
