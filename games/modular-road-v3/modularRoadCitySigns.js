// ============================================================================
// CITY SIGNS — building-scale HERO ADVERTS, plus the older Tokyo layers behind
// switches that default to OFF.
//
// ── WHAT CHANGED AND WHY ─────────────────────────────────────────────────────
//
// The first pass scattered five kinds of procedural signage — painted glyph
// logos, fake LCD text, neon frames — over most of the city. At building scale
// that art read as exactly what it was, and it was the single most artificial
// thing on screen. So the default is now ONE kind:
//
//   HERO BOARDS  few, huge (most of a tall tower's street-facing wall), a real
//                dark frame around a printed panel, LIT by the scene by day (a
//                vinyl wrap is a surface, not a light) and backlit at night.
//                Every one shows a tile from a 4x4 IMAGE ATLAS whose tiles are
//                NEUTRAL PLACEHOLDERS ("AD 07") until real images are loaded
//                into them: `setHeroImage(slot, img)` / `loadHeroImage(slot,
//                url)` repaint one tile in place, and every board on that slot
//                changes with no new draw, no new texture, no shader rebuild.
//
// Boards go on faces that FACE A STREET. A lot on a block edge has one or two
// street faces — known from its cell index alone — and an interior lot has
// none and gets no board: an advert nobody can see from the road is noise.
//
// The banners / podium bands / LED marquees / neon strips are all still here,
// still one draw each, behind fractions that are 0 by default.
//
// ── FIVE MATERIALS, FIVE DRAWS, WHATEVER THE COUNT ───────────────────────────
//
//   banners  vertical poster quads              · banner atlas (procedural)
//   screens  wide screens AND mega billboards   · screen atlas (IMPORTABLE)
//   bands    LED chevron strips over podiums    · v2 ledMatrix, chevron mode
//   text     LED dot-matrix marquees            · v2 ledMatrix, text mode
//   neon     tube outlines and corner strips    · procedural, no texture
//
// Screens and mega billboards share ONE mesh because they share one material —
// the only difference is the quad's size and which atlas tile it points at, and
// both of those are per-instance data. That is why a 40 m Shibuya screen costs
// the same as a 6 m one: nothing.
//
// ── IMPORTING IMAGES ─────────────────────────────────────────────────────────
//
// The screen atlas is a canvas with four 512x512 tiles. `setScreenImage(slot,
// src)` draws an image into one tile and flags the texture; every billboard
// pointing at that slot changes at once, with NO new draw call, NO new texture
// and NO shader rebuild. The texture object itself never changes identity or
// size, which is the swap three's node cache mishandles.
//
// Same for text: `setText(str)` re-rasterises into a FIXED-SIZE canvas that the
// LED material already holds, so the marquee is free to change.
//
// ── OPAQUE, ALWAYS ───────────────────────────────────────────────────────────
//
// r184 blends ONLY the `output` MRT attachment, so a TRANSPARENT surface wipes
// the emissive buffer behind it and kills the bloom of every lit window it
// covers. Signs are therefore opaque quads — never blended — offset a real
// margin off the wall so they do not z-fight at 400 m.
//
// ── DAY AND NIGHT ────────────────────────────────────────────────────────────
//
// By day a sign is printed board: unlit, at ink level. At night it is a light
// source: emissive into the bloom MRT. Neon is emissive at both, because a
// neon tube in daylight is still a bright tube — just not a bloom.
// ============================================================================
import * as THREE from "three";
import {
  Fn, float, vec2, vec3, vec4, uniform, attribute, texture, uv, fract, floor,
  mix, smoothstep, abs, max, min, sin, cos, clamp, oneMinus, step, saturate, fwidth,
} from "three/tsl";
import { applyBloomMRT } from "../../v3/render/bloomMRT.js";
import { makeLedMatrixMaterial, applyLedMatrixParams } from "../../v2/objects/shared/ledMatrix.js";

export const SIGN_DEFAULTS = {
  /** ── HERO ADVERTS — the default, and the only kind on by default. ────────
   *  Fraction of QUALIFYING towers (tall, with a wide street face). */
  heroFraction: 0.45,
  /** How much of the face the panel spans, and its height as a ratio of that
   *  width — capped against the building so it never meets the roofline. */
  heroFaceFrac: 0.86,
  heroAspect: 0.70,
  heroMinHeight: 42,
  heroMinFace: 16,
  /** The band (fraction of building height) the panel's centre lands in. */
  heroLow: 0.28,
  heroHigh: 0.60,
  /**
   * ── WHERE AN LED WALL GOES, and it is NOT where a printed wrap goes ───────
   *
   * A wrap is an advert ON a building, so it sits on the wall like a poster:
   * the middle third, well inside the facade. A Blade Runner screen is a piece
   * of the SKYLINE — you see it before you see the street it is on, over the
   * roofs of everything in front. Placed in the print band it was hidden by
   * the next tower along from anywhere except directly underneath it, which is
   * the one place a board that size does not need help being noticed.
   *
   * So screens crown the tower: centre in the top quarter, top edge just under
   * the parapet, and only on buildings tall enough that the crown is actually
   * above the skyline. A tower that fails `crownMinHeight` still gets a
   * board — it gets a printed one, which is what that building wanted anyway.
   */
  crownLow: 0.74,
  crownHigh: 0.90,
  /** Metres of parapet left above a crowning screen. Small: the board should
   *  look mounted on the roof line, not floating below it. */
  crownTopMargin: 1.4,
  /** Below this a tower is not a skyline piece and takes a printed wrap.
   *  NOT `screenMinHeight` — that name is already taken further down by the
   *  legacy wide-screen layer, and a second key of the same name in this
   *  object would have been silently swallowed by the first. */
  crownMinHeight: 66,
  /** Frame width in METRES — the same border on a 12 m and a 30 m board. */
  heroFrame: 0.55,
  /** Some heroes are SCREENS (LED walls: emissive day and night, scrolling);
   *  the rest are printed wraps, lit like the wall they hang on. */
  heroScreenFraction: 0.3,
  /** Print level by day; backlight at night. Screens use screenBoost. */
  heroDay: 1.0,
  heroNight: 2.4,
  /** The block layout the street-face test reads (the city's own numbers). */
  blockLots: 4,
  streetLots: 1,

  /** Fraction of buildings that get each of the OLD kinds. All off. */
  bannerFraction: 0,
  bandFraction: 0,
  screenFraction: 0,
  megaFraction: 0,
  textFraction: 0,
  neonFraction: 0,

  /** Vertical banner size (m) and how many stack up one edge. */
  bannerW: 2.2,
  bannerH: 8.5,
  bannersPerEdge: 3,

  /** Ordinary wide screen (m). */
  screenW: 16,
  screenH: 9,
  screenMinHeight: 70,

  /** MEGA BILLBOARD: a fraction of the face it sits on, so it scales with the
   *  building instead of being a fixed slab stuck on a tower. This is the
   *  Tokyo piece — 0.82 of the face width is most of the wall. */
  megaFaceFrac: 0.82,
  megaAspect: 0.62,        // height / width
  megaMinHeight: 45,       // building must be at least this tall
  megaMinFace: 14,         // and the face at least this wide
  megaLow: 0.30,           // vertical placement band, as a fraction of height
  megaHigh: 0.62,

  /** LED chevron band over the podium (m). */
  bandH: 1.3,
  /** LED text marquee (m). */
  textW: 12,
  textH: 2.4,
  /** What the marquees say. One per slot; buildings pick by hash. */
  texts: ["SHIBUYA", "APEX RUSH", "NEO CITY", "24H OPEN", "SAKURA", "電気街"],

  /** Neon: tube thickness (m), and the corner-strip height fraction. */
  neonThickness: 0.22,
  neonCornerFrac: 0.55,
  neonBoost: 3.0,

  /** Stand-off from the wall, so the quad never z-fights the facade. */
  standoff: 0.45,
  /** Printed level by day, light level at night. */
  dayLevel: 0.55,
  nightBoost: 3.2,
  /**
   * Screen emissive level.
   *
   * WAS 4.0, and that was tuned when a screen was a smooth glowing panel. The
   * LCD grid multiplies each subpixel by 3 to hold the panel's average
   * brightness, which is right on average and wrong at the peaks: every lit
   * subpixel is now a local spike, and at 4.0 those spikes clipped and bloomed
   * into a wall of white bars with the advert invisible behind them. The
   * structure IS the brightness now, so the level comes down to meet it.
   */
  screenBoost: 1.7,
  nightAmount: 0,

  /* ── LED WALL ──────────────────────────────────────────────────────────────
   * The pixel structure that separates a screen from a glowing poster. Screens
   * only; a printed wrap never runs any of it. See makeHeroMaterial.
   */
  /** LCD cells ACROSS the panel. Rows follow from the board's own aspect, so
   *  cells stay square. 96 on a 25 m board is a ~26 cm pixel, which is the
   *  pitch a real building-scale LED wall actually runs. */
  lcdCols: 132,
  /** Dark lattice between emitters, as a fraction of a subpixel. Real walls
   *  read as roughly a third black up close; below ~0.15 the grid disappears
   *  and it is just colour fringing. */
  lcdGap: 0.28,
  /**
   * How fast the structure dies as cells shrink on screen.
   *
   * MUCH more aggressive than the Nyquist limit alone would need, and that is
   * the point: a real LED wall shows no subpixel structure at all from across a
   * street, and at 1.6 the grid was still half-strength on a board 50 m away,
   * where it read as vertical noise with the advert lost behind it. At 6 the
   * structure belongs to the last few metres — which is exactly where you want
   * it, and where nothing else in the frame is competing for the pixels.
   */
  lcdFade: 2.0,
  /** How far toward true single-channel subpixels the stripe goes. 1 is what a
   *  display physically does and is too absolute over a photograph; see the
   *  note at the call site. */
  lcdStrength: 0.72,
  /** How much bigger a SCREEN board is than a printed one. A Blade Runner wall
   *  is not the size of a poster; these are the ones that should dominate a
   *  street, so they take more of the face and are allowed to run taller. */
  heroScreenScale: 1.45,
};

const BANNER_COLS = 4, BANNER_ROWS = 2, BANNER_PX = 1024;   // 8 portrait tiles
const SCREEN_COLS = 2, SCREEN_ROWS = 2, SCREEN_PX = 1024;   // 4 square tiles
/** Hero atlas: 16 square 512 px slots for REAL images. One texture, one draw. */
export const HERO_COLS = 4, HERO_ROWS = 4, HERO_PX = 2048;
export const HERO_SLOTS = HERO_COLS * HERO_ROWS;

/**
 * Where real adverts live: `public/city-ads/ad-01.webp` … `ad-16.webp`, served
 * from the Vite public dir as `/city-ads/…`.
 *
 * NUMBERED BY THE LABEL, NOT THE SLOT. A placeholder paints itself "AD 07",
 * which is slot 6 — the label is `i + 1`. Naming the files after the label is
 * what makes "replace the one that says AD 07" mean `ad-07.webp` instead of
 * sending you to `ad-06`, so the loader does the -1 rather than you.
 *
 * WebP first because the image is decoded into the atlas canvas either way —
 * the source format has no effect at all on GPU cost, only on download size —
 * but png/jpg are tried too so an image dropped in as either still works.
 */
export const HERO_AD_DIR = "/city-ads/";
export const HERO_AD_EXTENSIONS = ["webp", "png", "jpg"];

/**
 * Fill the hero slots from that folder. MISSING FILES ARE NOT AN ERROR: any
 * slot with no image keeps its "AD nn" placeholder, so you can drop in three
 * adverts today and the other thirteen carry on saying what they are.
 *
 * @param {object} signs the object returned by createCitySigns
 * @returns {Promise<{loaded:number, missing:string[]}>}
 */
export async function loadHeroAdFolder(signs, opts = {}) {
  const dir = opts.dir ?? HERO_AD_DIR;
  const exts = opts.extensions ?? HERO_AD_EXTENSIONS;
  if (!signs?.loadHeroImage || typeof Image === "undefined") return { loaded: 0, missing: [] };
  const missing = [];
  let loaded = 0;
  await Promise.all(Array.from({ length: HERO_SLOTS }, async (_, slot) => {
    const label = String(slot + 1).padStart(2, "0");
    for (const ext of exts) {
      try {
        // Each miss rejects (Image.onerror), which is the ONLY way to probe for
        // a file without a manifest — so the throw is expected control flow
        // here, not a failure, and must not escape to the caller.
        if (await signs.loadHeroImage(slot, `${dir}ad-${label}.${ext}`)) { loaded++; return; }
      } catch (_) { /* not this extension — try the next */ }
    }
    missing.push(label);
  }));
  return { loaded, missing };
}
// The marquee window is boardW/boardH divided by the canvas aspect, so a
// 1024x128 (8:1) canvas on a 12x2.4 m (5:1) board showed only 62% of the
// string — five legible characters out of twenty. Matching the canvas closer
// to the board aspect puts the whole message in view and still scrolls it.
const TEXT_W = 512, TEXT_H = 128;

/** Deterministic small RNG for the atlas art. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 1x1 stand-in where there is no DOM (the headless harness). */
function dummyTexture(r = 200, g = 40, b = 80) {
  const t = new THREE.DataTexture(new Uint8Array([r, g, b, 255]), 1, 1);
  t.needsUpdate = true;
  return t;
}

function finishTexture(canvas) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.flipY = true;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Poster atlas. `cols x rows` tiles of procedural "signage": a saturated
 * ground, bold glyph blocks that read as characters at a distance, a stripe
 * and a frame. Deterministic from the seed.
 *
 * Returns a handle that keeps the CANVAS so tiles can be repainted later
 * without ever replacing the texture object.
 */
function makeAtlas(seed, cols, rows, px, portrait) {
  if (typeof document === "undefined") {
    return { texture: dummyTexture(), cols, rows, setImage: () => false, repaint: () => {} };
  }
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = px;
  const ctx = canvas.getContext("2d");
  const tw = px / cols, th = px / rows;
  const hues = [350, 20, 45, 160, 195, 215, 280, 320];
  let tex = null;

  /**
   * Canvas rect for a SHADER tile index.
   *
   * The texture is `flipY`, so UV row 0 is the canvas's BOTTOM row. Writing
   * tile n at canvas row `floor(n/cols)` therefore puts it where the shader
   * looks for a different tile — an imported image lands on the wrong
   * billboards and the one you aimed at keeps its procedural art. Flipping the
   * row here is the whole fix, and it must be the ONLY place rows are
   * computed or the two paths drift apart again.
   */
  function tileRect(i) {
    const col = i % cols;
    const row = rows - 1 - Math.floor(i / cols);
    return [col * tw, row * th];
  }

  function paintTile(i, rnd) {
    const [x0, y0] = tileRect(i);
    const hue = hues[i % hues.length];
    const dark = rnd() < 0.4;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, y0, tw, th);
    ctx.clip();
    ctx.fillStyle = dark ? `hsl(${hue} 70% 12%)` : `hsl(${hue} 85% 52%)`;
    ctx.fillRect(x0, y0, tw, th);
    const ink = dark ? `hsl(${hue} 90% 62%)` : (rnd() < 0.5 ? "#ffffff" : "#111111");
    ctx.fillStyle = ink;
    const gRows = portrait ? 4 + Math.floor(rnd() * 3) : 2 + Math.floor(rnd() * 2);
    for (let r = 0; r < gRows; r++) {
      const gy = y0 + th * (0.10 + (r / gRows) * 0.78);
      const gh = th * (portrait ? 0.13 : 0.24);
      const strokes = 2 + Math.floor(rnd() * 3);
      for (let s = 0; s < strokes; s++) {
        const gx = x0 + tw * (0.14 + rnd() * 0.52);
        const gw = tw * (0.08 + rnd() * 0.3);
        ctx.fillRect(gx, gy + rnd() * gh * 0.3, gw, gh * (0.2 + rnd() * 0.5));
        ctx.fillRect(gx + rnd() * gw * 0.6, gy, gw * 0.18, gh);
      }
    }
    ctx.fillStyle = dark ? `hsl(${(hue + 40) % 360} 90% 55%)` : "#111111";
    ctx.fillRect(x0 + tw * 0.06, y0 + th * 0.90, tw * 0.88, th * 0.04);
    ctx.strokeStyle = dark ? `hsl(${hue} 90% 62%)` : "#ffffff";
    ctx.lineWidth = 6;
    ctx.strokeRect(x0 + 8, y0 + 8, tw - 16, th - 16);
    ctx.restore();
  }

  const rnd = rng(seed);
  for (let i = 0; i < cols * rows; i++) paintTile(i, rnd);
  tex = finishTexture(canvas);

  return {
    texture: tex,
    cols, rows,
    /**
     * Paint a user image into one tile. `src` may be an HTMLImageElement,
     * ImageBitmap, canvas, or anything drawImage takes. Cover-fits the tile.
     */
    setImage(slot, src) {
      const i = ((slot | 0) % (cols * rows) + cols * rows) % (cols * rows);
      const [x0, y0] = tileRect(i);
      const sw = src.width ?? src.videoWidth, sh = src.height ?? src.videoHeight;
      if (!sw || !sh) return false;
      const scale = Math.max(tw / sw, th / sh);           // cover
      const dw = sw * scale, dh = sh * scale;
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0, y0, tw, th);
      ctx.clip();
      ctx.fillStyle = "#000000";
      ctx.fillRect(x0, y0, tw, th);
      ctx.drawImage(src, x0 + (tw - dw) / 2, y0 + (th - dh) / 2, dw, dh);
      ctx.restore();
      tex.needsUpdate = true;
      return true;
    },
    /** Put the procedural art back on one tile. */
    repaint(slot) {
      paintTile(((slot | 0) % (cols * rows) + cols * rows) % (cols * rows), rng(seed + slot * 977));
      tex.needsUpdate = true;
    },
  };
}

/**
 * The hero atlas: same canvas machinery as the posters, but every tile starts
 * as a NEUTRAL PLACEHOLDER — a charcoal panel, a hairline inner border and a
 * small slot number. No logos, no glyphs, nothing pretending to be a brand.
 * It exists to be replaced by real images.
 */
function makeHeroAtlas(cols, rows, px) {
  const n = cols * rows;
  const wrap = (slot) => ((slot | 0) % n + n) % n;
  if (typeof document === "undefined") {
    const filled = new Array(n).fill(false);
    return {
      texture: dummyTexture(40, 42, 46), cols, rows,
      setImage: (slot) => { filled[wrap(slot)] = true; return true; },
      repaint: (slot) => { filled[wrap(slot)] = false; },
      isPlaceholder: (slot) => !filled[wrap(slot)],
    };
  }
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = px;
  const ctx = canvas.getContext("2d");
  const tw = px / cols, th = px / rows;
  const placeholder = new Array(n).fill(true);
  let tex = null;
  // flipY: UV row 0 is the canvas's BOTTOM row — see makeAtlas's tileRect.
  const tileRect = (i) => [(i % cols) * tw, (rows - 1 - Math.floor(i / cols)) * th];
  function paintTile(i) {
    const [x0, y0] = tileRect(i);
    ctx.save();
    ctx.beginPath(); ctx.rect(x0, y0, tw, th); ctx.clip();
    const g = ctx.createLinearGradient(x0, y0, x0, y0 + th);
    g.addColorStop(0, "#2c2f34"); g.addColorStop(1, "#1d1f23");
    ctx.fillStyle = g; ctx.fillRect(x0, y0, tw, th);
    ctx.strokeStyle = "rgba(255,255,255,0.10)"; ctx.lineWidth = 3;
    ctx.strokeRect(x0 + tw * 0.06, y0 + th * 0.06, tw * 0.88, th * 0.88);
    ctx.fillStyle = "rgba(255,255,255,0.18)";
    ctx.font = "600 " + Math.floor(th * 0.11) + "px Arial, sans-serif";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText("AD " + String(i + 1).padStart(2, "0"), x0 + tw / 2, y0 + th / 2);
    ctx.restore();
    placeholder[i] = true;
  }
  for (let i = 0; i < n; i++) paintTile(i);
  tex = finishTexture(canvas);
  return {
    texture: tex, cols, rows,
    /*
     * STRETCH-FIT, and it is stretch-fit because the TILE IS SQUARE AND THE
     * BOARD IS NOT.
     *
     * The atlas is one 2048² canvas in a 4x4 grid, so a tile is 512x512. The
     * printed panel inside a hero board's frame is 1.461:1 (`heroAspect` 0.70,
     * less a constant-metre frame), and makeHeroMaterial maps the panel's uv
     * 0..1 straight onto the tile — so whatever is in the tile is stretched
     * 1.46x horizontally on the wall. MEASURED with a circle-and-square test
     * card: the circle comes out a visibly wide ellipse.
     *
     * Cover-fit made that worse rather than better. A 1.46:1 advert was first
     * CROPPED to square, losing a third of its width, and then stretched back
     * out — damage twice over, and no source aspect could avoid both.
     *
     * Filling the tile means a 1.46:1 source is squashed to 1:1 here and
     * stretched back to 1.46:1 on the board, arriving exactly as authored.
     * So: AUTHOR ADVERTS AT ~1.46:1 (1024x700 is a good size) and they land
     * undistorted. A square source will look wide, which is now the honest
     * behaviour rather than a hidden crop.
     */
    setImage(slot, src) {
      const i = wrap(slot);
      const [x0, y0] = tileRect(i);
      const sw = src.width ?? src.videoWidth, sh = src.height ?? src.videoHeight;
      if (!sw || !sh) return false;
      ctx.save();
      ctx.beginPath(); ctx.rect(x0, y0, tw, th); ctx.clip();
      ctx.fillStyle = "#000"; ctx.fillRect(x0, y0, tw, th);
      ctx.drawImage(src, x0, y0, tw, th);
      ctx.restore();
      placeholder[i] = false;
      tex.needsUpdate = true;
      return true;
    },
    repaint(slot) { paintTile(wrap(slot)); tex.needsUpdate = true; },
    isPlaceholder(slot) { return placeholder[wrap(slot)]; },
  };
}

/**
 * An INSTANCED ATTRIBUTE IS STILL A VARYING, and a varying is interpolated.
 *
 * Every atlas material picks its tile with `fract(tile / cols)` for the column
 * and `floor(tile / cols)` for the row. That is correct arithmetic on an
 * integer and catastrophic on one that has been through the rasteriser:
 * `aSign` is read in the fragment stage, so three routes it through a varying,
 * and perspective-correct interpolation of the constant 4.0 across a quad
 * lands on 3.9999998. Then `fract(3.9999998 / 4)` is 0.99999995, not 0 — the
 * column jumps to the far side of the atlas AND the row drops by one, and
 * because the u then runs 1.0 → 1.25 the sampler clamps it, so the board shows
 * ONE COLUMN OF TEXELS from the wrong tile stretched across its whole face.
 *
 * MEASURED in road.html: tile 4 rendered as a flat wall of colour with no
 * image at all, while tiles 0 and 6 on the same mesh were perfect. It hits
 * exactly the tiles that are multiples of `cols` — 4, 8 and 12, which is 37 of
 * the city's 145 boards.
 *
 * Rounding to the nearest integer before the divide removes the whole class,
 * for one add and one floor. It is not a clamp or an epsilon: the value IS an
 * integer, and this is where it is made one again.
 */
function tileIndex(v) {
  return floor(v.add(0.5));
}

/**
 * Hero board material. LIT — a standard material, because a printed wrap is a
 * SURFACE the sun and the tower's own shadow fall on; the old unlit poster
 * floated in front of the wall at one flat brightness whatever the light did.
 * The dark frame is drawn in the shader from the quad's UV (no second draw),
 * and `aSign.w` picks SCREEN (emissive, scrolling) over PRINT (backlit at
 * night). Plain nodes shared by three slots: an Fn returning an object would
 * collapse to a swizzle.
 */
function makeHeroMaterial(atlas, u) {
  const mat = new THREE.MeshStandardNodeMaterial();
  mat.name = "CityHero";
  mat.metalness = 0.0;
  const aSign = attribute("aSign", "vec4");   // x = tile, y = frame frac in u, z = frame frac in v, w = 0 print / 1 screen
  const tex = texture(atlas.texture);
  const tile = tileIndex(aSign.x);
  const tx = fract(tile.div(atlas.cols));
  const ty = floor(tile.div(atlas.cols)).div(atlas.rows);
  const base = uv();
  const isScreen = aSign.w;
  // The image sits INSIDE the frame: remap the inner rectangle to the tile.
  const inner = vec2(
    base.x.sub(aSign.y).div(float(1.0).sub(aSign.y.mul(2.0))),
    base.y.sub(aSign.z).div(float(1.0).sub(aSign.z.mul(2.0))),
  );
  // NO SCROLL. A vertically wrapping tile shows its own seam — a doubled strip
  // across the top of every screen — and a real advert does not crawl. A
  // screen differs from a print by LIGHT, not motion.
  const auv = vec2(tx.add(clamp(inner.x, 0.0, 1.0).div(atlas.cols)), ty.add(clamp(inner.y, 0.0, 1.0).div(atlas.rows)));
  const flat = tex.sample(auv).rgb;
  /*
   * ── THE LCD, and it is what makes a screen read as a SCREEN ────────────────
   *
   * A printed wrap and an LED wall differ by more than brightness. Up close a
   * real display is a grid of emitters with black between them and a visible
   * RGB stripe inside each one, and that structure is most of why a Blade
   * Runner billboard looks like a billboard rather than a poster that happens
   * to glow. It costs about twenty ALU and it is gated to screens.
   *
   * SUBPIXELS. Each LCD pixel is split in three across; each third shows ONE
   * channel and is multiplied by 3 so the panel keeps its brightness. That
   * triples the local contrast, which is exactly the colour fringing you see on
   * a real emissive wall photographed close.
   *
   * THE FADE IS NOT OPTIONAL. A pixel grid is the textbook moire generator: the
   * instant one LCD cell is finer than one screen pixel it aliases into
   * crawling rainbow noise, and a board 300 m down an avenue is exactly that.
   * `fwidth` of the LCD-space coordinate says how many cells a pixel spans, and
   * the structure is faded out before it reaches one — past that the board is
   * simply the image, which is the correct answer at that distance anyway.
   *
   * Everything here multiplies `flat`, so a board with no image still shows its
   * placeholder through the grid rather than going black.
   */
  /*
   * SQUARE CELLS on a board that is not square. `lcdCols` counts cells ACROSS,
   * so the row count has to be scaled by the panel's height/width or the pixels
   * come out as letterbox slots. The frame fractions carry that ratio for free:
   * frU is frame/width and frV is frame/height, so frU/frV IS height/width, per
   * board, with no extra attribute.
   */
  const lcdAspect = aSign.y.div(aSign.z.max(1e-4));
  const lcdUv = vec2(inner.x.mul(u.lcdCols), inner.y.mul(u.lcdCols.mul(lcdAspect)));
  const cell = fract(lcdUv);
  // Three stripes across the cell; `sx` runs 0..3 through them.
  const sx = cell.x.mul(3.0);
  const rMask = oneMinus(step(1.0, sx));
  const gMask = step(1.0, sx).mul(oneMinus(step(2.0, sx)));
  const bMask = step(2.0, sx);
  // NOT a hard channel mask. Isolating each subpixel to one channel is what a
  // display physically does, and on a photograph at 50 m it reads as vertical
  // noise with the advert lost behind it. `lcdStrength` mixes toward that from
  // flat white, so the stripe is a strong tint rather than a filter — the
  // fringing survives, the picture survives with it.
  const stripe = mix(vec3(1.0, 1.0, 1.0), vec3(rMask, gMask, bMask).mul(3.0), u.lcdStrength);
  // The dark lattice: a gap down each subpixel and a wider one between rows,
  // which is what stops it reading as three coloured bars instead of a pixel.
  const subGap = smoothstep(float(0.0), u.lcdGap, fract(sx))
    .mul(smoothstep(float(1.0), float(1.0).sub(u.lcdGap), fract(sx)));
  const rowGap = smoothstep(float(0.0), u.lcdGap.mul(1.6), cell.y)
    .mul(smoothstep(float(1.0), float(1.0).sub(u.lcdGap.mul(1.6)), cell.y));
  const lcd = flat.mul(stripe).mul(subGap.mul(rowGap));
  // How many LCD cells one screen pixel covers. Past ~1 the grid is noise.
  const lcdTexel = max(fwidth(lcdUv.x), fwidth(lcdUv.y));
  const lcdFade = saturate(oneMinus(lcdTexel.mul(u.lcdFade))).mul(isScreen);
  const img = mix(flat, lcd, lcdFade);
  const edgeU = min(base.x, float(1.0).sub(base.x)), edgeV = min(base.y, float(1.0).sub(base.y));
  const inFrame = max(
    smoothstep(aSign.y, aSign.y.mul(0.75), edgeU),
    smoothstep(aSign.z, aSign.z.mul(0.75), edgeV),
  );
  const frameCol = vec3(0.07, 0.075, 0.08);
  // A screen's diffuse is nearly black — it is its own light.
  const albedo = mix(img.mul(mix(u.heroDay, float(0.12), isScreen)), frameCol, inFrame);
  const glow = img.mul(float(1.0).sub(inFrame))
    .mul(mix(u.nightAmount.mul(u.heroNight), u.screenBoost, isScreen));
  mat.colorNode = albedo;
  mat.emissiveNode = glow;
  mat.roughnessNode = mix(mix(float(0.62), float(0.3), isScreen), float(0.35), inFrame);
  applyBloomMRT(mat, vec4(glow, 1.0));
  return mat;
}

/** A fixed-size canvas the LED text material owns forever. */
function makeTextCanvas(str) {
  if (typeof document === "undefined") {
    return { texture: dummyTexture(255, 255, 255), set: () => {}, aspect: TEXT_W / TEXT_H };
  }
  const canvas = document.createElement("canvas");
  canvas.width = TEXT_W;
  canvas.height = TEXT_H;
  const ctx = canvas.getContext("2d");
  let tex = null;
  function set(s) {
    const text = String(s ?? "");
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, TEXT_W, TEXT_H);
    ctx.fillStyle = "#ffffff";
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
    // Shrink to fit rather than clip — a marquee that runs off the board reads
    // as a bug, and the LED grid quantises it anyway.
    let size = Math.floor(TEXT_H * 0.66);
    do {
      ctx.font = `700 ${size}px Arial, "Noto Sans JP", sans-serif`;
      if (ctx.measureText(text).width <= TEXT_W * 0.92) break;
      size -= 4;
    } while (size > 12);
    ctx.fillText(text, TEXT_W / 2, TEXT_H * 0.54);
    if (tex) tex.needsUpdate = true;
  }
  set(str);
  tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return { texture: tex, set, aspect: TEXT_W / TEXT_H };
}

/**
 * Poster material. Unlit; the atlas tile, brightness jitter and scroll speed
 * all arrive in ONE instanced vec3, so every poster in the city is one draw.
 */
function makePosterMaterial(atlas, u, name, boost) {
  const mat = new THREE.MeshBasicNodeMaterial();
  mat.name = name;
  const aSign = attribute("aSign", "vec3");   // x = tile, y = jitter, z = scroll
  const tex = texture(atlas.texture);
  const col = Fn(() => {
    const tile = tileIndex(aSign.x);
    const tx = fract(tile.div(atlas.cols));
    const ty = floor(tile.div(atlas.cols)).div(atlas.rows);
    const base = uv();
    // A non-zero scroll makes it a moving screen; zero leaves it a poster.
    const scrolled = vec2(base.x, fract(base.y.add(u.time.mul(0.05).mul(aSign.z))));
    const auv = vec2(
      tx.add(scrolled.x.div(atlas.cols)),
      ty.add(scrolled.y.div(atlas.rows)),
    );
    const ink = tex.sample(auv).rgb.mul(float(0.8).add(aSign.y.mul(0.4)));
    return ink.mul(mix(u.dayLevel, boost, u.nightAmount));
  })();
  mat.colorNode = vec4(col, 1.0);
  applyBloomMRT(mat, vec4(col.mul(u.nightAmount), 1.0));
  return mat;
}

/**
 * Neon material: a tube along the quad's long axis. Bright core, quadratic
 * falloff to the edge, hue per instance. No texture, no transparency — the
 * quad is thin enough that an opaque tube reads as a tube.
 */
function makeNeonMaterial(u) {
  const mat = new THREE.MeshBasicNodeMaterial();
  mat.name = "CityNeon";
  const aNeon = attribute("aNeon", "vec2");   // x = hue 0..1, y = intensity
  const col = Fn(() => {
    const d = abs(uv().y.sub(0.5)).mul(2.0);          // 0 at the core, 1 at the rim
    // The QUAD is the tube, so the bright part fills nearly all of it and only
    // the last sliver falls off. A soft falloff across the whole quad made a
    // 0.55 m strip read as a glowing slab; a real tube is thin and almost
    // uniformly bright. Opaque, so the falloff must not reach black inside the
    // quad or the sign becomes a dark bar in daylight.
    const glow = smoothstep(float(1.0), float(0.55), d).mul(0.85).add(0.15);
    const h = aNeon.x.mul(6.2831853);
    // Cheap hue wheel — three cosines 120 degrees apart, biased away from black.
    const rgb = vec3(
      cos(h).mul(0.5).add(0.5),
      cos(h.sub(2.0944)).mul(0.5).add(0.5),
      cos(h.sub(4.1888)).mul(0.5).add(0.5),
    ).mul(0.75).add(0.25);
    // A neon tube is bright in daylight too, just not a bloom source.
    const level = mix(float(1.0), u.neonBoost, u.nightAmount).mul(aNeon.y);
    return rgb.mul(glow.mul(level));
  })();
  mat.colorNode = vec4(col, 1.0);
  applyBloomMRT(mat, vec4(col.mul(u.nightAmount), 1.0));
  return mat;
}

/**
 * @param {object} o
 * @param {Array}  o.buildings   the city's placed buildings
 * @param {Array}  o.archetypes  kit archetypes (width, depth, massHeight)
 * @param {number} o.seed
 * @param {number} o.lobbyHeight
 * @param {object} [o.params]
 * @param {(cx:number,cz:number,k:number)=>number} o.lotRand deterministic per-lot draw
 */
export function createCitySigns({ buildings, archetypes, seed, lobbyHeight, params = {}, lotRand }) {
  const P = { ...SIGN_DEFAULTS, ...params };
  const group = new THREE.Group();
  group.name = "CitySigns";

  const u = {
    nightAmount: uniform(P.nightAmount),
    heroDay: uniform(P.heroDay),
    heroNight: uniform(P.heroNight),
    dayLevel: uniform(P.dayLevel),
    nightBoost: uniform(P.nightBoost),
    screenBoost: uniform(P.screenBoost),
    neonBoost: uniform(P.neonBoost),
    lcdCols: uniform(P.lcdCols),
    lcdGap: uniform(P.lcdGap),
    lcdFade: uniform(P.lcdFade),
    lcdStrength: uniform(P.lcdStrength),
    time: uniform(0),
  };

  const bannerAtlas = makeAtlas(seed, BANNER_COLS, BANNER_ROWS, BANNER_PX, true);
  const screenAtlas = makeAtlas(seed ^ 0x5bf03635, SCREEN_COLS, SCREEN_ROWS, SCREEN_PX, false);
  const heroAtlas = makeHeroAtlas(HERO_COLS, HERO_ROWS, HERO_PX);
  const textCanvas = makeTextCanvas(P.texts[0]);

  /**
   * Which of a lot's four faces look onto a STREET. The layout tiles the
   * world in periods of blockLots + streetLots cells; a built cell at index 0
   * of its block faces the street on its −x/−z side, one at blockLots−1 on
   * its +x/+z side. Interior cells face only their neighbours.
   */
  const period = P.blockLots + P.streetLots;
  function streetFaces(cx, cz) {
    const ix = ((cx % period) + period) % period;
    const iz = ((cz % period) + period) % period;
    const out = [];
    if (ix === 0) out.push([-1, 0]);
    if (ix === P.blockLots - 1) out.push([1, 0]);
    if (iz === 0) out.push([0, -1]);
    if (iz === P.blockLots - 1) out.push([0, 1]);
    return out;
  }

  // ── Placement ──────────────────────────────────────────────────────────────
  const FACES = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const banners = [], screens = [], bands = [], texts = [], neon = [], heroes = [];
  let megaCount = 0;
  const _q = new THREE.Quaternion();
  const _p = new THREE.Vector3();
  const _s = new THREE.Vector3(1, 1, 1);
  const _m = new THREE.Matrix4();
  const _up = new THREE.Vector3(0, 1, 0);

  /** A quad on a building face: centred at height `y`, `w` x `h` metres. */
  function faceMatrix(b, a, face, y, w, h, slide, out) {
    const [nx, nz] = face;
    const half = (nx !== 0 ? a.width : a.depth) * 0.5 + P.standoff;
    _p.set(b.x + nx * half, y, b.z + nz * half);
    // Slide along the face; the face tangent is (nz, -nx).
    _p.x += nz * (slide ?? 0);
    _p.z += -nx * (slide ?? 0);
    _q.setFromAxisAngle(_up, Math.atan2(nx, nz));
    _s.set(w, h, 1);
    return out.compose(_p, _q, _s);
  }

  /** Four neon tubes framing a `w` x `h` quad centred at `y`. */
  function neonFrame(b, a, face, y, w, h, hue, slide) {
    const t = P.neonThickness;
    const push = [
      [w + t, t, 0, (h + t) / 2],   // top
      [w + t, t, 0, -(h + t) / 2],  // bottom
      [t, h + t, (w + t) / 2, 0],   // right
      [t, h + t, -(w + t) / 2, 0],  // left
    ];
    for (const [qw, qh, ox, oy] of push) {
      faceMatrix(b, a, face, y + oy, qw, qh, (slide ?? 0) + ox, _m);
      // Nudge a hair further out so the frame never fights the board it frames.
      const [nx, nz] = face;
      _m.elements[12] += nx * 0.06;
      _m.elements[14] += nz * 0.06;
      neon.push({ m: _m.clone(), hue, intensity: 1 });
    }
  }

  for (const b of buildings) {
    const a = archetypes[b.arch];
    if (!a) continue;
    const height = b.top - b.y;
    const r0 = lotRand(b.cx, b.cz, 11);
    const face = FACES[Math.floor(r0 * 4)];
    const [nx, nz] = face;
    const faceW = nx !== 0 ? a.depth : a.width;
    // A second, different face for the mega board, so a signed building can
    // carry both without them stacking on one wall.
    const face2 = FACES[(Math.floor(r0 * 4) + 1 + Math.floor(lotRand(b.cx, b.cz, 19) * 3)) % 4];
    const faceW2 = face2[0] !== 0 ? a.depth : a.width;

    // ── HERO ADVERT ──────────────────────────────────────────────────────────
    // The default signage. Street-facing only, few, huge, framed, lit.
    const sf = streetFaces(b.cx, b.cz);
    let heroFace = null;
    if (sf.length && height > P.heroMinHeight && lotRand(b.cx, b.cz, 50) < P.heroFraction) {
      const hf = sf[Math.floor(lotRand(b.cx, b.cz, 51) * sf.length)];
      const fw = hf[0] !== 0 ? a.depth : a.width;
      if (fw > P.heroMinFace) {
        /*
         * SCREENS ARE BIGGER THAN PRINTS, and the roll happens FIRST so the
         * size can know. A printed wrap is an advert on a wall; an LED wall is
         * the thing you see the street by. Sizing both the same made the
         * screens read as posters that happened to glow — the scale is half of
         * why a Blade Runner board lands.
         *
         * Clamped to 0.98 of the face and to 62% of the building: a board wider
         * than its own wall, or one that reaches the roofline, both read as a
         * bug rather than as ambition.
         */
        const isScreen = lotRand(b.cx, b.cz, 54) < P.heroScreenFraction
          && height > P.crownMinHeight ? 1 : 0;
        const grow = isScreen ? P.heroScreenScale : 1;
        const w = fw * Math.min(P.heroFaceFrac * grow, 0.98);
        const h = Math.min(w * P.heroAspect, height * (isScreen ? 0.62 : 0.45));
        // Screens crown the tower, prints sit mid-wall — see crownLow.
        const lo = isScreen ? P.crownLow : P.heroLow;
        const hi = isScreen ? P.crownHigh : P.heroHigh;
        const top = isScreen ? P.crownTopMargin : 3;
        let y = b.y + height * (lo + lotRand(b.cx, b.cz, 52) * (hi - lo));
        y = Math.max(b.y + 8 + h / 2, Math.min(b.y + height - top - h / 2, y));
        faceMatrix(b, a, hf, y, w, h, 0, _m);
        heroes.push({
          m: _m.clone(),
          tile: Math.floor(lotRand(b.cx, b.cz, 53) * HERO_SLOTS),
          frU: P.heroFrame / w, frV: P.heroFrame / h,
          screen: isScreen,
          cx: b.cx, cz: b.cz, face: hf, w, h, y,
        });
        heroFace = hf;
      }
    }

    // ── MEGA BILLBOARD (legacy, off by default) ──────────────────────────────
    let megaFace = heroFace;
    if (height > P.megaMinHeight && faceW2 > P.megaMinFace
        && lotRand(b.cx, b.cz, 21) < P.megaFraction) {
      const w = faceW2 * P.megaFaceFrac;
      const h = Math.min(w * P.megaAspect, height * 0.42);
      const y = b.y + height * (P.megaLow + lotRand(b.cx, b.cz, 22) * (P.megaHigh - P.megaLow)) + h / 2;
      faceMatrix(b, a, face2, y, w, h, 0, _m);
      screens.push({
        m: _m.clone(),
        tile: Math.floor(lotRand(b.cx, b.cz, 23) * (SCREEN_COLS * SCREEN_ROWS)),
        jit: lotRand(b.cx, b.cz, 24),
        scroll: lotRand(b.cx, b.cz, 25) < 0.5 ? 0 : 0.6 + lotRand(b.cx, b.cz, 26),
      });
      neonFrame(b, a, face2, y, w, h, lotRand(b.cx, b.cz, 27), 0);
      megaFace = face2;
      megaCount++;
    }

    // ── STACKED BANNERS ──────────────────────────────────────────────────────
    if (lotRand(b.cx, b.cz, 12) < P.bannerFraction && height > lobbyHeight + P.bannerH * 1.5) {
      const edge = (lotRand(b.cx, b.cz, 13) < 0.5 ? -1 : 1) * (faceW * 0.5 - P.bannerW * 0.7);
      const n = Math.min(P.bannersPerEdge, Math.floor((height - lobbyHeight - 2) / (P.bannerH + 1)));
      for (let i = 0; i < n; i++) {
        const y = b.y + lobbyHeight + 1.5 + i * (P.bannerH + 1) + P.bannerH / 2;
        faceMatrix(b, a, face, y, P.bannerW, P.bannerH, edge, _m);
        banners.push({
          m: _m.clone(),
          tile: Math.floor(lotRand(b.cx, b.cz, 30 + i) * (BANNER_COLS * BANNER_ROWS)),
          jit: lotRand(b.cx, b.cz, 40 + i),
          scroll: 0,
        });
      }
    }

    // ── PODIUM LED BAND ──────────────────────────────────────────────────────
    if (lotRand(b.cx, b.cz, 14) < P.bandFraction && height > lobbyHeight + 4) {
      faceMatrix(b, a, face, b.y + lobbyHeight + P.bandH * 0.5 + 0.3, faceW * 0.96, P.bandH, 0, _m);
      bands.push(_m.clone());
    }

    // ── LED TEXT MARQUEE ─────────────────────────────────────────────────────
    // On the lobby band's face, above it — the shopfront sign.
    if (lotRand(b.cx, b.cz, 15) < P.textFraction && height > lobbyHeight + 8 && faceW > P.textW * 1.05) {
      const y = b.y + lobbyHeight + 4.6;
      faceMatrix(b, a, face, y, Math.min(P.textW, faceW * 0.8), P.textH, 0, _m);
      texts.push(_m.clone());
    }

    // ── ORDINARY SCREEN ──────────────────────────────────────────────────────
    if (!megaFace && height > P.screenMinHeight && faceW > P.screenW * 1.1
        && lotRand(b.cx, b.cz, 16) < P.screenFraction) {
      const y = b.y + height * (0.35 + lotRand(b.cx, b.cz, 17) * 0.3);
      faceMatrix(b, a, face, y, P.screenW, P.screenH, 0, _m);
      screens.push({
        m: _m.clone(),
        tile: Math.floor(lotRand(b.cx, b.cz, 18) * (SCREEN_COLS * SCREEN_ROWS)),
        jit: lotRand(b.cx, b.cz, 28),
        scroll: 0.5 + lotRand(b.cx, b.cz, 29),
      });
    }

    // ── NEON CORNER STRIPS ───────────────────────────────────────────────────
    // A tube running up one vertical edge. Cheap, and at night it is what
    // draws the eye up a tower.
    if (height > 30 && lotRand(b.cx, b.cz, 31) < P.neonFraction) {
      const h = height * P.neonCornerFrac;
      const y = b.y + lobbyHeight + h / 2;
      const edge = (lotRand(b.cx, b.cz, 32) < 0.5 ? -1 : 1) * (faceW * 0.5 - P.neonThickness);
      faceMatrix(b, a, face, y, P.neonThickness, h, edge, _m);
      neon.push({ m: _m.clone(), hue: lotRand(b.cx, b.cz, 33), intensity: 0.85 });
    }
  }

  // ── Meshes ─────────────────────────────────────────────────────────────────
  const quad = new THREE.PlaneGeometry(1, 1);

  function instanced(list, material, name, attrName, size, pack) {
    if (!list.length) return null;
    const geo = quad.clone();
    const data = new Float32Array(list.length * size);
    const im = new THREE.InstancedMesh(geo, material, list.length);
    im.name = name;
    im.frustumCulled = false;
    list.forEach((e, i) => {
      im.setMatrixAt(i, e.m ?? e);
      pack(data, i * size, e);
    });
    geo.setAttribute(attrName, new THREE.InstancedBufferAttribute(data, size));
    im.instanceMatrix.needsUpdate = true;
    group.add(im);
    return im;
  }

  const bannerMat = makePosterMaterial(bannerAtlas, u, "CityBanner", u.nightBoost);
  const screenMat = makePosterMaterial(screenAtlas, u, "CityScreen", u.screenBoost);
  const neonMat = makeNeonMaterial(u);
  const heroMat = makeHeroMaterial(heroAtlas, u);

  const packSign = (d, o, e) => { d[o] = e.tile; d[o + 1] = e.jit; d[o + 2] = e.scroll ?? 0; };
  const packNeon = (d, o, e) => { d[o] = e.hue; d[o + 1] = e.intensity; };
  const packHero = (d, o, e) => { d[o] = e.tile; d[o + 1] = e.frU; d[o + 2] = e.frV; d[o + 3] = e.screen; };

  const bannerMesh = instanced(banners, bannerMat, "CityBanners", "aSign", 3, packSign);
  const screenMesh = instanced(screens, screenMat, "CityScreens", "aSign", 3, packSign);
  const neonMesh = instanced(neon, neonMat, "CityNeon", "aNeon", 2, packNeon);
  const heroMesh = instanced(heroes, heroMat, "CityHeroes", "aSign", 4, packHero);
  if (heroMesh) { heroMesh.receiveShadow = true; heroMesh.castShadow = false; }

  // LED podium bands — chevron mode, the v2 matrix shader.
  const BAND_W = 20, BAND_H = 1.3;
  const bandMat = makeLedMatrixMaterial({ boardW: BAND_W, boardH: BAND_H });
  applyLedMatrixParams(bandMat, {
    mode: 1, shape: 1, cols: 160, rows: 8, emissive: 3.5, panSpeed: 0.35,
    chevronCount: 10, duty: 0.55, coreColor: "#ffe07a", edgeColor: "#ff4a1a",
  }, BAND_W, BAND_H);
  bandMat.side = THREE.FrontSide;

  // LED text marquees — text mode, our own fixed-size canvas.
  const textMat = makeLedMatrixMaterial({
    boardW: P.textW, boardH: P.textH,
    contentTexture: textCanvas.texture, sourceAspect: textCanvas.aspect,
  });
  applyLedMatrixParams(textMat, {
    mode: 4, shape: 1, cols: 110, rows: 20, emissive: 4.0, panSpeed: 0.22,
    rgb: false, tintColor: "#ff3a2a", useRamp: true,
    coreColor: "#ffd27a", edgeColor: "#ff2a12",
  }, P.textW, P.textH);
  textMat.side = THREE.FrontSide;

  let bandMesh = null, textMesh = null;
  if (bands.length) {
    bandMesh = new THREE.InstancedMesh(quad, bandMat, bands.length);
    bandMesh.name = "CityBands";
    bandMesh.frustumCulled = false;
    bands.forEach((m, i) => bandMesh.setMatrixAt(i, m));
    bandMesh.instanceMatrix.needsUpdate = true;
    group.add(bandMesh);
  }
  if (texts.length) {
    textMesh = new THREE.InstancedMesh(quad, textMat, texts.length);
    textMesh.name = "CityTexts";
    textMesh.frustumCulled = false;
    texts.forEach((m, i) => textMesh.setMatrixAt(i, m));
    textMesh.instanceMatrix.needsUpdate = true;
    group.add(textMesh);
  }

  return {
    group,
    params: P,
    stats: {
      heroes: heroes.length,
      banners: banners.length, bands: bands.length, texts: texts.length,
      neon: neon.length, mega: megaCount,
      /** Mega boards and ordinary screens share one mesh; this is the total. */
      screens: screens.length,
    },
    setNight(n) { u.nightAmount.value = n; },
    setTime(t) { u.time.value = t; },

    /**
     * Live-push any sign uniform. Every LED knob (`screenBoost`, `lcdCols`,
     * `lcdGap`, `lcdFade`, `lcdStrength`) is a plain uniform, so tuning the
     * look never needs a city rebuild — which matters because a rebuild is
     * seconds and judging a screen is a dozen small nudges. `nightAmount` is
     * excluded: it is driven per frame by setNight and a written value would
     * be overwritten on the next tick anyway.
     */
    applyParams(patch = {}) {
      for (const k of Object.keys(patch)) {
        if (k === "nightAmount" || k === "time") continue;
        if (u[k]) { u[k].value = patch[k]; P[k] = patch[k]; }
      }
    },

    /** ── HERO ADVERTS ──────────────────────────────────────────────────────
     *  `HERO_SLOTS` image slots; every board points at one. Put a real image
     *  in a slot and every board on it changes — no new draw, no new texture,
     *  no shader rebuild. */
    heroSlots: HERO_SLOTS,
    /** Where every board is, for a picker UI: {cx, cz, face, w, h, y, tile, screen}. */
    heroes: heroes.map((h, i) => ({ index: i, cx: h.cx, cz: h.cz, face: h.face, w: h.w, h: h.h, y: h.y, tile: h.tile, screen: h.screen })),
    /** Paint an image (HTMLImageElement / ImageBitmap / canvas / video) into a slot. */
    setHeroImage(slot, src) { return heroAtlas.setImage(slot, src); },
    /** Load a URL or data URL into a slot. */
    async loadHeroImage(slot, url) {
      if (typeof Image === "undefined") return false;
      const img = await new Promise((res, rej) => {
        const im = new Image();
        im.crossOrigin = "anonymous";
        im.onload = () => res(im);
        im.onerror = rej;
        im.src = url;
      });
      return heroAtlas.setImage(slot, img);
    },
    /** Back to the neutral placeholder on one slot. */
    resetHeroImage(slot) { heroAtlas.repaint(slot); },
    /** Is a slot still showing its placeholder? */
    heroSlotIsPlaceholder(slot) { return heroAtlas.isPlaceholder(slot); },
    /** Point one board at a different slot, or flip it between print/screen. */
    setHero(index, { slot, screen } = {}) {
      const h = heroes[index];
      if (!h || !heroMesh) return false;
      if (slot != null) h.tile = ((slot | 0) % HERO_SLOTS + HERO_SLOTS) % HERO_SLOTS;
      if (screen != null) h.screen = screen ? 1 : 0;
      const attr = heroMesh.geometry.getAttribute("aSign");
      attr.setXYZW(index, h.tile, h.frU, h.frV, h.screen);
      attr.needsUpdate = true;
      return true;
    },

    /**
     * Put an image on every billboard using `slot` (0..3). Accepts anything
     * `drawImage` takes: HTMLImageElement, ImageBitmap, canvas, video.
     * No new draw call, no new texture, no shader rebuild.
     */
    setScreenImage(slot, src) { return screenAtlas.setImage(slot, src); },
    /** Same, for the narrow vertical banners (0..7). */
    setBannerImage(slot, src) { return bannerAtlas.setImage(slot, src); },
    /** Restore the procedural art on one screen slot. */
    resetScreenImage(slot) { screenAtlas.repaint(slot); },
    /** Load a URL or data URL into a screen slot. */
    async loadScreenImage(slot, url) {
      if (typeof Image === "undefined") return false;
      const img = await new Promise((res, rej) => {
        const im = new Image();
        im.crossOrigin = "anonymous";
        im.onload = () => res(im);
        im.onerror = rej;
        im.src = url;
      });
      return screenAtlas.setImage(slot, img);
    },
    /** What every LED marquee says. Free — it repaints a canvas in place. */
    setText(str) { textCanvas.set(str); },

    dispose() {
      for (const m of [bannerMesh, screenMesh, neonMesh, bandMesh, textMesh, heroMesh]) {
        if (!m) continue;
        group.remove(m);
        if (m.geometry !== quad) m.geometry.dispose();
        m.dispose();
      }
      bannerMat.dispose(); screenMat.dispose(); neonMat.dispose(); heroMat.dispose();
      heroAtlas.texture.dispose();
      bandMat.dispose(); textMat.dispose();
      quad.dispose();
      bannerAtlas.texture.dispose();
      screenAtlas.texture.dispose();
      textCanvas.texture.dispose();
    },
  };
}
