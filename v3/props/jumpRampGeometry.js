import * as THREE from "three";

/**
 * Concave jump ramp from modular-road obstacles ("Jump ramp" prop).
 * Flat entry at z = 0, scooped profile rising toward −Z (y = rise×(1−cos(t×π/2))).
 * Feet on y = 0 — matches jumpRampGeometry(14, 22, 8, 32) in modularRoadProps.js.
 */

function solidKickerExtrusion(w, length, rise, segments, heightAt) {
  const hw = w / 2;
  const n = Math.max(8, segments);
  const L = Math.max(4, length);
  const H = Math.max(0.5, rise);
  const pos = [];
  const quad = (a, b, c, d) => pos.push(...a, ...b, ...c, ...a, ...c, ...d);

  const topL = [];
  const topR = [];
  const botL = [];
  const botR = [];

  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const z = -L * t;
    const y = heightAt(t, H);
    topL.push([-hw, y, z]);
    topR.push([hw, y, z]);
    botL.push([-hw, 0, z]);
    botR.push([hw, 0, z]);
  }

  for (let i = 0; i < n; i++) quad(topL[i], topR[i], topR[i + 1], topL[i + 1]);
  for (let i = 0; i < n; i++) quad(botL[i], botL[i + 1], botR[i + 1], botR[i]);
  for (let i = 0; i < n; i++) quad(botL[i], topL[i], topL[i + 1], botL[i + 1]);
  for (let i = 0; i < n; i++) quad(botR[i], botR[i + 1], topR[i + 1], topR[i]);
  quad(botL[n], topL[n], topR[n], botR[n]);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

/** Same defaults as modular-road's jumpkicker obstacle prop. */
export function createJumpRampGeometry(w = 14, length = 22, rise = 8, segments = 32) {
  return solidKickerExtrusion(w, length, rise, segments, (t, H) => H * (1 - Math.cos((Math.PI / 2) * t)));
}
