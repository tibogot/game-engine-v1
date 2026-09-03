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
//     a building because a building is inset inside its lot. Survives instance
//     rotation and footprint scaling, which `worldXZ - geometryXZ` would not.
//   • HEIGHT UP THE FACADE — `worldY - groundY`, in metres. Floor spacing is
//     therefore CONSTANT no matter how far an instance is stretched in Y, which
//     is the one detail that stops instanced towers reading as photocopies.
//   • ACROSS THE FACADE — `positionGeometry.xz`, the untouched vertex attribute.
//     NOT positionLocal: InstanceNode and BatchNode both `positionLocal.assign()`
//     the instance-transformed position (InstanceNode.js:188, BatchNode.js:134),
//     so by fragment time positionLocal is world space and the difference trick
//     collapses to zero.
//
// ── THE CONTRACT THIS BUYS ───────────────────────────────────────────────────
//
//   1. The city sits on FLAT GROUND at `groundY`. Floor lines are absolute
//      metres, so a building on a slope would slice its floors. Cities are built
//      on pads anyway; the game flattens one the way the road system already
//      flattens for a deck.
//   2. One building per lot cell, inset from the lot edge.
//
// ── ALIASING IS THE WHOLE JOB ────────────────────────────────────────────────
//
// A window grid is a high-frequency repeating pattern on geometry the player
// passes at 30 m/s. Untreated it is a shimmering moire field at any distance,
// and that — not triangle count, not draw calls — is what makes a procedural
// city look cheap in motion. The fix is the one already proven on the LED
// panels (v2/objects/shared/ledMatrix.js): measure cells-per-pixel with
// `fwidth`, and as the cells go subpixel DISSOLVE the mask toward its own
// average coverage instead of continuing to sample it. A far tower converges to
// a flat tinted slab, which is exactly what a far tower looks like.
//
// The same dissolve is applied to the lit-window hash, otherwise the night city
// twinkles: the pattern goes to its mean (`litFraction`) instead.
//
// ── WHY THIS IS A NODE MATERIAL AND NOT A PLAIN ONE ──────────────────────────
//
// Static world geometry with a plain material never re-uploads scene fog
// uniforms in three's WebGPU backend, so it freezes at the fog it first
// rendered with (see the note in modularRoadScenery.js). A city is the largest
// possible instance of that bug. Having a colorNode flips `hasNode` and keeps
// the haze live.
// ============================================================================
import * as THREE from "three";
import {
  Fn, float, vec2, vec3, uniform, select, mix, smoothstep, max, abs,
  floor, fract, dot, sin, positionGeometry, positionWorld, normalGeometry,
  fwidth, step,
} from "three/tsl";
import { applyBloomMRT } from "../../v3/render/bloomMRT.js";

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
  /** World Y the city stands on. */
  groundY: 0,

  /** Wall palette, mixed per building by the lot hash. */
  wallColorA: 0x6d6a66,
  wallColorB: 0x8a8378,
  wallColorC: 0x4e5359,
  /** Glass base tint (before the per-window brightness jitter). */
  glassColor: 0x2b3a4a,
  /** Roof / ledge tops — gravel and plant, never glass. */
  roofColor: 0x35353a,

  wallRough: 0.82,
  glassRough: 0.12,
  glassMetal: 0.55,

  /** 0 = day, 1 = night. Drives the lit windows only; not a light. */
  nightAmount: 0,
  /** Fraction of windows lit at full night. Also the far-distance average. */
  litFraction: 0.28,
  litColor: 0xffd9a0,
  emissiveBoost: 2.6,
  /** Fraction of storeys that are wholly dark (vacant floors). Cheap realism. */
  darkFloors: 0.22,

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
 * @returns {{ material: THREE.MeshStandardNodeMaterial, uniforms: object, params: object }}
 *   `params` is a live proxy — assigning to it writes the uniform, so the lab's
 *   sliders and the game's tuning file drive the same object.
 */
export function createCityFacadeMaterial({ params: overrides = {} } = {}) {
  const P = { ...FACADE_DEFAULTS, ...overrides };

  // ── Uniforms ───────────────────────────────────────────────────────────────
  const u = {
    floorHeight: uniform(P.floorHeight),
    colWidth: uniform(P.colWidth),
    winW: uniform(P.winW),
    winH: uniform(P.winH),
    lobbyHeight: uniform(P.lobbyHeight),
    lotSize: uniform(P.lotSize),
    groundY: uniform(P.groundY),
    wallColorA: uniform(new THREE.Color(P.wallColorA)),
    wallColorB: uniform(new THREE.Color(P.wallColorB)),
    wallColorC: uniform(new THREE.Color(P.wallColorC)),
    glassColor: uniform(new THREE.Color(P.glassColor)),
    roofColor: uniform(new THREE.Color(P.roofColor)),
    wallRough: uniform(P.wallRough),
    glassRough: uniform(P.glassRough),
    glassMetal: uniform(P.glassMetal),
    nightAmount: uniform(P.nightAmount),
    litFraction: uniform(P.litFraction),
    litColor: uniform(new THREE.Color(P.litColor)),
    emissiveBoost: uniform(P.emissiveBoost),
    darkFloors: uniform(P.darkFloors),
    lodSharp: uniform(P.lodSharp),
    lodFlat: uniform(P.lodFlat),
    glassJitter: uniform(P.glassJitter),
    paneGradient: uniform(P.paneGradient),
  };

  // ── The shared surface solve ───────────────────────────────────────────────
  // colorNode, roughnessNode, metalnessNode and emissiveNode all need the same
  // window mask, so it is solved ONCE and the four slots reference the same
  // sub-nodes. The node builder caches by node identity, so the mask is emitted
  // once in the WGSL no matter how many slots read it.
  //
  // DELIBERATELY NOT AN `Fn`. A TSL `Fn` whose callback returns a plain object
  // does not hand that object back — it collapses the return into a single node
  // and every property access on it is then parsed as a SWIZZLE. `s.color` is
  // not a swizzle, so it comes back `undefined` and all four material slots
  // silently go unwired. (Verified: `Fn(() => ({a, b}))()` returns a VarNode
  // whose `.a` is a SplitNode.) A plain function returns a plain object, and
  // costs nothing extra because the sharing comes from node caching, not from
  // the function scope.
  function solveSurface() {
    // WHICH FACE. A box tower's walls are ±X or ±Z; anything with a dominant Y
    // normal is a roof, a setback ledge or a string course top, and gets no
    // windows at all.
    //
    // normalGeometry, the RAW attribute — not normalWorld. The across-axis is
    // picked in the same space the coordinate is read from (positionGeometry),
    // so the pair stays consistent under an instance rotation. Deciding the
    // face in WORLD space and then reading a GEOMETRY coordinate would swap the
    // two horizontal axes on any 90°-rotated tower and run the window columns
    // up the wall instead of across it.
    const n = normalGeometry;
    const isRoof = abs(n.y).greaterThan(0.5);
    const facingX = abs(n.x).greaterThan(abs(n.z));
    const across = select(facingX, positionGeometry.z, positionGeometry.x).toVar();

    // Height above the city's ground plane, in metres.
    const up = positionWorld.y.sub(u.groundY).toVar();

    // WHICH BUILDING. The lot cell is constant over one tower.
    const lot = floor(positionWorld.xz.div(u.lotSize)).toVar();
    const bh = hash21(lot).toVar();               // building random, 0..1
    const bh2 = hash21(lot.add(vec2(17.3, 41.7))).toVar();

    // ── Cell coordinates ─────────────────────────────────────────────────────
    // Unwrapped first: floor() gives the indices the hashes need, fract() the
    // in-cell position, and fwidth() is taken on the UNWRAPPED value so the
    // derivative does not explode across the fract seam.
    const phaseU = bh.mul(7.0);
    const phaseV = bh2.mul(3.0);
    const fu = across.div(u.colWidth).add(phaseU).toVar();
    const fv = up.sub(u.lobbyHeight).div(u.floorHeight).add(phaseV).toVar();

    const colIdx = floor(fu).toVar();
    const floorIdx = floor(fv).toVar();
    const cellU = fract(fu).toVar();
    const cellV = fract(fv).toVar();

    // ── Screen-space LOD ─────────────────────────────────────────────────────
    // Cells per pixel on each axis. This is the whole anti-shimmer mechanism.
    const uPerPx = fwidth(across).div(u.colWidth);
    const vPerPx = fwidth(up).div(u.floorHeight);
    const cellsPerPx = max(uPerPx, vPerPx);
    const sharp = smoothstep(u.lodSharp, u.lodFlat, cellsPerPx).toVar(); // 1 near, 0 far

    // ── Window mask ──────────────────────────────────────────────────────────
    // Symmetric distance from the cell centre, AA'd by half a pixel. The floor
    // is there so a near-flat glancing wall does not go fully soft.
    const halfW = u.winW.mul(0.5);
    const halfH = u.winH.mul(0.5);
    const aaU = max(uPerPx.mul(0.5), float(0.0015));
    const aaV = max(vPerPx.mul(0.5), float(0.0015));
    const du = abs(cellU.sub(0.5));
    const dv = abs(cellV.sub(0.5));
    const towerRaw = smoothstep(halfW.add(aaU), halfW.sub(aaU), du)
      .mul(smoothstep(halfH.add(aaV), halfH.sub(aaV), dv));

    // LOBBY. A tall glazed base with vertical mullions only — no floor lines.
    // The single cheapest thing that makes street level not look like a stack.
    const lobbyRaw = smoothstep(halfW.add(aaU), halfW.sub(aaU), du)
      .mul(smoothstep(float(0.0), float(0.06), up.div(u.lobbyHeight)))
      .mul(smoothstep(float(1.0), float(0.88), up.div(u.lobbyHeight)));
    const isLobby = up.lessThan(u.lobbyHeight);
    const winRaw = select(isLobby, lobbyRaw, towerRaw).toVar();

    // Average coverage of the mask — what the far dissolve converges to.
    const coverage = u.winW.mul(u.winH);
    const win = mix(coverage, winRaw, sharp).toVar();

    // ── Lit windows ──────────────────────────────────────────────────────────
    // Two hashes: a per-floor one so whole storeys go dark (vacant floors read
    // as a city rather than as static), and a per-window one inside a lit floor.
    const floorLit = step(u.darkFloors, hash31(vec3(lot, floorIdx.mul(0.37))));
    const winHash = hash31(vec3(lot.mul(3.1), colIdx.add(floorIdx.mul(31.7))));
    const litHard = step(winHash, u.litFraction).mul(floorLit);
    // Dissolve the pattern too, or the night skyline twinkles at distance.
    const lit = mix(u.litFraction, litHard, sharp).toVar();

    // ── Glass shading ────────────────────────────────────────────────────────
    // Per-pane brightness jitter plus a bottom-to-top gradient inside each pane.
    // Without these a glass tower is one flat rectangle of colour, which is the
    // single biggest tell of a procedural facade.
    const paneJit = hash31(vec3(lot.mul(1.7), colIdx.mul(7.3).add(floorIdx)))
      .sub(0.5).mul(u.glassJitter);
    const paneGrad = cellV.sub(0.5).mul(u.paneGradient);
    const glassShade = mix(float(1.0), float(1.0).add(paneJit).add(paneGrad), sharp);
    const glass = u.glassColor.mul(max(glassShade, float(0.05)));

    // ── Wall colour ──────────────────────────────────────────────────────────
    // Three-way palette pick by the building hash. Deliberately a hard pick, not
    // a blend — blending a palette gives you mud, picking gives you a street.
    // The trailing `.mul` is a per-building value shift, so neighbours sharing
    // a palette entry still separate against each other.
    //
    // Written as one expression rather than a var plus `mulAssign`: assignment
    // operators need a TSL stack and this solve deliberately runs OUTSIDE an
    // `Fn` (see above), so a `mulAssign` here throws "No stack defined for
    // assign operation" at construction time. `toVar()` is fine — it resolves
    // during the build, when a stack exists.
    const t = bh2;
    const wall = mix(
      mix(u.wallColorA, u.wallColorB, smoothstep(0.0, 0.5, t)),
      u.wallColorC,
      smoothstep(0.55, 1.0, t),
    ).mul(float(0.82).add(bh.mul(0.36))).toVar();

    const baseColor = select(isRoof, u.roofColor, mix(wall, glass, win));

    return {
      color: baseColor,
      roughness: select(isRoof, float(0.95), mix(u.wallRough, u.glassRough, win)),
      metalness: select(isRoof, float(0.0), mix(float(0.0), u.glassMetal, win)),
      emissive: select(
        isRoof,
        vec3(0.0),
        u.litColor.mul(win).mul(lit).mul(u.nightAmount).mul(u.emissiveBoost),
      ),
    };
  }

  // ── Material ───────────────────────────────────────────────────────────────
  const material = new THREE.MeshStandardNodeMaterial();
  material.name = "CityFacade";

  // ONE call, four readers. Calling solveSurface() per slot would build four
  // independent graphs and emit the window mask four times.
  const s = solveSurface();
  material.colorNode = s.color;
  material.roughnessNode = s.roughness;
  material.metalnessNode = s.metalness;
  material.emissiveNode = s.emissive;

  // Selective bloom is per-buffer in v3, so lit windows have to opt in
  // explicitly. In the lab (no MRT pipeline) BloomMRTNode collapses to plain
  // `output`, so this is safe to leave on in both places.
  applyBloomMRT(material, s.emissive);

  // ── Live params proxy ──────────────────────────────────────────────────────
  // Writing `params.floorHeight = 4` writes the uniform. Colours accept a hex
  // number or anything THREE.Color takes.
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

  return { material, uniforms: u, params };
}
