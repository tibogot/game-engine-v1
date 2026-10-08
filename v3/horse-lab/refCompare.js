// ── Horse lab: compare with the reference game's screenshots ─────────────────
// The reference screenshots (v3/horse-lab/refs/*.png — kept OUT of git, they
// are someone else's game) were taken by an unknown camera. For each one the
// pixel positions of a few horse landmarks are written down below; the camera
// is fitted so OUR horse's landmarks land on those pixels (position, look-at,
// lens), then our rider is rendered through that camera at the screenshot's
// exact size — no squeeze — beside it and overlaid on it.
//
// The reference horse is the armored horse, ours the Quaternius one: the fit
// is good to ~20–25 px, so small differences are noise; big ones are real.
//
// rider landmarks (optional): reference joints, compared in pixels with ours.
import * as THREE from "three";

const V3 = THREE.Vector3;

export const REFS = {
  mount1: { size: [609, 496], horse: { nose: [42, 152], poll: [68, 71], tail: [446, 184], foreNear: [181, 446], hindNear: [420, 439] },
    rider: { hip: [336, 207], knee: [258, 216], ankle: [278, 300], head: [329, 107] } },   // left (near) leg raised into the iron
  mount2: { size: [551, 483], horse: { nose: [45, 150], poll: [72, 78], tail: [445, 190], foreNear: [192, 405], hindNear: [400, 393] } },   // approximate
  mount3: { size: [624, 414], horse: { nose: [45, 148], poll: [72, 45], tail: [445, 180], foreNear: [192, 378], hindNear: [402, 370] } },   // approximate
  mount4: { size: [614, 501], horse: { nose: [58, 296], poll: [76, 192], tail: [440, 214], foreNear: [186, 455], hindNear: [445, 460] } },
  mount5: { size: [591, 459], horse: { nose: [55, 270], poll: [72, 175], tail: [425, 205], foreNear: [180, 420], hindNear: [425, 425] } },   // landmarks approximate
  dismount4: { size: [486, 406], horse: { nose: [57, 160], poll: [74, 100], tail: [366, 220], foreNear: [154, 366], hindNear: [320, 394] } },   // read off a grid
  dismount5: { size: [412, 378], horse: { nose: [35, 132], poll: [46, 80], tail: [318, 166], foreNear: [134, 322], hindNear: [292, 330] } },   // approximate
  dismount6: { size: [407, 323], horse: { nose: [32, 128], poll: [62, 70], tail: [325, 140], foreNear: [158, 285], hindNear: [295, 248] } },   // approximate
  mount10: { size: [489, 388], horse: { nose: [25, 172], poll: [48, 104], tail: [348, 182], foreNear: [154, 366], hindNear: [308, 361] },
    rider: { hip: [217, 151], knee: [194, 202], ankle: [212, 265], head: [195, 45] } },
};

// The REAR (R), the horse's left side. Landmarks that stay readable while it is
// up: nose (the bit), poll, tail root, the near hind hoof (on the ground) and
// the rider's head (read by eye: ±5–10 px); fore = both front hooves, in
// either order (which is the near one is hard to tell in the air).
export const REAR_REFS = {
  rear1: { size: [581, 458], lm: { nose: [86, 198], poll: [127, 128], tail: [410, 288], hindNear: [368, 440], riderHead: [258, 100], stifle: [376, 340], hock: [422, 378] }, fore: [[115, 405], [152, 432]] },
  rear2: { size: [501, 520], lm: { nose: [128, 130], poll: [171, 83], tail: [358, 352], hindNear: [282, 496], riderHead: [282, 115], stifle: [296, 396], hock: [356, 433] }, fore: [[68, 328], [86, 290]] },
  rear3: { size: [417, 506], lm: { nose: [140, 80], poll: [184, 39], tail: [318, 332], hindNear: [236, 490], riderHead: [250, 92], stifle: [238, 352], hock: [298, 424] }, fore: [[35, 210], [78, 330]] },
  rear4: { size: [544, 523], lm: { nose: [188, 130], poll: [244, 89], tail: [428, 356], hindNear: [352, 505], riderHead: [365, 125], stifle: [356, 404], hock: [410, 454] }, fore: [[75, 285], [160, 285]] },
  rear5: { size: [531, 435], lm: { nose: [84, 75], poll: [123, 42], tail: [371, 268], hindNear: [292, 407], riderHead: [262, 30], stifle: [284, 308], hock: [363, 349] }, fore: [[57, 246], [93, 293]] },
  rear6: { size: [495, 505], lm: { nose: [175, 89], poll: [212, 48], tail: [361, 325], hindNear: [271, 494], riderHead: [283, 92], stifle: [284, 372], hock: [326, 432] }, fore: [[68, 214], [118, 332]] },
};

// Landmarks as SURFACE points of our horse's skin — the same points marked on
// the screenshots (point of the hock, front of the stifle, top of the head,
// top of the tail dock, the hoof soles). Bone joints sit inside the leg, 5–10 cm
// from those: comparing the two made a pose error out of nothing.
// The skin vertices are picked once (horse standing) and followed after that.
let SURF = null;
function pickSurface(H) {
  const c = H.ctrl, rig = H.horse.rig;
  let mesh = null; H.horse.model.traverse((o) => { if (o.isSkinnedMesh && o.visible && o.name !== "tail" && (!mesh || o.geometry.attributes.position.count > mesh.geometry.attributes.position.count)) mesh = o; });
  const g = mesh.geometry, si = g.attributes.skinIndex, sw = g.attributes.skinWeight, bones = mesh.skeleton.bones, n = g.attributes.position.count;
  const fwd = new V3(Math.sin(c.yaw), 0, Math.cos(c.yaw)), lat = new V3(Math.cos(c.yaw), 0, -Math.sin(c.yaw));
  const loc = (p) => { const q = p.clone().sub(c.pos); return { f: q.dot(fwd), y: p.y - c.y, s: q.dot(lat) }; };
  const bl = (nm) => { let b; rig.traverse((o) => { if (o.name === nm) b = o; }); return loc(b.getWorldPosition(new V3())); };
  const V = []; const top = [];
  for (let i = 0; i < n; i++) {
    const v = new V3().fromBufferAttribute(g.attributes.position, i); mesh.applyBoneTransform(i, v); v.applyMatrix4(mesh.matrixWorld);
    V.push(loc(v));
    let bi = 0, bw = 0; for (let k = 0; k < 4; k++) if (sw.getComponent(i, k) > bw) { bw = sw.getComponent(i, k); bi = si.getComponent(i, k); }
    top.push(bones[bi].name);
  }
  const pickBest = (filter, score, k = 3) => { const ids = []; for (let i = 0; i < n; i++) if (filter(V[i], top[i])) ids.push(i); ids.sort((x, y) => score(V[y]) - score(V[x])); return ids.slice(0, k); };
  const hk = bl("BackLowerLegL"), st = bl("BackUpperLegL"), hd = bl("Head"), t1 = bl("Tail1");
  const sole = (nm, side) => { const lo = Math.min(...V.filter((p, i) => top[i] === nm && Math.sign(p.s) === side).map((p) => p.y)); return pickBest((p, t) => t === nm && Math.sign(p.s) === side && p.y < lo + 0.02, () => 0, 12); };
  SURF = { mesh, ids: {
    _: 0,
    hock: pickBest((p, t) => p.s > 0 && /^Back(Lower|Upper)LegL$/.test(t) && Math.abs(p.y - hk.y) < 0.04, (p) => -p.f),
    stifle: pickBest((p, t) => p.s > 0 && /^Back(Upper)?LegL$|^BackUpperLegL$/.test(t) && Math.abs(p.y - st.y) < 0.05 && Math.abs(p.f - st.f) < 0.25, (p) => p.f),
    poll: pickBest((p, t) => t === "Head", (p) => p.y),
    nose: (() => { const b = loc(H.rider.bits[0].getWorldPosition(new V3()).add(H.rider.bits[1].getWorldPosition(new V3())).multiplyScalar(0.5)); return pickBest((p, t) => t === "Head", (p) => -Math.hypot(p.f - b.f, p.y - b.y, p.s - b.s), 4); })(),   // the mouth corner, on the skin (the bit rings do not follow a hand-turned head)
    tail: pickBest((p) => Math.abs(p.y - t1.y) < 0.06 && Math.abs(p.s) < 0.06, (p) => -p.f),   // the rump's rearmost point at the dock
    hindNear: sole("IKBackLegL", 1), foreL: sole("IKFrontLegL", 1), foreR: sole("IKFrontLegR", -1),   // (the hoof skin follows the IK bone)
  } };
  void hd;
  for (const [k, v] of Object.entries(SURF.ids)) if (Array.isArray(v) && !v.length) console.warn("[refCompare] no skin found for landmark", k);
  delete SURF.ids._;
}
function surf(H, name) {
  const { mesh, ids } = SURF, g = mesh.geometry, acc = new V3();
  for (const i of ids[name]) { const v = new V3().fromBufferAttribute(g.attributes.position, i); mesh.applyBoneTransform(i, v); acc.add(v.applyMatrix4(mesh.matrixWorld)); }
  return acc.divideScalar(ids[name].length);
}
export function rearLandmarks(H) {
  const h = H.horse, rd = H.rider;
  h.rig.updateMatrixWorld(true);
  if (!SURF || SURF.mesh.parent == null) pickSurface(H);
  return {
    nose: surf(H, "nose"),
    stifle: surf(H, "stifle"), hock: surf(H, "hock"), poll: surf(H, "poll"), tail: surf(H, "tail"), hindNear: surf(H, "hindNear"),
    riderHead: rd.B.head.getWorldPosition(new V3()),
    fore: [surf(H, "foreL"), surf(H, "foreR")],
  };
}
export const resetSurface = () => (SURF = null);

// like makeProject, but q is in the HORSE's frame (x = its left, z = forward):
// the fit's bounds then mean the same whatever way the horse faces
export function makeProjectH(H, W, Hh) {
  const p = makeProject(H, W, Hh), c = H.ctrl;
  const rot = (x, z) => [x * Math.cos(c.yaw) + z * Math.sin(c.yaw), -x * Math.sin(c.yaw) + z * Math.cos(c.yaw)];
  const set = (q) => { const [ax, az] = rot(q[0], q[2]), [bx, bz] = rot(q[3], q[5]); p.set([ax, q[1], az, bx, q[4], bz, q[6]]); };
  return { cam: p.cam, set, proj: p.proj };
}

// a camera through which the landmarks L land on the reference pixels T (+ the
// front-hoof pair) — on the horse's LEFT side, anywhere along it (refs 2–4 are
// from behind its middle), 0.5–4 m up, 2–10 m away, a normal lens
export function fitCamera(H, W, Hh, L, T, start = [4.2, 1.6, 1.0, 0, 1.2, 0, 38], fore = null) {
  const names = Object.keys(T), { set, proj } = makeProjectH(H, W, Hh);
  const err = (q) => {
    const dist = Math.hypot(q[0] - q[3], q[2] - q[5]);
    if (q[0] < 0.8 || q[1] < 1.3 || q[1] > 2.4 || dist < 2 || dist > 10 || q[6] < 25 || q[6] > 65) return 1e9;   // height 1.3–2.4 m: the refs' horizon crosses the horse at about the rider's knee (a high camera hid pose errors)
    set(q); let e = 0; for (const n of names) { const r = proj(L[n]); if (r[2] > 1) return 1e9; e += (r[0] - T[n][0]) ** 2 + (r[1] - T[n][1]) ** 2; }
    if (fore) { const a = proj(L.fore[0]), b = proj(L.fore[1]), d = (p, t) => (p[0] - t[0]) ** 2 + (p[1] - t[1]) ** 2; e += Math.min(d(a, fore[0]) + d(b, fore[1]), d(a, fore[1]) + d(b, fore[0])); }
    return e;
  };
  let best = start.slice(), be = err(best);
  for (let step = 0.8; step > 0.002; step *= 0.7) {
    let improved = true;
    while (improved) {
      improved = false;
      for (let j = 0; j < 7; j++) for (const s of [-1, 1]) {
        const q = best.slice(); q[j] += s * step * (j === 6 ? 12 : 1);
        const e = err(q); if (e < be) { be = e; best = q; improved = true; }
      }
    }
  }
  return { q: best, rms: Math.sqrt(be / (names.length + (fore ? 2 : 0))) };
}

// The animation editor's "fit view": the camera that puts our horse, as it is
// NOW, on a rear screenshot drawn over the editor's view. The editor draws the
// picture above its panel (height hv = view − panel, centred, true shape) and
// shifts the 3D view up by half the panel (setViewOffset): the reference pixels
// are mapped into that virtual full-screen frame before fitting.
// view = { W, Hh, ph } (window size, panel height). Returns the world camera.
export function rearViewFit(H, name, { W, Hh, ph }, q0 = null) {
  const ref = REAR_REFS[name], [rw, rh] = ref.size;
  const hv = Hh - ph, w = hv * rw / rh, x0 = (W - w) / 2;
  const map = ([u, v]) => [x0 + u * w / rw, v * hv / rh + ph / 2];
  const T = Object.fromEntries(Object.entries(ref.lm).filter(([k]) => k !== "riderHead").map(([k, p]) => [k, map(p)]));
  const L = rearLandmarks(H);
  const f = [q0, [4.2, 1.6, 1.0, 0, 1.2, 0, 38], [3.0, 1.2, 2.5, 0, 1.4, 0, 40], [6.0, 2.2, 3.0, 0, 1.3, 0, 32], [4.5, 1.0, 0.3, 0, 1.6, 0, 45], [3.0, 2.5, -1.0, 0, 1.3, 0, 40]]
    .filter(Boolean).map((s) => fitCamera(H, W, Hh, L, T, s, ref.fore?.map(map))).sort((a, b) => a.rms - b.rms)[0];
  const c = H.ctrl, cy = Math.cos(c.yaw), sy = Math.sin(c.yaw);
  const at = (x, y, z) => new V3(c.pos.x + x * cy + z * sy, c.y + y, c.pos.z - x * sy + z * cy);
  return { pos: at(f.q[0], f.q[1], f.q[2]), look: at(f.q[3], f.q[4], f.q[5]), fov: f.q[6], q: f.q, rms: f.rms * rh / hv };   // rms in the screenshot's pixels
}

// Our rear beside each reference, overlaid (50 %), through the camera fitted to
// the landmarks. The moment in our rear is FOUND too: the rear is stepped at a
// fixed 1/60 s and the best-fitting frame between t0 and t1 kept — so a pose
// difference shows as a big fit error / a visible ghost, not as a camera guess.
// names: which refs; opts.times: [t0, t1, step] in s.
export async function compareRear(H, names = Object.keys(REAR_REFS), opts = {}) {
  const { times = [0.1, 2.0, 0.05], scale = 0.75 } = opts;
  const c = H.ctrl, rd = H.rider, R0 = H.renderer, D = H.D;
  const DT = 1 / 60, idle = { fwd: 0, turn: 0, run: false };
  const raf = () => new Promise((r) => requestAnimationFrame(r));
  const restart = () => {
    if (c.oneShot) c.endOneShot(); c.idleT = -1e9; c.refusing = false; c.v = 0;
    // let any earlier rear finish completely (gather + rise + hold + fall + settle ≈ 3.2 s):
    // startRear() refuses while one is running — the comparison then measured a horse standing
    for (let i = 0; i < 600 && (c.rearT >= 0 || c.rearA > 0); i++) { c.update(DT, idle); rd.update(DT, {}); }
    for (let i = 0; i < 60; i++) { c.update(DT, idle); rd.update(DT, {}); }
    c.startRear();
    if (!(c.rearT >= 0)) throw new Error("compareRear: the rear did not start");
  };
  D.auditing = true;                                          // the page loop leaves the horse to us
  const rows = [], out = [];
  try {
    for (const name of names) {
      const ref = REAR_REFS[name], [W, Hh] = ref.size;
      // 1. the best moment: step the rear, fit a camera at each sample time
      restart();
      let t = 0, best = null, q0;
      for (let ts = times[0]; ts <= times[1] + 1e-6; ts += times[2]) {
        while (t < ts - 1e-6) { c.update(DT, idle); rd.update(DT, {}); t += DT; }
        const L = rearLandmarks(H), T = opts.rider ? ref.lm : Object.fromEntries(Object.entries(ref.lm).filter(([k]) => k !== "riderHead"));   // (the horse alone by default: our rider does not lean like theirs yet)
        // several starts (left-front near / far, low / high, and the last fit): one start alone stuck in a local minimum
        const f = [q0, [4.2, 1.6, 1.0, 0, 1.2, 0, 38], [3.0, 1.2, 2.5, 0, 1.4, 0, 40], [6.0, 2.2, 3.0, 0, 1.3, 0, 32], [4.5, 1.0, 0.3, 0, 1.6, 0, 45]].filter(Boolean)
          .map((s) => fitCamera(H, W, Hh, L, T, s, ref.fore)).sort((a, b) => a.rms - b.rms)[0];
        q0 = f.q;                                             // warm start: the camera barely moves between samples
        if (opts.trace) (out.trace ??= {})[name] = [...(out.trace?.[name] ?? []), `${ts.toFixed(2)}:${f.rms.toFixed(0)}`];
        if (!best || f.rms < best.rms) best = { ...f, t: ts };
      }
      // 2. replay to that moment and render through its camera
      restart(); t = 0;
      while (t < best.t - 1e-6) { c.update(DT, idle); rd.update(DT, {}); t += DT; }
      const { cam, set } = makeProjectH(H, W, Hh);
      for (let r = 0; r < 2; r++) { await raf(); R0.setSize(W, Hh, false); set(best.q); R0.render(H.scene, cam); }
      const shot = document.createElement("canvas"); shot.width = W; shot.height = Hh;
      shot.getContext("2d").drawImage(R0.domElement, 0, 0, W, Hh);
      const im = new Image(); im.src = `/v3/horse-lab/refs/${name}.png`; await im.decode();
      rows.push({ im, shot, W, Hh, label: `${name} — our rear at ${best.t.toFixed(2)} s, pitch ${(c.rearPitch * 57.3).toFixed(0)}°`, rms: best.rms });
      // per landmark: ours − theirs in px (+x right, +y down) through the fitted camera
      const P = makeProjectH(H, W, Hh); P.set(best.q); const Lb = rearLandmarks(H);
      const off = Object.fromEntries(Object.entries(ref.lm).map(([k, p]) => { const r = P.proj(Lb[k]); return [k, [Math.round(r[0] - p[0]), Math.round(r[1] - p[1])]]; }));
      out.push({ name, t: +best.t.toFixed(2), fitRmsPx: +best.rms.toFixed(1), pitchDeg: Math.round(c.rearPitch * 57.3), off, cam: best.q.map((v) => +v.toFixed(2)) });
    }
  } finally {
    D.auditing = false;
    R0.setSize(innerWidth, innerHeight, true);
  }
  // sheet: reference | ours | overlay, each picture at its true aspect
  const colW = Math.max(...rows.map((r) => r.W)) * scale;
  const sheet = document.createElement("canvas");
  sheet.width = colW * 3; sheet.height = rows.reduce((s, r) => s + r.Hh * scale, 0);
  const g = sheet.getContext("2d");
  let y = 0;
  for (const r of rows) {
    const w = r.W * scale, h = r.Hh * scale;
    g.drawImage(r.im, 0, y, w, h);
    g.drawImage(r.shot, colW, y, w, h);
    g.drawImage(r.shot, colW * 2, y, w, h); g.globalAlpha = 0.5; g.drawImage(r.im, colW * 2, y, w, h); g.globalAlpha = 1;
    g.fillStyle = "#000"; g.font = "bold 14px sans-serif";
    g.fillText("reference", 6, y + 16); g.fillText(r.label, colW + 6, y + 16); g.fillText(`overlay (fit ±${r.rms.toFixed(0)} px)`, colW * 2 + 6, y + 16);
    y += h;
  }
  return { results: out, trace: out.trace, sheet: sheet.toDataURL("image/png") };
}

function horseLandmarks(H) {
  const h = H.horse, c = H.ctrl, rd = H.rider;
  const bone = (n) => { let b; h.rig.traverse((o) => { if (o.name === n) b = o; }); return b.getWorldPosition(new V3()); };
  h.rig.updateMatrixWorld(true);
  return {
    nose: rd.bits[0].getWorldPosition(new V3()).add(rd.bits[1].getWorldPosition(new V3())).multiplyScalar(0.5),
    poll: bone("Head"), tail: bone("Tail1"),
    foreNear: bone("FFL").setY(c.y), hindNear: bone("FFBL").setY(c.y),
  };
}

// q = [camera offset x y z, look-at offset x y z, fov] relative to the horse
function makeProject(H, W, Hh) {
  const cam = new THREE.PerspectiveCamera(30, W / Hh, 0.05, 500), c = H.ctrl;
  const set = (q) => { cam.fov = q[6]; cam.aspect = W / Hh; cam.position.set(c.pos.x + q[0], c.y + q[1], c.pos.z + q[2]); cam.lookAt(c.pos.x + q[3], c.y + q[4], c.pos.z + q[5]); cam.updateProjectionMatrix(); cam.updateMatrixWorld(); };
  const proj = (p) => { const v = p.clone().project(cam); return [(v.x + 1) / 2 * W, (1 - v.y) / 2 * Hh, v.z]; };
  return { cam, set, proj };
}

export function fitRefCamera(H, name) {
  const ref = REFS[name], [W, Hh] = ref.size;
  const key = `${H.horse.height}`;
  if (ref._q?.[key]) return ref._q[key];   // (cached per horse height)
  const L = horseLandmarks(H), names = Object.keys(ref.horse);
  const { set, proj } = makeProject(H, W, Hh);
  // a game camera: above the ground, a normal lens (a planar set of points also fits a camera under the floor)
  const err = (q) => { if (q[1] < 0.6 || q[6] < 25 || q[6] > 65) return 1e9; set(q); let e = 0; for (const n of names) { const r = proj(L[n]); if (r[2] > 1) return 1e9; e += (r[0] - ref.horse[n][0]) ** 2 + (r[1] - ref.horse[n][1]) ** 2; } return e; };
  let best = [3.6, 1.3, 0.6, 0.2, 0.8, 0, 30], be = err(best);
  // deterministic search: shrinking coordinate steps (reproducible fits)
  for (let step = 0.8; step > 0.002; step *= 0.7) {
    let improved = true;
    while (improved) {
      improved = false;
      for (let j = 0; j < 7; j++) for (const s of [-1, 1]) {
        const q = best.slice(); q[j] += s * step * (j === 6 ? 12 : 1);
        if (j === 6) q[6] = Math.max(8, Math.min(90, q[6]));
        const e = err(q); if (e < be) { be = e; best = q; improved = true; }
      }
    }
  }
  (ref._q ??= {})[key] = best;
  ref._rms = Math.sqrt(be / names.length);
  return best;
}

// pairs: [[refName, clip, frame], …]; clip "ride:idle" etc. holds a riding posture.
export async function compareRefs(H, pairs, { scale = 0.6 } = {}) {
  const E = H.editor, R0 = H.renderer, rd = H.rider;
  const out = [];
  const rows = [];
  for (const [name, clip, frame] of pairs) {
    const ref = REFS[name], [W, Hh] = ref.size, q = fitRefCamera(H, name);
    const im = new Image(); im.src = `/v3/horse-lab/refs/${name}.png`; await im.decode();
    E.open(clip);
    if (!clip.startsWith("ride:")) E.setT(frame / 60);
    E.playing = false;
    const { cam, set, proj } = makeProject(H, W, Hh);
    const helpers = [...Object.values(E.handles), ...Object.values(E.paths), E.tc.getHelper(), ...E.kneeArrows];
    for (let r = 0; r < 3; r++) {
      await new Promise((rr) => requestAnimationFrame(rr));
      R0.setSize(W, Hh, false); for (const h of helpers) h.visible = false; set(q); R0.render(H.scene, cam);
    }
    const shot = document.createElement("canvas"); shot.width = R0.domElement.width; shot.height = R0.domElement.height;
    shot.getContext("2d").drawImage(R0.domElement, 0, 0);
    // joints in pixels
    let joints = null;
    if (ref.rider) {
      const g = rd.B.legs[0], w = (b) => b.getWorldPosition(new V3());
      const ours = { hip: w(g.u), knee: w(g.l), ankle: w(g.tip), head: w(rd.B.head) };
      joints = {};
      for (const [k, p] of Object.entries(ref.rider)) { const r = proj(ours[k]); joints[k] = { ours: [Math.round(r[0]), Math.round(r[1])], ref: p, dx: Math.round(r[0] - p[0]), dy: Math.round(r[1] - p[1]) }; }
    }
    rows.push({ im, shot, W, Hh, label: `${name} | ${clip}${clip.startsWith("ride:") ? "" : " f" + frame}`, rms: ref._rms });
    out.push({ name, clip, frame, fitRmsPx: +ref._rms.toFixed(1), joints });
  }
  R0.setSize(innerWidth, innerHeight, true);
  E.tc.getHelper().visible = true; E.close();
  // sheet: reference | ours | overlay, one row each, every image at its own true aspect
  const colW = Math.max(...rows.map((r) => r.W)) * scale;
  const sheet = document.createElement("canvas");
  sheet.width = colW * 3; sheet.height = rows.reduce((s, r) => s + r.Hh * scale, 0);
  const g = sheet.getContext("2d");
  let y = 0;
  for (const r of rows) {
    const w = r.W * scale, h = r.Hh * scale;
    g.drawImage(r.im, 0, y, w, h);
    g.drawImage(r.shot, colW, y, w, h);
    g.drawImage(r.shot, colW * 2, y, w, h); g.globalAlpha = 0.5; g.drawImage(r.im, colW * 2, y, w, h); g.globalAlpha = 1;
    g.fillStyle = "#000"; g.font = "14px sans-serif";
    g.fillText("reference", 6, y + 16); g.fillText(`ours — ${r.label}`, colW + 6, y + 16); g.fillText(`overlay (fit ±${r.rms.toFixed(0)} px)`, colW * 2 + 6, y + 16);
    y += h;
  }
  document.getElementById("sheet")?.remove();
  const img = document.createElement("img"); img.id = "sheet"; img.src = sheet.toDataURL();
  img.style.cssText = "position:fixed;left:0;top:0;z-index:50;max-width:100vw;max-height:100vh;background:#888";
  img.onclick = () => img.remove();
  document.body.appendChild(img);
  return out;
}

// One pose, big, for review: the reference screenshot (left) beside ours
// (right), same picture size, through a hand-set camera (offset from the horse,
// look-at offset, lens). Stays on screen until clicked.
export const POSE_CAMS = {
  dismount4: { pos: [2.52, 2.89, -0.88], look: [0, 1.36, -0.07], fov: 45 },   // fitted (azimuth 108°, elevation 30°, 3.1 m), rms 18 px
  dismount5: { pos: [2.93, 2.66, -0.53], look: [0, 1.13, -0.02], fov: 45 },   // fitted, rms 14 px
  dismount6: { pos: [3.9, 2.3, 0.6], look: [0, 0.95, -0.1], fov: 40 },   // set by hand (the landmark fit went too close)
  mount2: { pos: [2.5, 1.45, -1.9], look: [0.05, 0.85, 0.2], fov: 46 },   // set by hand: behind his back, close, eye about at the horse's back
  behindLeft: { pos: [0.75, 1.95, -3.0], look: [0.35, 1.05, 0.3], fov: 42 },   // mountB1–B3 (behind the horse, a little to its left)
  frontLeft: { pos: [4.3, 2.5, 1.3], look: [0.2, 1.05, -0.25], fov: 38 },   // dismount4 / dismount5
  side: { pos: [-4.6, 1.75, 0.6], look: [0, 1.05, 0.15], fov: 40 },   // the horse's right side, facing right in the picture (idleSide)
  behind: { pos: [0.2, 2.75, -3.9], look: [0, 1.4, 0], fov: 40 },   // matched to dismountB1–B3
};
export async function showPose(H, ref, clip, frame, camName = "behind", label = "") {
  const E = H.editor, c = H.ctrl, R0 = H.renderer;
  // "fit": the camera fitted to the screenshot's horse landmarks (REFS)
  let C = POSE_CAMS[camName];
  if (camName === "fit") { const q = fitRefCamera(H, ref); C = { pos: q.slice(0, 3), look: q.slice(3, 6), fov: q[6] }; }
  const im = new Image(); im.src = `/v3/horse-lab/refs/${ref}.png`; await im.decode();
  const Hh = Math.min(innerHeight - 20, 760), W = Math.round(Hh * im.width / im.height);
  E.open(clip); E.playing = false;
  if (!clip.startsWith("ride:")) {
    // play up to the frame at 60 fps (as the game does): released irons fall, smoothing settles
    const ms = H.rider.mountSys; ms.groundW = null; ms.ironW = null; ms.ikIronW = null; ms.polePrev = null; ms.armPolePrev = null; ms.tgtPrev = null; ms.poleTurn = null;
    for (let i = 0; i <= frame; i++) { ms.edit = { clip, t: i / 60, playing: i > 0 }; H.rider.update(i ? 1 / 60 : 0, {}); }
    E.setT(frame / 60);
  }
  const cam = new THREE.PerspectiveCamera(C.fov, W / Hh, 0.05, 500);
  const helpers = [...Object.values(E.handles), ...Object.values(E.paths), E.tc.getHelper(), ...E.kneeArrows];
  H.D.paused = true;   // hold the stepped state while rendering
  for (let r = 0; r < 3; r++) {
    await new Promise((rr) => requestAnimationFrame(rr));
    R0.setSize(W, Hh, false); for (const h of helpers) h.visible = false;
    // offsets are in the HORSE's frame (x = its left, z = forward): turn them with it
    const cy = Math.cos(c.yaw), sy = Math.sin(c.yaw), rot = (v) => [v[0] * cy + v[2] * sy, v[1], -v[0] * sy + v[2] * cy];
    const cp = rot(C.pos), cl = rot(C.look);
    cam.position.set(c.pos.x + cp[0], c.y + cp[1], c.pos.z + cp[2]); cam.lookAt(c.pos.x + cl[0], c.y + cl[1], c.pos.z + cl[2]); cam.updateMatrixWorld();
    R0.render(H.scene, cam);
  }
  const sheet = document.createElement("canvas"); sheet.width = W * 2 + 10; sheet.height = Hh;
  const g = sheet.getContext("2d"); g.fillStyle = "#222"; g.fillRect(0, 0, sheet.width, Hh);
  g.drawImage(im, 0, 0, W, Hh); g.drawImage(R0.domElement, W + 10, 0, W, Hh);
  g.fillStyle = "#fff"; g.font = "bold 20px sans-serif";
  g.fillText("REFERENCE", 10, 28); g.fillText(`OURS  ${label}`, W + 20, 28);
  H.D.paused = false;
  R0.setSize(innerWidth, innerHeight, true); E.tc.getHelper().visible = true; E.close();
  document.getElementById("sheet")?.remove();
  const img = document.createElement("img"); img.id = "sheet"; img.src = sheet.toDataURL();
  img.style.cssText = "position:fixed;left:50%;top:10px;transform:translateX(-50%);z-index:50;max-width:98vw;max-height:96vh;border:2px solid #fff";
  img.title = "click to close"; img.onclick = () => img.remove();
  document.body.appendChild(img);
}
