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
      else if (body) { payload = new URLSearchParams(body).toString(); headers['content-type'] = 'application/x-www-form-urlencoded'; }
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
  return ctx;
}

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
const PDF = Buffer.from('%PDF-1.4\n%test\n');

module.exports = { startApp, PNG, PDF };
