// Saved-rock entry assembly and labels. Stdlib only.
//
// Run: node --test web/pwa/saved.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DRY_NO_SUGGESTIONS,
  buildSavedEntry,
  cleanedLabel,
  formatDate,
  rowIdentity,
  savedDisplayNo,
} from './src/saved.js';

const BUNDLE = {
  photo: { file: 'blob-handle' },
  note: 'found by the creek',
};

function result(over = {}) {
  return {
    stone: { description: 'bright turquoise oval, smooth' },
    hardness: {
      cleaned: true,
      status: undefined,
      range: { lo: 5.5, hi: 6.5, approx: null, label: '5.5–6.5' },
    },
    suggestions: [
      {
        rank: 1, name: 'turquoise', supporting: ['blue-green color'],
        contradicting: ['could be dyed howlite'], next_check: 'streak test',
      },
    ],
    dry_run: false,
    ...over,
  };
}

test('entry keeps exactly the displayed fields', () => {
  const e = buildSavedEntry(BUNDLE, result(), 1, 5, 1720000000000);
  assert.deepEqual({ ...e, photo: 'x', suggestions: 'x' }, {
    photo: 'x',
    description: 'bright turquoise oval, smooth',
    hardness: '5.5–6.5',
    cleaned: true,
    note: 'found by the creek',
    suggestions: 'x',
    dryRun: false,
    bedNo: 1,
    origRank: 5,
    ts: 1720000000000,
  });
  assert.equal(e.photo, 'blob-handle');
  assert.deepEqual(e.suggestions, result().suggestions);
});

test('inconclusive hardness stores unknown', () => {
  const r = result({ hardness: { cleaned: false, status: 'inconclusive', range: null } });
  const e = buildSavedEntry(BUNDLE, r, 2, 5, 1);
  assert.equal(e.hardness, 'unknown');
  assert.equal(e.cleaned, false);
  assert.equal(e.bedNo, 2);
  assert.equal(e.origRank, 5);
});

test('display number prefers bedNo, falls back to bedId', () => {
  assert.equal(savedDisplayNo({ bedNo: 3, origRank: 9 }), 3);
  assert.equal(savedDisplayNo({ bedId: 4 }), 5);
  assert.equal(savedDisplayNo({}), null);
});

test('dry entry keeps flag, empty note defaults', () => {
  const r = result({ suggestions: [], dry_run: true });
  const e = buildSavedEntry({ photo: { file: 'b' }, note: '' }, r, 3, 7, 2);
  assert.equal(e.dryRun, true);
  assert.deepEqual(e.suggestions, []);
  assert.equal(e.note, '');
  assert.equal(DRY_NO_SUGGESTIONS, 'Dry run — no live suggestions');
});

test('row identity: top possible, dry, or none', () => {
  assert.equal(rowIdentity({ suggestions: [{ name: 'turquoise' }], dryRun: false }),
    'turquoise · possible — not confirmed');
  assert.equal(rowIdentity({ suggestions: [], dryRun: true }), 'Dry run');
  assert.equal(rowIdentity({ suggestions: [], dryRun: false }), 'No suggestions');
});

test('cleaned + date labels', () => {
  assert.deepEqual([cleanedLabel(true), cleanedLabel(false), cleanedLabel(null)],
    ['yes', 'no', 'unknown']);
  assert.ok(formatDate(1761945600000).includes('2025'));
});
