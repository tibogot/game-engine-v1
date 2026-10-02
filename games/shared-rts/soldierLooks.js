// Faction LOOKS for the Mixamo soldiers — one body, many armies.
//
// A look is three cheap things, none of which needs a new model:
//
//   1. UNIFORM RECOLOUR in the shader. The soldiers' colour maps are low
//      saturation and their parts separate by HUE (measured on Image_3, sRGB):
//      uniform greens 54–68°, khaki 40° (and light), helmet net 47°, boots 36°
//      and belts 32° (both dark), hair 30°, skin 24°. So a colorNode finds the
//      uniform by hue and repaints it — keeping the texture's folds and dirt by
//      scaling the new colour with the texel's luminance — and works on any
//      soldier texture, PNG or KTX2, whatever its UV layout. A camouflage
//      pattern is drawn from 3-D noise on the BIND-POSE position, so it moves
//      with the body and costs no texture.
//   2. NO HELMET: every soldier so far shares the helmet's spot in the colour
//      map (HELMET_UV); the triangles textured from there are the helmet shell,
//      its underside and the chin strap. A bare head with hair sits beneath.
//   3. HEADGEAR: low-poly, vertex-coloured, modelled in metres from the crown
//      of the bare head, hung on the Head bone (in the game: merged into the
//      crowd mesh, skinned 100 % to the Head bone — no extra draw).
//
// The colours are a first pass from memory of photos, to be judged in the lab.
import * as THREE from "three";
import {
  Fn, abs, attribute, clamp, color, dot, float, min, mix, mx_noise_float, positionGeometry, pow,
  smoothstep, step, texture, uniform, uv, vec3, vec4,
} from "three/tsl";
import { prim } from "./procWeapons.js";

/** The helmet's region of the soldiers' colour maps (glTF UVs, v down). */
export const HELMET_UV = { u0: 0.315, u1: 0.665, v0: 0.785, v1: 1.0 };

// Reference luminance (linear) of each repainted part, so its average texel
// comes out exactly the target colour: greens ≈ HSL(60°, .22, .29), khaki ≈
// HSL(40°, .23, .41), the helmet net ≈ HSL(47°, .16, .28).
const LUM_GREEN = 0.09, LUM_KHAKI = 0.17, LUM_HELMET = 0.07;

// Who does what in a French section (by the soldier's index in the squad):
// the leader with a MAT 49 and binoculars, the radioman (his radio replaces
// the pack), the FM 24/29 gunner.
const SECTION_ROLES = {
  0: { name: "leader", weapon: "mat49", kit: ["binoculars"] },
  1: { name: "radio", kit: ["radio"], drop: ["pack"] },
  2: { name: "LMG", weapon: "fm2429" },
};

// The ALN's skin: the pale end is the texture's own tone, the other end this
// multiplier (olive to deep tan, per soldier through his variation).
const ALN_SKIN = [0.66, 0.5, 0.38];

export const LOOKS = {
  us: {
    label: "US (as modelled)", remap: false, helmet: true, headgear: null, weapon: null,
  },
  // French M47 fatigues: an olive close to the US one when new, but in Algeria
  // they are mostly seen sun-faded toward a lighter, greyer khaki-green — the
  // US Vietnam look is the darker OG-107 with the netted helmet.
  appele: {
    label: "Appelé", note: "French conscript: faded M47 fatigues, plain painted helmet",
    green: 0x6f6d4b, khaki: 0x838059, helmet: true, helmetColor: 0x5a5a40, headgear: null, weapon: "mas49_56",
    kit: ["pack", "belt"],
  },
  appeleBrousse: {
    label: "Appelé, bush hat", note: "chapeau de brousse",
    green: 0x6f6d4b, khaki: 0x838059, helmet: false, headgear: "bushHat", hatColor: 0x77744f, weapon: "mas49_56",
    kit: ["pack", "belt"],
  },
  // The Génie's sapeur (alg-rts): the appelé's fatigues and helmet, a pack and
  // belt, sleeves-up extras; his shovel appears when he digs (the TOOL bone).
  sapeur: {
    label: "Sapeur du Génie", note: "the appelé's kit, dressed for work",
    green: 0x6f6d4b, khaki: 0x838059, helmet: true, helmetColor: 0x5a5a40, hatColor: 0x77744f, weapon: "mas49_56",
    variants: [{ w: 0.7 }, { w: 0.3, helmet: false, headgear: "bushHat" }],
    kit: ["pack", "belt"],
    extras: { scarf: 0.45, mustache: 0.3, cigarette: 0.2 },
  },
  appeleRadio: {
    label: "Appelé, radio", note: "the section's radio operator",
    green: 0x6f6d4b, khaki: 0x838059, helmet: true, helmetColor: 0x5a5a40, headgear: null, weapon: "mas49_56",
    kit: ["radio", "belt"],
  },
  para: {
    label: "Para (léopard)", note: "camouflaged smock, casquette Bigeard",
    camo: { base: 0xa59c72, green: 0x55603a, brown: 0x6a4b2f }, helmet: false, headgear: "bigeard", weapon: "mat49",
    kit: ["belt"],
  },
  paraBeret: {
    label: "Para, red beret", note: "colonial paras' béret rouge",
    camo: { base: 0xa59c72, green: 0x55603a, brown: 0x6a4b2f }, helmet: false, headgear: "beret", hatColor: 0x7a1c1c, weapon: "mat49",
    kit: ["belt"],
  },
  legionPara: {
    label: "Légion para", note: "Foreign Legion paras: green beret, seven-flame grenade",
    camo: { base: 0xa59c72, green: 0x55603a, brown: 0x6a4b2f }, helmet: false, headgear: "beret", hatColor: 0x2f4a2c,
    badge: "grenade", weapon: "mas49_56", kit: ["belt"],
  },
  // THE HERO (2026-10-02): Colonel Marc Delorme, a FICTIONAL para colonel in
  // the Bigeard mould — the casquette, a cleaner léopard smock than his men's,
  // sunglasses, a scarf; binoculars, the map case, a holster and the rank tab
  // no other man has. Same body (soldier1) as the rest: what sets him apart
  // is the kit, the silhouette and how he is drawn (alg-rts, on his own).
  colonel: {
    label: "Colonel (hero)", note: "Col. Delorme — casquette, binoculars, map case, holster, five galons",
    camo: { base: 0xb3aa7e, green: 0x4f5c34, brown: 0x6e4a2b }, helmet: false, headgear: "bigeard", weapon: "mat49",
    kit: ["belt", "binoculars", "mapCase", "holster", "rankTab", "sunglasses"],
    hero: true,
  },
  // SECTIONS: every man picks one of the look's `variants` (weighted), so a
  // squad mixes headgear; the per-soldier variation (fade, skin tone — see
  // lookColorNode) applies to every look.
  appeleSection: {
    label: "Appelé section", note: "mixed: helmets and bush hats, every man a little different",
    green: 0x6f6d4b, khaki: 0x838059, helmet: true, helmetColor: 0x5a5a40, hatColor: 0x77744f, weapon: "mas49_56",
    variants: [{ w: 0.6 }, { w: 0.4, helmet: false, headgear: "bushHat" }],
    kit: ["pack", "belt"], roles: SECTION_ROLES,
    extras: { scarf: 0.35, mustache: 0.3, cigarette: 0.12, sunglasses: 0.08, grenades: 0.25 },
  },
  paraSection: {
    label: "Para section", note: "mixed: casquettes Bigeard and red berets",
    camo: { base: 0xa59c72, green: 0x55603a, brown: 0x6a4b2f }, helmet: false, weapon: "mat49",
    variants: [{ w: 0.65, headgear: "bigeard" }, { w: 0.35, headgear: "beret", hatColor: 0x7a1c1c }],
    weaponMix: { mat49: 0.55, mas49_56: 0.45 },   // paras carried more SMGs than the line
    kit: ["belt"], roles: SECTION_ROLES,
    extras: { sunglasses: 0.3, scarf: 0.25, mustache: 0.3, cigarette: 0.15, grenades: 0.45 },
  },
  // The 1er REP: Légion paras. Green beret, the seven-flame grenade, the
  // leopard smock; older men — more mustaches, cigarettes, grenades.
  legionSection: {
    label: "Légion section", note: "green berets, grenade badge; the veterans",
    camo: { base: 0xa59c72, green: 0x55603a, brown: 0x6a4b2f }, helmet: false, weapon: "mas49_56",
    variants: [{ w: 1, headgear: "beret", hatColor: 0x2f4a2c, badge: "grenade" }],
    weaponMix: { mas49_56: 0.6, mat49: 0.4 },
    kit: ["belt"], roles: SECTION_ROLES,
    extras: { mustache: 0.5, sunglasses: 0.25, cigarette: 0.3, grenades: 0.55, scarf: 0.15 },
  },
  // ALN (the headband body, aln1). From memory, to check against photos: khaki
  // drill (much of it captured French) mixed with civilian browns; the chèche —
  // a long plain cloth, white/sand/khaki, wound as a turban, sometimes over the
  // lower face (NOT the checkered keffiyeh, which is Levantine); mustaches
  // everywhere, beards in the maquis; bandoliers; MAS 36s, captured MAT 49s and
  // FM 24/29s. Skin: a North African range, olive to deep tan (skinTan).
  aln: {
    label: "ALN, chèche", note: "djoundi: khaki drill, head cloth",
    green: 0x8c7f5e, khaki: 0xa39473, helmet: false, headgear: "cheche", hatColor: 0xd4cbb3, weapon: "mas36",
    kit: ["musette"], skinTan: ALN_SKIN, clothRef: 0.045, bodies: ["aln1", "aln2"],
  },
  alnCap: {
    label: "ALN, field cap", note: "djoundi in a soft khaki cap",
    green: 0x7e7552, khaki: 0x9b8d69, helmet: false, headgear: "fieldCap", hatColor: 0x857953, weapon: "mas36",
    kit: ["musette"], skinTan: ALN_SKIN, clothRef: 0.045, bodies: ["aln1", "aln2"],
  },
  alnSection: {
    label: "ALN section", note: "chèches (some over the face), caps, bare heads; beards, bandoliers",
    // cloth: khaki drill → civilian brown, per man (greenAlt, by his variation)
    green: 0x86775a, greenAlt: 0x5e4b37, khaki: 0xa08f6d, helmet: false, weapon: "mas36",
    skinTan: ALN_SKIN, clothRef: 0.045,
    variants: [
      { w: 0.3, headgear: "cheche", hatColor: 0xdcd5c3 },
      { w: 0.15, headgear: "cheche", hatColor: 0xb3a27c },
      { w: 0.15, headgear: "chechePulled", hatColor: 0xcfc6ae },
      { w: 0.2, headgear: "fieldCap", hatColor: 0x857953 },
      // own headwear: aln1's cloth headband (with its tails), aln2's boonie
      { w: 0.2, headgear: null, helmet: true },
    ],
    bodies: ["aln1", "aln2"],
    kit: ["musette"],
    roles: {
      0: { name: "leader", weapon: "mat49" },
      2: { name: "LMG", weapon: "fm2429" },
      // (no standard-bearer: you, 2026-09-30 — the flag kit stays in KIT)
    },
    weaponMix: { mas36: 0.45, mauser98: 0.3, enfield: 0.25 },
    extras: { beard: 0.45, mustache: 0.5, bandolier: 0.4, bandoliers: 0.25, cigarette: 0.1, kachabia: 0.2 },
  },
  // The ALN's FM gunners (alg-rts fmTeam): the section's look, every man with
  // the FM 24/29 (no mix, no roles), bandoliers for its magazines more often.
  alnGunners: {
    label: "ALN FM gunners", note: "the section's look, all with the FM 24/29",
    green: 0x86775a, greenAlt: 0x5e4b37, khaki: 0xa08f6d, helmet: false, weapon: "fm2429",
    skinTan: ALN_SKIN, clothRef: 0.045,
    variants: [
      { w: 0.35, headgear: "cheche", hatColor: 0xdcd5c3 },
      { w: 0.25, headgear: "fieldCap", hatColor: 0x857953 },
      { w: 0.2, headgear: "chechePulled", hatColor: 0xcfc6ae },
      { w: 0.2, headgear: null, helmet: true },
    ],
    bodies: ["aln1", "aln2"],
    kit: ["musette"],
    extras: { beard: 0.5, mustache: 0.45, bandolier: 0.5, bandoliers: 0.35, cigarette: 0.1 },
  },
  alnKachabia: {
    label: "ALN, kachabia", note: "hooded wool cloak over the drill",
    green: 0x86775a, greenAlt: 0x5e4b37, khaki: 0xa08f6d, helmet: false, headgear: "cheche", hatColor: 0xdcd5c3,
    weapon: "enfield", kit: ["musette", "kachabia"], skinTan: ALN_SKIN, clothRef: 0.045, bodies: ["aln1", "aln2"],
  },
};

/** The look one soldier wears: `look` with one of its variants (by weight) merged in; r in [0, 1). */
export function pickVariant(look, r) {
  if (!look.variants) return look;
  const total = look.variants.reduce((s, v) => s + (v.w ?? 1), 0);
  let t = r * total;
  for (const v of look.variants) {
    t -= v.w ?? 1;
    if (t < 0) return { ...look, ...v };
  }
  return { ...look, ...look.variants.at(-1) };
}

/**
 * A per-soldier vec3 in [0, 1)³ for lookColorNode's variation, read from each
 * object's `userData.vary` (a Vector3) — one shared material, a different value
 * per mesh. The crowd renderer can hash its instanceIndex instead.
 */
export function variationNode() {
  const zero = new THREE.Vector3(0.5, 0, 0); // = no variation
  return uniform(new THREE.Vector3(0.5, 0, 0)).onObjectUpdate(({ object }) => object.userData.vary ?? zero);
}

// ── 1. Uniform recolour ─────────────────────────────────────────────────────

const rgbToHsv = Fn(([c]) => {
  const K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  const p = mix(vec4(c.b, c.g, K.w, K.z), vec4(c.g, c.b, K.x, K.y), step(c.b, c.g));
  const q = mix(vec4(p.x, p.y, p.w, c.r), vec4(c.r, p.y, p.z, p.x), step(p.x, c.r));
  const d = q.x.sub(min(q.w, q.y));
  const e = float(1e-10);
  return vec3(abs(q.z.add(q.w.sub(q.y).div(d.mul(6.0).add(e)))), d.div(q.x.add(e)), q.x);
});

const deg = (d) => d / 360;
// TSL's color(): vec3(new THREE.Color()) compiled to BLACK here (every repainted
// texel came out 0,0,0 in the lab).
const col = (hex) => color(hex);

/**
 * Léopard camouflage at a point given in METRES: sand ground, green and brown
 * blotches ~10–20 cm across (camo.freq noise cycles per metre, default 7).
 * The uniform and the camouflaged headgear both draw from it, so a cap and a
 * smock carry the same pattern.
 */
export function camoNode(pMetres, camo) {
  const p = pMetres.mul(camo.freq ?? 7);
  const g = smoothstep(0.16, 0.22, mx_noise_float(p));
  const b = smoothstep(0.2, 0.26, mx_noise_float(p.mul(1.37).add(vec3(17.1, 3.3, 9.7)))).mul(float(1).sub(g));
  return mix(mix(col(camo.base), col(camo.green), g), col(camo.brown), b);
}

/**
 * The soldier's colour with its uniform (and helmet) repainted for `look`.
 *
 * `neck` (optional) — { point, up } in the MESH's local (bind-pose) space:
 * nothing above that plane is treated as uniform. The face has texels in the
 * uniform's hue (the nostril shadow came out olive — black before — on the
 * appelé), and no uniform reaches above the Head bone. Get it from neckPlane().
 *
 * `vary` (optional) — a vec3 node in [0, 1)³, different per soldier (see
 * variationNode): x = how faded/dark the cloth is (±10 %), y = how far the
 * greens have faded toward the khaki (sun-bleached shirts), z = skin tone,
 * pale → tanned. (0.5, 0, 0) is the look as defined.
 */
export function lookColorNode(map, look, neck = null, vary = null) {
  const tex = texture(map, uv());
  const lin = tex.rgb;
  // The repainted cloth is classified and SHADED from a softer read (one mip
  // and a half down): the pack paints mud as chunky pixel blocks and ETC1S adds
  // 4×4 blocks; lightening dark cloth (the ALN's ~2×) doubled their contrast
  // into a blocky "digital camo". Folds survive the blur; blocks don't. What is
  // not repainted (mud, boots, skin) keeps the sharp texel — the pack's look.
  const soft = texture(map, uv()).bias(1.5).rgb;
  const hsv = rgbToHsv(pow(soft, vec3(1 / 2.2))); // thresholds were measured in sRGB
  const h = hsv.x, s = hsv.y, v = hsv.z;
  // a little of the sharp texel's shading kept, so the cloth isn't smeared
  const lum = mix(dot(soft, vec3(0.2126, 0.7152, 0.0722)), dot(lin, vec3(0.2126, 0.7152, 0.0722)), 0.3);

  const below = neck
    ? step(dot(positionGeometry.sub(vec3(neck.point)), vec3(neck.up)), 0)
    : float(1);
  const greenMask = smoothstep(deg(46), deg(51), h).mul(float(1).sub(smoothstep(deg(150), deg(170), h)))
    .mul(float(1).sub(smoothstep(0.55, 0.7, s))).mul(below);
  const khakiMask = smoothstep(deg(36.5), deg(38.5), h).mul(float(1).sub(smoothstep(deg(45), deg(47), h)))
    .mul(smoothstep(0.36, 0.42, v)).mul(below);

  let green, khaki;
  if (look.camo) {
    // Drawn on the bind pose, so every man would wear the SAME pattern (seen in
    // the lab's para section) — each is shifted by his variation value.
    let p = positionGeometry.div(neck?.unitsPerMetre ?? 1);
    if (vary) p = p.add(vary.mul(vec3(3.1, 1.7, 2.3)));
    const camo = camoNode(p, look.camo);
    green = camo;
    khaki = camo;
  } else {
    green = col(look.green);
    khaki = col(look.khaki);
    // Per man: toward a second cloth colour (ALN: khaki drill → civilian
    // brown), or else sun-faded toward the khaki.
    if (vary) green = look.greenAlt !== undefined ? mix(green, col(look.greenAlt), vary.y) : mix(green, khaki, vary.y.mul(0.35));
  }
  if (vary) {
    const cloth = mix(float(0.9), float(1.1), vary.x);
    green = green.mul(cloth);
    khaki = khaki.mul(cloth);
  }
  // look.clothRef: the luminance of an average cloth texel on THIS body — the
  // ALN body's vest and trousers are far darker than soldier1's greens, so
  // with soldier1's reference khaki came out nearly black.
  let out = mix(lin, green.mul(clamp(lum.div(look.clothRef ?? LUM_GREEN), 0.25, 2.2)), greenMask);
  out = mix(out, khaki.mul(clamp(lum.div(LUM_KHAKI), 0.25, 2.2)), khakiMask);

  if (vary) {
    // Skin: warm (hue 8–34°), light and saturated — clear of the hair (30°
    // but dark), belts (32°, dark) and khaki (40°). Tinted toward a tan.
    const skinMask = smoothstep(deg(8), deg(12), h).mul(float(1).sub(smoothstep(deg(30), deg(34), h)))
      .mul(smoothstep(0.45, 0.55, v)).mul(smoothstep(0.2, 0.3, s));
    const tan = look.skinTan ?? [0.84, 0.7, 0.58];
    const tone = mix(vec3(1, 1, 1), vec3(...tan), vary.z.mul(look.skinRange ?? 1));
    out = out.mul(mix(vec3(1, 1, 1), tone, skinMask));
  }

  if (look.helmet && look.helmetColor !== undefined) {
    // A plain painted helmet: only a trace of the net's shading survives (the
    // netted M1 is the US Vietnam signature). Which vertices are helmet comes
    // from markHelmet() — mesh pieces, not the texture area (see below).
    const inHelmet = attribute("helmet", "float");
    const shade = mix(float(1), clamp(lum.div(LUM_HELMET), 0.4, 1.8), 0.12);
    out = mix(out, col(look.helmetColor).mul(shade), inHelmet);
  }
  return out;
}

/** A node material wearing `look`, built from a soldier's glTF material. */
export function lookMaterial(base, look, key, neck = null, vary = null) {
  if (look.remap === false) return base;
  const m = new THREE.MeshStandardNodeMaterial({
    name: `${base.name}:${key}`, roughness: base.roughness, metalness: base.metalness,
  });
  m.colorNode = lookColorNode(base.map, look, neck, vary);
  return m;
}

/**
 * The neck plane of a soldier mesh AT REST, in its local (bind-pose) space: a
 * point at the Head bone and the up direction. Uniform ends below it.
 */
export function neckPlane(mesh) {
  const head = mesh.skeleton.bones.find((b) => /Head$/.test(b.name));
  const toLocal = mesh.matrixWorld.clone().invert();
  const point = head.getWorldPosition(new THREE.Vector3()).applyMatrix4(toLocal);
  const up = new THREE.Vector3(0, 1, 0).transformDirection(toLocal);
  // The mesh's own units (the Mixamo soldiers: ~8 per metre, upside down) —
  // the camo is sized in metres through this.
  const unitsPerMetre = toLocal.getMaxScaleOnAxis();
  return { point, up, unitsPerMetre };
}

// ── 2. The helmet: mark it, or take it off ─────────────────────────────────
//
// The helmet is found as mesh PIECES (islands: triangles joined through shared
// vertices), not as a texture area: on soldier1 the nose, both eyes and both
// hands also have triangles reaching into the helmet's UV region (the modeller
// packed them against it), so a UV test repainted a triangle under the nose,
// the eye corners and bits of the hands with the helmet colour. A helmet
// piece is one whose triangles lie ≥ 90 % inside HELMET_UV.

/** Islands of a soldier mesh at rest, with what each is (helmet, strap, goggles). */
function headPieces(mesh) {
  const g = mesh.geometry;
  const idx = g.index.array, t = g.attributes.uv, pos = g.attributes.position;
  const inRect = (i) => {
    const u = t.getX(i), v = t.getY(i);
    return u > HELMET_UV.u0 && u < HELMET_UV.u1 && v > HELMET_UV.v0 && v <= HELMET_UV.v1;
  };
  const parent = Array.from({ length: pos.count }, (_, i) => i);
  const find = (x) => { while (parent[x] !== x) x = parent[x] = parent[parent[x]]; return x; };
  for (let k = 0; k < idx.length; k += 3) {
    const a = find(idx[k]);
    parent[find(idx[k + 1])] = a;
    parent[find(idx[k + 2])] = a;
  }
  const islands = new Map();
  const w = new THREE.Vector3();
  for (let k = 0; k < idx.length; k += 3) {
    const r = find(idx[k]);
    const e = islands.get(r) ?? {
      tris: 0, inRect: 0, y0: Infinity, y1: -Infinity, x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity,
      u0: 1, u1: 0, v0: 1, v1: 0,
    };
    e.tris++;
    if (inRect(idx[k]) && inRect(idx[k + 1]) && inRect(idx[k + 2])) e.inRect++;
    for (let j = 0; j < 3; j++) {
      const i = idx[k + j];
      w.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      e.y0 = Math.min(e.y0, w.y); e.y1 = Math.max(e.y1, w.y);
      e.x0 = Math.min(e.x0, w.x); e.x1 = Math.max(e.x1, w.x);
      e.z0 = Math.min(e.z0, w.z); e.z1 = Math.max(e.z1, w.z);
      e.u0 = Math.min(e.u0, t.getX(i)); e.u1 = Math.max(e.u1, t.getX(i));
      e.v0 = Math.min(e.v0, t.getY(i)); e.v1 = Math.max(e.v1, t.getY(i));
    }
    islands.set(r, e);
  }
  const headY = mesh.skeleton.bones.find((b) => /Head$/.test(b.name)).getWorldPosition(new THREE.Vector3()).y;
  const all = [...islands.values()];
  // ≥ 20 triangles: the helmets are 92 + 92 + 24; the ALN body's spiky hair
  // tufts are 1–3-triangle pieces textured from the same UV area — a helmet
  // test by UV alone would have scalped him.
  for (const e of all) e.helmet = e.tris >= 20 && e.inRect / e.tris >= 0.9;
  // Chin straps and hat cords: separate thin pieces — the helmet's (4
  // triangles, ~19 cm, temple → chin) and the boonie's cords (≤ 24 triangles,
  // ~30 cm long, 5 cm deep).
  for (const e of all) {
    e.strap = (e.tris <= 6 && e.y1 - e.y0 > 0.08 && e.y1 > headY + 0.08)
      || (e.tris <= 24 && e.y1 - e.y0 > 0.2 && e.z1 - e.z0 < 0.09 && e.y1 > headY + 0.1);
  }
  const straps = all.filter((e) => e.strap);
  // ...and their buckle bits: tiny pieces textured from the same UV strip.
  for (const e of all) {
    e.buckle = !e.strap && e.tris <= 2 && e.y1 > headY - 0.06 && straps.some((s) =>
      e.u0 > s.u0 - 0.01 && e.u1 < s.u1 + 0.01 && e.v0 > s.v0 - 0.01 && e.v1 < s.v1 + 0.01);
  }
  // Goggles strapped to the helmet's front (soldier3): one small piece across
  // BOTH eyes at the front of the face — wider than 12 cm and centred, unlike
  // an eye (one ~4 cm piece each side) or an ear (at the side).
  for (const e of all) {
    e.goggles = e.tris <= 40 && e.y0 > headY + 0.04 && e.y1 < headY + 0.2
      && e.x1 - e.x0 > 0.12 && Math.abs((e.x0 + e.x1) / 2) < 0.03 && e.z1 > 0.1;
  }
  // Anything else on the head that sticks OUT of the bare head — a hat's brim
  // and crown (aln2's boonie: brim to ±22 cm, crown above the hair). The bare
  // head is the big face-and-hair piece; ears (±14 cm vs ±11.6) and aln1's
  // cloth headband (±12.5) stay inside the 3 cm margin.
  const headIsland = all.filter((e) => e.tris > 300 && e.y1 > headY + 0.2).sort((a, b) => b.tris - a.tris)[0];
  for (const e of all) {
    e.overhang = !!headIsland && e !== headIsland && e.y0 > headY - 0.02 && (
      Math.max(-e.x0, e.x1) > Math.max(-headIsland.x0, headIsland.x1) + 0.03
      || e.z0 < headIsland.z0 - 0.03 || e.z1 > headIsland.z1 + 0.03 || e.y1 > headIsland.y1 + 0.01);
  }
  for (const e of all) e.headwear = e.helmet || e.strap || e.buckle || e.goggles || e.overhang;
  return { idx, find, islands, count: pos.count };
}

/**
 * Give the mesh's geometry a per-vertex `helmet` attribute (1 on helmet
 * pieces, 0 elsewhere) — what the helmet recolour reads. Call once per mesh,
 * at rest; helmet-less geometry from stripHelmet() shares it.
 */
export function markHelmet(mesh) {
  const { idx, find, islands, count } = headPieces(mesh);
  const flag = new Float32Array(count);
  for (let k = 0; k < idx.length; k++) if (islands.get(find(idx[k])).helmet) flag[idx[k]] = 1;
  mesh.geometry.setAttribute("helmet", new THREE.BufferAttribute(flag, 1));
}

/**
 * Give the geometry a per-vertex `headwear` attribute (1 on every headwear
 * piece — helmet, straps, goggles, a hat: what stripHelmet removes). The game's
 * crowd hides it PER SOLDIER (one shared geometry, a per-instance flag) where
 * the lab swaps in the stripped geometry.
 */
export function markHeadwear(mesh) {
  const { idx, find, islands, count } = headPieces(mesh);
  const flag = new Float32Array(count);
  for (let k = 0; k < idx.length; k++) if (islands.get(find(idx[k])).headwear) flag[idx[k]] = 1;
  mesh.geometry.setAttribute("headwear", new THREE.BufferAttribute(flag, 1));
}

/**
 * The mesh's geometry without its helmet: the helmet pieces, the chin straps
 * and their buckles (they hang on the cheeks once the helmet goes — seen in
 * the lab), and soldier3's goggles (they drop over his eyes). Shares the
 * attribute buffers — only the index is new — so it binds to the same skeleton
 * unchanged. `mesh` must be at rest (its matrixWorld and skeleton are read).
 */
export function stripHelmet(mesh) {
  const geometry = mesh.geometry;
  const { idx, find, islands } = headPieces(mesh);
  const keep = [];
  let straps = 0;
  for (const e of islands.values()) if (e.strap) straps++;
  for (let k = 0; k < idx.length; k += 3) {
    if (!islands.get(find(idx[k])).headwear) keep.push(idx[k], idx[k + 1], idx[k + 2]);
  }
  const g = new THREE.BufferGeometry();
  for (const [name, attr] of Object.entries(geometry.attributes)) g.setAttribute(name, attr);
  g.setIndex(keep);
  g.boundingSphere = geometry.boundingSphere?.clone() ?? null;
  g.userData.removedTris = (idx.length - keep.length) / 3;
  g.userData.straps = straps;
  return g;
}

/**
 * The crown of the bare head at rest (world), from the vertices skinned mostly
 * to the Head bone, the helmet's excluded. Headgear is modelled from here.
 */
export function measureCrown(mesh) {
  const g = mesh.geometry, pos = g.attributes.position;
  const si = g.attributes.skinIndex, sw = g.attributes.skinWeight;
  const head = mesh.skeleton.bones.findIndex((b) => /Head$/.test(b.name));
  // Vertices of the bare head only: not on any headwear piece (helmet, hat, straps).
  const { idx, find, islands } = headPieces(mesh);
  const bare = new Set();
  for (let k = 0; k < idx.length; k++) if (!islands.get(find(idx[k])).headwear) bare.add(idx[k]);
  const pts = [];
  const v = new THREE.Vector3();
  for (const i of bare) {
    let w = 0;
    for (let j = 0; j < 4; j++) if (si.getComponent(i, j) === head) w += sw.getComponent(i, j);
    if (w < 0.5) continue;
    pts.push(v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld).clone());
  }
  const box = new THREE.Box3().setFromPoints(pts);
  const top = pts.filter((p) => p.y > box.max.y - 0.04);
  const c = new THREE.Box3().setFromPoints(top).getCenter(new THREE.Vector3());
  return new THREE.Vector3(c.x, box.max.y, c.z);
}

// ── 3. Headgear ─────────────────────────────────────────────────────────────
// Frame: metres; origin at the CROWN of the bare head; +Y up, +Z the way the
// face looks, +X the soldier's left. The bare head, MEASURED (both soldiers,
// hair included) — half-width x, and z back…front, below the crown:
//    −2…−4 cm   ±7.7   −8.5…8.5        −6…−8 cm    ±10.4  −12.2…9.4
//    −8…−10 cm  ±11.6  −10.3…11.8      −12…−14 cm  ±13.6  −13.4…12.5 (ears)
// So the head is centred under the crown and the hair reaches 12–13 cm behind
// it; a hat's band sits on the brow ~10 cm under the crown. (The first hats sat
// 3 cm forward, were 4 cm short at the back — the hair poked through the bush
// hat — and rode too high.) These are big stylised heads; the hats are sized to
// them, and a little generous so they read from the RTS camera.

const { part, tri, toGeometry } = prim;

/** The brow band every hat is built round: just clear of the measured head. */
const BROW = { y: -0.1, rx: 0.132, rz: 0.138 };

/**
 * An elliptical tube between rings (open ends): ring k at height y, radii
 * rx × rz. `color` is one hex or a function (seg, ring) → hex. `from`/`to`
 * limit it to an arc (radians, 0 = the soldier's left, π/2 = the front).
 * Rings listed bottom → top face outward.
 */
function band(color, rings, { segs = 16, from = 0, to = Math.PI * 2, zc = 0 } = {}) {
  const full = to - from >= Math.PI * 2 - 1e-6;
  const n = full ? segs : segs + 1;
  // A ring may sit off-centre (xc, zo) and slope across (tilt: dy per metre of x).
  const pts = rings.map(({ y, rx, rz, xc = 0, zo = 0, tilt = 0 }) => Array.from({ length: n }, (_, i) => {
    const a = from + ((to - from) * i) / segs;
    const x = xc + Math.cos(a) * rx;
    return [x, y + tilt * x, zc + zo + Math.sin(a) * rz];
  }));
  const out = [];
  for (let r = 0; r < rings.length - 1; r++) {
    for (let i = 0; i < segs; i++) {
      const j = full ? (i + 1) % segs : i + 1;
      const p = part(typeof color === "function" ? color(i, r) : color);
      const A = pts[r], B = pts[r + 1];
      tri(p, A[i], B[i], B[j]);
      tri(p, A[i], B[j], A[j]);
      out.push(p);
    }
  }
  return out;
}

/** A flat-ish elliptical cap closing a ring from above: rim at y, apex at y + h. */
function dome(color, y, h, rx, rz, { segs = 16, zc = 0, xc = 0, tilt = 0, apexX = xc } = {}) {
  const p = part(color);
  const apex = [apexX, y + h + tilt * apexX, zc];
  const rim = (a) => { const x = xc + Math.cos(a) * rx; return [x, y + tilt * x, zc + Math.sin(a) * rz]; };
  for (let i = 0; i < segs; i++) {
    tri(p, rim((i / segs) * Math.PI * 2), apex, rim(((i + 1) / segs) * Math.PI * 2));
  }
  return p;
}

/** A brim: the surface between an inner and an outer ring, both faces. */
function brim(color, inner, outer, opts = {}) {
  return [
    ...band(color, [outer, inner], opts), // top face (outer → inner faces up)
    ...band(color, [inner, outer], opts), // underside
  ];
}

const shade = (hex, k) => new THREE.Color(hex).multiplyScalar(k).getHex();
const FRONT = (half) => ({ from: Math.PI / 2 - half, to: Math.PI / 2 + half, segs: 10 });
const BACK = (half) => ({ from: Math.PI * 1.5 - half, to: Math.PI * 1.5 + half, segs: 10 });

/** Chapeau de brousse: soft round crown, wide brim turned down. */
function bushHat(look) {
  const c = look.hatColor ?? 0x77744f, dark = shade(c, 0.72);
  return toGeometry([
    ...band(c, [BROW, { y: -0.05, rx: 0.127, rz: 0.133 }, { y: -0.005, rx: 0.114, rz: 0.119 }, { y: 0.02, rx: 0.096, rz: 0.1 }]),
    dome(c, 0.02, 0.012, 0.096, 0.1),
    ...band(dark, [{ y: -0.1, rx: 0.1335, rz: 0.1395 }, { y: -0.074, rx: 0.1305, rz: 0.1365 }]), // hat band
    ...brim(c, { y: -0.094, rx: 0.132, rz: 0.138 }, { y: -0.132, rx: 0.228, rz: 0.238 }),
  ]);
}

/**
 * Casquette Bigeard: stiff cap, short visor, flap over the neck — in the SAME
 * camouflage as the smock: its vertex colours are only light/shade (white =
 * lit cloth) and headgearMaterial() draws the léopard pattern over them with
 * camoNode(), in metres like the uniform. (The first cap used one flat colour
 * per facet — big blocky squares.) Without a camo look it's a plain cap.
 */
function bigeard(look) {
  const plain = look.camo ? null : (look.hatColor ?? 0x7d7654);
  const tone = (k) => plain !== null ? shade(plain, k) : new THREE.Color(k, k, k).getHex();
  return toGeometry([
    ...band(tone(1), [BROW, { y: -0.05, rx: 0.131, rz: 0.137 }, { y: 0.006, rx: 0.127, rz: 0.133 }]),
    dome(tone(1), 0.006, 0.01, 0.127, 0.133),
    ...brim(tone(0.85), { y: -0.093, rx: 0.132, rz: 0.138 }, { y: -0.112, rx: 0.16, rz: 0.215 }, FRONT(0.95)),
    // neck flap: the back of a skirt hanging from the band, both faces
    ...band(tone(0.95), [{ y: -0.18, rx: 0.142, rz: 0.15 }, { y: -0.098, rx: 0.133, rz: 0.139 }], BACK(1.2)),
    ...band(tone(0.8), [{ y: -0.098, rx: 0.132, rz: 0.138 }, { y: -0.18, rx: 0.141, rz: 0.149 }], BACK(1.2)),
  ]);
}

/**
 * A flat badge lying on a hat's sloping wall. `a` = where round the head
 * (0 = the soldier's left, π/2 = the front, π = his right); p0 → p1 = the wall
 * there, bottom to top. `layers`: [colour, lift (m), 2-D outline points in
 * metres, x across / y up the wall] — each drawn as a fan, lifted a few mm
 * clear of the wall and of the layer under it (no z-fighting).
 */
function badge(a, p0, p1, at, layers) {
  const r = new THREE.Vector3(Math.sin(a), 0, -Math.cos(a));          // across, level
  const u = new THREE.Vector3().subVectors(p1, p0).normalize();         // up the wall
  const n = new THREE.Vector3().crossVectors(r, u);                     // out of the wall
  const c = p0.clone().lerp(p1, at);
  return layers.map(([color, lift, outline]) => {
    // Faces out only if the outline runs counter-clockwise (x across, y up).
    const area = outline.reduce((s, [x, y], i) => {
      const [x2, y2] = outline[(i + 1) % outline.length];
      return s + x * y2 - x2 * y;
    }, 0);
    if (area < 0) outline = [...outline].reverse();
    const p = part(color);
    const q = outline.map(([x, y]) => c.clone().addScaledVector(r, x).addScaledVector(u, y).addScaledVector(n, lift).toArray());
    const mid = q.reduce((s, v) => s.map((t, i) => t + v[i] / q.length), [0, 0, 0]);
    for (let i = 0; i < q.length; i++) tri(p, mid, q[i], q[(i + 1) % q.length]);
    return p;
  });
}

/** Beret: a soft disc on the brow, pulled down to the soldier's left (French fashion). */
function beret(look) {
  const c = look.hatColor ?? 0x7a1c1c, dark = shade(c, 0.7);
  // The band sits level on the brow; the cloth above it is wide, pushed toward
  // the left and sloping down over the left ear. Its top stays above the crown
  // (y 0) — tilting the whole beret (the first two tries) either let the hair
  // through the top or lifted the band off the right side of the head.
  const rings = [
    { y: -0.094, rx: 0.134, rz: 0.14 },
    { y: -0.052, rx: 0.18, rz: 0.176, xc: 0.03, tilt: -0.34 },
    { y: -0.018, rx: 0.166, rz: 0.162, xc: 0.025, tilt: -0.3 },
  ];
  // The insignia (French paras: a winged arm holding a dagger — here wings and
  // a dagger on a round plate), silver, over the RIGHT eye where the beret
  // stands up; the cloth drapes the other way. ~6 cm across, 40 triangles.
  const a = Math.PI / 2 + 0.55;
  const onRing = ({ y, rx, rz, xc = 0, tilt = 0 }) => {
    const x = xc + Math.cos(a) * rx;
    return new THREE.Vector3(x, y + tilt * x, Math.sin(a) * rz);
  };
  const silver = 0xc9cbc6, darkSilver = 0x8d8f8a;
  const circle = (r) => Array.from({ length: 8 }, (_, i) => [Math.cos((i / 8) * Math.PI * 2) * r, Math.sin((i / 8) * Math.PI * 2) * r]);
  const wing = (s) => [[0, 0.004], [s * 0.012, 0.012], [s * 0.031, 0.015], [s * 0.027, 0.006], [s * 0.016, -0.003], [0, -0.004]];
  const dagger = [[0, 0.021], [0.003, 0.012], [0.003, -0.012], [0.006, -0.013], [0, -0.02], [-0.006, -0.013], [-0.003, -0.012], [-0.003, 0.012]];
  return toGeometry([
    ...band(dark, [{ y: -0.104, rx: 0.1335, rz: 0.1395 }, rings[0]]), // leather band
    ...band(c, rings),
    dome(c, -0.018, 0.034, 0.166, 0.162, { xc: 0.025, tilt: -0.3, apexX: 0.01 }),
    ...badge(a, onRing(rings[0]), onRing(rings[1]), 0.5, look.badge === "grenade" ? GRENADE : [
      [darkSilver, 0.004, circle(0.012)],
      [silver, 0.006, wing(-1)],
      [silver, 0.006, wing(1)],
      [0xe2e0d6, 0.008, dagger],
    ]),
  ]);
}

/** Chèche: a long cloth wound round the head in bulging turns. */
function cheche(look) {
  return toGeometry(chechePieces(look));
}

function chechePieces(look) {
  // Turns shaded only slightly apart (the first alternated 100 % / 86 % and
  // read as a striped beehive), the lowest down on the brow just above the
  // eyes — on both bodies the eyes sit ~15.6 cm under the crown.
  // The turns are TILTED alternately (the level ones read as stacked rings):
  // each crosses the front on a slant, the next the other way and a few mm
  // further out, like cloth wound round and round. Radii differ where turns
  // overlap, so they cross rather than coincide (no z-fighting).
  const c = look.hatColor ?? 0xd4cbb3, d = shade(c, 0.93);
  const turn = (y, h, r, tilt, k) => band(k % 2 ? d : c, [
    { y, rx: 0.13 + r, rz: 0.136 + r, tilt },
    { y: y + h / 2, rx: 0.142 + r, rz: 0.148 + r, tilt },
    { y: y + h, rx: 0.13 + r, rz: 0.136 + r, tilt },
  ]);
  // the loose end: from behind the left ear down to the shoulder, flaring
  const tail = { from: Math.PI * 1.5 + 0.35, to: Math.PI * 1.5 + 0.85, segs: 3 };
  return [
    // the cloth under the turns, a shade darker and ≥ 3 mm inside them: the
    // gaps between slanted turns showed the hair and aln1's headband
    ...band(shade(c, 0.8), [
      { y: -0.132, rx: 0.127, rz: 0.132 }, { y: -0.06, rx: 0.126, rz: 0.131 },
      { y: -0.012, rx: 0.106, rz: 0.11 }, { y: 0.014, rx: 0.098, rz: 0.102 },
    ]),
    ...turn(-0.134, 0.042, 0.004, 0.2, 0),
    ...turn(-0.106, 0.042, 0.011, -0.22, 1),
    ...turn(-0.07, 0.04, 0.0, 0.18, 0),
    ...turn(-0.044, 0.038, 0.006, -0.2, 1),
    ...turn(-0.02, 0.034, -0.02, 0.1, 0),
    dome(c, 0.014, 0.014, 0.112, 0.118),
    ...band(d, [{ y: -0.32, rx: 0.13, rz: 0.15 }, { y: -0.1, rx: 0.146, rz: 0.152 }], tail),
    ...band(d, [{ y: -0.1, rx: 0.144, rz: 0.15 }, { y: -0.32, rx: 0.128, rz: 0.148 }], tail),
  ];
}

/**
 * Chèche pulled over the lower face: the same turban, and the cloth's end
 * wound across the mouth and nose, ear to ear. The face at those heights
 * (measured, from the crown): nose tip 18 cm forward at −19 cm, mouth −23,
 * chin −28; the head ±12.5 cm wide there.
 */
function chechePulled(look) {
  const d = shade(look.hatColor ?? 0xcfc6ae, 0.86);
  return toGeometry([
    ...chechePieces(look),
    ...band(d, [
      { y: -0.285, rx: 0.118, rz: 0.15, zo: 0.012 },
      { y: -0.245, rx: 0.132, rz: 0.168, zo: 0.012 },
      { y: -0.205, rx: 0.13, rz: 0.17, zo: 0.012 },
      { y: -0.185, rx: 0.128, rz: 0.158, zo: 0.012 },
    ], { segs: 14 }),
  ]);
}

/** Soft field cap: rounded crown, short visor. */
function fieldCap(look) {
  const c = look.hatColor ?? 0x857953, dark = shade(c, 0.75);
  return toGeometry([
    ...band(c, [BROW, { y: -0.03, rx: 0.128, rz: 0.134 }, { y: 0.008, rx: 0.115, rz: 0.12 }]),
    dome(c, 0.008, 0.01, 0.115, 0.12),
    ...brim(dark, { y: -0.092, rx: 0.132, rz: 0.138 }, { y: -0.105, rx: 0.15, rz: 0.195 }, FRONT(0.85)),
  ]);
}

// The Foreign Legion's seven-flame grenade (from memory: gilt, on the green
// beret): a round bomb and seven flames fanning up from it, each flame its own
// triangle. badge() layers, ~4 cm tall.
const GRENADE = (() => {
  const gold = 0xb8963e, dark = 0x7d6429;
  const bomb = Array.from({ length: 8 }, (_, i) => [Math.cos((i / 8) * Math.PI * 2) * 0.01, -0.009 + Math.sin((i / 8) * Math.PI * 2) * 0.01]);
  const flames = Array.from({ length: 7 }, (_, i) => {
    const t = (i / 6 - 0.5) * 1.9; // −0.95 … 0.95 rad from straight up
    const tip = [Math.sin(t) * 0.024, 0.001 + Math.cos(t) * 0.024];
    const side = [Math.cos(t) * 0.0028, -Math.sin(t) * 0.0028];
    return [gold, 0.007, [[-side[0], 0.001 - side[1]], [side[0], 0.001 + side[1]], tip]];
  });
  return [[dark, 0.004, bomb.map(([x, y]) => [x * 1.15, y * 1.15 - 0.001])], [gold, 0.006, bomb], ...flames];
})();

export const HEADGEAR = { bushHat, bigeard, beret, cheche, chechePulled, fieldCap };

// ── 4. Kit ──────────────────────────────────────────────────────────────────
// Rigid pieces on a bone, like the headgear: vertex-coloured, no texture, and
// in the game merged into the crowd mesh skinned 100 % to their bone (no extra
// draw). Modelled in WORLD metres around soldier1 at rest, from its measured
// torso: the back ~16 cm behind the spine at the chest (1.15–1.30 m), the
// shoulders ~1.33 m, the BELT 0.87–0.95 m high, ±18 cm wide, z −12 … +15 cm.
// (Another body needs its own numbers.) Attach with inverse(bone world at rest).

const OLIVE = 0x5d5a3c, CANVAS = 0x6d6650, RADIO = 0x40432f, DARK = 0x2a2a26, LEATHER = 0x4a3524;

/** A vertical cylinder (open bottom) from y0 to y1 at (x, z); `lean` shifts the top in x/z. */
function post(color, x, z, y0, y1, r, { lean = [0, 0], segs = 8, cap = true } = {}) {
  return [
    ...band(color, [{ y: y0, rx: r, rz: r, xc: x, zo: z }, { y: y1, rx: r, rz: r, xc: x + lean[0], zo: z + lean[1] }], { segs }),
    ...(cap ? [dome(color, y1, r * 0.3, r, r, { segs, xc: x + lean[0], zc: z + lean[1] })] : []),
  ];
}

/** Soldier's pack on the upper back, a rolled blanket strapped on top. */
function pack() {
  const { block } = prim;
  return toGeometry([
    block(OLIVE, { z: -0.295, top: 1.3, bot: 1.03, w: 0.27 }, { z: -0.165, top: 1.32, bot: 1.0, w: 0.3 }),
    block(shade(OLIVE, 0.8), { z: -0.31, top: 1.2, bot: 1.06, w: 0.2 }, { z: -0.293, top: 1.21, bot: 1.05, w: 0.22 }), // outer pocket
    // the blanket roll: a cylinder built upright, closed at both ends, then
    // turned to lie across the top of the pack (a ROTATION: (x, y) → (y, −x) —
    // a plain axis swap would mirror it and turn its faces inside out)
    ...[
      ...band(CANVAS, [{ y: -0.18, rx: 0.052, rz: 0.052 }, { y: 0.18, rx: 0.052, rz: 0.052 }], { segs: 8 }),
      dome(CANVAS, 0.18, 0.01, 0.052, 0.052, { segs: 8 }),
      mapPart(dome(CANVAS, 0.18, 0.01, 0.052, 0.052, { segs: 8 }), ([x, y, z]) => [x, -y, -z]),
    ].map((p) => mapPart(p, ([x, y, z]) => [y, 1.37 - x, -0.235 + z])),
  ]);
}

/**
 * Backpack radio (the SCR-300 / AN-PRC-10 family, from memory): a tall box on
 * the back and a whip antenna ~1.3 m over the head — the most readable shape a
 * squad has from the RTS camera, so the antenna is drawn a little thick.
 */
function radio() {
  const { block, box } = prim;
  return toGeometry([
    block(RADIO, { z: -0.31, top: 1.36, bot: 0.98, w: 0.28 }, { z: -0.165, top: 1.38, bot: 0.96, w: 0.3 }),
    box(DARK, [0.07, 1.395, -0.24], [0.05, 0.03, 0.05]),   // antenna base block
    box(DARK, [-0.06, 1.39, -0.25], [0.04, 0.02, 0.04]),   // knobs
    box(shade(RADIO, 0.75), [0, 1.17, -0.313], [0.2, 0.12, 0.01]), // front panel
    ...post(DARK, 0.07, -0.24, 1.41, 2.7, 0.007, { lean: [0.02, -0.12], segs: 5 }),
  ]);
}

/** Belt kit: two ammo pouches either side of the buckle, a canteen on the right hip. */
function belt() {
  const { box } = prim;
  return toGeometry([
    box(OLIVE, [0.085, 0.9, 0.17], [0.07, 0.075, 0.045]),
    box(OLIVE, [-0.085, 0.9, 0.17], [0.07, 0.075, 0.045]),
    box(shade(OLIVE, 0.8), [0.085, 0.935, 0.172], [0.074, 0.012, 0.05]), // pouch flaps
    box(shade(OLIVE, 0.8), [-0.085, 0.935, 0.172], [0.074, 0.012, 0.05]),
    ...post(OLIVE, -0.225, -0.02, 0.8, 0.935, 0.045, { segs: 8 }),        // canteen in its cover
    ...post(DARK, -0.225, -0.02, 0.935, 0.955, 0.018, { segs: 6 }),       // cap
  ]);
}

/** Map a part's vertices through fn([x, y, z]) → [x, y, z] (winding kept if fn keeps handedness). */
function mapPart(p, fn) {
  for (let i = 0; i < p.pos.length; i += 3) {
    const [x, y, z] = fn([p.pos[i], p.pos[i + 1], p.pos[i + 2]]);
    p.pos[i] = x; p.pos[i + 1] = y; p.pos[i + 2] = z;
  }
  return p;
}

// ── Extras: small character pieces, per soldier ────────────────────────────
// Placed from soldier1's MEASURED face at rest: eyes centred at x ±4.7 cm,
// 1.598 m high, surface z 14.1 cm (each 5.6 × 2.3 cm); nose tip z 18 cm at
// 1.56 m; mouth ~1.525 m (z ~15.5); face ±12.6 cm wide at the eyes; neck and
// collar 1.40–1.46 m, ±10–14 cm, z −8 … +17; chest front z 13–19 cm at
// 1.10–1.30 m.

/** A cylinder between two points (open ends), faces outward. */
function stick(color, from, to, r, segs = 6) {
  const a = new THREE.Vector3(...from), b = new THREE.Vector3(...to);
  const d = b.clone().sub(a).normalize();
  const u = new THREE.Vector3().crossVectors(d, Math.abs(d.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)).normalize();
  const w = new THREE.Vector3().crossVectors(u, d); // u × w = −d: the band() winding faces out
  const ring = (c) => Array.from({ length: segs }, (_, i) => {
    const t = (i / segs) * Math.PI * 2;
    return c.clone().addScaledVector(u, Math.cos(t) * r).addScaledVector(w, Math.sin(t) * r).toArray();
  });
  const A = ring(a), B = ring(b);
  const p = part(color);
  for (let i = 0; i < segs; i++) {
    const j = (i + 1) % segs;
    tri(p, A[i], B[i], B[j]);
    tri(p, A[i], B[j], A[j]);
  }
  return p;
}

/** A flat shape facing +Z at depth z (outline x, y counter-clockwise seen from the front). */
function plateZ(color, z, outline) {
  const p = part(color);
  const mid = outline.reduce((s, [x, y]) => [s[0] + x / outline.length, s[1] + y / outline.length], [0, 0]);
  for (let i = 0; i < outline.length; i++) {
    const [x0, y0] = outline[i], [x1, y1] = outline[(i + 1) % outline.length];
    tri(p, [mid[0], mid[1], z], [x0, y0, z], [x1, y1, z]);
  }
  return p;
}

/**
 * Aviator sunglasses: big teardrop lenses (~7 × 5 cm — these are big stylised
 * faces; the first ones were 4 × 3 cm and round), flat on top and dropping
 * lowest toward the nose, each turned back 16° at its outer edge so it follows
 * the face. Gold wire rim, double bridge, arms to the ears. The glass is a dark
 * green-grey with one light streak, so it reads as glass and not a black hole.
 */
function sunglasses() {
  const glass = 0x1c2825, gold = 0xb3955a, streak = 0x62726e;
  // The LEFT lens (outward = +x), counter-clockwise, centred on the eye.
  const outline = [
    [0.037, 0.016], [0.018, 0.019], [0, 0.018], [-0.018, 0.016], [-0.032, 0.011], [-0.036, 0],
    [-0.031, -0.014], [-0.02, -0.025], [-0.006, -0.031], [0.01, -0.029], [0.025, -0.019], [0.035, -0.005],
  ];
  const yaw = 0.28;
  const lens = (s) => {
    // local x runs outward (+x for the left lens, −x for the right); both
    // frames keep x-across × y-up pointing out of the face.
    const r = new THREE.Vector3(Math.cos(yaw), 0, -s * Math.sin(yaw));
    const u = new THREE.Vector3(0, 1, 0);
    const n = new THREE.Vector3().crossVectors(r, u);
    const c = new THREE.Vector3(s * 0.047, 1.595, 0.161);
    const at = (x, y, lift) => c.clone().addScaledVector(r, s * x).addScaledVector(u, y).addScaledVector(n, lift).toArray();
    const layer = (color, pts, lift) => {
      const q = (s > 0 ? pts : [...pts].reverse()).map(([x, y]) => at(x, y, lift));
      const mid = at(0, -0.004, lift);
      const p = part(color);
      for (let i = 0; i < q.length; i++) tri(p, mid, q[i], q[(i + 1) % q.length]);
      return p;
    };
    return {
      parts: [
        layer(gold, outline.map(([x, y]) => [x * 1.09, y * 1.1 - 0.0004]), 0),   // the wire rim, just larger
        layer(glass, outline, 0.0015),
        layer(streak, [[0.02, 0.011], [0.026, 0.008], [0.004, -0.018], [-0.002, -0.015]], 0.003),
      ],
      innerTop: at(-0.03, 0.013, 0.001), outerTop: at(0.037, 0.016, 0.001),
    };
  };
  const L = lens(1), R = lens(-1);
  return toGeometry([
    ...L.parts, ...R.parts,
    stick(gold, L.innerTop, R.innerTop, 0.0018, 4),                                   // top bar
    stick(gold, [0.016, 1.604, 0.171], [-0.016, 1.604, 0.171], 0.0018, 4),             // bridge over the nose
    stick(gold, L.outerTop, [0.129, 1.604, -0.005], 0.0019, 4),                         // arms, back to the ears
    stick(gold, R.outerTop, [-0.129, 1.604, -0.005], 0.0019, 4),
  ]);
}

/** A mustache: a dark bar on the upper lip, its ends drooping. */
function mustache() {
  return toGeometry(mustachePieces());
}

function mustachePieces() {
  const { block } = prim;
  const c = 0x2b1e15;
  // Full and bushy (the first read as two pencil lines).
  return [
    block(c, { z: 0.152, top: 1.556, bot: 1.537, w: 0.05 }, { z: 0.174, top: 1.553, bot: 1.539, w: 0.042 }),
    stick(c, [0.018, 1.545, 0.166], [0.036, 1.528, 0.157], 0.0075, 6),
    stick(c, [-0.018, 1.545, 0.166], [-0.036, 1.528, 0.157], 0.0075, 6),
  ];
}

/** A cigarette from the corner of the mouth, pointing forward and down, glowing tip. */
function cigarette() {
  return toGeometry([
    stick(0xe8e3d6, [-0.022, 1.525, 0.158], [-0.04, 1.51, 0.205], 0.0032, 5),
    stick(0xc4541f, [-0.04, 1.51, 0.205], [-0.0415, 1.509, 0.209], 0.0034, 5),
  ]);
}

/** Neck scarf (a sand chèche worn at the neck): a thick roll round the collar, a knot in front, two ends. */
function scarf() {
  const c = 0xb8a67c, d = shade(c, 0.82);
  // Hugging the collar (the first one bulged out to ±16 cm — a neck brace).
  return toGeometry([
    ...band(c, [
      { y: 1.4, rx: 0.122, rz: 0.118, zo: 0.045 },
      { y: 1.425, rx: 0.132, rz: 0.128, zo: 0.045 },
      { y: 1.45, rx: 0.114, rz: 0.108, zo: 0.04 },
    ], { segs: 12 }),
    prim.box(d, [0, 1.41, 0.178], [0.032, 0.026, 0.02]),                             // knot
    prim.block(d, { z: 0.172, top: 1.4, bot: 1.345, w: 0.03 }, { z: 0.184, top: 1.4, bot: 1.35, w: 0.024 }), // ends
  ]);
}

/** Two grenades hooked on the chest, either side. */
function grenades() {
  const c = 0x4a4a32, lever = 0x6b6b62;
  const one = (x) => [
    ...post(c, x, 0.205, 1.18, 1.235, 0.02, { segs: 7 }),
    stick(lever, [x + 0.012, 1.245, 0.21], [x + 0.016, 1.19, 0.222], 0.003, 4),
  ];
  return toGeometry([...one(0.1), ...one(-0.1)]);
}

/** The section leader's binoculars, hanging mid-chest on a neck strap. */
function binoculars() {
  const c = 0x1d1d1b;
  return toGeometry([
    ...post(c, 0.024, 0.215, 1.08, 1.17, 0.021, { segs: 7 }),
    ...post(c, -0.024, 0.215, 1.08, 1.17, 0.021, { segs: 7 }),
    prim.box(c, [0, 1.15, 0.215], [0.03, 0.02, 0.02]),                               // hinge
    stick(0x3a2a1c, [0.03, 1.17, 0.21], [0.07, 1.4, 0.13], 0.004, 4),                // strap
    stick(0x3a2a1c, [-0.03, 1.17, 0.21], [-0.07, 1.4, 0.13], 0.004, 4),
  ]);
}

// ── The COLONEL's pieces (the hero look, 2026-10-02) ───────────────────────
const GOLD = 0xc9a23a;

/**
 * His rank on the chest: the "patte de poitrine" of the camouflaged smock — a
 * dark tab with a colonel's five gold galons, over his left breast. The bars
 * stand 2 mm proud of the tab (never coplanar: no z-fighting).
 */
function rankTab() {
  const { box } = prim;
  const x = 0.085, y = 1.255, z = 0.19;
  return toGeometry([
    box(0x1e2a1e, [x, y, z], [0.045, 0.055, 0.006]),
    ...[0, 1, 2, 3, 4].map((i) => box(GOLD, [x, y - 0.019 + i * 0.0095, z + 0.004], [0.034, 0.0045, 0.003])),
  ]);
}

/** A leather map case on his left hip, its strap across the chest from the right shoulder. */
function mapCase() {
  const { box } = prim;
  return toGeometry([
    box(LEATHER, [0.205, 0.8, 0.02], [0.03, 0.24, 0.2]),
    box(shade(LEATHER, 0.8), [0.222, 0.87, 0.02], [0.006, 0.09, 0.2]),   // the flap, 2 mm out
    stick(shade(LEATHER, 0.85), [-0.12, 1.47, 0.06], [0.0, 1.24, 0.205], 0.007, 4),
    stick(shade(LEATHER, 0.85), [0.0, 1.24, 0.205], [0.2, 0.93, 0.08], 0.007, 4),
  ]);
}

/** A pistol holster on the right of the belt (the MAC 50). */
function holster() {
  const { box } = prim;
  return toGeometry([
    box(LEATHER, [-0.165, 0.85, 0.11], [0.05, 0.13, 0.06]),
    box(shade(LEATHER, 0.75), [-0.165, 0.915, 0.11], [0.054, 0.02, 0.064]),   // the flap
  ]);
}

/**
 * A full beard: a shell over the jaw and chin, open at the back (it stops
 * short of the ears), with a mustache on the upper lip. Face measured at
 * soldier1's heights (chin ~1.47 m, mouth ~1.525, nose tip 1.56).
 */
function beard() {
  // Tight to the jaw and brown-black (the first stood 3 cm off the cheeks in
  // near-black and read as a mask). The face is ±9.5 cm wide at 1.54 m.
  const c = 0x33261b;
  const arc = { from: -0.3, to: Math.PI + 0.3, segs: 12 };
  return toGeometry([
    ...band(c, [
      { y: 1.45, rx: 0.05, rz: 0.042, zo: 0.1 },
      { y: 1.47, rx: 0.084, rz: 0.074, zo: 0.084 },
      { y: 1.5, rx: 0.103, rz: 0.09, zo: 0.066 },
      { y: 1.528, rx: 0.106, rz: 0.094, zo: 0.058 },
      { y: 1.552, rx: 0.11, rz: 0.086, zo: 0.052 },
    ], arc),
    // under the chin: a cap built upright, then turned over (a 180° rotation
    // about x — a negative height would turn its faces inward)
    mapPart(dome(c, 0, 0.008, 0.05, 0.042, { segs: 12 }), ([x, y, z]) => [x, 1.45 - y, 0.1 - z]),
    ...mustachePieces(),
  ]);
}

/** A bandolier: a leather strap round the torso from the left shoulder to the right hip, brass cartridges in front. */
function bandolierPieces(side) {
  const leather = 0x5b422a, brass = 0xa8894a;
  const tilt = 0.78 * side; // dy per metre of x: up toward +x (left) for side +1
  const ring = (dy, grow) => ({ y: 1.17 + dy, rx: 0.228 + grow, rz: 0.195 + grow, zo: 0.018, tilt });
  const strap = [
    ...band(leather, [ring(0, 0), ring(0.05, 0)], { segs: 20 }),
    ...band(shade(leather, 0.7), [ring(0.05, -0.004), ring(0, -0.004)], { segs: 20 }), // inside face
  ];
  // cartridges: small boxes along the front of the strap
  const bullets = [];
  for (let k = -3; k <= 3; k++) {
    const a = Math.PI / 2 + k * 0.17;
    const x = Math.cos(a) * 0.235, z = 0.018 + Math.sin(a) * 0.202;
    bullets.push(prim.box(brass, [x, 1.195 + tilt * x, z], [0.012, 0.03, 0.012]));
  }
  return [...strap, ...bullets];
}
const bandolier = () => toGeometry(bandolierPieces(1));
const bandoliers = () => toGeometry([...bandolierPieces(1), ...bandolierPieces(-1)]);

/** A canvas shoulder bag (musette) on the left hip. */
function musette() {
  const { block } = prim;
  const c = 0x7a6b4c;
  return toGeometry([
    block(c, { z: -0.06, top: 0.95, bot: 0.8, w: 0.06, x: 0.215 }, { z: 0.12, top: 0.95, bot: 0.8, w: 0.07, x: 0.225 }),
    block(shade(c, 0.8), { z: -0.065, top: 0.955, bot: 0.9, w: 0.075, x: 0.225 }, { z: 0.125, top: 0.955, bot: 0.9, w: 0.08, x: 0.23 }), // flap
  ]);
}

/**
 * The FLN flag on a pole strapped to the back (the standard-bearer): green at
 * the hoist, white at the fly, the red crescent opening toward the fly with the
 * star inside it. ~55 × 37 cm, a baked ripple, both faces. Pole ~1.6 m up
 * from the pack, so it rides well above the squad.
 */
function flnFlag() {
  const green = 0x0b6b3a, white = 0xeeeee6, red = 0xc81d2c, wood = 0x6a4a2c;
  const pole = [-0.07, 0.98, -0.22], top = [-0.1, 2.62, -0.29];
  const L = 0.55, H = 0.37, cols = 8, y0 = 2.2;
  const at = (i, y) => { // i: 0 (at the pole) … cols (the fly end), −x away from the pole
    const t = i / cols;
    return [top[0] - t * L, y, top[2] + 0.035 * Math.sin(t * Math.PI * 2.2) * t];
  };
  const cloth = [];
  for (let i = 0; i < cols; i++) {
    const p = part(i < cols / 2 ? green : white);
    const a = at(i, y0), b = at(i + 1, y0), c = at(i + 1, y0 + H), d = at(i, y0 + H);
    tri(p, a, c, b); tri(p, a, d, c); // faces +z (x runs toward −x)
    tri(p, a, b, c); tri(p, a, c, d); // and −z
    cloth.push(p);
  }
  // crescent + star, on both faces, lifted 3 mm off the cloth at the middle
  const mid = at(cols / 2, y0 + H / 2);
  const emblem = (dz) => {
    const p = part(red);
    const c = [mid[0], mid[1], mid[2] + dz];
    const arcPt = (cx, r, a) => [c[0] + cx + Math.cos(a) * r, c[1] + Math.sin(a) * r, c[2]];
    const A0 = Math.PI + 0.9, A1 = Math.PI * 3 - 0.9, n = 12; // gap toward −x (the fly)
    for (let k = 0; k < n; k++) {
      const a = A0 + ((A1 - A0) * k) / n, b = A0 + ((A1 - A0) * (k + 1)) / n;
      const o0 = arcPt(0, 0.085, a), o1 = arcPt(0, 0.085, b);
      const i0 = arcPt(-0.026, 0.068, a), i1 = arcPt(-0.026, 0.068, b);
      // both windings: each emblem sits in front of its own face of the
      // cloth, so its back is hidden by the cloth anyway
      tri(p, o0, i0, i1); tri(p, o0, i1, o1); tri(p, o0, i1, i0); tri(p, o0, o1, i1);
    }
    const s = [c[0] - 0.05, c[1], c[2]];
    const star = Array.from({ length: 10 }, (_, k) => {
      const a = Math.PI / 2 + (k * Math.PI) / 5, r = k % 2 ? 0.011 : 0.028;
      return [s[0] + Math.cos(a) * r, s[1] + Math.sin(a) * r, s[2]];
    });
    for (let k = 0; k < 10; k++) {
      const q0 = star[k], q1 = star[(k + 1) % 10];
      tri(p, s, q1, q0); tri(p, s, q0, q1);
    }
    return p;
  };
  return toGeometry([
    stick(wood, pole, top, 0.012, 6),
    ...cloth,
    emblem(0.003), emblem(-0.003),
  ]);
}

/**
 * Kachabia: the long hooded wool cloak of the Algerian countryside (from
 * memory), here as an OPEN-FRONT cape from the shoulders to below the knees
 * with the hood down on the back — open in front so the arms can hold a rifle
 * without piercing it. The one SKINNED kit piece: above the hips it rides the
 * spine; below, it blends from the hips into each thigh by side (x), so the
 * back of the cape stretches between the legs instead of tearing.
 */
function kachabia() {
  // Brown wool, lighter than it would be in the lab: under the game's
  // exposure and ACES the lab's 0x5d4633 read near-black (2026-09-30).
  const c = 0x7d6147, inner = 0x574330;
  const rings = [
    { y: 0.5, rx: 0.32, rz: 0.28, zo: -0.01 },
    { y: 0.95, rx: 0.275, rz: 0.235, zo: 0.0 },
    { y: 1.2, rx: 0.262, rz: 0.222, zo: 0.005 },
    { y: 1.37, rx: 0.245, rz: 0.2, zo: 0.0 },
    { y: 1.46, rx: 0.12, rz: 0.11, zo: 0.0 },
  ];
  const arc = { from: Math.PI / 2 + 0.6, to: Math.PI * 2.5 - 0.6, segs: 18 };
  const hoodArc = { from: Math.PI * 1.5 - 0.7, to: Math.PI * 1.5 + 0.7, segs: 6 };
  const hood = [
    { y: 1.2, rx: 0.06, rz: 0.22, zo: -0.02 },
    { y: 1.32, rx: 0.14, rz: 0.19, zo: -0.02 },
    { y: 1.45, rx: 0.135, rz: 0.14, zo: -0.02 },
  ];
  return toGeometry([
    ...band(c, rings, arc),
    ...band(inner, [...rings].reverse().map((r) => ({ ...r, rx: r.rx - 0.004, rz: r.rz - 0.004 })), arc), // inside
    ...band(shade(c, 0.92), hood, hoodArc),
    ...band(inner, [...hood].reverse().map((r) => ({ ...r, rx: r.rx - 0.004, rz: r.rz - 0.004 })), hoodArc),
  ]);
}

/** Skin weights for the kachabia at a rest-pose point (metres): [[bone, weight], …]. */
function kachabiaWeights(p) {
  const s = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  if (p.y >= 1.25) return [["Spine2", 1]];
  if (p.y >= 1.05) { const t = s(1.05, 1.25, p.y); return [["Spine2", t], ["Spine1", 1 - t]]; }
  if (p.y >= 0.92) { const t = s(0.92, 1.05, p.y); return [["Spine1", t], ["Hips", 1 - t]]; }
  // below the hips: into the thighs, left (+x) / right by side, softly across the middle
  const legs = s(0.92, 0.62, p.y), left = s(-0.1, 0.1, p.x);
  return [["Hips", 1 - legs], ["LeftUpLeg", legs * left], ["RightUpLeg", legs * (1 - left)]];
}

/** Kit pieces and the bone each rides on. */
export const KIT = {
  pack: { bone: "Spine2", build: pack },
  radio: { bone: "Spine2", build: radio },
  belt: { bone: "Hips", build: belt },
  sunglasses: { bone: "Head", build: sunglasses },
  mustache: { bone: "Head", build: mustache },
  cigarette: { bone: "Head", build: cigarette },
  scarf: { bone: "Neck", build: scarf },
  grenades: { bone: "Spine2", build: grenades },
  binoculars: { bone: "Spine2", build: binoculars },
  rankTab: { bone: "Spine2", build: rankTab },
  mapCase: { bone: "Hips", build: mapCase },
  holster: { bone: "Hips", build: holster },
  beard: { bone: "Head", build: beard },
  bandolier: { bone: "Spine2", build: bandolier },
  bandoliers: { bone: "Spine2", build: bandoliers },
  musette: { bone: "Hips", build: musette },
  flag: { bone: "Spine2", build: flnFlag },
  // skinned: built at rest in metres, weighted per vertex by `weights`
  kachabia: { skinned: true, build: kachabia, weights: kachabiaWeights },
};

/** The per-soldier extras a look can roll (look.extras = { name: chance }). */
export const EXTRAS = ["sunglasses", "mustache", "cigarette", "scarf", "grenades", "beard", "bandolier", "bandoliers", "kachabia"];

/**
 * What soldier `index` of a squad wears and carries.
 *   - a variant of the look (headgear mix), by `rnd(1)`
 *   - the look's kit, then its ROLE for this index (look.roles[index]: the
 *     leader's MAT 49 + binoculars, the radioman, the LMG gunner) — a role's
 *     `drop` removes kit (the radioman leaves his pack)
 *   - each extra rolled against its chance (`rnd(10 + k)`), or all of them
 *     when `showAll` (the lab's inspect switch)
 * `rnd(salt)` → a stable random in [0, 1) for this soldier.
 */
export function loadout(base, index, rnd, showAll = false) {
  const look = pickVariant(base, rnd(1));
  const kit = new Set(look.kit ?? []);
  let weapon = look.weapon;
  const role = base.roles?.[index];
  // A mixed armoury (the ALN): each man draws his rifle from look.weaponMix.
  if (base.weaponMix && !role?.weapon) {
    const mix = Object.entries(base.weaponMix);
    let t = rnd(30) * mix.reduce((s, [, w]) => s + w, 0);
    for (const [key, w] of mix) { t -= w; if (t < 0) { weapon = key; break; } }
  }
  if (role) {
    if (role.weapon) weapon = role.weapon;
    for (const k of role.drop ?? []) kit.delete(k);
    for (const k of role.kit ?? []) kit.add(k);
  }
  EXTRAS.forEach((name, k) => {
    const chance = base.extras?.[name] ?? 0;
    if (showAll || rnd(10 + k) < chance) kit.add(name);
  });
  // Pieces that would overlap (and z-fight): the beard has its own mustache;
  // two bandoliers include the single one.
  if (kit.has("beard")) kit.delete("mustache");
  if (kit.has("bandoliers")) kit.delete("bandolier");
  return { look, kit: [...kit], weapon, role: role?.name ?? null };
}

/**
 * The headgear material for `look`: colour per vertex, matte cloth. A
 * camouflaged look's caps take the smock's léopard pattern (camoNode, in the
 * hat's own metres) times their vertex shade.
 */
export function headgearMaterial(look = {}) {
  const m = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.9, metalness: 0, name: "headgear" });
  if (look.camo && CAMO_HEADGEAR.has(look.headgear)) {
    m.colorNode = camoNode(positionGeometry, look.camo).mul(attribute("color", "vec3"));
  }
  return m;
}
const CAMO_HEADGEAR = new Set(["bigeard"]);
