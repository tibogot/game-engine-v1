// ── Horse lab: measure a pose against the reference screenshots ──────────────
// The reference game uses the SAME armoured horse and the same robot, so the
// horse's outline in a screenshot can be compared with ours pixel for pixel:
//   refMask(name)        the horse cut out of the screenshot by colour (dark
//                        red-brown body, black tail — not the yellow robot, the
//                        orange fence, the white / grey floor, the green arch)
//   ourMask(H, cam, W,h) our horse alone, white on black, through a camera
//   score(a, b)          overlap (IoU) + a diff picture: red = only in the
//                        reference, blue = only ours, grey = both
//   anatomy(H)           the leg joints' angles, and what is unnatural
// Used by the rear matcher (rearMatch) to tune the rear by NUMBERS, not by eye.
import * as THREE from "three";

const V3 = THREE.Vector3;
const cache = new Map();

function hsv(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d > 1e-6) h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(h * 60 + 360) % 360, mx > 0 ? d / mx : 0, mx];
}
// the armoured horse's coat, its leather, the black tail / mane / hooves
export function isHorse(r, g, b) {
  const [h, s, v] = hsv(r / 255, g / 255, b / 255);
  if (v < 0.2) return true;                                   // black: tail, hooves, plates in shade
  if (s > 0.75 && v > 0.85) return false;                     // the red circle drawn on the screenshot (no coat is that bright)
  // the coat is red-brown, hue 5–20° (measured); the fence / posts are orange
  // wood, hue 31–35° even in shade — the cut is at 26°
  const coat = h < 26 || h > 335;
  return coat && s > 0.25 && v < 0.85;                         // (lit coat reaches ~0.8; the circle is ≥ 0.9)
}

export async function refMask(name) {
  if (cache.has(name)) return cache.get(name);
  const im = new Image(); im.src = `/v3/horse-lab/refs/${name}.png`; await im.decode();
  const W = im.naturalWidth, Hh = im.naturalHeight;
  const cv = document.createElement("canvas"); cv.width = W; cv.height = Hh;
  const g = cv.getContext("2d", { willReadFrequently: true }); g.drawImage(im, 0, 0);
  const px = g.getImageData(0, 0, W, Hh).data, m = new Uint8Array(W * Hh);
  for (let i = 0; i < W * Hh; i++) m[i] = isHorse(px[i * 4], px[i * 4 + 1], px[i * 4 + 2]) ? 1 : 0;
  const out = { W, Hh, m: largest(clean(m, W, Hh), W, Hh), im };
  cache.set(name, out);
  return out;
}
// the big connected pieces only (specks of other dark-brown things drop out)
function largest(m, W, Hh) {
  const lab = new Int32Array(W * Hh), st = [], sizes = [0];
  let best = 0, bestN = 0, n = 0;
  for (let i = 0; i < W * Hh; i++) {
    if (!m[i] || lab[i]) continue;
    n++; let cnt = 0; st.push(i); lab[i] = n;
    while (st.length) {
      const j = st.pop(); cnt++;
      const x = j % W, y = (j - x) / W;
      for (const k of [x > 0 ? j - 1 : -1, x < W - 1 ? j + 1 : -1, y > 0 ? j - W : -1, y < Hh - 1 ? j + W : -1]) if (k >= 0 && m[k] && !lab[k]) { lab[k] = n; st.push(k); }
    }
    sizes[n] = cnt;
    if (cnt > bestN) { bestN = cnt; best = n; }
  }
  // every piece at least 3 % of the biggest: the robot and the reins cut the horse into pieces
  const o = new Uint8Array(W * Hh);
  for (let i = 0; i < W * Hh; i++) o[i] = lab[i] && sizes[lab[i]] >= bestN * 0.03 ? 1 : 0;
  return o;
}
// drop specks: keep a pixel if most of its 5×5 block agrees (an opening, cheaply)
function clean(m, W, Hh) {
  const o = new Uint8Array(W * Hh);
  for (let y = 2; y < Hh - 2; y++) for (let x = 2; x < W - 2; x++) {
    let s = 0;
    for (let j = -2; j <= 2; j++) for (let i = -2; i <= 2; i++) s += m[(y + j) * W + x + i];
    o[y * W + x] = s >= 13 ? 1 : 0;
  }
  return o;
}

// Our horse alone (no rider, no world), white on black, through cam at W×Hh.
export async function ourMask(H, cam, W, Hh) {
  const R = H.renderer, scene = H.scene, horse = H.horse.model, riderRoot = H.rider.r.rig;
  const keep = new Set(), occl = new Set();
  horse.traverse((o) => keep.add(o));
  riderRoot.traverse((o) => occl.add(o));
  for (let p = horse; p; p = p.parent) keep.add(p);
  for (let p = riderRoot; p; p = p.parent) keep.add(p);
  const hidden = [], mats = [];
  white ??= new THREE.MeshBasicMaterial({ color: 0xffffff }); black ??= new THREE.MeshBasicMaterial({ color: 0x000000 });
  scene.traverse((o) => {
    if (!(o.isMesh || o.isLine || o.isPoints || o.isSprite) || !o.visible) return;
    if (occl.has(o) && o.isMesh) { mats.push([o, o.material]); o.material = black; }   // the rider: an occluder
    else if (keep.has(o) && o.isMesh) { mats.push([o, o.material]); o.material = white; }
    else { hidden.push(o); o.visible = false; }
  });
  const bg = scene.background, fog = scene.fog;
  scene.background = new THREE.Color(0x000000); scene.fog = null;
  if (!rt || rt.width !== W || rt.height !== Hh) { rt?.dispose(); rt = new THREE.RenderTarget(W, Hh); }
  const prev = R.getRenderTarget();
  R.setRenderTarget(rt); R.render(scene, cam); R.setRenderTarget(prev);
  for (const o of hidden) o.visible = true;
  for (const [o, mt] of mats) o.material = mt;
  scene.background = bg; scene.fog = fog;
  const px = await R.readRenderTargetPixelsAsync(rt, 0, 0, W, Hh);
  // (rows may be padded to 256 bytes on WebGPU)
  const row = px.length >= W * Hh * 4 + 1 ? Math.ceil(W * 4 / 256) * 256 : W * 4, m = new Uint8Array(W * Hh);   // (WebGPU pads each row to 256 bytes; the last one is not)
  for (let y = 0; y < Hh; y++) for (let x = 0; x < W; x++) m[y * W + x] = px[y * row + x * 4] > 64 ? 1 : 0;
  return { W, Hh, m };
}
let rt = null, white = null, black = null;
export const __RT = THREE.RenderTarget;   // (debug scripts)

// overlap + a picture of the difference
export function score(ref, ours, { picture = false } = {}) {
  const { W, Hh } = ref;
  let both = 0, refOnly = 0, ourOnly = 0;
  const img = picture ? new ImageData(W, Hh) : null;
  for (let i = 0; i < W * Hh; i++) {
    const a = ref.m[i], b = ours.m[i];
    if (a && b) both++; else if (a) refOnly++; else if (b) ourOnly++;
    if (img) {
      const c = a && b ? [150, 150, 150] : a ? [235, 60, 50] : b ? [60, 120, 240] : [20, 22, 26];
      img.data.set([c[0], c[1], c[2], 255], i * 4);
    }
  }
  return { iou: both / Math.max(1, both + refOnly + ourOnly), refOnly, ourOnly, both, img };
}

// ── anatomy: the leg joints, in the horse's side plane ───────────────────────
// Angles at each joint (180° = straight). A horse's hind leg zig-zags: the
// stifle points FORWARD, the hock BACKWARD; the gaskin (stifle → hock) always
// slopes down-and-back, never flat; the front knee only bends backward.
// Rearing, the reference's hind leg measures gaskin ~62°, hock ~103°, cannon
// ~49° forward (refs/rear3) — the limits below allow that, not a flat gaskin.
export function anatomy(H) {
  const rig = H.horse.rig, c = H.ctrl;
  rig.updateMatrixWorld(true);
  const P = (n) => { let b; rig.traverse((o) => { if (o.name === n) b = o; }); return b.getWorldPosition(new V3()); };
  const fwd = new V3(Math.sin(c.yaw), 0, Math.cos(c.yaw));
  // into the side plane: x = forward, y = up
  const s = (p) => [p.clone().sub(c.pos).dot(fwd), p.y - c.y];
  const ang = (a, b, d) => { const u = [a[0] - b[0], a[1] - b[1]], v = [d[0] - b[0], d[1] - b[1]]; return Math.acos(Math.max(-1, Math.min(1, (u[0] * v[0] + u[1] * v[1]) / Math.hypot(...u) / Math.hypot(...v)))) * 57.3; };
  const out = { legs: {}, flags: [] };
  for (const side of ["L", "R"]) {
    const hip = s(P(`BackLeg${side}`)), st = s(P(`BackUpperLeg${side}`)), hk = s(P(`BackLowerLeg${side}`)), hf = s(P(`IKBackLeg${side}`));
    const gaskinSlope = Math.atan2(st[1] - hk[1], st[0] - hk[0]) * 57.3;     // stifle above-and-ahead of the hock: + (≈ 30–80°)
    const cannonTilt = Math.atan2(hf[0] - hk[0], hk[1] - hf[1]) * 57.3;      // hoof ahead of the hock: + (≈ −10 … +25°)
    const hockBack = (hk[0] - (st[0] + (hf[0] - st[0]) * (st[1] - hk[1]) / Math.max(1e-3, st[1] - hf[1])));   // hock behind the stifle→hoof line: < 0
    const L = { stifle: Math.round(ang(hip, st, hk)), hock: Math.round(ang(st, hk, hf)), gaskinSlope: Math.round(gaskinSlope), cannonTilt: Math.round(cannonTilt), hockBehindCm: Math.round(-hockBack * 100) };
    out.legs[`hind${side}`] = L;
    if (L.gaskinSlope < 25) out.flags.push(`hind ${side}: gaskin ${L.gaskinSlope}° — near flat (natural ≥ 30°)`);
    if (L.hock < 70) out.flags.push(`hind ${side}: hock folded to ${L.hock}° (natural ≥ 70°)`);
    if (L.cannonTilt > 58) out.flags.push(`hind ${side}: cannon tilted ${L.cannonTilt}° forward (the reference rears at ~49°)`);
    if (L.cannonTilt < -20) out.flags.push(`hind ${side}: cannon tilted ${-L.cannonTilt}° back`);
    if (L.hockBehindCm < 0) out.flags.push(`hind ${side}: hock IN FRONT of the stifle→hoof line (bends the wrong way)`);
    const sh = s(P(`FrontUpperLeg${side}`)), kn = s(P(`FrontLowerLeg${side}`)), ff = s(P(`IKFrontLeg${side}`));
    const knee = ang(sh, kn, ff), kneeFwd = (ff[0] - kn[0]) * (sh[1] - kn[1]) - 0;   // (kept simple: the angle)
    out.legs[`front${side}`] = { knee: Math.round(knee) };
    void kneeFwd;
  }
  return out;
}

// ── the rear against the screenshots ──────────────────────────────────────
import { REAR_REFS, rearLandmarks, fitCamera, makeProjectH } from "./refCompare.js";

const DT = 1 / 60, IDLE = { fwd: 0, turn: 0, run: false };
const step = (H, n = 1) => { for (let i = 0; i < n; i++) { H.ctrl.update(DT, IDLE); H.rider.update(DT, { lookYaw: 0, input: {} }); } };
function restartRear(H) {
  const c = H.ctrl;
  if (c.oneShot) c.endOneShot(); c.refusing = false; c.v = 0; c.idleT = -1e9;
  for (let i = 0; i < 600 && (c.rearT >= 0 || c.rearA > 0); i++) step(H);   // an earlier rear runs out (startRear refuses meanwhile)
  step(H, 20);
  c.startRear();
  if (!(c.rearT >= 0)) throw new Error("the rear did not start");
}
// the horse exactly t s into a rear (a fresh one, stepped at 1/60 s)
export function rearAt(H, t) { restartRear(H); for (let s = 0; s < t - 1e-6; s += DT) step(H); }

const STARTS = [[4.2, 1.6, 1.0, 0, 1.2, 0, 38], [3.0, 1.5, 2.5, 0, 1.4, 0, 40], [6.0, 2.2, 3.0, 0, 1.3, 0, 32], [4.5, 1.4, 0.3, 0, 1.6, 0, 45], [3.0, 2.2, -1.0, 0, 1.3, 0, 40]];   // (inside fitCamera's 1.3–2.4 m height)
const camFor = (H, W, Hh, q) => { const p = makeProjectH(H, W, Hh); p.set(q); return p.cam; };

// One screenshot: the moment of our rear and the camera that match it best,
// by silhouette overlap (IoU). Landmarks give a first camera at each moment;
// the best moments are then refined by overlap (camera + time).
export async function matchOne(H, name, { t0 = 0.1, t1 = 2.0, dt = 0.1, picture = false } = {}) {
  const ref = REAR_REFS[name], mask = await refMask(name), { W, Hh } = mask;
  const T = Object.fromEntries(Object.entries(ref.lm).filter(([k]) => k !== "riderHead"));
  const iouAt = async (q) => score(mask, await ourMask(H, camFor(H, W, Hh, q), W, Hh)).iou;
  // 1. every moment: a landmark camera, then its overlap
  restartRear(H);
  let t = 0, q0 = null;
  const cands = [];
  for (let ts = t0; ts <= t1 + 1e-6; ts += dt) {
    while (t < ts - 1e-6) { step(H); t += DT; }
    const L = rearLandmarks(H);
    const f = [q0, ...STARTS].filter(Boolean).map((s) => fitCamera(H, W, Hh, L, T, s, ref.fore)).sort((a, b) => a.rms - b.rms)[0];
    q0 = f.q;
    cands.push({ t: ts, q: f.q, iou: await iouAt(f.q) });
  }
  cands.sort((a, b) => b.iou - a.iou);
  // 2. the best moment: refine the camera by overlap (shrinking steps), then the time around it
  let best = cands[0];
  rearAt(H, best.t);
  const steps = [0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 6];
  for (const k of [1, 0.5, 0.25, 0.12]) {
    for (let j = 0; j < 7; j++) for (const s of [-1, 1]) {
      const q = best.q.slice(); q[j] += s * steps[j] * k;
      const v = await iouAt(q); if (v > best.iou) best = { ...best, q, iou: v };
    }
  }
  for (const dtt of [-0.1, -0.05, 0.05, 0.1]) {
    const tt = best.t + dtt; if (tt < t0 || tt > t1) continue;
    rearAt(H, tt);
    const v = await iouAt(best.q); if (v > best.iou) best = { ...best, t: tt, iou: v };
  }
  rearAt(H, best.t);
  const out = { name, t: +best.t.toFixed(2), iou: +best.iou.toFixed(3), pitch: Math.round(H.ctrl.rearPitch * 57.3), anatomy: anatomy(H), q: best.q };
  if (picture) {
    const ours = await ourMask(H, camFor(H, W, Hh, best.q), W, Hh);
    out.diff = score(mask, ours, { picture: true }).img; out.mask = mask;
    // and the real render through that camera (horse + rider, as the game shows it)
    const R = H.renderer, cam = camFor(H, W, Hh, best.q);
    const size = R.getSize(new THREE.Vector2());
    R.setSize(W, Hh, false); R.render(H.scene, cam);
    const cv = document.createElement("canvas"); cv.width = W; cv.height = Hh;
    cv.getContext("2d").drawImage(R.domElement, 0, 0, W, Hh);
    R.setSize(size.x, size.y, true);
    out.render = cv;
  }
  return out;
}

// All the screenshots: score + a sheet (reference | ours | difference).
export async function matchRear(H, names = Object.keys(REAR_REFS), opts = {}) {
  const D = H.D; D.auditing = true;                          // the page loop leaves the horse to us
  const res = [];
  try { for (const n of names) res.push(await matchOne(H, n, opts)); }
  finally { D.auditing = false; }
  if (!opts.picture) return { results: res, mean: +(res.reduce((s, r) => s + r.iou, 0) / res.length).toFixed(3) };
  const RH = 300, colW = Math.max(...res.map((r) => Math.round(RH * r.mask.W / r.mask.Hh)));
  const sheet = document.createElement("canvas"); sheet.width = colW * 3; sheet.height = RH * res.length;
  const g = sheet.getContext("2d");
  res.forEach((r, k) => {
    const w = Math.round(RH * r.mask.W / r.mask.Hh), y = k * RH;
    g.drawImage(r.mask.im, 0, y, w, RH);
    g.drawImage(r.render, colW, y, w, RH);
    const c = document.createElement("canvas"); c.width = r.mask.W; c.height = r.mask.Hh; c.getContext("2d").putImageData(r.diff, 0, 0);
    g.drawImage(c, colW * 2, y, w, RH);
    g.fillStyle = "#fff"; g.font = "bold 14px sans-serif";
    g.fillText(`${r.name}`, 6, y + 16);
    g.fillText(`ours ${r.t}s ${r.pitch}°`, colW + 6, y + 16);
    g.fillText(`overlap ${(r.iou * 100).toFixed(1)} %  red=ref only  blue=ours only`, colW * 2 + 6, y + 16);
    g.fillStyle = "#ffd36b"; g.font = "12px sans-serif";
    r.anatomy.flags.slice(0, 3).forEach((f, i) => g.fillText(f, colW * 2 + 6, y + 34 + i * 15));
  });
  for (const r of res) { delete r.diff; delete r.render; delete r.mask; }
  return { results: res, mean: +(res.reduce((s, r) => s + r.iou, 0) / res.length).toFixed(3), sheet: sheet.toDataURL("image/png") };
}

// ── tuning the rear's settings against the screenshots ────────────────────
// Score = mean overlap over the screenshots − 0.03 per anatomy flag at the
// matched moments (an unnatural pose cannot win). Each screenshot keeps its
// camera while the settings move (the moment is searched again nearby);
// cameras are re-fitted between rounds. Coordinate search, shrinking steps.
export const REAR_TUNE = {
  rearAngle: [0.7, 1.25, 0.08], rearHip: [0.7, 0.95, 0.04], rearCannon: [0, 0.4, 0.06], rearHipFwd: [-0.35, 0.05, 0.05],
  rearArch: [0, 1.2, 0.12], rearHeadFlex: [0, 1.1, 0.1], rearReach: [0.4, 2.6, 0.25], rearKnee: [0.4, 2.0, 0.2],
};
async function evalSet(H, fixed) {
  let s = 0, flags = 0;
  const per = [];
  for (const f of fixed) {
    const { W, Hh } = f.mask;
    let best = { iou: -1, t: f.t };
    restartRear(H);
    let t = 0;
    for (const ts of [f.t - 0.15, f.t - 0.075, f.t, f.t + 0.075, f.t + 0.15]) {
      if (ts < 0.05) continue;
      while (t < ts - 1e-6) { step(H); t += DT; }
      const v = score(f.mask, await ourMask(H, camFor(H, W, Hh, f.q), W, Hh)).iou;
      if (v > best.iou) best = { iou: v, t: ts, nflags: anatomy(H).flags.length };
    }
    f.tNew = best.t; s += best.iou; flags += best.nflags; per.push(+best.iou.toFixed(3));
  }
  return { score: s / fixed.length - 0.03 * flags, mean: s / fixed.length, flags, per };
}
export async function tuneRear(H, { names = Object.keys(REAR_REFS), rounds = 2, keys = Object.keys(REAR_TUNE), log = () => {} } = {}) {
  const HP = H.HP, D = H.D;
  D.auditing = true;
  try {
    let fixed = [];
    const refit = async () => {
      fixed = [];
      for (const n of names) { const r = await matchOne(H, n, { picture: false }); fixed.push({ name: n, t: r.t, q: r.q, mask: await refMask(n) }); }
    };
    await refit();
    let cur = await evalSet(H, fixed);
    log(`start: score ${cur.score.toFixed(3)} overlap ${cur.mean.toFixed(3)} flags ${cur.flags} ${cur.per}`);
    for (let round = 0; round < rounds; round++) {
      for (const k of [1, 0.5]) {
        for (const key of keys) {
          const [lo, hi, st] = REAR_TUNE[key];
          for (const dir of [-1, 1]) {
            const old = HP[key], v = Math.min(hi, Math.max(lo, old + dir * st * k));
            if (v === old) continue;
            HP[key] = v;
            const r = await evalSet(H, fixed);
            if (r.score > cur.score + 1e-4) { cur = r; for (const f of fixed) f.t = f.tNew; log(`${key} ${old.toFixed(2)} → ${v.toFixed(2)}: score ${r.score.toFixed(3)} overlap ${r.mean.toFixed(3)} flags ${r.flags} ${r.per}`); break; }
            HP[key] = old;
          }
        }
      }
      await refit();
      cur = await evalSet(H, fixed);
      log(`round ${round + 1} (cameras re-fitted): score ${cur.score.toFixed(3)} overlap ${cur.mean.toFixed(3)} flags ${cur.flags} ${cur.per}`);
    }
    return { ...cur, settings: Object.fromEntries(keys.map((k) => [k, +HP[k].toFixed(3)])) };
  } finally { D.auditing = false; }
}

// ── fitting the rear to the screenshots' JOINTS (hind stifle + hock + hoof,
// nose, poll, tail root, front hooves) — pixel distances, no silhouettes ──
// For each screenshot: every moment of the rear gets the camera that best
// puts all those points on theirs; the moment with the smallest error wins.
// The error in px is normalised by the picture's height (as % of it).
function jointErrAt(H, ref, q0) {
  const L = rearLandmarks(H), [W, Hh] = ref.size;
  const T = Object.fromEntries(Object.entries(ref.lm).filter(([k]) => k !== "riderHead"));
  const f = [q0, ...STARTS.slice(0, 3)].filter(Boolean).map((s) => fitCamera(H, W, Hh, L, T, s, ref.fore)).sort((a, b) => a.rms - b.rms)[0];
  const P = makeProjectH(H, W, Hh); P.set(f.q);
  const per = Object.fromEntries(Object.entries(T).map(([k, p]) => { const r = P.proj(L[k]); return [k, Math.hypot(r[0] - p[0], r[1] - p[1]) / Hh * 100]; }));
  return { q: f.q, rms: f.rms / Hh * 100, per };
}
export function fitJoints(H, names = Object.keys(REAR_REFS), { t0 = 0.1, t1 = 2.3, dt = 0.1 } = {}) {
  restartRear(H); rearLandmarks(H);                         // (surface points picked on the standing horse)
  const out = [];
  for (const n of names) {
    const ref = REAR_REFS[n];
    restartRear(H);
    let t = 0, q0 = null, best = null;
    for (let ts = t0; ts <= t1 + 1e-6; ts += dt) {
      while (t < ts - 1e-6) { step(H); t += DT; }
      const e = jointErrAt(H, ref, q0); q0 = e.q;
      if (!best || e.rms < best.rms) best = { ...e, t: ts };
    }
    out.push({ name: n, ...best });
  }
  return { refs: out, mean: out.reduce((s, r) => s + r.rms, 0) / out.length };
}
export const JOINT_TUNE = {
  rearAngle: [0.6, 1.3, 0.08], rearHip: [0.6, 1.0, 0.04], rearHipFwd: [-0.7, 0.2, 0.08], rearCannon: [0, 1.1, 0.1],
  rearStep: [0, 0.5, 0.08], rearArch: [0, 1.6, 0.15], rearHeadFlex: [0, 1.4, 0.12], rearNeck: [0, 1, 0.1], rearStand: [0, 1, 0.08],
};
export function tuneJoints(H, { names, rounds = 3, keys = Object.keys(JOINT_TUNE), lock = {}, log = () => {} } = {}) {
  const HP = H.HP, D = H.D;
  D.auditing = true;
  try {
    Object.assign(HP, lock);
    let cur = fitJoints(H, names);
    log(`start: mean ${cur.mean.toFixed(2)} % — ${cur.refs.map((r) => r.name + " " + r.rms.toFixed(1)).join(", ")}`);
    for (let round = 0; round < rounds; round++) {
      const k = round === 0 ? 1 : round === 1 ? 0.5 : 0.25;
      for (const key of keys) {
        if (key in lock) continue;
        const [lo, hi, st] = JOINT_TUNE[key];
        for (const dir of [-1, 1]) {
          let improved = false;
          for (;;) {
            const old = HP[key], v = Math.min(hi, Math.max(lo, old + dir * st * k));
            if (v === old) break;
            HP[key] = v;
            const r = fitJoints(H, names);
            if (r.mean < cur.mean - 1e-3) { cur = r; improved = true; log(`${key} ${old.toFixed(2)} → ${v.toFixed(2)}: mean ${r.mean.toFixed(2)} %`); }
            else { HP[key] = old; break; }
          }
          if (improved) break;
        }
      }
    }
    return { ...cur, settings: Object.fromEntries(keys.map((k) => [k, +HP[k].toFixed(3)])) };
  } finally { D.auditing = false; }
}

// ── posing the neck onto the screenshots (keys for the pose editor) ───────
// For each screenshot, at its matched moment: the camera is fitted on the BODY
// points only (tail, stifle, hock, hooves — the neck is what we solve), then
// the neck base / middle / top and the head are turned about the horse's
// side axis until the poll and nose land on theirs. Returns the rotation
// offsets per moment (the pose editor's layer format: bone-local quaternions).
export function solveNeck(H, names = Object.keys(REAR_REFS), { bones = ["Neck1", "Neck2", "Neck3", "Head"] } = {}) {
  const c = H.ctrl, D = H.D;
  const B = bones.map((n) => { let b; H.horse.rig.traverse((o) => { if (o.name === n) b = o; }); return b; });
  D.auditing = true;
  const out = [];
  try {
    const fit = fitJoints(H, names);
    for (const f of fit.refs) {
      const ref = REAR_REFS[f.name], [W, Hh] = ref.size;
      rearAt(H, f.t);
      const body = ["tail", "stifle", "hock", "hindNear"];
      const Tb = Object.fromEntries(body.map((k) => [k, ref.lm[k]]));
      void Tb;
      const cam = { q: f.q };                                 // the all-points camera (a body-only fit came out far too close: the head left the frame)
      const P = makeProjectH(H, W, Hh); P.set(cam.q);
      const base = B.map((b) => b.quaternion.clone());
      const lat = new V3(Math.cos(c.yaw), 0, -Math.sin(c.yaw));
      const apply = (a) => {
        B.forEach((b, i) => b.quaternion.copy(base[i]));
        H.horse.rig.updateMatrixWorld(true);
        const offs = [];
        B.forEach((b, i) => {
          const ax = lat.clone().applyQuaternion(b.getWorldQuaternion(new THREE.Quaternion()).invert()).normalize();
          const off = new THREE.Quaternion().setFromAxisAngle(ax, a[i]);
          b.quaternion.multiply(off); b.updateMatrixWorld(true); offs.push(off);
        });
        return offs;
      };
      const err = (a) => {
        apply(a);
        const L = rearLandmarks(H);
        let e = 0;
        for (const k of ["poll", "nose"]) { const r = P.proj(L[k]); e += (r[0] - ref.lm[k][0]) ** 2 + (r[1] - ref.lm[k][1]) ** 2; }
        if (a.some((x) => Math.abs(x) > 0.7)) return 1e12;   // ±40° per joint at most
        return e + 2500 * a.reduce((s, x) => s + x * x, 0);   // (small angles preferred: no wild solutions)
      };
      let a = bones.map(() => 0), be = err(a);
      const e0 = Math.sqrt(be / 2) / Hh * 100;
      for (let st = 0.3; st > 0.003; st *= 0.6) {
        let imp = true;
        while (imp) { imp = false; for (let i = 0; i < a.length; i++) for (const s of [-1, 1]) { const b2 = a.slice(); b2[i] += s * st; const e = err(b2); if (e < be) { be = e; a = b2; imp = true; } } }
      }
      const offs = apply(a);
      const L = rearLandmarks(H), resid = ["poll", "nose"].map((k) => { const r = P.proj(L[k]); return Math.hypot(r[0] - ref.lm[k][0], r[1] - ref.lm[k][1]) / Hh * 100; });
      B.forEach((b, i) => b.quaternion.copy(base[i]));
      out.push({ cam: cam.q, name: f.name, t: f.t, deg: a.map((x) => Math.round(x * 57.3)), before: +e0.toFixed(1), after: +Math.max(...resid).toFixed(1), offs: offs.map((q) => q.toArray()) });
    }
  } finally { D.auditing = false; }
  return out;
}
