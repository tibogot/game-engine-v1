/**
 * The water dish — v3's lake material, rescaled from kilometres to centimetres.
 *
 * This wraps `v3/render/water/lakeMaterial.js` unchanged. That material is worth
 * importing rather than reimplementing because of what it does that the hand-rolled
 * Fresnel surface could not:
 *
 *  - THE SHORELINE IS FREE AND EXACT. Thickness comes from the scene depth buffer, and
 *    the shader discards wherever thickness <= 0. So the water is a plain rectangle and
 *    the waterline is carved, pixel-exact, by whatever the soil actually does — including
 *    around the rocks standing in it. The previous version was a hand-fitted disc whose
 *    edge had to be guessed against a sculpted basin, and it never quite sat right.
 *  - REAL REFRACTION, from the grabbed backbuffer, offset by the surface tangent. This is
 *    the one thing I said the thin glass did not need and the water genuinely does: you
 *    are looking through 15 mm of water at a substrate 15 mm away, and the wobble is the
 *    single strongest "this is liquid" cue there is.
 *  - SSR, which indoors matters more than it does on a lake. There is no sky here — the
 *    interesting reflections are the cork background, the rocks and the basking lamp, and
 *    all of those are on screen.
 *  - Per-channel Beer-Lambert instead of a flat tint.
 *
 * WHAT HAD TO CHANGE IS ONLY NUMBERS. Every length in LAKE_DEFAULTS is in metres and was
 * authored for a lake: 20 m of depth falloff, one normal tile every 20 m, a 120 m SSR
 * march, a 0.6 m foam band. Dropped into a 17 cm dish holding 15 mm of water, the defaults
 * produce a flat, untextured, completely transparent sheet — every falloff is three orders
 * of magnitude too long to register. The params below are the same look re-authored at
 * dish scale; see the note on absorption, which is the one that is deliberately unphysical.
 *
 * Caustics are still NOT here. They live on the substrate material, projected onto the
 * soil under the waterline, which is where light focused by this surface actually lands.
 */
import * as THREE from "three/webgpu";
import { createLakeMaterial } from "../../v3/render/water/lakeMaterial.js";
import { DISH, bakeRippleNormal } from "./terrariumSubstrate.js";

/**
 * Lake params, re-authored for a water dish.
 *
 * Kept as a flat object so the lab panel can push single keys through `syncParams`.
 */
export const WATER_DEFAULTS = {
  level: DISH.level,

  // ── surface ───────────────────────────────────────────────────────────────────────
  /**
   * Repeats per metre. The lake ships 0.05 — one tile every 20 m. At that rate a 17 cm
   * dish samples less than one hundredth of a tile and the surface is mirror-flat.
   */
  normalTiling: 22,
  normalStrength: 0.13,
  /** Metres/second. Water in a bowl drifts; it does not have wind fetch. */
  flowSpeed: 0.006,
  flowDir: [1, 0.35],

  // ── refraction ────────────────────────────────────────────────────────────────────
  /**
   * A screen-UV offset, so it does NOT scale with the scene — it scales with how much of
   * the screen the water covers. The dish fills a good part of the frame in the Water
   * view, and the lake's 0.1 there is a smeared mess; this is a few pixels of wobble.
   */
  refractionStrength: 0.011,

  // ── reflection ────────────────────────────────────────────────────────────────────
  fresnelScale: 0.6,
  // Not sky. These stand in for the room: a dim cool ceiling overhead falling to the
  // warmer wall tone at grazing angles. They are also what SSR falls back to on a miss.
  skyZenithColor: "#2b3138",
  skyHorizonColor: "#544c42",
  skyReflectIntensity: 1.0,

  // On, unlike the lake default. A lake's SSR competes with a real sky and costs a march
  // over 120 m; here the march is 60 cm, and everything worth reflecting is on screen.
  ssrEnabled: true,
  ssrStrength: 1.0,
  ssrMaxDistance: 0.6,
  ssrThickness: 0.008,
  ssrEdgeFade: 0.15,

  // ── body ──────────────────────────────────────────────────────────────────────────
  // The ratio is the lake's — red absorbs fastest, which is what pushes water toward
  // teal. Only the scale changes.
  absorption: [0.35, 0.1, 0.08],
  /**
   * DELIBERATELY UNPHYSICAL, and the one value here I would defend rather than call a
   * port. Real water over 15 mm absorbs essentially nothing: at the lake's scale of 15
   * the red channel loses under 8% and the dish renders as clear glass. Physically
   * correct, and it looks like nothing at all.
   *
   * 22 keeps a faint teal in the body while the substrate still reads clearly through
   * it. 40 was the first try and it was too much — the dish went opaque and read as a
   * deep pool cut into the soil rather than as a shallow bowl of water. Drag Water tint
   * to 0 for the honest version.
   */
  absorptionScale: 22,
  inscatterTint: "#00171a",
  inscatterStrength: 0.16,

  // ── glint ─────────────────────────────────────────────────────────────────────────
  // The "sun" is the basking lamp; syncToLamp points it and takes its colour, so the
  // highlight swings when you move the lamp and goes red at night.
  sunColor: "#ffd7a8",
  shininess: 700,
  glintStrength: 3.0,
  glintFresnel: 0.35,
  glintSpread: 0.35,
  /** Metres of water the glint fades over, so highlights do not crawl up the shore. */
  glintShoreFade: 0.003,

  // ── shoreline ─────────────────────────────────────────────────────────────────────
  /** Metres of water over which absorption reaches full strength — roughly max depth. */
  depthDistance: 0.018,
  /** Metres of water the surface fades in over. 2.5 mm gives a damp edge, not a cut. */
  shoreFade: 0.0025,
  surfaceOpacity: 1.0,

  // A dish has no surf and no rain rings. Both branch out entirely when off, so the
  // Worley FBM behind them costs nothing.
  foamEnabled: false,
  pulseEnabled: false,
};

/** How far past the dish the water rectangle extends, in dish radii. */
const QUAD_SPAN = 1.55;

export function createWater(params = WATER_DEFAULTS) {
  const p = { ...WATER_DEFAULTS, ...params };
  const normalMap = bakeRippleNormal();

  const lake = createLakeMaterial({ normalMap, params: p, uvMode: "world" });

  // No fog in this scene, and the material is a static mesh — exactly the case where
  // three's WebGPU path never refreshes a fog uniform. Turning it off removes the
  // question entirely rather than leaving a term that silently never updates.
  lake.material.fog = false;

  // ── geometry ──────────────────────────────────────────────────────────────────────
  // A flat rectangle, NOT a fitted disc: the depth-buffer discard is what defines the
  // waterline, so fitting the mesh to the basin would be doing badly by hand the thing
  // the shader does exactly.
  //
  // It is kept LOCAL to the dish rather than spanning the tank, and that matters. The
  // substrate at the far +X end sits at roughly 0.048-0.056 m, only millimetres above
  // the 0.041 m waterline — a tank-wide quad would find thickness > 0 over patches of
  // it and flood the cool end with puddles.
  const span = DISH.r * QUAD_SPAN;
  const geo = new THREE.PlaneGeometry(span * 2, span * 2);
  geo.rotateX(-Math.PI / 2);

  const mesh = new THREE.Mesh(geo, lake.material);
  mesh.name = "water";
  mesh.position.set(DISH.x, p.level, DISH.z);
  // The material composites against the grabbed backbuffer, so it must be drawn AFTER
  // every opaque surface it is meant to show through itself. It is not `transparent`, so
  // it sorts with the opaque queue — front-to-back — and without this it would happily
  // draw before the substrate and refract an empty frame. (v3's lakeSystem uses 100 too.)
  mesh.renderOrder = 100;
  mesh.frustumCulled = false;

  const _sunDir = new THREE.Vector3();

  /**
   * Aim the glint at the basking lamp and take its colour.
   *
   * The lake material wants a directional sun; the lamp is a point 50 cm away. Using the
   * dish-to-lamp direction is a good enough approximation over a 17 cm surface, and it
   * means the highlight tracks the lamp height slider and turns red at night.
   */
  function syncToLamp(spot) {
    _sunDir.set(
      spot.position.x - DISH.x,
      spot.position.y - p.level,
      spot.position.z - DISH.z,
    ).normalize();
    lake.setSunDir(_sunDir);
    lake.uniforms.sunColor.value.copy(spot.color);
  }

  /** Room tones the surface reflects where SSR misses. */
  function setRoomColors(zenith, horizon) {
    lake.setSkyColors(zenith, horizon);
  }

  function setLevel(y) {
    mesh.position.y = y;
    p.level = y;
  }

  return {
    mesh,
    material: lake.material,
    uniforms: lake.uniforms,
    syncParams: lake.syncParams,
    update: lake.update,
    syncToLamp,
    setRoomColors,
    setLevel,
    normalMap,
  };
}
