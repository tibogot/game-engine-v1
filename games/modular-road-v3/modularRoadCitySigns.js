// ============================================================================
// CITY SIGNS — Tokyo-style signage on the towers, in three instanced draws.
//
// The city's look is decided by DENSITY of signage at podium height — stacked
// vertical banners climbing the tower edges, a lit LED band wrapping every
// podium, a few giant screens on blank slab faces — not by any one big sign.
// So this is placement, not rendering: the rendering is one procedural poster
// atlas and the LED-matrix shader the game already ships.
//
// ── THREE MESHES, THREE DRAWS ────────────────────────────────────────────────
//
//   banners  InstancedMesh of tall narrow quads, poster atlas, per-instance
//            tile index + hue in ONE instanced attribute (signs are their own
//            mesh, so a real attribute is fine here — the no-attribute rule is
//            the facade's, because the facade has to survive a backend swap).
//   screens  InstancedMesh of wide quads on the blank faces of slab towers,
//            same atlas, slowly scrolling.
//   bands    InstancedMesh of thin strips at the top of every signed podium,
//            the v2 LED matrix material (chevron mode, built-in fwidth LOD).
//
// ── OPAQUE, WITH A BACKING ───────────────────────────────────────────────────
//
// r184 blends ONLY the `output` MRT attachment, so any TRANSPARENT surface
// erases the emissive buffer behind it and kills the bloom of every window it
// covers (ref: the smoke-vs-glow-props finding). Signs therefore never blend:
// they are opaque quads with a dark backing colour, offset a real margin off
// the wall so they do not z-fight at 400 m.
//
// ── NIGHT ────────────────────────────────────────────────────────────────────
//
// By day a sign is a printed panel: unlit, reflecting nothing (MeshBasic), at
// a printed-ink level. At night it is a light: emissive into the bloom MRT.
// `nightAmount` comes from the city, which gets it from the sky.
// ============================================================================
import * as THREE from "three";
import {
  Fn, float, vec2, vec3, vec4, uniform, attribute, texture, uv, fract, floor,
  mix, smoothstep, abs, step, sin, dot, max,
} from "three/tsl";
import { applyBloomMRT } from "../../v3/render/bloomMRT.js";
import { makeLedMatrixMaterial, applyLedMatrixParams } from "../../v2/objects/shared/ledMatrix.js";

export const SIGN_DEFAULTS = {
  /** Fraction of buildings that get banners / a band / a screen. */
  bannerFraction: 0.55,
  bandFraction: 0.40,
  screenFraction: 0.12,
  /** Banner size (m) and how many stack up one edge. */
  bannerW: 2.2,
  bannerH: 8.5,
  bannersPerEdge: 3,
  /** Screen size (m) — on blank faces of towers over `screenMinHeight`. */
  screenW: 16,
  screenH: 9,
  screenMinHeight: 70,
  /** LED band height (m), sits just above the lobby. */
  bandH: 1.3,
  /** Stand-off from the wall, so the quad never z-fights the facade. */
  standoff: 0.45,
  /** Printed level by day, light level at night. */
  dayLevel: 0.55,
  nightBoost: 3.2,
  screenBoost: 4.0,
  nightAmount: 0,
};

const ATLAS_COLS = 4, ATLAS_ROWS = 2, ATLAS_PX = 1024;

/**
 * A procedural "Tokyo" poster atlas: 8 portrait tiles, saturated grounds,
 * fake glyph blocks, a stripe or two. Deterministic from the seed. Falls back
 * to a 1×1 texture where there is no document (the headless test).
 */
function makePosterAtlas(seed) {
  if (typeof document === "undefined") {
    const t = new THREE.DataTexture(new Uint8Array([200, 40, 80, 255]), 1, 1);
    t.needsUpdate = true;
    return t;
  }
  let a = seed >>> 0;
  const rnd = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const c = document.createElement("canvas");
  c.width = c.height = ATLAS_PX;
  const ctx = c.getContext("2d");
  const tw = ATLAS_PX / ATLAS_COLS, th = ATLAS_PX / ATLAS_ROWS;
  const hues = [350, 20, 45, 160, 195, 215, 280, 320];
  for (let i = 0; i < ATLAS_COLS * ATLAS_ROWS; i++) {
    const x0 = (i % ATLAS_COLS) * tw, y0 = Math.floor(i / ATLAS_COLS) * th;
    const hue = hues[i];
    const dark = rnd() < 0.4;
    ctx.fillStyle = dark ? `hsl(${hue} 70% 12%)` : `hsl(${hue} 85% 52%)`;
    ctx.fillRect(x0, y0, tw, th);
    // Glyph blocks — bold strokes that read as characters at a distance.
    const ink = dark ? `hsl(${hue} 90% 62%)` : (rnd() < 0.5 ? "#ffffff" : "#111111");
    ctx.fillStyle = ink;
    const rows = 4 + Math.floor(rnd() * 3);
    for (let r = 0; r < rows; r++) {
      const gy = y0 + th * (0.10 + (r / rows) * 0.78);
      const gh = th * 0.13;
      const strokes = 2 + Math.floor(rnd() * 3);
      for (let s = 0; s < strokes; s++) {
        const gx = x0 + tw * (0.16 + rnd() * 0.5);
        const gw = tw * (0.08 + rnd() * 0.3);
        ctx.fillRect(gx, gy + rnd() * gh * 0.3, gw, gh * (0.2 + rnd() * 0.5));
        ctx.fillRect(gx + rnd() * gw * 0.6, gy, gw * 0.18, gh);
      }
    }
    // A stripe and a frame.
    ctx.fillStyle = dark ? `hsl(${(hue + 40) % 360} 90% 55%)` : "#111111";
    ctx.fillRect(x0 + tw * 0.06, y0 + th * 0.92, tw * 0.88, th * 0.03);
    ctx.strokeStyle = dark ? `hsl(${hue} 90% 62%)` : "#ffffff";
    ctx.lineWidth = 6;
    ctx.strokeRect(x0 + 8, y0 + 8, tw - 16, th - 16);
  }
  const data = ctx.getImageData(0, 0, ATLAS_PX, ATLAS_PX);
  const tex = new THREE.DataTexture(data.data, ATLAS_PX, ATLAS_PX);
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
 * Poster material shared by banners and screens: unlit, atlas tile from the
 * instanced `aSign` attribute (x = tile, y = brightness jitter, z = scroll).
 */
function makePosterMaterial(atlas, u, { scrolling = false, boostUniform }) {
  const mat = new THREE.MeshBasicNodeMaterial();
  mat.name = scrolling ? "CityScreen" : "CityBanner";
  const aSign = attribute("aSign", "vec3");
  const tex = texture(atlas);
  const col = Fn(() => {
    const tile = aSign.x;
    const tx = fract(tile.div(ATLAS_COLS));
    const ty = floor(tile.div(ATLAS_COLS)).div(ATLAS_ROWS);
    let uvv = uv();
    if (scrolling) uvv = vec2(uvv.x, fract(uvv.y.add(u.time.mul(0.05).mul(aSign.z))));
    const auv = vec2(tx.add(uvv.x.div(ATLAS_COLS)), ty.add(uvv.y.div(ATLAS_ROWS)));
    const ink = tex.sample(auv).rgb.mul(float(0.8).add(aSign.y.mul(0.4)));
    // Day: printed. Night: lit — bloom through the emissive attachment.
    const level = mix(u.dayLevel, boostUniform, u.nightAmount);
    return ink.mul(level);
  })();
  mat.colorNode = vec4(col, 1.0);
  // Emissive contribution only at night; by day the panel is just paint.
  applyBloomMRT(mat, vec4(col.mul(u.nightAmount), 1.0));
  return mat;
}

/**
 * @param {object} o
 * @param {Array}  o.buildings  the city's placed buildings (x, y, z, top, arch)
 * @param {Array}  o.archetypes kit archetypes (width, depth, massHeight, hasPodium)
 * @param {number} o.seed
 * @param {number} o.lobbyHeight
 * @param {object} [o.params]
 * @param {(cx:number,cz:number,k:number)=>number} o.lotRand deterministic per-lot random
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
    time: uniform(0),
  };
  const atlas = makePosterAtlas(seed);

  // ── Placement ──────────────────────────────────────────────────────────────
  // Four facade normals; a sign goes on ONE face per building, chosen by hash,
  // so two signed neighbours do not always face the same street.
  const FACES = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const banners = [], screens = [], bands = [];
  const _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(1, 1, 1);
  const _m = new THREE.Matrix4();
  const _up = new THREE.Vector3(0, 1, 0);

  function faceMatrix(b, a, face, y, w, h, out) {
    const [nx, nz] = face;
    const half = (nx !== 0 ? a.width : a.depth) * 0.5 + P.standoff;
    _p.set(b.x + nx * half, y, b.z + nz * half);
    _q.setFromAxisAngle(_up, Math.atan2(nx, nz));
    _s.set(w, h, 1);
    return out.compose(_p, _q, _s);
  }

  for (const b of buildings) {
    const a = archetypes[b.arch];
    if (!a) continue;
    const r0 = lotRand(b.cx, b.cz, 11), r1 = lotRand(b.cx, b.cz, 12), r2 = lotRand(b.cx, b.cz, 13);
    const face = FACES[Math.floor(r0 * 4)];
    const height = b.top - b.y;
    const [nx, nz] = face;
    const faceW = nx !== 0 ? a.depth : a.width;   // width of the face we are on

    if (r1 < P.bannerFraction && height > lobbyHeight + P.bannerH * 1.5) {
      // Stacked up one edge of the face.
      const edge = (r2 < 0.5 ? -1 : 1) * (faceW * 0.5 - P.bannerW * 0.7);
      const n = Math.min(P.bannersPerEdge, Math.floor((height - lobbyHeight - 2) / (P.bannerH + 1)));
      for (let i = 0; i < n; i++) {
        const y = b.y + lobbyHeight + 1.5 + i * (P.bannerH + 1) + P.bannerH / 2;
        faceMatrix(b, a, face, y, P.bannerW, P.bannerH, _m);
        // Slide along the face to the edge: the face tangent is (nz, -nx).
        _m.elements[12] += nz * edge;
        _m.elements[14] += -nx * edge;
        banners.push({ m: _m.clone(), tile: Math.floor(lotRand(b.cx, b.cz, 20 + i) * 8), jit: lotRand(b.cx, b.cz, 30 + i) });
      }
    }
    if (r2 < P.bandFraction && height > lobbyHeight + 4) {
      // A strip the full width of the face, just above the lobby.
      faceMatrix(b, a, face, b.y + lobbyHeight + P.bandH * 0.5 + 0.3, faceW * 0.96, P.bandH, _m);
      bands.push(_m.clone());
    }
    if (height > P.screenMinHeight && lotRand(b.cx, b.cz, 14) < P.screenFraction && faceW > P.screenW * 1.1) {
      faceMatrix(b, a, face, b.y + height * (0.35 + lotRand(b.cx, b.cz, 15) * 0.3), P.screenW, P.screenH, _m);
      screens.push({ m: _m.clone(), tile: Math.floor(lotRand(b.cx, b.cz, 16) * 8), jit: lotRand(b.cx, b.cz, 17), scroll: 0.5 + lotRand(b.cx, b.cz, 18) });
    }
  }

  // ── Meshes ─────────────────────────────────────────────────────────────────
  // Unit quad, facing +Z, origin at its centre. Plus a backing quad a hair
  // behind it so the sign has a dark back and reads as a panel from behind.
  const quad = new THREE.PlaneGeometry(1, 1);

  function instancedPosters(list, material, name) {
    if (!list.length) return null;
    const im = new THREE.InstancedMesh(quad, material, list.length);
    im.name = name;
    im.frustumCulled = false;
    const sign = new Float32Array(list.length * 3);
    list.forEach((e, i) => {
      im.setMatrixAt(i, e.m);
      sign[i * 3] = e.tile; sign[i * 3 + 1] = e.jit; sign[i * 3 + 2] = e.scroll ?? 0;
    });
    im.geometry = quad.clone();
    im.geometry.setAttribute("aSign", new THREE.InstancedBufferAttribute(sign, 3));
    im.instanceMatrix.needsUpdate = true;
    group.add(im);
    return im;
  }

  const bannerMat = makePosterMaterial(atlas, u, { scrolling: false, boostUniform: u.nightBoost });
  const screenMat = makePosterMaterial(atlas, u, { scrolling: true, boostUniform: u.screenBoost });
  const bannerMesh = instancedPosters(banners, bannerMat, "CityBanners");
  const screenMesh = instancedPosters(screens, screenMat, "CityScreens");

  // LED band: the v2 matrix shader in chevron mode. One material, one draw.
  let bandMesh = null;
  const bandMat = makeLedMatrixMaterial({ boardW: 20, boardH: P.bandH });
  applyLedMatrixParams(bandMat, {
    mode: 1, shape: 1, cols: 160, rows: 8, emissive: 3.5, panSpeed: 0.35,
    chevronCount: 10, duty: 0.55, coreColor: "#ffe07a", edgeColor: "#ff4a1a",
  }, 20, P.bandH);
  bandMat.side = THREE.FrontSide;
  if (bands.length) {
    bandMesh = new THREE.InstancedMesh(quad, bandMat, bands.length);
    bandMesh.name = "CityBands";
    bandMesh.frustumCulled = false;
    bands.forEach((m, i) => bandMesh.setMatrixAt(i, m));
    bandMesh.instanceMatrix.needsUpdate = true;
    group.add(bandMesh);
  }

  return {
    group,
    params: P,
    stats: { banners: banners.length, screens: screens.length, bands: bands.length },
    setNight(n) { u.nightAmount.value = n; },
    setTime(t) { u.time.value = t; },
    dispose() {
      for (const m of [bannerMesh, screenMesh, bandMesh]) {
        if (!m) continue;
        group.remove(m);
        m.geometry.dispose();
        m.dispose();
      }
      bannerMat.dispose(); screenMat.dispose(); bandMat.dispose();
      quad.dispose();
      atlas.dispose();
    },
  };
}
