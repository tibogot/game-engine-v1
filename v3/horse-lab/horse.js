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
const LOOPS = ["Idle", "Walk", "Trot", "Canter", "Gallop"];
// Gears, slowest first. Canter = the gallop clip played slower.
export const GEARS = ["Walk", "Trot", "Canter", "Gallop"];

export const HP = {               // tunables (the lab GUI edits these)
  pitchFollow: 1.0,               // how much of the ground pitch the body takes
  rollFollow: 0.45,               // ... and roll (a horse stays fairly upright)
  fade: 0.3,                      // crossfade seconds
  speedScale: 1.3,                // every gear this much faster than the clips' measured ground speed: the legs play 1.3× (hooves stay planted). Real horses are ~2× faster still; the clips' short stride is why
  trotRate: 1.9,                  // trot speed = walk speed × this (the trot plays the re-timed walk faster)
  canterRate: 0.75,               // canter speed = gallop speed × this (the gallop clip, slower)
  phaseMatch: true,               // smart gait hand-overs (best moment + matching pose)
  blendWait: 0.45,                // s a gait change may wait for that moment
  accel: 3.0,                     // m/s² (doubled inside the walk↔gallop gap)
  decel: 5.0,
  turnIdle: 1.3, turnWalk: 1.1, turnGallop: 0.75,   // rad/s
  lean: 0.12,                     // rad of lean into a full-rate gallop turn
  stepOver: 0.35,                 // m: a thing on the ground lower than this is stepped over (ground poles), never a wall
  stepMax: 0.75,                  // m: higher than this ahead = a wall
  ik: true,                       // hoof IK (C toggles it)
  maxDrop: 0.35,                  // m the body may sink so a hoof reaches lower ground
  maxLift: 0.5,                   // m a hoof may be raised above the clip's flat ground
  neckLevel: 0.5,                 // share of the body pitch the neck takes back out
  headTurn: 0.45,                 // rad the neck bends into a full-rate turn
  autoJump: true,                 // galloping at a jumpable obstacle: the horse jumps it by itself (like Zelda / RDR)
  autoJumpRange: 7,               // m ahead where it commits to the jump
  jumpWindup: 0.28,               // s from Space to the stride start — CONSTANT, so the take-off spot is predictable
                                  // (the rest of the stride is played at whatever speed fits: 0.8×–2.2×)
  jumpLeadIn: 1.7,                // playback speed of the jump clip's 0.5 s run-up (snappier take-off)
  jumpHeight: 0.5,                // m of EXTRA arc on top of the clip's own ~1 m jump (hooves clear ~1.5 m: fences, platform A)
  jumpBoostMax: 0.75,             // m more arc a jump may add for the obstacle in front of it (fitJump): a 1.4 m fence needs ~0.6
  jumpMargin: 0.15,               // m every hoof passes above the obstacle's top (the baked clearance reads ~7 cm high vs the real hooves)
  jumpLatest: 1.7,                // m (+ 0.12 s of travel): a queued jump still waiting for its stride takes off NOW
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
  // keep the bend on the side the clip has it (forcing it forward flipped
  // joints the clip bends slightly back — up to 37° on flat ground)
  if (force || _p.lengthSq() < 1e-8) _p.copy(fwd).addScaledVector(_d, -fwd.dot(_d));
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
  if (typeof location !== "undefined" && new URLSearchParams(location.search).has("rawclips")) return 0;   // debug: clips as exported
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

// 1-2-1 low-pass on quaternion keys (slerp-based), `passes` times, on the
// leg/hip bones. Removes key-to-key zig-zag; keeps the motion's shape.
const LEG_TRACK = /^(BackShoulder|BackLeg|BackUpperLeg|BackLowerLeg|FrontShoulder|FrontUpperLeg|FrontLowerLeg)[LR]\.quaternion$/;
function smoothLegTracks(clip, passes) {
  if (typeof location !== "undefined" && new URLSearchParams(location.search).has("rawclips")) return;
  const qa = new THREE.Quaternion(), qb = new THREE.Quaternion(), qc = new THREE.Quaternion();
  for (const tr of clip.tracks) {
    if (!LEG_TRACK.test(tr.name)) continue;
    const v = tr.values, K = tr.times.length;
    for (let p = 0; p < passes; p++) {
      const src = v.slice();
      for (let i = 1; i < K - 1; i++) {
        qa.fromArray(src, (i - 1) * 4); qb.fromArray(src, i * 4); qc.fromArray(src, (i + 1) * 4);
        const nb = qa.clone().slerp(qc, 0.5);                     // neighbours' midpoint
        qb.slerp(nb, 0.5).normalize();                            // = 1-2-1 weights
        qb.toArray(v, i * 4);
      }
    }
  }
}

// Which bones belong to each leg (FEET order: FL, FR, BL, BR).
const LEG_BONES = [
  ["FrontShoulderL", "FrontUpperLegL", "FrontLowerLegL", "IKFrontLegL", "FFL", "PoleTargetL"],
  ["FrontShoulderR", "FrontUpperLegR", "FrontLowerLegR", "IKFrontLegR", "FFR", "PoleTargetR"],
  ["BackShoulderL", "BackLegL", "BackUpperLegL", "BackLowerLegL", "IKBackLegL", "FFBL", "PoleTargetBackL"],
  ["BackShoulderR", "BackLegR", "BackUpperLegR", "BackLowerLegR", "IKBackLegR", "FFBR", "PoleTargetBackR"],
];

// A trot made from the walk. The walk lifts the legs one after another; a
// trot moves DIAGONAL pairs together. Measure each hoof's swing phase (first
// harmonic of its height over the clip), then time-shift every track of that
// leg so FL+BR swing together and FR+BL half a cycle later — the same re-timing
// the camel's pace used. The body gets a bounce on each diagonal beat.
// footTr[k][i] = [hoofY, hoofZ] sampled at N even times over the walk.
function buildTrot(walk, footTr, modelScale) {
  const N = footTr[0].length, D = walk.duration;
  const phase = footTr.map((t) => {
    let c = 0, sn = 0;
    t.forEach(([y], i) => { const a = 2 * Math.PI * i / N; c += y * Math.cos(a); sn += y * Math.sin(a); });
    return Math.atan2(sn, c) / (2 * Math.PI);                 // swing peak at this fraction of the cycle
  });
  const p0 = phase[0];
  const target = [p0, p0 + 0.5, p0 + 0.5, p0];               // FL, FR, BL, BR
  const wrap = (x) => x - Math.round(x);
  const shift = phase.map((ph, k) => wrap(ph - target[k]));
  const legOf = {};
  LEG_BONES.forEach((names, k) => names.forEach((n) => (legOf[n] = k)));
  const trot = walk.clone();
  trot.name = "Trot";
  for (const tr of trot.tracks) {
    const bone = tr.name.split(".")[0], k = legOf[bone];
    if (k === undefined || !shift[k]) continue;
    const it = tr.createInterpolant(), n = tr.getValueSize();
    const out = new Float32Array(tr.values.length);
    for (let i = 0; i < tr.times.length; i++) {
      let t = tr.times[i] + shift[k] * D;
      t = ((t % D) + D) % D;
      out.set(it.evaluate(t), i * n);
    }
    tr.values = out;
  }
  // bounce: lowest at mid-stance of each diagonal (twice per cycle). Body moves
  // in armature space: up is local +z, 1 unit = 100 × the model scale (m).
  const body = trot.tracks.find((t) => t.name === "Body.position");
  if (body) {
    const A = 0.035 / (100 * modelScale), low = p0 + 0.5;
    for (let i = 0; i < body.times.length; i++) body.values[i * 3 + 2] -= A * Math.cos(4 * Math.PI * (body.times[i] / D - low));
  }
  trot.userData = { shift, phase };
  return trot;
}

const TIP_LEGS = [["FrontLowerLegL", "IKFrontLegL"], ["FrontLowerLegR", "IKFrontLegR"], ["BackLowerLegL", "IKBackLegL"], ["BackLowerLegR", "IKBackLegR"]];

// How different two clip poses are: summed rotation (degrees) of the leg,
// body and neck bones. Blending poses far apart is what makes legs look thin
// and misplaced for a moment (gallop mid-stride → jump take-off was ~470°).
const POSE_BONES = ["FrontUpperLegL", "FrontLowerLegL", "FrontUpperLegR", "FrontLowerLegR", "BackLegL", "BackUpperLegL", "BackLowerLegL", "BackLegR", "BackUpperLegR", "BackLowerLegR", "BackShoulderL", "BackShoulderR", "FrontShoulderL", "FrontShoulderR", "Body", "Back", "Neck1"];
const _interp = new WeakMap(), _qa = new THREE.Quaternion(), _qb2 = new THREE.Quaternion();
function boneQuat(clip, bone, t, out) {
  let m = _interp.get(clip);
  if (!m) { m = {}; for (const tr of clip.tracks) { const [b, prop] = tr.name.split("."); if (prop === "quaternion") m[b] = tr.createInterpolant(); } _interp.set(clip, m); }
  const it = m[bone];
  if (!it) return null;
  const v = it.evaluate(Math.min(Math.max(t, 0), clip.duration));
  return out.set(v[0], v[1], v[2], v[3]).normalize();
}
export function poseDiff(clipA, tA, clipB, tB) {
  let s = 0;
  for (const b of POSE_BONES) {
    const a = boneQuat(clipA, b, tA, _qa), c = boneQuat(clipB, b, tB, _qb2);
    if (a && c) s += a.angleTo(c);
  }
  return s * 180 / Math.PI;
}

export async function loadHorse(url, { height = 2.15 } = {}) {
  const gltf = await getSharedGltfLoader().loadAsync(encodeURI(url));
  const model = gltf.scene;
  // The GLB carries every clip twice (plain + "AnimalArmature|…"); keep the plain ones.
  const clips = {};
  for (const c of gltf.animations) if (!c.name.includes("|")) clips[c.name] = c;
  for (const c of Object.values(clips)) cleanClip(c);
  // Gallop_Jump's back-LEFT leg is keyed with a zig-zag: hip, BackLeg, upper
  // and lower leg all jump out of line at the SAME keys (0.08, 0.17, 0.50 s, up
  // to 18°) and back — the leg visibly shakes after Space. The right side is
  // smooth. Low-pass the clip's leg tracks; first/last keys stay (the gallop
  // hand-over still matches).
  if (clips.Gallop_Jump) smoothLegTracks(clips.Gallop_Jump, 2);
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

  let foot, jump, tips;
  // Measure gaits on a throwaway mixer.
  const gait = {};
  {
    const mixer = new THREE.AnimationMixer(model);
    const footTracks = {};
    const measureGait = (name) => {
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
      footTracks[name] = tr;
    };
    for (const name of ["Walk", "Gallop", "Idle"]) measureGait(name);
    // TROT from the walk: each leg re-timed so diagonal pairs move together
    // (FL+BR, then FR+BL), plus a body bounce on each diagonal beat.
    clips.Trot = buildTrot(clips.Walk, footTracks.Walk, s);
    measureGait("Trot");
    // CANTER: the gallop clip, its own action (played slower)
    clips.Canter = clips.Gallop.clone(); clips.Canter.name = "Canter";
    gait.Canter = { ...gait.Gallop };
    // Gallop_Jump: when are all four hooves off the ground? The clip barely
    // leaves the floor, so the controller adds a real ballistic arc there.
    {
      const clip = clips.Gallop_Jump, act = mixer.clipAction(clip);
      act.play();
      const N = 120, lows = [], lowF = [], lowH = [];
      for (let i = 0; i < N; i++) {
        mixer.setTime((i / N) * clip.duration);
        rig.updateMatrixWorld(true);
        lows.push(Math.min(...FEET.map((f) => wp(f).y)));
        lowF.push(Math.min(wp("FFL").y, wp("FFR").y));
        lowH.push(Math.min(wp("FFBL").y, wp("FFBR").y));
      }
      act.stop();
      const ref = Math.min(...lows), air = lows.map((y) => y > ref + 0.05 * height);
      let best = [0.35, 0.65], run = -1;
      for (let i = 0; i <= N; i++) {
        if (i < N && air[i]) { if (run < 0) run = i; }
        else if (run >= 0) { if ((i - run) / N > best[1] - best[0] || best[0] === 0.35) best = [run / N, i / N]; run = -1; }
      }
      // how high the LOWEST hoof is above the ground, through the clip (m) — the
      // horse's real clearance, used so obstacles only block what it cannot clear
      jump = { t0: best[0] * clip.duration, t1: best[1] * clip.duration, clear: lows.map((y) => Math.max(0, y - ref)), clearF: lowF.map((y) => Math.max(0, y - ref)), clearH: lowH.map((y) => Math.max(0, y - ref)), duration: clip.duration };
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
    // Each hoof hangs off an IK bone that is NOT in the leg chain. Store where
    // it sits in its leg's last bone, standing: the controller keeps it there.
    tips = TIP_LEGS.map(([leg, ik]) => ({ leg, ik, off: bone(leg).worldToLocal(wp(ik)) }));
    foot = { fz: (wp("FFL").z + wp("FFR").z) / 2, hz: (wp("FFBL").z + wp("FFBR").z) / 2, x: Math.abs(wp("FFL").x - wp("FFR").x) / 2, sole: (wp("FFL").y + wp("FFBL").y) / 2,
      shY: wp("FrontUpperLegL").y, shZ: wp("FrontUpperLegL").z,
      hipY: (wp("BackLegL").y + wp("BackLegR").y) / 2, hipZ: (wp("BackLegL").z + wp("BackLegR").z) / 2 };
    mixer.stopAllAction();
    mixer.uncacheRoot(model);
    rig.updateMatrixWorld(true);
  }

  return { rig, model, clips, bone, gait, halfLen, halfWid, foot, jump, tips, height, scale: s };
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
    this.blendLog = [];                                      // every crossfade: from, to, pose difference (audit)
    this.jumpQueued = false;
    this.rearT = -1; this.rearA = 0; this.rearPitch = 0; this.rearDy = 0;
    this.rearFold = 0; this.rearPaw = 0; this.rearToss = 0; this.landT = -1;
    this.rearLeg = REAR_LEGS.map(() => ({ A: 0, fold: 0, paw: 0, toss: 0 }));
    this.touched = [...this.legs.flatMap((g) => [g.u, g.l, g.cannon, g.ik].filter(Boolean)), ...this.necks, this.headB].map((b) => ({ b, p: b.position.clone(), q: b.quaternion.clone() }));
    this.bodyOff = 0;
    this.switchTo("Idle", 0, true);
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
    this.ikCorr = 0;
    const fwd = new V3(0, 0, 1).applyQuaternion(r.quaternion);
    const untilt = new THREE.Quaternion().setFromAxisAngle(new V3(0, 1, 0), this.yaw).multiply(r.quaternion.clone().invert());
    this.legs.forEach((g, li) => {
      if (g.w < 0.01 && !g.cannon && !(g.under > 0)) return;   // front legs folded by the rear: leave them
      // A hoof goes up only as far as it must to clear the ground: planted
      // (hA ≈ 0) it takes the whole offset; mid-stride, already lifted by the
      // clip, it takes only what is left — else bumps get stepped over twice.
      let d = ((g.delta > 0 ? Math.max(0, g.delta - g.hA) : g.delta) - this.bodyOff) * g.w;
      // no hoof is ever left under the ground — front or hind, whatever the IK
      // weight (blends into a new gait, landing while IK fades back in)
      // (under was measured before the body sank by bodyOff: add that back)
      const needUp = g.under - this.bodyOff;
      if (needUp > 0.01 && !(g.cannon && this.rearT >= 0)) d = Math.max(d, needUp);   // ≤ 1 cm into the ground is invisible
      const C = g.ik.getWorldPosition(new V3());
      const T = C.clone(); T.y += d;
      if (g.cannon && this.rearT >= 0 && this.rearPlant) T.copy(this.rearFoot(li - 2));
      // front hooves stay exactly where they stand while the horse gathers,
      // released as that leg's own push-off starts
      if (!g.cannon && this.rearT >= 0 && this.rearPlantF && this.rearT < HP.rearPrep + HP.rearRise) {
        const pin = 1 - smooth01((this.rearA - 0.09) / 0.3);
        if (pin > 0) T.lerp(this.rearPlantF[li], pin);
      }   // rearing: hind hooves step under, stay planted, step back — never slide
      // Nothing to correct (flat ground, no rear): leave the leg exactly as the
      // clip has it. Re-solving anyway re-bent joints 8–37° (the audit's
      // "IK on flat ground" check), worst while leaning into gallop turns.
      // (a hoof 1 cm into the ground is invisible; a near-straight leg turns a
      // few mm of correction into several degrees of knee — leave it alone)
      this.ikCorr = Math.max(this.ikCorr, T.distanceTo(C));   // biggest correction asked this frame (audit)
      if (T.distanceToSquared(C) < 0.01 * 0.01 && !(needUp > 0.01)) return;
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

  // Best gait-to-gait hand-overs, precomputed: for each moment of the outgoing
  // loop, where to start the incoming one (least pose difference) and how
  // different the poses still are. Blending far-apart poses shows thin,
  // misplaced legs (measured: Gallop→Walk ~265°, best 93° at gallop 0).
  transition(from, to) {
    this.trans ??= {};
    const key = from + ">" + to;
    if (!this.trans[key]) {
      const A = this.h.clips[from], B = this.h.clips[to], N = 32, M = 48, rows = [];
      for (let i = 0; i < N; i++) {
        const ta = i / N * A.duration;
        let best = Infinity, tb = 0;
        for (let k = 0; k < M; k++) { const t = k / M * B.duration, d = poseDiff(A, ta, B, t); if (d < best) { best = d; tb = t; } }
        rows.push({ deg: best, at: tb });
      }
      this.trans[key] = rows;
    }
    return this.trans[key];
  }

  // Change gait. With smart hand-overs the switch waits (up to HP.blendWait s)
  // for the moment of the outgoing stride that matches the new gait best, and
  // the new gait starts at its matching pose. Returns true once switched.
  switchTo(name, fade = HP.fade, force = false) {
    const prev = this.cur;
    let startAt = 0;
    if (prev && HP.phaseMatch && LOOPS.includes(this.gaitName) && LOOPS.includes(name) && this.gaitName !== name) {
      const rows = this.transition(this.gaitName, name), A = prev.getClip(), N = rows.length;
      const iNow = Math.floor(((prev.time % A.duration) / A.duration) * N) % N;
      const bestDeg = Math.min(...rows.map((r) => r.deg));
      const waitedEnough = (this.blendWaitT = (this.blendWaitT ?? 0) + (this.lastDt ?? 0)) > HP.blendWait * (name === "Idle" ? 1.8 : 1);   // a stop may take a last step
      // the outgoing loop is long and calm (Idle): every moment is alike — no wait
      const calm = this.gaitName === "Idle";
      if (!force && !calm && !waitedEnough && rows[iNow].deg > bestDeg + 15) return false;
      startAt = rows[iNow].at;
    }
    this.blendWaitT = 0;
    const next = this.act(name);
    next.reset();
    next.time = startAt;
    next.setLoop(THREE.LoopRepeat, Infinity);
    next.clampWhenFinished = false;
    next.play();
    if (prev && prev !== next) { this.logBlend(prev, next); prev.crossFadeTo(next, fade, false); }
    this.cur = next;
    this.gaitName = name;
    return true;
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

  // Height of the lowest hoof above the take-off ground right now (m): the
  // clip's own clearance at this moment of the jump plus any extra arc.
  jumpClearance() {
    if (!(this.oneShot && this.oneShotName === "Gallop_Jump")) return 0;
    const j = this.h.jump, n = j.clear.length;
    const i = Math.min(n - 1, Math.max(0, Math.floor(this.oneShot.time / j.duration * n)));
    return j.clear[i] + this.lift;
  }

  startRear() {
    if (this.oneShot && ["Idle_2", "Idle_Headlow", "Eating"].includes(this.oneShotName)) this.endOneShot();   // fidgets may be cut
    if (this.oneShot || this.rearT >= 0 || Math.abs(this.v) > 1.6) return false;
    this.rearT = 0;
    this.rearPlant = this.legs.slice(2).map((g) => g.ik.getWorldPosition(new V3()));
    this.rearPlantF = this.legs.slice(0, 2).map((g) => g.ik.getWorldPosition(new V3()));   // front hooves: pinned until each one pushes off   // where the hind hooves stand at the start
    return true;
  }

  logBlend(from, to) {
    const d = poseDiff(from.getClip(), from.time, to.getClip(), to.time);
    this.blendLog.push({ from: from.getClip().name, to: to.getClip().name, deg: Math.round(d) });
    if (this.blendLog.length > 200) this.blendLog.shift();
  }

  // Space while galloping: the jump clip begins at gallop frame 0 (pose
  // difference 0°; mid-stride it is up to ~470° and the blend shows thin,
  // misplaced legs). So queue it and take off at the start of the next stride.
  // Distance (m, from the horse's centre) to the nearest thing ahead it would
  // have to jump: a fence/rock/wall face, or a rise in the ground (a platform
  // edge). null if the way is clear for `range` m.
  obstacleAhead(range) {
    const fwd = new V3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    const left = new V3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const down = new V3(0, -1, 0);
    let best = null;
    // across the horse's width (an angled approach meets the fence off-centre),
    // and at every 15 cm of height: a split-rail fence is mostly GAPS — three
    // rays at 0.3 / 0.7 / 1.1 m slipped between its rails and saw nothing.
    // The obstacle's top is the highest top found near the first face hit (a
    // post beside a rail counts: the hooves pass over both).
    const hits = [];
    for (const side of [-0.35, 0, 0.35]) for (let up = 0.2; up <= 1.65; up += 0.15) {
      const o = this.pos.clone().addScaledVector(left, side); o.y = this.y + up;
      this.ray.set(o, fwd); this.ray.far = range;
      const hit = this.ray.intersectObjects(this.nearList("blockers"), false)[0];
      if (!hit) continue;
      const pt = hit.point.clone().addScaledVector(fwd, 0.04);
      this.ray.set(new V3(pt.x, pt.y + 6, pt.z), down); this.ray.far = 12;
      const topHit = this.ray.intersectObjects(this.nearList("blockers"), false)[0];
      hits.push({ dist: hit.distance, top: (topHit ? topHit.point.y : hit.point.y) - this.y });
    }
    if (hits.length) {
      const d0 = Math.min(...hits.map((h) => h.dist));
      best = { dist: d0, top: Math.max(...hits.filter((h) => h.dist < d0 + 0.8).map((h) => h.top)), depth: 0.15 };
      // its DEPTH: down rays past the front face (an oxer's back rail is 1.2 m
      // further, a log pile 0.6 m) — gaps under 1.5 m belong to the same obstacle
      let last = 0;
      for (let s = 0.05; s <= 3; s += 0.15) {
        if (s - last > 1.5) break;
        let topS = -Infinity;
        for (const side of [-0.35, 0, 0.35]) {
          const p = this.pos.clone().addScaledVector(fwd, d0 + s).addScaledVector(left, side);
          this.ray.set(new V3(p.x, this.y + 6, p.z), down); this.ray.far = 6 - 0.3;
          const hh = this.ray.intersectObjects(this.nearList("blockers"), false)[0];
          if (hh) topS = Math.max(topS, hh.point.y - this.y);
        }
        if (topS > 0.3) { last = s; best.top = Math.max(best.top, topS); }
      }
      best.depth = Math.max(best.depth, last);
    }
    for (let s = 0.5; s <= range && (!best || s < best.dist); s += 0.25) {
      const p = this.pos.clone().addScaledVector(fwd, s);
      const h = this.sampleGround(p.x, p.z, this.y, 10);
      if (h !== null && h - this.y > HP.stepMax) { best = { dist: s, top: h - this.y, depth: 0.15 }; break; }   // a bank: landed ON, so only its edge is crossed
    }
    return best;
  }

  // Can the horse get its front hooves over this (top: m above the ground)?
  jumpable(o) {
    if (!o) return false;
    if (this.peakFrontFor !== HP.jumpHeight) this.peakFront = undefined;
    this.peakFrontFor = HP.jumpHeight;
    if (this.peakFront === undefined) { const b = this.jumpBoost; this.jumpBoost = 0; let m = 0; for (let t = this.h.jump.t0; t <= this.h.jump.t1; t += 0.01) m = Math.max(m, this.clearanceAt(t, "front")); this.peakFront = m; this.jumpBoost = b; }
    // anything up to what the arc can be raised to (fitJump adds the height a
    // given obstacle needs, up to HP.jumpBoostMax)
    return o.top > 0.35 && o.top < this.peakFront + HP.jumpBoostMax * 0.3;    // (the arc only rises by part of its boost where the hooves cross; measured: 1.4 m clears, 1.6 m refuses)
  }

  // At take-off: raise this jump's arc as much as THIS obstacle needs, so the
  // front AND hind hooves are above it (+ margin) when each one gets there —
  // a late take-off or a post a few cm taller than the rails no longer means
  // hooves through the top rail (and a refusal at the last moment).
  fitJump() {
    this.jumpBoost = 0;
    this.jumpObs = null;
    const o = this.obstacleAhead(7);
    if (!o || !this.jumpable(o)) return;
    // remembered in the world: the jump only lets THIS obstacle pass under it
    // (a second fence just after the landing still has to be jumped)
    const fwd = new V3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    this.jumpObs = { ...o, near: this.pos.clone().addScaledVector(fwd, o.dist), fwd };
    const j = this.h.jump, a = this.oneShot, ft = this.h.foot;
    const v = Math.max(Math.abs(this.v), this.gallopV() * 0.6);
    // the arc height sets the air time, and the air time where the hooves are
    // when they reach the obstacle: raise in small passes until every hoof clears
    for (let pass = 0; pass < 4; pass++) {
      let need = 0;
      for (const z of [ft.fz, ft.hz]) for (const dd of [-0.25, 0, o.depth / 2, o.depth, o.depth + 0.25]) {   // its near face, middle, far side — ±25 cm: the two hooves of a pair are that far apart at the gallop
        const tf = this.jumpClipTimeAfter(a.time, Math.max(0, o.dist + dd - z) / v);
        if (tf <= j.t0 || tf >= j.t1) continue;               // reaches it on the ground (run-up / landing): nothing an arc can fix
        const u = (tf - j.t0) / (j.t1 - j.t0), shape = 4 * u * (1 - u);
        const short = o.top + HP.jumpMargin - this.clearanceAt(tf, z === ft.fz ? "front" : "hind");   // (with the boost so far)
        if (short > 0 && shape > 0.15) need = Math.max(need, short / shape);
      }
      if (need < 0.005) break;
      this.jumpBoost = Math.min(HP.jumpBoostMax, this.jumpBoost + need);
    }
  }

  // Seconds in the air for this jump: the clip's own flight, longer for a
  // higher arc (t = √(8h/g) for the extra height), and at least long enough to
  // carry the whole horse over a deep obstacle (an oxer: its depth + the
  // horse's own front-to-hind length).
  airTime() {
    if (this.jumpAirFixed) return this.jumpAirFixed;          // fitted to the obstacle at take-off
    const j = this.h.jump, h = HP.jumpHeight + (this.jumpBoost ?? 0);
    return Math.max(j.t1 - j.t0, h > 0 ? Math.sqrt(8 * h / 9.8) : 0, this.jumpAirMin ?? 0);
  }
  // where in the clip's flight (0 take-off … 1 landing) the hooves are highest
  flightPeakU() {
    if (this._peakU === undefined) {
      const j = this.h.jump, b = this.jumpBoost; this.jumpBoost = 0;
      let tP = j.t0, cP = -1;
      for (let t = j.t0; t <= j.t1; t += 0.005) { const c = this.clearanceAt(t); if (c > cP) { cP = c; tP = t; } }
      this.jumpBoost = b; this._peakU = (tP - j.t0) / (j.t1 - j.t0);
    }
    return this._peakU;
  }
  // The flight an obstacle wants: the clip's own, long enough to carry the
  // horse over its depth, and longer for a higher arc (t = √(8h/g)).
  idealAir(o) {
    const j = this.h.jump;
    return Math.max(j.t1 - j.t0, this.airFor(o), Math.sqrt(8 * (HP.jumpHeight + Math.max(0, o.top - 0.95)) / 9.8));
  }
  airFor(o) {
    const ft = this.h.foot, v = Math.max(Math.abs(this.v), this.gallopV() * 0.6);
    return o ? (o.depth + ft.fz - ft.hz + 0.7) / v : 0;
  }

  // Where to enter the jump clip's RUN-UP from this moment of the gallop/canter
  // stride (clip time t): the run-up pose closest to it (a table per clip,
  // 32 stride phases), so a take-off at any phase blends between like poses.
  jumpEntry(t) {
    const A = this.cur.getClip(), n = 32, B = this.h.clips.Gallop_Jump, t0 = this.h.jump.t0;
    this.entryTab ??= {};
    if (!this.entryTab[A.name]) {
      const tab = [];
      for (let i = 0; i < n; i++) {
        const ta = i / n * A.duration;
        let best = Infinity, tb = 0;
        for (let k = 0; k <= 24; k++) { const tt = k / 24 * (t0 - 0.12), d = poseDiff(A, ta, B, tt); if (d < best) { best = d; tb = tt; } }
        tab.push(tb); (this.entryDeg ??= {})[A.name + i] = best;   // how far apart the two poses are (°)
      }
      this.entryTab[A.name] = tab;
    }
    const i = ((Math.floor(t / A.duration * n) % n) + n) % n;
    this.lastEntryDeg = this.entryDeg[A.name + i];
    return this.entryTab[A.name][i];
  }

  // Seconds from now to take-off so the horse's centre is over the obstacle's
  // middle at the top of the arc. No obstacle: the wind-up.
  jumpWindupFor(o) {
    const dist = o ? o.dist + o.depth / 2 : null;
    if (dist === null) return HP.jumpWindup;
    const j = this.h.jump, v = Math.max(this.v, 1);
    let tPeak = j.t0, cPeak = -1;
    for (let t = j.t0; t <= j.t1; t += 0.01) { const c = this.clearanceAt(t); if (c > cPeak) { cPeak = c; tPeak = t; } }
    const airRate = (j.t1 - j.t0) / this.airTime();
    const W = dist / v - j.t0 / HP.jumpLeadIn - (tPeak - j.t0) / airRate;
    return clamp(W, 0.12, 1.6);
  }

  gallopLike() { return this.gaitName === "Gallop" || this.gaitName === "Canter"; }

  // Target ground speed of each gear (m/s), slowest first.
  gearSpeeds() {
    const g = this.h.gait;
    const k = HP.speedScale;
    return [g.Walk.speed * k, g.Walk.speed * HP.trotRate * k, g.Gallop.speed * HP.canterRate * k, g.Gallop.speed * k];
  }
  // the gallop gear's ground speed (m/s)
  gallopV() {
    return this.h.gait.Gallop.speed * HP.speedScale;
  }

  queueJump() {
    // also while still speeding up into the gallop (Space pressed early): wait up to 1.2 s;
    // and while LANDING a jump (a bounce / a short related distance: the next take-off chains on)
    if (this.rearT < 0 && (!this.oneShot || this.oneShotName.startsWith("Idle") || this.descending()) && (this.gallopLike() || this.lastRun)) {
      this.jumpQueued = true; this.jumpQueueT = 2.2; this.jumpRate = undefined; this.jumpSkipWrap = undefined;
      const o = this.obstacleAhead(10);
      this.jumpAtObs = !!(o && this.jumpable(o));             // an obstacle: the take-off is placed by distance
    }
  }
  // in the landing part of a jump (hooves coming down): may chain into the next one
  landing() { return !!(this.oneShot && this.oneShotName === "Gallop_Jump" && this.oneShot.time > this.h.jump.t1 - 0.02); }
  // past the top of a jump: the next one may be queued (it takes off once landed)
  descending() { return !!(this.oneShot && this.oneShotName === "Gallop_Jump" && this.oneShot.time > (this.h.jump.t0 + this.h.jump.t1) / 2); }

  // A jump straight out of a landing: the same clip again, through a second
  // copy of it (an action cannot crossfade into itself).
  chainJump(at, fade) {
    const A = this.h.clips.Gallop_Jump, cur = this.oneShot;
    const clip = cur.getClip() === A ? (this._jumpB ??= A.clone()) : A;
    const a = this.mixer.clipAction(clip);
    a.reset(); a.time = at; a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; a.setEffectiveTimeScale(1); a.play();
    this.logBlend(cur, a);
    cur.crossFadeTo(a, fade, false);
    this.oneShot = a; this.cur = a; this.holdSpeed = true;
  }

  playOneShot(name, { holdSpeed = false, fade = 0.2, at = 0 } = {}) {
    if (this.rearT >= 0) return;
    if (this.oneShot && ["Idle_2", "Idle_Headlow"].includes(this.oneShotName) && name !== this.oneShotName) this.oneShot = null;   // idle fidgets may be cut by any action
    if (this.oneShot || !this.h.clips[name]) return;
    const a = this.act(name);
    a.reset();
    a.time = at;
    a.setLoop(THREE.LoopOnce, 1);
    a.clampWhenFinished = true;
    a.setEffectiveTimeScale(1);
    a.play();
    if (this.cur && this.cur !== a) { this.logBlend(this.cur, a); this.cur.crossFadeTo(a, fade, false); }
    this.oneShot = a;
    this.oneShotName = name;
    this.holdSpeed = holdSpeed;
    this.cur = a;
  }

  endOneShot() {
    const S = this.gearSpeeds();
    let gi = 0;
    while (gi < GEARS.length - 1 && this.v > (S[gi] + S[gi + 1]) / 2) gi++;
    const back = Math.abs(this.v) < 0.05 ? "Idle" : GEARS[gi];
    const a = this.oneShot;
    this.oneShot = null;
    const next = this.act(back);
    next.reset().setLoop(THREE.LoopRepeat, Infinity);
    next.play();
    this.logBlend(a, next);
    a.crossFadeTo(next, 0.25, false);
    this.cur = next;
    this.gaitName = back;
    this.idleT = 0;
  }

  // The world's ground / blockers within reach of the horse (16 m), refreshed
  // when it has moved a metre or a new frame began. Every ray tests only these:
  // testing the whole level made a gallop on the farm cost 16 ms of CPU a frame.
  // (Level objects are static: their world bounding spheres are cached.)
  nearList(kind) {
    const c = (this._near ??= {}), e = c[kind], x = this.pos.x, z = this.pos.z;
    if (e && e.f === this._frame && Math.abs(e.x - x) < 1 && Math.abs(e.z - z) < 1) return e.list;
    const list = this.world[kind].filter((o) => {
      let ws = o.userData._ws;
      if (!ws) {
        if (!o.geometry.boundingSphere) o.geometry.computeBoundingSphere();
        if (o.isInstancedMesh && !o.boundingSphere) o.computeBoundingSphere();
        o.updateMatrixWorld(true);
        ws = o.userData._ws = (o.isInstancedMesh ? o.boundingSphere : o.geometry.boundingSphere).clone().applyMatrix4(o.matrixWorld);
      }
      return Math.hypot(ws.center.x - x, ws.center.z - z) < 16 + ws.radius;
    });
    c[kind] = { f: this._frame, x, z, list };
    return list;
  }

  // Down ray from `up` metres above yRef. Starting INSIDE a solid misses it,
  // so the step test (below) casts from high up.
  sampleGround(x, z, yRef, up = 1.2) {
    this.ray.set(new V3(x, yRef + up, z), new V3(0, -1, 0));
    this.ray.far = up + 7;
    const hit = this.ray.intersectObjects(this.nearList("ground"), false)[0];
    return hit ? hit.point.y : null;
  }

  // Hoof clearance (m above the take-off ground) at a given time of the jump
  // clip: the clip's own lowest-hoof height plus the extra arc.
  clearanceAt(clipT, feet = "all") {
    const j = this.h.jump, n = j.clear.length;
    const arr = feet === "front" ? j.clearF : feet === "hind" ? j.clearH : j.clear;
    const i = Math.min(n - 1, Math.max(0, Math.floor(clipT / j.duration * n)));
    let lift = 0;
    if (clipT > j.t0 && clipT < j.t1) { const u = (clipT - j.t0) / (j.t1 - j.t0); lift = 4 * (HP.jumpHeight + (this.jumpBoost ?? 0)) * u * (1 - u); }
    return arr[i] + lift;
  }

  // The clearance the hooves will have when they reach something `dist` m
  // ahead (0 when not jumping): the jump is predicted, not sampled now.
  clearanceIn(dist, feet = "all") {
    if (!(this.oneShot && this.oneShotName === "Gallop_Jump")) return 0;
    // speed: the jump carries its gallop speed (a block this frame must not
    // make the prediction think it will never get there)
    const v = Math.max(Math.abs(this.v), this.gallopV() * 0.6), a = this.oneShot;
    const tf = this.jumpClipTimeAfter(a.time, Math.max(0, dist) / v);
    return tf >= a.getClip().duration ? 0 : this.clearanceAt(tf, feet);
  }

  // Where the jump clip will be after `secs` of real time, stepping through
  // its speeds: quick run-up, the flight (stretched to the air time), landing.
  jumpClipTimeAfter(t, secs) {
    const j = this.h.jump;
    const airT = this.airTime();
    const phases = [[j.t0, this.jumpLead || HP.jumpLeadIn], [j.t1, (j.t1 - j.t0) / airT], [Infinity, 1]];
    for (const [end, rate] of phases) {
      if (t >= end) continue;
      const need = (end - t) / rate;
      if (secs <= need) return t + secs * rate;
      secs -= need; t = end;
    }
    return t;
  }

  blockedAhead(dir) {
    const { halfLen } = this.h;
    const fwd = new V3(Math.sin(this.yaw), 0, Math.cos(this.yaw)).multiplyScalar(dir);
    const left = new V3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    // Step test: the ground just past the chest must not be a wall — unless
    // the hooves will be above it when they get there (jumping onto it).
    // look further ahead the faster we go: a galloping stride reaches ~1 m past
    // the chest, so a refusal must stop before the legs get to the wall
    const reach = halfLen + 0.35 + Math.min(1, Math.abs(this.v) * 0.2);
    const ahead = this.pos.clone().addScaledVector(fwd, reach);
    const h = this.sampleGround(ahead.x, ahead.z, this.y, 10);
    // a step the legs can take, or a rise the front hooves will be ABOVE when they get there
    if (h === null) return true;
    const rise = h - this.y;
    // Once committed to a jump, anything the horse can clear at the top of its
    // arc does not block (forgiving, like horse games: an angled approach meets
    // the fence a little before the peak and failed by a centimetre).
    const committed = this.oneShot && this.oneShotName === "Gallop_Jump" && this.oneShot.time < this.h.jump.t1;
    // (the arc THIS jump flies: the clip's peak plus the height fitJump added)
    // a jump pending at a jumpable obstacle goes at the edge of this range
    // (later this frame): it must not be refused first
    const pending = this.jumpQueued && this.jumpAtObs;
    const canClear = (top, at) => {
      if (pending && top > 0 && this.jumpable({ top }) && (!at || Math.hypot(at.x - this.pos.x, at.z - this.pos.z) > this.h.halfLen + 0.5)) return true;
      if (!committed || !(top > 0 && top < this.peakFront + (this.jumpBoost ?? 0) - 0.05)) return false;
      const J = this.jumpObs;
      if (!J || !at) return true;                              // a jump with nothing fitted (Space in the open), or a ground rise
      const s = at.clone().sub(J.near).dot(J.fwd);             // along the jump from the obstacle's front face
      return s > -0.6 && s < J.depth + 0.6 && top < J.top + 0.06;
    };
    if (committed && this.peakFront === undefined) this.jumpable({ top: 1 });   // measures peakFront
    if (rise > HP.stepMax && !canClear(rise) && rise > this.clearanceIn(reach - this.h.foot.fz, "front") - 0.05) return true;
    // Fences, walls, arches, rocks: for each hit, find the obstacle's TOP and
    // block only if it is higher than the hooves will be when they reach it.
    const down = new V3(0, -1, 0);
    this.ray.far = halfLen + 0.8 + Math.min(1, Math.abs(this.v) * 0.2);
    // every 15 cm of height (rays at 0.3 / 0.6 / 1.0 / 1.4 m slipped between
    // the poles of a 0.8 m fence: the horse walked through it)
    for (let up = 0.2; up <= 1.65; up += 0.15) for (const side of [-0.3, 0, 0.3]) {
      const o = this.pos.clone().addScaledVector(left, side);
      o.y = this.y + up;
      this.ray.set(o, fwd);
      const hit = this.ray.intersectObjects(this.nearList("blockers"), false)[0];
      if (!hit) continue;
      const p = hit.point.clone().addScaledVector(fwd, 0.04);
      this.ray.set(new V3(p.x, p.y + 6, p.z), down);
      this.ray.far = 12;
      const topHit = this.ray.intersectObjects(this.nearList("blockers"), false)[0];
      this.ray.far = halfLen + 0.8 + Math.min(1, Math.abs(this.v) * 0.2);
      const top = topHit ? topHit.point.y : hit.point.y;
      if (top - this.y < HP.stepOver) continue;              // a ground pole, a kerb: the horse steps over it
      // front hooves reach it first, hind hooves ~1.1 m later — each must be
      // above it when IT gets there (the lowest hoof at take-off is a hind one)
      if (canClear(top - this.y, hit.point)) continue;
      const ft = this.h.foot, rise = top - this.y + 0.05;
      if (rise > this.clearanceIn(hit.distance - ft.fz, "front")) return true;
      if (rise > this.clearanceIn(hit.distance - ft.hz, "hind")) return true;
    }
    return false;
  }

  // input: { fwd: -1..1, turn: -1..1, run: bool }
  update(dt, input) {
    this.lastDt = dt;
    this._frame = (this._frame ?? 0) + 1;
    input = { fwd: input?.fwd ?? 0, turn: input?.turn ?? 0, run: !!input?.run, gearUp: !!input?.gearUp, gearDown: !!input?.gearDown };   // missing fields = 0 (an empty input once turned the yaw into NaN)
    this.lastRun = !!input.run && input.fwd > 0;
    // Auto-jump: galloping toward something it can clear, the horse commits to
    // the jump itself; the take-off spot is then placed by jumpWindupFor().
    if (HP.autoJump && this.gallopLike() && input.fwd > 0 && (!this.oneShot || this.descending()) && !this.jumpQueued && this.rearT < 0 && this.v > this.gallopV() * 0.65) {
      this.autoT = (this.autoT ?? 0) + 1;
      if (this.autoT % 3 === 0) {
        const o = this.obstacleAhead(HP.autoJumpRange);
        if (o && o.dist > 1.2 && this.jumpable(o)) this.queueJump();   // (closer than the take-off spot: the trigger goes at once)
      }
    }
    const g = this.h.gait, walkV = g.Walk.speed, galV = g.Gallop.speed;
    const busy = (this.oneShot && !this.holdSpeed) || this.rearT >= 0;

    // Speed
    // Gears: tap up / down; holding the sprint key gallops while held;
    // standing still puts the gear back to walk.
    const S = this.gearSpeeds();
    if (input.gearUp) this.gear = Math.min(GEARS.length - 1, (this.gear ?? 0) + 1);
    if (input.gearDown) this.gear = Math.max(0, (this.gear ?? 0) - 1);
    if (input.fwd <= 0 && Math.abs(this.v) < 0.05) this.gear = 0;
    this.effGear = input.run ? GEARS.length - 1 : (this.gear ?? 0);
    let target = 0;
    if (!busy) {
      if (input.fwd > 0) target = S[this.effGear];
      if (this.oneShot && this.oneShotName === "Gallop_Jump") target = Math.max(target, this.gallopV() * 0.98);   // the jump is ridden at gallop speed
      else if (input.fwd < 0) target = -walkV * 0.55;
    }
    const acc = Math.abs(target) > Math.abs(this.v) ? HP.accel : HP.decel;
    this.v += clamp(target - this.v, -acc * dt, acc * dt);

    // Turning
    const tr = this.gallopLike() ? HP.turnGallop : this.gaitName === "Trot" ? (HP.turnWalk + HP.turnGallop) / 2 : Math.abs(this.v) > 0.1 ? HP.turnWalk : HP.turnIdle;
    const wantTurn = busy ? 0 : input.turn * tr;
    this.turnRate += (wantTurn - this.turnRate) * lerpK(8, dt);
    this.yaw += this.turnRate * dt;

    // Move (stop dead against walls)
    if (Math.abs(this.v) > 1e-3) {
      this.blocked = this.blockedAhead(Math.sign(this.v));
      if (this.blocked) {
        this.v = 0;
        this.jumpQueued = false;
        // a refusal: blocked before the horse is really in the air cancels the
        // jump (else its legs reach forward into the obstacle while it stands)
        if (this.oneShot && this.oneShotName === "Gallop_Jump" && this.oneShot.time < this.h.jump.t0 + 0.1) this.endOneShot();
      }
      else {
        this.pos.x += Math.sin(this.yaw) * this.v * dt;
        this.pos.z += Math.cos(this.yaw) * this.v * dt;
      }
    } else this.blocked = false;

    // Gait selection (with hysteresis)
    if (!this.oneShot) {
      const turning = Math.abs(this.turnRate) > 0.15;
      // gait from speed: the band of each gear, with hysteresis (±6 %) so
      // it does not flicker between two gaits at a boundary
      let want;
      if (Math.abs(this.v) <= 0.05 && !turning && target === 0) want = "Idle";
      else if (this.v <= 0.05) want = "Walk";
      else {
        let i = Math.max(0, GEARS.indexOf(this.gaitName));
        while (i < GEARS.length - 1 && this.v > (S[i] + S[i + 1]) / 2 * 1.06) i++;
        while (i > 0 && this.v < (S[i - 1] + S[i]) / 2 * 0.94) i--;
        want = GEARS[i];
      }
      if (this.rearT >= 0) want = "Idle";                      // the rear is procedural, on top of Idle
      if (want !== this.gaitName) this.switchTo(want);
      else this.blendWaitT = 0;                              // no change pending: a later request waits afresh
      // Time scale so the hooves match the ground.
      if (this.gaitName === "Walk") {
        // stopping: keep stepping at a normal pace for one last step, so the
        // walk reaches a pose it can stand from (else a 235° blend into Idle)
        const stopping = this.blendWaitT > 0 && Math.abs(this.v) < 0.3;
        const ts = stopping ? 1 : Math.abs(this.v) < 0.05 && turning ? 0.6 : this.v / walkV;
        this.cur.setEffectiveTimeScale(Math.sign(ts || 1) * clamp(Math.abs(ts), 0.35, 1.6));
      } else if (this.gaitName === "Trot") {
        this.cur.setEffectiveTimeScale(clamp(this.v / g.Trot.speed, 1.0, 2.6 * HP.speedScale));
      } else if (this.gallopLike()) {
        let ts = this.gaitName === "Canter" ? clamp(this.v / galV, 0.55, 0.95 * HP.speedScale) : clamp(this.v / galV, 0.6, 1.25 * HP.speedScale);   // (galV: the clip's native speed — with speedScale the legs play faster)
        if (this.jumpQueued) {
          if (this.jumpRate === undefined) {                 // first gallop frame with a jump queued
            const d = this.cur.getClip().duration, left0 = d - (this.cur.time % d);
            // How long until take-off: aimed at the obstacle ahead if there is
            // one (the horse "finds its distance"), else the plain wind-up.
            const o = this.obstacleAhead(10), ok = o && this.jumpable(o);
            this.jumpAirMin = ok ? this.airFor(o) : 0; this.jumpBoost = 0;
            // An obstacle: aim the take-off (a stride start: the jump's run-up
            // matches frame 0 of the stride, a clean blend) where the ideal
            // flight for it would centre its peak over it. Wherever the stride
            // plan actually lands, the flight is then fitted exactly at take-off.
            this.jumpAtObs = !!ok;
            let W = this.jumpWindupFor(null);
            if (ok) {
              const j = this.h.jump, ft = this.h.foot, vJ = Math.max(Math.abs(this.v), this.gallopV() * 0.98);
              // (+0.15 s of flight: the ideal spot sits right at the last-chance
              // line, so a plan aimed AT it lost to that trigger mid-stride)
              const reach = (this.idealAir(o) + 0.15) * vJ * this.flightPeakU() + vJ * j.t0 / HP.jumpLeadIn;
              W = clamp((o.dist + o.depth / 2 - (ft.fz + ft.hz) / 2 - reach) / Math.max(Math.abs(this.v), 0.5), 0.05, 1.6);
            }
            // Pick how many more strides to take so the stride speed stays
            // closest to normal (0.75×–2×), then fit them into W exactly.
            let best = null;
            for (let n = 0; n < 4; n++) {
              const left = left0 + n * d, rate = left / (ts * W);
              const cost = rate < 0.75 || rate > 2 ? 10 + Math.abs(Math.log(rate)) : Math.abs(Math.log(rate));
              if (!best || cost < best.cost) best = { n, rate, cost };
            }
            this.jumpSkipWrap = best.n;
            this.jumpRate = clamp(best.rate, 0.6, 3.2);
            this.jumpQueueT = Math.max(this.jumpQueueT, W + 0.5);
          }
          ts *= this.jumpRate;
        }
        this.cur.setEffectiveTimeScale(ts);
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
    if (this.airborne) {
      // In the air the body keeps its take-off height (the clip and the arc
      // carry it) — it does not snap to whatever is underneath. If the ground
      // below rises above the hooves (landing ON a platform), the body is only
      // lifted as much as needed to keep the hooves on top of it.
      const clearNow = this.jumpClearance();
      if (ty > this.y + clearNow) this.y = ty - clearNow;
    } else {
      const k = ty < this.y ? lerpK(9, dt) : lerpK(14, dt);
      this.y += (ty - this.y) * k;
    }
    const tp = -Math.atan2(gF - gB, Fz - Hz) * HP.pitchFollow;
    const lean = -(this.turnRate / HP.turnGallop) * clamp(this.v / this.gallopV(), 0, 1) * HP.lean;
    const trl = Math.atan2(gL - gR, 2 * Fx) * HP.rollFollow + lean;
    this.pitch += (clamp(tp, -0.45, 0.45) - this.pitch) * lerpK(8, dt);
    this.roll += (clamp(trl, -0.3, 0.3) - this.roll) * lerpK(6, dt);

    // Jump: a ballistic arc over the clip's airborne window, which is slowed
    // so the air time matches the height (t = √(8h/g)); hoof IK off in the air.
    this.lift = 0;
    let airborne = false;
    if (this.oneShot && this.oneShotName === "Gallop_Jump") {
      const { t0, t1 } = this.h.jump, t = this.oneShot.time;
      // The clip already jumps ~1 m (hoof IK used to pull it back down, which
      // is why it once looked flat). Extra height is optional; only then is
      // the air time stretched to match (t = √(8h/g) for the extra arc).
      const airT = this.airTime();
      this.oneShot.setEffectiveTimeScale(t < t0 ? (this.jumpLead || HP.jumpLeadIn) : t <= t1 ? (t1 - t0) / airT : 1);   // quick run-up, then real air time
      if (t >= t0 - 0.06 && t <= t1 + 0.06) airborne = true;
      if (t > t0 && t < t1) { const u = (t - t0) / (t1 - t0); this.lift = 4 * (HP.jumpHeight + (this.jumpBoost ?? 0)) * u * (1 - u); }
    } else { this.jumpBoost = 0; this.jumpObs = null; if (!this.jumpQueued) { this.jumpAirMin = 0; this.jumpAirFixed = 0; this.jumpLead = 0; } }
    this.ikW += ((airborne ? 0 : 1) - this.ikW) * lerpK(14, dt);
    this.airborne = airborne;

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
    this.glueHooves();
    if (this.jumpQueued) {
      this.jumpQueueT -= dt;
      if (this.jumpQueueT < 0 || this.rearT >= 0 || (this.oneShot && !this.oneShotName.startsWith("Idle") && !this.descending())) this.jumpQueued = false;
      else if (this.gallopLike() && (!this.oneShot || this.oneShotName.startsWith("Idle") || this.landing())) {
        const t = this.cur.time % this.cur.getClip().duration;
        // the stride just wrapped to frame 0 (or we first see it right at the start)
        const wrapped = (this.prevGallopT !== undefined && t < this.prevGallopT) || (this.prevGallopT === undefined && t < 0.06);
        // At an obstacle the take-off is placed by DISTANCE, every frame: enter
        // the jump at the moment of its run-up that best matches this stride,
        // and go when the arc's peak would then land over the obstacle's middle.
        // (Waiting for the stride to end and re-timing it missed by a metre or
        // more: hooves through the rails, oxers landed in.)
        let fire = wrapped && this.jumpSkipWrap <= 0, at = t, fade = 0.06;
        if (wrapped && this.jumpSkipWrap > 0) this.jumpSkipWrap--;
        if (this.jumpAtObs) {
          const onStride = fire;                                // the planned stride start
          fire = false;
          const o = this.obstacleAhead(9);
          if (o && this.jumpable(o)) {
            // (it surges to gallop speed for the jump: a canter's flight is too short to carry the horse's own length)
            const j = this.h.jump, ft = this.h.foot, v = Math.max(Math.abs(this.v), this.gallopV() * 0.98);
            // entering at a stride start: the run-up from frame 0; otherwise the
            // run-up pose closest to this stride moment, played so it lasts the
            // same (the needed flight then changes smoothly frame to frame)
            const e = onStride ? t : this.jumpEntry(t);
            const lead = onStride ? HP.jumpLeadIn : clamp((j.t0 - e) / (j.t0 / HP.jumpLeadIn), 0.8, HP.jumpLeadIn);
            const run = v * Math.max(0, j.t0 - e) / lead;
            const mid = o.dist + o.depth / 2 - (ft.fz + ft.hz) / 2;
            const need = (mid - run) / (v * this.flightPeakU());     // the flight that puts the arc's peak over the obstacle's middle
            // never a refusal at a jumpable obstacle: at the edge of the
            // blocking range it goes, whatever the stride
            const lastChance = o.dist < this.h.halfLen + 0.8 + Math.min(1, v * 0.2) + v * this.lastDt * 2 + 0.1;
            // planned (a stride plan exists): at its stride start; chained out
            // of a landing (no plan): as soon as the flight is down to the ideal
            const planned = this.jumpSkipWrap !== undefined && !this.landing();
            // a last-chance take-off mid-stride only from a pose the jump can blend from
            // (turning into a fence seen inside 2 m: legs snapped across 277° — refuse instead)
            const canBlend = onStride || (this.lastEntryDeg ?? 0) < 170;
            const go = planned ? onStride || (lastChance && canBlend) : need <= this.idealAir(o) || need <= 0.5 || (lastChance && canBlend);
            if (go) {
              fire = true; at = e; fade = onStride ? 0.06 : 0.12;
              this.jumpAirFixed = clamp(need, 0.5, 1.3); this.jumpLead = lead;
            }
          }
        }
        if (fire) {
          this.jumpQueued = false;
          if (this.landing()) this.chainJump(at, fade);
          else this.playOneShot("Gallop_Jump", { holdSpeed: true, fade, at });
          if (this.jumpAtObs) this.v = Math.max(this.v, this.gallopV() * 0.98);   // the surge (see the trigger)
          this.fitJump();
        }
      }
    }
    this.prevGallopT = this.gallopLike() && this.cur ? this.cur.time % this.cur.getClip().duration : undefined;
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

  // The hooves are skinned to IK bones that are NOT children of the legs. The
  // clips keep them together, but any blend (crossfade, gait change, one-shot
  // start) mixes the leg ROTATIONS and the IK bone POSITIONS separately, so the
  // hoof drifted off the leg (measured: 11 cm in the gallop, 25 cm starting a
  // jump) and the skin between stretched thin. Put each IK bone back at its
  // leg's tip every frame; its rotation (the hoof angle) stays the clip's.
  glueHooves() {
    this.h.rig.updateMatrixWorld(true);
    for (const t of this.h.tips) {
      const leg = this.h.bone(t.leg), ik = this.h.bone(t.ik);
      ik.position.copy(ik.parent.worldToLocal(leg.localToWorld(t.off.clone())));
      ik.updateMatrixWorld(true);
    }
  }

  // How fast the clip's planted hooves move vs how fast the body moves (0 = no skating).
  slip() {
    const g = this.h.gait;
    if (this.oneShot || this.gaitName === "Idle") return 0;
    const animV = g[this.gaitName].speed * this.cur.getEffectiveTimeScale();
    return Math.abs(this.v) > 0.05 ? (animV - this.v) / Math.abs(this.v) : 0;
  }
}
