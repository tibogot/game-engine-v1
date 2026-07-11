// Combat FX — GAME code. Muzzle flashes, impact sparks and explosions.
// (Tracers are gone: shots are now visible rockets — see projectiles.js.)
//
// Every material writes to the emissive MRT buffer via bloom.js, so v3's
// existing selective-bloom pass makes them glow with no pipeline work.
// Everything is POOLED — combat spawns FX constantly.
import * as THREE from "three";
import { makeBloomMaterial, BLOOM } from "./bloom.js";

const FLASH_LIFE = 0.07;
const IMPACT_LIFE = 0.24;
const EXPLOSION_LIFE = 0.6;

export function createCombatFx({ app, pool = 40 }) {
  const { scene } = app;

  const flashMat = makeBloomMaterial({ color: 0xffd27a, soft: true }, BLOOM.muzzle);
  const impactMat = makeBloomMaterial({ color: 0xff9a3c, soft: true }, BLOOM.impact);
  const fireMat = makeBloomMaterial({ color: 0xff6a1e, soft: true }, BLOOM.fire);

  function makeSprites(mat, n, size) {
    const arr = [];
    for (let i = 0; i < n; i++) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(size, size), mat);
      m.visible = false;
      m.frustumCulled = false;
      scene.add(m);
      arr.push({ mesh: m, t: 0, life: 1, size });
    }
    return arr;
  }
  const flashes = makeSprites(flashMat, pool, 2.4);
  const impacts = makeSprites(impactMat, pool, 3.0);
  const blasts = makeSprites(fireMat, 16, 12);

  const takeFree = (arr) => arr.find((e) => !e.mesh.visible) ?? arr[0];

  const fire = (arr, x, y, z, life) => {
    const e = takeFree(arr);
    e.mesh.position.set(x, y, z);
    e.mesh.visible = true;
    e.t = life;
    e.life = life;
  };

  const muzzle    = (x, y, z) => fire(flashes, x, y, z, FLASH_LIFE);
  const impact    = (x, y, z) => fire(impacts, x, y, z, IMPACT_LIFE);
  const explosion = (x, y, z) => fire(blasts, x, y + 1.5, z, EXPLOSION_LIFE);

  function update(dt, camera) {
    for (const arr of [flashes, impacts, blasts]) {
      for (const e of arr) {
        if (!e.mesh.visible) continue;
        e.t -= dt;
        if (e.t <= 0) { e.mesh.visible = false; continue; }
        const p = e.t / e.life;                                // 1 → 0
        if (camera) e.mesh.quaternion.copy(camera.quaternion); // billboard
        const grow = 1 + (1 - p) * 1.5;                        // expand as it fades
        e.mesh.scale.setScalar(grow * (0.35 + p * 0.65));
      }
    }
  }

  return { muzzle, impact, explosion, update };
}
