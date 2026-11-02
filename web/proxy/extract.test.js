// Proxy-side assessment recovery. Stdlib only (CommonJS package).
//
// Run: node --test web/proxy/extract.test.js
//
// Fixture provenance: fixtures/closeup-stdout-v5.txt reconstructs the
// Oct 31 live close-up stdout. The proxy never logged the original bytes
// (v2.4 added failure logging), so nothing is captured verbatim; but
// nothing is invented either — the SAM progress lines come from the real
// sam_segment_photo prints with stubbed network only, and the assessment
// JSON comes from the real run_closeup dry path. Counts mirror the
// reported run: 70 SAM + 1 Spark.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  UNREADABLE_NOTE,
  assembleFallback,
  extractAssessment,
  fallbackParseError,
  mineCloseupErr,
} = require('./extract.js');

const FIXTURE = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'closeup-stdout-v5.txt'), 'utf8');

test('v5 polluted stdout fails a bare parse (the reported bug)', () => {
  assert.throws(() => JSON.parse(FIXTURE));
});

test('extraction recovers the v5 assessment', () => {
  const a = extractAssessment(FIXTURE);
  assert.equal(a.mode, 'closeup_assessment');
  assert.equal(a.hardness.range.label, '5.5–6.5');
  assert.equal(a.suggestions.length, 1);
  assert.equal(a.suggestions[0].name, 'turquoise');
  assert.equal(a.images_sent, 71);
});

test('clean stdout still extracts', () => {
  const body = JSON.stringify({ mode: 'closeup_assessment', stone: {}, suggestions: [] });
  assert.equal(extractAssessment(`${body}\n`).mode, 'closeup_assessment');
});

test('prefers the assessment among several objects', () => {
  const out = '{"log": "sam done"}\n{"mode": "closeup_assessment", "stone": {}} trailing';
  assert.equal(extractAssessment(out).mode, 'closeup_assessment');
});

test('garbage, empty, truncated, and non-objects yield null', () => {
  for (const bad of ['', 'no braces', '{"cut off', '[1, 2]', null, undefined, 42]) {
    assert.equal(extractAssessment(bad), null, String(bad));
  }
});

const LIVE_ERR = '  projected SAM calls: 70 (budget 700)\n'
  + '  scale 512px: 70 patches\n'
  + '  spark: close-up assessment\n'
  + 'dry.jpg: close-up (2620, 1315, 492, 492) source=tap, 71 images sent (sam 70 + spark 1)\n';

test('mining reads stage + counts from live stderr', () => {
  assert.deepEqual(mineCloseupErr(LIVE_ERR),
    { stage: 'Spark assessment', sent: 71, sam: 70, spark: 1 });
});

test('mining degrades honestly without a summary', () => {
  assert.equal(mineCloseupErr(''), null);
  const m = mineCloseupErr('  sam: done, 3 calls, 9 segments, 0 split events\n');
  assert.equal(m.stage, 'SAM segmentation');
  assert.equal(m.sent, null);
});

test('fallback keeps local stats with honest note + counts', () => {
  const dry = {
    mode: 'closeup_assessment', dry_run: true, images_sent: 0,
    sam_images: 0, spark_images: 0,
    stone: { box: [1, 2, 3, 4], description: 'mid-tone gray, smooth' },
    hardness: { range: { label: '5.5–6.5' } },
    suggestions: [], note: 'Live scan needed for possible identities.',
  };
  const fb = assembleFallback(dry,
    { stage: 'Spark assessment', sent: 71, sam: 70, spark: 1 });
  assert.equal(fb.note, UNREADABLE_NOTE);
  assert.equal(fb.note,
    'Live assessment could not be read — showing local description only.');
  assert.deepEqual([fb.images_sent, fb.sam_images, fb.spark_images], [71, 70, 1]);
  assert.equal(fb.dry_run, false);
  assert.deepEqual(fb.stone, dry.stone);
  assert.match(fb.parse_error, /Spark assessment \(71 images sent\)/);
  assert.match(fb.parse_error, /dashboard/);
});

test('fallback error without mined counts stays honest', () => {
  assert.match(fallbackParseError(null), /unconfirmed/);
  assert.match(fallbackParseError(null), /dashboard/);
  assert.match(fallbackParseError({ stage: null, sent: null, sam: null, spark: null }),
    /unconfirmed/);
});
