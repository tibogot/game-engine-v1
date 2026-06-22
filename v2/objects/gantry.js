import * as THREE from "three";
import {
  color,
  float,
  Fn,
  mix,
  mod,
  smoothstep,
  step,
  time,
  uv,
  vec2,
} from "three/tsl";

/**
 * Procedural start/finish gantry — a span structure (two towers + a lattice
 * beam) carrying an emissive LED board. Combines the bridge-style span, the
 * LED-matrix board, and the emissive→selective-bloom glow.
 *
 * Two-point object: the FIRST and LAST spline points are the two tower feet
 * (drop them either side of the track). The board spans between them and is
 * double-sided so it reads from both approaches. Board modes:
 *   - "checker"  classic checkered-flag finish line
 *   - "chevron"  animated arrows sweeping (uses `time`)
 *   - "lights"   F1 five-light start sequence (uses `time`)
 */

export const GANTRY_DEFAULTS = {
  towerHeight: 6.0, // clearance under the beam
  towerWidth: 0.45,
  towerDepth: 0.45,

  beamHeight: 1.1,
  beamDepth: 0.6,
  chordThick: 0.12,
  strutThick: 0.07,
  strutSpacing: 1.2,

  board: true,
  boardMode: "checker", // checker | chevron | lights
  boardShape: "round", // round | square | diamond | solid (no dots)
  boardHeightFrac: 0.78, // board height as a fraction of beamHeight
  boardInsetEnds: 0.9, // shrink the board this far in from each tower
  dotPitch: 0.085, // metres per LED dot — keeps dot size constant at any span
  dotRadius: 0.36,
  emissive: 6.0,
  offLevel: 0.04,

  // checker (square size in metres so it scales with the board)
  checkerSize: 0.55,
  boardColorA: "#ffffff",
  boardColorB: "#0d0d12",
  // chevron (one arrow per this many metres)
  chevronSpacing: 0.9,
  chevronSkew: 2.0,
  chevronDuty: 0.5,
  chevronColor: "#ff8c1a",
  panSpeed: 0.45,
  // lights
  lightColor: "#ff2418",

  cornerLights: true,
  cornerColor: "#ff3522",
  cornerIntensity: 4.0,

  colorTower: "#3a3d44",
  colorBeam: "#23262c",
  roughness: 0.5,
  metalness: 0.7,
};

const WORLD_UP = new THREE.Vector3(0, 1, 0);
const _box = new THREE.BoxGeometry(1, 1, 1);

function metalMat(hex, p) {
  return new THREE.MeshStandardMaterial({
    color: hex,
    roughness: p.roughness,
    metalness: p.metalness,
  });
}

// Emissive LED-board material — pattern picked at build time, self-animating.
// Dot size is driven by a physical pitch (m/dot) so the board reads the same
// whether the span is 6 m or 50 m.
function makeBoardMaterial(p, boardW, boardH) {
  const pitch = Math.max(0.02, p.dotPitch);
  const cols = Math.max(6, Math.round(boardW / pitch));
  const rows = Math.max(2, Math.round(boardH / pitch));
  const dotR = p.dotRadius;
  const I = p.emissive;
  const off = p.offLevel;

  // chevrons / checker squares sized in metres so they scale with the board
  const chevCount = Math.max(1, Math.round(boardW / Math.max(0.2, p.chevronSpacing)));
  const nx = Math.max(2, Math.round(boardW / Math.max(0.1, p.checkerSize)));
  const ny = Math.max(1, Math.round(boardH / Math.max(0.1, p.checkerSize)));

  const mat = new THREE.MeshStandardNodeMaterial({
    color: 0x000000,
    roughness: 1,
    metalness: 0,
    side: THREE.DoubleSide,
  });

  const solid = p.boardShape === "solid";

  mat.emissiveNode = Fn(() => {
    const base = uv();
    const gx = base.x.mul(cols);
    const gy = base.y.mul(rows);
    const cxc = gx.floor().add(0.5);
    const cyc = gy.floor().add(0.5);

    // pixel style: round / square / diamond / solid (no mask)
    const lx = gx.sub(cxc).abs();
    const ly = gy.sub(cyc).abs();
    let dot;
    if (solid) {
      dot = float(1.0);
    } else {
      const dist =
        p.boardShape === "square"
          ? lx.max(ly)
          : p.boardShape === "diamond"
            ? lx.add(ly)
            : vec2(lx, ly).length(); // round
      dot = smoothstep(dotR, dotR - 0.06, dist);
    }

    // solid samples the pattern continuously (smooth); else at the cell centre
    const cu = solid ? base.x : cxc.div(cols);
    const cv = solid ? base.y : cyc.div(rows);

    // hot core -> warm rim per dot (matches the LED board look)
    const core = dot.mul(dot);

    // base colour + "lit" amount per mode
    let baseColor;
    let lit;
    if (p.boardMode === "chevron") {
      const dy = cv.sub(0.5).abs();
      const phase = cu.mul(chevCount).add(dy.mul(p.chevronSkew)).sub(time.mul(p.panSpeed));
      lit = smoothstep(p.chevronDuty, p.chevronDuty - 0.04, phase.fract());
      baseColor = color(p.chevronColor);
    } else if (p.boardMode === "lights") {
      const colIdx = cu.mul(5.0).floor();
      const band = smoothstep(0.3, 0.26, cv.sub(0.5).abs());
      const ph = mod(time, 7.0); // count up 0..5s, hold to 6s, dark to 7s
      lit = step(colIdx, ph).mul(step(6.0, ph).oneMinus()).mul(band);
      baseColor = color(p.lightColor);
    } else {
      const sq = mod(cu.mul(nx).floor().add(cv.mul(ny).floor()), 2.0);
      baseColor = mix(color(p.boardColorB), color(p.boardColorA), sq);
      lit = float(1.0);
    }

    const ledColor = baseColor.mul(mix(float(0.55), float(1.3), core));
    const brightness = dot.mul(lit.mul(I).add(off));
    return ledColor.mul(brightness);
  })();

  return mat;
}

/**
 * @param {object} opts
 * @param {THREE.Vector3[]|{x,y,z}[]} opts.points  first + last = tower feet
 * @param {object} [opts.params]
 * @param {(x:number,z:number)=>number} [opts.getWorldHeight]
 * @returns {THREE.Group|null}
 */
export function buildGantryMesh({
  points,
  params = {},
  getWorldHeight = () => 0,
}) {
  if (!Array.isArray(points) || points.length < 2) return null;
  const p = { ...GANTRY_DEFAULTS, ...params };

  const a = points[0];
  const b = points[points.length - 1];
  const gA = getWorldHeight(a.x, a.z);
  const gB = getWorldHeight(b.x, b.z);
  const footA = new THREE.Vector3(a.x, gA, a.z);
  const footB = new THREE.Vector3(b.x, gB, b.z);

  // orthonormal right-handed basis: X=along span, Y=up, Z=facing the road
  const dir = new THREE.Vector3().subVectors(footB, footA);
  dir.y = 0;
  const spanLen = Math.max(1, dir.length());
  dir.normalize();
  const facing = new THREE.Vector3().crossVectors(dir, WORLD_UP).normalize();

  const beamBottomY = Math.max(gA, gB) + p.towerHeight; // level beam
  const beamCenterY = beamBottomY + p.beamHeight * 0.5;
  const midXZ = new THREE.Vector3()
    .addVectors(footA, footB)
    .multiplyScalar(0.5);

  const group = new THREE.Group();
  group.name = "Gantry";

  const towerMat = metalMat(p.colorTower, p);
  const beamMat = metalMat(p.colorBeam, p);

  // place a unit box with a given world scale, position and our basis
  const m = new THREE.Matrix4();
  const scl = new THREE.Vector3();
  const addBox = (mat, sx, sy, sz, pos, cast = true) => {
    const mesh = new THREE.Mesh(_box, mat);
    scl.set(sx, sy, sz);
    m.makeBasis(dir, WORLD_UP, facing).scale(scl).setPosition(pos);
    mesh.applyMatrix4(m);
    mesh.castShadow = cast;
    mesh.receiveShadow = true;
    group.add(mesh);
    return mesh;
  };

  // ── towers + base plates ──
  for (const [foot, gY] of [
    [footA, gA],
    [footB, gB],
  ]) {
    const h = Math.max(0.5, beamBottomY - gY);
    const pos = new THREE.Vector3(foot.x, gY + h * 0.5, foot.z);
    addBox(towerMat, p.towerWidth, h, p.towerDepth, pos);
    const basePos = new THREE.Vector3(foot.x, gY + 0.1, foot.z);
    addBox(towerMat, p.towerWidth * 1.9, 0.2, p.towerDepth * 1.9, basePos);
  }

  // ── lattice beam: 4 chords (front/back × top/bottom) ──
  const beamLen = spanLen - p.towerWidth; // sit between the towers
  const halfH = p.beamHeight * 0.5 - p.chordThick * 0.5;
  const halfD = p.beamDepth * 0.5;
  for (const oy of [halfH, -halfH]) {
    for (const oz of [halfD, -halfD]) {
      const pos = new THREE.Vector3(midXZ.x, beamCenterY, midXZ.z)
        .addScaledVector(WORLD_UP, oy)
        .addScaledVector(facing, oz);
      addBox(beamMat, beamLen, p.chordThick, p.chordThick, pos);
    }
  }

  // ── vertical struts along the beam (instanced, front + back) ──
  const strutStations = Math.max(2, Math.floor(beamLen / Math.max(0.4, p.strutSpacing)) + 1);
  const struts = new THREE.InstancedMesh(_box, beamMat, strutStations * 2);
  struts.castShadow = true;
  let si = 0;
  for (let i = 0; i < strutStations; i++) {
    const tx = (i / (strutStations - 1) - 0.5) * beamLen; // -L/2..L/2
    for (const oz of [halfD, -halfD]) {
      const pos = new THREE.Vector3(midXZ.x, beamCenterY, midXZ.z)
        .addScaledVector(dir, tx)
        .addScaledVector(facing, oz);
      scl.set(p.strutThick, p.beamHeight - p.chordThick, p.strutThick);
      m.makeBasis(dir, WORLD_UP, facing).scale(scl).setPosition(pos);
      struts.setMatrixAt(si++, m);
    }
  }
  struts.instanceMatrix.needsUpdate = true;
  group.add(struts);

  // ── LED board on the beam (double-sided) ──
  if (p.board) {
    const boardW = Math.max(0.5, spanLen - 2 * p.boardInsetEnds);
    const boardH = Math.max(0.3, p.beamHeight * p.boardHeightFrac);
    const boardMat = makeBoardMaterial(p, boardW, boardH);
    const board = new THREE.Mesh(new THREE.PlaneGeometry(boardW, boardH), boardMat);
    const pos = new THREE.Vector3(midXZ.x, beamCenterY, midXZ.z).addScaledVector(
      facing,
      halfD + 0.03,
    );
    m.makeBasis(dir, WORLD_UP, facing).setPosition(pos);
    board.applyMatrix4(m);
    group.add(board);
  }

  // ── corner marker lights (emissive → bloom) ──
  if (p.cornerLights) {
    const lampMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(p.cornerColor).multiplyScalar(0.4),
      emissive: new THREE.Color(p.cornerColor),
      emissiveIntensity: p.cornerIntensity,
      roughness: 0.6,
    });
    for (const sx of [-1, 1]) {
      const pos = new THREE.Vector3(midXZ.x, beamCenterY + p.beamHeight * 0.5 + 0.12, midXZ.z)
        .addScaledVector(dir, sx * (spanLen * 0.5 - p.towerWidth));
      addBox(lampMat, 0.18, 0.18, p.beamDepth + 0.1, pos, false);
    }
  }

  return group;
}

/** Fixed hero span — a clear gantry over a wide track for close-up tuning. */
export const GANTRY_HERO_POINTS = [
  { x: -6, y: 0, z: -14 },
  { x: 6, y: 0, z: -14 },
];
