/**
 * The editor's crash / reload safety net (2026-10-21, EDITOR_REVIEW_2026_10 A1): the last autosaved
 * project, kept in IndexedDB until a real save or a deliberate load replaces it. One record:
 *   { buf: ArrayBuffer (.v3proj bytes), savedAt: ms since epoch, terrain: { worldSize, heightmapSize, maxHeight } }
 * Same database as pendingLoad.js ("v3-editor" / "pending"), another key — no schema change.
 * Every call degrades to a no-op / null when IndexedDB is unavailable (private window, blocked storage).
 */
const DB_NAME = "v3-editor";
const STORE   = "pending";
const KEY     = "autosave";

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run(mode, fn) {
  let db;
  try { db = await openDB(); } catch { return null; }
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req?.result ?? null);
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

/** Replace the autosave. */
export const putAutosave = (record) => run("readwrite", (s) => s.put(record, KEY)).catch(() => null);
/** The autosave, or null. */
export const getAutosave = () => run("readonly", (s) => s.get(KEY)).catch(() => null);
/** Forget it (after a real save, or when the user discards it). */
export const clearAutosave = () => run("readwrite", (s) => s.delete(KEY)).catch(() => null);
