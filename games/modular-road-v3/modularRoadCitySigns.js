// ============================================================================
// CITY SIGNS — Tokyo-style signage, in five instanced draws for the whole city.
//
// What makes a street read as Tokyo is DENSITY and LAYERING, not one big sign:
// stacked vertical banners climbing the tower edges, a lit band wrapping every
// podium, dot-matrix text marquees, neon tube outlines, and — the piece that
// sells it — MEGA BILLBOARDS covering a large part of a building's face.
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
  mix, smoothstep, abs, max, sin, cos, clamp,
} from "three/tsl";
import { applyBloomMRT } from "../../v3/render/bloomMRT.js";
import { makeLedMatrixMaterial, applyLedMatrixParams } from "../../v2/objects/shared/ledMatrix.js";

export const SIGN_DEFAULTS = {
  /** Fraction of buildings that get each kind. */
  bannerFraction: 0.55,
  bandFraction: 0.40,
  screenFraction: 0.12,
  megaFraction: 0.16,
  textFraction: 0.18,
  neonFraction: 0.30,

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
  screenBoost: 4.0,
  nightAmount: 0,
};

const BANNER_COLS = 4, BANNER_ROWS = 2, BANNER_PX = 1024;   // 8 portrait tiles
const SCREEN_COLS = 2, SCREEN_ROWS = 2, SCREEN_PX = 1024;   // 4 square tiles
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
    const tile = aSign.x;
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
    dayLevel: uniform(P.dayLevel),
    nightBoost: uniform(P.nightBoost),
    screenBoost: uniform(P.screenBoost),
    neonBoost: uniform(P.neonBoost),
    time: uniform(0),
  };

  const bannerAtlas = makeAtlas(seed, BANNER_COLS, BANNER_ROWS, BANNER_PX, true);
  const screenAtlas = makeAtlas(seed ^ 0x5bf03635, SCREEN_COLS, SCREEN_ROWS, SCREEN_PX, false);
  const textCanvas = makeTextCanvas(P.texts[0]);

  // ── Placement ──────────────────────────────────────────────────────────────
  const FACES = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const banners = [], screens = [], bands = [], texts = [], neon = [];
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

    // ── MEGA BILLBOARD ───────────────────────────────────────────────────────
    // The Tokyo piece: most of a wall. Checked first, because it claims the
    // wall it is on and the banners must not land on the same one.
    let megaFace = null;
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

  const packSign = (d, o, e) => { d[o] = e.tile; d[o + 1] = e.jit; d[o + 2] = e.scroll ?? 0; };
  const packNeon = (d, o, e) => { d[o] = e.hue; d[o + 1] = e.intensity; };

  const bannerMesh = instanced(banners, bannerMat, "CityBanners", "aSign", 3, packSign);
  const screenMesh = instanced(screens, screenMat, "CityScreens", "aSign", 3, packSign);
  const neonMesh = instanced(neon, neonMat, "CityNeon", "aNeon", 2, packNeon);

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
      banners: banners.length, bands: bands.length, texts: texts.length,
      neon: neon.length, mega: megaCount,
      /** Mega boards and ordinary screens share one mesh; this is the total. */
      screens: screens.length,
    },
    setNight(n) { u.nightAmount.value = n; },
    setTime(t) { u.time.value = t; },

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
      for (const m of [bannerMesh, screenMesh, neonMesh, bandMesh, textMesh]) {
        if (!m) continue;
        group.remove(m);
        if (m.geometry !== quad) m.geometry.dispose();
        m.dispose();
      }
      bannerMat.dispose(); screenMat.dispose(); neonMat.dispose();
      bandMat.dispose(); textMat.dispose();
      quad.dispose();
      bannerAtlas.texture.dispose();
      screenAtlas.texture.dispose();
      textCanvas.texture.dispose();
    },
  };
}
