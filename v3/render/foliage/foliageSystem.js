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
 *   3 (colorHead.rgb, 0) — a cattail's sausage or a reed's plume
 */
import * as THREE from "three";
import {
  Discard, Fn, attribute, cameraPosition, cameraViewMatrix, cos, dot, exp, faceDirection, float,
  hash, instanceIndex, length, max, mix, normalLocal, normalize, pow, positionLocal, saturate,
  select, sin, smoothstep, step, texture, time, uniform, uv, varying, vec2, vec3, vec4, PI2,
} from "three/tsl";
import { drawPlumeTexture } from "./plumeTexture.js";
import { bakeObjectThumbnails } from "../../../v2/tools/objectThumbnails.js";
import { ScatterField } from "../scatter/scatterField.js";
import { createFoliageTypeGeometry, FOLIAGE_LODS, usesPlumeTexture } from "./foliageGeometry.js";
import { FOLIAGE_TYPE_COUNT } from "../../app/state/foliageScatterState.js";
import { terrainShade, terrainSunVisibilityHere } from "../lighting/terrainSunShadow.js";

const ROWS = 4;
const RULE_ROW = 2;

/**
 * The plume strand texture the thumbnails draw pampas with. Its own copy, made
 * on first use, so a picture can be baked before any foliage system exists.
 */
let _thumbPlumeTex = null;
function thumbPlumeTexture() {
  if (_thumbPlumeTex) return _thumbPlumeTex;
  const canvas = document.createElement("canvas");
  canvas.width = 256; canvas.height = 512;
  drawPlumeTexture(canvas, { texSpread: 54, texStrands: 420, texStrandLen: 0.34, texDroop: 0.6 });
  _thumbPlumeTex = new THREE.CanvasTexture(canvas);
  _thumbPlumeTex.colorSpace = THREE.NoColorSpace;
  _thumbPlumeTex.needsUpdate = true;
  return _thumbPlumeTex;
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
    if (part > 1.5) c.copy(head).multiplyScalar(0.85 + along * 0.3);
    else if (part > 0.5) c.copy(stalk);
    else c.copy(base).lerp(tip, Math.min(1, t * 0.65 + along * 0.35));
    colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));

  // Head triangles last, so they can carry the plume texture on their own.
  const idx = Array.from(geometry.index.array);
  const bodyTris = [], headTris = [];
  for (let i = 0; i < idx.length; i += 3) {
    (aPlant.getX(idx[i]) > 1.5 ? headTris : bodyTris).push(idx[i], idx[i + 1], idx[i + 2]);
  }
  geometry.setIndex([...bodyTris, ...headTris]);
  geometry.clearGroups();

  const opts = { vertexColors: true, side: THREE.DoubleSide, roughness: 0.9, metalness: 0 };
  const body = new THREE.MeshStandardMaterial(opts);
  // A plant with no head (a fern) gets no second group: an empty draw is a
  // WebGPU warning, not a no-op.
  const headMat = headTris.length
    ? new THREE.MeshStandardMaterial(
      usesPlumeTexture(type.kind) ? { ...opts, alphaMap: thumbPlumeTexture(), alphaTest: 0.4, transparent: false } : opts,
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
   *   heightTex, terrainNormalTex, densityTex, grassDensityTex, splatTex, riverNearTex, windTex
   *   fs  foliage state (createFoliageScatterState shape)
   *   gp  grassState — the shared wind and blade height
   *   tileSize, plantsPerSide  wrap tile (192 m / 256 ≈ 65k slots, 0.75 m apart:
   *                            ferns are bigger than flowers, so fewer go further)
   */
  constructor({
    scene, renderer, heightTex, terrainNormalTex, densityTex, grassDensityTex, splatTex,
    riverNearTex = null, windTex, worldSize, fs, gp, tileSize = 192, plantsPerSide = 256,
    name = "Foliage", typeCount = FOLIAGE_TYPE_COUNT,
  }) {
    // Foliage runs 8 types on a 192 m tile; susuki runs this same system with
    // one type on a 400 m tile so its fields stay visible to ~195 m.
    this.typeCount = typeCount;
    const field = (this.field = new ScatterField({
      scene, renderer, name,
      typeCount, lods: FOLIAGE_LODS, rows: ROWS, ruleRow: RULE_ROW,
      worldSize, tileSize, plantsPerSide,
      heightTex, terrainNormalTex, densityTex, splatTex, riverNearTex, windTex, grassDensityTex,
      cullRadius: 5,   // a jungle fern is metres across, not centimetres
      shadows: true,   // tall plants cast (per type, near cascades only)
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

    // The susuki plume texture: hundreds of fine arcing strands drawn white,
    // used as the ALPHA of a plume card. Geometry cannot afford that detail, so
    // the one plant that needs it (pampas) gets its own material and pays the
    // alpha test; every other plant keeps plain early-depth-rejected geometry.
    const plumeCanvas = document.createElement("canvas");
    plumeCanvas.width = 256; plumeCanvas.height = 512;
    drawPlumeTexture(plumeCanvas, { texSpread: 54, texStrands: 420, texStrandLen: 0.34, texDroop: 0.6 });
    const plumeTex = new THREE.CanvasTexture(plumeCanvas);
    plumeTex.colorSpace = THREE.NoColorSpace;
    plumeTex.anisotropy = 8;
    plumeTex.needsUpdate = true;
    this._plumeTex = plumeTex;

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
        .mul(fade);

      const mag = length(vec2(d.x, d.y));
      const inv = float(1).div(max(mag, 1e-4));
      const bx = d.x.mul(inv), bz = d.y.mul(inv);
      // A fern is springier than a flower stem: it leans further for the same wind.
      const lean = mag.mul(1.25).add(hash(plant.add(313)).mul(0.1));

      const yaw = hash(plant.add(131)).mul(PI2);
      const cy = cos(yaw), sy = sin(yaw);

      // Leaflets flutter across their own width; the rachis only bends.
      const isLeaf = part.lessThan(0.5);
      const flutter = sin(time.mul(5.2).add(a.z.mul(29)).add(hash(plant).mul(13)))
        .mul(u.uFlutter).mul(0.06).mul(along).mul(select(isLeaf, float(1), float(0)));

      const local = yawRot(positionLocal.mul(size), cy, sy).add(vec3(0, flutter.mul(size), 0));
      const nLocal = yawRot(normalLocal, cy, sy);
      // Stiff at the base, loose at the top — the whole plant bows from the crown.
      const bendAngle = lean.mul(pow(max(t, 1e-4), 1.4));
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
    // (Almost all the way: game ferns are lit as a flat canopy; what little
    // geometric normal remains keeps the fronds from looking like paper.)
    const nLeaf = normalize(mix(nW, vec3(0, 1, 0), 0.95));
    const nLeafView = cameraViewMatrix.mul(vec4(nLeaf, 0)).xyz.normalize();
    // …and always toward the viewer: a frond hanging toward the camera shows
    // its underside, which must not go dark next to a lit neighbour.
    const nLeafFacing = select(nLeafView.z.lessThan(0), nLeafView.negate(), nLeafView);
    // Heads (part 2) are bodies of revolution, so half of one faces away from
    // the sun and goes muddy; they are soft and pale in life, so they get the
    // same canopy normal as the leaves. Only the stalk keeps its true normal.
    const isSoft = vPart.lessThan(0.5).or(vPart.greaterThan(1.5));
    mat.normalNode = select(isSoft,
      nLeafFacing,
      cameraViewMatrix.mul(vec4(nW, 0)).xyz.normalize().mul(faceDirection));

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
      leaf.mulAssign(float(0.94).add(vRand.mul(0.12)));
      // The stalk: only a little paler and yellower than the blade, and as
      // dark as the blade toward the crown.
      const stem = mix(r1.xyz, vec3(0.72, 0.8, 0.4), float(0.5))
        .mul(mix(float(0.5), float(1), smoothstep(0.0, 0.12, vHeight)));
      // The head (a cattail's sausage, a reed's plume): its own colour, a
      // little darker where it meets the stem and paler at the tip.
      const head = row(vType, 3).xyz.mul(mix(float(0.82), float(1.12), vAlong));
      const col = select(vPart.lessThan(0.5), leaf, select(vPart.lessThan(1.5), stem, head));
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
      const thin = select(vPart.lessThan(0.5), row(vType, 0).w, float(0));
      return col.mul(behind.mul(thin).mul(u.uTransMul).mul(0.9).add(u.uGlowLight));
    })();

    if (headTex) {
      // The plume's shape lives in the texture's alpha; everything else on the
      // plant is solid geometry and stays fully opaque.
      mat.opacityNode = Fn(() => {
        const a = select(vPart.greaterThan(1.5), texture(headTex, uv()).a, float(1));
        Discard(a.lessThan(0.4));
        return float(1);
      })();
      // The shadow pass ignores opacityNode: without this the plume casts
      // the whole card.
      mat.maskShadowNode = vPart.lessThan(1.5).or(texture(headTex, uv()).a.greaterThanEqual(0.4));
    }
    return mat;
    };

    const mat = makeMaterial(null);
    this._mat = mat;
    this._plumeMat = makeMaterial(plumeTex);

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
    this.field.rebuildType(i, (lod) => createFoliageTypeGeometry(type, { lod }));
    // Only the textured-plume plants pay for the alpha test.
    const mat = usesPlumeTexture(type.kind) ? this._plumeMat : this._mat;
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
      c.set(t.colorHead ?? t.colorTip); rows[o + 3].set(c.r, c.g, c.b, 0);
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
