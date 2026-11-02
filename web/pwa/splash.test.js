// Splash prompt trigger (bed scan only). Stdlib only.
//
// Run: node --test web/pwa/splash.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SPLASH_COPY, SPLASH_PRIMARY, SPLASH_DISMISS, shouldPromptSplash,
} from './src/splash.js';

test('prompt copy is exact', () => {
  assert.equal(
    SPLASH_COPY,
    'No candidates at 85% confidence or above found. Splash the bed with '
    + 'water and reshoot — wet stones show color and contrast that dry stones hide.',
  );
  assert.equal(SPLASH_PRIMARY, 'Splash and reshoot');
  assert.equal(SPLASH_DISMISS, 'Dismiss');
});

test('prompts only for live scans filtering to 0', () => {
  assert.equal(shouldPromptSplash('live', 0, false), true);
  assert.equal(shouldPromptSplash('live', 1, false), false);
  assert.equal(shouldPromptSplash('live', 24, false), false);
  assert.equal(shouldPromptSplash('live', 0, true), false);
  assert.equal(shouldPromptSplash('dry', 0, false), false);
  assert.equal(shouldPromptSplash('demo', 0, false), false);
  assert.equal(shouldPromptSplash('', 0, false), false);
  assert.equal(shouldPromptSplash('live', null, false), false);
});
