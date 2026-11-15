// Worker checks the approved timesheet (48 hours, problem → admin answer), payment notices,
// and the admin's money management (billed, received, worker pay, expenses, profit / loss).
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { startApp } = require('./support/harness');

const ctx = startApp({ WHATSAPP_PROVIDER: 'meta', WHATSAPP_TOKEN: 't', WHATSAPP_PHONE_NUMBER_ID: '1' });
const { Client } = ctx;
const notify = require('../src/notify');
const db = require('../src/db');

const sent = [];
notify._setFetch(async (url, opts) => { sent.push(JSON.parse(opts.body)); return new Response('{}'); });
const settle = () => new Promise((r) => setTimeout(r, 80));
const to = (phone) => sent.filter((m) => m.to === phone).map((m) => m.text.body);

before(ctx.start);
after(ctx.stop);

const XLSX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('x')]);
const admin = new Client();
const company = new Client();
const anwar = new Client();
const bilal = new Client();
const month = new Date().toISOString().slice(0, 7);
let tsId;
const lineOf = {};
const stat = (html, label) => {
  const m = new RegExp(`<b>([^<]+)</b><span>${label}`).exec(html);
  return m && m[1];
};

test('setup: published demand, two hired and joined workers, approved timesheet', async () => {
  await admin.post('/login', { email: 'admin@test.local', password: 'adminpass' });
  await company.post('/register/company', { company_name: 'Red Sea Builders', cr_number: '5', contact_person: 'K', city: 'Jeddah', phone: '0509990000', email: 'rs@test.local', password: 'secret12', password_confirm: 'secret12', notify_channel: 'none' });
  const cid = /\/admin\/companies\/(\d+)\/status/.exec((await admin.get('/admin')).text)[1];
  await admin.post(`/admin/companies/${cid}/status`, { status: 'approved' }, '/admin');
  const r = await company.post('/company/demands', {
    title: 'Shuttering carpenter', category: 'Carpenter', quantity: '2', salary_amount: '20', salary_type: 'hourly', client_payment_days: '30',
    hours_per_day: '10', days_per_week: '6', duration: '3 months', location_city: 'Jeddah', required_docs: '',
  }, '/company');
  const demandId = r.location.split('/').pop();
  await ctx.publish(admin, demandId, { worker_rate: '15', worker_rate_type: 'hourly' });
  for (const [c, name, phone, channel] of [[anwar, 'Anwar', '0552000001', 'whatsapp'], [bilal, 'Bilal', '0552000002', 'none']]) {
    await c.post('/register/worker', { full_name: name, nationality: 'Pakistan', profession: 'Carpenter', phone, email: name + '@test.local', password: 'secret12', password_confirm: 'secret12', notify_channel: channel }, '/register/worker');
    db.prepare("UPDATE workers SET status = 'approved'").run();
    await c.post(`/demands/${demandId}/apply`, new FormData(), `/demands/${demandId}`);
  }
  const apps = await admin.get(`/admin/demands/${demandId}`);
  for (const m of apps.text.matchAll(/\/admin\/applications\/(\d+)"/g)) {
    await admin.post(`/admin/applications/${m[1]}/status`, { status: 'hired' }, '/admin');
    await admin.post(`/admin/applications/${m[1]}/joined`, { joined_at: `${month}-01` }, '/admin');
  }
  const own = await company.get(`/company/demands/${demandId}`);
  assert.match(own.text, /Joined on/);

  const formPage = await company.get(`/company/timesheets/new?demand=${demandId}`);
  const ids = Object.fromEntries([...formPage.text.matchAll(/<bdi>(\w+)<\/bdi>[\s\S]*?name="hours_(\d+)"/g)].map((m) => [m[1], m[2]]));
  const fd = new FormData();
  for (const [k, v] of Object.entries({ demand_id: demandId, month, ['hours_' + ids.Anwar]: 100, ['amount_' + ids.Anwar]: 2000, ['days_' + ids.Anwar]: 10, ['hours_' + ids.Bilal]: 50, ['amount_' + ids.Bilal]: 1000, ['days_' + ids.Bilal]: 5 })) fd.append(k, String(v));
  fd.append('file', new Blob([XLSX]), 'sheet.xlsx');
  tsId = (await company.post('/company/timesheets', fd, '/company/timesheets')).location.split('/').pop();
  await admin.post(`/admin/timesheets/${tsId}/review`, { action: 'confirm', payment_method: 'bank' }, '/admin');
  await settle();
  for (const [name, c] of [['anwar', anwar], ['bilal', bilal]]) {
    const page = await c.get('/worker/payments');
    lineOf[name] = /\/worker\/timesheet-lines\/(\d+)\/confirm/.exec(page.text)[1];
  }
  assert.ok(to('966552000001').some((m) => /10 days, 100 hours, 1,500.00 SAR .*within 48 hours/.test(m)));
});

test('worker reports a problem; the admin answers with corrected numbers; the worker confirms', async () => {
  let r = await anwar.post(`/worker/timesheet-lines/${lineOf.anwar}/problem`, { worker_note: '' }, '/worker/payments');
  assert.match((await anwar.get('/worker/payments')).text, /Please write the problem/);
  await anwar.post(`/worker/timesheet-lines/${lineOf.anwar}/problem`, { worker_note: 'I worked 110 hours, 10 hours overtime are missing.' }, '/worker/payments');
  assert.match((await anwar.get('/worker/payments')).text, /ManpowerHub KSA is checking your problem/);
  let page = await admin.get(`/admin/timesheets/${tsId}`);
  assert.match(page.text, /10 hours overtime are missing/);
  assert.match(page.text, /Problem reported/);
  assert.strictEqual(stat((await admin.get('/admin')).text, 'Timesheet problems reported'), '1');

  // Cannot pay a disputed line.
  r = await admin.post(`/timesheet-lines/${lineOf.anwar}/paid`, new FormData(), `/admin/timesheets/${tsId}`);
  assert.match((await admin.get(r.location)).text, /The worker has not confirmed this timesheet yet/);

  await admin.post(`/admin/timesheet-lines/${lineOf.anwar}/reply`, {
    reply_result: 'resolved', admin_reply: 'Checked with the site: overtime added.', hours: '110', worker_amount: '1650', amount: '2200',
  }, `/admin/timesheets/${tsId}`);
  await settle();
  assert.match(to('966552000001').at(-1), /has been solved: Checked with the site: overtime added\. Now: 10 days, 110 hours, 1,650.00 SAR\. Please confirm within 48 hours/);
  page = await anwar.get('/worker/payments');
  assert.match(page.text, /Admin replied/);
  assert.match(page.text, /1,650.00/);
  await anwar.post(`/worker/timesheet-lines/${lineOf.anwar}/confirm`, {}, '/worker/payments');
  assert.match((await anwar.get('/worker/payments')).text, /Confirmed by worker/);
  r = await anwar.post(`/worker/timesheet-lines/${lineOf.anwar}/confirm`, {}, '/worker/payments');
  assert.match((await anwar.get('/worker/payments')).text, /already confirmed/);
});

test('a worker who does not answer within 48 hours is confirmed automatically; notices show on the dashboard', async () => {
  // Bilal has messages switched off: he still sees the notice on his dashboard.
  const dash = await bilal.get('/worker');
  assert.match(dash.text, /Notices from ManpowerHub KSA/);
  assert.match(dash.text, /Please check it within 48 hours/);
  assert.strictEqual(to('966552000002').length, 0);

  db.prepare("UPDATE timesheet_lines SET worker_deadline = datetime('now', '-1 minute') WHERE id = ?").run(lineOf.bilal);
  await admin.get('/admin/money');
  const page = await bilal.get('/worker/payments');
  assert.match(page.text, /Confirmed automatically because the time to check ended/);
  // A confirmed line cannot be disputed any more.
  await bilal.post(`/worker/timesheet-lines/${lineOf.bilal}/problem`, { worker_note: 'late complaint' }, '/worker/payments');
  assert.strictEqual(db.prepare('SELECT worker_status FROM timesheet_lines WHERE id = ?').get(lineOf.bilal).worker_status, 'confirmed');
});

test('payment notice before paying, then payment', async () => {
  await admin.post(`/admin/timesheets/${tsId}/pay-notice`, { pay_date: '2030-01-05' }, `/admin/timesheets/${tsId}`);
  await settle();
  assert.match(to('966552000001').at(-1), /salary of 1,650.00 SAR .* will be paid on 2030-01-05/);
  assert.match((await bilal.get('/worker')).text, /salary of 750.00 SAR .* will be paid on 2030-01-05/);
  const fd = new FormData();
  fd.append('paid_at', '2030-01-05');
  await admin.post(`/timesheet-lines/${lineOf.anwar}/paid`, fd, `/admin/timesheets/${tsId}`);
  await settle();
  assert.match(to('966552000001').at(-1), /payment of 1,650.00 SAR/);
  const page = await anwar.get('/worker/payments');
  assert.match(page.text, /Payment slip/);
});

test('expenses and the money summary: billed, received, worker pay, profit and loss', async () => {
  let r = await admin.post('/admin/expenses', { spent_on: '', category: 'kafala', amount: '300' }, '/admin/money');
  assert.match((await admin.get(r.location)).text, /Please enter the date, type and amount/);
  await admin.post('/admin/expenses', { spent_on: `${month}-10`, category: 'kafala', amount: '300', note: 'Iqama renewal' }, '/admin/money');
  await admin.post('/admin/expenses', { spent_on: `${month}-12`, category: 'transport', amount: '100' }, '/admin/money');

  let page = (await admin.get('/admin/money')).text;
  assert.strictEqual(stat(page, 'Billed to companies'), '3,200.00'); // 2,200 + 1,000
  assert.strictEqual(stat(page, 'Received from companies'), '0.00');
  assert.strictEqual(stat(page, 'Still due from companies'), '3,200.00');
  assert.strictEqual(stat(page, 'Worker salaries earned'), '2,400.00'); // 1,650 + 750
  assert.strictEqual(stat(page, 'Paid to workers'), '1,650.00');
  assert.strictEqual(stat(page, 'Still to pay workers'), '750.00');
  assert.strictEqual(stat(page, 'Expenses'), '400.00');
  assert.match(page, /<b>400.00<\/b><span>Profit \(on work done\)/); // 3,200 − 2,400 − 400
  assert.match(page, /<b>-2,050.00<\/b><span>Cash in hand/); // 0 − 1,650 − 400

  // Which worker is owed money, and at which company.
  const workers = (await admin.get('/admin/money?tab=workers')).text;
  assert.match(workers, /Bilal[\s\S]*?750.00[\s\S]*?Red Sea Builders/);
  assert.match((await admin.get('/admin/money?tab=expenses')).text, /Iqama renewal/);

  await admin.post(`/admin/timesheets/${tsId}/client-paid`, { paid_at: `${month}-28` }, `/admin/timesheets/${tsId}`);
  page = (await admin.get('/admin/money')).text;
  assert.strictEqual(stat(page, 'Received from companies'), '3,200.00');
  assert.match(page, /<b>1,150.00<\/b><span>Cash in hand/); // 3,200 − 1,650 − 400
  const months = (await admin.get('/admin/money?tab=months')).text;
  assert.match(months, /<b>400.00<\/b>/);

  assert.strictEqual((await company.get('/admin/money')).status, 403);
  assert.strictEqual((await anwar.get('/admin/money')).status, 403);
});
