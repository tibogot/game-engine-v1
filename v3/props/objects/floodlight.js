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

  headTiltDeg: 28,
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

  const backing = new THREE.Mesh(new THREE.BoxGeometry(headW + 0.2, headH + 0.2, 0.22), housingMat);
  backing.position.z = -0.04;
  backing.castShadow = true;
  head.add(backing);

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

  // Single point: just place one unit, no instancing needed
  if (points.length === 1) {
    const v = points[0];
    const unit = buildFloodlightUnit(p);
    unit.position.set(v.x, getWorldHeight(v.x, v.z), v.z);
    group.add(unit);
    return group;
  }

  // ── Spline case: one InstancedMesh per structural part → 4 draw calls total ──

  const grounded = points.map((pt) =>
    new THREE.Vector3(pt.x, getWorldHeight(pt.x, pt.z), pt.z),
  );
  const curve = new THREE.CatmullRomCurve3(grounded, !!closed, "catmullrom", 0.5);
  const length = curve.getLength();
  const count = Math.max(1, Math.floor(length / Math.max(4, p.spacing)) + 1);

  // ── Shared geometry params ──
  const Hm = Math.max(3, p.mastHeight);
  const cols = Math.max(1, p.lampCols | 0);
  const rows = Math.max(1, p.lampRows | 0);
  const pitchX = p.lampW + p.lampGap;
  const pitchY = p.lampH + p.lampGap;
  const headW = cols * pitchX;
  const headH = rows * pitchY;
  const lampsPerMast = cols * rows;

  // ── Materials ──
  const mastMat = new THREE.MeshStandardMaterial({
    color: p.colorMast,
    roughness: p.roughness,
    metalness: p.metalness,
  });
  const housingMat = new THREE.MeshStandardMaterial({
    color: p.colorHousing,
    roughness: 0.6,
    metalness: 0.4,
  });
  const lampMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(p.lampColor).multiplyScalar(0.35),
    emissive: new THREE.Color(p.lampColor),
    emissiveIntensity: p.emissive,
    roughness: 0.5,
    metalness: 0,
  });

  // ── InstancedMeshes ──
  const mastMesh = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(p.mastRadiusTop, p.mastRadiusBase, Hm, 14),
    mastMat,
    count,
  );
  mastMesh.castShadow = true;
  mastMesh.receiveShadow = true;

  const baseMesh = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(p.mastRadiusBase * 2.4, p.mastRadiusBase * 3, 0.3, 18),
    mastMat,
    count,
  );
  baseMesh.castShadow = true;

  const backingMesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(headW + 0.2, headH + 0.2, 0.22),
    housingMat,
    count,
  );
  backingMesh.castShadow = true;

  // All lamps from all masts in one InstancedMesh
  const allLampsMesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(p.lampW, p.lampH, 0.12),
    lampMat,
    count * lampsPerMast,
  );

  group.add(mastMesh, baseMesh, backingMesh, allLampsMesh);

  // ── Pre-compute part-local matrices (same for every mast) ──
  const _unitScale = new THREE.Vector3(1, 1, 1);
  const _axX = new THREE.Vector3(1, 0, 0);

  const mastLocalM = new THREE.Matrix4().makeTranslation(0, Hm * 0.5, 0);
  const baseLocalM = new THREE.Matrix4().makeTranslation(0, 0.15, 0);

  // head group: T(0, Hm, mastRadiusTop+0.05) * Rx(headTiltDeg)
  const headQ = new THREE.Quaternion().setFromAxisAngle(
    _axX,
    THREE.MathUtils.degToRad(p.headTiltDeg),
  );
  const headLocalM = new THREE.Matrix4().compose(
    new THREE.Vector3(0, Hm, p.mastRadiusTop + 0.05),
    headQ,
    _unitScale,
  );

  // backing offset within head: T(0, 0, -0.04)
  const backingLocalM = new THREE.Matrix4().multiplyMatrices(
    headLocalM,
    new THREE.Matrix4().makeTranslation(0, 0, -0.04),
  );

  // Per-lamp offset within head (precomputed for each cx, cy)
  const lampLocalMs = [];
  for (let cx = 0; cx < cols; cx++) {
    for (let cy = 0; cy < rows; cy++) {
      const x = (cx - (cols - 1) / 2) * pitchX;
      const y = (cy - (rows - 1) / 2) * pitchY;
      lampLocalMs.push(
        new THREE.Matrix4().multiplyMatrices(
          headLocalM,
          new THREE.Matrix4().makeTranslation(x, y, 0.1),
        ),
      );
    }
  }

  // SpotLight aim data (reused per mast)
  const tilt = THREE.MathUtils.degToRad(p.headTiltDeg);
  const lightLocalPos = new THREE.Vector3(0, Hm, p.mastRadiusTop + 0.1);
  const targetLocalPos = new THREE.Vector3(
    0,
    Hm - Math.sin(tilt) * 30,
    p.mastRadiusTop + Math.cos(tilt) * 30,
  );

  // ── Matrix scratch space ──
  const _lm = new THREE.Matrix4(); // mast world transform
  const _im = new THREE.Matrix4(); // _lm * partLocal

  // ── Fill instance matrices per mast ──
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
    const yaw = Math.atan2(-_perp.x * sign, -_perp.z * sign);
    const groundY = getWorldHeight(x, z);

    // Mast world transform
    _lm.makeRotationY(yaw);
    _lm.setPosition(x, groundY, z);

    // mast
    _im.multiplyMatrices(_lm, mastLocalM);
    mastMesh.setMatrixAt(i, _im);

    // base
    _im.multiplyMatrices(_lm, baseLocalM);
    baseMesh.setMatrixAt(i, _im);

    // backing
    _im.multiplyMatrices(_lm, backingLocalM);
    backingMesh.setMatrixAt(i, _im);

    // all lamp faces for this mast
    for (let j = 0; j < lampsPerMast; j++) {
      _im.multiplyMatrices(_lm, lampLocalMs[j]);
      allLampsMesh.setMatrixAt(i * lampsPerMast + j, _im);
    }

    // SpotLight — not instanceable, add one per mast (lights ≠ draw calls)
    if (p.castLight) {
      const light = new THREE.SpotLight(
        p.lampColor,
        p.lightIntensity,
        p.lightDistance,
        Math.PI * 0.28,
        0.4,
        1.5,
      );
      light.position.copy(lightLocalPos.clone().applyMatrix4(_lm));
      light.target.position.copy(targetLocalPos.clone().applyMatrix4(_lm));
      group.add(light, light.target);
    }
  }

  mastMesh.instanceMatrix.needsUpdate = true;
  baseMesh.instanceMatrix.needsUpdate = true;
  backingMesh.instanceMatrix.needsUpdate = true;
  allLampsMesh.instanceMatrix.needsUpdate = true;

  return group;
}

export const FLOODLIGHT_HERO_POINTS = [{ x: 0, y: 0, z: -16 }];
