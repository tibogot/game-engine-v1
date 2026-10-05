// ── Horse lab: the horse ─────────────────────────────────────────────────────
// Loads the Quaternius horse (same 50-bone rig as the donkey) and drives it
// directly: speed → gait (Idle / Walk / Gallop), ground following with body
// pitch + roll from four ground samples, and one-shots (jump, head toss, eat).
//
// Rig facts (read from the GLB): leg FK is baked as rotations on the
// upper/lower leg bones; each hoof is skinned to FFL/FFR/FFBL/FFBR, children
// of the IK target bones (IKFrontLegL…) that hang from the armature root.
// Those targets are where hoof IK will act later.
//
// Ground speed per gait is MEASURED from the clip: while a hoof is planted it
// slides backwards at exactly the speed the body must move to not skate.
//
// Gait switches are PHASE-MATCHED: each clip's "front-left hoof touches down"
// moment is measured, and the incoming clip starts at the same point of the
// stride as the outgoing one, so the crossfade never makes a leg jump.
import * as THREE from "three";
import { getSharedGltfLoader } from "../../v2/core/foliage/glbLoader.js";

const V3 = THREE.Vector3;
export const FEET = ["FFL", "FFR", "FFBL", "FFBR"];
const LOOPS = ["Idle", "Walk", "Gallop"];

export const HP = {               // tunables (the lab GUI edits these)
  pitchFollow: 1.0,               // how much of the ground pitch the body takes
  rollFollow: 0.45,               // ... and roll (a horse stays fairly upright)
  fade: 0.3,                      // crossfade seconds
  phaseMatch: true,
  accel: 3.0,                     // m/s² (doubled inside the walk↔gallop gap)
  decel: 5.0,
  turnIdle: 1.3, turnWalk: 1.1, turnGallop: 0.75,   // rad/s
  lean: 0.12,                     // rad of lean into a full-rate gallop turn
  stepMax: 0.75,                  // m: higher than this ahead = a wall
  ik: true,                       // hoof IK (C toggles it)
  maxDrop: 0.35,                  // m the body may sink so a hoof reaches lower ground
  maxLift: 0.5,                   // m a hoof may be raised above the clip's flat ground
  neckLevel: 0.5,                 // share of the body pitch the neck takes back out
  headTurn: 0.45,                 // rad the neck bends into a full-rate turn
  jumpHeight: 0.9,                // m the jump arc lifts the horse
  rearAngle: 1.05,                // rad (60°) the body pitches up when rearing (R)
  rearHip: 0.8,                   // hip height when up, × its standing height (hind hocks + stifles clearly bent)
  rearStep: 0.24,                 // m each hind hoof steps forward under the body going up (and back after)
  rearSettle: 0.55,               // s after the front lands, for the hind hooves to step back
  rearHipFwd: 0.06,               // m the hips sit ahead of the planted hind hooves
  rearNeck: 0.3,                  // neck levelling while up: the neck reaches up AND forward
  rearHeadFlex: 0.45,             // rad the head flexes nose-down at the poll (not into the chest)
  rearPrep: 0.3,                  // s gathering (weight back, hind feet step under) before the push
  rearRise: 0.55, rearHold: 1.2, rearFall: 0.6,   // s
  pawRate: 1.6,                   // front-leg paws per second while up
};

// Hoof IK chains. Measured on the rig: each lower-leg bone's +Y points at its
// IK target bone (0–5°) at a constant length, and the hoof is skinned to the
// target's child (FFL…). So: move the target, bend the leg to meet it.
//
// FRONT: shoulder knob (9 cm, not a real segment) → FrontUpperLeg (forearm,
// 0.53 m) → FrontLowerLeg (cannon, 0.35 m) → hoof: a plain two-bone solve,
// elbow + knee.
// HIND: BackLeg (hip → stifle, 0.37 m) → BackUpperLeg (stifle → hock, 0.56 m)
// → BackLowerLeg (cannon, 0.42 m) → hoof. Bending only the hock tilts the
// cannon and zig-zags the leg (the user saw it), so the cannon KEEPS its
// animated angle and the hip + stifle take the change — what a horse does.
const LEGS = [
  { upper: "FrontUpperLegL", lower: "FrontLowerLegL", ik: "IKFrontLegL" },
  { upper: "FrontUpperLegR", lower: "FrontLowerLegR", ik: "IKFrontLegR" },
  { upper: "BackLegL", lower: "BackUpperLegL", cannon: "BackLowerLegL", ik: "IKBackLegL" },
  { upper: "BackLegR", lower: "BackUpperLegR", cannon: "BackLowerLegR", ik: "IKBackLegR" },
];

// Front legs while rearing are NOT mirror copies (that read as robotic): the
// right leg runs 0.11 s behind the left (leaves, folds, lands later), folds a
// little less, reaches a little further, paws at its own rate and phase.
// (The body lifts both hooves at once, so the lead leg must act BEFORE the
// body rises and the trailing one stay bent AFTER it lands.)
const REAR_LEGS = [
  { lag: -0.14, fold: 1, reach: 0.3, rate: 1, phase: 0 },          // leads: lifts during the gather, lands first
  { lag: 0.2, fold: 0.85, reach: 0.38, rate: 1.15, phase: 2.3 },    // trails: still bent when the body lands
];

const _a = new V3(), _b = new V3(), _c = new V3(), _t = new V3(), _d = new V3(), _p = new V3(), _u = new V3(), _v = new V3(), _w = new V3();
const _q = new THREE.Quaternion(), _qp = new THREE.Quaternion(), _qb = new THREE.Quaternion();

// Rotate a bone about its own origin by a WORLD-space rotation.
export function rotateWorld(bone, qW) {
  bone.getWorldQuaternion(_qb);
  bone.parent.getWorldQuaternion(_qp);
  bone.quaternion.copy(_qp.invert().multiply(qW.clone().multiply(_qb)));
  bone.updateMatrixWorld(true);
}

// Two-bone IK: bend `upper`/`lower` so the tip C (rigid in `lower`) lands on T.
// The middle joint stays on the side it is animated on, and never behind the
// leg line: both the front knee and the stifle sit FORWARD of it on a horse
// (`fwd` = the body's forward). With `force`, the joint always bends toward
// `fwd` (used as a pole: elbows, knees of the rider). Returns where the tip got to.
export function solveTwoBone(upper, lower, C, T, fwd, out, force = false) {
  upper.getWorldPosition(_a);
  lower.getWorldPosition(_b);
  const a = _a.distanceTo(_b), b = _b.distanceTo(C);
  _d.subVectors(T, _a);
  const c = THREE.MathUtils.clamp(_d.length(), Math.abs(a - b) + 1e-3, a + b - 1e-3);
  _d.normalize();
  _p.subVectors(_b, _a).addScaledVector(_d, -_u.subVectors(_b, _a).dot(_d));   // joint offset ⟂ the leg line
  if (force || _p.lengthSq() < 1e-8 || _p.dot(fwd) < 0) _p.copy(fwd).addScaledVector(_d, -fwd.dot(_d));
  _p.normalize();
  const cosA = THREE.MathUtils.clamp((a * a + c * c - b * b) / (2 * a * c), -1, 1);
  const sinA = Math.sqrt(1 - cosA * cosA);
  const Bd = _w.copy(_a).addScaledVector(_d, cosA * a).addScaledVector(_p, sinA * a);   // where the joint goes
  const Tc = out.copy(_a).addScaledVector(_d, c);                                        // reachable tip
  _u.subVectors(_b, _a).normalize();
  _v.subVectors(Bd, _a).normalize();
  _q.setFromUnitVectors(_u, _v);
  rotateWorld(upper, _q);
  _c.subVectors(C, _a).applyQuaternion(_q).add(_a);       // tip after the upper turn
  _u.subVectors(_c, Bd).normalize();
  _v.subVectors(Tc, Bd).normalize();
  _q.setFromUnitVectors(_u, _v);
  rotateWorld(lower, _q);
  return out;
}

const lerpK = (rate, dt) => 1 - Math.exp(-rate * dt);
const smooth01 = (u) => { u = Math.min(1, Math.max(0, u)); return u * u * (3 - 2 * u); };
const clamp = THREE.MathUtils.clamp;

// The pack's clips carry bad single keys: one key out of line with BOTH
// neighbours while they agree (measured: up to ~17° on the hind upper leg in
// Gallop_Jump, ~10° on a front knee in Walk) — a bone snaps for one key and
// back. Replace such a key with the interpolation of its neighbours, and make
// quaternion signs continuous.
function cleanClip(clip) {
  let fixed = 0;
  for (const tr of clip.tracks) {
    const n = tr.getValueSize(), t = tr.times, v = tr.values, K = t.length;
    if (K < 3) continue;
    const quat = tr.name.endsWith(".quaternion");
    if (quat) for (let i = 1; i < K; i++) {
      let d = 0;
      for (let k = 0; k < 4; k++) d += v[(i - 1) * 4 + k] * v[i * 4 + k];
      if (d < 0) for (let k = 0; k < 4; k++) v[i * 4 + k] = -v[i * 4 + k];
    }
    for (let i = 1; i < K - 1; i++) {
      const u = (t[i] - t[i - 1]) / (t[i + 1] - t[i - 1]);
      let dev = 0, step = 0;
      for (let k = 0; k < n; k++) {
        const a = v[(i - 1) * n + k], b = v[i * n + k], c = v[(i + 1) * n + k];
        dev += (b - (a + (c - a) * u)) ** 2; step += (c - a) ** 2;
      }
      dev = Math.sqrt(dev); step = Math.sqrt(step);
      const min = quat ? 0.004 : 0.0002;                     // positions: armature units, 0.0002 ≈ 1 cm on the horse
      if (dev > min && dev > 3 * step) {
        for (let k = 0; k < n; k++) v[i * n + k] = v[(i - 1) * n + k] + (v[(i + 1) * n + k] - v[(i - 1) * n + k]) * u;
        if (quat) {
          let l = 0; for (let k = 0; k < 4; k++) l += v[i * 4 + k] ** 2;
          l = Math.sqrt(l); for (let k = 0; k < 4; k++) v[i * 4 + k] /= l;
        }
        fixed++;
      }
    }
  }
  return fixed;
}

export async function loadHorse(url, { height = 2.15 } = {}) {
  const gltf = await getSharedGltfLoader().loadAsync(encodeURI(url));
  const model = gltf.scene;
  // The GLB carries every clip twice (plain + "AnimalArmature|…"); keep the plain ones.
  const clips = {};
  for (const c of gltf.animations) if (!c.name.includes("|")) clips[c.name] = c;
  for (const c of Object.values(clips)) cleanClip(c);
  model.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false; } });

  const rig = new THREE.Group();
  rig.rotation.order = "YXZ";
  rig.add(model);
  const bone = (n) => model.getObjectByName(n);
  const wp = (n) => bone(n).getWorldPosition(new V3());

  // Face +Z, scale to `height` (ears included), centre between shoulders and hips.
  rig.updateMatrixWorld(true);
  const head = wp("Head"), tail = wp("Tail1");
  const yaw0 = Math.atan2(head.x - tail.x, head.z - tail.z);
  model.rotation.y = -yaw0;
  rig.updateMatrixWorld(true);
  const box0 = new THREE.Box3().setFromObject(model, true);
  const s = height / (box0.max.y - box0.min.y);
  model.scale.setScalar(s);
  rig.updateMatrixWorld(true);
  const fr = wp("FrontUpperLegL"), frR = wp("FrontUpperLegR"), bk = wp("BackUpperLegL");
  model.position.x -= (fr.x + frR.x) / 2;
  model.position.z -= (fr.z + bk.z) / 2;
  rig.updateMatrixWorld(true);

  // Body half-length (shoulder ↔ hip) and half-width (hoof spread).
  const halfLen = Math.abs(wp("FrontUpperLegL").z - wp("BackUpperLegL").z) / 2;
  const halfWid = Math.max(0.18, Math.abs(wp("FFL").x - wp("FFR").x) / 2);

  let foot, jump;
  // Measure gaits on a throwaway mixer.
  const gait = {};
  {
    const mixer = new THREE.AnimationMixer(model);
    for (const name of ["Walk", "Gallop", "Idle"]) {
      const clip = clips[name];
      const act = mixer.clipAction(clip);
      act.play();
      const N = 120, dt = clip.duration / N;
      const tr = FEET.map(() => []);
      for (let i = 0; i < N; i++) {
        mixer.setTime(i * dt);
        rig.updateMatrixWorld(true);
        FEET.forEach((f, k) => { const p = wp(f); tr[k].push([p.y, p.z]); });
      }
      act.stop();
      const vs = [];
      let touch = 0;
      tr.forEach((t, k) => {
        const minY = Math.min(...t.map((a) => a[0]));
        const planted = t.map((a) => a[0] < minY + 0.02 * height);
        for (let i = 0; i < N; i++) {
          const j = (i + 1) % N;
          if (planted[i] && planted[j]) vs.push(-(t[j][1] - t[i][1]) / dt);
        }
        if (k === 0) {                                    // front-left touchdown
          for (let i = 0; i < N; i++) if (planted[i] && !planted[(i + N - 1) % N]) { touch = i / N; break; }
        }
      });
      vs.sort((a, b) => a - b);
      gait[name] = { speed: name === "Idle" ? 0 : Math.max(0, vs[vs.length >> 1] ?? 0), touch, duration: clip.duration };
    }
    // Gallop_Jump: when are all four hooves off the ground? The clip barely
    // leaves the floor, so the controller adds a real ballistic arc there.
    {
      const clip = clips.Gallop_Jump, act = mixer.clipAction(clip);
      act.play();
      const N = 120, lows = [];
      for (let i = 0; i < N; i++) {
        mixer.setTime((i / N) * clip.duration);
        rig.updateMatrixWorld(true);
        lows.push(Math.min(...FEET.map((f) => wp(f).y)));
      }
      act.stop();
      const ref = Math.min(...lows), air = lows.map((y) => y > ref + 0.05 * height);
      let best = [0.35, 0.65], run = -1;
      for (let i = 0; i <= N; i++) {
        if (i < N && air[i]) { if (run < 0) run = i; }
        else if (run >= 0) { if ((i - run) / N > best[1] - best[0] || best[0] === 0.35) best = [run / N, i / N]; run = -1; }
      }
      jump = { t0: best[0] * clip.duration, t1: best[1] * clip.duration };
    }
    // Stand the Idle pose on y = 0.
    mixer.setTime(0);
    mixer.clipAction(clips.Idle).play();
    mixer.setTime(0);
    rig.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(model, true);
    model.position.y -= box.min.y;
    // Where the four hooves stand (rig space): the body is placed from the
    // ground under THESE points, so it takes the big height differences.
    rig.updateMatrixWorld(true);
    foot = { fz: (wp("FFL").z + wp("FFR").z) / 2, hz: (wp("FFBL").z + wp("FFBR").z) / 2, x: Math.abs(wp("FFL").x - wp("FFR").x) / 2, sole: (wp("FFL").y + wp("FFBL").y) / 2,
      shY: wp("FrontUpperLegL").y, shZ: wp("FrontUpperLegL").z,
      hipY: (wp("BackLegL").y + wp("BackLegR").y) / 2, hipZ: (wp("BackLegL").z + wp("BackLegR").z) / 2 };
    mixer.stopAllAction();
    mixer.uncacheRoot(model);
    rig.updateMatrixWorld(true);
  }

  return { rig, model, clips, bone, gait, halfLen, halfWid, foot, jump, height, scale: s };
}

// ── Controller ───────────────────────────────────────────────────────────────
export class HorseController {
  constructor(h, world) {
    this.h = h;
    this.world = world;                      // { ground: Mesh[], blockers: Mesh[] }
    this.mixer = new THREE.AnimationMixer(h.model);
    this.actions = {};
    this.pos = new V3();
    this.yaw = 0; this.y = 0; this.pitch = 0; this.roll = 0;
    this.v = 0; this.turnRate = 0;
    this.gaitName = "Idle"; this.cur = null; this.oneShot = null; this.idleT = 0;
    this.blocked = false;
    this.probes = [new V3(), new V3(), new V3(), new V3()];
    this.ray = new THREE.Raycaster();
    this.mixer.addEventListener("finished", (e) => { if (e.action === this.oneShot) this.endOneShot(); });
    // IK state. Every bone IK touches is reset to its stored pose before the
    // mixer runs, so a bone a clip does not animate never keeps last frame's IK.
    this.legs = LEGS.map((L) => ({ u: h.bone(L.upper), l: h.bone(L.lower), cannon: L.cannon ? h.bone(L.cannon) : null, ik: h.bone(L.ik), ff: h.bone(L.ik).children[0], delta: 0, hit: new V3(), on: false }));
    this.neck = h.bone("Neck1");
    this.necks = ["Neck1", "Neck2", "Neck3"].map((n) => h.bone(n));
    this.headB = h.bone("Head");
    this.lift = 0; this.ikW = 1;
    this.rearT = -1; this.rearA = 0; this.rearPitch = 0; this.rearDy = 0;
    this.rearFold = 0; this.rearPaw = 0; this.rearToss = 0; this.landT = -1;
    this.rearLeg = REAR_LEGS.map(() => ({ A: 0, fold: 0, paw: 0, toss: 0 }));
    this.touched = [...this.legs.flatMap((g) => [g.u, g.l, g.cannon, g.ik].filter(Boolean)), ...this.necks, this.headB].map((b) => ({ b, p: b.position.clone(), q: b.quaternion.clone() }));
    this.bodyOff = 0;
    this.switchTo("Idle", 0);
  }

  applyIK(dt) {
    const r = this.h.rig;
    r.updateMatrixWorld(true);
    const up = _t.set(0, 1, 0).applyQuaternion(r.quaternion);
    const px = r.position.x, py = r.position.y, pz = r.position.z;
    const fwdX = Math.sin(this.yaw), fwdZ = Math.cos(this.yaw);
    // 1. how far the real ground under each hoof is from the clip's flat ground
    let minD = 0;
    this.legs.forEach((g, li) => {
      g.ff.getWorldPosition(_c);                           // the hoof itself, not its IK parent
      const planeY = py - (up.x * (_c.x - px) + up.z * (_c.z - pz)) / up.y;
      // heel, centre, toe — the highest wins, so a hoof half over a step
      // edge stands ON the edge instead of sinking past it
      const y0 = Math.max(_c.y, planeY);
      let hy = null;
      for (const o of [-0.07, 0, 0.07]) {
        const h1 = this.sampleGround(_c.x + fwdX * o, _c.z + fwdZ * o, y0, 0.9);
        if (h1 !== null && (hy === null || h1 > hy)) hy = h1;
      }
      g.hA = Math.max(0, _c.y - planeY - this.h.foot.sole);   // how high the CLIP lifts this hoof
      g.on = hy !== null;
      if (g.on) g.hit.set(_c.x, hy, _c.z);
      const raw = g.on ? THREE.MathUtils.clamp(hy - planeY, -HP.maxDrop - 0.2, HP.maxLift) : 0;
      g.delta += (raw - g.delta) * (g.hA < 0.02 ? 1 : lerpK(18, dt));   // planted: no lag
      g.w = (g.cannon ? 1 : 1 - smooth01((this.rearA - 0.09) / 0.3)) * this.ikW;   // front hooves: contact follows the BODY (a leg cannot stay down once the body is up); the legs differ in how they fold
      // how far this hoof is UNDER the ground (> 0): a front hoof is never
      // left there, whatever its IK weight (rear landing, tilted body)
      g.under = g.on ? hy + this.h.foot.sole - _c.y : 0;
      if (g.w > 0.5) minD = Math.min(minD, g.delta);
    });
    // 2. sink the body so the lowest hoof can reach
    const target = Math.max(minD, -HP.maxDrop) * this.ikW * (1 - this.rearA);
    this.bodyOff += (target - this.bodyOff) * lerpK(10, dt);
    r.position.y = this.y + this.lift + this.rearDy + this.bodyOff;
    r.updateMatrixWorld(true);
    // 3. move each IK target and bend the leg to meet it
    const fwd = new V3(0, 0, 1).applyQuaternion(r.quaternion);
    const untilt = new THREE.Quaternion().setFromAxisAngle(new V3(0, 1, 0), this.yaw).multiply(r.quaternion.clone().invert());
    this.legs.forEach((g, li) => {
      if (g.w < 0.01 && !g.cannon && !(g.under > 0)) return;   // front legs folded by the rear: leave them
      // A hoof goes up only as far as it must to clear the ground: planted
      // (hA ≈ 0) it takes the whole offset; mid-stride, already lifted by the
      // clip, it takes only what is left — else bumps get stepped over twice.
      let d = ((g.delta > 0 ? Math.max(0, g.delta - g.hA) : g.delta) - this.bodyOff) * g.w;
      if (!g.cannon && g.under > 0) d = Math.max(d, g.under);
      const C = g.ik.getWorldPosition(new V3());
      const T = C.clone(); T.y += d;
      if (g.cannon && this.rearT >= 0 && this.rearPlant) T.copy(this.rearFoot(li - 2));
      // front hooves stay exactly where they stand while the horse gathers,
      // released as that leg's own push-off starts
      if (!g.cannon && this.rearT >= 0 && this.rearPlantF && this.rearT < HP.rearPrep + HP.rearRise) {
        const pin = 1 - smooth01((this.rearA - 0.09) / 0.3);
        if (pin > 0) T.lerp(this.rearPlantF[li], pin);
      }   // rearing: hind hooves step under, stay planted, step back — never slide
      let reached;
      if (!g.cannon) reached = solveTwoBone(g.u, g.l, C, T, fwd, new V3());
      else {
        // hind: the cannon keeps the clip's angle to the VERTICAL (not to the
        // tilted body); hip + stifle put the hock where the cannon must start.
        const hock = g.cannon.getWorldPosition(new V3());
        const w = C.clone().sub(hock).applyQuaternion(untilt);
        const tipLocal = g.cannon.worldToLocal(C.clone());
        const hockReached = solveTwoBone(g.u, g.l, hock, T.clone().sub(w), fwd, new V3());
        const tipNow = g.cannon.localToWorld(tipLocal);
        rotateWorld(g.cannon, _q.setFromUnitVectors(tipNow.sub(hockReached).normalize(), w.clone().normalize()));
        reached = hockReached.add(w);
      }
      g.ik.position.copy(g.ik.parent.worldToLocal(reached));
      // rearing: the hoof bone tilts with the body and would tip the hoof onto
      // its heel, 10 cm up — turn it back level with the ground
      if (g.cannon && this.rearA > 0) rotateWorld(g.ik, new THREE.Quaternion().slerp(untilt, this.rearA));
      g.ik.updateMatrixWorld(true);
    });
  }

  // Neck: level the head on slopes, and bend into turns (Neck1-3 share it).
  levelNeck() {
    const rq = this.h.rig.quaternion;
    const lvl = HP.neckLevel + (HP.rearNeck - HP.neckLevel) * this.rearA;
    const lat = new V3(1, 0, 0).applyQuaternion(rq);
    if (lvl) rotateWorld(this.neck, _q.setFromAxisAngle(lat, -(this.pitch - this.rearPitch) * lvl));
    if (this.rearA > 0) rotateWorld(this.headB, _q.setFromAxisAngle(lat, HP.rearHeadFlex * this.rearA));   // nose tucked down
    if (this.rearToss > 0) {                                  // up: a small head toss
      const w = Math.PI * 2 * 1.1 * this.rearT;
      rotateWorld(this.necks[1], _q.setFromAxisAngle(lat, 0.09 * Math.sin(w) * this.rearToss));
      rotateWorld(this.headB, _q.setFromAxisAngle(lat, -0.07 * Math.sin(w + 1) * this.rearToss));
    }
    const turn = clamp(this.turnRate / HP.turnWalk, -1, 1) * HP.headTurn;
    if (turn) {
      const up = new V3(0, 1, 0).applyQuaternion(rq);
      [0.35, 0.35, 0.3].forEach((w, i) => rotateWorld(this.necks[i], _q.setFromAxisAngle(up, turn * w)));
    }
  }

  act(name) {
    return this.actions[name] ??= this.mixer.clipAction(this.h.clips[name]);
  }

  // Stride phase of an action, 0..1, measured from front-left touchdown.
  phaseOf(name, action) {
    const g = this.h.gait[name];
    if (!g) return 0;
    return (((action.time / g.duration) - g.touch) % 1 + 1) % 1;
  }

  switchTo(name, fade = HP.fade) {
    const next = this.act(name);
    const prev = this.cur;
    next.reset();
    next.setLoop(THREE.LoopRepeat, Infinity);
    next.clampWhenFinished = false;
    if (prev && HP.phaseMatch && prev !== next && LOOPS.includes(this.gaitName) && name !== "Idle" && this.gaitName !== "Idle") {
      const ph = this.phaseOf(this.gaitName, prev);
      const g = this.h.gait[name];
      next.time = ((ph + g.touch) % 1) * g.duration;
    }
    next.play();
    if (prev && prev !== next) prev.crossFadeTo(next, fade, false);
    this.cur = next;
    this.gaitName = name;
  }

  // Hind hoof i (0 left, 1 right) during a rear: steps forward under the body
  // on the way up (left first), stays planted, steps back after the front
  // lands (left first) — each step a short lifted arc, so nothing slides.
  rearFoot(i) {
    const t = this.rearT, end = HP.rearPrep + HP.rearRise + HP.rearHold + HP.rearFall + HP.rearSettle;
    const stepIn = i ? [0.14, 0.44] : [0.04, 0.34];
    const stepOut = i ? [end - 0.3, end - 0.02] : [end - 0.5, end - 0.22];
    const sm = (u) => u * u * (3 - 2 * u);
    let s = 0, lift = 0;
    if (t >= stepIn[0] && t < stepIn[1]) { const u = (t - stepIn[0]) / (stepIn[1] - stepIn[0]); s = sm(u); lift = Math.sin(Math.PI * u) ** 2; }   // eases in and out: no pop on the first frame
    else if (t >= stepIn[1] && t < stepOut[0]) s = 1;
    else if (t >= stepOut[0] && t < stepOut[1]) { const u = (t - stepOut[0]) / (stepOut[1] - stepOut[0]); s = 1 - sm(u); lift = Math.sin(Math.PI * u) ** 2; }
    const f = new V3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    return this.rearPlant[i].clone().addScaledVector(f, s * HP.rearStep).add(new V3(0, lift * 0.12, 0));
  }

  // The rear timeline at time t (s): body tilt A, knee fold, paw, head toss.
  rearCurve(t) {
    const o = { A: 0, fold: 0, paw: 0, toss: 0 };
    if (t < 0) return o;
    const Pp = HP.rearPrep, R = HP.rearRise, Hd = HP.rearHold, F = HP.rearFall;
    const sm = (u) => { u = clamp(u, 0, 1); return u * u * (3 - 2 * u); };
    if (t < Pp) o.A = 0.08 * sm(t / Pp);
    else if (t < Pp + R) { o.A = 0.08 + 0.92 * sm((t - Pp) / R); o.fold = sm((o.A - 0.2) / 0.75); }   // knees fold gradually after push-off
    else if (t < Pp + R + Hd) { o.A = 1; o.fold = 1; o.paw = sm((t - Pp - R) / 0.35); o.toss = sm((t - Pp - R) / 0.3); }
    else if (t < Pp + R + Hd + F) {
      const u = (t - Pp - R - Hd) / F;
      o.A = 1 - u * u;                                         // drops, faster at the end
      o.fold = sm((o.A - 0.12) / 0.55);                        // legs unfold and reach for the ground
      o.paw = 1 - sm(u * 2.5); o.toss = 1 - sm(u * 2);
    }
    return o;
  }

  startRear() {
    if (this.oneShot && ["Idle_2", "Idle_Headlow", "Eating"].includes(this.oneShotName)) this.endOneShot();   // fidgets may be cut
    if (this.oneShot || this.rearT >= 0 || Math.abs(this.v) > 1.6) return false;
    this.rearT = 0;
    this.rearPlant = this.legs.slice(2).map((g) => g.ik.getWorldPosition(new V3()));
    this.rearPlantF = this.legs.slice(0, 2).map((g) => g.ik.getWorldPosition(new V3()));   // front hooves: pinned until each one pushes off   // where the hind hooves stand at the start
    return true;
  }

  playOneShot(name, { holdSpeed = false } = {}) {
    if (this.rearT >= 0) return;
    if (this.oneShot && ["Idle_2", "Idle_Headlow"].includes(this.oneShotName) && name !== this.oneShotName) this.oneShot = null;   // idle fidgets may be cut by any action
    if (this.oneShot || !this.h.clips[name]) return;
    const a = this.act(name);
    a.reset();
    a.setLoop(THREE.LoopOnce, 1);
    a.clampWhenFinished = true;
    a.setEffectiveTimeScale(1);
    a.play();
    if (this.cur && this.cur !== a) this.cur.crossFadeTo(a, 0.2, false);
    this.oneShot = a;
    this.oneShotName = name;
    this.holdSpeed = holdSpeed;
    this.cur = a;
  }

  endOneShot() {
    const back = Math.abs(this.v) < 0.05 ? "Idle" : (this.v > this.h.gait.Walk.speed * 1.75 ? "Gallop" : "Walk");
    const a = this.oneShot;
    this.oneShot = null;
    const next = this.act(back);
    next.reset().setLoop(THREE.LoopRepeat, Infinity);
    next.play();
    a.crossFadeTo(next, 0.25, false);
    this.cur = next;
    this.gaitName = back;
    this.idleT = 0;
  }

  // Down ray from `up` metres above yRef. Starting INSIDE a solid misses it,
  // so the step test (below) casts from high up.
  sampleGround(x, z, yRef, up = 1.2) {
    this.ray.set(new V3(x, yRef + up, z), new V3(0, -1, 0));
    this.ray.far = up + 7;
    const hit = this.ray.intersectObjects(this.world.ground, false)[0];
    return hit ? hit.point.y : null;
  }

  blockedAhead(dir) {
    const { halfLen } = this.h;
    const fwd = new V3(Math.sin(this.yaw), 0, Math.cos(this.yaw)).multiplyScalar(dir);
    const left = new V3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    // Step test: the ground just past the chest must not be a wall.
    const ahead = this.pos.clone().addScaledVector(fwd, halfLen + 0.35);
    const h = this.sampleGround(ahead.x, ahead.z, this.y, 10);
    const clear = this.oneShotName === "Gallop_Jump" && this.oneShot ? HP.jumpHeight : 0;   // a jump clears low things
    if (h === null || h - this.y > HP.stepMax + clear) return true;
    // Chest-height rays against fences, walls, arches, rocks.
    this.ray.far = halfLen + 0.8;
    for (const up of [0.6, 1.2]) for (const side of [-0.3, 0, 0.3]) {
      const o = this.pos.clone().addScaledVector(left, side);
      o.y = this.y + up + clear;
      this.ray.set(o, fwd);
      if (this.ray.intersectObjects(this.world.blockers, false).length) return true;
    }
    return false;
  }

  // input: { fwd: -1..1, turn: -1..1, run: bool }
  update(dt, input) {
    const g = this.h.gait, walkV = g.Walk.speed, galV = g.Gallop.speed;
    const busy = (this.oneShot && !this.holdSpeed) || this.rearT >= 0;

    // Speed
    let target = 0;
    if (!busy) {
      if (input.fwd > 0) target = input.run ? galV : walkV;
      else if (input.fwd < 0) target = -walkV * 0.55;
    }
    const inGap = this.v > walkV * 1.5 && this.v < galV * 0.6;   // no trot clip: hurry through
    const acc = (Math.abs(target) > Math.abs(this.v) ? HP.accel : HP.decel) * (inGap ? 2 : 1);
    this.v += clamp(target - this.v, -acc * dt, acc * dt);

    // Turning
    const tr = this.gaitName === "Gallop" ? HP.turnGallop : Math.abs(this.v) > 0.1 ? HP.turnWalk : HP.turnIdle;
    const wantTurn = busy ? 0 : input.turn * tr;
    this.turnRate += (wantTurn - this.turnRate) * lerpK(8, dt);
    this.yaw += this.turnRate * dt;

    // Move (stop dead against walls)
    if (Math.abs(this.v) > 1e-3) {
      this.blocked = this.blockedAhead(Math.sign(this.v));
      if (this.blocked) this.v = 0;
      else {
        this.pos.x += Math.sin(this.yaw) * this.v * dt;
        this.pos.z += Math.cos(this.yaw) * this.v * dt;
      }
    } else this.blocked = false;

    // Gait selection (with hysteresis)
    if (!this.oneShot) {
      const turning = Math.abs(this.turnRate) > 0.15;
      let want = this.gaitName;
      if (this.gaitName === "Gallop") { if (this.v < walkV * 1.6) want = "Walk"; }
      else if (this.v > walkV * 1.9) want = "Gallop";
      else if (Math.abs(this.v) > 0.05 || turning || target !== 0) want = "Walk";
      else if (Math.abs(this.v) <= 0.05) want = "Idle";
      if (this.rearT >= 0) want = "Idle";                      // the rear is procedural, on top of Idle
      if (want !== this.gaitName) this.switchTo(want);
      // Time scale so the hooves match the ground.
      if (this.gaitName === "Walk") {
        const ts = Math.abs(this.v) < 0.05 && turning ? 0.6 : this.v / walkV;
        this.cur.setEffectiveTimeScale(Math.sign(ts || 1) * clamp(Math.abs(ts), 0.35, 1.6));
      } else if (this.gaitName === "Gallop") {
        this.cur.setEffectiveTimeScale(clamp(this.v / galV, 0.6, 1.25));
      } else {
        this.cur.setEffectiveTimeScale(1);
        this.idleT += dt;
        if (this.idleT > 9 && this.rearT < 0) { this.idleT = 0; this.playOneShot(Math.random() < 0.5 ? "Idle_2" : "Idle_Headlow"); }
      }
    }
    if (this.gaitName !== "Idle") this.idleT = 0;

    // Ground under the four hoof footprints (FL, FR, BL, BR) → height, pitch, roll
    const { fz: Fz, hz: Hz, x: Fx } = this.h.foot;
    const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw), lx = Math.cos(this.yaw), lz = -Math.sin(this.yaw);
    const P = this.probes;
    P[0].set(this.pos.x + fx * Fz + lx * Fx, 0, this.pos.z + fz * Fz + lz * Fx);
    P[1].set(this.pos.x + fx * Fz - lx * Fx, 0, this.pos.z + fz * Fz - lz * Fx);
    P[2].set(this.pos.x + fx * Hz + lx * Fx, 0, this.pos.z + fz * Hz + lz * Fx);
    P[3].set(this.pos.x + fx * Hz - lx * Fx, 0, this.pos.z + fz * Hz - lz * Fx);
    for (const p of P) { const h = this.sampleGround(p.x, p.z, this.y); p.y = h ?? this.y; }
    const gF = (P[0].y + P[1].y) / 2, gB = (P[2].y + P[3].y) / 2, gL = (P[0].y + P[2].y) / 2, gR = (P[1].y + P[3].y) / 2;
    const ty = gB + (gF - gB) * (-Hz) / (Fz - Hz);            // ground line at the body origin
    const k = ty < this.y ? lerpK(9, dt) : lerpK(14, dt);
    this.y += (ty - this.y) * k;
    const tp = -Math.atan2(gF - gB, Fz - Hz) * HP.pitchFollow;
    const lean = -(this.turnRate / HP.turnGallop) * clamp(this.v / galV, 0, 1) * HP.lean;
    const trl = Math.atan2(gL - gR, 2 * Fx) * HP.rollFollow + lean;
    this.pitch += (clamp(tp, -0.45, 0.45) - this.pitch) * lerpK(8, dt);
    this.roll += (clamp(trl, -0.3, 0.3) - this.roll) * lerpK(6, dt);

    // Jump: a ballistic arc over the clip's airborne window, which is slowed
    // so the air time matches the height (t = √(8h/g)); hoof IK off in the air.
    this.lift = 0;
    let airborne = false;
    if (this.oneShot && this.oneShotName === "Gallop_Jump") {
      const { t0, t1 } = this.h.jump, t = this.oneShot.time;
      const airT = Math.sqrt(8 * HP.jumpHeight / 9.8);
      this.oneShot.setEffectiveTimeScale(t >= t0 && t <= t1 ? (t1 - t0) / airT : 1);
      if (t >= t0 - 0.06 && t <= t1 + 0.06) airborne = true;
      if (t > t0 && t < t1) { const u = (t - t0) / (t1 - t0); this.lift = 4 * HP.jumpHeight * u * (1 - u); }
    }
    this.ikW += ((airborne ? 0 : 1) - this.ikW) * lerpK(14, dt);

    // Rear (procedural — the pack has no rearing clip): the body pitches up
    // over the planted hind hooves (hind IK gathers the legs, cannons stay
    // vertical); the front legs leave IK, fold and paw; the neck carries on
    // up the body line and the head flexes nose-down.
    // A rear in five beats: GATHER (weight back, hind feet step under, front
    // still planted) → PUSH (the front leaves the ground with straight legs,
    // THEN the knees fold) → PAW (circular, knee and cannon out of phase; a
    // small head toss) → COME DOWN (the legs unfold and reach before landing)
    // → LAND (a short compression) while the hind feet step back.
    this.rearA = 0; this.rearFold = 0; this.rearPaw = 0; this.rearToss = 0;
    if (this.rearT >= 0) {
      this.rearT += dt;
      const c = this.rearCurve(this.rearT);
      this.rearA = c.A; this.rearFold = c.fold; this.rearPaw = c.paw; this.rearToss = c.toss;
      const Fend = HP.rearPrep + HP.rearRise + HP.rearHold + HP.rearFall, t = this.rearT;
      if (t >= Fend && t < Fend + HP.rearSettle) { if (this.landT < 0 && t - Fend < dt * 1.5) this.landT = 0; }
      else if (t >= Fend + HP.rearSettle) this.rearT = -1;
    }
    // Each front leg runs its own copy of the timeline, the second one late —
    // they leave the ground, fold, paw and land one after the other.
    this.rearLeg = REAR_LEGS.map((L) => this.rearCurve(this.rearT < 0 ? -1 : this.rearT - L.lag));
    let landDip = 0;                                           // front lands: a short compression
    if (this.landT >= 0) {
      this.landT += dt;
      if (this.landT > 0.4) this.landT = -1;
      else landDip = Math.sin(Math.PI * this.landT / 0.4) * Math.exp(-this.landT * 3);
    }
    this.rearPitch = this.rearA * HP.rearAngle;
    // Place the body by its HIPS, not by pivoting round the hooves (that sat
    // the horse down like a dog): up, the hips sit just ahead of the planted
    // hind hooves at ~0.9 of their standing height; IK gathers the legs under.
    const r = this.h.rig;
    r.position.set(this.pos.x, this.y + this.lift, this.pos.z);
    r.rotation.set(this.pitch - this.rearPitch + 0.05 * landDip, this.yaw, this.roll);
    r.position.y -= 0.035 * landDip;
    this.rearDy = -0.035 * landDip;
    if (this.rearA > 0) {
      const ft = this.h.foot, hipL = new V3(0, ft.hipY, ft.hipZ);
      const q0 = new THREE.Quaternion().setFromEuler(new THREE.Euler(this.pitch, this.yaw, this.roll, "YXZ"));
      const hip0 = hipL.clone().applyQuaternion(q0).add(r.position);
      const hz = ft.hz + HP.rearStep + HP.rearHipFwd;              // over the stepped-in hind hooves
      const hipUp = new V3(this.pos.x + fx * hz, this.y + ft.hipY * HP.rearHip, this.pos.z + fz * hz);
      const hipW = hip0.lerp(hipUp, this.rearA);
      r.position.copy(hipW.sub(hipL.applyQuaternion(r.quaternion)));
      // Until the front pushes off, its legs are near straight and cannot
      // reach further: the shoulders must not rise, so the body sinks instead
      // (the weight goes back by lowering the hind end, not lifting the front).
      const pu = clamp((this.rearA - 0.08) / 0.4, 0, 1), pinF = 1 - pu * pu * (3 - 2 * pu);   // released gradually on the BODY's clock
      if (pinF > 0) {
        const sh = new V3(0, ft.shY, ft.shZ).applyQuaternion(r.quaternion).add(r.position);
        r.position.y -= Math.max(0, sh.y - (this.y + ft.shY)) * pinF;
      }
      this.rearDy = r.position.y - (this.y + this.lift);
    }
    // Restore what the ANIMATION wrote last frame (not the rest pose): the
    // mixer skips a bone whose animated value did not change since its last
    // write, so a rest-pose reset survived every clip hold as a one-frame pop.
    for (const t of this.touched) { t.b.position.copy(t.p); t.b.quaternion.copy(t.q); }
    this.mixer.update(dt);
    for (const t of this.touched) { t.p.copy(t.b.position); t.q.copy(t.b.quaternion); }
    if (this.rearLeg.some((L) => L.fold > 0 || L.paw > 0)) {
      r.updateMatrixWorld(true);
      const lftAxis = new V3(1, 0, 0).applyQuaternion(r.quaternion);
      for (let i = 0; i < 2; i++) {                          // front legs: lift forward, fold the knee, paw
        const g = this.legs[i], L = this.rearLeg[i], S = REAR_LEGS[i];
        if (!(L.fold > 0 || L.paw > 0)) continue;
        const ph = this.rearT * HP.pawRate * S.rate * Math.PI * 2 + S.phase;
        // The hoof hangs off the IK bone (root-parented), not off the leg:
        // carry it with the folded cannon, or IK straightens the leg back out.
        const tipL = g.l.worldToLocal(g.ik.getWorldPosition(new V3()));
        const qBefore = g.l.getWorldQuaternion(new THREE.Quaternion());
        rotateWorld(g.u, _q.setFromAxisAngle(lftAxis, -(S.reach * L.fold + 0.25 * L.paw * Math.sin(ph))));   // forearm forward
        rotateWorld(g.l, _q.setFromAxisAngle(lftAxis, 1.5 * S.fold * L.fold + 0.3 * L.paw * Math.sin(ph - 1.6)));   // knee folds; out of phase = a circular paw
        const dq = g.l.getWorldQuaternion(new THREE.Quaternion()).multiply(qBefore.invert());
        rotateWorld(g.ik, dq);
        g.ik.position.copy(g.ik.parent.worldToLocal(g.l.localToWorld(tipL)));
        g.ik.updateMatrixWorld(true);
      }
    }
    if (HP.ik) this.applyIK(dt);
    else this.bodyOff = 0;
    r.updateMatrixWorld(true);
    this.levelNeck();
  }

  // How fast the clip's planted hooves move vs how fast the body moves (0 = no skating).
  slip() {
    const g = this.h.gait;
    if (this.oneShot || this.gaitName === "Idle") return 0;
    const animV = g[this.gaitName].speed * this.cur.getEffectiveTimeScale();
    return Math.abs(this.v) > 0.05 ? (animV - this.v) / Math.abs(this.v) : 0;
  }
}
