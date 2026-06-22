import * as THREE from "three";
import { seededRand } from "./woodUtils.js";

/**
 * Stylized cartoon street lamp — discrete instances along a spline.
 * Param names chosen for later v2 full-road / spline porting.
 */

export const STREET_LAMP_DEFAULTS = {
  spacing: 14,
  sideOffset: 2.8,
  side: "right",

  baseWidth: 0.42,
  baseHeight: 0.14,
  baseDepth: 0.42,

  poleHeight: 4.4,
  poleRadiusTop: 0.065,
  poleRadiusBase: 0.12,
  poleSegments: 6,

  collarHeight: 0.1,
  collarScale: 1.4,

  armLength: 1.15,
  armThickness: 0.085,
  armMountHeight: 3.75,
  armPitch: -6,

  headWidth: 0.58,
  headHeight: 0.38,
  headDepth: 0.42,
  headDrop: 0.06,
  capHeight: 0.14,

  bulbSize: 0.24,
  emissiveColor: "#ffecc0",
  emissiveIntensity: 2.8,

  colorMetal: "#4a5568",
  colorPole: "#343d4a",
  roughness: 0.78,
  metalness: 0.42,
  flatShading: true,

  castLight: true,
  lightIntensity: 1.4,
  lightDistance: 22,
  lightDecay: 1.8,

  leanAmount: 2.5,
  leanRatio: 0.18,
  seed: 7,
};

const _tangent = new THREE.Vector3();
const _perp = new THREE.Vector3();

function sideSign(side) {
  return side === "left" ? 1 : -1;
}

function metalMat(p, colorHex) {
  return new THREE.MeshStandardMaterial({
    color: colorHex,
    roughness: p.roughness,
    metalness: p.metalness,
    flatShading: !!p.flatShading,
  });
}

function emissiveMat(p) {
  return new THREE.MeshStandardMaterial({
    color: p.emissiveColor,
    emissive: new THREE.Color(p.emissiveColor),
    emissiveIntensity: p.emissiveIntensity,
    roughness: 0.35,
    metalness: 0,
    flatShading: !!p.flatShading,
  });
}

/**
 * Build one lamp at local origin (base at y=0). Caller sets world transform.
 * @returns {THREE.Group}
 */
export function buildStreetLampUnit(params = {}, index = 0) {
  const p = { ...STREET_LAMP_DEFAULTS, ...params };
  const seed = (p.seed | 0) + index * 17;

  const poleH = Math.max(1.5, p.poleHeight);
  const armLen = Math.max(0.2, p.armLength);
  const armY = THREE.MathUtils.clamp(p.armMountHeight, p.baseHeight, poleH - 0.2);
  const armThick = Math.max(0.04, p.armThickness);
  const headW = Math.max(0.2, p.headWidth);
  const headH = Math.max(0.12, p.headHeight);
  const headD = Math.max(0.15, p.headDepth);

  const rLean = seededRand(seed, 1);
  const leanDeg =
    p.leanAmount > 0 && rLean < p.leanRatio
      ? (seededRand(seed, 2) * 2 - 1) * p.leanAmount
      : 0;

  const unit = new THREE.Group();
  unit.name = "StreetLampUnit";

  const poleMat = metalMat(p, p.colorPole);
  const trimMat = metalMat(p, p.colorMetal);

  const baseW = Math.max(0.2, p.baseWidth);
  const baseH = Math.max(0.05, p.baseHeight);
  const baseD = Math.max(0.2, p.baseDepth);
  const base = new THREE.Mesh(
    new THREE.BoxGeometry(baseW, baseH, baseD),
    trimMat,
  );
  base.position.y = baseH * 0.5;
  base.castShadow = true;
  base.receiveShadow = true;
  unit.add(base);

  const poleGeo = new THREE.CylinderGeometry(
    Math.max(0.03, p.poleRadiusTop),
    Math.max(0.04, p.poleRadiusBase),
    poleH,
    Math.max(3, p.poleSegments | 0),
  );
  const pole = new THREE.Mesh(poleGeo, poleMat);
  pole.position.y = baseH + poleH * 0.5;
  if (leanDeg !== 0) {
    pole.rotation.z = THREE.MathUtils.degToRad(leanDeg * 0.35);
  }
  pole.castShadow = true;
  pole.receiveShadow = true;
  unit.add(pole);

  const collarH = Math.max(0, p.collarHeight);
  if (collarH > 0.01) {
    const collarScale = Math.max(1, p.collarScale);
    const collar = new THREE.Mesh(
      new THREE.CylinderGeometry(
        p.poleRadiusTop * collarScale,
        p.poleRadiusTop * collarScale * 1.05,
        collarH,
        Math.max(3, p.poleSegments | 0),
      ),
      trimMat,
    );
    collar.position.y = baseH + armY - collarH * 0.5;
    collar.castShadow = true;
    collar.receiveShadow = true;
    unit.add(collar);
  }

  const armGroup = new THREE.Group();
  armGroup.position.set(0, baseH + armY, 0);
  // Arm runs local +X. Pitch around Z dips the head toward the ground — no roll.
  armGroup.rotation.z = THREE.MathUtils.degToRad(p.armPitch);

  const stub = new THREE.Mesh(
    new THREE.BoxGeometry(armThick, armThick * 1.2, armThick),
    trimMat,
  );
  stub.castShadow = true;
  stub.receiveShadow = true;
  armGroup.add(stub);

  const arm = new THREE.Mesh(
    new THREE.BoxGeometry(armLen, armThick * 0.85, armThick * 0.9),
    trimMat,
  );
  arm.position.set(armLen * 0.5, 0, 0);
  arm.castShadow = true;
  arm.receiveShadow = true;
  armGroup.add(arm);

  const headGroup = new THREE.Group();
  headGroup.position.set(armLen, -p.headDrop, 0);

  const housing = new THREE.Mesh(
    new THREE.BoxGeometry(headW, headH, headD),
    trimMat,
  );
  housing.castShadow = true;
  housing.receiveShadow = true;
  headGroup.add(housing);

  const capH = Math.max(0, p.capHeight);
  if (capH > 0.01) {
    const cap = new THREE.Mesh(
      new THREE.BoxGeometry(headW * 1.04, capH, headD * 1.04),
      poleMat,
    );
    cap.position.y = headH * 0.5 + capH * 0.5;
    cap.castShadow = true;
    cap.receiveShadow = true;
    headGroup.add(cap);
  }

  const bulbSize = Math.max(0.08, p.bulbSize);
  const bulb = new THREE.Mesh(
    new THREE.BoxGeometry(headW * 0.72, bulbSize, headD * 0.72),
    emissiveMat(p),
  );
  bulb.position.y = -headH * 0.5 + bulbSize * 0.55;
  headGroup.add(bulb);

  armGroup.add(headGroup);
  unit.add(armGroup);

  if (p.castLight) {
    const light = new THREE.PointLight(
      p.emissiveColor,
      p.lightIntensity,
      p.lightDistance,
      p.lightDecay,
    );
    light.position.set(0, -headH * 0.12, 0);
    headGroup.add(light);
  }

  return unit;
}

/**
 * @param {object} opts
 * @param {THREE.Vector3[]|{x:number,y:number,z:number}[]} opts.points
 * @param {boolean} [opts.closed]
 * @param {object} [opts.params]
 * @param {(x:number,z:number)=>number} [opts.getWorldHeight]
 * @returns {THREE.Group|null}
 */
export function buildStreetLampMesh({
  points,
  closed = false,
  params = {},
  getWorldHeight = () => 0,
}) {
  if (!Array.isArray(points) || points.length < 1) return null;

  const p = { ...STREET_LAMP_DEFAULTS, ...params };
  const spacing = Math.max(1, p.spacing);
  const offset = p.sideOffset;
  const sign = sideSign(p.side);

  const group = new THREE.Group();
  group.name = "StreetLamp";

  if (points.length === 1) {
    const pt = points[0];
    const v = pt.isVector3 ? pt : new THREE.Vector3(pt.x, pt.y, pt.z);
    const groundY = getWorldHeight(v.x, v.z);
    const unit = buildStreetLampUnit(p, 0);
    unit.position.set(v.x, groundY, v.z);
    unit.rotation.y = Math.PI * 0.5;
    group.add(unit);
    return group;
  }

  const groundedPoints = points.map((pt) => {
    const v = pt.isVector3 ? pt : new THREE.Vector3(pt.x, pt.y, pt.z);
    return new THREE.Vector3(v.x, getWorldHeight(v.x, v.z), v.z);
  });

  const curve = new THREE.CatmullRomCurve3(
    groundedPoints,
    !!closed,
    "catmullrom",
    0.5,
  );

  const length = curve.getLength();
  const lampCount = Math.max(1, Math.floor(length / spacing) + 1);

  for (let i = 0; i < lampCount; i++) {
    const t = closed
      ? i / lampCount
      : lampCount === 1
        ? 0
        : i / Math.max(1, lampCount - 1);

    const pos = curve.getPointAt(t);
    _tangent.copy(curve.getTangentAt(t));
    if (_tangent.lengthSq() < 1e-10) _tangent.set(0, 0, 1);
    _tangent.normalize();

    _perp.set(-_tangent.z, 0, _tangent.x).normalize();

    const groundY = getWorldHeight(pos.x, pos.z);

    const unit = buildStreetLampUnit(p, i);
    unit.position.set(
      pos.x + _perp.x * offset * sign,
      groundY,
      pos.z + _perp.z * offset * sign,
    );
    // Arm extends toward the spline (over the road), not along it.
    unit.rotation.y = Math.atan2(-_perp.x * sign, -_perp.z * sign);
    group.add(unit);
  }

  return group;
}

/** Single lamp for hero / studio view. */
export const STREET_LAMP_HERO_POINTS = [{ x: 0, y: 0, z: -14 }];
