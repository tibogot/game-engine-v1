// THUNDERLINE'S ASPHALT (user, 2026-10-23: "those long streaks looks bad … that type of asphalt road", an
// Apex Rush shot: a dark deck with MANY thin, faint lines running with the road, each breaking off after a
// few metres). The old game's surface stretches its aggregate 14× along the path, so its chips come out as
// broad 3 m bands that a low sun lights up like brush strokes. This one keeps the chips round and draws the
// lines on their own: the zero contours of a noise squeezed across the road and stretched along it — thin,
// wandering, never parallel for long — cut into segments by a second, slow noise.
//
// It plugs into createRoadMaterial's `buildSurface` and keeps that contract (see modularRoadMaterial.js):
// .x the low-frequency macro (the drift marks wander with it), .y the fine detail, .z the wheel paths,
// .w the detail's distance fade. The old game keeps its own surface.
import * as THREE from "three";
import {
  Fn, uv, attribute, vec2, vec3, vec4, float, uniform, positionWorld, texture, normalMap, mix, dot,
  mx_noise_float, mx_fractal_noise_float, fwidth, max, min, abs, saturate, smoothstep, oneMinus,
} from "three/tsl";
import { loadTexture } from "../../../../v3/render/textureLoad.js";

// live-tunable from the console (window.__roadWear) while we look at it
export const ROAD_WEAR = {
  chipScale: uniform(6.0), //   round aggregate, ~17 cm
  lineFreq: uniform(2.4), //    worn lines across the road, per metre (main set)
  lineFreq2: uniform(5.5), //   a finer, fainter set between them
  lineLen: uniform(0.045), //   how slowly a line wanders, per metre along
  lineWidth: uniform(0.07), //  in noise units: thin
  lineAmt: uniform(0.55), //    how much lighter a line is (the deck's tone mixes only 40 % of this in)
  breakScale: uniform(0.1), //  segments of ~5–10 m
  breakCover: uniform(0.45), // the share of the road that carries lines
  chipAmt: uniform(1.0), //     the procedural chips; 0 once a scan gives the stones
};

/** One set of contour lines, 0..1, faded to its average once it falls under a pixel. */
const contour = (n, width) => {
  const fw = max(fwidth(n), 1e-4);
  const w = max(width, fw);
  // a line narrower than a pixel is drawn one pixel wide but fainter, so it never crawls
  return saturate(oneMinus(abs(n).div(w))).mul(min(float(1), width.div(fw)));
};

export function buildWornSurface(u) {
  return Fn(() => {
    // metres along (decorrelated per piece) and across — NOT stretched
    const along = uv().x.add(attribute("aPiece", "vec2").x);
    const across = uv().y;
    const lateral = attribute("aLateral", "float");
    const W = ROAD_WEAR;

    // MACRO in world space, as the old surface does (no tonal step at the joints)
    const macro = mx_fractal_noise_float(positionWorld.mul(u.macroScale), 3, 2.0, 0.5, 1.0).mul(0.5).add(0.5);

    // CHIPS: round, a little longer than wide
    const texel = max(fwidth(along), fwidth(across));
    const aggFade = saturate(oneMinus(texel.mul(W.chipScale).mul(2.0)));
    const chips = mx_noise_float(vec3(along.mul(W.chipScale).mul(0.6), across.mul(W.chipScale), 0.0)).mul(aggFade).mul(W.chipAmt);

    // THE WORN LINES: two sets of contours, the second finer and fainter
    const l1 = contour(mx_noise_float(vec3(across.mul(W.lineFreq), along.mul(W.lineLen), 7.3)), W.lineWidth);
    const l2 = contour(mx_noise_float(vec3(across.mul(W.lineFreq2), along.mul(W.lineLen.mul(1.7)), 19.1)), W.lineWidth.mul(0.8));
    // broken into segments by a slow noise, so no line runs the whole road
    const cut = oneMinus(W.breakCover).sub(0.5).mul(0.5); // the noise sits in about −0.4..0.4
    const seg = smoothstep(cut.sub(0.08), cut.add(0.08), mx_noise_float(vec3(along.mul(W.breakScale), across.mul(0.9), 3.1)));
    const lines = max(l1, l2.mul(0.6)).mul(seg);

    const agg = chips.mul(0.5).add(0.5).add(lines.mul(W.lineAmt));

    const wheelPath = smoothstep(0.18, 0.42, abs(lateral)).mul(oneMinus(smoothstep(0.55, 0.8, abs(lateral))));
    return vec4(macro, agg, wheelPath, aggFade);
  })();
}

// ── THE DECK FROM A SCAN (user, 2026-10-23: the noise "looks also cheap … roughness and normals map?") ──
// A Poly Haven asphalt (CC0): its stones, as a variation around OUR deck colour so the light rig still fits, the normal map for the stones catching a low sun, and a roughness taken from the stones
// themselves (the scans' own roughness maps are flat, ±0.005): bright polished chips shinier, binder matte.
// Our macro tone, worn lines, wheel paths and drift marks stay on top (createRoadMaterial's `deck` hook).
const PBR = "/textures/pbr_materials/";
// metres one tile covers (Poly Haven's dimensions); mean = each diffuse's linear average, for reference.
// Tarred Gravel won (user, 2026-10-23: the others "are all doing some bad lines"); Asphalt Track stays as the
// A/B (?asphalt=asphalt_track — the dock already ships it). Pit Lane and Clean Asphalt were tried and dropped.
export const ROAD_SCANS = {
  asphalt_track: { mean: [0.0166, 0.013, 0.0121], tile: 2.0 },
  tarred_gravel: { mean: [0.0519, 0.0456, 0.0376], tile: 2.2 },
};
export const ROAD_SCAN = {
  tile: uniform(2.0), //       metres per tile
  colorAmt: uniform(1.0), //   0 = our flat ramp, 1 = the scan's full variation
  saturation: uniform(0.35), // the scans are brownish; our deck is a cool grey
  normalAmt: uniform(1.0),
  roughBase: uniform(0.9),
  roughStones: uniform(0.25), // how much shinier a bright chip is than the binder (0.35: "a bit too bright")
  shineAA: uniform(1.0), //    0 = off: the far road's bumps don't turn into sparkle (below)
  brightness: uniform(0.72), // the deck's colour (user: "a bit too bright", 10-23 → 0.85; "a bit darker", 10-29 → 0.72)
};

// The placeholder until the scan has loaded: FLAT, and with every mip level (2026-10-27: the dock's START picture
// came out white — it is drawn at boot, before the scan arrives. A 1×1 texture has no LOCAL_MIP level, so the
// high-pass below divided by ~0). 256² so LOCAL_MIP exists and equals the texture: the deck is plain grey.
const flatTex = (r, g, b) => {
  const N = 256, px = new Uint8Array(N * N * 4);
  for (let i = 0; i < N * N; i++) { px[i * 4] = r; px[i * 4 + 1] = g; px[i * 4 + 2] = b; px[i * 4 + 3] = 255; }
  const t = new THREE.DataTexture(px, N, N);
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
};

// THE TILE'S OWN SHADING IS THROWN AWAY (user's top view, 2026-10-23: a checkerboard of light and dark
// squares). A scan is lighter on one side than the other, and repeated every 2 m that gradient is a grid.
// Divided by a blurred copy of itself (mip LOCAL_MIP: 16×16 texels, ~17 cm) only the stones are left; the
// broad tone comes from our world-space macro, which has no repeat. The normal map gets the same high-pass.
const LOCAL_MIP = 7;

export function createScanDeck(name = "tarred_gravel") {
  const S = ROAD_SCAN;
  const diffN = texture(flatTex(128, 128, 128));
  const norN = texture(flatTex(128, 128, 255));
  let loading = 0;
  async function use(id) {
    const info = ROAD_SCANS[id];
    if (!info) throw new Error(`no road scan ${id}`);
    const n = ++loading;
    const [d, nm] = await Promise.all([
      loadTexture(`${PBR}${id}/${id}_diff_2k.jpg`),
      loadTexture(`${PBR}${id}/${id}_nor_gl_2k.jpg`),
    ]);
    if (n !== loading) return; // a newer pick won
    for (const t of [d, nm]) {
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.anisotropy = 8;
      t.needsUpdate = true;
    }
    if (typeof window !== "undefined") window.__roadScanKtx2 = d.userData.ktx2 && nm.userData.ktx2;
    diffN.value = d;
    norN.value = nm;
    S.tile.value = info.tile;
    ROAD_WEAR.chipAmt.value = 0;
  }
  // (resolves once the scan is in: a picture cached before it would keep the flat grey placeholder)
  const ready = use(name).catch(() => {});

  const hook = (u, { surface }) => {
    const suv = vec2(uv().x.add(attribute("aPiece", "vec2").x), uv().y).div(S.tile);
    const rel = diffN.sample(suv).rgb.div(max(diffN.sample(suv).level(LOCAL_MIP).rgb, vec3(1e-3, 1e-3, 1e-3))); // 1 = the local average
    const lum = dot(rel, vec3(0.2126, 0.7152, 0.0722));
    const relC = mix(vec3(lum, lum, lum), rel, S.saturation);
    // our ramp (macro tone + worn lines) carries the deck's colour; the scan modulates it
    const shaped = saturate(surface.x.mul(oneMinus(u.aggWeight)).add(surface.y.mul(u.aggWeight)).sub(0.5).mul(u.grainScale).add(0.5));
    const ramp = mix(u.asphaltDark, u.asphaltLight, shaped);
    const normal = normalMap(norN.sample(suv).rgb.sub(norN.sample(suv).level(LOCAL_MIP).rgb).add(vec3(0.5, 0.5, 1.0)), vec2(S.normalAmt, S.normalAmt));

    // SHINE THAT HOLDS AT DISTANCE (specular anti-aliasing, Kaplanyan & Hoffman 2016): where the stones'
    // normals change faster than a pixel can show, the sun's highlight would sparkle on and off between
    // frames. The normal's own screen-space variation becomes extra roughness instead, capped so the
    // polished wheel paths still read as two bright bands into a low sun.
    const dn = fwidth(normal);
    const roughAA = min(dot(dn, dn).mul(0.5), 0.18).mul(S.shineAA);

    return {
      color: ramp.mul(mix(vec3(1, 1, 1), relC, S.colorAmt)).mul(S.brightness),
      rough: S.roughBase.sub(saturate(lum.sub(1.0)).mul(S.roughStones)).add(surface.x.sub(0.5).mul(u.roughVary)),
      roughAA,
      normal,
    };
  };
  return { hook, use, ready };
}
