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

test('company posts a demand (hidden until approved)', async () => {
  const r = await company.post('/company/demands', {
    title: 'Electrician for villa project', category: 'Electrician', quantity: '1', salary_amount: '15',
    salary_type: 'hourly', hours_per_day: '10', days_per_week: '6', duration: '3 months', location_city: 'Riyadh',
    food: 'yes', accommodation: 'yes', transport: 'allowance', required_docs: 'iqama', overtime: '1.5x', deadline: '',
  });
  assert.strictEqual(r.status, 302);
  demandId = r.location.split('/').pop();
  const pub = await new Client().get('/demands');
  assert.doesNotMatch(pub.text, /Electrician for villa project/);
});

test('admin approves the company', async () => {
  let r = await admin.post('/login', { email: 'admin@test.local', password: 'adminpass' }, '/login');
  assert.strictEqual(r.location, '/admin');
  r = await admin.get('/admin');
  assert.match(r.text, /Al Noor Contracting/);
  const companyId = /\/admin\/companies\/(\d+)\/status/.exec(r.text)[1];
  r = await admin.post(`/admin/companies/${companyId}/status`, { status: 'approved' }, '/admin');
  assert.strictEqual(r.status, 302);
  const pub = await new Client().get('/demands?category=Electrician');
  assert.match(pub.text, /Electrician for villa project/);
});

test('demand letter is printable', async () => {
  const r = await new Client().get(`/demands/${demandId}/letter`);
  assert.strictEqual(r.status, 200);
  assert.match(r.text, /DEMAND LETTER/);
  assert.match(r.text, /1010123456/);
});

test('worker registers and uploads documents', async () => {
  let r = await worker.post('/register/worker', {
    full_name: 'Rahim Uddin', nationality: 'Bangladesh', profession: 'Electrician', experience_years: '5',
    phone: '+966500000002', email: 'rahim@test.local', password: 'secret12', password_confirm: 'secret12',
  });
  assert.strictEqual(r.location, '/worker/documents');

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

test('other companies cannot see the worker documents', async () => {
  await otherCompany.post('/register/company', {
    company_name: 'Other Co', cr_number: '999', contact_person: 'B', city: 'Jeddah',
    phone: '1', email: 'other@test.local', password: 'secret12', password_confirm: 'secret12',
  });
  const r = await otherCompany.get('/documents/' + docId);
  assert.strictEqual(r.status, 404);
  const r2 = await otherCompany.get(`/company/demands/${demandId}`);
  assert.strictEqual(r2.status, 404);
});

test('company reviews the applicant and hires', async () => {
  let r = await company.get(`/company/demands/${demandId}`);
  assert.match(r.text, /Rahim Uddin/);
  applicationId = /\/company\/applications\/(\d+)"/.exec(r.text)[1];
  r = await company.get('/company/applications/' + applicationId);
  assert.match(r.text, /Iqama \(Residence ID\)/);
  assert.strictEqual((await company.get('/documents/' + docId)).status, 200);
  r = await company.post(`/company/applications/${applicationId}/status`, { status: 'hired', company_note: 'Report Sunday 7 AM' }, '/company');
  assert.strictEqual(r.status, 302);
  r = await worker.get('/worker');
  assert.match(r.text, /badge-hired/);
  assert.match(r.text, /Report Sunday 7 AM/);
});

test('cannot hire more than the demanded quantity', async () => {
  await worker2.post('/register/worker', {
    full_name: 'Karim', nationality: 'Nepal', profession: 'Electrician', phone: '3',
    email: 'karim@test.local', password: 'secret12', password_confirm: 'secret12',
  });
  const fd = new FormData();
  fd.append('doc_iqama', new Blob([PDF], { type: 'application/pdf' }), 'iqama.pdf');
  await worker2.post(`/demands/${demandId}/apply`, fd, `/demands/${demandId}`);
  let r = await company.get(`/company/demands/${demandId}`);
  const ids = [...r.text.matchAll(/\/company\/applications\/(\d+)"/g)].map((m) => m[1]);
  const second = ids.find((id) => id !== applicationId);
  await company.post(`/company/applications/${second}/status`, { status: 'hired' }, '/company');
  r = await company.get('/company/applications/' + second);
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
  let r = await c.get('/lang?code=bn&next=/demands');
  assert.strictEqual(r.location, '/demands');
  r = await c.get('/demands');
  assert.match(r.text, /<html lang="bn" dir="ltr">/);
  assert.match(r.text, /কাজের ডিমান্ড/);
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
