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
import { buildAdTotemMesh, AD_TOTEM } from "./modularRoadAdBillboard.js";

export const SIGN_DEFAULTS = {
  /* ── shopfront neon and the kerb ribbon ─────────────────────────────────── */
  /** How many street-facing faces get a neon word. */
  wordFraction: 0.55,
  /** Metres. The ASPECT must match the atlas tile's or the lettering stretches. */
  wordW: 4.6,
  wordAspect: 4,
  /** Height of its centre above the pavement — above a door, below a first floor. */
  wordY: 3.5,
  /** Of the faces that get a word, how many also get a ribbon at the kerb. */
  ribbonFraction: 0.7,
  ribbonH: 0.42,
  ribbonY: 0.62,

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
  /** Board thickness, metres. Under `standoff` (0.45) so the box reaches the
   *  wall without touching it — see the note where the boxes are built. */
  /** How many street-facing building faces get a pavement citylight. */
  totemFraction: 0.3,
  /** Metres out from the wall — it stands on the pavement, not against it. */
  totemStandoff: 2.6,
  heroDepth: 0.4,
  heroBoxColor: 0x2a2d33,
  /**
   * Fraction of ordinary heroes that are LED screens. ZERO, and deliberately.
   *
   * Sixteen glowing walls scattered over the skyline is wallpaper: none of
   * them is a place, and each one makes the next less remarkable. There is
   * exactly ONE LED wall in the city, it is a landmark, and it is placed by
   * the block below rather than rolled per building. Everything else is a
   * printed wrap, which is what an advert on a building actually is.
   */
  heroScreenFraction: 0,

  /* ── THE ONE LED WALL: how big, and where ────────────────────────────────
   * It spans a RUN OF ADJACENT BUILDINGS along a block edge, so it is wider
   * than any single facade could ever be. */
  /** How many neighbouring lots it spans. 3 lots is ~95 m of wall. */
  ledSpanLots: 3,
  /** Fraction of the run it actually covers — under 1 so it reads as mounted
   *  on the block rather than as the block's own surface. */
  ledSpanFrac: 0.94,
  /** Board height as a fraction of its width, and a hard cap against the
   *  SHORTEST building in the run so it can never overhang one. */
  ledSpanAspect: 0.30,
  ledSpanHeightCap: 0.42,
  /** Every building under the board must be at least this tall. */
  ledSpanMinHeight: 52,
  /** Metres of wall left above the board. */
  ledSpanTopMargin: 6,
  /** Which atlas slot the wall shows. Pinned rather than rolled: there is one
   *  of these and you should be able to choose what is on it. */
  ledSpanTile: 0,
  /** Print level by day; backlight at night. Screens use screenBoost. */
  heroDay: 1.0,
  heroNight: 2.4,
  /** The block layout the street-face test reads (the city's own numbers). */
  blockLots: 4,
  streetLots: 1,

  /** Fraction of buildings that get each of the OLD kinds. All off. */
  bannerFraction: 0,
  /**
   * How many podiums get the LED band that WRAPS the corner.
   *
   * Was 0 — the band existed as a single quad on a single face, which reads as
   * a poster stuck on rather than as part of the building, and it was not worth
   * having. It wraps now (four faces, mitred at the corners), which is the
   * thing that made it worth turning on. Kept well under half so a street has
   * some and not every tower.
   */
  bandFraction: 0.22,
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
   * Emissive level of THE LED wall.
   *
   * Tuned against the dot mask, not against a smooth panel: most of the board
   * is the dark gap between emitters, so the lit dots have to sit well above
   * what a flat glowing quad would need to reach the same apparent brightness.
   */
  screenBoost: 2.6,
  nightAmount: 0,

  /* ── THE LED WALL ─────────────────────────────────────────────────────────
   *
   * ONE board in the city runs this, and it is a landmark rather than a class
   * of signage — see the placement block at the end of createCitySigns. Every
   * other hero is a printed wrap, which is why `heroScreenFraction` is 0.
   *
   * THE MODEL IS v2/objects/shared/ledMatrix.js, ported rather than imported.
   * That file is the canonical LED shader and it gets this right in a way the
   * first attempt here did not: the previous version drew a subpixel grid OVER
   * a smooth photograph, which is a photo with a screen door in front of it.
   * An LED wall is not that — the image is SAMPLED PER EMITTER, so each LED
   * shows one flat colour and the picture is genuinely made of them. That is
   * `ledUv` below, and it is the whole difference.
   *
   * It is ported and not imported because ledMatrix owns a material per board
   * with its own uv and one content texture, while every hero here is an
   * instance in ONE mesh reading ONE atlas by a per-instance tile. Importing
   * it would cost a draw call and give up the atlas; porting the model costs
   * about fifteen ALU on a quad.
   */
  /**
   * Distance between LED centres, in METRES. The grid follows from the board's
   * own size, so a bigger wall gets MORE emitters rather than bigger ones —
   * which is the property a fixed column count does not have, and the reason
   * the mega board would otherwise have looked like a low-res texture.
   *
   * Deliberately far coarser than a real wall (10–50 mm). At a true pitch a
   * 96 m board carries ~2000 emitters across, and from anywhere you actually
   * drive that is comfortably sub-pixel — the structure would be correct,
   * invisible, and pointless. This is the pitch of a stadium screen, which is
   * the thing that reads as "made of LEDs" from across a city.
   *
   * TUNED IN THE GAME against the two failure modes either side of it, on the
   * 96 m wall (so ~230 emitters across, 68 down):
   *   0.34  emitters too fine to read at 95 m — a photo again
   *   0.55  unmistakably LEDs, and the advert is mush
   *   0.42  emitters countable at 40 m, obvious at 95 m, and the truck,
   *         the script and the strapline all still read
   */
  ledPitch: 0.42,
  /** Emitter radius as a fraction of its cell. Below ~0.3 the board goes dark
   *  between dots; above ~0.45 they touch and it is a smooth panel again. */
  ledDotRadius: 0.36,
  /** Edge softness on the dot, in cell units. Pure AA — keep it small. */
  ledDotSoft: 0.07,
  /**
   * The LOD window, in LED CELLS PER SCREEN PIXEL.
   *
   * A dot grid is the textbook moire generator, so both the dot mask and the
   * per-emitter sampling cross-fade to their smooth equivalents as the cells
   * shrink: full structure below `ledLodFar`, gone above `ledLodNear`. The
   * mask fades to `ledCoverage` — the dots' own average — rather than to 1, so
   * the board holds its brightness across the transition instead of flaring.
   */
  ledLodNear: 0.95,
  ledLodFar: 0.10,
  /** How much bigger a SCREEN board is than a printed one. */
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
/** Shop-front neon: 4:1 tiles, so two columns of eight fill a square page. */
export const WORD_COLS = 2, WORD_ROWS = 8, WORD_PX = 2048;
export const WORD_SLOTS = WORD_COLS * WORD_ROWS;

/**
 * ── NEON WITH ACTUAL WORDS ───────────────────────────────────────────────────
 *
 * The city already had `neon`, and it is a coloured TUBE — a glowing bar that
 * frames a billboard. What a street like the reference is actually full of is
 * shop signs that SAY something, at head height, in a dozen different colours,
 * and that is a different object: artwork, not a shape.
 *
 * One canvas page, sixteen tiles, one instanced quad per sign. The tiles are 4:1
 * because that is the shape a shopfront sign is, and because the quad's aspect
 * has to match the tile's or the lettering stretches — the same rule the gantry
 * atlas states and the portal band follows.
 *
 * OPAQUE, deliberately. A neon sign drawn with transparency would erase the
 * emissive attachment behind it (r184 blends only `output`), and the dark tile
 * background reads as the sign's own backing box, which is what most of them
 * have anyway. So the transparency problem is avoided rather than solved.
 */
function makeNeonWordAtlas(px = WORD_PX, cols = WORD_COLS, rows = WORD_ROWS) {
  if (typeof document === "undefined") return { texture: dummyTexture(), cols, rows };
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = px;
  const ctx = canvas.getContext("2d");
  const tw = px / cols, th = px / rows;
  const WORDS = [
    ["RAMEN", "#ff2d55"], ["OPEN 24H", "#25e0ff"], ["BAR", "#ffb020"],
    ["NOODLES", "#ff4fd8"], ["SUSHI", "#39ff88"], ["HOTEL", "#ff2d55"],
    ["KARAOKE", "#a06bff"], ["COFFEE", "#ffd24a"], ["CLUB", "#25e0ff"],
    ["TATTOO", "#ff4fd8"], ["PHARMACY", "#39ff88"], ["LIVE", "#ff6a1a"],
    ["CASINO", "#ffd24a"], ["MOTEL", "#ff2d55"], ["EAT", "#25e0ff"],
    ["EXCHANGE", "#a06bff"],
  ];
  ctx.fillStyle = "#07060a";
  ctx.fillRect(0, 0, px, px);
  for (let i = 0; i < cols * rows; i++) {
    const col = i % cols;
    // flipY, exactly as `makeAtlas` explains: shader row 0 is the canvas bottom.
    const row = rows - 1 - Math.floor(i / cols);
    const x0 = col * tw, y0 = row * th;
    const [word, hue] = WORDS[i % WORDS.length];

    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, y0, tw, th);
    ctx.clip();
    // The backing box, and a thin bright keyline round it — every one of these
    // signs is a physical object bolted to a wall, not a decal.
    ctx.fillStyle = "#0a0910";
    ctx.fillRect(x0, y0, tw, th);
    ctx.strokeStyle = "rgba(255,255,255,0.10)";
    ctx.lineWidth = Math.max(2, th * 0.02);
    ctx.strokeRect(x0 + th * 0.06, y0 + th * 0.06, tw - th * 0.12, th - th * 0.12);

    /*
     * NEON IS BUILT UP IN THREE PASSES, and the order is what makes it read:
     * a wide soft halo in the tube's colour, a tighter stroke of the same, then
     * a near-white core. One pass of coloured text looks like coloured text.
     */
    const cx = x0 + tw / 2, cy = y0 + th / 2;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    let size = Math.round(th * 0.52);
    ctx.font = `bold ${size}px system-ui, sans-serif`;
    while (ctx.measureText(word).width > tw * 0.82 && size > 12) {
      size -= 2;
      ctx.font = `bold ${size}px system-ui, sans-serif`;
    }
    ctx.shadowColor = hue;
    ctx.lineJoin = "round";
    ctx.shadowBlur = th * 0.30;
    ctx.strokeStyle = hue;
    ctx.lineWidth = size * 0.30;
    ctx.strokeText(word, cx, cy);
    ctx.shadowBlur = th * 0.14;
    ctx.lineWidth = size * 0.14;
    ctx.strokeText(word, cx, cy);
    ctx.shadowBlur = th * 0.05;
    ctx.fillStyle = "#fff8f2";
    ctx.fillText(word, cx, cy);
    ctx.restore();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return { texture: tex, cols, rows };
}

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

/** Fraction of a unit cell a round emitter of radius `r` covers. */
function dotCoverage(r) {
  return Math.min(1, Math.PI * r * r);
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
  /*
   * ── THE IMAGE IS SAMPLED PER EMITTER ─────────────────────────────────────
   *
   * This is the line that makes it an LED wall rather than a photograph with a
   * grid over it. `cellUv` is the CENTRE of the LED the fragment falls in, so
   * every fragment inside one emitter reads the SAME texel and the whole cell
   * lights one flat colour — which is what an LED wall physically does, and
   * what the eye reads as "made of LEDs". Sampling the photo continuously and
   * multiplying a mask over it, which is what this did before, gives a smooth
   * picture behind a screen door and reads as neither.
   *
   * The grid comes from a real dot PITCH, so the board's own size decides the
   * emitter count: a 90 m wall gets 260 LEDs across and a 12 m one gets 35,
   * and both have the same physical pixel. `panelW`/`panelH` recover that size
   * from the frame fractions the instance already carries — frU is frame/w, so
   * w is frame/frU and the lit panel inside it is w − 2·frame. No new
   * attribute, no second uniform per board.
   *
   * SQUARE CELLS FALL OUT FOR FREE, because both axes are divided by the same
   * metre pitch rather than by a column count the aspect then has to correct.
   */
  const panelW = u.heroFrameM.div(aSign.y.max(1e-4)).sub(u.heroFrameM.mul(2.0));
  const panelH = u.heroFrameM.div(aSign.z.max(1e-4)).sub(u.heroFrameM.mul(2.0));
  const ledCols = panelW.div(u.ledPitch).max(2.0);
  const ledRows = panelH.div(u.ledPitch).max(2.0);
  const grid = vec2(inner.x.mul(ledCols), inner.y.mul(ledRows));
  const cellCentre = floor(grid).add(0.5);
  const local = grid.sub(cellCentre);          // −0.5 … 0.5 within the emitter
  /*
   * SCREEN-SPACE LOD, and it is not optional. A dot grid is the textbook moire
   * generator: the instant a cell is finer than a pixel it turns into crawling
   * noise. `fwidth` of the LED-space coordinate says how many cells a pixel
   * spans, and BOTH the mask and the per-emitter snapping cross-fade to their
   * smooth equivalents across that window — so the far board is simply the
   * image at the correct average brightness, which is also what it looks like
   * in life from that distance.
   *
   * Derivatives at TOP LEVEL, never inside a branch (cityShaderTest enforces
   * it), and `isScreen` folded in here so a printed wrap runs none of it.
   */
  const cellsPerPx = max(fwidth(inner.x).mul(ledCols), fwidth(inner.y).mul(ledRows));
  const sharp = smoothstep(u.ledLodNear, u.ledLodFar, cellsPerPx).mul(isScreen);
  const ledUv = mix(inner, cellCentre.div(vec2(ledCols, ledRows)), sharp);

  // NO SCROLL. A vertically wrapping tile shows its own seam — a doubled strip
  // across the top of every screen — and a real advert does not crawl. A
  // screen differs from a print by LIGHT, not motion.
  const auv = vec2(
    tx.add(clamp(ledUv.x, 0.0, 1.0).div(atlas.cols)),
    ty.add(clamp(ledUv.y, 0.0, 1.0).div(atlas.rows)),
  );
  const flat = tex.sample(auv).rgb;

  /*
   * THE EMITTER, and the reason the mask fades to `ledCoverage` rather than to
   * 1.0: most of an LED wall is the dark gap between dots, so its average is
   * well under full. Dissolving toward 1 makes the board FLARE as it recedes;
   * dissolving toward the dots' own coverage holds one brightness all the way
   * out. Round, because a round emitter behind a diffuser is what a stadium
   * screen actually is, and a square one just reads as a low-res texture.
   */
  const dotDist = local.length();
  const rawDot = smoothstep(u.ledDotRadius, u.ledDotRadius.sub(u.ledDotSoft), dotDist);
  const dotMask = mix(float(1.0), mix(u.ledCoverage, rawDot, sharp), isScreen);
  const img = flat.mul(dotMask);
  /*
   * BLOOM SEES A FULLER BOARD THAN THE EYE DOES — the same split ledMatrix.js
   * makes, for the same reason. The visible mask fades to ~40% coverage at
   * distance, which is the correct average brightness but drops a far board
   * under the bloom threshold, so its glow would die exactly where a real LED
   * wall's glow is the whole point. Up close the two masks are identical.
   */
  const bloomMask = mix(float(1.0), mix(float(1.0), rawDot, sharp), isScreen);
  const bloomImg = flat.mul(bloomMask);
  const edgeU = min(base.x, float(1.0).sub(base.x)), edgeV = min(base.y, float(1.0).sub(base.y));
  const inFrame = max(
    smoothstep(aSign.y, aSign.y.mul(0.75), edgeU),
    smoothstep(aSign.z, aSign.z.mul(0.75), edgeV),
  );
  const frameCol = vec3(0.07, 0.075, 0.08);
  // A screen's diffuse is nearly black — it is its own light.
  const albedo = mix(img.mul(mix(u.heroDay, float(0.12), isScreen)), frameCol, inFrame);
  const level = mix(u.nightAmount.mul(u.heroNight), u.screenBoost, isScreen);
  const notFrame = float(1.0).sub(inFrame);
  const glow = img.mul(notFrame).mul(level);
  mat.colorNode = albedo;
  mat.emissiveNode = glow;
  mat.roughnessNode = mix(mix(float(0.62), float(0.3), isScreen), float(0.35), inFrame);
  applyBloomMRT(mat, vec4(bloomImg.mul(notFrame).mul(level), 1.0));
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
/** Shop neon: an atlas tile, lifted hard at night, and a bloom source. */
function makeNeonWordMaterial(atlas, u) {
  const mat = new THREE.MeshBasicNodeMaterial();
  mat.name = "CityNeonWord";
  const aWord = attribute("aWord", "vec2");    // x = tile, y = per-sign level
  const tex = texture(atlas.texture);
  const col = Fn(() => {
    const tile = tileIndex(aWord.x);
    const tx = fract(tile.div(atlas.cols));
    const ty = floor(tile.div(atlas.cols)).div(atlas.rows);
    const base = uv();
    const auv = vec2(tx.add(base.x.div(atlas.cols)), ty.add(base.y.div(atlas.rows)));
    const ink = tex.sample(auv).rgb;
    /*
     * A neon sign is ON in daylight too — that is why you can tell an open shop
     * from a shut one at noon — it just is not a bloom source until dusk. So the
     * day level is a real number rather than zero, and only the night term
     * reaches the emissive buffer below.
     */
    return ink.mul(mix(u.dayLevel.mul(1.35), u.neonBoost, u.nightAmount)).mul(aWord.y);
  })();
  mat.colorNode = vec4(col, 1.0);
  applyBloomMRT(mat, vec4(col.mul(u.nightAmount), 1.0));
  return mat;
}

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
    // The board's physical size is recovered in the shader from the frame
    // fractions, so the frame's metre width has to be a uniform too.
    heroFrameM: uniform(P.heroFrame),
    ledPitch: uniform(P.ledPitch),
    ledDotRadius: uniform(P.ledDotRadius),
    ledDotSoft: uniform(P.ledDotSoft),
    ledLodNear: uniform(P.ledLodNear),
    ledLodFar: uniform(P.ledLodFar),
    /* The dots' own average coverage — what the mask dissolves TO at distance
     * so the board holds its brightness. Derived, never authored: a round dot
     * of radius r in a unit cell covers pi*r^2, and authoring it separately
     * just means it can disagree with the radius it is supposed to describe. */
    ledCoverage: uniform(dotCoverage(P.ledDotRadius)),
    time: uniform(0),
  };

  const bannerAtlas = makeAtlas(seed, BANNER_COLS, BANNER_ROWS, BANNER_PX, true);
  const screenAtlas = makeAtlas(seed ^ 0x5bf03635, SCREEN_COLS, SCREEN_ROWS, SCREEN_PX, false);
  const heroAtlas = makeHeroAtlas(HERO_COLS, HERO_ROWS, HERO_PX);
  const wordAtlas = makeNeonWordAtlas();
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
  /** Shop-front neon words, and the kerb ribbons under them. */
  const words = [], ribbons = [];
  /** Pavement citylights — the track builder's ad totem, finally in the city. */
  const totems = [], totemPosters = [];
  /** The single LED wall, once placed — null if no run in the city qualified. */
  let ledWall = null;
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

    /*
     * ── PODIUM LED BAND, WHICH NOW GOES ROUND THE CORNER ───────────────────────
     *
     * It used to be one quad on one face, which is a poster. A real one runs
     * round the whole podium and turns the corners, and that is most of why it
     * reads as architecture rather than as a sticker: you see it continue past
     * the edge of the building.
     *
     * Four quads, one per face, each sized to ITS OWN face — a tower is not
     * square, so using one width for all four leaves two of them short. They
     * overlap slightly at the corners: each is inset from the wall by
     * `standoff`, so meeting them exactly at the corner leaves a notch you can
     * see straight through.
     *
     * The band runs the CHEVRON pattern, and that is what makes this safe. A
     * repeating pattern turning a corner needs no continuity of content, so
     * there is no per-face scroll offset to carry and nothing to keep in phase.
     * Text would need one, and would need the shared v2 LED material changed to
     * take it.
     */
    if (lotRand(b.cx, b.cz, 14) < P.bandFraction && height > lobbyHeight + 4) {
      const bandY = b.y + lobbyHeight + P.bandH * 0.5 + 0.3;
      for (const f of FACES) {
        const fW = (f[0] !== 0 ? a.depth : a.width);
        faceMatrix(b, a, f, bandY, fW + P.standoff * 2 + 0.06, P.bandH, 0, _m);
        bands.push(_m.clone());
      }
    }

    /*
     * ── SHOPFRONT NEON, AND THE RIBBON UNDER IT ────────────────────────────────
     *
     * The two things the reference street is full of at eye level, and the two
     * the city had nothing of: a sign that says RAMEN, and a strip of scrolling
     * text along the kerb under it. Both go on faces that actually front a
     * street — a neon sign in an interior courtyard is lighting a wall nobody
     * stands at.
     *
     * They are placed together on purpose. A sign with a ribbon under it reads
     * as one shop; scattered independently they read as decoration.
     */
    for (const sf of streetFaces(b.cx, b.cz)) {
      const fW = (sf[0] !== 0 ? a.depth : a.width);
      if (fW < P.wordW * 1.4) continue;
      const r0 = lotRand(b.cx, b.cz, 61 + sf[0] * 3 + sf[1]);
      if (r0 > P.wordFraction) continue;
      // Along the face, clear of the corners.
      const room = fW * 0.5 - P.wordW * 0.62;
      const slide = (lotRand(b.cx, b.cz, 62 + sf[0] + sf[1] * 2) * 2 - 1) * Math.max(0, room);
      const wy = b.y + P.wordY;
      faceMatrix(b, a, sf, wy, P.wordW, P.wordW / P.wordAspect, slide, _m);
      words.push({
        m: _m.clone(),
        tile: Math.floor(lotRand(b.cx, b.cz, 63 + sf[0] + sf[1]) * WORD_SLOTS),
        level: 0.75 + lotRand(b.cx, b.cz, 64 + sf[0] - sf[1]) * 0.5,
      });
      if (lotRand(b.cx, b.cz, 65 + sf[0] * 2 + sf[1]) < P.ribbonFraction) {
        faceMatrix(b, a, sf, b.y + P.ribbonY, fW * 0.92, P.ribbonH, 0, _m);
        ribbons.push(_m.clone());
      }
    }

    /*
     * ── CITYLIGHTS ON THE PAVEMENT ─────────────────────────────────────────
     *
     * The track builder has had an "Ad totem" since the scenery kit was
     * written — a 1.28 x 2.22 m portrait cabinet, the thing that stands beside
     * a bus stop — and the city never used it. Every advert in the city was
     * three storeys up, which is why the streets read as walls with posters on
     * them rather than as somewhere a person waits for a bus.
     *
     * It stands on the PAVEMENT, so it is pushed out past the building by
     * `totemStandoff` rather than the wall `standoff` the mounted signs use,
     * and it sits on the building's own base height.
     *
     * The poster costs NOTHING: it is pushed into the banner list, so it is
     * another instance of a mesh that already exists, off the portrait atlas
     * that is already the right shape for it. Only the cabinet is new, and
     * that is two instanced meshes for every totem in the city.
     */
    for (const sf of streetFaces(b.cx, b.cz)) {
      if (lotRand(b.cx, b.cz, 71 + sf[0] * 5 + sf[1]) > P.totemFraction) continue;
      const fW = (sf[0] !== 0 ? a.depth : a.width);
      // Along the face, well clear of the corners a kerb turns at.
      const slide = (lotRand(b.cx, b.cz, 72 + sf[0] + sf[1] * 3) * 2 - 1) * (fW * 0.3);
      const [nx, nz] = sf;
      const half = (nx !== 0 ? a.width : a.depth) * 0.5 + P.totemStandoff;
      _p.set(b.x + nx * half + nz * slide, b.y, b.z + nz * half - nx * slide);
      _q.setFromAxisAngle(_up, Math.atan2(nx, nz));
      totems.push(_m.compose(_p, _q, _s.set(1, 1, 1)).clone());
      // The poster plane, on the cabinet's own front face.
      const cy = AD_TOTEM.baseH + AD_TOTEM.panelH * 0.5;
      const out = AD_TOTEM.depth * 0.52;
      _p.set(b.x + nx * (half + out) + nz * slide, b.y + cy, b.z + nz * (half + out) - nx * slide);
      /*
       * ITS OWN LIST, not the banner list it first went into.
       *
       * Sharing the banner MATERIAL is free and right — the portrait atlas is
       * already the shape a citylight poster is. Sharing its LIST was not:
       * `banners` means tower-scale wall banners, which are off by default, and
       * the stats immediately read "626 banners" for a city with none. One draw
       * either way; this way the number still means something.
       */
      totemPosters.push({
        m: _m.compose(_p, _q, _s.set(AD_TOTEM.panelW - 0.06, AD_TOTEM.panelH - 0.06, 1)).clone(),
        tile: Math.floor(lotRand(b.cx, b.cz, 73 + sf[0] - sf[1]) * (BANNER_COLS * BANNER_ROWS)),
        jit: lotRand(b.cx, b.cz, 74 + sf[0] + sf[1]),
        scroll: 0,
      });
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


  /* ══ THE LED WALL ══════════════════════════════════════════════════════════
   *
   * One board, and it does not belong to a building.
   *
   * Every other sign in this file is rolled per lot: a building qualifies, a
   * hash says yes, a board goes on its wall. That is right for signage and
   * wrong for a landmark — a landmark has to be findable, has to be the only
   * one, and has to be BIGGER THAN ANY FACADE, which per-lot placement can
   * never give you because the widest lot is 34 m.
   *
   * So this is a second pass over the finished layout. It looks for a RUN of
   * adjacent buildings along one block edge — same edge, all built, all tall
   * enough — and hangs a single quad across the whole run. Three lots is about
   * 95 m of wall, which is the width of two or three towers, and the board
   * fronts all of them at once.
   *
   * ── WHY A RUN AND NOT A BILLBOARD ON A POST ──────────────────────────────
   *
   * A free-standing structure would need its own geometry, its own draw call
   * and its own collision, and it would have to be sited somewhere the track
   * never goes. Hanging the board on a wall that already exists costs ONE MORE
   * INSTANCE in the hero mesh — no new mesh, no new material, no new draw —
   * and the buildings behind it are already solid, so the collision is done.
   *
   * ── WHY IT CANNOT OVERHANG ───────────────────────────────────────────────
   *
   * The run's buildings are different heights, and a board sized off the
   * tallest would float in front of the shortest with sky behind it. So the
   * height is capped against the MINIMUM top in the run and hung below it:
   * whatever the skyline does, every part of the board has wall behind it.
   *
   * Likewise the stand-off is taken from the DEEPEST building on the run, so
   * the board clears the one that sticks out furthest instead of being
   * swallowed by it.
   */
  {
    const lots = new Map();
    for (const b of buildings) lots.set(b.cx + "," + b.cz, b);

    // Runs advance along the edge: a z-facing edge runs in x, and vice versa.
    let best = null;
    for (const b of buildings) {
      for (const face of streetFaces(b.cx, b.cz)) {
        const stepX = face[0] !== 0 ? 0 : 1;
        const stepZ = face[0] !== 0 ? 1 : 0;
        const run = [];
        let minTop = Infinity, maxHalf = 0, ok = true;
        for (let k = 0; k < P.ledSpanLots; k++) {
          const n = lots.get((b.cx + stepX * k) + "," + (b.cz + stepZ * k));
          const a = n && archetypes[n.arch];
          // Same edge for every lot in the run, or the board turns a corner.
          if (!a || !streetFaces(n.cx, n.cz).some(f => f[0] === face[0] && f[1] === face[1])) { ok = false; break; }
          if (n.top - n.y < P.ledSpanMinHeight) { ok = false; break; }
          run.push(n);
          minTop = Math.min(minTop, n.top);
          maxHalf = Math.max(maxHalf, (face[0] !== 0 ? a.width : a.depth) * 0.5);
        }
        if (!ok || run.length < P.ledSpanLots) continue;
        /*
         * Pick DOWNTOWN. The tallest run would put the board where the towers
         * already compete with it; the run nearest the origin is where the
         * track and the player are, and a landmark you never drive past is not
         * one. Ties break on height so it still lands on a real wall.
         */
        const mid = run[(run.length / 2) | 0];
        const score = Math.hypot(mid.x, mid.z) - (minTop - mid.y) * 0.5;
        if (!best || score < best.score) best = { run, face, minTop, maxHalf, score };
      }
    }

    if (best) {
      const { run, face, minTop, maxHalf } = best;
      const [nx, nz] = face;
      const first = run[0], last = run[run.length - 1];
      // Centre of the run, pushed out to the shared face plane.
      const cxw = (first.x + last.x) * 0.5 + nx * (maxHalf + P.standoff);
      const czw = (first.z + last.z) * 0.5 + nz * (maxHalf + P.standoff);
      /*
       * The run's own spacing IS the lot pitch, so the wall length needs no
       * lotSize passed in: centre-to-centre over (n-1) gaps gives the pitch,
       * and n pitches is the block frontage the run occupies.
       */
      const centres = Math.abs(last.x - first.x) + Math.abs(last.z - first.z);
      const pitch = centres / Math.max(1, run.length - 1);
      const runLen = pitch * run.length;
      const w = runLen * P.ledSpanFrac;
      const lowest = minTop - Math.max(...run.map(r => r.y));
      const h = Math.min(w * P.ledSpanAspect, lowest * P.ledSpanHeightCap);
      const y = minTop - P.ledSpanTopMargin - h / 2;

      _p.set(cxw, y, czw);
      _q.setFromAxisAngle(_up, Math.atan2(nx, nz));
      _s.set(w, h, 1);
      _m.compose(_p, _q, _s);
      heroes.push({
        m: _m.clone(),
        tile: ((P.ledSpanTile | 0) % HERO_SLOTS + HERO_SLOTS) % HERO_SLOTS,
        frU: P.heroFrame / w, frV: P.heroFrame / h,
        screen: 1,
        cx: run[0].cx, cz: run[0].cz, face, w, h, y,
      });
      ledWall = { w, h, y, lots: run.length, x: cxw, z: czw, face };
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
  // The citylight posters: their own mesh, the banners' material and atlas.
  const totemPosterMesh = instanced(totemPosters, bannerMat, "CityTotemPosters", "aSign", 3, packSign);
  const screenMesh = instanced(screens, screenMat, "CityScreens", "aSign", 3, packSign);
  const neonMesh = instanced(neon, neonMat, "CityNeon", "aNeon", 2, packNeon);
  const wordMat = makeNeonWordMaterial(wordAtlas, u);
  const wordMesh = instanced(words, wordMat, "CityNeonWords", "aWord", 2,
    (d, o, e) => { d[o] = e.tile; d[o + 1] = e.level; });
  const heroMesh = instanced(heroes, heroMat, "CityHeroes", "aSign", 4, packHero);
  if (heroMesh) { heroMesh.receiveShadow = true; heroMesh.castShadow = false; }

  /*
   * ── THE BOARD BEHIND THE POSTER ────────────────────────────────────────────
   *
   * A hero advert was a printed sheet floating in the air. Its frame is painted
   * IN the shader — `frU`/`frV` are fractions of the quad — so there was no
   * geometry anywhere: seen from an angle the board had no thickness, and it
   * cast no shadow on the wall it was supposedly bolted to.
   *
   * One instanced box fixes both, and the shadow is the half that actually
   * sells it. Depth reads from the silhouette only when you are beside the
   * board; the shadow reads from everywhere.
   *
   * SIZED TO THE GAP, not guessed. The panel already floats `standoff` (0.45 m)
   * off the wall, so a box a little shallower than that reaches the facade
   * without touching it — full thickness, and no coplanar face to fight with
   * the wall behind. Its front sits just behind the poster for the same reason.
   *
   * ONE DRAW for every board in the city. The matrices are derived from the
   * heroes that already exist rather than built at each push site, because
   * heroes are pushed from two places and a second copy of this arithmetic is
   * how the two drift apart.
   */
  /*
   * ── THE CITYLIGHT CABINETS ─────────────────────────────────────────────────
   *
   * Built ONCE by the track builder's own `buildAdTotemMesh`, then instanced.
   * Calling the shared builder rather than re-describing the box stack here is
   * the whole point: the totem beside a bus stop in the city is the same object
   * as the totem you can place on a track, and if someone restyles it there it
   * restyles here too. A second description would have looked identical for
   * about a week.
   *
   * Two draws — the steel and the dark cabinet back — for every citylight in
   * the city. Its poster is not here at all: that went into the banner list, so
   * it is another instance of a mesh that already existed.
   */
  const totemMeshes = [];
  if (totems.length) {
    const proto = buildAdTotemMesh({});
    for (const child of proto.children) {
      // The prototype's own poster is a single placeholder plane; the city's
      // posters come off the shared portrait atlas instead.
      if (child.userData?.adPoster) { child.geometry.dispose(); child.material?.dispose?.(); continue; }
      const im = new THREE.InstancedMesh(child.geometry, child.material, totems.length);
      im.name = `CityTotem_${child.name.replace(/^AdTotem/, "")}`;
      im.frustumCulled = false;
      im.castShadow = true;
      im.receiveShadow = true;
      totems.forEach((m, i) => im.setMatrixAt(i, m));
      im.instanceMatrix.needsUpdate = true;
      group.add(im);
      totemMeshes.push(im);
    }
  }

  let heroBoxMesh = null;
  if (heroes.length && P.heroDepth > 0) {
    const boxGeo = new THREE.BoxGeometry(1, 1, 1);
    const boxMat = new THREE.MeshStandardNodeMaterial({
      color: new THREE.Color(P.heroBoxColor), roughness: 0.72, metalness: 0.0,
    });
    boxMat.name = "CityHeroBox";
    heroBoxMesh = new THREE.InstancedMesh(boxGeo, boxMat, heroes.length);
    heroBoxMesh.name = "CityHeroBoxes";
    heroBoxMesh.frustumCulled = false;
    heroBoxMesh.castShadow = true;
    heroBoxMesh.receiveShadow = true;
    const bp = new THREE.Vector3(), bq = new THREE.Quaternion(), bs = new THREE.Vector3();
    const bm = new THREE.Matrix4();
    const d = P.heroDepth;
    heroes.forEach((e, i) => {
      e.m.decompose(bp, bq, bs);
      const [nx, nz] = e.face;
      // Back the box off along the face normal so its FRONT is just behind the
      // poster; `bs` carries the board's own width and height already.
      bp.x -= nx * (d * 0.5 + 0.01);
      bp.z -= nz * (d * 0.5 + 0.01);
      heroBoxMesh.setMatrixAt(i, bm.compose(bp, bq, bs.set(bs.x, bs.y, d)));
    });
    heroBoxMesh.instanceMatrix.needsUpdate = true;
    group.add(heroBoxMesh);
  }

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

  /*
   * THE KERB RIBBON — the strip of scrolling text along the bottom of a
   * shopfront. Its own material rather than the marquee's because it is a
   * different object: much wider than it is tall, so it needs far more columns
   * and far fewer rows, and it runs faster because you read it from a moving
   * car.
   */
  const ribbonMat = makeLedMatrixMaterial({
    boardW: 18, boardH: P.ribbonH,
    contentTexture: textCanvas.texture, sourceAspect: textCanvas.aspect,
  });
  applyLedMatrixParams(ribbonMat, {
    mode: 4, shape: 1, cols: 240, rows: 6, emissive: 4.4, panSpeed: 0.5,
    rgb: false, tintColor: "#ffb020", useRamp: true,
    coreColor: "#fff3c4", edgeColor: "#ff7a10",
  }, 18, P.ribbonH);
  ribbonMat.side = THREE.FrontSide;

  let bandMesh = null, textMesh = null, ribbonMesh = null;
  if (ribbons.length) {
    ribbonMesh = new THREE.InstancedMesh(quad, ribbonMat, ribbons.length);
    ribbonMesh.name = "CityKerbRibbon";
    ribbonMesh.frustumCulled = false;
    ribbons.forEach((m, i) => ribbonMesh.setMatrixAt(i, m));
    ribbonMesh.instanceMatrix.needsUpdate = true;
    group.add(ribbonMesh);
  }
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
      totems: totems.length,
      banners: banners.length, bands: bands.length, texts: texts.length,
      neon: neon.length, mega: megaCount,
      /** Shopfront neon words and the kerb ribbons under them. */
      words: words.length, ribbons: ribbons.length,
      /** Mega boards and ordinary screens share one mesh; this is the total. */
      screens: screens.length,
      /** The one LED wall: its size and where it landed, or null. */
      ledWall,
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
      // Derived, so moving the radius alone must not leave the dissolve
      // target describing the old dot.
      if ("ledDotRadius" in patch) u.ledCoverage.value = dotCoverage(P.ledDotRadius);
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
      for (const m of [bannerMesh, screenMesh, neonMesh, bandMesh, textMesh, heroMesh, heroBoxMesh, totemPosterMesh, ...totemMeshes]) {
        if (!m) continue;
        group.remove(m);
        if (m.geometry !== quad) m.geometry.dispose();
        m.dispose();
      }
      bannerMat.dispose(); screenMat.dispose(); neonMat.dispose(); heroMat.dispose();
      wordMat.dispose(); ribbonMat.dispose(); wordAtlas.texture?.dispose();
      heroBoxMesh?.material.dispose();
      heroAtlas.texture.dispose();
      bandMat.dispose(); textMat.dispose();
      wordMesh?.geometry.dispose(); ribbonMesh?.geometry.dispose();
      quad.dispose();
      bannerAtlas.texture.dispose();
      screenAtlas.texture.dispose();
      textCanvas.texture.dispose();
    },
  };
}
