// Saved rocks: device-only close-up store. Pure entry assembly and
// labels live here (unit-tested in node); the thin IndexedDB wrapper at
// the bottom only touches indexedDB when called, so importing this file
// in node is safe. Save makes no server, proxy, or API call — photo Blob
// plus metadata JSON stay in on-device IndexedDB.

export const DRY_NO_SUGGESTIONS = 'Dry run — no live suggestions';

// Pick exactly the displayed fields out of a close-up bundle + result.
// bedNo is the 1-based filtered display number shown in the UI; origRank
// is the 1-based original rank kept in metadata for debugging; ts is
// Date.now().
export function buildSavedEntry(bundle, result, bedNo, origRank, ts) {
  const hard = result.hardness || {};
  return {
    photo: bundle.photo.file,
    description: result.stone.description,
    hardness: hard.status === 'inconclusive'
      ? 'unknown'
      : (hard.range ? hard.range.label : 'unknown'),
    cleaned: hard.cleaned ?? null,
    note: bundle.note || '',
    suggestions: (result.suggestions || []).map((s) => ({
      rank: s.rank,
      name: s.name,
      supporting: [...s.supporting],
      contradicting: [...s.contradicting],
      next_check: s.next_check,
    })),
    dryRun: !!result.dry_run,
    bedNo,
    origRank,
    ts,
  };
}

// Displayed Close-up number for an entry; pre-filter saves stored bedId.
export function savedDisplayNo(entry) {
  if (entry.bedNo != null) return entry.bedNo;
  if (entry.bedId != null) return entry.bedId + 1;
  return null;
}

// One-line identity for a saved-list row.
export function rowIdentity(entry) {
  const top = (entry.suggestions || [])[0];
  if (top) return `${top.name} · possible — not confirmed`;
  if (entry.dryRun) return 'Dry run';
  return 'No suggestions';
}

export function cleanedLabel(cleaned) {
  if (cleaned === true) return 'yes';
  if (cleaned === false) return 'no';
  return 'unknown';
}

export function formatDate(ts) {
  return new Date(ts).toLocaleDateString(undefined,
    { year: 'numeric', month: 'short', day: 'numeric' });
}

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('gem-finder', 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('rocks',
        { keyPath: 'id', autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function idbAll() {
  return idbOpen().then((db) => new Promise((resolve, reject) => {
    const req = db.transaction('rocks', 'readonly').objectStore('rocks').getAll();
    req.onsuccess = () => { db.close(); resolve(req.result || []); };
    req.onerror = () => { db.close(); reject(req.error); };
  }));
}

export function idbAdd(entry) {
  return idbOpen().then((db) => new Promise((resolve, reject) => {
    const req = db.transaction('rocks', 'readwrite').objectStore('rocks').add(entry);
    req.onsuccess = () => { db.close(); resolve(req.result); };
    req.onerror = () => { db.close(); reject(req.error); };
  }));
}

export function idbDelete(id) {
  return idbOpen().then((db) => new Promise((resolve, reject) => {
    const req = db.transaction('rocks', 'readwrite').objectStore('rocks').delete(id);
    req.onsuccess = () => { db.close(); resolve(); };
    req.onerror = () => { db.close(); reject(req.error); };
  }));
}
