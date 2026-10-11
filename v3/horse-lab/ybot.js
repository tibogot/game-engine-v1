// ── Horse lab: Mixamo's Y Bot as the rider (?rider=ybot) ─────────────────────
// The rider code finds bones by the robot's (UE) names and measures everything
// else from the rest pose — so Y Bot's bones are RENAMED to those names here
// (mixamorig:Hips → pelvis, LeftUpLeg → thigh_l, …) and the rest just works.
// It returns what loadRider returns ({ rig, model, clips, bone, height }); its
// clips are the robot's own (sit, idle, walk, jog) RETARGETED onto it, so the
// game asks for the same names. Mixamo clips play on it exactly as captured —
// same proportions, no corrections for build.
import * as THREE from "three";
import { FBXLoader } from "three/addons/loaders/FBXLoader.js";
import * as SkeletonUtils from "three/addons/utils/SkeletonUtils.js";
import { bakeMixamoOnto, UE_FROM_MIXAMO } from "./retarget.js";

const V3 = THREE.Vector3;
// the robot's clips the game plays (rider: sit; mount system: idle, walk, jog)
export const RIDER_CLIPS = ["Sitting_Idle_Loop_Armature", "Idle_Loop_Armature", "Walk_Loop_Armature", "Jog_Fwd_Loop_Armature"];

export async function loadYBot(url, robot, { height = 1.78, clipNames = RIDER_CLIPS } = {}) {
  const fbx = await new FBXLoader().loadAsync(url);
  fbx.animations = [];
  // the robot's bone names
  fbx.traverse((o) => { if (o.isBone) { const k = o.name.replace(/^mixamorig:?/, ""); if (UE_FROM_MIXAMO[k]) o.name = UE_FROM_MIXAMO[k]; } });
  // ONE skeleton, of EVERY bone, for both meshes: the FBX gives each mesh its own, of only
  // the bones that move its vertices (some finger joints missing — code reading "the"
  // skeleton found holes). A missing bone's rest = its pose as loaded (the bind T-pose).
  const skins = []; fbx.traverse((o) => { if (o.isSkinnedMesh) skins.push(o); });
  fbx.updateMatrixWorld(true);
  // (each Mixamo bone also comes with a same-named COPY as its child, childless — a name
  // then found either; the copies go, their skin weights to their real bone)
  const dup = (b) => b.parent?.isBone && b.parent.name === b.name && b.children.length === 0;
  const real = (b) => (dup(b) ? b.parent : b);
  const copies = []; fbx.traverse((o) => { if (o.isBone && dup(o)) copies.push(o); });
  const all = []; fbx.traverse((o) => { if (o.isBone && !dup(o)) all.push(o); });
  const inv = all.map((b) => { for (const m of skins) { const i = m.skeleton.bones.indexOf(b); if (i >= 0) return m.skeleton.boneInverses[i].clone(); } return b.matrixWorld.clone().invert(); });
  const skeleton = new THREE.Skeleton(all, inv);
  for (const m of skins) {
    const map = m.skeleton.bones.map((b) => all.indexOf(real(b))), si = m.geometry.attributes.skinIndex;
    for (let i = 0; i < si.count; i++) for (let c = 0; c < si.itemSize; c++) si.setComponent(i, c, Math.max(0, map[si.getComponent(i, c)]));
    si.needsUpdate = true;
    m.bind(skeleton, m.bindMatrix);
  }
  for (const c of copies) c.removeFromParent();
  // a clean look: light grey body, darker joints (the FBX's Phong materials, replaced)
  const body = new THREE.MeshStandardMaterial({ color: 0xb8bcc4, roughness: 0.55, metalness: 0.05 });
  const joints = new THREE.MeshStandardMaterial({ color: 0x3a3f4a, roughness: 0.6 });
  fbx.traverse((o) => { if (o.isMesh) { o.material = /joint/i.test(o.name) ? joints : body; o.castShadow = o.receiveShadow = true; o.frustumCulled = false; } });
  // placed as loadRider places the robot: facing +z, scaled to the height
  const model = fbx, rig = new THREE.Group();
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
  // the robot's clips onto it (the retargeter run the other way: a UE-named source)
  const src = SkeletonUtils.clone(robot.model), mixer = new THREE.AnimationMixer(src);
  const clips = {};
  for (const name of clipNames) {
    const clip = robot.clips[name];
    if (!clip) continue;
    mixer.stopAllAction();
    const act = mixer.clipAction(clip); act.play();
    const ref = { ue: true, root: src, clip, bone: (n) => src.getObjectByName(UE_FROM_MIXAMO[n] ?? n), at(t) { mixer.setTime(t); src.updateMatrixWorld(true); } };
    clips[name] = bakeMixamoOnto(ref, model).toClip(name);
  }
  mixer.stopAllAction(); mixer.uncacheRoot(src);
  return { rig, model, clips, bone, height, kind: "ybot" };
}
