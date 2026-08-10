import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

/**
 * MODULAR ROAD GUARDRAIL — the shipping rail.
 *
 * Replaces the kit's original `buildGuardrailGeometry`, which is kept and still
 * used, but now only as the COLLISION PROXY: it is a handful of quads, which is
 * exactly what a BVH wants, while this file is what you look at. Bolts, base
 * plates, chamfers and a rolled bull-nose have no business in a collision mesh,
 * and `bakeCollision()` runs on every track edit.
 *
 * Authored in road-piece-lab.html, which imports from here — so the lab tunes
 * the same code the game runs, rather than a copy that drifts.
 *
 * WHY IT LOOKS THE WAY IT DOES. The old rail read as folded cardboard for four
 * separate reasons, and all four are addressed here:
 *   1. no environment  — a metal with nothing to reflect has no diffuse term to
 *      fall back on, which is why the old material sat at metalness 0.5 and
 *      still looked like plastic. (Fixed in the material, not here.)
 *   2. hard corners    — `filletPolyline` rounds every formed corner.
 *   3. an open sheet   — the section is a CLOSED ring, so it is a solid box beam
 *      with rolled edges rather than a zero-thickness ribbon.
 *   4. proportion      — a W-beam at this kit's 0.8 m height is mostly flat
 *      sheet; `style` picks 1/2/3 corrugations.
 *
 * WHY IT COSTS WHAT IT COSTS. Measured with tools/railBudget.mjs on a 32 m
 * straight: the hero settings the lab was tuned at came to 9,712 tris a piece
 * (777k over an 80-piece circuit, ~46% on top of the whole scene). The shipping
 * defaults below are 3,688. The single biggest saving was `decimateFrames` —
 * see its comment. Normals are computed ANALYTICALLY from the 2-D profile, so
 * shading stays smooth at low segment counts; the blockiness was never polygon
 * count, it was flat normals.
 */

/** Shipping defaults. The lab overrides these live; a track carries none of it
 *  yet, so changing a number here changes every rail in the game. */
export const railParams = {
  mirrorSides: true, // corrugation faces traffic on BOTH sides
  flipW: false, // false = corrugated face toward the track
  style: 2, // corrugations: 1 box beam · 2 W-beam · 3 thrie-beam
  height: 0.8,
  depth: 0.26,
  gap: 0.18, // kerb top → beam bottom
  valleyGap: 0.3, // valley inset, as a fraction of depth
  backAmp: 0.35, // corrugation carried onto the back face (0 = flat plate)
  plateau: 0.22, // flat run at each crest/valley, fraction of the pitch
  bendRadius: 0.05,
  bendSeg: 2,
  beadSeg: 6,
  frameStep: 4.0, // max metres between rail frames
  frameAngle: 7, // max degrees (yaw OR roll) between rail frames
  posts: true,
  postShape: "slab", // slab | ibeam
  postSpacing: 3.6,
  postWidth: 0.15,
  postDepth: 0.17,
  flangeT: 0.022,
  webT: 0.018,
  postRise: 0.06,
  blockout: 0.07, // spacer beam→post; wider pushes the post off the kerb
  basePlate: true,
  bolts: true,
  boltRadius: 0.034,
  bevel: 0.006,
};

const _m = new THREE.Matrix4();
const _pos = new THREE.Vector3();

export function straightFrames(length, segLen = 1.6) {
  const n = Math.max(2, Math.ceil(length / segLen) + 1);
  const frames = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    frames.push({
      pos: new THREE.Vector3(0, 0, -length * t),
      tangent: new THREE.Vector3(0, 0, -1),
      up: new THREE.Vector3(0, 1, 0),
      right: new THREE.Vector3(1, 0, 0),
    });
  }
  return frames;
}

/* --- 2-D section helpers, in (y vertical, z lateral) metres ---------- */

/** Signed area of a closed polyline in the (z, y) plane. */
export function signedArea(pts) {
  let a = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % n];
    a += p.z * q.y - q.z * p.y;
  }
  return a * 0.5;
}

/** Drop coincident points (fillets and arcs meet exactly on their tangent
 *  points, and a zero-length segment has no normal). */
function dedupe(pts, eps = 1e-5) {
  const out = [];
  for (const p of pts) {
    const q = out[out.length - 1];
    if (q && Math.abs(q.y - p.y) < eps && Math.abs(q.z - p.z) < eps) continue;
    out.push(p);
  }
  const a = out[0];
  const b = out[out.length - 1];
  if (out.length > 2 && Math.abs(a.y - b.y) < eps && Math.abs(a.z - b.z) < eps) out.pop();
  return out;
}

/**
 * Round every corner of a CLOSED polyline with a circular fillet.
 *
 * This is the single biggest reason the kit rail reads as folded card:
 * its section is a bare polyline, so every corrugation corner is a hard
 * crease that computeVertexNormals turns into a facet. Sheet steel is
 * roll-formed — the corners have a radius, and once they do the sweep
 * shades as a continuous surface.
 *
 * Tangent lengths are clamped to half the shorter neighbouring segment, so
 * neighbouring fillets can never overlap and turn the section inside out.
 *
 * Only the corrugated face gets filleted (open mode) — running it over the
 * finished ring would also nibble the bull-nose arcs, which are already
 * smooth, and pull the beam a millimetre or two under its stated height.
 */
function filletPolyline(pts, radius, seg, closed = false) {
  const n = pts.length;
  if (radius <= 1e-5 || seg < 1 || n < 3) return pts.slice();
  const out = [];
  if (!closed) out.push(pts[0]);
  const first = closed ? 0 : 1;
  const last = closed ? n - 1 : n - 2;
  for (let i = first; i <= last; i++) {
    const p = pts[i];
    const a = pts[(i - 1 + n) % n];
    const b = pts[(i + 1) % n];
    let ay = a.y - p.y;
    let az = a.z - p.z;
    let by = b.y - p.y;
    let bz = b.z - p.z;
    const la = Math.hypot(ay, az);
    const lb = Math.hypot(by, bz);
    if (la < 1e-6 || lb < 1e-6) continue;
    ay /= la; az /= la; by /= lb; bz /= lb;
    const theta = Math.acos(Math.min(1, Math.max(-1, ay * by + az * bz)));
    // Straight-through or doubled-back: nothing to round.
    if (theta > Math.PI - 1e-3 || theta < 1e-3) {
      out.push(p);
      continue;
    }
    const half = theta * 0.5;
    const tanDist = Math.min(radius / Math.tan(half), la * 0.5, lb * 0.5);
    const r = tanDist * Math.tan(half);
    let my = ay + by;
    let mz = az + bz;
    const lm = Math.hypot(my, mz);
    if (lm < 1e-6) {
      out.push(p);
      continue;
    }
    my /= lm; mz /= lm;
    const cDist = r / Math.sin(half);
    const cy = p.y + my * cDist;
    const cz = p.z + mz * cDist;
    const a0 = Math.atan2(p.y + ay * tanDist - cy, p.z + az * tanDist - cz);
    const a1 = Math.atan2(p.y + by * tanDist - cy, p.z + bz * tanDist - cz);
    let d = a1 - a0;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    for (let k = 0; k <= seg; k++) {
      const ang = a0 + d * (k / seg);
      out.push({ y: cy + Math.sin(ang) * r, z: cz + Math.cos(ang) * r });
    }
  }
  if (!closed) out.push(pts[n - 1]);
  return out;
}

/** Outward unit normal per point of a CCW closed polyline, averaged from
 *  the two adjacent segments. Supplied to the sweep directly instead of
 *  calling computeVertexNormals, which would leave a shading seam where
 *  the ring wraps back on itself. */
function polylineNormals(pts) {
  const n = pts.length;
  const seg = new Array(n);
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % n];
    const dy = q.y - p.y;
    const dz = q.z - p.z;
    const l = Math.hypot(dy, dz) || 1;
    seg[i] = { y: -dz / l, z: dy / l }; // outward for CCW winding
  }
  return pts.map((_, i) => {
    const a = seg[(i - 1 + n) % n];
    const b = seg[i];
    const y = a.y + b.y;
    const z = a.z + b.z;
    const l = Math.hypot(y, z) || 1;
    return { y: y / l, z: z / l };
  });
}

/**
 * Closed rail cross-section, about the beam centre. +z is the FIELD side
 * (where the posts live); the corrugated face looks at traffic on -z.
 *
 * `humps` picks the family: 1 = plain box beam, 2 = W-beam (one centre
 * valley), 3 = thrie-beam (two valleys). At the height this kit uses —
 * 0.8 m, nearly three times a real W-beam — a two-hump section is mostly
 * flat sheet, which is the other half of why it looks like a slab. Three
 * humps put a corrugation every ~0.25 m and the silhouette reads as steel.
 *
 * The ends are half-round bull-noses of radius depth/2, which also
 * replaces the kit's `capRiseFrac` peak: a cylinder sheds a car landing on
 * the rail at least as well as a 45° ridge (see wBeamProfile in
 * modularRoadKit.js for why that matters) without the knife-edge look.
 *
 * Returns the (already CCW) point ring, its outward normals, the field-side
 * plane the posts bolt to, and the valley positions the bolts sit in.
 */
export function railProfile(o) {
  const h = Math.max(0.12, o.height);
  // The bull-nose radius is half the depth, and it has to fit inside the
  // height — so a section deeper than it is tall is clamped, not left with
  // a bead that can't reach the crest plane.
  const d = Math.min(Math.max(0.04, o.depth), h * 0.9);
  const r = d * 0.5;
  const yEnd = h * 0.5 - r; // where the beads take over
  const zCrest = -d * 0.5;
  const valleyGap = Math.min(0.45, Math.max(0.05, o.valleyGap));
  const zValley = d * 0.5 - valleyGap * d;

  // Corrugated traffic face, bottom → top. A crest at BOTH ends so the
  // beads meet it tangentially.
  const humps = Math.max(1, Math.round(o.humps));
  const K = 2 * (humps - 1);
  const face = [];
  const valleys = [];
  if (K === 0) {
    face.push({ y: -yEnd, z: zCrest }, { y: yEnd, z: zCrest });
  } else {
    const stepY = (yEnd * 2) / K;
    const flat = Math.max(0, Math.min(0.48, o.plateau)) * stepY;
    for (let k = 0; k <= K; k++) {
      const y = -yEnd + stepY * k;
      const z = k % 2 === 0 ? zCrest : zValley;
      if (k % 2 === 1) valleys.push({ y, z });
      face.push({ y: k === 0 ? y : y - flat, z });
      face.push({ y: k === K ? y : y + flat, z });
    }
  }

  // Round the formed corners, then close the ring: top bull-nose (crest →
  // field side), flat back plate, bottom bull-nose.
  const pts = dedupe(
    filletPolyline(
      dedupe(face), o.bendRadius, Math.max(1, Math.round(o.bendSeg)), false,
    ),
  );
  const faceEnd = pts.length;
  // Even segment count so the apex lands exactly on h/2 rather than being
  // chorded off by a sample either side of it.
  const beadSeg = 2 * Math.max(1, Math.round(Math.max(2, o.beadSeg) / 2));
  const arc = (cy, a0, a1) => {
    for (let k = 0; k <= beadSeg; k++) {
      const ang = a0 + (a1 - a0) * (k / beadSeg);
      pts.push({ y: cy + Math.sin(ang) * r, z: Math.cos(ang) * r });
    }
  };
  arc(yEnd, Math.PI, 0);
  // Back face. A flat plate there is the last slab-shaped surface on the
  // barrier and it is what you see from off-track, so it gets a shallow
  // mirror of the corrugation. Amplitude is capped to keep a real wall
  // thickness at the valleys, where front and back come closest.
  const back = pts.slice(0, faceEnd).reverse();
  const amp = back.length
    ? Math.min(
      Math.max(0, o.backAmp ?? 0),
      (r - zValley - 0.012) / Math.max(1e-4, zValley + r),
    )
    : 0;
  if (amp > 1e-4) {
    for (const p of back) pts.push({ y: p.y, z: r - (p.z - zCrest) * amp });
  } else {
    pts.push({ y: -yEnd, z: r });
  }
  arc(-yEnd, 0, -Math.PI);

  let ring = dedupe(pts);
  if (o.flip) for (const p of ring) p.z = -p.z;
  if (signedArea(ring) < 0) ring.reverse(); // normals + winding assume CCW

  const sgn = o.flip ? -1 : 1;
  return {
    pts: ring,
    normals: polylineNormals(ring),
    backZ: r * sgn, // the plane posts bolt to
    valleys: valleys.map((v) => ({ y: v.y, z: v.z * sgn })),
    height: h,
    depth: d,
  };
}

/**
 * Sweep the closed section along the frames, with explicit normals and
 * both ends capped — a solid box beam, not an open sheet that has to be
 * rendered DoubleSide and still shows its zero-thickness edge on.
 *
 * `zSign` mirrors the section for the left-hand rail (so the corrugation
 * faces traffic on both sides); that mirror reverses the parametrisation,
 * hence the winding flip.
 */
export function sweepRail(frames, prof, baseLat, zSign, centerV) {
  const F = frames.length;
  const R = prof.pts.length;
  const V = R + 1; // seam column duplicated so the UVs don't wrap
  // A curled bank deck lifts its own kerb, so the rail standing on it has to
  // lift too — per frame, because the curl EASES along a bank-in. Stamped on
  // the frame by buildPiece; every other piece leaves it undefined and gets 0.
  const liftAt = (fr) => fr.deckLift ?? 0;

  const along = [0];
  for (let i = 1; i < F; i++) {
    along[i] = along[i - 1] + frames[i].pos.distanceTo(frames[i - 1].pos);
  }
  // v in metres around the section, so galvanising detail stays square.
  const arcV = [0];
  for (let j = 1; j < V; j++) {
    const p = prof.pts[j % R];
    const q = prof.pts[j - 1];
    arcV[j] = arcV[j - 1] + Math.hypot(p.y - q.y, p.z - q.z);
  }

  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  const push = (fr, lat, y, nz, ny, u, v) => {
    positions.push(
      fr.pos.x + fr.right.x * lat + fr.up.x * y,
      fr.pos.y + fr.right.y * lat + fr.up.y * y,
      fr.pos.z + fr.right.z * lat + fr.up.z * y,
    );
    normals.push(
      fr.right.x * nz + fr.up.x * ny,
      fr.right.y * nz + fr.up.y * ny,
      fr.right.z * nz + fr.up.z * ny,
    );
    uvs.push(u, v);
  };

  for (let i = 0; i < F; i++) {
    const fr = frames[i];
    const lift = liftAt(fr);
    for (let j = 0; j < V; j++) {
      const p = prof.pts[j % R];
      const n = prof.normals[j % R];
      push(fr, baseLat + zSign * p.z, centerV + p.y + lift, zSign * n.z, n.y, along[i], arcV[j]);
    }
  }
  const flipWind = zSign < 0;
  for (let i = 0; i < F - 1; i++) {
    const r0 = i * V;
    const r1 = (i + 1) * V;
    for (let j = 0; j < V - 1; j++) {
      if (flipWind) {
        indices.push(r0 + j, r0 + j + 1, r1 + j, r0 + j + 1, r1 + j + 1, r1 + j);
      } else {
        indices.push(r0 + j, r1 + j, r0 + j + 1, r0 + j + 1, r1 + j, r1 + j + 1);
      }
    }
  }

  // End caps.
  //
  // EAR CLIPPING, not a fan from the centroid. The section is strongly
  // non-convex — a corrugated front, a relieved back and two bull-noses —
  // so it is not star-shaped about its centroid, and a fan sprays
  // triangles straight across the corrugation valleys. On screen that is
  // a bulging blob of crossing facets at the end of the rail rather than a
  // flat cut. ShapeUtils.triangulateShape is three's earcut and handles
  // any simple polygon, which the ring is guaranteed to be (the profile
  // test asserts no self-intersections).
  const capTris = THREE.ShapeUtils.triangulateShape(
    prof.pts.map((p) => new THREE.Vector2(p.z, p.y)), [],
  );
  const cap = (i, dir) => {
    const fr = frames[i];
    const base = positions.length / 3;
    const t = fr.tangent;
    const v0 = centerV + liftAt(fr);
    for (const p of prof.pts) {
      const lat = baseLat + zSign * p.z;
      positions.push(
        fr.pos.x + fr.right.x * lat + fr.up.x * (v0 + p.y),
        fr.pos.y + fr.right.y * lat + fr.up.y * (v0 + p.y),
        fr.pos.z + fr.right.z * lat + fr.up.z * (v0 + p.y),
      );
      normals.push(t.x * dir, t.y * dir, t.z * dir);
      uvs.push(p.z, p.y);
    }
    const forward = dir * zSign < 0;
    for (const [a, b, c] of capTris) {
      if (forward) indices.push(base + a, base + b, base + c);
      else indices.push(base + a, base + c, base + b);
    }
  };
  cap(0, -1);
  cap(F - 1, 1);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  return geo;
}

/* --- Post hardware, built in POST SPACE ------------------------------
 * x = lateral offset from the kerb centreline, +x toward the field
 * y = height above the deck (so it lines up with the sweep's centerV)
 * z = along travel
 * One template is built per rebuild and cloned per post.
 */

/** ExtrudeGeometry comes back non-indexed while the sweeps and cylinders
 *  are indexed, and mergeGeometries refuses to mix the two (it returns
 *  null and you get a silently empty rail). A trivial sequential index
 *  costs one int per vertex and keeps everything mergeable. */
function ensureIndexed(geo) {
  if (geo.index) return geo;
  const n = geo.attributes.position.count;
  const arr = n > 65535 ? new Uint32Array(n) : new Uint16Array(n);
  for (let i = 0; i < n; i++) arr[i] = i;
  geo.setIndex(new THREE.BufferAttribute(arr, 1));
  return geo;
}

/** Box with chamfered edges. ExtrudeGeometry's bevel does the work — a
 *  bare BoxGeometry (what the kit uses for posts) has nothing for a
 *  highlight to catch, which is exactly what "blocky" looks like. */
function chamferBox(w, h, d, bevel) {
  const b = Math.max(0.001, Math.min(bevel, w * 0.24, h * 0.24, d * 0.24));
  const hw = w * 0.5 - b;
  const hd = d * 0.5 - b;
  const shape = new THREE.Shape();
  shape.moveTo(-hw, -hd);
  shape.lineTo(hw, -hd);
  shape.lineTo(hw, hd);
  shape.lineTo(-hw, hd);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: Math.max(0.001, h - 2 * b),
    bevelEnabled: true,
    bevelThickness: b,
    bevelSize: b,
    bevelOffset: 0,
    bevelSegments: 1,
    curveSegments: 1,
  });
  geo.translate(0, 0, b);
  geo.rotateX(-Math.PI / 2); // extrusion axis → up, shape y → along travel
  return ensureIndexed(geo);
}

/** I-section post: flanges facing the field, web running along travel. */
function iBeamPost(width, depth, flangeT, webT, height, bevel) {
  const x0 = width * 0.5;
  const y0 = depth * 0.5;
  const xi = Math.max(0.002, x0 - flangeT);
  const yi = Math.max(0.001, webT * 0.5);
  const s = new THREE.Shape();
  s.moveTo(-x0, -y0);
  s.lineTo(-x0, y0);
  s.lineTo(-xi, y0);
  s.lineTo(-xi, yi);
  s.lineTo(xi, yi);
  s.lineTo(xi, y0);
  s.lineTo(x0, y0);
  s.lineTo(x0, -y0);
  s.lineTo(xi, -y0);
  s.lineTo(xi, -yi);
  s.lineTo(-xi, -yi);
  s.lineTo(-xi, -y0);
  s.closePath();
  // Bevel must stay under half the thinnest wall or the reflex corners of
  // the I self-intersect and the post turns into spaghetti.
  const b = Math.max(0.001, Math.min(bevel, flangeT * 0.35, webT * 0.35));
  const geo = new THREE.ExtrudeGeometry(s, {
    depth: Math.max(0.01, height - 2 * b),
    bevelEnabled: true,
    bevelThickness: b,
    bevelSize: b,
    bevelOffset: 0,
    bevelSegments: 1,
    curveSegments: 1,
  });
  geo.translate(0, 0, b);
  geo.rotateX(-Math.PI / 2);
  return ensureIndexed(geo);
}

/**
 * Drop faces lying flat on y ≈ `y0`.
 *
 * The post and its base plate both stand ON the kerb, so their undersides can
 * never be seen from anywhere — a piece is a solid slab and the kerb is opaque,
 * including on loops and banks, since the rail rotates with the piece. Only
 * whole triangles at the plane are removed, so the chamfer (which spans upward
 * from it) survives and the silhouette is untouched.
 *
 * Indices only: the vertices stay in the buffer. It is rasterisation this saves,
 * not memory.
 */
function stripFacesAt(geo, y0 = 0, eps = 1e-4) {
  const idx = geo.getIndex();
  const pos = geo.getAttribute("position");
  if (!idx || !pos) return geo;
  const keep = [];
  for (let i = 0; i < idx.count; i += 3) {
    const a = idx.getX(i);
    const b = idx.getX(i + 1);
    const c = idx.getX(i + 2);
    const flat = pos.getY(a) <= y0 + eps && pos.getY(b) <= y0 + eps && pos.getY(c) <= y0 + eps;
    if (!flat) keep.push(a, b, c);
  }
  geo.setIndex(keep);
  return geo;
}

/**
 * Button-head bolt sunk in a corrugation valley, axis along ±x.
 *
 * SIX sides, not ten. This is a 3.4 cm head on a barrier you pass at 150 km/h —
 * it is a couple of pixels wide in play, and at ten segments it was costing 40
 * triangles, a THIRD of the whole post assembly, more than the base plate and
 * the blockout combined. Six is also what a bolt head actually has.
 */
function boltHead(radius, len, dir) {
  const geo = new THREE.CylinderGeometry(radius, radius * 0.62, len, 6, 1, false);
  geo.rotateZ(-Math.PI / 2); // +y → +x
  if (dir < 0) geo.rotateY(Math.PI);
  return geo;
}

/** Everything that repeats at each post, merged once into one template. */
/** Base plate footprint, as a multiple of the post's width/depth. */
const PLATE_SCALE = 1.25;

/**
 * @param {number} kerbHalf half the kerb's width — the post-space x at which the
 *   kerb's outer edge sits, since post space is centred on the kerb.
 */
export function buildPostTemplate(prof, r, kerbTop, centerV, kerbHalf = Infinity) {
  const parts = [];
  const sgn = prof.backZ >= 0 ? 1 : -1;
  const beamTop = centerV + prof.height * 0.5;

  // A real guardrail post is driven into the ground OUTBOARD of the barrier.
  // These pieces are floating slabs with no ground beside them, so the post has
  // to land on the kerb — and at the natural offset it does not: measured, the
  // base plate hung 0.181 m past the kerb edge of its own 0.232 m width, i.e.
  // 78% of it in mid-air, with the post itself 93% off.
  //
  // Widening the kerb (roadParams.railWidth) is the fix, but it cannot be the
  // only one: railWidth is saved INTO a track file, so every track authored
  // before the change loads its old narrow kerb back and floats again. So the
  // offset is also clamped to whatever kerb it actually gets. Pushed inboard the
  // post tucks under the beam, which is hidden and harmless — unlike floating.
  const widest = Math.max(r.postWidth, r.basePlate ? r.postWidth * PLATE_SCALE : 0);
  const want = Math.abs(prof.backZ) + r.blockout + r.postWidth * 0.5;
  const postX = sgn * Math.min(want, Math.max(0, kerbHalf - widest * 0.5));
  const postTop = beamTop + r.postRise;
  const postH = Math.max(0.08, postTop - kerbTop);

  // An I-section costs ~4× a chamfered box and its web is invisible past a
  // few metres — at 150 km/h you read the post's silhouette and nothing
  // else. `slab` is the shipping shape; `ibeam` stays for close-ups.
  const post = r.postShape === "ibeam"
    ? iBeamPost(r.postWidth, r.postDepth, r.flangeT, r.webT, postH, r.bevel)
    : chamferBox(r.postWidth, postH, r.postDepth, r.bevel);
  // Both of these are built standing on y = 0, and both then sit on the kerb —
  // the post's base inside the plate, the plate's underside on the concrete.
  stripFacesAt(post);
  post.translate(postX, kerbTop, 0);
  parts.push(post);

  if (r.basePlate) {
    const plate = chamferBox(r.postWidth * PLATE_SCALE, 0.028, r.postDepth * PLATE_SCALE, r.bevel);
    stripFacesAt(plate);
    plate.translate(postX, kerbTop, 0);
    parts.push(plate);
  }

  // Spacer between post and beam, overlapping both a little so no hairline
  // gap opens up at grazing angles.
  // chamferBox sits on y = 0, so centre it on the beam rather than
  // hanging it off the beam's midline.
  const blockW = r.blockout + 0.024;
  const blockH = prof.height * 0.62;
  const block = chamferBox(blockW, blockH, r.postDepth * 0.92, r.bevel);
  block.translate(
    prof.backZ + sgn * (blockW * 0.5 - 0.012), centerV - blockH * 0.5, 0,
  );
  parts.push(block);

  if (r.bolts) {
    for (const v of prof.valleys) {
      // Wide end flush with the valley floor, taper toward traffic.
      const len = r.boltRadius * 1.5;
      const bolt = boltHead(r.boltRadius, len, sgn);
      bolt.translate(v.z - sgn * len * 0.5, centerV + v.y, 0);
      parts.push(bolt);
    }
  }

  const merged = mergeGeometries(parts, false);
  for (const g of parts) g.dispose();
  return merged;
}

const _pa = new THREE.Vector3();
const _pb = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _rightS = new THREE.Vector3();
const _fwdS = new THREE.Vector3();

/**
 * Posts along the rail, evenly spaced by arc length.
 *
 * MUST be given the SAME frames the beam was swept along, not the piece's full
 * set. The beam sweeps decimated frames, whose chords cut the corner, so posts
 * placed on the true arc drift off it — and asymmetrically, because the chord
 * always moves toward the centre of curvature while the posts sit outboard.
 * Measured on an R14 150° hairpin: the inner rail's posts stood 4.4 cm clear of
 * their beam while the outer rail's were only 1.3 cm out and looked fine. One
 * side visibly detached, the other not, which is exactly how it was spotted.
 *
 * Spacing stays even because posts are INTERPOLATED along the chord polyline
 * rather than snapped to whichever frames survived decimation — snapping would
 * quantise them to the frame step (4 m on a straight, so a 3.6 m spacing would
 * come out at 4 m or 8 m).
 */
export function placePosts(frames, template, baseLat, zSign, spacing, out) {
  const F = frames.length;
  if (F < 2) return;
  // Arc length measured AT THIS RAIL'S lateral offset, not on the centreline —
  // the outer rail of a curve is genuinely longer and wants more posts.
  const cum = [0];
  for (let i = 1; i < F; i++) {
    _pa.copy(frames[i - 1].pos).addScaledVector(frames[i - 1].right, baseLat);
    _pb.copy(frames[i].pos).addScaledVector(frames[i].right, baseLat);
    cum[i] = cum[i - 1] + _pa.distanceTo(_pb);
  }
  const total = cum[F - 1];
  const n = Math.max(2, Math.round(total / Math.max(0.6, spacing)) + 1);

  let seg = 0;
  for (let k = 0; k < n; k++) {
    const d = (k / (n - 1)) * total;
    while (seg < F - 2 && cum[seg + 1] < d) seg++;
    const a = frames[seg];
    const b = frames[seg + 1];
    const span = cum[seg + 1] - cum[seg];
    const t = span > 1e-6 ? Math.min(1, Math.max(0, (d - cum[seg]) / span)) : 0;

    // Anchor on the CHORD the beam actually spans, offset included, so the post
    // meets the beam wherever it lands between two frames. `deckLift` rides
    // along: on a curled bank the kerb the post stands on is above the
    // centreline plane, and it eases, so it is lerped like everything else.
    _pa.copy(a.pos).addScaledVector(a.right, baseLat).addScaledVector(a.up, a.deckLift ?? 0);
    _pb.copy(b.pos).addScaledVector(b.right, baseLat).addScaledVector(b.up, b.deckLift ?? 0);
    _pos.lerpVectors(_pa, _pb, t);

    // Re-orthogonalised, since lerping two orthonormal bases does not give one.
    _fwd.lerpVectors(a.tangent, b.tangent, t).normalize();
    _up.lerpVectors(a.up, b.up, t).normalize();
    _right.crossVectors(_fwd, _up).normalize(); // the kit's right = cross(tangent, up)
    _up.crossVectors(_right, _fwd).normalize();

    // (right, up, tangent) is LEFT-handed here, so negate the third axis to keep
    // the template's winding intact; the post is symmetric along travel, so the
    // flip costs nothing.
    _rightS.copy(_right).multiplyScalar(zSign);
    _fwdS.copy(_fwd).multiplyScalar(-zSign);
    _m.makeBasis(_rightS, _up, _fwdS).setPosition(_pos);
    out.push(template.clone().applyMatrix4(_m));
  }
}

/**
 * Thin a piece's frames for the RAIL SWEEP ONLY.
 *
 * The deck is stepped at roadParams.segLen (1.6 m) because its SURFACE
 * needs that resolution, and curves are capped at 1.5°/step so the kerb
 * silhouette does not facet. A rail is a smooth tube 0.26 m across — it
 * needs nothing like that. Measured: a 32 m straight goes 21 frames → 9,
 * and a 90° R26 curve 61 → ~16, which is most of the beam's triangle cost
 * gone for no visible change at any speed you drive at.
 *
 * First and last frames are kept exactly, so the rail still starts and
 * ends flush with the piece's sockets.
 *
 * MEASURE THE RAIL'S PATH, NOT THE CENTRELINE'S. `lat` is the lateral offset the
 * rail being thinned actually sits at, and passing it is not optional polish on
 * any piece that ROLLS. A rail stands ~7.6 m out from the centre, so when a
 * bank-in rolls its deck 22° the rail swings through ~2.9 m of vertical arc —
 * while the centreline is a dead straight line whose tangent never moves at all
 * and whose `up` only turns those same 22°. Judged on the centreline the piece
 * looks nearly frame-free, the distance rule alone survives, and an 18 m
 * transition keeps about SIX frames to describe a 3 m climb. That is what the
 * rising rail on a bank-in looked like: a row of straight chords with a visible
 * kink at each one.
 *
 * `deckLift` (the curled bank deck raising its own kerb — see buildBankProfile)
 * rides in the same measurement for the same reason.
 *
 * @param {number} [lat=0] lateral offset of this rail; 0 measures the
 *   centreline, which is right for a piece with no roll and wrong for one with.
 */
export function decimateFrames(frames, maxDist, maxAngleDeg, lat = 0) {
  if (frames.length <= 2 || maxDist <= 0) return frames;
  const maxAngle = THREE.MathUtils.degToRad(Math.max(0.5, maxAngleDeg));
  const ang = (a, b) => Math.acos(Math.min(1, Math.max(-1, a.dot(b))));

  // Where this rail actually runs, and which way it is heading there.
  const railPos = (f) => f.pos.clone()
    .addScaledVector(f.right, lat)
    .addScaledVector(f.up, f.deckLift ?? 0);
  const path = frames.map(railPos);
  const dir = path.map((_, i) => {
    const a = path[Math.max(0, i - 1)];
    const b = path[Math.min(path.length - 1, i + 1)];
    const d = b.clone().sub(a);
    return d.lengthSq() < 1e-12 ? frames[i].tangent.clone() : d.normalize();
  });

  // Roll counts as much as yaw — a twist piece turns its `up` while the tangent
  // barely moves, and dropping those frames would untwist it.
  const budget = (a, i) => Math.max(
    ang(frames[a].tangent, frames[i].tangent),
    ang(frames[a].up, frames[i].up),
    ang(dir[a], dir[i]),
  );

  const out = [frames[0]];
  let run = 0;
  let anchor = 0;
  for (let i = 1; i < frames.length - 1; i++) {
    // Distance along the RAIL, not the centreline — the outer rail of a curve
    // is genuinely longer and wants its frames spaced on its own run.
    run += path[i].distanceTo(path[i - 1]);
    // THE ANGLE TEST LOOKS ONE FRAME AHEAD; the distance test does not.
    //
    // Asking "have I exceeded it yet?" commits frame i only once the limit is
    // already past, so the gap left behind is however far the path moved in the
    // step that tripped it — unbounded, and worst exactly where the motion is
    // fastest. For ANGLE that is a visible defect: on a bank-in the roll rate
    // peaks mid-transition and it measured 14.9° between consecutive rail
    // frames against a stated 7° limit, which is a corner you can see in the
    // beam. Looking ahead makes the limit an actual limit (7.7°, the remainder
    // being chord-vs-tangent).
    //
    // DISTANCE is left alone deliberately. Overshooting it on a straight run
    // costs nothing to look at — the direction has not changed, so a longer
    // chord is still exactly on the path — and tightening it there is pure
    // triangles: measured +14% on every rail in the kit (3288 → 3744 tris on a
    // 32 m straight) to fix a kink that only curved and rolling pieces have.
    if (run >= maxDist || budget(anchor, i + 1) > maxAngle) {
      out.push(frames[i]);
      run = 0;
      anchor = i;
    }
  }
  out.push(frames[frames.length - 1]);
  return out;
}

/** @param {Array} frames the piece's own transport frames (buildPiece.frames) */
/** Sweep an OPEN section along frames straight into shared buffers. Position and
 *  index only — a BVH reads nothing else, so normals and UVs are pure waste. */
function sweepCollisionSheet(frames, section, baseLat, zSign, positions, indices) {
  const F = frames.length;
  const S = section.length;
  const base = positions.length / 3;
  for (let i = 0; i < F; i++) {
    const fr = frames[i];
    // Same per-frame kerb lift the visible rail uses — the proxy has to track
    // it or the chassis collides with a barrier that is not where it looks.
    const lift = fr.deckLift ?? 0;
    for (let j = 0; j < S; j++) {
      const s = section[j];
      const lat = baseLat + zSign * s.z;
      const y = s.y + lift;
      positions.push(
        fr.pos.x + fr.right.x * lat + fr.up.x * y,
        fr.pos.y + fr.right.y * lat + fr.up.y * y,
        fr.pos.z + fr.right.z * lat + fr.up.z * y,
      );
    }
  }
  for (let i = 0; i < F - 1; i++) {
    const r0 = base + i * S;
    const r1 = base + (i + 1) * S;
    for (let j = 0; j < S - 1; j++) {
      indices.push(r0 + j, r1 + j, r0 + j + 1, r0 + j + 1, r1 + j, r1 + j + 1);
    }
  }
}

/**
 * COLLISION PROXY — what the chassis actually hits.
 *
 * A guardrail's collision job is small: stop the car leaving sideways, scrape
 * believably, never trap it, and shed it if it lands on top. Nothing in that
 * list needs corrugation, posts, bolts or a back plate, and the previous proxy
 * (the kit's old W-beam sheet plus box posts, 696 tris a piece) paid for all
 * four. Two reasons they are not merely wasted:
 *
 *  - Guardrails are in the SOLIDS bvh, which only the CHASSIS HULL touches —
 *    wheels never probe them. And the hull is SAMPLED against triangles, so
 *    surface detail finer than the sample spacing is invisible at best and
 *    something for a sample to snag on at worst. A flat face slides cleanly.
 *  - The posts sit on the FIELD side, behind the beam. The only way to reach
 *    one is to already be through the rail.
 *
 * So: one wall at the beam's traffic face, run from the kerb (no ledge under
 * the beam for a sample to catch), capped with a 45° tent.
 *
 * THE TENT IS NOT OPTIONAL. The rail top stands 1.2 m over the deck and this is
 * a stunt game, so cars land on it. See wBeamProfile in modularRoadKit.js: a
 * flat or knife-edged top leaves a car neither supported nor rejected, and with
 * no wheels on the deck it has no drive, no steering and no way off. The tent
 * gives every landing a direction to fall.
 *
 * Derived from the VISIBLE rail's own profile and swept along the SAME
 * decimated frames, so the two can never drift apart. They already had: the
 * proxy was a separate parameter set whose beam was 0.1 m deep against the
 * visible 0.26, leaving the car colliding 8 cm short of the rail it could see.
 *
 * DO NOT "FIX" THIS BY MAKING IT DOUBLE-SIDED. An open sheet with no thickness
 * looks like something a car could pass through from behind, and it is not: the
 * chassis only ever queries the solids BVH via `closestPointWithNormal`, which
 * re-orients the face normal toward the query point (modularRoadBvh.js). The
 * push-out direction therefore comes from which side you are on, not from
 * winding. Emitting reversed triangles would double the collision mesh and
 * change nothing. Held by tools/railCollisionSideTest.mjs.
 */
export function buildRailCollision(frames, rp, r = railParams) {
  if (r.height <= 0 || !frames?.length) return null;
  const hw = rp.width / 2;
  const rw = Math.min(Math.max(0, rp.railWidth), hw * 0.45);
  const kerbTop = rp.railHeight;
  const edgeAbs = hw - rw * 0.5;
  const centerV = kerbTop + r.gap + r.height * 0.5;
  const prof = railProfile({ ...r, humps: r.style, flip: r.flipW });

  const beamTop = centerV + prof.height * 0.5;
  const half = prof.depth * 0.5;
  const zBack = prof.backZ; // field side
  const zFace = -prof.backZ; // traffic side — the surface the car should meet

  const section = [
    { y: kerbTop, z: zFace }, // stands on the kerb
    { y: beamTop - half, z: zFace }, // up the traffic face
    { y: beamTop, z: 0 }, // ridge
    { y: beamTop - half, z: zBack }, // and down the back
  ];

  const positions = [];
  const indices = [];
  for (const side of [-1, 1]) {
    const zSign = r.mirrorSides ? side : 1;
    // Thinned on THIS rail's own path (see decimateFrames) so the proxy keeps
    // following the visible beam on a rolling piece.
    const sweepFrames = decimateFrames(frames, r.frameStep, r.frameAngle, side * edgeAbs);
    sweepCollisionSheet(sweepFrames, section, side * edgeAbs, zSign, positions, indices);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeBoundingSphere();
  return geo;
}

export function buildRailGeometry(frames, rp, r = railParams) {
  if (r.height <= 0 || !frames?.length) return null;
  const hw = rp.width / 2;
  const rw = Math.min(Math.max(0, rp.railWidth), hw * 0.45);
  const kerbTop = rp.railHeight;
  const edgeAbs = hw - rw * 0.5;
  const centerV = kerbTop + r.gap + r.height * 0.5;
  const prof = railProfile({ ...r, humps: r.style, flip: r.flipW });

  // Post space is centred on the kerb, so the kerb's outer edge is at rw/2.
  const template = r.posts
    ? buildPostTemplate(prof, r, kerbTop, centerV, rw * 0.5)
    : null;
  const geos = [];
  for (const side of [-1, 1]) {
    const zSign = r.mirrorSides ? side : 1;
    const baseLat = side * edgeAbs;
    // PER SIDE, on this rail's own path — the two rails of a rolling or curving
    // piece do not travel the same distance or turn through the same angles, so
    // one shared thinning has to be wrong for at least one of them.
    // Beam AND posts still use the SAME polyline, which is the constraint that
    // actually matters, or the posts stand off the beam — see placePosts.
    const sweepFrames = decimateFrames(frames, r.frameStep, r.frameAngle, baseLat);
    geos.push(sweepRail(sweepFrames, prof, baseLat, zSign, centerV));
    if (template) placePosts(sweepFrames, template, baseLat, zSign, r.postSpacing, geos);
  }
  template?.dispose();
  const merged = mergeGeometries(geos, false);
  for (const g of geos) g.dispose();
  if (merged) merged.computeBoundingSphere();
  return merged;
}
