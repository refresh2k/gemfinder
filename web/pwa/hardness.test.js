// Guided scratch-test key, v2.1 semantics. Stdlib only.
//
// Run: node --test web/pwa/hardness.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NO_SCRATCH,
  STONE_SCRATCHES_TOOL as SST,
  TOOL_SCRATCHES_STONE as TSS,
  TOOLS,
  hardnessRange,
  lockedRange,
  stopLabel,
} from './src/hardness.js';

test('tools run soft to hard', () => {
  assert.deepEqual(TOOLS.map((t) => t.h), [2.5, 3, 5.5, 6.5]);
});

test('empty answers give nothing, first tool next', () => {
  const r = hardnessRange({});
  assert.equal(r.label, null);
  assert.equal(r.stopped, false);
  assert.equal(r.next, 0);
});

test('no-mark unlocks next, never final on its own', () => {
  const r = hardnessRange({ 0: NO_SCRATCH });
  assert.equal(r.label, null);
  assert.equal(r.stopped, false);
  assert.equal(r.next, 1);
  assert.equal(stopLabel({ 0: NO_SCRATCH }), null);
});

test('stone scratches unlocks next, no label yet', () => {
  const r = hardnessRange({ 0: SST });
  assert.equal(r.lo, 2.5);
  assert.equal(r.label, null);
  assert.equal(r.stopped, false);
  assert.equal(r.next, 1);
  assert.equal(stopLabel({ 0: SST }), 'over 2.5');
});

test('tool scratches stops with previous-to-this bracket', () => {
  const r = hardnessRange({ 0: NO_SCRATCH, 1: TSS });
  assert.deepEqual([r.lo, r.hi, r.label, r.stopped, r.next],
    [2.5, 3, '2.5–3', true, -1]);
  const r2 = hardnessRange({ 0: SST, 1: SST, 2: TSS });
  assert.equal(r2.label, '3–5.5');
});

test('first-tool upper bound stops open-ended', () => {
  const r = hardnessRange({ 0: TSS });
  assert.deepEqual([r.label, r.stopped], ['under 2.5', true]);
});

test('steel stone-scratch ends over 6.5', () => {
  const r = hardnessRange({ 0: SST, 1: SST, 2: SST, 3: SST });
  assert.deepEqual([r.label, r.stopped], ['over 6.5', true]);
});

test('steel no-mark with a bound ends near steel', () => {
  const r = hardnessRange({ 0: SST, 1: SST, 2: SST, 3: NO_SCRATCH });
  assert.deepEqual([r.label, r.stopped], ['about 6.5', true]);
});

test('all no-marks ends inconclusive, never a range', () => {
  const r = hardnessRange({ 0: NO_SCRATCH, 1: NO_SCRATCH, 2: NO_SCRATCH, 3: NO_SCRATCH });
  assert.equal(r.label, null);
  assert.equal(r.stopped, true);
  assert.equal(r.inconclusive, true);
});

test('later hard bound clears a stale near-miss', () => {
  const r = hardnessRange({ 0: NO_SCRATCH, 1: SST });
  assert.equal(r.lo, 3);
  assert.equal(r.approx, null);
  assert.equal(stopLabel({ 0: NO_SCRATCH, 1: SST }), 'over 3');
});

test('stop uses the latest near-miss over an older bound', () => {
  assert.equal(stopLabel({ 0: SST, 1: NO_SCRATCH }), 'about 3');
});

test('gap ends the run, unknown outcome ignored', () => {
  assert.equal(hardnessRange({ 1: TSS }).next, 0);
  assert.equal(hardnessRange({ 0: 'maybe' }).next, 0);
});

test('manual stop locks the label and ends the run', () => {
  const r = lockedRange({ answers: { 0: SST }, stopped: 'over 2.5' });
  assert.deepEqual([r.lo, r.hi, r.label, r.stopped, r.next],
    [2.5, null, 'over 2.5', true, -1]);
});

test('automatic stop wins over a stale manual label', () => {
  const r = lockedRange({ answers: { 0: SST, 1: TSS }, stopped: 'over 2.5' });
  assert.equal(r.label, '2.5–3');
});

test('missing scratch state behaves as unanswered', () => {
  assert.equal(lockedRange(undefined).next, 0);
  assert.equal(lockedRange({}).label, null);
});

const ALL_NO = { 0: NO_SCRATCH, 1: NO_SCRATCH, 2: NO_SCRATCH, 3: NO_SCRATCH };

test('scan-anyway unlocks only a genuinely inconclusive run', () => {
  const r = lockedRange({ answers: ALL_NO, unknown: true });
  assert.equal(r.unknown, true);
  assert.equal(r.label, null);
  assert.equal(r.stopped, true);
});

test('scan-anyway is ignored without a full inconclusive run', () => {
  assert.equal(lockedRange({ answers: { 0: NO_SCRATCH }, unknown: true }).unknown, undefined);
  assert.equal(lockedRange({ answers: {}, unknown: true }).unknown, undefined);
});

test('a real range wins over a stale scan-anyway flag', () => {
  const r = lockedRange({ answers: { 0: SST, 1: TSS }, unknown: true });
  assert.equal(r.label, '2.5–3');
  assert.equal(r.unknown, undefined);
});
