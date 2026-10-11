// THE POINT'S MAST (you, 2026-10-11, beside Company of Heroes 3: our thin 5 m pole "reads as an
// antenna"; CoH's point is a tall mast held by guy wires over a small base — assets-src/refs/coh3/).
//
//   POLE     tapered steel, `height` m (a supply point 9, a village 11), a knob on top
//   BASE     a concrete footing block on a plate
//   GUYS     three wires from 70 % up to staked anchors `guyR` m out, fanned 66° apart AWAY from the depot
//   FLAG     hoisted from the top: `flagTop` is where the cloth's top edge rides at full hold
//
// One merged geometry (kit-style, its own vertex colours: steel, concrete, rope, stake), one draw.
// FIRST IN THE BUILDING LAB (the point entries' right-hand side); the game's poles are
// algPointFlags.js until the look is settled.
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

const COL = { steel: 0x4c4a45, knob: 0x6b675e, concrete: 0x7f7a70, concreteDark: 0x5c5850, rope: 0x2e2b26, stake: 0x5a4632 };

/**
 * @param {object} [o]
 * @param {number} [o.height]  the pole, m
 * @param {number} [o.guyR]    m from the foot to each anchor
 * @param {number} [o.away]    radians round Y the guy wires fan toward (away from the depot)
 * @returns {{ geometry: THREE.BufferGeometry, flagTop: number }}
 */
export function buildPointMast({ height = 9, guyR = 3.6, away = Math.PI } = {}) {
  const parts = [];
  const tint = (g, hex) => {
    const c = new THREE.Color(hex), n = g.attributes.position.count, a = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
    g.setAttribute("color", new THREE.BufferAttribute(a, 3));
    return g.index ? g.toNonIndexed() : g;
  };

  // The pole, tapered, and its knob.
  parts.push(tint(new THREE.CylinderGeometry(0.075, 0.13, height, 10).translate(0, height / 2, 0), COL.steel));
  parts.push(tint(new THREE.SphereGeometry(0.16, 10, 8).translate(0, height + 0.08, 0), COL.knob));
  // A collar where the guys meet the pole.
  const gy = height * 0.7;
  parts.push(tint(new THREE.CylinderGeometry(0.13, 0.13, 0.18, 10).translate(0, gy, 0), COL.knob));

  // The footing: a concrete block, a darker plate under it (a sandbag ring first: pale, round, it
  // read as bread rolls — 2026-10-11).
  parts.push(tint(new THREE.BoxGeometry(0.75, 0.42, 0.75).translate(0, 0.21, 0), COL.concrete));
  parts.push(tint(new THREE.BoxGeometry(1.0, 0.08, 1.0).translate(0, 0.04, 0), COL.concreteDark));

  // Three guy wires to staked anchors, fanned AWAY from what stands beside the mast (`away`: the
  // direction, radians round Y, the wires point to — the depot is the other way).
  const top = new THREE.Vector3(0, gy, 0);
  for (let k = 0; k < 3; k++) {
    const a = away + (k - 1) * 1.15;
    const foot = new THREE.Vector3(Math.cos(a) * guyR, 0.05, Math.sin(a) * guyR);
    const d = new THREE.Vector3().subVectors(top, foot), len = d.length();
    const wire = new THREE.CylinderGeometry(0.03, 0.03, len, 4).translate(0, len / 2, 0);
    wire.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()));
    wire.translate(foot.x, foot.y, foot.z);
    parts.push(tint(wire, COL.rope));
    parts.push(tint(new THREE.CylinderGeometry(0.05, 0.035, 0.45, 6).rotateZ(0.35).rotateY(-a).translate(foot.x, 0.18, foot.z), COL.stake));
  }

  const geometry = mergeGeometries(parts.map((g) => {
    // (one attribute set for every part: position, normal, uv, color)
    for (const k of Object.keys(g.attributes)) if (!["position", "normal", "uv", "color"].includes(k)) g.deleteAttribute(k);
    return g;
  }));
  for (const g of parts) g.dispose();
  geometry.computeBoundingSphere();
  return { geometry, flagTop: height - 0.15 };
}

/** The mast's material: its vertex colours, a little steel sheen (shared by every mast). */
let _mat = null;
export function pointMastMaterial() {
  return (_mat ??= new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.75, metalness: 0.25 }));
}
