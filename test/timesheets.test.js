// Monthly timesheet → admin check → worker message → payment → payment slip.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { startApp, PNG, PDF } = require('./support/harness');

const ctx = startApp({ WHATSAPP_PROVIDER: 'meta', WHATSAPP_TOKEN: 't', WHATSAPP_PHONE_NUMBER_ID: '1' });
const { Client } = ctx;
const notify = require('../src/notify');

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
    title: 'Steel fixer', category: 'Steel Fixer', quantity: '5', salary_amount: '15', salary_type: 'hourly',
    hours_per_day: '10', days_per_week: '6', duration: '6 months', location_city: 'Riyadh', required_docs: '',
  }, '/company');
  demandId = r.location.split('/').pop();

  await rahim.get('/lang?code=bn&next=/');
  for (const [w, name, phone, email] of [[rahim, 'Rahim', '0551000001', 'rahim@test.local'], [karim, 'Karim', '0551000002', 'karim@test.local']]) {
    await w.post('/register/worker', { full_name: name, nationality: 'Bangladesh', profession: 'Steel Fixer', phone, email, password: 'secret12', password_confirm: 'secret12', notify_channel: 'whatsapp' }, '/register/worker');
    await w.post(`/demands/${demandId}/apply`, await form({}), `/demands/${demandId}`);
  }
  await rahim.post('/worker/profile', { full_name: 'Rahim', nationality: 'Bangladesh', profession: 'Steel Fixer', phone: '0551000001', notify_channel: 'whatsapp', bank_name: 'Al Rajhi', iban: 'sa03 8000 0000 6080 1016 7519' }, '/worker/profile');
  const list = await company.get(`/company/demands/${demandId}`);
  for (const m of list.text.matchAll(/\/company\/applications\/(\d+)"/g)) {
    await company.post(`/company/applications/${m[1]}/status`, { status: 'hired' }, '/company');
  }
  const formPage = await company.get(`/company/timesheets/new?demand=${demandId}`);
  for (const m of formPage.text.matchAll(/<bdi>(\w+)<\/bdi>[\s\S]*?name="hours_(\d+)"/g)) ids[m[1].toLowerCase()] = m[2];
  assert.ok(ids.rahim && ids.karim, 'both hired workers listed');
  await settle();
  sent.length = 0;
});

test('timesheet file must be PDF / Excel / CSV, month not in the future, at least one worker', async () => {
  let r = await company.post('/company/timesheets', await form({ demand_id: demandId, month, payment_method: 'bank', ['hours_' + ids.rahim]: 10 }, { file: [PNG, 'sheet.png'] }), '/company/timesheets');
  assert.strictEqual(r.location, '/company/timesheets');
  assert.match((await company.get('/company/timesheets')).text, /must be a PDF, Excel \(.xlsx, .xls\) or CSV file/);
  // A ZIP renamed to .pdf is also refused.
  r = await company.post('/company/timesheets', await form({ demand_id: demandId, month, payment_method: 'bank', ['hours_' + ids.rahim]: 10 }, { file: [XLSX, 'sheet.pdf'] }), '/company/timesheets');
  assert.strictEqual(r.location, '/company/timesheets');

  r = await company.post('/company/timesheets', await form({ demand_id: demandId, month: '2999-01', payment_method: 'bank', ['hours_' + ids.rahim]: 10 }, { file: [XLSX, 'sheet.xlsx'] }), '/company/timesheets');
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
  assert.match(page.text, /6,900.00/);
  assert.match(page.text, /SA0380000000608010167519/); // IBAN shown for bank payment

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

test('admin confirms; each worker gets their hours, amount and payment status in their language', async () => {
  await admin.post(`/admin/timesheets/${tsId}/review`, { action: 'confirm' }, '/admin');
  await settle();
  const toRahim = messagesTo('966551000001');
  const toKarim = messagesTo('966551000002');
  assert.strictEqual(toRahim.length, 1);
  assert.match(toRahim[0], /২৬ দিন|26 দিন/);
  assert.match(toRahim[0], /260 ঘণ্টা/);
  assert.match(toRahim[0], /3,900.00 রিয়াল/);
  assert.match(toRahim[0], /ব্যাংক ট্রান্সফার/);
  assert.match(toKarim[0], /confirmed: 19 days, 190 hours, 2,850.00 SAR\. Payment by Bank transfer: Payment pending\./);

  // A confirmed month cannot be replaced.
  const r = await company.post('/company/timesheets', await form({ demand_id: demandId, month, payment_method: 'cash', ['hours_' + ids.rahim]: 1 }), '/company/timesheets');
  assert.match(r.text, /A confirmed timesheet for this month already exists/);
});

test('worker sees the payment; company marks it paid with a receipt; worker is told and can print the slip', async () => {
  let r = await karim.get('/worker/payments');
  assert.match(r.text, /2,850.00/);
  assert.match(r.text, /Payment pending/);
  const lineId = /\/payslips\/(\d+)/.exec(r.text)[1];
  assert.strictEqual((await rahim.get('/payslips/' + lineId)).status, 404, "another worker's slip is private");

  const page = await company.get(`/company/timesheets/${tsId}`);
  assert.ok(page.text.includes(`/timesheet-lines/${lineId}/paid`));
  r = await company.post(`/timesheet-lines/${lineId}/paid`, await form({ paid_at: '2026-12-02', payment_ref: 'TRX-55821' }, { proof: [PDF, 'receipt.pdf'] }), `/company/timesheets/${tsId}`);
  assert.strictEqual(r.location, `/company/timesheets/${tsId}`);
  await settle();
  assert.match(messagesTo('966551000002').at(-1), /payment of 2,850.00 SAR .* has been made by Bank transfer/);

  const slip = await karim.get('/payslips/' + lineId);
  assert.strictEqual(slip.status, 200);
  for (const s of ['PAYMENT SLIP', 'Karim', '2,850.00', 'Paid', 'TRX-55821', '190']) assert.ok(slip.text.includes(s), 'slip shows ' + s);
  const proof = await karim.get(`/timesheet-lines/${lineId}/proof`);
  assert.strictEqual(proof.status, 200);
  assert.strictEqual(proof.headers.get('content-type'), 'application/pdf');
  assert.strictEqual((await other.get(`/timesheet-lines/${lineId}/paid`)).status, 404);
  r = await other.post(`/timesheet-lines/${lineId}/paid`, await form({}), '/company');
  assert.strictEqual(r.status, 404);
});

test('admin lists timesheets by status', async () => {
  const r = await admin.get('/admin/timesheets?status=confirmed');
  assert.match(r.text, /Gulf Contracting/);
  assert.match(r.text, /1 \/ 2/); // one of two workers paid
  assert.doesNotMatch((await admin.get('/admin/timesheets?status=submitted')).text, /Gulf Contracting/);
});
