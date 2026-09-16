/**
 * TERRAIN SELF-SHADOWING — mountains shade valleys, at any distance.
 *
 * The terrain has never cast a shadow. It is not a CSM caster (receiveShadow
 * only), and even if it were, the cascades end at maxFar (150 m) while the
 * valley a mountain darkens can be a kilometre away. So a sunset over a ridge
 * lit both sides of it identically.
 *
 * This marches from each terrain VERTEX toward the sun through the heightmap
 * and asks whether the ray passes under the ground. Why per vertex:
 *
 *   - The terrain FRAGMENT stage is at exactly 16 of WebGPU's 16 samplers
 *     (see terrainNormalMap.js). One more texture there and the terrain
 *     silently stops drawing. The vertex stage has room, and already reads the
 *     heightmap for displacement — this adds no binding at all.
 *   - There is nothing to bake. The sun can move every frame (time of day) and
 *     a sculpt stroke shows its new shadow immediately, because the march reads
 *     the live heightmap.
 *   - The clipmap is ~84k vertices whose spacing grows with distance, which is
 *     the resolution a terrain shadow wants: fine near, broad far. Interpolating
 *     the result across triangles gives the soft edge for free.
 *
 * The march is exponential: short steps near the vertex (a ridge right next to
 * it) growing to the far side of the world, with a penumbra term k·clearance/t
 * (the classic heightfield soft shadow) so the edge widens with distance to the
 * occluder the way a real sun's does.
 *
 * It reaches the lighting through the SUN'S SHADOW NODE, not through a material
 * hook: CSMShadowNode only applies `receivedShadowNode` inside its cascades,
 * so past maxFar — exactly where mountain shade matters — it would never run.
 * `wrapSunShadow` multiplies the terrain term onto whatever the sun's shadow
 * already is, for materials that carry `terrainSunShadowNode`, and passes every
 * other material the untouched node. The branch happens at shader BUILD time,
 * so other materials pay nothing.
 */
import * as THREE from "three";
import {
  Fn,
  Loop,
  If,
  Break,
  float,
  vec2,
  uniform,
  texture,
  normalize,
  length,
  max,
  min,
  mix,
  clamp,
  smoothstep,
  step,
  nodeObject,
} from "three/tsl";

/** Direction TOWARDS the light that lights the scene (the moon at night). */
export const uTerrainSunDir = uniform(new THREE.Vector3(0.4, 0.7, 0.3));
/** 0 = off, 1 = full. A uniform, so toggling never recompiles. */
export const uTerrainShadowStrength = uniform(1);
/** Penumbra sharpness k: larger is harder. Driven from a 0..1 softness slider. */
export const uTerrainShadowK = uniform(12);

const STEPS = 32;

export function setTerrainSunDirection(dir) {
  uTerrainSunDir.value.copy(dir);
}

export function setTerrainShadowParams({ enabled = true, softness = 0.5 } = {}) {
  uTerrainShadowStrength.value = enabled ? 1 : 0;
  // softness 0 → k 40 (crisp), 1 → k 4 (very soft)
  const s = THREE.MathUtils.clamp(Number(softness) || 0, 0, 1);
  uTerrainShadowK.value = THREE.MathUtils.lerp(40, 4, s);
}

/**
 * Sun visibility at a terrain vertex, 1 = lit, 0 = in a mountain's shadow.
 * Build it in the VERTEX stage (wrap in `varying`): it samples the heightmap
 * 32 times.
 *
 * @param {object} o
 * @param {Node}   o.heightTexNode  the heightmap (R = height / maxHeight)
 * @param {Node}   o.worldX, o.worldZ, o.worldY  the displaced vertex
 * @param {number} o.worldSize, o.maxHeight, o.baseStep  terrain config
 */
export function terrainSunVisibility({ heightTexNode, worldX, worldZ, worldY, worldSize, maxHeight, baseStep }) {
  const tStart = Math.max(baseStep, 0.5) * 1.5;
  const tEnd = worldSize * 1.5;                       // corner to corner, and a bit
  const growth = Math.pow(tEnd / tStart, 1 / (STEPS - 1));
  const half = worldSize * 0.5;
  // No ray above this can be blocked. Stored heights may exceed 1.0 × maxHeight,
  // so leave generous headroom rather than break early past a real peak.
  const ceiling = maxHeight * 2.0;

  return Fn(() => {
    const L = normalize(uTerrainSunDir);
    const horiz = max(length(L.xz), float(1e-4));
    const dir = L.xz.div(horiz);
    const rise = L.y.div(horiz);                       // metres up per metre along

    const lit = float(1).toVar();
    const t = float(tStart).toVar();
    // A small lift plus a slope-scaled bias: the ray starts ON a bilinear
    // surface and would otherwise clip the very texel it stands in.
    const y0 = worldY.add(float(0.25));

    Loop(STEPS, () => {
      const rayY = y0.add(rise.mul(t)).add(t.mul(0.004));
      If(rayY.greaterThan(ceiling), () => { Break(); });

      const qx = worldX.add(dir.x.mul(t));
      const qz = worldZ.add(dir.y.mul(t));
      const u = qx.add(half).div(worldSize);
      const v = qz.add(half).div(worldSize);
      const inBounds = step(0, u).mul(step(u, 1)).mul(step(0, v)).mul(step(v, 1));
      const h = texture(heightTexNode, vec2(u, v)).r.mul(maxHeight).mul(inBounds);

      lit.assign(min(lit, rayY.sub(h).mul(uTerrainShadowK).div(t)));
      t.mulAssign(growth);
    });

    const vis = smoothstep(0, 1, clamp(lit, 0, 1));
    return mix(float(1), vis, uTerrainShadowStrength);
  })();
}

const _wrapped = new WeakMap();

/**
 * The sun's shadow node, with the terrain's own shadow multiplied in for any
 * material that provides one. Cached per inner node so the same CSM always maps
 * to the same wrapper — a new node object would recompile every lit material.
 */
export function wrapSunShadow(inner) {
  if (!inner) return inner;
  let wrapped = _wrapped.get(inner);
  if (!wrapped) {
    wrapped = Fn((builder) => {
      const terrain = builder.material?.terrainSunShadowNode;
      return terrain ? nodeObject(inner).mul(terrain) : nodeObject(inner);
    })();
    wrapped.isTerrainShadowWrapper = true;
    wrapped.innerShadowNode = inner;
    _wrapped.set(inner, wrapped);
  }
  return wrapped;
}

/** The node a wrapper was made from (or the node itself). */
export function unwrapSunShadow(node) {
  return node?.innerShadowNode ?? node;
}
