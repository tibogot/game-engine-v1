import * as THREE from "three";
import { makeLedBoardMaterial } from "./shared/ledBoard.js";

/**
 * Trackside advertising billboards placed along a spline on one side, angled to
 * face the track. The surface is either an animated LED board (shared LED-board
 * material → glows via selective bloom) or a flat printed/matte panel.
 */

export const BILLBOARD_DEFAULTS = {
  spacing: 16,
  sideOffset: 7,
  side: "right",
  tiltDeg: 6, // slight backward lean

  panelWidth: 5.0,
  panelHeight: 2.6,
  panelBottom: 1.3, // panel bottom height above ground
  frameThick: 0.14,
  legRadius: 0.1,

  surface: "led", // "led" | "matte"
  boardMode: "checker", // checker | chevron | lights
  boardShape: "square", // round | square | diamond | solid
  dotPitch: 0.06,
  dotRadius: 0.42,
  emissive: 5.0,
  offLevel: 0.03,
  checkerSize: 0.5,
  chevronSpacing: 0.8,
  chevronSkew: 1.6,
  chevronDuty: 0.5,
  chevronColor: "#ff8c1a",
  panSpeed: 0.4,
  lightColor: "#ff2418",
  boardColorA: "#ffffff",
  boardColorB: "#0d0d12",
  matteColor: "#c2c6cc",

  colorFrame: "#1d2026",
  colorBack: "#2a2e36",
  roughness: 0.6,
  metalness: 0.5,
};

const _tangent = new THREE.Vector3();
const _perp = new THREE.Vector3();

function metal(hex, p) {
  return new THREE.MeshStandardMaterial({ color: hex, roughness: p.roughness, metalness: p.metalness });
}

function buildBillboardUnit(p) {
  const unit = new THREE.Group();
  unit.name = "BillboardUnit";

  const W = Math.max(0.5, p.panelWidth);
  const H = Math.max(0.3, p.panelHeight);
  const cy = p.panelBottom + H * 0.5;
  const frameMat = metal(p.colorFrame, p);
  const backMat = metal(p.colorBack, p);

  // legs
  const legMat = metal(p.colorFrame, p);
  for (const sx of [-1, 1]) {
    const lx = sx * W * 0.36;
    const leg = new THREE.Mesh(
      new THREE.CylinderGeometry(p.legRadius * 0.85, p.legRadius, p.panelBottom + H * 0.2, 12),
      legMat,
    );
    leg.position.set(lx, (p.panelBottom + H * 0.2) * 0.5, 0);
    leg.castShadow = true;
    leg.receiveShadow = true;
    unit.add(leg);
  }

  // tilted panel assembly (lean back a touch)
  const head = new THREE.Group();
  head.position.set(0, cy, 0);
  head.rotation.x = -THREE.MathUtils.degToRad(p.tiltDeg);
  unit.add(head);

  // backing board
  const back = new THREE.Mesh(new THREE.BoxGeometry(W, H, 0.1), backMat);
  back.position.z = -0.06;
  back.castShadow = true;
  back.receiveShadow = true;
  head.add(back);

  // frame border (4 bars)
  const ft = p.frameThick;
  const bars = [
    [W + ft, ft, 0, H * 0.5],
    [W + ft, ft, 0, -H * 0.5],
    [ft, H, -W * 0.5, 0],
    [ft, H, W * 0.5, 0],
  ];
  for (const [bw, bh, bx, by] of bars) {
    const bar = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, ft * 1.4), frameMat);
    bar.position.set(bx, by, 0.02);
    bar.castShadow = true;
    head.add(bar);
  }

  // surface
  let surfMat;
  if (p.surface === "matte") {
    surfMat = new THREE.MeshStandardMaterial({ color: p.matteColor, roughness: 0.85, metalness: 0 });
  } else {
    surfMat = makeLedBoardMaterial(p, W, H);
  }
  const surf = new THREE.Mesh(new THREE.PlaneGeometry(W, H), surfMat);
  surf.position.z = 0.06;
  head.add(surf);

  // back struts
  for (const sx of [-1, 1]) {
    const strut = new THREE.Mesh(new THREE.BoxGeometry(0.08, p.panelBottom + H * 0.4, 0.08), backMat);
    strut.position.set(sx * W * 0.36, cy * 0.5, -0.5);
    strut.rotation.x = 0.5;
    strut.castShadow = true;
    unit.add(strut);
  }

  return unit;
}

export function buildBillboardMesh({
  points,
  closed = false,
  params = {},
  getWorldHeight = () => 0,
}) {
  if (!Array.isArray(points) || points.length < 1) return null;
  const p = { ...BILLBOARD_DEFAULTS, ...params };
  const sign = p.side === "left" ? 1 : -1;
  const offset = p.sideOffset;

  const group = new THREE.Group();
  group.name = "Billboard";

  const grounded = points.map((pt) =>
    new THREE.Vector3(pt.x, getWorldHeight(pt.x, pt.z), pt.z),
  );

  if (points.length === 1) {
    const v = grounded[0];
    const unit = buildBillboardUnit(p);
    unit.position.set(v.x, getWorldHeight(v.x, v.z), v.z);
    group.add(unit);
    return group;
  }

  const curve = new THREE.CatmullRomCurve3(grounded, !!closed, "catmullrom", 0.5);
  const length = curve.getLength();
  const count = Math.max(1, Math.floor(length / Math.max(2, p.spacing)) + 1);

  for (let i = 0; i < count; i++) {
    const t = closed ? i / count : count === 1 ? 0 : i / (count - 1);
    const pos = curve.getPointAt(t);
    _tangent.copy(curve.getTangentAt(t));
    _tangent.y = 0;
    if (_tangent.lengthSq() < 1e-9) _tangent.set(0, 0, 1);
    _tangent.normalize();
    _perp.set(-_tangent.z, 0, _tangent.x).normalize();

    const x = pos.x + _perp.x * offset * sign;
    const z = pos.z + _perp.z * offset * sign;
    const unit = buildBillboardUnit(p);
    unit.position.set(x, getWorldHeight(x, z), z);
    // face the track (panel +Z points back toward the spline)
    unit.rotation.y = Math.atan2(-_perp.x * sign, -_perp.z * sign);
    group.add(unit);
  }

  return group;
}

export const BILLBOARD_HERO_POINTS = [
  { x: -16, y: 0, z: -14 },
  { x: 16, y: 0, z: -14 },
];
