// THE GAME'S OWN SEA (2026-10-12, you: "the Tidewater ocean is awesome but not made for a top
// view — the breaking surf looks bad from above; build the game's own sea, inspired by Tidewater,
// without modifying it"). Ocean Pro (Tidewater's port) is built for a camera near the water looking
// at the horizon: curling lips, spray, grazing reflections. From the RTS camera (60-100 m up,
// looking down) what reads is what you see THROUGH the water and along its edge — so this is:
//
//   ONE flat lit surface at sea level (one draw), its colour from the DEPTH under it (the map's
//   heightmap, read in the shader):
//     the shallows    clear turquoise, the seabed seen through them (transparent near the shore)
//     the deep        Tidewater's blue-green absorption, opaque from ~4 m
//   the SURFACE        ripples (three layers of scrolling noise, along the wind) → the sun's glints
//                      and the sky's reflection, from the scene's own light and environment
//   the SHORE          (Tidewater's swash and surf, seen from above) a foam line at the water's edge
//                      that pulses with the swell, and WAVES rolling in through the shallows — bands
//                      of foam moving toward the beach, born ~4.5 m deep, breaking up into lace
//
// The map's sea LEVEL (maps/coast.js `sea.level`) is answered to every system by algGame.js (the
// level file carries no ocean). ?sea=pro = Ocean Pro instead, to compare.
import * as THREE from "three";
import { RENDER_ORDER } from "../shared-rts/renderOrder.js";
import { abs, clamp, exp, float, fract, max, mix, mx_noise_float, normalize, positionWorld, smoothstep, texture, time, transformNormalToView, uniform, vec2, vec3 } from "three/tsl";

export const SEA = {
  shallow: [0.29, 0.6, 0.56],    // over sand, a metre down
  deep: [0.03, 0.15, 0.21],      // Tidewater's absorption, deep water
  absorb: 5.5,                   // m: how fast the colour goes from shallow to deep
  clearDepth: 3.8,               // m: fully opaque from here (the seabed seen above it)
  edgeAlpha: 0.22,               // opacity at the water's edge (no hard line where it meets the land)
  roughness: 0.07,
  windDeg: 45,                   // the swell comes FROM here (the coast level's: NW, onto the beach)
  rippleAmp: 0.09,               // m
  clearDist: 22,                 // m from the shore: opaque by here whatever the depth
  edgeFoam: 1.2,                 // m: the swash's foam at rest (+1.6 m as the swell runs up)
  waveBorn: 34,                  // m from the shore: the waves are born here and break toward it
  waveSpacing: 9,                // m between two waves
  waveSpeed: 0.075,              // waves a second (0.7 m/s toward the beach)
  waveWobble: 4.5,               // m: how far a wave's line bends
  foam: [0.93, 0.95, 0.94],
};

/**
 * @param {object} app   the v3 app (scene, heightTexNode, maxHeight, worldSize, getWaterLevelAt)
 * @param {object} o
 * @param {number} o.level     the sea level (m)
 * @param {number} [o.size]    m, the surface's side (past the map: the open sea to the horizon)
 */
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

export function createAlgSea(app, { level, size = 6000 } = {}) {
  const P = SEA;
  const W = app.worldSize, H = app.maxHeight;
  const uLevel = uniform(level);
  const t = time;
  const t0 = performance.now();
  const shoreTex = shoreDistance(app, level);
  const shoreMs = Math.round(performance.now() - t0);

  // The DEPTH under a point: the sea level minus the ground (the heightmap, as terrainDrape's
  // drapeY reads it; past the map's edge the ground reads 0 → deep).
  const wp = positionWorld;
  const u = wp.x.add(W * 0.5).div(W), v = wp.z.add(W * 0.5).div(W);
  const ground = texture(app.heightTexNode, vec2(u, v)).r.mul(H);
  const inMap = smoothstep(0.0, 0.002, u).mul(smoothstep(1.0, 0.998, u)).mul(smoothstep(0.0, 0.002, v)).mul(smoothstep(1.0, 0.998, v));
  const depth = max(uLevel.sub(mix(float(level - 40), ground, inMap)), 0.0);

  // THE SURFACE: three ripple layers scrolling along the wind; the normal from their slope.
  const wr = THREE.MathUtils.degToRad(P.windDeg + 180);   // (FROM the wind's direction → toward)
  const wind = vec2(Math.sin(wr), Math.cos(wr));
  const layer = (xz, f, speed, amp, seed) => mx_noise_float(vec3(xz.mul(f).add(wind.mul(t.mul(speed))), t.mul(0.07).add(seed))).mul(amp);
  const hAt = (xz) => layer(xz, 0.09, 0.9, 1.0, 0).add(layer(xz, 0.23, 1.6, 0.45, 3.1)).add(layer(xz, 0.61, 2.4, 0.18, 7.7));
  const xz = wp.xz, e = 0.35;
  const h0 = hAt(xz), hx = hAt(xz.add(vec2(e, 0))), hz = hAt(xz.add(vec2(0, e)));
  // calmer in the shallows (the swell flattens as it feels the bottom) and far out, from above
  const amp = float(P.rippleAmp).mul(smoothstep(0.0, 2.5, depth).mul(0.6).add(0.4));
  const nWorld = normalize(vec3(hx.sub(h0).mul(amp).div(e).negate(), 1.0, hz.sub(h0).mul(amp).div(e).negate()));

  // THE COLOUR: Tidewater's absorption by depth.
  const k = float(1).sub(exp(depth.div(P.absorb).negate()));
  const water = mix(vec3(...P.shallow), vec3(...P.deep), k);

  // THE SHORE, measured in METRES from it (the distance field; past the map: far out).
  const dist = mix(float(64), texture(shoreTex, vec2(u, v)).r.mul(255 / 4), inMap);
  const lace = mx_noise_float(vec3(xz.mul(0.55), t.mul(0.35))).mul(0.5).add(0.5);           // fine foam lace
  const clumps = mx_noise_float(vec3(xz.mul(0.07).add(wind.mul(t.mul(0.4))), t.mul(0.05))).mul(0.5).add(0.5);   // where a wave breaks more
  const swell = t.mul(0.9).sin().mul(0.5).add(0.5);
  // the edge: the swash, a band a metre or two wide that runs up as the swell comes in
  const edge = smoothstep(float(P.edgeFoam).add(swell.mul(1.6)), 0.0, dist).mul(smoothstep(0.25, 0.6, lace.add(swell.mul(0.15))));
  // the waves: lines of constant distance moving toward the beach, a sharp crest and a trail of
  // foam behind; born waveBorn metres out, strongest where they break, gone at the swash
  // (the lines BENT by a slow noise — ruled straight stripes read as a pattern, not a sea — and
  // broken in pieces along their length: a wave breaks here and not there)
  const wobble = mx_noise_float(vec3(xz.mul(0.035), t.mul(0.04))).mul(P.waveWobble);
  const phase = fract(dist.add(wobble).div(P.waveSpacing).add(t.mul(P.waveSpeed)));
  const crest = smoothstep(0.0, 0.06, phase).mul(float(1).sub(smoothstep(0.06, 0.45, phase)));
  const born = smoothstep(P.waveBorn, P.waveBorn * 0.35, dist).mul(smoothstep(0.8, 3.0, dist));
  const waves = crest.mul(born).mul(smoothstep(0.45, 0.8, clumps.mul(0.75).add(lace.mul(0.4))));
  const foam = clamp(max(edge, waves), 0.0, 1.0);

  // OPACITY: clear in the shallows (the seabed shows), solid from clearDepth or clearDist out
  // (a flat beach's shallows would otherwise stay see-through for tens of metres); foam opaque.
  const clear = max(smoothstep(0.0, P.clearDepth, depth), smoothstep(0.0, P.clearDist, dist));
  const alpha = max(mix(float(P.edgeAlpha), float(1), clear), foam);

  const mat = new THREE.MeshStandardNodeMaterial({ transparent: true, depthWrite: false, metalness: 0, roughness: P.roughness });
  mat.name = "AlgSea";
  mat.colorNode = mix(water, vec3(...P.foam), foam);
  mat.roughnessNode = mix(float(P.roughness), float(0.65), foam);
  mat.opacityNode = alpha;
  // the ripples' normal, foam flatter (the geometry is already in world space: object = world)
  mat.normalNode = transformNormalToView(normalize(mix(nWorld, vec3(0, 1, 0), foam.mul(0.7))));

  const geo = new THREE.PlaneGeometry(size, size, 1, 1).rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = "AlgSea";
  mesh.position.y = level;
  mesh.receiveShadow = true;
  mesh.renderOrder = RENDER_ORDER.SEA;   // see-through: before the fields, rings, smoke over it
  mesh.frustumCulled = false;
  mesh.updateMatrix(); mesh.matrixAutoUpdate = false;
  app.scene.add(mesh);

  console.log(`[alg sea] level ${level} m, the shore distance in ${shoreMs} ms`);
  return {
    params: P, mesh, uLevel, shoreTex,
    dispose() { app.scene.remove(mesh); geo.dispose(); mat.dispose(); shoreTex.dispose(); },
  };
}
