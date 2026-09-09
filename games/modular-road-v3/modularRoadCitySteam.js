// ── STREET STEAM ─────────────────────────────────────────────────────────────
//
// Plumes drifting up out of manholes and vents. A small thing, and the reason
// it is worth doing is that it MOVES: the city has lights, signage and traffic,
// but at a standstill on an empty street nothing at all is alive. Steam is the
// cheapest motion a city can have.
//
// ── WHY THE SHAPE IS IN THE GEOMETRY AND THE MOTION IS IN THE FRAGMENT ──────
//
// The obvious build is a camera-facing billboard that rises and expands, which
// means moving vertices per instance — and `InstanceNode` overwrites
// `positionLocal`, so a vertex-stage reshape means fighting the instancing
// path (the same wall the traffic fleet hit). It is not needed here.
//
// A plume widens as it rises, so the widening is BAKED: each quad is a
// trapezoid, narrow at the base and wide at the top. Three of them crossed at
// sixty degrees stand in for a billboard — steam has no silhouette to give the
// trick away, and unlike a billboard it reads from above as well, which
// matters in a game whose track is over the rooftops.
//
// So the vertex stage does nothing at all, and the fragment stage does two
// sines. There is no CPU cost per frame: the drift is a clock uniform.
//
// ── ONE DRAW ─────────────────────────────────────────────────────────────────
//
// One InstancedMesh. `aPhase` scatters the vents so no two billow together —
// safe as a varying here, unlike the tile indices elsewhere in this city,
// because it is a CONTINUOUS value and interpolating a constant gives the
// constant back.

import * as THREE from "three";
import {
  attribute, texture, uv, vec3, vec4, float, sin, uniform, positionWorld,
  smoothstep, oneMinus, max, mix,
} from "three/tsl";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

export const STEAM_DEFAULTS = {
  /** Off and nothing is built at all. */
  steam: 1,
  /** Chance a block side gets a vent. Kept low: steam everywhere is fog. */
  steamChance: 0.20,
  /** How far into the carriageway from the kerb, metres. Manholes sit in the
   *  road, not on the pavement. */
  steamInset: 3.4,
  steamWidth: 1.5,
  steamTopWidth: 3.4,
  steamHeight: 5.2,
  /** Drift speed and how hard the plume reads. */
  steamRate: 0.22,
  steamOpacity: 0.30,
  /** Steam is lit by whatever is around it, so it lifts at night rather than
   *  going grey with the rest of the street. */
  steamNight: 1.5,
};

/**
 * Three trapezoids crossed at sixty degrees, base at y = 0.
 *
 * UV.y runs 0 at the base to 1 at the top — the fragment stage keys everything
 * off it, so the geometry is the only place the plume's proportions live.
 */
export function buildSteamGeometry(P) {
  const wb = P.steamWidth * 0.5, wt = P.steamTopWidth * 0.5, h = P.steamHeight;
  const parts = [];
  for (let i = 0; i < 3; i++) {
    const g = new THREE.BufferGeometry();
    // A trapezoid: narrow at the bottom, wide at the top.
    const pos = new Float32Array([
      -wb, 0, 0, wb, 0, 0, wt, h, 0,
      -wb, 0, 0, wt, h, 0, -wt, h, 0,
    ]);
    const uvs = new Float32Array([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1]);
    const nrm = new Float32Array(18);
    for (let k = 0; k < 6; k++) nrm[k * 3 + 2] = 1;
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
    g.setAttribute("normal", new THREE.BufferAttribute(nrm, 3));
    g.rotateY((i * Math.PI) / 3);
    parts.push(g);
  }
  const g = mergeGeometries(parts, false);
  for (const q of parts) q.dispose();
  if (!g) throw new Error("[CitySteam] merge returned null");
  return g;
}

/**
 * The plume. Two scrolling sines for the billow, a fade in at the base and out
 * at the top, and nothing else — no texture, no sampler, no mip chain.
 *
 * NOT ADDITIVE. Steam scatters light, it does not emit it: added, a plume over
 * a dark street glows like a ghost, and over a bright facade it disappears.
 */
export function makeSteamMaterial(uTime, uNight, P) {
  const mat = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: true,
  });
  mat.name = "CitySteam";
  const aPhase = attribute("aPhase", "float");
  const uRate = uniform(P.steamRate);
  const uOpacity = uniform(P.steamOpacity);
  const uNightLift = uniform(P.steamNight);

  const t = uTime.mul(uRate).add(aPhase.mul(7.3));
  const vy = uv().y;
  const vx = uv().x;
  /*
   * THE BILLOW. Two sines at co-prime-ish rates scrolling UP the plume: one
   * slow and broad, one quick and fine. A single sine reads as a rippling
   * curtain, which is the giveaway — it is the beat between two that looks
   * like turbulence.
   */
  const s1 = sin(vy.mul(5.1).sub(t.mul(3.0)).add(vx.mul(2.3))).mul(0.5).add(0.5);
  const s2 = sin(vy.mul(11.7).sub(t.mul(4.7)).add(aPhase.mul(19.0))).mul(0.5).add(0.5);
  const billow = s1.mul(0.65).add(s2.mul(0.35));
  // Soft at the edges of the quad, out of the ground, and gone by the top.
  const edge = smoothstep(0.0, 0.22, vx).mul(smoothstep(1.0, 0.78, vx));
  const rise = smoothstep(0.0, 0.16, vy).mul(oneMinus(smoothstep(0.42, 1.0, vy)));
  const a = edge.mul(rise).mul(billow.mul(0.7).add(0.3)).mul(uOpacity);

  // Warm-grey, lifting a little at night so it catches the street lighting
  // instead of sinking into it.
  const col = mix(vec3(0.80, 0.82, 0.84), vec3(1.0, 0.95, 0.88), uNight.mul(0.6));
  mat.colorNode = col.mul(mix(float(1.0), uNightLift, uNight));
  mat.opacityNode = a;
  return { material: mat, uRate, uOpacity, uNightLift };
}
