// Tap-to-zoom proof on real report boxes. Stdlib only.
//
// Run: node --test web/pwa/zoom.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromeSizes, toggleFocus, zoomForBox } from './src/zoom.js';

// Boxes copied verbatim from banked 300-candidate report
// runs/reports/dry.20261029T232604Z.json, in raw-pixel space (4000x3000:
// the CLI segments raw bytes). Display-space mapping is covered in
// exif.test.js; the cross-check below fails loudly if literals drift.
const W = 4000;
const H = 3000;
const CASES = [
  { id: 0, box: [2689, 1719, 96, 73] },
  { id: 2, box: [2572, 1202, 64, 57] },
  { id: 299, box: [26, 1302, 57, 19] },
];

test('fixtures match the banked 300-candidate report', { skip: !banked() }, () => {
  const r = banked();
  assert.equal(r.candidates.length, 300, 'banked report holds 300');
  for (const { id, box } of CASES) {
    const c = r.candidates.find((x) => x.id === id);
    assert.deepEqual(c.box, box, `id ${id} box matches banked JSON`);
  }
});

function banked() {
  try {
    return JSON.parse(readFileSync(
      new URL('../../runs/reports/dry.20261029T232604Z.json', import.meta.url)));
  } catch {
    return null;
  }
}

test('tap selects, second tap clears, other tap switches', () => {
  assert.equal(toggleFocus(null, 2), 2);
  assert.equal(toggleFocus(2, 2), null);
  assert.equal(toggleFocus(2, 0), 0);
});

for (const { id, box } of CASES) {
  test(`id ${id}: zoom centers that candidate's JSON box`, () => {
    const [x, y, w, h] = box;
    const cx = (x + w / 2) / W;
    const cy = (y + h / 2) / H;
    const { s, txPct, tyPct } = zoomForBox(W, H, box);
    assert.ok(s >= 2.5 && s <= 10, `scale ${s} in range`);
    const tx = txPct / 100;
    const ty = tyPct / 100;
    // Coverage: scaled photo spans the whole view (never void).
    assert.ok(tx <= 0 && tx + s >= 1, 'x covers view');
    assert.ok(ty <= 0 && ty + s >= 1, 'y covers view');
    // Centering: box center maps to view center unless clamped at an edge.
    for (const [c, t, axis] of [[cx, tx, 'x'], [cy, ty, 'y']]) {
      const mapped = s * c + t;
      const clamped = t === 0 || t === 1 - s;
      if (clamped) {
        assert.ok(mapped >= 0 && mapped <= 1, `${axis} stays on screen`);
      } else {
        assert.ok(Math.abs(mapped - 0.5) < 1e-9, `${axis} centered`);
      }
    }
  });
}

test('overlay chrome holds constant screen size under zoom', () => {
  const su = 8; // 4000px photo
  const plain = chromeSizes(su, 1, false);
  assert.deepEqual(plain, {
    stroke: 24, badgeW: 160, badgeH: 192, badgeDy: 208,
    font: 136, textDx: 32, textDy: 152,
  });
  // At 10x every chrome size shrinks 10x in photo px, so on screen
  // (photo px times scale) nothing grows: the phone bug was chrome
  // drawn at full photo-px size under zoom.
  for (const s of [2.5, 10]) {
    for (const hot of [false, true]) {
      const ch = chromeSizes(su, s, hot);
      const ref = chromeSizes(su, 1, hot);
      for (const k of Object.keys(ref)) {
        assert.equal(ch[k] * s, ref[k], `${k} screen-constant at ${s}x`);
      }
    }
  }
  assert.ok(chromeSizes(su, 10, true).stroke > chromeSizes(su, 10, false).stroke,
    'focused outline stays thicker than dimmed');
});

test('smaller boxes zoom deeper', () => {
  const big = zoomForBox(W, H, [1000, 1000, 400, 400]).s;
  const small = zoomForBox(W, H, [1000, 1000, 40, 40]).s;
  assert.ok(small > big, `${small} > ${big}`);
});
