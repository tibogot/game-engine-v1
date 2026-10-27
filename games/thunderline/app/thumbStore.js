// THE BUILDER DOCK'S PICTURES, KEPT (2026-10-27, builder load trace: drawing ~60 piece pictures at every
// load cost ~2.6 s of the GPU driver compiling shaders — their little scene has its own lights, so every
// piece material compiles a second time just for them). A picture is kept per piece and rails setting with
// the SIGNATURE it was drawn for (builder3.js thumbSig: the piece's geometry + the look's code); a changed
// piece gets a new signature and is drawn again. Its own database: the ghosts' one (ghostStore.js) is
// opened at version 1 and a new store would need a version bump there.
const DB = "thunderline-thumbs", STORE = "thumbs";

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
async function tx(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = t.onabort = () => reject(t.error);
  });
}

export const thumbStore = {
  /** every kept picture: Map key → { sig, url } (one read for the whole dock) */
  async all() {
    try {
      const d = await db();
      return await new Promise((resolve, reject) => {
        const out = new Map();
        const t = d.transaction(STORE, "readonly");
        const req = t.objectStore(STORE).openCursor();
        req.onsuccess = () => { const c = req.result; if (c) { out.set(c.key, c.value); c.continue(); } };
        t.oncomplete = () => resolve(out);
        t.onerror = t.onabort = () => reject(t.error);
      });
    } catch (e) { console.warn("[thumbs] not read", e); return new Map(); }
  },
  /** keep a picture (fire and forget) */
  set(key, sig, url) {
    tx("readwrite", (s) => s.put({ sig, url }, key)).catch((e) => console.warn("[thumbs] not kept", e));
  },
};
