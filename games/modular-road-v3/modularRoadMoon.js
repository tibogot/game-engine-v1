/**
 * THE MOON — a baked near-side albedo, and the photometry to light it correctly.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * TWO THINGS WERE WRONG WITH A SHADED SPHERE.
 *
 * 1. NO SURFACE. A featureless disc reads as "a light in the sky", not as the Moon. The
 *    maria — the dark basalt seas — are the single most recognisable thing about it, far
 *    more than any crater: they are what the eye matches against every moon it has ever
 *    seen. Without them the disc could be any planet.
 *
 * 2. LAMBERT IS THE WRONG LAW. Shading it with `dot(normal, sun)` makes a full moon look
 *    like a ball lit from the front — bright in the middle, falling off to a dark rim.
 *    The real full Moon does the opposite of what that predicts: it looks like a flat
 *    disc of almost uniform brightness, right out to the limb. Lunar regolith is porous
 *    and strongly backscattering, so its photometric function is much closer to
 *    Lommel-Seeliger,
 *
 *        brightness ∝ cos(i) / (cos(i) + cos(e))
 *
 *    which cancels most of the limb falloff a Lambertian sphere has. Using it is the
 *    difference between "a sphere" and "the Moon". The terminator on a crescent stays
 *    sharp either way; it is the FULL phase where Lambert gives itself away.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * WHY THE TEXTURE IS BAKED IN DISC SPACE, NOT EQUIRECTANGULAR.
 *
 * The Moon is tidally locked: we only ever see one face, and always the same one. An
 * equirect map would spend most of its texels on a far side that is never visible, and
 * would need an atan/asin per pixel to sample. Baking the near side as the ORTHOGRAPHIC
 * DISC — exactly as it appears — makes the lookup a plain 2D fetch at the disc
 * coordinate, with no trig at all.
 *
 * The features are still generated in 3D ON THE SPHERE and then projected, so they
 * foreshorten correctly toward the limb rather than being a flat sticker: a crater near
 * the edge squashes the way a real one does.
 */
import * as THREE from "three/webgpu";
import { seededRandom, makePeriodicPerlin, perlinFbm } from "./modularRoadCloudNoise.js";

/** Disc texture resolution. The Moon is ~0.5° wide, so even oversized it covers a few
 *  hundred pixels at most — 256² is already more than the screen can show. */
export const MOON_MAP_SIZE = 256;

/**
 * Bake the near-side albedo as an orthographic disc.
 *
 * R = albedo. G = a slope/roughness term used to break up the terminator so it does not
 * read as a clean geometric curve. Alpha marks the disc, so the shader can antialias the
 * limb without a second radius test.
 */
export function bakeMoonAlbedo(seed = 7919, size = MOON_MAP_SIZE) {
  const rng = seededRandom(seed >>> 0);
  const perlin = makePeriodicPerlin(rng);

  // Craters, scattered over the near hemisphere. Generated in 3D so the projection
  // squashes them toward the limb on its own.
  const CRATERS = 70;
  const craters = [];
  for (let i = 0; i < CRATERS; i++) {
    // Cosine-ish spread over the visible hemisphere, biased slightly toward the middle
    // where they are actually legible.
    const u = rng() * 2 - 1;
    const v = rng() * 2 - 1;
    const r2 = u * u + v * v;
    if (r2 > 0.98) { i--; continue; }
    const w = Math.sqrt(1 - r2);
    // Small ones dominate, as they do on the real surface.
    const rad = 0.012 + Math.pow(rng(), 2.4) * 0.075;
    craters.push({ x: u, y: v, z: w, rad, depth: 0.35 + rng() * 0.5 });
  }

  const out = new Uint8Array(size * size * 4);
  let i = 0;
  for (let py = 0; py < size; py++) {
    // +1 texel of margin so the limb has somewhere to fade.
    const v = (py + 0.5) / size * 2 - 1;
    for (let px = 0; px < size; px++) {
      const u = (px + 0.5) / size * 2 - 1;
      const r2 = u * u + v * v;
      if (r2 >= 1) { out[i] = 0; out[i + 1] = 0; out[i + 2] = 0; out[i + 3] = 0; i += 4; continue; }
      const w = Math.sqrt(1 - r2);

      // Sphere point -> 0..1 noise coords.
      const nx = u * 0.5 + 0.5, ny = v * 0.5 + 0.5, nz = w * 0.5 + 0.5;

      // MARIA: large, dark, smooth-edged basins. A low-frequency field thresholded hard,
      // because the real seas have definite shorelines rather than a gradient.
      const big = perlinFbm(perlin, nx, ny, nz, 2, 3);
      const mare = Math.max(0, Math.min(1, (big - 0.52) / 0.13));
      const mareS = mare * mare * (3 - 2 * mare);

      // Highland speckle — fine albedo variation so the bright areas are not flat.
      const fine = perlinFbm(perlin, nx, ny, nz, 9, 4);

      // Highlands ~0.88, maria ~0.42: roughly the real contrast ratio.
      let albedo = (0.88 - 0.46 * mareS) * (0.9 + 0.2 * fine);

      // CRATERS: a dark floor with a bright rim, the rim being what actually catches the
      // eye at this scale.
      let slope = 0;
      for (let c = 0; c < craters.length; c++) {
        const k = craters[c];
        const dx = u - k.x, dy = v - k.y, dz = w - k.z;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d > k.rad * 1.35) continue;
        const t = d / k.rad;
        if (t < 0.82) {
          albedo *= 1 - k.depth * 0.35 * (1 - t * 0.5);   // floor
          slope += 0.25 * (1 - t);
        } else if (t < 1.18) {
          albedo *= 1 + k.depth * 0.30;                    // rim
          slope += 0.6;
        }
      }

      const a255 = Math.max(0, Math.min(255, albedo * 255));
      // Fade the last texel ring so the limb is not a hard staircase.
      const edge = Math.max(0, Math.min(1, (1 - Math.sqrt(r2)) * size * 0.35));
      out[i++] = a255;
      out[i++] = Math.max(0, Math.min(255, slope * 255));
      out[i++] = 0;
      out[i++] = edge * 255;
    }
  }
  return out;
}

/**
 * @param {object} [opts]
 * @param {number} [opts.seed]
 */
export function createMoonSurface({ seed = 7919 } = {}) {
  const map = new THREE.DataTexture(
    bakeMoonAlbedo(seed), MOON_MAP_SIZE, MOON_MAP_SIZE, THREE.RGBAFormat,
  );
  // CLAMP, not repeat: outside the disc there is nothing, and wrapping would smear the
  // opposite limb across the sky.
  map.wrapS = map.wrapT = THREE.ClampToEdgeWrapping;
  map.minFilter = map.magFilter = THREE.LinearFilter;
  map.needsUpdate = true;
  return { map, dispose() { map.dispose(); } };
}
