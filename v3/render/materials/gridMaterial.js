/**
 * Grid material — the v3 editor's default greybox surface.
 *
 * WHY THIS EXISTS (and why it is not "tileMaterial but prettier")
 * ───────────────────────────────────────────────────────────────
 * `v2/core/legacy/tileMaterial.js` draws its grid by sampling `grid.png` at two
 * scales. That costs three things a greybox surface should not cost:
 *
 *   1. It is NOT METRIC. The cell period falls out of `textureScale × 0.00125`
 *      times whatever cell count is painted into the PNG — at the terrain's
 *      `textureScale: 400` the two layers repeat every 1.6 m and 16 m. Nothing
 *      in the editor can say "this square is one metre", so the grid cannot be
 *      used to judge scale, which is the entire job Unreal's WorldGridMaterial
 *      does for a blockout.
 *   2. It costs a SAMPLER. grid.png is 1024² RGB at anisotropy 16 and only `.r`
 *      is ever read. The terrain fragment stage sits at exactly 16 samplers on
 *      Windows WebGPU (see terrainNormalMap.js) — that ceiling is why CSM is
 *      pinned to 3 cascades.
 *   3. It ALIASES. A texture grid minifies into moiré: the line thins below a
 *      pixel, the mip chain greys it unevenly, and anisotropy 16 is the price
 *      paid to make that bearable at grazing angles.
 *
 * This module draws the same picture analytically instead, using the "pristine
 * grid" construction (Ben Golus): line width is held constant in SCREEN space by
 * clamping it to the UV derivative, the line is antialiased against that same
 * derivative, and the whole layer dissolves into its own average colour once a
 * cell shrinks below a pixel. That last step is what removes the moiré — the
 * grid fades to flat grey at distance the way UE's does, rather than boiling.
 *
 * Cost: ~2 derivative pairs and ~30 ALU for two decades of grid, versus 2 (XZ
 * path) to 6 (triplanar path) filtered texture taps. NOT a frame-time win — the
 * terrain grid was already measured down to ~0.1-0.15 ms once terrainLOD moved
 * to the XZ-only tile path. The wins here are the metric cell, the sampler slot,
 * the texture no longer being fetched, and the aliasing.
 *
 * WHAT IT DRAWS
 * ─────────────
 * Two decades of line (minor = `minorCell` metres, major = minorCell × 10), a
 * gentle per-major-cell brightness break-up so the surface reads as tiled rather
 * than printed, and a groove darkening (ambient occlusion folded into albedo)
 * plus a roughness break on the lines so the surface responds to a moving sun
 * instead of looking like a decal. All of it from ONE pair of derivatives.
 *
 * MODES — a default material is not one material
 * ──────────────────────────────────────────────
 *   "world"   world-space metric grid. The default: absolute, continuous across
 *             every object and the terrain, so tiling and proportion read.
 *   "object"  same metric cells, but the origin sits at the MESH's origin, so a
 *             box's own faces read its dimensions. Not instance-aware — see
 *             createGridMaterial.
 *   "checker" UV-space checker with quadrant tints. For imported meshes: this is
 *             the one that shows stretched or wrongly-scaled UVs.
 *   "flat"    no grid, base colour only. For judging lighting and silhouette,
 *             and for a game whose ground is fully painted.
 *
 * The uniform bundle is a module SINGLETON on purpose: terrain and props must
 * share one look and one place to tune it, and threading a bundle through
 * createTerrainLOD's 15 positional arguments and through v2's prop material
 * factory would buy nothing. Same pattern as tileMaterial's grid texture cache.
 */
import * as THREE from "three";
import {
  Fn,
  float,
  vec2,
  vec3,
  uniform,
  abs,
  clamp,
  dFdx,
  dFdy,
  dot,
  floor,
  fract,
  length,
  max,
  mix,
  normalLocal,
  normalWorld,
  positionLocal,
  positionWorld,
  saturate,
  sin,
  smoothstep,
  step,
  uv,
} from "three/tsl";

/**
 * Defaults, matched to Unreal's blockout floor rather than invented. Colours are
 * sRGB hex — the uniforms hold LINEAR, converted once on write (see
 * proj_modular_road_color_space: converting twice costs 5-10x).
 *
 * Two earlier passes were rejected on sight, and both failures are worth keeping:
 *   • the major line was near-black (#4a4a47, then darkened AGAIN by the groove
 *     AO, landing near 0x33). Unreal's heavy lines are a soft mid-grey — they
 *     separate blocks without drawing the eye.
 *   • the cells were a whole level too coarse (light 1 m, dark 5 m), so our LIGHT
 *     line sat where Unreal's DARK line sits. See the block on minorCell.
 *
 * The line colours are deliberately close together and close to the base. A
 * blockout grid is there to be READ WHEN LOOKED AT and ignored otherwise; high
 * contrast makes every screenshot about the floor.
 */
export const GRID_DEFAULTS = {
  /** Base surface colour between the lines. */
  baseColor: "#efede8",
  /** Minor line colour (the fine 10 cm grid). */
  lineColor: "#dedcd6",
  /**
   * Major line colour — the 1 m line, and the only one meant to be read at a
   * glance. Clearly darker than the minor grid (measured: it lands at ~2.4x the
   * contrast of the tile face, against the minor line's ~1.02x) but still a
   * grey, not a black seam.
   */
  majorColor: "#adaba5",
  /*
   * ── THE TWO CELL SIZES ARE UNREAL'S, NOT INVENTED ────────────────────────
   *
   * Epic's level-blockout documentation, describing SM_Cube and its material:
   *   "This block is 1m x 1m x 1m ... The dark lines on the material create a
   *    1m grid, and the light lines on the floor material create a 0.1m grid.
   *    The light lines on vertical surfaces are 0.2m grids."
   *
   * So: light 10 cm, dark 1 m, and 20 cm rather than 10 on walls. Three reasons
   * those are the right numbers rather than merely Epic's numbers:
   *
   *   • 1 uu = 1 cm and the grid is base-10 because the world is metric. UE3 and
   *     UDK snapped power-of-two (8/16/32/128); UE4 moved to base-10 and Epic
   *     still recommends it, because meshes arriving from any external DCC are
   *     metric too.
   *   • THE FINE GRID IS THE SNAP INCREMENT MADE VISIBLE. The same page: "By
   *     default, the grid size for moving objects is 10 units, or 10cm." The
   *     light grid is not decoration — it is a picture of where a dragged object
   *     will actually land.
   *   • The dark 1 m grid is the human-scale unit. Unreal's default character is
   *     180 uu, so a person is just under two dark cells, and doors, stairs and
   *     ceilings are all reasoned in metres from there.
   *
   * We shipped 1 m / 5 m first, which is one whole level too coarse: our LIGHT
   * line was sitting where Unreal's DARK line sits.
   */
  /** Minor cell edge, in METRES. This is the number that makes the grid a ruler. */
  minorCell: 0.1,
  /** Major cell = minorCell × this, i.e. the 1 m line. */
  majorRatio: 10,
  /**
   * On VERTICAL faces the minor cell is multiplied by this — Unreal's 0.2 m
   * instead of 0.1 m. Vertical surfaces are read at oblique angles, where a
   * 10 cm grid turns to clutter. The major line stays at 1 m on every face.
   * Free for us: the dominant-axis projection already knows which way a face
   * points. The terrain is a floor and never uses it.
   */
  wallCellScale: 2,
  /** Minor line width in METRES (not a UV fraction) — 4 mm, a hairline. */
  minorWidth: 0.004,
  /** Major line width in METRES — 2 cm, five times the minor line. */
  majorWidth: 0.02,
  /**
   * Per-tile brightness break-up, ±this fraction. Applied on the MAJOR (1 m)
   * cell: that is the "tile" the eye reads as a tile, and a 10 cm hash would be
   * sub-pixel noise at any useful camera distance.
   */
  variation: 0.04,
  /** Groove darkening under the lines, 0..1. This is what reads as a surface. */
  ao: 0.06,
  /**
   * How much darker an OBJECT's grid is than the ground's, 0..1.
   *
   * A multiplier rather than a second set of colours, and that is the whole
   * point of it: what has to stay SHARED is the grid's geometry — cell size,
   * line widths, where the lines fall — because that is what makes an object's
   * cells line up with the floor's and with the next object along. What has to
   * DIFFER is only the value, so a box separates from the ground it stands on by
   * more than its own shading and shadow.
   *
   * Scaling also preserves the contrast ratios the ground was tuned to (measured:
   * major line 2.37x the tile face, minor 1.02x). Giving objects their own colour
   * triplet would mean re-tuning that relationship separately, and it would drift
   * out of step the next time the ground's colours move.
   */
  objectTint: 0.8,
  /** Roughness between the lines. */
  roughness: 0.95,
  /** Roughness on the lines — grooves catch dirt, so slightly rougher. */
  roughLine: 1.0,
  /*
   * ── SURFACE BREAK-UP ──────────────────────────────────────────────────────
   *
   * Broad, slow variation in roughness and nothing else. This is the difference
   * between a floor that reads as a SURFACE and one that reads as printed paper:
   * with roughness flat, every pixel of the ground answers the sun identically,
   * so the only shading in a blockout comes from geometry. Give it slow blotches
   * and the floor catches light unevenly as the camera moves, which is what the
   * eye uses to decide something is real.
   *
   * Roughness ONLY — deliberately no normal perturbation. A normal would fight
   * the painted layers' normals on terrain and the baked terrain normal, for a
   * smaller gain.
   */
  /**
   * Strength of the blotches. Drives ROUGHNESS and, at `BREAKUP_ALBEDO` of this,
   * albedo.
   *
   * It has to touch albedo, and that is a measured result rather than a taste
   * call. Screenshot-diffed on the bare editor floor: driving roughness alone
   * over its whole sane range (±0.12, and even ±0.35) moved a mean of 0.03-0.06
   * luminance levels — nothing. Pushing the BASE roughness 0.95 → 0.30, a swing
   * five times larger than any break-up would use, still only reached a mean of
   * 1.06. On a bright, fully diffuse, non-metal floor, roughness is simply a very
   * weak lever: specular is swamped by the diffuse term at every angle that is
   * not grazing. Albedo is the one that shows, so the blotches drive both and
   * roughness became the supporting half rather than the whole effect.
   */
  breakup: 0.12,
  /** Blotch size in METRES. Must be well above the cell size or it reads as dirt. */
  breakupScale: 8,
};

/** Style values accepted by the terrain and by createGridMaterial. */
export const GRID_MODES = ["world", "object", "checker", "flat"];

/**
 * How much of `breakup` reaches ALBEDO, relative to how much reaches roughness.
 * Fixed rather than exposed: one slider should mean one idea, and the ratio
 * between the two halves is a property of the effect, not a preference.
 *
 * 1.0 rather than something smaller because this floor fights the effect. At
 * 0.35 the default worked out to a ±2% albedo swing, which screenshot-diffed to
 * a max of 2 luminance levels — invisible. At 1.0 the default is ±6%, which
 * moves about a quarter of the ground's pixels by up to ~5 levels: present when
 * you look, not a texture. See `breakup` for why roughness alone could not
 * carry this.
 */
const BREAKUP_ALBEDO = 1.0;

// ── Uniforms ──────────────────────────────────────────────────────────────────

function _lin(hex) {
  const c = new THREE.Color(hex);
  c.convertSRGBToLinear();
  return c;
}

let _shared = null;

/**
 * The shared uniform bundle. Every grid surface in the editor reads these, so a
 * panel edit is live on the terrain AND on every prop with no recompile — only
 * the MODE is compile-time.
 */
export function getGridUniforms() {
  if (_shared) return _shared;
  const d = GRID_DEFAULTS;
  _shared = {
    baseColor: uniform(_lin(d.baseColor)),
    lineColor: uniform(_lin(d.lineColor)),
    majorColor: uniform(_lin(d.majorColor)),
    minorCell: uniform(float(d.minorCell)),
    majorCell: uniform(float(d.minorCell * d.majorRatio)),
    /**
     * Plain number, not a uniform: the shader only ever sees the two CELL sizes.
     * It is kept because majorCell is derived from both, and without somewhere to
     * remember the ratio, changing the cell size alone would silently reset the
     * subdivision to the default.
     */
    majorRatio: d.majorRatio,
    minorWidth: uniform(float(d.minorWidth)),
    majorWidth: uniform(float(d.majorWidth)),
    variation: uniform(float(d.variation)),
    ao: uniform(float(d.ao)),
    objectTint: uniform(float(d.objectTint)),
    wallCellScale: uniform(float(d.wallCellScale)),
    breakup: uniform(float(d.breakup)),
    breakupScale: uniform(float(d.breakupScale)),
    roughness: uniform(float(d.roughness)),
    roughLine: uniform(float(d.roughLine)),
  };
  return _shared;
}

/**
 * Push a plain config object (same keys as GRID_DEFAULTS) onto the shared
 * uniforms. Unknown keys are ignored, missing keys keep their current value.
 * `majorCell` is derived, never set directly, so the two always stay a decade
 * apart unless minorCell/majorRatio say otherwise.
 */
export function applyGridConfig(cfg = {}) {
  const u = getGridUniforms();
  if (cfg.baseColor !== undefined) u.baseColor.value.copy(_lin(cfg.baseColor));
  if (cfg.lineColor !== undefined) u.lineColor.value.copy(_lin(cfg.lineColor));
  if (cfg.majorColor !== undefined) u.majorColor.value.copy(_lin(cfg.majorColor));
  if (cfg.minorCell !== undefined) u.minorCell.value = Math.max(1e-3, cfg.minorCell);
  if (cfg.majorRatio !== undefined) u.majorRatio = Math.max(2, cfg.majorRatio);
  if (cfg.minorCell !== undefined || cfg.majorRatio !== undefined) {
    u.majorCell.value = Math.max(1e-3, u.minorCell.value * u.majorRatio);
  }
  if (cfg.minorWidth !== undefined) u.minorWidth.value = cfg.minorWidth;
  if (cfg.majorWidth !== undefined) u.majorWidth.value = cfg.majorWidth;
  if (cfg.variation !== undefined) u.variation.value = cfg.variation;
  if (cfg.ao !== undefined) u.ao.value = cfg.ao;
  if (cfg.objectTint !== undefined) u.objectTint.value = cfg.objectTint;
  if (cfg.wallCellScale !== undefined) u.wallCellScale.value = Math.max(1, cfg.wallCellScale);
  if (cfg.breakup !== undefined) u.breakup.value = cfg.breakup;
  if (cfg.breakupScale !== undefined) u.breakupScale.value = Math.max(0.1, cfg.breakupScale);
  if (cfg.roughness !== undefined) u.roughness.value = cfg.roughness;
  if (cfg.roughLine !== undefined) u.roughLine.value = cfg.roughLine;
  return u;
}

// ── The grid itself ───────────────────────────────────────────────────────────

/**
 * One decade of antialiased grid line.
 *
 * @param uvN   surface position in CELL units (metres / cellSize)
 * @param deriv |d(uvN)/d(screen)| per axis, in cell units per pixel — passed in
 *              rather than recomputed so both decades share one derivative pair
 * @param lineW half-width of the line in cell units
 * @returns coverage 0..1
 *
 * Three things happen here that a naive `fract() < width` grid does not do, and
 * each one is a visible artefact if dropped:
 *   • `drawWidth` clamps the line to at least one pixel, so a line never thins
 *     out of existence at distance...
 *   • ...and `target / draw` dims it by exactly the amount it was widened, so
 *     total ink is conserved and the grid does not get BRIGHTER as it recedes.
 *   • past one cell per pixel the line is replaced by its own average, which is
 *     the moiré fix: nothing is left to alias.
 */
const gridLayer = /*@__PURE__*/ Fn(([uvN, deriv, lineW]) => {
  // A fully degenerate quad (backface, zero-area triangle) gives a zero
  // derivative; dividing by it later yields NaN, which reads as a black pixel.
  const d = max(vec2(deriv), vec2(1e-8)).toVar();
  const target = vec2(lineW).toVar();
  const draw = clamp(target, d, vec2(0.5)).toVar();
  const aa = d.mul(1.5);
  // 0 at the cell border (on the line), 1 at the cell centre.
  const cell = vec2(1.0).sub(abs(fract(vec2(uvN)).mul(2.0).sub(1.0)));
  // Written as 1 - smoothstep(lo, hi, x) rather than smoothstep(hi, lo, x):
  // GLSL/WGSL leave smoothstep undefined when edge0 > edge1.
  const g = vec2(1.0).sub(smoothstep(draw.sub(aa), draw.add(aa), cell)).toVar();
  g.mulAssign(saturate(target.div(draw)));
  g.assign(mix(g, target, saturate(d.mul(2.0).sub(1.0))));
  // Lines along X and along Y: union, not sum, so crossings do not double up.
  return mix(g.x, float(1.0), g.y);
}).setLayout({
  name: "v3GridLayer",
  type: "float",
  inputs: [
    { name: "uvN", type: "vec2" },
    { name: "deriv", type: "vec2" },
    { name: "lineW", type: "vec2" },
  ],
});

/** Cheap value hash — same construction as v2's tsl-utils hash12. */
const cellHash = /*@__PURE__*/ Fn(([p]) =>
  fract(sin(dot(vec2(p), vec2(127.1, 311.7))).mul(43758.5453)),
).setLayout({
  name: "v3GridCellHash",
  type: "float",
  inputs: [{ name: "p", type: "vec2" }],
});

/**
 * Smooth value noise, 0..1 — four hashes bilinearly blended with a smoothstep
 * weight so the result has no visible lattice. One octave on purpose: this drives
 * a slow roughness blotch, and a second octave would only add detail small enough
 * to alias into specular sparkle.
 */
const valueNoise = /*@__PURE__*/ Fn(([p]) => {
  const i = floor(vec2(p));
  const f = fract(vec2(p));
  const w = f.mul(f).mul(float(3.0).sub(f.mul(2.0)));
  return mix(
    mix(cellHash(i), cellHash(i.add(vec2(1, 0))), w.x),
    mix(cellHash(i.add(vec2(0, 1))), cellHash(i.add(vec2(1, 1))), w.x),
    w.y,
  );
}).setLayout({
  name: "v3GridValueNoise",
  type: "float",
  inputs: [{ name: "p", type: "vec2" }],
});

/**
 * The greybox surface at a point on a plane.
 *
 * @param p2 vec2 node — position on the surface plane, in METRES. World XZ for
 *           the terrain; the dominant-axis projection for an object.
 * @param u  uniform bundle (defaults to the shared one)
 * @param minorScale optional node/number multiplying the MINOR cell only, for
 *           Unreal's coarser grid on vertical faces. The major line stays at 1 m
 *           on every surface, which is what keeps a wall and the floor it meets
 *           agreeing about where the metre marks are. Omit for a floor.
 * @returns `{ col, rough, lines }` — plain nodes, NOT an Fn return value. A `Fn`
 *          that returns an object collapses to a single value (see
 *          ref_tsl_fn_and_instancing_traps); callers that want one WGSL function
 *          should wrap this in a `struct`, which is what terrainLOD does.
 */
export function gridSurface(p2, u = getGridUniforms(), minorScale = null) {
  const p = vec2(p2);
  const minorCell = minorScale === null ? u.minorCell : u.minorCell.mul(minorScale);

  // ONE derivative pair for both decades. dFdx/dFdy are quad-level, so this is
  // the whole screen-space cost of the material: metres of surface per pixel.
  //
  // NOTE — no `.toVar()` / `.assign()` anywhere below. Those need an open `Fn`
  // stack, and every caller here assembles its material OUTSIDE one (terrainLOD
  // builds the base before it opens its surface struct). Pure expression
  // composition is not a codegen loss: three caches a node's built result per
  // builder, so `lines`, referenced three times, still emits one variable.
  const px = dFdx(p);
  const py = dFdy(p);
  const mPerPx = vec2(length(vec2(px.x, py.x)), length(vec2(px.y, py.y)));

  const minorUV = p.div(minorCell);
  const majorUV = p.div(u.majorCell);
  const minor = gridLayer(
    minorUV,
    mPerPx.div(minorCell),
    vec2(u.minorWidth.div(minorCell)),
  );
  const major = gridLayer(
    majorUV,
    mPerPx.div(u.majorCell),
    vec2(u.majorWidth.div(u.majorCell)),
  );

  // Per-TILE brightness break-up, on the MAJOR (1 m) cell — that is the square
  // the eye reads as a tile. A hash on the 10 cm minor cell would be sub-pixel
  // noise at any useful camera distance and would alias exactly the way an
  // unguarded line does.
  //
  // Faded out on the same rule the lines use — gone once the cell drops under
  // ~4 px, which at 1 m is roughly 100 m out.
  const cellsPerPx = max(mPerPx.x, mPerPx.y).div(u.majorCell);
  const varFade = saturate(float(1.0).sub(cellsPerPx.mul(4.0)));

  // Slow blotches — the "this is a surface" term, and the one thing that stops a
  // blockout floor reading as printed paper. Faded toward the blotch's MEAN
  // rather than toward zero strength, so the distance where it gives out is not
  // also a brightness step; gone entirely once a blotch is under ~4 px, which at
  // 8 m is far enough out that the ground is flat grey anyway.
  const pxPerBlotch = max(mPerPx.x, mPerPx.y).div(u.breakupScale);
  const blotch = mix(
    float(0.5),
    valueNoise(p.div(u.breakupScale)),
    saturate(float(1.0).sub(pxPerBlotch.mul(4.0))),
  );
  const roughBase = u.roughness.sub(blotch.mul(u.breakup));

  // Both variations ride the BASE colour, not the final one, so the lines keep
  // their own tone and only the surface between them moves.
  const shade = float(1.0)
    .add(cellHash(floor(majorUV)).sub(0.5).mul(u.variation).mul(varFade))
    // Centred on zero so blotches lighten as well as darken — a one-sided term
    // reads as the floor getting dimmer, not as variation.
    .sub(blotch.sub(0.5).mul(u.breakup).mul(BREAKUP_ALBEDO));

  // Groove AO. The lines are engraved, so they lose ambient — this is what
  // separates "a surface with lines cut into it" from "a surface with lines
  // printed on it" once an environment map is doing most of the lighting.
  const lines = max(minor, major);
  const tinted = mix(
    mix(vec3(u.baseColor).mul(shade), vec3(u.lineColor), minor),
    vec3(u.majorColor),
    major,
  );

  return {
    col: tinted.mul(float(1.0).sub(lines.mul(u.ao))),
    rough: mix(roughBase, u.roughLine, lines),
    lines,
  };
}

/**
 * Flat variant — the same base colour the grid averages to, with no lines and no
 * derivatives. Used by the "flat" mode and by games that never show bare ground.
 *
 * The 0.5 × ao term is the mean of the groove darkening over a cell, so flat and
 * grid read at the same brightness and switching between them is not a step.
 */
export function flatSurface(u = getGridUniforms()) {
  const meanInk = u.minorWidth.div(u.minorCell).mul(2.0)
    .add(u.majorWidth.div(u.majorCell).mul(2.0));
  const col = mix(
    vec3(u.baseColor),
    vec3(u.lineColor),
    saturate(meanInk),
  ).mul(float(1.0).sub(meanInk.mul(u.ao)));
  // The blotch's own mean, as a constant — no noise and no derivatives here, but
  // flat still has to sit at the same average roughness as the grid or switching
  // between the two is a visible step in how the ground catches the sun.
  const rough = u.roughness.sub(u.breakup.mul(0.5));
  return { col, rough, lines: float(0) };
}

// ── UV checker (imported meshes) ──────────────────────────────────────────────

/**
 * UV-space checker. NOT metric and not meant to be: its job is to expose a UV
 * that is stretched, mirrored or scaled wrong on an imported mesh, which a
 * world-space grid cannot show because it ignores UVs entirely.
 *
 * Quadrant tints make mirrored UVs obvious (a mirrored island runs the colour
 * ramp backwards), and the checker itself carries the same derivative-based
 * fade as the grid so it greys out instead of aliasing.
 */
export function checkerSurface(repeat = 16, u = getGridUniforms()) {
  const c = uv().mul(float(repeat));
  const px = dFdx(c);
  const py = dFdy(c);
  const deriv = max(
    length(vec2(px.x, py.x)),
    length(vec2(px.y, py.y)),
  );
  const fade = saturate(float(1.0).sub(deriv.mul(2.0)));

  const q = floor(c);
  const checker = fract(q.x.add(q.y).mul(0.5)).mul(2.0);
  // Hue by UV quadrant so the direction of the mapping is readable.
  const tint = vec3(
    saturate(uv().x),
    float(0.45),
    saturate(uv().y),
  );
  const dark = vec3(u.baseColor).mul(0.45);
  const lightCol = mix(vec3(u.baseColor), tint, float(0.35));
  const col = mix(dark, lightCol, mix(float(0.5), checker, fade));
  return { col, rough: float(u.roughness), lines: float(0) };
}

// ── Standalone material (props, greybox, anything not the terrain) ────────────

/**
 * A MeshStandardNodeMaterial carrying the grid.
 *
 * Projection: the surface point is the DOMINANT-axis projection of the position,
 * not a triplanar blend. A greybox world is boxes, ramps and slabs — on those the
 * dominant axis is exact and costs one grid instead of three. `triplanar: true`
 * blends all three for curved meshes, at 3× the ALU.
 *
 * Every caller of this is an OBJECT — the terrain calls `gridSurface()` directly —
 * so the result is shaded by `objectTint` unless `tint: false` says otherwise.
 * That is what separates a box from the ground it stands on.
 *
 * `mode: "object"` anchors the cells to the mesh's own origin instead of the
 * world's, so a box's faces start a fresh cell at its corner and its dimensions
 * read exactly even when it sits off-grid. WORKS ONLY ON NON-INSTANCED MESHES.
 * On an InstancedMesh three's InstanceNode assigns the instance-transformed
 * position back into `positionLocal` during setup, so what this reads is the
 * position in the InstancedMesh's space, shared by every instance — which is the
 * world grid again, just with a different origin. Anchoring per instance needs
 * the translation column of `instanceMatrix` carried to the fragment stage as a
 * varying; until that exists, props stay on "world".
 */
export function createGridMaterial(opts = {}) {
  const {
    mode = "world",
    triplanar = false,
    checkerRepeat = 16,
    roughness,
    metalness = 0.0,
    tint = true,
    ...cfg
  } = opts;

  const u = getGridUniforms();
  if (Object.keys(cfg).length) applyGridConfig(cfg);

  const mat = new THREE.MeshStandardNodeMaterial({
    roughness: roughness ?? GRID_DEFAULTS.roughness,
    metalness,
  });
  mat.userData.gridMode = mode;
  const shade = (c) => (tint ? c.mul(u.objectTint) : c);

  if (mode === "flat") {
    const s = flatSurface(u);
    mat.colorNode = shade(s.col);
    mat.roughnessNode = s.rough;
    return mat;
  }

  if (mode === "checker") {
    const s = checkerSurface(checkerRepeat, u);
    mat.colorNode = shade(s.col);
    mat.roughnessNode = s.rough;
    return mat;
  }

  const objectSpace = mode === "object";
  const pos = objectSpace ? positionLocal : positionWorld;
  const nrm = objectSpace ? normalLocal : normalWorld;

  // The X and Z projections face sideways, so they take Unreal's coarser wall
  // grid; only the Y projection is a floor. The major 1 m line is unaffected, so
  // a wall and the floor it stands on still agree about where the metres are.
  if (triplanar) {
    const n = abs(nrm);
    const wsum = max(n.x.add(n.y).add(n.z), float(1e-4));
    const w = n.div(wsum);
    const sx = gridSurface(pos.zy, u, u.wallCellScale);
    const sy = gridSurface(pos.xz, u);
    const sz = gridSurface(pos.xy, u, u.wallCellScale);
    mat.colorNode = shade(sx.col.mul(w.x).add(sy.col.mul(w.y)).add(sz.col.mul(w.z)));
    mat.roughnessNode = sx.rough.mul(w.x)
      .add(sy.rough.mul(w.y))
      .add(sz.rough.mul(w.z));
    return mat;
  }

  // Dominant axis: pick the projection whose normal component is largest. `step`
  // rather than an `If` — the three projections are just swizzles of one vector,
  // so selecting is cheaper than branching and has no divergence cost.
  const n = abs(nrm);
  const useY = step(max(n.x, n.z), n.y);
  const useX = step(n.z, n.x).mul(float(1.0).sub(useY));
  const useZ = float(1.0).sub(useY).sub(useX);
  const p2 = pos.zy.mul(useX).add(pos.xz.mul(useY)).add(pos.xy.mul(useZ));
  // useY is 1 on a floor/ceiling and 0 on a wall, so this is the wall scale
  // everywhere except the up-facing projection — one mix, no branch.
  const s = gridSurface(p2, u, mix(u.wallCellScale, float(1.0), useY));
  mat.colorNode = shade(s.col);
  mat.roughnessNode = s.rough;
  return mat;
}
