/**
 * Persistent cache for the rock & cliff panel thumbnails (IndexedDB).
 *
 * Each tile is a small PNG data URL keyed by its generator params + the bake
 * settings, so a preset change rebakes only that tile, and a hit costs no
 * geometry generation at all. IndexedDB, not localStorage: 16+ PNGs as base64
 * would eat most of the 5 MB localStorage budget other editor state shares.
 *
 * The key cannot see source: if the generator or the shading changes how a
 * rock LOOKS without its params changing, bump THUMB_VERSION.
 */

export const THUMB_VERSION = 2;

const DB_NAME = "v3-rock-thumbnails";
const STORE = "tiles";

let _dbPromise = null;
function openDB() {
  if (!_dbPromise) {
    _dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }).catch(() => null); // private browsing without IDB: work uncached
  }
  return _dbPromise;
}

/** Cache key for one tile. */
export function thumbKey(params, size) {
  return `v${THUMB_VERSION}|${size}|${JSON.stringify(params)}`;
}

/** Data URL for a key, or null. */
export async function getThumb(key) {
  const db = await openDB();
  if (!db) return null;
  return new Promise((resolve) => {
    const req = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => resolve(null);
  });
}

export async function putThumb(key, dataUrl) {
  const db = await openDB();
  if (!db) return;
  await new Promise((resolve) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(dataUrl, key);
    tx.oncomplete = resolve;
    tx.onerror = resolve;
  });
}
