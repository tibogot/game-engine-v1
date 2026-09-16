/**
 * Plunge pool — the foam where a waterfall lands (TSL / WebGPU).
 *
 * One instanced disc per waterfall, laid on whatever the fall hits: the lake,
 * river or sea surface it plunges into, or the wet rock where it lands dry.
 * ONE draw call for every pool in the scene.
 *
 * WHAT IT DRAWS. Foam is born under the falling water and travels OUTWARD, so
 * the pattern is sampled in polar coordinates with the radius advected by time
 * — the same trick the sheet uses along its fall, turned inside out. On top of
 * that: the white churn under the impact itself, expanding rings, and a ragged
 * outer edge. Nothing is painted and nothing is authored; the radius comes from
 * the solved landing (its width and the speed the water arrives at).
 *
 * The noise is periodic AROUND the disc (the angle axis wraps on a whole number
 * of cells, waterfallNoise.js), so the seam at ±180° cannot show.
 *
 * DRAW RULES (AUDIT #100): it reads the shared scene depth to fade into the
 * shoreline and to sit softly on the bed, so it is in the opaque queue with
 * CustomBlending, after the water surfaces (lakes 100) and before the sheet
 * (110), and the mesh stays hidden until a pool exists.
 */
import * as THREE from "three";
import {
  Fn, Discard, uniform, float, vec2, vec3, vec4, attribute, smoothstep, saturate, atan, sin, uv,
  cameraViewMatrix, cameraNear, cameraFar, screenUV, perspectiveDepthToViewZ, length,
} from "three/tsl";
import { sceneDepthGrab } from "../water/lakeMaterial.js";
import { vnoiseY } from "./waterfallNoise.js";

/** Cells around the disc — the angle axis wraps on this, so there is no seam. */
const ANGLE_CELLS = 18;
/** After the water surfaces, before the sheet. */
export const POOL_RENDER_ORDER = 105;

const STRIDE = 12;

export function createWaterfallPool(look) {
  const u = {
    time: uniform(0),
    foamColor: uniform(new THREE.Color(look.poolColor)),
    opacity: uniform(look.poolOpacity),
    flow: uniform(look.poolFlow),
    churn: uniform(look.poolChurn),
    rings: uniform(look.poolRings),
    ringRate: uniform(look.poolRingRate),
    edge: uniform(look.poolEdge),
    softDepth: uniform(look.poolSoftDepth),
    detail: uniform(look.poolDetail),
  };

  const material = new THREE.MeshStandardNodeMaterial();
  material.transparent = false;
  material.blending = THREE.CustomBlending;
  material.blendEquation = THREE.AddEquation;
  material.blendSrc = THREE.SrcAlphaFactor;
  material.blendDst = THREE.OneMinusSrcAlphaFactor;
  material.blendSrcAlpha = THREE.ZeroFactor;
  material.blendDstAlpha = THREE.OneFactor;
  material.depthWrite = false;
  material.depthTest = true;
  material.side = THREE.DoubleSide;
  material.metalness = 0;
  material.roughness = 0.85;
  material.fog = true;

  // Per instance: centre + radius, flow direction + strength, seed + squash.
  const P0 = attribute("aPool0", "vec4");
  const P1 = attribute("aPool1", "vec4");

  // A unit disc laid flat, stretched ALONG the fall's direction: water arriving
  // with speed carries on, so a landing is an ellipse, not a circle.
  //
  // Held as ONE node used by both stages. In the fragment stage it interpolates,
  // which on a flat disc is exact — and it has to be read this way rather than
  // through `positionView`, which describes where the vertex would have been
  // before this node moved it (the same trap the rain field documents).
  // Disc-local coordinates, -1..1, from the geometry's OWN uv rather than from
  // `positionLocal`: assigning `positionNode` replaces positionLocal, so in the
  // fragment stage it would hand back this disc's WORLD position and every
  // pixel would read as being outside the disc.
  const discLocal = uv().sub(0.5).mul(2).toVar("wfpLocal");

  const worldPos = Fn(() => {
    const local = discLocal;                                  // -1..1
    const along = vec2(P1.x, P1.y);                           // the fall's heading in XZ
    const across = vec2(P1.y, P1.x.negate());
    const off = across.mul(local.x).add(along.mul(local.y.mul(P1.w))).mul(P0.w);
    return vec3(P0.x.add(off.x), P0.y, P0.z.add(off.y));
  })();
  material.positionNode = worldPos;

  // Polar coordinates of this pixel within the disc.
  const r = saturate(length(discLocal)).toVar("wfpR");
  const ang = atan(discLocal.y, discLocal.x).toVar("wfpAng");
  const angCell = ang.mul(ANGLE_CELLS / (Math.PI * 2)).add(ANGLE_CELLS * 4).toVar("wfpAngCell");
  const seed = P1.z;

  const foam = Fn(() => {
    // Foam is born at the impact and travels outward: the radius axis scrolls.
    const cells = float(ANGLE_CELLS);
    const a = vnoiseY(vec2(r.mul(4).sub(u.time.mul(u.flow)).add(seed), angCell), cells);
    const b = vnoiseY(vec2(r.mul(9).sub(u.time.mul(u.flow).mul(1.7)).add(seed.mul(3)), angCell.mul(2)), cells.mul(2));
    const n = a.mul(0.62).add(b.mul(0.38).mul(u.detail)).add(u.detail.oneMinus().mul(0.19));
    // Thick under the falling water, thinning outward: foam is carried away and
    // breaks up, so the pattern has to be CUT rather than faded, or the disc
    // reads as one flat white wash.
    const profile = float(1).sub(smoothstep(0.08, 0.95, r));
    const ring = sin(r.mul(14).sub(u.time.mul(u.ringRate))).mul(0.5).add(0.5);
    const rings = ring.mul(ring).mul(u.rings).mul(profile);
    const field = n.mul(profile.mul(u.churn).add(0.45)).add(rings);
    return smoothstep(0.42, 0.88, field);
  })().toVar("wfpFoam");

  material.colorNode = u.foamColor;
  // CircleGeometry faces +Z; this disc is laid flat, so it is lit from above.
  material.normalNode = cameraViewMatrix.mul(vec4(0, 1, 0, 0)).xyz.normalize();
  material.opacityNode = Fn(() => {
    // Ragged outer edge, and a hole under nothing at all.
    const edge = float(1).sub(smoothstep(u.edge.oneMinus().mul(0.85), 1, r.add(foam.mul(0.12))));
    // Soft where the bed or bank comes up to meet the disc.
    const sceneDist = perspectiveDepthToViewZ(sceneDepthGrab.sample(screenUV).r, cameraNear, cameraFar).negate();
    const viewZ = cameraViewMatrix.mul(vec4(worldPos, 1)).z.negate();
    const soft = smoothstep(0, u.softDepth.add(0.02), sceneDist.sub(viewZ));
    const a = u.opacity.mul(foam).mul(edge).mul(soft);
    Discard(a.lessThan(0.004));
    return a;
  })();

  const geo = new THREE.InstancedBufferGeometry();
  const disc = new THREE.CircleGeometry(0.5, 40);
  geo.index = disc.index;
  geo.setAttribute("position", disc.getAttribute("position"));
  geo.setAttribute("normal", disc.getAttribute("normal"));
  geo.setAttribute("uv", disc.getAttribute("uv"));
  const buf = new THREE.InstancedInterleavedBuffer(new Float32Array(16 * STRIDE), STRIDE, 1);
  buf.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute("aPool0", new THREE.InterleavedBufferAttribute(buf, 4, 0));
  geo.setAttribute("aPool1", new THREE.InterleavedBufferAttribute(buf, 4, 4));
  geo.instanceCount = 0;
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);

  const mesh = new THREE.Mesh(geo, material);
  mesh.name = "WaterfallPools";
  mesh.frustumCulled = false;
  mesh.renderOrder = POOL_RENDER_ORDER;
  mesh.receiveShadow = true;
  mesh.visible = false;

  let instances = buf;

  /** Rebuild the instances from solved falls: [{ fall, solved }]. */
  function setPools(entries, look) {
    if (entries.length > instances.count) {
      let capacity = instances.count;
      while (capacity < entries.length) capacity *= 2;
      instances = new THREE.InstancedInterleavedBuffer(new Float32Array(capacity * STRIDE), STRIDE, 1);
      instances.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute("aPool0", new THREE.InterleavedBufferAttribute(instances, 4, 0));
      geo.setAttribute("aPool1", new THREE.InterleavedBufferAttribute(instances, 4, 4));
    }
    const arr = instances.array;
    let k = 0;
    for (const { fall, solved } of entries) {
      const im = solved.impact;
      // The landing spreads with the width it arrives at and the speed it hits.
      // The foam ring reaches well past the cap (waterfallCap.js: 0.55·width).
      const radius = (im.width * 0.8 + Math.min(8, im.speed * 0.18)) * look.poolSize;
      if (radius <= 0.05 || fall.pool === 0) continue;
      arr.set([
        im.x, im.y + 0.05, im.z, radius,
        im.dirX, im.dirZ, (fall.id * 0.618) % 1, 1 + Math.min(0.6, im.speed * 0.012),
        0, 0, 0, 0,
      ], k * STRIDE);
      k++;
    }
    instances.clearUpdateRanges();
    instances.addUpdateRange(0, Math.max(STRIDE, k * STRIDE));
    instances.needsUpdate = true;
    geo.instanceCount = k;
    mesh.visible = k > 0 && look.poolEnabled !== false;
    return k;
  }

  function syncParams(look) {
    u.foamColor.value.set(look.poolColor);
    u.opacity.value = look.poolOpacity;
    u.flow.value = look.poolFlow;
    u.churn.value = look.poolChurn;
    u.rings.value = look.poolRings;
    u.ringRate.value = look.poolRingRate;
    u.edge.value = look.poolEdge;
    u.softDepth.value = look.poolSoftDepth;
    u.detail.value = look.poolDetail;
  }

  return {
    mesh,
    material,
    uniforms: u,
    setPools,
    syncParams,
    update(elapsed) { u.time.value = elapsed; },
    dispose() { geo.dispose(); material.dispose(); disc.dispose(); },
  };
}
