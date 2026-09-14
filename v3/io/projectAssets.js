/**
 * v3/io/projectAssets.js — files a user imported from disk, kept INSIDE the
 * project so it reloads anywhere (and a game loading the project by URL gets
 * them too).
 *
 * Before this, an imported texture, GLB or material folder saved only its
 * FILE NAME. It survived a reload only if a file of that name happened to sit
 * in public/, so a dropped paint texture came back as the slot's default, an
 * imported GLB prop vanished with every copy of it, and so on.
 *
 * How it works:
 *   - `add(file)` keeps the ORIGINAL bytes (not decoded pixels), keyed by a
 *     content hash, and returns that hash. The same file imported twice, or
 *     used by several slots, is stored once.
 *   - Callers save a reference string `asset:<hash>` in the place they used to
 *     save a URL or a name.
 *   - `resolveUrl(ref)` turns such a reference into an object URL for loaders
 *     that take URLs; `fileFor(ref)` gives a File for loaders that take files.
 *     Anything else passes through unchanged, so old projects keep working.
 *   - The save scans the project data for `asset:` references and writes only
 *     those assets as blobs (projectIO), so a texture you replaced is not
 *     carried along forever.
 *
 * One shared store for the page: every tool imports `projectAssets`.
 */

export const ASSET_PREFIX = "asset:";
const HASH_RE = /asset:([0-9a-f]{40})/g;

export function isAssetRef(ref) {
  return typeof ref === "string" && ref.startsWith(ASSET_PREFIX);
}

export function assetRef(hash) {
  return hash ? `${ASSET_PREFIX}${hash}` : null;
}

async function _sha1Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-1", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function _guessType(name) {
  const ext = (name.split(".").pop() || "").toLowerCase();
  return {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp",
    ktx2: "image/ktx2", hdr: "image/vnd.radiance", glb: "model/gltf-binary",
    gltf: "model/gltf+json", json: "application/json",
  }[ext] ?? "application/octet-stream";
}

export class ProjectAssets {
  constructor() {
    /** @type {Map<string, { hash:string, name:string, type:string, bytes:Uint8Array }>} */
    this._byHash = new Map();
    /** @type {Map<string, string>} hash → object URL (created lazily, kept for the session) */
    this._urls = new Map();
  }

  get size() { return this._byHash.size; }

  /** Keep a File or Blob's bytes; returns its hash (same bytes → same hash). */
  async add(fileOrBlob, name = fileOrBlob?.name ?? "asset") {
    const bytes = new Uint8Array(await fileOrBlob.arrayBuffer());
    const hash = await _sha1Hex(bytes);
    if (!this._byHash.has(hash)) {
      this._byHash.set(hash, { hash, name, type: fileOrBlob.type || _guessType(name), bytes });
    }
    return hash;
  }

  /** Store a file and return the `asset:<hash>` reference for it. */
  async addRef(fileOrBlob, name) {
    return assetRef(await this.add(fileOrBlob, name));
  }

  _hashOf(ref) {
    if (!isAssetRef(ref)) return null;
    return ref.slice(ASSET_PREFIX.length);
  }

  has(ref) {
    const h = this._hashOf(ref) ?? ref;
    return this._byHash.has(h);
  }

  /** Object URL for an `asset:` reference; any other string is returned as-is. */
  resolveUrl(ref) {
    const hash = this._hashOf(ref);
    if (!hash) return ref;
    const a = this._byHash.get(hash);
    if (!a) return null;
    let url = this._urls.get(hash);
    if (!url) {
      url = URL.createObjectURL(new Blob([a.bytes], { type: a.type }));
      this._urls.set(hash, url);
    }
    return url;
  }

  /** A File for an `asset:` reference (null if unknown). */
  fileFor(ref) {
    const hash = this._hashOf(ref);
    const a = hash ? this._byHash.get(hash) : null;
    return a ? new File([a.bytes], a.name, { type: a.type }) : null;
  }

  nameOf(ref) {
    const hash = this._hashOf(ref);
    return (hash && this._byHash.get(hash)?.name) || null;
  }

  /** Hashes referenced anywhere inside a JSON-able value. */
  static referencedHashes(value) {
    const out = new Set();
    const text = JSON.stringify(value ?? null);
    for (const m of text.matchAll(HASH_RE)) out.add(m[1]);
    return out;
  }

  /** Assets to write into a project: only the ones `data` refers to. */
  collectFor(data) {
    const list = [];
    for (const hash of ProjectAssets.referencedHashes(data)) {
      const a = this._byHash.get(hash);
      if (a) list.push(a);
    }
    return list;
  }

  /** Add assets read back from a project file (bytes are copied out of the file buffer). */
  load(entries) {
    for (const e of entries ?? []) {
      if (!e?.hash || !e.bytes || this._byHash.has(e.hash)) continue;
      this._byHash.set(e.hash, { hash: e.hash, name: e.name ?? "asset", type: e.type || _guessType(e.name ?? ""), bytes: e.bytes.slice() });
    }
  }
}

/** The page's asset store. */
export const projectAssets = new ProjectAssets();
