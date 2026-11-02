// Proxy cost-range math. Stdlib only (CommonJS package).
//
// Run: node --test web/proxy/projection.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { costRange, rates } = require('./cost.js');

test('bed-shaped projection prices inside the standing estimate', () => {
  // 70 SAM calls ($0.175) + 300 capped Spark crops.
  assert.deepEqual(costRange(70, 300), { min: 0.78, max: 1.98 });
});

test('zero crops leaves SAM only, min equals max', () => {
  assert.deepEqual(costRange(70, 0), { min: 0.18, max: 0.18 });
});

test('more calls never costs less', () => {
  const a = costRange(70, 300);
  const b = costRange(336, 300);
  assert.ok(b.min >= a.min && b.max >= a.max);
});

test('env overrides apply, garbage falls back to defaults', () => {
  const save = { ...process.env };
  try {
    process.env.SAM_USD_PER_1K = '10';
    process.env.SPARK_USD_PER_1K_MIN = '1';
    process.env.SPARK_USD_PER_1K_MAX = '2';
    assert.deepEqual(costRange(1000, 1000), { min: 11, max: 12 });
    process.env.SAM_USD_PER_1K = 'nope';
    process.env.SPARK_USD_PER_1K_MIN = '-5';
    delete process.env.SPARK_USD_PER_1K_MAX;
    assert.deepEqual(rates(), { samPer1k: 2.5, sparkPer1kMin: 2, sparkPer1kMax: 6 });
  } finally {
    for (const k of ['SAM_USD_PER_1K', 'SPARK_USD_PER_1K_MIN', 'SPARK_USD_PER_1K_MAX']) {
      if (save[k] === undefined) delete process.env[k];
      else process.env[k] = save[k];
    }
  }
});
