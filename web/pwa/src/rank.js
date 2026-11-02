// Bed-list 85% confidence filter (display-side only). The report keeps
// all ranked candidates; the list and overlay show score >= 0.85 with
// sequential 1-based display numbers. This 85% is a confidence score,
// unrelated to the 90% area-overlap suppression (CLI-side, unchanged).
export const SCORE_CUTOFF = 0.85;

export function keptCandidates(candidates) {
  return (candidates || []).filter((c) => c.score >= SCORE_CUTOFF);
}

// Bed-list score label: "95% confidence". Single source so rows in
// live, dry, and demo modes render identically.
export function scoreLabel(score) {
  return `${Math.round(score * 100)}% confidence`;
}

// 1-based displayed number of id within the kept list, or null.
export function displayNumber(kept, id) {
  const i = (kept || []).findIndex((c) => c.id === id);
  return i < 0 ? null : i + 1;
}
