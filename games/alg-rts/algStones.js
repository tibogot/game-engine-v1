// STONES THAT BELONG TO THE GROUND (you, 2026-09-29/30): loose stones whose
// colour and grain are the ground layers' OWN — each kind of stone is
// textured with the very photo of the layer it lies on (triplanar), so a
// scree stone is the scree, a ridge boulder the ridge's limestone, a wadi
// stone the bed's pebbles. The kit's grey fieldStone read foreign.
//
// Shapes: the engine's chipped-egg generator (v3/props/proceduralRock.js,
// the editor's rock kit), at lower triangle budgets for scattering.
// Placement: read from the map's paint (app.samplePaintWeights):
//
//   scree (slot 2)      many small stones and pebbles
//   limestone (1)       lumps and boulders, fewer
//   valley soil (0)     a stone here and there
//   wadi bed (4)        rounded stones (fewer chips) in the dry bed
//   piste (6) EDGES     gravel along the shoulders, never on the running
//                       surface (the paint's weight between 0.08 and 0.55)
//
// Each stone is SUNK 20-35% of its height and tilted to the slope — stones
// are buried, not placed (nam-rts's rocks lesson). None inside a building's
// footprint (the nav grid), in water, on the oasis grove or outside PLAY.
// One InstancedMesh per (ground, shape): ~14 draws, no per-frame work.
//
// THE BIG ONES ARE SCANS (2026-10-22, you: "they look like eggs, not realistic AAA at all" — the small ones are
// fine): the lumps and boulders take one of six Poly Haven scans (public/models/alg/boulders.glb, made by
// tools/blender/scanBoulders.py — 380-520 triangles, the scan's photo and normal map). Their COLOUR stays the
// ground's, as before (they belong to it); the scan gives the DETAIL: its photo's light and dark over its own mean
// (the smallest mip) — its cracks, crevices, layers — and its normal map. No file: the chipped eggs as before.
import { groundBlend } from "./algGroundBlend.js";
import * as THREE from "three";
import { abs, attribute, float, int, normalWorld, positionWorld, pow, renderGroup, texture, uniformArray, vec2, vec3 } from "three/tsl";
import { markGpuOnly } from "../../v3/render/gpuOnlyArrays.js";
import { createRockGeometry } from "../../v3/props/proceduralRock.js";
import { simplifierReady } from "../../v3/render/instancing/autoLod.js";
import { MAP, PLAY } from "./layout.js";
import { getSharedGltfLoader } from "../../v3/render/foliage/glbLoader.js";
import { mix, normalMap } from "three/tsl";

const TEX = (id, m) => `/textures/ground/${id}/${id}_${m}_1k.jpg`;

/** Per ground: its photo, how many stones per 100 m² at full weight, of which shapes. */
const AURES_GROUNDS = {
  scree:     { slot: 2, id: "rocks_ground_02",        tint: "#ffffff", per100: 5.5, shapes: [["pebble", 0.55], ["rock", 0.4], ["lump", 0.05]] },
  limestone: { slot: 1, id: "rock_boulder_dry", tint: "#ffffff", per100: 1.2, shapes: [["rock", 0.45], ["lump", 0.35], ["boulder", 0.2]] },
  soil:      { slot: 0, id: "brown_mud_dry",        tint: "#ffffff", per100: 0.35, shapes: [["pebble", 0.6], ["rock", 0.4]] },
  wadi:      { slot: 4, id: "rocky_trail",          tint: "#f4ece0", per100: 4.0, shapes: [["cobble", 0.7], ["pebble", 0.3]] },
  gravel:    { slot: 6, id: "dry_mud_field_001",    tint: "#eadcc4", per100: 9.0, shapes: [["pebble", 0.8], ["rock", 0.2]], edge: [0.08, 0.55] },
};

/** The shapes: the rock kit's classes, lighter, a few variants each. */
const SHAPES = {
  pebble:  { size: [0.16, 0.09, 0.13], tris: 48,  seeds: [3, 7],  extra: { chips: 10, detail: 12, simplifyError: 0.3 } },
  rock:    { size: [0.42, 0.27, 0.35], tris: 120, seeds: [2, 5],  extra: { chips: 18, detail: 20, baseCut: 0.18, simplifyError: 0.15 } },
  lump:    { size: [0.9, 0.6, 0.75],   tris: 360, seeds: [1, 4],  extra: { chips: 32, bigCuts: 3, baseCut: 0.2, detail: 30 } },
  boulder: { size: [0.85, 1.05, 0.75], tris: 520, seeds: [6],     extra: { chips: 40, bigCuts: 4, detail: 32 } },
  // River stones: few shallow chips, round egg — water-worn.
  cobble:  { size: [0.24, 0.13, 0.19], tris: 64,  seeds: [8, 9],  extra: { chips: 5, chipMax: 0.06, edgeSoft: 0.03, egg: 0.02, detail: 14, simplifyError: 0.25 } },
};

/** A map's own grounds (maps/*.js `stones`: the same shape, its own paint slots and photos), else the Aurès'. */
const GROUNDS = MAP.stones ?? AURES_GROUNDS;
const GROUND_KEYS = Object.keys(GROUNDS);
const PHOTO = 1024;

/**
 * The grounds' photos as ONE texture array (layer = GROUND_KEYS index). Rows
 * packed bottom-up: the separate photos were image textures (flipY), so the
 * triplanar taps land on the same texels as before.
 */
/**
 * THE PHOTOS, FETCHED EARLY (the boot A/B, 2026-10-08): asked for only when the stones were built,
 * they waited behind the rest of the boot — 1.2 s there, 0.14 s on an idle page. algGame starts
 * this at the very top of the boot; fetched and decoded OFF the main thread (createImageBitmap).
 */
let _photos = null;
export function prefetchStonePhotos() {
  _photos ??= Promise.all(GROUND_KEYS.map(async (gk) => {
    const res = await fetch(TEX(GROUNDS[gk].id, "diff"));
    return createImageBitmap(await res.blob());
  }));
  return _photos;
}

async function stonePhotos() {
  const imgs = await prefetchStonePhotos();
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = PHOTO;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const data = new Uint8Array(PHOTO * PHOTO * 4 * imgs.length), row = PHOTO * 4;
  imgs.forEach((img, l) => {
    ctx.clearRect(0, 0, PHOTO, PHOTO);
    ctx.drawImage(img, 0, 0, PHOTO, PHOTO);
    const px = ctx.getImageData(0, 0, PHOTO, PHOTO).data, o = l * PHOTO * row;
    for (let y = 0; y < PHOTO; y++) data.set(px.subarray(y * row, y * row + row), o + (PHOTO - 1 - y) * row);
  });
  const tex = new THREE.DataArrayTexture(data, PHOTO, PHOTO, imgs.length);
  tex.format = THREE.RGBAFormat;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  markGpuOnly(tex);   // static once uploaded: the game drops the CPU pixels
  return tex;
}

/**
 * THE stone material (2026-10-03, perf audit: was one per ground — 5 materials
 * over 23 instanced meshes, ~46 shader builds and 23 draws). Each stone's
 * ground is a per-instance attribute (`ground`): its layer of the photo array,
 * triplanar, a tile per ~0.9 m, and its ground's tint.
 */
function stoneMaterial(photos) {
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.95, metalness: 0 });
  mat.name = "Stone";
  const layer = int(attribute("ground", "float").add(0.5));
  // Shared render group: one copy per material, not re-sent for every draw
  // (shared-rts/PERF_RULES.md rule 7 — perfCheck caught it, 2026-10-03).
  const tints = uniformArray(GROUND_KEYS.map((gk) => new THREE.Color(GROUNDS[gk].tint)), "color").setGroup(renderGroup);
  const S = float(1 / 0.9);
  const w0 = pow(abs(normalWorld), vec3(4));
  const w = w0.div(w0.x.add(w0.y).add(w0.z));
  const p = positionWorld.mul(S);
  const c = texture(photos, vec2(p.z, p.y)).depth(layer).rgb.mul(w.x)
    .add(texture(photos, vec2(p.x, p.z)).depth(layer).rgb.mul(w.y))
    .add(texture(photos, vec2(p.x, p.y)).depth(layer).rgb.mul(w.z));
  // A shade lighter than the ground photo: a stone's top catches the sun the
  // flat ground photo already had baked in its shadows.
  mat.colorNode = c.mul(tints.element(layer)).mul(1.12);
  return mat;
}

/**
 * A scan's material: the boulder's OWN baked colour (the Namaqualand desert boulders: ochre-brown, the Aurès' own dry
 * rock — not tinted: the pale limestone tint read white against the red earth, seen) and its baked normal map, each
 * rock's brightness EVENED to one level (its photo over its own mean: the smallest mip, ~30 % of it the empty UV
 * space; the bakes ranged 0.27-0.40). The per-instance ground attribute is not read here.
 */
const SCAN_TINT = new THREE.Color(0.55, 0.45, 0.34);
function scanStoneMaterial(photos, src, app = null, geo = null) {
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.92, metalness: 0 });
  mat.name = `Stone:scan:${src.name}`;
  const map = src.map;
  if (map) {
    const c = texture(map).rgb, lum = (v) => v.r.mul(0.3).add(v.g.mul(0.59)).add(v.b.mul(0.11));
    mat.colorNode = c.mul(float(0.17).div(lum(texture(map).level(float(12)).rgb).max(0.08)));   // (0.24: pale, greyish — seen)
  } else mat.colorNode = vec3(SCAN_TINT.r, SCAN_TINT.g, SCAN_TINT.b);
  if (src.normalMap) mat.normalNode = normalMap(texture(src.normalMap));
  // (its foot in the ground's colour, its hue leaning to the ground's — algGroundBlend, 2026-10-24)
  if (app) {
    // (the fade over a share of ITS height: the source geometry's bounds — a scaled copy keeps the same share)
    if (geo && !geo.boundingBox) geo.computeBoundingBox();
    const bounds = geo ? { minY: geo.boundingBox.min.y, maxY: geo.boundingBox.max.y } : null;
    mat.userData.gbBase = mat.colorNode;   // (its colour without the blend: an A/B of its cost, the dev console)
    mat.colorNode = groundBlend(app, mat.colorNode, { bounds });
  }
  return mat;
}
/** The six scans (null: no file — the procedural shapes stay). */
async function loadBoulders() {
  try {
    const gltf = await getSharedGltfLoader().loadAsync("/models/alg/boulders.glb");
    const out = [];
    gltf.scene.traverse((o) => { if (o.isMesh) out.push(o); });
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out.length ? out : null;
  } catch (e) { console.warn("[stones] no boulder scans:", e?.message ?? e); return null; }
}

/**
 * THE SCANNED BOULDERS FOR THE OUTCROPS (2026-10-24, you, on the training camp: a white faceted outcrop "has holes" — "I
 * thought we solved this stone issue"): the loose stones took the scans on 10-22, the outcrops (algLandmarks) were
 * still the old procedural eggs. Each outcrop variant `i` gets scan i % n, its longest side `size` m (the old outcrop's
 * width), its own sunk base — and the same material as the stones. Null without the scans.
 */
export async function scanOutcropParts(size = 3.4, app = null) {
  const scans = await loadBoulders();
  if (!scans) return null;
  return scans.map((m) => {
    // (the GLB's attributes are meshopt-QUANTIZED — normalized 16-bit, the node's own scale and offset undo them: moved and
    // scaled as they are they CLAMP — the first try drew hollow ribbons. Plain floats first, the node's transform in.)
    const g = new THREE.BufferGeometry();
    for (const [k, at] of Object.entries(m.geometry.attributes)) {
      const out = new Float32Array(at.count * at.itemSize);
      for (let i = 0; i < at.count; i++) for (let c = 0; c < at.itemSize; c++) out[i * at.itemSize + c] = at.getComponent(i, c);
      g.setAttribute(k, new THREE.BufferAttribute(out, at.itemSize));
    }
    if (m.geometry.index) g.setIndex(new THREE.BufferAttribute(Uint32Array.from(m.geometry.index.array), 1));
    m.updateMatrix(); g.applyMatrix4(m.matrix);
    g.computeBoundingBox();
    const b = g.boundingBox, k = size / Math.max(b.max.x - b.min.x, b.max.z - b.min.z);
    g.translate(-(b.min.x + b.max.x) / 2, -b.min.y, -(b.min.z + b.max.z) / 2).scale(k, k, k);
    g.computeBoundingSphere();
    return { geometry: g, material: scanStoneMaterial(null, m.material, app, g) };
  });
}

export async function createAlgStones(app, { seed = 1954 } = {}) {
  const t0 = performance.now(), lap = [];
  await simplifierReady;
  lap.push(["simplifier", performance.now()]);
  // Shapes, built once.
  const geos = {};
  for (const [k, s] of Object.entries(SHAPES)) {
    geos[k] = s.seeds.map((sd) => {
      const g = createRockGeometry({ seed: sd, sizeX: s.size[0], sizeY: s.size[1], sizeZ: s.size[2], targetTriangles: s.tris, simplifyError: 0.05, ...s.extra });
      g.computeBoundingBox();
      return g;
    });
  }
  // THE BIG ONES: the scans (each 1 m long, its foot at 0) — a lump 0.9 m, a boulder bigger and taller
  const scans = await loadBoulders();
  const scanSrc = {};   // geometry uuid → the scan mesh (its material)
  if (scans) {
    const sized = (k, sx, sy) => scans.map((m) => { const g = m.geometry.clone().scale(sx, sy, sx); g.computeBoundingBox(); scanSrc[g.uuid] = m; return g; });
    geos.lump = sized("lump", 0.9, 0.9);
    geos.boulder = sized("boulder", 1.3, 1.15);   // (1.15 × 1.4: a real rock stretched up read as a tree stump — seen)
  }
  lap.push(["scans", performance.now()]);
  let st = seed;
  const rnd = () => ((st = (st * 16807) % 2147483647) / 2147483647);

  // ── Where: a jittered 2 m grid over PLAY, each cell a chance per ground ──
  const CELL = 2, AREA = CELL * CELL / 100;
  const lists = {};                       // `${ground}|${shape}|${variant}` → [{x, z, s, yaw}]
  const blocked = (x, z) => app.navGrid?.isBlockedAtWorld?.(x, z);
  let n = 0;
  for (let z = PLAY.z0 + 3; z < PLAY.z1 - 3; z += CELL) {
    for (let x = PLAY.x0 + 3; x < PLAY.x1 - 3; x += CELL) {
      const w = app.samplePaintWeights?.(x, z);
      if (!w) continue;
      if (w[3] > 0.15) continue;                                       // the oasis grove
      for (const [gk, g] of Object.entries(GROUNDS)) {
        let k = w[g.slot];
        if (g.edge) k = k > g.edge[0] && k < g.edge[1] ? 1 : 0;        // the piste's shoulders only
        else if (w[6] > 0.08 && gk !== "wadi") k *= 0.1;               // not on a track
        if (k <= 0.02 || rnd() > k * g.per100 * AREA) continue;
        const px = x + (rnd() - 0.5) * CELL, pz = z + (rnd() - 0.5) * CELL;
        if (blocked(px, pz)) continue;
        const y = app.getWorldHeight(px, pz);
        if ((app.getWaterLevelAt?.(px, pz) ?? -Infinity) > y - 0.05) continue;
        // The shape, by the ground's mix.
        let r = rnd(), shape = g.shapes[0][0];
        for (const [sh, share] of g.shapes) { if ((r -= share) <= 0) { shape = sh; break; } }
        const v = Math.floor(rnd() * geos[shape].length);
        const key = `${gk}|${shape}|${v}`;
        (lists[key] ??= []).push({ x: px, z: pz, y, s: 0.65 + rnd() * 0.8, yaw: rnd() * Math.PI * 2 });
        n++;
      }
    }
  }

  // ── The meshes: ONE material, one instanced mesh per shape variant ──────
  // (each stone's ground rides along as a per-instance attribute).
  lap.push(["shapes+placing", performance.now()]);
  const photos = await stonePhotos();
  const mat = stoneMaterial(photos);
  const scanMats = {};   // (one per scan photo: the three Namaqualand rocks share theirs)
  lap.push(["photos", performance.now()]);
  const byShape = {};                     // `${shape}|${variant}` → [{ ...p, g }]
  for (const [key, list] of Object.entries(lists)) {
    const [gk, shape, v] = key.split("|");
    const g = GROUND_KEYS.indexOf(gk);
    // Instance index within its old (ground, shape) list: the sink/scale
    // jitter below keys on it, so every stone keeps its exact old form.
    for (let i = 0; i < list.length; i++) (byShape[`${shape}|${v}`] ??= []).push({ ...list[i], g, i });
  }
  const group = new THREE.Group();
  group.name = "AlgStones";
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), qy = new THREE.Quaternion(), sc = new THREE.Vector3(), pos = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0), nv = new THREE.Vector3();
  for (const [key, list] of Object.entries(byShape)) {
    const [shape, v] = key.split("|");
    const geo = geos[shape][+v];
    const ground = new THREE.InstancedBufferAttribute(new Float32Array(list.length), 1);
    geo.setAttribute("ground", ground);
    const src = scanSrc[geo.uuid];
    const mesh = new THREE.InstancedMesh(geo, src ? (scanMats[src.material.uuid] ??= scanStoneMaterial(photos, src.material, app, src.geometry)) : mat, list.length);
    mesh.name = `Stones:${key}`;
    const hgt = geo.boundingBox.max.y - geo.boundingBox.min.y;
    list.forEach((p, k) => {
      const i = p.i;
      ground.array[k] = p.g;
      // Tilted to the ground (halfway: a stone rests, it does not lie flat on a
      // steep face), turned, and SUNK 20-35% of its height.
      const gn = app.getWorldNormal?.(p.x, p.z);
      nv.set(gn?.x ?? 0, gn?.y ?? 1, gn?.z ?? 0).lerp(up, scanSrc[geo.uuid] ? 0.8 : 0.45).normalize();
      q.setFromUnitVectors(up, nv).multiply(qy.setFromAxisAngle(up, p.yaw));
      const s = p.s * (shape === "boulder" ? 1.2 + (i % 3) * 0.3 : 1);
      // (a scan: deeper — its mesh is open underneath, a raised foot showed the cut — seen)
      // (a scan rebuilt is FLAT where the scan had no data — its base: deeper, and tilted less below)
      const sink = src ? 0.42 + ((i * 7) % 12) / 100 : 0.2 + ((i * 7) % 16) / 100;
      pos.set(p.x, p.y - geo.boundingBox.min.y * s - hgt * s * sink, p.z);
      m.compose(pos, q, sc.set(s * (0.85 + ((i * 13) % 30) / 100), s, s));
      mesh.setMatrixAt(k, m);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    // Only the big ones cast (a pebble's shadow is a pixel; the shadow pass isn't free).
    mesh.castShadow = shape === "lump" || shape === "boulder";
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  app.scene.add(group);
  const counts = {};
  for (const [key, list] of Object.entries(lists)) { const gk = key.split("|")[0]; counts[gk] = (counts[gk] ?? 0) + list.length; }
  // (its parts: the boot regression A/B, 2026-10-08 — 0.4 s on 10-04, 0.5-4.1 s since)
  const parts = lap.map(([k, at], i) => `${k} ${Math.round(at - (i ? lap[i - 1][1] : t0))}`).join(", ");
  console.log(`[stones] ${n} stones in ${group.children.length} draws (${Object.entries(counts).map(([k, c]) => `${k} ${c}`).join(", ")}) in ${Math.round(performance.now() - t0)} ms (${parts}, meshes ${Math.round(performance.now() - lap.at(-1)[1])})`);
  /**
   * Take out every stone `fn(x, z)` says to (worked land: algFields.js). Each
   * goes by moving the mesh's last instance into its slot: once, at load.
   */
  function clearWhere(fn) {
    let gone = 0;
    const mm = new THREE.Matrix4();
    for (const mesh of group.children) {
      for (let i = 0; i < mesh.count; i++) {
        mesh.getMatrixAt(i, mm);
        if (!fn(mm.elements[12], mm.elements[14])) continue;
        mesh.getMatrixAt(mesh.count - 1, mm);
        mesh.setMatrixAt(i, mm);
        // Its ground (the per-instance photo layer) moves with it.
        const g = mesh.geometry.getAttribute("ground");
        if (g) { g.array[i] = g.array[mesh.count - 1]; g.needsUpdate = true; }
        mesh.count--; i--; gone++;
        mesh.instanceMatrix.needsUpdate = true;
      }
    }
    return gone;
  }
  return { group, counts, total: n, clearWhere };
}
