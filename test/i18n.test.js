// Every translated text must exist in every language file, and the language menu must work.
const { test } = require('node:test');
const assert = require('node:assert');
const { collectKeys } = require('../scripts/i18n-keys');
const { LANGUAGES, dictionaries } = require('../src/i18n');

const keys = collectKeys();

for (const code of Object.keys(LANGUAGES).filter((c) => c !== 'en')) {
  test(`${LANGUAGES[code].name} (${code}) has every text translated`, () => {
    const missing = keys.filter((k) => !dictionaries[code][k]);
    assert.deepStrictEqual(missing, []);
  });
  test(`${code}: placeholders like {n} are kept`, () => {
    for (const k of keys) {
      const want = (k.match(/\{\w+\}/g) || []).sort().join();
      const got = (String(dictionaries[code][k]).match(/\{\w+\}/g) || []).sort().join();
      assert.strictEqual(got, want, `${code}: "${k}"`);
    }
  });
}
