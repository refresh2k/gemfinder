// Persistent key loading. Stdlib only (CommonJS package). Uses injected
// env/readers only — never touches the real file or environment.
//
// Run: node --test web/proxy/apikey.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { keyFilePath, loadApiKey } = require('./apikey.js');

test('explicit env value wins without reading the file', () => {
  let reads = 0;
  const got = loadApiKey({
    env: { MODEL_API_KEY: '  env-key ' },
    readFile: () => { reads += 1; return 'file-key'; },
    homedir: '/home/u',
  });
  assert.deepEqual(got, { key: 'env-key', source: 'env' });
  assert.equal(reads, 0);
});

test('falls back to the key file, trimmed', () => {
  let seen;
  const got = loadApiKey({
    env: {},
    readFile: (p) => { seen = p; return '  file-key\n'; },
    homedir: '/home/u',
  });
  assert.deepEqual(got, { key: 'file-key', source: 'file' });
  assert.equal(seen, '/home/u/.model_api_key');
});

test('MODEL_API_KEY_FILE overrides the path', () => {
  const got = loadApiKey({
    env: { MODEL_API_KEY_FILE: '/run/key' },
    readFile: (p) => (p === '/run/key' ? 'k' : ''),
    homedir: '/home/u',
  });
  assert.deepEqual(got, { key: 'k', source: 'file' });
  assert.equal(keyFilePath({ MODEL_API_KEY_FILE: '/run/key' }, '/home/u'), '/run/key');
});

test('missing, unreadable, or blank file means no key', () => {
  assert.deepEqual(loadApiKey({
    env: {}, readFile: () => { throw new Error('ENOENT'); }, homedir: '/x',
  }), { key: null, source: null });
  assert.deepEqual(loadApiKey({
    env: { MODEL_API_KEY: '   ' },
    readFile: () => '\n  \n', homedir: '/x',
  }), { key: null, source: null });
});
