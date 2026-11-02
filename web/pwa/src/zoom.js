// Pure focus/zoom math for tap-to-zoom. No DOM, no React: unit-tested
// with node:test against real report boxes (see ../zoom.test.js).

export function toggleFocus(currentId, tappedId) {
  return currentId === tappedId ? null : tappedId;
}

// Zoom + pan that centers `box` in the view. Returns CSS transform pieces
// for `translate(tx%, ty%) scale(s)` with transform-origin '0 0', under
// which a point at photo fraction c maps to s*c + t. Pan is clamped so
// the scaled photo always covers the view (no void at the edges).
// Overlay chrome sizes in photo px, counter-scaled by 1/s so screen size
// stays constant under zoom. s=1 reproduces the unzoomed look exactly.
export function chromeSizes(su, s, hot) {
  return {
    stroke: ((hot ? 7 : 3) * su) / s,
    badgeW: (20 * su) / s,
    badgeH: (24 * su) / s,
    badgeDy: (26 * su) / s,
    font: (17 * su) / s,
    textDx: (4 * su) / s,
    textDy: (19 * su) / s,
  };
}

export function zoomForBox(photoW, photoH, box) {
  const [x, y, w, h] = box;
  const cx = (x + w / 2) / photoW;
  const cy = (y + h / 2) / photoH;
  const s = Math.min(10, Math.max(2.5, Math.min(photoW, photoH) / 3 / Math.max(w, h)));
  const tx = Math.min(0, Math.max(1 - s, 0.5 - s * cx));
  const ty = Math.min(0, Math.max(1 - s, 0.5 - s * cy));
  return { s, txPct: tx * 100, tyPct: ty * 100 };
}
