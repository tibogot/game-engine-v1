// Tyre and track marks behind vehicles — shared machinery (a game decides who
// leaves them and how wide; alg-rts: algAmbience.js).
//
// The crater recipe (craterSystem.js) for a mark that is laid every couple of
// metres and fades: ONE instanced draw for every mark on the map, draped on
// the live heightmap in the vertex shader (terrainDrape.js), the ruts drawn in
// the fragment shader (no texture), the fade done in the shader from each
// mark's birth time — so a mark costs one write when it is laid and nothing
// after. A ring buffer: the oldest mark is the one overwritten.
//
// MULTIPLY blending: a rut DARKENS what is under it (dst × tint), so it reads
// the same in sun and in shadow — an unlit alpha decal glowed in the shade
// (craters are alpha; they are black, so it does not show there).
//
// Each lay uploads only its own slot (addUpdateRange), not the whole buffer.
import * as THREE from "three";
import { Fn, attribute, positionLocal, uv, sin, cos, abs, float, vec3, mix, smoothstep, uniform, max, fract } from "three/tsl";
import { drapedPosition } from "./terrainDrape.js";

const LIFT = 0.07;            // m above the heightmap (the clipmap rounds the ground a little)
const RENDER_ORDER = 41;      // just under the craters (42)

/**
 * @param {object} o
 * @param {object} o.app      the v3 app (scene, heightTexNode)
 * @param {number} [o.max]    marks alive at once (the ring)
 * @param {number} [o.life]   seconds a mark takes to fade away
 * @param {THREE.Color|number} [o.tint]  the rut's colour at full strength (multiplied in)
 */
export function createTrackMarks({ app, max: MAX = 1536, life = 50, tint = 0x9a8a78 }) {
  const { scene, heightTexNode } = app;
  const uTime = uniform(0);

  // One quad, 2 × 4 cells: enough to bend over a 2 m stretch of slope.
  const src = new THREE.PlaneGeometry(1, 1, 2, 4).rotateX(-Math.PI / 2);
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = src.index;
  geo.setAttribute("position", src.attributes.position);
  geo.setAttribute("uv", src.attributes.uv);
  // aMark: x, z, yaw, birth · aShape: half gauge (m), rut width (m), length (m), kind (0 tyre, 1 track)
  const markAttr = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 4), 4);
  const shapeAttr = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 4), 4);
  markAttr.setUsage(THREE.DynamicDrawUsage);
  shapeAttr.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute("aMark", markAttr);
  geo.setAttribute("aShape", shapeAttr);
  geo.instanceCount = 0;

  const mat = new THREE.MeshBasicNodeMaterial({
    transparent: true, depthTest: true, depthWrite: false, fog: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation, blendSrc: THREE.DstColorFactor, blendDst: THREE.ZeroFactor,
    blendEquationAlpha: THREE.AddEquation, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
  });
  mat.forceSinglePass = true;

  mat.positionNode = Fn(() => {
    const m = attribute("aMark", "vec4"), sh = attribute("aShape", "vec4");
    const s = sin(m.z), c = cos(m.z);
    // Local x across (the quad spans both ruts), z along the travel.
    const width = sh.x.add(sh.y).mul(2);
    const lx = positionLocal.x.mul(width), lz = positionLocal.z.mul(sh.z);
    const wx = lx.mul(c).add(lz.mul(s)).add(m.x);
    const wz = lz.mul(c).sub(lx.mul(s)).add(m.y);
    return drapedPosition(heightTexNode, wx, wz, LIFT);
  })();

  const T = new THREE.Color(tint);
  mat.colorNode = Fn(() => {
    const m = attribute("aMark", "vec4"), sh = attribute("aShape", "vec4");
    const p = uv();
    // Across, in metres from the centre line; the two ruts at ±gauge.
    const width = sh.x.add(sh.y).mul(2);
    const across = abs(p.x.sub(0.5).mul(width));
    const d = abs(across.sub(sh.x));
    const rut = float(1).sub(smoothstep(sh.y.mul(0.32), sh.y.mul(0.5), d));
    // A track's links: cross-bars every ~0.18 m along it. A tyre's tread is
    // too fine to see at play zoom: a plain rut.
    const along = p.y.mul(sh.z);
    const links = smoothstep(0.3, 0.5, abs(fract(along.div(0.18)).sub(0.5)).mul(2));
    const tread = mix(float(1), mix(float(0.55), float(1), links), sh.w);
    // Ends feathered (each mark overlaps the next a little), and the fade:
    // full for the first 60% of its life, gone at the end.
    const ends = smoothstep(0, 0.12, p.y).mul(smoothstep(0, 0.12, float(1).sub(p.y)));
    const age = uTime.sub(m.w);
    const fade = float(1).sub(smoothstep(life * 0.6, life, age)).mul(smoothstep(-0.01, 0, age));
    const k = rut.mul(tread).mul(ends).mul(fade).mul(0.85);
    // Multiply: 1 = untouched, the tint = a full-strength rut.
    return mix(vec3(1), vec3(T.r, T.g, T.b), max(k, 0));
  })();

  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = "TrackMarks";
  mesh.renderOrder = RENDER_ORDER;
  mesh.frustumCulled = false;
  mesh.visible = false;
  mesh.castShadow = mesh.receiveShadow = false;
  scene.add(mesh);

  let cursor = 0, count = 0;
  return {
    mesh,
    /** Advance the clock (seconds, the same clock lay() stamps with). */
    tick(dt) { uTime.value += dt; },
    get time() { return uTime.value; },
    /**
     * Lay one stretch of marks centred on (x, z), heading `yaw` (forward =
     * (sin yaw, cos yaw)), `length` metres; ruts at ±`gauge` m, `rut` m wide;
     * `track` true = a tracked vehicle's links.
     */
    lay(x, z, yaw, length, gauge, rut, track = false) {
      const i = cursor;
      markAttr.setXYZW(i, x, z, yaw, uTime.value);
      shapeAttr.setXYZW(i, gauge, rut, length, track ? 1 : 0);
      // Only this slot goes up (the renderer clears the ranges after the upload).
      markAttr.addUpdateRange?.(i * 4, 4); shapeAttr.addUpdateRange?.(i * 4, 4);
      markAttr.needsUpdate = shapeAttr.needsUpdate = true;
      cursor = (cursor + 1) % MAX;
      count = Math.min(count + 1, MAX);
      geo.instanceCount = count;
      mesh.visible = true;
    },
    dispose() { scene.remove(mesh); geo.dispose(); src.dispose(); mat.dispose(); },
  };
}
