/**
 * Meadow flowers — real petal geometry, placed and culled on the GPU.
 *
 * All the placement machinery (camera-following wrap tile, ONE compute pass for
 * paint, clumping, slope, rules, fade, frustum cull, near/far detail, wind and
 * player push, indirect draws sliced by `firstInstance`) is the shared scatter
 * field: v3/render/scatter/scatterField.js — which was first written here and
 * pulled out. This file is only what a flower IS: its per-type uniform rows,
 * its geometry and how it is shaded.
 *
 * Why geometry rather than alpha-masked cards: the petals' outline is exact at
 * every distance and never shimmers, MSAA smooths it like any mesh edge, and
 * no fragment is discarded, so hidden flowers are rejected by the depth test
 * before shading. See flowerGeometry.js.
 *
 * Per type, 5 uniform rows:
 *   0 (petalBase.rgb, translucency)
 *   1 (petalTip.rgb, size)
 *   2 (centre.rgb, stemHeight)
 *   3 (veins, 0, 0, 0)
 *   4 (heightMin, heightMax, paint layer or -1, river distance m or 0) — the rules
 */
import * as THREE from "three";
import {
  Fn,
  attribute,
  cameraPosition,
  cameraViewMatrix,
  cos,
  dot,
  exp,
  faceDirection,
  float,
  floor,
  fract,
  hash,
  instanceIndex,
  length,
  max,
  min,
  mix,
  normalLocal,
  normalize,
  pow,
  positionLocal,
  saturate,
  select,
  sin,
  smoothstep,
  step,
  time,
  uniform,
  uv,
  varying,
  vec2,
  vec3,
  vec4,
  PI2,
} from "three/tsl";
import { FLOWER_TYPE_COUNT } from "../../app/state/flowerState.js";
import { createFlowerTypeGeometry } from "./flowerGeometry.js";
import { ScatterField } from "../scatter/scatterField.js";
import { terrainShade, terrainSunVisibilityHere } from "../lighting/terrainSunShadow.js";

const LODS = 2;
const ROWS = 5; // uniform rows per type
const RULE_ROW = 4;

export class FlowerSystem {
  /**
   * @param {object} opts
   *   scene, renderer
   *   heightTex         RGBA float, .x = terrain world Y (grassHeightTex)
   *   terrainNormalTex  RGBA float, .xyz = terrain normal
   *   densityTex        masked flower density, one type per channel
   *   grassDensityTex   masked grass density (.x) — flowers rise above painted grass
   *   splatTex          SplatMap.tex — for the "grows on paint layer" rule
   *   riverNearTex      River v2 distance field (.r = distance² in UV), or null
   *   windTex           shared wind texture (grass / susuki)
   *   worldSize         terrain edge (m)
   *   fp                flower state (createFlowerState shape)
   *   gp                grassState (wind params, blade height)
   *   tileSize, plantsPerSide  wrap tile (default 192 m / 384 ≈ 147k slots, 0.5 m apart)
   */
  constructor({ scene, renderer, heightTex, terrainNormalTex, densityTex, grassDensityTex, splatTex, riverNearTex = null, windTex, worldSize, fp, gp, tileSize = 192, plantsPerSide = 384 }) {
    const field = (this.field = new ScatterField({
      scene, renderer, name: "Flowers",
      typeCount: FLOWER_TYPE_COUNT, lods: LODS, rows: ROWS, ruleRow: RULE_ROW,
      worldSize, tileSize, plantsPerSide,
      heightTex, terrainNormalTex, densityTex, splatTex, riverNearTex, windTex, grassDensityTex,
      cullRadius: 2,
    }));
    this.group = field.group;
    this.renderer = renderer;
    this.count = field.count;

    const u = (this.u = {
      uFlutter: uniform(0.6),
      uGlowLight: uniform(0.08),
      uTransMul: uniform(1),
      uSunDir: uniform(new THREE.Vector3(0.5, 0.8, 0.3).normalize()),
      uStemBase: uniform(new THREE.Color()),
      uStemTop: uniform(new THREE.Color()),
    });
    const { bufPos, bufDir, compactBuf } = field.nodes;
    const fu = field.u;

    // ── Material (shared by every draw) ──
    const mat = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide, roughness: 0.72, metalness: 0 });
    mat.envMapIntensity = 0.5;
    this._mat = mat;

    const vPart = varying(float(0), "v_fl_part");
    const vT = varying(float(0), "v_fl_t");
    const vType = varying(float(0), "v_fl_type");
    const vRand = varying(float(0), "v_fl_rand");
    const vPlant = varying(float(0), "v_fl_plant");
    const vWorld = varying(vec3(0), "v_fl_world");
    const vNormal = varying(vec3(0, 1, 0), "v_fl_normal");

    // ROUND the type, never truncate: an interpolated 1 can arrive as 0.99999.
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
      const id = instanceIndex.toVar();
      const plant = compactBuf.element(id);
      const p = bufPos.element(plant);
      const d = bufDir.element(plant);
      const a = attribute("aFlower", "vec4");
      const part = a.x, t = a.y, along = a.w;
      const r1 = row(p.z, 1);
      const r2 = row(p.z, 2);

      const fade = mix(float(0.3), float(1), d.z);
      const size = r1.w.mul(mix(float(1).sub(fu.uSizeVar), float(1).add(fu.uSizeVar), hash(plant.add(577)))).mul(fade);
      const hasStem = step(0.001, r2.w);
      // ±35%: a field of equal stems reads as planted lollipops.
      const stemH = r2.w.mul(mix(float(0.65), float(1.35), hash(plant.add(911)))).mul(fade).add(d.w.mul(hasStem));
      // Stemless blooms: their own small height each (overlapping neighbours
      // never share a depth) plus the grass they stand in.
      const groundLift = float(0.02).add(hash(plant.add(71)).mul(size).mul(0.25)).add(d.w).mul(float(1).sub(hasStem));

      const mag = length(vec2(d.x, d.y));
      const inv = float(1).div(max(mag, 1e-4));
      const bx = d.x.mul(inv), bz = d.y.mul(inv);
      // Capped like the foliage (see foliageSystem): a flower bows, it does
      // not lie flat when you stand on it.
      const lean = min(mag, float(0.8)).add(hash(plant.add(313)).mul(0.14));

      const yaw = hash(plant.add(131)).mul(PI2);
      const cy = cos(yaw), sy = sin(yaw);

      // Stem: thin tube, bending more toward its top, running into the bloom.
      const stemAngle = lean.mul(pow(max(t, 1e-4), 1.6));
      const radius = float(0.004).add(size.mul(0.022)).mul(hasStem);
      const stemPos = tilt(vec3(positionLocal.x.mul(radius), t.mul(stemH.add(size.mul(0.05))), positionLocal.z.mul(radius)), stemAngle, bx, bz);
      const stemN = tilt(normalLocal, stemAngle, bx, bz);

      // Bloom (petals + centre): sized, turned, flutter on the petals, riding the tip.
      const flutter = sin(time.mul(6.5).add(a.z.mul(31)).add(hash(plant).mul(17)))
        .mul(u.uFlutter).mul(0.05).mul(along).mul(step(part, 0.5));
      const bloomLocal = yawRot(positionLocal.mul(size), cy, sy).add(vec3(0, flutter.mul(size), 0));
      const tip = tilt(vec3(0, stemH, 0), lean, bx, bz);
      const bloomPos = tilt(bloomLocal, lean, bx, bz).add(tip);
      const bloomN = tilt(yawRot(normalLocal, cy, sy), lean, bx, bz);

      // Leaf: attached at its stem height, riding the bent stem.
      const leafAngle = lean.mul(pow(max(t, 1e-4), 1.6));
      const leafBase = tilt(vec3(0, t.mul(stemH), 0), leafAngle, bx, bz);
      const leafFlutter = sin(time.mul(4.2).add(a.z.mul(23)).add(hash(plant).mul(11))).mul(u.uFlutter).mul(0.03).mul(along);
      const leafLocal = yawRot(positionLocal.mul(size).mul(hasStem), cy, sy).add(vec3(0, leafFlutter.mul(size), 0));
      const leafPos = tilt(leafLocal, leafAngle.add(0.1), bx, bz).add(leafBase);
      const leafN = tilt(yawRot(normalLocal, cy, sy), leafAngle, bx, bz);

      const isStem = part.greaterThan(1.5).and(part.lessThan(2.5));
      const isLeaf = part.greaterThan(2.5);
      const pos = select(isLeaf, leafPos, select(isStem, stemPos, bloomPos));
      const nrm = select(isLeaf, leafN, select(isStem, stemN, bloomN));

      vPart.assign(part);
      vT.assign(select(part.lessThan(1.5), along, t));
      vType.assign(p.z);
      vRand.assign(a.z);
      vPlant.assign(hash(plant.add(3197)));
      vNormal.assign(nrm);
      const out = vec3(pos.x.add(p.x), pos.y.add(p.w).add(groundLift), pos.z.add(p.y));
      vWorld.assign(out.add(vec3(fu.uAnchorPos.x, 0, fu.uAnchorPos.z)));
      return out;
    })();

    // Smooth analytic normals, in view space, facing the camera on both sides.
    // Petals and leaves: bent halfway to UP and never flipped for back faces. A
    // true curved-petal normal lights a white daisy grey from the side and its
    // underside near black; foliage in games is lit "from above" so a bloom
    // reads bright from any angle. Stems and centres keep their real normal.
    const thin = vPart.lessThan(0.5).or(vPart.greaterThan(2.5));
    const nW = normalize(vNormal);
    const nThin = normalize(mix(nW, vec3(0, 1, 0), 0.55));
    mat.normalNode = select(thin,
      cameraViewMatrix.mul(vec4(nThin, 0)).xyz.normalize(),
      cameraViewMatrix.mul(vec4(nW, 0)).xyz.normalize().mul(faceDirection));

    const baseColor = Fn(() => {
      const r0 = row(vType, 0);
      const r1 = row(vType, 1);
      const r2 = row(vType, 2);
      const r3 = row(vType, 3);
      const c = uv();
      // Petal: base → tip, a soft midrib vein, darker at the root, per petal and per plant jitter.
      const along = vT;
      const petal = mix(r0.xyz, r1.xyz, smoothstep(0.0, 0.85, along)).toVar();
      const vein = exp(c.x.sub(0.5).mul(c.x.sub(0.5)).mul(-160)).mul(float(1).sub(along)).mul(r3.x);
      petal.mulAssign(float(1).sub(vein.mul(0.35)));
      petal.mulAssign(mix(float(0.62), float(1), smoothstep(0.0, 0.3, along)));
      petal.mulAssign(float(0.92).add(vRand.mul(0.16)));
      // Centre: seeds speckle, darker rim.
      const cr = length(c.sub(0.5)).mul(2);
      const speckle = step(0.62, fract(sin(dot(floor(c.mul(22)), vec2(12.9898, 78.233))).mul(43758.5453)));
      const centre = r2.xyz.mul(mix(float(1.15), float(0.7), cr)).mul(float(1).sub(speckle.mul(0.25)));
      // Stem and leaf.
      const stem = mix(u.uStemBase, u.uStemTop, vT);
      const leaf = mix(u.uStemBase, u.uStemTop, float(0.35).add(uv().y.mul(0.5)))
        .mul(float(0.85).add(exp(c.x.sub(0.5).mul(c.x.sub(0.5)).mul(-200)).mul(0.25)));
      const col = select(vPart.lessThan(0.5), petal, select(vPart.lessThan(1.5), centre, select(vPart.lessThan(2.5), stem, leaf)));
      const j = vPlant.sub(0.5).mul(2).mul(fu.uColorVar);
      return col.mul(vec3(float(1).add(j), float(1).add(j.mul(0.4)), float(1).sub(j.mul(0.3))));
    });
    const col = baseColor();
    // Mountain shade: see foliageSystem.js — same two halves.
    const sunVis = terrainSunVisibilityHere();
    mat.colorNode = terrainShade(col, sunVis);
    mat.terrainSunShadowNode = sunVis;   // shared with the sun's shadow term: one read

    // Light through petals and leaves when the sun is behind them.
    mat.emissiveNode = Fn(() => {
      const V = normalize(cameraPosition.sub(vWorld));
      const behind = pow(saturate(dot(V, u.uSunDir.negate())), 3).mul(sunVis);
      const thin = select(vPart.lessThan(0.5), row(vType, 0).w, select(vPart.greaterThan(2.5), float(0.45), float(0)));
      return col.mul(behind.mul(thin).mul(u.uTransMul).mul(1.4).add(u.uGlowLight));
    })();

    field.attachMaterial(mat);
    for (let i = 0; i < FLOWER_TYPE_COUNT; i++) this.rebuildType(i, fp.types[i]);
    this.syncFromState(fp, gp);
  }

  get meshes() { return this.field.meshes; }
  get triangles() { return this.field.triangles; }

  /** Rebuild one type's near + far meshes after a shape setting changed. */
  rebuildType(i, type) {
    this.field.rebuildType(i, (lod) => createFlowerTypeGeometry(type, { lod }));
  }

  init(camera) { return this.field.init(camera); }
  setEnabled(on) { this.field.setEnabled(on); }
  update(anchorPos, camera) { this.field.update(anchorPos, camera); }

  /**
   * fp = flower state, gp = grassState (shared wind, blade height), sunDir
   * toward the sun. `hasRivers` false means the world has no River v2 river, so
   * a "grows near water" rule could never be satisfied and is ignored.
   */
  syncFromState(fp, gp, sunDir, { hasRivers = true } = {}) {
    this.field.syncCommon({
      wind: gp ? { ...gp, windMul: fp.windMul } : null,
      density: fp.density,
      sizeVar: fp.sizeVar,
      colorVar: fp.colorVar,
      clumping: fp.clumping,
      clumpSize: fp.clumpSize,
      grassLift: fp.grassLift,
      flex: fp.flex,
      interactRadius: fp.interactRadius,
      interactStrength: fp.interactStrength,
      lodDistance: fp.lodDistance,
      fadeStart: fp.fadeStart,
      fadeEnd: fp.fadeEnd,
      slopeMinY: fp.slopeMinY,
    });
    const u = this.u;
    u.uFlutter.value = fp.flutter;
    u.uGlowLight.value = fp.glowLight;
    u.uTransMul.value = fp.translucencyMul;
    u.uStemBase.value.set(fp.stemBase);
    u.uStemTop.value.set(fp.stemTop);
    if (sunDir) u.uSunDir.value.copy(sunDir).normalize();

    const c = new THREE.Color();
    const rows = this.field.typeRows;
    for (let i = 0; i < FLOWER_TYPE_COUNT; i++) {
      const t = fp.types[i];
      const o = i * ROWS;
      c.set(t.petalBase); rows[o].set(c.r, c.g, c.b, t.translucency);
      c.set(t.petalTip);  rows[o + 1].set(c.r, c.g, c.b, t.size);
      c.set(t.centre);    rows[o + 2].set(c.r, c.g, c.b, t.stemHeight);
      rows[o + 3].set(t.veins, 0, 0, 0);
      rows[o + 4].set(t.heightMin ?? -1e5, t.heightMax ?? 1e5, t.onLayer ?? -1, hasRivers ? (t.nearRiver ?? 0) : 0);
    }
    this.field.setReceiveShadows(fp.receiveShadows);
  }
}
