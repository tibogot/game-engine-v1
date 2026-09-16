/**
 * Impact cap — the mound of churned water where a waterfall lands (TSL/WebGPU).
 *
 * The old waterfall had one of these and it is the right idea: a flat decal on
 * the surface can never read as volume, because the thing it is standing in for
 * is a DOME of aerated water being pushed up out of the pool. This is that
 * dome, rebuilt:
 *
 *   - ONE instanced draw for every waterfall in the scene (the old one was a
 *     mesh per waterfall, placed by hand);
 *   - size, height and squash come from the SOLVED landing — how wide the sheet
 *     is when it arrives and how fast it is going — not from a slider per fall;
 *   - the surface is displaced by noise that travels OUTWARD and downward from
 *     the apex, so the mound boils rather than wobbling in place;
 *   - it is lit by the engine (a MeshStandardNodeMaterial), so the dome catches
 *     the sun on the side the sheet falls from, which is most of what makes it
 *     read as a solid mass of water;
 *   - it fades into the water at its rim and against anything it touches
 *     (scene depth), so it never shows a hard shell edge.
 *
 * DRAW RULES (AUDIT #100): reads the shared scene depth, so it is in the opaque
 * queue with CustomBlending, after the water surfaces and the flat pool foam
 * (105) and before the sheet (110), hidden until there is an impact.
 */
import * as THREE from "three";
import * as TSL from "three/tsl";
import { sceneDepthGrab } from "../water/lakeMaterial.js";
import { vnoiseY } from "./waterfallNoise.js";

const {
  Fn, Discard, uniform, float, vec2, vec3, vec4, attribute, uv, smoothstep, saturate, mix,
  sin, cos, cross, normalize, dot, select, cameraViewMatrix, cameraNear, cameraFar, screenUV,
  perspectiveDepthToViewZ,
} = TSL;

/** The dome is SphereGeometry(1, …, 0, 2π, 0, THETA): θ = (1 − uv.y)·THETA, φ = uv.x·2π. */
const THETA = Math.PI * 0.46;

/** Cells around the dome; the angle axis wraps on this, so there is no seam. */
const ANGLE_CELLS = 36;
/** After the flat pool foam, before the sheet. */
export const CAP_RENDER_ORDER = 106;

const STRIDE = 8;

export function createWaterfallCap(look) {
  const u = {
    time: uniform(0),
    color: uniform(new THREE.Color(look.capColor)),
    deepColor: uniform(new THREE.Color(look.capDeepColor)),
    opacity: uniform(look.capOpacity),
    flow: uniform(look.capFlow),
    relief: uniform(look.capRelief),
    foam: uniform(look.capFoam),
    rim: uniform(look.capRim),
    softDepth: uniform(look.capSoftDepth),
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
  material.roughness = 0.75;
  material.fog = true;

  // Per instance: centre + radius, direction + height and seed.
  const C0 = attribute("aCap0", "vec4");
  const C1 = attribute("aCap1", "vec4");

  // The dome's own coordinates come from the geometry's UV, not from
  // positionLocal: assigning positionNode replaces positionLocal, and in the
  // fragment stage it would hand back the world position instead.
  const capUv = uv().toVar("wfcUv");
  const apex = capUv.y.toVar("wfcApex");                 // 1 at the top, 0 at the rim
  const angCell = capUv.x.mul(ANGLE_CELLS).add(ANGLE_CELLS * 4).toVar("wfcAng");
  const seed = C1.w;

  /**
   * Boiling water at a point of the dome (apex 1 → rim 0, angle in cells): three
   * octaves, the pattern travelling down the dome and out. Evaluated at the
   * pixel for the colour, and at four neighbours for the normal.
   */
  const boilAt = (ap, ac) => {
    const cells = float(ANGLE_CELLS);
    const t = u.time.mul(u.flow);
    // Boils are small next to the mound: many cells around, fine along.
    const a = vnoiseY(vec2(ap.mul(6).add(t).add(seed), ac), cells);
    const b = vnoiseY(vec2(ap.mul(12).add(t.mul(1.6)).add(seed.mul(3)), ac.mul(2)), cells.mul(2));
    const c = vnoiseY(vec2(ap.mul(24).add(t.mul(2.3)).add(seed.mul(7)), ac.mul(4)), cells.mul(4));
    return a.mul(0.45).add(b.mul(0.35)).add(c.mul(0.2));
  };
  const boil = boilAt(apex, angCell).toVar("wfcBoil");

  /**
   * World position of the dome surface at (apex, angle): the unit sphere cap,
   * pushed out by the boil, scaled to the landing (radius across, radius×height
   * up), stretched along the fall's heading. One function for the vertex
   * position AND the normal, so the light falls on the shape that is drawn.
   */
  const domePoint = (ap, ac) => {
    const theta = float(1).sub(ap).mul(THETA);
    const phi = ac.sub(ANGLE_CELLS * 4).mul((Math.PI * 2) / ANGLE_CELLS);
    const st = sin(theta), ct = cos(theta), sp = sin(phi), cp = cos(phi);
    // Boil: the mound heaves, most at the top, and its rim stays on the water.
    const lift = boilAt(ap, ac).sub(0.5).mul(u.relief).mul(0.3).mul(smoothstep(0, 0.35, ap));
    const r = float(1).add(lift);
    const px = cp.negate().mul(st).mul(r), py = ct.mul(r), pz = sp.mul(st).mul(r);
    const along = vec2(C1.x, C1.y);
    const across = vec2(C1.y, C1.x.negate());
    // Stretched a little along the fall: the water arrives with momentum.
    const flat = across.mul(px).add(along.mul(pz.mul(1.2))).mul(C0.w);
    return vec3(C0.x.add(flat.x), C0.y.add(py.mul(C0.w).mul(C1.z)), C0.z.add(flat.y));
  };

  material.positionNode = domePoint(apex, angCell);

  // The normal of the boiling surface, by finite differences of the same
  // function that placed it — so every heave is lit as a heave.
  const eA = float(0.012), eC = float(0.08);
  const domeNormal = Fn(() => {
    const dA = domePoint(apex.add(eA), angCell).sub(domePoint(apex.sub(eA), angCell));
    const dC = domePoint(apex, angCell.add(eC)).sub(domePoint(apex, angCell.sub(eC)));
    const n = normalize(cross(dC, dA)).toVar();
    const out = domePoint(apex, angCell).sub(C0.xyz);
    return select(dot(n, out).lessThan(0), n.negate(), n);
  })().toVar("wfcNormal");
  material.normalNode = normalize(cameraViewMatrix.mul(vec4(domeNormal, 0)).xyz);

  // White where the water is aerated (most of it), a little darker in the troughs.
  // Foam is not flat white: the boil itself shades it, or a lit dome saturates
  // to one tone and reads as a cloud.
  material.colorNode = mix(u.deepColor, u.color, saturate(boil.sub(0.35).mul(u.foam).mul(2.2).add(apex.mul(0.25))));

  material.opacityNode = Fn(() => {
    // Fade out into the water at the rim, with the boil breaking that edge up.
    const rim = smoothstep(0, u.rim.max(0.01), apex.add(boil.sub(0.5).mul(0.25)));
    // Soft against anything it meets. Measured from the dome's CENTRE plus its
    // radius, which is close enough on a shape this small and costs one matrix
    // multiply instead of a varying.
    const viewZ = cameraViewMatrix.mul(vec4(C0.xyz, 1)).z.negate();
    const sceneDist = perspectiveDepthToViewZ(sceneDepthGrab.sample(screenUV).r, cameraNear, cameraFar).negate();
    const soft = smoothstep(0, u.softDepth.add(0.02), sceneDist.sub(viewZ).add(C0.w));
    const a = u.opacity.mul(rim).mul(soft);
    Discard(a.lessThan(0.004));
    return a;
  })();

  const geo = new THREE.InstancedBufferGeometry();
  // A sphere cap: a dome, open underneath, like the old waterfall's splash.
  // Dense enough for the boil to show in its silhouette, not only in shading.
  const dome = new THREE.SphereGeometry(1, 48, 22, 0, Math.PI * 2, 0, THETA);
  geo.index = dome.index;
  geo.setAttribute("position", dome.getAttribute("position"));
  geo.setAttribute("normal", dome.getAttribute("normal"));
  geo.setAttribute("uv", dome.getAttribute("uv"));
  let instances = new THREE.InstancedInterleavedBuffer(new Float32Array(16 * STRIDE), STRIDE, 1);
  instances.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute("aCap0", new THREE.InterleavedBufferAttribute(instances, 4, 0));
  geo.setAttribute("aCap1", new THREE.InterleavedBufferAttribute(instances, 4, 4));
  geo.instanceCount = 0;
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);

  const mesh = new THREE.Mesh(geo, material);
  mesh.name = "WaterfallImpactCaps";
  mesh.frustumCulled = false;
  mesh.renderOrder = CAP_RENDER_ORDER;
  mesh.receiveShadow = true;
  mesh.visible = false;

  /** Rebuild from solved falls: [{ fall, solved }]. */
  function setCaps(entries, look) {
    if (entries.length > instances.count) {
      let capacity = instances.count;
      while (capacity < entries.length) capacity *= 2;
      instances = new THREE.InstancedInterleavedBuffer(new Float32Array(capacity * STRIDE), STRIDE, 1);
      instances.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute("aCap0", new THREE.InterleavedBufferAttribute(instances, 4, 0));
      geo.setAttribute("aCap1", new THREE.InterleavedBufferAttribute(instances, 4, 4));
    }
    const arr = instances.array;
    let k = 0;
    for (const { fall, solved } of entries) {
      const im = solved.impact;
      // The mound is about as wide as the sheet that makes it; speed adds a little.
      const radius = (im.width * 0.5 + Math.min(2.5, im.speed * 0.05)) * look.capSize;
      if (radius <= 0.05) continue;
      // Faster water piles the mound higher; it sits a little into the surface.
      const height = look.capHeight * (0.8 + Math.min(0.4, im.speed * 0.01));
      arr.set([
        im.x, im.y - radius * height * 0.3, im.z, radius,
        im.dirX, im.dirZ, height, (fall.id * 0.618) % 1,
      ], k * STRIDE);
      k++;
    }
    instances.clearUpdateRanges();
    instances.addUpdateRange(0, Math.max(STRIDE, k * STRIDE));
    instances.needsUpdate = true;
    geo.instanceCount = k;
    mesh.visible = k > 0 && look.capEnabled !== false;
    return k;
  }

  function syncParams(look) {
    u.color.value.set(look.capColor);
    u.deepColor.value.set(look.capDeepColor);
    u.opacity.value = look.capOpacity;
    u.flow.value = look.capFlow;
    u.relief.value = look.capRelief;
    u.foam.value = look.capFoam;
    u.rim.value = look.capRim;
    u.softDepth.value = look.capSoftDepth;
  }

  return {
    mesh,
    material,
    uniforms: u,
    setCaps,
    syncParams,
    update(elapsed) { u.time.value = elapsed; },
    dispose() { geo.dispose(); material.dispose(); dome.dispose(); },
  };
}
