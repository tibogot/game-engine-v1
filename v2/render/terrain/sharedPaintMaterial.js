/**
 * 4-layer weight-blended paint material (Unreal Landscape-style).
 *
 * Splat encoding (per-chunk 128² RGBA DataTexture):
 *   R, G, B → weights of layers 1, 2, 3 (0..1).
 *   Layer 0 is implicit: `w0 = max(0, 1 - R - G - B)`.
 *
 * Shader normalizes `(w0, w1, w2, w3)` by `(w0 + R + G + B)` so over-painted
 * areas (where R+G+B > 1) stay well-defined and visually predictable.
 *
 * Per-chunk binding: one shared material instance; each mesh's `onBeforeRender`
 * swaps `splatTexNode.value` to that chunk's splat DataTexture via
 * `setupPaintMeshSwap(mesh, sharedNodes)`.
 */
import * as THREE from "three";
import {
  Fn,
  float,
  vec2,
  vec3,
  vec4,
  texture,
  positionLocal,
  positionWorld,
  mix,
  max,
  clamp,
  sqrt,
} from "three/tsl";
import { normalMap } from "three/tsl";
import { createCliffShadingContext } from "../../core/legacy/chunkTerrainAutoCliff.js";

function makePlaceholderSplatTex() {
  const d = new Uint8Array([0, 0, 0, 0]);
  const t = new THREE.DataTexture(d, 1, 1, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.flipY = false;
  t.needsUpdate = true;
  return t;
}

/**
 * @param {object[]} layerSlots — 4 TextureLibrary slots (base + 3)
 * @param {number} chunkSize
 * @param {number} worldSize
 * @param {null | object} cliffDeps
 */
export function createV2PaintMaterial(
  layerSlots,
  chunkSize,
  worldSize,
  cliffDeps = null,
) {
  if (layerSlots.length !== 4) {
    throw new Error(
      `createV2PaintMaterial expects 4 layer slots, got ${layerSlots.length}`,
    );
  }

  const mat = new THREE.MeshStandardNodeMaterial({
    roughness: 0.88,
    metalness: 0.0,
  });
  mat.envMapIntensity = 0;

  const cs = float(chunkSize);
  const invWorldSize = float(1.0 / worldSize);

  const splatUV = positionLocal.xz.div(cs).add(vec2(0.5, 0.5));
  const splatTexNode = texture(makePlaceholderSplatTex(), splatUV);

  /** Per-layer sampling nodes keyed on the slot's uvScale uniform. */
  const layerNodes = layerSlots.map((slot) => {
    const uv = positionWorld.xz.mul(invWorldSize).mul(slot.uUVScale);
    return {
      slot,
      albedo: texture(slot.albedoTex, uv),
      orm: texture(slot.ormTex, uv),
    };
  });

  const cliff =
    cliffDeps &&
    createCliffShadingContext(
      cliffDeps.heightTex,
      cliffDeps.rockColorTex,
      cliffDeps.rockDataTex,
      cliffDeps.cliffU,
      cliffDeps.worldSize,
      cliffDeps.worldHalf,
      cliffDeps.htexRes,
    );

  /** Fn: returns vec4(w0, w1, w2, w3), normalized so sum=1. */
  const splatWeights = Fn(() => {
    const s = splatTexNode;
    const r = s.r;
    const g = s.g;
    const b = s.b;
    const w0Raw = max(float(0), float(1).sub(r).sub(g).sub(b));
    const total = max(float(1e-5), w0Raw.add(r).add(g).add(b));
    return vec4(w0Raw.div(total), r.div(total), g.div(total), b.div(total));
  });

  mat.colorNode = Fn(() => {
    const w = splatWeights();
    const aoW0 = mix(float(1), layerNodes[0].orm.g, layerSlots[0].uAOStr);
    const aoW1 = mix(float(1), layerNodes[1].orm.g, layerSlots[1].uAOStr);
    const aoW2 = mix(float(1), layerNodes[2].orm.g, layerSlots[2].uAOStr);
    const aoW3 = mix(float(1), layerNodes[3].orm.g, layerSlots[3].uAOStr);
    const c0 = layerNodes[0].albedo.rgb.mul(aoW0);
    const c1 = layerNodes[1].albedo.rgb.mul(aoW1);
    const c2 = layerNodes[2].albedo.rgb.mul(aoW2);
    const c3 = layerNodes[3].albedo.rgb.mul(aoW3);
    const blended = c0
      .mul(w.x)
      .add(c1.mul(w.y))
      .add(c2.mul(w.z))
      .add(c3.mul(w.w));
    return cliff ? cliff.augmentColor(blended) : blended;
  })();

  mat.roughnessNode = Fn(() => {
    const w = splatWeights();
    const r0 = mix(float(0.88), layerNodes[0].orm.r, layerSlots[0].uRoughStr);
    const r1 = mix(float(0.88), layerNodes[1].orm.r, layerSlots[1].uRoughStr);
    const r2 = mix(float(0.88), layerNodes[2].orm.r, layerSlots[2].uRoughStr);
    const r3 = mix(float(0.88), layerNodes[3].orm.r, layerSlots[3].uRoughStr);
    const imgRough = clamp(
      r0.mul(w.x).add(r1.mul(w.y)).add(r2.mul(w.z)).add(r3.mul(w.w)),
      float(0.04),
      float(1),
    );
    if (!cliff) return imgRough;
    const slope = cliff.getSlopeMask().pow(cliffDeps.cliffU.uRockBlendSharp);
    return mix(cliff.evaluateRockRoughnessRawInFn(), imgRough, slope);
  })();

  mat.normalNode = Fn(() => {
    const w = splatWeights();
    const nx0 = layerNodes[0].orm.b.mul(2).sub(1);
    const ny0 = layerNodes[0].orm.a.mul(2).sub(1);
    const nx1 = layerNodes[1].orm.b.mul(2).sub(1);
    const ny1 = layerNodes[1].orm.a.mul(2).sub(1);
    const nx2 = layerNodes[2].orm.b.mul(2).sub(1);
    const ny2 = layerNodes[2].orm.a.mul(2).sub(1);
    const nx3 = layerNodes[3].orm.b.mul(2).sub(1);
    const ny3 = layerNodes[3].orm.a.mul(2).sub(1);
    const nx = nx0
      .mul(w.x)
      .add(nx1.mul(w.y))
      .add(nx2.mul(w.z))
      .add(nx3.mul(w.w));
    const ny = ny0
      .mul(w.x)
      .add(ny1.mul(w.y))
      .add(ny2.mul(w.z))
      .add(ny3.mul(w.w));
    const nz = sqrt(max(float(0), float(1).sub(nx.mul(nx)).sub(ny.mul(ny))));
    const imgRaw = vec3(
      nx.mul(0.5).add(0.5),
      ny.mul(0.5).add(0.5),
      nz.mul(0.5).add(0.5),
    );
    /** Per-layer normal-strength blended by weight. */
    const nstr = layerSlots[0].uNormalStr
      .mul(w.x)
      .add(layerSlots[1].uNormalStr.mul(w.y))
      .add(layerSlots[2].uNormalStr.mul(w.z))
      .add(layerSlots[3].uNormalStr.mul(w.w));
    if (!cliff) return normalMap(imgRaw, vec2(nstr, nstr));
    const rockRaw = cliff.evaluateRockNormalRawInFn();
    const slope = cliff.getSlopeMask().pow(cliffDeps.cliffU.uRockBlendSharp);
    const combined = mix(rockRaw, imgRaw, slope);
    return normalMap(combined, vec2(nstr, nstr));
  })();

  return { material: mat, splatTexNode };
}

/**
 * Hook `onBeforeRender` so each chunk mesh swaps the shared `splatTexNode.value`
 * to its own per-chunk splat texture. Sets placeholder for chunks without paint.
 */
export function setupPaintMeshSwap(mesh, sharedNodes, placeholderSplatTex) {
  const prev = mesh.onBeforeRender;
  mesh.onBeforeRender = (
    renderer,
    scene,
    camera,
    geometry,
    material,
    group,
  ) => {
    if (prev) prev(renderer, scene, camera, geometry, material, group);
    const ud = mesh.userData;
    sharedNodes.splatTexNode.value = ud._splatTex ?? placeholderSplatTex;
  };
}
