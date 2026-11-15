// Minimal EJS-compatible template engine.
// Supports <%= escaped %>, <%- raw %>, <% code %> and include(path, data).
const fs = require('fs');
const path = require('path');

const cache = new Map();
const CACHE = process.env.NODE_ENV === 'production';

function escapeHtml(v) {
  if (v === null || v === undefined) return '';
  return String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function compile(src, file) {
  let code = 'let __out = "";\nwith (locals) {\n';
  const re = /<%([=-]?)([\s\S]*?)%>/g;
  let last = 0;
  let m;
  while ((m = re.exec(src))) {
    code += `__out += ${JSON.stringify(src.slice(last, m.index))};\n`;
    if (m[1] === '=') code += `__out += __esc(${m[2]});\n`;
    else if (m[1] === '-') code += `__out += (${m[2]}) ?? "";\n`;
    else code += m[2] + '\n';
    last = re.lastIndex;
  }
  code += `__out += ${JSON.stringify(src.slice(last))};\n}\nreturn __out;`;
  try {
    // Templates are trusted files from the views folder (never user input).
    return new Function('locals', '__esc', 'include', code); // eslint-disable-line no-new-func
  } catch (e) {
    e.message = `Template syntax error in ${file}: ${e.message}`;
    throw e;
  }
}

function load(file) {
  if (CACHE && cache.has(file)) return cache.get(file);
  const fn = compile(fs.readFileSync(file, 'utf8'), file);
  if (CACHE) cache.set(file, fn);
  return fn;
}

function renderFile(file, locals) {
  const fn = load(file);
  const include = (p, data) => {
    const child = path.resolve(path.dirname(file), p.endsWith('.ejs') ? p : p + '.ejs');
    return renderFile(child, { ...locals, ...data });
  };
  const scope = Object.assign(Object.create(null), locals);
  scope.locals = scope;
  return fn(scope, escapeHtml, include);
}

module.exports = { renderFile, escapeHtml };
