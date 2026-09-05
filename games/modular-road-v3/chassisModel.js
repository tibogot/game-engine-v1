// ============================================================================
// GLB CHASSIS — loads models/chassis_compressed.glb as the car's body visual.
//
// The file is a Lotus Emira GT4 body (18 nodes, 13 materials, Draco + KTX2), the
// same car the WHEEL glb comes from. That shared origin is why it drops straight
// in at scale 1.0 — MEASURED against the physics rig rather than assumed:
//
//     model body half-width  1.05 m   ==  wheel hub |x|            1.05 m
//     model half-width+aero  1.16 m   ≈   wheel outer edge         1.17 m
//     model height           1.26 m       (real Emira: 1.225)
//
// The wheels land exactly in the arches with no scaling. `+Z` is forward in the
// file (headlight lens nodes at z +2.07, brake-light node at z -1.98), which is
// already the Vehicle's forward axis, so there is no re-orientation either.
//
// Two normalisations the file does need:
//
//  • VERTICAL. The model's own y=0 is its ground plane, but the Vehicle parents
//    the body visual at the chassis ORIGIN, which sits `CHASSIS_GLB.offsetY`
//    above the ground when the suspension has settled. That figure is measured
//    from a headless settle on flat ground (tools/chassisFitTest.mjs), not
//    derived — the spring rate, rest length and wheel radius all feed it.
//
//  • LONGITUDINAL. The body's bounds are asymmetric about its origin (z −2.19 to
//    +2.66) because of the rear wing, so it needs shifting back to sit centred
//    on the axles.
//
// LIGHTS. The file carries its own, which is why this returns handles to them:
//   • `emiss` material — emissiveFactor [1,1,1] × strength 3.64 with an emissive
//     TEXTURE. Genuinely emissive, so brake lights need no invention. Despite
//     the node being called BRAKES_LEFT it spans the full 1.73 m width — it is
//     both tail lights in one mesh.
//   • HEADLIGHT_LENS_LEFT/RIGHT — separate nodes, but authored as `mm_windows`
//     glass, so they are lenses and NOT emissive. They get a cloned material
//     here so they can be lit without touching the windows that share it.
// ============================================================================
import * as THREE from "three";
import {
  materialEmissive, uniform, positionLocal, smoothstep, oneMinus, vec3, float,
  normalLocal, normalize, transformNormalToView, mx_noise_float,
  uv, vec2, time, mix, saturate, normalMap, positionWorld, cameraPosition, length,
  If, Fn,
} from "three/tsl";
import { beadField, createRainLensUniforms } from "./modularRoadRainLens.js";
import {
  getSharedGltfLoader,
  initGlbLoaderRenderer,
} from "../../v2/core/foliage/glbLoader.js";
import { applyBloomMRT } from "../../v3/render/bloomMRT.js";
// Intensities live with the Vehicle because it drives them per frame; only the
// lamp COLOUR is needed here, to build the lens material. Same direction as
// modularRoadTireMarks importing WHEEL — no cycle.
import { CHASSIS_GLB_LIGHTS } from "../../v3/play/modularRoadVehicle.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

const _m4a = new THREE.Matrix4();
const _m4b = new THREE.Matrix4();

export const CHASSIS_GLB_URL = "/models/chassis_compressed.glb";

/**
 * Placement of the model inside the chassis anchor. All chassis-local metres.
 * Live-tunable from the dev panel (Chassis fit) — nudge, then copy the numbers
 * back here. `CHASSIS_GLB_DEFAULTS` below is the reset target.
 */
export const CHASSIS_GLB = {
  /** 1.0 is correct — see the width measurements in the header. */
  scale: 1.0,
  /** The file is laterally symmetric (x −1.16..+1.16), so this should stay 0 —
   *  it exists only so a fit problem can be ruled out rather than assumed. */
  offsetX: 0,
  /**
   * Body height above the chassis origin.
   *
   * THIS IS NOT THE SETTLED RIDE HEIGHT, AND IT MUST NOT BE. It was −0.597,
   * chosen so the model's own ground plane (y=0 in the file) landed exactly on
   * the physics ground plane, and tools/chassisModelTest.mjs asserted that
   * coincidence against a fresh settle.
   *
   * Aligning ground planes does NOT align arches to tyres. It only would if our
   * wheel matched the one the body was modelled around, and it does not —
   * WHEEL.radius is 0.36 while this body's arches are cut for something slightly
   * smaller. MEASURED in the running page by raycasting up from each wheel
   * centre into the body and scanning the full width and length of the tyre:
   *     offsetY −0.595    front −1.9 cm    rear −2.6 cm     <- NEGATIVE
   * i.e. the tyres were already 2–3 cm INSIDE the bodywork parked on flat
   * ground, before any suspension travel or body lean at all. Every millimetre
   * of movement then made a visible clip, which is why it showed up on bumps,
   * on landings and in turns but never cruising — the static overlap was
   * invisible only because the arch lip hides it head-on.
   *
   * The fit has to clear the tyre by at least the worst DYNAMIC closure
   * (tools/archClearanceRepro.mjs measures 7.8 cm: suspension bump travel plus
   * what is left of the body lean after BODYLEAN.archCompensate). Swept in the
   * page, clearance is linear in this number:
   *     −0.595 →  −1.9 / −2.6 cm        −0.535 →  +4.1 / +3.4 cm
   *     −0.555 →  +2.1 / +1.4 cm        −0.500 →  +8.1 / +7.4 cm   <= here
   * −0.50 is the shallowest value that covers the 7.8 cm worst case at both
   * axles, and it is the value that was arrived at independently by driving.
   */
  offsetY: -0.50,
  /** Body bounds centre is +0.23 in the file (rear wing skews it), but −0.23
   *  sits the car slightly too far back against the axles — eyeballed to −0.15,
   *  which is the wing's contribution to the bounds rather than the body's. */
  offsetZ: -0.15,
  /**
   * Glass in this file uses KHR_materials_transmission with transmission = 1.0
   * on SIX meshes (4 windows + 2 headlight lenses). Real transmission makes
   * three render a backdrop pass, which is a per-pixel cost on a car that is on
   * screen 100% of the time — expensive for a racer, and this project is
   * already GPU/fill-rate bound. Cheap alpha instead, by default.
   */
  cheapGlass: true,
  glassOpacity: 0.42,
  /**
   * ── CAR PAINT ────────────────────────────────────────────────────────────
   *
   * The file gives the shell (`mm_ext`) roughness 0.059, metalness 0 and NO
   * clearcoat. That is a very glossy DIELECTRIC — plastic. Real car paint is a
   * metallic basecoat under a clear lacquer, which is two specular lobes: a
   * broad tinted one from the flake and a tight white one from the coat. With
   * only the first you get shine without the depth that reads as "paint".
   *
   * `mm_ext` is already MeshPhysicalMaterial, so the coat needs no change of
   * material class — but the orange peel does, because a procedural normal
   * needs a node material. Both arrive together in `makePaintMaterial`.
   */
  paint: true,
  /** Strength of the clear lacquer. 1 is a show car. 0.85 on this shell was
   *  cling film: a dielectric coat on an already-glossy dielectric base, so
   *  every grazing panel dumped the sky as a blue wrapper. Half of that keeps
   *  the depth and drops the cellophane rim. */
  clearcoat: 0.48,
  /** Coat roughness. A lacquer is still smoother than the flake, but 0.06 was
   *  a chrome edge. Slightly softer so the sky sheen is a highlight, not a rim. */
  clearcoatRoughness: 0.14,
  /** Basecoat metalness. The file ships 0 (plastic). A modest flake tints the
   *  body spec with the livery instead of staying white under the coat. */
  paintMetalness: 0.32,
  /** Basecoat roughness. The file's 0.059 is a second mirror under the coat;
   *  raising it is what actually separates flake (broad, tinted) from lacquer
   *  (tighter, white). */
  paintRoughness: 0.24,
  /**
   * ORANGE PEEL — the fine ripple every sprayed panel has.
   *
   * This is the detail that separates a real painted panel from a CG one, and
   * it is exactly the thing a texture cannot store usefully: it is
   * high-frequency, view-dependent, and would need a normal map far larger than
   * the 1K albedo this car already shares across its whole shell. Procedurally
   * it costs one noise lookup and no VRAM at all.
   *
   * Sampled in OBJECT space so it sticks to the panel. Sampled in view space it
   * would swim across the bodywork as the camera moves, which reads as crawling
   * rather than as a surface.
   */
  orangePeel: 0.38,
  /** Ripples per metre. Real orange peel is roughly 1–3 mm across; this is
   *  deliberately coarser, because at 1 mm it aliases into noise at any
   *  distance the chase camera actually sits at. */
  orangePeelScale: 90,
  /**
   * The file ships a full cabin — seats, door cards, dashboard, steering wheel —
   * as SIX separate meshes.
   *
   * THIS USED TO BE FALSE, on the reasoning that behind tinted glass from a
   * chase camera none of it is ever legible. That is true of the DETAIL and
   * false of the job it actually does: the glass is transparent (0.42) and the
   * body is otherwise a hollow shell, so with the cabin gone you look straight
   * through the windscreen and out of the back of the car. Legibility was the
   * wrong test; OCCLUSION is what the interior is for, and an empty cockpit
   * reads as wrong long before anyone tries to make out a seat.
   *
   * MEASURED, on a 4-piece track with the headlights on:
   *     off   49 draws   305k tris   3.080 ms main scene pass
   *     on    56 draws   338k tris   2.949 ms
   * i.e. +7 draws and no measurable cost — two timestamp ticks the RIGHT way,
   * plausibly because an opaque cabin lets early-z reject fragments the
   * transparent glass was otherwise blending over nothing. The draw-call budget
   * this was originally traded against is not tight: the frame is ~4 ms of 16.7,
   * and 88% of it is fill in the main pass, not draw submission.
   *
   * They are not shadow casters either — `castShadow` is gated on RE_SILHOUETTE,
   * which no interior node matches — so this is 6 small meshes and nothing else.
   */
  showInterior: true,
  /**
   * Merge meshes that share a material into one draw. Only `mm_windows` is
   * shared here (four windows + two headlight lenses), and the lenses have to
   * stay separate because they are driven as lights — so this is the four
   * windows collapsing into one draw.
   */
  mergeByMaterial: true,
};

/** The six cabin meshes. `_INT_` catches the door/steering/interior nodes, and
 *  `INTERIOR` the cab shell — every one of them is authored `..._INT_...` or
 *  `...INTERIOR...` in this file. */
const RE_INTERIOR = /_INT_|INTERIOR|STEERING_WHEEL/i;
const RE_HEADLIGHT_LENS = /HEADLIGHT_LENS/i;
const RE_EMISSIVE = /emiss/i;
/**
 * THE TAIL LIGHT HOUSING — the big rear lens, and the thing everyone goes
 * looking for when the car appears to have no back light.
 *
 * The model has TWO rear light meshes and only one of them was ever driven:
 *
 *   ..._BRAKES_LEFT_mm_lights_emiss_0   caught by RE_EMISSIVE, driven per frame
 *                                        — the THIN STRIP inside the housing
 *   ..._BODY_mm_lights_mm_lights_0      matched NOTHING, fell through to the
 *                                        default body path, never touched
 *
 * So the lamp everyone means by "the back light" was in the file the whole
 * time; nothing is missing from the GLB. It simply had no rule, so it sat there
 * as an unlit chrome lens while a 20 cm strip inside it did all the glowing.
 *
 * IT IS NOT A REAR-ONLY MESH, which is why this cannot just be switched on.
 * Measured against the car's own forward axis, it spans −2.20 m to +2.24 m —
 * nearly the whole body — because `mm_lights` is the LENS MATERIAL for every
 * light surface on the car, front included. Lighting all of it turns the
 * headlight surrounds red. Hence the mask below.
 */
const RE_TAIL_HOUSING = /mm_lights/i;
const RE_GLASS = /windows/i;
/** The painted shell only. NOT `misc` or `mm_chassis` — those are trim and
 *  structure, and lacquering them would put a showroom shine on the splitter. */
const RE_PAINT = /mm_ext/i;
/** Parts that define the car's OUTER silhouette — the only ones worth casting. */
const RE_SILHOUETTE = /mm_ext|misc/i;

const label = (o) => `${o.name ?? ""} ${o.material?.name ?? ""}`;

/**
 * Rewrite every attribute as plain Float32, in place.
 *
 * `getComponent` denormalises for us, so this handles the KHR_mesh_quantization
 * int8/int16 encodings without needing to know which one a given attribute used.
 */
function dequantizeGeometry(g) {
  for (const name of Object.keys(g.attributes)) {
    const a = g.attributes[name];
    if (a.array instanceof Float32Array && !a.normalized) continue;
    const out = new Float32Array(a.count * a.itemSize);
    for (let i = 0; i < a.count; i++) {
      for (let c = 0; c < a.itemSize; c++) out[i * a.itemSize + c] = a.getComponent(i, c);
    }
    g.setAttribute(name, new THREE.BufferAttribute(out, a.itemSize));
  }
}

/**
 * Collapse several meshes that share a material into one draw.
 *
 * mergeGeometries returns NULL — silently, no throw — when the inputs disagree
 * on their attribute set or on indexed-ness, and the caller ends up adding
 * nothing to the scene and losing the parts. So both are normalised first, and
 * a null result falls back to keeping the originals: fewer draw calls is never
 * worth a car with no windows.
 *
 * @returns {THREE.Mesh|null} the merged mesh (already parented), or null if the
 *          originals were kept.
 */
function mergeMeshes(meshes, root, name) {
  if (meshes.length < 2) return null;
  const inv = _m4a.copy(root.matrixWorld).invert();
  const geos = meshes.map((m) => {
    const g = m.geometry.clone();
    // DEQUANTIZE FIRST — this file is KHR_mesh_quantization, so POSITION arrives
    // as NORMALIZED INT16. Two things break if it is merged as-is:
    //
    //   • 3 × int16 is a 6-byte arrayStride, and WebGPU requires a multiple of
    //     4 — the pipeline fails to create, every frame, forever:
    //     "Vertex buffer arrayStride (6) is not a multiple of 4".
    //     The UNMERGED meshes are fine because three pads them on upload; a
    //     geometry we hand-build gets no such help.
    //   • applyMatrix4 below would write world-space metres back into an int16
    //     normalised to [-1,1], which quantises the car into confetti.
    //
    // Float32 also makes the stride check unconditional: 4 × itemSize is always
    // a multiple of 4.
    dequantizeGeometry(g);
    g.applyMatrix4(_m4b.multiplyMatrices(inv, m.matrixWorld)); // bake to root space
    return g;
  });

  // Attribute intersection — anything not present on EVERY input has to go.
  let common = new Set(Object.keys(geos[0].attributes));
  for (const g of geos.slice(1)) {
    common = new Set([...common].filter((k) => k in g.attributes));
  }
  for (const g of geos) {
    for (const k of Object.keys(g.attributes)) if (!common.has(k)) g.deleteAttribute(k);
    g.morphAttributes = {};
  }
  // Indexed-ness must agree too. Dropping to non-indexed is the safe direction:
  // building an index for the odd one out can change vertex order.
  if (!geos.every((g) => g.index)) {
    for (let i = 0; i < geos.length; i++) {
      if (geos[i].index) { const n = geos[i].toNonIndexed(); geos[i].dispose(); geos[i] = n; }
    }
  }

  const merged = mergeGeometries(geos, false);
  for (const g of geos) g.dispose();
  if (!merged) {
    console.warn(`[ModularRoad-v3] chassis: could not merge "${name}" — keeping ${meshes.length} draws`);
    return null;
  }

  const out = new THREE.Mesh(merged, meshes[0].material);
  out.name = name;
  out.castShadow = meshes.some((m) => m.castShadow);
  out.receiveShadow = false;
  root.add(out);
  for (const m of meshes) { m.removeFromParent(); m.geometry.dispose(); }
  return out;
}

/**
 * Rebuild a loaded GLB material as a REAL node material for the light meshes.
 *
 * This is not fussiness. GLTFLoader produces classic MeshPhysicalMaterials, and
 * three converts those to node materials exactly ONCE, at shader build, with a
 * by-value copy (`NodeLibrary.fromMaterial`: `for (const key in material)
 * nodeMaterial[key] = material[key]`). Two consequences, both of which bite
 * precisely the thing we want here:
 *
 *   • `mrtNode` survives the copy, so bloom LOOKS wired — but
 *   • every later write to `emissiveIntensity` lands on the ORIGINAL material,
 *     after the copy was taken, so the lights never actually change brightness.
 *
 * Driving lights means writing that value every frame, so they have to be node
 * materials from the start. Only the properties a lamp needs are carried over —
 * copying wholesale would drag `type`/`uuid` across too.
 */
/**
 * Local-Z below which the housing counts as REAR, and the feather either side.
 *
 * MEASURED, not guessed. Sampling the mesh's vertices against the car's own
 * forward axis gives worldForward = −2.221 · localZ + 0.022, and the brake strip
 * — which is unambiguously the rear lamp — occupies localZ −0.895 to −1.0.
 * −0.78 therefore takes the strip plus the housing around it and stops well
 * short of anything at the front. Re-derive it the same way if the model
 * changes; tools has no fixture for this because it needs the loaded GLB.
 */
/** Housing glow, linear RGB. Deeper than the strip's white-hot core — the
 *  housing is the broad red mass, the strip is the filament inside it. */
const TAIL_HOUSING_COLOR = [1.0, 0.06, 0.03];
const TAIL_REAR_Z = -0.78;
const TAIL_REAR_SOFT = 0.06;

/**
 * The rear light HOUSING: the model's own lens, lit only across its rear end.
 *
 * Rebuilt rather than tweaked because the file ships it as a classic
 * MeshPhysicalMaterial, and a classic material has no `emissiveNode` to hang a
 * position mask on. Safe to rebuild — measured, exactly one mesh uses it.
 *
 * The map, roughness and metalness are carried across: this is a shiny lens and
 * it has to keep reading as one when the lights are off. Only the emissive is
 * new, and it is masked so the front lens surfaces sharing this material stay
 * dark.
 */
function makeTailHousingMaterial(src) {
  const uTail = uniform(0);
  const mat = new THREE.MeshStandardNodeMaterial({
    name: "tailHousing",
    map: src.map ?? null,
    color: src.color?.clone() ?? new THREE.Color(0xffffff),
    roughness: src.roughness ?? 0.1,
    metalness: src.metalness ?? 0.8,
    /**
     * FRONT FACES ONLY — and this is a fix, not a tidy-up.
     *
     * The file authors this lens DoubleSide, which was harmless while the mesh
     * was never lit. Once it glows it is not: `showInterior` is false so the
     * cabin is an empty shell, and the glass is transparent (opacity 0.42,
     * depthWrite off). Looking at the car head-on you therefore see straight
     * through the windscreen, through the hollow cabin, and onto the INSIDE of
     * the rear lamp — which reads as the tail lights shining through the car.
     *
     * Culling the back faces removes exactly that and nothing else: from behind,
     * where the lamp is meant to be seen, only front faces were ever visible.
     */
    side: THREE.FrontSide,
    // Same reasoning as the strip: a lamp is a bloom SOURCE, and tone mapping
    // it first crushes the headroom the bloom keys off.
    toneMapped: false,
  });
  // 1 across the rear end, 0 everywhere forward of it. `positionLocal` because
  // the mask is a property of the MODEL, not of where the car happens to be.
  const rear = oneMinus(smoothstep(
    float(TAIL_REAR_Z), float(TAIL_REAR_Z + TAIL_REAR_SOFT), positionLocal.z,
  ));
  const glow = vec3(...TAIL_HOUSING_COLOR).mul(uTail).mul(rear);
  mat.emissiveNode = glow;
  applyBloomMRT(mat, glow);
  /** Driven per frame by Vehicle._updateTaillights, alongside the strip. */
  mat._tailIntensity = uTail;
  return mat;
}




/**
 * The painted shell: a clear lacquer over the file's basecoat, plus orange peel.
 *
 * Rebuilt as a NODE material rather than tweaked in place, because the peel is a
 * procedural normal and `normalNode` only exists on a node material. Everything
 * the file authored — the livery map, its roughness and metalness — is carried
 * across; this only adds the two things the file has no way to express.
 *
 * THE NORMAL IS BUILT IN OBJECT SPACE AND CONVERTED. `normalNode` is consumed in
 * VIEW space (three falls back to `normalView`), so perturbing it directly would
 * tie the ripple to the camera and make it swim across the bodywork as you drive
 * — the surface would look like it was crawling. Building the perturbed normal
 * against `normalLocal` and handing it through `transformNormalToView` keeps the
 * peel welded to the panel, which is the whole point of it.
 *
 * Three decorrelated noise samples rather than a height field and its gradient:
 * orange peel IS a small random tilt of the surface, so perturbing the normal
 * directly is both the cheaper and the more faithful model. A height-and-
 * gradient version would need three extra taps to say the same thing.
 */
/* ── RAIN ON THE BODYWORK ──────────────────────────────────────────────────
 *
 * The car was the last dry thing in a storm. Rain fell past it, landed on the
 * road beside it and beaded on the lens in front of it, and the paint stayed at
 * showroom clearcoat — on the one object that fills a third of a chase frame.
 *
 * ── IT IS THE COAT'S NORMAL, NOT THE PAINT'S ─────────────────────────────────
 *
 * Water sits ON the lacquer, so it perturbs the CLEARCOAT normal and leaves the
 * basecoat alone. That is both the physics and the convenient answer: this file
 * already spends `normalNode` on orange peel, and the note above it explains
 * why that one has to be built in object space. A tangent-space drop normal
 * cannot be added to an object-space one without a frame to convert between
 * them, and `clearcoatNormalNode` is free, is what the road already uses for
 * exactly this, and is where the water actually is.
 *
 * ── ONE DROP FIELD, TWO SURFACES ─────────────────────────────────────────────
 *
 * `beadField` is the rain lens's own beads, imported rather than reimplemented.
 * A second drop model would look like a different kind of weather on the glass
 * and on the bonnet the first time either was tuned. It gets its OWN uniform
 * bag, so the car can be denser or finer than the lens without the two
 * disagreeing about what a raindrop is.
 */
export const CAR_RAIN = {
  /**
   * Beads per UV unit on the body, and how much of a cell one fills.
   *
   * Judged against the chase camera, which is where this is always seen: at 26
   * and 0.30 — a straight guess at "finer than the lens" — the beads were under
   * a pixel on a car ~270 px wide and the paint read as unchanged. 18 and 0.45
   * is the point at which they show as beading rather than as noise.
   */
  density: 18,
  size: 0.45,
  /** How hard the beads push the coat normal. Still small — a bead is a
   *  millimetre proud of a panel, not a dent in it. */
  normalStrength: 0.8,
  /** Coat roughness under a bead. Standing water is a mirror; the lacquer is
   *  already smooth, so this only has to beat `clearcoatRoughness`. */
  wetCoatRough: 0.03,
  /** Metres at which the beads are full strength, and where they are gone.
   *  Past the far one a drop is well under a pixel and all it can do is alias. */
  fadeNear: 20,
  fadeFar: 32,
};

/**
 * The beaded-coat nodes, or null when the car is dry.
 *
 * Returned as a pair rather than applied, because the caller owns the material
 * and this has no business knowing which of the two normals it is competing for.
 */
/**
 * The car's own drop uniforms. Same field as the lens, its own tuning — and its
 * own `amount`, so the game can fade beads off the paint (they dry, or the car
 * is under cover) without touching the drops on the screen.
 */
export function createCarRainUniforms() {
  return createRainLensUniforms({
    beadDensity: CAR_RAIN.density,
    beadSize: CAR_RAIN.size,
    amount: 0,
  });
}

function carRainCoat(u) {
  // The body's own UV, so the beads are welded to the panel and do not swim
  // when the car moves — the same requirement the orange peel note describes,
  // met here by construction rather than by a space conversion.
  //
  // Handed raw: `beadField` multiplies by `u.beadDensity` itself, and scaling
  // the coordinate here as well would square the density and leave the size
  // uniform describing a grid that no longer exists.
  /*
   * DISTANCE FADE, and it is not only an optimisation. Beads this size are
   * sub-pixel past thirty metres, and a sub-pixel normal perturbation does not
   * read as water, it reads as sparkle crawling over the bodywork. The chase
   * camera sits at ~8 m, so the car is inside the full-strength band whenever
   * the player can actually see it.
   *
   * Computed OUTSIDE the branch below: it is two instructions, and a value that
   * is read after a branch has to be materialised before it or it reads garbage
   * — the rule this project already learned from the terrain's gates.
   */
  const dist = length(positionWorld.sub(cameraPosition));
  const fade = oneMinus(saturate(
    dist.sub(CAR_RAIN.fadeNear).div(CAR_RAIN.fadeFar - CAR_RAIN.fadeNear),
  ));

  /*
   * THE WHOLE FIELD IS BEHIND AN `If`, and that is the difference between a
   * switch and a decoration. Multiplying the beads by an `amount` of zero still
   * pays for every hash, every cell lookup and the cap normal on every pixel of
   * the bodywork, every frame, forever — a dry car would carry the full cost of
   * rain it does not have. Gated, dry paint costs one scalar compare.
   */
  /*
   * WRAPPED IN AN `Fn`, AND RETURNING A vec3 RATHER THAN THE PAIR IT WANTS TO.
   *
   * Two of this project's recorded TSL traps meet here. `If` needs an Fn stack
   * to attach its branch to, and this is a plain JS builder called at material
   * construction — without the wrapper it throws `Cannot read properties of
   * null (reading 'If')`, which surfaces as the chassis silently failing to load
   * and the car falling back to the blue primitive. And an `Fn` that returns an
   * OBJECT collapses to a swizzle, so the coverage and the normal are packed
   * into one vec3 and unpacked by the caller instead.
   */
  const gated = Fn(() => {
    const cover = float(0).toVar();
    const n = vec2(0, 0).toVar();
    If(u.amount.greaterThan(0.001).and(fade.greaterThan(0.001)), () => {
      // The body's own UV, so the beads are welded to the panel and do not swim
      // when the car moves — the same requirement the orange peel note
      // describes, met here by construction rather than a space conversion.
      //
      // Handed raw: `beadField` multiplies by `u.beadDensity` itself, and
      // scaling the coordinate here as well would square the density and leave
      // the size uniform describing a grid that no longer exists.
      const drop = beadField(uv(), u, float(1), time);
      cover.assign(drop.cover);
      n.assign(drop.nxy);
    });
    return vec3(cover, n.x, n.y);
  })();

  const cover = gated.x;
  const nxy = vec2(gated.y, gated.z);
  const gain = cover.mul(fade).mul(u.amount);

  // `nxy` is the cap's normal xy and is only meaningful INSIDE the drop, so it
  // is gated by coverage before packing — outside a bead its magnitude is
  // greater than one and packing it unmasked tilts the whole panel.
  const packed = vec3(nxy.mul(cover), float(1)).normalize().mul(0.5).add(0.5);

  return {
    normal: normalMap(packed, vec2(
      gain.mul(CAR_RAIN.normalStrength), gain.mul(CAR_RAIN.normalStrength),
    )),
    /** Blend the authored coat roughness toward standing water where a bead is. */
    roughness: mix(float(CHASSIS_GLB.clearcoatRoughness), float(CAR_RAIN.wetCoatRough), gain),
  };
}

/**
 * @param {object} [opts]
 * @param {object} [opts.rainUniforms] a rain-lens uniform bag. Present = the
 *   paint is built WITH the bead layer; absent = absent from the graph, which
 *   is what keeps a dry track paying nothing for weather it does not have.
 */
function makePaintMaterial(src, opts = {}) {
  const mat = new THREE.MeshPhysicalNodeMaterial({
    name: src.name || "carPaint",
    map: src.map ?? null,
    color: src.color ? src.color.clone() : new THREE.Color(0xffffff),
    roughness: CHASSIS_GLB.paintRoughness,
    metalness: CHASSIS_GLB.paintMetalness,
    clearcoat: CHASSIS_GLB.clearcoat,
    // Smoother than the flake, not a second mirror — see CHASSIS_GLB.clearcoatRoughness.
    clearcoatRoughness: CHASSIS_GLB.clearcoatRoughness,
    side: src.side ?? THREE.FrontSide,
  });

  const amt = CHASSIS_GLB.orangePeel;
  if (amt > 0) {
    const p = positionLocal.mul(CHASSIS_GLB.orangePeelScale);
    const jitter = vec3(
      mx_noise_float(p),
      mx_noise_float(p.add(vec3(17.3, 4.1, 29.7))),
      mx_noise_float(p.add(vec3(51.9, 63.2, 8.5))),
    ).mul(amt * 0.02);
    mat.normalNode = transformNormalToView(normalize(normalLocal.add(jitter)));
  }

  if (opts.rainUniforms) {
    const coat = carRainCoat(opts.rainUniforms);
    mat.clearcoatNormalNode = coat.normal;
    mat.clearcoatRoughnessNode = coat.roughness;
  }
  return mat;
}

function makeLightMaterial(src, { name, emissive, color, opacity, transparent = true }) {
  const mat = new THREE.MeshStandardNodeMaterial({
    name,
    map: src.map ?? null,
    // The emissive MAP is the whole point of reusing the file's lamp art — it
    // carries the internal lens structure that a flat emissive colour cannot.
    emissiveMap: src.emissiveMap ?? null,
    emissive: new THREE.Color(emissive),
    emissiveIntensity: 0, // driven per-frame by Vehicle._updateTaillights
    /**
     * INHERIT THE FILE'S ALBEDO. Rebuilding used to leave this at
     * MeshStandardNodeMaterial's default, which is WHITE.
     *
     * That is why an unlit headlamp read as a flat white slab: the lens carries
     * no `map` and no `emissiveMap`, and `emissiveIntensity` is 0 until the
     * lights come on — so with nothing glowing, the only thing on screen was
     * that default colour. In the file the lens shares `mm_windows` with the
     * four windows, whose albedo is BLACK; inheriting it gives back the dark
     * glass the model actually ships, and the emissive still does the glowing.
     *
     * Safe for the brake lamps too, which come through here as well: emissive
     * is additive and independent of albedo, so a dark lens still lights up.
     */
    color: color != null
      ? new THREE.Color(color)
      : (src.color ? src.color.clone() : new THREE.Color(0xffffff)),
    roughness: src.roughness ?? 0.5,
    metalness: 0,
    transparent,
    // Default to the source's own coverage rather than a hardcoded 1.
    opacity: opacity ?? src.opacity ?? 1,
    side: src.side ?? THREE.FrontSide,
    // Lamps are a bloom SOURCE; tone mapping them first would crush the very
    // headroom the bloom threshold keys off.
    toneMapped: false,
  });
  applyBloomMRT(mat, materialEmissive);
  return mat;
}

/**
 * @param {THREE.WebGPURenderer} renderer once, for KTX2 transcoder detection
 * @param {string} [url]
 * @returns {Promise<{
 *   object: THREE.Object3D,
 *   size: THREE.Vector3,
 *   brakeLights: THREE.Mesh[],
 *   headlampLenses: THREE.Mesh[],
 *   meshCount: number,
 *   casterCount: number,
 * }>}
 */
/**
 * @param {object} [opts]
 * @param {object} [opts.rainUniforms] a rain-lens uniform bag (see CAR_RAIN).
 *   Handing one in builds the paint WITH beaded water; leaving it out keeps the
 *   drop field out of the shader entirely. It is therefore a LOAD-TIME choice —
 *   the game reloads the chassis when the weather first turns wet, the same
 *   trade the road makes for its own wet build.
 */
export async function loadChassisModel(renderer, url = CHASSIS_GLB_URL, opts = {}) {
  initGlbLoaderRenderer(renderer);
  const gltf = await getSharedGltfLoader().loadAsync(url);

  const root = gltf.scene;
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  if (box.isEmpty()) throw new Error("chassis GLB has no visible geometry");
  const size = box.getSize(new THREE.Vector3());

  // Wrap rather than bake, same as the wheel: the offsets stay live-tunable from
  // the dev panel without touching the loaded hierarchy or its shared geometry.
  const object = new THREE.Group();
  object.name = "ChassisModelGLB";
  object.add(root);
  applyChassisGlbTransform(object);

  // ── 1. CLASSIFY ─────────────────────────────────────────────────────────────
  // Collect first, act after: dropping and merging both mutate the hierarchy,
  // which is not safe to do from inside a traverse.
  const all = [];
  root.traverse((o) => { if (o.isMesh) all.push(o); });
  const loadedCount = all.length;

  const interior = [];
  const glass = [];
  const brakeLights = [];
  const headlampLenses = [];

  for (const o of all) {
    const tag = label(o);

    // SHADOW BUDGET — the same lesson the GLB wheel taught. Every caster is
    // redrawn once per shadow cascade and v3 runs 3, so a caster costs 1 main
    // draw + 3 shadow draws. Marking all 18 meshes would be 72 draws for one
    // car. Only the outer body and the mirrors/aero define the silhouette;
    // everything else sits inside it and would cost 48 draws to change nothing.
    o.castShadow = RE_SILHOUETTE.test(tag);
    o.receiveShadow = false; // a car body self-shadowing is not worth a cascade lookup

    if (RE_INTERIOR.test(o.name)) { interior.push(o); continue; }

    if (RE_HEADLIGHT_LENS.test(o.name)) {
      // A REBUILT node material, not a clone — see makeLightMaterial. Also note
      // the lens shares `mm_windows` with the four windows, so lighting it must
      // not light the windscreen; rebuilding gives that for free.
      o.material = makeLightMaterial(o.material, {
        name: "headlampLens",
        emissive: CHASSIS_GLB_LIGHTS.headlampColor,
        // Matched to the windows on purpose: in the file this lens IS
        // `mm_windows`, so it should read as the same glass. Colour comes
        // through from the source now — see makeLightMaterial.
        opacity: CHASSIS_GLB.glassOpacity,
      });
      headlampLenses.push(o);
      continue;
    }

    if (RE_EMISSIVE.test(tag)) {
      // Already emissive in the file (factor 1,1,1 × strength 3.64 + an emissive
      // MAP, which is kept — it is what gives the lamp its internal structure
      // instead of a flat glowing slab).
      o.material = makeLightMaterial(o.material, {
        name: "brakeLight",
        emissive: "#ffffff",
        opacity: o.material.opacity ?? 1,
        transparent: o.material.transparent,
      });
      brakeLights.push(o);
      continue;
    }

    // The housing the strip sits inside — see RE_TAIL_HOUSING. Must come AFTER
    // the RE_EMISSIVE test: the strip's node name contains `mm_lights` too, and
    // it has already been claimed above.
    if (RE_TAIL_HOUSING.test(tag)) {
      o.material = makeTailHousingMaterial(o.material);
      brakeLights.push(o);
      continue;
    }

    if (CHASSIS_GLB.paint && RE_PAINT.test(tag)) {
      o.material = makePaintMaterial(o.material, { rainUniforms: opts.rainUniforms });
      continue;
    }

    if (RE_GLASS.test(tag)) {
      if (CHASSIS_GLB.cheapGlass) {
        o.material = o.material.clone();
        o.material.transmission = 0;
        o.material.transparent = true;
        o.material.opacity = CHASSIS_GLB.glassOpacity;
      }
      glass.push(o);
    }
  }

  // ── 2. DROP THE CABIN ───────────────────────────────────────────────────────
  if (!CHASSIS_GLB.showInterior) {
    for (const o of interior) { o.removeFromParent(); o.geometry.dispose(); }
  }

  // ── 3. LAMP MOUNTS — BEFORE MERGING ─────────────────────────────────────────
  // The two lenses collapse into one mesh below, so their individual centres
  // have to be read now. Root-space: the caller re-derives anchor-space from the
  // CURRENT CHASSIS_GLB fit, so nudging the fit sliders moves the beams with the
  // bodywork instead of leaving them behind.
  object.updateMatrixWorld(true);
  const _c = new THREE.Box3();
  const headlampMountsLocal = headlampLenses.map((m) =>
    root.worldToLocal(_c.setFromObject(m).getCenter(new THREE.Vector3())));

  // ── 4. MERGE WHAT SHARES A MATERIAL ─────────────────────────────────────────
  // The windows are one material across four meshes. The two lenses share it too
  // but are driven as lights, so they merge into their OWN mesh rather than
  // joining the glass — they are always lit together, so one draw covers both.
  if (CHASSIS_GLB.mergeByMaterial) {
    const g = mergeMeshes(glass, root, "chassisGlass");
    if (g) { glass.length = 0; glass.push(g); }
    const l = mergeMeshes(headlampLenses, root, "headlampLenses");
    if (l) { headlampLenses.length = 0; headlampLenses.push(l); }
  }

  let meshCount = 0;
  let casterCount = 0;
  root.traverse((o) => { if (o.isMesh) { meshCount++; if (o.castShadow) casterCount++; } });

  return {
    object, size, brakeLights, headlampLenses, meshCount, casterCount, headlampMountsLocal,
    loadedCount, droppedInterior: CHASSIS_GLB.showInterior ? 0 : interior.length,
  };
}

/** The shipped fit, so the dev panel can offer a way back from a bad nudge. */
export const CHASSIS_GLB_DEFAULTS = { ...CHASSIS_GLB };

/** Re-apply CHASSIS_GLB placement after a live edit. */
export function applyChassisGlbTransform(object) {
  if (!object) return;
  object.scale.setScalar(CHASSIS_GLB.scale);
  object.position.set(CHASSIS_GLB.offsetX, CHASSIS_GLB.offsetY, CHASSIS_GLB.offsetZ);
}

/** Root-space lamp centres → chassis-anchor space under the CURRENT fit. */
export function chassisGlbMounts(local) {
  return (local ?? []).map((p) => p.clone()
    .multiplyScalar(CHASSIS_GLB.scale)
    .add(new THREE.Vector3(CHASSIS_GLB.offsetX, CHASSIS_GLB.offsetY, CHASSIS_GLB.offsetZ)));
}

/** Restore the shipped fit. Returns CHASSIS_GLB so callers can re-read sliders. */
export function resetChassisGlbFit(object) {
  Object.assign(CHASSIS_GLB, CHASSIS_GLB_DEFAULTS);
  applyChassisGlbTransform(object);
  return CHASSIS_GLB;
}

/**
 * One BufferGeometry of the car as a placement / replay glyph.
 *
 * Outer body + aero only (the same parts the live car casts shadows from), in
 * chassis-anchor space under the CURRENT fit, plus four rest-pose wheel discs
 * at `hubs`. Glass, lamps, badges and the cabin are dropped — a translucent
 * ghost does not need them, and they were the extra draws of a full GLB clone.
 *
 * Position-only: MeshBasicMaterial ignores the rest, and a common attribute set
 * is what lets the body and the cylinders merge into a single draw.
 *
 * Callers SHARE the result (spawn marker, spawn brush, lap ghost).
 * Rebake after a fit-slider edit; the fit is baked into the vertices.
 *
 * @returns {THREE.BufferGeometry|null}
 */
export function bakeGhostCarGeometry(object, {
  hubs = [],
  radius = 0.36,
  thickness = 0.24,
  wheelSegments = 12,
} = {}) {
  if (!object) return null;
  object.updateMatrixWorld(true);
  // Parent space is chassis-anchor / body space once the model is mounted;
  // unparented, the object's own matrixWorld already is that space.
  if (object.parent) _m4a.copy(object.parent.matrixWorld).invert();
  else _m4a.identity();

  const geos = [];
  object.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    if (!RE_SILHOUETTE.test(label(o))) return;
    const g = o.geometry.clone();
    dequantizeGeometry(g);
    g.applyMatrix4(_m4b.multiplyMatrices(_m4a, o.matrixWorld));
    stripNonPosition(g);
    geos.push(g);
  });

  if (hubs.length && radius > 0 && thickness > 0) {
    const disc = new THREE.CylinderGeometry(radius, radius, thickness, wheelSegments);
    disc.rotateZ(Math.PI / 2); // cylinder axis +Y → +X, the hub axis
    stripNonPosition(disc);
    for (const h of hubs) {
      const p = h.pos ?? h;
      const g = disc.clone();
      g.translate(p.x, p.y, p.z);
      geos.push(g);
    }
    disc.dispose();
  }

  return collapseGeometries(geos);
}

/** Ghosts are MeshBasic — drop UVs/normals/tangents so body + discs can merge. */
function stripNonPosition(g) {
  for (const k of Object.keys(g.attributes)) {
    if (k !== "position") g.deleteAttribute(k);
  }
  g.morphAttributes = {};
}

/**
 * Merge a list of already-cloned geometries, disposing the inputs.
 * Same compatibility rules as mergeMeshes (attribute intersection, indexed-ness).
 */
function collapseGeometries(geos) {
  if (!geos.length) return null;
  if (geos.length === 1) {
    geos[0].computeBoundingSphere();
    return geos[0];
  }

  let common = new Set(Object.keys(geos[0].attributes));
  for (const g of geos.slice(1)) {
    common = new Set([...common].filter((k) => k in g.attributes));
  }
  for (const g of geos) {
    for (const k of Object.keys(g.attributes)) if (!common.has(k)) g.deleteAttribute(k);
    g.morphAttributes = {};
  }
  if (!geos.every((g) => g.index)) {
    for (let i = 0; i < geos.length; i++) {
      if (geos[i].index) { const n = geos[i].toNonIndexed(); geos[i].dispose(); geos[i] = n; }
    }
  }

  const merged = mergeGeometries(geos, false);
  for (const g of geos) g.dispose();
  if (!merged) {
    console.warn("[ModularRoad-v3] chassis: ghost bake could not merge — no glyph");
    return null;
  }
  merged.computeBoundingSphere();
  return merged;
}
