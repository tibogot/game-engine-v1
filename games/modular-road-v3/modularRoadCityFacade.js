// ============================================================================
// CITY FACADE — one material for every building in the city, with no
// per-instance attributes at all.
//
// ── WHY NO ATTRIBUTES ────────────────────────────────────────────────────────
//
// The obvious design is an instanced attribute per tower carrying its tint, its
// window seed and its floor height. It is also the design that locks the city
// to ONE batching backend, because the three ways to carry per-instance data
// are all backend-specific and all have a catch:
//
//   • InstancedMesh + InstancedBufferAttribute — fine, but does not survive a
//     move to BatchedMesh.
//   • BatchedMesh.setColorAt() — NodeMaterial multiplies `vBatchColor` straight
//     into colorNode (NodeMaterial.js, "if object.isBatchedMesh && _colorsTexture"),
//     exactly like `instanceColor`. Smuggling non-colour data through it
//     corrupts the diffuse. Same trap modularRoadPropInstancer documents for
//     liveried parts.
//   • BatchedMesh + your own DataTexture — needs the batch's `_indirectTexture`
//     to map instanceIndex -> logical instance (on WebGPU `getDrawIndex()`
//     returns null, so BatchNode falls back to instanceIndex). Private API.
//
// So all the variation is derived from POSITION instead, and the material stops
// caring which backend drew it:
//
//   • WHICH BUILDING  — the lot cell, `floor(worldXZ / lotSize)`. Constant over
//     a building because a building is inset inside its lot.
//   • HEIGHT UP THE FACADE — `worldY - lotBaseY`, in metres. Floor spacing is
//     therefore CONSTANT no matter how far an instance is stretched in Y.
//   • ACROSS THE FACADE — `positionGeometry.xz`, the untouched vertex attribute.
//     NOT positionLocal: InstanceNode and BatchNode both `positionLocal.assign()`
//     the instance-transformed position (InstanceNode.js:188, BatchNode.js:134),
//     so by fragment time positionLocal is world space.
//
// ── THE LOT TEXTURE: PER-BUILDING DATA WITHOUT PER-INSTANCE DATA ─────────────
//
// One texel per lot cell, indexed by the `floor(worldXZ / lotSize)` the shader
// already computes, read with `textureLoad` (a load, not a sample — no sampler
// binding, so it never touches the 16-samplers-per-stage ceiling):
//
//     R  base Y of the building on this lot (metres)
//     G  top  Y of the building on this lot (metres)
//     B  district: 0 downtown glass · 1 midtown masonry · 2 low industrial
//     A  spare
//
// Allocated ONCE at a fixed size and rewritten in place (a TextureNode whose
// `.value` changes size is the swap three's node cache mishandles). Cells
// outside `lotOrigin/lotCount` clamp to the edge texel.
//
// ── INTERIOR MAPPING, WITHOUT THE ATTRIBUTES ─────────────────────────────────
//
// The three.js city generator's best trick is a ray-marched fake room behind
// every pane — walls, floor, ceiling, a light, furniture — with no geometry.
// It needs two baked attributes per glass vertex (`roomCenter`, `roomSize`)
// because its windows are geometry. Ours are a procedural cell grid, so the
// room box IS the cell: `[colIdx, colIdx+1] × [floorIdx, floorIdx+1] × depth`.
// The intersection is analytic (three divides, one min), the room's contents
// are hashes, and the whole thing rides the same `sharp` dissolve as the
// window mask — full rooms in the near ring, flat glass beyond. Zero
// attributes, both backends, one branch-free block.
//
// ── ALIASING IS THE WHOLE JOB ────────────────────────────────────────────────
//
// Every repeating pattern here (windows, bricks, piers, the room interiors)
// measures its own cells-per-pixel with `fwidth` and DISSOLVES to its mean as
// it goes subpixel — the LED-panel technique from v2/objects/shared/ledMatrix.js.
// A far tower converges to a flat tinted slab, which is what a far tower is.
//
// ── NODE MATERIAL, NOT PLAIN ─────────────────────────────────────────────────
//
// Static world geometry with a plain material never re-uploads scene fog
// uniforms on WebGPU (modularRoadScenery.js). A colorNode keeps the haze live.
// ============================================================================
import * as THREE from "three";
import {
  Fn, If, float, vec2, vec3, vec4, uniform, select, mix, smoothstep, max, min, abs,
  floor, fract, dot, sin, clamp, ivec2, positionGeometry, positionWorld,
  normalGeometry, cameraPosition, fwidth, step, textureLoad, normalize, sign,
} from "three/tsl";
import { applyBloomMRT } from "../../v3/render/bloomMRT.js";

/** Lot texture edge, in cells. 160 × 34 m = 5.4 km of city per axis. */
export const LOT_TEX_SIZE = 160;

/** District ids written into the lot texture's B channel. */
export const DISTRICT = { glass: 0, masonry: 1, industrial: 2 };

/**
 * Facade defaults, in metres and 0..1 fractions. Everything here is a uniform,
 * so the lab can drag any of it without a shader recompile.
 */
export const FACADE_DEFAULTS = {
  /** Storey height. Real towers are 3.3–4.2 m; this is what sets the SCALE read. */
  floorHeight: 3.7,
  /** Horizontal window pitch. */
  colWidth: 2.6,
  /** Window size as a fraction of its cell. Lower = fatter mullions/spandrel. */
  winW: 0.62,
  winH: 0.54,
  /** Ground-floor lobby band — taller, glassier, no horizontal mullions. */
  lobbyHeight: 7.5,

  /** Lot pitch. MUST match the layout's lotSize or the per-building hash smears. */
  lotSize: 34,
  /** World Y the city stands on when no lot texture has been written. */
  groundY: 0,

  /** Wall palette — six entries, hard-picked per building by the lot hash. */
  wallColorA: 0x8a8378,
  wallColorB: 0x6d6a66,
  wallColorC: 0xa89a82,
  wallColorD: 0x4e5359,
  wallColorE: 0x7a5a4c,
  wallColorF: 0x2e3238,
  /** Glass base tint (before the per-window brightness jitter). */
  glassColor: 0x2b3a4a,
  /** Roof / ledge tops — gravel and plant, never glass. */
  roofColor: 0x35353a,

  wallRough: 0.82,
  glassRough: 0.12,
  /** Metalness of a pane WITHOUT an interior (far) and WITH one (near). A
   *  metal has no diffuse, so a room behind the glass needs the pane to stop
   *  being metal or the room goes black. */
  glassMetal: 0.55,
  interiorMetal: 0.12,

  /** Grime / AO darkening at the base of every wall, and how far up it fades. */
  baseGrime: 0.30,
  baseGrimeHeight: 30,
  /** Darkening of the wall in a thin ring around each window — a recess. */
  recessAO: 0.28,
  /** Vertical pier relief on the column grid: width (cell fraction), strength. */
  pierWidth: 0.10,
  pierRelief: 0.14,
  /** Spandrel (floor-slab) band darkening at each floor line. */
  spandrel: 0.18,

  /** Masonry district: brick pitch (m), mortar width (fraction), tint spread. */
  brickW: 0.62,
  brickH: 0.28,
  mortar: 0.10,
  brickTint: 0.16,

  /** Interior mapping: 0 = flat glass, 1 = full rooms. Room depth in metres. */
  interior: 1.0,
  roomDepth: 4.2,
  /** Fraction of rooms with curtains drawn (an opaque pane, no room). */
  curtains: 0.28,

  /** 0 = day, 1 = night. Drives the lit windows only; not a light. */
  nightAmount: 0,
  /** Fraction of windows lit at full night. Also the far-distance average. */
  litFraction: 0.30,
  litWarm: 0xffd9a0,
  litCool: 0xcfe4ff,
  emissiveBoost: 2.6,
  /** Fraction of storeys that are wholly dark (vacant floors). Cheap realism. */
  darkFloors: 0.22,
  /** Window churn: a window changes state roughly every `churnPeriod` seconds,
   *  each on its own phase. 0 disables. */
  churnPeriod: 45,

  /** Crown lights: a lit band under the roofline of some towers at night. */
  crownFraction: 0.45,
  crownHeight: 1.6,
  crownBoost: 5.0,

  /** Screen-space dissolve band, in window-cells per pixel. 1 -> 0 between them. */
  lodSharp: 0.50,
  lodFlat: 0.12,

  /** Per-window glass brightness spread — the anti-"sheet of one colour" knob. */
  glassJitter: 0.35,
  /** Sky gradient inside each pane, bottom -> top. */
  paneGradient: 0.45,
};

/** 0..1 hash of a vec2. Positions here are bounded (lot cells, ~±100), so the
 *  classic sin-fract hash keeps full precision — no large-argument sin blowup. */
const hash21 = /*#__PURE__*/ Fn(([p]) => {
  return fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453));
});

/** 0..1 hash of a vec3 — lot cell + floor + column. */
const hash31 = /*#__PURE__*/ Fn(([p]) => {
  return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))).mul(43758.5453));
});

/**
 * Build the city facade material.
 *
 * @param {object}  [opts]
 * @param {object}  [opts.params] overrides on FACADE_DEFAULTS
 */
export function createCityFacadeMaterial({ params: overrides = {} } = {}) {
  const P = { ...FACADE_DEFAULTS, ...overrides };

  // ── Lot texture ────────────────────────────────────────────────────────────
  const lotData = new Float32Array(LOT_TEX_SIZE * LOT_TEX_SIZE * 4);
  const lotTexture = new THREE.DataTexture(
    lotData, LOT_TEX_SIZE, LOT_TEX_SIZE, THREE.RGBAFormat, THREE.FloatType,
  );
  lotTexture.name = "CityLotHeights";
  lotTexture.magFilter = lotTexture.minFilter = THREE.NearestFilter;
  lotTexture.generateMipmaps = false;
  lotTexture.colorSpace = THREE.NoColorSpace;
  lotTexture.flipY = false;
  const uLotOrigin = uniform(new THREE.Vector2(0, 0));
  const uLotCount = uniform(new THREE.Vector2(1, 1));

  function clearLots(baseY) {
    for (let i = 0; i < LOT_TEX_SIZE * LOT_TEX_SIZE; i++) {
      lotData[i * 4] = baseY;
      lotData[i * 4 + 1] = baseY;   // top == base: "no building here"
      lotData[i * 4 + 2] = 0;
      lotData[i * 4 + 3] = 0;
    }
    lotTexture.needsUpdate = true;
  }
  clearLots(P.groundY);

  // ── Uniforms ───────────────────────────────────────────────────────────────
  // Every numeric param becomes a uniform. Colours are the ones NAMED as
  // colours — `wallColorA..F`, `glassColor`, `roofColor`, `litWarm/litCool`.
  // The suffix letter matters: `/Color$/` alone silently made the six palette
  // entries FLOAT uniforms of ~9,000,000 and painted every wall blinding white.
  const isColorKey = (k) => /Color[A-F]?$|^lit(Warm|Cool)$/.test(k);
  const u = {};
  for (const [k, v] of Object.entries(P)) {
    if (typeof v === "number") u[k] = uniform(isColorKey(k) ? new THREE.Color(v) : v);
  }
  const uTime = uniform(0);

  // ── The shared surface solve ───────────────────────────────────────────────
  // ONE solve, four readers (color / roughness / metalness / emissive). A plain
  // function, NOT an `Fn`: an Fn returning an object collapses it to a single
  // node and every property read becomes a swizzle — `s.color` comes back
  // undefined and the slots go unwired. Corollary: no assign operators in here
  // (they need a TSL stack); `toVar()` is fine.
  function solveSurface() {
    // WHICH FACE, in GEOMETRY space so it stays consistent with positionGeometry.
    const n = normalGeometry;
    const isRoof = abs(n.y).greaterThan(0.5);
    const facingX = abs(n.x).greaterThan(abs(n.z));
    const across = select(facingX, positionGeometry.z, positionGeometry.x).toVar();
    // World axis the facade runs along, and the inward direction, for the rays.
    const acrossAxis = select(facingX, vec3(0.0, 0.0, 1.0), vec3(1.0, 0.0, 0.0));
    const inward = vec3(n.x, 0.0, n.z).negate();

    // WHICH BUILDING.
    const lot = floor(positionWorld.xz.div(u.lotSize)).toVar();
    const bh = hash21(lot).toVar();
    const bh2 = hash21(lot.add(vec2(17.3, 41.7))).toVar();
    const bh3 = hash21(lot.add(vec2(-9.1, 23.9))).toVar();

    // WHERE IT STANDS, HOW TALL, WHICH DISTRICT — the lot texture.
    const cell = clamp(lot.sub(uLotOrigin), vec2(0.0), uLotCount.sub(1.0));
    const lotInfo = textureLoad(lotTexture, ivec2(cell)).toVar();
    const baseY = lotInfo.r;
    const bldgH = max(lotInfo.g.sub(lotInfo.r), float(1.0));
    const district = lotInfo.b;
    const isMasonry = district.greaterThan(0.5).and(district.lessThan(1.5));
    const isIndustrial = district.greaterThan(1.5);
    const isGlassTower = district.lessThan(0.5);

    const up = positionWorld.y.sub(baseY).toVar();
    const belowTop = bldgH.sub(up).toVar();

    // District-shaped window sizes: a curtain wall downtown, punched windows in
    // masonry, few and small on an industrial shed.
    // Downtown is a CURTAIN WALL: nearly all glass, thin dark mullions. That is
    // the contrast that makes the districts read — pale punched-window masonry
    // next to dark glass slabs — rather than one grey grid everywhere.
    const winW = select(isGlassTower, u.winW.mul(1.5).min(0.93),
      select(isMasonry, u.winW.mul(0.82), u.winW.mul(0.6))).toVar();
    const winH = select(isGlassTower, u.winH.mul(1.6).min(0.9),
      select(isMasonry, u.winH.mul(0.9), u.winH.mul(0.55))).toVar();

    // ── Cell coordinates ─────────────────────────────────────────────────────
    const phaseU = bh.mul(7.0);
    const phaseV = bh2.mul(3.0);
    const fu = across.div(u.colWidth).add(phaseU).toVar();
    const fv = up.sub(u.lobbyHeight).div(u.floorHeight).add(phaseV).toVar();
    const colIdx = floor(fu).toVar();
    const floorIdx = floor(fv).toVar();
    const cellU = fract(fu).toVar();
    const cellV = fract(fv).toVar();

    // ── Screen-space LOD ─────────────────────────────────────────────────────
    const uPerPx = fwidth(across).div(u.colWidth);
    const vPerPx = fwidth(up).div(u.floorHeight);
    const cellsPerPx = max(uPerPx, vPerPx);
    const sharp = smoothstep(u.lodSharp, u.lodFlat, cellsPerPx).toVar(); // 1 near, 0 far

    // ── Window mask ──────────────────────────────────────────────────────────
    const halfW = winW.mul(0.5);
    const halfH = winH.mul(0.5);
    const aaU = max(uPerPx.mul(0.5), float(0.0015));
    const aaV = max(vPerPx.mul(0.5), float(0.0015));
    const du = abs(cellU.sub(0.5));
    const dv = abs(cellV.sub(0.5));
    const towerRaw = smoothstep(halfW.add(aaU), halfW.sub(aaU), du)
      .mul(smoothstep(halfH.add(aaV), halfH.sub(aaV), dv));
    const lobbyRaw = smoothstep(halfW.add(aaU), halfW.sub(aaU), du)
      .mul(smoothstep(float(0.0), float(0.06), up.div(u.lobbyHeight)))
      .mul(smoothstep(float(1.0), float(0.88), up.div(u.lobbyHeight)));
    const isLobby = up.lessThan(u.lobbyHeight);
    const winRaw = select(isLobby, lobbyRaw, towerRaw).toVar();
    const coverage = winW.mul(winH);
    const win = mix(coverage, winRaw, sharp).toVar();

    // Recess ring, pier relief, spandrel band — all dissolve with `sharp`.
    const ringRaw = smoothstep(halfW.add(0.14), halfW.add(0.02), du)
      .mul(smoothstep(halfH.add(0.14), halfH.add(0.02), dv))
      .sub(winRaw).max(0.0);
    const recess = ringRaw.mul(sharp).mul(u.recessAO);
    // Pier: a vertical rib on the cell boundary, lit on one side, shaded on
    // the other — relief without a normal.
    const pierMask = smoothstep(u.pierWidth, u.pierWidth.mul(0.4), du.sub(0.5).abs()).mul(sharp);
    const pierShade = float(1.0).add(pierMask.mul(u.pierRelief).mul(sign(cellU.sub(0.5))));
    const spandrelMask = smoothstep(float(0.09), float(0.02), min(cellV, float(1.0).sub(cellV))).mul(sharp);
    const spandrelShade = float(1.0).sub(spandrelMask.mul(u.spandrel));

    // ── Masonry (midtown only) ───────────────────────────────────────────────
    // Running bond keyed to building-local metres, mortar AA'd by its own
    // fwidth, dissolving to the mean tint when bricks go subpixel.
    //
    // BEHIND A REAL BRANCH. A `select` on district still evaluates the bricks
    // on every pixel of every glass tower; measured, no uniform toggle moved
    // the frame at all until the work sat inside a WGSL `If`. The inputs it
    // reads (`up`, `across`) are `toVar()`ed above — shared nodes must be
    // materialised before the first branch or the branch reads garbage (the
    // v3 terrain gate finding).
    const brickShade = Fn(() => {
      const out = float(1.0).toVar();
      const bAAu = max(fwidth(across).div(u.brickW), float(0.002)).toVar();
      const bAAv = max(fwidth(up).div(u.brickH), float(0.002)).toVar();
      const brickSharp = smoothstep(float(0.6), float(0.15), max(bAAu, bAAv)).toVar();
      If(isMasonry.and(brickSharp.greaterThan(0.001)), () => {
        const brow = floor(up.div(u.brickH));
        const bcol = across.div(u.brickW).add(fract(brow.mul(0.5))); // half-brick offset per row
        const bu = fract(bcol);
        const bv = fract(up.div(u.brickH));
        const m2 = u.mortar.mul(0.5);
        const mortarMask = float(1.0).sub(
          smoothstep(m2.sub(bAAu), m2.add(bAAu), min(bu, float(1.0).sub(bu)))
            .mul(smoothstep(m2.sub(bAAv), m2.add(bAAv), min(bv, float(1.0).sub(bv)))),
        );
        const brickJit = hash21(vec2(floor(bcol), brow)).sub(0.5).mul(u.brickTint);
        out.assign(mix(float(1.0),
          float(1.0).add(brickJit).mul(float(1.0).sub(mortarMask.mul(0.35))), brickSharp));
      });
      return out;
    })();

    // ── Lit windows + churn ──────────────────────────────────────────────────
    // Per-building bias so some towers are dark and some work late; per-floor
    // vacancy; per-window state that slowly flips on its own phase.
    const bldgLit = u.litFraction.mul(bh3.mul(1.1).add(0.45));
    const floorLit = step(u.darkFloors, hash31(vec3(lot, floorIdx.mul(0.37))));
    const winKey = colIdx.add(floorIdx.mul(31.7)).toVar();   // read inside the room branch
    const churnPhase = hash31(vec3(lot.mul(2.3), winKey.mul(0.61)));
    const epoch = floor(uTime.div(u.churnPeriod.max(1.0)).add(churnPhase));
    const winHash = hash31(vec3(lot.mul(3.1), winKey.add(epoch.mul(7.13))));
    const litHard = step(winHash, bldgLit).mul(floorLit);
    const lit = mix(bldgLit, litHard, sharp).toVar();
    const litColor = mix(u.litWarm, u.litCool, step(0.62, bh2));

    // ── Crown lights ─────────────────────────────────────────────────────────
    const hasCrown = step(bh3, u.crownFraction).mul(float(1.0).sub(select(isIndustrial, float(1.0), float(0.0))));
    const crownBand = smoothstep(u.crownHeight, u.crownHeight.mul(0.25), belowTop)
      .mul(step(float(0.0), belowTop));
    const crownHue = fract(bh.mul(5.3));
    const crownColor = vec3(
      smoothstep(0.5, 0.2, abs(crownHue.sub(0.15))).mul(0.6).add(0.4),
      smoothstep(0.45, 0.15, abs(crownHue.sub(0.5))).mul(0.7).add(0.3),
      smoothstep(0.5, 0.2, abs(crownHue.sub(0.82))).mul(0.8).add(0.35),
    );
    const crown = hasCrown.mul(crownBand).mul(u.nightAmount).mul(u.crownBoost);

    // ── Interior mapping ─────────────────────────────────────────────────────
    // Room = this cell, `roomDepth` deep. Facade-space ray from the camera:
    //   ru along the facade, rv up, rd inward (into the building).
    //
    // Only tower panes get rooms; the lobby is a glazed hall, left as glass.
    // And only NEAR panes: `interiorAmt` is zero once the window grid has
    // dissolved, and the whole solve sits behind a WGSL `If` on it — a uniform
    // `interior = 0` therefore actually removes the cost, and far pixels never
    // pay for rooms they cannot resolve. `litColor` is materialised first
    // because the branch reads it (see the masonry note).
    const interiorAmt = u.interior.mul(sharp).mul(select(isLobby, float(0.0), float(1.0))).toVar();
    const litColorV = litColor.toVar();
    const interiorRoom = Fn(() => {
      // xyz = pane colour, w = night-lit room brightness (for the emissive).
      const out = vec4(0.0).toVar();
      If(interiorAmt.greaterThan(0.001), () => {
        const V = normalize(positionWorld.sub(cameraPosition));
        const ru = dot(V, acrossAxis);
        const rv = V.y;
        const rd = max(dot(V, inward), float(0.03));
        const W = u.colWidth, H = u.floorHeight, D = u.roomDepth;
        const pu = cellU.mul(W), pv = cellV.mul(H);
        // Distances to the three walls the ray can hit; a wall behind the ray
        // (negative t) is pushed out of the min.
        const tBack = D.div(rd);
        const ruS = ru.add(sign(ru).mul(1e-4)).add(select(ru.equal(0.0), float(1e-4), float(0.0)));
        const rvS = rv.add(sign(rv).mul(1e-4)).add(select(rv.equal(0.0), float(1e-4), float(0.0)));
        const tSide = select(ru.greaterThan(0.0), W.sub(pu), pu.negate()).div(ruS);
        const tVert = select(rv.greaterThan(0.0), H.sub(pv), pv.negate()).div(rvS);
        const tSideP = select(tSide.greaterThan(0.0), tSide, float(1e6));
        const tVertP = select(tVert.greaterThan(0.0), tVert, float(1e6));
        const tHit = min(tBack, min(tSideP, tVertP));
        const hu = pu.add(ru.mul(tHit)), hv = pv.add(rv.mul(tHit)), hd = rd.mul(tHit);
        const hitBack = tHit.equal(tBack);
        const hitFloor = tHit.equal(tVertP).and(rv.lessThan(0.0));
        const hitCeil = tHit.equal(tVertP).and(rv.greaterThan(0.0));

        const roomHash = hash31(vec3(lot.mul(1.3), winKey.mul(0.37)));
        const roomHash2 = hash31(vec3(lot.mul(0.7), winKey.mul(1.91)));
        const hasCurtain = step(float(1.0).sub(u.curtains), roomHash2);
        // Room palette: a warm off-white wall, tinted per room; darker floor;
        // ceiling with a bright fixture near the middle when lit.
        const wallTint = vec3(0.86, 0.80, 0.72).mul(float(0.75).add(roomHash.mul(0.4)));
        const floorCol = vec3(0.32, 0.26, 0.22).mul(float(0.7).add(roomHash2.mul(0.5)));
        const ceilCol = vec3(0.9, 0.9, 0.88);
        const fixture = smoothstep(float(0.35), float(0.12), abs(hu.sub(W.mul(0.5))).max(abs(hd.sub(D.mul(0.5)))));
        // Furniture: a dark block against the back wall, a picture above it.
        const furniture = hitBack.and(hv.lessThan(H.mul(0.34))).and(abs(hu.sub(W.mul(0.5))).lessThan(W.mul(0.3)));
        const picture = hitBack.and(hv.greaterThan(H.mul(0.48))).and(hv.lessThan(H.mul(0.74)))
          .and(abs(hu.sub(W.mul(0.5))).lessThan(W.mul(0.16)));
        const pictureCol = vec3(fract(roomHash.mul(3.7)), fract(roomHash.mul(5.1)), fract(roomHash.mul(7.3))).mul(0.6).add(0.15);
        // Depth cue: the deeper the hit, the darker.
        const depthShade = mix(float(1.0), float(0.42), smoothstep(float(0.0), D, hd));
        const roomBase = select(hitFloor, floorCol,
          select(hitCeil, ceilCol.mul(float(0.7).add(fixture.mul(0.6))),
            select(furniture, vec3(0.14, 0.12, 0.13),
              select(picture, pictureCol, wallTint)))).mul(depthShade);
        // Unlit room by day: dim ambient from the window. Lit at night: the
        // warm/cool key, fixture blazing.
        // Faint by day: through real glass in sunlight you see the sky, not
        // the sofa. The room only reads once its own lights are on.
        const dayRoom = roomBase.mul(0.11).mul(float(1.0).sub(u.nightAmount.mul(0.85)));
        const nightRoom = roomBase.mul(litColorV).mul(u.nightAmount).mul(lit).mul(float(0.9).add(fixture.mul(1.6)));
        const curtainCol = vec3(0.62, 0.56, 0.5).mul(float(0.7).add(roomHash.mul(0.5)));
        const curtainLit = u.nightAmount.mul(lit);
        const col = mix(dayRoom.add(nightRoom), curtainCol.mul(float(0.35).add(curtainLit.mul(0.9))), hasCurtain);
        // Emissive share: the lit room, or a soft curtain glow.
        const glow = mix(nightRoom, litColorV.mul(curtainLit).mul(0.35), hasCurtain);
        out.assign(vec4(col, max(glow.r, max(glow.g, glow.b))));
      });
      return out;
    })();
    const interiorCol = interiorRoom.xyz;
    const interiorGlowLevel = interiorRoom.w;

    // ── Glass shading ────────────────────────────────────────────────────────
    const paneJit = hash31(vec3(lot.mul(1.7), colIdx.mul(7.3).add(floorIdx)))
      .sub(0.5).mul(u.glassJitter);
    const paneGrad = cellV.sub(0.5).mul(u.paneGradient);
    const glassShade = mix(float(1.0), float(1.0).add(paneJit).add(paneGrad), sharp);
    const flatGlass = u.glassColor.mul(max(glassShade, float(0.05)));
    const glass = mix(flatGlass, interiorCol, interiorAmt);

    // ── Wall colour ──────────────────────────────────────────────────────────
    const pick = floor(bh2.mul(5.999)).toVar();
    const wallBase = select(pick.lessThan(0.5), u.wallColorA,
      select(pick.lessThan(1.5), u.wallColorB,
        select(pick.lessThan(2.5), u.wallColorC,
          select(pick.lessThan(3.5), u.wallColorD,
            select(pick.lessThan(4.5), u.wallColorE, u.wallColorF)))));
    // Districts push the palette: masonry warmer, industrial greyer, and the
    // glass towers' mullions dark — a curtain wall's frame is anodised metal,
    // not stone.
    const wallDistrict = select(isMasonry, wallBase.mul(vec3(1.12, 0.96, 0.86)),
      select(isIndustrial, wallBase.mul(vec3(0.82, 0.84, 0.86)), wallBase.mul(0.42)));
    const grime = float(1.0).sub(u.baseGrime.mul(smoothstep(u.baseGrimeHeight, float(0.0), up)));
    const wall = wallDistrict
      .mul(float(0.82).add(bh.mul(0.36)))
      .mul(grime)
      .mul(float(1.0).sub(recess))
      .mul(pierShade)
      .mul(spandrelShade)
      .mul(select(isMasonry, brickShade, float(1.0)))
      .toVar();

    const baseColor = select(isRoof, u.roofColor, mix(wall, glass, win));

    // A pane with a LIT room in it is a window, not a mirror — but by day a
    // curtain wall IS a mirror, and dropping its metalness for the sake of a
    // dim unlit room turned every glass tower into a stack of grey boxes. So
    // the reflection stays by day and gives way to the rooms as night comes.
    const paneMetal = mix(u.glassMetal, u.interiorMetal, interiorAmt.mul(u.nightAmount));
    // Emissive: window glow (flat, far) OR the lit room itself (near) — the
    // room already carries `lit` and `nightAmount`, so blend the two by the
    // same amount to avoid double-counting.
    const flatGlow = litColorV.mul(lit).mul(u.nightAmount).mul(u.emissiveBoost);
    // A lit room is already its own light in the DIFFUSE term; the emissive
    // here is only the bloom contribution, scaled by the room's own brightness
    // level and tinted by the pane. At 0.55× it saturated every near window to
    // a flat tan square and the room detail vanished under it.
    const roomGlow = interiorCol.mul(interiorGlowLevel).mul(u.emissiveBoost.mul(0.22));
    const windowGlow = mix(flatGlow, roomGlow, interiorAmt).mul(win);
    const emissive = select(isRoof, vec3(0.0), windowGlow.add(crownColor.mul(crown)));

    return {
      color: baseColor,
      roughness: select(isRoof, float(0.95), mix(u.wallRough, u.glassRough, win)),
      metalness: select(isRoof, float(0.0), mix(float(0.0), paneMetal, win)),
      emissive,
    };
  }

  // ── Material ───────────────────────────────────────────────────────────────
  const material = new THREE.MeshStandardNodeMaterial();
  material.name = "CityFacade";
  const s = solveSurface();
  material.colorNode = s.color;
  material.roughnessNode = s.roughness;
  material.metalnessNode = s.metalness;
  material.emissiveNode = s.emissive;

  // vec4, not the vec3 emissive: the MRT attachment is a vec4 struct member
  // and WGSL will not widen an assignment — `cannot assign 'vec3<f32>' to
  // 'vec4<f32>'`, an invalid ShaderModule, and a city that silently never
  // draws. Only the GAME hits it; the lab has no MRT target and the node
  // collapses to `output`.
  applyBloomMRT(material, vec4(s.emissive, 1.0));

  // ── Live params proxy ──────────────────────────────────────────────────────
  const params = new Proxy(P, {
    set(target, key, value) {
      target[key] = value;
      const un = u[key];
      if (un) {
        if (un.value && un.value.isColor) un.value.set(value);
        else un.value = value;
      }
      return true;
    },
  });

  const lotHeights = {
    texture: lotTexture,
    data: lotData,
    size: LOT_TEX_SIZE,
    setOrigin(cellX, cellZ, countX, countZ) {
      uLotOrigin.value.set(cellX, cellZ);
      uLotCount.value.set(
        Math.max(1, Math.min(countX, LOT_TEX_SIZE)),
        Math.max(1, Math.min(countZ, LOT_TEX_SIZE)),
      );
    },
    clear: clearLots,
  };

  return {
    material, uniforms: u, params, lotHeights,
    /** Advance the window-churn clock. Seconds. */
    setTime(t) { uTime.value = t; },
  };
}
