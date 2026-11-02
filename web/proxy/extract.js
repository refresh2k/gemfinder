// Proxy-side close-up stdout recovery. The CLI prints progress to stderr
// and one assessment JSON object to stdout, but v5 SAM progress leaked
// onto stdout and bare JSON.parse threw "cli assessment is not JSON" on
// live runs (proxy log, Oct 31). This module extracts the assessment
// tolerantly, mines stderr for spend accounting, and assembles an honest
// dry fallback when stdout holds no assessment at all.
//
// Mirror note: UNREADABLE_NOTE duplicates cli.UNREADABLE_NOTE; the proxy
// needs it when the CLI's own stdout is the casualty. Keep the text exact.
const UNREADABLE_NOTE = 'Live assessment could not be read — showing local description only.';

function balancedSpans(text) {
  const spans = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    if (text[i] !== '{') {
      i += 1;
      continue;
    }
    let depth = 0;
    let instr = false;
    let esc = false;
    let j = i;
    while (j < n) {
      const ch = text[j];
      if (instr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') instr = false;
      } else if (ch === '"') instr = true;
      else if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          spans.push(text.slice(i, j + 1));
          break;
        }
      }
      j += 1;
    }
    i += 1;
  }
  return spans;
}

function extractAssessment(out) {
  if (typeof out !== 'string') return null;
  const cands = [out, ...balancedSpans(out)];
  let first = null;
  for (const cand of cands) {
    let obj = null;
    try {
      obj = JSON.parse(cand.trim());
    } catch {
      continue;
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) continue;
    if (obj.mode === 'closeup_assessment') return obj;
    if (!first) first = obj;
  }
  return first;
}

function mineCloseupErr(err) {
  const text = String(err || '');
  const m = text.match(/(\d+) images sent \(sam (\d+) \+ spark (\d+)\)/);
  let stage = null;
  if (m || text.includes('spark: close-up assessment')) {
    stage = 'Spark assessment';
  } else if (text.includes('sam: done')) {
    stage = 'SAM segmentation';
  }
  if (!m && !stage) return null;
  return {
    stage,
    sent: m ? Number(m[1]) : null,
    sam: m ? Number(m[2]) : null,
    spark: m ? Number(m[3]) : null,
  };
}

function fallbackParseError(mined) {
  if (mined && mined.sent !== null) {
    return `Live close-up reached ${mined.stage || 'the scan'} `
      + `(${mined.sent} images sent) but the assessment could not be read. `
      + 'Check the dashboard for actual billing.';
  }
  return 'Live close-up assessment could not be read '
    + '(images sent unconfirmed). Check the dashboard for actual billing.';
}

function assembleFallback(dry, mined) {
  return {
    ...dry,
    dry_run: false,
    images_sent: mined && mined.sent !== null ? mined.sent : dry.images_sent,
    sam_images: mined && mined.sam !== null ? mined.sam : dry.sam_images,
    spark_images: mined && mined.spark !== null ? mined.spark : dry.spark_images,
    note: UNREADABLE_NOTE,
    parse_error: fallbackParseError(mined),
  };
}

module.exports = {
  UNREADABLE_NOTE,
  balancedSpans,
  extractAssessment,
  mineCloseupErr,
  fallbackParseError,
  assembleFallback,
};
