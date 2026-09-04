/**
 * THE MILKY WAY — a baked galactic band, and why it is baked rather than procedural.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * The night sky had stars but no galaxy, and a starfield alone reads as "dots on black"
 * rather than as a sky. What the eye actually recognises about a real night is the BAND:
 * a broad, mottled, unevenly bright arch with dark lanes cut through it. Uniform stars
 * cannot suggest that, however many of them there are.
 *
 * WHY BAKED. Doing this procedurally means several octaves of 3D noise per sky pixel,
 * and the structure that matters here — a bright bulge toward the galactic centre, a
 * thinning toward the anticentre, and the Great Rift of dust cutting the band lengthwise
 * — is large-scale and static. There is nothing to gain from evaluating it per frame.
 * One 512x128 texture in galactic coordinates answers it in a single fetch, which is
 * also what lets this run inside the existing night branch without changing its cost
 * profile. Same reasoning as the moon's near-side map.
 *
 * WHY (longitude, latitude) AND NOT A CUBEMAP. The band is one structure wrapped around
 * one great circle: it is intrinsically 2D and mostly 1D. An equirect strip spends its
 * texels exactly where the galaxy is, and outside the modelled latitude range there is
 * nothing to store — so the strip covers only +/-BAND_SIN and fades to nothing at its
 * edges rather than wasting rows on empty sky.
 */
import * as THREE from "three/webgpu";
import { seededRandom, makePeriodicPerlin, perlinFbm } from "./modularRoadCloudNoise.js";

export const MW_WIDTH = 512;
export const MW_HEIGHT = 128;

/**
 * Half-height of the modelled band, as sin(galactic latitude). ~0.55 is a little over
 * 33 degrees — comfortably wider than the visible glow, so the taper to zero happens
 * inside the texture rather than at its edge.
 */
export const BAND_SIN = 0.55;

/**
 * Bake the band.
 *
 * R = diffuse glow. G = a star-density multiplier (the band is thick with unresolved
 * stars, so the resolved ones should crowd there too). B and A are unused.
 */
export function bakeMilkyWay(seed = 20287, W = MW_WIDTH, H = MW_HEIGHT) {
  const rng = seededRandom(seed >>> 0);
  const perlin = makePeriodicPerlin(rng);
  const out = new Uint8Array(W * H * 4);

  let i = 0;
  for (let y = 0; y < H; y++) {
    // sin(latitude) across the strip. Linear in sin rather than in the angle, because
    // that is the coordinate the shader can produce with a single dot product.
    const sinB = ((y + 0.5) / H * 2 - 1) * BAND_SIN;

    for (let x = 0; x < W; x++) {
      // Longitude 0..1, with the GALACTIC CENTRE at 0.5 — i.e. in the middle of the
      // texture, so the brightest, most detailed part is nowhere near the wrap seam.
      const l01 = (x + 0.5) / W;
      const ang = l01 * Math.PI * 2;

      // Angular distance from the centre, wrapped.
      const dl0 = Math.abs(l01 - 0.5);
      const dl = Math.min(dl0, 1 - dl0);

      /*
       * THE BULGE. The galaxy is not a uniform ribbon: looking toward Sagittarius you
       * are looking through the entire disc into the core, and toward the anticentre
       * you are looking out of it. That asymmetry — bright and broad on one side of the
       * sky, thin and faint on the other — is the single most recognisable thing about
       * the band, more than any individual feature.
       */
      const centre = Math.exp(-((dl / 0.17) ** 2));

      // Thicker toward the core, thinner toward the rim, for the same reason.
      const thick = 0.055 + 0.105 * centre;
      const vert = Math.exp(-((sinB / thick) ** 2));

      // Mottling. Sampled on the CYLINDER (cos, sin, latitude) so it wraps in longitude
      // for free — no seam, and no need for a periodic domain in the noise itself.
      const cx = Math.cos(ang), cz = Math.sin(ang);
      const mot = perlinFbm(perlin, cx * 1.6 + 0.5, cz * 1.6 + 0.5, sinB * 3.0 + 0.5, 3, 4);
      const fine = perlinFbm(perlin, cx * 4.1 + 0.5, cz * 4.1 + 0.5, sinB * 7.0 + 0.5, 5, 3);

      /*
       * THE GREAT RIFT. A lane of dust that splits the band lengthwise for much of its
       * run — dark against the glow, and much more legible than the glow's own edges.
       * It meanders, so its centre line is itself driven by a low-frequency field, and
       * it is strongest near the core (where there is most light behind it to block)
       * and fades out toward the anticentre.
       */
      const riftLine = (perlinFbm(perlin, cx * 0.9 + 0.5, cz * 0.9 + 0.5, 0.31, 2, 2) - 0.5) * 0.075;
      const riftStr = 0.85 * centre + 0.15;
      const rift = 1 - riftStr * 0.8 * Math.exp(-(((sinB - riftLine) / 0.032) ** 2));

      // Fade to nothing at the strip's edges so the band has no hard boundary.
      const edge = Math.max(0, 1 - (Math.abs(sinB) / BAND_SIN) ** 3);

      let glow = vert * (0.22 + 1.05 * centre) * (0.5 + 0.85 * mot) * (0.75 + 0.45 * fine);
      glow *= rift * edge;

      // Star crowding follows the glow but is less bitten by dust: the rift hides the
      // diffuse light of distant stars, and dims but does not erase nearer ones.
      const dens = vert * (0.3 + 0.9 * centre) * (0.55 + 0.7 * mot) * (0.45 + 0.55 * rift) * edge;

      out[i++] = Math.max(0, Math.min(255, glow * 255));
      out[i++] = Math.max(0, Math.min(255, dens * 255));
      out[i++] = 0;
      out[i++] = 255;
    }
  }
  return out;
}

/**
 * @param {object} [opts]
 * @param {number} [opts.seed]
 */
export function createMilkyWay({ seed = 20287 } = {}) {
  const map = new THREE.DataTexture(
    bakeMilkyWay(seed), MW_WIDTH, MW_HEIGHT, THREE.RGBAFormat,
  );
  // Longitude WRAPS, latitude does not: repeat across, clamp down. Getting the second
  // one wrong mirrors the northern band onto the southern sky.
  map.wrapS = THREE.RepeatWrapping;
  map.wrapT = THREE.ClampToEdgeWrapping;
  map.minFilter = map.magFilter = THREE.LinearFilter;
  map.needsUpdate = true;
  return { map, dispose() { map.dispose(); } };
}

/**
 * An orthonormal basis for galactic coordinates, as three world-space vectors.
 *
 * The real galactic plane sits at a large angle to the horizon and that angle turns
 * through the night; this is a fixed, chosen orientation — the band crosses the sky on
 * a diagonal, which is what it looks like from mid-latitudes on a summer evening and is
 * far more legible than an arch sitting flat on the horizon.
 *
 * @param {THREE.Vector3} pole galactic north, need not be normalised
 */
export function galacticBasis(pole = new THREE.Vector3(0.34, 0.62, -0.71)) {
  const p = pole.clone().normalize();
  // Any reference not parallel to the pole; +Y is only degenerate if the pole is
  // straight up, which this deliberately is not.
  const ref = Math.abs(p.y) > 0.95 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const gx = new THREE.Vector3().crossVectors(ref, p).normalize();
  const gy = new THREE.Vector3().crossVectors(p, gx).normalize();
  return { pole: p, gx, gy };
}
