import * as THREE from "three";

/**
 * Stadium-style floodlight masts placed along a spline on one side. Each mast
 * is a tall tapered pole with a tilted head carrying a grid of emissive lamp
 * fixtures aimed at the track — the emissive faces glow via selective bloom.
 * Optional real SpotLights (off by default; one per mast is costly).
 */

export const FLOODLIGHT_DEFAULTS = {
  spacing: 45,
  sideOffset: 12,
  side: "right",

  mastHeight: 14,
  mastRadiusBase: 0.34,
  mastRadiusTop: 0.18,

  headTiltDeg: 28, // aim the lamps down toward the track
  lampCols: 4,
  lampRows: 3,
  lampW: 0.72,
  lampH: 0.52,
  lampGap: 0.12,

  emissive: 8.0,
  lampColor: "#eaf2ff",

  castLight: false,
  lightIntensity: 3.0,
  lightDistance: 90,

  colorMast: "#3a3d44",
  colorHousing: "#141619",
  roughness: 0.5,
  metalness: 0.7,
};

const _tangent = new THREE.Vector3();
const _perp = new THREE.Vector3();

function buildFloodlightUnit(p) {
  const unit = new THREE.Group();
  unit.name = "FloodlightUnit";

  const mastMat = new THREE.MeshStandardMaterial({ color: p.colorMast, roughness: p.roughness, metalness: p.metalness });
  const housingMat = new THREE.MeshStandardMaterial({ color: p.colorHousing, roughness: 0.6, metalness: 0.4 });
  const lampMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(p.lampColor).multiplyScalar(0.35),
    emissive: new THREE.Color(p.lampColor),
    emissiveIntensity: p.emissive,
    roughness: 0.5,
    metalness: 0,
  });

  const Hm = Math.max(3, p.mastHeight);
  const mast = new THREE.Mesh(
    new THREE.CylinderGeometry(p.mastRadiusTop, p.mastRadiusBase, Hm, 14),
    mastMat,
  );
  mast.position.y = Hm * 0.5;
  mast.castShadow = true;
  mast.receiveShadow = true;
  unit.add(mast);

  const base = new THREE.Mesh(
    new THREE.CylinderGeometry(p.mastRadiusBase * 2.4, p.mastRadiusBase * 3, 0.3, 18),
    mastMat,
  );
  base.position.y = 0.15;
  base.castShadow = true;
  unit.add(base);

  // head: grid of lamp fixtures, tilted down toward +Z (the track)
  const cols = Math.max(1, p.lampCols | 0);
  const rows = Math.max(1, p.lampRows | 0);
  const pitchX = p.lampW + p.lampGap;
  const pitchY = p.lampH + p.lampGap;
  const headW = cols * pitchX;
  const headH = rows * pitchY;

  const head = new THREE.Group();
  head.position.set(0, Hm, p.mastRadiusTop + 0.05);
  head.rotation.x = THREE.MathUtils.degToRad(p.headTiltDeg);
  unit.add(head);

  // backing
  const backing = new THREE.Mesh(new THREE.BoxGeometry(headW + 0.2, headH + 0.2, 0.22), housingMat);
  backing.position.z = -0.04;
  backing.castShadow = true;
  head.add(backing);

  // emissive lamp faces (instanced)
  const lampGeo = new THREE.BoxGeometry(p.lampW, p.lampH, 0.12);
  const lamps = new THREE.InstancedMesh(lampGeo, lampMat, cols * rows);
  const m = new THREE.Matrix4();
  let i = 0;
  for (let cx = 0; cx < cols; cx++) {
    for (let cyi = 0; cyi < rows; cyi++) {
      const x = (cx - (cols - 1) / 2) * pitchX;
      const y = (cyi - (rows - 1) / 2) * pitchY;
      m.makeTranslation(x, y, 0.1);
      lamps.setMatrixAt(i++, m);
    }
  }
  lamps.instanceMatrix.needsUpdate = true;
  head.add(lamps);

  if (p.castLight) {
    const light = new THREE.SpotLight(p.lampColor, p.lightIntensity, p.lightDistance, Math.PI * 0.28, 0.4, 1.5);
    light.position.set(0, Hm, p.mastRadiusTop + 0.1);
    const tilt = THREE.MathUtils.degToRad(p.headTiltDeg);
    light.target.position.set(0, Hm - Math.sin(tilt) * 30, p.mastRadiusTop + Math.cos(tilt) * 30);
    unit.add(light);
    unit.add(light.target);
  }

  return unit;
}

export function buildFloodlightMesh({
  points,
  closed = false,
  params = {},
  getWorldHeight = () => 0,
}) {
  if (!Array.isArray(points) || points.length < 1) return null;
  const p = { ...FLOODLIGHT_DEFAULTS, ...params };
  const sign = p.side === "left" ? 1 : -1;
  const offset = p.sideOffset;

  const group = new THREE.Group();
  group.name = "Floodlight";

  if (points.length === 1) {
    const v = points[0];
    const unit = buildFloodlightUnit(p);
    unit.position.set(v.x, getWorldHeight(v.x, v.z), v.z);
    group.add(unit);
    return group;
  }

  const grounded = points.map((pt) =>
    new THREE.Vector3(pt.x, getWorldHeight(pt.x, pt.z), pt.z),
  );
  const curve = new THREE.CatmullRomCurve3(grounded, !!closed, "catmullrom", 0.5);
  const length = curve.getLength();
  const count = Math.max(1, Math.floor(length / Math.max(4, p.spacing)) + 1);

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
    const unit = buildFloodlightUnit(p);
    unit.position.set(x, getWorldHeight(x, z), z);
    // aim the head toward the track
    unit.rotation.y = Math.atan2(-_perp.x * sign, -_perp.z * sign);
    group.add(unit);
  }

  return group;
}

export const FLOODLIGHT_HERO_POINTS = [{ x: 0, y: 0, z: -16 }];
