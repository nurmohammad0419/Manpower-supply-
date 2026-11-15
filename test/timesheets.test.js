// Monthly timesheet → admin check → worker message → payment → payment slip.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { startApp, PNG, PDF } = require('./support/harness');

const ctx = startApp({ WHATSAPP_PROVIDER: 'meta', WHATSAPP_TOKEN: 't', WHATSAPP_PHONE_NUMBER_ID: '1' });
const { Client } = ctx;
const notify = require('../src/notify');
const db = require('../src/db');

const sent = [];
notify._setFetch(async (url, opts) => { sent.push(JSON.parse(opts.body)); return new Response('{}'); });
const messagesTo = (phone) => sent.filter((m) => m.to === phone).map((m) => m.text.body);
const settle = () => new Promise((r) => setTimeout(r, 80));

before(ctx.start);
after(ctx.stop);

const XLSX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('fake excel contents')]);
const admin = new Client();
const company = new Client();
const other = new Client();
const rahim = new Client();
const karim = new Client();
let demandId;
let ids = {};
let tsId;
const month = new Date().toISOString().slice(0, 7);

async function form(fields, files = {}) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, String(v));
  for (const [k, [buf, name]] of Object.entries(files)) fd.append(k, new Blob([buf]), name);
  return fd;
}

test('setup: company hires two workers', async () => {
  await admin.post('/login', { email: 'admin@test.local', password: 'adminpass' });
  for (const [c, name, email] of [[company, 'Gulf Contracting', 'gulf@test.local'], [other, 'Other Co', 'other@test.local']]) {
    await c.post('/register/company', { company_name: name, cr_number: '1', contact_person: 'A', city: 'Riyadh', phone: '0500000009', email, password: 'secret12', password_confirm: 'secret12', notify_channel: 'none' });
  }
  const page = await admin.get('/admin');
  for (const m of page.text.matchAll(/\/admin\/companies\/(\d+)\/status/g)) await admin.post(`/admin/companies/${m[1]}/status`, { status: 'approved' }, '/admin');
  const r = await company.post('/company/demands', {
    title: 'Steel fixer', category: 'Steel Fixer', quantity: '5', salary_amount: '15', salary_type: 'hourly', client_payment_days: '45',
    hours_per_day: '10', days_per_week: '6', duration: '6 months', location_city: 'Riyadh', required_docs: '',
  }, '/company');
  demandId = r.location.split('/').pop();
  await ctx.publish(admin, demandId, { worker_rate: '12', worker_rate_type: 'hourly' });

  await rahim.get('/lang?code=bn&next=/');
  for (const [w, name, phone, email] of [[rahim, 'Rahim', '0551000001', 'rahim@test.local'], [karim, 'Karim', '0551000002', 'karim@test.local']]) {
    await w.post('/register/worker', { full_name: name, nationality: 'Bangladesh', profession: 'Steel Fixer', phone, email, password: 'secret12', password_confirm: 'secret12', notify_channel: 'whatsapp' }, '/register/worker');
    db.prepare("UPDATE workers SET status = 'approved'").run();
    await w.post(`/demands/${demandId}/apply`, await form({}), `/demands/${demandId}`);
  }
  await rahim.post('/worker/profile', { full_name: 'Rahim', nationality: 'Bangladesh', profession: 'Steel Fixer', phone: '0551000001', notify_channel: 'whatsapp', bank_name: 'Al Rajhi', iban: 'sa03 8000 0000 6080 1016 7519' }, '/worker/profile');
  const list = await admin.get(`/admin/demands/${demandId}`);
  for (const m of list.text.matchAll(/\/admin\/applications\/(\d+)"/g)) {
    await admin.post(`/admin/applications/${m[1]}/status`, { status: 'hired' }, '/admin');
  }
  // Hired but not joined yet: not on the timesheet form.
  assert.doesNotMatch((await company.get(`/company/timesheets/new?demand=${demandId}`)).text, /name="hours_/);
  for (const m of list.text.matchAll(/\/admin\/applications\/(\d+)"/g)) {
    await admin.post(`/admin/applications/${m[1]}/joined`, { joined_at: '2026-11-01' }, '/admin/applications/' + m[1]);
  }
  const formPage = await company.get(`/company/timesheets/new?demand=${demandId}`);
  for (const m of formPage.text.matchAll(/<bdi>(\w+)<\/bdi>[\s\S]*?name="hours_(\d+)"/g)) ids[m[1].toLowerCase()] = m[2];
  assert.ok(ids.rahim && ids.karim, 'both hired workers listed');
  await settle();
  sent.length = 0;
});

test('timesheet file must be PDF / Excel / CSV, month not in the future, at least one worker', async () => {
  let r = await company.post('/company/timesheets', await form({ demand_id: demandId, month, ['hours_' + ids.rahim]: 10 }, { file: [PNG, 'sheet.png'] }), '/company/timesheets');
  assert.strictEqual(r.location, '/company/timesheets');
  assert.match((await company.get('/company/timesheets')).text, /must be a PDF, Excel \(.xlsx, .xls\) or CSV file/);
  // A ZIP renamed to .pdf is also refused.
  r = await company.post('/company/timesheets', await form({ demand_id: demandId, month, ['hours_' + ids.rahim]: 10 }, { file: [XLSX, 'sheet.pdf'] }), '/company/timesheets');
  assert.strictEqual(r.location, '/company/timesheets');

  r = await company.post('/company/timesheets', await form({ demand_id: demandId, month: '2999-01', ['hours_' + ids.rahim]: 10 }, { file: [XLSX, 'sheet.xlsx'] }), '/company/timesheets');
  assert.strictEqual(r.status, 400);
  assert.match(r.text, /cannot be in the future/);
  r = await company.post('/company/timesheets', await form({ demand_id: demandId, month, payment_method: 'bank' }, { file: [XLSX, 'sheet.xlsx'] }), '/company/timesheets');
  assert.match(r.text, /at least one worker/);
});

test('company submits a timesheet; nobody else can see it and workers are not told yet', async () => {
  const r = await company.post('/company/timesheets', await form({
    demand_id: demandId, month, payment_method: 'bank',
    ['days_' + ids.rahim]: 26, ['hours_' + ids.rahim]: 260, ['amount_' + ids.rahim]: 3900,
    ['days_' + ids.karim]: 20, ['hours_' + ids.karim]: 200, ['amount_' + ids.karim]: 3000,
  }, { file: [XLSX, 'November.xlsx'] }), '/company/timesheets');
  assert.match(r.location, /^\/company\/timesheets\/\d+$/);
  tsId = r.location.split('/').pop();
  const page = await company.get(r.location);
  assert.match(page.text, /Waiting for admin check/);
  assert.match(page.text, /6,900.00/); // what the company owes
  assert.doesNotMatch(page.text, /SA0380000000608010167519/, 'the company does not see worker bank details');
  assert.match((await admin.get(`/admin/timesheets/${tsId}`)).text, /SA0380000000608010167519/);

  const file = await company.get(`/timesheets/${tsId}/file`);
  assert.strictEqual(file.status, 200);
  assert.match(file.headers.get('content-disposition'), /^attachment/);

  assert.strictEqual((await other.get(`/company/timesheets/${tsId}`)).status, 404);
  assert.strictEqual((await other.get(`/timesheets/${tsId}/file`)).status, 404);
  assert.strictEqual((await rahim.get(`/timesheets/${tsId}/file`)).status, 403);
  assert.match((await rahim.get('/worker/payments')).text, /কোনো নিশ্চিত টাইমশিট নেই|No confirmed timesheets yet/);
  await settle();
  assert.strictEqual(sent.length, 0);
});

test('admin sends it back with a note; company corrects it without re-uploading the file', async () => {
  let r = await admin.post(`/admin/timesheets/${tsId}/review`, { action: 'reject', admin_note: '' }, '/admin');
  assert.match((await admin.get(`/admin/timesheets/${tsId}`)).text, /Please write what needs to be corrected/);
  await admin.post(`/admin/timesheets/${tsId}/review`, { action: 'reject', admin_note: 'Karim hours do not match the sheet (190).' }, '/admin');
  r = await company.get(`/company/timesheets/new?demand=${demandId}&month=${month}`);
  assert.match(r.text, /Karim hours do not match the sheet/);
  assert.match(r.text, new RegExp(`name="hours_${ids.karim}"[^>]*value="200"`));
  r = await company.post('/company/timesheets', await form({
    demand_id: demandId, month, payment_method: 'bank',
    ['days_' + ids.rahim]: 26, ['hours_' + ids.rahim]: 260, ['amount_' + ids.rahim]: 3900,
    ['days_' + ids.karim]: 19, ['hours_' + ids.karim]: 190, ['amount_' + ids.karim]: 2850,
  }), '/company/timesheets');
  assert.strictEqual(r.location, `/company/timesheets/${tsId}`);
  assert.strictEqual((await company.get(`/timesheets/${tsId}/file`)).status, 200, 'old file kept');
});

test('admin sets worker pay from the worker rate and confirms; each worker gets their pay in their language', async () => {
  const page = await admin.get(`/admin/timesheets/${tsId}`);
  const payIds = Object.fromEntries([...page.text.matchAll(/<bdi>(\w+)<\/bdi>[\s\S]*?name="pay_(\d+)"[^>]*value="([\d.]+)"/g)].map((m) => [m[1].toLowerCase(), { id: m[2], value: m[3] }]));
  assert.strictEqual(payIds.rahim.value, '3120.00', '260 h x 12 SAR worker rate');
  assert.strictEqual(payIds.karim.value, '2280.00');
  let r = await admin.post(`/admin/timesheets/${tsId}/review`, { action: 'confirm' }, '/admin');
  assert.match((await admin.get(r.location)).text, /Please choose the payment method/);
  await admin.post(`/admin/timesheets/${tsId}/review`, {
    action: 'confirm', payment_method: 'bank', ['pay_' + payIds.rahim.id]: '', ['pay_' + payIds.karim.id]: '2300',
  }, '/admin');
  await settle();
  const toRahim = messagesTo('966551000001');
  const toKarim = messagesTo('966551000002');
  assert.strictEqual(toRahim.length, 1);
  assert.match(toRahim[0], /২৬ দিন|26 দিন/);
  assert.match(toRahim[0], /260 ঘণ্টা/);
  assert.match(toRahim[0], /3,120.00 রিয়াল/);
  assert.match(toRahim[0], /ব্যাংক ট্রান্সফার/);
  assert.match(toKarim[0], /: 19 days, 190 hours, 2,300.00 SAR \(payment by Bank transfer\)\. Please check it within 48 hours/);

  const adminView = await admin.get(`/admin/timesheets/${tsId}`);
  assert.match(adminView.text, /5,420.00/); // worker pay total
  assert.match(adminView.text, /1,330.00/); // margin: 6,750.00 - 5,420.00
  const companyView = await company.get(`/company/timesheets/${tsId}`);
  assert.match(companyView.text, /6,750.00/);
  assert.match(companyView.text, /Payment due date/);
  assert.doesNotMatch(companyView.text, /5,420.00|3,120.00|2,300.00/, 'the company does not see worker pay');

  // A confirmed month cannot be replaced.
  const again = await company.post('/company/timesheets', await form({ demand_id: demandId, month, ['hours_' + ids.rahim]: 1 }), '/company/timesheets');
  assert.match(again.text, /A confirmed timesheet for this month already exists/);
});

test('worker sees the payment; the admin pays with a receipt; worker is told and can print the slip', async () => {
  let r = await karim.get('/worker/payments');
  assert.match(r.text, /2,300.00/);
  assert.match(r.text, /Waiting for worker check/);
  assert.match(r.text, /Please check your hours and pay/);
  const lineId = /\/worker\/timesheet-lines\/(\d+)\/confirm/.exec(r.text)[1];
  assert.strictEqual((await rahim.get('/payslips/' + lineId)).status, 404, "another worker's slip is private");

  r = await company.post(`/timesheet-lines/${lineId}/paid`, await form({}), `/company/timesheets/${tsId}`);
  assert.strictEqual(r.status, 403, 'the supply company pays workers, not the client company');
  // Not payable until the worker has confirmed the timesheet.
  let page = await admin.get(`/admin/timesheets/${tsId}`);
  assert.ok(!page.text.includes(`/timesheet-lines/${lineId}/paid`));
  r = await admin.post(`/timesheet-lines/${lineId}/paid`, await form({}), `/admin/timesheets/${tsId}`);
  assert.match((await admin.get(r.location)).text, /The worker has not confirmed this timesheet yet/);
  await karim.post(`/worker/timesheet-lines/${lineId}/confirm`, {}, '/worker/payments');
  // Notice before paying.
  await admin.post(`/admin/timesheets/${tsId}/pay-notice`, { pay_date: '2026-12-02' }, `/admin/timesheets/${tsId}`);
  await settle();
  assert.match(messagesTo('966551000002').at(-1), /salary of 2,300.00 SAR for .* will be paid on 2026-12-02 by Bank transfer/);
  page = await admin.get(`/admin/timesheets/${tsId}`);
  assert.ok(page.text.includes(`/timesheet-lines/${lineId}/paid`));
  r = await admin.post(`/timesheet-lines/${lineId}/paid`, await form({ paid_at: '2026-12-02', payment_ref: 'TRX-55821' }, { proof: [PDF, 'receipt.pdf'] }), `/admin/timesheets/${tsId}`);
  assert.strictEqual(r.location, `/admin/timesheets/${tsId}`);
  await settle();
  assert.match(messagesTo('966551000002').at(-1), /payment of 2,300.00 SAR .* has been made by Bank transfer/);

  const slip = await karim.get('/payslips/' + lineId);
  assert.strictEqual(slip.status, 200);
  for (const s of ['PAYMENT SLIP', 'Karim', '2,300.00', 'Paid', 'TRX-55821', '190', 'ManpowerHub KSA', 'Client company']) assert.ok(slip.text.includes(s), 'slip shows ' + s);
  assert.ok(!slip.text.includes('Gulf Contracting'), 'company name hidden on the slip');
  assert.strictEqual((await company.get('/payslips/' + lineId)).status, 403);
  const proof = await karim.get(`/timesheet-lines/${lineId}/proof`);
  assert.strictEqual(proof.status, 200);
  assert.strictEqual(proof.headers.get('content-type'), 'application/pdf');
});

test('admin records the company payment', async () => {
  await admin.post(`/admin/timesheets/${tsId}/client-paid`, { paid_at: '2026-12-20' }, `/admin/timesheets/${tsId}`);
  assert.match((await company.get(`/company/timesheets/${tsId}`)).text, /Company paid on/);
});

test('admin lists timesheets by status', async () => {
  const r = await admin.get('/admin/timesheets?status=confirmed');
  assert.match(r.text, /Gulf Contracting/);
  assert.match(r.text, /1 \/ 2/); // one of two workers paid
  assert.doesNotMatch((await admin.get('/admin/timesheets?status=submitted')).text, /Gulf Contracting/);
});
