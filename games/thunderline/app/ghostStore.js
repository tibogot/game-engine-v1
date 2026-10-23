// GHOSTS IN INDEXEDDB (2026-10-23: saves were failing — "QuotaExceededError … thunderline.library.v1"). The
// ghosts filled the browser's 5 MB of localStorage on their own: 4.9 MB of it, up to 900 KB a run, one per
// track CONTENT (drive.js trackKey: every edit starts a new one) and none ever deleted — after that even a
// 10 KB track save failed. IndexedDB has no 5 MB cap and stores the ghost object as it is (no JSON text).
// The newest KEEP ghosts stay; older ones go. The ones still in localStorage move here once and leave it.
const DB = "thunderline", STORE = "ghosts", KEEP = 60, OLD_PREFIX = "thunderline.ghost.";

let dbp = null;
function db() {
  dbp ??= new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return dbp;
}
/** One transaction on the store; resolves with `fn`'s request result once it has committed. */
async function tx(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = t.onabort = () => reject(t.error);
  });
}

let moved = null;
/** Once per page: localStorage ghosts into the store, then out of localStorage (that frees the space). */
function moveOld() {
  moved ??= (async () => {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k?.startsWith(OLD_PREFIX)) keys.push(k); }
    for (const k of keys) {
      let data = null;
      try { data = JSON.parse(localStorage.getItem(k)); } catch {}
      if (data) await tx("readwrite", (s) => s.put({ data, at: 0 }, k.slice(OLD_PREFIX.length)));
      localStorage.removeItem(k);
    }
  })().catch((e) => console.warn("[ghosts] could not move the old ghosts", e));
  return moved;
}

export const ghosts = {
  /** the ghost for this track content, or null */
  async get(key) {
    try { await moveOld(); return (await tx("readonly", (s) => s.get(key)))?.data ?? null; } catch (e) { console.warn("[ghosts] not read", e); return null; }
  },
  /** keep this run as the content's ghost; true if saved */
  async set(key, data) {
    try {
      await moveOld();
      await tx("readwrite", (s) => s.put({ data, at: Date.now() }, key));
      await prune();
      return true;
    } catch (e) { console.warn("[ghosts] not saved", e); return false; }
  },
};

/** Only the newest KEEP ghosts stay (a moved one counts as the oldest). */
async function prune() {
  const [keys, recs] = await Promise.all([tx("readonly", (s) => s.getAllKeys()), tx("readonly", (s) => s.getAll())]);
  if (keys.length <= KEEP) return;
  const old = keys.map((k, i) => [k, recs[i]?.at ?? 0]).sort((a, b) => a[1] - b[1]).slice(0, keys.length - KEEP);
  await tx("readwrite", (s) => { for (const [k] of old) s.delete(k); });
}
