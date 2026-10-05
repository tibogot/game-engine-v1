// ── Horse lab: on foot, mounting and dismounting ─────────────────────────────
// The rider has three lives besides riding:
//
//   ground     the robot on its own feet, driven by its UAL clips (idle / walk /
//              jog), tank controls like the horse; F near the horse mounts
//   approach   F pressed on foot: walks itself to the mounting spot at the
//              horse's shoulder (left side, or right if the left is blocked)
//              and turns to face it
//   mount /    a keyed performance around the SADDLE (so it fits the horse
//   dismount   wherever it stands): the pelvis, the facing, the lean, both feet
//              and both hands each follow their own smooth path, phases
//              overlapping like a real rider —
//                0.0–0.5  left hand to the withers (reins + mane), right hand
//                         to the cantle, left foot up into the stirrup
//                0.8–1.3  spring up on the stirrup leg, lying over the saddle
//                1.3–2.1  right leg swings high over the croup, hips turn
//                         forward
//                2.0–2.6  sit softly, right foot finds its stirrup, hands to
//                         the reins
//              Dismounting plays the same performance backwards (step down via
//              the stirrup), on whichever side is clear.
//
// Limbs reach their targets with the same two-bone IK as riding; the hand-overs
// (ground → mount → riding and back) blend the whole pose over a few tenths of
// a second, so nothing snaps.
import * as THREE from "three";
import { rotateWorld, solveTwoBone } from "./horse.js";
import { solveLeg, levelFoot } from "./rider.js";
import { stirrupGeom } from "./stirrups.js";

const V3 = THREE.Vector3;
const clamp = THREE.MathUtils.clamp;
const lerpK = (rate, dt) => 1 - Math.exp(-rate * dt);
const wpos = (o) => o.getWorldPosition(new V3());
const smooth = (u) => { u = clamp(u, 0, 1); return u * u * (3 - 2 * u); };

export const MP = {
  duration: 2.6,          // s, the whole mount (dismount plays it backwards)
  walkSpeed: 1.35,        // m/s on foot
  jogSpeed: 3.2,
  turnRate: 2.6,          // rad/s on foot
  reach: 3.2,             // m: how close to the horse F mounts
  stand: 0.5,             // m (× k) out from the saddle centre: ~0.35 m from the horse's side, at its shoulder
  letDown: false,
  pull: 0.07,             // m the foot draws the near iron out from the horse's side         // false = the stirrup stays at riding length; the foot must reach it
  mountDrop: 0.18,        // m below the hip the let-down stirrup is taken (natural up to ~10–20 cm below;
                          // at riding length it hung 23–31 cm ABOVE the hip and the hip spun 160°+)
  kneeUp: 0.3,
  crouch: 0,           // m the hips dip while the foot goes up (more dip = the stirrup is relatively higher)           // how much the stirrup leg's knee points UP (toward the chest) while the foot is raised
};

// A path of keys [t, value] evaluated with a smooth (Catmull-Rom) curve; values
// are numbers or [x, y, z] in the saddle frame.
function track(keys) {
  const vec = Array.isArray(keys[0][1]);
  return (t) => {
    if (t <= keys[0][0]) return vec ? new V3(...keys[0][1]) : keys[0][1];
    const n = keys.length;
    if (t >= keys[n - 1][0]) return vec ? new V3(...keys[n - 1][1]) : keys[n - 1][1];
    let i = 0;
    while (keys[i + 1][0] < t) i++;
    const [t1, a1] = keys[i], [t2, a2] = keys[i + 1];
    const a0 = keys[Math.max(0, i - 1)][1], a3 = keys[Math.min(n - 1, i + 2)][1];
    const u = (t - t1) / (t2 - t1);
    // monotone cubic (no overshoot): a key between two keys that do not both
    // rise (or both fall) gets a flat tangent — Catmull-Rom overshot here and
    // dipped a landing foot under the ground (the dismount bounce)
    const h0 = t1 - keys[Math.max(0, i - 1)][0] || 1, h1 = t2 - t1, h2 = keys[Math.min(n - 1, i + 2)][0] - t2 || 1;
    const tan = (pa, pb, pc, ha, hb) => { const d1 = (pb - pa) / ha, d2 = (pc - pb) / hb; return d1 * d2 <= 0 ? 0 : (d1 + d2) / 2; };
    const cr = (p0, p1, p2, p3) => {
      const m1 = tan(p0, p1, p2, h0, h1) * h1, m2 = tan(p1, p2, p3, h1, h2) * h1;
      const u2 = u * u, u3 = u2 * u;
      return (2 * u3 - 3 * u2 + 1) * p1 + (u3 - 2 * u2 + u) * m1 + (-2 * u3 + 3 * u2) * p2 + (u3 - u2) * m2;
    };
    if (!vec) return cr(a0, a1, a2, a3);
    return new V3(cr(a0[0], a1[0], a2[0], a3[0]), cr(a0[1], a1[1], a2[1], a3[1]), cr(a0[2], a1[2], a2[2], a3[2]));
  };
}

// The performance, for the LEFT side (s = +1), in the saddle frame: x = the
// horse's left, y = up (0 = saddle surface), z = forward. `G` = the ground's
// height in that frame, `ph` = the robot's standing pelvis height, `st` = the
// stirrup point (same as riding), `seat` = the riding pelvis height.
function buildMount({ G, ph, st, seat, k, au, pull }) {
  const GA = G + au;                                           // ankle height when the foot is on the ground
  const D = MP.stand;                                         // how far out from the horse the rider stands (× k)
  const stand = [D * k, G + ph, 0.16 * k];
  return {
    pelvis: track([
      [0.0, stand],
      [0.5, [(D - 0.03) * k, G + ph - MP.crouch, 0.12 * k]],          // a slight dip as the foot goes up
      [0.72, [(D - 0.06) * k, G + ph - 0.04, 0.1 * k]],                // weight onto the stirrup foot
      [1.12, [0.44 * k, st.y + 0.62, 0.06 * k]],                // spring up (over the stirrup foot): standing in it, leg straight, hips at saddle height
      [1.3, [0.24 * k, 0.33, 0.0]],                             // over the saddle, lying forward
      [1.75, [0.06 * k, 0.3, -0.04 * k]],                       // the leg goes over
      [2.15, [0.0, seat + 0.05, 0.0]],
      [2.6, [0.0, seat, 0.0]],                                  // seated
    ]),
    yaw: track([[0, -1.85], [0.5, -1.78], [1.0, -1.68], [1.35, -1.45], [1.75, -0.7], [2.15, -0.1], [2.6, 0]]),   // rad: facing the horse → facing forward
    // forward lean: lies over the withers while the leg swings over the croup (counterbalance)
    lean: track([[0, 0.02], [0.5, 0.12], [0.95, 0.42], [1.3, 0.8], [1.6, 0.95], [1.85, 0.55], [2.15, 0.14], [2.6, 0.03]]),
    // the stirrup foot (rider's left on the left side)
    nearFoot: track([
      [0.0, [D * k, GA, 0.29 * k]],
      [0.24, [D * k, GA, 0.29 * k]],
      // the stirrup is let down for mounting (the horse is tall: at its riding
      // length it hangs ABOVE the robot's hip, which forced the knee behind the
      // leg and spun the hip 150°) — the foot goes in just below hip height
      // the foot goes into the REAL stirrup (fixed strap): the iron is pulled
      // out toward the rider, which lifts it a little, foot about 20 cm above
      // the hip — knee high, a slight crouch
      // to where the near iron HANGS (barely pulled out): the foot goes to the
      // stirrup, the stirrup does not fly to the foot
      [0.46, pull(MP.pull + 0.03)],
      [0.6, pull(MP.pull)],
      [0.72, pull(MP.pull)],
      [1.12, [st.x, st.y, st.z]],                               // the iron rises with the rider
      [2.6, [st.x, st.y, st.z]],
    ]),
    // the swinging leg (rider's right on the left side)
    farFoot: track([
      [0.0, [D * k, GA, 0.03 * k]],
      [0.8, [(D - 0.02) * k, GA, 0.03 * k]],                          // pushes off the ground
      [1.05, [0.56 * k, GA + 0.25, -0.08 * k]],
      [1.35, [0.42 * k, -0.08, -0.3 * k]],                      // trailing, lifting behind
      [1.62, [0.12 * k, 0.42, -0.5 * k]],                       // over the croup, knee bent (the leg is ~0.9 m)
      [1.9, [-0.3 * k, -0.12, -0.28 * k]],                      // already dropping down the far side
      [2.35, [-st.x, st.y, st.z]],                              // into the far stirrup
      [2.6, [-st.x, st.y, st.z]],
    ]),
    // hands: near = withers (reins + mane), far = cantle → pommel → rein
    nearHand: track([[0.0, [0.3 * k, -0.25, 0.3 * k]], [0.3, [0.12 * k, 0.15, 0.42 * k]], [1.9, [0.12 * k, 0.15, 0.42 * k]], [2.6, [0.125, 0.25, 0.25]]]),
    farHand: track([[0.0, [0.3 * k, -0.25, 0.0]], [0.38, [0.03 * k, 0.12, -0.24 * k]], [1.2, [0.03 * k, 0.12, -0.24 * k]], [1.5, [0.0, 0.16, 0.16 * k]], [1.95, [0.0, 0.16, 0.16 * k]], [2.6, [-0.125, 0.25, 0.25]]]),
    handW: track([[0.0, 0], [0.3, 1], [2.6, 1]]),             // from hanging arms to IK
    // phase weights (knee directions, stirrups, gaze)
    astride: (T) => smooth((T - 2.0) / 0.4),
    raised: (T) => smooth((T - 0.2) / 0.25) * (1 - smooth((T - 0.9) / 0.25)),
    swing: (T) => smooth((T - 1.05) / 0.3) * (1 - smooth((T - 1.95) / 0.3)),
    look: (T) => clamp(1 - T / 1.6, 0, 1),
    nearIn: (T) => (T > 0.4 ? 1 : 0), farIn: (T) => (T > 2.3 ? 1 : 0),
    duration: 2.6,
    stand,
  };
}

// The DISMOUNT (its own movement, not the mount backwards — like the reference
// game): stand up in the near stirrup, swing the far leg back over the croup
// with the body upright, hang a moment beside the horse, step down far foot
// first, near foot out of the iron, stand.
function buildDismount({ G, ph, st, seat, k, au }) {
  const GA = G + au, D = MP.stand;
  const inStir = [st.x - 0.1 * k, st.y + 0.74, st.z - 0.05];   // standing in the near stirrup
  return {
    pelvis: track([
      [0.0, [0.0, seat, 0.0]],
      [0.45, inStir],
      [0.9, [st.x - 0.06 * k, st.y + 0.77, -0.06 * k]],
      [1.35, [st.x + 0.1 * k, st.y + 0.68, 0.0]],               // beside the horse, still in the stirrup
      [1.8, [(D - 0.06) * k, G + ph - 0.07, 0.08 * k]],          // landed on the far foot, knees soft
      [2.4, [D * k, G + ph, 0.12 * k]],
    ]),
    yaw: track([[0, 0], [0.45, -0.15], [0.9, -0.75], [1.35, -1.55], [1.8, -1.8], [2.4, -1.85]]),
    lean: track([[0, 0.03], [0.45, 0.3], [0.9, 0.42], [1.35, 0.22], [1.8, 0.14], [2.4, 0.02]]),
    nearFoot: track([
      [0.0, [st.x, st.y, st.z]],
      [1.5, [st.x, st.y, st.z]],
      [1.75, [st.x + 0.18 * k, (st.y + GA) / 2, st.z + 0.05]],  // out of the iron, down
      [2.05, [D * k, GA, 0.27 * k]],
      [2.4, [D * k, GA, 0.27 * k]],
    ]),
    farFoot: track([
      [0.0, [-st.x, st.y, st.z]],
      [0.35, [-st.x + 0.06 * k, st.y + 0.08, st.z - 0.1 * k]],  // out of its stirrup
      [0.65, [-0.12 * k, 0.22, -0.48 * k]],                     // lifting behind
      [0.9, [0.1 * k, 0.4, -0.55 * k]],                         // over the croup
      [1.15, [0.36 * k, 0.0, -0.36 * k]],
      [1.4, [0.46 * k, st.y - 0.12, -0.1 * k]],                 // hanging beside the near leg
      [1.75, [(D - 0.02) * k, GA, 0.03 * k]],                   // lands
      [2.4, [D * k, GA, 0.03 * k]],
    ]),
    nearHand: track([[0.0, [0.125, 0.25, 0.25]], [0.3, [0.12 * k, 0.15, 0.42 * k]], [1.6, [0.12 * k, 0.15, 0.42 * k]], [2.4, [0.3 * k, -0.25, 0.3 * k]]]),
    farHand: track([[0.0, [-0.125, 0.25, 0.25]], [0.3, [0.0, 0.16, 0.16 * k]], [0.95, [0.0, 0.16, 0.16 * k]], [1.3, [0.06 * k, 0.12, -0.08 * k]], [1.7, [0.06 * k, 0.12, -0.08 * k]], [2.4, [0.3 * k, -0.25, 0.0]]]),
    handW: track([[0.0, 1], [1.85, 1], [2.4, 0]]),
    astride: (T) => 1 - smooth(T / 0.35),
    raised: () => 0,
    swing: (T) => smooth((T - 0.45) / 0.2) * (1 - smooth((T - 1.25) / 0.2)),
    look: (T) => smooth((T - 1.3) / 0.3) * (1 - smooth((T - 2.05) / 0.3)),
    nearIn: (T) => (T < 1.55 ? 1 : 0), farIn: (T) => (T < 0.3 ? 1 : 0),
    duration: 2.4,
    stand: [D * k, G + ph, 0.12 * k],
  };
}

export class MountSystem {
  constructor(rider) {
    this.rd = rider;
    this.MP = MP;                // the settings THIS page uses (a test importing the module again gets a separate copy)
    const r = rider.r, hc = rider.hc;
    this.mode = "riding";
    this.t = 0;
    this.side = 1;
    // On-foot clips and their measured ground speed.
    const mixer = rider.mixer;
    this.acts = {};
    for (const [key, name] of [["idle", "Idle_Loop_Armature"], ["walk", "Walk_Loop_Armature"], ["jog", "Jog_Fwd_Loop_Armature"]]) {
      const c = r.clips[name];
      if (c) this.acts[key] = mixer.clipAction(c);
    }
    this.measure();
    this.gpos = new V3(); this.gyaw = 0; this.gv = 0;
    this.blend = null;           // { snap, t, dur } pose to blend away from
    this.cur = null;             // current on-foot action
    this.hc = hc;
  }

  // Standing pelvis height and walk / jog speeds, from the clips (like the
  // horse's gaits): a planted foot slides back at exactly the ground speed.
  measure() {
    const r = this.rd.r, rig = r.rig;
    const saveP = rig.position.clone(), saveQ = rig.quaternion.clone();
    rig.position.set(0, 0, 0); rig.quaternion.identity();
    const m = new THREE.AnimationMixer(r.model);
    const sole = () => { let lo = 1e9; for (const f of ["ball_l", "ball_r", "foot_l", "foot_r"]) lo = Math.min(lo, wpos(r.bone(f)).y); return lo; };
    const idle = m.clipAction(this.acts.idle.getClip()); idle.play(); m.setTime(0); rig.updateMatrixWorld(true);
    this.ankleUp = wpos(r.bone("foot_l")).y - sole() + 0.035;   // ankle above the sole (+ ball height)
    this.pelvisH = wpos(r.bone("pelvis")).y - sole() + 0.035;
    idle.stop();
    this.speed = {};
    for (const key of ["walk", "jog"]) {
      const a = this.acts[key]; if (!a) continue;
      const clip = a.getClip(), ac = m.clipAction(clip); ac.play();
      const N = 60, dt = clip.duration / N, zs = [], ys = [];
      for (let i = 0; i < N; i++) { m.setTime(i * dt); rig.updateMatrixWorld(true); const p = wpos(r.bone("foot_l")); zs.push(p.z); ys.push(p.y); }
      ac.stop();
      const lo = Math.min(...ys), v = [];
      for (let i = 0; i < N; i++) { const j = (i + 1) % N; if (ys[i] < lo + 0.02 && ys[j] < lo + 0.02) v.push(-(zs[j] - zs[i]) / dt); }
      v.sort((a, b) => a - b);
      this.speed[key] = Math.abs(v[v.length >> 1] ?? 1.3) || 1.3;
      if (key === "jog") this.speed.jog = clamp(this.speed.jog, 2.5, 4);   // (the jog measures oddly: keep it sane)
    }
    m.stopAllAction(); m.uncacheRoot(r.model);
    rig.position.copy(saveP); rig.quaternion.copy(saveQ); rig.updateMatrixWorld(true);
  }

  play(key, fade = 0.25) {
    const a = this.acts[key];
    if (!a || this.cur === a) return;
    a.reset().play();
    if (this.cur) this.cur.crossFadeTo(a, fade, false);
    else { this.rd.sitAction.crossFadeTo(a, fade, false); }
    this.cur = a;
  }

  // ── pose snapshots for the hand-overs ─────────────────────────────────────
  snapshot() {
    const rig = this.rd.r.rig;
    return { p: rig.position.clone(), q: rig.quaternion.clone(), bones: this.rd.touched.map((t) => t.b.quaternion.clone()), pel: this.rd.B.pelvis.position.clone() };
  }
  applyBlend(dt) {
    const b = this.blend;
    if (!b) return;
    b.t += dt;
    const w = 1 - smooth(b.t / b.dur);
    if (w <= 0) { this.blend = null; return; }
    const rig = this.rd.r.rig;
    rig.position.lerp(b.snap.p, w);
    rig.quaternion.slerp(b.snap.q, w);
    this.rd.touched.forEach((t, i) => t.b.quaternion.slerp(b.snap.bones[i], w));
    this.rd.B.pelvis.position.lerp(b.snap.pel, w);
    rig.updateMatrixWorld(true);
  }
  startBlend(dur = 0.3) { this.blend = { snap: this.snapshot(), t: 0, dur }; }

  // ── saddle frame helpers ──────────────────────────────────────────────────
  frame() {
    const S = this.rd.saddle, hc = this.hc;
    hc.h.rig.updateMatrixWorld(true);
    const q = S.getWorldQuaternion(new THREE.Quaternion());
    const toW = (v) => S.localToWorld(v.clone());
    // ground height in the saddle frame, under the saddle
    const a = wpos(S);
    const G = S.worldToLocal(new V3(a.x, hc.y, a.z)).y;
    return { S, q, toW, G };
  }
  // the riding ankle position (left side), where the fixed strap holds the tread
  stirrup() {
    const k = this.rd.k, g = stirrupGeom(k), H = g.hang(1);
    const x = 0.38 * k / 1.07, z = 0.12, dx = x - H.x, dz = z - H.z;
    return new V3(x, H.y - Math.sqrt(g.len * g.len - dx * dx - dz * dz) + g.ankleAboveTread, z);
  }
  // an ankle in the near stirrup with the iron pulled out sideways by `out` m
  // The strap is LET DOWN for mounting (what riders do on a tall horse) so
  // the foot goes in a little below the hip; mountExtra = how much longer.
  stirrupPulled(out, fwd = 0.06) {
    const g = stirrupGeom(this.rd.k), H = g.hang(1), { G } = this.frame();
    if (!MP.letDown) { this.mountExtra = 0; return [H.x + out, H.y - Math.sqrt(Math.max(0, g.len * g.len - out * out - fwd * fwd)) + g.ankleAboveTread, H.z + fwd]; }
    const ankleY = G + this.pelvisH - MP.mountDrop, dy = H.y + g.ankleAboveTread - ankleY;
    this.mountExtra = Math.max(this.mountExtra ?? 0, Math.sqrt(dy * dy + out * out + fwd * fwd) - g.len);
    return [H.x + out, ankleY, H.z + fwd];
  }
  // how far the near strap is let down at mount time T: lowered while walking
  // up, back to riding length once seated
  strapExtra(T) { return (this.mountExtra ?? 0) * smooth((T - 0.02) / 0.3) * (1 - smooth((T - 2.1) / 0.45)); }
  // Which side can the rider get on/off: left first (tradition), else right.
  clearSide(prefer = 1) {
    const { toW } = this.frame(), hc = this.hc, k = this.rd.k;
    for (const s of [prefer, -prefer]) {
      const spot = toW(new V3(s * 0.75 * k, 0, 0.15 * k));
      const g = hc.sampleGround(spot.x, spot.z, hc.y, 3);
      if (g === null || Math.abs(g - hc.y) > 0.35) continue;
      const o = toW(new V3(s * 0.3 * k, -0.5, 0.1 * k)), d = toW(new V3(s * 1.2 * k, -0.5, 0.1 * k)).sub(o);
      hc.ray.set(o, d.clone().normalize()); hc.ray.far = d.length();
      if (hc.ray.intersectObjects(hc.world.blockers, false).length) continue;
      return s;
    }
    return 0;
  }

  // ── controls ──────────────────────────────────────────────────────────────
  // F: dismount when riding (standing still), mount when on foot near the horse.
  toggle() {
    if (this.mode === "riding") {
      if (Math.abs(this.hc.v) > 0.3 || this.hc.oneShot || this.hc.rearT >= 0) return "moving";
      const s = this.clearSide(1);
      if (!s) return "blocked";
      this.side = s;
      this.mode = "dismount"; this.t = 0;
      this.rd.dismountBlendFrom = this.snapshot();
      this.startBlend(0.25);
      this.play("idle", 0.4);
      return "ok";
    }
    if (this.mode === "ground") {
      const d = Math.hypot(this.gpos.x - this.hc.pos.x, this.gpos.z - this.hc.pos.z);
      if (d > MP.reach) return "far";
      // the side the rider is on (if clear), else the other
      const { toW } = this.frame();
      const lft = toW(new V3(1, 0, 0)).sub(toW(new V3(0, 0, 0)));
      const onLeft = (this.gpos.x - this.hc.pos.x) * lft.x + (this.gpos.z - this.hc.pos.z) * lft.z >= 0;
      const s = this.clearSide(onLeft ? 1 : -1);
      if (!s) return "blocked";
      this.side = s;
      this.mode = "approach";
      return "ok";
    }
    return "busy";
  }

  // ── per frame ─────────────────────────────────────────────────────────────
  // input: { fwd, turn, run }; returns true when it drove the rider this frame.
  update(dt, input) {
    if (this.mode === "riding") return false;
    if (this.mode === "ground" || this.mode === "approach") this.updateFoot(dt, input);
    else this.updatePerformance(dt);
    return true;
  }

  updateFoot(dt, input) {
    const rd = this.rd, r = rd.r, rig = r.rig, hc = this.hc;
    let fwd = input.fwd, turn = input.turn, run = input.run;
    if (this.mode === "approach") {
      // walk to the mounting spot, then turn to face the horse, then mount
      const { toW, q } = this.frame(), k = rd.k, s = this.side;
      const spot = toW(new V3(s * MP.stand * k, 0, 0.16 * k));
      const dx = spot.x - this.gpos.x, dz = spot.z - this.gpos.z, dist = Math.hypot(dx, dz);
      const faceYaw = new THREE.Euler().setFromQuaternion(q, "YXZ").y + s * -1.85;   // facing the horse (towards its tail a little)
      let want;
      if (dist > 0.08) want = Math.atan2(dx, dz); else want = faceYaw;
      const dy = Math.atan2(Math.sin(want - this.gyaw), Math.cos(want - this.gyaw));
      turn = clamp(dy * 3, -1, 1);
      fwd = dist > 0.08 && Math.abs(dy) < 1.2 ? clamp(dist * 1.5, 0.25, 1) : 0;
      run = false;
      if (dist <= 0.08 && Math.abs(dy) < 0.05) {
        this.mode = "mount"; this.t = 0;
        this.startBlend(0.3);
        this.play("idle", 0.3);
        return this.updatePerformance(0);
      }
    }
    // tank controls; speed from the clip that is playing so the feet do not slide
    const target = fwd > 0 ? (run ? this.speed.jog : this.speed.walk) * fwd : fwd < 0 ? -0.5 : 0;   // the clips' own speeds: no sliding feet
    this.gv += clamp(target - this.gv, -6 * dt, 4 * dt);
    this.gyaw += turn * MP.turnRate * dt;
    this.gpos.x += Math.sin(this.gyaw) * this.gv * dt;
    this.gpos.z += Math.cos(this.gyaw) * this.gv * dt;
    // keep out of the horse (a capsule along its spine)
    {
      const f = new V3(Math.sin(hc.yaw), 0, Math.cos(hc.yaw));
      const rel = new V3(this.gpos.x - hc.pos.x, 0, this.gpos.z - hc.pos.z);
      const along = clamp(rel.dot(f), -1.1, 1.3);
      const c = new V3(hc.pos.x, 0, hc.pos.z).addScaledVector(f, along);
      const off = new V3(this.gpos.x - c.x, 0, this.gpos.z - c.z), L = off.length(), R = 0.55 * rd.k;
      if (L < R && L > 1e-4) { this.gpos.x = c.x + off.x / L * R; this.gpos.z = c.z + off.z / L * R; }
    }
    const gy = hc.sampleGround(this.gpos.x, this.gpos.z, hc.y + 1, 3) ?? 0;
    const sp = Math.abs(this.gv);
    if (sp < 0.08 && Math.abs(turn) < 0.1) this.play("idle");
    else if (run && sp > this.speed.walk * 1.3) { this.play("jog"); this.cur.setEffectiveTimeScale(clamp(sp / this.speed.jog, 0.5, 1.5)); }
    else { this.play("walk"); this.cur.setEffectiveTimeScale(Math.sign(this.gv || 1) * clamp(Math.max(sp, 0.4) / this.speed.walk, 0.4, 1.5)); }
    rd.mixer.update(dt);
    for (const t of rd.touched) { t.p.copy(t.b.position); t.q.copy(t.b.quaternion); }
    rig.position.set(this.gpos.x, gy, this.gpos.z);
    rig.quaternion.setFromAxisAngle(new V3(0, 1, 0), this.gyaw);
    rig.updateMatrixWorld(true);
    this.applyBlend(dt);
    rd.stirrups.update(dt, [{ in: 0 }, { in: 0 }]);
    rd.restReins(dt);
  }

  updatePerformance(dt) {
    const rd = this.rd, r = rd.r, rig = r.rig, B = rd.B, s = this.side, k = rd.k;
    const isMount = this.mode === "mount";
    for (const t of rd.touched) { t.b.position.copy(t.p); t.b.quaternion.copy(t.q); }
    rd.mixer.update(dt);
    for (const t of rd.touched) { t.p.copy(t.b.position); t.q.copy(t.b.quaternion); }

    const { q: sq, toW, G } = this.frame();
    const st = this.stirrup();
    const seat = 0.1 + 0.035;                                  // pelvis above the saddle surface when seated
    this.perf ??= {};
    const key = `${s}:${G.toFixed(2)}`;
    if (!this.perf[key]) this.mountExtra = 0;
    if (!this.perf[key]) this.perf[key] = { mount: null, dismount: null };
    const P0 = this.perf[key];
    if (!P0.mount) P0.mount = buildMount({ G, ph: this.pelvisH, st, seat, k, au: this.ankleUp, pull: (o) => this.stirrupPulled(o) });
    if (!P0.dismount) P0.dismount = buildDismount({ G, ph: this.pelvisH, st, seat, k, au: this.ankleUp });
    const M = isMount ? P0.mount : P0.dismount;
    this.t = clamp(this.t + dt, 0, M.duration);
    const T = this.t;
    const mir = (v) => (v.x *= s, v);                          // the right side is the mirror image
    // Root: facing (yaw in the saddle frame), part of the lean; pelvis on its path.
    const yaw = M.yaw(T) * s, lean = M.lean(T);
    const up = new V3(0, 1, 0).applyQuaternion(sq);
    const yawQ = new THREE.Quaternion().setFromAxisAngle(new V3(0, 1, 0), yaw);
    const leanQ = new THREE.Quaternion().setFromAxisAngle(new V3(1, 0, 0), lean * 0.4);
    rig.quaternion.copy(sq).multiply(yawQ).multiply(leanQ);
    rig.position.set(0, 0, 0);
    rig.updateMatrixWorld(true);
    const pel = toW(mir(M.pelvis(T)));
    rig.position.copy(pel.sub(wpos(B.pelvis)));
    rig.updateMatrixWorld(true);
    // the rest of the lean in the spine
    const rq = rig.quaternion;
    const lftR = new V3(1, 0, 0).applyQuaternion(rq), fwdR = new V3(0, 0, 1).applyQuaternion(rq);
    const qq = new THREE.Quaternion();
    rotateWorld(B.spine1, qq.setFromAxisAngle(lftR, lean * 0.35));
    rotateWorld(B.spine2, qq.setFromAxisAngle(lftR, lean * 0.25));
    // Feet: near = the leg on the horse's side of the mount (left on the left)
    const legs = s > 0 ? [B.legs[0], B.legs[1]] : [B.legs[1], B.legs[0]];
    // a foot on the ground aims its ANKLE above the sole; in the stirrup the
    // ankle is the target. Fade between the two over the first 10 cm of lift
    // (it used to switch in one frame and bounced the landing foot).
    // (the foot keys ARE ankle positions — on the ground that is ankle height
    // above the floor — so no offset switches or fades: that bounced the foot)
    const footTarget = (p) => toW(mir(p));
    // Knee directions by phase. Standing and stepping up, a knee points the
    // way the rider faces (and up as the foot lifts) — splaying it sideways
    // looked broken. Only astride the horse (seated) do the knees go out round
    // the barrel, like riding; the swinging leg's knee points DOWN over the croup.
    const astride = M.astride(T);
    const kneeFwd = fwdR.clone().multiplyScalar(0.95).addScaledVector(up, 0.3).normalize();
    // foot raised to the stirrup (about hip height): the knee comes UP toward the
    // chest; once standing in the stirrup the leg straightens, knee forward again
    const raised = M.raised(T);
    const kneeUp = up.clone().addScaledVector(fwdR, 0.35).addScaledVector(lftR, -legs[0].side * 0.15).normalize();
    const kneeNear = kneeFwd.clone().lerp(kneeUp, raised * MP.kneeUp).normalize().lerp(fwdR.clone().multiplyScalar(0.85).addScaledVector(lftR, legs[0].side * 0.55).normalize(), astride).normalize();
    const swing = M.swing(T);
    const kneeFar = kneeFwd.clone().lerp(up.clone().negate().addScaledVector(fwdR, 0.3).normalize(), swing)
      .lerp(fwdR.clone().multiplyScalar(0.85).addScaledVector(lftR, legs[1].side * 0.55).normalize(), astride).normalize();
    const nearT = M.nearFoot(T), farT = M.farFoot(T);
    // on the ground the ankle sits above the sole; in a stirrup the ankle IS the target
    const onGround = (p) => p.y <= G + 0.01;
    solveLeg(legs[0], footTarget(nearT), kneeNear);
    solveLeg(legs[1], footTarget(farT), kneeFar);
    // a foot in its iron is levelled like riding (near / far by the phase)
    {
      const fwS = new V3(0, 0, 1).applyQuaternion(sq), lfS = new V3(1, 0, 0).applyQuaternion(sq);
      if (M.nearIn(T)) levelFoot(legs[0], fwS, up, lfS);
      if (M.farIn(T)) levelFoot(legs[1], fwS, up, lfS);
    }
    // Hands: from the hanging clip pose to their targets (weight), elbows out-down
    const w = M.handW(T);
    const arms = s > 0 ? [B.arms[0], B.arms[1]] : [B.arms[1], B.arms[0]];
    [[arms[0], M.nearHand(T)], [arms[1], M.farHand(T)]].forEach(([g, tgt]) => {
      const cur = wpos(g.tip);
      const T3 = cur.clone().lerp(toW(mir(tgt)), w);
      const pole = lftR.clone().multiplyScalar(g.side * 0.6).addScaledVector(up, -0.6).addScaledVector(fwdR, -0.3).normalize();
      solveTwoBone(g.u, g.l, cur, T3, pole, new V3(), true);
    });
    // head looks at what it's doing: the stirrup early, forward late
    const look = M.look(T);
    rotateWorld(B.head, qq.setFromAxisAngle(lftR, 0.35 * look));
    // fists close on the reins / saddle as the hands arrive
    const q2 = new THREE.Quaternion();
    for (const hd of rd.hands) for (const c of hd.curl) c.b.quaternion.multiply(q2.setFromAxisAngle(c.axis, c.angle * w * 0.85));
    rig.updateMatrixWorld(true);
    this.applyBlend(dt);
    // the near foot takes its iron as it arrives (0.4 s); the far foot finds
    // its own as the rider sits (2.3 s)
    const nearIn = M.nearIn(T), farIn = M.farIn(T);
    const nearIdx = s > 0 ? 0 : 1;
    const fw = new V3(0, 0, 1).applyQuaternion(sq);
    const ex = this.strapExtra(T);
    rd.stirrups.update(dt, [0, 1].map((i) => ({ in: i === nearIdx ? nearIn : farIn, ankle: wpos(B.legs[i].tip), ball: wpos(B.legs[i].ball), fwd: fw, extra: i === nearIdx ? ex : 0 })));
    rd.restReins(dt);
    // ends
    if (this.mode === "mount" && T >= M.duration) {
      this.mode = "riding";
      rd.seatY = null;                                         // re-seed the seat spring
      rd.sitAction.reset().play();
      this.cur?.crossFadeTo(rd.sitAction, 0.3, false);
      this.cur = null;
      rd.pendingBlend = this.snapshot();                       // riding blends away from this pose
    }
    if (this.mode === "dismount" && T >= M.duration) {
      this.mode = "ground";
      const p = wpos(rd.B.pelvis);
      this.gpos.set(p.x, 0, p.z);
      this.gyaw = new THREE.Euler().setFromQuaternion(rig.quaternion, "YXZ").y;
      this.gv = 0;
      this.startBlend(0.3);
    }
  }
}
