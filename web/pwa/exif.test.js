// EXIF orientation parsing + raw->display box mapping. Stdlib only.
//
// Run: node --test web/pwa/exif.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { inverseMapPoint, mapBox, parseOrientation, rawDims } from './src/exif.js';
import { zoomForBox } from './src/zoom.js';

// Minimal JPEG: SOI + one APP1 carrying EXIF orientation, LE TIFF unless be.
function jpegWithOrientation(v, be = false) {
  const tiff = [];
  const u16 = (n) => be ? [n >> 8, n & 0xff] : [n & 0xff, n >> 8];
  const u32 = (n) => be
    ? [n >>> 24, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]
    : [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, n >>> 24];
  tiff.push(...(be ? [0x4d, 0x4d] : [0x49, 0x49]), ...u16(42), ...u32(8));
  tiff.push(...u16(1)); // one IFD entry
  tiff.push(...u16(0x0112), ...u16(3), ...u32(1), ...u16(v), 0x00, 0x00);
  tiff.push(...u32(0)); // next IFD
  const app1 = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...tiff]; // Exif\0\0
  const len = app1.length + 2;
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe1, len >> 8, len & 0xff, ...app1]);
}

test('parses orientations 1-8 (LE) and 6 (BE)', () => {
  for (let v = 1; v <= 8; v++) {
    assert.equal(parseOrientation(jpegWithOrientation(v)), v, `LE o=${v}`);
  }
  assert.equal(parseOrientation(jpegWithOrientation(6, true)), 6, 'BE o=6');
});

test('garbage yields identity, never throws', () => {
  const cases = [
    new Uint8Array([]),
    new Uint8Array([0x89, 0x50, 0x4e, 0x47]), // PNG, not JPEG
    new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), // bare SOI+EOI
    jpegWithOrientation(6).slice(0, 20), // truncated APP1
    new Uint8Array([0xff, 0xd8, 0x00, 0x00]), // corrupt marker run
  ];
  for (const c of cases) assert.equal(parseOrientation(c), 1);
  assert.equal(parseOrientation(new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x08,
    0x45, 0x78, 0x69, 0x66, 0x00, 0x00])), 1); // Exif header, no TIFF
});

const RAW = [2689, 1719, 96, 73]; // banked #0, raw 4000x3000 space
const MAPPED = {
  1: [2689, 1719, 96, 73],
  2: [1215, 1719, 96, 73],
  3: [1215, 1208, 96, 73],
  4: [2689, 1208, 96, 73],
  5: [1719, 2689, 73, 96],
  6: [1208, 2689, 73, 96], // testbed dry.jpg: verified against PIL transpose
  7: [1208, 1215, 73, 96],
  8: [1719, 1215, 73, 96],
};

test('mapBox covers all 8 orientations', () => {
  for (let o = 1; o <= 8; o++) {
    assert.deepEqual(mapBox(RAW, 4000, 3000, o), MAPPED[o], `o=${o}`);
  }
});

test('mapped boxes stay inside display dims', () => {
  for (let o = 1; o <= 8; o++) {
    const [dw, dh] = o >= 5 ? [3000, 4000] : [4000, 3000];
    const [x, y, w, h] = mapBox(RAW, 4000, 3000, o);
    assert.ok(x >= 0 && y >= 0 && x + w <= dw && y + h <= dh, `o=${o} in-bounds`);
  }
});

test('rawDims swaps if and only if transposed', () => {
  for (let o = 1; o <= 8; o++) {
    assert.deepEqual(rawDims(3000, 4000, o),
      o >= 5 ? [4000, 3000] : [3000, 4000], `o=${o}`);
  }
});

test('inverseMapPoint inverts every orientation', () => {
  // Hand-computed display positions of raw point (100, 200) in 4000x3000.
  const disp = {
    1: [100, 200], 2: [3900, 200], 3: [3900, 2800], 4: [100, 2800],
    5: [200, 100], 6: [2800, 100], 7: [2800, 3900], 8: [200, 3900],
  };
  for (let o = 1; o <= 8; o++) {
    const [dx, dy] = disp[o];
    assert.deepEqual(
      inverseMapPoint(dx, dy, 4000, 3000, o).map(Math.round),
      [100, 200], `o=${o}`);
  }
});

test('mapped #0 chain: EXIF 6 box centers in display space', () => {
  const box = mapBox(RAW, 4000, 3000, 6);
  const { s, txPct, tyPct } = zoomForBox(3000, 4000, box);
  const tx = txPct / 100;
  const ty = tyPct / 100;
  const cx = (box[0] + box[2] / 2) / 3000;
  const cy = (box[1] + box[3] / 2) / 4000;
  assert.ok(tx <= 0 && tx + s >= 1 && ty <= 0 && ty + s >= 1, 'covers view');
  assert.ok(Math.abs(s * cx + tx - 0.5) < 1e-9, 'x centered');
  assert.ok(Math.abs(s * cy + ty - 0.5) < 1e-9, 'y centered');
});
