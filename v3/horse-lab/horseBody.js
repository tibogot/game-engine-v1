// ── Horse lab: a new BODY on the horse's skeleton ────────────────────────────
// The Quaternius horse's skeleton and clips drive everything (gaits, hoof IK,
// jumps, rear, mount); this puts another horse model — a static mesh, no bones
// (public/models/armored_horse_compressed.glb) — on that skeleton:
//
//   1. LANDMARKS found on both bodies (hooves, leg tops, belly, back, withers,
//      croup, chest, rump, nose, poll), the same way on each;
//   2. a smooth 3-D warp (thin-plate spline) through those pairs moves every
//      BONE into the new body; each bone's position keys in every clip move by
//      the same rest offset, so the clips play on the new proportions;
//   3. the new mesh takes its SKIN WEIGHTS from the old one, warped onto it
//      (nearest points); rigid pieces (saddle, head plate) follow one bone;
//   4. the old mesh is warped too and kept INVISIBLE: a light raycast stand-in
//      (the saddle fit and the knee checks raycast it, not 44k triangles).
//
// Runs inside loadHorse, after the model faces +Z at its scale and before any
// gait is measured, so every measurement is of the new horse.
import * as THREE from "three";

const V3 = THREE.Vector3;

// ── thin-plate spline, R³ → R³, kernel φ(r) = r ──────────────────────────────
function solve(A, b) {                                       // Gaussian elimination, partial pivot
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c] || 1e-12;
    for (let r = c + 1; r < n; r++) { const f = M[r][c] / d; if (f) for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) { let s = M[r][n]; for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k]; x[r] = s / (M[r][r] || 1e-12); }
  return x;
}
export function makeWarp(src, dst) {
  const n = src.length, N = n + 4;
  const A = Array.from({ length: N }, () => new Array(N).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) A[i][j] = src[i].distanceTo(src[j]);
    A[i][n] = A[n][i] = 1;
    A[i][n + 1] = A[n + 1][i] = src[i].x; A[i][n + 2] = A[n + 2][i] = src[i].y; A[i][n + 3] = A[n + 3][i] = src[i].z;
  }
  const W = ["x", "y", "z"].map((k) => solve(A, [...dst.map((p) => p[k]), 0, 0, 0, 0]));
  return (p, out = new V3()) => {
    const r = [0, 0, 0];
    for (let c = 0; c < 3; c++) {
      const w = W[c];
      let s = w[n] + w[n + 1] * p.x + w[n + 2] * p.y + w[n + 3] * p.z;
      for (let i = 0; i < n; i++) s += w[i] * src[i].distanceTo(p);
      r[c] = s;
    }
    return out.set(r[0], r[1], r[2]);
  };
}

// ── landmarks of a horse-shaped point cloud (+Z forward, +Y up) ───────────────
export function horseLandmarks(P) {
  const box = new THREE.Box3().setFromPoints(P), H = box.max.y - box.min.y, L = box.max.z - box.min.z, Wd = box.max.x - box.min.x;
  const mean = (a, k) => a.reduce((s, p) => s + p[k], 0) / Math.max(1, a.length);
  const low = P.filter((p) => p.y < box.min.y + 0.035 * H);
  const zc = mean(low, "z");
  const quad = (fr, lr) => low.filter((p) => (p.z > zc) === fr && (p.x > 0) === lr);
  const hoof = [[true, true], [true, false], [false, true], [false, false]].map(([f, l]) => { const q = quad(f, l); return new V3(mean(q, "x"), box.min.y, mean(q, "z")); });
  const zF = (hoof[0].z + hoof[1].z) / 2, zH = (hoof[2].z + hoof[3].z) / 2, zM = (zF + zH) / 2;
  const slice = (z, w = 0.06, xw = 0.12) => P.filter((p) => Math.abs(p.z - z) < w * L && Math.abs(p.x) < xw * Wd + 0.02);
  const sM = slice(zM), sF = slice(zF), sH = slice(zH);
  const minY = (a) => Math.min(...a.map((p) => p.y)), maxY = (a) => Math.max(...a.map((p) => p.y));
  const belly = minY(sM), back = maxY(sM), croup = maxY(sH), withers = maxY(sF);
  const midY = (belly + back) / 2;
  // chest front / rump back: the furthest points at body height (not the head, not the tail tip)
  const body = P.filter((p) => p.y > belly && p.y < midY + 0.15 * (back - belly) && Math.abs(p.x) < 0.3 * Wd);
  const chest = body.reduce((a, p) => (p.z > a.z ? p : a), body[0]);
  const rump = body.reduce((a, p) => (p.z < a.z ? p : a), body[0]);
  const nose = P.reduce((a, p) => (p.z > a.z ? p : a), P[0]);
  const poll = P.reduce((a, p) => (p.y > a.y ? p : a), P[0]);
  const legTop = hoof.map((h) => new V3(h.x, belly, h.z));
  const knee = hoof.map((h) => new V3(h.x, box.min.y + 0.5 * (belly - box.min.y), h.z));
  return {
    points: [...hoof, ...legTop, ...knee, new V3(0, belly, zM), new V3(0, back, zM), new V3(0, croup, zH), new V3(0, withers, zF),
      new V3(0, chest.y, chest.z), new V3(0, rump.y, rump.z), nose.clone(), poll.clone()],
    names: ["hoofFL", "hoofFR", "hoofBL", "hoofBR", "legTopFL", "legTopFR", "legTopBL", "legTopBR", "kneeFL", "kneeFR", "kneeBL", "kneeBR", "belly", "back", "croup", "withers", "chest", "rump", "nose", "poll"],
    box,
  };
}

// ── spatial hash for nearest-point queries ────────────────────────────────────
function makeGrid(points, cell) {
  const map = new Map(), key = (x, y, z) => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
  points.forEach((p, i) => { const k = key(p.x, p.y, p.z); (map.get(k) ?? map.set(k, []).get(k)).push(i); });
  return {
    nearest(p, k = 4) {
      const cx = Math.floor(p.x / cell), cy = Math.floor(p.y / cell), cz = Math.floor(p.z / cell);
      for (let r = 1; r < 8; r++) {
        const cand = [];
        for (let x = cx - r; x <= cx + r; x++) for (let y = cy - r; y <= cy + r; y++) for (let z = cz - r; z <= cz + r; z++) { const l = map.get(`${x},${y},${z}`); if (l) cand.push(...l); }
        if (cand.length >= k) return cand.map((i) => [i, points[i].distanceToSquared(p)]).sort((a, b) => a[1] - b[1]).slice(0, k);
      }
      return [];
    },
  };
}

/**
 * Put `bodyScene` (a static glTF scene, +Z forward, Y up, at real size) on the
 * horse's skeleton. `model` is the Quaternius scene as loadHorse has it at this
 * point (rest pose, facing +Z, scaled), `clips` its clips (position tracks are
 * shifted in place). Options: rigid(mesh) → true for meshes that move with ONE
 * bone. Returns { meshes, proxies, landmarks } for checks.
 */
export function fitBodyToRig({ model, clips, bodyScene, rigid = () => false }) {
  model.updateMatrixWorld(true);
  const bones = [];
  model.traverse((o) => { if (o.isBone) bones.push(o); });
  const oldSkins = [];
  model.traverse((o) => { if (o.isSkinnedMesh) oldSkins.push(o); });
  // the old body's vertices at rest (world) with their weights
  const oldPts = [], oldW = [];
  const p = new V3();
  for (const m of oldSkins) {
    const g = m.geometry, si = g.attributes.skinIndex, sw = g.attributes.skinWeight;
    const local = m.skeleton.bones;
    for (let i = 0; i < g.attributes.position.count; i++) {
      m.getVertexPosition(i, p); m.localToWorld(p);
      oldPts.push(p.clone());
      const w = [];
      for (let k = 0; k < 4; k++) { const wt = sw.getComponent(i, k); if (wt > 0) w.push([bones.indexOf(local[si.getComponent(i, k)]), wt]); }
      oldW.push(w);
    }
  }
  // the new body: placed over the old one (centred in x / z, standing on its ground)
  const oldBox = new THREE.Box3().setFromPoints(oldPts);
  bodyScene.updateMatrixWorld(true);
  const newBox = new THREE.Box3().setFromObject(bodyScene);
  bodyScene.position.set(
    (oldBox.min.x + oldBox.max.x) / 2 - (newBox.min.x + newBox.max.x) / 2,
    oldBox.min.y - newBox.min.y,
    (oldBox.min.z + oldBox.max.z) / 2 - (newBox.min.z + newBox.max.z) / 2,
  );
  bodyScene.updateMatrixWorld(true);
  const parts = [];
  bodyScene.traverse((o) => { if (o.isMesh) parts.push(o); });
  const partPts = parts.map((m) => {
    const a = m.geometry.attributes.position, out = [];
    for (let i = 0; i < a.count; i++) out.push(new V3().fromBufferAttribute(a, i).applyMatrix4(m.matrixWorld));
    return out;
  });
  // landmarks: the old body, and the new BODY part only (the biggest mesh: no saddle, no armour)
  const bodyIdx = parts.reduce((b, m, i) => (m.geometry.attributes.position.count > parts[b].geometry.attributes.position.count ? i : b), 0);
  const LA = horseLandmarks(oldPts), LB = horseLandmarks(partPts[bodyIdx]);
  const warp = makeWarp(LA.points, LB.points);

  // 2. bones: new rest positions (top-down), position keys shifted by the same local offset
  const newWorld = new Map(bones.map((b) => [b, warp(b.getWorldPosition(new V3()))]));
  const delta = new Map();
  const ordered = [];
  model.traverse((o) => { if (o.isBone) ordered.push(o); });   // parents before children
  for (const b of ordered) {
    const old = b.position.clone();
    b.parent.updateMatrixWorld(true);
    b.position.copy(b.parent.worldToLocal(newWorld.get(b).clone()));
    b.updateMatrixWorld(true);
    delta.set(b.name, b.position.clone().sub(old));
  }
  for (const clip of Object.values(clips)) for (const tr of clip.tracks) {
    const [name, prop] = tr.name.split(".");
    if (prop !== "position" || !delta.has(name)) continue;
    const d = delta.get(name), v = tr.values;
    for (let i = 0; i < v.length; i += 3) { v[i] += d.x; v[i + 1] += d.y; v[i + 2] += d.z; }
  }
  model.updateMatrixWorld(true);
  // the tail bones laid along the new tail's line (before the rest pose is taken)
  const tc = tailChain(bones);
  const curveT = tc.length >= 3 ? tailCurve({ root: tc[0].getWorldPosition(new V3()), croupY: LB.points[LB.names.indexOf("croup")].y, rumpZ: LB.points[LB.names.indexOf("rump")].z }) : null;
  if (curveT) layTailBones({ bones, clips, curve: curveT });
  model.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(bones);                // inverses from the NEW rest pose
  calmTail(clips, bones);                                    // (the new tail hangs: the stylised clip swing, toned down)

  // 3. the new body's skin: weights from the warped old body (4 nearest, by inverse distance)
  const tailIdx = new Set(bones.map((b, i) => (/^Tail/.test(b.name) ? i : -1)).filter((i) => i >= 0));
  const backIdx = Math.max(0, bones.findIndex((b) => b.name === "Back"));
  const warpedOld = oldPts.map((q) => warp(q));
  const grid = makeGrid(warpedOld, 0.06);
  const inv = new THREE.Matrix4().copy(model.matrixWorld).invert();
  const nrmM = new THREE.Matrix3();
  const meshes = parts.map((m, pi) => {
    const pts = partPts[pi], n = pts.length;
    const g = new THREE.BufferGeometry();
    const pos = new Float32Array(n * 3), nrm = new Float32Array(n * 3);
    const toModel = new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld);
    nrmM.getNormalMatrix(toModel);
    const na = m.geometry.attributes.normal, nv = new V3();
    for (let i = 0; i < n; i++) {
      const q = pts[i].clone().applyMatrix4(inv); pos.set([q.x, q.y, q.z], i * 3);
      if (na) { nv.fromBufferAttribute(na, i).applyMatrix3(nrmM).normalize(); nrm.set([nv.x, nv.y, nv.z], i * 3); }
    }
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    if (na) g.setAttribute("normal", new THREE.BufferAttribute(nrm, 3));
    if (m.geometry.attributes.uv) g.setAttribute("uv", m.geometry.attributes.uv.clone());
    if (m.geometry.index) g.setIndex(m.geometry.index.clone());
    const si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
    const acc = new Map();
    const weightsAt = (pt) => {
      acc.clear();
      // never the TAIL bones: the new body has no tail, and its rump skin took
      // their weights and stretched into a sail when the tail lifted (canter)
      for (const [j, d2] of grid.nearest(pt, 4)) { const w0 = 1 / (Math.sqrt(d2) + 0.005); for (const [b, w] of oldW[j]) if (!tailIdx.has(b)) acc.set(b, (acc.get(b) ?? 0) + w * w0); }
      if (!acc.size) acc.set(backIdx, 1);
      return [...acc.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
    };
    if (rigid(m, pi)) {
      // one bone for the whole piece: the strongest over its vertices
      const tot = new Map();
      for (let i = 0; i < n; i += 7) for (const [b, w] of weightsAt(pts[i])) tot.set(b, (tot.get(b) ?? 0) + w);
      const b = [...tot.entries()].sort((a, c) => c[1] - a[1])[0][0];
      for (let i = 0; i < n; i++) { si[i * 4] = b; sw[i * 4] = 1; }
    } else {
      const W0 = pts.map((pt) => new Map(weightsAt(pt)));
      const Ws = smoothWeights(W0, pts, m.geometry.index, 20);   // soft joints (~10 cm: the source triangles), one weight per welded vertex
      for (let i = 0; i < n; i++) {
        const top = [...Ws[i].entries()].sort((a, b) => b[1] - a[1]).slice(0, 4), s = top.reduce((a, [, w]) => a + w, 0) || 1;
        top.forEach(([b, w], k) => { si[i * 4 + k] = b; sw[i * 4 + k] = w / s; });
      }
    }
    g.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(si, 4));
    g.setAttribute("skinWeight", new THREE.BufferAttribute(sw, 4));
    g.computeBoundingSphere();
    const sm = new THREE.SkinnedMesh(g, m.material);
    sm.name = `body_${pi}`;
    sm.castShadow = true; sm.receiveShadow = true; sm.frustumCulled = false;
    sm.raycast = () => {};                                   // the stand-in is what rays hit
    model.add(sm);
    sm.updateMatrixWorld(true);
    sm.bind(skeleton, sm.matrixWorld);                       // (attached mode: bind = its world matrix at rest — at rest every bone matrix is identity)
    return sm;
  });

  // 3b. a TAIL of our own (the new body has none), skinned to the tail bones
  const tail = curveT ? buildTail({ model, bones, skeleton, inv, rumpZ: LB.points[LB.names.indexOf("rump")].z, curve: curveT }) : null;
  if (tail) meshes.push(tail);

  // 4. the old body → warped invisible stand-in on the same skeleton
  const proxies = oldSkins.map((m, k) => {
    const g0 = m.geometry, n = g0.attributes.position.count, g = new THREE.BufferGeometry();
    const pos = new Float32Array(n * 3), si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
    let base = 0; for (let j = 0; j < k; j++) base += oldSkins[j].geometry.attributes.position.count;
    for (let i = 0; i < n; i++) {
      const q = warpedOld[base + i].clone().applyMatrix4(inv); pos.set([q.x, q.y, q.z], i * 3);
      oldW[base + i].slice(0, 4).forEach(([b, w], c) => { si[i * 4 + c] = b; sw[i * 4 + c] = w; });
    }
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(si, 4));
    g.setAttribute("skinWeight", new THREE.BufferAttribute(sw, 4));
    if (g0.index) g.setIndex(Array.from(g0.index.array));
    g.computeVertexNormals(); g.computeBoundingSphere();
    const pm = new THREE.SkinnedMesh(g, m.material);
    pm.name = `proxy_${k}`;
    pm.visible = false; pm.frustumCulled = false;
    model.add(pm);
    pm.updateMatrixWorld(true);
    pm.bind(skeleton, pm.matrixWorld);
    m.removeFromParent();
    return pm;
  });
  bodyScene.removeFromParent();
  return { meshes, proxies, skeleton, landmarks: { old: LA, new: LB }, warp };
}


// ── the tail ─────────────────────────────────────────────────────────────────
// HAIR CARDS, the way games do hair: 14 ribbons with a strand texture (opaque
// near the dock, thinning to ragged, fading tips), fanned round the back and
// sides of a short dock and spreading as the tail falls — light passes
// between the locks, so it reads as hair, not a tube. Its own shape (the bone
// chain is a stylised raised hook): the dock goes back and a little down from
// the croup, the hair falls to about the hocks, behind the quarters.
// Each card is built TWICE, once per side, both front-facing with a normal
// pointing OUT from the tail's axis: the bundle shades like a volume, and no
// DoubleSide face flips its normal into the hair (that renders black).
// Every vertex follows the nearest tail bones (inverse distance to the bone
// segments), so the clips still swing it.
function hairTexture() {
  const W = 128, H = 512, cv = document.createElement("canvas");
  cv.width = W; cv.height = H;
  const ctx = cv.getContext("2d");
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  // a dense opaque band at the top (the dock and the hair's root)
  const top = ctx.createLinearGradient(0, 0, 0, H * 0.3);
  top.addColorStop(0, "rgba(16,13,11,1)"); top.addColorStop(1, "rgba(16,13,11,0)");
  ctx.fillStyle = top; ctx.fillRect(0, 0, W, H * 0.3);
  // strands: denser in the middle of the card, each ending at its own length
  for (let i = 0; i < 120; i++) {                           // fewer: real gaps between locks (260 made a solid card)
    const x0 = W * (0.5 + (rnd() - 0.5) * (rnd() < 0.75 ? 0.75 : 1.0));
    const len = H * (0.55 + 0.45 * Math.pow(rnd(), 0.6));
    const shade = rnd();
    const r = shade < 0.18 ? 70 + shade * 90 : 12 + shade * 26, gch = r * 0.8, b = r * 0.7;   // near-black (the reference), a fifth with faint grey-brown glints
    ctx.lineWidth = 0.8 + rnd() * 2.2;
    const grad = ctx.createLinearGradient(0, 0, 0, len);
    grad.addColorStop(0, `rgba(${r},${gch},${b},1)`); grad.addColorStop(0.75, `rgba(${r},${gch},${b},0.95)`); grad.addColorStop(1, `rgba(${r},${gch},${b},0)`);
    ctx.strokeStyle = grad;
    ctx.beginPath();
    const ph = rnd() * 6, amp = 1 + rnd() * 3;
    for (let y = 0; y <= len; y += 8) { const x = x0 + Math.sin(y / 60 + ph) * amp + (y / H) * (rnd() - 0.5) * 2; if (y === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

const tailChain = (bones) => bones.filter((b) => /^Tail\d+$/.test(b.name)).sort((a, b) => +a.name.slice(4) - +b.name.slice(4));

// The tail's own line (rest pose, world): from the root inside the croup, out at
// the TOP of the rump just under the croup — above the crupper strap, which loops
// under it (out at ~1.2 m it hung below the strap) — then falling to the hocks.
function tailCurve({ root, croupY, rumpZ }) {
  const groundY = 0.42 * (root.y / 1.33);                     // ~hock height (scaled with the horse)
  const dock = new V3(0, croupY - 0.16, rumpZ - 0.02);       // (−0.06 carried it too high and proud; still above the strap at ~1.28 m)
  // out of the croup, then a quarter-circle (r 13 cm) back-and-down into the fall —
  // a tighter bend (~6 cm) still read as an angle at the dock
  const r = 0.13, arc = (deg) => dock.clone().add(new V3(0, -r * (1 - Math.cos(deg * Math.PI / 180)), -r * Math.sin(deg * Math.PI / 180)));
  return new THREE.CatmullRomCurve3([
    root.clone(), dock,
    arc(30), arc(60), arc(90),
    dock.clone().add(new V3(0, -0.28, -0.125)),
    dock.clone().add(new V3(0, -0.5 * (dock.y - groundY), -0.105)),
    new V3(0, groundY + 0.12, dock.z - 0.075),
    new V3(0, groundY, dock.z - 0.055),
  ], false, "centripetal");
}

// The tail BONES moved onto that line. They sat along the old horse's tail — a
// raised hook — so each bone swung a part of our tail that was not round it and
// the gallop showed a stiff, kinked plank; laid along the tail, each animated
// rotation bends it about its own centre line, in one smooth arc. Their
// position keys in every clip move by the same rest offset (like the body fit).
const TAIL_AT = [0, 0.12, 0.27, 0.42, 0.57, 0.72, 0.86];      // where each tail bone sits along the tail (arc length)

function layTailBones({ bones, clips, curve }) {
  const chain = tailChain(bones);
  const at = TAIL_AT;
  const delta = new Map();
  chain.forEach((b, i) => {
    if (i === 0) return;                                     // Tail1: the root stays (inside the croup)
    const old = b.position.clone();
    b.parent.updateMatrixWorld(true);
    b.position.copy(b.parent.worldToLocal(curve.getPointAt(at[Math.min(i, at.length - 1)]).clone()));
    b.updateMatrixWorld(true);
    delta.set(b.name, b.position.clone().sub(old));
  });
  for (const clip of Object.values(clips)) for (const tr of clip.tracks) {
    const [name, prop] = tr.name.split(".");
    if (prop !== "position" || !delta.has(name)) continue;
    const d = delta.get(name), v = tr.values;
    for (let i = 0; i < v.length; i += 3) { v[i] += d.x; v[i + 1] += d.y; v[i + 2] += d.z; }
  }
}

function buildTail({ model, bones, skeleton, inv, rumpZ, curve }) {
  const chainB = tailChain(bones);
  if (chainB.length < 3) return null;
  // weights: by position ALONG the tail (u), not distance — each bone owns its
  // segment's middle and hands over smoothly to the next, so a bent joint
  // bends the hair in a curve (nearest-segment weights creased it at every joint:
  // an elbow at the dock)
  const at = chainB.map((_, i) => TAIL_AT[Math.min(i, TAIL_AT.length - 1)]);
  const mid = at.map((a, i) => (a + (i + 1 < at.length ? at[i + 1] : 1)) / 2);
  const weightsFor = (u) => {
    const n = mid.length;
    if (u <= mid[0]) return [bones.indexOf(chainB[0]), 0, 1, 0];
    if (u >= mid[n - 1]) return [bones.indexOf(chainB[n - 1]), 0, 1, 0];
    let i = 0; while (u > mid[i + 1]) i++;
    let t = (u - mid[i]) / (mid[i + 1] - mid[i]); t = t * t * (3 - 2 * t);
    return [bones.indexOf(chainB[i]), bones.indexOf(chainB[i + 1]), 1 - t, t];
  };
  const pos = [], nrm = [], uvs = [], col = [], si = [], sw = [], idx = [];
  const behind = (c, margin) => { if (c.z > rumpZ - margin) c.z = rumpZ - margin; return c; };
  const push = (p, n, u, v, tint, w) => {
    const q = p.clone().applyMatrix4(inv);
    pos.push(q.x, q.y, q.z);
    const nq = n.clone().transformDirection(inv);
    nrm.push(nq.x, nq.y, nq.z);
    uvs.push(u, v); col.push(tint, tint, tint);
    si.push(w[0], w[1], 0, 0); sw.push(w[2], w[3], 0, 0);
  };
  const side = new V3(1, 0, 0);
  // 1. the dock: a short tube (the top of the texture: opaque), into the croup
  const DR = 10, DS = 12;
  for (let r = 0; r <= DR; r++) {
    const u = 0.35 * r / DR, c = curve.getPointAt(u), T = curve.getTangentAt(u), bk = new V3().crossVectors(side, T).normalize();
    const rad = 0.04 - 0.01 * (u / 0.35), w = weightsFor(u);   // slim dock (the reference: narrow at the croup)
    for (let k = 0; k <= DS; k++) {
      const a = (k / DS) * Math.PI * 2, n = side.clone().multiplyScalar(Math.cos(a)).addScaledVector(bk, Math.sin(a));
      push(c.clone().addScaledVector(n, rad), n, k / DS, 0.02 + 0.12 * (r / DR), 0.9, w);
    }
  }
  for (let r = 0; r < DR; r++) for (let k = 0; k < DS; k++) {
    const a = r * (DS + 1) + k, b = a + 1, c2 = a + DS + 1, d = c2 + 1;
    idx.push(a, c2, b, b, c2, d);                            // outward: (a, b, c2) gave t×T = −side, inward — black on a lit tube
  }
  // 2. the cards
  let seed = 41;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const CARDS = 14, SEG = 26;
  for (let i = 0; i < CARDS; i++) {
    // round the back and the sides (not into the horse): −160°…+160° from straight back
    const th = (-0.9 + 1.8 * (i + rnd() * 0.6) / CARDS) * Math.PI * 0.95;
    const spreadK = 0.6 + rnd() * 0.6, lenK = 0.86 + rnd() * 0.16, wK = 0.8 + rnd() * 0.5, tint = 0.85 + rnd() * 0.3;
    const u0 = 0.03 + rnd() * 0.04;                         // from the root, inside the croup
    for (const face of [1, -1]) {
      const base = pos.length / 3;
      for (let s = 0; s <= SEG; s++) {
        const t = s / SEG, u = u0 + (lenK - u0) * t;
        const c = curve.getPointAt(Math.min(1, u)), T = curve.getTangentAt(Math.min(1, u));
        const bk = new V3().crossVectors(side, T).normalize();                 // straight back from the tail axis
        const radial = bk.clone().multiplyScalar(Math.cos(th)).addScaledVector(side, Math.sin(th)).normalize();
        const tang = new V3().crossVectors(T, radial).normalize();             // across the card
        const spread = (0.012 + 0.035 * Math.min(1, Math.max(0, (u - 0.2) / 0.4)) - 0.012 * Math.max(0, (u - 0.8) / 0.2)) * spreadK;   // widens only lower down
        const width = (0.03 + 0.035 * Math.min(1, t / 0.55) - 0.025 * Math.max(0, (t - 0.75) / 0.25)) * wK;   // slim at the top, ~12 cm bundle low down
        // keep the AXIS behind the quarters by the bundle's own radius, THEN fan out
        // (clamping each card centre collapsed every card onto one plane: a flat sheet)
        // ...only lower down: at the top the hair must JOIN the dock at the croup (a
        // clamp all along floated the tail behind the quarters like a separate block)
        const away = Math.min(1, Math.max(0, (u - 0.28) / 0.2));
        if (away > 0) { const lim = rumpZ - (0.02 + 0.08 * spreadK) * away; if (c.z > lim) c.z = lim; }
        const centre = c.clone().addScaledVector(radial, spread);
        const w = weightsFor(Math.min(1, u));
        for (const e of [-1, 1]) push(centre.clone().addScaledVector(tang, e * width / 2), radial, (e + 1) / 2, 0.06 + 0.92 * t, tint, w);
      }
      for (let s = 0; s < SEG; s++) {
        const a = base + s * 2, b = a + 1, c2 = a + 2, d = a + 3;
        if (face > 0) idx.push(a, c2, b, b, c2, d); else idx.push(a, b, c2, b, d, c2);   // both sides, each front-facing
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(si, 4));
  g.setAttribute("skinWeight", new THREE.Float32BufferAttribute(sw, 4));
  g.setIndex(idx);
  g.computeBoundingSphere();
  // rough, little sky reflection (0.55 roughness mirrored the blue sky)
  const m = new THREE.SkinnedMesh(g, new THREE.MeshStandardMaterial({ map: hairTexture(), vertexColors: true, alphaTest: 0.45, roughness: 0.85, metalness: 0, envMapIntensity: 0.55 }));
  m.name = "tail"; m.castShadow = true; m.receiveShadow = true; m.frustumCulled = false;
  m.raycast = () => {};
  model.add(m);
  m.updateMatrixWorld(true);
  m.bind(skeleton, m.matrixWorld);
  return m;
}


// Calm the tail: the clips swing a stylised tail; a real one hangs, and moves
// less at the walk than streaming out at the gallop. Each tail key is pulled
// toward the bone's rest rotation.
export function calmTail(clips, bones) {
  const rest = new Map(bones.filter((b) => /^Tail\d+$/.test(b.name)).map((b) => [b.name, b.quaternion.clone()]));
  const q = new THREE.Quaternion();
  for (const [name, clip] of Object.entries(clips)) {
    const keep = /Gallop|Jump|Canter/.test(name) ? 0.75 : 0.45;
    for (const tr of clip.tracks) {
      const [b, prop] = tr.name.split(".");
      if (prop !== "quaternion" || !rest.has(b)) continue;
      const r0 = rest.get(b), v = tr.values;
      for (let i = 0; i < v.length; i += 4) { q.fromArray(v, i); r0.clone().slerp(q, keep).toArray(v, i); }
    }
  }
}

// Smooth skin weights over the mesh. The source body is low-poly with HARD
// weight boundaries; copied onto a dense mesh they made creases (a flat flap
// behind the thighs at the gallop). Vertices at the same position (UV seams)
// are WELDED first, so both sides of a seam get one weight (no cracks at the
// fetlocks). Then `iters` rounds of: each vertex = half its own, half its
// neighbours' mean.
function smoothWeights(W, pts, index, iters) {
  const n = pts.length, key = new Map(), canon = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const p = pts[i], k = `${Math.round(p.x * 2e4)},${Math.round(p.y * 2e4)},${Math.round(p.z * 2e4)}`;
    if (!key.has(k)) key.set(k, key.size);
    canon[i] = key.get(k);
  }
  const m = key.size, nb = Array.from({ length: m }, () => new Set());
  const ix = index ? index.array : null, tris = (ix ? ix.length : n) / 3;
  for (let t = 0; t < tris; t++) {
    const a = canon[ix ? ix[t * 3] : t * 3], b = canon[ix ? ix[t * 3 + 1] : t * 3 + 1], c = canon[ix ? ix[t * 3 + 2] : t * 3 + 2];
    nb[a].add(b); nb[a].add(c); nb[b].add(a); nb[b].add(c); nb[c].add(a); nb[c].add(b);
  }
  let cw = Array.from({ length: m }, () => new Map());
  for (let i = 0; i < n; i++) for (const [b, w] of W[i]) cw[canon[i]].set(b, Math.max(cw[canon[i]].get(b) ?? 0, w));   // welded: one weight
  for (let it = 0; it < iters; it++) {
    const next = cw.map((own, v) => {
      const out = new Map();
      for (const [b, w] of own) out.set(b, w * 0.5);
      const list = nb[v];
      if (!list.size) return own;
      const f = 0.5 / list.size;
      for (const u of list) for (const [b, w] of cw[u]) out.set(b, (out.get(b) ?? 0) + w * f);
      // keep the strongest 6 so the maps stay small
      return new Map([...out.entries()].sort((x, y) => y[1] - x[1]).slice(0, 6));
    });
    cw = next;
  }
  return Array.from({ length: n }, (_, i) => cw[canon[i]]);
}

// ── the armoured model's pieces ──────────────────────────────────────────────
// Its parts hold many separate pieces (connected islands). Measured in the
// horse's frame (y up from the ground, z forward, after loadHorse):
//   body_0  neck plates + face plate        → each RIGID on its strongest bone
//   body_1  the saddle                       → RIGID
//   body_2  tack: reins (saddle → bit, z 0.2…1.2) and the stirrup leathers +
//           irons (outside the flanks, below 1.35 m) → REMOVED: the lab's own
//           rope reins and swinging stirrups replace them;
//           bridle, bit rings, buckles (z > 0.85 up on the head) → RIGID on the head
//   everything else (girth, breast strap, crupper, saddle cloth) stays skinned.
export function trimArmorPieces(h) {
  // the hide: roughness 0.72 × its map read as wet plastic under the sky's light — 1.0 × map is a satin coat
  for (const m of h.bodyFit.meshes) if (m.material.name === "02___Default") { m.material.roughness = 1.0; m.material.needsUpdate = true; }
  const M = h.model.matrix, V = THREE.Vector3;
  const rules = {
    body_0: () => "rigid",
    body_1: () => "rigid",
    body_2: (b) => {
      const zLen = b.max.z - b.min.z;
      if (zLen > 0.7 && b.min.z < 0.4 && b.max.z > 1.0 && b.max.y < 1.65) return "remove";                 // reins
      if ((b.min.x > 0.15 || b.max.x < -0.15) && b.min.y < 1.0 && zLen < 0.25) return "remove";             // stirrup leathers + irons
      if (b.min.z > 0.85 && b.min.y > 1.4) return "rigid";                                                  // bridle hardware on the head
      return "skin";
    },
  };
  const report = {};
  for (const m of h.bodyFit.meshes) {
    const rule = rules[m.name];
    if (!rule) continue;
    const g = m.geometry, P = g.attributes.position, n = P.count, ix = g.index.array;
    const SI = g.attributes.skinIndex, SW = g.attributes.skinWeight;
    const key = new Map(), canon = new Int32Array(n);
    for (let i = 0; i < n; i++) { const k = `${Math.round(P.getX(i) * 2e4)},${Math.round(P.getY(i) * 2e4)},${Math.round(P.getZ(i) * 2e4)}`; if (!key.has(k)) key.set(k, key.size); canon[i] = key.get(k); }
    const par = Int32Array.from({ length: key.size }, (_, i) => i);
    const find = (x) => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
    for (let t = 0; t < ix.length; t += 3) { const a = find(canon[ix[t]]); par[find(canon[ix[t + 1]])] = a; par[find(canon[ix[t + 2]])] = a; }
    const isl = new Map(), v = new V();
    for (let i = 0; i < n; i++) {
      const r = find(canon[i]);
      if (!isl.has(r)) isl.set(r, { verts: [], box: new THREE.Box3() });
      const s = isl.get(r); s.verts.push(i);
      s.box.expandByPoint(v.fromBufferAttribute(P, i).applyMatrix4(M));
    }
    const action = new Map(), count = { remove: 0, rigid: 0, skin: 0 };
    for (const [r, s] of isl) {
      const a = rule(s.box);
      action.set(r, a); count[a]++;
      if (a === "rigid") {
        const tot = new Map();
        for (const i of s.verts) for (let k = 0; k < 4; k++) { const w = SW.getComponent(i, k); if (w > 0) { const b = SI.getComponent(i, k); tot.set(b, (tot.get(b) ?? 0) + w); } }
        const b = [...tot.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] ?? 0;
        for (const i of s.verts) { SI.setXYZW(i, b, 0, 0, 0); SW.setXYZW(i, 1, 0, 0, 0); }
      }
    }
    SI.needsUpdate = true; SW.needsUpdate = true;
    if (count.remove) {
      const keep = [];
      for (let t = 0; t < ix.length; t += 3) if (action.get(find(canon[ix[t]])) !== "remove") keep.push(ix[t], ix[t + 1], ix[t + 2]);
      g.setIndex(keep);
    }
    report[m.name] = count;
  }
  return report;
}
