// Banked pieces sweep a CURLED deck, not a flat plate rolled over.
//
// The complaint was that banked pieces looked "low poly / bad" next to a
// reference game, and the measurement backed it: the drivable deck of a long
// banked turn was 120 triangles and a bank-in was 30 — ONE quad across the full
// 14.5 m width. One quad has one normal, so the whole deck shaded as a single
// flat tone whatever the light did. The fix is a genuinely different SHAPE
// (buildBankProfile) rather than more polygons, and it has three ways to go
// wrong that a screenshot will not catch:
//
//   • THE SEAMS. Bank-in has to leave a FLAT section behind it (it mates with a
//     straight) and a FULLY CURLED one in front (it mates with a banked turn).
//     Get the easing wrong and every bank/straight junction in every saved track
//     grows a step. This is the one that matters.
//   • THE FACETS. The sweep emits un-shared bands per profile edge, so
//     computeVertexNormals gives a hard crease at EVERY profile point. Adding a
//     12-segment curve without weldSmoothProfileNormals makes the piece look
//     more low-poly, not less — 12 flat facets instead of 1.
//   • THE OPT-OUT. bankCurl = 0 has to reproduce the old flat piece exactly, or
//     there is no way to dial the look back.
//
// Drives the real builders — the kit imports cleanly under node.
import * as THREE from "three";

const kit = await import(
  new URL("../games/modular-road-v3/modularRoadKit.js", import.meta.url).href
);
const {
  buildPiece, buildProfile, buildBankProfile, roadParams, pieceParams, guardrailParams,
} = kit;

let failures = 0;
const ok = (cond, label, detail = "") => {
  if (cond) console.log(`  PASS  ${label}${detail ? `  ${detail}` : ""}`);
  else { console.log(`  FAIL  ${label}${detail ? `  ${detail}` : ""}`); failures++; }
};
const near = (a, b, eps) => Math.abs(a - b) <= eps;

const rp = { ...roadParams };
const pp = { ...pieceParams };
const HW = rp.width / 2;
const CURL = pp.bankCurl;

/* ---------------------------------------------------------------- helpers */

/** Deck-zone vertices of one piece, grouped by frame ring, in LOCAL space. */
function deckRings(geo, frameCount) {
  const pos = geo.getAttribute("position");
  const nrm = geo.getAttribute("normal");
  const zone = geo.getAttribute("aZone");
  const lat = geo.getAttribute("aLateral");
  const rings = Array.from({ length: frameCount }, () => []);
  // Band layout: band k occupies k*F*2, frame i at +i*2 (near) and +i*2+1 (far).
  const bands = pos.count / (frameCount * 2);
  for (let k = 0; k < bands; k++) {
    const base = k * frameCount * 2;
    if (zone.getX(base) !== 1) continue; // deck bands only
    for (let i = 0; i < frameCount; i++) {
      for (const v of [base + i * 2, base + i * 2 + 1]) {
        rings[i].push({
          x: pos.getX(v), y: pos.getY(v), z: pos.getZ(v),
          nx: nrm.getX(v), ny: nrm.getY(v), nz: nrm.getZ(v),
          lat: lat.getX(v),
        });
      }
    }
  }
  return rings;
}

/** How far the deck edge stands above the deck centre, in the piece's own
 *  cross-section — measured as a HEIGHT ALONG THE FRAME's up axis, so it is the
 *  curl and not the bank. */
function curlAt(piece, frameIndex) {
  const fr = piece.frames[frameIndex];
  const ring = deckRings(piece.geometry, piece.frames.length)[frameIndex];
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of ring) {
    // Height of this vertex above the frame origin, along the frame's up.
    const h = (v.x - fr.pos.x) * fr.up.x + (v.y - fr.pos.y) * fr.up.y + (v.z - fr.pos.z) * fr.up.z;
    if (h < lo) lo = h;
    if (h > hi) hi = h;
  }
  return hi - lo;
}

const IDENT = new THREE.Matrix4();
const build = (id, params = pp) => buildPiece(id, IDENT.clone(), params, rp, guardrailParams, true);

/* ------------------------------------------------- 1. the shape is a curve */

console.log("\n1. The banked deck is genuinely curved");
{
  const turn = build("banked");
  const mid = Math.floor(turn.frames.length / 2);
  const ring = deckRings(turn.geometry, turn.frames.length)[mid];

  // Sort across the width and check the profile is a bowl: monotonically
  // falling to the centre, rising back out, never flat.
  const byLat = [...ring].sort((a, b) => a.lat - b.lat);
  const fr = turn.frames[mid];
  const h = (v) => (v.x - fr.pos.x) * fr.up.x + (v.y - fr.pos.y) * fr.up.y + (v.z - fr.pos.z) * fr.up.z;
  const centreH = Math.min(...byLat.map(h));
  const edgeH = Math.max(h(byLat[0]), h(byLat[byLat.length - 1]));
  const rise = edgeH - centreH;
  // Deck stops at the kerb, so the edge sample is at |x| = hw - railWidth.
  const dx = HW - Math.min(rp.railWidth, HW * 0.45);
  const want = CURL * (dx / HW) ** 2;
  ok(near(rise, want, 0.02), "deck edge lifts above the deck centre",
    `${rise.toFixed(3)} m (want ${want.toFixed(3)})`);

  const distinct = new Set(byLat.map((v) => v.lat.toFixed(4))).size;
  ok(distinct >= 12, "deck is sampled across its width", `${distinct} lateral stations`);
}

/* -------------------------------------------------- 2. triangles and shading */

console.log("\n2. Shading — smooth across the curve, not faceted");
{
  const flat = build("straight");
  const turn = build("banked");
  const deckTris = (geo) => {
    const zone = geo.getAttribute("aZone");
    const idx = geo.getIndex();
    let n = 0;
    for (let i = 0; i < idx.count; i += 3) if (zone.getX(idx.getX(i)) === 1) n++;
    return n;
  };
  console.log(`        straight deck ${deckTris(flat.geometry)} tris · banked turn ${deckTris(turn.geometry)} tris`);

  const mid = Math.floor(turn.frames.length / 2);
  const ring = deckRings(turn.geometry, turn.frames.length)[mid].sort((a, b) => a.lat - b.lat);

  // Coincident vertices (the two bands meeting at one profile point) must now
  // carry the SAME normal — that is what the welding pass does, and it is the
  // whole difference between a curve and a 12-sided polygon.
  let maxPairSplit = 0;
  for (let i = 0; i + 1 < ring.length; i++) {
    const a = ring[i];
    const b = ring[i + 1];
    if (Math.abs(a.lat - b.lat) > 1e-6) continue; // not a coincident pair
    const dot = a.nx * b.nx + a.ny * b.ny + a.nz * b.nz;
    maxPairSplit = Math.max(maxPairSplit, Math.acos(Math.min(1, dot)) * 180 / Math.PI);
  }
  // Tolerance is float32 noise, not slack: normals are stored as Float32 and
  // acos is ill-conditioned near 1, so a perfectly welded pair still reads a
  // few thousandths of a degree apart. A real crease here would be ~2°, the
  // angle between neighbouring stations.
  ok(maxPairSplit < 0.1, "no crease at the interior deck points",
    `worst split ${maxPairSplit.toFixed(4)}°`);

  // And the normal must actually TURN across the width — a curve that shades
  // like a plane is a plane.
  const first = ring[0];
  const last = ring[ring.length - 1];
  const turned = Math.acos(Math.min(1,
    first.nx * last.nx + first.ny * last.ny + first.nz * last.nz)) * 180 / Math.PI;
  ok(turned > 15, "normal sweeps across the deck", `${turned.toFixed(1)}° edge to edge`);

  // Neighbouring stations must step gently — that is "smooth" as an eye reads it.
  let worstStep = 0;
  for (let i = 0; i + 1 < ring.length; i++) {
    const a = ring[i];
    const b = ring[i + 1];
    if (Math.abs(a.lat - b.lat) < 1e-6) continue;
    const dot = a.nx * b.nx + a.ny * b.ny + a.nz * b.nz;
    worstStep = Math.max(worstStep, Math.acos(Math.min(1, dot)) * 180 / Math.PI);
  }
  ok(worstStep < 6, "no facet between neighbouring stations", `worst ${worstStep.toFixed(2)}°`);
}

/* ------------------------------------------------------------- 3. the seams */

console.log("\n3. Seams — a bank-in is flat where it meets a straight");
{
  const bankIn = build("bankin");
  const bankOut = build("bankout");
  const turn = build("banked");
  const tilt = build("banktilt");

  const dx = HW - Math.min(rp.railWidth, HW * 0.45);
  const full = CURL * (dx / HW) ** 2;
  const last = (p) => p.frames.length - 1;

  ok(curlAt(bankIn, 0) < 0.005, "bank-in ENTRY is flat (mates a straight)",
    `${curlAt(bankIn, 0).toFixed(4)} m`);
  ok(near(curlAt(bankIn, last(bankIn)), full, 0.01), "bank-in EXIT is fully curled",
    `${curlAt(bankIn, last(bankIn)).toFixed(3)} m`);
  ok(near(curlAt(bankOut, 0), full, 0.01), "bank-out ENTRY is fully curled",
    `${curlAt(bankOut, 0).toFixed(3)} m`);
  ok(curlAt(bankOut, last(bankOut)) < 0.005, "bank-out EXIT is flat",
    `${curlAt(bankOut, last(bankOut)).toFixed(4)} m`);

  // Held-bank pieces carry the full curl at BOTH ends, so any of them chains
  // onto any other in any order.
  for (const [name, p] of [["banked turn", turn], ["banked straight", tilt]]) {
    const a = curlAt(p, 0);
    const b = curlAt(p, last(p));
    ok(near(a, full, 0.01) && near(b, full, 0.01), `${name} holds the curl end to end`,
      `${a.toFixed(3)} → ${b.toFixed(3)} m`);
  }

  // The easing must be MONOTONIC, or the deck curls up and back down inside the
  // transition and reads as a bump.
  let monotonic = true;
  let prev = -1;
  for (let i = 0; i < bankIn.frames.length; i++) {
    const c = curlAt(bankIn, i);
    if (c < prev - 1e-4) monotonic = false;
    prev = c;
  }
  ok(monotonic, "bank-in curls monotonically (no bump mid-piece)");
}

/* --------------------------------------------------- 4. bankCurl = 0 opt-out */

console.log("\n4. bankCurl = 0 gives back the old flat piece");
{
  const zero = { ...pp, bankCurl: 0 };
  const a = buildBankProfile(rp, true, 0);
  const b = buildProfile(rp, true);
  ok(JSON.stringify(a) === JSON.stringify(b), "profile falls back to buildProfile exactly");

  const turn = build("banked", zero);
  const mid = Math.floor(turn.frames.length / 2);
  ok(curlAt(turn, mid) < 1e-6, "banked turn deck is flat again",
    `${curlAt(turn, mid).toExponential(1)} m`);
}

/* ----------------------------------------------------- 5. the rail rides up */

console.log("\n5. The guardrail rides the curled kerb");
{
  // Measured PER FRAME AND PER SIDE, in the frame's own axes. Global Y extremes
  // are meaningless on a rolled piece — the lowest rail vertex is the inner
  // rail at the far end while the highest deck vertex is the outer edge
  // somewhere else entirely, so comparing them says nothing at all.
  const rwP = Math.min(rp.railWidth, HW * 0.45);
  const edgeAbs = HW - rwP * 0.5;
  for (const id of ["banked", "bankin"]) {
    const p = build(id);
    const rail = p.railGeometry.getAttribute("position");
    let worst = 0;
    let worstAt = "";
    // ONLY the end frames. The rail sweeps a DECIMATED copy of the frames
    // (decimateFrames — a 0.26 m tube does not need the deck's 1.6 m stepping),
    // so between rail frames there are simply no vertices to be nearest to and
    // a mid-piece sample measures the thinning, not the lift. The two ends are
    // the frames decimateFrames guarantees it keeps, and on a bank-in they are
    // also the interesting ones: zero curl at one, full curl at the other.
    for (const f of [0, p.frames.length - 1]) {
      const fr = p.frames[f];
      for (const side of [-1, 1]) {
        // Where the kerb top IS, given the lift buildPiece stamped on the frame.
        const want = fr.pos.clone()
          .addScaledVector(fr.right, side * edgeAbs)
          .addScaledVector(fr.up, (fr.deckLift ?? 0) + rp.railHeight);
        // Nearest rail vertex to it. The post base plate sits exactly here, so
        // on a correctly placed rail this distance is centimetres.
        let best = Infinity;
        for (let i = 0; i < rail.count; i++) {
          const d = want.distanceToSquared(
            new THREE.Vector3(rail.getX(i), rail.getY(i), rail.getZ(i)),
          );
          if (d < best) best = d;
        }
        best = Math.sqrt(best);
        if (best > worst) { worst = best; worstAt = `frame ${f} side ${side}`; }
      }
    }
    ok(worst < 0.35, `${id}: rail sits on the kerb wherever the curl puts it`,
      `worst gap ${worst.toFixed(3)} m (${worstAt})`);
  }

  // The proof that the lift is doing the work: with the curl off, the rail is
  // measurably LOWER, by exactly the kerb's share of the curl.
  {
    const dxK = HW - rwP * 0.5;
    const expect = CURL * (dxK / HW) ** 2;
    const railTop = (piece) => {
      const a = piece.railGeometry.getAttribute("position");
      const fr = piece.frames[Math.floor(piece.frames.length / 2)];
      let hi = -Infinity;
      for (let i = 0; i < a.count; i++) {
        const h = new THREE.Vector3(a.getX(i), a.getY(i), a.getZ(i)).sub(fr.pos).dot(fr.up);
        if (h > hi) hi = h;
      }
      return hi;
    };
    const lifted = railTop(build("banktilt"));
    const flatR = railTop(build("banktilt", { ...pp, bankCurl: 0 }));
    ok(near(lifted - flatR, expect, 0.02), "rail rises by exactly the kerb's curl",
      `${(lifted - flatR).toFixed(3)} m (want ${expect.toFixed(3)})`);
  }
}

/* ------------------------------------------- 5b. the rail is not a chord run */

console.log("\n5b. The rising rail is smooth, not chorded");
{
  const rail = await import(
    new URL("../games/modular-road-v3/modularRoadRail.js", import.meta.url).href
  );
  const { decimateFrames, railParams } = rail;
  const rwP = Math.min(rp.railWidth, HW * 0.45);
  const edgeAbs = HW - rwP * 0.5;

  // Worst bend between consecutive rail frames, measured on the path the rail
  // actually takes. This is the number you SEE as a kink: the beam is straight
  // between frames, so a 20° step is a visible corner in a smooth-looking tube.
  const worstKink = (frames, lat) => {
    const kept = decimateFrames(frames, railParams.frameStep, railParams.frameAngle, lat);
    const pos = kept.map((f) => f.pos.clone()
      .addScaledVector(f.right, lat)
      .addScaledVector(f.up, f.deckLift ?? 0));
    let worst = 0;
    for (let i = 1; i + 1 < pos.length; i++) {
      const a = pos[i].clone().sub(pos[i - 1]).normalize();
      const b = pos[i + 1].clone().sub(pos[i]).normalize();
      worst = Math.max(worst, Math.acos(Math.min(1, a.dot(b))) * 180 / Math.PI);
    }
    return { worst, frames: kept.length };
  };

  for (const id of ["bankin", "banked"]) {
    const p = build(id);
    for (const side of [-1, 1]) {
      const { worst, frames: n } = worstKink(p.frames, side * edgeAbs);
      // The thinning promises frames no more than `frameAngle` apart in
      // direction; allowing 1.6× covers the last frame before an end, which is
      // pinned rather than chosen. A rail judged on the centreline instead came
      // in far above this — that was the blockiness.
      ok(worst < railParams.frameAngle * 1.6, `${id} side ${side}: no visible kink`,
        `worst ${worst.toFixed(1)}° over ${n} rail frames`);
    }
  }
}

/* ------------------------------------------- 5c. the ramp length is its own */

console.log("\n5c. Bank ramps size themselves, and their sockets agree");
{
  // The exit socket is where the NEXT piece gets planted. If it disagrees with
  // the geometry by even a little, every piece downstream is offset and the
  // chain visibly tears — so this is the assertion that protects splitting
  // bankRampLength out of straightLength.
  const exitZ = (piece) => -piece.connectorOut.elements[14];
  const deckEndZ = (piece) => {
    const pos = piece.geometry.getAttribute("position");
    let far = 0;
    for (let i = 0; i < pos.count; i++) far = Math.min(far, pos.getZ(i));
    return -far;
  };
  for (const id of ["bankin", "bankout"]) {
    for (const L of [22, 44, 70]) {
      const p = build(id, { ...pp, bankRampLength: L });
      ok(near(exitZ(p), L, 0.01), `${id} @ ${L} m: exit socket is at the far end`,
        `socket ${exitZ(p).toFixed(2)} m`);
      ok(near(deckEndZ(p), L, 0.01), `${id} @ ${L} m: geometry reaches the socket`,
        `deck ends ${deckEndZ(p).toFixed(2)} m`);
    }
  }

  // Old saves carry straightLength and no bankRampLength; they must reload at
  // the length they were authored at, not silently grow to the new default.
  const legacy = { ...pp, straightLength: 18 };
  delete legacy.bankRampLength;
  ok(near(exitZ(build("bankin", legacy)), 18, 0.01),
    "a pre-bankRampLength save keeps its authored 18 m");

  // …while a held-bank STRAIGHT still measures itself with straightLength, and
  // is not dragged along by the ramp's new number.
  ok(near(exitZ(build("banktilt", { ...pp, straightLength: 26, bankRampLength: 70 })), 26, 0.01),
    "banked straight still follows straightLength");
}

/* ------------------------------------------------- 6. it is REAL collision */

console.log("\n6. The curl is drivable geometry, not just a look");
{
  const turn = build("banked");
  ok(turn.deckCollision === null,
    "no separate collision form — the BVH bakes the curved mesh itself");

  // Drop a ray straight down onto the outer third of the deck and confirm it
  // lands on the curve, above where the old flat plate would have been.
  const mid = Math.floor(turn.frames.length / 2);
  const fr = turn.frames[mid];
  const geo = turn.geometry.clone();
  geo.computeBoundingBox();
  // DoubleSide: this samples POSITIONS, and a ray that drops onto the deck from
  // above must not care which way the sweep happened to wind its triangles.
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  mesh.updateMatrixWorld(true);
  const rc = new THREE.Raycaster();
  rc.firstHitOnly = false;

  // Dropped from straight overhead in WORLD space, which is what a wheel probe
  // does. Rising along the frame's own `up` would not do: on a banked piece
  // that axis is tilted 22°, so 40 m of it moves the origin 10 m sideways and
  // the ray comes down beside the road.
  const sample = (fracAcross) => {
    const dx = (HW - rp.railWidth) * fracAcross;
    const target = fr.pos.clone().addScaledVector(fr.right, dx);
    const o = target.clone().setY(target.y + 40);
    rc.set(o, new THREE.Vector3(0, -1, 0));
    const hits = rc.intersectObject(mesh, false);
    return hits.length ? hits[0].point : null;
  };
  const centre = sample(0);
  const outer = sample(0.95);
  ok(centre && outer, "wheel rays find the deck across the width");
  if (centre && outer) {
    // Height of each hit above the frame origin, measured along the frame up —
    // isolates the curl from the bank the same way curlAt does.
    const h = (p) => p.clone().sub(fr.pos).dot(fr.up);
    const lift = h(outer) - h(centre);
    ok(lift > 0.4, "the outer deck a wheel touches really is raised",
      `${lift.toFixed(3)} m above the centre`);
  }
}

console.log(failures ? `\n${failures} FAILED\n` : "\nall passed\n");
process.exit(failures ? 1 : 0);
