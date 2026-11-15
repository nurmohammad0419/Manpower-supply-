// End-to-end test of the full flow: company registers → admin approves → company posts demand →
// worker registers, uploads documents, applies → company reviews documents and hires.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { startApp, PNG, PDF } = require('./support/harness');

const ctx = startApp();
const { Client } = ctx;
before(ctx.start);
after(ctx.stop);

const company = new Client();
const worker = new Client();
const worker2 = new Client();
const admin = new Client();
const otherCompany = new Client();
let demandId;
let applicationId;
let docId;

test('home page renders', async () => {
  const r = await new Client().get('/');
  assert.strictEqual(r.status, 200);
  assert.match(r.text, /Hire workers in Saudi Arabia/);
});

test('POST without CSRF token is rejected', async () => {
  const r = await new Client().req('POST', '/login', { email: 'x@y.z', password: 'nope' });
  assert.strictEqual(r.status, 403);
});

test('company registers', async () => {
  const r = await company.post('/register/company', {
    company_name: 'Al Noor Contracting', cr_number: '1010123456', contact_person: 'Ahmed', city: 'Riyadh',
    phone: '+966500000001', email: 'hr@alnoor.test', password: 'secret12', password_confirm: 'secret12',
  });
  assert.strictEqual(r.status, 302);
  assert.strictEqual(r.location, '/company');
  const dash = await company.get('/company');
  assert.match(dash.text, /awaiting admin verification/);
});

test('duplicate email is refused', async () => {
  const r = await new Client().post('/register/worker', {
    full_name: 'X', nationality: 'Bangladesh', profession: 'Mason', phone: '1',
    email: 'hr@alnoor.test', password: 'secret12', password_confirm: 'secret12',
  });
  assert.strictEqual(r.status, 400);
  assert.match(r.text, /already exists/);
});

test('jobs are hidden from visitors, companies and workers until the admin approves the worker', async () => {
  let r = await worker.post('/register/worker', {
    full_name: 'Rahim Uddin', nationality: 'Bangladesh', profession: 'Electrician', experience_years: '5',
    phone: '+966500000002', email: 'rahim@test.local', password: 'secret12', password_confirm: 'secret12',
  });
  assert.strictEqual(r.location, '/worker/documents');
  assert.match((await worker.get('/worker/documents')).text, /will check your details and approve your account/);

  // Visitor: sent to login. Company: not allowed. Waiting worker: sent back to the dashboard.
  r = await new Client().get('/demands');
  assert.match(r.location, /^\/login\?next=/);
  assert.match((await new Client().get('/')).text, /Running jobs are only for registered workers/);
  assert.strictEqual((await company.get('/demands')).status, 403);
  r = await worker.get('/demands');
  assert.strictEqual(r.location, '/worker');
  assert.match((await worker.get('/worker')).text, /Your account is waiting for approval/);
  assert.doesNotMatch((await worker.get('/')).text, /href="\/demands"/, 'no job menu yet');

  await admin.post('/login', { email: 'admin@test.local', password: 'adminpass' }, '/login');
  const page = await admin.get('/admin');
  assert.match(page.text, /Waiting for approval/);
  const id = /\/admin\/workers\/(\d+)\/status" class="inline quick" data-approve/.exec(page.text)[1];
  await admin.post(`/admin/workers/${id}/status`, { status: 'approved' }, '/admin');
  assert.strictEqual((await worker.get('/demands')).status, 200);
});

test('company posts a demand: it waits for the admin and is not public', async () => {
  const r = await company.post('/company/demands', {
    title: 'Electrician for villa project', category: 'Electrician', quantity: '1', salary_amount: '15',
    salary_type: 'hourly', client_payment_days: '45', hours_per_day: '10', days_per_week: '6', duration: '3 months', location_city: 'Riyadh',
    food: 'yes', accommodation: 'yes', transport: 'allowance', required_docs: 'iqama', overtime: '1.5x', deadline: '',
  });
  assert.strictEqual(r.status, 302);
  demandId = r.location.split('/').pop();
  const page = await company.get(r.location);
  assert.match(page.text, /Demand sent\. The admin will confirm the terms/);
  assert.match(page.text, /Waiting for admin review/);
  assert.match(page.text, /45 days after month end/);
  assert.doesNotMatch((await worker.get('/demands')).text, /Electrician for villa project/);
  assert.strictEqual((await worker.get(`/demands/${demandId}`)).status, 404);
});

test('admin approves the company; the demand stays hidden until published', async () => {
  let r = await admin.get('/admin');
  assert.match(r.text, /Al Noor Contracting/);
  const companyId = /\/admin\/companies\/(\d+)\/status/.exec(r.text)[1];
  r = await admin.post(`/admin/companies/${companyId}/status`, { status: 'approved' }, '/admin');
  assert.strictEqual(r.status, 302);
  assert.doesNotMatch((await worker.get('/demands')).text, /Electrician for villa project/);
});

test('admin cannot publish before the agreement is signed', async () => {
  const r = await ctx.publish(admin, demandId, { agreement_signed: '' });
  assert.strictEqual(r.location, `/admin/demands/${demandId}`);
  assert.match((await admin.get(r.location)).text, /only be published after the agreement with the company is signed/);
  assert.doesNotMatch((await worker.get('/demands')).text, /Electrician for villa project/);
});

test('admin signs the agreement and publishes the job with the worker rate and terms', async () => {
  const fd = { worker_rate: '11.5', worker_rate_type: 'hourly', worker_pay_days: '5', worker_terms: 'Probation one month.', agreement: undefined };
  const r = await ctx.publish(admin, demandId, fd);
  assert.match((await admin.get(r.location)).text, /Job published/);
  const list = await worker.get('/demands?category=Electrician');
  assert.match(list.text, /Electrician for villa project/);
  assert.match(list.text, /11.5 SAR/);
  assert.doesNotMatch(list.text, /15 SAR/, 'company rate is never shown to workers');
  assert.doesNotMatch(list.text, /Al Noor Contracting/, 'company name hidden by default');
  assert.match(list.text, /Client company/);
  assert.doesNotMatch((await worker.get('/demands?q=Al+Noor')).text, /Electrician for villa project/);
  const detail = await worker.get(`/demands/${demandId}`);
  assert.match(detail.text, /Paid within 5 days after the end of each month/);
  assert.match(detail.text, /Transport to work provided by ManpowerHub KSA/);
  assert.match(detail.text, /Accommodation and food provided/);
  assert.match(detail.text, /Probation one month/);
  // The company sees its agreed terms, not the worker rate.
  const own = await company.get(`/company/demands/${demandId}`);
  assert.match(own.text, /Published/);
  assert.match(own.text, /Signed/);
  assert.doesNotMatch(own.text, /11\.5/);
  // The company cannot open the worker job page or the job offer, so it never learns the worker rate.
  assert.strictEqual((await company.get(`/demands/${demandId}`)).status, 403);
  assert.strictEqual((await company.get(`/demands/${demandId}/letter`)).status, 403);
});

test('job offer letter is printable and issued by the supply company', async () => {
  const r = await worker.get(`/demands/${demandId}/letter`);
  assert.strictEqual(r.status, 200);
  assert.match(r.text, /JOB OFFER/);
  assert.match(r.text, /11.5 SAR/);
  assert.doesNotMatch(r.text, /1010123456|Al Noor/);
});

test('company cannot change a published demand', async () => {
  const r = await company.get(`/company/demands/${demandId}/edit`);
  assert.strictEqual(r.location, `/company/demands/${demandId}`);
  assert.match((await company.get(r.location)).text, /already published/);
});

test('worker uploads documents', async () => {
  let r;

  // A fake "image" that is really text must be rejected.
  const bad = new FormData();
  bad.append('doc_photo', new Blob(['hello']), 'photo.png');
  r = await worker.post('/worker/documents', bad, '/worker/documents');
  assert.strictEqual(r.status, 302);
  r = await worker.get('/worker/documents');
  assert.match(r.text, /is not a PDF, JPG, PNG or WEBP/);

  const fd = new FormData();
  fd.append('doc_photo', new Blob([PNG], { type: 'image/png' }), 'me.png');
  fd.append('doc_passport', new Blob([PDF], { type: 'application/pdf' }), 'passport.pdf');
  r = await worker.post('/worker/documents', fd, '/worker/documents');
  r = await worker.get('/worker/documents');
  assert.match(r.text, /2 document\(s\) uploaded/);
  docId = /href="\/documents\/(\d+)"/.exec(r.text)[1];
  const doc = await worker.get('/documents/' + docId);
  assert.strictEqual(doc.status, 200);
});

test('apply is blocked until required Iqama is uploaded, then succeeds', async () => {
  let r = await worker.post(`/demands/${demandId}/apply`, new FormData(), `/demands/${demandId}`);
  r = await worker.get(`/demands/${demandId}`);
  assert.match(r.text, /Please upload the required documents: Iqama/);

  const fd = new FormData();
  fd.append('doc_iqama', new Blob([PDF], { type: 'application/pdf' }), 'iqama.pdf');
  fd.append('cover_note', 'Available immediately');
  r = await worker.post(`/demands/${demandId}/apply`, fd, `/demands/${demandId}`);
  assert.strictEqual(r.location, '/worker');
  r = await worker.get('/worker');
  assert.match(r.text, /Application submitted/);
  assert.match(r.text, /badge-applied/);
});

test('companies cannot see applicants or their documents before the admin assigns them', async () => {
  await otherCompany.post('/register/company', {
    company_name: 'Other Co', cr_number: '999', contact_person: 'B', city: 'Jeddah',
    phone: '1', email: 'other@test.local', password: 'secret12', password_confirm: 'secret12',
  });
  assert.strictEqual((await otherCompany.get('/documents/' + docId)).status, 404);
  assert.strictEqual((await otherCompany.get(`/company/demands/${demandId}`)).status, 404);
  assert.strictEqual((await company.get('/documents/' + docId)).status, 404);
  const own = await company.get(`/company/demands/${demandId}`);
  assert.doesNotMatch(own.text, /Rahim Uddin/);
  assert.match(own.text, /No workers assigned yet/);
});

test('admin reviews the applicant and hires; the company sees the worker without contact details', async () => {
  let r = await admin.get(`/admin/demands/${demandId}`);
  assert.match(r.text, /Rahim Uddin/);
  applicationId = /\/admin\/applications\/(\d+)"/.exec(r.text)[1];
  r = await admin.get('/admin/applications/' + applicationId);
  assert.match(r.text, /\+966500000002/);
  assert.match(r.text, /Available immediately/);
  r = await admin.post(`/admin/applications/${applicationId}/status`, { status: 'hired', company_note: 'Report Sunday 7 AM' }, '/admin');
  assert.strictEqual(r.status, 302);
  r = await worker.get('/worker');
  assert.match(r.text, /badge-hired/);
  assert.match(r.text, /Report Sunday 7 AM/);
  assert.match(r.text, /11.5/);

  const own = await company.get(`/company/demands/${demandId}`);
  assert.match(own.text, /Rahim Uddin/);
  const assignedId = /\/company\/assigned\/(\d+)"/.exec(own.text)[1];
  const view = await company.get('/company/assigned/' + assignedId);
  assert.match(view.text, /Iqama \(Residence ID\)/);
  assert.doesNotMatch(view.text, /\+966500000002|rahim@test\.local|Available immediately/);
  assert.strictEqual((await company.get('/documents/' + docId)).status, 200);
  assert.strictEqual((await company.get('/admin/applications/' + applicationId)).status, 403);
});

test('cannot hire more than the demanded quantity', async () => {
  await worker2.post('/register/worker', {
    full_name: 'Karim', nationality: 'Nepal', profession: 'Electrician', phone: '3',
    email: 'karim@test.local', password: 'secret12', password_confirm: 'secret12',
  });
  await ctx.approveWorkers(admin);
  const fd = new FormData();
  fd.append('doc_iqama', new Blob([PDF], { type: 'application/pdf' }), 'iqama.pdf');
  await worker2.post(`/demands/${demandId}/apply`, fd, `/demands/${demandId}`);
  let r = await admin.get(`/admin/demands/${demandId}`);
  const ids = [...r.text.matchAll(/\/admin\/applications\/(\d+)"/g)].map((m) => m[1]);
  const second = ids.find((id) => id !== applicationId);
  await admin.post(`/admin/applications/${second}/status`, { status: 'hired' }, '/admin');
  r = await admin.get('/admin/applications/' + second);
  assert.match(r.text, /already hired 1 of 1/);
});

test('worker cannot open company pages and logout works', async () => {
  assert.strictEqual((await worker.get('/company')).status, 403);
  const r = await worker.post('/logout', {}, '/');
  assert.strictEqual(r.location, '/');
  assert.strictEqual((await worker.get('/worker')).status, 302);
});

test('language menu switches the site language and direction', async () => {
  const c = new Client();
  let r = await c.get('/lang?code=bn&next=/register/worker');
  assert.strictEqual(r.location, '/register/worker');
  r = await c.get('/register/worker');
  assert.match(r.text, /<html lang="bn" dir="ltr">/);
  assert.match(r.text, /কর্মী রেজিস্ট্রেশন/);
  assert.match(r.text, /ইলেকট্রিশিয়ান/); // category name translated

  await c.get('/lang?code=ar&next=/');
  r = await c.get('/');
  assert.match(r.text, /<html lang="ar" dir="rtl">/);
  assert.match(r.text, /وظّف العمال في المملكة العربية السعودية/);

  await c.get('/lang?code=ur&next=/');
  r = await c.get('/login');
  assert.match(r.text, /dir="rtl"/);

  // Flash messages come in the chosen language too.
  r = await c.post('/login', { email: 'nobody@test.local', password: 'wrongpass' }, '/login');
  assert.match(r.text, /ای میل یا پاس ورڈ غلط ہے/);

  // Unknown language falls back to English; off-site redirects are refused.
  r = await c.get('/lang?code=xx&next=//evil.example');
  assert.strictEqual(r.location, '/');
  r = await c.get('/');
  assert.match(r.text, /<html lang="en" dir="ltr">/);
});
