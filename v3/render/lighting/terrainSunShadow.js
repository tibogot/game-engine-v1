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
import { QuadMesh } from "three/webgpu";
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
  uv,
  vec4,
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

/*
 * ── THE BAKED VERSION ────────────────────────────────────────────────────────
 *
 * Marching every terrain vertex every frame costs ~0.24 ms whether or not the
 * sun moved — and most games set a fixed sun. So the march is done ONCE into a
 * texture, and only again when the sun turns or the terrain changes. With a
 * fixed sun the per-frame cost is a single texture read per vertex.
 *
 * What is stored is not "lit or dark" but the HEIGHT the shadow reaches at each
 * point of the map (R, metres) and how far away the blocking terrain is (G,
 * metres). A point is sunlit when it stands above that height. Two things fall
 * out of that for free:
 *   - anything, not just the ground, can ask — grass, props, trees, foliage —
 *     and a tall tree's crown pokes out into the sun while its trunk is shaded;
 *   - the penumbra can widen with the distance to the occluder (G), which is how
 *     a real sun's shadow softens.
 *
 * Texel (u, v) is the heightmap's texel (u, v): same world mapping as
 * terrainNormalMap.js, so a bilinear read at a vertex's heightmap UV agrees.
 */
export function createTerrainShadowMap({ renderer, heightTexNode, worldSize, maxHeight, heightmapSize, resolution = heightmapSize }) {
  const RES = resolution;
  const rtType = renderer?.backend?.device?.features?.has("float32-filterable")
    ? THREE.FloatType
    : THREE.HalfFloatType;
  const rt = new THREE.RenderTarget(RES, RES, {
    format: THREE.RGBAFormat,
    type: rtType,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    generateMipmaps: false,
    depthBuffer: false,
    colorSpace: THREE.NoColorSpace,
  });
  rt.texture.flipY = false;
  rt.texture.name = "TerrainShadowHeight";

  const baseStep = worldSize / heightmapSize;
  const tStart = Math.max(baseStep, 0.5) * 1.5;
  const tEnd = worldSize * 1.5;
  const growth = Math.pow(tEnd / tStart, 1 / (STEPS - 1));
  const half = worldSize * 0.5;
  const ceiling = maxHeight * 2.0;
  const NONE = -6.0e4;          // "nothing blocks this point" (inside half-float range)

  const bakeMat = new THREE.MeshBasicNodeMaterial();
  bakeMat.toneMapped = bakeMat.fog = false;
  bakeMat.depthTest = bakeMat.depthWrite = false;
  bakeMat.fragmentNode = Fn(() => {
    const c = uv();
    const wx = c.x.mul(worldSize).sub(half);
    const wz = c.y.mul(worldSize).sub(half);
    const L = normalize(uTerrainSunDir);
    const horiz = max(length(L.xz), float(1e-4));
    const dir = L.xz.div(horiz);
    const rise = L.y.div(horiz);

    const occ = float(NONE).toVar();                // shadow top height, metres
    const tOcc = float(0).toVar();                  // distance to what casts it
    const t = float(tStart).toVar();

    Loop(STEPS, () => {
      // Nothing further along can beat the current answer: even a peak at the
      // ceiling would need a lower start than we already have.
      If(float(ceiling).sub(rise.mul(t)).lessThan(occ), () => { Break(); });

      const u = wx.add(dir.x.mul(t)).add(half).div(worldSize);
      const v = wz.add(dir.y.mul(t)).add(half).div(worldSize);
      const inBounds = step(0, u).mul(step(u, 1)).mul(step(0, v)).mul(step(v, 1));
      const h = texture(heightTexNode, vec2(u, v)).r.mul(maxHeight).mul(inBounds);
      // The same lift and slope bias the per-vertex march used, moved to this
      // side of the comparison.
      const need = h.sub(rise.mul(t)).sub(t.mul(0.004)).sub(0.25);
      If(need.greaterThan(occ), () => { occ.assign(need); tOcc.assign(t); });
      t.mulAssign(growth);
    });
    return vec4(occ, tOcc, 0, 1);
  })();
  const bakeQuad = new QuadMesh(bakeMat);
  const shadowTexNode = texture(rt.texture);

  function bake() {
    renderInto(null);
    bakeCount++;
  }

  /*
   * A full bake of 1024² measured ~3.1 ms (onSubmittedWorkDone, 2026-09-16).
   * Fine once — a fixed sun, a sculpt stroke, switching shadows on — but with
   * time of day animating the light turns every frame, and re-baking all of it
   * each frame would cost 13x the per-vertex march this replaced. So while the
   * SUN moves, the map is refreshed one horizontal band per frame, BANDS of
   * them, always with the current sun. A band is ~0.2 ms; a whole sweep takes
   * BANDS frames (a quarter of a second), which at any sane day speed moves the
   * sun by far less than a shadow edge can show.
   */
  const BANDS = 16;
  const bandH = Math.ceil(RES / BANDS);
  let nextBand = 0;
  let sweepLeft = 0;

  function renderInto(bandIndex) {
    const prevRT = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    if (bandIndex !== null) {
      rt.scissor.set(0, bandIndex * bandH, RES, Math.min(bandH, RES - bandIndex * bandH));
      renderer.setScissorTest(true);
    }
    renderer.setRenderTarget(rt);
    bakeQuad.render(renderer);
    renderer.setRenderTarget(prevRT);
    if (bandIndex !== null) {
      renderer.setScissorTest(false);
      rt.scissor.set(0, 0, RES, RES);
    }
    renderer.autoClear = prevAutoClear;
  }

  let bakeCount = 0;
  let bandCount = 0;
  let lastVersion = -1;
  let lastEnabled = null;
  const lastDir = new THREE.Vector3(NaN, NaN, NaN);
  // A turn smaller than this does not start a new sweep: far below what a
  // shadow edge can show, and it keeps sub-pixel sun jitter from costing work.
  const COS_EPS = Math.cos(THREE.MathUtils.degToRad(0.03));

  /**
   * Call once per frame, after the sun has moved and before rendering.
   * Full bake when the terrain changed or shadows were switched on; one band
   * per frame while the sun is turning; nothing at all otherwise.
   */
  function bakeIfNeeded(heightVersion) {
    const enabled = uTerrainShadowStrength.value > 0;
    if (!enabled) { lastEnabled = false; sweepLeft = 0; return false; }
    const dir = uTerrainSunDir.value;

    if (heightVersion !== lastVersion || lastEnabled !== true) {
      lastVersion = heightVersion;
      lastEnabled = true;
      lastDir.copy(dir);
      sweepLeft = 0;
      bake();
      return true;
    }

    const len = (dir.length() * lastDir.length()) || 1;
    if (!(dir.dot(lastDir) / len > COS_EPS)) {
      lastDir.copy(dir);
      sweepLeft = BANDS;               // (re)start: every band sees this sun
    }
    if (sweepLeft <= 0) return false;
    renderInto(nextBand);
    nextBand = (nextBand + 1) % BANDS;
    sweepLeft--;
    bandCount++;
    return true;
  }

  /**
   * Sun visibility of a world point, 1 = lit. Any material, any stage: one
   * texture read. `uvNode` is the heightmap UV of the point's world XZ.
   */
  function visibilityAt(uvNode, worldY) {
    return Fn(() => {
      const s = shadowTexNode.sample(uvNode);
      const inBounds = step(0, uvNode.x).mul(step(uvNode.x, 1))
        .mul(step(0, uvNode.y)).mul(step(uvNode.y, 1));
      // Penumbra: fully lit once the point clears the shadow top by t/k —
      // exactly where the per-vertex k·clearance/t term reached 1.
      const width = max(s.g.div(uTerrainShadowK), float(0.3));
      const vis = smoothstep(0, width, worldY.sub(s.r));
      return mix(float(1), mix(float(1), vis, inBounds), uTerrainShadowStrength);
    })();
  }

  return {
    texture: rt.texture,
    shadowTexNode,
    visibilityAt,
    bake,
    bakeIfNeeded,
    bakeBand: (i) => renderInto(i % BANDS),
    get bakeCount() { return bakeCount; },
    get bandCount() { return bandCount; },
    bands: BANDS,
    resolution: RES,
    dispose() { rt.dispose(); bakeMat.dispose(); },
  };
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
