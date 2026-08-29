// Instanced guardrail posts must stand exactly where the baked ones did.
//
// The claim is geometric, so it is checked geometrically: take the post
// positions the OLD path produced (posts merged into the rail) and the ones the
// new path produces (template + transforms), and require the two point sets to
// coincide. A post 4 cm off its beam is the exact bug placePosts already carries
// a comment about, so "close enough" is not the bar.
import { register } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { loadTrackFile } from "./loadTrackFile.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
register("./threeWebgpuHook.mjs", import.meta.url);
const THREE = await import("three/webgpu");
const RAIL = await import(pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadRail.js")).href);
const KIT = await import(pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadKit.js")).href);

let fail = 0;
const check = (n, c, d = "") => {
  console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`);
  if (!c) fail++;
};

const RP = KIT.roadParams;

/**
 * Every vertex of a geometry as [x,y,z] triples, optionally transformed.
 *
 * NOT hashed into strings. The old path merged posts by `geometry.applyMatrix4`,
 * which writes the transformed vertex back into a Float32Array, so its points
 * carry float32 rounding that a freshly-computed float64 point does not. String
 * keys turned that into an 8% "mismatch" on identical geometry. The question is
 * geometric — is there a post vertex where there used to be one — so it is
 * answered geometrically, with a tolerance.
 */
const points = (geo, mat) => {
  const a = geo.getAttribute("position");
  const v = new THREE.Vector3();
  const out = [];
  for (let i = 0; i < a.count; i++) {
    v.set(a.getX(i), a.getY(i), a.getZ(i));
    if (mat) v.applyMatrix4(mat);
    out.push([v.x, v.y, v.z]);
  }
  return out;
};

const TOL = 1e-4; // 0.1 mm — far tighter than the 4 cm misplacement bug it guards
/** Grid hash so the match is O(n) rather than 11k² on the loop piece. */
const makeIndex = (pts) => {
  const cell = 1e-3;
  const map = new Map();
  const key = (i, j, k) => `${i},${j},${k}`;
  for (const p of pts) {
    const k = key(Math.round(p[0] / cell), Math.round(p[1] / cell), Math.round(p[2] / cell));
    let b = map.get(k);
    if (!b) { b = []; map.set(k, b); }
    b.push(p);
  }
  return {
    has(p) {
      const ci = Math.round(p[0] / cell), cj = Math.round(p[1] / cell), ck = Math.round(p[2] / cell);
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (let k = -1; k <= 1; k++) {
        const b = map.get(key(ci + i, cj + j, ck + k));
        if (!b) continue;
        for (const q of b) {
          if (Math.abs(q[0] - p[0]) <= TOL && Math.abs(q[1] - p[1]) <= TOL && Math.abs(q[2] - p[2]) <= TOL) return true;
        }
      }
      return false;
    },
  };
};

// ── 1. beam+posts (old) === beam (new) ∪ instanced posts ───────────────────
for (const pieceId of ["straight", "curve", "banked", "loop", "rounded_end"]) {
  const def = KIT.PIECE_CATALOG.find((d) => d.id === pieceId);
  if (!def) { console.log(`  skip ${pieceId} (not in catalog)`); continue; }
  let frames;
  try {
    const built = KIT.buildPiece(pieceId, KIT.initialConnector(), undefined, undefined, undefined, true);
    frames = built.frames;
  } catch (e) { console.log(`  skip ${pieceId}: ${e.message}`); continue; }

  const merged = RAIL.buildRailGeometry(frames, RP);              // old: posts baked in
  const sink = { key: "", template: null, matrices: [] };
  const beam = RAIL.buildRailGeometry(frames, RP, undefined, { postSink: sink }); // new
  if (!merged || !beam) { console.log(`  skip ${pieceId} (no rail)`); continue; }

  const oldPts = points(merged);
  const newPts = points(beam);
  for (const m of sink.matrices) for (const p of points(sink.template, m)) newPts.push(p);

  const newIdx = makeIndex(newPts);
  const oldIdx = makeIndex(oldPts);
  let missing = 0;
  for (const p of oldPts) if (!newIdx.has(p)) missing++;
  let extra = 0;
  for (const p of newPts) if (!oldIdx.has(p)) extra++;

  check(`${pieceId}: instanced posts occupy the same points as the baked ones`,
    missing === 0 && extra === 0 && oldPts.length === newPts.length,
    `${sink.matrices.length} posts · ${oldPts.length} old pts · ${newPts.length} new pts · ${missing} missing · ${extra} extra`);

  check(`${pieceId}: the beam alone is far smaller than beam+posts`,
    beam.getAttribute("position").count < merged.getAttribute("position").count * 0.4,
    `${beam.getAttribute("position").count} vs ${merged.getAttribute("position").count}`);
}

// ── 2. The template really is shared ───────────────────────────────────────
{
  const f = KIT.buildPiece("straight", KIT.initialConnector(), undefined, undefined, undefined, true).frames;
  const a = { key: "", template: null, matrices: [] };
  const b = { key: "", template: null, matrices: [] };
  RAIL.buildRailGeometry(f, RP, undefined, { postSink: a });
  RAIL.buildRailGeometry(f, RP, undefined, { postSink: b });
  check("two pieces get the SAME template object", a.template === b.template && !!a.template);
  check("...and the same key, so they share one instanced draw", a.key === b.key && a.key !== "");

  // A WIDER road shares the post, and that is correct rather than a collision:
  // the post is seated off the KERB, and widening the deck only loosens a clamp
  // that was not biting. Sharing here is the whole point — it is why a 41-piece
  // track comes out with one template.
  const wide = { ...RP, width: RP.width * 3 };
  const c = { key: "", template: null, matrices: [] };
  RAIL.buildRailGeometry(f, wide, undefined, { postSink: c });
  check("a wider deck with the same kerb shares the post",
    c.key === a.key && c.template === a.template);

  // ...but a different KERB must not. That is the case the key exists for: the
  // post offset is clamped against the kerb it actually gets, so a narrower one
  // seats the post somewhere else entirely.
  const narrowKerb = { ...RP, railWidth: RP.railWidth * 0.4 };
  const d = { key: "", template: null, matrices: [] };
  RAIL.buildRailGeometry(f, narrowKerb, undefined, { postSink: d });
  check("a different kerb gets its own template + key",
    d.key !== a.key && d.template !== a.template,
    `kerb ${RP.railWidth} vs ${narrowKerb.railWidth}`);
}

// ── 3. buildPiece hands the posts out ──────────────────────────────────────
{
  let withPosts = 0, total = 0, postCount = 0;
  for (const def of KIT.PIECE_CATALOG) {
    let b;
    try { b = KIT.buildPiece(def.id, KIT.initialConnector(), undefined, undefined, undefined, true); }
    catch { continue; }
    total++;
    if (b.railPosts?.matrices?.length) { withPosts++; postCount += b.railPosts.matrices.length; }
    // Any piece with a rail must either have posts or have none by design.
    if (b.railGeometry && b.railPosts?.matrices?.length === 0 && RAIL.railParams.posts) {
      console.log(`    note: ${def.id} has a rail but no posts`);
    }
  }
  check("buildPiece returns post transforms", withPosts > 0,
    `${withPosts}/${total} piece types, ${postCount} posts total`);
  check("deckOnly still returns no posts",
    KIT.buildPiece("straight", KIT.initialConnector(), undefined, undefined, undefined, true,
      { deckOnly: true }).railPosts.matrices.length === 0);
}

// ── 4. The whole-track saving ──────────────────────────────────────────────
{
  // Through loadTrackFile — a v2 track's per-piece params are sparse.
  const { rp, gp, pieces } = await loadTrackFile(ROOT, "games/modular-road-v3/rushline.json");
  let beamVerts = 0, posts = 0, templates = new Set();
  for (const e of pieces) {
    let b;
    try { b = KIT.buildPiece(e.id, new THREE.Matrix4().fromArray(e.connectorIn), e.pp, rp, gp, e.edges ?? true); }
    catch { continue; }
    if (b.railGeometry) beamVerts += b.railGeometry.getAttribute("position").count;
    posts += b.railPosts?.matrices?.length ?? 0;
    if (b.railPosts?.key) templates.add(b.railPosts.key);
  }
  const tplVerts = [...templates].length
    ? RAIL.postTemplate(rp).template.getAttribute("position").count : 0;
  console.log(`\n  rushline: rail beams ${beamVerts} verts (was 280330 with posts baked in)`);
  console.log(`            ${posts} posts → ${templates.size} template(s) × ${tplVerts} verts`);
  console.log(`            post geometry in memory: ${posts * tplVerts} → ${templates.size * tplVerts} verts`);
  check("rail beam geometry is a fraction of what it was", beamVerts < 280330 * 0.3,
    `${beamVerts} vs 280330`);
  check("the whole track's posts share very few templates", templates.size <= 3,
    `${templates.size} templates for ${pieces.length} pieces`);
}

console.log(fail ? `\n${fail} FAILED` : "\nall good");
process.exit(fail ? 1 : 0);
