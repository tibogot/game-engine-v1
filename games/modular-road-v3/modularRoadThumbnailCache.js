/**
 * Persistent store for the palette's baked piece thumbnails (IndexedDB).
 *
 * The bake in modularRoadThumbnails.js renders ~175 tiles and encodes them into
 * a sprite sheet. Doing that on every page load is seconds of work for output
 * that only changes when the catalog, the road look or the geometry code
 * changes — so it is baked once and read back from here.
 *
 * NOT localStorage: the sheet is a couple of MB, past its ~5 MB quota once the
 * bytes are base64'd into strings. Blobs in IndexedDB stay binary.
 *
 * ── Invalidation ───────────────────────────────────────────────────────────
 * A cached bake is only reused when its signature matches, and the signature
 * covers what can actually be read at runtime: every item's id + params, the
 * tile size, and the live road look. Adding a piece, retuning a preset or
 * changing a colour therefore rebakes on its own.
 *
 * What it CANNOT see is source: editing buildPiece(), a prop's make(), or the
 * framing/lighting in the baker changes the pixels while the signature stays
 * put. That is what THUMB_CACHE_VERSION and the "Rebake" escape hatches are
 * for — cheap and explicit beats a fingerprint that is subtly wrong.
 */

const DB_NAME = "modular-road-thumbnails";
const DB_VERSION = 1;
const STORE = "bakes";

/** Bump BY HAND after changing piece geometry, a prop's make(), or the baker's
 *  own camera/lighting — see the invalidation note above. It also covers the
 *  stored SHAPE: v2 is the sprite sheet, v1 was one Blob per tile. */
export const THUMB_CACHE_VERSION = 19;

/** FNV-1a, 32-bit. Only needs to change when its input changes; not a hash
 *  anything depends on for security. */
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/**
 * Content key for one bake. Items are hashed in order, so a reordered palette
 * counts as a change too (the tiles are keyed by id, but the cheap check is
 * worth more than the rare needless rebake).
 *
 * @param {{key:string, pieceId?:string, params?:object, make?:Function}[]} items
 * @param {object} [extra] anything else the pixels depend on — tile size, look
 */
export function thumbnailSignature(items, extra = {}) {
  const parts = items.map((it) =>
    it.make
      ? `${it.key}|make` // a builder function; its output is invisible from here
      : `${it.key}|${it.pieceId}|${JSON.stringify(it.params ?? {})}`,
  );
  parts.push(JSON.stringify(extra));
  return `v${THUMB_CACHE_VERSION}.${items.length}.${fnv1a(parts.join("\n"))}`;
}

/** Resolves null instead of throwing: private-mode browsers, a corrupt store or
 *  a blocked upgrade must cost a rebake, never the editor. */
function openDb() {
  return new Promise((resolve) => {
    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "sig" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
}

/** A bake is only usable if the sheets AND the index survived the round trip;
 *  a half-written record has to read as a miss, not as an empty palette. */
const isBake = (b) =>
  !!b && Array.isArray(b.sheets) && b.sheets.length > 0
  && b.sheets.every((s) => s?.blob instanceof Blob)
  && b.cells instanceof Map && b.cells.size > 0;

/**
 * @param {string} sig from thumbnailSignature()
 * @returns {Promise<object|null>} the bake, or null on a miss OR any failure
 */
export async function loadThumbnailCache(sig) {
  const db = await openDb();
  if (!db) return null;
  try {
    const rec = await new Promise((resolve) => {
      let req;
      try {
        req = db.transaction(STORE, "readonly").objectStore(STORE).get(sig);
      } catch {
        resolve(null);
        return;
      }
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => resolve(null);
    });
    return isBake(rec?.bake) ? rec.bake : null;
  } finally {
    db.close();
  }
}

/**
 * Store one bake, dropping every older one — a stale signature is dead weight
 * (a bake is a couple of MB) and there is nothing to go back to.
 *
 * @param {string} sig
 * @param {object} bake as returned by bakeRoadThumbnails()
 */
export async function saveThumbnailCache(sig, bake) {
  if (!isBake(bake)) return false;
  const db = await openDb();
  if (!db) return false;
  try {
    return await new Promise((resolve) => {
      let tx;
      try {
        tx = db.transaction(STORE, "readwrite");
      } catch {
        resolve(false);
        return;
      }
      const store = tx.objectStore(STORE);
      store.clear();
      store.put({ sig, bake, savedAt: Date.now() });
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
    });
  } finally {
    db.close();
  }
}

/** Wipe every cached bake — the dev-panel "Rebake thumbnails" button and the
 *  `?rebake=1` URL flag both go through here before baking. */
export async function clearThumbnailCache() {
  const db = await openDb();
  if (!db) return false;
  try {
    return await new Promise((resolve) => {
      let tx;
      try {
        tx = db.transaction(STORE, "readwrite");
      } catch {
        resolve(false);
        return;
      }
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
    });
  } finally {
    db.close();
  }
}
