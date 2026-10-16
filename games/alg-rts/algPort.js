// THE PORT (2026-10-16, the coast — you: "a real port … AAA, check images online of anything you
// recreate"). A small fishing port of the Constantinois coast in the 1950s, from the refs in
// assets-src/refs/coast/ (Stora, Collo, Philippeville's harbour entrance, 1890s-1930s photos) and
// the FAO's 1961 report on Algerian fishing (open, undecked LAMPARO boats for sardine and anchovy):
//
//   the HOUSES     two-storey colonial row houses along the shore road: lime-washed (white, cream,
//                  ochre, a pale blue), CANAL-TILE roofs at a low pitch, painted shutters (green, blue,
//                  brown), a stone plinth and a cornice, a balcony here and there
//   the MAGASIN    a long one-storey warehouse on the quay: dressed stone, a tile roof, big doors
//   the MOLE       a breakwater of dressed blocks on a rock apron, out from the beach, a parapet on its
//                  sea side, bollards, a small white LIGHTHOUSE with a green lantern at its tip
//   the BOATS      lamparo boats, ~8 m (game scale): open double-ended hulls painted white with a
//                  coloured band, a short mast, the big lamp on its pole at the stern
//
// Built as the masonry (algMasonry.js): real photos projected in each piece's own space, one merged
// mesh per surface. World metres at the game's scale (man-made things ×1.3). A piece's front (doors,
// windows) looks down −Z. The painted things (shutters, boats, the lantern) in ONE vertex-coloured mesh.
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { SURFACES, newSite, siteGroup } from "./algMasonry.js";

const BUILD = (id, m) => `/textures/build/${id}/${id}_${m}_1k.jpg`;
// THE PORT'S SURFACES (the masonry's material code; the photos from tools/fetchBuildingMaterials.mjs)
Object.assign(SURFACES, {
  // the lime washes: one rough plaster photo, its colour per house
  // (the photo is mid-grey — mean sRGB 124,113,87, linear ~0.17: the tints lift it ~3.5× to a wash)
  washWhite: { url: BUILD, id: "white_plaster_rough_01", tile: 2.4, tint: [3.5, 3.45, 3.3], sat: 0.2, rough: 0.95, foot: 0.3, single: true },
  washCream: { url: BUILD, id: "white_plaster_rough_01", tile: 2.4, tint: [3.6, 3.2, 2.45], sat: 0.25, rough: 0.95, foot: 0.3, single: true },
  washOchre: { url: BUILD, id: "white_plaster_rough_01", tile: 2.4, tint: [3.5, 2.55, 1.55], sat: 0.25, rough: 0.95, foot: 0.3, single: true },
  washBlue: { url: BUILD, id: "white_plaster_rough_01", tile: 2.4, tint: [2.7, 3.1, 3.5], sat: 0.2, rough: 0.95, foot: 0.3, single: true },
  // the canal tiles (their channels run along the photo's v: down a slope whose ridge runs along X)
  tiles: { url: BUILD, id: "clay_roof_tiles_02", tile: 2.5, tint: [1.15, 0.98, 0.86], sat: 0.85, rough: 0.9, foot: 0, single: true },
  // dressed blocks: the quay, the mole, plinths and cornices (warmed: the photo is a cool grey)
  quay: { url: BUILD, id: "large_sandstone_blocks", tile: 3.0, tint: [3.6, 3.2, 2.6], sat: 0.45, rough: 0.95, foot: 0.2 },
});
const WASHES = ["washWhite", "washCream", "washOchre", "washWhite", "washBlue", "washCream"];
const SHUTTERS = [[0.22, 0.38, 0.27], [0.2, 0.33, 0.5], [0.4, 0.27, 0.17], [0.26, 0.45, 0.42], [0.5, 0.2, 0.15]];

function rng(seed) { let s = seed >>> 0 || 1; return () => ((s = Math.imul(s ^ (s >>> 15), 2246822507) + 1013904223) >>> 0) / 4294967296; }
const box = (w, h, d, x, y, z) => new THREE.BoxGeometry(w, h, d).translate(x, y, z);
/** sRGB → linear (vertex colours are linear: the palette written as seen came out washed-out beige). */
const lin = (c) => c.map((v) => v ** 2.2);
/** A box of one colour (the painted mesh). */
function paintBox(w, h, d, x, y, z, col) {
  const g = new THREE.BoxGeometry(w, h, d).translate(x, y, z);
  const n = g.attributes.position.count, c = new Float32Array(n * 3), L = lin(col);
  for (let i = 0; i < n; i++) c.set(L, i * 3);
  g.setAttribute("color", new THREE.BufferAttribute(c, 3));
  g.deleteAttribute("uv");
  return g;
}
/** A gable end: the triangle under the roof, both faces, in the YZ plane at x. */
function gable(x, y0, z, d, rise) {
  const g = new THREE.BufferGeometry();
  const p = [x, y0, z - d / 2, x, y0, z + d / 2, x, y0 + rise, z];
  g.setAttribute("position", new THREE.Float32BufferAttribute([...p, ...p], 3));
  g.setIndex([0, 1, 2, 5, 4, 3]);
  g.computeVertexNormals();
  return g;
}

/** A new port site: the masonry's site + the port's surfaces + the painted list. */
export const newPortSite = () => ({ ...newSite(), washWhite: [], washCream: [], washOchre: [], washBlue: [], tiles: [], quay: [], paint: [] });

/**
 * A GABLE ROOF of canal tiles over a w × d body whose walls top out at y: ridge along X, eaves
 * `over` m past the front and back walls, `pitch` rad. Adds the gable ends in `wall`.
 */
function roof(site, wall, { x, z, w, d, y, pitch = 0.3, over = 0.4 }) {
  const half = d / 2 + over, rise = Math.tan(pitch) * half, slope = half / Math.cos(pitch), th = 0.16;
  for (const s of [-1, 1]) {
    const g = new THREE.BoxGeometry(w + 0.3, th, slope).rotateX(s * pitch).translate(x, y + rise / 2 + th / 2 - 0.02, z + s * half / 2);
    site.tiles.push(g);
  }
  // the ridge: a row of round tiles
  site.tiles.push(new THREE.CylinderGeometry(0.13, 0.13, w + 0.35, 8).rotateZ(Math.PI / 2).translate(x, y + rise + 0.1, z));
  // the gable ends (the triangle of wall from the walls' top to the ridge)
  const r = Math.tan(pitch) * d / 2;
  site[wall].push(gable(x - w / 2, y, z, d, r), gable(x + w / 2, y, z, d, r));
}

/** A window: its dark opening (proud of the wall: no shared face) and its two shutters open beside it. */
function windowAt(site, x, y, zFace, out, ww, wh, col, sill = true) {
  site.dark.push(box(ww, wh, 0.1, x, y, zFace + out * 0.03));
  for (const sx of [-1, 1]) site.paint.push(paintBox(ww / 2, wh, 0.07, x + sx * (ww * 0.75 + 0.04), y, zFace + out * 0.06, col));
  if (sill) site.quay.push(box(ww + 0.25, 0.1, 0.22, x, y - wh / 2 - 0.05, zFace + out * 0.1));
}

/**
 * A COLONIAL ROW HOUSE: (x, z) the centre of its footprint, w along the street (X), d deep, two
 * storeys (or `storeys`), its front at z − d/2 (−Z). Lime wash, a stone plinth and cornice, a canal
 * tile roof, windows with painted shutters, a door (or a shop's wide doorway), a balcony sometimes,
 * a chimney.
 */
export function portHouse(site, { x = 0, z = 0, w = 7.5, d = 7, storeys = 2, seed = 1, wash = null, shop = false } = {}) {
  const R = rng(seed * 7919 + 13);
  const S = 3.6, H = S * storeys + 0.5;   // a storey (game scale), the parapet under the eaves
  wash ??= WASHES[(seed * 3 + 1) % WASHES.length];
  const col = SHUTTERS[(seed * 5 + 2) % SHUTTERS.length].map((c) => c * (0.9 + R() * 0.2));
  site[wash].push(box(w, H, d, x, H / 2, z));
  // the plinth (a band of dressed stone, proud) and the cornice under the eaves, front and back
  for (const s of [-1, 1]) {
    site.quay.push(box(w + 0.02, 0.7, 0.12, x, 0.35, z + s * (d / 2 + 0.05)));
    site.quay.push(box(w + 0.02, 0.28, 0.24, x, H - 0.14, z + s * (d / 2 + 0.1)));
  }
  roof(site, wash, { x, z, w, d, y: H, pitch: 0.28 + R() * 0.06 });
  // THE FRONT: windows in bays ~2.6 m apart; on the ground floor a door in one bay (or a shop's
  // wide doorway), windows in the rest; a band between the storeys
  const n = Math.max(2, Math.round(w / 2.6)), bay = w / n, zf = z - d / 2;
  const door = Math.floor(R() * n);
  for (let f = 0; f < storeys; f++) {
    const y = f * S + (f === 0 ? 1.55 : 1.9);
    for (let i = 0; i < n; i++) {
      const bx = x - w / 2 + bay * (i + 0.5);
      if (f === 0 && i === door) {
        const dw = shop ? Math.min(bay * 0.8, 2.6) : 1.2;
        site.dark.push(box(dw, 2.5, 0.1, bx, 1.25, zf - 0.03));
        site.paint.push(paintBox(dw + 0.16, 0.16, 0.08, bx, 2.58, zf - 0.05, col));   // the lintel, painted
        if (shop) site.paint.push(paintBox(dw * 0.95, 0.5, 0.06, bx, 3.05, zf - 0.07, [0.6, 0.55, 0.42]));   // its sign
        continue;
      }
      windowAt(site, bx, y, zf, -1, 1.05, f === 0 ? 1.7 : 1.9, col, f > 0);
    }
    if (f > 0) site.quay.push(box(w + 0.02, 0.18, 0.14, x, f * S, zf - 0.05));
  }
  // a BALCONY (a stone slab on brackets, an iron rail) over the door, sometimes
  if (storeys > 1 && R() < 0.55) {
    const bx = x - w / 2 + bay * (door + 0.5), by = S + 0.05;
    site.quay.push(box(2.0, 0.16, 0.95, bx, by, zf - 0.48));
    site.metal.push(box(2.0, 0.05, 0.05, bx, by + 1.0, zf - 0.93), box(0.05, 0.05, 0.92, bx - 0.98, by + 1.0, zf - 0.48), box(0.05, 0.05, 0.92, bx + 0.98, by + 1.0, zf - 0.48));
    for (let k = 0; k < 9; k++) site.metal.push(box(0.03, 0.95, 0.03, bx - 0.96 + k * 0.24, by + 0.55, zf - 0.93));
  }
  // THE BACK: one window a storey; a chimney on the ridge's back slope
  for (let f = 0; f < storeys; f++) windowAt(site, x + (R() - 0.5) * w * 0.5, f * S + 1.9, z + d / 2, 1, 0.9, 1.4, col);
  const cx = x + (R() - 0.5) * w * 0.6;
  site[wash].push(box(0.7, 1.6, 0.55, cx, H + 1.1, z + d * 0.22));
  site.tiles.push(box(0.85, 0.1, 0.7, cx, H + 1.95, z + d * 0.22));
  return { x, z, w, d, h: H };
}

/** THE MAGASIN: a long warehouse on the quay — dressed stone, a tile roof, big plank doors. */
export function portWarehouse(site, { x = 0, z = 0, w = 22, d = 10, seed = 3 } = {}) {
  const H = 5.6;
  site.quay.push(box(w, H, d, x, H / 2, z));
  roof(site, "quay", { x, z, w, d, y: H, pitch: 0.26, over: 0.5 });
  const n = Math.max(2, Math.round(w / 7)), zf = z - d / 2;
  for (let i = 0; i < n; i++) {
    const bx = x - w / 2 + (w / n) * (i + 0.5);
    site.dark.push(box(3.0, 3.8, 0.1, bx, 1.9, zf - 0.03));
    site.planks.push(box(1.45, 3.7, 0.1, bx - 2.2, 1.85, zf - 0.08));   // a leaf folded back
    site.dark.push(box(1.2, 0.8, 0.1, bx + 2.6, 4.3, zf - 0.03));        // a high window
  }
  return { x, z, w, d, h: H };
}

/**
 * THE MOLE: from (x, z) on the beach out along `dir` (rad, 0 = −Z) for `len` m, `width` wide, its top
 * `top` m over the sea at `sea`. Dressed blocks on a rock apron (the seabed hides the foot), a parapet
 * on its sea side (the left, walking out), bollards, the LIGHTHOUSE at its tip.
 */
export function portMole(site, { x = 0, z = 0, dir = 0, len = 70, width = 7, sea = 0, top = 1.7, foot = -9 } = {}) {
  const g = [];
  const H = top - foot, y0 = sea + foot;
  // the body (its own frame: along −Z), then the parapet, bollards and the lighthouse
  g.push(["quay", box(width, H, len, 0, y0 + H / 2, -len / 2)]);
  // the rock apron along both sides, a slope under the water line
  for (const s of [-1, 1]) g.push(["quay", new THREE.BoxGeometry(3.2, H - 0.6, len).rotateZ(s * 0.5).translate(s * (width / 2 + 0.6), y0 + (H - 0.6) / 2 - 0.3, -len / 2)]);
  g.push(["quay", box(0.9, 1.3, len - 6, -width / 2 + 0.45, sea + top + 0.65, -len / 2 + 3)]);
  for (let k = 0; k < Math.floor(len / 9); k++) g.push(["metal", new THREE.CylinderGeometry(0.22, 0.28, 0.6, 10).translate(width / 2 - 0.6, sea + top + 0.3, -6 - k * 9)]);
  // THE LIGHTHOUSE: a white round tower on a square base, its gallery, the lantern (green, the
  // harbour's starboard light), a dome
  const tz = -len + 3.5, ty = sea + top;
  g.push(["quay", box(4.2, 1.2, 4.2, 0, ty + 0.6, tz)]);
  g.push(["washWhite", new THREE.CylinderGeometry(1.25, 1.5, 9.5, 20).translate(0, ty + 1.2 + 4.75, tz)]);
  g.push(["quay", new THREE.CylinderGeometry(1.9, 1.7, 0.3, 20).translate(0, ty + 10.85, tz)]);
  for (let k = 0; k < 16; k++) { const a = (k / 16) * Math.PI * 2; g.push(["metal", box(0.05, 0.9, 0.05, Math.cos(a) * 1.8, ty + 11.45, tz + Math.sin(a) * 1.8)]); }
  g.push(["metal", new THREE.TorusGeometry(1.8, 0.04, 4, 24).rotateX(Math.PI / 2).translate(0, ty + 11.9, tz)]);
  g.push(["paint", (() => { const c = new THREE.CylinderGeometry(0.85, 0.85, 1.5, 12).translate(0, ty + 11.75, tz); return colour(c, [0.25, 0.62, 0.38]); })()]);
  g.push(["paint", colour(new THREE.SphereGeometry(0.95, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2).translate(0, ty + 12.5, tz), [0.2, 0.36, 0.26])]);
  g.push(["dark", box(0.8, 1.7, 0.1, 0, ty + 2.05, tz - 1.33)]);   // its door
  // into the site, turned to `dir` about the root
  const m = new THREE.Matrix4().makeRotationY(-dir).setPosition(x, 0, z);
  for (const [k, geo] of g) site[k].push(geo.applyMatrix4(m));
  return { tip: new THREE.Vector3(0, 0, -len).applyMatrix4(m), len, width };
}
function colour(g, col) {
  const n = g.attributes.position.count, c = new Float32Array(n * 3), L = lin(col);
  for (let i = 0; i < n; i++) c.set(L, i * 3);
  g.setAttribute("color", new THREE.BufferAttribute(c, 3));
  if (g.attributes.uv) g.deleteAttribute("uv");
  return g;
}

/**
 * A LAMPARO BOAT, ~8 m: an open double-ended hull (lofted: the beam fullest a little aft, the sheer
 * rising to both stems), white with a coloured band at the gunwale and a darker bottom, thwarts, a
 * short mast, the lamp on its pole at the stern. Its waterline at y = 0, its bow toward −Z.
 * Returns a geometry with vertex colours (the painted mesh).
 */
export function portBoat({ seed = 1, len = 8.2, beam = 2.5 } = {}) {
  const R = rng(seed * 31 + 7);
  const BAND = [[0.2, 0.33, 0.55], [0.55, 0.18, 0.14], [0.22, 0.45, 0.32], [0.75, 0.6, 0.22], [0.2, 0.25, 0.3]][seed % 5];
  const HULL = R() < 0.7 ? [0.86, 0.85, 0.8] : [0.32, 0.46, 0.6];
  const BOTTOM = [0.42, 0.18, 0.12];
  const NS = 22, NP = 9;   // stations along, points round a half section (keel → gunwale)
  const pos = [], col = [], idx = [];
  for (let i = 0; i <= NS; i++) {
    const t = (i / NS) * 2 - 1;                                   // −1 bow … +1 stern
    const b = (beam / 2) * Math.pow(Math.max(0, 1 - Math.pow(Math.abs(t + 0.08), 2.2)), 0.55);
    const sheer = 0.95 + 0.45 * t * t;                            // the gunwale rises to the stems
    const keel = -0.55 * (1 - t * t * 0.6);
    for (let s = -NP; s <= NP; s++) {
      const a = s / NP;                                           // −1 port gunwale … +1 starboard
      const ang = a * Math.PI / 2;
      const px = Math.sin(ang) * b, py = keel + (sheer - keel) * (1 - Math.cos(ang)) ** 0.9;
      pos.push(px, py, t * len / 2);
      const c = py > sheer - 0.28 ? BAND : py < 0.02 ? BOTTOM : HULL;
      col.push(...lin(c));
    }
  }
  const row = NP * 2 + 1;
  for (let i = 0; i < NS; i++) for (let s = 0; s < row - 1; s++) {
    const a = i * row + s, b = a + 1, c = a + row, d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  const hull = new THREE.BufferGeometry();
  hull.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  hull.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  hull.setIndex(idx);
  hull.computeVertexNormals();
  // the inside: the same hull, faces turned, a little smaller, weathered wood
  const inner = hull.clone();
  const ip = inner.attributes.position, ic = inner.attributes.color;
  for (let i = 0; i < ip.count; i++) { ip.setX(i, ip.getX(i) * 0.94); ip.setY(i, ip.getY(i) - 0.03); ic.setXYZ(i, ...lin([0.42, 0.33, 0.24])); }
  const ii = inner.index.array; for (let k = 0; k < ii.length; k += 3) { const t = ii[k]; ii[k] = ii[k + 1]; ii[k + 1] = t; }
  inner.computeVertexNormals();
  const parts = [hull, inner];
  const wood = [0.45, 0.35, 0.25];
  for (const tz of [-1.6, 0.2, 1.9]) parts.push(colour(new THREE.BoxGeometry(beam * 0.82, 0.07, 0.3).translate(0, 0.62, tz), wood));
  parts.push(colour(new THREE.CylinderGeometry(0.06, 0.08, 3.4, 6).translate(0, 2.3, -1.4), wood));   // the mast
  // the LAMP: a pole leaning out over the stern quarter, the lamp (a white globe in a cage)
  parts.push(colour(new THREE.CylinderGeometry(0.04, 0.05, 2.6, 6).rotateX(-0.35).translate(0.5, 1.9, len / 2 - 0.9), wood));
  parts.push(colour(new THREE.SphereGeometry(0.22, 10, 6).translate(0.5, 3.15, len / 2 - 0.45), [0.95, 0.93, 0.82]));
  // nets heaped amidships (a lumpy brown mound) on some
  if (R() < 0.6) parts.push(colour(new THREE.SphereGeometry(0.75, 8, 5, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.45, 1.3).translate(0, 0.35, 0.9), [0.36, 0.3, 0.24]));
  for (const p of parts) { for (const k of Object.keys(p.attributes)) if (k !== "position" && k !== "normal" && k !== "color") p.deleteAttribute(k); if (!p.index) p.setIndex([...Array(p.attributes.position.count).keys()]); }
  return mergeGeometries(parts);
}

let _paint = null;
/** The painted things (shutters, the lantern, the boats): vertex colours, both faces (the open hulls). */
export const paintMaterial = () => (_paint ??= new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.8, metalness: 0, side: THREE.DoubleSide, name: "Port:paint" }));

/** The site's meshes: the masonry's (one per surface) and the painted mesh. */
export function portGroup(site, name = "Port") {
  const { paint, ...rest } = site;
  const { group, tris } = siteGroup(rest, name);
  if (paint.length) {
    const g = mergeGeometries(paint.map((p) => { for (const k of Object.keys(p.attributes)) if (k !== "position" && k !== "normal" && k !== "color") p.deleteAttribute(k); if (!p.index) p.setIndex([...Array(p.attributes.position.count).keys()]); return p; }));
    const m = new THREE.Mesh(g, paintMaterial());
    m.name = `${name}:paint`;
    m.castShadow = m.receiveShadow = true;
    group.add(m);
  }
  return { group, tris };
}

/**
 * THE LAB'S PORT BLOCK: a quay front of row houses (five, the second a shop), the magasin at its
 * end, the mole out from it with its lighthouse, boats along the mole and pulled up on the "beach".
 */
export function buildPortBlock({ seed = 1 } = {}) {
  const site = newPortSite();
  const R = rng(seed);
  let x = -24;
  for (let i = 0; i < 5; i++) {
    const w = 6.5 + R() * 3, d = 7 + R() * 2;
    portHouse(site, { x: x + w / 2, z: d / 2 + R() * 0.8, w, d, storeys: R() < 0.2 ? 3 : 2, seed: seed * 10 + i, shop: i === 1 });
    x += w + 0.02;
  }
  portWarehouse(site, { x: x + 13, z: 5, w: 22, d: 10 });
  portMole(site, { x: x + 4, z: -14, dir: -0.25, len: 60, sea: -0.5, foot: -1.2, top: 1.1 });
  const { group } = portGroup(site, "PortBlock");
  // the boats: three moored along the mole, two pulled up on the beach (tilted on their bilge)
  const boats = [];
  for (let k = 0; k < 5; k++) {
    const m = new THREE.Mesh(portBoat({ seed: seed + k }), paintMaterial());
    m.castShadow = m.receiveShadow = true;
    if (k < 3) { m.position.set(x + 9.5 + k * 3.2, -0.15, -30 - k * 9); m.rotation.y = -0.25 + (R() - 0.5) * 0.2; }
    else { m.position.set(-14 + (k - 3) * 6, 0.35, -14); m.rotation.set(0, 1.4 + (R() - 0.5) * 0.4, 0.18); }
    boats.push(m);
  }
  group.add(...boats);
  return group;
}

/** Pushes `fn`'s pieces into `site`, lifted by `dy` (a house on its own ground). */
function lifted(site, dy, fn) {
  const tmp = newPortSite();
  const r = fn(tmp);
  for (const [k, list] of Object.entries(tmp)) for (const g of list) site[k].push(g.translate(0, dy, 0));
  return r;
}

/**
 * THE PORT IN THE GAME (maps/coast.js `port`): the QUAY FRONT — the magasin, a lane, a row of houses —
 * along a line from `front.from` to `front.to` (world x, z), the fronts facing the sea (the line's
 * left, walking from → to); the MOLE out from `mole.root` along `mole.dir`; the BOATS moored along
 * the mole and pulled up on the beach. Each piece on its own ground (the lowest under its footprint,
 * sunk a little); blocks the nav, clears the plants.
 */
export function createAlgPort(app, { front, mole, sea, seed = 1955, navGrid = null } = {}) {
  const t0 = performance.now();
  const H = (x, z) => app.getWorldHeight(x, z);
  const R = rng(seed);
  // THE QUAY FRONT, in its own frame (x along the line, the fronts toward −z), turned into place
  const [ax, az] = front.from, [bx, bz] = front.to;
  const L = Math.hypot(bx - ax, bz - az), yaw = Math.atan2(-(bz - az), bx - ax);
  const c = Math.cos(yaw), sn = Math.sin(yaw);
  const toWorld = (lx, lz) => [ax + lx * c + lz * sn, az - lx * sn + lz * c];
  const ground = (lx, lz, hw, hd) => {
    let lo = Infinity;
    for (const u of [-1, 0, 1]) for (const v of [-1, 0, 1]) { const [wx, wz] = toWorld(lx + u * hw, lz + v * hd); lo = Math.min(lo, H(wx, wz)); }
    return lo;
  };
  const row = newPortSite();
  const pieces = [];
  // the magasin at the west end, a lane, then the houses
  const ww = 20, wd = 10;
  lifted(row, ground(ww / 2, wd / 2, ww / 2, wd / 2) - 0.25, (st) => portWarehouse(st, { x: ww / 2, z: wd / 2, w: ww, d: wd }));
  pieces.push({ lx: ww / 2, lz: wd / 2, hw: ww / 2, hd: wd / 2 });
  let x = ww + 5;
  for (let i = 0; x < L - 4; i++) {
    const w = Math.min(6.5 + R() * 3, L - x), d = 7 + R() * 2, lz = d / 2 + R() * 0.8;
    lifted(row, ground(x + w / 2, lz, w / 2, d / 2) - 0.25, (st) => portHouse(st, { x: x + w / 2, z: lz, w, d, storeys: R() < 0.25 ? 3 : 2, seed: seed + i, shop: i % 4 === 1 }));
    pieces.push({ lx: x + w / 2, lz, hw: w / 2, hd: d / 2 });
    x += w + (R() < 0.25 ? 3.5 : 0.02);   // a lane now and then
  }
  const { group: rowGroup } = portGroup(row, "PortFront");
  rowGroup.position.set(ax, 0, az);
  rowGroup.rotation.y = yaw;
  // THE MOLE (built in world space: its own photo frame turns with it — it is one long piece)
  const ms = newPortSite();
  const [mx, mz] = mole.root;
  const tip = portMole(ms, { x: mx, z: mz, dir: mole.dir, len: mole.len, width: 7, sea, top: 1.6, foot: -9 });
  const { group: moleGroup } = portGroup(ms, "PortMole");
  // THE BOATS: one mesh — moored along the mole's sheltered side, pulled up on the beach
  const boats = [];
  const md = [Math.sin(mole.dir), -Math.cos(mole.dir)], side = [Math.cos(mole.dir), Math.sin(mole.dir)];
  for (let k = 0; k < 6; k++) {
    const t = 18 + k * 9.5, bxw = mx + md[0] * t + side[0] * 6.2, bzw = mz + md[1] * t + side[1] * 6.2;
    if (H(bxw, bzw) > sea - 0.4) continue;   // aground: not a mooring
    boats.push({ x: bxw, y: sea + 0.18, z: bzw, yaw: -mole.dir + (R() - 0.5) * 0.25, roll: 0 });
  }
  for (let k = 0; k < 4; k++) {
    // pulled up on the sand west of the mole's root, bows to the sea, heeled on their bilge
    const bxw = mx - 14 - k * 7 + R() * 2, bzw = mz + 7 + R() * 7;   // (landward of the root: dry sand)
    boats.push({ x: bxw, y: H(bxw, bzw) + 0.42, z: bzw, yaw: -mole.dir + Math.PI * (R() < 0.5 ? 0 : 1) + (R() - 0.5) * 0.5, roll: (R() < 0.5 ? -1 : 1) * 0.2 });
  }
  const geos = boats.map((b, k) => portBoat({ seed: seed + k }).applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(b.x, b.y, b.z), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, b.yaw, b.roll, "YXZ")), new THREE.Vector3(1, 1, 1))));
  const boatMesh = new THREE.Mesh(mergeGeometries(geos), paintMaterial());
  boatMesh.name = "PortBoats";
  boatMesh.castShadow = boatMesh.receiveShadow = true;
  const group = new THREE.Group();
  group.name = "Port";
  group.add(rowGroup, moleGroup, boatMesh);
  app.scene.add(group);
  // the nav and the plants: each piece's footprint
  for (const p of pieces) {
    const [wx, wz] = toWorld(p.lx, p.lz);
    navGrid?.addFootprint?.(wx, wz, p.hw + 0.3, p.hd + 0.3, yaw);
    app.clearVegetation?.(wx, wz, Math.hypot(p.hw, p.hd) + 3, { grass: 0, edge: 0.6 });
  }
  console.log(`[alg port] ${pieces.length} buildings, ${boats.length} boats, in ${Math.round(performance.now() - t0)} ms`);
  return { group, pieces, boats, tip };
}
