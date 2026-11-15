// Workers choose several positions; matching workers get a message when a new demand is posted.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { startApp } = require('./support/harness');

const ctx = startApp({ WHATSAPP_PROVIDER: 'meta', WHATSAPP_TOKEN: 't', WHATSAPP_PHONE_NUMBER_ID: '1', BASE_URL: 'https://jobs.example.com' });
const { Client } = ctx;
const notify = require('../src/notify');
const db = require('../src/db');

const sent = [];
notify._setFetch(async (url, opts) => { sent.push(JSON.parse(opts.body)); return new Response('{}'); });
const settle = () => new Promise((r) => setTimeout(r, 100));
const recipients = () => sent.map((m) => m.to).sort();

before(ctx.start);
after(ctx.stop);

const admin = new Client();
const company = new Client();
const workers = {};
let companyId;

async function registerWorker(key, { profession, positions = [], alerts = true, channel = 'whatsapp', phone, lang }) {
  const c = new Client();
  if (lang) await c.get(`/lang?code=${lang}&next=/`);
  const r = await c.post('/register/worker', {
    full_name: key, nationality: 'Bangladesh', profession, phone, email: `${key}@test.local`,
    password: 'secret12', password_confirm: 'secret12', notify_channel: channel, positions, ...(alerts ? { job_alerts: '1' } : {}),
  }, '/register/worker');
  assert.strictEqual(r.location, '/worker/documents', `register ${key}`);
  workers[key] = c;
  return c;
}

// Company posts a demand; the admin publishes it (unless publish is false).
async function postDemand(category, title, { publish = true, ...overrides } = {}) {
  const r = await company.post('/company/demands', {
    title, category, quantity: '3', salary_amount: '1800', salary_type: 'monthly', client_payment_days: '30', hours_per_day: '8', days_per_week: '6',
    duration: '1 year', location_city: 'Riyadh', required_docs: '',
  }, '/company');
  const id = r.location.split('/').pop();
  if (!publish) return { id };
  const p = await ctx.publish(admin, id, { worker_rate: '1500', worker_rate_type: 'monthly', ...overrides });
  return { id, page: await admin.get(p.location) };
}

test('workers register with several positions', async () => {
  await registerWorker('anis', { profession: 'Mason', positions: ['Electrician', 'Painter', 'Not a real job'], phone: '0550000001', lang: 'bn' });
  await registerWorker('badal', { profession: 'Electrician', alerts: false, phone: '0550000002' });
  await registerWorker('chandan', { profession: 'Plumber', phone: '0550000003' });
  await registerWorker('dipu', { profession: 'Electrician', channel: 'none', phone: '0550000004' });
  await registerWorker('emon', { profession: 'Cook', positions: ['Electrician'], channel: 'sms', phone: '0550000005' });

  db.prepare("UPDATE workers SET status = 'approved'").run();
  // Registered but not approved by the admin: never gets job alerts.
  await registerWorker('farid', { profession: 'Painter', phone: '0550000006' });
  const profile = await workers.anis.get('/worker/profile');
  for (const p of ['Electrician', 'Painter']) assert.match(profile.text, new RegExp(`value="${p}" checked`));
  assert.doesNotMatch(profile.text, /value="Plumber" checked/);
  assert.doesNotMatch((await workers.badal.get('/worker/profile')).text, /name="job_alerts" value="1" checked/);
});

test('workers are alerted when the admin publishes, not when the company posts', async () => {
  await company.post('/register/company', { company_name: 'Najd Power', cr_number: '7', contact_person: 'F', city: 'Riyadh', phone: '0509999999', email: 'najd@test.local', password: 'secret12', password_confirm: 'secret12', notify_channel: 'none' });
  await admin.post('/login', { email: 'admin@test.local', password: 'adminpass' });
  const { id } = await postDemand('Electrician', 'Site electrician', { publish: false });
  // The company is not approved yet: the admin cannot publish.
  let r = await ctx.publish(admin, id, { worker_rate: '1500', worker_rate_type: 'monthly', show_company: '1' });
  assert.match((await admin.get(r.location)).text, /Approve the company before publishing its demand/);
  await settle();
  assert.strictEqual(sent.length, 0);

  companyId = /\/admin\/companies\/(\d+)\/status/.exec((await admin.get('/admin')).text)[1];
  await admin.post(`/admin/companies/${companyId}/status`, { status: 'approved' }, '/admin');
  await settle();
  assert.strictEqual(sent.length, 0, 'approval alone does not publish');
  r = await ctx.publish(admin, id, { worker_rate: '1500', worker_rate_type: 'monthly', show_company: '1' });
  // anis (WhatsApp) and emon (SMS — no SMS provider here, so it is logged as not sent).
  assert.match((await admin.get(r.location)).text, /Job published\. 2 workers with this position were sent a message/);
  await settle();
  // anis (extra position) — yes; badal (alerts off), dipu (no messages), chandan (plumber) — no; emon uses SMS (no SMS provider here).
  assert.deepStrictEqual(recipients(), ['966550000001']);
  const text = sent[0].text.body;
  assert.match(text, /ইলেকট্রিশিয়ান পদে নতুন কাজ/);
  assert.match(text, /Najd Power-এর "Site electrician", রিয়াদ/);
  assert.match(text, /1500 রিয়াল প্রতি মাস/, 'workers see the worker rate');
  assert.doesNotMatch(text, /1800/);
  assert.match(text, /https:\/\/jobs\.example\.com\/demands\/\d+/);

  // Saving the job post again, or re-approving the company, does not announce it twice.
  await ctx.publish(admin, id, { worker_rate: '1550', worker_rate_type: 'monthly', show_company: '1' });
  await admin.post(`/admin/companies/${companyId}/status`, { status: 'rejected' }, '/admin');
  await admin.post(`/admin/companies/${companyId}/status`, { status: 'approved' }, '/admin');
  await settle();
  assert.strictEqual(sent.length, 1);
});

test('each published demand alerts matching workers; the company name stays hidden unless shown', async () => {
  sent.length = 0;
  let { page } = await postDemand('Painter', 'Villa painter');
  assert.match(page.text, /Job published\. 1 workers with this position were sent a message/);
  await settle();
  assert.deepStrictEqual(recipients(), ['966550000001']);
  assert.match(sent[0].text.body, /একটি ক্লায়েন্ট কোম্পানি/);
  assert.doesNotMatch(sent[0].text.body, /Najd Power/);

  sent.length = 0;
  ({ page } = await postDemand('Plumber', 'Plumber for towers'));
  await settle();
  assert.deepStrictEqual(recipients(), ['966550000003']);

  sent.length = 0;
  await postDemand('Welder', 'Welder');
  await settle();
  assert.strictEqual(sent.length, 0, 'no worker has this position');
});

test('worker changes positions and job alerts in the profile', async () => {
  const csrf = await workers.anis.csrf('/worker/profile');
  await workers.anis.req('POST', '/worker/profile', {
    _csrf: csrf, full_name: 'anis', nationality: 'Bangladesh', profession: 'Mason', phone: '0550000001', notify_channel: 'whatsapp',
    positions: ['Electrician'], job_alerts: '1',
  });
  const csrf2 = await workers.badal.csrf('/worker/profile');
  await workers.badal.req('POST', '/worker/profile', {
    _csrf: csrf2, full_name: 'badal', nationality: 'Bangladesh', profession: 'Electrician', phone: '0550000002', notify_channel: 'whatsapp', job_alerts: '1',
  });
  sent.length = 0;
  await postDemand('Painter', 'Another painter job');
  await settle();
  assert.strictEqual(sent.length, 0, 'anis removed Painter');
  await postDemand('Electrician', 'Panel electrician');
  await settle();
  assert.deepStrictEqual(recipients(), ['966550000001', '966550000002']);
});

test('company and admin see the worker positions', async () => {
  const { id } = await postDemand('Mason', 'Mason job');
  await workers.anis.post(`/demands/${id}/apply`, new FormData(), '/worker');
  const apps = await admin.get(`/admin/demands/${id}`);
  const appId = /\/admin\/applications\/(\d+)"/.exec(apps.text)[1];
  assert.match((await admin.get('/admin/applications/' + appId)).text, /Work positions<\/th><td>Mason, Electrician/);
  await admin.post(`/admin/applications/${appId}/status`, { status: 'hired' }, '/admin');
  const own = await company.get(`/company/demands/${id}`);
  const view = await company.get('/company/assigned/' + /\/company\/assigned\/(\d+)"/.exec(own.text)[1]);
  assert.match(view.text, /Work positions<\/th><td>Mason, Electrician/);
});
