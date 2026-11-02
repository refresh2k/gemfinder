import { useEffect, useRef, useState } from 'react';
import { chromeSizes, toggleFocus, zoomForBox } from './zoom.js';
import { inverseMapPoint, mapBox, parseOrientation, rawDims } from './exif.js';
import { TOOLS, lockedRange, stopLabel } from './hardness.js';
import {
  DRY_NO_SUGGESTIONS, buildSavedEntry, cleanedLabel, formatDate,
  idbAdd, idbAll, idbDelete, rowIdentity, savedDisplayNo,
} from './saved.js';
import { displayNumber, keptCandidates, scoreLabel } from './rank.js';
import { scrubPriceWording } from './scrub.js';
import {
  SPLASH_COPY, SPLASH_DISMISS, SPLASH_PRIMARY, shouldPromptSplash,
} from './splash.js';
import './app.css';

function BlobImg({ blob, className, alt }) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    if (!blob) {
      setUrl(null);
      return undefined;
    }
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob]);
  if (!url) return null;
  return <img src={url} className={className} alt={alt} />;
}

function loadDims(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => reject(new Error('could not load photo'));
    img.src = url;
  });
}

function loadOrientation(blob) {
  return blob.arrayBuffer().then((ab) => parseOrientation(ab)).catch(() => 1);
}

export default function App() {
  const [photo, setPhoto] = useState(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('Pick a photo, then scan.');
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [mode, setMode] = useState('');
  const [focusId, setFocusId] = useState(null);
  const [closeups, setCloseups] = useState({});
  const [openCloseup, setOpenCloseup] = useState(null);
  const [confirmLive, setConfirmLive] = useState(null);
  const [bedProj, setBedProj] = useState(null);
  const [projecting, setProjecting] = useState(false);
  const [liveAvail, setLiveAvail] = useState(null);
  const [rocks, setRocks] = useState([]);
  const [openSaved, setOpenSaved] = useState(null);
  const [savedError, setSavedError] = useState('');
  const [dismissedSplash, setDismissedSplash] = useState(-1);
  const bedToken = useRef(0);
  const scanSeq = useRef(0);

  // Uniform clear: removing the open close-up (photo, note, result) and
  // restoring the unfocused bed view. The bed list itself is never touched.
  function clearBedView() {
    if (openCloseup !== null) {
      setCloseups((prev) => {
        const next = { ...prev };
        delete next[openCloseup];
        return next;
      });
      setOpenCloseup(null);
    }
    setConfirmLive(null);
    setFocusId(null);
  }

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') clearBedView(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openCloseup]);

  useEffect(() => {
    idbAll().then(
      (rows) => setRocks(rows),
      () => setRocks([]),
    );
  }, []);

  // Report boxes are raw-pixel space; the browser displays EXIF-rotated
  // photos transposed. Map overlay/zoom boxes to display space. The list
  // below shows the report's >=85% confidence entries only (display-side
  // filter; the report itself is untouched) with sequential 1-based
  // display numbers; c.id stays the internal original rank.
  const ori = photo ? (photo.ori || 1) : 1;
  const [rawW, rawH] = photo ? rawDims(photo.w, photo.h, ori) : [0, 0];
  const kept = result ? keptCandidates(result.candidates) : null;
  const shown = kept && photo
    ? kept.map((c) => ({ ...c, box: mapBox(c.box, rawW, rawH, ori) }))
    : null;
  const focus = focusId == null || !shown
    ? null
    : shown.find((c) => c.id === focusId) || null;
  const zoom = focus && photo ? zoomForBox(photo.w, photo.h, focus.box) : null;
  const showSplash = result !== null && shouldPromptSplash(
    mode, kept ? kept.length : null, dismissedSplash === scanSeq.current,
  );
  const abortRef = useRef(null);
  const fileRef = useRef(null);
  const camRef = useRef(null);
  const previewRef = useRef(null);
  const closeLibRef = useRef(null);
  const closeCamRef = useRef(null);
  const savedRef = useRef(null);

  function tapEntry(id) {
    const next = toggleFocus(focusId, id);
    if (next === null) {
      clearBedView();
      return;
    }
    if (openCloseup !== next) setOpenCloseup(next);
    if (previewRef.current) {
      const reduceMotion = window.matchMedia?.(
        '(prefers-reduced-motion: reduce)')?.matches;
      previewRef.current.scrollIntoView({
        behavior: reduceMotion ? 'auto' : 'smooth',
        block: 'start',
      });
    }
    setFocusId(next);
  }

  function updateCloseup(id, patch) {
    setCloseups((prev) => ({
      ...prev,
      [id]: {
        photo: null, note: '', result: null,
        busy: false, error: '', status: '',
        proj: null, projecting: false,
        cleaned: null, focusTap: null, scratch: { answers: {} },
        ...(prev[id] || {}), ...patch,
      },
    }));
  }

  function invalidateCuResult(id) {
    updateCloseup(id, {
      result: null, proj: null, projecting: false, savedId: null,
    });
    setConfirmLive((cur) => (cur === id ? null : cur));
  }

  function refreshLiveAvail() {
    fetch('/health', { cache: 'no-store' }).then(
      (r) => r.json().catch(() => ({})),
      () => ({}),
    ).then((h) => {
      if (typeof h.live_available === 'boolean') setLiveAvail(h.live_available);
      else if (typeof h.key === 'boolean') setLiveAvail(h.key);
    });
  }

  async function requestCloseupLive(id) {
    const bundle = closeups[id];
    if (!bundle || !bundle.photo || !bundle.photo.file) {
      updateCloseup(id, { error: 'Attach a close-up photo first.' });
      return;
    }
    const range = lockedRange(bundle.scratch);
    if (bundle.cleaned == null || (!range.label && !range.unknown)) {
      updateCloseup(id, { error: 'Finish the clean and scratch steps first.' });
      return;
    }
    const forFile = bundle.photo.file;
    refreshLiveAvail();
    updateCloseup(id, { proj: null, projecting: true });
    setConfirmLive(id);
    const store = (patch) => setCloseups((prev) => {
      const b = prev[id];
      if (!b || !b.photo || b.photo.file !== forFile) return prev;
      return { ...prev, [id]: { ...b, ...patch } };
    });
    try {
      const fd = new FormData();
      fd.append('photo', forFile);
      const res = await fetch('/project?kind=closeup', { method: 'POST', body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.projection) throw new Error(data.error || 'projection failed');
      store({ proj: { data }, projecting: false });
    } catch (e) {
      store({ proj: { error: true }, projecting: false });
    }
  }

  function onCloseFile(id, file) {
    if (!file) return;
    const url = URL.createObjectURL(file);
    Promise.all([loadDims(url), loadOrientation(file)])
      .then(([dims, foundOri]) => {
        updateCloseup(id, {
          photo: { url, file, name: file.name, ori: foundOri, ...dims },
          result: null, status: '', error: '',
          proj: null, projecting: false, focusTap: null,
        });
        setConfirmLive((cur) => (cur === id ? null : cur));
      })
      .catch(() => updateCloseup(id, { error: 'Could not read that file as a photo.' }));
  }

  function cuFailText(e, nextMode) {
    const what = nextMode === 'dry' ? 'Dry run' : 'Live scan';
    const clean = scrubPriceWording(
      String((e && e.message) || e).replace(/^cli exit \d+: /, ''))
      || `${what} failed.`;
    if (e && (e.status === 400 || e.status === 503)) return `${clean} No live call was made.`;
    if (e && e.status) {
      if (/no images sent|\d+ images sent/.test(clean)) return clean;
      if (nextMode === 'dry') return `${clean} Dry runs send nothing.`;
      return clean;
    }
    return `${what} did not reach the server. No live call was made.`;
  }

  function openSavedDetail(id) {
    setOpenSaved(id);
    setTimeout(() => {
      savedRef.current?.scrollIntoView({ block: 'start' });
    }, 60);
  }

  async function saveRock(id) {
    const bundle = closeups[id];
    if (!bundle || !bundle.result || !kept) return;
    if (bundle.savedId != null) {
      openSavedDetail(bundle.savedId);
      return;
    }
    const bedNo = displayNumber(kept, id);
    if (bedNo == null) return;
    try {
      const entry = buildSavedEntry(bundle, bundle.result, bedNo, id + 1, Date.now());
      const savedId = await idbAdd(entry);
      setRocks((prev) => [...prev, { ...entry, id: savedId }]);
      updateCloseup(id, { savedId });
    } catch (e) {
      updateCloseup(id, { error: 'Save failed on this device.' });
    }
  }

  async function removeRock(id) {
    try {
      await idbDelete(id);
      setRocks((prev) => prev.filter((r) => r.id !== id));
      setOpenSaved((cur) => (cur === id ? null : cur));
      setSavedError('');
    } catch (e) {
      setSavedError('Remove failed on this device.');
    }
  }

  async function scanCloseup(id, nextMode) {
    const bundle = closeups[id];
    if (!bundle || !bundle.photo || !bundle.photo.file) {
      updateCloseup(id, { error: 'Attach a close-up photo first.' });
      return;
    }
    const range = lockedRange(bundle.scratch);
    if (bundle.cleaned == null || (!range.label && !range.unknown)) {
      updateCloseup(id, { error: 'Finish the clean and scratch steps first.' });
      return;
    }
    setConfirmLive(null);
    updateCloseup(id, {
      error: '', result: null, savedId: null, busy: true,
      status: nextMode === 'dry'
        ? 'Assessing one stone (dry run)…'
        : 'This may take a minute',
    });
    try {
      const fd = new FormData();
      fd.append('photo', bundle.photo.file);
      if (bundle.focusTap) {
        const [rw, rh] = rawDims(bundle.photo.w, bundle.photo.h,
          bundle.photo.ori || 1);
        const [rx, ry] = inverseMapPoint(
          bundle.focusTap.fx * bundle.photo.w,
          bundle.focusTap.fy * bundle.photo.h,
          rw, rh, bundle.photo.ori || 1);
        fd.append('focus', `${Math.round(rx)},${Math.round(ry)}`);
      }
      const hardTests = TOOLS.map((t, i) => {
        const o = (bundle.scratch.answers || {})[i];
        return o ? { tool: t.id, outcome: o } : null;
      }).filter(Boolean);
      fd.append('hardness', JSON.stringify(range.unknown
        ? {
          cleaned: bundle.cleaned, tests: hardTests,
          range: null, status: 'inconclusive',
        }
        : {
          cleaned: bundle.cleaned,
          tests: hardTests,
          range: { lo: range.lo, hi: range.hi, approx: range.approx, label: range.label },
        }));
      // NOTE: the free-text note is UI-only; it is never appended here.
      const res = await fetch(`/closeup?mode=${nextMode}`, { method: 'POST', body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const fail = new Error(data.error || `scan failed (${res.status})`);
        fail.status = res.status;
        throw fail;
      }
      if (data.parse_error) data.parse_error = scrubPriceWording(data.parse_error);
      if (data.note) data.note = scrubPriceWording(data.note);
      updateCloseup(id, {
        result: data,
        status: nextMode === 'dry' ? 'Dry run: one-stone assessment ready.' : 'Live scan complete.',
      });
    } catch (e) {
      updateCloseup(id, { status: '', error: cuFailText(e, nextMode) });
    } finally {
      updateCloseup(id, { busy: false });
    }
  }

  function onFile(file) {
    if (!file) return;
    const url = URL.createObjectURL(file);
    Promise.all([loadDims(url), loadOrientation(file)])
      .then(([dims, foundOri]) => {
        setPhoto({ url, file, name: file.name, ori: foundOri, ...dims });
        setResult(null);
        setFocusId(null);
        setCloseups({});
        setOpenCloseup(null);
        setConfirmLive(null);
        bedToken.current++;
        setBedProj(null);
        setError('');
        setStatus('');
      })
      .catch(() => setError('Could not read that file as a photo.'));
  }

  function cancel() {
    if (abortRef.current) abortRef.current.abort();
  }

  async function requestBedLive() {
    if (!photo || !photo.file) {
      setError('Pick a photo first.');
      return;
    }
    const tag = ++bedToken.current;
    refreshLiveAvail();
    setProjecting(true);
    setBedProj(null);
    try {
      const fd = new FormData();
      fd.append('photo', photo.file);
      const res = await fetch('/project', { method: 'POST', body: fd });
      const data = await res.json().catch(() => ({}));
      if (tag !== bedToken.current) return;
      if (!res.ok || !data.projection) throw new Error(data.error || 'projection failed');
      setBedProj({ data, tag });
    } catch (e) {
      if (tag !== bedToken.current) return;
      setBedProj({ error: true, tag });
    } finally {
      setProjecting(false);
    }
  }

  function confirmBedLive() {
    const p = bedProj;
    setBedProj(null);
    if (!p || p.tag !== bedToken.current) {
      if (p) requestBedLive();
      return;
    }
    scan('live');
  }

  async function scan(nextMode) {
    setError('');
    setResult(null);
    setFocusId(null);
    setCloseups({});
    setOpenCloseup(null);
    setConfirmLive(null);
    bedToken.current++;
    scanSeq.current++;
    setBedProj(null);
    setMode(nextMode);
    abortRef.current = new AbortController();
    const { signal } = abortRef.current;
    setBusy(true);
    try {
      if (nextMode === 'demo') {
        setStatus('Loading banked demo…');
        const [dims, foundOri, rep] = await Promise.all([
          loadDims('/demo/photo'),
          fetch('/demo/photo', { signal }).then((r) => r.blob()).then(loadOrientation),
          fetch('/demo/report', { signal }).then((r) => {
            if (!r.ok) throw new Error('demo unavailable');
            return r.json();
          }),
        ]);
        setPhoto({ url: '/demo/photo', name: 'demo gravel bed', ori: foundOri, ...dims });
        setResult(rep);
        setStatus(`Demo: ${keptCandidates(rep.candidates).length} banked candidates.`);
        return;
      }
      if (!photo || !photo.file) throw new Error('Pick a photo first.');
      setStatus(nextMode === 'dry' ? 'Scanning (dry run)…' : 'This may take a minute');
      const fd = new FormData();
      fd.append('photo', photo.file);
      const res = await fetch(`/scan?mode=${nextMode}`, { method: 'POST', body: fd, signal });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `scan failed (${res.status})`);
      setResult(data);
      const secs = Math.round((data.latency_ms || 0) / 1000);
      const keptN = keptCandidates(data.candidates).length;
      setStatus(`${nextMode === 'dry' ? 'Dry run' : 'Live scan'}: ${keptN} candidates in ${secs}s.`);
    } catch (e) {
      if (e.name === 'AbortError') {
        setStatus('Cancelled on this end. The server may still finish the run.');
      } else {
        setStatus('Failed.');
        setError(scrubPriceWording(String((e && e.message) || e)) || 'Scan failed.');
      }
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }

  const su = photo ? photo.w / 500 : 1;

  // Open close-up bundle (photo, UI-only note, per-candidate result).
  // Boxes map raw->display with the close-up photo's own EXIF orientation.
  const openBundle = openCloseup !== null
    ? (closeups[openCloseup] || {
      photo: null, note: '', result: null,
      busy: false, error: '', status: '',
      proj: null, projecting: false,
    })
    : null;
  const cuPhoto = openBundle ? openBundle.photo : null;
  const cuOri = cuPhoto ? (cuPhoto.ori || 1) : 1;
  const [cuRawW, cuRawH] = cuPhoto ? rawDims(cuPhoto.w, cuPhoto.h, cuOri) : [0, 0];
  const cuBox = openBundle && openBundle.result && cuPhoto
    ? mapBox(openBundle.result.stone.box, cuRawW, cuRawH, cuOri)
    : null;
  const cuSu = cuPhoto ? cuPhoto.w / 500 : 1;
  const cuRange = openBundle
    ? lockedRange(openBundle.scratch)
    : { lo: null, hi: null, approx: null, label: null, stopped: false, next: 0 };
  const cuAnswers = openBundle ? ((openBundle.scratch || {}).answers || {}) : {};
  const cuHasAnswers = Object.keys(cuAnswers).length > 0;
  const cuStopLabel = openBundle && !cuRange.stopped ? stopLabel(cuAnswers) : null;
  const cuCanStop = cuStopLabel != null;
  const cuResultUnknown = !!(openBundle && openBundle.result
    && openBundle.result.hardness.status === 'inconclusive');
  const toolName = (h) => {
    const t = TOOLS.find((t) => t.h === h);
    return t ? t.label.toLowerCase() : `hardness ${h}`;
  };
  const cuReady = !!openBundle && !!cuPhoto && openBundle.cleaned != null
    && (!!cuRange.label || !!cuRange.unknown);
  const cuNo = openCloseup !== null && kept
    ? displayNumber(kept, openCloseup)
    : null;
  const openSavedEntry = openSaved != null
    ? (rocks.find((r) => r.id === openSaved) || null)
    : null;

  return (
    <main className="wrap">
      <header className="top">
        <h1>Gem Finder</h1>
        <p className="sub">Rank, never species. {photo ? photo.name : 'No photo yet.'}</p>
      </header>

      <section className="panel">
        <div className="btnrow">
          <button type="button" disabled={busy} onClick={() => fileRef.current.click()}>
            Photo library
          </button>
          <button type="button" disabled={busy} onClick={() => camRef.current.click()}>
            Camera
          </button>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => { onFile(e.target.files[0]); e.target.value = ''; }}
        />
        <input
          ref={camRef}
          type="file"
          accept="image/*"
          capture="environment"
          hidden
          onChange={(e) => { onFile(e.target.files[0]); e.target.value = ''; }}
        />
      </section>

      {photo && (
        <section
          ref={previewRef}
          className={`panel preview${focus !== null ? ' focused' : ''}`}
          onClick={() => { if (focusId !== null) clearBedView(); }}
        >
          <div
            className="zoomwrap"
            style={zoom ? {
              transformOrigin: '0 0',
              transform: `translate(${zoom.txPct}%, ${zoom.tyPct}%) scale(${zoom.s})`,
            } : undefined}
          >
            <img src={photo.url} alt="gravel bed under test" />
            {shown && (
              <svg viewBox={`0 0 ${photo.w} ${photo.h}`} aria-hidden="true">
                {shown.map((c, i) => {
                  const hot = focus !== null && c.id === focusId;
                  const dim = focus !== null && !hot;
                  const col = hot ? '#f5b301' : '#e5484d';
                  // Overlay chrome is drawn in photo pixels, so the zoom
                  // transform would blow it up: counter-scale by 1/s to hold
                  // constant screen size. Dimmed boxes keep outlines only.
                  const zs = zoom ? zoom.s : 1;
                  const ch = chromeSizes(su, zs, hot);
                  const badgeY = Math.max(0, c.box[1] - ch.badgeDy);
                  return (
                    <g key={c.id} opacity={dim ? 0.22 : 1}>
                      <rect
                        x={c.box[0]} y={c.box[1]} width={c.box[2]} height={c.box[3]}
                        fill="none" stroke={col}
                        strokeWidth={ch.stroke}
                      />
                      {!dim && (
                        <rect
                          x={c.box[0]} y={badgeY}
                          width={ch.badgeW} height={ch.badgeH} fill={col}
                        />
                      )}
                      {!dim && (
                        <text
                          x={c.box[0] + ch.textDx} y={badgeY + ch.textDy}
                          fontSize={ch.font} fill={hot ? '#1a1408' : '#fff'}
                          textAnchor="start"
                        >
                          {i + 1}
                        </text>
                      )}
                    </g>
                  );
                })}
              </svg>
            )}
          </div>
        </section>
      )}

      {openCloseup !== null && focus !== null && openBundle && cuNo !== null && (
        <section className="panel closeup">
          <h2>
            Close-up #{cuNo}
            <button
              type="button" className="clearbtn"
              onClick={() => clearBedView()}
            >
              Close
            </button>
          </h2>
          <h3 className="step">1 · Clean the stone</h3>
          <p>Clean the stone first (wash / splash, let grit and dust come off), then shoot the close-up.</p>
          <div className="btnrow">
            <button
              type="button" className={openBundle.cleaned === true ? 'primary' : ''}
              aria-pressed={openBundle.cleaned === true}
              onClick={() => { updateCloseup(openCloseup, { cleaned: true }); invalidateCuResult(openCloseup); }}
            >
              Yes, cleaned
            </button>
            <button
              type="button" className={openBundle.cleaned === false ? 'primary' : ''}
              aria-pressed={openBundle.cleaned === false}
              onClick={() => { updateCloseup(openCloseup, { cleaned: false }); invalidateCuResult(openCloseup); }}
            >
              No
            </button>
          </div>

          <h3 className="step">2 · Close-up photo</h3>
          {openBundle.cleaned == null ? (
            <p className="locked">Clean the stone first to unlock the photo step.</p>
          ) : !cuPhoto ? (
            <>
              <div className="btnrow">
                <button type="button" onClick={() => closeLibRef.current.click()}>
                  Photo library
                </button>
                <button type="button" onClick={() => closeCamRef.current.click()}>
                  Camera
                </button>
              </div>
              <p className="hint">JPEG preferred. One photo per candidate.</p>
            </>
          ) : (
            <>
              <p className="hint">Attached: {cuPhoto.name}</p>
              <div className="btnrow">
                <button
                  type="button" className="ghost"
                  disabled={openBundle.busy}
                  onClick={() => closeLibRef.current.click()}
                >
                  Replace photo
                </button>
              </div>
            </>
          )}

          <h3 className="step">3 · Focus the stone</h3>
          {!cuPhoto ? (
            <p className="locked">Attach the close-up photo first.</p>
          ) : (
            <>
              <div
                className="cuphoto tapzone"
                onClick={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  updateCloseup(openCloseup, { focusTap: {
                    fx: (e.clientX - r.left) / r.width,
                    fy: (e.clientY - r.top) / r.height,
                  } });
                  invalidateCuResult(openCloseup);
                }}
              >
                <img src={cuPhoto.url} alt={`close-up of candidate ${cuNo}`} />
                {openBundle.focusTap && !cuBox && (
                  <span
                    className="focusmark" aria-hidden="true"
                    style={{
                      left: `${openBundle.focusTap.fx * 100}%`,
                      top: `${openBundle.focusTap.fy * 100}%`,
                    }}
                  />
                )}
                {cuBox && (
                  <svg viewBox={`0 0 ${cuPhoto.w} ${cuPhoto.h}`} aria-hidden="true">
                    <rect
                      x={cuBox[0]} y={cuBox[1]} width={cuBox[2]} height={cuBox[3]}
                      fill="none" stroke="#f5b301"
                      strokeWidth={chromeSizes(cuSu, 1, true).stroke}
                    />
                  </svg>
                )}
              </div>
              <p className="hint">
                {openBundle.focusTap
                  ? 'Focused on your tap.'
                  : 'No tap — the center stone will be used.'}
              </p>
              {openBundle.focusTap && (
                <div className="btnrow">
                  <button
                    type="button" className="ghost"
                    onClick={() => { updateCloseup(openCloseup, { focusTap: null }); invalidateCuResult(openCloseup); }}
                  >
                    Use center stone instead
                  </button>
                </div>
              )}
            </>
          )}

          <h3 className="step">4 · Personal note</h3>
          {!cuPhoto ? (
            <p className="locked">Attach the close-up photo first.</p>
          ) : (
            <label className="cunote">
              <span className="notelabel">
                Hardness note <span className="tag">stays on this device</span>
              </span>
              <textarea
                rows={2}
                value={openBundle.note}
                placeholder="e.g. where found, who it belongs to"
                onChange={(e) => updateCloseup(openCloseup, { note: e.target.value })}
              />
            </label>
          )}

          <h3 className="step">5 · Scratch test</h3>
          {!cuPhoto ? (
            <p className="locked">Attach the close-up photo first.</p>
          ) : (
            <>
              <p className="warn">
                Test an inconspicuous spot with light pressure.
                Skip any test that could damage a stone you want to keep.
              </p>
              {TOOLS.map((t, i) => {
                const answers = (openBundle.scratch || {}).answers || {};
                const recorded = answers[i];
                const isNext = !cuRange.stopped && i === cuRange.next;
                return (
                  <div
                    key={t.id}
                    className={`toolcard${recorded ? ' done' : ''}${!recorded && !isNext ? ' dim' : ''}`}
                  >
                    <p className="toolhead">{t.label} <span className="muted">~{t.h}</span></p>
                    {recorded ? (
                      <p className="choice">
                        {recorded === 'stone_scratches_tool'
                          ? `Stone scratches ${t.label.toLowerCase()}`
                          : recorded === 'tool_scratches_stone'
                            ? `${t.label} scratches stone`
                            : 'No mark either way'}
                      </p>
                    ) : isNext ? (
                      <div className="btnrow col">
                        <button type="button" onClick={() => {
                          updateCloseup(openCloseup, { scratch: { answers: { ...answers, [i]: 'stone_scratches_tool' } } });
                          invalidateCuResult(openCloseup);
                        }}>
                          Stone scratches {t.label.toLowerCase()}
                        </button>
                        <button type="button" onClick={() => {
                          updateCloseup(openCloseup, { scratch: { answers: { ...answers, [i]: 'tool_scratches_stone' } } });
                          invalidateCuResult(openCloseup);
                        }}>
                          {t.label} scratches stone
                        </button>
                        <button type="button" onClick={() => {
                          updateCloseup(openCloseup, { scratch: { answers: { ...answers, [i]: 'no_scratch' } } });
                          invalidateCuResult(openCloseup);
                        }}>
                          No mark either way
                        </button>
                      </div>
                    ) : cuRange.stopped ? (
                      <p className="hint">
                        {cuRange.label
                          ? `Test complete — hardness range ${cuRange.label}.`
                          : 'Test complete — no clear range.'}
                      </p>
                    ) : (
                      <p className="hint">Locked until the previous step is answered.</p>
                    )}
                  </div>
                );
              })}
              {cuHasAnswers && (
                <div className="rangebanner">
                  {cuRange.label ? (
                    <>
                      <p>Hardness range: {cuRange.label}.</p>
                      {cuRange.approx != null && cuRange.lo != null && (
                        <p className="hint">
                          Supporting: stone scratched {toolName(cuRange.lo)} (~{cuRange.lo});
                          no mark with {toolName(cuRange.approx)}.
                        </p>
                      )}
                      <p className="hint">Guided hardness result is sent with the close-up scan.</p>
                    </>
                  ) : cuRange.stopped ? (
                    <>
                      <p>Hardness: inconclusive — no tool scratched the stone and the stone scratched no tool.</p>
                      <p className="hint">
                        Light pressure, a dirty surface, or the test spot can cause this.
                        Clean the stone and retest on a fresh spot — or scan with hardness unknown.
                      </p>
                      {cuRange.unknown && (
                        <p className="hint">Hardness unknown will be sent with the close-up scan.</p>
                      )}
                    </>
                  ) : cuCanStop ? (
                    <p className="hint">Stop now to lock in {cuStopLabel}, or keep testing.</p>
                  ) : null}
                  <div className="btnrow">
                    {cuCanStop && (
                      <button
                        type="button"
                        onClick={() => { updateCloseup(openCloseup, { scratch: { answers: cuAnswers, stopped: cuStopLabel } }); invalidateCuResult(openCloseup); }}
                      >
                        Stop here — use this range
                      </button>
                    )}
                    {cuRange.inconclusive && !cuRange.unknown && (
                      <button
                        type="button"
                        onClick={() => { updateCloseup(openCloseup, { scratch: { answers: cuAnswers, stopped: null, unknown: true } }); invalidateCuResult(openCloseup); }}
                      >
                        Scan anyway with hardness unknown
                      </button>
                    )}
                    <button
                      type="button" className="ghost"
                      onClick={() => { updateCloseup(openCloseup, { scratch: { answers: {}, stopped: null, unknown: null } }); invalidateCuResult(openCloseup); }}
                    >
                      Start over
                    </button>
                  </div>
                </div>
              )}
            </>
          )}

          <h3 className="step">6 · Scan</h3>
          {cuReady ? (confirmLive === openCloseup ? (
            <div className="confirm">
              {openBundle.projecting || !openBundle.proj ? (
                <p className="status" role="status">
                  <span className="spin" aria-hidden="true" />
                  Preparing live scan…
                </p>
              ) : !openBundle.proj.data ? (
                <p className="hint">Live scan check did not respond — you can still continue.</p>
              ) : null}
              {liveAvail === false && (
                <p className="error">live scans unavailable — proxy key missing.</p>
              )}
              <div className="btnrow">
                <button
                  type="button" className="primary"
                  disabled={openBundle.busy || openBundle.projecting || !openBundle.proj
                    || liveAvail === false}
                  onClick={() => scanCloseup(openCloseup, 'live')}
                >
                  Confirm live scan
                </button>
                <button type="button" onClick={() => setConfirmLive(null)}>
                  Back
                </button>
              </div>
            </div>
          ) : (
            <div className="btnrow scanrow">
              <button
                type="button" className="primary"
                disabled={openBundle.busy}
                onClick={() => requestCloseupLive(openCloseup)}
              >
                Scan close-up
              </button>
            </div>
          )) : null}
          {(openBundle.status || openBundle.busy) && (
            <p className="status" role="status">
              {openBundle.busy && <span className="spin" aria-hidden="true" />}
              {openBundle.status}
            </p>
          )}
          {openBundle.error && <p className="error">{openBundle.error}</p>}

          {openBundle.result && (
            <>
              <h3 className="step">7 · Result — one stone</h3>
              <p>{openBundle.result.stone.description}</p>
              <p className="hint">
                {cuResultUnknown
                  ? 'Hardness: unknown (inconclusive test)'
                  : 'Hardness range used: ' + (openBundle.result.hardness.range
                    ? openBundle.result.hardness.range.label : 'none recorded')}
                {' · '}Cleaned: {openBundle.result.hardness.cleaned === true
                  ? 'yes' : openBundle.result.hardness.cleaned === false ? 'no' : 'unknown'}
              </p>
              <div className="suggestions">
                <h4>{cuResultUnknown
                  ? 'Hardness unknown — suggestions are visual only.'
                  : 'Possible identities — not confirmed'}</h4>
                {openBundle.result.suggestions.length === 0 ? (
                  <p className="hint">{openBundle.result.note || 'No suggestions.'}</p>
                ) : (
                  <ol>
                    {openBundle.result.suggestions.map((s) => (
                      <li key={s.rank}>
                        <p className="sugname">#{s.rank} {s.name}</p>
                        <p>Supporting: {s.supporting.join('; ')}</p>
                        <p>Uncertain or contradicting: {s.contradicting.join('; ')}</p>
                        <p>Next check: {s.next_check}</p>
                      </li>
                    ))}
                  </ol>
                )}
              </div>
              {openBundle.result.parse_error && (
                <p className="error">{openBundle.result.parse_error}</p>
              )}
              <div className="btnrow">
                <button type="button" onClick={() => saveRock(openCloseup)}>
                  {openBundle.savedId != null ? 'Saved ✓' : 'Save this rock'}
                </button>
              </div>
            </>
          )}
          <input
            ref={closeLibRef}
            type="file"
            accept="image/jpeg,image/*"
            hidden
            onChange={(e) => { onCloseFile(openCloseup, e.target.files[0]); e.target.value = ''; }}
          />
          <input
            ref={closeCamRef}
            type="file"
            accept="image/jpeg,image/*"
            capture="environment"
            hidden
            onChange={(e) => { onCloseFile(openCloseup, e.target.files[0]); e.target.value = ''; }}
          />
        </section>
      )}

      {openCloseup === null && (
      <section className="panel">
        <div className="btnrow scanrow">
          <button type="button" className="primary" disabled={busy || projecting} onClick={() => requestBedLive()}>
            Scan
          </button>
          <button type="button" disabled={busy || projecting} onClick={() => scan('demo')}>
            Demo <span>banked</span>
          </button>
        </div>
        {projecting && (
          <p className="status" role="status">
            <span className="spin" aria-hidden="true" />
            Preparing live scan…
          </p>
        )}
        {bedProj && !projecting && (
          <div className="confirm">
            {!bedProj.data && (
              <p className="hint">Live scan check did not respond — you can still continue.</p>
            )}
            {liveAvail === false && (
              <p className="error">live scans unavailable — proxy key missing.</p>
            )}
            <div className="btnrow">
              <button
                type="button" className="primary"
                disabled={liveAvail === false}
                onClick={() => confirmBedLive()}
              >
                Confirm live scan
              </button>
              <button type="button" onClick={() => setBedProj(null)}>
                Back
              </button>
            </div>
          </div>
        )}
        {busy && (
          <div className="btnrow">
            <button type="button" className="ghost" onClick={cancel}>Cancel</button>
          </div>
        )}
        {(status || busy) && (
          <p className="status" role="status">
            {busy && <span className="spin" aria-hidden="true" />}
            {status}
          </p>
        )}
        {error && <p className="error">{error}</p>}
      </section>
      )}

      {result && (
        <section className="panel">
          {openCloseup === null && (
          <h2>
            {kept.length} candidates at 85% or above
            {mode === 'demo' && <span className="tag">banked</span>}
            {mode === 'dry' && <span className="tag">dry run</span>}
            {focus !== null && (
              <button
                type="button" className="clearbtn"
                onClick={() => clearBedView()}
              >
                Show all
              </button>
            )}
          </h2>
          )}
          {showSplash ? (
            <div className="splashprompt">
              <p>{SPLASH_COPY}</p>
              <div className="btnrow">
                <button
                  type="button" className="primary"
                  onClick={() => fileRef.current?.click()}
                >
                  {SPLASH_PRIMARY}
                </button>
                <button
                  type="button"
                  onClick={() => setDismissedSplash(scanSeq.current)}
                >
                  {SPLASH_DISMISS}
                </button>
              </div>
            </div>
          ) : (
          <ol className="ranks">
            {(shown || []).map((c, i) => (
              <li key={c.id} className={c.id === focusId ? 'active' : ''}>
                <button
                  type="button" className="rankbtn"
                  aria-pressed={c.id === focusId}
                  onClick={() => tapEntry(c.id)}
                >
                  <span className="rankline">
                    <span className="rank">#{i + 1}</span>
                    <span className="score">{scoreLabel(c.score)}</span>
                  </span>
                  <span className="bar" aria-hidden="true">
                    <span className="fill" style={{ width: `${Math.round(c.score * 100)}%` }} />
                  </span>
                  <span className="reason">{c.reason}</span>
                </button>
              </li>
            ))}
          </ol>
          )}
        </section>
      )}

      <section ref={savedRef} className="panel">
        <h2>
          Saved rocks <span className="count">{rocks.length}</span>
          <span className="tag">saved on this device</span>
        </h2>
        {savedError && <p className="error">{savedError}</p>}
        {openSavedEntry ? (
          <>
            <h3 className="step">Close-up #{savedDisplayNo(openSavedEntry)} — saved rock</h3>
            <BlobImg blob={openSavedEntry.photo} className="savedphoto" alt="saved close-up" />
            <p>{openSavedEntry.description}</p>
            <p className="hint">
              Hardness: {openSavedEntry.hardness}
              {' · '}Cleaned: {cleanedLabel(openSavedEntry.cleaned)}
              {' · '}{formatDate(openSavedEntry.ts)}
            </p>
            {openSavedEntry.note && <p>Note: {openSavedEntry.note}</p>}
            <div className="suggestions">
              <h4>Possible identities — not confirmed</h4>
              {openSavedEntry.suggestions.length === 0 ? (
                <p className="hint">
                  {openSavedEntry.dryRun ? DRY_NO_SUGGESTIONS : 'No suggestions.'}
                </p>
              ) : (
                <ol>
                  {openSavedEntry.suggestions.map((s) => (
                    <li key={s.rank}>
                      <p className="sugname">#{s.rank} {s.name}</p>
                      <p>Supporting: {s.supporting.join('; ')}</p>
                      <p>Uncertain or contradicting: {s.contradicting.join('; ')}</p>
                      <p>Next check: {s.next_check}</p>
                    </li>
                  ))}
                </ol>
              )}
            </div>
            <div className="btnrow">
              <button type="button" className="ghost" onClick={() => removeRock(openSavedEntry.id)}>
                Remove
              </button>
              <button type="button" onClick={() => setOpenSaved(null)}>
                Back to saved rocks
              </button>
            </div>
          </>
        ) : rocks.length === 0 ? (
          <p className="hint">No saved rocks yet — save one from a close-up result.</p>
        ) : (
          <ol className="ranks">
            {rocks.map((r) => (
              <li key={r.id}>
                <button
                  type="button" className="rockrow"
                  onClick={() => openSavedDetail(r.id)}
                >
                  <BlobImg blob={r.photo} className="rockthumb" alt="" />
                  <span className="rockmeta">
                    <span className="rockdesc">{r.description}</span>
                    <span className="hint">
                      Hardness: {r.hardness} · {formatDate(r.ts)}
                    </span>
                    <span className="hint">{rowIdentity(r)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ol>
        )}
      </section>
    </main>
  );
}
