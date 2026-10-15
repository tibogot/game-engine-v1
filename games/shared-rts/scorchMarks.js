// BURN MARKS — ground that burnt (2026-10-16, you: the flamethrower's burning fuel sat on clean
// green grass, "pasted on"). GAME code.
//
// A crater (craterSystem.js) is a shell hole: a bowl, a rim, clods — under a puddle of fuel it
// read as a row of holes with bright rims. This is only the BURN: charred black-brown where it
// burnt, blotchy (the fuel lay in puddles), a singed brown fringe round it where the grass dried
// and browned, a ragged edge. Like the craters it does not paint a colour: it MULTIPLIES the
// ground under it, so the ground's own photo (grass, sand, stones) shows through, darkened.
//
//   GROWS   the char spreads from the middle while the fire burns (`grow` s), so it does not
//           pop in under the flames; then it stays (ring buffer: the oldest overwritten).
//   ONE     overlapping burns do not stack into black: a new one within `merge` × r of a
//           recent one is skipped (a stream on one spot lays one mark, not ten).
//
// One instanced draw, draped on the live heightmap in the vertex shader (terrainDrape.js).
import * as THREE from "three";
import { Fn, attribute, positionLocal, positionWorld, sin, cos, smoothstep, float, vec3, uniform, length, mix, clamp, max, mx_noise_float } from "three/tsl";
import { drapedPosition } from "./terrainDrape.js";
import { RENDER_ORDER } from "./renderOrder.js";

export const SCORCH = {
  max: 128,      // marks kept (the oldest overwritten)
  subdiv: 16,    // the plane's cells: enough to bend over a slope a few metres wide
  lift: 0.12,    // m over the ground (with polygon offset: never z-fights the terrain)
  grow: 2.5,     // s for the char to spread to its full size
  merge: 0.7,    // a new mark nearer than this × its radius to a recent one is skipped
  recent: 24,    // how many of the newest marks that check looks at
};

function scorchMaterial(time, P) {
  const mat = new THREE.MeshBasicNodeMaterial({
    transparent: true, depthTest: true, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    // dst × src: what the shader outputs is a factor on the ground already drawn.
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
    blendSrc: THREE.DstColorFactor, blendDst: THREE.ZeroFactor,
    blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
  });
  mat.forceSinglePass = true;
  mat.fog = false;   // a factor, not a colour: fog would tint it
  const a = attribute("aScorch", "vec4");   // x, z, radius, seed
  const t0 = attribute("aBorn", "float");
  const d = positionWorld.xz.sub(a.xy).div(a.z);   // radii from the centre
  const r = length(d);
  const lump = mx_noise_float(vec3(positionWorld.x.mul(0.9), a.w.mul(5.1), positionWorld.z.mul(0.9)));   // ~1 m: fingers of the edge
  const blot = mx_noise_float(vec3(positionWorld.x.mul(2.2), a.w.mul(2.3), positionWorld.z.mul(2.2)));   // the puddles (blackest)
  const tuft = mx_noise_float(vec3(positionWorld.x.mul(3.4), a.w.mul(1.7), positionWorld.z.mul(3.4)));   // unburnt tufts
  const grain = mx_noise_float(vec3(positionWorld.x.mul(8.0), a.w, positionWorld.z.mul(8.0)));           // ~12 cm
  // Its size so far: the char spreads from the middle while the fire burns.
  const g = clamp(time.sub(t0).div(P.grow), 0, 1);
  const reach = g.mul(0.7).add(0.3);
  // The shape: r over the decal's inner ~70 % (room for the noise at the quad's edge), broken by
  // the noise into fingers and bays — burnt grass is never a disc.
  const e = r.mul(1.4).sub(lump.mul(0.4)).sub(blot.mul(0.16)).add(grain.mul(0.05)).div(reach);
  const burnt = float(1).sub(smoothstep(0.55, 0.68, e));
  // The char: neutral (green taken out, so grass goes grey-brown, not dark green), blackest where
  // the fuel lay and towards the middle, lighter singed tufts left standing in it.
  const deep = clamp(blot.mul(0.9).add(0.55).sub(e.mul(0.45)), 0, 1);
  const charred = mix(vec3(0.6, 0.47, 0.5), vec3(0.2, 0.16, 0.17), deep);
  const tufts = smoothstep(0.2, 0.5, tuft).mul(smoothstep(0.1, 0.45, e));
  const singeCol = vec3(0.92, 0.7, 0.52);
  const char = mix(charred, singeCol, tufts.mul(0.75)).mul(grain.mul(0.22).add(1));
  // The singed fringe: grass dried brown (red kept, green and blue taken down), fading out.
  const fringe = smoothstep(0.5, 0.66, e).mul(float(1).sub(smoothstep(0.72, 0.98, e)));
  const singe = mix(vec3(1), singeCol, fringe.mul(lump.mul(0.3).add(0.8)));
  mat.colorNode = mix(singe, char, burnt);
  return mat;
}

/**
 * @param {object} o
 * @param {object} o.app   needs app.heightTexNode (the live heightmap) and app.scene
 * @param {object} [o.params]
 */
export function createScorchMarks({ app, params = SCORCH } = {}) {
  const P = params;
  const MAX = P.max;
  const time = uniform(0);

  const src = new THREE.PlaneGeometry(1, 1, P.subdiv, P.subdiv).rotateX(-Math.PI / 2);
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = src.index;
  geo.setAttribute("position", src.attributes.position);
  const marks = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 4), 4);
  const born = new THREE.InstancedBufferAttribute(new Float32Array(MAX), 1);
  marks.setUsage(THREE.DynamicDrawUsage);
  born.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute("aScorch", marks);
  geo.setAttribute("aBorn", born);
  geo.instanceCount = 0;

  const mat = scorchMaterial(time, P);
  // The mesh sits at the origin, identity transform: the world position built here IS local.
  mat.positionNode = Fn(() => {
    const m = attribute("aScorch", "vec4");
    const s = sin(m.w), c = cos(m.w);
    const lx = positionLocal.x.mul(m.z.mul(2)), lz = positionLocal.z.mul(m.z.mul(2));
    return drapedPosition(app.heightTexNode, lx.mul(c).add(lz.mul(s)).add(m.x), lz.mul(c).sub(lx.mul(s)).add(m.y), P.lift);
  })();

  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = "RtsScorchMarks";
  mesh.renderOrder = RENDER_ORDER.TRACKS;   // under the craters and blood pools, over the fields
  mesh.frustumCulled = false;
  mesh.visible = false;
  app.scene.add(mesh);

  let clock = 0, count = 0, cursor = 0;

  /** A burn centred at (x, z), `radius` m (it spreads to that over P.grow s). */
  function add(x, z, radius = 1.5) {
    // Overlapping marks multiply into black: a recent one this near stands for it.
    for (let i = 1; i <= Math.min(count, P.recent); i++) {
      const j = ((cursor - i) % MAX + MAX) % MAX;
      const mx = marks.getX(j), mz = marks.getY(j), mr = marks.getZ(j);
      if (Math.hypot(x - mx, z - mz) < P.merge * Math.max(radius, mr)) return false;
    }
    marks.setXYZW(cursor, x, z, radius, Math.random() * Math.PI * 2);
    born.setX(cursor, clock);
    marks.needsUpdate = true;
    born.needsUpdate = true;
    cursor = (cursor + 1) % MAX;
    count = Math.min(count + 1, MAX);
    geo.instanceCount = count;
    mesh.visible = true;
    return true;
  }

  /** The marks' clock (the sim's: a paused game does not spread them). */
  function update(dt) {
    clock += dt;
    time.value = clock;
  }

  function clear() {
    count = 0; cursor = 0;
    geo.instanceCount = 0;
    mesh.visible = false;
  }

  function dispose() {
    app.scene.remove(mesh);
    geo.dispose(); src.dispose(); mat.dispose();
  }

  return { add, update, clear, dispose, mesh, get count() { return count; } };
}
