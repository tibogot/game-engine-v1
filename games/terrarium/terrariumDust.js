/**
 * Dust motes drifting inside the tank.
 *
 * The cheapest atmosphere in the scene by a wide margin. A hard light source in a closed
 * box always has visible dust in its beam, and because the motes are only bright INSIDE
 * the cone, they trace the shape of the light through the air. That does the job of a
 * volumetric light shaft for the cost of a few thousand additive points, and it also
 * does something a shaft cannot: it tells you the box has air in it.
 *
 * Everything moves on the GPU — the CPU never touches these after boot.
 */
import * as THREE from "three/webgpu";
import {
  vec3, float, uniform, attribute, positionLocal, time,
  sin, cos, fract, dot, normalize, length, smoothstep, clamp, mix, pow, oneMinus,
} from "three/tsl";
import { TANK } from "./terrariumGlass.js";

export const DUST_DEFAULTS = {
  count: 2600,
  size: 0.0016,
  brightness: 0.75,
  speed: 1.0,
};

/** Vertical band the motes occupy: above the soil, below the rim. */
const BASE_Y = 0.075;
const SPAN_Y = TANK.h - BASE_Y - 0.03;

export function createDust(params = DUST_DEFAULTS) {
  const n = params.count;
  const pos = new Float32Array(n * 3);
  const seeds = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    pos[i * 3] = (Math.random() - 0.5) * TANK.iw * 0.97;
    pos[i * 3 + 1] = BASE_Y + Math.random() * SPAN_Y;
    pos[i * 3 + 2] = (Math.random() - 0.5) * TANK.id * 0.97;
    seeds[i] = Math.random();
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 1));
  geo.boundingSphere = new THREE.Sphere(
    new THREE.Vector3(0, BASE_Y + SPAN_Y / 2, 0),
    Math.hypot(TANK.iw, TANK.id, SPAN_Y) * 0.5,
  );

  const u = {
    brightness: uniform(params.brightness),
    speed: uniform(params.speed),
    lampPos: uniform(new THREE.Vector3(-0.265, 0.58, 0.02)),
    lampDir: uniform(new THREE.Vector3(0, -1, 0)),
    lampColor: uniform(new THREE.Color(0xffc78a)),
    cosOuter: uniform(Math.cos(0.52 * 1.25)),
    cosInner: uniform(Math.cos(0.52 * 0.45)),
    ambient: uniform(0.10),
  };

  const mat = new THREE.PointsNodeMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    sizeAttenuation: true,
    size: params.size,
  });

  const seed = attribute("aSeed", "float");
  const p = positionLocal;
  const t = time.mul(u.speed);

  // ── drift ─────────────────────────────────────────────────────────────────────────
  // Two out-of-phase oscillators per axis so the paths never look like a shared sine.
  // Amplitude is a centimetre or so: dust in still air barely goes anywhere, and motes
  // that visibly fly across the tank read as snow, not dust.
  const ph = seed.mul(43.7);
  const wobX = sin(t.mul(0.29).add(ph)).mul(0.011).add(sin(t.mul(0.11).add(ph.mul(2.3))).mul(0.006));
  const wobZ = cos(t.mul(0.24).add(ph.mul(1.7))).mul(0.011).add(cos(t.mul(0.09).add(ph)).mul(0.006));

  // Slow convection: everything rises off the warm substrate and wraps at the rim.
  // Rate is per-mote so the field never pulses in unison.
  const rate = seed.mul(0.55).add(0.45).mul(0.010);
  const y = fract(p.y.sub(BASE_Y).div(SPAN_Y).add(t.mul(rate))).mul(SPAN_Y).add(BASE_Y);

  const world = vec3(p.x.add(wobX), y, p.z.add(wobZ));
  mat.positionNode = world;

  // ── how lit is this mote ──────────────────────────────────────────────────────────
  const toMote = world.sub(u.lampPos);
  const dist = length(toMote);
  const cosA = dot(normalize(toMote), u.lampDir);
  const inBeam = smoothstep(u.cosOuter, u.cosInner, cosA);
  const falloff = float(1.0).div(dist.mul(dist).mul(2.2).add(1.0));

  // Motes are forward-scattering: a speck is far brighter seen against the light than
  // lit from behind. Skipping this makes the beam look like a uniformly glowing wedge.
  const lit = inBeam.mul(falloff).mul(pow(clamp(cosA, 0, 1), 1.6).mul(0.7).add(0.3));

  // Pulled well toward white. Motes take the lamp's hue, but a fully saturated one turns
  // them into orange embers — a dust speck scatters broadly and washes out toward the
  // light's own colour, it does not glow like a spark.
  const moteCol = mix(u.lampColor, vec3(1.0, 0.96, 0.92), float(0.55));
  mat.colorNode = moteCol.mul(lit.mul(1.9).add(u.ambient)).mul(u.brightness);

  // Fade at the top and bottom of the band so wrapping motes never pop in mid-air.
  const bandT = world.y.sub(BASE_Y).div(SPAN_Y);
  const edgeFade = smoothstep(0.0, 0.10, bandT).mul(oneMinus(smoothstep(0.86, 1.0, bandT)));
  mat.opacityNode = clamp(lit.mul(1.6).add(0.05), 0, 1).mul(edgeFade);

  const points = new THREE.Points(geo, mat);
  points.name = "dust";
  points.frustumCulled = false;
  points.renderOrder = 12;

  /** Keep the beam test in sync with whatever the lamp is currently doing. */
  function syncToLamp(spot) {
    u.lampPos.value.copy(spot.position);
    const dir = new THREE.Vector3()
      .subVectors(spot.target.position, spot.position)
      .normalize();
    u.lampDir.value.copy(dir);
    u.lampColor.value.copy(spot.color);
    u.cosOuter.value = Math.cos(Math.min(Math.PI / 2, spot.angle * 1.25));
    u.cosInner.value = Math.cos(spot.angle * 0.45);
  }

  return { points, material: mat, uniforms: u, syncToLamp };
}
