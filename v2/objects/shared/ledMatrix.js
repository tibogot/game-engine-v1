import * as THREE from "three";
import {
  clamp,
  color,
  float,
  fwidth,
  mix,
  mod,
  output,
  select,
  smoothstep,
  step,
  texture,
  time,
  uniform,
  uv,
  vec2,
  vec4,
} from "three/tsl";

/**
 * Shared LED matrix material — the one LED shader for every board in the
 * registry (LED matrix board, trackside billboard, overhead gantry).
 *
 * Everything that used to be a JS constant (mode, shape, cols, rows, colours)
 * is a uniform, so:
 *   • one material serves an entire spline of boards (build it once, share it),
 *   • changing a param writes a uniform instead of recompiling the shader.
 *
 * Distance handling matters more here than in most materials: a dot grid is a
 * high-frequency pattern, and once a cell shrinks below ~1px it turns into
 * moiré. `fwidth` gives us cells-per-pixel, and we fade the dot mask toward its
 * own average coverage (`dotCoverage`) as that ratio climbs — the board
 * converges to a smooth panel of the correct average brightness instead of
 * shimmering. The pattern lookup blends from cell-centre (snapped, crisp LEDs)
 * to continuous over the same range.
 *
 * Modes: 0 checker · 1 chevron · 2 lights · 3 image · 4 text
 * Shapes: 0 round · 1 square · 2 diamond · 3 solid (no dot mask)
 */

export const LED_MODES = { checker: 0, chevron: 1, lights: 2, image: 3, text: 4 };
export const LED_SHAPES = { round: 0, square: 1, diamond: 2, solid: 3 };

// Bound when a board has no content texture (chevron/checker/lights). The
// sample still happens — it's one texel of a 1×1 texture, and keeping the
// binding valid means mode can change without rebuilding the material.
let _dummyTex = null;
function dummyTexture() {
  if (!_dummyTex) {
    _dummyTex = new THREE.DataTexture(
      new Uint8Array([255, 255, 255, 255]),
      1,
      1,
      THREE.RGBAFormat,
    );
    _dummyTex.needsUpdate = true;
  }
  return _dummyTex;
}

// Text marquees are rebuilt on every param change; cache by content so
// scrubbing an unrelated slider doesn't re-rasterise the canvas each time.
const _textCache = new Map();
const TEXT_H = 160;

export function makeTextTexture(str) {
  const key = String(str ?? "");
  const hit = _textCache.get(key);
  if (hit) return hit;

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  const font = `700 ${Math.floor(TEXT_H * 0.62)}px Arial, sans-serif`;
  ctx.font = font;
  const textW = Math.ceil(ctx.measureText(key || " ").width);
  const padX = Math.floor(TEXT_H * 0.4);

  canvas.width = Math.max(textW + padX * 2, 8);
  canvas.height = TEXT_H;
  // resizing the canvas resets the 2d state, so restyle after
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#ffffff";
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.font = font;
  ctx.fillText(key, padX, TEXT_H * 0.52);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping; // loop the marquee forever
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;

  const entry = { texture: tex, aspect: canvas.width / canvas.height };
  _textCache.set(key, entry);
  return entry;
}

export function clearLedTextCache() {
  for (const { texture: t } of _textCache.values()) t.dispose();
  _textCache.clear();
}

// three r184: when a scene renders into a render target while no renderer-level
// MRT is set, a material's mrtNode becomes the ENTIRE fragment output, and
// MRTNode maps members to attachments by texture *name*. On a plain RT (env
// probes, offscreen bakes, thumbnail targets) no attachment is called
// "emissive", so the stock mrt() node emits a zero-member WGSL output struct —
// "structures must have at least one member", invalid pipeline. This subclass
// keeps the stock behaviour whenever any attachment name matches and otherwise
// collapses to the material's regular `output`, like a normal material.
class LedBloomMRTNode extends THREE.MRTNode {
  static get type() {
    return "LedBloomMRTNode";
  }

  setup(builder) {
    const textures = builder.renderer.getRenderTarget()?.textures;
    const anyNamed =
      !!textures && textures.some((t) => this.outputNodes[t.name] !== undefined);
    if (anyNamed) return super.setup(builder);
    this.members = [vec4(output)];
    // OutputStructNode defines no setup of its own — this is exactly what
    // MRTNode's own `super.setup()` resolves to.
    return THREE.Node.prototype.setup.call(this, builder);
  }
}

// Average coverage of one dot within its cell — the value the mask converges to
// once the cell is subpixel. Keeps distant boards the same brightness as near
// ones instead of blowing out to full-white panels.
function dotCoverageFor(shape, r) {
  if (shape === LED_SHAPES.solid) return 1;
  if (shape === LED_SHAPES.square) return Math.min(1, (2 * r) * (2 * r));
  if (shape === LED_SHAPES.diamond) return Math.min(1, 2 * r * r);
  return Math.min(1, Math.PI * r * r); // round
}

function resolveMode(p) {
  const m = p.mode ?? p.source ?? p.boardMode ?? "chevron";
  return typeof m === "number" ? m : (LED_MODES[m] ?? LED_MODES.chevron);
}

function resolveShape(p) {
  const s = p.shape ?? p.boardShape ?? "round";
  return typeof s === "number" ? s : (LED_SHAPES[s] ?? LED_SHAPES.round);
}

/**
 * Grid resolution. Boards authored by physical dot pitch (billboard, gantry)
 * keep a constant real-world dot size at any span; boards authored by explicit
 * cols/rows (the LED matrix board) pin the panel's native resolution.
 */
function resolveGrid(p, boardW, boardH) {
  if (p.cols != null && p.rows != null) {
    return { cols: Math.max(2, Math.round(p.cols)), rows: Math.max(1, Math.round(p.rows)) };
  }
  const pitch = Math.max(0.02, p.dotPitch ?? 0.085);
  return {
    cols: Math.max(6, Math.round(boardW / pitch)),
    rows: Math.max(2, Math.round(boardH / pitch)),
  };
}

// The flat tint used by chevron/lights. Only one mode is live per material, so
// a single uniform covers both and applyLedMatrixParams picks the right source.
function resolveTint(p, mode) {
  if (mode === LED_MODES.lights) return p.lightColor || "#ff2418";
  if (mode === LED_MODES.chevron) return p.chevronColor || p.coreColor || "#ff8c1a";
  return p.coreColor || "#ffffff";
}

/** Write every uniform from `p`. Never recompiles — safe to call per edit. */
export function applyLedMatrixParams(material, p, boardW, boardH) {
  const led = material.userData?.led;
  if (!led) return;
  const u = led.u;

  const mode = resolveMode(p);
  const shape = resolveShape(p);
  const { cols, rows } = resolveGrid(p, boardW, boardH);
  const dotRadius = p.dotRadius ?? 0.36;

  u.mode.value = mode;
  u.shape.value = shape;
  u.rgb.value = p.rgb ? 1 : 0;
  u.cols.value = cols;
  u.rows.value = rows;
  // non-square cells would stretch the dot; correct in the mask's local space
  u.cellAspect.value = boardW / cols / (boardH / rows);
  u.dotRadius.value = dotRadius;
  u.dotCoverage.value = dotCoverageFor(shape, dotRadius);
  u.emissive.value = p.emissive ?? 6.0;
  u.offLevel.value = p.offLevel ?? 0.04;
  u.panSpeed.value = p.panSpeed ?? 0.4;
  u.threshold.value = p.threshold ?? 0.5;

  // chevron authored either as a count across the board or a spacing in metres
  u.chevronCount.value =
    p.chevronCount ??
    Math.max(1, Math.round(boardW / Math.max(0.2, p.chevronSpacing ?? 0.9)));
  u.skew.value = p.skew ?? p.chevronSkew ?? 2.0;
  u.duty.value = p.duty ?? p.chevronDuty ?? 0.5;

  const checkerSize = Math.max(0.1, p.checkerSize ?? 0.55);
  u.checkerX.value = Math.max(2, Math.round(boardW / checkerSize));
  u.checkerY.value = Math.max(1, Math.round(boardH / checkerSize));

  // useRamp=1 → hot core / warm rim per dot (LED matrix board)
  // useRamp=0 → flat tint with the legacy brightness ramp (billboard, gantry)
  u.useRamp.value = p.useRamp ? 1 : 0;
  u.coreColor.value.set(p.coreColor || "#ffe07a");
  u.edgeColor.value.set(p.edgeColor || "#ff6a00");
  u.tintColor.value.set(resolveTint(p, mode));
  u.colorA.value.set(p.boardColorA || "#ffffff");
  u.colorB.value.set(p.boardColorB || "#0d0d12");

  // How many content-texture widths span the board. Text runs at its natural
  // height so it can scroll; images fill the board once.
  const srcAspect = led.sourceAspect || 1;
  u.contentRepeat.value =
    mode === LED_MODES.text ? boardW / boardH / srcAspect : 1.0;
}

/**
 * @param {object} o
 * @param {number} o.boardW  physical board width (m)
 * @param {number} o.boardH  physical board height (m)
 * @param {object} o.params
 * @param {THREE.Texture|null} [o.contentTexture]  image/text source
 * @param {number} [o.sourceAspect]  content's own width/height
 */
export function makeLedMatrixMaterial({
  boardW = 1,
  boardH = 1,
  params = {},
  contentTexture = null,
  sourceAspect = 1,
}) {
  const u = {
    mode: uniform(float(0)),
    shape: uniform(float(0)),
    rgb: uniform(float(0)),
    cols: uniform(float(32)),
    rows: uniform(float(16)),
    cellAspect: uniform(float(1)),
    dotRadius: uniform(float(0.36)),
    dotCoverage: uniform(float(0.4)),
    emissive: uniform(float(6)),
    offLevel: uniform(float(0.04)),
    panSpeed: uniform(float(0.4)),
    threshold: uniform(float(0.5)),
    chevronCount: uniform(float(6)),
    skew: uniform(float(2.3)),
    duty: uniform(float(0.5)),
    checkerX: uniform(float(8)),
    checkerY: uniform(float(4)),
    contentRepeat: uniform(float(1)),
    useRamp: uniform(float(1)),
    coreColor: uniform(color("#ffe07a")),
    edgeColor: uniform(color("#ff6a00")),
    tintColor: uniform(color("#ff8c1a")),
    colorA: uniform(color("#ffffff")),
    colorB: uniform(color("#0d0d12")),
  };

  const contentNode = texture(contentTexture || dummyTexture());

  // Unlit: the panel is emissive-dominant, so a black-albedo PBR pass would
  // spend a full lighting evaluation to contribute ~nothing.
  const mat = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });

  // Plain node graph (no Fn wrapper) so the bloom output below can reuse the
  // same intermediates — the builder emits each shared temp exactly once.
  const baseUV = uv();

  // ── which dot, and where inside its cell ──
  const grid = vec2(baseUV.x.mul(u.cols), baseUV.y.mul(u.rows));
  const cellCenter = grid.floor().add(0.5);
  const local = grid.sub(cellCenter); // -0.5 .. 0.5
  const shaped = vec2(local.x.mul(u.cellAspect), local.y);
  const ax = shaped.x.abs();
  const ay = shaped.y.abs();
  const dist = select(
    u.shape.lessThan(0.5),
    shaped.length(), // round
    select(u.shape.lessThan(1.5), ax.max(ay), ax.add(ay)), // square / diamond
  );
  const isSolid = u.shape.greaterThan(2.5);

  // ── screen-space LOD: how many cells fall inside one pixel ──
  const cellsPerPx = fwidth(baseUV.x)
    .mul(u.cols)
    .max(fwidth(baseUV.y).mul(u.rows));
  const sharp = smoothstep(float(0.5), float(0.12), cellsPerPx); // 1 near, 0 far

  const rawMask = smoothstep(u.dotRadius, u.dotRadius.sub(0.06), dist);
  const dotMask = select(
    isSolid,
    float(1.0),
    mix(u.dotCoverage, rawMask, sharp), // dissolve to average coverage far off
  );

  // Snap the pattern to cell centres up close (each LED lights as a unit);
  // sample continuously once the cells are subpixel.
  const cellUV = cellCenter.div(vec2(u.cols, u.rows));
  const cuv = select(isSolid, baseUV, mix(baseUV, cellUV, sharp));
  const scroll = time.mul(u.panSpeed);
  const core = dotMask.mul(dotMask);

  // ── per-mode "is this dot lit" ──
  const checkerSq = mod(
    cuv.x.mul(u.checkerX).floor().add(cuv.y.mul(u.checkerY).floor()),
    2.0,
  );

  const chevY = cuv.y.sub(0.5).abs();
  const phase = cuv.x.mul(u.chevronCount).add(chevY.mul(u.skew)).sub(scroll);
  const chevLit = smoothstep(u.duty, u.duty.sub(0.04), phase.fract());

  const colIdx = cuv.x.mul(5.0).floor();
  const band = smoothstep(0.3, 0.26, cuv.y.sub(0.5).abs());
  const ph = mod(time, 7.0); // count up 0..5s, hold to 6s, dark to 7s
  const lightsLit = step(colIdx, ph).mul(step(6.0, ph).oneMinus()).mul(band);

  const sampleUV = vec2(cuv.x.mul(u.contentRepeat).add(scroll), cuv.y);
  const tex = contentNode.sample(sampleUV);
  const lum = tex.r.mul(0.299).add(tex.g.mul(0.587)).add(tex.b.mul(0.114));
  const texLit = smoothstep(u.threshold.sub(0.05), u.threshold.add(0.05), lum);

  const isChecker = u.mode.lessThan(0.5);
  const isChevron = u.mode.lessThan(1.5);
  const isLights = u.mode.lessThan(2.5);
  const isRgb = u.rgb.greaterThan(0.5);

  // rgb (video-wall): every LED lit, coloured by the source
  const contentLit = select(isRgb, float(1.0), texLit);
  const lit = select(
    isChecker,
    float(1.0),
    select(isChevron, chevLit, select(isLights, lightsLit, contentLit)),
  );

  // ── colour ──
  const legacyRamp = mix(float(0.55), float(1.3), core);
  const monoColor = select(
    u.useRamp.greaterThan(0.5),
    mix(u.edgeColor, u.coreColor, core),
    u.tintColor.mul(legacyRamp),
  );
  const checkerColor = mix(u.colorB, u.colorA, checkerSq).mul(legacyRamp);
  const ledColor = select(
    isChecker,
    checkerColor,
    select(isLights, monoColor, select(isRgb, tex.rgb, monoColor)),
  );

  const litLevel = clamp(lit.mul(u.emissive).add(u.offLevel), 0.0, u.emissive);
  const ledOut = ledColor.mul(dotMask.mul(litLevel));

  mat.colorNode = ledOut;

  // Bloom feed. The VISIBLE output fades to the dots' average coverage at
  // distance (~40% for round dots — correct average brightness), but that
  // drops a far board's luminance to barely above the bloom threshold, so its
  // glow dies long before solid-faced objects (floodlight) or big square dots
  // (billboard checker, ~71% coverage). Bloom instead sees the panel as if
  // the lit dots covered it fully: up close rawMask ≡ the visible mask so the
  // two outputs are identical; far away glow energy holds steady.
  const bloomMask = select(isSolid, float(1.0), mix(float(1.0), rawMask, sharp));
  const bloomOut = ledColor.mul(bloomMask.mul(litLevel));

  // Selective bloom: both pipelines bloom ONLY the `emissive` MRT target, which
  // is normally fed by a material's emissive slot — an unlit material has none.
  // A per-material mrtNode is merged over the pass's (mrt.merge), so this fills
  // `emissive` without disturbing the output/diffuseColor/normal targets that
  // postFxPipeline writes for SSAO. LedBloomMRTNode (above) rather than mrt()
  // so plain-RT renders (env probes, offscreen bakes) fall back to a normal
  // single output instead of an invalid empty struct.
  mat.mrtNode = new LedBloomMRTNode({ emissive: bloomOut });

  mat.userData.led = { u, contentNode, sourceAspect };
  applyLedMatrixParams(mat, params, boardW, boardH);
  return mat;
}
