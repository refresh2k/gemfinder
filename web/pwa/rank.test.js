// Bed-list 85% confidence filter. Stdlib only.
//
// Run: node --test web/pwa/rank.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { SCORE_CUTOFF, displayNumber, keptCandidates, scoreLabel } from './src/rank.js';

test('keeps score >= 0.85, boundary inclusive', () => {
  assert.equal(SCORE_CUTOFF, 0.85);
  const rows = [
    { id: 0, score: 0.99 },
    { id: 1, score: 0.85 },
    { id: 2, score: 0.849 },
    { id: 3, score: 0.8 },
    { id: 4, score: 0.1 },
  ];
  assert.deepEqual(keptCandidates(rows).map((c) => c.id), [0, 1]);
});

test('order preserved, empty and null safe', () => {
  assert.deepEqual(keptCandidates([]), []);
  assert.deepEqual(keptCandidates(null), []);
  assert.deepEqual(keptCandidates(undefined), []);
});

test('score label reads N% confidence', () => {
  assert.equal(scoreLabel(1), '100% confidence');
  assert.equal(scoreLabel(0.98), '98% confidence');
  assert.equal(scoreLabel(0.95), '95% confidence');
  assert.equal(scoreLabel(0.9), '90% confidence');
  assert.equal(scoreLabel(0.85), '85% confidence');
  assert.equal(scoreLabel(0.849), '85% confidence');
});

test('display number is filtered position, not original id', () => {
  const kept = [{ id: 7, score: 0.95 }, { id: 2, score: 0.91 }];
  assert.equal(displayNumber(kept, 7), 1);
  assert.equal(displayNumber(kept, 2), 2);
  assert.equal(displayNumber(kept, 9), null);
  assert.equal(displayNumber([], 7), null);
  assert.equal(displayNumber(null, 7), null);
});
