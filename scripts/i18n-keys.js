// Collects every English text that the site translates.
// `node scripts/i18n-keys.js` prints the keys missing from each language file.
const fs = require('fs');
const path = require('path');
const {
  CATEGORIES, DOC_TYPES, CITIES, SALARY_TYPES, APP_STATUS, NATIONALITIES, KAFALA_OPTIONS, DRIVING_OPTIONS, NOTIFY_CHANNELS, FIELD_TYPES,
} = require('../src/constants');

const root = path.join(__dirname, '..');

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

function collectKeys() {
  const keys = new Set();
  const add = (k) => { if (k && /[A-Za-z]/.test(k)) keys.add(k); };

  for (const file of walk(path.join(root, 'views'))) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/\bt\('((?:[^'\\]|\\.)+)'/g)) add(m[1]);
    for (const m of src.matchAll(/\b(?:approved|rejected|pending): '([^']+)'/g)) add(m[1]);
    for (const m of src.matchAll(/\['\w+', '([^']+)'\]/g)) add(m[1]);
    for (const m of src.matchAll(/\bt\([^()]*?\? '([^']+)' : '([^']+)'\)/g)) { add(m[1]); add(m[2]); }
    for (const m of src.matchAll(/\b(?:sent|failed|not_sent|pending): '([^']+)'/g)) add(m[1]);
  }

  const server = fs.readFileSync(path.join(root, 'src/server.js'), 'utf8');
  const patterns = [
    /flash\(req, [^,]+, '([^']+)'/g,
    /\b(?:title|message|error): '([^']+)'/g,
    /error = '([^']+)'/g,
    /&& '([^']+)'\)/g,
    /return '([^']+)';/g,
    /\b(?:yes|no|allowance|approved|rejected|pending): '([^']+)'/g,
    /\b(?:shortlisted|hired): '([^']+)'/g,
    /notifyUser\([^,]+, '([^']+)'/g,
    /req\.t\('([^']+)'/g,
  ];
  for (const re of patterns) for (const m of server.matchAll(re)) add(m[1]);
  // Titles of pages rendered with a variable title are user content and not translated.

  const notify = fs.readFileSync(path.join(root, 'src/notify.js'), 'utf8');
  for (const m of notify.matchAll(/\bt\('([^']+)'/g)) add(m[1]);

  const web = fs.readFileSync(path.join(root, 'src/lib/web.js'), 'utf8');
  for (const m of web.matchAll(/new Error\('([^']+)'\)/g)) add(m[1]);
  for (const m of web.matchAll(/e\.message = '([^']+)'/g)) add(m[1]);

  [CATEGORIES, Object.values(DOC_TYPES), CITIES, Object.values(SALARY_TYPES), Object.values(APP_STATUS), NATIONALITIES,
    Object.values(KAFALA_OPTIONS), Object.values(DRIVING_OPTIONS), Object.values(NOTIFY_CHANNELS), Object.values(FIELD_TYPES)]
    .forEach((list) => list.forEach(add));
  ['Open', 'Closed'].forEach(add);
  return [...keys].filter((k) => !/^\/|^[a-z_]+$/.test(k)).sort();
}

module.exports = { collectKeys };

if (require.main === module) {
  const { LANGUAGES, dictionaries } = require('../src/i18n');
  const keys = collectKeys();
  if (process.argv.includes('--list')) { console.log(JSON.stringify(keys, null, 1)); process.exit(0); }
  let missingTotal = 0;
  for (const code of Object.keys(LANGUAGES)) {
    if (code === 'en') continue;
    const missing = keys.filter((k) => !dictionaries[code][k]);
    missingTotal += missing.length;
    console.log(`${code}: ${keys.length - missing.length}/${keys.length}` + (missing.length ? `  missing: ${JSON.stringify(missing.slice(0, 10))}` : ''));
  }
  process.exit(missingTotal ? 1 : 0);
}
