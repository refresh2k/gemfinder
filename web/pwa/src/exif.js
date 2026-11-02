// EXIF orientation handling for overlay alignment. The CLI segments raw
// JPEG bytes (no EXIF transpose), so report boxes are in raw pixel space,
// while browsers display EXIF-rotated photos transposed (e.g. testbed
// dry.jpg: raw 4000x3000 landscape, displayed 3000x4000 portrait).
// Rendering raw boxes at raw coordinates in the displayed photo transposes
// the whole overlay. These pure helpers map boxes raw -> display.

// Read EXIF orientation (1-8) from image bytes. Total: anything unreadable
// or non-JPEG yields 1 (identity), never throws.
export function parseOrientation(buf) {
  try {
    const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return 1;
    let p = 2;
    while (p + 1 < b.length) {
      if (b[p] !== 0xff) return 1;
      let q = p + 1;
      while (q < b.length && b[q] === 0xff) q++; // fill bytes
      if (q >= b.length) return 1;
      const marker = b[q];
      if (marker === 0xd9 || marker === 0xda) return 1; // EOI / SOS: past metadata
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { p = q + 1; continue; }
      if (q + 3 > b.length) return 1;
      const len = (b[q + 1] << 8) | b[q + 2];
      if (len < 2 || q + 1 + len > b.length) return 1;
      if (marker === 0xe1 && len >= 8 &&
          b[q + 3] === 0x45 && b[q + 4] === 0x78 && b[q + 5] === 0x69 &&
          b[q + 6] === 0x66 && b[q + 7] === 0x00 && b[q + 8] === 0x00) {
        return orientationFromTiff(b, q + 9, q + 1 + len);
      }
      p = q + 1 + len;
    }
  } catch {
    // fall through to 1
  }
  return 1;
}

function orientationFromTiff(b, start, end) {
  if (start + 8 > end) return 1;
  const le = b[start] === 0x49 && b[start + 1] === 0x49
    ? true
    : b[start] === 0x4d && b[start + 1] === 0x4d ? false : null;
  if (le === null) return 1;
  const u16 = (o) => (le ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1]);
  const u32 = (o) => le
    ? b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)
    : (b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3];
  if (u16(start + 2) !== 42) return 1;
  const ifd = start + u32(start + 4);
  if (ifd + 2 > end) return 1;
  const n = u16(ifd);
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > end) return 1;
    if (u16(e) === 0x0112 && u16(e + 2) === 3 && u32(e + 4) >= 1) {
      const v = u16(e + 8);
      return v >= 1 && v <= 8 ? v : 1;
    }
  }
  return 1;
}

// Raw pixel dims given display dims (naturalWidth/Height) and orientation.
export function rawDims(displayW, displayH, orientation) {
  return orientation >= 5 ? [displayH, displayW] : [displayW, displayH];
}

// Inverse: display-space point back to raw pixels (for sending taps).
export function inverseMapPoint(px, py, rawW, rawH, orientation) {
  switch (orientation) {
    case 2: return [rawW - px, py];
    case 3: return [rawW - px, rawH - py];
    case 4: return [px, rawH - py];
    case 5: return [py, px];
    case 6: return [py, rawH - px];
    case 7: return [rawW - py, rawH - px];
    case 8: return [rawW - py, px];
    default: return [px, py];
  }
}

// Map a raw-space [x, y, w, h] box to display space.
export function mapBox(box, rawW, rawH, orientation) {
  const [x, y, w, h] = box;
  switch (orientation) {
    case 2: return [rawW - (x + w), y, w, h];
    case 3: return [rawW - (x + w), rawH - (y + h), w, h];
    case 4: return [x, rawH - (y + h), w, h];
    case 5: return [y, x, h, w];
    case 6: return [rawH - (y + h), x, h, w];
    case 7: return [rawH - (y + h), rawW - (x + w), h, w];
    case 8: return [y, rawW - (x + w), h, w];
    default: return [x, y, w, h];
  }
}
