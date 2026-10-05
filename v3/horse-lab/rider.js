// ── Horse lab: the rider ─────────────────────────────────────────────────────
// The play-mode robot (UAL, 67 bones) riding the horse with NO riding clip.
// Everything below is driven by the HORSE, so it stays in time with every
// horse clip (walk, gallop, jump, eating, head toss…) without per-clip work:
//
//   seat      the pelvis rides a damped spring on a saddle frame parented to
//             the horse's Torso2 bone → it rocks and bounces with the back
//   absorb    the spine takes back part of the saddle's rocking, so the
//             shoulders stay quieter than the hips (a "following seat")
//   posture   a pose per horse state (idle, walk, gallop half-seat, jump fold,
//             eating, backing), blended smoothly
//   hands     fists (finger curl), thumbs up, low near the withers; they follow
//             the horse's head nod (keeping contact with the mouth) and move
//             toward the turn when steering; the inside rein shortens
//   legs      ankles in the stirrups (IK), knees forward-out
//   head      turns toward the camera and into turns
//   reins     verlet ropes, fist → bit ring, lying on the neck (reins.js)
//
// Saddle points were measured on the horse in its idle pose at 2.15 m (rig
// space: back top 1.47 m at z −0.05) and are scaled to its real height.
import * as THREE from "three";
import { getSharedGltfLoader } from "../../v2/core/foliage/glbLoader.js";
import { rotateWorld, solveTwoBone } from "./horse.js";
import { Rein } from "./reins.js";
import { MountSystem } from "./mount.js";

const V3 = THREE.Vector3;
const clamp = THREE.MathUtils.clamp;
const lerpK = (rate, dt) => 1 - Math.exp(-rate * dt);

export const RP = {
  seatSpring: 260,     // 1/s² — stiffness of the seat following the saddle
  seatDamp: 0.45,      // damping ratio (<1 = a little bounce)
  bounceMax: 0.07,     // m the seat may lag the saddle
  pelvisUp: 0.1,       // m pelvis bone above the saddle surface
  absorb: 0.65,        // share of the saddle's rocking the spine takes back out
  upright: 0.6,        // share of the horse's slope pitch the spine takes back out
  stirrupWidth: 0.38,  // m from the spine to each ankle
  grip: 1,             // finger curl (0 open … 1 fist)
  bitFollow: 0.45,     // how much the hands follow the horse's head nod
  steerHands: 1,       // how far the hands move when steering
  handFwd: 0, handUp: 0,   // offsets on top of the posture
  headFollow: 0,       // 1 = the rider looks where the camera looks (his option); 0 = ahead + into turns
  reinSlack: 1.06,     // rein length ÷ hand-to-bit distance at rest
  posting: 0.075,      // m the rider rises at the trot (once per stride)
  reinLoop: 0.55,      // m of rein hanging between the fists (the closed loop over the withers)
  show: true,
};

// Postures (m / rad). Hands are relative to the saddle frame.
const POSES = {
  idle:   { lean: -0.04, seatUp: 0,    handFwd: 0.25, handUp: 0.25, handApart: 0.125, stirrupDrop: 0.50, stirrupFwd: 0.12, slack: 1.0 },
  walk:   { lean: 0.03,  seatUp: 0,    handFwd: 0.26, handUp: 0.25, handApart: 0.125, stirrupDrop: 0.50, stirrupFwd: 0.10, slack: 1.0 },
  trot:   { lean: 0.12,  seatUp: 0.01, handFwd: 0.28, handUp: 0.25, handApart: 0.125, stirrupDrop: 0.47, stirrupFwd: 0.08, slack: 1.0 },
  canter: { lean: 0.22,  seatUp: 0.03, handFwd: 0.32, handUp: 0.25, handApart: 0.12, stirrupDrop: 0.46, stirrupFwd: 0.06, slack: 0.98 },
  gallop: { lean: 0.42,  seatUp: 0.07, handFwd: 0.38, handUp: 0.25, handApart: 0.12, stirrupDrop: 0.43, stirrupFwd: 0.04, slack: 0.97 },
  jump:   { lean: 0.75,  seatUp: 0.14, handFwd: 0.50, handUp: 0.33, handApart: 0.12,  stirrupDrop: 0.42, stirrupFwd: 0.0,  slack: 1.05 },
  eat:    { lean: 0.12,  seatUp: 0,    handFwd: 0.42, handUp: 0.24, handApart: 0.11,  stirrupDrop: 0.50, stirrupFwd: 0.12, slack: 1.6 },
  rear:   { lean: 0.6,   seatUp: 0.03, handFwd: 0.44, handUp: 0.32, handApart: 0.11,  stirrupDrop: 0.46, stirrupFwd: 0.02, slack: 1.1 },
  buck:   { lean: -0.32, seatUp: 0.04, handFwd: 0.20, handUp: 0.36, handApart: 0.14,  stirrupDrop: 0.50, stirrupFwd: 0.22, slack: 1.0 },
  back:   { lean: -0.12, seatUp: 0,    handFwd: 0.20, handUp: 0.33, handApart: 0.135, stirrupDrop: 0.50, stirrupFwd: 0.16, slack: 0.95 },
};
const POSE_KEYS = Object.keys(POSES.idle);

const SEAT = new V3(0, 1.47, -0.05);
const BIT = new V3(0.07, 1.6, 1.33);
const MEASURED_AT = 2.15;
const FINGERS = ["index", "middle", "ring", "pinky"];
const CURL = [1.05, 1.35, 0.9];                      // rad per finger joint at grip 1
const THUMB_CURL = [0.25, 0.45, 0.35];

export async function loadRider(url, { height = 1.78 } = {}) {
  const gltf = await getSharedGltfLoader().loadAsync(encodeURI(url));
  const model = gltf.scene;
  const clips = {};
  for (const c of gltf.animations) clips[c.name] = c;
  model.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false; } });
  const rig = new THREE.Group();
  rig.add(model);
  const bone = (n) => model.getObjectByName(n);
  rig.updateMatrixWorld(true);
  const left = bone("thigh_l").getWorldPosition(new V3()).sub(bone("thigh_r").getWorldPosition(new V3()));
  const fwd = left.clone().cross(new V3(0, 1, 0));
  model.rotation.y = -Math.atan2(fwd.x, fwd.z);
  rig.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(model, true);
  model.scale.multiplyScalar(height / (box.max.y - box.min.y));
  rig.updateMatrixWorld(true);
  return { rig, model, clips, bone, height };
}

const wpos = (o) => o.getWorldPosition(new V3());

// ── Leg IK with the twist controlled ────────────────────────────────────────
// Aiming each bone at the next point (shortest-arc rotation) leaves its spin
// round its own axis to chance: the thigh rotated at the hip while the knee
// still landed in the right place (user: 'a complete hip rotation'). Here each
// bone gets a FULL orientation: its axis along the limb AND its front (the
// kneecap, measured in the rest pose) turned toward the way the knee bends.
const _m1 = new THREE.Matrix4(), _m2 = new THREE.Matrix4(), _qa = new THREE.Quaternion(), _qp2 = new THREE.Quaternion();
function basis(m, axis, front) {
  const f = front.clone().addScaledVector(axis, -front.dot(axis)).normalize();
  const sd = new V3().crossVectors(axis, f);
  return m.makeBasis(axis, f, sd);
}
function setBoneWorld(bone, axisL, frontL, axisW, frontW) {
  basis(_m1, axisL, frontL); basis(_m2, axisW, frontW);
  const qW = _qa.setFromRotationMatrix(_m2.multiply(_m1.transpose()));
  bone.parent.getWorldQuaternion(_qp2);
  bone.quaternion.copy(_qp2.invert().multiply(qW));
  bone.updateMatrixWorld(true);
}
// leg = { u: thigh, l: calf, tip: foot, axU, frU, axL, frL } (local axes from the rest pose)
export function solveLeg(leg, target, pole) {
  const H = wpos(leg.u), K0 = wpos(leg.l), F0 = wpos(leg.tip);
  const a = H.distanceTo(K0), b = K0.distanceTo(F0);
  const d = target.clone().sub(H);
  const c = clamp(d.length(), Math.abs(a - b) + 1e-3, a + b - 1e-3);
  d.normalize();
  const p = pole.clone().addScaledVector(d, -pole.dot(d));
  if (p.lengthSq() < 1e-8) p.set(0, 0, 1);
  p.normalize();
  const cosA = clamp((a * a + c * c - b * b) / (2 * a * c), -1, 1), sinA = Math.sqrt(1 - cosA * cosA);
  const K = H.clone().addScaledVector(d, cosA * a).addScaledVector(p, sinA * a);
  const F = H.clone().addScaledVector(d, c);
  const ax1 = K.clone().sub(H).normalize(), ax2 = F.clone().sub(K).normalize();
  setBoneWorld(leg.u, leg.axU, leg.frU, ax1, p);   // kneecap toward the bend
  setBoneWorld(leg.l, leg.axL, leg.frL, ax2, p);   // shin front the same way
  return F;
}
// measured in the REST pose (constructor, before any animation): bone axis =
// direction to the child, front = the character's forward, both in bone space
function legAxes(leg, fwdW) {
  const ql = leg.u.getWorldQuaternion(new THREE.Quaternion()).invert(), qc = leg.l.getWorldQuaternion(new THREE.Quaternion()).invert();
  leg.axU = leg.l.position.clone().normalize();
  leg.frU = fwdW.clone().applyQuaternion(ql).normalize();
  leg.axL = leg.tip.position.clone().normalize();
  leg.frL = fwdW.clone().applyQuaternion(qc).normalize();
}
// Hip rotation round the thigh axis compared with the skeleton's BIND pose
// (swing-twist), degrees — independent of the IK (a natural hip stays within
// about ±45°). This is the check that catches 'the hip spins'; the kneecap-vs-
// bend check below cannot, because the solver aims the kneecap itself.
export function hipTwistDeg(rd, legIndex) {
  const Q = THREE.Quaternion;
  if (!rd._bindRel) {
    let skin = null; rd.r.model.traverse((o) => { if (o.isSkinnedMesh && !skin) skin = o; });
    const sk = skin.skeleton;
    const bindQ = (bone) => { const m = sk.boneInverses[sk.bones.indexOf(bone)].clone().invert(); const q = new Q(); m.decompose(new V3(), q, new V3()); return q; };
    rd._bindRel = rd.B.legs.map((g) => bindQ(rd.B.pelvis).invert().multiply(bindQ(g.u)));
  }
  const g = rd.B.legs[legIndex];
  const rel = rd.B.pelvis.getWorldQuaternion(new Q()).invert().multiply(g.u.getWorldQuaternion(new Q()));
  const delta = rel.clone().multiply(rd._bindRel[legIndex].clone().invert());
  const axis = g.axU.clone().applyQuaternion(rel).normalize();
  const proj = axis.multiplyScalar(new V3(delta.x, delta.y, delta.z).dot(axis));
  const tw = new Q(proj.x, proj.y, proj.z, delta.w).normalize();
  return 2 * Math.acos(Math.min(1, Math.abs(tw.w))) * 180 / Math.PI;
}

// how far a leg's kneecap is turned away from its bend direction (degrees)
export function legTwistDeg(leg) {
  const H = wpos(leg.u), K = wpos(leg.l), F = wpos(leg.tip);
  const d = F.clone().sub(H).normalize();
  const bend = K.clone().sub(H).addScaledVector(d, -K.clone().sub(H).dot(d));
  if (bend.length() < 0.02) return 0;                      // straight leg: any twist reads as straight
  const front = leg.frU.clone().applyQuaternion(leg.u.getWorldQuaternion(new THREE.Quaternion()));
  return front.addScaledVector(d, -front.dot(d)).angleTo(bend) * 180 / Math.PI;
}

// Push a point out of oval capsules (same shapes the reins collide with), plus a margin.
function pushOut(p, caps, margin) {
  const ab = new V3(), d = new V3(), vt = new V3();
  for (const sg of caps) {
    ab.subVectors(sg.b, sg.a);
    const t = d.subVectors(p, sg.a).dot(ab) / ab.lengthSq();
    if (t < 0 || t > 1) continue;
    const c = sg.a.clone().addScaledVector(ab, t);
    d.subVectors(p, c);
    vt.crossVectors(ab, sg.lat).normalize();
    const rl = sg.ra[0] + (sg.rb[0] - sg.ra[0]) * t + margin, rv = sg.ra[1] + (sg.rb[1] - sg.ra[1]) * t + margin;
    const dl = d.dot(sg.lat), dv = d.dot(vt), e = (dl / rl) ** 2 + (dv / rv) ** 2;
    if (e < 1 && e > 1e-9) { const sc = 1 / Math.sqrt(e) - 1; p.addScaledVector(sg.lat, dl * sc).addScaledVector(vt, dv * sc); }
  }
  return p;
}

export class RiderController {
  constructor(r, horseCtrl, scene) {
    this.r = r;
    this.hc = horseCtrl;
    const b = r.bone;

    // ── Hands: palm side + per-finger curl axes, measured in the bind pose ──
    r.rig.updateMatrixWorld(true);
    this.hands = ["l", "r"].map((s) => {
      const hand = b(`hand_${s}`), H = wpos(hand);
      const I = wpos(b(`index_01_${s}`)), P = wpos(b(`pinky_01_${s}`)), T = wpos(b(`thumb_02_${s}`));
      const raw = new V3().crossVectors(I.clone().sub(H), P.clone().sub(H)).normalize();
      const palmSign = Math.sign(T.clone().sub(H).dot(raw)) || 1;           // the thumb sits on the palm side
      const palm = raw.clone().multiplyScalar(palmSign);
      const curl = [];
      const chain = (names, angles) => names.forEach((n, j) => {
        const bn = b(n), nx = b(names[j + 1]) ?? bn.children[0];
        if (!nx) return;
        const dir = wpos(nx).sub(wpos(bn)).normalize();
        const axisW = new V3().crossVectors(dir, palm).normalize();         // +angle turns the finger toward the palm
        const axisL = axisW.applyQuaternion(bn.getWorldQuaternion(new THREE.Quaternion()).invert());
        curl.push({ b: bn, axis: axisL, angle: angles[j] });
      });
      for (const f of FINGERS) chain([1, 2, 3].map((k) => `${f}_0${k}_${s}`), CURL);
      chain([1, 2, 3].map((k) => `thumb_0${k}_${s}`), THUMB_CURL);
      return { hand, side: s === "l" ? 1 : -1, palmSign, curl, index: b(`index_01_${s}`), pinky: b(`pinky_01_${s}`), middle: b(`middle_01_${s}`), grip: b(`middle_02_${s}`), tipM: b(`middle_03_${s}`) };
    });

    this.mixer = new THREE.AnimationMixer(r.model);
    const sit = r.clips.Sitting_Idle_Loop_Armature ?? r.clips.Sitting_Idle_Loop;
    this.sitAction = this.mixer.clipAction(sit);
    this.sitAction.play();

    // Saddle frame + bit rings, attached to horse bones at their idle placement.
    const hr = horseCtrl.h.rig;
    hr.updateMatrixWorld(true);
    const hq = hr.getWorldQuaternion(new THREE.Quaternion());
    const mount = (bone, p) => {
      const o = new THREE.Object3D();
      scene.add(o);
      o.position.copy(hr.localToWorld(p.clone()));
      o.quaternion.copy(hq);
      o.updateMatrixWorld(true);
      bone.attach(o);
      return o;
    };
    const k = horseCtrl.h.height / MEASURED_AT;
    this.k = k;
    this.saddle = mount(horseCtrl.h.bone("Torso2"), SEAT.clone().multiplyScalar(k));
    const head = horseCtrl.h.bone("Head");
    this.bits = [mount(head, BIT.clone().multiplyScalar(k)), mount(head, new V3(-BIT.x, BIT.y, BIT.z).multiplyScalar(k))];
    // Neck collision for the reins: oval sections fitted to the horse mesh at
    // 2.15 m (centre offset above each bone, lateral / vertical radii), hung on
    // the neck bones so they follow the head (eating, head toss).
    this.neckDef = [
      { bone: horseCtrl.h.bone("Torso2"), up: 0.17, r: [0.27, 0.2] },     // withers / front of the saddle (the rein loop rests here)
      { bone: horseCtrl.h.bone("Torso3"), up: 0.2, r: [0.24, 0.24] },
      { bone: horseCtrl.h.bone("Neck1"), up: 0.2, r: [0.2, 0.28] },
      { bone: horseCtrl.h.bone("Neck3"), up: 0.07, r: [0.13, 0.27] },
      { bone: horseCtrl.h.bone("Head"), up: 0.02, r: [0.12, 0.2] },
    ];

    this.B = {
      pelvis: b("pelvis"), spine1: b("spine_01"), spine2: b("spine_02"), spine3: b("spine_03"), neck: b("neck_01"), head: b("Head"),
      legs: [["thigh_l", "calf_l", "foot_l", 1], ["thigh_r", "calf_r", "foot_r", -1]].map(([t, c, f, s]) => ({ u: b(t), l: b(c), tip: b(f), side: s })),
      arms: [["upperarm_l", "lowerarm_l", "hand_l", 1], ["upperarm_r", "lowerarm_r", "hand_r", -1]].map(([t, c, f, s]) => ({ u: b(t), l: b(c), tip: b(f), side: s })),
    };
    const all = [this.B.pelvis, this.B.spine1, this.B.spine2, this.B.spine3, this.B.neck, this.B.head,
      ...[...this.B.legs, ...this.B.arms].flatMap((g) => [g.u, g.l, g.tip]),
      ...this.hands.flatMap((h) => h.curl.map((c) => c.b))];
    this.touched = [...new Set(all)].map((bn) => ({ b: bn, p: bn.position.clone(), q: bn.quaternion.clone() }));

    this.seatY = null; this.seatV = 0; this.prevAY = 0;
    this.pose = { ...POSES.idle };
    this.poseName = "idle";
    this.bitAvg = null;
    // Reins are ONE closed loop: left bit → left fist → a bight hanging over
    // the withers → right fist → right bit. Pinned in both fists, the three
    // pieces behave as one strap.
    // Point indices along the one strap: bit L (0) … L fist (pinky side, thumb
    // side) … loop … R fist (thumb side, pinky side) … bit R (n−1).
    this.RI = { side: 13, loop: 14 };
    this.rein = new Rein(scene, { n: this.RI.side * 2 + this.RI.loop + 3 });   // 13 + fist + 14 + fist + 13 segments
    this.reins = [this.rein];
    // on foot / mounting / dismounting (mount.js)
    // rest-pose leg axes for the twist-controlled leg IK (before any animation runs)
    r.rig.updateMatrixWorld(true);
    const fwdRest = new V3(0, 0, 1).applyQuaternion(r.rig.getWorldQuaternion(new THREE.Quaternion()));
    for (const g of this.B.legs) legAxes(g, fwdRest);
    this.mountSys = new MountSystem(this);
  }

  get mode() { return this.mountSys.mode; }

  // Horse collision shapes for hands + reins (withers, neck, head to the mouth).
  neckCaps() {
    const hc = this.hc;
    const hUp = new V3(0, 1, 0).applyQuaternion(hc.h.rig.quaternion), hLat = new V3(1, 0, 0).applyQuaternion(hc.h.rig.quaternion);
    const pts = this.neckDef.map((d) => wpos(d.bone).addScaledVector(hUp, d.up * this.k));
    const neck = [];
    for (let i = 0; i < pts.length - 1; i++) neck.push({ a: pts[i], b: pts[i + 1], lat: hLat, ra: this.neckDef[i].r.map((x) => x * this.k), rb: this.neckDef[i + 1].r.map((x) => x * this.k) });
    const mouth = wpos(this.bits[0]).add(wpos(this.bits[1])).multiplyScalar(0.5);
    const poll = wpos(hc.h.bone("Head"));
    const hd = mouth.clone().sub(poll).normalize(), down = new V3().crossVectors(hLat, hd).normalize();
    const jaw = poll.clone().addScaledVector(down, 0.15 * this.k).addScaledVector(hd, 0.04 * this.k);
    neck.push({ a: jaw, b: mouth, lat: hLat, ra: [0.15 * this.k, 0.15 * this.k], rb: [0.075 * this.k, 0.08 * this.k] });
    return neck;
  }

  // Not riding: the reins lie on the neck, their loop resting on the withers.
  restReins(dt) {
    const S = this.saddle, k = this.k, n = this.rein.n;
    const { side: S1, loop: L1 } = this.RI;
    const iLp = S1, iLt = S1 + 1, iRt = iLt + L1, iRp = iRt + 1;
    const w = (x, z) => S.localToWorld(new V3(x * k, 0.17, z * k));
    const pins = [[0, wpos(this.bits[0])], [iLp, w(0.13, 0.5)], [iLt, w(0.1, 0.46)], [iRt, w(-0.1, 0.46)], [iRp, w(-0.13, 0.5)], [n - 1, wpos(this.bits[1])]];
    const seg = new Float32Array(n - 1);
    const lenL = pins[0][1].distanceTo(pins[1][1]) * 1.12, lenR = pins[5][1].distanceTo(pins[4][1]) * 1.12, loop = 0.2 + RP.reinLoop;
    for (let i = 0; i < n - 1; i++) seg[i] = i < iLp ? lenL / S1 : (i === iLp || i === iRt) ? 0.07 : i < iRt ? loop / L1 : lenR / S1;
    this.rein.step(dt, pins, seg, this.neckCaps());
  }

  setVisible(v) {
    this.r.rig.visible = v;
    for (const l of this.reins) l.setVisible(v);
  }

  targetPose() {
    const hc = this.hc;
    if (hc.rearA > 0.15) return "rear";
    if (hc.oneShot) {
      if (hc.oneShotName === "Gallop_Jump") return "jump";
      if (hc.oneShotName === "Eating") return "eat";
      if (hc.oneShotName === "Attack_Kick") return "buck";
    }
    if (hc.gaitName === "Gallop") return "gallop";
    if (hc.gaitName === "Canter") return "canter";
    if (hc.gaitName === "Trot") return "trot";
    if (hc.gaitName === "Walk") return hc.v < -0.05 ? "back" : "walk";
    return "idle";
  }

  update(dt, { lookYaw = 0, input = {} } = {}) {
    if (!this.r.rig.visible) return;
    if (this.mountSys.update(dt, { fwd: input.fwd ?? 0, turn: input.turn ?? 0, run: !!input.run })) return;   // on foot / mounting
    const hc = this.hc, B = this.B, rig = this.r.rig;
    // Restore what the ANIMATION wrote last frame (not the rest pose): the
    // mixer skips a bone whose animated value did not change since its last
    // write, so a rest-pose reset survived every clip hold as a one-frame pop.
    for (const t of this.touched) { t.b.position.copy(t.p); t.b.quaternion.copy(t.q); }
    this.mixer.update(dt);
    for (const t of this.touched) { t.p.copy(t.b.position); t.q.copy(t.b.quaternion); }

    // Posture blend
    this.poseName = this.targetPose();
    const tp = POSES[this.poseName];
    const pk = lerpK(["jump", "rear", "buck"].includes(this.poseName) ? 7 : 3.5, dt);
    for (const key of POSE_KEYS) this.pose[key] += (tp[key] - this.pose[key]) * pk;
    const P = this.pose;

    // Saddle frame (the horse is already updated this frame)
    hc.h.rig.updateMatrixWorld(true);
    const S = this.saddle;
    const anchor = wpos(S);
    const sq = S.getWorldQuaternion(new THREE.Quaternion());
    const up = new V3(0, 1, 0).applyQuaternion(sq);
    const fwd = new V3(0, 0, 1).applyQuaternion(sq);
    const lft = new V3(1, 0, 0).applyQuaternion(sq);

    // Seat spring (vertical)
    if (this.seatY === null || dt <= 0) { this.seatY = anchor.y; this.seatV = 0; this.prevAY = anchor.y; }
    else {
      const vA = (anchor.y - this.prevAY) / dt;
      const kk = RP.seatSpring, c = 2 * RP.seatDamp * Math.sqrt(kk);
      const steps = Math.ceil(dt / 0.004), h = dt / steps;
      for (let i = 0; i < steps; i++) {
        const a = kk * (anchor.y - this.seatY) - c * (this.seatV - vA);
        this.seatV += a * h; this.seatY += this.seatV * h;
      }
      this.seatY = clamp(this.seatY, anchor.y - RP.bounceMax, anchor.y + RP.bounceMax);
      this.prevAY = anchor.y;
    }

    // Root: oriented like the saddle; pelvis on the seat.
    rig.quaternion.copy(sq);
    rig.position.set(0, 0, 0);
    rig.updateMatrixWorld(true);
    // Posting trot: rise once per stride with one diagonal, sit on the other
    // (follows the trot action's own clock, faded with its blend weight).
    let post = 0;
    const trotA = hc.actions.Trot;
    if (trotA && trotA.getEffectiveWeight() > 0.01) {
      const clip = trotA.getClip(), p0 = clip.userData?.phase?.[0] ?? 0;
      const ph = trotA.time / clip.duration - p0;
      post = RP.posting * (0.5 - 0.5 * Math.cos(2 * Math.PI * ph)) * trotA.getEffectiveWeight();
    }
    this.post = post;
    const seat = new V3(anchor.x, this.seatY, anchor.z).addScaledVector(up, RP.pelvisUp + P.seatUp + post).addScaledVector(fwd, post * 0.6);
    rig.position.copy(seat.sub(wpos(B.pelvis)));
    rig.updateMatrixWorld(true);

    // Spine: absorb the saddle's rocking (relative to the horse body), take
    // back part of the slope, lean with the posture; lag of the seat spring
    // folds it a little (the rider's mass).
    const rel = new THREE.Euler().setFromQuaternion(hc.h.rig.quaternion.clone().invert().multiply(sq), "YXZ");
    const steer = clamp(hc.turnRate / Math.max(0.1, (hc.gaitName === "Gallop" ? 0.75 : 1.1)), -1, 1) * RP.steerHands;
    const lag = (this.seatY - anchor.y) * 2.5;
    const lean = P.lean - (hc.pitch - hc.rearPitch) * RP.upright - rel.x * RP.absorb - lag;
    const roll = -rel.z * RP.absorb - hc.roll * 0.4;
    const q = new THREE.Quaternion();
    const wUp = new V3(0, 1, 0);
    rotateWorld(B.spine1, q.setFromAxisAngle(lft, lean * 0.5));
    rotateWorld(B.spine2, q.setFromAxisAngle(lft, lean * 0.3));
    rotateWorld(B.spine3, q.setFromAxisAngle(lft, lean * 0.2));
    rotateWorld(B.spine1, q.setFromAxisAngle(fwd, roll * 0.6));
    rotateWorld(B.spine2, q.setFromAxisAngle(wUp, steer * 0.14));             // shoulders into the turn

    // Legs into the stirrups
    for (const g of B.legs) {
      const T = S.localToWorld(new V3(g.side * RP.stirrupWidth * this.k / 1.07, -P.stirrupDrop * this.k / 1.07, P.stirrupFwd));
      const pole = fwd.clone().multiplyScalar(0.85).addScaledVector(lft, g.side * 0.55).normalize();
      solveLeg(g, T, pole);
    }

    // Horse collision for hands + reins: oval sections along the withers and
    // neck, plus the head down to the mouth (the bit rings' midpoint).
    const hUp = new V3(0, 1, 0).applyQuaternion(hc.h.rig.quaternion), hLat = new V3(1, 0, 0).applyQuaternion(hc.h.rig.quaternion);
    const pts = this.neckDef.map((d) => wpos(d.bone).addScaledVector(hUp, d.up * this.k));
    const neck = [];
    for (let i = 0; i < pts.length - 1; i++) {
      neck.push({ a: pts[i], b: pts[i + 1], lat: hLat, ra: this.neckDef[i].r.map((x) => x * this.k), rb: this.neckDef[i + 1].r.map((x) => x * this.k) });
    }
    // the head: from the cheeks/jaw (below the Head bone, which sits at the
    // poll) to the mouth, in the head's own frame so it follows head moves
    const mouth = wpos(this.bits[0]).add(wpos(this.bits[1])).multiplyScalar(0.5);
    const poll = wpos(hc.h.bone("Head"));
    const hd = mouth.clone().sub(poll).normalize(), down = new V3().crossVectors(hLat, hd).normalize();
    const jaw = poll.clone().addScaledVector(down, 0.15 * this.k).addScaledVector(hd, 0.04 * this.k);
    neck.push({ a: jaw, b: mouth, lat: hLat, ra: [0.15 * this.k, 0.15 * this.k], rb: [0.075 * this.k, 0.08 * this.k] });
    this.neckDbg = neck;

    // Hands: posture + follow the horse's mouth + steering
    const bitMid = wpos(this.bits[0]).add(wpos(this.bits[1])).multiplyScalar(0.5);
    const bitL = S.worldToLocal(bitMid.clone());
    if (!this.bitAvg) this.bitAvg = bitL.clone();
    this.bitAvg.lerp(bitL, lerpK(1.2, dt));
    const follow = bitL.clone().sub(this.bitAvg).multiplyScalar(RP.bitFollow);
    follow.x = 0; follow.clampLength(0, 0.12);
    for (let i = 0; i < 2; i++) {
      const g = B.arms[i], hd = this.hands[i];
      const inside = steer * g.side > 0 ? Math.abs(steer) : 0;               // the hand on the turn's side
      const outside = steer * g.side < 0 ? Math.abs(steer) : 0;
      const local = new V3(
        // turning: the hand on the turn side lifts and opens out to the side
        // (his screenshot); the other stays low and gives a little forward
        g.side * (P.handApart + inside * 0.13) + steer * 0.02,
        P.handUp + RP.handUp + follow.y + inside * 0.15 - outside * 0.02,
        P.handFwd + RP.handFwd + follow.z - inside * 0.05 + outside * 0.04,
      );
      const T = pushOut(S.localToWorld(local), neck, 0.07 * this.k);   // never inside the neck (it rises toward the rider when rearing)
      const pole = lft.clone().multiplyScalar(g.side * (0.6 + inside * 0.3)).addScaledVector(up, -0.55 + inside * 0.5).addScaledVector(fwd, -0.35).normalize();   // elbows out; the turning arm's elbow lifts
      solveTwoBone(g.u, g.l, wpos(g.tip), T, pole, new V3(), true);
      this.orientHand(hd, fwd, up, lft);
    }

    // Head: toward the camera, a little into the turn
    const look = clamp(Math.atan2(Math.sin(lookYaw - hc.yaw), Math.cos(lookYaw - hc.yaw)), -1.1, 1.1) * RP.headFollow + steer * 0.25;
    rotateWorld(B.neck, q.setFromAxisAngle(wUp, look * 0.4));
    rotateWorld(B.head, q.setFromAxisAngle(wUp, look * 0.6));
    rotateWorld(B.head, q.setFromAxisAngle(lft, -lean * 0.35));            // eyes stay up when leaning

    // Fists
    for (const hd of this.hands) for (const c of hd.curl) c.b.quaternion.multiply(q.setFromAxisAngle(c.axis, c.angle * RP.grip));
    rig.updateMatrixWorld(true);
    // just sat down: blend away from the mount's last pose
    if (this.pendingBlend) { this.mountSys.blend = { snap: this.pendingBlend, t: 0, dur: 0.35 }; this.pendingBlend = null; }
    this.mountSys.applyBlend(dt);

    // Reins (rope physics), fist → bit ring, the inside rein shortened
    // Through each fist: the strap enters on the little-finger side (from the
    // bit) and leaves on the thumb side (into the loop), through the middle of
    // the closed fingers — so it reads as held, not stuck to a knuckle.
    const fist = this.hands.map((hd) => {
      const c = wpos(hd.middle).lerp(wpos(hd.tipM), 0.5);                   // inside the curled fingers
      const ax = wpos(hd.index).sub(wpos(hd.pinky)).normalize();            // pinky → thumb side
      return { pinky: c.clone().addScaledVector(ax, -0.035), thumb: c.clone().addScaledVector(ax, 0.035) };
    });
    const { side: S1, loop: L1 } = this.RI, n = this.rein.n;
    const iLp = S1, iLt = S1 + 1, iRt = iLt + L1, iRp = iRt + 1;
    const ringL = wpos(this.bits[0]), ringR = wpos(this.bits[1]);
    const sideLen = (i) => {
      const a = fist[i].pinky, bt = i ? ringR : ringL;
      if (!this.reinRest) this.reinRest = a.distanceTo(bt);
      const shorten = steer * this.hands[i].side > 0 ? Math.abs(steer) * 0.06 : 0;
      return Math.max(a.distanceTo(bt) * 1.04, this.reinRest * RP.reinSlack * P.slack - shorten);   // never quite taut: it drapes
    };
    const lenL = sideLen(0), lenR = sideLen(1);
    const loopLen = fist[0].thumb.distanceTo(fist[1].thumb) + RP.reinLoop;
    const seg = new Float32Array(n - 1);
    for (let i = 0; i < n - 1; i++) {
      if (i < iLp) seg[i] = lenL / S1;
      else if (i === iLp || i === iRt) seg[i] = 0.07;                         // inside a fist (both ends held)
      else if (i < iRt) seg[i] = loopLen / L1;
      else seg[i] = lenR / S1;
    }
    this.rein.step(dt, [[0, ringL], [iLp, fist[0].pinky], [iLt, fist[0].thumb], [iRt, fist[1].thumb], [iRp, fist[1].pinky], [n - 1, ringR]], seg, neck);
  }

  // Fist: knuckles forward and a little in, level; palm in and down.
  orientHand(hd, fwd, up, lft) {
    const H = wpos(hd.hand);
    const curDir = wpos(hd.middle).sub(H).normalize();
    const curN = new V3().crossVectors(wpos(hd.index).sub(H), wpos(hd.pinky).sub(H)).normalize().multiplyScalar(hd.palmSign);
    const D = fwd.clone().multiplyScalar(0.85).addScaledVector(up, -0.08).addScaledVector(lft, -hd.side * 0.4).normalize();
    const N = lft.clone().multiplyScalar(-hd.side * 0.75).addScaledVector(up, -0.6);
    const q1 = new THREE.Quaternion().setFromUnitVectors(curDir, D);
    const n1 = curN.applyQuaternion(q1);
    const a = n1.addScaledVector(D, -n1.dot(D)).normalize();
    const bN = N.addScaledVector(D, -N.dot(D)).normalize();
    const ang = Math.atan2(new V3().crossVectors(a, bN).dot(D), a.dot(bN));
    const q2 = new THREE.Quaternion().setFromAxisAngle(D, ang);
    rotateWorld(hd.hand, q2.multiply(q1));
  }
}
