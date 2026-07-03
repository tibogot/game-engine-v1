/**
 * One-shot IndexedDB stash for a heightmap file that must survive a page
 * reload. Used when loading a .v3height whose dimensions differ from the
 * current terrain config: the editor saves the new config + stashes the file,
 * reloads, and the boot path imports and clears the stash.
 * (localStorage can't hold multi-MB binary payloads — hence IndexedDB.)
 */

const DB_NAME  = "v3-editor";
const STORE    = "pending";
const KEY      = "pendingHeightmap";

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Stash a heightmap ArrayBuffer to import after the next reload. */
export async function stashPendingHeightmap(buffer) {
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(buffer, KEY);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

/** Retrieve AND clear the stashed heightmap; resolves null if none. */
export async function takePendingHeightmap() {
  let db;
  try {
    db = await openDB();
  } catch {
    return null; // e.g. private browsing without IDB — degrade gracefully
  }
  const buffer = await new Promise((resolve) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const get = store.get(KEY);
    get.onsuccess = () => {
      store.delete(KEY);
      resolve(get.result ?? null);
    };
    get.onerror = () => resolve(null);
  });
  db.close();
  return buffer;
}
