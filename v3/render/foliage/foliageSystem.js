/**
 * Painted foliage — ferns and other ground plants, placed and culled on the
 * GPU, drawn as real geometry.
 *
 * All the placement machinery (wrap tile, one compute pass, indirect draws, one
 * per type × detail level, wind and player push) is the shared scatter field:
 * v3/render/scatter/scatterField.js. This file is only what a fern IS — its
 * per-type uniform rows, its geometry, and how it is shaded.
 *
 * Per type, 4 uniform rows:
 *   0 (colorBase.rgb, translucency)
 *   1 (colorTip.rgb, size in metres)
 *   2 (heightMin, heightMax, paint layer or -1, river distance m or 0) — the rules
 *   3 (colorHead.rgb, local height) — a cattail's sausage or a reed's plume,
 *     plus the type's unscaled height, which the bend needs (see positionNode)
 */
import * as THREE from "three";
import {
  Discard, Fn, abs, attribute, cameraPosition, cameraViewMatrix, cos, cross, dot, exp, faceDirection, float,
  floor, fract, fwidth, hash, instanceIndex, length, max, min, mix, normalLocal, normalize, pow, positionLocal, saturate,
  select, sin, smoothstep, step, texture, time, uniform, uv, varying, vec2, vec3, vec4, PI2, mx_noise_float,
} from "three/tsl";
import { drawPlumeTexture, PLUME_TEX_W, PLUME_TEX_H } from "./plumeTexture.js";
import { drawBambooSprayTexture, SPRAY_TEX_W, SPRAY_TEX_H } from "./bambooSprayTexture.js";
import { drawPalmFrondTexture, FROND_TEX_W, FROND_TEX_H } from "./palmFrondTexture.js";
import { drawFernFrondTexture, FERN_TEX_W, FERN_TEX_H } from "./fernFrondTexture.js";
import { drawBananaLeafTexture, drawTaroLeafTexture, BROADLEAF_TEX_W, BROADLEAF_TEX_H } from "./broadleafTextures.js";
import { drawCanopyClusterTexture, CANOPY_TEX_W, CANOPY_TEX_H } from "./canopyClusterTexture.js";
import { drawFanLeafTexture, FAN_TEX_W, FAN_TEX_H } from "./fanLeafTexture.js";
import { drawLanceLeafTexture, LANCE_TEX_W, LANCE_TEX_H } from "./lanceLeafTexture.js";
import { drawBanyanLeafTexture, BANYAN_TEX_W, BANYAN_TEX_H } from "./banyanLeafTexture.js";
import { drawCedarNeedleTexture, NEEDLE_TEX_W, NEEDLE_TEX_H } from "./cedarNeedleTexture.js";
import { drawLeafSprayCard, loadLeafSprayMasks, LEAF_SPRAY_MASKS, LEAF_SPRAY_TEX } from "./leafSprayCard.js";
import { bakeObjectThumbnails } from "../../../v2/tools/objectThumbnails.js";
import { ScatterField } from "../scatter/scatterField.js";
import { createFoliageTypeGeometry, FOLIAGE_LODS, cardTextureOf } from "./foliageGeometry.js";
import { foliageLeafLift, foliageTopdownLift } from "./foliageLighting.js";
import { coverageMippedTexture } from "./alphaCoverageMips.js";
import { FOLIAGE_TYPE_COUNT } from "../../app/state/foliageScatterState.js";
import { terrainShade, terrainSunVisibilityHere } from "../lighting/terrainSunShadow.js";

const ROWS = 4;
const RULE_ROW = 2;

/**
 * How much of a leaf's canopy normal-lift survives when the camera is looking
 * straight down at it (1 = the lift a ground camera gets, 0 = the leaf's true
 * normal). See the long note beside `liftToUp`: the lift cures a ground
 * camera's two-tone and causes a top-down camera's flatness, so it is scaled
 * by the camera's elevation rather than chosen once.
 *
 * Both this and the base lift are uniforms rather than constants because they
 * are the two ends of that trade, and it is judged by eye in the game at the
 * camera it is for. It now defaults to 1 — no relax at all — because at 0.45
 * the plants grew BLACK FACES from the RTS camera; foliageLighting.js has the
 * measurements and what the flatter crowns cost.
 */
const FOLIAGE_TOPDOWN_LIFT = foliageTopdownLift;
/**
 * 1 = the canopy-tree leaf cards (dipterocarp builder, part 5.35: alg-rts's
 * tamarisk tree, nam-rts's dipterocarps) keep their baked dome normal with no
 * flip to the viewer — the light stops following the camera. 0 = the old
 * flip. A switch for the Plant Lab's before / after (2026-10-02).
 */
export const FOLIAGE_DOME_CARDS = uniform(1);
/** The foliage's shadow lookup offset, metres: x along the normal, y toward the sun (see createFoliageMaterial). */
export const FOLIAGE_SHADOW_OFFSET = uniform(new THREE.Vector2(0.2, 3));

/**
 * THE CARD TEXTURES — one canvas-drawn alpha per `cardTextureOf` key. Geometry
 * cannot afford strand, spray or lace detail; a texture can, and a card of it
 * sways as one thing. Each is drawn white; colour is the shader's.
 */
const CARD_TEXTURES = {
  plume: {
    w: PLUME_TEX_W, h: PLUME_TEX_H,
    draw: (c) => drawPlumeTexture(c, { texSpread: 54, texStrands: 420, texStrandLen: 0.34, texDroop: 0.6 }),
  },
  spray: { w: SPRAY_TEX_W, h: SPRAY_TEX_H, draw: drawBambooSprayTexture, shade: true },
  frond: { w: FROND_TEX_W, h: FROND_TEX_H, draw: drawPalmFrondTexture, shade: true },
  fern:  { w: FERN_TEX_W,  h: FERN_TEX_H,  draw: drawFernFrondTexture, shade: true },
  banana: { w: BROADLEAF_TEX_W, h: BROADLEAF_TEX_H, draw: drawBananaLeafTexture, shade: true },
  taro:   { w: BROADLEAF_TEX_W, h: BROADLEAF_TEX_H, draw: drawTaroLeafTexture },
  canopy: { w: CANOPY_TEX_W, h: CANOPY_TEX_H, draw: drawCanopyClusterTexture },
  fan:    { w: FAN_TEX_W, h: FAN_TEX_H, draw: drawFanLeafTexture, shade: true },
  lance:  { w: LANCE_TEX_W, h: LANCE_TEX_H, draw: drawLanceLeafTexture, shade: true },
  // `shade: true`: the card's grey is a per-leaf SHADE multiplied into its
  // colour (see alphaCoverageMips) — a leaf cluster is leaves, a fan is
  // pleated, a frond is a thousand blades, not one flat green (2026-09-24).
  banyan: { w: BANYAN_TEX_W, h: BANYAN_TEX_H, draw: drawBanyanLeafTexture, shade: true },
  // The Atlas cedar's flat mats of needle rosettes (Algeria, 2026-09-26).
  needle: { w: NEEDLE_TEX_W, h: NEEDLE_TEX_H, draw: drawCedarNeedleTexture, shade: true },
  // The canopy tree's crown: sprays of REAL leaves from the arborist's masks,
  // sky between the leaves (leafSprayCard.js; your call 2026-09-25, "look way
  // better"). The masks are PNGs, so the banyan card stands in until they
  // load and the texture is redrawn in place.
  leafSpray: {
    w: LEAF_SPRAY_TEX, h: LEAF_SPRAY_TEX, draw: drawBanyanLeafTexture, shade: true,
    masks: LEAF_SPRAY_MASKS,
    drawMasks: (c, masks) => drawLeafSprayCard(c, masks, { sprays: 4, scale: 0.52 }),
  },
  // The betoum's leaf CLUSTERS (tools/makeBetoumLeaves.py, 2026-10-02): four
  // twigs of compound leaves built from CC0 leaf photos, a 2x2 atlas — rgb a
  // per-leaf shade, alpha the leaves. An IMAGE: the banyan card stands in
  // until it loads.
  betoumLeaf: {
    w: 1024, h: 1024, draw: drawBanyanLeafTexture, shade: true,
    image: "/textures/leaves/betoum_clusters.png",
  },
};

/** Mask images, loaded once per set and shared by every card that uses them. */
const _maskLoads = new Map();

/**
 * Draw one card texture. `anisotropy` for the live field; thumbnails go without.
 *
 * The mip chain is built on the CPU with COVERAGE PRESERVED (see
 * alphaCoverageMips.js), not by the GPU: these are alpha-TESTED cards, and a
 * plain averaged mip drops thin shapes under the threshold, so a spray, a
 * frond or a leaf cluster thins out and finally dissolves as the camera pulls
 * back. Every card plant on the map goes through here.
 */
export function makeCardTexture(key, anisotropy = 0) {
  const spec = CARD_TEXTURES[key];
  const canvas = document.createElement("canvas");
  canvas.width = spec.w; canvas.height = spec.h;
  // Its pixels are read back once to build the coverage mips: say so BEFORE
  // the painter takes a context (a canvas keeps the first one it gives out),
  // or Chrome warns "Multiple readback operations… willReadFrequently".
  canvas.getContext("2d", { willReadFrequently: true });
  spec.draw(canvas);
  const opts = { threshold: 0.4, anisotropy, shade: spec.shade === true };
  const tex = coverageMippedTexture(canvas, opts);
  if (spec.image) {
    // An image card: drawn into the same canvas once loaded, then the same
    // coverage mips, into the SAME texture (no material rebuild).
    const img = new Image();
    img.onload = () => {
      const g = canvas.getContext("2d");
      g.clearRect(0, 0, canvas.width, canvas.height);
      g.drawImage(img, 0, 0, canvas.width, canvas.height);
      const next = coverageMippedTexture(canvas, opts);
      tex.image = next.image;
      tex.mipmaps = next.mipmaps;
      tex.needsUpdate = true;
    };
    img.src = spec.image;
  }
  if (spec.masks) {
    // Redraw from the masks once they are in, into the SAME texture — every
    // material built on it picks the new pixels up with no rebuild.
    const key = spec.masks.join("|");
    if (!_maskLoads.has(key)) _maskLoads.set(key, loadLeafSprayMasks(spec.masks));
    _maskLoads.get(key).then((masks) => {
      if (!masks.length) return;                     // keep the stand-in
      spec.drawMasks(canvas, masks);
      const next = coverageMippedTexture(canvas, opts);
      tex.image = next.image;
      tex.mipmaps = next.mipmaps;
      tex.needsUpdate = true;
    });
  }
  return tex;
}

/**
 * The thumbnails' own copies, made on first use, so a picture can be baked
 * before any foliage system exists.
 */
const _thumbCardTex = new Map();
function thumbCardTexture(key) {
  if (!_thumbCardTex.has(key)) _thumbCardTex.set(key, makeCardTexture(key));
  return _thumbCardTex.get(key);
}

/**
 * A PNG of one plant for the Vegetation picker. The live material is instanced
 * and reads the scatter buffers, so the thumbnail builds its own plain mesh:
 * the same geometry, its colours baked per vertex from the type, and the head
 * split into its own group so a textured plume keeps its alpha.
 *
 * Needs only a renderer — NOT a built foliage field — so the picker shows real
 * pictures the first time Vegetation opens, whichever plant kind it opens on.
 * @returns {Promise<string|null>} data URL
 */
export async function bakeFoliageThumbnail(type, { renderer, size = 128, runRendererSideWork = null } = {}) {
  const { geometry } = createFoliageTypeGeometry(type, { lod: 0 });
  const aPlant = geometry.getAttribute("aPlant");
  const count = aPlant.count;
  // Billboard cards (part 6) keep all four corners at their centre and are
  // spread by the live vertex stage. Spread them here once, facing +Z (the
  // thumbnail camera's side), or the picture would show a bare trunk.
  {
    const pos = geometry.getAttribute("position"), uvA = geometry.getAttribute("uv");
    for (let i = 0; i < count; i++) {
      if (aPlant.getX(i) <= 5.99) continue;
      const s = aPlant.getW(i);
      pos.setXY(i, pos.getX(i) + (uvA.getX(i) * 2 - 1) * s, pos.getY(i) + (uvA.getY(i) * 2 - 1) * s);
    }
  }

  const c = new THREE.Color();
  const base = new THREE.Color(type.colorBase ?? "#3f6f26");
  const tip = new THREE.Color(type.colorTip ?? "#8fbf45");
  const head = new THREE.Color(type.colorHead ?? type.colorTip ?? "#8fbf45");
  const stalk = new THREE.Color().copy(tip).lerp(new THREE.Color(0.72, 0.8, 0.4), 0.5);
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const part = aPlant.getX(i), t = aPlant.getY(i), along = aPlant.getW(i);
    // Part 3 is a bamboo culm: `along` is the signed distance to the nearest
    // node (bambooGeometry.js), so the scar and the waxy bloom survive into
    // the picker's thumbnail as a coarse version of the live shader's bands.
    if (part > 2.5 && part < 3.5) {
      const ad = Math.abs(along);
      const scar = ad < 0.09 ? (1 - ad / 0.09) * 0.34 : 0;
      const bloom = along > 0.03 && along < 0.36 ? 0.26 : 0;
      c.copy(head).multiplyScalar((0.82 + t * 0.36) * (1 - scar + bloom));
    } else if (part > 1.5) c.copy(head).multiplyScalar(0.85 + Math.min(along, 1) * 0.3);   // a cactus pad's `along` is 2 + age
    else if (part > 0.5) c.copy(stalk);
    // Part 0 is a leaf, parts 4 and 5 are leaf CARDS (alpha-tested spray or
    // frond): same colour. A dead frond (rand ≥ 2) is brown.
    else if (aPlant.getZ(i) >= 2.9) c.copy(base);      // fruit, buds, capsules
    else if (aPlant.getZ(i) >= 1.5) c.setRGB(0.62, 0.42, 0.17);
    else c.copy(base).lerp(tip, Math.min(1, t * 0.65 + along * 0.35));
    colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));

  // Textured triangles last, so they can carry their alpha on their own: a
  // plume head (part 2) or a bamboo spray card (part 4). A culm (part 3) is
  // solid geometry and must stay in the body group, or an alpha-mapped
  // material would eat it.
  const idx = Array.from(geometry.index.array);
  const bodyTris = [], headTris = [];
  for (let i = 0; i < idx.length; i += 3) {
    const pv = aPlant.getX(idx[i]);
    ((pv > 1.5 && pv < 2.5) || pv > 3.5 ? headTris : bodyTris).push(idx[i], idx[i + 1], idx[i + 2]);
  }
  geometry.setIndex([...bodyTris, ...headTris]);
  geometry.clearGroups();

  const opts = { vertexColors: true, side: THREE.DoubleSide, roughness: 0.9, metalness: 0 };
  const body = new THREE.MeshStandardMaterial(opts);
  // A plant with no head (a fern) gets no second group: an empty draw is a
  // WebGPU warning, not a no-op.
  const cardKey = cardTextureOf(type.kind);
  const cardTex = cardKey ? thumbCardTexture(cardKey) : null;
  const headMat = headTris.length
    ? new THREE.MeshStandardMaterial(
      cardTex ? { ...opts, alphaMap: cardTex, alphaTest: 0.4, transparent: false } : opts,
    )
    : null;
  // …and a plant that is ALL head (every triangle a card) gets no empty
  // FIRST group either: that was the "Draw with an index count of 0"
  // warning when the editor loaded a map (2026-09-29). One material then.
  const both = headMat && bodyTris.length;
  if (both) {
    geometry.addGroup(0, bodyTris.length, 0);
    geometry.addGroup(bodyTris.length, headTris.length, 1);
  }
  const mesh = new THREE.Mesh(geometry, both ? [body, headMat] : headMat ?? body);
  const run = () => bakeObjectThumbnails({ renderer, size, items: [{ key: "p", make: () => mesh }] });
  try {
    const out = await (runRendererSideWork ? runRendererSideWork(run) : run());
    return out.get("p") ?? null;
  } finally {
    geometry.dispose();
    body.dispose();
    headMat?.dispose();
  }
}

/**
 * THE FOLIAGE MATERIAL — how every plant in the scatter fields is shaded, and
 * now also the plants a place puts down by hand (placedFoliage.js). It knows
 * nothing about where a plant came from; `src` answers that:
 *
 *   plantAt()        inside the vertex stage: { plant, p, d, yaw?, scale? }
 *                      plant  a per-plant id node (hashed for variety)
 *                      p      vec4(x, z, type, groundY), world-relative
 *                      d      vec4(bendX, bendZ, fade 0..1, grass lift)
 *                      yaw    optional heading (radians); else hashed
 *                      scale  optional size multiplier; else 1
 *                      leanJitter  a random resting lean, radians (0.1; a
 *                             planted tree wants 0 — see placedFoliage.js)
 *   rowOf(t, r)      the type's uniform row r (see ROWS in the header)
 *   sizeVar, colorVar, anchorPos   uniforms
 *   thinScale(plant) 0..1 size for zoom thinning
 *   viewPos          optional uniform: the MAIN camera, for billboard cards
 *                    (else `cameraPosition`, which in the shadow pass is the sun)
 *
 * `u` is the shading uniforms (uFlutter, uGlowLight, uTransMul, uSunDir) and
 * `headTex` the card texture, or null for a plant with no alpha cards.
 * Matte: a fern has no highlights to speak of, and a specular term on a
 * saturated green reads as plastic.
 */
export function createFoliageMaterial({ src, u, headTex = null }) {
  const mat = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide, roughness: 0.92, metalness: 0 });
  mat.envMapIntensity = 0.35;

  const vPart = varying(float(0), "v_fo_part");
  const vAlong = varying(float(0), "v_fo_along");
  const vHeight = varying(float(0), "v_fo_height");
  const vType = varying(float(0), "v_fo_type");
  const vRand = varying(float(0), "v_fo_rand");
  const vPlant = varying(float(0), "v_fo_plant");
  const vWorld = varying(vec3(0), "v_fo_world");
  const vNormal = varying(vec3(0, 1, 0), "v_fo_normal");
  const vAO = varying(float(1), "v_fo_ao");
  const vMacro = varying(float(0), "v_fo_macro");

  const row = src.rowOf;

  /** Rotate v so +Y leans toward (bx, bz) by angle a. */
  const tilt = (v, a, bx, bz) => {
    const along = v.x.mul(bx).add(v.z.mul(bz));
    const ca = cos(a), sa = sin(a);
    const shift = along.mul(ca).add(v.y.mul(sa)).sub(along);
    return vec3(v.x.add(bx.mul(shift)), along.negate().mul(sa).add(v.y.mul(ca)), v.z.add(bz.mul(shift)));
  };
  const yawRot = (v, c, s) => vec3(v.x.mul(c).sub(v.z.mul(s)), v.y, v.x.mul(s).add(v.z.mul(c)));

  mat.positionNode = Fn(() => {
    const { plant, p, d, yaw: srcYaw = null, scale: srcScale = null, leanJitter = 0.1 } = src.plantAt();
    const a = attribute("aPlant", "vec4");
    const part = a.x, t = a.y, along = a.w;

    const fade = mix(float(0.35), float(1), d.z);
    const size = row(p.z, 1).w
      .mul(mix(float(1).sub(src.sizeVar), float(1).add(src.sizeVar), hash(plant.add(577))))
      .mul(fade)
      // Zoom thinning: shrink away rather than pop (ScatterField.thinScale).
      .mul(src.thinScale(plant))
      .mul(srcScale ?? float(1));

    const mag = length(vec2(d.x, d.y));
    const inv = float(1).div(max(mag, 1e-4));
    const bx = d.x.mul(inv), bz = d.y.mul(inv);
    // A fern is springier than a flower stem: it leans further for the same wind.
    // CAPPED. Wind and the player's push arrive as one bend vector, and a
    // plant standing next to the player used to take the whole push: at
    // strength 1.2 that is 86 deg, which reads as the plant STRETCHING
    // across the view rather than bowing. A plant bows to 35 deg and no
    // further, however hard the wind blows or how close you stand.
    const lean = min(mag.mul(1.25), float(0.6)).add(hash(plant.add(313)).mul(leanJitter));

    // A placed plant carries its own heading; a scattered one takes a hash.
    const yaw = srcYaw ?? hash(plant.add(131)).mul(PI2);
    const cy = cos(yaw), sy = sin(yaw);

    // Leaflets flutter across their own width; the rachis only bends. A
    // spray CARD (part 4) flutters as one thing — `along` runs up the card
    // and `a.z` is per card, so the whole fan moves on its own phase.
    const isLeaf = part.lessThan(0.5).or(part.greaterThan(3.5));
    // A BILLBOARD CARD (part 6 + lift, the banyan's leaf clumps): all four
    // corners sit at the card's CENTRE and are spread out below, facing the
    // camera — `along` carries the card's half-size instead of a flutter
    // weight, and `uv` says which corner. See billboardOffset.
    const isBB = part.greaterThan(5.99);
    // FLUTTER (2026-10-02, you: "the alfa's movement with the wind looks very
    // off, going up and down"): it was 6 cm × size STRAIGHT UP for every leaf
    // — a tuft of long blades bobbed and boiled; along the leaf's normal was
    // still mostly up on an arching blade. Now a small SIDEWAYS swish: round
    // the plant's axis (the horizontal at right angles to the leaf's way out
    // of the crown), a third of the old size, each leaf at its own rate. The
    // plant's BOW to the wind (below) is what reads as wind; this is detail.
    const flutterRate = float(3.1).add(fract(a.z.mul(7.13)).mul(2.2));
    const flutter = sin(time.mul(flutterRate).add(a.z.mul(29)).add(hash(plant).mul(13)))
      .mul(u.uFlutter).mul(0.02).mul(along).mul(select(isLeaf.and(isBB.not()).and(a.z.lessThan(2.9)), float(1), float(0)));   // fruit (rand ≥ 3) carries ripeness in `along`: still
    const radial = vec2(positionLocal.x, positionLocal.z);
    const swish = vec3(radial.y.negate(), 0, radial.x).div(max(length(radial), 0.02));

    const nLocal = yawRot(normalLocal, cy, sy);
    const local = yawRot(positionLocal.mul(size).add(swish.mul(flutter.mul(size))), cy, sy);
    // Stiff at the base, loose at the top: the angle grows with a vertex's
    // HEIGHT on the plant.
    //
    // It used to grow with `t` — how far along its own frond or plume a
    // vertex sits — which is not the same thing at all: a plume's root sat
    // at t = 0 and its tip at t = 1, so the root stayed put while the tip
    // swung, and the head SHEARED into streaks instead of tilting. Every
    // vertex at one height now turns by one angle, so a head rides the stalk
    // rigidly and only the stalk bends.
    const hFrac = saturate(positionLocal.y.div(max(row(p.z, 3).w, float(0.01))));
    const bendAngle = lean.mul(pow(max(hFrac, 1e-4), 1.4));
    const pos = tilt(local, bendAngle, bx, bz);
    const nrm = tilt(nLocal, bendAngle, bx, bz);

    vPart.assign(part);
    // A billboard's `along` is its size, not a place on a frond: hand the
    // colour ramp a neutral value instead.
    vAlong.assign(select(isBB, float(0.3), along));
    vHeight.assign(t);
    vType.assign(p.z);
    vRand.assign(a.z);
    vPlant.assign(hash(plant.add(3197)));
    vNormal.assign(nrm);
    // The plant's own AMBIENT OCCLUSION rides in the normal's length
    // (foliageGeometry bakeSelfOcclusion; 1 = open, for every kind without it).
    vAO.assign(length(normalLocal).clamp(0, 1));
    // MACRO VARIATION: a dry ↔ lush field across the world (~40 m and ~12 m
    // blobs), read once per plant at its root — from an RTS camera this is
    // the variation the eye reads; leaf-by-leaf jitter disappears.
    vMacro.assign(mx_noise_float(vec3(p.x.mul(0.025), p.y.mul(0.025), 7.3)).add(mx_noise_float(vec3(p.x.mul(0.08), p.y.mul(0.08), 2.1)).mul(0.4)));
    // Sits on the ground, lifted by the grass it grows in.
    const base = vec3(pos.x.add(p.x), pos.y.add(p.w).add(d.w.mul(0.5)), pos.z.add(p.y));
    // BILLBOARD: spread the corner out from the centre in the plane facing the
    // camera (your arborist page's leaf cards, 2026-09-24). The card turns;
    // its LIGHTING does not — the normal stays the baked dome normal, so a
    // crown shades as one rounded mass whichever way its cards face, and
    // nothing swims as the camera moves. A roll per card (`rand`, 0.5 = none)
    // breaks the "every card the same way up" tell. They face the PLAYER'S
    // camera in every pass (`src.viewPos`), shadows included: in the shadow
    // pass `cameraPosition` is the SUN, and cards turned to it crossed their
    // camera-facing twins along a straight line — half of every card sat in
    // its own shadow, and the crown was striped with hard horizontal cuts.
    const centreW = base.add(vec3(src.anchorPos.x, 0, src.anchorPos.z));
    const toCam = normalize((src.viewPos ?? cameraPosition).sub(centreW));
    // NaN-safe basis: when the camera looks straight down, cross with X.
    const cA = cross(vec3(0, 1, 0), toCam);
    const cB = cross(vec3(-1, 0, 0), toCam);
    const bbRight = normalize(mix(cA, cB, step(float(0.99), abs(toCam.y))));
    const bbUp = normalize(cross(toCam, bbRight));
    // `rand` 0.5 is upright; the banyan keeps its cards within a few tenths of
    // a radian, because its texture is lit from the top.
    const roll = a.z.sub(0.5).mul(PI2);
    const rR = bbRight.mul(cos(roll)).add(bbUp.mul(sin(roll)));
    const rU = bbUp.mul(cos(roll)).sub(bbRight.mul(sin(roll)));
    const corner = uv().mul(2).sub(1);
    // …and pushed TOWARD the camera by most of its half-size. A flat quad
    // turned to face you slices into whatever is behind it — the crown's
    // solid core, its neighbours — along a hard straight line; lifted
    // forward it overlaps them instead, which is all a leaf clump should do.
    const bbOffset = rR.mul(corner.x).add(rU.mul(corner.y)).add(toCam.mul(0.7)).mul(along.mul(size));
    const out = base.add(select(isBB, bbOffset, vec3(0)));
    vWorld.assign(out.add(vec3(src.anchorPos.x, 0, src.anchorPos.z)));
    return out;
  })();

  // Leaflets are lit "from above" like foliage in games: their normal is bent
  // halfway to UP and never flipped for back faces, so a frond reads bright
  // from any side instead of going near black underneath. Stems keep theirs.
  // Bent most of the way to UP: a leaflet whose true normal tilts away from
  // the sun would otherwise go black next to a lit neighbour, a hard
  // two-tone no real fern shows.
  const nW = normalize(vNormal);

  /*
   * HOW FAR TOWARD UP — AND WHY THE CAMERA GETS A VOTE.
   *
   * Every lift below is a CANOPY approximation. It exists so a leaflet whose
   * true normal tilts away from the sun does not go black beside a lit
   * neighbour, which is the failure a camera STANDING IN THE FIELD sees.
   *
   * From an RTS camera looking DOWN it causes the opposite failure. Bending
   * the normals toward up puts nearly all of them within ~45 degrees of the
   * view direction, so every leaf takes the same light: the field goes flat
   * and reads too bright, and a plant loses the form its geometry has. A
   * banana shows it worst — a big flat card has the least geometric normal
   * left to survive the bend.
   *
   * So the lift RELAXES as the camera climbs, by the same rule revo grass
   * uses for faceCamera: the camera's own ELEVATION OVER THIS PLANT decides
   * it. A camera in the field is untouched whatever the value, so there is
   * no "is this an RTS camera" mode to keep in sync. sin(elevation) is just
   * the y of the direction to the camera, so no trigonometry is needed.
   *
   * It relaxes rather than switching off: at zero lift the two-tone the lift
   * was added to cure comes straight back, so from overhead a leaf keeps
   * FOLIAGE_TOPDOWN_LIFT of its canopy bend and gets the rest of its normal
   * back.
   */
  const _camUpW = cameraPosition.sub(vWorld).normalize().y;
  // 10 degrees -> 40 degrees, the gate revo grass uses: the blades (here,
  // leaves) under a walking camera have a high elevation too, and relaxing
  // those would read as the plant flinching away from you.
  const _overhead = smoothstep(float(0.17), float(0.64), _camUpW);
  const _liftScale = mix(float(1), FOLIAGE_TOPDOWN_LIFT, _overhead);
  const liftToUp = (n, amount) => normalize(mix(n, vec3(0, 1, 0), float(amount).mul(_liftScale)));
  // (Almost all the way: game ferns are lit as a flat canopy; what little
  // geometric normal remains keeps the fronds from looking like paper.)
  // 0.55, not 0.95: the geometry now carries a ROUNDED normal per leaf
  // (foliageGeometry roundLeafNormals — see its header for the low-sun
  // diagnosis), so the shader only has to soften it, not replace it. At
  // 0.95 no leaf ever faced a low sun and the whole field went black.
  const nLeaf = liftToUp(nW, foliageLeafLift);
  const nLeafView = cameraViewMatrix.mul(vec4(nLeaf, 0)).xyz.normalize();
  // …and always toward the viewer: a frond hanging toward the camera shows
  // its underside, which must not go dark next to a lit neighbour.
  const nLeafFacing = select(nLeafView.z.lessThan(0), nLeafView.negate(), nLeafView);
  // Heads (part 2) are bodies of revolution, so half of one faces away from
  // the sun and goes muddy; they are soft and pale in life, so they get the
  // same canopy normal as the leaves. Only the stalk keeps its true normal.
  // A bamboo culm (part 3) is neither. The leaves' 95% lift would flatten a
  // pole into a green stripe; the stalk's true normal turned it BLACK, which
  // is the physically correct answer and the wrong picture — a standing
  // cylinder's normal is horizontal, so under a low sun its whole
  // camera-facing side falls off a cliff, top to bottom, unshadowed. A real
  // culm is glossy and reads the sky there. 45% keeps the round gradient and
  // lifts the shaded side off the floor.
  // Part 4 (a leaf card) is a leaf in every way but its alpha.
  const isLeafPart = vPart.lessThan(0.5).or(vPart.greaterThan(3.5));
  // A prickly-pear pad: part 2 with `along` 2 + age (foliageGeometry buildOpuntia).
  const padMask = vPart.greaterThan(1.5).and(vPart.lessThan(2.5)).and(vAlong.greaterThan(1.5));
  // A cactus pad (part 2, `along` ≥ 2) and an agave leaf (part 2.25) are
  // solid bodies with real form: they shade like a pad (below), not as a
  // soft canopy that flattens them.
  const isSoft = isLeafPart.or(vPart.greaterThan(1.5).and(vPart.lessThan(2.5)).and(vAlong.lessThan(1.5)).and(vPart.lessThan(2.2).or(vPart.greaterThan(2.3))));
  const nCulm = liftToUp(nW, 0.45);
  const trueView = cameraViewMatrix.mul(vec4(nW, 0)).xyz.normalize().mul(faceDirection);
  const culmView = cameraViewMatrix.mul(vec4(nCulm, 0)).xyz.normalize().mul(faceDirection);
  // A palm frond half-card (part 5) is lifted only HALF way to up. The
  // leaves' 95% would shade both halves of the V-fold the same and flatten
  // the frond into a comb; at 50% the sunward half and the shaded half
  // read apart, which is the whole reason the frond is two cards.
  // The lift rides in the part id's fraction (palmGeometry addFrondCards):
  // 5.5 for a palm, 5.85 for a ground fern.
  const nFrond = liftToUp(nW, fract(vPart));
  const nFrondView = cameraViewMatrix.mul(vec4(nFrond, 0)).xyz.normalize();
  const nFrondFacing = select(nFrondView.z.lessThan(0), nFrondView.negate(), nFrondView);
  // DOME FOLIAGE (2026-10-02, you: "orbiting around it feels it's not using
  // rounded normals"): the tamarisk shrub's strand cards (part 2.4) and the
  // oleander's leaf cards (part 5.25) carry a baked DOME normal
  // (foliageGeometry LEAF_ROUNDING) — the crown's sun side lit, its far side
  // falling off. The "turn toward the viewer" flip above relit whatever side
  // you orbited to (the light followed the camera); these skip it, and are
  // lifted only a quarter of the way to up so the dome survives.
  // The canopy trees' cards (part 5.35) too, behind FOLIAGE_DOME_CARDS; they
  // keep their own lift (the part's fraction, 0.35).
  const isTreeCard = vPart.greaterThan(5.3).and(vPart.lessThan(5.4)).and(FOLIAGE_DOME_CARDS.greaterThan(0.5));
  // A thin tepal (part 2.1) faces the viewer too, lifted well up: a petal
  // seen from behind is lit through, never a sky-blue mirror.
  const isTepalN = vPart.greaterThan(2.05).and(vPart.lessThan(2.15));
  const isDome = vPart.greaterThan(2.35).and(vPart.lessThan(2.45)).or(vPart.greaterThan(5.2).and(vPart.lessThan(5.3))).or(isTreeCard);
  const domeView = cameraViewMatrix.mul(vec4(liftToUp(nW, select(isTreeCard, float(0.35), float(0.25))), 0)).xyz.normalize();
  // The pad: 20% of the way to up — its own baked occlusion now darkens the
  // heart of the plant, so the normal can keep its form (45% read flat). A
  // pad is a CLOSED body whose normals already point out, and its triangles
  // wind so the side you see is the back face — `faceDirection` would turn
  // every normal inward (black pads, first try).
  const padView = cameraViewMatrix.mul(vec4(liftToUp(nW, 0.2), 0)).xyz.normalize();
  // (A flower turned away from the sun took only the blue sky: lifted most of
  // the way to up, every tepal takes the sun, as a cup of thin white petals does.)
  const tepalView = cameraViewMatrix.mul(vec4(liftToUp(nW, 0.85), 0)).xyz.normalize();
  const tepalFacing = select(tepalView.z.lessThan(0), tepalView.negate(), tepalView);
  mat.normalNode = select(isTepalN, tepalFacing, select(isDome, domeView, select(vPart.greaterThan(4.5), nFrondFacing,
    select(isSoft, nLeafFacing,
      select(vPart.greaterThan(2.5), culmView, select(vPart.greaterThan(1.5), padView, trueView))))));

  // SELF-SHADOW ACNE (2026-10-02, alg-rts's prickly pear: every pad hatched
  // in fine stripes): the RTS fitted sun shadow runs with almost no bias to
  // keep the level look, and a plant's smooth, sun-grazing surfaces shadow
  // themselves. Its texel is ~17 cm (2048 over a 340 m frustum), as wide as
  // half a pad, so a plant's self-shadow there is only fine hatching. The
  // shadow is looked up OUT of the surface (along its true normal, on the
  // side being drawn) and 3 m toward the sun — measured: 0.8 and 1.8 m still
  // hatched the lower pads, 3 m is clean. A plant skips its OWN shadow; a
  // wall, a building or a tree taller than the offset still shades it, and
  // the plant still casts on the ground. Its form comes from its normals.
  mat.receivedShadowPositionNode = vWorld.add(nW.mul(faceDirection).mul(FOLIAGE_SHADOW_OFFSET.x)).add(u.uSunDir.mul(FOLIAGE_SHADOW_OFFSET.y));

  const baseColor = Fn(() => {
    const r0 = row(vType, 0);
    const r1 = row(vType, 1);
    const c = uv();
    // Lighter toward the frond's tip and its cut edges, darker in the heart
    // of the plant; a midrib along the rachis catches the light.
    const up = vHeight.mul(0.65).add(vAlong.mul(0.35));
    const leaf = mix(r0.xyz, r1.xyz, smoothstep(0.05, 0.95, up).mul(0.9)).toVar();
    // The outer third goes a touch paler and yellower.
    leaf.mulAssign(mix(vec3(1), vec3(1.14, 1.1, 0.88), smoothstep(0.55, 1.0, vHeight)));
    // A faint vein down the CENTRE of the leaflet (uv.x = 0.5 there; 0 and
    // 1 are its two edges).
    const cx = c.x.sub(0.5).mul(2);
    const vein = exp(cx.mul(cx).mul(-30));
    leaf.mulAssign(float(1).add(vein.mul(0.06)));
    // The heart of the rosette is its darkest green.
    leaf.mulAssign(mix(float(0.55), float(1), smoothstep(0.0, 0.3, vHeight)));
    leaf.mulAssign(float(0.94).add(min(vRand, float(1)).mul(0.12)));
    // A DEAD leaf — a palm's hanging skirt — is flagged by rand ≥ 2 (the
    // only spare channel): brown, and opaque to the backlight below.
    // MARBLED LEAF (part 0.25: the milk thistle's rosette): the white the
    // plant is named for — a pale midrib, side veins running out to the teeth,
    // and milky patches along them. uv.x 0 → 1 across (0.5 the rib), uv.y the
    // length. Fades to its average where it would shimmer.
    {
      const mx = c.x.sub(0.5).mul(2), my = c.y;
      const rib = exp(mx.mul(mx).mul(-70));
      const side = smoothstep(0.82, 0.97, sin(my.mul(11).sub(mx.abs().mul(2.6)).mul(3.14159))).mul(smoothstep(0.92, 0.6, mx.abs()));
      const patch = smoothstep(0.25, 0.75, sin(mx.mul(7.3).add(vRand.mul(13))).mul(sin(my.mul(9.1).add(vRand.mul(5)))).mul(0.5).add(0.5)).mul(0.55);
      const white = rib.max(side).max(patch.mul(rib.max(side).mul(2).min(1))).max(patch.mul(0.35));
      const fine = smoothstep(0.15, 0.5, fwidth(my.mul(11)));
      const marble = mix(white, float(0.28), fine);
      leaf.assign(select(vPart.greaterThan(0.2).and(vPart.lessThan(0.5)), mix(leaf, vec3(0.42, 0.46, 0.36), marble.mul(0.85)), leaf));
    }
    const dead = vRand.greaterThan(1.5);
    leaf.assign(select(dead, vec3(0.62, 0.42, 0.17).mul(float(0.85).add(vHeight.mul(0.3))), leaf));
    // A DRY leaf (rand 1..1.5 — the alfa's straw blades, foliageGeometry
    // addBladeFan `dry`): grey straw, paler toward the tip (linear colours).
    const dryLeaf = vRand.greaterThanEqual(0.999).and(vRand.lessThan(1.5));
    leaf.assign(select(dryLeaf, mix(leaf, vec3(0.25, 0.22, 0.15).mul(float(0.8).add(vHeight.mul(0.4))), 0.85), leaf));
    // FRUIT (rand ≥ 3, the prickly pear's figs — foliageGeometry buildOpuntia):
    // the type's colorBase, which a plant drawn in its head colour leaves free.
    // Brightest at the top, where the sun hits (vHeight 0.9 there).
    // RIPENESS rides in `along` (0 green → 0.5 orange → 1 the type's colour):
    // a hedge in late summer carries every stage at once.
    const ripe = vAlong.clamp(0, 1);
    const fruitCol = mix(mix(vec3(0.1, 0.16, 0.035), vec3(0.5, 0.15, 0.02), smoothstep(0, 0.5, ripe)), r0.xyz, smoothstep(0.5, 1, ripe));   // linear
    leaf.assign(select(vRand.greaterThan(2.9), fruitCol.mul(float(0.8).add(vHeight.mul(0.25))), leaf));
    // The stalk: only a little paler and yellower than the blade, and as
    // dark as the blade toward the crown.
    const stemGreen = mix(r1.xyz, vec3(0.72, 0.8, 0.4), float(0.5))
      .mul(mix(float(0.5), float(1), smoothstep(0.0, 0.12, vHeight)));
    // A WOODY STALK (part 1.25: the agave's flower spear): colorBase at the
    // foot → colorTip at the top, with faint lengthwise striations.
    const stemWood = mix(r0.xyz, r1.xyz, smoothstep(0.1, 0.9, vHeight))
      .mul(float(1).add(sin(uv().x.mul(PI2).mul(5)).mul(0.05)));
    const stem = select(vPart.greaterThan(1.2).and(vPart.lessThan(1.3)), stemWood, stemGreen);
    // The head (a cattail's sausage, a reed's plume): its own colour, a
    // little darker where it meets the stem and paler at the tip.
    const headPlain = row(vType, 3).xyz.mul(mix(float(0.82), float(1.12), vAlong.min(1)));
    // A PRICKLY-PEAR PAD (foliageGeometry buildOpuntia: `along` 2 + age,
    // uv = the pad's own −1..1 frame, rand per pad): the old pads low down
    // darker and greyer, the young ones on top fresher; a paler rim; the
    // AREOLES — the little tufts of glochids in a diamond lattice that make a
    // pad read as cactus, not a green paddle — fading out where they would
    // shimmer; now and then a dried, yellowed pad.
    const padAge = vAlong.sub(2).clamp(0, 1);
    const padUv = uv().mul(2).sub(1);
    const padBase = row(vType, 3).xyz.mul(float(0.82).add(vRand.mul(0.32)));
    const padTone = mix(padBase.mul(vec3(0.78, 0.8, 0.76)), padBase.mul(vec3(1.08, 1.1, 0.96)), padAge);
    const rim = smoothstep(0.72, 1.0, dot(padUv, padUv));
    const padRim = mix(padTone, padTone.mul(vec3(1.18, 1.14, 0.82)), rim.mul(0.7));
    const q = vec2(padUv.x.mul(3.2), padUv.y.mul(4.2));
    const qRow = floor(q.y);
    const qc = vec2(fract(q.x.add(qRow.mul(0.5))), fract(q.y)).sub(0.5);
    // (Colours here are LINEAR: a pale tan dot is ~0.25, not 0.6.)
    const areole = float(1).sub(smoothstep(0.05, 0.1, length(qc)));
    const areoleFine = smoothstep(0.2, 0.45, fwidth(q.x));
    const padDots = mix(padRim, vec3(0.2, 0.17, 0.09), areole.mul(float(1).sub(areoleFine)).mul(0.7));
    // Mottling: the faint lighter and darker patches of a living pad.
    const mott = sin(padUv.x.mul(5.1).add(vRand.mul(17))).mul(sin(padUv.y.mul(4.3).add(vRand.mul(9)))).mul(0.07);
    // Summer stress: a purple-red flush at the rim of some pads.
    const stressed = smoothstep(0.55, 0.8, fract(vRand.mul(7.31)));
    const padLive = mix(padDots.mul(float(1).add(mott)), padDots.mul(vec3(1.25, 0.82, 0.95)), rim.mul(stressed).mul(0.55));
    const dried = vRand.greaterThan(0.93).and(padAge.lessThan(0.4));
    // THE TRUNK: an old plant's foot pads turn woody — corky grey-brown,
    // rough, ringed. Half the bottom tier (the shader can't know the plant's
    // age; the bottom pads of a 3-tier plant are its oldest).
    const woody = padAge.lessThan(0.05).and(vRand.lessThan(0.5));
    const cork = vec3(0.17, 0.12, 0.07).mul(float(0.85).add(sin(padUv.y.mul(22).add(padUv.x.mul(3))).mul(0.12)).add(mott));
    const pad = select(woody, cork, select(dried, mix(padLive, vec3(0.26, 0.19, 0.07), 0.7), padLive));
    const isPad = vAlong.greaterThan(1.5);
    // AN AGAVE LEAF (part 2.25): darker toward its spiny margins, a little
    // olive at the root, paler toward the tip, and the ghost of the next
    // leaf's outline printed across it (the "imprint" bands every agave has).
    const agEdge = abs(uv().x.sub(0.5)).mul(2);
    const imprint = smoothstep(0.88, 1, sin(vAlong.mul(9).add(vRand.mul(6)).add(agEdge.mul(2.5)))).mul(0.12);
    const agave = row(vType, 3).xyz
      .mul(mix(vec3(0.9, 0.95, 0.8), vec3(1.08, 1.06, 1.04), smoothstep(0, 0.7, vAlong)))
      .mul(mix(float(1), float(0.62), smoothstep(0.55, 1, agEdge)))
      .mul(float(1).add(imprint))
      .mul(float(0.9).add(vRand.mul(0.2)))
      // The terminal spine: the last few centimetres go dark brown.
      .toVar();
    agave.assign(mix(agave, vec3(0.09, 0.06, 0.035), smoothstep(0.9, 0.98, vAlong)));
    const isAgave = vPart.greaterThan(2.2).and(vPart.lessThan(2.3));
    // A STRIPED TEPAL (part 2.1, the asphodel's flower): white, a fine
    // reddish-brown MIDRIB down its middle (uv.x 0.5), fading out at the tip;
    // averaged away where it would shimmer.
    const tx = uv().x.sub(0.5).mul(2);
    const midrib = exp(tx.mul(tx).mul(-55)).mul(float(1).sub(smoothstep(0.7, 1, uv().y))).mul(0.85);
    const ribFine = smoothstep(0.3, 0.8, fwidth(uv().x));
    const tepal = mix(headPlain, vec3(0.2, 0.06, 0.035), mix(midrib, float(0.12), ribFine));
    const isTepal = vPart.greaterThan(2.05).and(vPart.lessThan(2.15));
    // A tamarisk WAND (part 2.4): each a slightly different grey-green, and
    // one in ten in flower — the dusty pink plume of late summer.
    const isWand = vPart.greaterThan(2.35).and(vPart.lessThan(2.45));
    const wandTone = headPlain.mul(mix(vec3(0.9, 0.96, 1.04), vec3(1.08, 1.04, 0.88), fract(vRand.mul(3.7))));
    const wand = select(vRand.greaterThan(0.93), mix(wandTone, vec3(0.5, 0.3, 0.32), 0.5), wandTone);
    const head = select(isPad, pad, select(isAgave, agave, select(isTepal, tepal, select(isWand, wand, headPlain))));
    // A bamboo culm (part 3). `vAlong` is the SIGNED distance to the nearest
    // node in half-internodes (bambooGeometry.js): 0 on the node, ±1 in the
    // middle of an internode, negative below the node. A node is drawn from
    // it as the two things geometry cannot make crisp on a 40 cm quad:
    //   scar   a thin dark line on the node itself (the leaf-sheath scar)
    //   bloom  the pale waxy band a few centimetres ABOVE it
    // (the raised ridge is geometry). Fine vertical striations round the
    // culm, the up-culm ramp from green at the foot to straw at the crown
    // read from `vHeight`, and older culms (per-culm `vRand`) yellowing all
    // over — the same hue shift a grove shows between this year's canes and
    // last year's.
    const nd = vAlong;
    const scar = float(1).sub(smoothstep(0.0, 0.09, nd.abs())).mul(0.34);
    const bloom = smoothstep(0.03, 0.08, nd).mul(float(1).sub(smoothstep(0.18, 0.36, nd))).mul(0.26);
    const striae = sin(uv().x.mul(PI2).mul(41)).mul(0.035);
    const culmRow = row(vType, 3).xyz;
    const culmTone = mix(culmRow, culmRow.mul(vec3(1.14, 1.04, 0.66)), vRand.mul(0.55));
    const culmRinged = culmTone
      .mul(mix(float(0.82), float(1.18), vHeight))
      .mul(float(1).sub(scar).add(bloom).add(striae));
    // BOOTS — a fan palm's trunk (fanPalmGeometry.js flags it with `along` 2,
    // outside the ±1 the rings use). The old leaf bases stay on the trunk for
    // years, split down the middle, and stack into a criss-cross lattice: a
    // diamond per boot, pale grey where the base is weathered flat, rust-brown
    // where the fibre splits at its edges, a dark groove between. From your
    // photograph of the sugar-palm stand. 6 boots round, 20 up the trunk. `uv.x`
    // runs 0 -> 1 round the trunk with a seam vertex, so the lattice closes.
    //
    // A boot is a SCALE, not a cell: each one overlaps the one above it, so its
    // lower half is the weathered pale face and its upper half is the dark
    // hollow the next boot stands out of. A flat per-cell fill read as a woven
    // basket (first try); the shadowed pocket at the top of every diamond is
    // what turns the lattice into a trunk.
    const bootA = uv().x.mul(6).add(vHeight.mul(20));
    const bootB = uv().x.mul(6).sub(vHeight.mul(20));
    const fa = fract(bootA), fb = fract(bootB);
    const edge = min(min(fa, float(1).sub(fa)), min(fb, float(1).sub(fb)));
    // Height inside the diamond: -1 at its bottom point, +1 at its top.
    const inY = fa.sub(fb);
    const cellTone = hash(floor(bootA).mul(31.7).add(floor(bootB)).add(vPlant.mul(97)));
    const pale = culmTone.mul(vec3(1.36, 1.18, 0.92)).mul(float(0.8).add(cellTone.mul(0.4)));
    const rust = culmTone.mul(vec3(1.1, 0.66, 0.42));
    const face = mix(rust, pale, smoothstep(0.04, 0.3, edge));
    const pocket = smoothstep(0.05, 0.75, inY);          // the hollow above the face
    const bootCol = face
      .mul(mix(float(1), float(0.38), pocket))
      .mul(mix(float(0.3), float(1), smoothstep(0.0, 0.06, edge)));
    // Where the lattice gets finer than a couple of pixels it would shimmer:
    // fade it to its own average as the cells shrink.
    const bootFine = smoothstep(0.25, 0.6, fwidth(bootA));
    const bootMean = mix(rust, pale, float(0.5)).mul(0.72);
    const boots = mix(bootCol, bootMean, bootFine);
    // BARK (part 3.4, betoumGeometry): furrowed grey-brown bark from uv —
    // u round the branch in whole tile wraps, v metres along it. Long ridges
    // (noise stretched along the wood), dark cracks between them, a little
    // lichen-pale on the ridges, darker low on the trunk; averaged away
    // where it would shimmer.
    const bu = uv().x, bv = uv().y;
    const ridge = mx_noise_float(vec3(bu.mul(5.0), bv.mul(0.9), vPlant.mul(7)));
    const crackN = float(1).sub(smoothstep(0.0, 0.22, abs(ridge)));
    const fineB = mx_noise_float(vec3(bu.mul(23), bv.mul(6), 3.1)).mul(0.5).add(0.5);
    const barkFine = smoothstep(0.15, 0.6, fwidth(bu.mul(5)));
    const barkBase = row(vType, 3).xyz.mul(float(0.85).add(fineB.mul(0.3)));
    const barkLit = mix(barkBase, barkBase.mul(vec3(1.2, 1.18, 1.1)), smoothstep(0.3, 0.7, ridge.mul(0.5).add(0.5)).mul(0.5));
    const barkCol = mix(barkLit.mul(mix(float(1), float(0.45), crackN)), barkBase.mul(0.82), barkFine)
      .mul(mix(float(0.72), float(1), smoothstep(0.0, 0.25, vHeight)));
    const isBark = vPart.greaterThan(3.35).and(vPart.lessThan(3.45));
    const culm = select(isBark, barkCol, select(vAlong.greaterThan(1.5), boots, culmRinged));
    const col = select(isLeafPart, leaf,
      select(vPart.lessThan(1.5), stem,
        select(vPart.lessThan(2.5), head, culm)));
    const j = vPlant.sub(0.5).mul(2).mul(src.colorVar);
    // The macro field (vMacro): dry plants yellower and paler, lush ones a
    // deeper green. Greens only — flowers, fruit and buds keep their colour.
    const isGreen = isLeafPart.and(vRand.lessThan(1.5)).or(padMask).or(vPart.greaterThan(0.5).and(vPart.lessThan(1.5)));
    const dry = smoothstep(-0.45, 0.6, vMacro);
    const macroTint = mix(vec3(0.86, 0.98, 0.9), vec3(1.16, 1.04, 0.74), dry);
    const colM = select(isGreen, col.mul(macroTint), col);
    return colM.mul(vec3(float(1).add(j.mul(0.6)), float(1).add(j), float(1).sub(j.mul(0.5))));
  });
  // A card texture's RGB is a per-leaf SHADE (the banyan's clusters); every
  // other card texture is white there, so this multiply leaves it untouched.
  const cardPart = vPart.greaterThan(1.5).and(vPart.lessThan(2.5)).or(vPart.greaterThan(3.5));
  const col = (headTex
    ? baseColor().mul(select(cardPart, texture(headTex, uv()).rgb, vec3(1)))
    : baseColor()).mul(vAO).mul(mix(vec3(1.15, 1.0, 0.78), vec3(1), vAO));   // the dark heart takes the GROUND's warm bounce, not the sky's blue
  // Mountain shade (terrainSunShadow.js): shade the colour on the detail
  // levels that skip shadows, and take the sun out of the see-through light
  // everywhere — emissive never passes through any shadow.
  const sunVis = terrainSunVisibilityHere();
  // WAXY PADS (cactus): a lower roughness for a soft sheen, and the bluish
  // bloom of the wax where the pad turns away at its rim (a Fresnel term on
  // the colour). Everything else stays matte.
  const padFres = pow(float(1).sub(abs(dot(normalize(cameraPosition.sub(vWorld)), nW))), 3);
  const waxy = padMask.and(vAlong.greaterThan(2.05).or(vRand.greaterThanEqual(0.5)))   // not the woody trunk
    .or(vPart.greaterThan(2.2).and(vPart.lessThan(2.3)));                               // the agave's leaves
  const colWax = select(waxy, col.mul(mix(vec3(1), vec3(1.05, 1.15, 1.26), padFres.mul(0.4))), col);
  // The plant's own occlusion also dims the SKY's light on it (diffuse and
  // reflection): darkening only the colour left the sky's blue reflection
  // standing in the dark heart of every rosette.
  mat.aoNode = vAO;
  // Glossy marbled leaves (the milk thistle) too.
  mat.roughnessNode = select(waxy, float(0.55), select(vPart.greaterThan(0.2).and(vPart.lessThan(0.5)), float(0.74), float(0.92)));
  mat.colorNode = terrainShade(colWax, sunVis);
  mat.terrainSunShadowNode = sunVis;   // shared with the sun's shadow term: one read

  // Sunlight through the blades when the sun is behind them.
  mat.emissiveNode = Fn(() => {
    const V = normalize(cameraPosition.sub(vWorld));
    const behind = pow(saturate(dot(V, u.uSunDir.negate())), 3).mul(sunVis);
    // Leaves let light through; a stem or a solid head does not.
    const thin = select(isLeafPart.and(vRand.lessThan(1.5)), row(vType, 0).w,
      select(vPart.greaterThan(2.05).and(vPart.lessThan(2.15)), float(0.8), float(0)));   // tepals let light through
    return col.mul(behind.mul(thin).mul(u.uTransMul).mul(0.9).add(u.uGlowLight));
  })();

  if (headTex) {
    // The card's shape lives in the texture's alpha — a plume head (part 2)
    // or a bamboo spray (part 4); everything else on the plant is solid
    // geometry and stays fully opaque.
    const isCard = vPart.greaterThan(1.5).and(vPart.lessThan(2.5)).or(vPart.greaterThan(3.5));
    mat.opacityNode = Fn(() => {
      const a = select(isCard, texture(headTex, uv()).a, float(1));
      Discard(a.lessThan(0.4));
      return float(1);
    })();
    // The shadow pass ignores opacityNode: without this the card casts
    // its whole rectangle.
    mat.maskShadowNode = isCard.not().or(texture(headTex, uv()).a.greaterThanEqual(0.4));
  }
  return mat;
}

export class FoliageScatterSystem {
  /**
   * @param {object} o
   *   scene, renderer, worldSize
   *   heightTex, terrainNormalTex, densityTex, grassDensityTex, splatTex, riverNearTex,
   *   waterMapTex, windTex
   *   fs  foliage state (createFoliageScatterState shape)
   *   gp  grassState — the shared wind and blade height
   *   tileSize, plantsPerSide  wrap tile (192 m / 256 ≈ 65k slots, 0.75 m apart:
   *                            ferns are bigger than flowers, so fewer go further)
   */
  constructor({
    scene, renderer, heightTex, terrainNormalTex, densityTex, grassDensityTex, splatTex,
    riverNearTex = null, waterMapTex = null, windTex, worldSize, fs, gp, tileSize = 192, plantsPerSide = 256,
    name = "Foliage", typeCount = FOLIAGE_TYPE_COUNT, nearFade = 0.9,
    terrainSurface = null,
    variants = 1,   // shape variants per type (ScatterField)
    depthPrepass = false,   // cut-out cards: depth first, shade each pixel once (see _prepass)
    receiveLods = 1,        // detail levels that receive shadows (ScatterField.setReceiveShadows)
  }) {
    this._depthPrepass = !!depthPrepass;
    // Foliage runs 8 types on a 192 m tile; susuki runs this same system with
    // one type on a 400 m tile so its fields stay visible to ~195 m.
    this.typeCount = typeCount;
    const field = (this.field = new ScatterField({
      scene, renderer, name,
      typeCount, lods: FOLIAGE_LODS, rows: ROWS, ruleRow: RULE_ROW, receiveLods,
      worldSize, tileSize, plantsPerSide,
      heightTex, terrainNormalTex, densityTex, splatTex, riverNearTex, waterMapTex, windTex, grassDensityTex,
      terrainSurface,  // stand on the mesh, like the grass does
      cullRadius: 5,   // a jungle fern is metres across, not centimetres
      shadows: true,   // tall plants cast (per type, near cascades only)
      nearFade,        // plants right at the camera thin out
      variants,
    }));
    this.group = field.group;
    this.renderer = renderer;

    const u = (this.u = {
      uFlutter: uniform(0.7),
      uGlowLight: uniform(0.05),
      uTransMul: uniform(1),
      uSunDir: uniform(new THREE.Vector3(0.5, 0.8, 0.3).normalize()),
    });
    const { bufPos, bufDir, compactBuf } = field.nodes;
    const fu = field.u;

    // Card plants (plume heads, bamboo sprays, palm and fern fronds) get a
    // material per texture key, made on first use in rebuildType, and pay the
    // alpha test; every other plant keeps plain early-depth-rejected geometry.
    this._cardTex = {};
    this._cardMats = {};

    // Every scattered plant is shaded by createFoliageMaterial (above this
    // class); this is where the field tells it where a plant is.
    const src = {
      plantAt: () => {
        const plant = compactBuf.element(instanceIndex);
        return { plant, p: bufPos.element(plant), d: bufDir.element(plant) };
      },
      rowOf: (t, r) => field.rowOf(t, r),
      sizeVar: fu.uSizeVar,
      colorVar: fu.uColorVar,
      anchorPos: fu.uAnchorPos,
      thinScale: (plant) => field.thinScale(plant),
      // Billboard cards face the PLAYER's camera in every pass, the shadow
      // pass included (see the billboard note in createFoliageMaterial). The
      // placed banyan had this; the field did not, and the canopy trees'
      // crowns were striped with hard horizontal shadow cuts (2026-09-24).
      viewPos: fu.uCamPos,
    };
    const makeMaterial = (headTex) => createFoliageMaterial({ src, u, headTex });

    // Each type's unscaled height, read off its near mesh — the bend below
    // needs to know how high a vertex sits on ITS plant.
    this._localH = new Array(typeCount).fill(1);

    const mat = makeMaterial(null);
    this._mat = mat;
    /** The material for one card texture key, built on first use. */
    this._cardMat = (key) => {
      if (!this._cardMats[key]) {
        this._cardTex[key] = makeCardTexture(key, 8);
        this._cardMats[key] = makeMaterial(this._cardTex[key]);
      }
      return this._cardMats[key];
    };
    /**
     * DEPTH PRE-PASS FOR CUT-OUT CARDS. A card's shape is cut from its
     * texture with a discard, and a shader that can discard switches off the
     * GPU's early depth test for its whole draw: every card hidden behind the
     * front ones was still fully lit before being covered. MEASURED
     * 2026-09-27, alg-rts cedar massif, 1919x888: cedars ~12 ms of a 19 ms
     * scene.
     *
     * So a card mesh draws twice: a depth-only copy that keeps the discard
     * (cheap: no lighting runs for it), then the colour pass WITHOUT the
     * discard, depth-tested EQUAL — each visible pixel shaded exactly once,
     * and the cut-out edges come from the depth the first pass left. The
     * depth pass is UNLIT and shares the colour pass's position node, so the
     * depths match. MEASURED after: cedar view 19.1 → 6.4 ms, image identical.
     */
    this._prepassMats = {};
    this._prepassFor = (key) => {
      if (!this._prepassMats[key]) {
        const base = this._cardMat(key);
        // UNLIT: a clone of the lit material still ran all its lighting with
        // colour writes off (measured 17.8 ms vs 6.4 ms). Same position and
        // cut-out nodes, so the depth matches the colour pass exactly
        // (pixel diff against the original 0.002%, frozen plants).
        const depth = new THREE.MeshBasicNodeMaterial({ side: base.side });
        depth.positionNode = base.positionNode;
        depth.opacityNode = base.opacityNode;
        depth.colorWrite = false;
        depth.name = `${base.name || "Foliage"}:depth`;
        const colour = base.clone();
        colour.opacityNode = null;
        colour.depthFunc = THREE.EqualDepth;
        colour.depthWrite = false;
        this._prepassMats[key] = { depth, colour };
      }
      return this._prepassMats[key];
    };

    field.attachMaterial(mat);
    for (let i = 0; i < typeCount; i++) this.rebuildType(i, fs.types[i]);
    this.syncFromState(fs, gp);
  }

  get triangles() { return this.field.triangles; }
  get meshes() { return this.field.meshes; }

  /** A PNG of one plant for the picker — see bakeFoliageThumbnail. */
  bakeThumbnail(type, o = {}) { return bakeFoliageThumbnail(type, { renderer: this.renderer, ...o }); }

  /** Rebuild one type's meshes after a shape setting changed. */
  rebuildType(i, type) {
    this.field.rebuildType(i, (lod, _part, { variant = 0 } = {}) => {
      const made = createFoliageTypeGeometry(type, { lod, variant });
      if (lod === 0 && variant === 0) {
        made.geometry.computeBoundingBox();
        this._localH[i] = Math.max(0.05, made.geometry.boundingBox.max.y);
        this.field.typeRows[i * ROWS + 3].w = this._localH[i];
      }
      return made;
    });
    // Only the card-carrying plants pay for the alpha test.
    const cardKey = cardTextureOf(type.kind);
    const pre = cardKey && this._depthPrepass ? this._prepassFor(cardKey) : null;
    const mat = cardKey ? (pre ? pre.colour : this._cardMat(cardKey)) : this._mat;
    for (let v = 0; v < this.field.variants; v++) {
      for (let lod = 0; lod < FOLIAGE_LODS; lod++) {
        const m = this.field.meshes[this.field.meshIndex(i, lod, 0, v)];
        m.material = mat;
        // The depth copy: a CHILD, so it follows the mesh's position (moved
        // with the field every frame) and visibility (unused types hide).
        let d = m.children.find((c) => c.userData.depthPrepass);
        if (pre) {
          if (!d) {
            d = new THREE.Mesh(m.geometry, pre.depth);
            d.userData.depthPrepass = true;
            d.name = m.name + ":depth";
            d.frustumCulled = false;
            d.castShadow = d.receiveShadow = false;
            d.renderOrder = -1;   // before every colour draw
            m.add(d);
          }
          d.geometry = m.geometry;
          d.material = pre.depth;
          d.count = m.count;
        } else if (d) m.remove(d);
      }
      // The shadow pass keeps the cut-out material (its own depth test).
      const sh = this.field.shadowMeshes[this.field.shadowMeshIndex(i, 0, v)];
      if (sh) sh.material = cardKey ? this._cardMat(cardKey) : mat;
    }
  }

  /**
   * fs = foliage state, gp = grassState (shared wind, blade height), sunDir
   * toward the sun. `hasRivers` false means the world has no River v2 river at
   * all, so a "grows near water" rule could never be satisfied.
   */
  syncFromState(fs, gp, sunDir, { hasRivers = true } = {}) {
    this.field.syncCommon({
      wind: gp ? { ...gp, windMul: fs.windMul } : null,
      density: fs.density,
      sizeVar: fs.sizeVar,
      colorVar: fs.colorVar,
      clumping: fs.clumping,
      clumpSize: fs.clumpSize,
      grassLift: fs.grassLift,
      flex: fs.flex,
      interactRadius: fs.interactRadius,
      interactStrength: fs.interactStrength,
      lodDistance: fs.lodDistance,
      lodDistance2: fs.lodDistance2,
      fadeStart: fs.fadeStart,
      fadeEnd: fs.fadeEnd,
      slopeMinY: fs.slopeMinY,
    });
    this.u.uFlutter.value = fs.flutter;
    this.u.uGlowLight.value = fs.glowLight;
    this.u.uTransMul.value = fs.translucencyMul;
    if (sunDir) this.u.uSunDir.value.copy(sunDir).normalize();

    const c = new THREE.Color();
    const rows = this.field.typeRows;
    for (let i = 0; i < this.typeCount; i++) {
      const t = fs.types[i];
      const o = i * ROWS;
      c.set(t.colorBase); rows[o].set(c.r, c.g, c.b, t.translucency);
      c.set(t.colorTip);  rows[o + 1].set(c.r, c.g, c.b, t.size);
      // With no river in the world the near-water rule is meaningless, and
      // enforcing it would silently grow nothing where the user just painted.
      const nearRiver = hasRivers ? (t.nearRiver ?? 0) : 0;
      rows[o + 2].set(t.heightMin ?? -1e5, t.heightMax ?? 1e5, t.onLayer ?? -1, nearRiver);
      c.set(t.colorHead ?? t.colorTip); rows[o + 3].set(c.r, c.g, c.b, this._localH[i] ?? 1);
    }
    this.field.setReceiveShadows(fs.receiveShadows);
    this.field.setShadowCasters(
      fs.types.map((t) => fs.castShadows !== false && t.castShadow === true),
      fs.shadowDistance ?? 35,
    );
  }

  /** Near cascade cameras the shadow lists draw into — see ScatterField.setShadowCameras. */
  setShadowCameras(cams) { this.field.setShadowCameras(cams); }

  init(camera) { return this.field.init(camera); }
  setEnabled(on) { this.field.setEnabled(on); }
  update(anchorPos, camera, pushPos = anchorPos) { this.field.update(anchorPos, camera, pushPos); }
}
