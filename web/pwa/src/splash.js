// Splash prompt: shown when a LIVE bed scan completes with 0 candidates
// at or above the confidence cutoff. Never on dry run (plumbing test) or
// demo (fixed banked report). Pure logic; the UI layers per-result
// dismissal and the reshoot picker on top.

export const SPLASH_COPY = 'No candidates at 85% confidence or above found. Splash the bed with '
  + 'water and reshoot — wet stones show color and contrast that dry stones hide.';
export const SPLASH_PRIMARY = 'Splash and reshoot';
export const SPLASH_DISMISS = 'Dismiss';

// mode: 'live' | 'dry' | 'demo' | ''. keptCount: filtered length, or null
// when no result is present. dismissed: whether the user dismissed the
// prompt for this scan result already.
export function shouldPromptSplash(mode, keptCount, dismissed) {
  return mode === 'live' && keptCount === 0 && !dismissed;
}
