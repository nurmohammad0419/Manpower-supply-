// Starts the app on a random port with its own temporary database, and provides a
// small browser-like client (cookies + CSRF tokens) for tests.
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

function startApp(env = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'manpower-test-'));
  Object.assign(process.env, {
    DATA_DIR: path.join(tmp, 'data'), UPLOAD_DIR: path.join(tmp, 'uploads'),
    ADMIN_EMAIL: 'admin@test.local', ADMIN_PASSWORD: 'adminpass', ...env,
  });
  const app = require('../../src/server');
  const ctx = { base: '' };
  ctx.start = async () => {
    ctx.server = http.createServer(app.handle);
    await new Promise((r) => ctx.server.listen(0, r));
    ctx.base = `http://127.0.0.1:${ctx.server.address().port}`;
  };
  ctx.stop = () => { ctx.server.close(); fs.rmSync(tmp, { recursive: true, force: true }); };

  class Client {
    constructor() { this.jar = {}; }
    async req(method, url, body) {
      const headers = {};
      const cookie = Object.entries(this.jar).map(([k, v]) => `${k}=${v}`).join('; ');
      if (cookie) headers.cookie = cookie;
      let payload;
      if (body instanceof FormData) payload = body;
      else if (body) {
        const params = new URLSearchParams();
        for (const [k, v] of Object.entries(body)) for (const item of [].concat(v)) params.append(k, item);
        payload = params.toString();
        headers['content-type'] = 'application/x-www-form-urlencoded';
      }
      const res = await fetch(ctx.base + url, { method, headers, body: payload, redirect: 'manual' });
      for (const c of res.headers.getSetCookie()) {
        const [pair] = c.split(';');
        const i = pair.indexOf('=');
        this.jar[pair.slice(0, i)] = pair.slice(i + 1);
      }
      const text = await res.text();
      return { status: res.status, location: res.headers.get('location'), text, headers: res.headers };
    }
    get(url) { return this.req('GET', url); }
    async csrf(url = '/login') {
      const r = await this.get(url);
      const m = /name="_csrf" value="([a-f0-9]+)"/.exec(r.text);
      assert.ok(m, 'csrf token on ' + url);
      return m[1];
    }
    async post(url, fields, from = '/login') {
      const _csrf = await this.csrf(from);
      if (fields instanceof FormData) { fields.append('_csrf', _csrf); return this.req('POST', url, fields); }
      return this.req('POST', url, { ...fields, _csrf });
    }
  }
  ctx.Client = Client;

  // Admin confirms the agreement with the company and publishes the job for workers.
  ctx.publish = async (admin, demandId, overrides = {}) => {
    const page = await admin.get('/admin/demands/' + demandId);
    const val = (name) => (new RegExp(`name="${name}"[^>]*value="([^"]*)"`).exec(page.text) || [])[1];
    const sel = (name) => (new RegExp(`<select name="${name}"[^>]*>[\\s\\S]*?value="(\\w+)" selected`).exec(page.text) || [])[1];
    const fields = {
      salary_amount: val('salary_amount'), salary_type: sel('salary_type') || 'hourly', client_payment_days: val('client_payment_days') || '30',
      food: 'no', accommodation: 'no', transport: 'no',
      worker_rate: '10', worker_rate_type: 'hourly', worker_pay_days: '7',
      local_transport: '1', outside_accommodation: '1', outside_food: '1', worker_terms: '', agreement_signed: '1',
      ...overrides,
    };
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null) fd.append(k, String(v));
    return admin.post(`/admin/demands/${demandId}/publish`, fd, '/admin/demands/' + demandId);
  };
  return ctx;
}

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
const PDF = Buffer.from('%PDF-1.4\n%test\n');

module.exports = { startApp, PNG, PDF };
