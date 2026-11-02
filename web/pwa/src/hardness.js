// Guided scratch-test key, v2.1 semantics: soft to hard; a no-mark never
// ends the test by itself. Tool scratches stone stops with a bracket;
// stone scratches tool unlocks the next tool (over 6.5 at steel); no-mark
// unlocks the next tool to bracket further. The user may also Stop here
// once the stone has scratched some tool. Pure logic; the UI layers
// sequential answering and the stop action on top.

export const TOOLS = [
  { id: 'nail', label: 'Fingernail', h: 2.5 },
  { id: 'copper', label: 'Copper coin', h: 3 },
  { id: 'glass', label: 'Glass plate', h: 5.5 },
  { id: 'steel', label: 'Steel nail or file', h: 6.5 },
];

export const STONE_SCRATCHES_TOOL = 'stone_scratches_tool';
export const TOOL_SCRATCHES_STONE = 'tool_scratches_stone';
export const NO_SCRATCH = 'no_scratch';

// answers: {toolIdx: outcome}. Reads the answered prefix in order; a gap or
// unknown outcome ends the input. Returns {lo, hi, approx, label, stopped,
// stopKind, next, inconclusive}. label is set only on a stopped test.
export function hardnessRange(answers) {
  const a = answers || {};
  let lo = null;
  let approx = null;
  let idx = 0;
  while (idx < TOOLS.length && a[idx] !== undefined) {
    const o = a[idx];
    const h = TOOLS[idx].h;
    if (o === TOOL_SCRATCHES_STONE) {
      const lower = idx > 0 ? TOOLS[idx - 1].h : null;
      return {
        lo: lower, hi: h, approx: null,
        label: lower !== null ? `${lower}–${h}` : `under ${h}`,
        stopped: true, stopKind: 'bound', next: -1, inconclusive: false,
      };
    }
    if (o === STONE_SCRATCHES_TOOL) {
      lo = h;
      approx = null; // later hard bound supersedes an earlier near-miss
    } else if (o === NO_SCRATCH) {
      approx = h;
    } else {
      break;
    }
    idx += 1;
  }
  if (idx >= TOOLS.length) {
    if (lo === null) {
      return { lo: null, hi: null, approx, label: null, stopped: true,
        stopKind: 'steel', next: -1, inconclusive: true };
    }
    return { lo, hi: null, approx,
      label: approx !== null ? `about ${approx}` : `over ${lo}`,
      stopped: true, stopKind: 'steel', next: -1, inconclusive: false };
  }
  return { lo, hi: null, approx, label: null, stopped: false,
    stopKind: null, next: idx, inconclusive: false };
}

// Effective range for a scratch-test state {answers, stopped, unknown}: a
// manual stop locks the label while the answers stay the run's evidence.
// Scan-anyway marks a genuinely inconclusive run as scannable-with-unknown;
// anything else (including a real range) ignores the flag. An automatic
// stop always wins over a stale manual label.
export function lockedRange(scratch) {
  const s = scratch || {};
  const r = hardnessRange(s.answers || {});
  if (s.unknown && r.inconclusive) {
    return { ...r, unknown: true };
  }
  if (s.stopped != null && !r.stopped) {
    return { ...r, label: s.stopped, stopped: true, stopKind: 'manual', next: -1 };
  }
  return r;
}

// Final label if the user stops here with the current answers, or null when
// nothing lockable exists yet (no tool scratched by the stone).
export function stopLabel(answers) {
  const r = hardnessRange(answers);
  if (r.stopped) return r.label;
  if (r.lo === null) return null;
  return r.approx !== null ? `about ${r.approx}` : `over ${r.lo}`;
}
