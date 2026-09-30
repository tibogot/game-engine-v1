// BLOOD — the hit and the pool, convincing at RTS zoom and nearly free (your
// ask, 2026-09-30). Shared machinery; a game wires it to combat's hits and
// deaths (alg-rts: algCombat.js). Two instanced draws for the whole battle.
//
//   THE HIT   a few dark droplets thrown OUT of the wound, away from the
//             shooter, falling under gravity, and a faint mist that swells and
//             thins — gone in about 0.4 s. Restrained, as in Company of
//             Heroes: at this zoom a big red burst reads as a cartoon.
//   THE POOL  a ground decal under the body, draped on the terrain in the
//             vertex shader (as the craters: terrainDrape.js). Its SHAPE is
//             grown in the fragment shader — a noise-warped outline seeded per
//             man, so no two are alike, no texture at all. It spreads over the
//             first seconds, starts wet and glossy-dark, and as the sand soaks
//             it in it dries to a matte brown-red and fades with the body.
//
// Cost: the CPU writes a few floats when something spawns, never per frame —
// the droplets' flight and the pools' spread are computed on the GPU from the
// spawn time and a shared clock.
//
// `enabled` (a gore switch; ?blood=0 boots without): nothing spawns.
import * as THREE from "three";
import {
  Fn, attribute, float, max, mix, mx_noise_float, positionLocal, smoothstep, sqrt, uniform, uv, vec2, vec3, cos, sin, atan, exp,
} from "three/tsl";
import { drapedPosition } from "./terrainDrape.js";

export const BLOOD = {
  /** Pools at once (the oldest recycled). */
  maxPools: 160,
  /** Droplets + mist puffs in the air at once. */
  maxDrops: 384,
  /** Metres: a man's pool at full size, ± per man. */
  poolRadius: 0.95, poolRadiusVar: 0.35,
  /** Seconds: the body falls first, then it spreads over `spread`. */
  poolDelay: 0.6, poolSpread: 3.5,
  /** Seconds a pool lasts (the corpse: its death clip + 14 s, unitRenderer.js). */
  poolLife: 18,
  /** Droplets a hit throws. */
  dropsPerHit: 6,
  dropLife: 0.42,
  // Sand soaks it: dark red when fresh, brown-red dry. Linear colours.
  wet: [0.12, 0.006, 0.005],
  dry: [0.065, 0.014, 0.008],
  drop: [0.2, 0.01, 0.008],
};

const POOL_ORDER = 42;       // with the crater decals (craterSystem.js)
const SUBDIV = 10;           // a pool is small: 10 × 10 is enough to drape it
const LIFT = 0.12;

export function createBloodField({ app, params = BLOOD }) {
  const { scene, heightTexNode } = app;
  const P = params;
  const uTime = uniform(0);
  const enabled = typeof location === "undefined" || new URLSearchParams(location.search).get("blood") !== "0";

  // ── Pools ────────────────────────────────────────────────────────────────
  const src = new THREE.PlaneGeometry(1, 1, SUBDIV, SUBDIV).rotateX(-Math.PI / 2);
  const poolGeo = new THREE.InstancedBufferGeometry();
  poolGeo.index = src.index;
  poolGeo.setAttribute("position", src.attributes.position);
  poolGeo.setAttribute("uv", src.attributes.uv);
  const poolA = new THREE.InstancedBufferAttribute(new Float32Array(P.maxPools * 4), 4);   // x, z, radius, rotation
  const poolB = new THREE.InstancedBufferAttribute(new Float32Array(P.maxPools * 4), 4);   // birth, seed, life, stretch
  poolGeo.setAttribute("aPool", poolA);
  poolGeo.setAttribute("aPoolB", poolB);
  poolGeo.instanceCount = 0;

  const poolMat = new THREE.MeshBasicNodeMaterial({
    transparent: true, depthTest: true, depthWrite: false, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
  });
  poolMat.forceSinglePass = true;   // a flat decal never overlaps itself (craterSystem.js)
  poolMat.positionNode = Fn(() => {
    const a = attribute("aPool", "vec4"), b = attribute("aPoolB", "vec4");
    const s = sin(a.w), c = cos(a.w);
    // stretched along its own axis: a body is longer than it is wide
    const lx = positionLocal.x.mul(a.z.mul(2)).mul(b.w), lz = positionLocal.z.mul(a.z.mul(2));
    return drapedPosition(heightTexNode, lx.mul(c).add(lz.mul(s)).add(a.x), lz.mul(c).sub(lx.mul(s)).add(a.y), LIFT);
  })();
  {
    const b = attribute("aPoolB", "vec4");
    const age = uTime.sub(b.x);
    // Spread: nothing while the body falls, then a fast start easing out.
    const grow = float(1).sub(exp(max(age.sub(P.poolDelay), 0).mul(-3 / P.poolSpread)));
    // The outline: a circle pushed in and out by noise round it (lobes) and a
    // finer ragged rim, both seeded per pool.
    const p = uv().sub(vec2(0.5)).mul(2);                      // -1..1
    const r = sqrt(p.x.mul(p.x).add(p.y.mul(p.y)));
    const ang = atan(p.y, p.x);
    const seed = b.y.mul(17.3);
    const lobes = mx_noise_float(vec3(cos(ang).mul(1.3), sin(ang).mul(1.3), seed)).mul(0.28);
    const rag = mx_noise_float(vec3(p.mul(7.5), seed.add(4.1))).mul(0.07);
    const edge = float(0.78).add(lobes).add(rag).mul(grow);    // the outline's radius, 0..~1
    const inside = smoothstep(edge, edge.sub(0.035), r);       // a liquid edge: sharp, a hair soft
    // Dries from the rim in (sand drinks the edge first), fades at the end.
    const dryness = smoothstep(2, 12, age).add(smoothstep(edge.mul(0.55), edge, r).mul(0.35)).min(1);
    const thick = smoothstep(edge, edge.mul(0.3), r);           // deeper toward the middle
    const col = mix(vec3(...P.wet), vec3(...P.dry), dryness).mul(mix(float(1.15), float(0.8), thick));
    const fade = float(1).sub(smoothstep(b.z.sub(2.5), b.z, age));
    poolMat.colorNode = col;
    poolMat.opacityNode = inside.mul(fade).mul(mix(float(0.92), float(0.8), dryness));
  }
  const poolMesh = new THREE.Mesh(poolGeo, poolMat);
  poolMesh.renderOrder = POOL_ORDER;
  poolMesh.frustumCulled = false;
  poolMesh.visible = false;
  poolMesh.name = "BloodPools";
  scene.add(poolMesh);
  let poolCount = 0, poolCursor = 0;

  // ── Droplets and mist ────────────────────────────────────────────────────
  // A quad per drop, turned to the camera in the vertex shader (the camera's
  // right / up as uniforms), flying from its spawn under gravity.
  const quad = new THREE.PlaneGeometry(1, 1);
  const dropGeo = new THREE.InstancedBufferGeometry();
  dropGeo.index = quad.index;
  dropGeo.setAttribute("position", quad.attributes.position);
  dropGeo.setAttribute("uv", quad.attributes.uv);
  const dropA = new THREE.InstancedBufferAttribute(new Float32Array(P.maxDrops * 4), 4);   // x, y, z, birth
  const dropB = new THREE.InstancedBufferAttribute(new Float32Array(P.maxDrops * 4), 4);   // vx, vy, vz, size
  const dropC = new THREE.InstancedBufferAttribute(new Float32Array(P.maxDrops), 1);       // 0 droplet, 1 mist
  dropGeo.setAttribute("aDrop", dropA);
  dropGeo.setAttribute("aDropV", dropB);
  dropGeo.setAttribute("aMist", dropC);
  dropGeo.instanceCount = 0;
  const uRight = uniform(new THREE.Vector3(1, 0, 0)), uUp = uniform(new THREE.Vector3(0, 1, 0));

  const dropMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthTest: true, depthWrite: false, side: THREE.FrontSide });
  {
    const a = attribute("aDrop", "vec4"), v = attribute("aDropV", "vec4"), mist = attribute("aMist", "float");
    const age = uTime.sub(a.w);
    const life = mix(float(P.dropLife), float(P.dropLife * 1.6), mist);
    const t = age.clamp(0, life);
    const k = t.div(life);                                      // 0 → 1 over its life
    // droplets fall (and slow a little), mist hangs and swells
    const g = mix(float(9.8), float(0.6), mist);
    const pos = vec3(a.x, a.y, a.z).add(vec3(v.x, v.y, v.z).mul(t)).sub(vec3(0, g.mul(t).mul(t).mul(0.5), 0));
    const size = v.w.mul(mix(float(1).sub(k.mul(0.4)), float(1).add(k.mul(1.6)), mist));
    dropMat.positionNode = pos.add(uRight.mul(positionLocal.x.mul(size))).add(uUp.mul(positionLocal.y.mul(size)));
    const d = uv().sub(vec2(0.5)).length();
    const round = smoothstep(float(0.5), mix(float(0.32), float(0.0), mist), d);
    const alive = age.greaterThanEqual(0).and(age.lessThan(life)).select(float(1), float(0));
    dropMat.colorNode = vec3(...P.drop);
    dropMat.opacityNode = round.mul(alive).mul(mix(float(1).sub(k.mul(k)), float(0.35).mul(float(1).sub(k)), mist));
  }
  const dropMesh = new THREE.Mesh(dropGeo, dropMat);
  dropMesh.frustumCulled = false;
  dropMesh.visible = false;
  dropMesh.name = "BloodDrops";
  scene.add(dropMesh);
  let dropCount = 0, dropCursor = 0, lastDrop = -1e9;

  let time = 0;
  const rnd = Math.random;

  return {
    params: P,
    enabled,
    /**
     * A man hit at `at` (world, the wound), by a shooter at `from` (or null):
     * droplets out of the far side, a puff of mist.
     */
    hit(at, from = null) {
      if (!enabled) return;
      let dx = 0, dz = 0;
      if (from) { dx = at.x - from.x; dz = at.z - from.z; const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l; }
      const put = (vx, vy, vz, size, mist) => {
        const i = dropCursor;
        dropA.setXYZW(i, at.x + dx * 0.15, at.y, at.z + dz * 0.15, time);
        dropB.setXYZW(i, vx, vy, vz, size);
        dropC.setX(i, mist);
        dropCursor = (dropCursor + 1) % P.maxDrops;
        dropCount = Math.min(dropCount + 1, P.maxDrops);
      };
      for (let k = 0; k < P.dropsPerHit; k++) {
        const s = 1.6 + rnd() * 2.2;
        put(dx * s + (rnd() - 0.5) * 1.6, 0.8 + rnd() * 1.8, dz * s + (rnd() - 0.5) * 1.6, 0.05 + rnd() * 0.06, 0);
      }
      put(dx * 0.6, 0.35, dz * 0.6, 0.35, 1);
      dropA.needsUpdate = dropB.needsUpdate = dropC.needsUpdate = true;
      dropGeo.instanceCount = dropCount;
      dropMesh.visible = true;
      lastDrop = time;
    },
    /**
     * A man down, his chest at (x, z): his pool spreads under him, longer along
     * `heading` (the way he faced: his body's axis) than across.
     */
    pool(x, z, heading = rnd() * Math.PI * 2) {
      if (!enabled) return;
      const i = poolCursor;
      // The decal's stretched local x runs along (cos w, -sin w): the body's
      // axis (sin h, cos h) at w = h − π/2.
      poolA.setXYZW(i, x, z, P.poolRadius + (rnd() - 0.5) * 2 * P.poolRadiusVar, heading - Math.PI / 2);
      poolB.setXYZW(i, time, rnd() * 100, P.poolLife, 1.15 + rnd() * 0.3);
      poolA.needsUpdate = poolB.needsUpdate = true;
      poolCursor = (poolCursor + 1) % P.maxPools;
      poolCount = Math.min(poolCount + 1, P.maxPools);
      poolGeo.instanceCount = poolCount;
      poolMesh.visible = true;
    },
    /** Every rendered frame: the clock, the camera's axes for the droplets. */
    update(dt, camera) {
      time += dt;
      uTime.value = time;
      if (camera) {
        uRight.value.setFromMatrixColumn(camera.matrixWorld, 0);
        uUp.value.setFromMatrixColumn(camera.matrixWorld, 1);
      }
      // nothing in the air for a while: drop out of the render list
      if (dropMesh.visible && time - lastDrop > P.dropLife * 2) dropMesh.visible = false;
    },
    dispose() {
      scene.remove(poolMesh, dropMesh);
      poolGeo.dispose(); dropGeo.dispose(); src.dispose(); quad.dispose();
      poolMat.dispose(); dropMat.dispose();
    },
  };
}
