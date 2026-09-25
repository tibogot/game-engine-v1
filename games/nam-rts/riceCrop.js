// THE RICE ITSELF — real plants in the paddies, round the camera. GAME code.
//
// Every plant is a clump of leaves (a "hill": the seedlings are set out by
// hand in rows along the terrace), built in the vertex shader from one small
// clump mesh: each blade a tapered, curving strip; young rice short and
// upright, the growing crop tall and arching, ripe rice gold with its heads
// bent over. They sway with the wind, each clump in its own phase.
//
// COST. One draw. Only the clumps within `radius` of the camera are drawn —
// the field's shader carries the crop beyond — and they shrink into the
// ground over the last metres, so nothing pops. The plants are kept sorted in
// 12 m chunks: when the camera's set of chunks changes, their runs are copied
// to the front of the instance buffers (a memcpy each) and only that range is
// uploaded. At the RTS camera's usual height no chunk is near: nothing drawn.
import * as THREE from "three";
import {
  Fn, attribute, cameraPosition, clamp, cos, float, max, mix, normalize, sin, smoothstep, time,
  transformNormalToView, uniform, varying, vec3,
} from "three/tsl";

const CHUNK = 12;
/** Metres from the camera the plants reach; the field shader takes over past it. */
export const CROP_RADIUS = uniform(55);
/** The share of clumps drawn at a distance — the field shader paints the rest. */
export const CROP_KEEP_NEAR = 30, CROP_KEEP_MIN = 0.22;
export const cropKeep = (dist) => clamp(float(CROP_KEEP_NEAR).div(dist), CROP_KEEP_MIN, 1);

/** sRGB hex → linear vec3 node. */
const lin = (hex) => { const c = new THREE.Color(hex); return vec3(c.r, c.g, c.b); };

/** One clump: `blades` curving strips, each 2 segments + a tip (3 triangles). */
function clumpGeometry(blades = 6) {
  const aB = [], aS = [], idx = [];
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let b = 0; b < blades; b++) {
    const angle = (b / blades) * Math.PI * 2 + rnd() * 0.8;
    const lean = 0.18 + rnd() * 0.32;          // tip out, as a share of the height
    const hs = 0.72 + rnd() * 0.33;
    const base = aB.length / 4;
    for (const t of [0, 0.5]) for (const side of [-1, 1]) { aB.push(angle, lean, hs, t); aS.push(side); }
    aB.push(angle, lean, hs, 1); aS.push(0);
    idx.push(base, base + 1, base + 2, base + 1, base + 3, base + 2, base + 2, base + 3, base + 4);
  }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute("aB", new THREE.Float32BufferAttribute(aB, 4));
  g.setAttribute("aS", new THREE.Float32BufferAttribute(aS, 1));
  // three wants a position attribute; the vertex shader makes the real one.
  g.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(aS.length * 3), 3));
  g.setIndex(idx);
  return g;
}

/**
 * `plants`: [{ x, y, z, kind: 0 young | 1 growing | 2 ripe, rnd }].
 * Returns { mesh, update(camera), count }.
 */
export function createRiceCrop(app, plants, { radius = 400 } = {}) {
  // Sort into chunks, each a contiguous run.
  const key = (p) => `${Math.floor(p.x / CHUNK)},${Math.floor(p.z / CHUNK)}`;
  const byChunk = new Map();
  for (const p of plants) {
    const k = key(p);
    if (!byChunk.has(k)) byChunk.set(k, []);
    byChunk.get(k).push(p);
  }
  const N = plants.length;
  const srcPos = new Float32Array(N * 4), srcInf = new Float32Array(N * 4);
  const chunks = [];
  let o = 0;
  for (const [, list] of byChunk) {
    // By their random, ascending: the share a distance keeps (the shader's
    // thinning keeps rnd < keep) is then a PREFIX of the run.
    list.sort((a, b) => a.rnd - b.rnd);
    let cx = 0, cy = 0, cz = 0;
    const start = o;
    for (const p of list) {
      srcPos.set([p.x, p.y, p.z, p.rnd * Math.PI * 2], o * 4);
      const h = p.kind === 0 ? 0.32 + 0.1 * p.rnd : p.kind === 1 ? 0.62 + 0.16 * p.rnd
        : p.kind === 2 ? 0.85 + 0.15 * p.rnd : 0.2 + 0.16 * p.rnd;   // 3: bank grass
      srcInf.set([h, p.kind, p.rnd, 0], o * 4);
      cx += p.x; cy += p.y; cz += p.z;
      o++;
    }
    chunks.push({ start, count: list.length, x: cx / list.length, y: cy / list.length, z: cz / list.length });
  }

  const geo = clumpGeometry(6);
  const iPos = new THREE.InstancedBufferAttribute(new Float32Array(N * 4), 4);
  const iInf = new THREE.InstancedBufferAttribute(new Float32Array(N * 4), 4);
  iPos.setUsage(THREE.DynamicDrawUsage);
  iInf.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute("iPos", iPos);
  geo.setAttribute("iInf", iInf);
  geo.instanceCount = 0;
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);

  const uRadius = CROP_RADIUS;
  uRadius.value = radius;
  const mat = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide, roughness: 0.72, metalness: 0 });
  mat.name = "RiceCrop";
  const ip = attribute("iPos", "vec4"), inf = attribute("iInf", "vec4");
  const B = attribute("aB", "vec4"), S = attribute("aS", "float");
  const t = B.w;
  const kind = inf.y;
  // Kind 3 is the GRASS of the banks and dikes: short, shaggy, arching out.
  const grassK = smoothstep(2.5, 3, kind);
  const ripe = smoothstep(1.5, 2, kind).mul(float(1).sub(grassK)), young = float(1).sub(smoothstep(0, 0.5, kind));
  const dist = cameraPosition.sub(ip.xyz).length();
  // Shrinks into the ground over the last 10 m of the radius: no popping.
  const fade = smoothstep(uRadius, uRadius.sub(10), dist);
  // THINNED WITH DISTANCE: far off, a clump's leaves are a few pixels and
  // the next clump's cover the same ones (overdraw was most of the cost), so
  // only a share is drawn — all of them within 30 m, a quarter past 130 m — each
  // a little wider to keep the cover. A clump leaves by shrinking, its own
  // random against a smooth threshold: no popping.
  const keep = cropKeep(dist);
  const thin = smoothstep(keep, keep.sub(0.08), inf.z);
  const Hh = inf.x.mul(B.z).mul(fade).mul(thin);
  const a = B.x.add(ip.w);
  const dir = vec3(cos(a), 0, sin(a));
  const side = vec3(sin(a).negate(), 0, cos(a));
  // Leaves arch out; ripe heads bend over at the top.
  const lean = B.y.mul(mix(float(1), float(0.55), young)).mul(grassK.mul(0.8).add(1));
  const out = lean.mul(Hh).mul(t.mul(t)).add(ripe.mul(Hh).mul(0.3).mul(t.mul(t).mul(t)));
  const y = Hh.mul(t).sub(ripe.mul(Hh).mul(0.28).mul(t.mul(t).mul(t)));
  // The wind: a slow swell across the field and each clump's own flutter.
  const phase = ip.x.mul(0.21).add(ip.z.mul(0.13));
  const sway = sin(time.mul(1.1).add(phase)).mul(0.6).add(sin(time.mul(2.7).add(inf.z.mul(6.28))).mul(0.25))
    .mul(0.07).mul(Hh).mul(t.mul(t));
  // Blades a centimetre and a half wide, widened with distance so a leaf never
  // gets thinner than about a pixel (the shimmer of sub-pixel grass).
  const width = float(0.017).mul(float(1).sub(t.mul(0.85))).mul(max(float(1), dist.div(20))).mul(float(1).div(keep).sub(1).mul(0.5).add(1)).mul(fade).mul(thin);
  mat.positionNode = Fn(() => {
    const local = dir.mul(out).add(side.mul(width.mul(S))).add(vec3(sway, y, sway.mul(0.6)));
    return ip.xyz.add(local);
  })();
  // Lit as a clump, not as flat strips: the normal leans out with the blade.
  const nW = varying(normalize(dir.mul(t.mul(0.55).add(0.25)).add(vec3(0, 1, 0))));
  mat.normalNode = transformNormalToView(nW);
  const vT = varying(t), vKind = varying(kind), vR = varying(inf.z);
  const baseCol = mix(mix(lin("#35601b"), lin("#2c4f16"), smoothstep(0.5, 1, vKind)), lin("#6b5424"), smoothstep(1.5, 2, vKind));
  const tipCol = mix(mix(lin("#7aa834"), lin("#5f922a"), smoothstep(0.5, 1, vKind)), lin("#c4a04c"), smoothstep(1.5, 2, vKind));
  const vGrass = smoothstep(2.5, 3, vKind);
  const base2 = mix(baseCol, lin("#2a4418"), vGrass), tip2 = mix(tipCol, mix(lin("#5d8a2c"), lin("#7b9a3a"), vR), vGrass);
  mat.colorNode = mix(base2, tip2, smoothstep(0, 0.9, vT)).mul(vR.mul(0.18).add(0.91));

  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = "RiceCrop";
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  app.scene.add(mesh);

  let lastCam = new THREE.Vector3(1e9, 0, 0), lastSet = "", lastN = 0;
  return {
    mesh, count: N, uRadius,
    update(camera) {
      const cp = camera.position;
      // Someone else set the count (the pipeline warm-up puts back what it
      // found at load, 0): rebuild from scratch.
      if (geo.instanceCount !== lastN) { lastSet = ""; lastCam.set(1e9, 0, 0); }
      if (lastCam.distanceToSquared(cp) < 2.25) return;
      lastCam.copy(cp);
      const R = uRadius.value + CHUNK * 0.75;
      // Each near chunk sends the share its NEAREST clump could keep (the
      // shader decides per clump; this only skips the ones it would shrink
      // to nothing — most of the vertex work at the RTS camera's height).
      const near = [];
      for (let i = 0; i < chunks.length; i++) {
        const c = chunks[i];
        const dist = Math.hypot(c.x - cp.x, c.y - cp.y, c.z - cp.z);
        if (dist >= R) continue;
        const keep = Math.min(1, Math.max(CROP_KEEP_MIN, CROP_KEEP_NEAR / Math.max(1, dist - CHUNK * 0.75)) + 0.02);
        near.push(i, Math.min(c.count, Math.ceil(c.count * keep)));
      }
      const set = near.join(",");
      if (set === lastSet) return;
      lastSet = set;
      let n = 0;
      for (let k = 0; k < near.length; k += 2) {
        const c = chunks[near[k]], cnt = near[k + 1];
        iPos.array.set(srcPos.subarray(c.start * 4, (c.start + cnt) * 4), n * 4);
        iInf.array.set(srcInf.subarray(c.start * 4, (c.start + cnt) * 4), n * 4);
        n += cnt;
      }
      for (const at of [iPos, iInf]) {
        at.clearUpdateRanges();
        at.addUpdateRange(0, n * 4);
        at.needsUpdate = true;
      }
      geo.instanceCount = lastN = n;
      mesh.visible = n > 0;
    },
  };
}
