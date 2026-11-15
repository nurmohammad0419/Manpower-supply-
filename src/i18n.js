// Translations. English is the main language and the fallback: any text without a
// translation is shown in English. Translation files live in src/locales/<code>.json and
// map the English text to the translated text.
const fs = require('fs');
const path = require('path');

const LANGUAGES = {
  en: { name: 'English', dir: 'ltr', locale: 'en-GB' },
  bn: { name: 'বাংলা', dir: 'ltr', locale: 'bn-BD' },
  hi: { name: 'हिन्दी', dir: 'ltr', locale: 'hi-IN' },
  ur: { name: 'اردو', dir: 'rtl', locale: 'ur-PK' },
  ne: { name: 'नेपाली', dir: 'ltr', locale: 'ne-NP' },
  si: { name: 'සිංහල', dir: 'ltr', locale: 'si-LK' },
  ar: { name: 'العربية', dir: 'rtl', locale: 'ar-SA' },
  tl: { name: 'Filipino', dir: 'ltr', locale: 'fil-PH' },
};
const DEFAULT_LANG = 'en';

const dictionaries = {};
for (const code of Object.keys(LANGUAGES)) {
  const file = path.join(__dirname, 'locales', code + '.json');
  dictionaries[code] = code === DEFAULT_LANG || !fs.existsSync(file) ? {} : JSON.parse(fs.readFileSync(file, 'utf8'));
}

function translator(lang) {
  const dict = dictionaries[lang] || {};
  return (key, params) => {
    let s = dict[key] || key;
    if (params) s = String(s).replace(/\{(\w+)\}/g, (m, k) => (params[k] !== undefined ? params[k] : m));
    return s;
  };
}

function pickLanguage(req) {
  const m = /(?:^|;\s*)lang=([a-z]{2})/.exec(req.headers.cookie || '');
  return m && LANGUAGES[m[1]] ? m[1] : DEFAULT_LANG;
}

module.exports = { LANGUAGES, DEFAULT_LANG, dictionaries, translator, pickLanguage };
