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
import { getSharedGltfLoader } from "../render/foliage/glbLoader.js";
import { rotateWorld, solveTwoBone } from "./horse.js";
import { Rein } from "./reins.js";
import { MountSystem } from "./mount.js";
import { Stirrups, stirrupGeom, BALL_TO_TREAD } from "./stirrups.js";

const V3 = THREE.Vector3;
const clamp = THREE.MathUtils.clamp;
const lerpK = (rate, dt) => 1 - Math.exp(-rate * dt);

export const RP = {
  hillLean: 0.6,                  // rad the rider leans INTO a full hill (forward up, back down)
  seatSpring: 260,     // 1/s² — stiffness of the seat following the saddle
  seatDamp: 0.45,      // damping ratio (<1 = a little bounce)
  bounceMax: 0.07,     // m the seat may lag the saddle
  pelvisUp: 0.107,     // m pelvis bone above the saddle frame's 0 (seat leather ~9 cm up, tack.js) — set by eye in the editor (riding idle)
  absorb: 0.65,        // share of the saddle's rocking the spine takes back out
  upright: 0.6,        // share of the horse's slope pitch the spine takes back out
  stirrupWidth: 0.36,  // m from the spine to each ankle
  grip: 1,             // finger curl (0 open … 1 fist)
  // JOUST: a lance couched under the right arm (off: the riding hands as they were)
  lance: false,
  lanceHand: [-0.15, 0.52, 0.18],  // right fist in the saddle frame (x: − = right, y up, z forward): in front of the chest, the lance under the armpit — lower, it could not clear the armoured crest
  lanceAcross: 0.2,    // rad the lance points LEFT of straight ahead (over the horse's neck, as in a joust)
  lanceDip: -0.03,     // rad the tip points down (− = a touch up: it rides over the neck)
  lanceDown: false,    // couched for the charge (L key); raised: carried upright, the butt on the thigh
  lanceUpHand: [-0.24, 0.24, 0.14], lanceUpGrip: 0.95, lanceUpTilt: 0.22,   // raised: the fist by the thigh, m of pole below it, rad leaning forward
  lanceTime: 0.7,      // s to lower or raise it
  lanceLen: 3.6, lanceBack: 0.75,   // m long; m behind the fist (its butt tucked at the armpit)
  // BANNER: a standard-bearer's flag held upright in the right hand (wins over the lance)
  banner: false,
  bannerHand: [-0.3, 0.2, 0.12],  // right fist in the saddle frame: beside the right thigh, forearm low
  bannerTilt: 0.1,     // rad the pole leans forward (and a little out)
  bannerGrip: 1.05,    // m from the butt to the fist (the pole is 3.1 m)
  bitFollow: 0.45,     // how much the hands follow the horse's head nod
  steerHands: 1,       // how far the hands move when steering
  handFwd: 0, handUp: 0,   // offsets on top of the posture
  headFollow: 0,       // 1 = the rider looks where the camera looks (his option); 0 = ahead + into turns
  reinSlack: 1.06,     // rein length ÷ hand-to-bit distance at rest
  elbowsOut: 1.6,      // how far the elbows point out to the sides (the reference rides with them wide)
  heelDown: -0.2,      // rad the heel sits below the toe in the iron — NEGATIVE: the reference rider's toe points a little DOWN, heel ~11° up
  posting: 0.075,      // m the rider rises at the trot (once per stride)
  reinLoop: 0.55,      // m of rein hanging between the fists (the closed loop over the withers)
  show: true,
};

// Postures (m / rad). Hands are relative to the saddle frame.
export const POSES = {
  idle:   { lean: -0.12, seatUp: 0,    handFwd: 0.2, handUp: 0.08, handApart: 0.125, stirrupDrop: 0.63, stirrupFwd: 0.04, slack: 1.0 },   // the reference game's seated pose: long leg, foot under the knee, hands low over the pommel
  walk:   { lean: 0.03,  seatUp: 0,    handFwd: 0.26, handUp: 0.25, handApart: 0.125, stirrupDrop: 0.63, stirrupFwd: 0.10, slack: 1.0 },
  trot:   { lean: 0.12,  seatUp: 0.01, handFwd: 0.28, handUp: 0.25, handApart: 0.125, stirrupDrop: 0.64, stirrupFwd: 0.08, slack: 1.0 },
  canter: { lean: 0.22,  seatUp: 0.03, handFwd: 0.32, handUp: 0.25, handApart: 0.12, stirrupDrop: 0.6, stirrupFwd: 0.06, slack: 0.98 },
  gallop: { lean: 0.42,  seatUp: 0.07, handFwd: 0.38, handUp: 0.25, handApart: 0.12, stirrupDrop: 0.54, stirrupFwd: 0.04, slack: 0.97 },
  jump:   { lean: 0.75,  seatUp: 0.14, handFwd: 0.50, handUp: 0.33, handApart: 0.12,  stirrupDrop: 0.42, stirrupFwd: 0.0,  slack: 1.05 },
  eat:    { lean: 0.12,  seatUp: 0,    handFwd: 0.42, handUp: 0.24, handApart: 0.11,  stirrupDrop: 0.63, stirrupFwd: 0.12, slack: 1.6 },
  rear:   { lean: 0.6,   seatUp: 0.03, handFwd: 0.44, handUp: 0.32, handApart: 0.11,  stirrupDrop: 0.46, stirrupFwd: 0.02, slack: 1.1 },
  buck:   { lean: -0.32, seatUp: 0.04, handFwd: 0.20, handUp: 0.36, handApart: 0.14,  stirrupDrop: 0.63, stirrupFwd: 0.22, slack: 1.0 },
  back:   { lean: -0.12, seatUp: 0,    handFwd: 0.20, handUp: 0.33, handApart: 0.135, stirrupDrop: 0.63, stirrupFwd: 0.16, slack: 0.95 },
};
// added for the animation editor (riding mode): seat forward / back, foot
// width out from the spine, how far the knees point out round the barrel
for (const p of Object.values(POSES)) { p.seatFwd ??= 0; p.footW ??= 0.4; p.kneeOut ??= 0.55; p.chest ??= 0.3; }
const POSE_KEYS = Object.keys(POSES.idle);
export const POSES_BUILTIN = JSON.parse(JSON.stringify(POSES));
export const PELVIS_UP_BUILTIN = RP.pelvisUp;

// Riding postures as saved by the editor (v3/horse-lab/anims/riding.json):
// every posture, the seat height and the stirrup strap length.
// A jousting lance, 3.6 m along +z from its butt: a turned wooden shaft (one
// smooth profile) painted in spiral stripes, a leather-wrapped grip, a flared
// steel vamplate (hand guard) just ahead of the fist, a three-pronged coronel.
function lanceStripes() {
  const cv = document.createElement("canvas"); cv.width = 64; cv.height = 256;
  const g = cv.getContext("2d");
  g.fillStyle = "#efe6cf"; g.fillRect(0, 0, 64, 256);
  g.fillStyle = "#a51c25";
  for (let k = -2; k < 6; k++) { g.beginPath(); g.moveTo(0, k * 64); g.lineTo(64, k * 64 + 64); g.lineTo(64, k * 64 + 96); g.lineTo(0, k * 64 + 32); g.fill(); }   // diagonal: wraps into a spiral
  g.globalAlpha = 0.08; for (let y = 0; y < 256; y += 3) { g.fillStyle = y % 6 ? "#000" : "#fff"; g.fillRect(0, y, 64, 1); }   // a little grain
  const t = new THREE.CanvasTexture(cv); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.repeat.set(1, 7);
  return t;
}
// A standard-bearer's banner: an ash pole with a gilded spear finial, and a
// heraldic flag (quarterly azure and or, a red cross, a swallowtail fly end)
function makeBanner() {
  const pg = new THREE.Group(); pg.name = "bannerPole";
  const wood = new THREE.MeshStandardMaterial({ color: 0x6b4a2e, roughness: 0.7 });
  const gold = new THREE.MeshStandardMaterial({ color: 0xd8a83a, roughness: 0.3, metalness: 0.9 });
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.026, 3.0, 12), wood); pole.position.y = 1.5; pole.castShadow = true; pg.add(pole);
  const ball = new THREE.Mesh(new THREE.SphereGeometry(0.04, 14, 10), gold); ball.position.y = 3.02; pg.add(ball);
  const tip = new THREE.Mesh(new THREE.ConeGeometry(0.035, 0.18, 4), gold); tip.position.y = 3.14; tip.castShadow = true; pg.add(tip);
  const ferrule = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.02, 0.08, 10), gold); ferrule.position.y = 0.04; pg.add(ferrule);
  // the flag's picture: a long tapering pennon (a gonfanon) — blue and gold
  // bands, a red cross at the hoist, a gold fringe, the fly cut into two tails
  const cv = document.createElement("canvas"); cv.width = 512; cv.height = 192;
  const c = cv.getContext("2d");
  for (let k = 0; k < 4; k++) { c.fillStyle = k % 2 ? "#d9a632" : "#1f3f8f"; c.fillRect(0, k * 48, 512, 48); }
  c.fillStyle = "#efe6cf"; c.fillRect(0, 0, 150, 192);
  c.fillStyle = "#a51c25"; c.fillRect(56, 0, 38, 192); c.fillRect(0, 77, 150, 38);
  c.fillStyle = "#e8c35a"; c.fillRect(0, 0, 512, 6); c.fillRect(0, 186, 512, 6);
  c.globalCompositeOperation = "destination-in";             // keep only the pennon's outline
  c.beginPath(); c.moveTo(0, 0); c.lineTo(512, 62); c.lineTo(340, 96); c.lineTo(512, 130); c.lineTo(0, 192); c.closePath(); c.fill();
  const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
  const W = 1.5, Hc = 0.62, nx = 18, ny = 6;
  const geo = new THREE.PlaneGeometry(W, Hc, nx, ny);
  const cloth = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: tex, side: THREE.DoubleSide, alphaTest: 0.5, roughness: 0.85 }));
  cloth.name = "bannerCloth"; cloth.frustumCulled = false; cloth.castShadow = true;
  // PlaneGeometry rows run top → bottom, columns left (at the pole) → right (the fly): the uvs already match
  return { pole: pg, cloth, W, Hc, nx, ny, wind: 0.15, t: 0 };
}

function makeLance() {
  const g = new THREE.Group(); g.name = "lance";
  const lathe = (profile, mat, seg = 18) => {                // profile: [radius, z] pairs, along +z
    const geo = new THREE.LatheGeometry(profile.map(([r, z]) => new THREE.Vector2(r, z)), seg);
    geo.rotateX(Math.PI / 2);                                 // lathe axis y → +z
    const m = new THREE.Mesh(geo, mat); m.castShadow = true; g.add(m); return m;
  };
  const wood = new THREE.MeshStandardMaterial({ map: lanceStripes(), roughness: 0.55 });
  const leather = new THREE.MeshStandardMaterial({ color: 0x3b2416, roughness: 0.85 });
  const steel = new THREE.MeshStandardMaterial({ color: 0xb9bec6, roughness: 0.3, metalness: 0.9, side: THREE.DoubleSide });
  // butt: a rounded end, swelling a little before the grip (it locks under the arm)
  lathe([[0, 0], [0.026, 0.01], [0.034, 0.06], [0.038, 0.45], [0.03, 0.62]], wood);
  lathe([[0.03, 0.62], [0.031, 0.66], [0.029, 0.72], [0.031, 0.78], [0.029, 0.84], [0.032, 0.9]], leather);   // the grip, wrapped
  // vamplate: a steel funnel opening back over the hand, a rolled rim
  lathe([[0.034, 1.08], [0.06, 1.04], [0.11, 0.97], [0.15, 0.9], [0.165, 0.86], [0.158, 0.85]], steel, 28);
  // shaft: thick behind the guard, a long smooth taper to the tip
  const shaft = []; for (let i = 0; i <= 16; i++) { const u = i / 16, z = 0.9 + u * 2.6; shaft.push([0.046 * (1 - u) ** 0.8 + 0.014 * u, z]); }
  shaft.unshift([0.032, 0.9]);
  lathe(shaft, wood);
  // coronel: a steel cap with three short prongs (blunted: a tilt lance)
  lathe([[0.014, 3.5], [0.022, 3.52], [0.024, 3.56], [0.02, 3.58]], steel);
  for (let k = 0; k < 3; k++) {
    const p = new THREE.Mesh(new THREE.ConeGeometry(0.008, 0.045, 6), steel);
    p.rotation.x = Math.PI / 2; const a = (k / 3) * Math.PI * 2;
    p.position.set(Math.cos(a) * 0.014, Math.sin(a) * 0.014, 3.6); g.add(p);
  }
  return g;
}

export function ridingData(strap) {
  return { version: 1, pelvisUp: RP.pelvisUp, heelDown: RP.heelDown, strapLen: strap.len, poses: JSON.parse(JSON.stringify(POSES)) };
}
export function applyRidingData(d, strap) {
  if (!d?.poses) return;
  for (const [name, p] of Object.entries(d.poses)) if (POSES[name]) Object.assign(POSES[name], p);
  if (typeof d.pelvisUp === "number") RP.pelvisUp = d.pelvisUp;
  if (typeof d.heelDown === "number") RP.heelDown = d.heelDown;
  if (typeof d.strapLen === "number") strap.len = d.strapLen;
}

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

// How far a figure's SEAT (the lowest skin that follows the pelvis, near the middle) sits
// below its pelvis bone, in its rest pose. Riders place the pelvis BONE above the saddle,
// and skeletons put that bone at different depths in the body (Y Bot's ~7 cm higher than
// the robot's — it sat 7 cm into the leather): the difference is a rider's seatAdj.
export function seatDepth(r, clip = null) {
  let skin = null; r.model.traverse((o) => { if (o.isSkinnedMesh && !skin) skin = o; });
  // (in the SITTING pose when a clip is given — a seat's shape there, not standing)
  const saved = []; let mx = null;
  if (clip) { r.model.traverse((o) => { if (o.isBone) saved.push([o, o.position.clone(), o.quaternion.clone()]); }); mx = new THREE.AnimationMixer(r.model); mx.clipAction(clip).play(); mx.setTime(0.5); }
  r.rig.updateMatrixWorld(true);
  const pel = r.bone("pelvis"), pi = skin.skeleton.bones.indexOf(pel), g = skin.geometry, sw = g.attributes.skinWeight, si = g.attributes.skinIndex;
  const pp = r.rig.worldToLocal(wpos(pel)), v = new V3();
  let low = Infinity;
  for (let i = 0; i < g.attributes.position.count; i++) {
    let w = 0; for (let c = 0; c < 4; c++) if (si.getComponent(i, c) === pi) w += sw.getComponent(i, c);
    if (w < 0.5) continue;
    skin.getVertexPosition(i, v); v.applyMatrix4(skin.matrixWorld); r.rig.worldToLocal(v);
    if (Math.abs(v.x - pp.x) < 0.1) low = Math.min(low, v.y);
  }
  if (mx) { mx.stopAllAction(); mx.uncacheRoot(r.model); for (const [b, p0, q0] of saved) { b.position.copy(p0); b.quaternion.copy(q0); } r.rig.updateMatrixWorld(true); }
  return pp.y - low;
}

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
// A foot in a stirrup: ankle→ball pointing forward, toe 10° up (heel down),
// turned 12° out — riders' feet do not hang toe-down like the sitting clip's.
// The foot in the iron: its SOLE tilted heelDown rad from flat. footPitch =
// how far the ankle→ball line points down on a flat foot (~31° for the robot);
// tilting that line UP 10° (the old way) put the heel ~41° down, toes in the air.
export function ridingFootDir(fwd, up, lft, side, footPitch = 0.54, heelDown = RP.heelDown, toeOut = 0.21) {
  const a = footPitch - heelDown;                          // ankle→ball below horizontal
  return fwd.clone().multiplyScalar(Math.cos(a)).addScaledVector(up, -Math.sin(a)).addScaledVector(lft, side * toeOut).normalize();
}
export function levelFoot(g, fwd, up, lft, footPitch) {
  const A = wpos(g.tip), Bl = wpos(g.ball);
  const cur = Bl.sub(A).normalize();
  const want = ridingFootDir(fwd, up, lft, g.side, footPitch);
  rotateWorld(g.tip, new THREE.Quaternion().setFromUnitVectors(cur, want));
}

// A natural foot for a free leg: perpendicular to the shin, on the kneecap's
// side, toe tipped down ankleDown rad from square (a relaxed ankle) — then
// optionally blended toward a flat foot (on the ground) and the riding foot.
export function naturalFootDir(g, ankleDown = 0.25) {
  const K = wpos(g.l), A = wpos(g.tip), ax = A.clone().sub(K).normalize();
  const front = g.frL.clone().applyQuaternion(g.l.getWorldQuaternion(new THREE.Quaternion()));
  front.addScaledVector(ax, -front.dot(ax)).normalize();
  return front.multiplyScalar(Math.cos(ankleDown)).addScaledVector(ax, Math.sin(ankleDown)).normalize();
}
export function aimFoot(g, dir) {
  const cur = wpos(g.ball).sub(wpos(g.tip)).normalize();
  rotateWorld(g.tip, new THREE.Quaternion().setFromUnitVectors(cur, dir.clone().normalize()));
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
// each thigh's bind orientation relative to the pelvis (from the skin's inverse binds)
function bindRel(rd) {
  const Q = THREE.Quaternion;
  if (!rd._bindRel) {
    let skin = null; rd.r.model.traverse((o) => { if (o.isSkinnedMesh && !skin) skin = o; });
    const sk = skin.skeleton;
    const bindQ = (bone) => { const m = sk.boneInverses[sk.bones.indexOf(bone)].clone().invert(); const q = new Q(); m.decompose(new V3(), q, new V3()); return q; };
    rd._bindRel = rd.B.legs.map((g) => bindQ(rd.B.pelvis).invert().multiply(bindQ(g.u)));
  }
  return rd._bindRel;
}
// The NATURAL knee direction for a foot target: the bind-pose thigh swung
// (no roll about its own axis) from its rest axis to where it will point — a
// standing leg's knee forward, a leg raised in front knee UP, a leg reaching
// back knee DOWN. Hip twist ~0 by construction. Two passes: the thigh axis
// depends on the knee bend, which depends on the pole.
export function naturalKneeDir(rd, g, target, prev = null) {
  // The knee lies on a circle round the hip→foot line. For each point on it,
  // the thigh is the bind thigh SWUNG there (no roll); keep the one whose shin
  // hangs in that thigh's own bend plane, behind the kneecap — a knee that
  // hinges like a knee. (A fixed-point guess settled on a wrong branch when
  // the leg folds tight, stepping into the iron: the hip rolled 87°.)
  const Q = THREE.Quaternion, i = rd.B.legs.indexOf(g);
  const Qt = rd.B.pelvis.getWorldQuaternion(new Q()).multiply(bindRel(rd)[i]);
  const a0 = g.axU.clone().applyQuaternion(Qt).normalize(), f0 = g.frU.clone().applyQuaternion(Qt).normalize();
  const H = wpos(g.u), K = wpos(g.l), F = wpos(g.tip);
  const a = H.distanceTo(K), b = K.distanceTo(F);
  const d = target.clone().sub(H); const c = clamp(d.length(), Math.abs(a - b) + 1e-3, a + b - 1e-3); d.normalize();
  const cosA = clamp((a * a + c * c - b * b) / (2 * a * c), -1, 1), sinA = Math.sqrt(1 - cosA * cosA);
  const foot = H.clone().addScaledVector(d, c);
  const u = new V3(0, 1, 0).cross(d); if (u.lengthSq() < 1e-6) u.set(1, 0, 0).cross(d); u.normalize();
  const v = new V3().crossVectors(d, u);
  const sw = new Q(), ax = new V3(), fr = new V3(), sh = new V3(), n = new V3();
  const score = (phi) => {
    const p = u.clone().multiplyScalar(Math.cos(phi)).addScaledVector(v, Math.sin(phi));
    ax.copy(d).multiplyScalar(cosA).addScaledVector(p, sinA);
    fr.copy(f0).applyQuaternion(sw.setFromUnitVectors(a0, ax));
    sh.copy(foot).sub(H).addScaledVector(ax, -a).normalize();               // knee → foot
    n.crossVectors(ax, fr);
    const off = Math.abs(sh.dot(n));                                        // shin out of the bend plane
    const back = sh.dot(fr) > 0.05 ? 1 : 0;                                 // shin in FRONT of the kneecap: hyperextended
    const stay = prev ? 0.15 * (1 - p.dot(prev)) : 0;                      // prefer last frame's knee: no branch jumps
    return { p, cost: off + back * 2 + stay };
  };
  let best = null;
  for (let k = 0; k < 72; k++) { const r = score((k / 72) * Math.PI * 2); if (!best || r.cost < best.cost) best = { ...r, phi: (k / 72) * Math.PI * 2 }; }
  for (let step = Math.PI / 72; step > 1e-3; step /= 2) for (const dp of [-step, step]) { const r = score(best.phi + dp); if (r.cost < best.cost) best = { ...r, phi: best.phi + dp }; }
  return best.p;
}
export function hipTwistDeg(rd, legIndex) {
  const Q = THREE.Quaternion;
  bindRel(rd);
  const g = rd.B.legs[legIndex];
  const rel = rd.B.pelvis.getWorldQuaternion(new Q()).invert().multiply(g.u.getWorldQuaternion(new Q()));
  const delta = rel.clone().multiply(rd._bindRel[legIndex].clone().invert());
  const axis = g.axU.clone().applyQuaternion(rel).normalize();
  const proj = axis.multiplyScalar(new V3(delta.x, delta.y, delta.z).dot(axis));
  const tw = new Q(proj.x, proj.y, proj.z, delta.w).normalize();
  return 2 * Math.acos(Math.min(1, Math.abs(tw.w))) * 180 / Math.PI;
}

// Ankle twist: the foot (ankle → ball) against the SHIN's front (the calf's
// rest-pose front, i.e. where the kneecap faces), both across the shin, in
// degrees. A natural foot points within ~30–40° of the knee (toe-out); much
// more is a foot twisted at the ankle (user: 'the foot bends wrongly in the
// iron'). Independent of levelFoot — it reads only bones and the rest pose.
export function footTwistDeg(leg) {
  const K = wpos(leg.l), A = wpos(leg.tip), Bl = wpos(leg.ball);
  const ax = A.clone().sub(K).normalize();
  const front = leg.frL.clone().applyQuaternion(leg.l.getWorldQuaternion(new THREE.Quaternion()));
  const foot = Bl.sub(A);
  const a = foot.addScaledVector(ax, -foot.dot(ax)), b = front.addScaledVector(ax, -front.dot(ax));
  if (a.length() < 1e-3 || b.length() < 1e-3) return 0;
  return a.angleTo(b) * 180 / Math.PI;
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
    // past either end the push FADES out (over 15 % of the segment) — a hard
    // cut there made the hand jump 5 cm the moment the neck bobbed past it
    const t0 = d.subVectors(p, sg.a).dot(ab) / ab.lengthSq();
    const fade = t0 < 0 ? 1 - Math.min(1, -t0 / 0.15) : t0 > 1 ? 1 - Math.min(1, (t0 - 1) / 0.15) : 1;
    if (fade <= 0) continue;
    const t = Math.min(1, Math.max(0, t0));
    const c = sg.a.clone().addScaledVector(ab, t);
    d.subVectors(p, c);
    vt.crossVectors(ab, sg.lat).normalize();
    const rl = sg.ra[0] + (sg.rb[0] - sg.ra[0]) * t + margin, rv = sg.ra[1] + (sg.rb[1] - sg.ra[1]) * t + margin;
    const dl = d.dot(sg.lat), dv = d.dot(vt), e = (dl / rl) ** 2 + (dv / rv) ** 2;
    if (e < 1 && e > 1e-9) { const sc = (1 / Math.sqrt(e) - 1) * fade * fade * (3 - 2 * fade); p.addScaledVector(sg.lat, dl * sc).addScaledVector(vt, dv * sc); }
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
      legs: [["thigh_l", "calf_l", "foot_l", "ball_l", 1], ["thigh_r", "calf_r", "foot_r", "ball_r", -1]].map(([t, c, f, bl, s]) => ({ u: b(t), l: b(c), tip: b(f), ball: b(bl), side: s })),
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
    this.stirrups = new Stirrups(scene, this.saddle, this.k);
    this.mountSys = new MountSystem(this);
    this.lance = makeLance(); this.lance.visible = false; scene.add(this.lance);
    this.banner = makeBanner(); this.banner.pole.visible = this.banner.cloth.visible = false; scene.add(this.banner.pole, this.banner.cloth);
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
    this.stirrups?.setVisible(v);
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
  // (the editor pins a posture with forcePose and wants it applied at once)

  update(dt, { lookYaw = 0, input = {} } = {}) {
    if (!this.r.rig.visible) return;
    if (this.mountSys.update(dt, { fwd: input.fwd ?? 0, turn: input.turn ?? 0, run: !!input.run, hold: !!input.hold, aimYaw: input.aimYaw })) return;   // on foot / mounting
    const hc = this.hc, B = this.B, rig = this.r.rig;
    // Restore what the ANIMATION wrote last frame (not the rest pose): the
    // mixer skips a bone whose animated value did not change since its last
    // write, so a rest-pose reset survived every clip hold as a one-frame pop.
    for (const t of this.touched) { t.b.position.copy(t.p); t.b.quaternion.copy(t.q); }
    this.mixer.update(dt);
    for (const t of this.touched) { t.p.copy(t.b.position); t.q.copy(t.b.quaternion); }

    // Posture blend
    this.poseName = this.forcePose ?? this.targetPose();
    const tp = POSES[this.poseName];
    const pk = lerpK(["jump", "rear", "buck"].includes(this.poseName) ? 7 : 3.5, dt);
    for (const key of POSE_KEYS) this.pose[key] += (tp[key] - this.pose[key]) * (this.forcePose ? 1 : pk);
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
    const seat = new V3(anchor.x, this.seatY, anchor.z).addScaledVector(up, RP.pelvisUp + (this.seatAdj ?? 0) + P.seatUp + post).addScaledVector(fwd, post * 0.6 + P.seatFwd);
    rig.position.copy(seat.sub(wpos(B.pelvis)));
    rig.updateMatrixWorld(true);

    // Spine: absorb the saddle's rocking (relative to the horse body), take
    // back part of the slope, lean with the posture; lag of the seat spring
    // folds it a little (the rider's mass).
    const rel = new THREE.Euler().setFromQuaternion(hc.h.rig.quaternion.clone().invert().multiply(sq), "YXZ");
    const steer = clamp(hc.turnRate / Math.max(0.1, (hc.gaitName === "Gallop" ? 0.75 : 1.1)), -1, 1) * RP.steerHands;
    const lag = (this.seatY - anchor.y) * 2.5;
    const lean = P.lean - (hc.pitch - hc.rearPitch) * RP.upright - rel.x * RP.absorb - lag;
    // into the hill: forward going up, back going down (he tipped with the saddle the other way)
    const leanH = lean + (hc.rearT < 0 ? (hc.hillK ?? 0) * RP.hillLean : 0);
    const roll = -rel.z * RP.absorb - hc.roll * 0.4;
    const q = new THREE.Quaternion();
    const wUp = new V3(0, 1, 0);
    rotateWorld(B.spine1, q.setFromAxisAngle(lft, leanH * 0.5));
    rotateWorld(B.spine2, q.setFromAxisAngle(lft, leanH * 0.3));
    rotateWorld(B.spine3, q.setFromAxisAngle(lft, leanH * 0.2));
    // chest up: straighten the sitting clip's hunch (upper back + neck back, head level) — the reference sits tall
    rotateWorld(B.spine2, q.setFromAxisAngle(lft, -P.chest * 0.4));
    rotateWorld(B.spine3, q.setFromAxisAngle(lft, -P.chest * 0.6));
    rotateWorld(B.head, q.setFromAxisAngle(lft, P.chest * 0.6));          // the head stays level (not tipped back with the chest)
    rotateWorld(B.spine1, q.setFromAxisAngle(fwd, roll * 0.6));
    rotateWorld(B.spine2, q.setFromAxisAngle(wUp, steer * 0.14));             // shoulders into the turn

    // Legs into the stirrups
    for (const g of B.legs) {
      const sg = stirrupGeom(this.k), hangL = sg.hang(g.side);
      const ankL = new V3(g.side * P.footW * this.k / 1.07, -P.stirrupDrop * this.k / 1.07, P.stirrupFwd);
      // the tread hangs from a fixed strap: the foot is AT its end — never
      // lower (stretch) nor higher (the iron would ride up: an elastic strap).
      // Postures that rise (gallop, jump) lift the seat; the knees bend.
      // The iron's tread goes under the BALL of the foot (stirrups.js), so the
      // strap length is measured to there: ball offset from the ankle as last
      // frame's foot had it (it was measured to the ankle: the foot sat 10 cm off its iron)
      const off = g.ballOff ?? new V3(0, -0.06, 0.12);                 // ankle → tread, saddle frame
      const tr = ankL.clone().add(off).sub(hangL);
      ankL.copy(hangL).addScaledVector(tr.normalize(), sg.len).sub(off);
      const T = S.localToWorld(ankL);
      const pole = fwd.clone().multiplyScalar(0.85).addScaledVector(lft, g.side * P.kneeOut).normalize();
      solveLeg(g, T, pole);
      levelFoot(g, fwd, up, lft, this.mountSys.footPitch);   // in the iron: sole near level, heel a touch down, toe a touch out
      g.ballOff = S.worldToLocal(wpos(g.ball).addScaledVector(up, -BALL_TO_TREAD)).sub(S.worldToLocal(wpos(g.tip)));
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
    follow.x = 0;
    { const L = follow.length(); if (L > 1e-6) follow.multiplyScalar(0.12 * Math.tanh(L / 0.12) / L); }   // soft 12 cm limit (a hard clamp held the hands still, then let go)
    { const want = RP.lanceDown ? 1 : 0; this.lanceT ??= want; this.lanceT += Math.sign(want - this.lanceT) * Math.min(Math.abs(want - this.lanceT), dt / RP.lanceTime); const u = this.lanceT; this.lanceA = u * u * (3 - 2 * u); }
    for (let i = 0; i < 2; i++) {
      const g = B.arms[i], hd = this.hands[i];
      const inside = steer * g.side > 0 ? Math.abs(steer) : 0;               // the hand on the turn's side
      const outside = steer * g.side < 0 ? Math.abs(steer) : 0;
      const bannerOn = RP.banner && this.mode === "riding" && !this.bowOn;
      const lanceOn = RP.lance && !RP.banner && this.mode === "riding" && !this.bowOn;
      const local = new V3(
        // turning: the hand on the turn side lifts and opens out to the side
        // (his screenshot); the other stays low and gives a little forward
        g.side * (P.handApart + inside * 0.13) + steer * 0.02,
        P.handUp + RP.handUp + follow.y + inside * 0.15 - outside * 0.02,
        P.handFwd + RP.handFwd + follow.z - inside * 0.05 + outside * 0.04,
      );
      // jousting: the right fist low at the front of the right hip (the lance
      // couched), the left takes both reins in the middle
      if (bannerOn) { if (g.side < 0) local.set(...RP.bannerHand); else { local.x = 0.02; local.z += 0.02; } }
      else if (lanceOn) { if (g.side < 0) local.set(...RP.lanceUpHand.map((x, k) => x + (RP.lanceHand[k] - x) * this.lanceA)); else { local.x = 0.02; local.z += 0.02; } }   // raised by the thigh → couched at the chest
      const T = pushOut(S.localToWorld(local), neck, 0.07 * this.k);   // never inside the neck (it rises toward the rider when rearing)
      // never a locked arm: the elbow stays bent and soaks up the neck's bob
      // (a straight arm reads as a push-up on the withers at the gallop)
      const sh = wpos(g.u), armLen = g.l.position.length() * g.u.getWorldScale(new V3()).x + g.tip.position.length() * g.l.getWorldScale(new V3()).x;
      // a SOFT limit: past 72 % of the arm the reach eases toward 90 % (never
      // straight). A hard cut at 86 % froze the elbow at 119° for half of every
      // gallop stride, then let it snap away — the elbow jitter
      const toT = T.clone().sub(sh), d = toT.length(), k0 = armLen * 0.72, k1 = armLen * 0.9;
      if (d > k0) T.copy(sh).addScaledVector(toT.normalize(), k0 + (k1 - k0) * Math.tanh((d - k0) / (k1 - k0)));
      const tuck = clamp((P.lean - 0.25) / 0.4, 0, 1);                           // leaning forward (canter, gallop): elbows in and back, not winged out
      const pole = bannerOn && g.side < 0 ? lft.clone().multiplyScalar(-0.8).addScaledVector(up, -0.4).addScaledVector(fwd, -0.3).normalize()   // elbow out to the right and down
        : lanceOn && g.side < 0 ? lft.clone().multiplyScalar(-0.8 + 0.55 * this.lanceA).addScaledVector(up, -0.4 - 0.3 * this.lanceA).addScaledVector(fwd, -0.3 - 0.3 * this.lanceA).normalize()   // elbow down, back, against the ribs (the lance under it)
        : lft.clone().multiplyScalar(g.side * (RP.elbowsOut * (1 - tuck * 0.55) + inside * 0.3)).addScaledVector(up, -0.15 - tuck * 0.35 + inside * 0.5).addScaledVector(fwd, -0.2 - tuck * 0.5).normalize();   // elbows out to the sides (the reference)   // elbows out; the turning arm's elbow lifts
      solveTwoBone(g.u, g.l, wpos(g.tip), T, pole, new V3(), true);
      if (bannerOn && g.side < 0) this.orientHandTo(hd, lft.clone().multiplyScalar(0.75).addScaledVector(fwd, 0.55), lft.clone().multiplyScalar(0.4).addScaledVector(fwd, -0.5));   // fingers round the upright pole, knuckles out
      else if (lanceOn && g.side < 0) {
        this.orientHandTo(hd, lft.clone().multiplyScalar(0.75).addScaledVector(fwd, 0.55), lft.clone().multiplyScalar(0.4).addScaledVector(fwd, -0.5));   // raised: round the upright shaft
        this.orientHandTo(hd, fwd.clone().multiplyScalar(0.55).addScaledVector(up, -0.6).addScaledVector(lft, 0.25), lft.clone(), this.lanceA);   // couched   // fingers forward-down round the shaft, palm in
      }
      else this.orientHand(hd, fwd, up, lft);
    }

    // Head: toward the camera, a little into the turn
    const look = clamp(Math.atan2(Math.sin(lookYaw - hc.yaw), Math.cos(lookYaw - hc.yaw)), -1.1, 1.1) * RP.headFollow + steer * 0.25;
    rotateWorld(B.neck, q.setFromAxisAngle(wUp, look * 0.4));
    rotateWorld(B.head, q.setFromAxisAngle(wUp, look * 0.6));
    rotateWorld(B.head, q.setFromAxisAngle(lft, -leanH * 0.35));            // eyes stay up when leaning

    // Fists
    for (const hd of this.hands) for (const c of hd.curl) c.b.quaternion.multiply(q.setFromAxisAngle(c.axis, c.angle * RP.grip));
    rig.updateMatrixWorld(true);
    this.placeLance(fwd, up, lft, hc, dt);
    this.placeBanner(hc, dt);
    this.stirrups.update(dt, this.B.legs.map((g) => ({ in: 1, force: true, ankle: wpos(g.tip), ball: wpos(g.ball), fwd })));
    // just sat down: blend away from the mount's last pose
    if (this.pendingBlend) { this.mountSys.blend = { snap: this.pendingBlend, t: 0, dur: 0.35 }; this.pendingBlend = null; }
    this.mountSys.applyBlend(dt);

    // the bow up (bow.js handsFree): the reins dropped on the neck — mounted archers steer with the legs
    if (this.handsFree) { this.restReins(dt); return; }
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

  // The lance through the right fist: over the horse's neck to the left, the
  // tip a little down, the butt under the armpit
  placeLance(fwd, up, lft, hc, dtL = 1 / 60) {
    // aimed in the WORLD: the horse's heading, true vertical — the rider holds it
    // on the target. Built from the saddle's axes it rocked with the horse's back:
    // the tip bobbed 55 cm every gallop stride
    if (hc) { fwd = new V3(Math.sin(hc.yaw), 0, Math.cos(hc.yaw)); up = new V3(0, 1, 0); lft = new V3(Math.cos(hc.yaw), 0, -Math.sin(hc.yaw)); }
    const on = RP.lance && !RP.banner && this.mode === "riding" && this.r.rig.visible && !this.bowOn;
    this.lance.visible = on;
    if (!on) return;
    const hd = this.hands[1], grip = wpos(hd.middle).lerp(wpos(hd.tipM), 0.5);
    // NEVER through the horse: tested against its neck + head (the reins'
    // capsules, inflated by the lance's thickness); touching, it angles further
    // across (it then crosses close to the saddle, where the neck is low) and a
    // little up — the least that clears, eased so it does not twitch
    const aim = (ac, dp) => fwd.clone().multiplyScalar(Math.cos(ac)).addScaledVector(lft, Math.sin(ac)).addScaledVector(up, -Math.sin(dp)).normalize();
    // (against the horse's REAL skin — neck, head and the armour plates on the
    // crest, which stand well out of the reins' simple neck capsules)
    const pts = this.horseSkinPoints(hc), clear2 = (0.045 + 0.03) ** 2, L = RP.lanceLen - RP.lanceBack;
    const touches = (d) => {
      for (const p of pts) {
        const t = clamp(p.clone().sub(grip).dot(d), 0.3, L);
        if (grip.clone().addScaledVector(d, t).distanceToSquared(p) < clear2) return true;
      }
      return false;
    };
    // ONE correction along ONE path (across + a little up together), the least
    // that clears — found by bisection, with a 3 cm margin so it does not flicker
    // at the edge — then eased. (Trying several kinds of fix and taking the first
    // that cleared jumped between them: the lance shook 11° a frame at idle.)
    const along = (k) => aim(RP.lanceAcross + 0.75 * k, RP.lanceDip - 0.45 * k);
    let need = 0;
    if (touches(along(0))) {
      let lo = 0, hi = 0.8;
      if (touches(along(hi))) need = hi;
      else { for (let it = 0; it < 10; it++) { const m = (lo + hi) / 2; if (touches(along(m))) lo = m; else hi = m; } need = hi; }
      need = Math.min(0.8, need + 0.03);
    }
    this.lanceK ??= need;
    // held at the HIGHEST it needed over the last ~2 s: at a gallop the neck
    // rises into the lance's path every stride — following that, the tip bobbed
    // 60 cm a stride; a rider holds it steady above the whole bob
    // (only measured once it is (nearly) couched: raised, the fist is low by the
    // thigh and the couched line from THERE runs through the neck — that held
    // the lance pointing up for seconds after lowering it)
    if ((this.lanceA ?? 1) < 0.9) need = Math.min(need, this.lanceNeed ?? 0);
    this.lanceNeed = Math.max(need, (this.lanceNeed ?? need) - 0.12 * Math.min(dtL, 0.05));   // a peak that sinks ~0.12 a second
    this.lanceK += (this.lanceNeed - this.lanceK) * (1 - Math.exp(-(this.lanceNeed > this.lanceK ? 10 : 1.5) * Math.min(dtL, 0.05)));
    this.lanceFix = [0.75 * this.lanceK, -0.45 * this.lanceK];
    const dirC = aim(RP.lanceAcross + this.lanceFix[0], RP.lanceDip + this.lanceFix[1]);
    // raised → couched: the shaft swings down from upright over the horse's head
    const dirU = up.clone().addScaledVector(fwd, Math.sin(RP.lanceUpTilt)).addScaledVector(lft, -0.03).normalize();
    const a = this.lanceA ?? 1, qU = new THREE.Quaternion().setFromUnitVectors(new V3(0, 0, 1), dirU), qC = new THREE.Quaternion().setFromUnitVectors(new V3(0, 0, 1), dirC);
    const qL = qU.slerp(qC, a), dir = new V3(0, 0, 1).applyQuaternion(qL);
    this.lance.position.copy(grip).addScaledVector(dir, -(RP.lanceUpGrip + (RP.lanceBack - RP.lanceUpGrip) * a));
    this.lance.quaternion.copy(qL);
    this.lance.scale.setScalar(RP.lanceLen / 3.6);
    this.lance.userData.gripAt = RP.lanceBack;
  }

  // Sample points of the horse's neck + head skin this frame (every 5th vertex
  // whose main bone is a neck / head / ear bone; armour plates included)
  horseSkinPoints(hc) {
    if (!this.skinPick) {
      this.skinPick = [];
      hc.h.model.traverse((m) => {
        if (!m.isSkinnedMesh || !m.visible || m.name === "tail") return;
        const g = m.geometry, si = g.attributes.skinIndex, sw = g.attributes.skinWeight, ids = [];
        for (let i = 0; i < g.attributes.position.count; i += 5) {
          let bi = 0, bw = 0;
          for (let k = 0; k < 4; k++) if (sw.getComponent(i, k) > bw) { bw = sw.getComponent(i, k); bi = si.getComponent(i, k); }
          if (/^(Neck[23]|Head|Ear)/.test(m.skeleton.bones[bi]?.name)) ids.push(i);   // (not Neck1: the base of the neck is beside the fist itself)
        }
        if (ids.length) this.skinPick.push({ m, ids });
      });
    }
    const out = [];
    for (const { m, ids } of this.skinPick) for (const i of ids) { const v = new V3().fromBufferAttribute(m.geometry.attributes.position, i); m.applyBoneTransform(i, v); out.push(v.applyMatrix4(m.matrixWorld)); }
    return out;
  }

  // The banner: the pole through the right fist, upright (world vertical, a
  // little forward and out); the flag on its upper end droops when still and
  // streams back with speed, fluttering (its vertices set each frame)
  placeBanner(hc, dt = 1 / 60) {
    const B = this.banner, on = RP.banner && this.mode === "riding" && this.r.rig.visible && !this.bowOn;
    B.pole.visible = B.cloth.visible = on;
    if (!on || !hc) return;
    const fwd = new V3(Math.sin(hc.yaw), 0, Math.cos(hc.yaw)), lft = new V3(Math.cos(hc.yaw), 0, -Math.sin(hc.yaw)), up = new V3(0, 1, 0);
    const hd = this.hands[1], grip = wpos(hd.middle).lerp(wpos(hd.tipM), 0.5);
    const dir = up.clone().addScaledVector(fwd, Math.sin(RP.bannerTilt)).addScaledVector(lft, -0.04).normalize();
    B.pole.position.copy(grip).addScaledVector(dir, -RP.bannerGrip);
    B.pole.quaternion.setFromUnitVectors(new V3(0, 1, 0), dir);
    B.pole.updateMatrixWorld(true);
    // wind: the horse's speed (+ a light breeze), smoothed
    B.wind += (clamp(Math.abs(hc.v) / 5, 0, 1) * 0.85 + 0.15 - B.wind) * (1 - Math.exp(-2 * dt));
    B.t += dt * (2.5 + 9 * B.wind);
    const g = B.cloth.geometry, P = g.attributes.position, { W, Hc, nx, ny } = B;
    const top = B.pole.localToWorld(new V3(0, 2.92, 0)), back = fwd.clone().negate();
    const droop = (1 - B.wind) * 1.25;                         // rad: hanging down along the pole when still
    for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) {
      const u = i / nx, y = (j / ny) * Hc, x = u * W;
      const a = droop * (0.25 + 0.75 * u);
      const base = top.clone().addScaledVector(dir, -y);
      // flutter only OUTWARD (to the right, away from the rider): swinging both
      // ways the gallop flutter went into his right shoulder
      const amp = 0.025 + 0.1 * B.wind, fl = -amp * u * (1 + Math.sin(B.t - u * 6 + y * 2.2)) - 0.02 * u * (1 + Math.sin(B.t * 1.7 - u * 9)) - 0.03 * u;
      const p = base.addScaledVector(back, x * Math.cos(a)).addScaledVector(up, -x * Math.sin(a)).addScaledVector(lft, fl);
      const over = p.clone().sub(top).dot(lft);                 // never on the rider's side of the pole
      if (over > 0.01) p.addScaledVector(lft, 0.01 - over);
      P.setXYZ(j * (nx + 1) + i, p.x, p.y, p.z);
    }
    P.needsUpdate = true; g.computeVertexNormals(); g.computeBoundingSphere();
  }

  // Fist: knuckles forward and a little in, level; palm in and down.
  orientHand(hd, fwd, up, lft, w = 1) {
    const D = fwd.clone().multiplyScalar(0.85).addScaledVector(up, -0.08).addScaledVector(lft, -hd.side * 0.4).normalize();
    const N = lft.clone().multiplyScalar(-hd.side * 0.75).addScaledVector(up, -0.6);
    this.orientHandTo(hd, D, N, w);
  }
  // point the fingers along D with the palm facing N (any hand pose)
  orientHandTo(hd, D, N, w = 1) {
    if (w <= 0.001) return;
    D = D.clone().normalize(); N = N.clone();
    const H = wpos(hd.hand);
    const curDir = wpos(hd.middle).sub(H).normalize();
    const curN = new V3().crossVectors(wpos(hd.index).sub(H), wpos(hd.pinky).sub(H)).normalize().multiplyScalar(hd.palmSign);
    const q1 = new THREE.Quaternion().setFromUnitVectors(curDir, D);
    const n1 = curN.applyQuaternion(q1);
    const a = n1.addScaledVector(D, -n1.dot(D)).normalize();
    const bN = N.addScaledVector(D, -N.dot(D)).normalize();
    const ang = Math.atan2(new V3().crossVectors(a, bN).dot(D), a.dot(bN));
    const q2 = new THREE.Quaternion().setFromAxisAngle(D, ang);
    rotateWorld(hd.hand, new THREE.Quaternion().slerp(q2.multiply(q1), w));
  }
}
