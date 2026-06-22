import * as THREE from "three";
import {
  clamp,
  color,
  float,
  Fn,
  mix,
  mod,
  smoothstep,
  time,
  uv,
  vec2,
} from "three/tsl";

/**
 * Procedural traffic light — LED-dot lamps clipped to a circle, self-animating
 * through the red/amber/green sequence purely from the global `time` node (no
 * per-frame update hook needed). Mirrors the lab in traffic-light.html.
 *
 * Single-point object like the street lamp: built at the spline point, the head
 * sits on top of the pole — raise `poleHeight` to place it higher.
 */

export const TRAFFIC_LIGHT_DEFAULTS = {
  poleHeight: 3.2, // head bottom sits this high above the ground
  poleRadius: 0.085,

  lampSize: 0.34, // lens diameter (m)
  lampGap: 0.4, // centre-to-centre spacing between lamps

  // LED look
  density: 14, // dots across a lamp
  dotRadius: 0.36,
  emissive: 6.0,
  offLevel: 0.03, // faint ember on unlit dots

  // sequence (seconds) — set redAmberDur to 0 for US-style
  greenDur: 4.0,
  amberDur: 1.2,
  redDur: 4.0,
  redAmberDur: 1.5,
  speed: 1.0,

  redColor: "#ff2a1c",
  amberColor: "#ff9a16",
  greenColor: "#36ff5a",

  colorHousing: "#121217",
  colorBackboard: "#b9a318",
};

const EPS = 0.05; // sequence transition softness (s)

function metalMat(hex, rough = 0.5, metal = 0.45) {
  return new THREE.MeshStandardMaterial({
    color: hex,
    roughness: rough,
    metalness: metal,
  });
}

// One LED-dot lamp. `phase` selects which slot of the cycle lights it.
function makeLampMesh(p, phase) {
  const hex = phase === "red" ? p.redColor : phase === "amber" ? p.amberColor : p.greenColor;
  const g = Math.max(0, p.greenDur);
  const a = Math.max(0, p.amberDur);
  const r = Math.max(0, p.redDur);
  const ra = Math.max(0, p.redAmberDur);
  const total = Math.max(0.1, g + a + r + ra);
  const speed = Math.max(0.001, p.speed);

  const density = Math.max(4, p.density | 0);
  const dotRadius = p.dotRadius;
  const emissive = p.emissive;
  const offLevel = p.offLevel;

  // Emissive output (black base) so the lamp writes into the EMISSIVE MRT
  // buffer — that's what gets bloomed, so the sky never glows.
  const mat = new THREE.MeshStandardNodeMaterial({
    color: 0x000000,
    roughness: 1,
    metalness: 0,
  });
  mat.emissiveNode = Fn(() => {
    // physical LED grid
    const grid = uv().mul(density);
    const cellCenter = grid.floor().add(0.5);
    const local = grid.sub(cellCenter);
    const dot = smoothstep(dotRadius, dotRadius - 0.06, local.length());

    // clip to a circular lens
    const cuv = cellCenter.div(density);
    const shape = smoothstep(0.45, 0.43, cuv.sub(vec2(0.5, 0.5)).length());

    // sequence position in seconds, looping
    const pt = mod(time.mul(speed), total);
    const sUp = (edge) => smoothstep(edge - EPS, edge + EPS, pt);

    let on;
    if (phase === "green") {
      on = float(1).sub(sUp(g)); // [0, g)
    } else if (phase === "amber") {
      on = clamp(sUp(g).sub(sUp(g + a)).add(sUp(g + a + r)), 0, 1); // [g,g+a) + [g+a+r,total)
    } else {
      on = sUp(g + a); // [g+a, total) covers red + red+amber
    }

    const tint = mix(float(0.8), float(1.25), dot); // hot-centre bulb feel
    const intensity = dot
      .mul(shape)
      .mul(clamp(on.mul(emissive).add(offLevel), 0, emissive));
    return color(hex).mul(intensity).mul(tint);
  })();

  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(p.lampSize, p.lampSize), mat);
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  return mesh;
}

/** Build one traffic light at local origin (pole base at y=0). */
export function buildTrafficLightUnit(params = {}) {
  const p = { ...TRAFFIC_LIGHT_DEFAULTS, ...params };
  const poleH = Math.max(0.5, p.poleHeight);
  const lamp = Math.max(0.1, p.lampSize);
  const gap = Math.max(lamp * 1.05, p.lampGap);

  const unit = new THREE.Group();
  unit.name = "TrafficLightUnit";

  // ── pole + base ──
  const poleMat = metalMat("#1c1c22", 0.6, 0.45);
  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(p.poleRadius * 0.85, p.poleRadius, poleH, 18),
    poleMat,
  );
  pole.position.y = poleH * 0.5;
  pole.castShadow = true;
  unit.add(pole);

  const base = new THREE.Mesh(
    new THREE.CylinderGeometry(p.poleRadius * 2.6, p.poleRadius * 3.4, 0.12, 22),
    poleMat,
  );
  base.position.y = 0.06;
  base.castShadow = true;
  unit.add(base);

  // ── head ──
  const padX = lamp * 0.3;
  const padY = lamp * 0.28;
  const headW = lamp + padX * 2;
  const headH = gap * 2 + lamp + padY * 2;
  const headDepth = lamp * 0.75;
  const faceZ = headDepth * 0.5;

  const head = new THREE.Group();
  head.position.y = poleH + headH * 0.5; // head sits on the pole
  unit.add(head);

  // visibility backboard
  const backboard = new THREE.Mesh(
    new THREE.BoxGeometry(headW + lamp * 0.5, headH + lamp * 0.5, 0.04),
    metalMat(p.colorBackboard, 0.75, 0.1),
  );
  backboard.position.z = -faceZ - 0.06;
  backboard.castShadow = true;
  head.add(backboard);

  // housing
  const housing = new THREE.Mesh(
    new THREE.BoxGeometry(headW, headH, headDepth),
    metalMat(p.colorHousing, 0.5, 0.45),
  );
  housing.castShadow = true;
  housing.receiveShadow = true;
  head.add(housing);

  const bezelMat = metalMat("#0a0a0d", 0.45, 0.55);
  const visorMat = metalMat("#070709", 0.7, 0.2);
  const bezelR = lamp * 0.56;
  const hoodR = lamp * 0.62;
  const hoodDepth = lamp * 0.5;

  const slots = [
    { y: gap, mesh: makeLampMesh(p, "red") },
    { y: 0, mesh: makeLampMesh(p, "amber") },
    { y: -gap, mesh: makeLampMesh(p, "green") },
  ];

  for (const s of slots) {
    s.mesh.position.set(0, s.y, faceZ + 0.012);
    head.add(s.mesh);

    const bezel = new THREE.Mesh(
      new THREE.TorusGeometry(bezelR, lamp * 0.06, 12, 32),
      bezelMat,
    );
    bezel.position.set(0, s.y, faceZ + 0.005);
    bezel.castShadow = true;
    head.add(bezel);

    // top-half tube hood (axis forward, open underside)
    const hood = new THREE.Mesh(
      new THREE.CylinderGeometry(hoodR, hoodR, hoodDepth, 24, 1, true, Math.PI, Math.PI),
      visorMat,
    );
    hood.rotation.x = Math.PI / 2;
    hood.position.set(0, s.y, faceZ + hoodDepth * 0.5);
    hood.castShadow = true;
    head.add(hood);
  }

  return unit;
}

/**
 * @param {object} opts
 * @param {THREE.Vector3[]|{x,y,z}[]} opts.points
 * @param {object} [opts.params]
 * @param {(x:number,z:number)=>number} [opts.getWorldHeight]
 * @returns {THREE.Group|null}
 */
export function buildTrafficLightMesh({
  points,
  params = {},
  getWorldHeight = () => 0,
}) {
  if (!Array.isArray(points) || points.length < 1) return null;
  const p = { ...TRAFFIC_LIGHT_DEFAULTS, ...params };

  const group = new THREE.Group();
  group.name = "TrafficLight";

  // place a light at every spline point (single point = one light)
  for (const pt of points) {
    const v = pt.isVector3 ? pt : new THREE.Vector3(pt.x, pt.y, pt.z);
    const unit = buildTrafficLightUnit(p);
    unit.position.set(v.x, getWorldHeight(v.x, v.z), v.z);
    group.add(unit);
  }

  return group;
}

/** Single light for hero / studio view. */
export const TRAFFIC_LIGHT_HERO_POINTS = [{ x: 0, y: 0, z: -14 }];
