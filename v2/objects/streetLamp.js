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

  baseRadius: 0.26,
  baseHeight: 0.34,

  poleHeight: 4.4,
  poleRadiusTop: 0.05,
  poleRadiusBase: 0.09,
  poleSegments: 18,

  collarScale: 1.7,

  armLength: 1.2,
  armMountHeight: 3.95,
  armThickness: 0.055,
  armCurve: 0.55, // gooseneck rise/arc

  lanternRadius: 0.26,
  lanternHeight: 0.55,
  shadeTaper: 0.5, // top radius / bottom radius of the shade
  finialSize: 0.09,
  bulbSize: 0.17,

  emissiveColor: "#ffe6b0",
  glow: 7.0, // emissive intensity — high enough to bloom

  colorMetal: "#3a4350",
  colorPole: "#2c333d",
  roughness: 0.55,
  metalness: 0.6,

  castLight: true,
  lightIntensity: 1.6,
  lightDistance: 24,
  lightDecay: 1.8,

  groundPool: true, // faked light pool on the ground under the lantern
  poolRadius: 2.2,
  poolStrength: 0.55,

  leanAmount: 2.0,
  leanRatio: 0.15,
  seed: 7,
};

const _tangent = new THREE.Vector3();
const _perp = new THREE.Vector3();

function sideSign(side) {
  return side === "left" ? 1 : -1;
}

// smooth (not flat) metal — rounded look
function metalMat(p, colorHex) {
  return new THREE.MeshStandardMaterial({
    color: colorHex,
    roughness: p.roughness,
    metalness: p.metalness,
  });
}

function emissiveMat(p) {
  return new THREE.MeshStandardMaterial({
    color: new THREE.Color(p.emissiveColor).multiplyScalar(0.5),
    emissive: new THREE.Color(p.emissiveColor),
    emissiveIntensity: Math.max(0, p.glow),
    roughness: 0.4,
    metalness: 0,
  });
}

// cached radial-gradient texture for the faked ground light pool
let _poolTex = null;
function getPoolTexture() {
  if (_poolTex) return _poolTex;
  const s = 128;
  const c = document.createElement("canvas");
  c.width = c.height = s;
  const ctx = c.getContext("2d");
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, "#ffffff");
  g.addColorStop(0.45, "#9a9a9a");
  g.addColorStop(1, "#000000");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  _poolTex = new THREE.CanvasTexture(c);
  _poolTex.colorSpace = THREE.SRGBColorSpace;
  return _poolTex;
}

/**
 * Build one lamp at local origin (base at y=0). Caller sets world transform.
 * Rounded post + gooseneck arm + flared lantern with a glowing bulb.
 * @returns {THREE.Group}
 */
export function buildStreetLampUnit(params = {}, index = 0) {
  const p = { ...STREET_LAMP_DEFAULTS, ...params };
  const seed = (p.seed | 0) + index * 17;

  const poleH = Math.max(1.5, p.poleHeight);
  const armLen = Math.max(0.2, p.armLength);
  const baseH = Math.max(0.1, p.baseHeight);
  const armY = THREE.MathUtils.clamp(p.armMountHeight, baseH, poleH - 0.1);
  const armThick = Math.max(0.03, p.armThickness);

  const rLean = seededRand(seed, 1);
  const leanDeg =
    p.leanAmount > 0 && rLean < p.leanRatio
      ? (seededRand(seed, 2) * 2 - 1) * p.leanAmount
      : 0;

  const unit = new THREE.Group();
  unit.name = "StreetLampUnit";

  const poleMat = metalMat(p, p.colorPole);
  const trimMat = metalMat(p, p.colorMetal);

  // ── base: tapered cylinder + foot ring ──
  const baseR = Math.max(0.12, p.baseRadius);
  const base = new THREE.Mesh(
    new THREE.CylinderGeometry(baseR * 0.62, baseR, baseH, 20),
    trimMat,
  );
  base.position.y = baseH * 0.5;
  base.castShadow = true;
  base.receiveShadow = true;
  unit.add(base);
  const foot = new THREE.Mesh(
    new THREE.TorusGeometry(baseR * 0.85, baseR * 0.16, 8, 22),
    trimMat,
  );
  foot.rotation.x = Math.PI / 2;
  foot.position.y = baseR * 0.16;
  foot.castShadow = true;
  unit.add(foot);

  // ── pole (smooth) ──
  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(
      Math.max(0.03, p.poleRadiusTop),
      Math.max(0.04, p.poleRadiusBase),
      poleH,
      Math.max(8, p.poleSegments | 0),
    ),
    poleMat,
  );
  pole.position.y = baseH + poleH * 0.5;
  if (leanDeg !== 0) pole.rotation.z = THREE.MathUtils.degToRad(leanDeg * 0.35);
  pole.castShadow = true;
  pole.receiveShadow = true;
  unit.add(pole);

  // ── collar ring near the arm mount ──
  const collar = new THREE.Mesh(
    new THREE.TorusGeometry(
      Math.max(0.04, p.poleRadiusTop * p.collarScale),
      Math.max(0.02, p.poleRadiusTop * 0.6),
      8,
      20,
    ),
    trimMat,
  );
  collar.rotation.x = Math.PI / 2;
  collar.position.y = baseH + armY - 0.05;
  collar.castShadow = true;
  unit.add(collar);

  // ── curved gooseneck arm (tube along a bezier), runs local +X ──
  const ay = baseH + armY;
  const start = new THREE.Vector3(0, ay, 0);
  const ctrl = new THREE.Vector3(armLen * 0.4, ay + armLen * 0.5 * p.armCurve, 0);
  const end = new THREE.Vector3(armLen, ay + armLen * 0.22 * p.armCurve, 0);
  const armPath = new THREE.QuadraticBezierCurve3(start, ctrl, end);
  const arm = new THREE.Mesh(
    new THREE.TubeGeometry(armPath, 24, armThick, 10, false),
    trimMat,
  );
  arm.castShadow = true;
  arm.receiveShadow = true;
  unit.add(arm);

  // ── lantern hanging from the arm end ──
  const headGroup = new THREE.Group();
  headGroup.position.copy(end);
  unit.add(headGroup);

  const lr = Math.max(0.1, p.lanternRadius);
  const lh = Math.max(0.15, p.lanternHeight);
  const taper = THREE.MathUtils.clamp(p.shadeTaper, 0.15, 1);

  const knuckle = new THREE.Mesh(
    new THREE.SphereGeometry(armThick * 1.7, 12, 10),
    trimMat,
  );
  headGroup.add(knuckle);

  // flared shade (open-bottom cone frustum)
  const shade = new THREE.Mesh(
    new THREE.CylinderGeometry(lr * taper, lr, lh, 20, 1, true),
    trimMat,
  );
  shade.position.y = -lh * 0.5 - armThick;
  shade.castShadow = true;
  headGroup.add(shade);

  // finial on top
  const fin = Math.max(0.02, p.finialSize);
  const finial = new THREE.Mesh(new THREE.SphereGeometry(fin, 12, 10), poleMat);
  finial.position.y = fin * 0.6;
  headGroup.add(finial);

  // glowing bulb — hang it at the shade opening so it's clearly visible/blooms
  const bs = Math.max(0.05, p.bulbSize);
  const by = -lh - armThick + bs * 0.3;
  const bulb = new THREE.Mesh(new THREE.SphereGeometry(bs, 18, 14), emissiveMat(p));
  bulb.position.y = by;
  headGroup.add(bulb);

  if (p.castLight) {
    const light = new THREE.PointLight(
      p.emissiveColor,
      p.lightIntensity,
      p.lightDistance,
      p.lightDecay,
    );
    light.position.y = by;
    headGroup.add(light);
  }

  // faked light pool on the ground under the lantern (additive radial disc)
  if (p.groundPool) {
    const poolMat = new THREE.MeshBasicMaterial({
      map: getPoolTexture(),
      color: new THREE.Color(p.emissiveColor),
      transparent: true,
      opacity: THREE.MathUtils.clamp(p.poolStrength, 0, 1),
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const pool = new THREE.Mesh(
      new THREE.CircleGeometry(Math.max(0.3, p.poolRadius), 40),
      poolMat,
    );
    pool.rotation.x = -Math.PI / 2;
    pool.position.set(end.x, 0.03, end.z);
    pool.renderOrder = 2;
    unit.add(pool);
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
