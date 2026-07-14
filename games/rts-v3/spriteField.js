// Instanced billboard sprites — ONE draw call per FX kind.
//
// Combat FX used to be a pool of individual Meshes: 40 muzzle flashes + 40
// impacts + 16 blasts + 220 trail puffs, each its own draw the moment it turned
// visible. A quiet frame cost ~55 draws; a firefight cost 600+, because the draw
// count scaled with how much was ON FIRE. That's the worst possible shape — the
// cost spikes exactly when the frame is already busy.
//
// Now each kind is one InstancedMesh with a live `count`. 200 puffs cost the same
// single draw as one. As a bonus we can finally fade each sprite INDIVIDUALLY:
// the old pool shared one material, so it could only fade by shrinking (see the
// note that used to live in projectiles.js). Life is a per-instance attribute now.
import * as THREE from "three";
import { attribute, uv, vec2, float, smoothstep, mul, materialColor } from "three/tsl";
import { BloomMRTNode } from "./bloom.js";

const _obj = new THREE.Object3D();

/**
 * A pool of camera-facing, emissive (blooming) sprites drawn in one instanced call.
 *
 * `scaleAt(p)` maps remaining life (p: 1 → 0) to a scale multiplier, so each FX
 * keeps its own growth curve. `fadeAt(p)` does the same for opacity.
 */
export function createSpriteField({
  scene,
  max = 64,
  color = 0xffffff,
  size = 1,
  bloomScale = 1,
  blending = THREE.AdditiveBlending,
  soft = true,                       // radial falloff → reads as a glow, not a quad
  scaleAt = (p) => 0.35 + p * 0.65,
  fadeAt = (p) => p,
}) {
  const geo = new THREE.PlaneGeometry(size, size);

  // Remaining life of each instance, 1 → 0. Drives per-sprite fade.
  const lifeAttr = new THREE.InstancedBufferAttribute(new Float32Array(max), 1);
  lifeAttr.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute("iFade", lifeAttr);

  const fade = attribute("iFade", "float");

  let alpha = fade;
  if (soft) {
    const d = uv().sub(vec2(0.5)).length();          // 0 centre → ~0.707 corner
    alpha = mul(alpha, smoothstep(float(0.5), float(0.0), d));
  }

  const mat = new THREE.MeshBasicNodeMaterial({
    transparent: true, depthWrite: false, depthTest: true,
    blending, side: THREE.DoubleSide,
  });
  mat.color.set(color);
  mat.opacityNode = alpha;
  // Emissive MRT → v3's selective bloom makes it glow. BloomMRTNode (not mrt())
  // so offscreen bakes with no "emissive" attachment don't blow up.
  mat.mrtNode = new BloomMRTNode({ emissive: mul(mul(materialColor.rgb, float(bloomScale)), alpha) });

  const mesh = new THREE.InstancedMesh(geo, mat, max);
  mesh.count = 0;
  mesh.frustumCulled = false;
  scene.add(mesh);

  // Pool: `t` counts down, `life` is what it started at.
  const pool = [];
  for (let i = 0; i < max; i++) pool.push({ t: 0, life: 1, x: 0, y: 0, z: 0 });
  let next = 0;

  return {
    mesh,

    /** Light up one sprite for `life` seconds. Oldest is recycled when full. */
    spawn(x, y, z, life) {
      let e = pool.find((s) => s.t <= 0);
      if (!e) { e = pool[next]; next = (next + 1) % max; } // all busy → steal one
      e.x = x; e.y = y; e.z = z;
      e.t = life;
      e.life = life;
    },

    /** Age every live sprite and rewrite the instance buffer. */
    update(dt, camera) {
      let n = 0;
      for (const e of pool) {
        if (e.t <= 0) continue;
        e.t -= dt;
        if (e.t <= 0) continue;

        const p = e.t / e.life; // 1 → 0 over its life

        _obj.position.set(e.x, e.y, e.z);
        if (camera) _obj.quaternion.copy(camera.quaternion); // billboard
        _obj.scale.setScalar(scaleAt(p));
        _obj.updateMatrix();
        mesh.setMatrixAt(n, _obj.matrix);
        lifeAttr.setX(n, fadeAt(p));
        n++;
      }
      mesh.count = n;
      mesh.instanceMatrix.needsUpdate = true;
      lifeAttr.needsUpdate = true;
    },

    dispose() {
      scene.remove(mesh);
      geo.dispose();
      mat.dispose();
    },
  };
}
