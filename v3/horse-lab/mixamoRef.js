// ── Horse lab: a Mixamo clip as a motion REFERENCE ──────────────────────────
// Loads an FBX from v3/horse-lab/refs (kept out of git) — the clip's own figure,
// in metres, posed at a time. For measuring a real (mocap) motion beside ours,
// as the Muybridge plates were for the horse; nothing here drives the robot.
import * as THREE from "three";
import { FBXLoader } from "three/addons/loaders/FBXLoader.js";

export async function loadMixamoRef(url) {
  const fbx = await new FBXLoader().loadAsync(url);
  fbx.scale.setScalar(0.01);                               // (Mixamo FBX: centimetres)
  const clip = fbx.animations[0];
  const mixer = new THREE.AnimationMixer(fbx), action = mixer.clipAction(clip);
  action.play();
  const bone = (n) => fbx.getObjectByName("mixamorig" + n) ?? fbx.getObjectByName("mixamorig:" + n);
  return {
    root: fbx, clip, mixer, bone,
    at(t) { mixer.setTime(t); fbx.updateMatrixWorld(true); },
  };
}
