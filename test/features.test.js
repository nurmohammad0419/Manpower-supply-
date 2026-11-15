// Company logo, extra worker details, admin-defined worker fields, and WhatsApp / SMS notifications.
// The WhatsApp / SMS services are replaced by a fake that records the requests.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { startApp, PNG, PDF } = require('./support/harness');

const ctx = startApp({
  WHATSAPP_PROVIDER: 'meta', WHATSAPP_TOKEN: 'test-token', WHATSAPP_PHONE_NUMBER_ID: '123456',
  SMS_PROVIDER: 'twilio', TWILIO_ACCOUNT_SID: 'AC_TEST', TWILIO_AUTH_TOKEN: 'secret', TWILIO_SMS_FROM: '+15550000000',
  BASE_URL: 'https://jobs.example.com',
});
const { Client } = ctx;
const notify = require('../src/notify');
const db = require('../src/db');

const sent = [];
let failNext = false;
notify._setFetch(async (url, opts) => {
  sent.push({ url, ...opts });
  if (failNext) { failNext = false; return new Response('{"error":"bad number"}', { status: 400 }); }
  return new Response('{}', { status: 200 });
});
const waitForMessages = async (n) => {
  for (let i = 0; i < 50 && sent.length < n; i++) await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(sent.length, n, `expected ${n} messages, got ${sent.length}`);
};

before(ctx.start);
after(ctx.stop);

const admin = new Client();
const company = new Client();
const worker = new Client();
let logoFile;
let demandId;

test('phone numbers are converted to international format', () => {
  assert.strictEqual(notify.normalizePhone('0501234567'), '+966501234567');
  assert.strictEqual(notify.normalizePhone('50 123 4567'), '+966501234567');
  assert.strictEqual(notify.normalizePhone('00880 1712-345678'), '+8801712345678');
  assert.strictEqual(notify.normalizePhone('+966 50 123 4567'), '+966501234567');
  assert.strictEqual(notify.normalizePhone('12345'), null);
});

test('company registers with a logo; a PDF is refused as a logo', async () => {
  const bad = new FormData();
  bad.append('logo', new Blob([PDF]), 'logo.pdf');
  let r = await company.post('/register/company', bad, '/register/company');
  assert.strictEqual(r.location, '/register/company');
  r = await company.get('/register/company');
  assert.match(r.text, /must be a JPG, PNG or WEBP image/);

  const fd = new FormData();
  for (const [k, v] of Object.entries({
    company_name: 'Desert Builders', cr_number: '1010999', contact_person: 'Saad', city: 'Riyadh',
    phone: '0500000001', email: 'hr@desert.test', password: 'secret12', password_confirm: 'secret12', notify_channel: 'whatsapp',
  })) fd.append(k, v);
  fd.append('logo', new Blob([PNG], { type: 'image/png' }), 'logo.png');
  r = await company.post('/register/company', fd, '/register/company');
  assert.strictEqual(r.location, '/company');
  r = await company.get('/company');
  logoFile = /src="\/logos\/([\w.-]+)"/.exec(r.text)[1];
  const img = await new Client().get('/logos/' + logoFile);
  assert.strictEqual(img.status, 200);
  assert.strictEqual(img.headers.get('content-type'), 'image/png');
  assert.strictEqual((await new Client().get('/logos/../../data/manpower.db')).status, 404);
});

test('admin approval sends the company a WhatsApp message', async () => {
  await admin.post('/login', { email: 'admin@test.local', password: 'adminpass' });
  const r = await admin.get('/admin');
  const id = /\/admin\/companies\/(\d+)\/status/.exec(r.text)[1];
  await admin.post(`/admin/companies/${id}/status`, { status: 'approved' }, '/admin');
  await waitForMessages(1);
  const m = sent[0];
  assert.strictEqual(m.url, 'https://graph.facebook.com/v21.0/123456/messages');
  assert.strictEqual(m.headers.Authorization, 'Bearer test-token');
  const body = JSON.parse(m.body);
  assert.strictEqual(body.to, '966500000001');
  assert.match(body.text.body, /Your company "Desert Builders" has been approved/);
  assert.match(body.text.body, /https:\/\/jobs\.example\.com\/company/);
});

test('a published demand shows the company logo when the admin shows the company name', async () => {
  const r = await company.post('/company/demands', {
    title: 'Mason for school project', category: 'Mason', quantity: '2', salary_amount: '12', salary_type: 'hourly', client_payment_days: '30',
    hours_per_day: '10', days_per_week: '6', duration: '4 months', location_city: 'Riyadh', required_docs: 'iqama',
  }, '/company');
  demandId = r.location.split('/').pop();
  await ctx.publish(admin, demandId, { show_company: '1', worker_rate: '10' });
  await waitForMessages(2); // company: "your demand is published"
  assert.match(JSON.parse(sent[1].body).text.body, /Your demand "Mason for school project" is confirmed and published/);
  const list = await new Client().get('/demands');
  assert.ok(list.text.includes('/logos/' + logoFile));
});

test('admin adds extra worker fields; required ones are enforced at registration', async () => {
  await admin.post('/admin/fields', { label: 'Marital status', field_type: 'select', options: 'Single, Married', required: '1' }, '/admin/fields');
  await admin.post('/admin/fields', { label: 'Height (cm)', field_type: 'number' }, '/admin/fields');
  let r = await admin.post('/admin/fields', { label: 'Broken', field_type: 'select', options: '' }, '/admin/fields');
  r = await admin.get('/admin/fields');
  assert.match(r.text, /Please enter the choices/);
  assert.match(r.text, /Marital status/);

  // Worker chooses Bangla before registering: messages should come in Bangla.
  await worker.get('/lang?code=bn&next=/');
  const page = await worker.get('/register/worker');
  const fieldId = /name="cf_(\d+)"/.exec(page.text)[1];
  const fields = {
    full_name: 'Rafiq Islam', nationality: 'Bangladesh', profession: 'Mason', phone: '0551112222',
    email: 'rafiq@test.local', password: 'secret12', password_confirm: 'secret12', notify_channel: 'sms',
  };
  r = await worker.post('/register/worker', fields, '/register/worker');
  assert.strictEqual(r.status, 400);
  assert.match(r.text, /&quot;Marital status&quot; পূরণ করুন/);
  r = await worker.post('/register/worker', { ...fields, ['cf_' + fieldId]: 'Married' }, '/register/worker');
  assert.strictEqual(r.location, '/worker/documents');
});

test('worker adds more details; the admin sees them, the company only after the worker is assigned', async () => {
  const page = await worker.get('/worker/profile');
  const ids = [...page.text.matchAll(/name="cf_(\d+)"/g)].map((m) => m[1]);
  const r = await worker.post('/worker/profile', {
    full_name: 'Rafiq Islam', nationality: 'Bangladesh', profession: 'Mason', phone: '0551112222', notify_channel: 'sms',
    iqama_expiry: '2027-03-01', kafala_transfer: 'yes', driving_license: 'light', languages: 'Bangla, Arabic',
    expected_salary: '1800 per month', available_from: '2026-12-01', work_history: '2020-2024 Mason, Jeddah',
    ['cf_' + ids[0]]: 'Married', ['cf_' + ids[1]]: '172',
  }, '/worker/profile');
  assert.strictEqual(r.location, '/worker/profile');
  const bad = await worker.post('/worker/profile', {
    full_name: 'Rafiq Islam', nationality: 'Bangladesh', profession: 'Mason', ['cf_' + ids[0]]: 'Married', ['cf_' + ids[1]]: 'tall',
  }, '/worker/profile');
  assert.strictEqual(bad.location, '/worker/profile');
  assert.match((await worker.get('/worker/profile')).text, /&quot;Height \(cm\)&quot; ঠিক আছে কিনা দেখুন/);

  const fd = new FormData();
  fd.append('doc_iqama', new Blob([PDF]), 'iqama.pdf');
  await worker.post(`/demands/${demandId}/apply`, fd, `/demands/${demandId}`);
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(sent.length, 2, 'applications go to the admin, the company is not messaged');

  const list = await admin.get(`/admin/demands/${demandId}`);
  const appId = /\/admin\/applications\/(\d+)"/.exec(list.text)[1];
  const view = await admin.get('/admin/applications/' + appId);
  for (const s of ['Transferable', 'Light vehicle', 'Bangla, Arabic', '1800 per month', '2020-2024 Mason, Jeddah', 'Married', '172']) {
    assert.ok(view.text.includes(s), 'admin sees ' + s);
  }
  worker.appId = appId;
});

test('hiring sends the worker an SMS in their language, with the note; the company is told who was assigned', async () => {
  await admin.post(`/admin/applications/${worker.appId}/status`, { status: 'hired', company_note: 'Come Sunday 7 AM' }, '/admin');
  await waitForMessages(4);
  const m = sent[2];
  assert.strictEqual(m.url, 'https://api.twilio.com/2010-04-01/Accounts/AC_TEST/Messages.json');
  assert.strictEqual(m.headers.Authorization, 'Basic ' + Buffer.from('AC_TEST:secret').toString('base64'));
  const form = new URLSearchParams(m.body);
  assert.strictEqual(form.get('To'), '+966551112222');
  assert.strictEqual(form.get('From'), '+15550000000');
  assert.match(form.get('Body'), /অভিনন্দন! Desert Builders আপনাকে "Mason for school project" কাজে নিয়োগ দিয়েছে/);
  assert.match(form.get('Body'), /কোম্পানির নোট: Come Sunday 7 AM/);
  assert.match(JSON.parse(sent[3].body).text.body, /Rafiq Islam has been assigned to your demand "Mason for school project"/);
  const own = await company.get(`/company/demands/${demandId}`);
  const view = await company.get('/company/assigned/' + /\/company\/assigned\/(\d+)"/.exec(own.text)[1]);
  for (const s of ['Transferable', 'Bangla, Arabic', 'Married']) assert.ok(view.text.includes(s), 'company sees ' + s);
  assert.ok(!view.text.includes('0551112222'), 'company does not see the phone number');
});

test('failed and switched-off messages are recorded; admin can see them', async () => {
  failNext = true;
  await admin.post(`/admin/applications/${worker.appId}/status`, { status: 'shortlisted' }, '/admin');
  await waitForMessages(5);
  await new Promise((r) => setTimeout(r, 50));
  // Worker turns messages off: nothing more is sent.
  await worker.post('/worker/profile', { full_name: 'Rafiq Islam', nationality: 'Bangladesh', profession: 'Mason', phone: '0551112222', notify_channel: 'none', cf_1: 'Married' }, '/worker/profile');
  await admin.post(`/admin/applications/${worker.appId}/status`, { status: 'rejected' }, '/admin');
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(sent.length, 5);

  const rows = db.prepare('SELECT status, error FROM notifications ORDER BY id').all();
  assert.deepStrictEqual(rows.map((x) => x.status), ['sent', 'sent', 'sent', 'sent', 'failed']);
  assert.match(rows[4].error, /HTTP 400/);
  const r = await admin.get('/admin');
  assert.match(r.text, /WhatsApp \/ SMS messages/);
  assert.match(r.text, /badge-rejected">Failed/);
});

test('company can remove its logo', async () => {
  const fd = new FormData();
  for (const [k, v] of Object.entries({ company_name: 'Desert Builders', contact_person: 'Saad', city: 'Riyadh', phone: '0500000001', remove_logo: '1' })) fd.append(k, v);
  const r = await company.post('/company/profile', fd, '/company/profile');
  assert.strictEqual(r.location, '/company/profile');
  assert.strictEqual((await new Client().get('/logos/' + logoFile)).status, 404);
});

test('WhatsApp template mode (needed for business-started messages) sends the text as the template variable', async () => {
  process.env.WHATSAPP_TEMPLATE = 'job_update';
  process.env.WHATSAPP_TEMPLATE_LANG_BN = 'bn';
  try {
    const user = db.prepare("SELECT id FROM users WHERE email = 'rafiq@test.local'").get();
    db.prepare("UPDATE users SET notify_channel = 'whatsapp' WHERE id = ?").run(user.id);
    const before = sent.length;
    await notify.notifyUser(user.id, 'ManpowerHub KSA: You have been shortlisted for "{job}" at {company}.', { job: 'Mason', company: 'Desert Builders' });
    const body = JSON.parse(sent[before].body);
    assert.strictEqual(body.type, 'template');
    assert.strictEqual(body.template.name, 'job_update');
    assert.strictEqual(body.template.language.code, 'bn');
    assert.match(body.template.components[0].parameters[0].text, /শর্টলিস্টেড/);
  } finally {
    delete process.env.WHATSAPP_TEMPLATE;
  }
});
