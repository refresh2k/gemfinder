// Price-wording scrub. Stdlib only.
//
// Run: node --test web/pwa/scrub.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { scrubPriceWording } from './src/scrub.js';

test('strips the dashboard note', () => {
  assert.equal(
    scrubPriceWording('Live close-up reached Spark assessment (71 images sent) '
      + 'but the assessment could not be read. '
      + 'Check the dashboard for actual billing.'),
    'Live close-up reached Spark assessment (71 images sent) '
      + 'but the assessment could not be read.');
});

test('strips dollar amounts and ranges', () => {
  assert.equal(scrubPriceWording('Estimated $0.18–$0.18 total.'),
    'Estimated total.');
  assert.equal(scrubPriceWording('about $1–2 per scan'), 'about per scan');
});

test('rewords the budget guard without spend', () => {
  assert.equal(
    scrubPriceWording('projected 800 SAM calls exceed the 700 per-photo '
      + 'budget; stopping before spending'),
    'projected 800 SAM calls exceed the 700 per-photo '
      + 'budget; stopping before sending');
});

test('clean text passes through untouched', () => {
  for (const ok of ['Live scan did not reach the server. No live call was made.',
    'close-up failed during Spark assessment (3 images sent): socket closed',
    'Dry runs send nothing.',
    'live scans unavailable — proxy key missing.',
    'No live call was made.']) {
    assert.equal(scrubPriceWording(ok), ok);
  }
  assert.equal(scrubPriceWording(null), '');
  assert.equal(scrubPriceWording(''), '');
});
