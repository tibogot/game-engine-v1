// SANDSTONE ROCKS (2026-10-08, you, a CoH 3 screenshot: "those big rocks — could you make them
// procedurally?"). In the BUILDINGS LAB first; not in the game yet.
//
// What makes CoH's read as AAA, and where each comes from here:
//   the SHAPE      a flat-topped slab, rounded worn edges, the foot undercut, vertical joints —
//                  the engine's chipped-egg generator (v3/props/proceduralRock.js) with its
//                  sandstone options (undercut, strata, joints)
//   the LAYERS     the bedding: a photo of layered sandstone on the sides (cliff_side), projected
//                  from the sides only so its layers stay level whatever the rock's turn
//   the TOP        weathered and cracked: another photo (rock_boulder_cracked) on the faces that
//                  look up, a little darker (desert varnish)
//   the RELIEF     both photos' normal maps, triplanar (whiteout blend)
//   the EDGES      the generator's baked curvature: worn edges lighter, the joints darker
// The sand skirt at the foot is the game's contact splats (algGroundContact.js) — not in the lab.
import * as THREE from "three";
import { abs, attribute, clamp, dot, float, mix, normalGeometry, positionGeometry, pow, smoothstep, texture, transformNormalToView, uniform, vec2, vec3 } from "three/tsl";
import { createRockGeometry } from "../../v3/props/proceduralRock.js";
import { RENDER_ORDER } from "../shared-rts/renderOrder.js";

/** The shapes (metres, half-extents): a long mesa slab, a shorter block, a low boulder. */
export const SANDSTONE_SHAPES = {
  mesa: {
    label: "Grand banc", sizeX: 10, sizeY: 3.4, sizeZ: 5.5, egg: -0.08, squareness: 4.2, topCut: 0.27, baseCut: 0.12,
    chips: 44, chipMax: 0.12, bigCuts: 7, bigMax: 0.24, maxChipUp: 0.62, maxChipDown: 0.4, edgeSoft: 0.022, lump: 0.12,
    undercut: 0.16, undercutHeight: 0.35, strata: 6, strataDepth: 0.07, joints: 7, jointDepth: 0.13, jointWidth: 0.32, topRelief: 0.025,
    detail: 96, targetTriangles: 6000, simplifyError: 0.005,
  },
  block: {
    label: "Bloc", sizeX: 5.5, sizeY: 3.2, sizeZ: 4.2, egg: -0.04, squareness: 3.8, topCut: 0.24, baseCut: 0.14,
    chips: 38, chipMax: 0.12, bigCuts: 5, bigMax: 0.24, maxChipUp: 0.62, maxChipDown: 0.4, edgeSoft: 0.025, lump: 0.12,
    undercut: 0.14, undercutHeight: 0.35, strata: 5, strataDepth: 0.07, joints: 5, jointDepth: 0.12, jointWidth: 0.3, topRelief: 0.025,
    detail: 100, targetTriangles: 4500, simplifyError: 0.005,
  },
  low: {
    label: "Dalle basse", sizeX: 6.5, sizeY: 1.6, sizeZ: 4.5, egg: 0.0, squareness: 3.6, topCut: 0.21, baseCut: 0.15,
    chips: 34, chipMax: 0.11, bigCuts: 5, bigMax: 0.2, maxChipUp: 0.62, maxChipDown: 0.35, edgeSoft: 0.03, lump: 0.12,
    undercut: 0.12, undercutHeight: 0.4, strata: 3, strataDepth: 0.06, joints: 4, jointDepth: 0.12, jointWidth: 0.28, topRelief: 0.03,
    detail: 100, targetTriangles: 3500, simplifyError: 0.005,
  },
};

export function buildSandstoneRock(shape = "mesa", seed = 1) {
  const { label, ...p } = SANDSTONE_SHAPES[shape];
  return createRockGeometry({ ...p, seed });
}

const TEX = (id, m) => `/textures/ground/${id}/${id}_${m}_1k.jpg`;
function photo(url, srgb) {
  const t = new THREE.TextureLoader().load(url);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** The tunables (live: the lab's sliders write them). */
export const sandstoneLook = {
  tint: uniform(new THREE.Color(1, 1, 1)),
  sideTile: uniform(4.5),      // metres a tile of the layered photo
  topTile: uniform(7.0),       // metres a tile of the cracked photo (3 m repeated visibly on a 20 m rock)
  topDark: uniform(0.6),       // the top's varnish: CoH's tops are darker than the faces, not bleached
  topHue: uniform(new THREE.Color(1.0, 0.8, 0.62)),   // the cracked photo (beige) pulled to the faces' ochre
  // The top: 1 = the SAME layered stone as the sides, seen from above (eroded layers outcrop as
  // bands, as on real sandstone — you: "shouldn't the top be the same stone?"); 0 = the cracked photo.
  topSame: uniform(1),
  edgeLight: uniform(0.35),    // worn edges lighter
  creaseDark: uniform(0.45),   // joints and hollows darker
  footDark: uniform(0.22),     // the foot in its own dust and shade
  saturation: uniform(1),      // 1 = the photos' own colour
};

/**
 * THE COLOURS (2026-10-08, you: "keep the CoH look as the lab's default, but I need a version that
 * goes with the game"): CoH = the photos as they are (the red desert of the screenshot); AURÈS =
 * the same stone greyed towards the map's ochre and limestone (the ground photos, the kit's stone).
 */
export const SANDSTONE_COLOURS = {
  coh: { label: "CoH (rouge)", tint: [1, 1, 1], saturation: 1, topDark: 0.6 },
  // (the photo greyed alone reads PINK — red without its orange: the tint puts the yellow back)
  aures: { label: "Aurès (ocre)", tint: [1.14, 1.0, 0.72], saturation: 0.5, topDark: 0.66 },
  aures2: { label: "Aurès (gris)", tint: [1.06, 1.0, 0.84], saturation: 0.22, topDark: 0.7 },
};
export function setSandstoneColour(key) {
  const c = SANDSTONE_COLOURS[key];
  sandstoneLook.tint.value.setRGB(...c.tint);
  sandstoneLook.saturation.value = c.saturation;
  sandstoneLook.topDark.value = c.topDark;
}

/**
 * The material: triplanar photos and their normal maps, the top its own photo. In the ROCK'S OWN
 * space (its geometry, before any instance or model transform): the photos stay on the rock when
 * it turns (in world space they slid over it on the lab's turntable — you, 2026-10-08), and each
 * rock placed at its own yaw shows its own patch. The layers stay level: rocks only yaw.
 */
export function sandstoneMaterial() {
  const sideD = photo(TEX("cliff_side", "diff"), true), sideN = photo(TEX("cliff_side", "nor_gl"));
  const topD = photo(TEX("rock_boulder_cracked", "diff"), true), topN = photo(TEX("rock_boulder_cracked", "nor_gl"));
  const L = sandstoneLook;
  const n = normalGeometry.normalize();
  const a = pow(abs(n.x), float(4)).add(1e-4), b = pow(abs(n.z), float(4)).add(1e-4);
  const ps = positionGeometry.div(L.sideTile), pt = positionGeometry.div(L.topTile);
  const uvX = vec2(ps.z, ps.y), uvZ = vec2(ps.x, ps.y), uvY = vec2(pt.x, pt.z);
  // Colour: the sides blended by facing, the top over them where the face looks up.
  const side = texture(sideD, uvX).rgb.mul(a).add(texture(sideD, uvZ).rgb.mul(b)).div(a.add(b));
  const topSameCol = texture(sideD, uvY.mul(L.topTile.div(L.sideTile))).rgb;
  const top = mix(texture(topD, uvY).rgb.mul(L.topHue), topSameCol, L.topSame).mul(L.topDark);
  const up = smoothstep(0.4, 0.92, n.y);      // a wide blend: a narrow one drew a hard rim
  let col = mix(side, top, up);
  // The baked curvature (x) and height (y): worn edges, dark joints, the foot.
  const shade = attribute("rockShade", "vec2");
  const edge = clamp(shade.x.mul(4), -1, 1);
  col = col.mul(float(1).add(edge.max(0).mul(L.edgeLight)).sub(edge.min(0).negate().mul(L.creaseDark)));
  col = col.mul(float(1).sub(L.footDark.mul(float(1).sub(smoothstep(0.0, 0.3, shade.y)))));
  // Relief: each projection's tangent normal, whiteout-blended into the world normal.
  const tn = (tex, uv) => texture(tex, uv).xyz.mul(2).sub(1);
  const nx = tn(sideN, uvX), nz = tn(sideN, uvZ), ny = mix(tn(topN, uvY), tn(sideN, uvY.mul(L.topTile.div(L.sideTile))), L.topSame);
  const wX = vec3(nx.xy.add(vec2(n.z, n.y)), abs(nx.z).mul(n.x)).zyx;
  const wZ = vec3(nz.xy.add(vec2(n.x, n.y)), abs(nz.z).mul(n.z));
  const wY = vec3(ny.xy.add(vec2(n.x, n.z)), abs(ny.z).mul(n.y)).xzy;
  const sideNrm = wX.mul(a).add(wZ.mul(b)).normalize();
  const nObj = mix(sideNrm, wY, up).normalize();
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.92, metalness: 0 });
  mat.name = "Sandstone";
  // Saturation about the colour's own luminance, then the tint.
  col = mix(vec3(dot(col, vec3(0.2126, 0.7152, 0.0722))), col, L.saturation);
  mat.colorNode = col.mul(L.tint);
  // normalNode is VIEW space (three r184): the rock's-space normal through its instance and model.
  mat.normalNode = transformNormalToView(nObj).normalize();
  return mat;
}

/**
 * THE SAND APRON — LAB PREVIEW (in the game, the ground splats do it: algGroundContact.js): pale
 * blown sand and grit round a rock's foot, ragged at its edge, fading out ~35% past the rock. A
 * disc 4 cm above the lab's flat ground, drawn after it with no depth write (no z-fight).
 */
export function sandApron(geo) {
  geo.computeBoundingBox();
  const bb = geo.boundingBox, rx = (bb.max.x - bb.min.x) / 2 * 1.35 + 1.5, rz = (bb.max.z - bb.min.z) / 2 * 1.35 + 1.5;
  const disc = new THREE.CircleGeometry(1, 64).rotateX(-Math.PI / 2).scale(rx, 1, rz);
  disc.translate((bb.max.x + bb.min.x) / 2, 0.04, (bb.max.z + bb.min.z) / 2);
  const sand = photo(TEX("gravelly_sand", "diff"), true);
  sand.repeat.set((rx * 2) / 3, (rz * 2) / 3);
  // The fade: a soft radial gradient whose edge is broken by noise (an alphaMap: plain, no nodes).
  const N = 256, cv = document.createElement("canvas");
  cv.width = cv.height = N;
  const ctx = cv.getContext("2d"), img = ctx.createImageData(N, N);
  const wob = Array.from({ length: 6 }, (_, k) => ({ f: 3 + k * 2, a: 0.05 / (1 + k * 0.5), p: k * 1.7 }));
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const u = (x + 0.5) / N * 2 - 1, v = (y + 0.5) / N * 2 - 1, ang = Math.atan2(v, u);
    let r = Math.hypot(u, v);
    for (const w of wob) r += Math.sin(ang * w.f + w.p) * w.a;
    const t = Math.min(1, Math.max(0, (r - 0.42) / 0.55)), a = (1 - t * t * (3 - 2 * t)) * 0.85;
    const o = (y * N + x) * 4;
    img.data[o] = img.data[o + 1] = img.data[o + 2] = Math.round(a * 255);
    img.data[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const fade = new THREE.CanvasTexture(cv);
  const mat = new THREE.MeshStandardNodeMaterial({ map: sand, alphaMap: fade, color: 0xffeedd, roughness: 1, metalness: 0, transparent: true, depthWrite: false });
  mat.name = "SandApron";
  mat.polygonOffset = true; mat.polygonOffsetFactor = -2; mat.polygonOffsetUnits = -2;
  const m = new THREE.Mesh(disc, mat);
  m.receiveShadow = true;
  m.renderOrder = RENDER_ORDER.FIELDS;   // painted on the ground, as the fields
  return m;
}
