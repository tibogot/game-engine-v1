// NAM ROCKS — the map's kit rocks made to belong in this war. GAME code,
// nam-rts only: the rock kit, the editor and your other game are untouched.
// Your note (2026-09-26): "the rocks look too stylized for this game".
//
// What made them read stylized, and what this does about it:
//   · painted pale BEVEL EDGES and one clean blue-grey (the kit's rockShade
//     look) → a PHOTO rock material instead: Rock028 (weathered grey stone,
//     moss in its cracks), projected on three axes with its normal map;
//     limestone grey, and in patches red LATERITE (the region's iron stone);
//     MOSS on what faces the sky; a DAMP dark band where the rock meets soil.
//   · sitting ON the ground like pebbles → each rock SUNK 15-30% of its
//     height and tilted a few degrees: rocks are buried, not placed.
//   · a spray of small stones over every meadow → most lone small stones go;
//     they stay on slopes, near water and by the cliffs, where stones are.
//
// ?rocks=kit boots with the kit's own look and placement: the before/after.
import * as THREE from "three";
import {
  Fn, abs, dot, float, mix, normalWorld, normalize, pow, positionWorld, sin, smoothstep, texture,
  transformNormalToView, vec2, vec3,
} from "three/tsl";
import { drapeY } from "./terrainDrape.js";

const TEX = "/textures/pbr_materials/Rock028/Rock028_2K-JPG_";

function loadTex(url, srgb) {
  const t = new THREE.TextureLoader().load(url);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = 8;
  return t;
}
const lin = (hex) => { const c = new THREE.Color(hex); return vec3(c.r, c.g, c.b); };

/** The rock material: triplanar photo stone, laterite patches, moss, damp base. */
function namRockMaterial(heightTexNode) {
  const albedo = loadTex(`${TEX}Color.jpg`, true), nrm = loadTex(`${TEX}NormalGL.jpg`, false);
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.92, metalness: 0 });
  mat.name = "NamRock";
  const wp = positionWorld;
  const S = float(1 / 2.6);                              // one texture tile per 2.6 m
  const w0 = pow(abs(normalWorld), vec3(4));
  const w = w0.div(w0.x.add(w0.y).add(w0.z));
  const uvX = vec2(wp.z, wp.y).mul(S), uvY = vec2(wp.x, wp.z).mul(S), uvZ = vec2(wp.x, wp.y).mul(S);
  const cX = texture(albedo, uvX).rgb, cY = texture(albedo, uvY).rgb, cZ = texture(albedo, uvZ).rgb;
  const stone = cX.mul(w.x).add(cY.mul(w.y)).add(cZ.mul(w.z));
  // Large, slow patches: limestone grey or red laterite.
  const n1 = sin(wp.x.mul(0.013).add(wp.z.mul(0.009))).mul(sin(wp.z.mul(0.011).sub(wp.x.mul(0.007))));
  const lum = dot(stone, vec3(0.3, 0.59, 0.11));
  const laterite = smoothstep(0.25, 0.45, n1);
  const limestone = mix(stone, vec3(lum), 0.35).mul(1.25);            // greyer; the photo is dark (wet stone)
  const red = vec3(lum).mul(lin("#b0603a")).mul(1.9);
  let col = mix(limestone, red, laterite.mul(0.85));
  // Moss where the rock faces the sky, in drifts.
  const n2 = sin(wp.x.mul(0.9).add(wp.z.mul(0.7))).mul(sin(wp.z.mul(1.1).sub(wp.x.mul(0.5))));
  const moss = smoothstep(0.55, 0.85, normalWorld.y).mul(smoothstep(-0.3, 0.4, n2));
  col = mix(col, lin("#3a4a1e").mul(lum.mul(1.6).add(0.4)), moss.mul(0.75));
  // Damp at the foot: the band a rock keeps wet where it meets the soil.
  if (heightTexNode) {
    const above = wp.y.sub(drapeY(heightTexNode, wp.x, wp.z));
    col = col.mul(mix(float(0.55), float(1), smoothstep(0.0, 0.7, above)));
  }
  mat.colorNode = col;
  // The stone's own relief: the three projections' normals folded onto the surface.
  mat.normalNode = Fn(() => {
    const nX = texture(nrm, uvX).xy.mul(2).sub(1), nY = texture(nrm, uvY).xy.mul(2).sub(1), nZ = texture(nrm, uvZ).xy.mul(2).sub(1);
    const k = float(0.8);
    const pert = vec3(0, nX.y, nX.x).mul(w.x).add(vec3(nY.x, 0, nY.y).mul(w.y)).add(vec3(nZ.x, nZ.y, 0).mul(w.z)).mul(k);
    return transformNormalToView(normalize(normalWorld.add(pert)));
  })();
  mat.roughnessNode = mix(float(0.9), float(0.97), moss);
  return mat;
}

const SMALL = /^Rock: (Stone|Lump)/;

/**
 * Give the map's kit rocks the nam look (see the header). Call after the
 * level has loaded and the game has removed the rocks its sites need gone.
 * Returns { changed, removed } or null when ?rocks=kit.
 */
export function applyNamRocks(app) {
  if (new URLSearchParams(location.search).get("rocks") === "kit") return null;
  const ps = app.propStore;
  if (!ps?.types) return null;
  const rockType = ps.types.map((t) => /^Rock:/.test(t?.name ?? ""));
  let seed = 90210;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

  // 1. Fewer lone small stones: they stay on slopes, near water and cliffs.
  const keepSmall = (x, z) => {
    if (app.getWorldNormal(x, z).y < 0.9) return true;                     // a slope
    for (const [dx, dz] of [[6, 0], [-6, 0], [0, 6], [0, -6]]) {
      if (app.getWorldNormal(x + dx, z + dz).y < 0.8) return true;         // by a cliff
      if ((app.getWaterLevelAt?.(x + dx, z + dz) ?? -Infinity) > app.getWorldHeight(x + dx, z + dz)) return true;  // by water
    }
    return rnd() < 0.15;                                                     // a few strays
  };
  let removed = 0;
  for (let i = ps.instances.length - 1; i >= 0; i--) {
    const inst = ps.instances[i];
    if (!rockType[inst.typeIdx] || !SMALL.test(ps.types[inst.typeIdx].name)) continue;
    if (keepSmall(inst.px, inst.pz)) continue;
    const last = ps.instances.length - 1;
    if (i !== last) ps.instances[i] = ps.instances[last];
    ps.instances.pop();
    removed++;
  }

  // 1b. KARST PILLARS on the hillsides (your go, 2026-09-26): the tall grey
  // limestone of Ha Long and Ninh Binh — the most Vietnamese rock there is.
  // On steep ground only (34-55°: nobody walks there anyway, so they block
  // nothing), 40 m from any structure, never in the paddies, in loose groups.
  const karst = ps.types.map((t, i) => (/^Rock: Karst/.test(t?.name ?? "") ? i : -1)).filter((i) => i >= 0);
  let added = 0;
  const karstSpots = [];
  app.namKarst = karstSpots;
  if (karst.length) {
    const built = (app.structures?.list ?? []).map((q) => q.position);
    const placed = (app.placed?.pieces ?? []).map((q) => ({ x: q.x, z: q.z }));
    const steep = (x, z) => { const ny = app.getWorldNormal(x, z).y; return ny < 0.83 && ny > 0.57; };
    const clear = (x, z) => ![...built, ...placed].some((q) => (q.x - x) ** 2 + (q.z - z) ** 2 < 40 * 40)
      && !app.ricePaddies?.inBlock?.(x, z)
      && !((app.getWaterLevelAt?.(x, z) ?? -Infinity) > app.getWorldHeight(x, z) - 1);
    const spots = [];
    for (let k = 0; k < 20000 && spots.length < 45; k++) {
      const x = (rnd() - 0.5) * 960, z = (rnd() - 0.5) * 960;
      if (!steep(x, z) || !clear(x, z)) continue;
      if (spots.some((q) => (q.x - x) ** 2 + (q.z - z) ** 2 < 9 * 9)) continue;
      // Groups: past the first few, a new pillar wants a neighbour within 30 m.
      if (spots.length > 6 && !spots.some((q) => (q.x - x) ** 2 + (q.z - z) ** 2 < 30 * 30) && rnd() < 0.7) continue;
      spots.push({ x, z });
    }
    for (const { x, z } of spots) {
      // Tall enough to stand OUT of the canopy (its crowns are ~20-25 m up):
      // 17-30 m pillars, their feet cleared (clearKarstGround, after the
      // canopy is painted).
      const s = 1.5 + rnd() * 0.8;
      ps.instances.push({
        typeIdx: karst[Math.floor(rnd() * karst.length)], px: x, py: app.getWorldHeight(x, z), pz: z,
        rx: 0, ry: rnd() * 360, rz: 0, sx: s * (0.85 + rnd() * 0.3), sy: s * (1.1 + rnd() * 0.5), sz: s * (0.85 + rnd() * 0.3),
      });
      karstSpots.push({ x, z, r: 4 * s + 3 });
      added++;
    }
  }

  // 2. Buried and tilted.
  let changed = 0;
  for (const inst of ps.instances) {
    if (!rockType[inst.typeIdx]) continue;
    const box = ps.types[inst.typeIdx].mergedBox;
    const h = box ? (box.max.y - box.min.y) * Math.abs(inst.sy ?? 1) : 1;
    inst.py -= h * (0.15 + 0.15 * rnd());
    inst.rx = (inst.rx ?? 0) + (rnd() - 0.5) * 14;
    inst.rz = (inst.rz ?? 0) + (rnd() - 0.5) * 14;
    changed++;
  }
  ps._bump();

  // 3. The photo material on every mesh that draws a rock type.
  const old = new Set();
  ps.types.forEach((t, i) => {
    if (!rockType[i]) return;
    for (const list of [t.entries, t.lod1Entries, t.lod2Entries]) for (const e of list ?? []) if (e?.material) old.add(e.material);
  });
  const mat = namRockMaterial(app.heightTexNode);
  const swap = (o) => {
    if (!o.isMesh) return;
    if (Array.isArray(o.material)) o.material = o.material.map((m) => (old.has(m) ? mat : m));
    else if (old.has(o.material)) o.material = mat;
  };
  app.scene.traverse(swap);
  // The instancer rebuilds its meshes on the bump: swap those too, and keep
  // the entries pointing at it so any later rebuild uses it.
  ps.types.forEach((t, i) => {
    if (!rockType[i]) return;
    for (const list of [t.entries, t.lod1Entries, t.lod2Entries]) for (const e of list ?? []) if (e) e.material = mat;
  });
  requestAnimationFrame(() => requestAnimationFrame(() => app.scene.traverse(swap)));
  return { changed, removed, added, material: mat };
}

/**
 * The karst pillars' feet: the canopy and undergrowth cleared round each, so
 * the pillar rises from open rock and scrub, not out of a hole in the forest.
 * Call AFTER the jungle canopy is painted (it paints over earlier clearings).
 */
export function clearKarstGround(app) {
  for (const k of app.namKarst ?? []) app.clearVegetation?.(k.x, k.z, k.r, { grass: k.r * 0.6, edge: 3 });
  return app.namKarst?.length ?? 0;
}
