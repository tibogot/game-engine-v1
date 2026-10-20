// SHARE CODES (user, 2026-10-20: track settings + "a share code"): a whole track as one line of text to
// copy and paste, PolyTrack's way. "TL1." + base64url(deflate(JSON)). Short: a piece that hangs off
// another (`parent`) carries no matrix — its place IS its parent's exit — and the others are rounded to
// 4 decimals. Decoding lays the chain again from the pieces' own exits (kit.js), so a pasted track can be
// driven before it is ever opened in the builder.
import * as THREE from "three";
import { ensureTile, integrate, socketMatrix } from "../proto/kit/kit.js";
import "../proto/kit/oldTiles.js"; // the old kit's pieces (bowls, flip ramps, start, finish) resolve by id

const PREFIX = "TL1.";
const round = (M) => M.map((x) => Math.round(x * 1e4) / 1e4);

async function deflate(text) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Response(stream).text();
}
const toB64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

/** A library record's track as a share code. */
export async function encodeTrack(name, track) {
  const t = {
    ...track,
    pieces: (track.pieces ?? []).map((p) => { const q = { ...p }; if (q.parent != null) delete q.M; else q.M = round(q.M); return q; }),
    props: (track.props ?? []).map((o) => ({ ...o, M: round(o.M) })),
  };
  const bytes = await deflate(JSON.stringify({ n: name, t }));
  return PREFIX + toB64url(bytes);
}

/** A share code back to { name, track } (the chain laid again), or throws with a reason a player can read. */
export async function decodeTrack(code) {
  const s = String(code ?? "").trim();
  if (!s.startsWith(PREFIX)) throw new Error("That's not a Thunderline track code (it should start with TL1.)");
  let data;
  try { data = JSON.parse(await inflate(fromB64url(s.slice(PREFIX.length)))); } catch { throw new Error("The code is damaged or cut short: copy it again, whole."); }
  const track = data.t;
  if (!Array.isArray(track?.pieces)) throw new Error("The code holds no track.");
  // every piece on its parent's exit (parents come first in the list, as the builder keeps them)
  const byUid = new Map();
  for (const p of track.pieces) {
    if (p.parent != null) {
      const par = byUid.get(p.parent);
      const t = par && ensureTile(par.id);
      if (!t) throw new Error(`The code uses a piece this version doesn't know (${par?.id ?? "?"}).`);
      p.M = new THREE.Matrix4().fromArray(par.M).multiply(socketMatrix(integrate(t).exit)).toArray();
    }
    if (!p.ring && !ensureTile(p.id)) throw new Error(`The code uses a piece this version doesn't know (${p.id}).`);
    byUid.set(p.uid, p);
  }
  track.nextUid = Math.max(track.nextUid ?? 1, ...track.pieces.map((p) => p.uid + 1), ...(track.props ?? []).map((o) => o.uid + 1));
  return { name: String(data.n ?? "Shared track").slice(0, 40), track };
}
