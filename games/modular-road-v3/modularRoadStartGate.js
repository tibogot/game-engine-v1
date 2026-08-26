import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

/** Start gantry neon — green, distinct from checkpoint cyan. */
const START_GATE_GLOW = 0x3dff8a;
/** Finish gantry neon — pink, so Finish (rounded) reads apart from Start (rounded). */
const FINISH_GATE_GLOW = 0xff4ec8;

/** Thin strip Shape along a 2-D polyline (XY), half-width `halfW`. */
function neonStrokeShape(pts, halfW) {
  const left = [];
  const right = [];
  for (let i = 0; i < pts.length; i++) {
    const prev = pts[Math.max(0, i - 1)];
    const next = pts[Math.min(pts.length - 1, i + 1)];
    const dx = next.x - prev.x;
    const dy = next.y - prev.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = (-dy / len) * halfW;
    const ny = (dx / len) * halfW;
    left.push({ x: pts[i].x + nx, y: pts[i].y + ny });
    right.push({ x: pts[i].x - nx, y: pts[i].y - ny });
  }
  const shape = new THREE.Shape();
  shape.moveTo(left[0].x, left[0].y);
  for (let i = 1; i < left.length; i++) shape.lineTo(left[i].x, left[i].y);
  for (let i = right.length - 1; i >= 0; i--) shape.lineTo(right[i].x, right[i].y);
  shape.closePath();
  return shape;
}

/** Map gate-local XY(Z depth) into piece-local space at the start-line frame. */
function applyGateFrame(geo, fr, deckLift = 0.04) {
  const m = new THREE.Matrix4();
  const zAxis = fr.tangent.clone().normalize().negate();
  const yAxis = fr.up.clone().normalize();
  const xAxis = new THREE.Vector3().crossVectors(yAxis, zAxis).normalize();
  yAxis.crossVectors(zAxis, xAxis).normalize();
  m.makeBasis(xAxis, yAxis, zAxis);
  m.setPosition(fr.pos.clone().addScaledVector(fr.up, deckLift));
  geo.applyMatrix4(m);
}

/**
 * Extruded start gantry — same silhouette as the Neon gate prop, returned as
 * separate body + glow buffers for matte vs bloom materials.
 *
 * @param {{pos:THREE.Vector3,tangent:THREE.Vector3,up:THREE.Vector3,right:THREE.Vector3}} fr
 * @param {number} roadWidth kerb-to-kerb (m)
 * @returns {{body:THREE.BufferGeometry,glow:THREE.BufferGeometry}}
 */
export function buildStartNewGateGeometries(fr, roadWidth) {
  const W = roadWidth;
  const T = 0.72;
  const D = 0.38;
  const C = 1.85;
  const clearH = 7.2;
  const H = clearH + T;
  const hw = W / 2;
  const iw = hw - T;
  const ih = clearH;
  const SINK = 0.06;
  const gapW = 1.4;
  const neonHalf = 0.07;

  const outline = new THREE.Shape();
  outline.moveTo(-hw, -SINK);
  outline.lineTo(-hw, H - C);
  outline.lineTo(-hw + C, H);
  outline.lineTo(hw - C, H);
  outline.lineTo(hw, H - C);
  outline.lineTo(hw, -SINK);
  outline.closePath();

  const hole = new THREE.Path();
  hole.moveTo(-iw, -SINK);
  hole.lineTo(-iw, ih - C);
  hole.lineTo(-iw + C, ih);
  hole.lineTo(iw - C, ih);
  hole.lineTo(iw, ih - C);
  hole.lineTo(iw, -SINK);
  hole.closePath();
  outline.holes.push(hole);

  const body = new THREE.ExtrudeGeometry(outline, {
    depth: D,
    bevelEnabled: false,
    curveSegments: 1,
  });
  body.translate(0, 0, -D / 2);

  const cxL = -hw + T / 2;
  const cxR = hw - T / 2;
  const cyTop = ih + T / 2;
  const cChamferY = cyTop - C;
  const neonDepth = D + 0.12;

  const glowParts = [];
  for (const pts of [
    [
      { x: cxL, y: -SINK },
      { x: cxL, y: cChamferY },
      { x: cxL + C, y: cyTop },
      { x: -gapW / 2, y: cyTop },
    ],
    [
      { x: gapW / 2, y: cyTop },
      { x: cxR - C, y: cyTop },
      { x: cxR, y: cChamferY },
      { x: cxR, y: -SINK },
    ],
  ]) {
    const stroke = new THREE.ExtrudeGeometry(neonStrokeShape(pts, neonHalf), {
      depth: neonDepth,
      bevelEnabled: false,
      curveSegments: 1,
    });
    stroke.translate(0, 0, -neonDepth / 2);
    glowParts.push(stroke);
  }

  // START panel + three timing pods (all bloom).
  const panel = new THREE.Shape();
  const ph = hw * 0.38;
  const py0 = cyTop + 0.35;
  const py1 = py0 + 1.05;
  panel.moveTo(-ph, py0);
  panel.lineTo(ph, py0);
  panel.lineTo(ph, py1);
  panel.lineTo(-ph, py1);
  panel.closePath();
  const panelGeo = new THREE.ExtrudeGeometry(panel, {
    depth: 0.12,
    bevelEnabled: false,
    curveSegments: 1,
  });
  panelGeo.translate(0, 0, -D / 2 - 0.08);
  glowParts.push(panelGeo);

  for (const x of [-hw * 0.22, 0, hw * 0.22]) {
    const pod = new THREE.Shape();
    pod.moveTo(x - 0.28, H + 0.12);
    pod.lineTo(x + 0.28, H + 0.12);
    pod.lineTo(x + 0.28, H + 0.52);
    pod.lineTo(x - 0.28, H + 0.52);
    pod.closePath();
    const podGeo = new THREE.ExtrudeGeometry(pod, {
      depth: 0.14,
      bevelEnabled: false,
      curveSegments: 1,
    });
    podGeo.translate(0, 0, -D / 2 - 0.04);
    glowParts.push(podGeo);
  }

  applyGateFrame(body, fr);
  for (const g of glowParts) applyGateFrame(g, fr);
  const glow = mergeGeometries(glowParts, false);
  for (const g of glowParts) g.dispose();

  body.computeVertexNormals();
  glow?.computeVertexNormals();
  return { body, glow: glow ?? body.clone() };
}

/**
 * Semicircle neon arch for checkpoint_new — yellow bloom, no posts or deck line.
 * Centreline is a half-ring of radius ~ road half-width, so the feet sit on the
 * kerbs and the apex clears the car by several metres.
 *
 * @param {{pos:THREE.Vector3,tangent:THREE.Vector3,up:THREE.Vector3,right:THREE.Vector3}} fr
 * @param {number} roadWidth kerb-to-kerb (m)
 * @returns {THREE.BufferGeometry}
 */
export function buildCheckpointArchGeometry(fr, roadWidth) {
  const hw = roadWidth / 2;
  const R = hw + 0.15;
  const tube = 0.14;
  const SINK = 0.08;
  const geo = new THREE.TorusGeometry(R, tube, 10, 36, Math.PI);
  geo.translate(0, -SINK, 0);
  applyGateFrame(geo, fr);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

export { START_GATE_GLOW, FINISH_GATE_GLOW };
