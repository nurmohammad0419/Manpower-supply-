// A small, dependency-free web framework (Express-like API) built on Node's http module.
// Provides: routing with :params, middleware, urlencoded + multipart body parsing,
// sessions stored in SQLite, static files, and EJS-style template rendering.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { renderFile } = require('./template');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8',
};

function compilePath(p) {
  const keys = [];
  const re = p.replace(/[.+*?^${}()|[\]\\]/g, '\\$&').replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; });
  return { regex: new RegExp('^' + re + '/?$'), keys };
}

function createApp() {
  const routes = [];
  const settings = {};

  function add(method, p, handlers) {
    const { regex, keys } = p ? compilePath(p) : { regex: null, keys: [] };
    routes.push({ method, regex, keys, handlers });
  }

  const app = {
    set: (k, v) => { settings[k] = v; },
    use: (...fns) => add(null, null, fns),
    get: (p, ...fns) => add('GET', p, fns),
    post: (p, ...fns) => add('POST', p, fns),
    handle,
    listen: (port, cb) => http.createServer(handle).listen(port, cb),
  };

  function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    try { req.path = decodeURIComponent(url.pathname); } catch { req.path = url.pathname; }
    req.originalUrl = req.url;
    req.query = Object.fromEntries(url.searchParams);
    req.params = {};
    req.body = {};
    req.is = (type) => String(req.headers['content-type'] || '').toLowerCase().startsWith(type);
    decorateResponse(req, res, settings);

    // Flatten into a list of matching handlers and run them in sequence.
    const chain = [];
    for (const r of routes) {
      if (r.method && r.method !== req.method && !(r.method === 'GET' && req.method === 'HEAD')) continue;
      if (r.regex) {
        const m = r.regex.exec(req.path);
        if (!m) continue;
        const params = {};
        r.keys.forEach((k, i) => { params[k] = m[i + 1]; });
        for (const h of r.handlers) chain.push({ h, params });
      } else {
        for (const h of r.handlers) chain.push({ h, params: null });
      }
    }
    let i = 0;
    const errorHandlers = chain.filter((c) => c.h.length === 4);
    const normal = chain.filter((c) => c.h.length !== 4);
    function next(err) {
      if (res.writableEnded) return;
      if (err) {
        const eh = errorHandlers.shift();
        if (eh) { try { return eh.h(err, req, res, next); } catch (e) { return fatal(e); } }
        return fatal(err);
      }
      const c = normal[i++];
      if (!c) return res.status(404).send('Not found');
      if (c.params) req.params = c.params;
      try {
        const out = c.h(req, res, next);
        if (out && typeof out.catch === 'function') out.catch(next);
      } catch (e) { next(e); }
    }
    function fatal(e) {
      console.error(e);
      if (!res.headersSent) { res.statusCode = 500; res.setHeader('Content-Type', 'text/plain'); }
      res.end('Internal server error');
    }
    next();
  }

  return app;
}

function decorateResponse(req, res, settings) {
  res.locals = {};
  res._hooks = [];
  const commit = () => { while (res._hooks.length) res._hooks.shift()(); };
  res.status = (code) => { res.statusCode = code; return res; };
  res.type = (t) => { res.setHeader('Content-Type', t); return res; };
  res.set = (k, v) => { res.setHeader(k, v); return res; };
  res.send = (body) => {
    commit();
    if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(req.method === 'HEAD' ? undefined : body);
  };
  res.redirect = (url) => {
    commit();
    res.statusCode = 302;
    res.setHeader('Location', url);
    res.end();
  };
  res.render = (view, data = {}) => {
    const file = path.join(settings.views, view + '.ejs');
    let html;
    try { html = renderFile(file, { ...res.locals, ...data }); } catch (e) {
      e.message = `Rendering ${view}: ${e.message}`;
      throw e;
    }
    res.send(html);
  };
  res.sendFile = (file) => {
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) { res.statusCode = 404; return res.send('Not found'); }
      commit();
      if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
      res.setHeader('Content-Length', st.size);
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file).pipe(res);
    });
  };
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
}

// ---------- Middleware ----------
function serveStatic(root) {
  const base = path.resolve(root);
  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const file = path.resolve(base, '.' + req.path);
    if (!file.startsWith(base + path.sep)) return next();
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) return next();
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.sendFile(file);
    });
  };
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('Upload is too large.'), { code: 'LIMIT_FILE_SIZE' })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function addField(obj, key, value) {
  if (key in obj) obj[key] = [].concat(obj[key], value);
  else obj[key] = value;
}

function urlencoded() {
  return async (req, res, next) => {
    if (req.method !== 'POST' || !req.is('application/x-www-form-urlencoded')) return next();
    try {
      const buf = await readBody(req, 1024 * 1024);
      const body = Object.create(null);
      for (const [k, v] of new URLSearchParams(buf.toString('utf8'))) addField(body, k, v);
      req.body = body;
      next();
    } catch (e) { next(e); }
  };
}

// Sessions: random id in an HttpOnly cookie, data stored as JSON in SQLite.
function sessions({ db, maxAgeMs, secure }) {
  db.exec(`CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, data TEXT NOT NULL, expires INTEGER NOT NULL)`);
  const get = db.prepare('SELECT data FROM sessions WHERE id = ? AND expires > ?');
  const put = db.prepare('INSERT INTO sessions (id, data, expires) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data, expires=excluded.expires');
  const del = db.prepare('DELETE FROM sessions WHERE id = ?');
  const purge = db.prepare('DELETE FROM sessions WHERE expires <= ?');
  setInterval(() => purge.run(Date.now()), 60 * 60 * 1000).unref();

  return (req, res, next) => {
    const cookies = Object.fromEntries(String(req.headers.cookie || '').split(';').map((c) => {
      const i = c.indexOf('=');
      return i < 0 ? [c.trim(), ''] : [c.slice(0, i).trim(), decodeURIComponent(c.slice(i + 1).trim())];
    }));
    let sid = /^[a-f0-9]{64}$/.test(cookies.sid || '') ? cookies.sid : null;
    const row = sid && get.get(sid, Date.now());
    let data = row ? JSON.parse(row.data) : {};
    if (!row) sid = null;

    const makeSession = (d) => {
      const s = Object.assign(Object.create(null), d);
      Object.defineProperties(s, {
        regenerate: { value: (cb) => { if (sid) del.run(sid); sid = null; req.session = makeSession({}); cb(); } },
        destroy: { value: (cb) => { if (sid) del.run(sid); sid = null; req.session = makeSession({}); req.session._destroyed = true; cb(); } },
      });
      return s;
    };
    req.session = makeSession(data);

    res._hooks.push(() => {
      const s = req.session;
      const json = JSON.stringify({ ...s, _destroyed: undefined });
      const cookieBase = `; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
      const setCookie = (v) => res.setHeader('Set-Cookie', [].concat(res.getHeader('Set-Cookie') || [], v));
      if (s._destroyed) { setCookie('sid=' + cookieBase + '; Max-Age=0'); return; }
      if (json === '{}' && !sid) return; // nothing to store
      if (!sid) sid = crypto.randomBytes(32).toString('hex');
      put.run(sid, json, Date.now() + maxAgeMs); // sliding expiry
      setCookie(`sid=${sid}${cookieBase}; Max-Age=${Math.floor(maxAgeMs / 1000)}`);
    });
    next();
  };
}

// ---------- Multipart (file upload) parsing ----------
function parseMultipart(buf, boundary) {
  const parts = [];
  const delim = Buffer.from('--' + boundary);
  let pos = buf.indexOf(delim);
  while (pos !== -1) {
    pos += delim.length;
    if (buf.slice(pos, pos + 2).toString() === '--') break;
    pos += 2; // CRLF
    const headerEnd = buf.indexOf('\r\n\r\n', pos);
    if (headerEnd === -1) break;
    const headers = buf.slice(pos, headerEnd).toString('utf8');
    const next = buf.indexOf(delim, headerEnd + 4);
    if (next === -1) break;
    const content = buf.slice(headerEnd + 4, next - 2); // strip trailing CRLF
    const disp = /content-disposition:[^\r\n]*/i.exec(headers)?.[0] || '';
    const name = /\bname="([^"]*)"/i.exec(disp)?.[1];
    const filename = /\bfilename="([^"]*)"/i.exec(disp)?.[1];
    const type = /content-type:\s*([^\r\n;]+)/i.exec(headers)?.[1]?.trim().toLowerCase();
    if (name !== undefined) parts.push({ name, filename, type, content });
    pos = next;
  }
  return parts;
}

// Check real file contents, not only the browser-reported type.
function sniffMime(b) {
  if (b.length >= 4 && b.slice(0, 4).toString('latin1') === '%PDF') return 'application/pdf';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length >= 12 && b.slice(0, 4).toString('latin1') === 'RIFF' && b.slice(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

const EXT = { 'application/pdf': '.pdf', 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };

// upload({ dir, maxFileSize, allowedFields, allowedMimes }) → middleware filling req.body and req.files
function upload({ dir, maxFileSize, maxFiles, allowedFields, allowedMimes = Object.keys(EXT) }) {
  return async (req, res, next) => {
    if (req.method !== 'POST' || !req.is('multipart/form-data')) return next();
    const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(req.headers['content-type'] || '');
    if (!boundary) return next(Object.assign(new Error('Bad upload.'), { userError: true }));
    try {
      const buf = await readBody(req, maxFileSize * maxFiles + 1024 * 1024);
      const body = Object.create(null);
      const files = Object.create(null);
      for (const p of parseMultipart(buf, boundary[1] || boundary[2])) {
        if (p.filename === undefined) { addField(body, p.name, p.content.toString('utf8')); continue; }
        if (!p.filename || !p.content.length) continue; // empty file input
        if (!allowedFields.includes(p.name)) continue;
        if (p.content.length > maxFileSize) throw Object.assign(new Error('File is too large. Maximum size is {mb} MB.'), { userError: true, params: { mb: Math.round(maxFileSize / 1048576) } });
        const mime = sniffMime(p.content);
        if (!mime) throw Object.assign(new Error('"{file}" is not a PDF, JPG, PNG or WEBP file.'), { userError: true, params: { file: path.basename(p.filename) } });
        if (!allowedMimes.includes(mime)) throw Object.assign(new Error('"{file}" must be a JPG, PNG or WEBP image.'), { userError: true, params: { file: path.basename(p.filename) } });
        (files[p.name] ||= []).push({ originalname: path.basename(p.filename).slice(0, 200), mimetype: mime, content: p.content });
      }
      // Only write files once the whole request is valid.
      for (const list of Object.values(files)) {
        for (const f of list) {
          f.filename = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${EXT[f.mimetype]}`;
          fs.writeFileSync(path.join(dir, f.filename), f.content);
          f.size = f.content.length;
          delete f.content;
        }
      }
      req.body = body;
      req.files = files;
      next();
    } catch (e) {
      if (e.code === 'LIMIT_FILE_SIZE') { e.message = 'File is too large. Maximum size is {mb} MB.'; e.params = { mb: Math.round(maxFileSize / 1048576) }; }
      e.userError = true;
      next(e);
    }
  };
}

module.exports = { createApp, serveStatic, urlencoded, sessions, upload };
