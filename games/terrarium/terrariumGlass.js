/**
 * The tank: glass panes, aluminium trim, silicone corner beads.
 *
 * Deliberately NOT a volumetric transmission material. At 6 mm thickness and viewed
 * near head-on, real terrarium glass refracts almost nothing, disperses nothing, and
 * absorbs nothing worth modelling — the refraction offset scales with thickness, and
 * there is barely any. What you actually see is:
 *
 *   - Fresnel: 4% reflection head-on rising to ~100% at grazing angles
 *   - a long soft reflection of the room and window
 *   - a green cast concentrated at the edges (iron in the glass, long path length)
 *   - and, above all, GRIME — dust, smudges, fingerprints, condensation
 *
 * That last one is doing more work than everything else combined. Perfectly clean glass
 * is nearly invisible; it is the imperfection that tells the eye there is a surface
 * there. So the expensive part of this material is a baked detail map, not a render pass.
 *
 * The practical payoff: the glass covers most of the viewport in this scene, and a
 * backdrop-capture transmission material would re-render the whole scene behind it every
 * frame at near-full resolution. This costs one extra transparent pass.
 */
import * as THREE from "three/webgpu";
import {
  vec2, vec3, float, uniform, texture, positionWorld, normalWorld, cameraPosition,
  normalize, dot, abs, pow, clamp, mix, oneMinus, smoothstep, step,
} from "three/tsl";
import { fbm, ridged, makeDataTexture, bakeNormalMap, clamp01, smoothstep as sstep } from "./terrariumTextures.js";

/** Tank dimensions in metres — a 90 x 45 x 45 cm vivarium, a realistic adult enclosure. */
export const TANK = {
  w: 0.90,
  d: 0.45,
  h: 0.45,
  glass: 0.006,
  get iw() { return this.w - this.glass * 2; },
  get id() { return this.d - this.glass * 2; },
};

export const GLASS_DEFAULTS = {
  envIntensity: 1.6,
  roughness: 0.035,
  baseOpacity: 0.05,
  fresnel: 0.62,
  tint: 0.28,
  smudge: 0.55,
  condensation: 0.22,
};

const DETAIL_SIZE = 1024;

/**
 * Bake the grime map.
 *
 *   .r  smudge / dust / fingerprint haze     -> raises opacity and roughness
 *   .g  condensation droplet mask            -> raises opacity, sharpens reflection
 *   .b  large-scale dirt drift               -> breaks up the .r field at a lower rate
 *
 * The vertical gradient matters: dust settles and condensation runs down, so both fields
 * are biased toward the bottom of the pane. Uniform grime over the whole sheet reads as
 * a noisy texture rather than as a dirty window.
 */
function bakeGlassDetail() {
  const S = DETAIL_SIZE;
  const data = new Uint8Array(S * S * 4);

  // A handful of fingerprint-ish arcs, placed once so they read as deliberate marks
  // rather than as noise. Real tanks are touched in a few places, not evenly.
  const prints = [
    { x: 0.22, y: 0.36, r: 0.055, a: 0.55 },
    { x: 0.26, y: 0.40, r: 0.045, a: 0.40 },
    { x: 0.71, y: 0.58, r: 0.062, a: 0.45 },
    { x: 0.48, y: 0.19, r: 0.070, a: 0.30 },
  ];

  for (let y = 0; y < S; y++) {
    const v = y / S;                       // 0 = pane bottom, 1 = pane top
    for (let x = 0; x < S; x++) {
      const u = x / S;
      const fx = u * 8, fy = v * 8;

      // Dust: fine, settles low.
      const dust = fbm(fx * 5.5, fy * 5.5, { octaves: 5, seed: 11, period: 44 });
      const settle = 0.35 + 0.65 * (1 - sstep(0.0, 0.85, v));
      let haze = clamp01((dust - 0.42) * 2.2) * settle;

      // Drying streaks — vertical, low frequency across, high frequency down.
      const streak = fbm(fx * 3.0, fy * 0.35, { octaves: 4, seed: 29, period: 24 });
      haze += clamp01((streak - 0.55) * 1.9) * 0.55 * settle;

      // Fingerprints: concentric ridges inside a soft disc.
      for (const p of prints) {
        const dx = u - p.x, dy = v - p.y;
        const dr = Math.hypot(dx, dy);
        if (dr < p.r) {
          const falloff = 1 - dr / p.r;
          const ridgeN = 0.5 + 0.5 * Math.sin(dr * 520 + fbm(fx * 2, fy * 2, { seed: 5 }) * 6);
          haze += falloff * falloff * ridgeN * p.a;
        }
      }
      haze = clamp01(haze);

      // Condensation. Cell noise thresholded into discrete beads, heavily bottom-weighted
      // because that is where humidity condenses and where the substrate is warmest.
      //
      // Frequency and threshold both matter more than they look. The first pass ran at
      // 208 cycles across the map with a low threshold, which at 30 cm from the camera
      // put hundreds of sub-millimetre beads on every pane — the glass read as television
      // static, or snow. Real condensation is a sparse field of beads you can count.
      const humidityBias = 1 - sstep(0.05, 0.75, v);
      const beadField = ridged(fx * 9, fy * 9, { octaves: 2, seed: 71, period: 72 });
      let drops = clamp01((beadField - 0.80) * 6.0) * humidityBias;
      // A second, coarser pass gives a few big beads among the small ones.
      const bigField = ridged(fx * 3.5, fy * 3.5, { octaves: 2, seed: 97, period: 28 });
      drops = Math.max(drops, clamp01((bigField - 0.84) * 7.0) * humidityBias * 0.9);

      const drift = fbm(fx * 1.2, fy * 1.2, { octaves: 3, seed: 43, period: 10 });

      const i = (y * S + x) * 4;
      data[i] = haze * 255;
      data[i + 1] = clamp01(drops) * 255;
      data[i + 2] = drift * 255;
      data[i + 3] = 255;
    }
  }
  return makeDataTexture(data, S);
}

/**
 * Normal map for the same surface. Droplets are little spherical caps; the smudge field
 * contributes a very faint waviness so that even the dry glass is not optically perfect.
 */
function bakeGlassNormal() {
  const S = DETAIL_SIZE;
  const height = (x, y) => {
    const u = x / S, v = y / S;
    const fx = u * 8, fy = v * 8;
    const humidityBias = 1 - sstep(0.05, 0.75, v);
    const bead = ridged(fx * 9, fy * 9, { octaves: 2, seed: 71, period: 72 });
    const big = ridged(fx * 3.5, fy * 3.5, { octaves: 2, seed: 97, period: 28 });
    const drop = Math.max(clamp01((bead - 0.80) * 6.0), clamp01((big - 0.84) * 7.0) * 0.9) * humidityBias;
    // sqrt gives the domed profile of a bead sitting on a surface; a linear ramp reads flat.
    const dome = Math.sqrt(drop);
    const wave = fbm(fx * 2.2, fy * 2.2, { octaves: 3, seed: 61, period: 18 }) * 0.10;
    return dome * 1.0 + wave;
  };
  return bakeNormalMap(S, height, 5.0);
}

/**
 * Build the glass material.
 *
 * One material shared by every pane, with the detail map addressed triplanar-style off
 * world position so a single material can serve panes facing X and Z without needing
 * per-pane UV sets or per-pane materials.
 */
export function createGlassMaterial(params = GLASS_DEFAULTS) {
  const detailTex = bakeGlassDetail();
  const normalTex = bakeGlassNormal();

  const u = {
    env: uniform(params.envIntensity),
    rough: uniform(params.roughness),
    baseOp: uniform(params.baseOpacity),
    fres: uniform(params.fresnel),
    tint: uniform(params.tint),
    smudge: uniform(params.smudge),
    cond: uniform(params.condensation),
  };

  const mat = new THREE.MeshPhysicalNodeMaterial({
    transparent: true,
    // Glass must not write depth or it occludes everything behind it in the transparent
    // pass; the panes are separate meshes so three still sorts them back-to-front.
    depthWrite: false,
    side: THREE.DoubleSide,
    metalness: 0,
    roughness: params.roughness,
    color: 0x000000,
  });
  mat.ior = 1.52;                     // soda-lime glass; gives the correct 4% at normal incidence
  mat.envMapIntensity = params.envIntensity;

  // ── addressing ────────────────────────────────────────────────────────────────────
  // Pick the two world axes that lie IN the pane. abs(normal) tells us which axis the
  // pane faces; everything else is a two-way blend. Scale is metres -> ~0.3 m per tile,
  // which puts the fingerprint arcs at roughly life size.
  const SC = float(3.2);
  const an = abs(normalWorld);
  const uvZ = vec2(positionWorld.x, positionWorld.y).mul(SC);   // pane faces +/-Z
  const uvX = vec2(positionWorld.z, positionWorld.y).mul(SC);   // pane faces +/-X
  const uvY = vec2(positionWorld.x, positionWorld.z).mul(SC);   // the base pane
  const facingX = step(an.z, an.x);
  const facingY = step(an.x, an.y).mul(step(an.z, an.y));
  const detailUV = mix(mix(uvZ, uvX, facingX), uvY, facingY);

  const det = texture(detailTex, detailUV);
  const haze = det.r.mul(u.smudge);
  const drops = det.g.mul(u.cond);
  const drift = det.b;

  // ── Fresnel ───────────────────────────────────────────────────────────────────────
  // abs() because the panes are double sided and we want the same falloff from inside.
  const V = normalize(cameraPosition.sub(positionWorld));
  const facing = clamp(abs(dot(normalWorld, V)), 0, 1);
  const fresnel = pow(oneMinus(facing), 5);

  // ── colour ────────────────────────────────────────────────────────────────────────
  // Glass has essentially no diffuse albedo. The green is the one exception worth
  // faking: iron absorption over a long path, so it only appears where the path is long
  // — at grazing angles. Head-on the pane stays colourless, which is correct.
  const edgeGreen = vec3(0.09, 0.30, 0.20).mul(fresnel).mul(u.tint);
  // Grime, unlike the glass, IS diffuse and slightly warm-grey.
  const grime = vec3(0.42, 0.40, 0.37).mul(haze.mul(0.5));
  mat.colorNode = edgeGreen.add(grime);

  // ── opacity ───────────────────────────────────────────────────────────────────────
  // Base is what a clean pane costs (nearly nothing). Fresnel is the physical part.
  // Grime and beads are what make the pane legible where it faces you head-on.
  mat.opacityNode = clamp(
    u.baseOp
      .add(fresnel.mul(u.fres))
      .add(haze.mul(0.34))
      .add(drops.mul(0.24))
      .add(drift.mul(0.02)),
    0, 1,
  );

  // ── microsurface ──────────────────────────────────────────────────────────────────
  // Smudge blurs the reflection; a water bead is smoother than the glass around it, so
  // condensation pulls roughness DOWN and reads as a field of sharp little highlights.
  mat.roughnessNode = clamp(
    u.rough.add(haze.mul(0.30)).sub(drops.mul(0.03)),
    0.004, 1,
  );

  mat.normalMap = normalTex;
  mat.normalScale = new THREE.Vector2(params.condensation, params.condensation);

  return { material: mat, uniforms: u, detailTex, normalTex };
}

/**
 * Assemble the tank: four glass walls, a glass base, aluminium trim top and bottom,
 * silicone beads in the vertical corners.
 *
 * Panes are boxes, not planes, so the 6 mm edges are real geometry and catch a real
 * highlight where they meet the trim. That edge line is a surprisingly large part of
 * reading the object as a manufactured tank.
 */
export function buildTank(glassMaterial) {
  const g = TANK.glass;
  const group = new THREE.Group();
  group.name = "tank";

  const panes = new THREE.Group();
  panes.name = "tank-glass";
  const addPane = (w, h, d, x, y, z) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), glassMaterial);
    m.position.set(x, y, z);
    // Glass draws after everything it is meant to be in front of.
    m.renderOrder = 20;
    panes.add(m);
    return m;
  };

  const wallH = TANK.h - g;              // walls sit on top of the base pane
  const wallY = g + wallH / 2;
  addPane(TANK.w, g, TANK.d, 0, g / 2, 0);                                  // base
  addPane(TANK.w, wallH, g, 0, wallY, -TANK.d / 2 + g / 2);                 // back
  addPane(TANK.w, wallH, g, 0, wallY, TANK.d / 2 - g / 2);                  // front
  addPane(g, wallH, TANK.id, -TANK.w / 2 + g / 2, wallY, 0);                // left
  addPane(g, wallH, TANK.id, TANK.w / 2 - g / 2, wallY, 0);                 // right
  group.add(panes);

  // ── trim ──────────────────────────────────────────────────────────────────────────
  // Dark anodised aluminium. Brushed rather than polished: a mirror rail next to soft
  // glass looks like chrome tape, a brushed one looks like a rail.
  const trimMat = new THREE.MeshStandardNodeMaterial({
    color: 0x22262a, metalness: 0.92, roughness: 0.38,
  });
  const trim = new THREE.Group();
  trim.name = "tank-trim";
  const T = 0.016, TO = 0.004;           // rail height, and how far it stands proud
  const addTrim = (w, h, d, x, y, z) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), trimMat);
    m.position.set(x, y, z);
    m.castShadow = true;
    m.receiveShadow = true;
    trim.add(m);
  };
  for (const y of [T / 2, TANK.h - T / 2]) {
    addTrim(TANK.w + TO * 2, T, TO, 0, y, -TANK.d / 2 - TO / 2);
    addTrim(TANK.w + TO * 2, T, TO, 0, y, TANK.d / 2 + TO / 2);
    addTrim(TO, T, TANK.d, -TANK.w / 2 - TO / 2, y, 0);
    addTrim(TO, T, TANK.d, TANK.w / 2 + TO / 2, y, 0);
  }
  group.add(trim);

  // ── silicone ──────────────────────────────────────────────────────────────────────
  // A translucent bead in each inner vertical corner and along the inner base seam. Real
  // tanks have these and they catch light in a very specific milky way; without them the
  // corners are a hard geometric line that reads as CAD.
  const silMat = new THREE.MeshPhysicalNodeMaterial({
    color: 0xd8dad4, roughness: 0.45, metalness: 0, transparent: true, opacity: 0.5,
    depthWrite: false,
  });
  const sil = new THREE.Group();
  sil.name = "tank-silicone";
  const B = 0.007;
  const cornerX = TANK.iw / 2 - B / 2, cornerZ = TANK.id / 2 - B / 2;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(B, TANK.h - g, B), silMat);
      m.position.set(sx * cornerX, g + (TANK.h - g) / 2, sz * cornerZ);
      m.renderOrder = 15;
      sil.add(m);
    }
  }
  group.add(sil);

  return { group, panes, trim, silicone: sil, trimMat, silMat };
}
