import * as THREE from "three";
import { makeLedMatrixMaterial, makeTextTexture } from "./shared/ledMatrix.js";

/**
 * Free-standing LED matrix board — a panel on legs showing a procedural chevron,
 * an image, or a scrolling text marquee. One point drops a single board; a
 * spline spaces a run of them along one side, facing the path.
 *
 * Perf shape: every unit is identical, so the whole run is three InstancedMeshes
 * (frame, legs, panel) and one shared LED material — three draw calls whether
 * you place one board or forty. All LED params are uniforms on that material,
 * so nothing here recompiles a shader.
 */

export const LED_MATRIX_DEFAULTS = {
  // spline placement
  spacing: 24,
  sideOffset: 7,
  side: "right",

  // content
  source: "chevron", // chevron | image | text
  text: "RACE  •  CHAMPIONS  •  ",
  rgb: false, // show the source's own colour per LED (video-wall)
  threshold: 0.5, // image/text: luminance cutoff for "lit"
  fitSource: false, // match board height to the image's aspect
  panSpeed: 0.4,

  // chevron
  chevronCount: 6,
  skew: 2.3,
  duty: 0.5,

  // board
  boardW: 6.4,
  boardH: 1.9,
  tiltDeg: 0,
  standHeight: 0.7,
  legs: true,

  // LED grid
  shape: "round", // round | square | diamond | solid
  cols: 78,
  rows: 22,
  dotRadius: 0.36,
  emissive: 6.0,
  offLevel: 0.04,
  coreColor: "#ffe07a",
  edgeColor: "#ff6a00",

  // structure
  framePad: 0.16,
  frameDepth: 0.22,
  legRadius: 0.08,
  colorFrame: "#120708",
  colorLeg: "#1a1a1f",
  roughness: 0.55,
  metalness: 0.3,
};

const _tangent = new THREE.Vector3();
const _perp = new THREE.Vector3();
const _unit = new THREE.Matrix4();
const _local = new THREE.Matrix4();
const _out = new THREE.Matrix4();

const LEG_Z = -0.05;
const LEG_SPREAD = 0.35; // fraction of board width
const FRAME_Z = -0.08;
const PANEL_Z = 0.04;

/** Content texture + its own aspect for the current source. */
function resolveContent(p) {
  if (p.source === "text") {
    const { texture, aspect } = makeTextTexture(p.text);
    return { texture, aspect };
  }
  if (p.source === "image" && p.image?.isTexture) {
    const img = p.image.image;
    const aspect = img?.width && img?.height ? img.width / img.height : 1;
    return { texture: p.image, aspect };
  }
  return { texture: null, aspect: 1 };
}

export function buildLedMatrixMesh({
  points,
  closed = false,
  params = {},
  getWorldHeight = () => 0,
}) {
  if (!Array.isArray(points) || points.length < 1) return null;
  const p = { ...LED_MATRIX_DEFAULTS, ...params };

  const content = resolveContent(p);
  const W = Math.max(0.5, p.boardW);
  const H =
    p.fitSource && p.source !== "chevron"
      ? THREE.MathUtils.clamp(W / content.aspect, 0.4, 12)
      : Math.max(0.3, p.boardH);

  const standTop = p.legs ? Math.max(0, p.standHeight) : 0;
  const cy = standTop + H * 0.5;

  // ── unit-local geometry (origin at the board's foot, +Z faces the viewer) ──
  const tilt = -THREE.MathUtils.degToRad(p.tiltDeg);
  const tiltAboutCenter = new THREE.Matrix4()
    .makeTranslation(0, cy, 0)
    .multiply(new THREE.Matrix4().makeRotationX(tilt))
    .multiply(new THREE.Matrix4().makeTranslation(0, -cy, 0));

  const pad = p.framePad;
  const frameGeo = new THREE.BoxGeometry(W + pad * 2, H + pad * 2, p.frameDepth);
  frameGeo.translate(0, cy, FRAME_Z);
  frameGeo.applyMatrix4(tiltAboutCenter);

  const panelGeo = new THREE.PlaneGeometry(W, H);
  panelGeo.translate(0, cy, PANEL_Z);
  panelGeo.applyMatrix4(tiltAboutCenter);

  const ledMat = makeLedMatrixMaterial({
    boardW: W,
    boardH: H,
    params: { ...p, useRamp: true, mode: p.source },
    contentTexture: content.texture,
    sourceAspect: content.aspect,
  });
  const frameMat = new THREE.MeshStandardMaterial({
    color: p.colorFrame,
    roughness: p.roughness,
    metalness: p.metalness,
  });

  // ── unit transforms along the spline ──
  const grounded = points.map(
    (pt) => new THREE.Vector3(pt.x, getWorldHeight(pt.x, pt.z), pt.z),
  );
  const placements = [];

  if (points.length === 1) {
    const v = grounded[0];
    placements.push({ x: v.x, z: v.z, yaw: 0 });
  } else {
    const curve = new THREE.CatmullRomCurve3(grounded, !!closed, "catmullrom", 0.5);
    const length = curve.getLength();
    const count = Math.max(1, Math.floor(length / Math.max(2, p.spacing)) + 1);
    const sign = p.side === "left" ? 1 : -1;

    for (let i = 0; i < count; i++) {
      const t = closed ? i / count : count === 1 ? 0 : i / (count - 1);
      const pos = curve.getPointAt(t);
      _tangent.copy(curve.getTangentAt(t));
      _tangent.y = 0;
      if (_tangent.lengthSq() < 1e-9) _tangent.set(0, 0, 1);
      _tangent.normalize();
      _perp.set(-_tangent.z, 0, _tangent.x).normalize();

      placements.push({
        x: pos.x + _perp.x * p.sideOffset * sign,
        z: pos.z + _perp.z * p.sideOffset * sign,
        // face back toward the spline
        yaw: Math.atan2(-_perp.x * sign, -_perp.z * sign),
      });
    }
  }

  const n = placements.length;
  const group = new THREE.Group();
  group.name = "LedMatrix";

  const frames = new THREE.InstancedMesh(frameGeo, frameMat, n);
  const panels = new THREE.InstancedMesh(panelGeo, ledMat, n);
  frames.castShadow = true;
  frames.receiveShadow = true;
  panels.castShadow = false; // emissive panel — a shadow from it reads as a bug
  panels.receiveShadow = false;

  for (let i = 0; i < n; i++) {
    const { x, z, yaw } = placements[i];
    _unit.makeRotationY(yaw).setPosition(x, getWorldHeight(x, z), z);
    frames.setMatrixAt(i, _unit);
    panels.setMatrixAt(i, _unit);
  }
  frames.instanceMatrix.needsUpdate = true;
  panels.instanceMatrix.needsUpdate = true;
  group.add(frames, panels);

  if (p.legs && standTop > 0) {
    const legGeo = new THREE.CylinderGeometry(
      p.legRadius * 0.85,
      p.legRadius,
      standTop,
      12,
    );
    const legMat = new THREE.MeshStandardMaterial({
      color: p.colorLeg,
      roughness: 0.6,
      metalness: 0.4,
    });
    // two legs per unit, packed into one InstancedMesh
    const legs = new THREE.InstancedMesh(legGeo, legMat, n * 2);
    legs.castShadow = true;
    legs.receiveShadow = true;
    let k = 0;
    for (let i = 0; i < n; i++) {
      const { x, z, yaw } = placements[i];
      _unit.makeRotationY(yaw).setPosition(x, getWorldHeight(x, z), z);
      for (const sx of [-1, 1]) {
        _local.makeTranslation(sx * W * LEG_SPREAD, standTop * 0.5, LEG_Z);
        _out.multiplyMatrices(_unit, _local);
        legs.setMatrixAt(k++, _out);
      }
    }
    legs.instanceMatrix.needsUpdate = true;
    group.add(legs);
  }

  // the content texture is either cached (text) or owned by the caller (image),
  // so the group disposes geometry + materials only
  group.userData.ledMatrix = { material: ledMat, boardW: W, boardH: H };
  return group;
}

export const LED_MATRIX_HERO_POINTS = [{ x: 0, y: 0, z: -12 }];
