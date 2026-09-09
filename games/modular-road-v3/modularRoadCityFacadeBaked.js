// CITY FACADE, BAKED — the same wall, read from a texture instead of solved.
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
//
// MEASURED: the city's ~29 s first-frame wait is almost entirely the GPU driver
// compiling WGSL. `city.stats.lastBuildMs` is 69 ms for 2106 buildings, so it is
// not JS, and the network is 6.46 MB, so it is not the wire.
//
// And the shader is big because of ONE thing. The near facade generates 4833
// lines; the far one, which differs by having no ray-cast reveal, no interior
// rooms, no per-brick bump and no normalNode, generates 1584. So the analytic
// trace and its normal pass are ~67% of the shader — and the trace is emitted
// TWICE, because three always builds `normalNode` in its own sub-build and it
// re-runs the same solve.
//
// Splitting the facade per building type was tried first and measured wrong:
// each pipeline shrank 8-31%, but the driver ended up compiling 11057 lines
// instead of 4833, because the city draws all three types at once. See
// `facadeTypeSplit` in modularRoadCity.js.
//
// ── THE IDEA ─────────────────────────────────────────────────────────────────
//
// Run the existing facade ONCE, into a texture, and have the runtime shader
// sample it. The relief survives — as a height map read by parallax occlusion
// mapping, which is what a shipped AAA facade actually does — but the closed-
// form trace, the room raymarch and the brick hashing all leave the runtime
// shader entirely.
//
// Nothing is downloaded. The atlas is BAKED FROM THE PROCEDURAL SHADER at load,
// so this costs zero bytes on the wire — which matters, because getting boot
// from 119 MB to 9.45 MB was most of a day and shipping facade textures would
// hand it straight back.
//
// ── WHAT IS STILL SOLVED AT RUNTIME, AND WHY ─────────────────────────────────
//
// The FACE SOLVE stays. A baked tile is a rhythm of bays and floors in metres;
// mapping it onto a face still needs to know how many metres wide that face is,
// and that is the screen-derivative trick the analytic facade already uses —
// it is what gives every setback tier a pier at both ends without the shader
// knowing the footprint. It is also cheap: it is in the 1584-line far shader.
//
// The PER-LOT VARIATION stays, and has to. A city where every tower samples the
// same tile is a wallpaper city. Tint, grime, the lit-window churn and the tile
// choice are all per-lot hashes, and they are a handful of instructions.
//
// ── STATUS: A SPIKE ──────────────────────────────────────────────────────────
//
// This is here to answer ONE question — how small does the runtime shader get —
// before committing to the bake pass that fills the atlas. The textures below
// are placeholders sized like the real thing. Nothing in the game uses this yet.

import * as THREE from "three";
import {
  Fn, If, Loop, float, vec2, vec3, vec4, uniform, uniformArray, texture, uv,
  positionWorld, normalWorldGeometry, cameraPosition, dFdx, dFdy, abs, max, min,
  floor, fract, dot, normalize, select, mix, smoothstep, clamp, step, sign,
  textureLoad, ivec2, log2, pow,
} from "three/tsl";
import { applyBloomMRT } from "../../v3/render/bloomMRT.js";

export const BAKED_FACADE_DEFAULTS = {
  /** Metres per lot — the grid the per-building hashes are keyed on. */
  lotSize: 34,
  groundY: 0,
  /** Atlas layout: `tiles` styles across, one row per building type. */
  tiles: 4,
  types: 3,
  /** One tile is one BAY by one FLOOR, so the rhythm is in the mapping. */
  bayWidth: 4.2,
  floorHeight: 3.6,
  /**
   * How deep the height map reads, in metres.
   *
   * This is the whole reason to keep parallax: a facade with no depth reads as
   * a decal at the near distances a car actually drives past at.
   */
  reliefDepth: 0.55,
  /** POM steps at the closest LOD, falling to 1 as the wall gets small. */
  reliefSteps: 20,
  /** Beyond this many texels per pixel the march is pointless — flat sample. */
  reliefFade: 2.2,
  wallRough: 0.72,
  grime: 0.35,
  emissive: 2.4,
  envIntensity: 1.0,
};

const ATLAS_PX = 512;

/**
 * Build the baked-facade material.
 *
 * @param {object}  [opts]
 * @param {object}  [opts.params]      overrides on BAKED_FACADE_DEFAULTS
 * @param {THREE.Texture} [opts.albedoHeight] RGB albedo, A = height (1 = front)
 * @param {THREE.Texture} [opts.normalMask]   RG = normal.xy, B = rough, A = lit
 * @param {THREE.Texture} [opts.lotTexture]   the city's lot field, R/G/B/A =
 *                                            base, top, district, type
 */
export function createBakedFacadeMaterial({
  params: overrides = {},
  albedoHeight = null,
  normalMask = null,
  lotTexture = null,
} = {}) {
  const P = { ...BAKED_FACADE_DEFAULTS, ...overrides };

  // Placeholders so this builds standalone. The bake pass replaces them; the
  // shader does not know or care which it got.
  const blank = (n, fill) => {
    const px = new Uint8Array(ATLAS_PX * ATLAS_PX * 4).fill(fill);
    const t = new THREE.DataTexture(px, ATLAS_PX, ATLAS_PX, THREE.RGBAFormat);
    t.name = n;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.needsUpdate = true;
    return t;
  };
  const albedoTex = albedoHeight || blank("FacadeAtlasAlbedoHeight", 200);
  const maskTex = normalMask || blank("FacadeAtlasNormalMask", 128);
  const lotTex = lotTexture || (() => {
    const t = new THREE.DataTexture(new Float32Array(4), 1, 1, THREE.RGBAFormat, THREE.FloatType);
    t.magFilter = t.minFilter = THREE.NearestFilter;
    t.needsUpdate = true;
    return t;
  })();

  const u = {};
  for (const [k, v] of Object.entries(P)) if (typeof v === "number") u[k] = uniform(v);
  const uTime = uniform(0);
  const uLotOrigin = uniform(new THREE.Vector2(0, 0));
  const uLotCount = uniform(new THREE.Vector2(1, 1));
  const uTint = uniformArray([
    new THREE.Color(0xb9b2a6), new THREE.Color(0x9aa3a8), new THREE.Color(0xc4b7a4),
    new THREE.Color(0x8f9aa2), new THREE.Color(0xd0c8b8), new THREE.Color(0x7f8b93),
  ]);

  /** One PCG-ish round, same shape as the analytic facade's, so the two agree. */
  const hash21 = Fn(([p]) => {
    const q = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
    return fract(vec2(q.x.sin(), q.y.sin()).mul(43758.5453)).x;
  });

  /**
   * EVERY DERIVATIVE IN ONE PLACE, at function top level.
   *
   * The march below is inside a loop and a branch, and a derivative taken in
   * non-uniform control flow is undefined. Same rule the analytic facade
   * follows, same reason — and here it is doubly load-bearing, because the
   * texture LOD is computed from these and then fed to an explicit
   * `.level()`, since an implicit-LOD sample inside a loop is illegal too.
   */
  function frame() {
    const nW = normalize(normalWorldGeometry).toVar();
    const isRoof = abs(nW.y).greaterThan(0.5).toVar();
    const uAxis = normalize(vec3(nW.z, 0.0, nW.x.negate()).add(vec3(1e-5, 0.0, 0.0))).toVar();

    const pdx = dFdx(positionWorld).toVar(), pdy = dFdy(positionWorld).toVar();
    const t = uv().toVar();
    const udx = dFdx(t.x).toVar(), udy = dFdy(t.x).toVar();
    const vdx = dFdx(t.y).toVar(), vdy = dFdy(t.y).toVar();

    // FACE SIZE IN METRES from the ratio of world-position derivatives to box-UV
    // derivatives — on a planar face both are linear in screen space, so the
    // ratio IS the face width. See the analytic facade's note; this is the same
    // trick and the reason a baked tile can be laid on any tier at any scale.
    const ufw = abs(udx).add(abs(udy)).max(1e-7).toVar();
    const vfw = abs(vdx).add(abs(vdy)).max(1e-7).toVar();
    const adx = dot(pdx, uAxis).toVar(), ady = dot(pdy, uAxis).toVar();
    const W = abs(adx).add(abs(ady)).div(ufw).clamp(0.5, 400.0).toVar();
    const Hf = abs(pdx.y).add(abs(pdy.y)).div(vfw).clamp(0.5, 700.0).toVar();
    const sU = adx.mul(udx).add(ady.mul(udy));
    const sV = pdx.y.mul(vdx).add(pdy.y.mul(vdy));
    const u0 = select(sU.greaterThan(0.0), t.x, float(1.0).sub(t.x)).mul(W).toVar();
    const v0 = select(sV.greaterThan(0.0), t.y, float(1.0).sub(t.y)).mul(Hf).toVar();
    const mpxU = ufw.mul(W).toVar();
    const mpxV = vfw.mul(Hf).toVar();

    const lot = floor(positionWorld.xz.div(u.lotSize)).toVar();
    const cell = clamp(lot.sub(uLotOrigin), vec2(0.0), uLotCount.sub(1.0));
    const info = textureLoad(lotTex, ivec2(cell)).toVar();
    const baseY = info.r, btype = info.a;
    const bldgH = max(info.g.sub(info.r), float(1.0)).toVar();
    const h1 = hash21(lot).toVar();
    const h2 = fract(h1.mul(197.31)).toVar();
    const h3 = fract(h1.mul(419.77)).toVar();

    // Bays and floors stretched so the tile rhythm lands whole on the face —
    // both ends of every face get a pier, exactly as the analytic one does.
    const count = max(floor(W.div(u.bayWidth)), 1.0).toVar();
    const bay = W.div(count).toVar();
    const nF = max(floor(Hf.div(u.floorHeight)).max(1.0), 1.0).toVar();
    const fh = Hf.div(nF).toVar();

    const up = positionWorld.y.sub(baseY).toVar();
    return { nW, isRoof, uAxis, W, Hf, u0, v0, mpxU, mpxV, lot, h1, h2, h3, bay, fh, up, bldgH, btype };
  }

  /** Tile origin in atlas UV, from the building type and a per-lot style roll. */
  function tileBase(F) {
    const style = floor(F.h2.mul(u.tiles.sub(0.001))).toVar();
    const row = clamp(floor(F.btype.add(0.5)), float(0.0), u.types.sub(1.0)).toVar();
    return vec2(style.div(u.tiles), row.div(u.types)).toVar();
  }

  /**
   * PARALLAX OCCLUSION — the relief, kept.
   *
   * The analytic facade intersects a ray with closed-form rectangles, which is
   * exact and costs ~3200 lines of straight-line WGSL. This marches a height
   * map instead: a loop the driver compiles once, with a texture fetch and a
   * compare in it. Not free at run time, far cheaper to compile, and it can
   * represent shapes the closed form cannot — which is the reason a shipped
   * facade uses one.
   *
   * Steps fall off with texel density, and below `reliefFade` the march is
   * skipped entirely: at that size the offset is under a pixel.
   */
  function relief(F, tile, lod) {
    const inTile = vec2(fract(F.u0.div(F.bay)), fract(F.v0.div(F.fh))).toVar();
    const scale = vec2(float(1.0).div(u.tiles), float(1.0).div(u.types)).toVar();
    const atlasUV = tile.add(inTile.mul(scale)).toVar();

    const V = normalize(positionWorld.sub(cameraPosition)).toVar();
    // Tangent-space ray. `up` is the face's vertical because a building face is
    // always vertical — there is no need for a general TBN here.
    const ru = dot(V, F.uAxis).toVar();
    const rv = V.y.toVar();
    const rn = dot(V, F.nW).abs().max(0.08).toVar();

    // Total UV offset across the full relief depth, in TILE units then atlas.
    const offs = vec2(ru.div(rn).mul(u.reliefDepth).div(F.bay),
      rv.div(rn).mul(u.reliefDepth).div(F.fh)).mul(scale).toVar();

    const density = max(F.mpxU.div(F.bay), F.mpxV.div(F.fh)).mul(float(ATLAS_PX)).toVar();
    const steps = clamp(u.reliefSteps.mul(smoothstep(u.reliefFade, float(0.2), density)),
      float(1.0), u.reliefSteps).toVar();

    const hitUV = atlasUV.toVar();
    const depth = float(0.0).toVar();
    const done = float(0.0).toVar();

    If(steps.greaterThan(1.5), () => {
      const dt = float(1.0).div(steps).toVar();
      const prevUV = atlasUV.toVar();
      const prevH = float(1.0).toVar();
      const prevT = float(0.0).toVar();
      Loop({ start: 1, end: u.reliefSteps, type: "int", condition: "<=" }, ({ i }) => {
        If(done.lessThan(0.5).and(float(i).lessThanEqual(steps)), () => {
          const t = float(i).mul(dt).toVar();
          const sUV = atlasUV.add(offs.mul(t)).toVar();
          // EXPLICIT LOD. An implicit-derivative sample cannot sit inside a
          // loop or a branch — the derivative is undefined there, and on some
          // backends it is a compile error rather than a wrong pixel.
          const h = texture(albedoTex, sUV).level(lod).a.toVar();
          const rayH = float(1.0).sub(t).toVar();
          If(h.greaterThanEqual(rayH), () => {
            // One linear refine between the last miss and this hit. A second
            // pass would cost another fetch for a difference nobody sees at
            // the speed this game moves.
            const a = prevH.sub(float(1.0).sub(prevT));
            const b = h.sub(rayH);
            const w = a.div(max(a.sub(b), 1e-5)).clamp(0.0, 1.0);
            const tHit = mix(prevT, t, w);
            hitUV.assign(atlasUV.add(offs.mul(tHit)));
            depth.assign(tHit);
            done.assign(1.0);
          });
          prevUV.assign(sUV);
          prevH.assign(h);
          prevT.assign(t);
        });
      });
    });
    return { hitUV, depth, atlasUV };
  }

  const R = {};

  const surface = Fn(() => {
    const F = frame();
    // The LOD, computed OUTSIDE every branch and loop below. See `frame`.
    const lod = log2(max(F.mpxU.div(F.bay), F.mpxV.div(F.fh))
      .mul(float(ATLAS_PX)).max(1e-4)).max(0.0).toVar();

    const tile = tileBase(F);
    const { hitUV, depth } = relief(F, tile, lod);

    const alb = texture(albedoTex, hitUV).level(lod).toVar();
    const msk = texture(maskTex, hitUV).level(lod).toVar();

    // PER-LOT VARIATION, or it is wallpaper. A palette pick, a small tint
    // spread, and grime that climbs the building the way weather actually
    // leaves it — all per-lot hashes, all a few instructions.
    const tint = uTint.element(floor(F.h1.mul(5.999))).toVar();
    const grimeAmt = u.grime.mul(smoothstep(F.bldgH, float(0.0), F.up))
      .mul(float(0.6).add(F.h3.mul(0.8))).toVar();
    const col = mix(alb.rgb.mul(tint), vec3(0.16, 0.15, 0.14), grimeAmt)
      .mul(float(0.88).add(F.h2.mul(0.24))).toVar();

    // Lit windows: the mask says WHERE glass is, a per-cell hash and the clock
    // say which are on. Same churn the analytic facade runs, same cost.
    const cellId = vec2(floor(F.u0.div(F.bay)), floor(F.v0.div(F.fh)));
    const wh = hash21(cellId.add(F.lot.mul(31.7))).toVar();
    const churn = fract(wh.mul(7.13).add(uTime.mul(0.017))).toVar();
    const lit = msk.a.mul(step(churn, float(0.34))).toVar();

    R.rough = mix(msk.b.mul(u.wallRough), float(0.28), msk.a).toVar();
    R.emissive = vec3(1.0, 0.86, 0.66).mul(lit).mul(u.emissive).toVar();
    // Self-occlusion straight off the march: deeper into the wall is darker.
    R.ao = float(1.0).sub(depth.mul(0.45)).toVar();
    R.normalXY = msk.rg.mul(2.0).sub(1.0).toVar();
    R.frame = F;
    return col;
  });

  const material = new THREE.MeshStandardNodeMaterial();
  material.name = "CityFacadeBaked";
  material.envMapIntensity = P.envIntensity;
  material.colorNode = surface();
  material.roughnessNode = Fn(() => R.rough)();
  material.metalnessNode = float(0.0);
  material.emissiveNode = Fn(() => R.emissive)();
  material.aoNode = Fn(() => R.ao)();
  /*
   * THE NORMAL IS READ, NOT RE-SOLVED.
   *
   * This is the second half of the saving and it is easy to miss. three always
   * builds `normalNode` in its OWN sub-build, so it cannot share the colour
   * pass's flow — whatever it does, it does again from scratch. In the analytic
   * facade that means the whole face solve AND the whole ray cast are emitted
   * twice. Here it is two texture channels and a cross product.
   */
  material.normalNode = Fn(() => {
    const F = frame();
    const lod = log2(max(F.mpxU.div(F.bay), F.mpxV.div(F.fh))
      .mul(float(ATLAS_PX)).max(1e-4)).max(0.0).toVar();
    const tile = tileBase(F);
    const { hitUV } = relief(F, tile, lod);
    const nxy = texture(maskTex, hitUV).level(lod).rg.mul(2.0).sub(1.0).toVar();
    const nz = float(1.0).sub(nxy.x.mul(nxy.x)).sub(nxy.y.mul(nxy.y)).max(0.0).sqrt();
    const up = vec3(0.0, 1.0, 0.0);
    return normalize(F.uAxis.mul(nxy.x).add(up.mul(nxy.y)).add(F.nW.mul(nz)));
  })();

  applyBloomMRT(material, Fn(() => vec4(R.emissive, 1.0))());

  const params = new Proxy(P, {
    set(target, key, value) {
      target[key] = value;
      if (key === "envIntensity") { material.envMapIntensity = value; return true; }
      if (u[key]) u[key].value = value;
      return true;
    },
  });

  return {
    material,
    params,
    uniforms: u,
    atlas: { albedoHeight: albedoTex, normalMask: maskTex },
    setTime(t) { uTime.value = t; },
    setLotOrigin(cellX, cellZ, countX, countZ) {
      uLotOrigin.value.set(cellX, cellZ);
      uLotCount.value.set(countX, countZ);
    },
    dispose() {
      material.dispose();
      if (!albedoHeight) albedoTex.dispose();
      if (!normalMask) maskTex.dispose();
    },
  };
}
