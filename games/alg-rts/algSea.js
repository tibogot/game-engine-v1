// THE GAME'S OWN SEA (2026-10-12, you: "the Tidewater ocean is awesome but not made for a top
// view — the breaking surf looks bad from above; build the game's own sea, inspired by Tidewater,
// without modifying it"; then "we could do way better looking"). Ocean Pro (Tidewater's port) is
// built for a camera near the water looking at the horizon. From the RTS camera (60-100 m up,
// looking down) what reads is what you see THROUGH the water and along its edge — so this is
// Tidewater's optics seen from above, ONE surface (one draw):
//
//   THROUGH the water   the real scene behind it (the shared one-copy-a-frame grab, lakeMaterial's
//                       sceneColorGrab), ABSORBED per channel by the depth (Beer-Lambert: red goes
//                       first) — sand a metre down reads turquoise, 10 m down deep blue — plus the
//                       light the water itself scatters back. At depth 0 nothing is absorbed: the
//                       shoreline is seamless (the old surface drew a hard line there).
//   CAUSTICS            on the seabed in the shallows (Caustic_Free.jpg, two layers, their minimum)
//   the SURFACE         the water normal map, two scrolling layers along the wind: the sun's glints
//                       and the sky's reflection (the scene's own light and environment, roughness)
//   the SHORE           the distance-to-shore field (built once at load): waves rolling in, their
//                       foam LACE from the caustic cells; the SWASH — the surface sits `lift` over
//                       the sea, so a thin film runs up the beach and back, a lace at its front, and
//                       the sand it leaves is darker (wet), drying up the slope
//
// The map's sea LEVEL (maps/coast.js `sea.level`) is answered to every system by algGame.js (the
// level file carries no ocean); only this surface sits `lift` over it. ?sea=pro = Ocean Pro.
import * as THREE from "three";
import { RENDER_ORDER } from "../shared-rts/renderOrder.js";
import { sceneColorGrab } from "../../v3/render/water/lakeMaterial.js";
import { clamp, exp, float, fract, max, min, mix, mx_noise_float, normalize, positionWorld, screenUV, smoothstep, texture, time, transformNormalToView, uniform, vec2, vec3 } from "three/tsl";

export const SEA = {
  // the light the water scatters back (deep, open water seen from above) and how fast each
  // channel is absorbed (1/m) — the Mediterranean's turquoise shallows, ultramarine deep
  deep: [0.004, 0.035, 0.2],
  shallow: [0.02, 0.38, 0.6],   // the light scattered in clear shallows over sand: the turquoise
  shallowTo: 9,                  // m: shallow scatter → deep scatter
  sigma: [0.85, 0.23, 0.085],
  viewK: 1.15,                   // the view ray's path through the water ÷ the depth (the RTS tilt)
  roughness: 0.06,
  windDeg: 45,                   // the swell comes FROM here (onto the beach, NW)
  normalTile: [41, 15],           // m: the two normal-map layers
  normalStr: 0.3,
  refract: 0.012,                // screen-uv offset by the surface's slope (×depth, capped)
  caustics: 1.1,                 // how bright on the seabed
  causticTile: 7,                // m
  // the shore (in metres from it, the distance field)
  waveBorn: 34, waveSpacing: 9, waveSpeed: 0.075, waveWobble: 4.5,
  foam: [0.92, 0.94, 0.93],
  // the swash: the surface `lift` m over the sea, a run-up every `period` s
  lift: 0.35, period: 7.5, wetDark: 0.62,
};

/**
 * THE DISTANCE TO THE SHORE (Tidewater's shore field, simply): metres from each water point to the
 * nearest land, on a 2 m grid over the map, built ONCE from the terrain (whatever its shape). The
 * foam and the waves are measured in it — the depth alone failed: the coast's beach is so flat
 * (0.4 m deep 30 m out) that a "depth under 0.75 m" foam line came out tens of metres wide.
 * A chamfer distance (two passes, 3-4-5 weights); stored in a byte, 0.25 m a step, up to 63.75 m.
 */
function shoreDistance(app, level, N = 512) {
  const W = app.worldSize, cell = W / N, BIG = 1e9;
  const d = new Float32Array(N * N);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const x = -W / 2 + (i + 0.5) * cell, z = -W / 2 + (j + 0.5) * cell;
    d[j * N + i] = app.getWorldHeight(x, z) >= level ? 0 : BIG;
  }
  const a = cell, b = cell * Math.SQRT2;
  const at = (i, j) => (i < 0 || j < 0 || i >= N || j >= N ? BIG : d[j * N + i]);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const k = j * N + i;
    if (!d[k]) continue;
    d[k] = Math.min(d[k], at(i - 1, j) + a, at(i, j - 1) + a, at(i - 1, j - 1) + b, at(i + 1, j - 1) + b);
  }
  for (let j = N - 1; j >= 0; j--) for (let i = N - 1; i >= 0; i--) {
    const k = j * N + i;
    if (!d[k]) continue;
    d[k] = Math.min(d[k], at(i + 1, j) + a, at(i, j + 1) + a, at(i + 1, j + 1) + b, at(i - 1, j + 1) + b);
  }
  const bytes = new Uint8Array(N * N);
  for (let k = 0; k < N * N; k++) bytes[k] = Math.min(255, Math.round(d[k] * 4));
  const tex = new THREE.DataTexture(bytes, N, N, THREE.RedFormat, THREE.UnsignedByteType);
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  tex.name = "alg sea shore distance";
  return tex;
}

function repeatTex(url, srgb = false) {
  const t = new THREE.TextureLoader().load(url);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/**
 * @param {object} app   the v3 app (scene, heightTexNode, maxHeight, worldSize, getWorldHeight)
 * @param {object} o
 * @param {number} o.level     the sea level (m)
 * @param {number} [o.size]    m, the surface's side (past the map: the open sea to the horizon)
 */
export function createAlgSea(app, { level, size = 6000 } = {}) {
  const P = SEA;
  const W = app.worldSize, H = app.maxHeight;
  const U = {
    level: uniform(level), deep: uniform(new THREE.Color(...P.deep)), shallow: uniform(new THREE.Color(...P.shallow)), sigma: uniform(new THREE.Vector3(...P.sigma)),
    caustics: uniform(P.caustics), normalStr: uniform(P.normalStr), wetDark: uniform(P.wetDark),
  };
  const t = time;
  const t0 = performance.now();
  const shoreTex = shoreDistance(app, level);
  const shoreMs = Math.round(performance.now() - t0);
  const nrmTex = repeatTex("/textures/waterNormal.webp");
  const cauTex = repeatTex("/textures/Caustic_Free.jpg");

  // ── Where: the ground under the point, the depth, the distance from the shore ──
  const wp = positionWorld, xz = wp.xz;
  const u = wp.x.add(W * 0.5).div(W), v = wp.z.add(W * 0.5).div(W);
  const inMap = smoothstep(0.0, 0.002, u).mul(smoothstep(1.0, 0.998, u)).mul(smoothstep(0.0, 0.002, v)).mul(smoothstep(1.0, 0.998, v));
  const ground = mix(float(level - 40), texture(app.heightTexNode, vec2(u, v)).r.mul(H), inMap);
  const below = U.level.sub(ground);                       // + under the sea, − up the beach
  const depth = max(below, 0.0);
  const dist = mix(float(64), texture(shoreTex, vec2(u, v)).r.mul(255 / 4), inMap);

  const wr = THREE.MathUtils.degToRad(P.windDeg + 180);   // (FROM the wind's direction → toward)
  const wind = vec2(Math.sin(wr), Math.cos(wr)), side = vec2(Math.cos(wr), -Math.sin(wr));

  // ── THE SWASH: the run-up (m over the sea) at this point now ─────────────────
  // a quick rush up, a slow fall back; each stretch of beach on its own phase and reach
  const along = mx_noise_float(vec3(xz.mul(0.045), 0.0)).mul(0.5).add(0.5);
  const sw = fract(t.div(P.period).add(along.mul(1.7)));
  const rush = smoothstep(0.0, 0.28, sw).mul(float(1).sub(smoothstep(0.28, 1.0, sw)));
  const runup = rush.mul(along.mul(0.55).add(0.45)).mul(P.lift);
  const film = clamp(runup.sub(below.negate()).div(0.05), 0.0, 1.0).mul(smoothstep(0.0, -0.02, below.negate().sub(P.lift)));   // up the beach, under the film
  const onBeach = smoothstep(-0.005, 0.005, below.negate());   // 1 where the ground is over the sea

  // ── THE SURFACE: two normal-map layers along the wind ────────────────────────
  const n1 = texture(nrmTex, xz.div(P.normalTile[0]).add(wind.mul(t.mul(0.018)))).xyz.mul(2).sub(1);
  const n2 = texture(nrmTex, xz.div(P.normalTile[1]).add(side.mul(t.mul(0.011))).add(wind.mul(t.mul(0.026)))).xyz.mul(2).sub(1);
  // calm on the beach's film and as the swell feels the bottom
  const calm = smoothstep(0.0, 1.5, depth).mul(0.75).add(0.25).mul(float(1).sub(onBeach.mul(0.7)));
  const slope = n1.xy.add(n2.xy).mul(U.normalStr).mul(calm);
  const nWorld = normalize(vec3(slope.x, 1.0, slope.y));

  // ── THROUGH THE WATER: the seabed, refracted, absorbed; caustics ─────────────
  const refr = slope.mul(P.refract).mul(min(depth, 2.0)).mul(float(1).sub(onBeach));
  const behind = sceneColorGrab.sample(screenUV.add(refr).clamp()).rgb;
  const path = depth.mul(P.viewK);
  const T = exp(U.sigma.mul(path).negate());   // per channel
  const cuv = xz.div(P.causticTile);
  const cau = min(
    texture(cauTex, cuv.add(wind.mul(t.mul(0.03)))).r,
    texture(cauTex, cuv.mul(1.31).add(side.mul(t.mul(0.025))).add(0.37)).r,
  );
  const cauMask = smoothstep(0.08, 0.5, depth).mul(float(1).sub(smoothstep(1.5, 6.0, depth)));
  // (the sand under the water is WET: as dark as the wet beach — dry-bright under the shallows, they
  // read brighter than the wet strip above the waterline)
  const seabed = behind.mul(U.wetDark).mul(float(1).add(cau.mul(cau).mul(U.caustics).mul(cauMask)));

  // ── THE SHORE: waves rolling in, their lace ─────────────────────────────────
  // the lace: the caustic cells' bright edges, their UVs WARPED by a noise (straight, the cells drew
  // a regular net of round holes — "Swiss cheese"), two scales
  const warp = vec2(mx_noise_float(vec3(xz.mul(0.18), t.mul(0.12))), mx_noise_float(vec3(xz.mul(0.18).add(7.3), t.mul(0.12)))).mul(0.45);
  const lace = texture(cauTex, xz.div(6.5).add(warp).add(wind.mul(t.mul(0.05)))).r;
  const lace2 = texture(cauTex, xz.div(2.7).add(warp.mul(1.6)).add(side.mul(t.mul(0.07))).add(0.61)).r;
  const clumps = mx_noise_float(vec3(xz.mul(0.07).add(wind.mul(t.mul(0.4))), t.mul(0.05))).mul(0.5).add(0.5);
  const wobble = mx_noise_float(vec3(xz.mul(0.035), t.mul(0.04))).mul(P.waveWobble);
  const phase = fract(dist.add(wobble).div(P.waveSpacing).add(t.mul(P.waveSpeed)));
  const crest = smoothstep(0.0, 0.05, phase).mul(float(1).sub(smoothstep(0.05, 0.55, phase)));   // a front and its trail
  const born = smoothstep(P.waveBorn, P.waveBorn * 0.35, dist).mul(smoothstep(0.3, 2.0, dist));
  const waveAmt = crest.mul(born).mul(smoothstep(0.35, 0.8, clumps));
  // foam = a soft BODY (churned, milky water) and the lace over it, both by the amount
  const laceAt = (amt) => max(
    smoothstep(float(1).sub(amt), float(1.25).sub(amt), lace.mul(0.6).add(lace2.mul(0.5))),
    smoothstep(0.25, 1.0, amt).mul(0.55).mul(lace2.mul(0.5).add(0.5)));
  // the swash: a lace at the film's front as it runs up, lace left in the film as it falls back
  const front = smoothstep(0.07, 0.0, runup.sub(below.negate())).mul(film).mul(onBeach).mul(smoothstep(0.02, 0.08, runup));
  const frontLine = front.mul(lace2.mul(0.35).add(0.65));   // a continuous line, a little broken (was specks)
  const shoreAmt = max(waveAmt, max(frontLine, film.mul(onBeach).mul(0.4)))
    .add(smoothstep(2.5, 0.0, dist).mul(float(1).sub(onBeach)).mul(0.6));   // the line where it meets the sand
  const foam = clamp(laceAt(clamp(shoreAmt, 0.0, 1.0)), 0.0, 1.0);

  // ── WET SAND: up the beach, darker toward the sea; under the film, a touch more ──
  // (its top edge ragged: a perfectly even beach slope drew it as a ruled stripe)
  const rag = mx_noise_float(vec3(xz.mul(0.22), 0.0)).mul(0.06).add(mx_noise_float(vec3(xz.mul(0.9), 0.0)).mul(0.025));
  const wet = smoothstep(P.lift * 0.85, P.lift * 0.15, below.negate().add(rag)).mul(onBeach);
  const sandSeen = behind.mul(mix(float(1), U.wetDark, wet.mul(0.8).add(film.mul(0.2))));

  // ── THE OUTPUT: what is seen through (unlit: the grab is lit already) + the water's own ──
  // in the sea: the seabed through the water + its scattered light; on the beach: the sand, wet
  const through = mix(seabed.mul(T), sandSeen, onBeach);
  const scatter = mix(U.shallow, U.deep, smoothstep(0.5, P.shallowTo, depth));
  const own = scatter.mul(vec3(1).sub(T)).mul(float(1).sub(onBeach));
  // (Physical: its SPECULAR can be switched off — on the dry beach the standard material's 4% sky
  // reflection lit the sand the surface overlaps, and its edge drew a line along the beach)
  const mat = new THREE.MeshPhysicalNodeMaterial({ transparent: true, depthWrite: false, metalness: 0, roughness: P.roughness, ior: 1.33 });
  mat.name = "AlgSea";
  mat.fog = false;   // the grab is fogged already; the RTS camera sees no horizon
  mat.colorNode = mix(own, vec3(...P.foam), foam);
  mat.emissiveNode = through.mul(float(1).sub(foam));
  // a dry beach is not shiny: the specular only where there is water
  const wetSurf = max(float(1).sub(onBeach), film);
  // THE RIPPLES ONLY IN THE REFLECTION (2026-10-16, you: "the noise looks weird"): on the base normal
  // they SHADED the water's own colour like a matte surface — crumpled plaster. Water has no matte
  // relief: the base is flat (its colour, the foam), the waves live in a CLEARCOAT layer — the glints.
  mat.roughnessNode = mix(float(0.95), float(0.6), foam);
  mat.specularIntensityNode = float(0);
  mat.clearcoatNode = wetSurf.mul(float(1).sub(foam));
  mat.clearcoatRoughnessNode = float(P.roughness);
  mat.clearcoatNormalNode = transformNormalToView(normalize(mix(vec3(0, 1, 0), nWorld, wetSurf)));
  mat.normalNode = transformNormalToView(vec3(0, 1, 0));

  const geo = new THREE.PlaneGeometry(size, size, 1, 1).rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = "AlgSea";
  mesh.position.y = level + P.lift;
  mesh.receiveShadow = true;
  mesh.renderOrder = RENDER_ORDER.SEA;   // see-through: after the opaque scene it reads, before the ground marks
  mesh.frustumCulled = false;
  mesh.updateMatrix(); mesh.matrixAutoUpdate = false;
  app.scene.add(mesh);

  console.log(`[alg sea] level ${level} m, the shore distance in ${shoreMs} ms`);
  return {
    params: P, uniforms: U, mesh, shoreTex,
    dispose() { app.scene.remove(mesh); geo.dispose(); mat.dispose(); shoreTex.dispose(); nrmTex.dispose(); cauTex.dispose(); },
  };
}
