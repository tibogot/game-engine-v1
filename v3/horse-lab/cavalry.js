// ── Horse lab: a CAVALRY of knights as GPU crowds (the alg-rts soldier path) ──
// The full knight (horse controller + hoof IK + tail rope + rider IK + rope
// reins) costs CPU per knight every frame. The RTS games draw hundreds of
// soldiers by NOT running that per unit: the poses are BAKED once into a
// [frame][bone] matrix table, a compute pass skins every instance, and ONE draw
// per body part draws them all (v3/render/crowdSkinning.js). Per frame the CPU
// writes a transform and a frame index per knight — the cost stays flat.
//
// Here the bake is RECORDED from the live knight: the real horse (its IK, tail
// rope, neck) and the real rider (his posture, reins) are stepped on the spot
// through one stride of each gait and their skeletons' bone matrices are stored
// as they are — so a crowd knight moves exactly like the full one did, minus
// reacting to the ground (they ride flat ground in formation).
//
// Usage: panel "Cavalry (GPU crowd)" → count; or __HORSE.cavalry.set(n).
import * as THREE from "three";
import { storage } from "three/tsl";
import { createCrowdField } from "../render/crowdSkinning.js";

const V3 = THREE.Vector3;
const GAITS = { gallop: { fwd: 1, run: true }, canter: { fwd: 1, gear: "Canter" }, walk: { fwd: 1 } };

export function createCavalry({ scene, renderer, horse, ctrl, rider, D }) {
  let fields = null, n = 0, t = 0, gait = "gallop";
  const MAX = 120;

  // ── recording: one stride of each gait, on the spot, both skeletons ─────────
  function record() {
    const DT = 1 / 60, saved = { pos: ctrl.pos.clone(), yaw: ctrl.yaw, v: ctrl.v, y: ctrl.y, gear: ctrl.gear };
    const step = (inp) => { ctrl.pos.set(0, ctrl.pos.y, 0); ctrl.yaw = 0; ctrl.update(DT, inp); rider.update(DT, { lookYaw: 0, input: {} }); };
    // the skeletons: the horse's parts share one; the rider has his own
    const horseParts = [], riderParts = [];
    horse.model.traverse((o) => { if (o.isSkinnedMesh && o.visible && o.geometry.attributes.uv) horseParts.push(o); });
    rider.r.rig.parent.traverse((o) => { if (o.isSkinnedMesh && o.visible && /Mannequin/.test(o.name)) riderParts.push(o); });
    const skH = horseParts[0].skeleton, skR = riderParts[0].skeleton;
    const tables = { H: [], R: [] }, info = {};
    D.auditing = true;
    let offset = 0;
    try {
      if (ctrl.oneShot) ctrl.endOneShot();
      for (const [name, inp] of Object.entries(GAITS)) {
        if (inp.gear) ctrl.gear = Math.max(0, ["Walk", "Canter", "Gallop"].indexOf(inp.gear));
        for (let i = 0; i < 240; i++) step(inp);                // settle into the gait
        const act = ctrl.cur, period = act.getClip().duration / Math.max(0.05, Math.abs(act.getEffectiveTimeScale()));
        const frames = Math.max(8, Math.round(period * 60));
        for (let f = 0; f < frames; f++) {
          step(inp);
          scene.updateMatrixWorld(true);
          skH.update(); skR.update();
          tables.H.push(skH.boneMatrices.slice()); tables.R.push(skR.boneMatrices.slice());
        }
        info[name] = { offset, frames, duration: frames / 60, speed: ctrl.v };
        offset += frames;
      }
    } finally {
      D.auditing = false;
      Object.assign(ctrl, { yaw: saved.yaw, v: 0, gear: 0 }); ctrl.pos.copy(saved.pos);
    }
    const baked = (list, sk) => {
      const boneCount = sk.bones.length, table = new Float32Array(list.length * boneCount * 16);
      list.forEach((m, i) => table.set(m.subarray(0, boneCount * 16), i * boneCount * 16));
      const attr = new THREE.StorageBufferAttribute(list.length * boneCount, 16);
      attr.array.set(table); attr.needsUpdate = true;
      return { table, slices: list.length, boneCount, info, bones: storage(attr, "mat4", attr.count).toReadOnly() };
    };
    return { parts: [...horseParts.map((m) => [m, "H"]), ...riderParts.map((m) => [m, "R"])], bakedH: baked(tables.H, skH), bakedR: baked(tables.R, skR), info };
  }

  function build() {
    const rec = record();
    fields = rec.parts.map(([m, who]) => {
      // a frozen source: its bind, and NO mesh-world inverse — the recorded bone
      // matrices already hold each vertex's world place (horse at the origin),
      // the instance matrix moves it to the knight's spot
      const src = { geometry: m.geometry, skeleton: m.skeleton, material: m.material, bindMatrix: m.bindMatrix.clone(), bindMatrixInverse: new THREE.Matrix4() };
      const f = createCrowdField({ scene, renderer, source: src, animRoot: null, clips: {}, max: MAX, castShadow: true, shareFrom: { baked: who === "H" ? rec.bakedH : rec.bakedR } });
      f.mesh.name = `cavalry:${m.name}`;
      return f;
    });
    return rec.info;
  }

  // the formation: rows of five, riding a loop round the field's middle
  const C = new V3(0, 0, 35), R = 58, mtx = new THREE.Matrix4(), q = new THREE.Quaternion(), one = new V3(1, 1, 1), p = new V3(), UP = new V3(0, 1, 0);
  let info = null;
  function update(dt) {
    if (!fields || n === 0) { if (fields) for (const f of fields) { f.begin(); f.commit(); } return; }
    const g = info[gait], v = g.speed;
    t += dt;
    for (const f of fields) f.begin();
    for (let i = 0; i < n; i++) {
      const row = Math.floor(i / 5), col = i % 5;
      const lat = (col - 2) * 2.4, s = v * t - row * 4.2;
      const th = s / R, rr = R + lat;
      p.set(C.x + rr * Math.cos(th), 0, C.z + rr * Math.sin(th));
      q.setFromAxisAngle(UP, Math.atan2(-Math.sin(th), Math.cos(th)));
      mtx.compose(p, q, one);
      const ph = t + i * 0.137 + row * 0.05;                     // each knight a little out of step
      for (const f of fields) f.addPose(mtx, gait, ph, gait, ph, 1);
    }
    for (const f of fields) f.commit();
  }

  return {
    set(count, g = gait) {
      if (!fields) info = build();
      n = Math.max(0, Math.min(MAX, count | 0)); gait = g;
    },
    update,
    get count() { return n; },
    /** Knight i's ground position and heading now (for cameras). */
    where(i = 0) { const v = info?.[gait]?.speed ?? 0, row = Math.floor(i / 5), col = i % 5, s = v * t - row * 4.2, th = s / R, rr = R + (col - 2) * 2.4; return { x: C.x + rr * Math.cos(th), z: C.z + rr * Math.sin(th), yaw: Math.atan2(-Math.sin(th), Math.cos(th)) }; },
    get drawsPerFrame() { return fields ? fields.length : 0; },
  };
}
