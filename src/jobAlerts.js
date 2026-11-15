// Worker positions and new-job alerts.
//
// A worker can work in several positions (their main profession plus others). When a company posts a
// demand, every worker with a matching position who wants job alerts gets a WhatsApp / SMS message.
// A demand is announced once, when the admin publishes it (or, if it was published while the company
// was not approved, when the company is approved). Workers see the worker rate, not the company's rate.
const db = require('./db');
const { CATEGORIES, SALARY_TYPES } = require('./constants');
const { notifyUser } = require('./notify');

function workerPositions(workerId) {
  return db.prepare('SELECT category FROM worker_positions WHERE worker_id = ? ORDER BY rowid').all(workerId).map((r) => r.category);
}

// Positions from a form: the main profession plus the ticked "positions" boxes.
function positionsFromForm(main, others) {
  return [...new Set([main, ...[].concat(others || [])].filter((c) => CATEGORIES.includes(c)))];
}

function savePositions(workerId, positions) {
  db.prepare('DELETE FROM worker_positions WHERE worker_id = ?').run(workerId);
  const insert = db.prepare('INSERT OR IGNORE INTO worker_positions (worker_id, category) VALUES (?,?)');
  for (const p of positions) insert.run(workerId, p);
}

// Tell matching workers about a demand. Returns how many workers will get a message.
function announceDemand(demandId) {
  const d = db.prepare(`SELECT d.*, c.company_name, c.status AS company_status FROM demands d
    JOIN companies c ON c.user_id = d.company_id WHERE d.id = ?`).get(demandId);
  if (!d || d.status !== 'open' || d.company_status !== 'approved' || d.review_status !== 'published' || d.announced_at) return 0;
  if (d.deadline && d.deadline < new Date().toISOString().slice(0, 10)) return 0;
  // Mark first, so the same demand is never announced twice.
  if (!db.prepare("UPDATE demands SET announced_at = datetime('now') WHERE id = ? AND announced_at IS NULL").run(d.id).changes) return 0;

  const workers = db.prepare(`
    SELECT DISTINCT p.worker_id FROM worker_positions p
    JOIN workers w ON w.user_id = p.worker_id JOIN users u ON u.id = w.user_id
    WHERE p.category = ? AND w.status = 'approved' AND w.job_alerts = 1 AND u.notify_channel != 'none'
      AND p.worker_id NOT IN (SELECT worker_id FROM applications WHERE demand_id = ?)`).all(d.category, d.id);

  const params = {
    position: { tr: d.category }, job: d.title, company: d.show_company ? d.company_name : { tr: 'a client company' },
    city: { tr: d.location_city }, rate: d.worker_rate, per: { tr: SALARY_TYPES[d.worker_rate_type] },
  };
  // Send one after another in the background so a large list does not flood the provider.
  (async () => {
    for (const w of workers) {
      await notifyUser(w.worker_id, 'ManpowerHub KSA: New job for {position} — "{job}" at {company}, {city}. Pay: {rate} SAR {per}.', params, `/demands/${d.id}`);
    }
  })();
  return workers.length;
}

function announceCompanyDemands(companyId) {
  const ids = db.prepare("SELECT id FROM demands WHERE company_id = ? AND status = 'open' AND announced_at IS NULL").all(companyId);
  return ids.reduce((n, r) => n + announceDemand(r.id), 0);
}

module.exports = { workerPositions, positionsFromForm, savePositions, announceDemand, announceCompanyDemands };
