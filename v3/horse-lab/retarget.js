// ── Horse lab: Mixamo clips onto the robot (Quaternius UAL, UE-style bones) ──
// Bakes a Mixamo clip (mixamoRef.js) into the robot's own bone rotations, so the
// whole body moves as captured — collarbones, spine, hips, legs, head, fingers —
// and a game layer (IK onto a bow, a string, a rein) only corrects on top.
//
// The two rest poses differ (Mixamo: a T-pose; the robot: its own bind), so each
// mapped bone gets a body-based frame in both rests — x along the bone toward its
// child, z from the body (left–right; for an arm, forward; for a hand / finger,
// across the palm) — and the robot's rest bone is turned onto Mixamo's frame.
// Each sampled frame then carries Mixamo's rotation AWAY from its rest onto that.
// The clip's own facing at its start is taken out (its pelvis yaw at t = 0), so
// the robot faces where the game turns it; the pelvis moves by Mixamo's offset
// from its rest, scaled by hip height.
import * as THREE from "three";

const Q = THREE.Quaternion, V3 = THREE.Vector3, M4 = THREE.Matrix4;

// robot bone ← Mixamo bone (the mixamorig prefix left off), and the child that
// gives the bone's direction (robot, Mixamo); "up" = toward the parent's other end
const MAP = [];
const add = (dst, src, dc, sc, kind) => MAP.push({ dst, src, dc, sc, kind });
add("pelvis", "Hips", "spine_01", "Spine", "body");
add("spine_01", "Spine", "spine_02", "Spine1", "body");
add("spine_02", "Spine1", "spine_03", "Spine2", "body");
add("spine_03", "Spine2", "neck_01", "Neck", "body");
add("neck_01", "Neck", "Head", "Head", "body");
add("Head", "Head", null, null, "head");
for (const [s, S] of [["l", "Left"], ["r", "Right"]]) {
  add(`clavicle_${s}`, `${S}Shoulder`, `upperarm_${s}`, `${S}Arm`, "rest");   // (see "rest" below)
  add(`upperarm_${s}`, `${S}Arm`, `lowerarm_${s}`, `${S}ForeArm`, "arm");
  add(`lowerarm_${s}`, `${S}ForeArm`, `hand_${s}`, `${S}Hand`, "arm");
  add(`hand_${s}`, `${S}Hand`, `middle_01_${s}`, `${S}HandMiddle1`, "palm");
  for (const [f, F] of [["index", "Index"], ["middle", "Middle"], ["ring", "Ring"], ["pinky", "Pinky"], ["thumb", "Thumb"]]) {
    for (let j = 1; j <= 3; j++) {
      add(`${f}_0${j}_${s}`, `${S}Hand${F}${j}`, j < 3 ? `${f}_0${j + 1}_${s}` : `${f}_04_leaf_${s}`, `${S}Hand${F}${j + 1}`, "palm");
      if (j === 3) Object.assign(MAP[MAP.length - 1], { dp: `${f}_02_${s}`, sp: `${S}Hand${F}2` });   // (tips: by their own segment)
    }
  }
  add(`thigh_${s}`, `${S}UpLeg`, `calf_${s}`, `${S}Leg`, "body");
  add(`calf_${s}`, `${S}Leg`, `foot_${s}`, `${S}Foot`, "body");
  add(`foot_${s}`, `${S}Foot`, `ball_${s}`, `${S}ToeBase`, "body");
  add(`ball_${s}`, `${S}ToeBase`, `ball_leaf_${s}`, `${S}Toe_End`, "body");
}

// Mixamo name (no prefix) → UE name, and back — every mapped bone, its child, the end bones
export const UE_FROM_MIXAMO = {};
for (const m of MAP) { UE_FROM_MIXAMO[m.src] = m.dst; if (m.sc && m.dc) UE_FROM_MIXAMO[m.sc] = m.dc; }
export const MIXAMO_FROM_UE = Object.fromEntries(Object.entries(UE_FROM_MIXAMO).map(([k, v]) => [v, k]));

// bind (rest) transforms in the skeleton's own space, by name (Mixamo names; a UE-named
// skeleton is read through MIXAMO_FROM_UE when `ue` is set)
function restOf(skinned, ue = false) {
  const sk = skinned.skeleton, out = {};
  sk.bones.forEach((b, i) => {
    const m = sk.boneInverses[i].clone().invert(), p = new V3(), q = new Q(), s = new V3();
    m.decompose(p, q, s);
    const nm = b.name.replace(/^mixamorig:?/, "");
    const key = ue ? MIXAMO_FROM_UE[nm] ?? nm : nm;
    if (!out[key]) out[key] = { p, q, bone: b };   // (the first: a Mixamo FBX repeats each bone as a childless copy under it)
  });
  return out;
}
const skinOf = (root) => { let k = null; root.traverse((o) => { if (o.isSkinnedMesh && !k) k = o; }); return k; };
// a rotation from two directions: x along `a`, z = `b` made square to it
function basis(a, b) {
  const x = a.clone().normalize(), z = b.clone().addScaledVector(x, -b.dot(x)).normalize(), y = new V3().crossVectors(z, x);
  return new Q().setFromRotationMatrix(new M4().makeBasis(x, y, z));
}

/**
 * Bake a Mixamo clip onto the robot.
 * @param ref    loadMixamoRef(...) result (root, clip, mixer, bone, at)
 * @param robot  the robot's model (contains its SkinnedMesh)
 * @param fps    samples a second
 * @returns {{ duration, fps, names, frames: Float32Array[], hips: Float32Array, apply(t, w) }}
 */
export function bakeMixamoOnto(ref, robot, fps = 30) {
  // (ref.ue: the SOURCE is UE-named — the robot's own clips onto another figure; its bones
  // are then read under their Mixamo names, ref.bone takes Mixamo names too)
  // (a clip downloaded "Without Skin" has no rest pose of its own: every Mixamo clip shares
  // Y Bot's skeleton and T-pose, so it reads the rest from a skinned Mixamo file — ref.restFrom)
  const sSkin = skinOf(ref.root) ?? (ref.restFrom && skinOf(ref.restFrom));
  if (!sSkin) throw new Error("no rest pose: a clip without skin needs ref.restFrom (a skinned Mixamo file)");
  const S = restOf(sSkin, !!ref.ue), D = restOf(skinOf(robot));
  const maps = MAP.filter((m) => D[m.dst] && S[m.src]);
  // the body's side axis in each rest (left minus right), and up (pelvis → neck)
  const sideOf = (R, l, r) => R[l].p.clone().sub(R[r].p).normalize();
  const sSide = sideOf(S, "LeftUpLeg", "RightUpLeg"), dSide = sideOf(D, "thigh_l", "thigh_r");
  const sUp = S.Neck.p.clone().sub(S.Hips.p).normalize(), dUp = D.neck_01.p.clone().sub(D.pelvis.p).normalize();
  // the two model spaces turned onto each other (Mixamo's into the robot's) from the
  // pelvis' frames: every Mixamo rotation is read through this
  const QS = basis(sUp, sSide), QD = basis(dUp, dSide), Qsd = QD.clone().multiply(QS.clone().invert());
  // per bone: the robot's rest turned onto Mixamo's (in the robot's space)
  for (const m of maps) {
    const dir = (R, a, c, up) => (c && R[c] ? R[c].p.clone().sub(R[a].p) : up.clone());
    let sd = dir(S, m.src, m.sc, sUp).applyQuaternion(Qsd), dd = dir(D, m.dst, m.dc, dUp);
    // a FINGERTIP bone's direction from its own segment (middle joint → it): the robot's
    // "_04_leaf" ends don't sit out along the finger, and aimed at them every tip bent
    // ~90° backward
    if (m.dp) { sd = S[m.src].p.clone().sub(S[m.sp].p).applyQuaternion(Qsd); dd = D[m.dst].p.clone().sub(D[m.dp].p); }
    let ss, ds;
    if (m.kind === "palm") {
      const L = m.dst.endsWith("_l") ? "Left" : "Right", sfx = m.dst.slice(-2);
      ss = S[`${L}HandIndex1`].p.clone().sub(S[`${L}HandPinky1`].p).applyQuaternion(Qsd);
      ds = D[`index_01${sfx}`].p.clone().sub(D[`pinky_01${sfx}`].p);
    } else if (m.kind === "arm") {
      ss = new V3().crossVectors(sSide, sUp).applyQuaternion(Qsd); ds = new V3().crossVectors(dSide, dUp);   // forward
    } else { ss = sSide.clone().applyQuaternion(Qsd); ds = dSide.clone(); }
    if (m.kind === "head") { sd = sUp.clone().applyQuaternion(Qsd); dd = dUp.clone(); }
    const align = basis(sd, ss).multiply(basis(dd, ds).invert());     // robot rest frame → Mixamo rest frame
    m.dRestAligned = align.multiply(D[m.dst].q.clone());               // the robot bone, posed as Mixamo's rest
    // "rest": a COLLARBONE carries its MOVE from its own rest, not its direction — each
    // skeleton's rest collarbone is its own neutral (the robot's point 37° back by design,
    // Y Bot's 12°); copied by direction, Y Bot stood shoulders back, chest out
    if (m.kind === "rest") m.dRestAligned = D[m.dst].q.clone();
    m.sRestInv = S[m.src].q.clone().invert();
  }
  // the parent of each mapped robot bone (for local rotations): mapped, or its bind
  const dByBone = new Map(Object.values(D).map((r) => [r.bone, r]));
  for (const m of maps) {
    const pb = D[m.dst].bone.parent;
    m.parentMap = maps.find((x) => D[x.dst].bone === pb) ?? null;
    m.parentRest = dByBone.get(pb)?.q ?? new Q();
  }
  // the clip's facing at its start (its pelvis yaw), taken out
  const srcRoot = ref.root, inv = new Q();
  const srcModelQ = (bone) => inv.copy(srcRoot.getWorldQuaternion(new Q())).invert().multiply(bone.getWorldQuaternion(new Q()));
  ref.at(0);
  const hips = ref.bone("Hips");
  // (yaw of the pelvis' delta from rest at t = 0, in the robot's space)
  const d0 = srcModelQ(hips).multiply(S.Hips.q.clone().invert()).premultiply(Qsd).multiply(Qsd.clone().invert());
  const fw = new V3(0, 0, 1).applyQuaternion(d0); fw.y = 0; fw.normalize();
  const yaw0 = Math.atan2(fw.x, fw.z), unyaw = new Q().setFromAxisAngle(new V3(0, 1, 0), -yaw0);
  const hipH = { s: S.Hips.p.y, d: D.pelvis.p.y }, k = Math.abs(hipH.d / hipH.s);
  const sHips0 = S.Hips.p.clone();                                    // (from the REST: a sitting clip's pelvis drop is kept)
  const n = Math.round(ref.clip.duration * fps) + 1;
  const frames = maps.map(() => new Float32Array(n * 4)), hipsPos = new Float32Array(n * 3);
  const world = maps.map(() => new Q()), local = new Q(), sw = new Q();
  for (let f = 0; f < n; f++) {
    ref.at(Math.min(f / fps, ref.clip.duration));
    maps.forEach((m, i) => {
      // Mixamo's rotation away from its rest, in the robot's space, facing taken out
      sw.copy(srcModelQ(ref.bone(m.src))).multiply(m.sRestInv);
      sw.premultiply(Qsd).multiply(Qsd.clone().invert()).premultiply(unyaw);
      world[i].copy(sw).multiply(m.dRestAligned);
    });
    maps.forEach((m, i) => {
      const pw = m.parentMap ? world[maps.indexOf(m.parentMap)] : m.parentRest;
      local.copy(pw).invert().multiply(world[i]);
      local.toArray(frames[i], f * 4);
    });
    const hp = srcRoot.worldToLocal(hips.getWorldPosition(new V3())).sub(sHips0).applyQuaternion(Qsd).applyQuaternion(unyaw).multiplyScalar(k);
    hp.toArray(hipsPos, f * 3);
  }
  // a direction between two of the clip's bones at t, in the robot's space (e.g. its arrow line)
  const dirAt = (t, a, b) => { ref.at(t); const pa = srcRoot.worldToLocal(ref.bone(a).getWorldPosition(new V3())), pb = srcRoot.worldToLocal(ref.bone(b).getWorldPosition(new V3())); return pb.sub(pa).applyQuaternion(Qsd).applyQuaternion(unyaw).normalize(); };
  ref.at(0);
  const out = makePlayer(robot, { duration: ref.clip.duration, fps, names: maps.map((m) => m.dst), frames, hips: hipsPos });
  out.dirAt = dirAt;
  return out;
}

// the player: pose the robot at a clip time, blended over its current pose
function makePlayer(robot, data) {
  const { duration, fps, names, frames, hips } = data, n = Math.round(duration * fps) + 1;
  const D = restOf(skinOf(robot)), dByBone = new Map(Object.values(D).map((r) => [r.bone, r]));
  const bones = names.map((nm) => D[nm].bone), pelvis = D.pelvis.bone;
  // the pelvis' rest local position (its bind relative to its parent's bind)
  const rootRest = dByBone.get(pelvis.parent);
  const rqInv = rootRest ? rootRest.q.clone().invert() : new Q();
  const pelvisRestLocal = D.pelvis.p.clone().sub(rootRest ? rootRest.p : new V3()).applyQuaternion(rqInv);
  const qa = new Q(), qb = new Q(), pa = new V3(), pb = new V3();
  return {
    duration, fps, names, frames, hips,
    /** the baked frames as a THREE.AnimationClip on this figure's bone names (for its mixer) */
    toClip(name) {
      const times = Array.from({ length: n }, (_, i) => Math.min(i / fps, duration));
      const tracks = bones.map((b, j) => new THREE.QuaternionKeyframeTrack(`${b.name}.quaternion`, times, Array.from(frames[j])));
      const pos = [];
      for (let i = 0; i < n; i++) { const v = pelvisRestLocal.clone().add(pa.fromArray(hips, i * 3).applyQuaternion(rqInv)); pos.push(v.x, v.y, v.z); }
      tracks.push(new THREE.VectorKeyframeTrack(`${pelvis.name}.position`, times, pos));
      return new THREE.AnimationClip(name, duration, tracks);
    },
    /** pose the robot at clip time t, blended over its current pose by w (0..1) */
    apply(t, w = 1, { hips: moveHips = true, only = null, loop = false } = {}) {
      if (w <= 0) return;
      // (loop: t wraps round the clip; only: a Set of bone names — a layer, e.g. the legs)
      const tt = loop ? ((t % duration) + duration) % duration : THREE.MathUtils.clamp(t, 0, duration);
      const x = tt * fps, i0 = Math.min(n - 1, Math.floor(x)), i1 = loop ? (i0 + 1) % n : Math.min(n - 1, i0 + 1), a = x - i0;
      bones.forEach((b, j) => {
        if (only && !only.has(names[j])) return;
        qa.fromArray(frames[j], i0 * 4); qb.fromArray(frames[j], i1 * 4); qa.slerp(qb, a);
        b.quaternion.slerp(qa, w);
      });
      if (moveHips && (!only || only.has("pelvis"))) {
        pa.fromArray(hips, i0 * 3); pb.fromArray(hips, i1 * 3); pa.lerp(pb, a);
        pelvis.position.lerp(pelvisRestLocal.clone().add(pa.applyQuaternion(rqInv)), w);   // (the offset is in the robot's model space: into the pelvis' parent's)
      }
      robot.updateMatrixWorld(true);
    },
    /** an in-place walk's speed ON THIS FIGURE (m/s): how fast its planted foot (the lower
     *  one) slides back under it — its own legs set the stride, not the clip's source */
    stepSpeed() {
      const fl = D.foot_l?.bone, fr = D.foot_r?.bone;
      if (!fl || !fr) return null;
      const keep = bones.map((b) => b.quaternion.clone()), keepP = pelvis.position.clone();
      const at = (b) => b.getWorldPosition(new V3());                 // (world: metres whatever the figure's own scale)
      const v = [];
      let prev = null;
      for (let i = 0; i < n; i++) {
        this.apply(i / fps, 1);
        const f = [at(fl), at(fr)], k = f[0].y < f[1].y ? 0 : 1;
        if (prev && prev.k === k) v.push(Math.hypot(f[k].x - prev.f[k].x, f[k].z - prev.f[k].z) * fps);
        prev = { f, k };
      }
      bones.forEach((b, j) => b.quaternion.copy(keep[j])); pelvis.position.copy(keepP); robot.updateMatrixWorld(true);
      v.sort((x, y) => x - y);
      return v.length ? v[Math.floor(v.length / 2)] : null;
    },
  };
}

/** a baked clip as plain JSON (rounded), with any extra fields (e.g. arrowYaw) */
export function bakedToJSON(b, extra = {}) {
  const r = (a) => Array.from(a, (x) => Math.round(x * 1e4) / 1e4);
  return { version: 1, duration: b.duration, fps: b.fps, names: b.names, frames: b.frames.map(r), hips: r(b.hips), ...extra };
}
/** …and back: a player on this robot */
export function bakedFromJSON(data, robot) {
  const p = makePlayer(robot, { ...data, frames: data.frames.map((f) => Float32Array.from(f)), hips: Float32Array.from(data.hips) });
  for (const k of Object.keys(data)) if (!(k in p)) p[k] = data[k];
  return p;
}
