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
  Discard, Fn, attribute, cameraPosition, cameraViewMatrix, cos, dot, exp, faceDirection, float,
  fract, hash, instanceIndex, length, max, min, mix, normalLocal, normalize, pow, positionLocal, saturate,
  select, sin, smoothstep, step, texture, time, uniform, uv, varying, vec2, vec3, vec4, PI2,
} from "three/tsl";
import { drawPlumeTexture, PLUME_TEX_W, PLUME_TEX_H } from "./plumeTexture.js";
import { drawBambooSprayTexture, SPRAY_TEX_W, SPRAY_TEX_H } from "./bambooSprayTexture.js";
import { drawPalmFrondTexture, FROND_TEX_W, FROND_TEX_H } from "./palmFrondTexture.js";
import { drawFernFrondTexture, FERN_TEX_W, FERN_TEX_H } from "./fernFrondTexture.js";
import { drawBananaLeafTexture, drawTaroLeafTexture, BROADLEAF_TEX_W, BROADLEAF_TEX_H } from "./broadleafTextures.js";
import { drawCanopyClusterTexture, CANOPY_TEX_W, CANOPY_TEX_H } from "./canopyClusterTexture.js";
import { drawFanLeafTexture, FAN_TEX_W, FAN_TEX_H } from "./fanLeafTexture.js";
import { drawLanceLeafTexture, LANCE_TEX_W, LANCE_TEX_H } from "./lanceLeafTexture.js";
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
 * THE CARD TEXTURES — one canvas-drawn alpha per `cardTextureOf` key. Geometry
 * cannot afford strand, spray or lace detail; a texture can, and a card of it
 * sways as one thing. Each is drawn white; colour is the shader's.
 */
const CARD_TEXTURES = {
  plume: {
    w: PLUME_TEX_W, h: PLUME_TEX_H,
    draw: (c) => drawPlumeTexture(c, { texSpread: 54, texStrands: 420, texStrandLen: 0.34, texDroop: 0.6 }),
  },
  spray: { w: SPRAY_TEX_W, h: SPRAY_TEX_H, draw: drawBambooSprayTexture },
  frond: { w: FROND_TEX_W, h: FROND_TEX_H, draw: drawPalmFrondTexture },
  fern:  { w: FERN_TEX_W,  h: FERN_TEX_H,  draw: drawFernFrondTexture },
  banana: { w: BROADLEAF_TEX_W, h: BROADLEAF_TEX_H, draw: drawBananaLeafTexture },
  taro:   { w: BROADLEAF_TEX_W, h: BROADLEAF_TEX_H, draw: drawTaroLeafTexture },
  canopy: { w: CANOPY_TEX_W, h: CANOPY_TEX_H, draw: drawCanopyClusterTexture },
  fan:    { w: FAN_TEX_W, h: FAN_TEX_H, draw: drawFanLeafTexture },
  lance:  { w: LANCE_TEX_W, h: LANCE_TEX_H, draw: drawLanceLeafTexture },
};

/**
 * Draw one card texture. `anisotropy` for the live field; thumbnails go without.
 *
 * The mip chain is built on the CPU with COVERAGE PRESERVED (see
 * alphaCoverageMips.js), not by the GPU: these are alpha-TESTED cards, and a
 * plain averaged mip drops thin shapes under the threshold, so a spray, a
 * frond or a leaf cluster thins out and finally dissolves as the camera pulls
 * back. Every card plant on the map goes through here.
 */
function makeCardTexture(key, anisotropy = 0) {
  const spec = CARD_TEXTURES[key];
  const canvas = document.createElement("canvas");
  canvas.width = spec.w; canvas.height = spec.h;
  spec.draw(canvas);
  return coverageMippedTexture(canvas, { threshold: 0.4, anisotropy });
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
    } else if (part > 1.5) c.copy(head).multiplyScalar(0.85 + along * 0.3);
    else if (part > 0.5) c.copy(stalk);
    // Part 0 is a leaf, parts 4 and 5 are leaf CARDS (alpha-tested spray or
    // frond): same colour. A dead frond (rand ≥ 2) is brown.
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
  if (headMat) {
    geometry.addGroup(0, bodyTris.length, 0);
    geometry.addGroup(bodyTris.length, headTris.length, 1);
  }
  const mesh = new THREE.Mesh(geometry, headMat ? [body, headMat] : body);
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
  }) {
    // Foliage runs 8 types on a 192 m tile; susuki runs this same system with
    // one type on a 400 m tile so its fields stay visible to ~195 m.
    this.typeCount = typeCount;
    const field = (this.field = new ScatterField({
      scene, renderer, name,
      typeCount, lods: FOLIAGE_LODS, rows: ROWS, ruleRow: RULE_ROW,
      worldSize, tileSize, plantsPerSide,
      heightTex, terrainNormalTex, densityTex, splatTex, riverNearTex, waterMapTex, windTex, grassDensityTex,
      terrainSurface,  // stand on the mesh, like the grass does
      cullRadius: 5,   // a jungle fern is metres across, not centimetres
      shadows: true,   // tall plants cast (per type, near cascades only)
      nearFade,        // plants right at the camera thin out
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

    // Matte: a fern has no highlights to speak of, and a specular term on a
    // saturated green reads as plastic.
    const makeMaterial = (headTex) => {
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

    const row = (t, r) => field.rowOf(t, r);

    /** Rotate v so +Y leans toward (bx, bz) by angle a. */
    const tilt = (v, a, bx, bz) => {
      const along = v.x.mul(bx).add(v.z.mul(bz));
      const ca = cos(a), sa = sin(a);
      const shift = along.mul(ca).add(v.y.mul(sa)).sub(along);
      return vec3(v.x.add(bx.mul(shift)), along.negate().mul(sa).add(v.y.mul(ca)), v.z.add(bz.mul(shift)));
    };
    const yawRot = (v, c, s) => vec3(v.x.mul(c).sub(v.z.mul(s)), v.y, v.x.mul(s).add(v.z.mul(c)));

    mat.positionNode = Fn(() => {
      const plant = compactBuf.element(instanceIndex);
      const p = bufPos.element(plant);
      const d = bufDir.element(plant);
      const a = attribute("aPlant", "vec4");
      const part = a.x, t = a.y, along = a.w;

      const fade = mix(float(0.35), float(1), d.z);
      const size = row(p.z, 1).w
        .mul(mix(float(1).sub(fu.uSizeVar), float(1).add(fu.uSizeVar), hash(plant.add(577))))
        .mul(fade)
        // Zoom thinning: shrink away rather than pop (ScatterField.thinScale).
        .mul(field.thinScale(plant));

      const mag = length(vec2(d.x, d.y));
      const inv = float(1).div(max(mag, 1e-4));
      const bx = d.x.mul(inv), bz = d.y.mul(inv);
      // A fern is springier than a flower stem: it leans further for the same wind.
      // CAPPED. Wind and the player's push arrive as one bend vector, and a
      // plant standing next to the player used to take the whole push: at
      // strength 1.2 that is 86 deg, which reads as the plant STRETCHING
      // across the view rather than bowing. A plant bows to 35 deg and no
      // further, however hard the wind blows or how close you stand.
      const lean = min(mag.mul(1.25), float(0.6)).add(hash(plant.add(313)).mul(0.1));

      const yaw = hash(plant.add(131)).mul(PI2);
      const cy = cos(yaw), sy = sin(yaw);

      // Leaflets flutter across their own width; the rachis only bends. A
      // spray CARD (part 4) flutters as one thing — `along` runs up the card
      // and `a.z` is per card, so the whole fan moves on its own phase.
      const isLeaf = part.lessThan(0.5).or(part.greaterThan(3.5));
      const flutter = sin(time.mul(5.2).add(a.z.mul(29)).add(hash(plant).mul(13)))
        .mul(u.uFlutter).mul(0.06).mul(along).mul(select(isLeaf, float(1), float(0)));

      const local = yawRot(positionLocal.mul(size), cy, sy).add(vec3(0, flutter.mul(size), 0));
      const nLocal = yawRot(normalLocal, cy, sy);
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
      vAlong.assign(along);
      vHeight.assign(t);
      vType.assign(p.z);
      vRand.assign(a.z);
      vPlant.assign(hash(plant.add(3197)));
      vNormal.assign(nrm);
      // Sits on the ground, lifted by the grass it grows in.
      const out = vec3(pos.x.add(p.x), pos.y.add(p.w).add(d.w.mul(0.5)), pos.z.add(p.y));
      vWorld.assign(out.add(vec3(fu.uAnchorPos.x, 0, fu.uAnchorPos.z)));
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
    const isSoft = isLeafPart.or(vPart.greaterThan(1.5).and(vPart.lessThan(2.5)));
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
    mat.normalNode = select(vPart.greaterThan(4.5), nFrondFacing,
      select(isSoft, nLeafFacing,
        select(vPart.greaterThan(2.5), culmView, trueView)));

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
      const dead = vRand.greaterThan(1.5);
      leaf.assign(select(dead, vec3(0.62, 0.42, 0.17).mul(float(0.85).add(vHeight.mul(0.3))), leaf));
      // The stalk: only a little paler and yellower than the blade, and as
      // dark as the blade toward the crown.
      const stem = mix(r1.xyz, vec3(0.72, 0.8, 0.4), float(0.5))
        .mul(mix(float(0.5), float(1), smoothstep(0.0, 0.12, vHeight)));
      // The head (a cattail's sausage, a reed's plume): its own colour, a
      // little darker where it meets the stem and paler at the tip.
      const head = row(vType, 3).xyz.mul(mix(float(0.82), float(1.12), vAlong));
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
      const culm = culmTone
        .mul(mix(float(0.82), float(1.18), vHeight))
        .mul(float(1).sub(scar).add(bloom).add(striae));
      const col = select(isLeafPart, leaf,
        select(vPart.lessThan(1.5), stem,
          select(vPart.lessThan(2.5), head, culm)));
      const j = vPlant.sub(0.5).mul(2).mul(fu.uColorVar);
      return col.mul(vec3(float(1).add(j.mul(0.6)), float(1).add(j), float(1).sub(j.mul(0.5))));
    });
    const col = baseColor();
    // Mountain shade (terrainSunShadow.js): shade the colour on the detail
    // levels that skip shadows, and take the sun out of the see-through light
    // everywhere — emissive never passes through any shadow.
    const sunVis = terrainSunVisibilityHere();
    mat.colorNode = terrainShade(col, sunVis);
    mat.terrainSunShadowNode = sunVis;   // shared with the sun's shadow term: one read

    // Sunlight through the blades when the sun is behind them.
    mat.emissiveNode = Fn(() => {
      const V = normalize(cameraPosition.sub(vWorld));
      const behind = pow(saturate(dot(V, u.uSunDir.negate())), 3).mul(sunVis);
      // Leaves let light through; a stem or a solid head does not.
      const thin = select(isLeafPart.and(vRand.lessThan(1.5)), row(vType, 0).w, float(0));
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
    };

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
    this.field.rebuildType(i, (lod) => {
      const made = createFoliageTypeGeometry(type, { lod });
      if (lod === 0) {
        made.geometry.computeBoundingBox();
        this._localH[i] = Math.max(0.05, made.geometry.boundingBox.max.y);
        this.field.typeRows[i * ROWS + 3].w = this._localH[i];
      }
      return made;
    });
    // Only the card-carrying plants pay for the alpha test.
    const cardKey = cardTextureOf(type.kind);
    const mat = cardKey ? this._cardMat(cardKey) : this._mat;
    for (let lod = 0; lod < FOLIAGE_LODS; lod++) this.field.meshes[i * FOLIAGE_LODS + lod].material = mat;
    const sh = this.field.shadowMeshes[this.field.shadowMeshIndex(i)];
    if (sh) sh.material = mat;
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
  update(anchorPos, camera) { this.field.update(anchorPos, camera); }
}
