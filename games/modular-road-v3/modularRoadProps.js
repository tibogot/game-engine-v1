import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
// Collision radius is shared so the visual offset and the body can never drift.
import {
  PHYSICS_PROP_TYPES,
  CONE_SCALE,
  TIRE_SCALE,
  TIRE_OUTER_R,
  TIRE_TUBE_R,
  TIRE_SIZE,
  GATE_WIDTH,
  GATE_HEIGHT,
  GATE_BASE_Y,
  GATE_POST_RADIUS,
  GATE_POST_HEIGHT,
} from "./modularRoadPropPhysics.js";
import { SCENERY_CATALOG, makeSceneryProp } from "./modularRoadScenery.js";
import { isSharedGeometry } from "./modularRoadBatching.js";
import { makeContainer, CONTAINER_LIVERIES, CONTAINER_SIZE } from "./modularRoadContainer.js";
import { makeTireWall } from "./modularRoadTireWall.js";
import { makeCrane } from "./modularRoadCrane.js";
import { makePalm } from "./modularRoadPalm.js";
import { DECAL_OFFSET } from "./modularRoadDecals.js";
import { roadParams } from "./modularRoadKit.js";

/** The one decal there is so far. Lives beside the game rather than in
 *  public/models because it is track dressing, not a shared engine asset. */
export const DECAL_URL = "/games/modular-road-v3/rondcarre.png";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { materialEmissive, materialColor } from "three/tsl";
import { applyBloomMRT } from "../../v3/render/bloomMRT.js";
import {
  kickerRampGeometry,
  jumpRampGeometry,
  buildSlopeLabGroup,
  buildJumpLabGroup,
  enableMeshShadows,
  attachDeckProxy,
  thickWallTubeGeometry,
  thickWallVaultGeometry,
} from "./modularRoadParkour.js";

/**
 * Free-placement props for the modular road. Unlike auto-chained track pieces,
 * props are standalone objects (box, wall, ramp, cylinders, ring gate)
 * positioned by hand with a shared TransformControls gizmo — the same pattern as
 * the v2 editor props mode (W/E/R = move/rotate/scale, right-click select).
 *
 * Each prop carries a `collision` role so the page can bake it into the right
 * BVH:
 *   - "deck"  → drive surface (wheel raycasts): ramps, the floor of a tube
 *   - "solid" → chassis wall collision only (no wheel ground): wall panels
 *   - "both"  → drive on top AND blocked at the sides: boxes
 *   - "none"  → pure decoration you pass through: ring gates
 */

const V3 = THREE.Vector3;

// Boost-pad footprint (shared by the visual + its trigger zone).
const BOOST_W = 10; // width across the deck (m)
const BOOST_D = 20; // length along travel (m)
const BOOST_H = 0.12; // slab thickness (flush decal)

// Scratch objects for the per-frame trigger-zone test (no per-frame allocation).
const _fieldInv = new THREE.Matrix4();
const _fieldLocal = new V3();
const _fieldFwd = new V3();
// Scratch for stackSnap — see PropManager.stackSnap.
const _stackLocal = new V3();
const _stackOff = new V3();
const _stackQuat = new THREE.Quaternion();

/* ----------------------------------------------------------------------- */
/* Prop geometry builders                                                   */
/* ----------------------------------------------------------------------- */

/** Right-triangular prism ramp: base on y=0, rising from +Z (low) to -Z (high). */
function rampGeometry(L = 18, H = 6, W = 14) {
  const hw = W / 2;
  const zN = L / 2; // near (low) edge
  const zF = -L / 2; // far (high) edge
  const Al = [-hw, 0, zN], Bl = [-hw, 0, zF], Cl = [-hw, H, zF];
  const Ar = [hw, 0, zN], Br = [hw, 0, zF], Cr = [hw, H, zF];
  // Sloped top on its own — it is the only drivable face, and the vertical back
  // is this shape's lip cap. See attachDeckProxy in modularRoadParkour.js.
  const deckPos = [];
  const deckQuad = (a, b, c, d) => deckPos.push(...a, ...b, ...c, ...a, ...c, ...d);
  deckQuad(Al, Ar, Cr, Cl); // sloped top (drive surface)

  const pos = deckPos.slice();
  const quad = (a, b, c, d) => pos.push(...a, ...b, ...c, ...a, ...c, ...d);
  const tri = (a, b, c) => pos.push(...a, ...b, ...c);
  quad(Al, Bl, Br, Ar); // bottom
  quad(Bl, Cl, Cr, Br); // vertical back
  tri(Al, Cl, Bl); // left cap
  tri(Ar, Br, Cr); // right cap
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return attachDeckProxy(geo, deckPos);
}

/** Thick-walled pipe, still hollow to drive through.
 *
 * Open inner + outer cylinders and flat RingGeometry end caps — see
 * thickWallTubeGeometry for why this replaced a single Lathe profile.
 * FrontSide, no DoubleSide. 40 radial steps — this mesh is the deck the wheels
 * probe, and a coarser ring reads as a prism. */
function openTubeGroup(outerR = 9, length = 30, wall = 0.65, segments = 40) {
  const innerR = outerR - wall;
  const geo = thickWallTubeGeometry(innerR, outerR, length, segments);
  const root = new THREE.Group();
  root.name = "OpenCylinder";
  root.add(new THREE.Mesh(geo, mat(0x3a7bd5, { metalness: 0.55, roughness: 0.4 })));
  root.rotation.x = Math.PI / 2;
  root.position.set(0, outerR, 0); // bottom of the pipe rests on the ground
  return root;
}

/**
 * Plastic water-filled road block — jersey silhouette, handle trough on top.
 *
 * One extruded prism, FrontSide, stripes in a 1-D texture. The trough is part
 * of the same ring (not a second mesh), so a row of these is one instanced
 * draw. ~50 triangles; the wheels never probe it (`solid`).
 *
 * Long axis is X so a drop onto a −Z straight blocks the lane; rotate 90° to
 * line a shoulder.
 */
function roadBlockGeometry(length = 2.2, height = 1.06) {
  // Jersey in XY (x = thickness, y = height), extruded along Z, then spun so
  // the long axis is X. The trough is concave; ExtrudeGeometry earcuts the
  // caps, which a fan from one corner would invert.
  const shape = new THREE.Shape();
  const ring = [
    [ 0.28, 0.00],
    [ 0.28, 0.06],
    [ 0.20, 0.28],
    [ 0.095, height - 0.08],
    [ 0.095, height],
    [ 0.038, height],
    [ 0.038, height - 0.09],
    [-0.038, height - 0.09],
    [-0.038, height],
    [-0.095, height],
    [-0.095, height - 0.08],
    [-0.20, 0.28],
    [-0.28, 0.06],
    [-0.28, 0.00],
  ];
  shape.moveTo(ring[0][0], ring[0][1]);
  for (let i = 1; i < ring.length; i++) shape.lineTo(ring[i][0], ring[i][1]);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: length, bevelEnabled: false, curveSegments: 1, steps: 1,
  });
  geo.translate(0, 0, -length / 2);
  geo.rotateY(Math.PI / 2);
  geo.computeVertexNormals();
  const pos = geo.attributes.position;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    uv[i * 2] = 0;
    uv[i * 2 + 1] = height > 0 ? pos.getY(i) / height : 0;
  }
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  geo.computeBoundingSphere();
  geo.computeBoundingBox();
  return geo;
}

/** Solid white / solid red — instance tint, same cost as one colour. */
export const ROAD_BLOCK_COLORS = [
  0xf4f4f6, // white
  0xd62424, // red
];

function makeRoadBlock() {
  // White base: instanceColor multiplies in, so tint × 1 = the chosen colour.
  const m = new THREE.Mesh(
    roadBlockGeometry(),
    mat(0xffffff, { roughness: 0.42, metalness: 0.04 }),
  );
  m.name = "RoadBlock";
  m.userData.tintable = true;
  return m;
}

/**
 * Arcade boost decal: `>>>` from true square pixels on a uniform XZ grid.
 *
 * Each lit cell is a square (equal X and Z extent) with a fixed gap — the old
 * version stepped diagonally with stacked offsets, which read as rectangles.
 * Still one merged mesh.
 */
function pixelChevronRunMesh(w, d, color, y = 0.06) {
  const cell = 0.34; // square side (m) — same on X and Z
  const gap = 0.07;
  const step = cell + gap;
  const rows = 10; // rows per chevron (tip + arm length)
  const stroke = 2; // arm thickness in grid cells
  const count = 3;
  const span = d * 0.74;
  const z0 = span * 0.5;
  const chevLen = (rows - 1) * step;
  const chevGap = count > 1 ? Math.max(step * 1.5, (span - chevLen) / (count - 1)) : 0;
  const half = cell * 0.5;

  const lit = new Set();
  for (let c = 0; c < count; c++) {
    const tipZ = z0 - (count <= 1 ? 0 : c * (chevLen + chevGap));
    for (let r = 0; r < rows; r++) {
      const cz = tipZ + r * step;
      const place = (ix) => {
        if (Math.abs(ix) * step > w * 0.46) return;
        lit.add(`${ix * step},${cz}`);
      };
      if (r === 0) place(0);
      else {
        for (let t = 0; t < stroke; t++) {
          const ix = r - t;
          place(ix);
          place(-ix);
        }
      }
    }
  }

  const pos = [];
  for (const key of lit) {
    const [cx, cz] = key.split(",").map(Number);
    pos.push(
      cx - half, y, cz - half, cx + half, y, cz - half, cx + half, y, cz + half,
      cx - half, y, cz - half, cx + half, y, cz + half, cx - half, y, cz + half,
    );
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  return new THREE.Mesh(
    geo,
    mat(color, { roughness: 0.3, emissive: color, emissiveIntensity: 5, side: THREE.DoubleSide }),
  );
}

/** Emissive triangle chevrons — used by the raised boost / launch pads only. */
function chevronRunMesh(w, d, color, y = 0.06) {
  const hw = w * 0.34;
  const aLen = Math.min(3.4, d * 0.22);
  const gap = d * 0.24;
  const pos = [];
  for (let i = 0; i < 3; i++) {
    const zBack = gap - i * gap;
    pos.push(0, y, zBack - aLen, hw, y, zBack, -hw, y, zBack); // tip, right, left
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  return new THREE.Mesh(
    geo,
    mat(color, { roughness: 0.3, emissive: color, emissiveIntensity: 5, side: THREE.DoubleSide }),
  );
}

/**
 * Flush deck pad: dark slab + bright emissive chevrons pointing along local −Z
 * (the "forward" the car is meant to enter from). The effect (boost / launch)
 * comes from the prop's `field` trigger zone (see PropManager.applyFields), not
 * the geometry — this is just the look. Used by both the boost and launch pads.
 */
function flatPadGroup(w, d, color, name = "Pad") {
  const g = new THREE.Group();
  g.name = name;
  const base = new THREE.Mesh(
    new THREE.BoxGeometry(w, BOOST_H, d),
    mat(0x0d1116, { roughness: 0.5, metalness: 0.25, emissive: 0x0a1f24, emissiveIntensity: 0.5 }),
  );
  base.position.y = BOOST_H / 2 + 0.04; // sit flush just above the deck
  g.add(base);
  g.add(chevronRunMesh(w, d, color, BOOST_H + 0.06));
  return g;
}

/**
 * TRUE flat decal: pixel-square chevrons only, hugging the deck like paint. No
 * raised slab (see flatPadGroup). Decals only — pads keep triangle chevrons.
 */
function flatDecalGroup(w, d, color, name = "Decal") {
  const g = new THREE.Group();
  g.name = name;
  g.add(pixelChevronRunMesh(w, d, color));
  return g;
}

/**
 * Circular launch decal: concentric blue rings. One merged emissive mesh.
 */
function launchDecalGroup(radius = 5.5, color = 0x4ad2ff) {
  const g = new THREE.Group();
  g.name = "LaunchDecal";
  const parts = [];
  for (const rFrac of [0.92, 0.6, 0.28]) {
    const ring = new THREE.RingGeometry(radius * rFrac - 0.35, radius * rFrac, 32);
    ring.rotateX(-Math.PI / 2);
    ring.translate(0, 0.06, 0);
    parts.push(ring);
  }
  const geo = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  if (geo) {
    g.add(new THREE.Mesh(
      geo,
      mat(color, { roughness: 0.3, emissive: color, emissiveIntensity: 4, side: THREE.DoubleSide }),
    ));
  }
  return g;
}

/**
 * Tube booster decal: a ring of emissive chevrons wrapped around the INSIDE of
 * a cylinder, all pointing along −Z — the boost-pad look bent into a hoop, for
 * mounting inside tube pieces (or the rotating tube). Authored with its axis at
 * the group ORIGIN and the group lifted by the tube radius, so surface-snapping
 * onto a tube floor puts the band dead on the tube's axis.
 */
function boostTubeGroup(r = 7.3, len = 5.2, color = 0x18ffd0) {
  const g = new THREE.Group();
  g.name = "BoostTube";

  // Faint translucent sleeve so the band reads as one object.
  const sleeve = new THREE.Mesh(
    new THREE.CylinderGeometry(r + 0.15, r + 0.15, len, 48, 1, true),
    mat(0x0d1116, { roughness: 0.55, opacity: 0.35, side: THREE.DoubleSide }),
  );
  sleeve.rotation.x = Math.PI / 2; // axis along Z
  g.add(sleeve);

  // Bright hoops at both mouths.
  for (const z of [-len / 2, len / 2]) {
    const hoop = new THREE.Mesh(
      new THREE.TorusGeometry(r + 0.2, 0.14, 12, 48), // torus already lies in XY → axis = Z
      mat(color, { roughness: 0.35, emissive: color, emissiveIntensity: 3.5 }),
    );
    hoop.position.z = z;
    g.add(hoop);
  }

  // Chevrons around the inner surface, tips toward −Z (the boost direction).
  const K = 10;
  const dphi = 2.2 / r; // ~2.2 m arc half-width per arm
  const zTip = -len * 0.32;
  const zBack = len * 0.32;
  const pos = [];
  for (let k = 0; k < K; k++) {
    const phi = (2 * Math.PI * k) / K;
    const p = (ph, z) => pos.push(Math.cos(ph) * r, Math.sin(ph) * r, z);
    p(phi, zTip); // tip
    p(phi + dphi, zBack); // arm
    p(phi - dphi, zBack); // arm
  }
  const chevGeo = new THREE.BufferGeometry();
  chevGeo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  chevGeo.computeVertexNormals();
  g.add(new THREE.Mesh(
    chevGeo,
    mat(color, { roughness: 0.3, emissive: color, emissiveIntensity: 5, side: THREE.DoubleSide }),
  ));

  g.position.y = r; // rest offset: snapping to a tube floor centres the band on the axis
  return g;
}

/**
 * Optimized tube booster: purple chevron band only — no translucent sleeve, no
 * mouth toruses. The old `boostTubeGroup` draws filled triangles; this one draws
 * real open chevrons (`>` stroke) in a few rows around the cylinder, still a
 * single emissive mesh. Same rest-offset / snap convention as the original.
 *
 * (The "sleeve" on the old prop was a faint dark glass cylinder behind the
 * arrows — dropped here; chevrons alone carry the read.)
 */
function boostTubeGroupNew(r = 7.3, len = 5.2, color = 0xb44dff) {
  const g = new THREE.Group();
  g.name = "BoostTubeNew";

  // Circumference count × rows along −Z → racing `>>>` wrapped into a hoop.
  const K = 8;
  const ROWS = 3;
  const halfArc = 1.65; // outer arm half-width along the wall (m)
  const strokeArc = 0.45; // how thick the V stroke is along the wall (m)
  const rowPitch = len * 0.28;
  const row0 = -rowPitch;

  const pos = [];
  const push = (ph, z) => {
    pos.push(Math.cos(ph) * r, Math.sin(ph) * r, z);
  };
  const tri = (ph0, z0, ph1, z1, ph2, z2) => {
    push(ph0, z0); push(ph1, z1); push(ph2, z2);
  };

  for (let row = 0; row < ROWS; row++) {
    const zTip = row0 + row * rowPitch;
    const zBack = zTip + len * 0.2;
    // Inner tip sits part-way back so the notch opens toward +Z (entry side).
    const zInner = zTip + (zBack - zTip) * 0.48;
    const dphi = halfArc / r;
    const dphiIn = Math.max(0.08, (halfArc - strokeArc) / r);
    for (let k = 0; k < K; k++) {
      const phi = (2 * Math.PI * k) / K;
      // Right arm quad (oTip → oR → iR → iTip), then left mirror.
      // iR/iL stay close to the outer arms so the middle stays open.
      tri(phi, zTip, phi + dphi, zBack, phi + dphiIn, zBack);
      tri(phi, zTip, phi + dphiIn, zBack, phi, zInner);
      tri(phi, zTip, phi, zInner, phi - dphiIn, zBack);
      tri(phi, zTip, phi - dphiIn, zBack, phi - dphi, zBack);
    }
  }

  const chevGeo = new THREE.BufferGeometry();
  chevGeo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  chevGeo.computeVertexNormals();
  g.add(new THREE.Mesh(
    chevGeo,
    mat(color, { roughness: 0.3, emissive: color, emissiveIntensity: 5, side: THREE.DoubleSide }),
  ));

  g.position.y = r;
  return g;
}

/** Functional boost ring: an emissive cyan torus gate that slingshots the car
 *  forward when driven through. Distinct cyan glow (vs the orange Glow ring). */
function boostRingGroup() {
  const m = new THREE.Mesh(
    new THREE.TorusGeometry(8.5, 0.9, 18, 56),
    mat(0x18ffd0, { roughness: 0.35, metalness: 0.1, emissive: 0x18ffd0, emissiveIntensity: 4.5 }),
  );
  m.geometry.translate(0, 10, 0); // lift so the hole clears the ground
  return m;
}

/**
 * Angular neon checkpoint gate — square goalpost with 45° chamfered top corners,
 * NOT a torus. Spans `roadParams.width` so a drop on a straight sits on the kerbs.
 *
 * Dark frame + a thin sky-cyan neon stroke down the MEDIAL of the arch (follows
 * the posts, chamfers and top bar). Only the stroke blooms; the body stays matte
 * black. A gap on the top bar breaks the line so it does not read as one solid
 * strip through the bloom.
 *
 * Same selective-bloom path as Glow box (`mat` + emissiveIntensity > 1 → MRT).
 * Fixed sky-cyan (the reference look); not wired to the orange glowPropParams.
 */
const NEON_GATE_GLOW = 0x5ad8ff;
const NEON_GATE_BODY = 0x0a0c10;

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

function neonGateGroup() {
  const W = roadParams.width; // kerb-to-kerb — place centred on a road piece
  const T = 0.72; // frame thickness in the arch plane
  const D = 0.38; // depth along travel
  const C = 1.85; // 45° chamfer run on each top corner
  const clearH = 7.2; // headroom under the bar
  const H = clearH + T;
  const hw = W / 2;
  const iw = W / 2 - T;
  const ih = clearH;
  // Same sink as hole walls — resting exactly on y=0 z-fights the deck.
  const SINK = 0.06;
  const gapW = 1.4; // break in the top neon (and visual centre cue)
  const neonHalf = 0.07; // half-width of the glowing stroke

  const g = new THREE.Group();
  g.name = "NeonGate";

  const outline = new THREE.Shape();
  outline.moveTo(-hw, -SINK);
  outline.lineTo(-hw, H - C);
  outline.lineTo(-hw + C, H);
  outline.lineTo(hw - C, H);
  outline.lineTo(hw, H - C);
  outline.lineTo(hw, -SINK);
  outline.closePath();

  // Hole winds opposite the outline (three requires it) — CW vs outline CCW.
  const hole = new THREE.Path();
  hole.moveTo(-iw, -SINK);
  hole.lineTo(-iw, ih - C);
  hole.lineTo(-iw + C, ih);
  hole.lineTo(iw - C, ih);
  hole.lineTo(iw, ih - C);
  hole.lineTo(iw, -SINK);
  hole.closePath();
  outline.holes.push(hole);

  const geo = new THREE.ExtrudeGeometry(outline, {
    depth: D,
    bevelEnabled: false,
    curveSegments: 1,
  });
  geo.translate(0, 0, -D / 2);

  // Matte body — the neon is a separate stroke, not the whole frame.
  g.add(new THREE.Mesh(
    geo,
    mat(NEON_GATE_BODY, { roughness: 0.55, metalness: 0.35, bloom: false }),
  ));

  // Medial path of the arch (centre of the frame thickness).
  const cxL = -hw + T / 2;
  const cxR = hw - T / 2;
  const cyTop = ih + T / 2;
  const cChamferY = cyTop - C;

  const leftPts = [
    { x: cxL, y: -SINK },
    { x: cxL, y: cChamferY },
    { x: cxL + C, y: cyTop },
    { x: -gapW / 2, y: cyTop },
  ];
  const rightPts = [
    { x: gapW / 2, y: cyTop },
    { x: cxR - C, y: cyTop },
    { x: cxR, y: cChamferY },
    { x: cxR, y: -SINK },
  ];

  const neonMat = mat(NEON_GATE_GLOW, {
    roughness: 0.3,
    metalness: 0.05,
    emissive: NEON_GATE_GLOW,
    emissiveIntensity: 5.5,
  });
  // Slightly proud of both faces so the stroke reads from either approach.
  const neonDepth = D + 0.1;
  for (const pts of [leftPts, rightPts]) {
    const stroke = new THREE.ExtrudeGeometry(neonStrokeShape(pts, neonHalf), {
      depth: neonDepth,
      bevelEnabled: false,
      curveSegments: 1,
    });
    stroke.translate(0, 0, -neonDepth / 2);
    const mesh = new THREE.Mesh(stroke, neonMat);
    mesh.userData.isGlow = true;
    mesh.userData.noCollide = true;
    g.add(mesh);
  }

  return g;
}

/**
 * Short orange vault — a half-pipe tunnel you drive through, a bit narrower
 * than the default deck so a centred drop sits inside the kerbs.
 *
 * Built like the open cylinder (split inner/outer shells + end rings), not as
 * an extrusion. ExtrudeGeometry shares the vault with the end caps, so
 * averaged normals facet the curve even at the same vertex count; the
 * cylinder pieces already carry radial normals and the caps stay flat.
 */
function roadArchGroup() {
  const Ro = roadParams.width * 0.44; // ~7.0 m → outer span ~14 m on a 16 m road
  const wall = 0.95;
  const Ri = Ro - wall;
  const depth = 6; // metres along travel — a short tunnel, not a hoop
  const SINK = 0.08;

  const geo = thickWallVaultGeometry(Ri, Ro, depth, 40);
  geo.rotateX(Math.PI / 2);
  geo.translate(0, -SINK, 0);
  geo.computeBoundingBox();
  geo.computeBoundingSphere();

  const m = new THREE.Mesh(
    geo,
    mat(0xf07020, { roughness: 0.78, metalness: 0 }),
  );
  m.name = "RoadArch";
  return m;
}

/* ----------------------------------------------------------------------- */
/* Hole walls — the straight menu's Hole Road, stood up                     */
/* ----------------------------------------------------------------------- */

/**
 * The two hole walls, as numbers. One builder makes both (buildHoleWall) —
 * they are the same object with a different port and a different frame, and
 * duplicating the geometry would only let the two drift apart.
 *
 * `bottom`/`top` are the plate's extent in METRES ABOVE THE DECK, because that
 * is the difference between the two: the drive-through wall is planted in the
 * road (bottom is negative — a skirt buried in the 0.8 m slab) while the air
 * gate floats clear of it and you pass UNDER as easily as through.
 *
 * `mouthY` is the flat chord that cuts the port open at the bottom, or `null`
 * for a full circle. That single field is what makes one wall drivable and the
 * other jump-only — see buildHoleWall.
 */
const HOLE_WALL = {
  width: 22, // plate width (m) — spans a default 16 m road with room either side
  bottom: -0.55, // skirt below the deck (m), buried in the 0.8 m road slab
  top: 11, // plate top above the deck (m)
  depth: 0.9, // plate thickness along travel (m)
  radius: 5.2, // port radius (m)
  centerY: 2.9, // port centre height (m) — BELOW `radius`, so the port opens at the deck
  mouthY: -0.06, // chord that cuts the port open (m) — see buildHoleWall
  rim: 0.42, // width of the glowing rim band (m)
};
const HOLE_WALL_AIR = {
  width: 17,
  bottom: 2.6, // floats: the plate starts well above the deck
  top: 17.4,
  depth: 0.9,
  radius: 5, // full circle, so this is the clearance in EVERY direction
  centerY: 10, // same height as the ring gates — what a big jump actually reaches
  mouthY: null, // FULL circle: no chord, no way through but the air
  rim: 0.42,
};
const HOLE_WALL_GLOW = 0xffb02e;

/**
 * The port outline: a circle of radius `R` about (0, `cfg.centerY`), optionally
 * cut off by a flat chord at `bottomY` and closed across it.
 *
 * Called twice per wall with the SAME centre — once for the hole in the plate,
 * once for the rim band's outer edge with both radius and chord pushed out by
 * the rim width, which keeps the band an even thickness the whole way round.
 *
 * @param {THREE.Path|THREE.Shape} target path to append to (Shape for an outer
 *   contour, Path for a hole — three needs the distinction, not the maths).
 * @param {number} bottomY chord height, or `null` for an uncut circle.
 */
function holeWallPort(target, cfg, R, bottomY) {
  const cy = cfg.centerY;
  if (bottomY == null) {
    target.absarc(0, cy, R, 0, Math.PI * 2, false);
    return target;
  }
  // Keep every point with y ≥ bottomY, i.e. sinθ ≥ (bottomY − cy)/R.
  const s = THREE.MathUtils.clamp((bottomY - cy) / R, -1, 1);
  const a0 = Math.asin(s); // right-hand crossing (θ < 0)
  target.absarc(0, cy, R, a0, Math.PI - a0, false); // CCW over the top to the left crossing
  target.lineTo(Math.cos(a0) * R, cy + Math.sin(a0) * R); // flat chord back to the start
  target.closePath();
  return target;
}

/**
 * The straight menu's HOLE ROAD, turned through 90°.
 *
 * There, a deck with a circular hole punched through it is a trap you drop into;
 * here the same slab stands ACROSS the track, and the hole is the only way past.
 * Same construction idea (one slab, one round hole, no boolean anywhere — the
 * hole is a contour the triangulator is told to leave empty), opposite job.
 *
 * VERTICAL IS THE AUTHORED POSE, not a rotation you apply after dropping it: the
 * plate is built in the XY plane with its depth along Z, and −Z is the props'
 * travel direction (the same forward the boost pads' chevrons point down), so a
 * freshly placed wall already faces oncoming traffic.
 *
 * `cfg.mouthY` picks which of the two walls this is, and the choice is entirely
 * about where the port sits relative to the car:
 *
 *  • A CHORD (the drive-through wall) clips the circle just under the road. A
 *    full circle at driving height would leave a ledge below it at exactly wheel
 *    height — you would hit the wall instead of driving through the hole. Cut at
 *    6 cm LOW rather than at 0 on purpose: cut exactly at deck level and the
 *    sill's top face is coplanar with the road and z-fights across the mouth.
 *  • NULL (the air gate) leaves the circle whole and lifts it out of reach, so
 *    the only way in is a jump. Nothing is clipped because nothing needs to be —
 *    at 10 m up there is no wheel to catch on the bottom of the ring.
 *
 * Collision is `solid` for both and needs nothing special, for the same reason
 * the holed deck needs nothing special: the bake only ever contains triangles
 * that exist, so the port is genuinely empty space and the plate is genuinely a
 * wall.
 */
function buildHoleWall(cfg, name) {
  const { width: W, bottom: B, top: T, depth: D, radius: R, mouthY, rim } = cfg;
  const hw = W / 2;
  const g = new THREE.Group();
  g.name = name;

  const plateMat = mat(0x2b3038, { roughness: 0.62, metalness: 0.38 });
  const extrude = (shape, depth) => {
    const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 48 });
    geo.translate(0, 0, -depth / 2); // extrude runs 0→depth; centre it on the pivot
    return geo;
  };

  // ── NO PART IS EVER FLUSH WITH ANOTHER ─────────────────────────────────────
  // Every trim piece here was first authored the obvious way — rim on the port
  // radius, columns aligned with the plate's edge, cap beam the plate's width
  // with its top at the plate's top, footings resting on y = 0 — and every one
  // of those is a pair of EXACTLY COPLANAR faces. The depth buffer cannot order
  // them, so which one wins is decided by floating-point noise that changes with
  // the camera: the whole edge crawls and flickers as you drive past. Distance
  // makes it worse, not better, which is exactly when you see these props.
  //
  // The fix is not a depth-bias or a polygon offset, it is not authoring the
  // coincidence: each part either sinks INSIDE the volume of the part it trims
  // or clears it by BITE, so no two surfaces are ever candidates for the same
  // pixel. BITE is well above float precision at these distances and well below
  // anything the eye reads as a gap.
  const BITE = 0.1;
  // Same idea against the ROAD, and the same 6 cm the port's mouth chord uses:
  // anything resting exactly on the deck z-fights with the deck.
  const SINK = 0.06;

  // ── Plate: rectangle minus the port ────────────────────────────────────────
  const outline = new THREE.Shape();
  outline.moveTo(-hw, B);
  outline.lineTo(hw, B);
  outline.lineTo(hw, T);
  outline.lineTo(-hw, T);
  outline.closePath();
  outline.holes.push(holeWallPort(new THREE.Path(), cfg, R, mouthY));
  g.add(new THREE.Mesh(extrude(outline, D), plateMat));

  // ── Rim: the same curve as a band, standing proud of both faces ────────────
  // On the drive-through wall its lower ends run below the deck, so what you see
  // is a horseshoe of light around the mouth; on the air gate it closes into a
  // full ring, which is the whole aiming cue for a jump.
  //
  // Its inner edge BITES INTO the port rather than sitting on it. Built on the
  // same radius the two share one cylindrical surface all the way round the
  // hole — the worst case of the note above, and a ring of flicker exactly where
  // the eye is aimed. A hair narrower and the plate's port wall is buried inside
  // the rim's solid instead, which is a plain intersection the depth buffer has
  // no trouble with. It costs 6 cm off a 10 m opening.
  const rimShape = holeWallPort(new THREE.Shape(), cfg, R + rim, mouthY == null ? null : mouthY - rim);
  rimShape.holes.push(holeWallPort(new THREE.Path(), cfg, R - SINK, mouthY));
  g.add(new THREE.Mesh(
    extrude(rimShape, D + 0.24),
    mat(HOLE_WALL_GLOW, {
      roughness: 0.35,
      metalness: 0.1,
      emissive: HOLE_WALL_GLOW,
      emissiveIntensity: 3.5,
    }),
  ));

  // ── Hazard columns down both ends ──────────────────────────────────────────
  // Painted, not stacked rings — same reasoning as the pole's bands, and it
  // keeps both columns on one material so they merge into a single draw.
  // Inset by BITE on all three axes, so neither the outer face nor either end
  // face lands on one of the plate's. The ends are hidden under the beams
  // anyway, but "hidden by another part" is a fact about the CURRENT numbers —
  // moving a beam later would expose a coincidence nobody knew was there.
  const colGeo = new THREE.BoxGeometry(0.6, T - B - 2 * BITE, D + 0.16);
  const colMat = mat(0xffffff, { roughness: 0.55, metalness: 0.2, map: poleBandTexture() });
  for (const x of [-(hw - 0.3 - BITE), hw - 0.3 - BITE]) {
    const col = new THREE.Mesh(colGeo, colMat);
    col.position.set(x, (T + B) / 2, 0);
    g.add(col);
  }

  // ── Beams: a cap on top always; the air gate also gets a matching bottom ───
  // Wider than the plate and overhanging it by BITE in `dir`, so the plate's top
  // (or bottom) face and both its side faces end up INSIDE the beam rather than
  // level with it. The columns' end faces are swallowed the same way.
  const beam = (edgeY, dir) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(W + 2 * BITE, 0.5, D + 0.34), plateMat);
    m.position.y = edgeY + dir * (BITE - 0.25);
    g.add(m);
  };
  beam(T, +1);
  if (mouthY == null) beam(B, -1); // floating ring — close the frame

  return g;
}

/* ----------------------------------------------------------------------- */
/* Prop catalog                                                             */
/* ----------------------------------------------------------------------- */

/** Shared look for the emissive "Glow box" prop. Edited live via the inspector;
 *  high emissiveIntensity (>1) so it blooms against any sky (folio-2025 style). */
export const glowPropParams = { color: "#ff5a1e", intensity: 6 };

/**
 * Where a placed prop's feet land.
 *
 * Props used to keep whatever y `make()` authored, so anything dropped near an
 * elevated road piece just hung in the air at its rest height. Both surfaces are
 * already available to the game (the deck BVH for road, `app.getWorldHeight` for
 * terrain) — this just asks for one.
 *
 * THREE modes, not two, and the third is the one that matters:
 *   • auto   — road if there is any under the point, else terrain. Right ~90% of
 *              the time, so it is the default.
 *   • ground — terrain ONLY. The escape hatch: placing a prop on the ground
 *              UNDERNEATH an elevated road is exactly the parkour case, and auto
 *              would snap it up onto the deck above. Unfixable without this.
 *   • road   — deck ONLY. Nothing placed if there is no road under the point.
 *   • free   — no snapping; drag the Y axis by hand.
 *
 * In every snapped mode Y is DRIVEN by the surface, so dragging the gizmo's Y
 * axis does nothing — that is what `free` is for. A predictable rule beats a
 * clever one that sometimes lets you nudge height and sometimes doesn't.
 */
export const SURFACE_SNAP = { mode: "auto" };
export const SURFACE_SNAP_MODES = ["auto", "ground", "road", "free"];

/**
 * Write a material's emissive into the bloom buffer.
 *
 * Built from `materialEmissive`, a LIVE node, so later changes to `.emissive` /
 * `.emissiveIntensity` (see applyGlowParams) update the glow with no mrtNode
 * rebuild.
 *
 * Goes through v3's BloomMRTNode (applyBloomMRT), NOT stock mrt(): these
 * materials are also rendered into a plain offscreen RenderTarget by
 * bakeRoadThumbnails() for the palette tiles, and on three r184 a stock mrtNode
 * there emits a zero-member WGSL output struct and kills the renderer.
 */
function applyPropBloom(material) {
  applyBloomMRT(material, materialEmissive);
  material.userData.bloom = true;
  // BATCHABLE DESPITE THE mrtNode. Every material through here gets the SAME
  // graph — applyBloomMRT over the live `materialEmissive` node — so what it
  // renders is fully determined by its plain `.emissive` / `.emissiveIntensity`,
  // which the merge signature already covers. Without this tag the mrtNode sends
  // it down materialKey's identity fallback and the glowing props stop merging
  // entirely: measured at twenty separate meshes for twenty glow rings.
  material.userData.batchKey = "propBloom";
  return material;
}

/**
 * Standard prop material.
 *
 * NODE material, not MeshStandardMaterial — v3's bloom is SELECTIVE: only the
 * emissive MRT buffer blooms, and `mrtNode` is a NodeMaterial property. The lab
 * bloomed the whole scene's bright pixels, so `emissive` plus a high
 * `emissiveIntensity` glowed there for free; here that alone does nothing.
 *
 * `bloom` defaults on for emissiveIntensity > 1 — the props MEANT to glow
 * (chevrons 5, boost ring 4.5, glow box/ring 6) opt in, while incidental
 * emissive (a 0.4 metal sheen, the 0.5 pad slab) stays out of the bloom buffer.
 * Pass `bloom` explicitly to override either way.
 */
function mat(color, opts = {}) {
  const emissiveIntensity = opts.emissiveIntensity ?? 1;
  const m = new THREE.MeshStandardNodeMaterial({
    color: new THREE.Color(color),
    roughness: opts.roughness ?? 0.7,
    metalness: opts.metalness ?? 0.1,
    emissive: new THREE.Color(opts.emissive ?? 0x000000),
    emissiveIntensity,
    side: opts.side ?? THREE.FrontSide,
  });
  if (opts.opacity != null && opts.opacity < 1) {
    m.transparent = true;
    m.opacity = opts.opacity;
    m.depthWrite = false; // translucent decal tint — never occlude the deck
  }
  if (opts.map) m.map = opts.map;
  // KEEPS THE FOG LIVE. three's WebGPU backend only re-uploads a render object's
  // uniforms when its material carries a NODE property — scene-level uniforms
  // behind `scene.fogNode` are not tracked — so a plain-node material on a prop
  // that never moves would keep whatever fog it first rendered with forever,
  // while the track around it updates. Props are exactly that: static world
  // geometry. `materialColor` leaves `.color` (and `.map`, which it multiplies
  // in) authoritative, so this changes nothing about how the prop looks.
  m.colorNode = materialColor;
  if (opts.bloom ?? emissiveIntensity > 1) applyPropBloom(m);
  return m;
}

/**
 * Was the swing gate's red/white hazard band (1-D texture). Panel is solid bright
 * red now — kept for restore.
 */
// let _gateStripeTex = null;
// function gateStripeTexture() {
//   if (_gateStripeTex) return _gateStripeTex;
//   const H = 64;
//   const band = Math.round((0.26 / GATE_HEIGHT) * H);
//   const data = new Uint8Array(H * 4);
//   for (let i = 0; i < H; i++) {
//     const inBand = Math.abs(i - H / 2) < band / 2;
//     const c = inBand ? [244, 244, 244] : [226, 59, 46];
//     data[i * 4] = c[0]; data[i * 4 + 1] = c[1]; data[i * 4 + 2] = c[2]; data[i * 4 + 3] = 255;
//   }
//   _gateStripeTex = new THREE.DataTexture(data, 1, H);
//   _gateStripeTex.colorSpace = THREE.SRGBColorSpace;
//   _gateStripeTex.wrapS = _gateStripeTex.wrapT = THREE.ClampToEdgeWrapping;
//   _gateStripeTex.needsUpdate = true;
//   return _gateStripeTex;
// }

/**
 * Diagonal-free hazard banding for the pole — yellow/black rings up its length.
 *
 * Same shared-and-painted approach as the (former) gate stripe: stacking real
 * ring meshes would be a draw call each AND put every ring's cap coplanar with
 * the shaft.
 */
let _poleBandTex = null;
function poleBandTexture() {
  const H = 128;
  if (_poleBandTex) return _poleBandTex;
  const data = new Uint8Array(H * 4);
  for (let i = 0; i < H; i++) {
    const dark = Math.floor(i / 8) % 2 === 0;
    const c = dark ? [26, 26, 28] : [232, 176, 32];
    data[i * 4] = c[0]; data[i * 4 + 1] = c[1]; data[i * 4 + 2] = c[2]; data[i * 4 + 3] = 255;
  }
  _poleBandTex = new THREE.DataTexture(data, 1, H);
  _poleBandTex.colorSpace = THREE.SRGBColorSpace;
  _poleBandTex.wrapS = _poleBandTex.wrapT = THREE.ClampToEdgeWrapping;
  _poleBandTex.needsUpdate = true;
  return _poleBandTex;
}

/**
 * Give a placement its colour variant.
 *
 * `tint` is what the instancer writes into `InstancedMesh.instanceColor`, which
 * three multiplies into the material's colour — so variation is a vec3 per
 * instance and costs no extra draw, material or binding. A prop with no
 * `variants` gets no tint at all and renders exactly as its materials say.
 */
function setVariant(inst, index) {
  const list = inst.def?.variants;
  if (!list?.length) { inst.variant = 0; inst.tint = null; return inst; }
  inst.variant = ((index | 0) % list.length + list.length) % list.length;
  inst.tint = new THREE.Color(list[inst.variant]);
  return inst;
}

/**
 * @typedef {object} PropDef
 * @property {string} id
 * @property {string} label
 * @property {string} collision  Role in the TRIANGLE bake: none|deck|solid|both.
 *   Capsule colliders are a SEPARATE channel and are collected regardless — see
 *   PropManager.collisionCapsules() — so a prop can be `none` here and still
 *   block the car. Scenery is the case that needs it: its meshes are decor and
 *   only its masts and legs are solid.
 * @property {string} [category] Palette tab. Defaults to "obstacles".
 * @property {{length:number, height:number, width:number}} [stack] Footprint +
 *   course height for PropManager.stackSnap (containers, tyres).
 * @property {() => THREE.Object3D} make
 */
/** @type {PropDef[]} */
export const PROP_CATALOG = [
  // ── PHYSICS PROPS ───────────────────────────────────────────────────────────
  // `collision: "none"` is deliberate: these are simulated by PropPhysics and
  // must NOT go into the static collision bake. Baking them would weld a cone to
  // the track — the car would hit an immovable invisible wall where the cone was
  // authored, and the visible cone would fly off on its own.
  {
    id: "cone",
    label: "Traffic cone",
    collision: "none",
    make: () => {
      const g = new THREE.Group();
      g.name = "Cone";
      // A real traffic cone is NOT a pointed cone: it is a truncated taper with
      // a FLAT TOP, standing on a square flanged base, with two retroreflective
      // collars. The pointed-ConeGeometry version read as a party hat.
      //
      // Built as a LATHE so the silhouette curves slightly inward like moulded
      // PVC instead of being a dead-straight ramp, and so the base flange and
      // body are one continuous surface rather than two parts intersecting.
      //
      // Authored as a MOTORWAY cone (~0.93 m) rather than a footpath one:
      // against a 4.85 m car anything shorter reads as a toy. CONE_SCALE then
      // multiplies the whole silhouette — shared with the collision proxy in
      // modularRoadPropPhysics.js so the two cannot drift.
      const S = CONE_SCALE;
      const H = 0.93 * S;
      const profile = [
        new THREE.Vector2(0.278, 0.0),    // flange edge
        new THREE.Vector2(0.263, 0.033),
        new THREE.Vector2(0.198, 0.045),  // flange tucks in
        new THREE.Vector2(0.177, 0.083),
        new THREE.Vector2(0.150, 0.21),   // slight concave sweep up the body
        new THREE.Vector2(0.119, 0.42),
        new THREE.Vector2(0.083, 0.66),
        new THREE.Vector2(0.057, 0.84),
        new THREE.Vector2(0.051, 0.93),   // FLAT top, not a point
        new THREE.Vector2(0.0, 0.93),
      ].map((v) => v.multiplyScalar(S));
      const body = new THREE.Mesh(
        new THREE.LatheGeometry(profile, 20),
        mat(0xf4581a, { roughness: 0.55, metalness: 0.0 }),
      );
      // Two collars, the upper one narrower — they follow the taper, so each
      // needs its own radii or they float off the surface.
      const collar = (yBottom, h, rB, rT) => {
        const m = new THREE.Mesh(
          new THREE.CylinderGeometry(rT, rB, h, 20, 1, true),
          mat(0xeef0f2, { roughness: 0.35, metalness: 0.15 }),
        );
        m.position.y = yBottom + h / 2;
        return m;
      };
      const square = new THREE.Mesh(
        new THREE.BoxGeometry(0.55 * S, 0.042 * S, 0.55 * S),
        mat(0x141417, { roughness: 0.9 }),
      );
      square.position.y = 0.021 * S;
      g.add(
        square, body,
        collar(0.45 * S, 0.17 * S, 0.113 * S, 0.097 * S),
        collar(0.70 * S, 0.105 * S, 0.076 * S, 0.067 * S),
      );

      // ── SIT ON THE GROUND, AND ROTATE ABOUT THE MIDDLE ──────────────────────
      // Two constraints that pull opposite ways:
      //  • PropManager keeps the authored y on placement (it only sets x/z), so
      //    make() must leave the prop ground-flush.
      //  • The rigid body integrates about the ROOT, so the root has to be the
      //    cone's CENTRE — put it at the base and a knocked cone pivots on its
      //    tip like a spinning top.
      // Satisfy both: drop the geometry by the collision radius, then lift the
      // ROOT by the same amount. Base lands on y=0, root sits at the centre.
      // Taken from PHYSICS_PROP_TYPES so the two can never drift apart — the
      // earlier hardcoded copy is exactly how it ended up half-buried.
      const R = PHYSICS_PROP_TYPES.cone.radius;
      g.children.forEach((c) => { c.position.y -= R; });
      g.position.y = R;
      return g;
    },
  },
  {
    id: "tyre",
    label: "Tyre",
    collision: "none",
    /**
     * Knockable barrier tyre — not the static Tire wall segment. Lies FLAT
     * (hole up) so a stack is a column of pancakes, the way a real tyre wall
     * is built. Click on one to add a course, click beside one to extend the
     * row.
     */
    stack: TIRE_SIZE,
    make: () => {
      const g = new THREE.Group();
      g.name = "Tyre";
      const S = TIRE_SCALE;
      const outer = TIRE_OUTER_R;
      const hw = TIRE_TUBE_R;
      const inner = outer - hw * 1.55;
      // Lathe around Y — hole up, lying flat. That is the default pose: you
      // stack them like pancakes, not on their tread.
      const profile = [
        new THREE.Vector2(inner, -hw * 0.88),
        new THREE.Vector2(inner + 0.02 * S, -hw),
        new THREE.Vector2(outer - 0.07 * S, -hw),
        new THREE.Vector2(outer - 0.012 * S, -hw * 0.5),
        new THREE.Vector2(outer, -hw * 0.22),
        new THREE.Vector2(outer - 0.01 * S, -0.04 * S),
        new THREE.Vector2(outer, 0),
        new THREE.Vector2(outer - 0.01 * S,  0.04 * S),
        new THREE.Vector2(outer,  hw * 0.22),
        new THREE.Vector2(outer - 0.012 * S,  hw * 0.5),
        new THREE.Vector2(outer - 0.07 * S,  hw),
        new THREE.Vector2(inner + 0.02 * S,  hw),
        new THREE.Vector2(inner,  hw * 0.88),
        new THREE.Vector2(inner, -hw * 0.88),
      ];
      const body = new THREE.Mesh(
        new THREE.LatheGeometry(profile, 28),
        mat(0x1a1a1c, { roughness: 0.94, metalness: 0.02 }),
      );
      const rim = new THREE.Mesh(
        new THREE.TorusGeometry(inner + 0.012 * S, 0.016 * S, 8, 24),
        mat(0x3c3c42, { roughness: 0.5, metalness: 0.28 }),
      );
      rim.rotation.x = Math.PI / 2; // torus hole is Z; match the lathe's Y hole
      g.add(body, rim);
      // Lathe is centred on the origin. Lift by half-thickness so the bottom
      // sidewall sits on y=0 and physics rotates about the middle.
      g.position.y = hw;
      return g;
    },
  },
  {
    id: "flag",
    label: "Banner flag",
    category: "scenery",
    collision: "none", // triangle bake off — thin pole uses a capsule instead
    // Just the POLE. The CLOTH is drawn by ModularRoadFlags as a single
    // instanced mesh across every flag on the track — see that file for why it
    // is a shader wave rather than the engine's Verlet cloth. The pole stays a
    // real prop mesh so the gizmo has something to grab and right-click picking
    // still works; an empty root would be unselectable.
    make: () => {
      const g = new THREE.Group();
      g.name = "BannerFlag";
      const POLE_H = 6;
      const POLE_R = 0.08;
      const pole = new THREE.Mesh(
        new THREE.CylinderGeometry(0.07, 0.09, POLE_H, 10),
        mat(0xb9c0c8, { roughness: 0.35, metalness: 0.75 }),
      );
      pole.position.y = POLE_H / 2;
      // Exact capsule — same pattern as gate post / scenery masts; the hull
      // sampler cannot see a pole this thin reliably.
      pole.userData.capsule = { radius: POLE_R, height: POLE_H };
      const finial = new THREE.Mesh(
        new THREE.SphereGeometry(0.11, 10, 8),
        mat(0xd8dee6, { roughness: 0.25, metalness: 0.85 }),
      );
      finial.position.y = POLE_H + 0.05;
      finial.userData.noCollide = true;
      const base = new THREE.Mesh(
        new THREE.CylinderGeometry(0.34, 0.42, 0.16, 12),
        mat(0x23262b, { roughness: 0.85 }),
      );
      base.position.y = 0.08;
      base.userData.noCollide = true;
      g.add(base, pole, finial);
      return g;
    },
  },
  {
    id: "gate",
    label: "Swing gate",
    /**
     * SPLIT COLLISION, unlike the cone above. The post is a fixed steel column
     * bolted to the deck and clipping through it read as a bug, so the gate opts
     * IN to the static solids bake — and the panel opts back out per-mesh
     * (`noCollide`), because a swinging panel baked into a static BVH is exactly
     * the invisible-wall failure the cone's comment describes.
     *
     * Safe only because the post is a cylinder ON the hinge axis: PropPhysics
     * rotates the whole prop root by the gate angle, so every other child moves
     * in world space, but a cylinder spun about its own axis has an unchanged
     * footprint and the baked snapshot stays correct.
     */
    collision: "solid",
    make: () => {
      const g = new THREE.Group();
      g.name = "Gate";
      // Hinge post at the LOCAL ORIGIN — the panel swings about it, so the prop's
      // placement point IS the hinge.
      // Panel size comes from GATE_*, shared with the hinge simulation in
      // modularRoadPropPhysics.js — the panel you SEE, the panel the car is
      // resisted by, and the collider wireframe all read the same numbers.
      const W = GATE_WIDTH;
      const H = GATE_HEIGHT;
      const Y = GATE_BASE_Y + H / 2; // panel centre; bottom sits at GATE_BASE_Y
      const post = new THREE.Mesh(
        new THREE.CylinderGeometry(GATE_POST_RADIUS, GATE_POST_RADIUS, GATE_POST_HEIGHT, 10),
        mat(0x9aa0a8, { roughness: 0.45, metalness: 0.6 }),
      );
      post.position.y = GATE_POST_HEIGHT / 2;
      // Collided as an exact capsule rather than as triangles — a 0.22 m post is
      // thinner than the chassis hull's sample spacing, so the sampled path
      // cannot see it reliably. See PropManager.collisionCapsules().
      post.userData.capsule = { radius: GATE_POST_RADIUS, height: GATE_POST_HEIGHT };
      // Solid bright red panel — the white hazard stripe was dropped (one colour
      // is enough). No map: keeps the gate at two meshes / one plain material.
      const panel = new THREE.Mesh(
        new THREE.BoxGeometry(W, H, 0.09),
        mat(0xff1a1a, { roughness: 0.55, metalness: 0.05 }),
      );
      panel.position.set(W / 2, Y, 0); // extends along +X from the hinge
      // The moving half stays out of the static bake — see `collision` above.
      panel.userData.noCollide = true;
      g.add(post, panel);
      return g;
    },
  },
  {
    id: "pole",
    label: "Pole",
    /**
     * A round obstacle you have to steer around — and the first prop built on
     * the capsule collider from the outset rather than retrofitted onto it.
     *
     * `solid`, but every mesh here is either a capsule or excluded, so it
     * contributes ZERO triangles to the static bake. That is the point: a pole
     * is exactly the shape triangle sampling handles worst (see the sample-gap
     * note on CHASSIS_HULL.sampleSpacing), and exactly the shape an analytic
     * primitive handles perfectly.
     */
    collision: "solid",
    make: () => {
      const g = new THREE.Group();
      g.name = "Pole";
      const R = 0.36;   // fat enough to read as a hazard from a moving car
      const H = 7.0;
      const shaft = new THREE.Mesh(
        new THREE.CylinderGeometry(R, R, H, 14),
        mat(0xc8ccd2, { roughness: 0.4, metalness: 0.7 }),
      );
      shaft.position.y = H / 2;
      shaft.userData.capsule = { radius: R, height: H };
      // Hazard bands, painted rather than stacked as rings — same z-fighting
      // reasoning as the swing gate's stripe, and it keeps the pole at one draw.
      shaft.material.map = poleBandTexture();
      shaft.material.color.set(0xffffff);
      // A footing so it reads as bolted down rather than dropped in. Squat and
      // wide, so it never decides a contact the shaft should have owned — it is
      // excluded from collision entirely and the capsule covers the whole height.
      const base = new THREE.Mesh(
        new THREE.CylinderGeometry(R * 2.1, R * 2.4, 0.22, 14),
        mat(0x2a2d33, { roughness: 0.85 }),
      );
      base.position.y = 0.11;
      base.userData.noCollide = true;
      g.add(shaft, base);
      return g;
    },
  },
  {
    id: "container",
    label: "Container",
    /**
     * `both`, like the Box: a container is a solid you steer around AND a roof
     * you can land on. At 2.59 m tall that is a genuine stunt feature rather
     * than a nicety, and it is free — the deck bake and the solid bake read the
     * same meshes.
     *
     * Triangle collision rather than a capsule, unlike the pole: this really is
     * a box, so the chassis hull's surface sampling has plenty to land on and
     * an analytic primitive would buy nothing.
     */
    collision: "both",
    /**
     * Per-placement colour, applied as an instance tint rather than as extra
     * materials — so a yard of containers in seven liveries costs exactly what
     * one container costs. See CONTAINER_LIVERIES for why that works.
     */
    variants: CONTAINER_LIVERIES,
    /** Footprint + course height, so placements stack onto each other exactly —
     *  see PropManager.stackSnap. */
    stack: CONTAINER_SIZE,
    /**
     * A sticker on both long sides — its own instanced quad, NOT a second map on
     * the container material, which would cost a draw call per container. See
     * modularRoadDecals.js.
     *
     * EVERY NUMBER DERIVED FROM CONTAINER_SIZE. The height and the patch size
     * were literals sized against the unscaled box, so raising CONTAINER_SCALE
     * left the logo 0.56 m below centre and proportionally too small — the wall
     * grew and the sticker did not. Anything hardcoded here silently comes
     * unstuck the moment the container is resized.
     */
    decal: {
      url: DECAL_URL,
      // ~58% of the wall height, which leaves it clear of the corner castings
      // top and bottom at any scale.
      size: [CONTAINER_SIZE.height * 0.58, CONTAINER_SIZE.height * 0.58],
      faces: [
        { pos: [0, CONTAINER_SIZE.height / 2, CONTAINER_SIZE.width / 2 + DECAL_OFFSET], yaw: 0 },
        { pos: [0, CONTAINER_SIZE.height / 2, -(CONTAINER_SIZE.width / 2 + DECAL_OFFSET)], yaw: Math.PI },
      ],
    },
    make: () => makeContainer(),
  },
  {
    id: "tirewall",
    label: "Tire wall",
    /**
     * Solid barrier — steer around it, not over it. Triangle collision goes
     * through a box proxy (see modularRoadTireWall.js) so a row of segments
     * does not put thousands of tire tread triangles into the static BVH.
     */
    collision: "solid",
    make: () => makeTireWall(),
  },
  {
    id: "crane",
    label: "Crane",
    /**
     * Solid obstacle — drive around it. Collision is the visual mesh, not a
     * box: a bounding box would fill the empty air under the boom. 3433 tris
     * is fine for a few of these; it is not a yard of containers.
     */
    collision: "solid",
    make: () => makeCrane(),
  },
  {
    id: "palm",
    label: "Palm tree",
    /**
     * Triangle bake off: the fronds must not be a leafy wall, and the trunk is
     * a round post — the hull sampler's case for a capsule, same as a gate
     * post. The capsule lives on the template (see modularRoadPalm.js).
     */
    collision: "none",
    make: () => makePalm(),
  },
  {
    id: "box",
    label: "Box",
    collision: "both",
    make: () => {
      // Height matches jump ramp rise (8 m) so boxes stack as platforms off a jump.
      const m = new THREE.Mesh(new THREE.BoxGeometry(8, 8, 8), mat(0x8fd99a, { roughness: 0.85 }));
      m.geometry.translate(0, 4, 0); // sit on the ground
      return m;
    },
  },
  {
    id: "wall",
    label: "Wall",
    collision: "solid",
    make: () => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.8, 4, 22), mat(0x804040, { roughness: 0.75 }));
      m.geometry.translate(0, 2, 0); // rest on the ground
      return m;
    },
  },
  {
    id: "roadblock",
    label: "Road block",
    /**
     * Static jersey — you steer around it, not over it. The top trough is 8 cm
     * across; treating that as a deck would be a 2.2 m tightrope nobody asked
     * for. `solid` matches Wall.
     *
     * White or red per placement via instance tint — no second material, no
     * extra draw (same path as container liveries).
     */
    collision: "solid",
    variants: ROAD_BLOCK_COLORS,
    make: () => makeRoadBlock(),
  },
  {
    id: "holewall",
    label: "Hole wall",
    /**
     * `solid`, exactly like the Wall it is a variant of: the plate stops the
     * chassis and the port is empty space in the bake, so aiming is the whole
     * gameplay. Not `both` — the only thing to land on is a 0.9 m cap beam 11 m
     * up, which is not a feature anyone would use on purpose.
     */
    collision: "solid",
    make: () => buildHoleWall(HOLE_WALL, "HoleWall"),
  },
  {
    id: "holewall_air",
    label: "Hole gate (air)",
    /**
     * The same wall with its port left as a FULL circle and lifted to ring-gate
     * height: there is no way through it on the ground, so it only pays off
     * placed over a jump — thread the ring in mid-air or bounce off the plate.
     *
     * The plate floats (its bottom edge is 2.6 m up) rather than reaching the
     * deck. Reaching down would make it a wall with an unreachable hole, i.e.
     * a dead end; floating leaves the driver a choice — go under and lose the
     * line, or commit to the jump.
     *
     * `solid` again, and again the port needs no special case: it is empty space
     * in the bake, so a car that threads it touches nothing at all.
     */
    collision: "solid",
    make: () => buildHoleWall(HOLE_WALL_AIR, "HoleGateAir"),
  },
  {
    id: "roadarch",
    label: "Arch",
    /**
     * Short orange vault. `solid`: the shell is a wall you can clip, the
     * opening is empty space in the bake.
     */
    collision: "solid",
    make: () => roadArchGroup(),
  },
  {
    id: "ramp",
    label: "Slope ramp",
    category: "parkour",
    collision: "both",
    // Rise 8 m — same as jump ramp / box, so a slope can meet a platform flush.
    make: () => new THREE.Mesh(rampGeometry(18, 8, 14), mat(0xe8912d, { roughness: 0.8 })),
  },
  {
    id: "slopelab",
    label: "Slope lab",
    category: "parkour",
    collision: "both",
    make: () => buildSlopeLabGroup(),
  },
  {
    id: "jumplab",
    label: "Jump lab",
    category: "parkour",
    collision: "both",
    make: () => buildJumpLabGroup(),
  },
  {
    id: "glowbox",
    label: "Glow box",
    collision: "both",
    make: () => {
      const m = new THREE.Mesh(
        new THREE.BoxGeometry(6, 12, 3),
        mat(glowPropParams.color, {
          roughness: 0.5,
          emissive: glowPropParams.color,
          emissiveIntensity: glowPropParams.intensity,
        }),
      );
      m.geometry.translate(0, 6, 0); // rest on the ground
      m.userData.isGlow = true;
      return m;
    },
  },
  {
    id: "boostpad",
    label: "Boost pad",
    collision: "none", // flush decal — you drive through it; the field does the work
    make: () => flatPadGroup(BOOST_W, BOOST_D, 0x18ffd0, "BoostPad"),
    // Trigger zone (local box around `center`): while inside, accelerate along the
    // pad's forward (−Z). `apply` is the reusable effect hook (see applyFields).
    field: {
      center: [0, 1.5, 0],
      half: [BOOST_W / 2, 2.5, BOOST_D / 2],
      apply(vehicle, dt, fwd) {
        const body = vehicle.body;
        const target = 62; // ~223 km/h target speed along the pad
        const along = body.vel.dot(fwd);
        if (along < target) body.vel.addScaledVector(fwd, Math.min(150 * dt, target - along));
      },
    },
  },
  {
    id: "launchpad",
    label: "Launch pad",
    collision: "none",
    make: () => flatPadGroup(11, 12, 0xffae33, "LaunchPad"),
    // Flings the car UP (set, not add → one clean launch) with a forward arc.
    field: {
      center: [0, 1.5, 0],
      half: [5.5, 2.5, 6],
      apply(vehicle, dt, fwd) {
        const body = vehicle.body;
        const up = 18; // launch speed (≈16 m of air)
        if (body.vel.y < up) body.vel.y = up;
        const fwdTarget = 22; // a little forward so it arcs, not straight up
        const along = body.vel.dot(fwd);
        if (along < fwdTarget) body.vel.addScaledVector(fwd, Math.min(90 * dt, fwdTarget - along));
      },
    },
  },
  // Hidden from the Obstacles palette — same forward-boost role as BOOSTER tube
  // new (target ~70 vs ~68); kept for reference / restore.
  // {
  //   id: "boostring",
  //   label: "Boost ring",
  //   collision: "none",
  //   make: () => boostRingGroup(),
  //   // Slingshot forward when flying through the hole (trigger sits at the lifted
  //   // ring centre, a thin slab along the ring's axis).
  //   field: {
  //     // Tall, thin slab spanning the ring's vertical plane (ground → hole), so it
  //     // fires whether you drive through the arch or fly through the hole mid-jump.
  //     center: [0, 7, 0],
  //     half: [8, 9, 3.5],
  //     apply(vehicle, dt, fwd) {
  //       const body = vehicle.body;
  //       const target = 70; // strong punch through the gate
  //       const along = body.vel.dot(fwd);
  //       if (along < target) body.vel.addScaledVector(fwd, Math.min(700 * dt, target - along));
  //     },
  //   },
  // },
  {
    id: "boostdecal",
    label: "Boost decal",
    collision: "none", // pure paint — chevrons only, zero slab / tint
    make: () => flatDecalGroup(BOOST_W, BOOST_D, 0xffe048, "BoostDecal"),
    field: {
      center: [0, 1.5, 0],
      half: [BOOST_W / 2, 2.5, BOOST_D / 2],
      apply(vehicle, dt, fwd) {
        const body = vehicle.body;
        const target = 62; // same push as the boost pad — only the look differs
        const along = body.vel.dot(fwd);
        if (along < target) body.vel.addScaledVector(fwd, Math.min(150 * dt, target - along));
      },
    },
  },
  {
    id: "launchdecal",
    label: "Launch decal",
    collision: "none", // circular blue rings — one merged emissive mesh
    make: () => launchDecalGroup(5.5, 0x4ad2ff),
    field: {
      center: [0, 1.5, 0],
      half: [5.5, 2.5, 5.5],
      apply(vehicle, dt, fwd) {
        const body = vehicle.body;
        const up = 18; // same launch as the pad — set, not add → one clean pop
        if (body.vel.y < up) body.vel.y = up;
        const fwdTarget = 22;
        const along = body.vel.dot(fwd);
        if (along < fwdTarget) body.vel.addScaledVector(fwd, Math.min(90 * dt, fwdTarget - along));
      },
    },
  },
  // Hidden from the Obstacles palette — kept for reference / restore.
  // {
  //   id: "boosttube",
  //   label: "Booster (tube)",
  //   collision: "none",
  //   make: () => boostTubeGroup(),
  //   // The band's axis sits at the group origin (make() lifts the root by the
  //   // tube radius), so the field is a fat slab across the whole cross-section:
  //   // boost fires wherever you are on the tube wall — floor, side, or ceiling.
  //   field: {
  //     center: [0, 0, 0],
  //     half: [7.6, 7.6, 3],
  //     apply(vehicle, dt, fwd) {
  //       const body = vehicle.body;
  //       const target = 68; // punchier than the flat pad — tubes eat speed
  //       const along = body.vel.dot(fwd);
  //       if (along < target) body.vel.addScaledVector(fwd, Math.min(400 * dt, target - along));
  //     },
  //   },
  // },
  {
    id: "boosttubenew",
    label: "BOOSTER tube new",
    collision: "none",
    make: () => boostTubeGroupNew(),
    // Same trigger footprint / punch as the original tube booster — only the
    // look differs (purple open chevrons, no sleeve / mouth rings).
    field: {
      center: [0, 0, 0],
      half: [7.6, 7.6, 3],
      apply(vehicle, dt, fwd) {
        const body = vehicle.body;
        const target = 68;
        const along = body.vel.dot(fwd);
        if (along < target) body.vel.addScaledVector(fwd, Math.min(400 * dt, target - along));
      },
    },
  },
  {
    id: "kickerramp",
    label: "Convex kicker",
    category: "parkour",
    collision: "both",
    make: () =>
      new THREE.Mesh(
        kickerRampGeometry(14, 20, 7, 32),
        mat(0xc07840, { roughness: 0.82 }),
      ),
  },
  {
    id: "jumpkicker",
    label: "Jump ramp",
    category: "parkour",
    collision: "both",
    make: () =>
      new THREE.Mesh(
        jumpRampGeometry(14, 22, 8, 32),
        mat(0x886838, { roughness: 0.82 }),
      ),
  },
  {
    id: "tube",
    label: "Open cylinder",
    collision: "deck",
    make: () => openTubeGroup(),
  },
  {
    id: "cylinder_full",
    label: "Solid cylinder",
    collision: "both",
    make: () => {
      const r = 0.55;
      const len = 8;
      const m = new THREE.Mesh(
        new THREE.CylinderGeometry(r, r, len, 20),
        mat(0x707880, { roughness: 0.88 }),
      );
      m.geometry.rotateZ(Math.PI / 2); // axis along X — log lying on the floor
      m.geometry.translate(0, r, 0);
      return m;
    },
  },
  // Hidden from the Obstacles palette — same pass-through torus as Glow ring,
  // only a quiet gold look; kept for reference / restore.
  // {
  //   id: "ring",
  //   label: "Ring (gate)",
  //   collision: "none",
  //   make: () => {
  //     const m = new THREE.Mesh(
  //       new THREE.TorusGeometry(9, 1, 18, 56),
  //       mat(0xf1c40f, { metalness: 0.7, roughness: 0.3, emissive: 0x6b5300, emissiveIntensity: 0.4 }),
  //     );
  //     m.geometry.translate(0, 10, 0); // lift so the hole is off the ground
  //     return m;
  //   },
  // },
  {
    id: "glowring",
    label: "Glow ring",
    collision: "none",
    make: () => {
      // Orange emissive gate ring — same live-tuned glow params as the Glow box.
      // Leaner torus (was 18×56 / tube 1): still reads round at chase distance.
      const m = new THREE.Mesh(
        new THREE.TorusGeometry(9, 0.45, 10, 36),
        mat(glowPropParams.color, {
          roughness: 0.45,
          metalness: 0.0,
          emissive: glowPropParams.color,
          emissiveIntensity: glowPropParams.intensity,
        }),
      );
      m.geometry.translate(0, 10, 0); // lift so the hole clears the ground
      m.userData.isGlow = true;
      m.userData.noCastShadow = true;
      m.castShadow = false;
      return m;
    },
  },
  {
    id: "neongate",
    label: "Neon gate",
    /**
     * Angular checkpoint arch (chamfered corners, not a torus). Drive-through
     * only — `none` like the ring gates. Width follows `roadParams.width` so a
     * centred drop lands on the kerbs of a default straight.
     */
    collision: "none",
    make: () => neonGateGroup(),
  },

  // ── SCENERY ────────────────────────────────────────────────────────────────
  // Roadside dressing from the v2 objects lab, on its own palette tab because it
  // is not gameplay: obstacles are things you must avoid, these are things that
  // make the avoiding look like somewhere. See modularRoadScenery.js for how the
  // lab's spline objects become single placeable props (and for why their
  // materials have to be rebuilt before they go anywhere near v3's fog).
  //
  // `collision: "none"` refers to the TRIANGLE bake only — each of these carries
  // capsule colliders on its masts and legs, which is the channel that can
  // actually see something that thin.
  ...SCENERY_CATALOG.map((s) => ({
    id: s.id,
    label: s.label,
    // "none" unless the entry declares a solid wall — the RUN objects (fence,
    // wire) are lines you should not be able to drive through, and a line is the
    // one scenery shape capsules cannot cover. Their visible meshes opt out
    // per-mesh, so only the wall is in the bake. See solidWall in the scenery
    // module for why this is not just more capsules.
    collision: s.solidWall ? "solid" : "none",
    category: "scenery",
    make: () => makeSceneryProp(s.id) ?? new THREE.Group(),
  })),
];

export const PROP_BY_ID = new Map(PROP_CATALOG.map((p) => [p.id, p]));

/* ----------------------------------------------------------------------- */
/* Manager                                                                  */
/* ----------------------------------------------------------------------- */

export class PropManager {
  /**
   * @param {object} o
   * @param {THREE.Scene} o.scene
   * @param {THREE.Camera} o.camera
   * @param {HTMLElement} o.domElement
   * @param {import("three/addons/controls/OrbitControls.js").OrbitControls} o.orbit
   * @param {() => void} [o.onChange] fired when props are added/removed/moved (collision is now stale)
   * @param {() => void} [o.onSelect] fired when a prop is selected (deselect other gizmos)
   * @param {(x:number,y:number,z:number,mode:string)=>number|null} [o.getSurfaceY]
   *        surface height under a point for the current snap mode — see
   *        SURFACE_SNAP. `y` is the prop's current height; the search runs
   *        downward from there.
   */
  constructor({
    scene, camera, domElement, orbit,
    onChange = null, onSelect = null, onSelectionChange = null, getSurfaceY = null,
  }) {
    this.getSurfaceY = getSurfaceY;
    this.scene = scene;
    this.camera = camera;
    this.domElement = domElement;
    this.orbit = orbit;
    this.onChange = onChange;
    this.onSelect = onSelect;
    this.onSelectionChange = onSelectionChange;
    this.enabled = false;
    /** Handles down while a placement brush owns the pointer. See suspendGizmo. */
    this._gizmoSuspended = false;

    /** @type {{id:string, def:object, root:THREE.Object3D, collision:string}[]} */
    this.instances = [];
    this.selected = null;

    this.group = new THREE.Group();
    this.group.name = "RoadProps";
    scene.add(this.group);

    this.raycaster = new THREE.Raycaster();
    this._ndc = new THREE.Vector2();

    this.gizmo = new TransformControls(camera, domElement);
    this.gizmo.setMode("translate");
    this.gizmo.setSpace("local");
    this.gizmo.enabled = false;
    this.gizmo.visible = false;
    this.gizmo.size = 0.9;
    scene.add(this.gizmo.getHelper());

    this.selBox = new THREE.BoxHelper(new THREE.Object3D(), 0xffe066);
    this.selBox.visible = false;
    scene.add(this.selBox);

    this.gizmo.addEventListener("dragging-changed", (e) => {
      if (this.orbit) this.orbit.enabled = !e.value && this.enabled;
    });
    this.gizmo.addEventListener("change", () => {
      if (!this.selected) return;
      // LIVE while dragging, so the prop visibly hugs the surface as it moves
      // rather than snapping only on release. Translate mode only — during a
      // rotate or scale the position is not what is changing, and re-snapping
      // there would fight a prop deliberately tilted onto banking.
      if (this.gizmo.mode === "translate") this.snapToSurface(this.selected);
      this.selBox.setFromObject(this.selected.root);
    });
    // A gizmo drag is an AUTHORING act, so the pose it lands on becomes the new
    // authored one — see captureAuthored.
    this.gizmo.addEventListener("mouseUp", () => {
      this.captureAuthored(this.selected);
      this.onChange?.();
    });

    // NO RIGHT-CLICK LISTENER HERE ANY MORE. This used to select on its own,
    // on pointerDOWN, while the road builder selected on pointerUP — so a
    // right-click on something sitting on the road selected BOTH, and the
    // road's handler ran second and took the gizmo. roadGame now arbitrates
    // one right-click across every system via hitTest/selectHit.

    // Gizmo hotkeys run in the capture phase so they take priority over the
    // builder's bubble-phase shortcuts (e.g. R = flip, Backspace = undo).
    window.addEventListener("keydown", (e) => this._onKey(e), true);
  }

  get hasSelection() {
    return !!this.selected;
  }

  /** True while the user is grabbing/hovering a gizmo handle (suppress placing). */
  isUsingGizmo() {
    return this.enabled && (this.gizmo.dragging || this.gizmo.axis != null);
  }

  setEnabled(on) {
    this.enabled = on;
    if (!on) this.deselect();
  }

  /**
   * PUT THE MOVE TOOL DOWN WHILE A PLACEMENT BRUSH IS UP — without losing the
   * selection.
   *
   * TransformControls' pickers are INVISIBLE meshes far fatter than the drawn
   * arrows, and they scale to a constant screen size (`factor * size / 4`, i.e.
   * 0.2375 * size * canvasHeight pixels per gizmo unit). At size 0.9 on a 900 px
   * canvas that is a plus-shaped region ~230 px across, ~38 px thick, plus a
   * 38 px blob dead centre — and the picker raycast ignores occlusion, so a
   * handle behind a hill still counts. Merely HOVERING it sets `gizmo.axis`,
   * which is what `isUsingGizmo()` reports and what makes roadGame refuse the
   * place-click. Placing a prop right beside an already-selected one was
   * therefore impossible, and since `add()` selects what it just placed, laying
   * down a RUN of props re-armed the trap on every click.
   *
   * `setEnabled(false)` cannot be used for this: it deselects, and the whole
   * point is that the selection survives the brush.
   */
  suspendGizmo(on) {
    this._gizmoSuspended = !!on;
    // `pointerHover` early-returns while disabled, so a handle the pointer was
    // already over would stay latched in `axis` and keep eating clicks for as
    // long as the brush is armed.
    if (on) this.gizmo.axis = null;
    this._applyGizmoSuspend();
  }

  /**
   * Push the suspend state onto the gizmo. Called after every attach, because
   * `attach()` unconditionally shows the helper.
   *
   * `gizmo.visible` is NOT what hides it — TransformControls is a Controls, not
   * an Object3D; the helper returned by `getHelper()` owns visibility, and
   * attach/detach are what normally drive it.
   */
  _applyGizmoSuspend() {
    const attached = this.gizmo.object != null;
    const live = attached && !this._gizmoSuspended;
    this.gizmo.enabled = live;
    this.gizmo.getHelper().visible = live;
    this.selBox.visible = attached && !!this.selected;
  }

  setMode(mode) {
    this.gizmo.setMode(mode);
  }

  /**
   * Push the shared glow params onto every placed glow prop (box + ring).
   *
   * No mrtNode rebuild needed: the bloom node is `materialEmissive`, which three
   * resolves as emissive × emissiveIntensity through live uniform accessors — so
   * writing these three properties updates the glow AND the bloom together.
   */
  applyGlowParams() {
    for (const inst of this.instances) {
      if (inst.id !== "glowbox" && inst.id !== "glowring") continue;
      inst.root.traverse((o) => {
        if (o.isMesh && o.material) {
          o.material.color.set(glowPropParams.color);
          o.material.emissive.set(glowPropParams.color);
          o.material.emissiveIntensity = glowPropParams.intensity;
        }
      });
    }
    // The props are DRAWN from per-type instancing templates, which hold their
    // own copies of these materials — the loose roots above are only what the
    // gizmo and picking act on. Without this the slider would move numbers
    // nothing on screen was reading.
    this.onGlowChange?.(["glowbox", "glowring"]);
  }

  /**
   * Apply every placed "field" prop's effect to the car this frame (boost pads,
   * and future launch/slow/wind zones). Reusable trigger-zone test: transform the
   * car into each prop's local space, check its `field.half` box, and if inside
   * call `field.apply(vehicle, dt, padForward)`. Call once per drive-physics step.
   */
  applyFields(vehicle, dt) {
    if (!vehicle?.body) return;
    for (const inst of this.instances) {
      const f = inst.def.field;
      if (!f) continue;
      const root = inst.root;
      root.updateMatrixWorld();
      _fieldInv.copy(root.matrixWorld).invert();
      _fieldLocal.copy(vehicle.body.pos).applyMatrix4(_fieldInv); // car in pad space
      const [hx, hy, hz] = f.half;
      const cx = f.center?.[0] ?? 0;
      const cy = f.center?.[1] ?? 0;
      const cz = f.center?.[2] ?? 0;
      if (
        Math.abs(_fieldLocal.x - cx) <= hx &&
        Math.abs(_fieldLocal.y - cy) <= hy &&
        Math.abs(_fieldLocal.z - cz) <= hz
      ) {
        // Pad forward = local −Z in world, flattened horizontal.
        _fieldFwd.set(0, 0, -1).applyQuaternion(root.quaternion);
        _fieldFwd.y = 0;
        if (_fieldFwd.lengthSq() > 1e-6) {
          _fieldFwd.normalize();
          f.apply(vehicle, dt, _fieldFwd, root);
        }
      }
    }
  }

  /**
   * Spawn a prop and select it.
   *
   * @param {string} typeId
   * @param {THREE.Vector3|null} [worldPos] where to put it. This is the normal
   *        path — the palette arms a cursor BRUSH and the game passes the point
   *        under the mouse. Omitting it falls back to the camera's orbit target,
   *        which is what the API-only callers (and track import) use.
   */
  add(typeId, worldPos = null) {
    this.onSelect?.();
    const def = PROP_BY_ID.get(typeId);
    if (!def) return null;
    const root = def.make();
    enableMeshShadows(root);
    root.userData.isProp = true;
    // `restY` is the offset make() authored — 0 for ground-flush props, or a
    // deliberate lift like the pipe's radius. Captured BEFORE the spawn position
    // overwrites y, so snapping can add it back and keep the prop's feet on the
    // surface. (Read straight off root.position.y below, this silently became
    // the CAMERA's height the moment the spawn started setting y.)
    const restY = root.position.y;
    if (worldPos) {
      // Placed under the cursor: the caller already picked a real surface point,
      // so the snap below only has to re-add restY and resolve the mode.
      root.position.copy(worldPos);
    } else if (this.orbit?.target) {
      // Spawn where the camera is looking — INCLUDING its height.
      //
      // This used to take x/z only and leave y at `restY`, so the downward
      // surface search started ~2 m above the world floor. That is fine on a
      // ground-level track and wrong everywhere else: the game's default build
      // height is 40 m (DEFAULT_BUILD_HEIGHT), and a deck up there is ABOVE the
      // ray, so it can never be hit. MEASURED with a deck at y=40.5:
      //     auto/ground → y=0.5, the terrain 40 m BELOW the track
      //     road        → refused, prop left at y=0 with no feedback
      // i.e. in the mode the game boots in, every prop landed under the road.
      //
      // The old comment justified it as "don't yank it up to the camera's y,
      // which is what made props hover" — true BEFORE snapToSurface existed and
      // nothing pulled them back down. It now sets y = surface + restY, so
      // seeding from the camera lands the prop ON the deck rather than above it.
      // MoverPropManager.add() has always used the full target for this reason.
      root.position.copy(this.orbit.target);
    }
    this.group.add(root);
    const inst = { id: typeId, def, root, collision: def.collision, restY };
    // A new placement picks its own livery, so a run of containers is a yard
    // rather than a warehouse order. Costs nothing to draw — see `variants`.
    setVariant(inst, def.variants ? Math.floor(Math.random() * def.variants.length) : 0);
    // OFF by default. Branding is a decision, not a default: a yard where boxes
    // randomly carry a logo is not something you can author, because you cannot
    // tell what you asked for from what the dice gave you. Turn it on per prop
    // (panel toggle or V), or on everything of a type at once.
    inst.decal = false;
    root.userData.propInstance = inst;
    this.instances.push(inst);
    // A PROP YOU JUST ADDED MUST NEVER BE LEFT HANGING IN MID-AIR.
    //
    // Spawning at the camera's height (above) is what lets a prop land on the
    // elevated deck you are looking at — but it also means the spawn point is
    // EMPTY SPACE, so a snap that finds nothing leaves the prop floating there
    // rather than near the ground. "road" is the mode that can fail: it returns
    // null rather than falling back to terrain, deliberately, so that dragging a
    // prop off the road does not silently teleport it downhill. MEASURED with a
    // deck at y=40.5 and the camera on it but off to one side:
    //     road, no deck under the camera → prop left at y=39.2, in the sky
    // That refusal is right for a DRAG (there is a previous position worth
    // keeping) and wrong for a PLACEMENT (there is not).
    //
    // So placement falls back to `auto` — road if there is any, else terrain.
    // "free" is exempt: it means "do not move my prop", and spawning at the
    // camera is precisely what you want when you are about to place it by hand.
    if (!this.snapToSurface(inst) && SURFACE_SNAP.mode !== "free") {
      this.snapToSurface(inst, "auto");
    }
    this.captureAuthored(inst);
    this._select(inst);
    this.onChange?.();
    return inst;
  }

  duplicateSelected() {
    if (!this.selected) return;
    const src = this.selected;
    const root = src.def.make();
    enableMeshShadows(root);
    root.userData.isProp = true;
    root.position.copy(src.root.position).add(new V3(4, 0, 4));
    root.quaternion.copy(src.root.quaternion);
    root.scale.copy(src.root.scale);
    this.group.add(root);
    const inst = { id: src.id, def: src.def, root, collision: src.collision, restY: src.restY ?? 0 };
    setVariant(inst, src.variant ?? 0); // a duplicate keeps its original's livery
    inst.decal = !!src.decal;
    root.userData.propInstance = inst;
    this.instances.push(inst);
    this.snapToSurface(inst); // the +4,+4 offset may have landed on a different surface
    this.captureAuthored(inst);
    this._select(inst);
    this.onChange?.();
  }

  deleteSelected() {
    if (!this.selected) return;
    this._removeInstance(this.selected);
    this.selected = null;
    this.gizmo.detach();
    this.gizmo.enabled = false;
    this.gizmo.getHelper().visible = false;
    this.selBox.visible = false;
    this.onChange?.();
  }

  clear() {
    this.deselect();
    for (const inst of this.instances) this._disposeInstance(inst);
    this.instances = [];
    this.onChange?.();
  }

  deselect() {
    const had = !!this.selected;
    this.selected = null;
    this.gizmo.detach();
    this.gizmo.enabled = false;
    this.gizmo.getHelper().visible = false;
    this.selBox.visible = false;
    if (had) this.onSelectionChange?.(null);
  }

  /**
   * Drop a prop onto the surface under it, preserving its authored rest offset.
   *
   * `restY` is whatever `make()` left on the root — for most props 0 (they are
   * authored ground-flush), for others a deliberate offset like the pipe's
   * radius or the cone's collision radius. Adding it back is what keeps a cone's
   * BASE on the road rather than burying it by a radius.
   *
   * @returns {boolean} true if it moved (i.e. a surface was found)
   */
  snapToSurface(inst, modeOverride = null) {
    if (!inst || !this.getSurfaceY) return false;
    const mode = modeOverride ?? SURFACE_SNAP.mode;
    if (mode === "free") return false;
    const p = inst.root.position;
    // The prop's CURRENT height is passed so the search looks DOWNWARD from
    // where it already is. That is what makes "auto" behave: a prop sitting on
    // the terrain under an elevated road finds the terrain, not the deck 20 m
    // above it — while dragging the same prop up onto the road finds the deck.
    const y = this.getSurfaceY(p.x, p.y, p.z, mode);
    if (y === null || y === undefined || !Number.isFinite(y)) return false;
    p.y = y + (inst.restY ?? 0);
    // Snapping is an EDITOR move, so the height it lands on is authored — see
    // captureAuthored. Captured here rather than at each call site because
    // there are four of them (add, duplicate, the live gizmo drag, snapAll) plus
    // the game's own snap-mode shortcut, and the two that were missed —
    // snapAll() after a track load, and re-snapping the selection when the
    // placement mode changes — would have silently saved the OLD height.
    // Nothing outside the editor calls this: the sims move roots directly.
    this.captureAuthored(inst);
    return true;
  }

  /**
   * Record where the EDITOR just put this prop — its authored pose.
   *
   * THE ROOT TRANSFORM IS NOT THE AUTHORED POSE for anything PropPhysics
   * simulates. The hinge sim writes `home × swing` onto a gate's root every
   * tick, and the body sim writes a knocked cone's tumbling pose, so the root is
   * "where this prop happens to be right now". Only the editor's own placements
   * are authorship, and they are exactly the call sites of this method.
   *
   * Without the distinction, `exportInstances()` saved the LIVE root and the
   * displacement became permanent. Reported as a swing gate that comes back from
   * a saved track "not in the rotation I placed it, and with no collision":
   * drive through a gate, switch to build (nothing resets props on the way in),
   * save — and the panel's swing angle was baked into the saved rotation. On
   * load that pose became the new `home`, so the gate stood permanently part-open
   * across the track instead of closed over it, which is what "no collision"
   * was: the panel is no longer where the doorway is. MEASURED in
   * tools/gateSaveLoadTest.mjs — a gate placed at 37° and saved with the panel
   * 51.6° open reloaded at 88.6°.
   */
  /**
   * Turn the selection by an EXACT angle about one of its own axes.
   *
   * Road pieces got arrow-key steps; obstacles had only a gizmo drag, so a boost
   * pad you wanted at exactly 45° was a matter of dragging and squinting. The
   * step itself comes from roadGame (the builder's Angle step), so a prop and
   * a road piece turn by the same amount — there is one setting, not two.
   *
   * LOCAL axes, composed on the right, matching what the rotate gizmo produces
   * in its default local space and what the road's own nudge does.
   *
   * @param {"yaw"|"pitch"|"roll"} axis
   * @param {number} radians
   */
  rotateSelectedBy(axis, radians) {
    const inst = this.selected;
    if (!inst) return false;
    const v = axis === "pitch" ? new THREE.Vector3(1, 0, 0)
      : axis === "roll" ? new THREE.Vector3(0, 0, 1)
        : new THREE.Vector3(0, 1, 0);
    const root = inst.root ?? inst;
    root.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(v, radians));
    root.updateMatrixWorld(true);
    // Same bookkeeping a gizmo drag does on mouseUp, or the pose is lost on save.
    // Optional-chained so all three systems share one shape: only props HAVE an
    // authored snapshot (a gate's panel animates, so its authored pose has to be
    // kept apart from the live one).
    this.captureAuthored?.(inst);
    this.onChange?.();
    return true;
  }

  captureAuthored(inst) {
    if (!inst) return;
    inst.authoredPos = inst.root.position.clone();
    inst.authoredQuat = inst.root.quaternion.clone();
  }

  /** Liveries available on the selection, or [] — drives the panel swatches. */
  get selectedVariants() { return this.selected?.def?.variants ?? []; }

  /**
   * Set the selected prop's livery.
   *
   * `onVariantChange` rather than a direct call into the instancer, because
   * PropManager does not know how its props are drawn — the tint lives on the
   * instance and something else has to notice it moved.
   */
  setSelectedVariant(index) {
    if (!this.selected?.def?.variants?.length) return false;
    setVariant(this.selected, index);
    this.onVariantChange?.(this.selected);
    return true;
  }

  /**
   * Turn the selected prop's decal on or off.
   *
   * Same `onVariantChange` hook as the livery: what changed is a property of the
   * prop INSTANCE, and the thing that draws it has to be told to re-read.
   */
  setSelectedDecal(on) {
    if (!this.selected?.def?.decal) return false;
    this.selected.decal = !!on;
    this.onVariantChange?.(this.selected);
    return true;
  }

  /** Step the selected prop's livery. `dir` −1 or +1. */
  cycleVariant(dir = 1) {
    if (!this.selected?.def?.variants?.length) return false;
    return this.setSelectedVariant(this.selected.variant + dir);
  }

  /** Re-roll every placement of `typeId` (or everything) — instant yard. */
  randomiseVariants(typeId = null) {
    let n = 0;
    for (const inst of this.instances) {
      const list = inst.def?.variants;
      if (!list?.length) continue;
      if (typeId && inst.id !== typeId) continue;
      setVariant(inst, Math.floor(Math.random() * list.length));
      n++;
    }
    if (n) this.onVariantChange?.(null);
    return n;
  }

  /**
   * Snap a placement onto the prop it is landing on, if they stack.
   *
   * Containers are the original case: they are the one prop you place in runs
   * and towers, and a stack is only convincing if the boxes line up exactly.
   * Tyres use the same path so you can build a wall — click ON one to add a
   * course, click BESIDE one to extend the row.
   *
   * The vertical half is free for anything in the deck bake (a container roof
   * is a placement hit). Physics props are `collision: "none"` so the ray goes
   * through them onto the road; those use the footprint in XZ instead, and a
   * side pad for the neighbour slot.
   *
   * Snapping to the SUPPORTING PROP rather than to a world grid is what makes
   * it work at any angle: a rotated stack lines up just as well as an
   * axis-aligned one, because the alignment is copied from what is underneath.
   *
   * @param {string} typeId what is being placed
   * @param {THREE.Vector3} point where the placement ray hit
   * @param {THREE.Raycaster} [ray] the view ray — used to hit physics-prop
   *   meshes that the deck BVH cannot see
   * @returns {{position: THREE.Vector3, quaternion: THREE.Quaternion}|null}
   */
  stackSnap(typeId, point, ray = null) {
    const def = PROP_BY_ID.get(typeId);
    const size = def?.stack;
    if (!size || !point) return null;
    const baked = def.collision && def.collision !== "none";
    const hx = size.length / 2;
    const hz = size.width / 2;
    const slack = Math.max(0.45, Math.min(hx, hz) * 0.25);

    // Physics props are invisible to the placement ray, so from a shallow
    // editor camera the ground hit through a tyre is often a metre behind it.
    // If we can see the MESH, that is the stack target — and we sit on the
    // tallest in that column so a 3-high wall keeps growing from the top.
    if (!baked && ray) {
      let bestMesh = null;
      let bestDist = Infinity;
      for (const inst of this.instances) {
        if (inst.id !== typeId) continue;
        const hits = ray.intersectObject(inst.root, true);
        const h = hits[0];
        if (!h || h.distance >= bestDist) continue;
        bestDist = h.distance;
        bestMesh = inst;
      }
      if (bestMesh) {
        let topInst = bestMesh;
        let top = bestMesh.root.position.y + size.height;
        const bx = bestMesh.root.position.x;
        const bz = bestMesh.root.position.z;
        for (const inst of this.instances) {
          if (inst.id !== typeId) continue;
          const dx = inst.root.position.x - bx;
          const dz = inst.root.position.z - bz;
          if (dx * dx + dz * dz > 0.05) continue;
          const t = inst.root.position.y + size.height;
          if (t > top) { top = t; topInst = inst; }
        }
        return {
          position: new THREE.Vector3(topInst.root.position.x, top, topInst.root.position.z),
          quaternion: topInst.root.quaternion.clone(),
        };
      }
    }

    let bestRoof = null;
    let bestSide = null;
    let bestSideD2 = Infinity;
    for (const inst of this.instances) {
      if (inst.id !== typeId) continue;
      const base = inst.root.position;
      const top = base.y + size.height;
      _stackLocal.copy(point).sub(base).applyQuaternion(
        _stackQuat.copy(inst.root.quaternion).invert(),
      );
      const ax = Math.abs(_stackLocal.x);
      const az = Math.abs(_stackLocal.z);
      const inside = ax <= hx && az <= hz;

      if (inside) {
        // Baked props: the ray has to actually hit the roof. Physics props are
        // invisible to the placement ray, so "inside the footprint" from above
        // is the stack cue — the hit is the ground THROUGH them.
        const yOk = baked
          ? Math.abs(point.y - top) <= 0.25
          : point.y <= top + 0.25;
        if (yOk && (!bestRoof || top > bestRoof.top)) bestRoof = { inst, top };
      }

      const feetY = base.y - (inst.restY ?? 0);
      if (Math.abs(point.y - feetY) > 0.4) continue;
      if (ax > hx + slack || az > hz + slack) continue;
      if (inside) continue;
      let dx = 0, dz = 0;
      if (ax > hx) dx = Math.sign(_stackLocal.x) * size.length;
      if (az > hz) dz = Math.sign(_stackLocal.z) * size.width;
      if (dx === 0 && dz === 0) continue;
      const d2 = (point.x - base.x) ** 2 + (point.z - base.z) ** 2;
      if (d2 < bestSideD2) {
        bestSideD2 = d2;
        bestSide = { inst, dx, dz };
      }
    }
    if (bestRoof) {
      return {
        position: new THREE.Vector3(bestRoof.inst.root.position.x, bestRoof.top, bestRoof.inst.root.position.z),
        quaternion: bestRoof.inst.root.quaternion.clone(),
      };
    }
    if (bestSide) {
      _stackOff.set(bestSide.dx, 0, bestSide.dz).applyQuaternion(bestSide.inst.root.quaternion);
      return {
        position: new THREE.Vector3(
          bestSide.inst.root.position.x + _stackOff.x,
          bestSide.inst.root.position.y,
          bestSide.inst.root.position.z + _stackOff.z,
        ),
        quaternion: bestSide.inst.root.quaternion.clone(),
      };
    }
    return null;
  }

  /** Re-snap every prop — after a track load, or a snap-mode change. */
  snapAll() {
    let n = 0;
    for (const inst of this.instances) if (this.snapToSurface(inst)) n++;
    if (n) this.onChange?.();
    return n;
  }

  /** Meshes split by collision role, for the page's BVH bake. */
  collisionMeshes() {
    const deck = [];
    const solids = [];
    for (const inst of this.instances) {
      if (inst.collision === "none") continue;
      inst.root.traverse((o) => {
        if (!o.isMesh) return;
        // PER-MESH OPT-OUT. A prop can be part static, part simulated — the swing
        // gate's POST never moves and must be solid, while its PANEL is driven by
        // PropPhysics and would be welded into the static bake as an invisible
        // wall across the doorway. The prop-level `collision` flag alone cannot
        // express that, so a mesh may exclude itself.
        //
        // `capsule` implies the same exclusion: that mesh is collided EXACTLY as
        // a primitive instead (see collisionCapsules), and having it in both
        // channels would resolve the same contact twice.
        if (o.userData.noCollide || o.userData.capsule) return;
        if (inst.collision === "deck" || inst.collision === "both") {
          // A DECK-ONLY STAND-IN, when the shape has one.
          //
          // "both" means drive on top AND be blocked at the sides, and it used
          // to express that by putting the identical closed solid in both
          // channels — so every band that merely CLOSES the mesh (a ramp's
          // underside, its flanks, the vertical cap at its lip) became a
          // surface the wheels probe and the deck-contact spring pushes off.
          // Measured on the jump ramp: 11–16 kN out of the end cap at the exact
          // moment of takeoff (tools/jumpRampChannels.mjs).
          //
          // Same stand-in pattern the road pieces and rails already use in
          // roadGame's bakeCollision, and the same shape of object — bakeFromMeshes
          // reads only `.geometry` and `.matrixWorld`, and calls
          // updateMatrixWorld() — so the world transform is still the prop's own,
          // live, by reference.
          const proxy = o.geometry?.userData?.deckGeometry;
          deck.push(proxy
            ? { geometry: proxy, matrixWorld: o.matrixWorld, updateMatrixWorld() {} }
            : o);
        }
        // SOLIDS KEEP THE WHOLE SOLID. Driving into a ramp's flank or its end
        // wall should stop you; only probing them as GROUND was ever wrong.
        if (inst.collision === "solid" || inst.collision === "both") solids.push(o);
      });
    }
    return { deck, solids };
  }

  /**
   * World-space capsule colliders, from meshes tagged
   * `userData.capsule = { radius, height }`.
   *
   * A ROUND POST IS NOT A TRIANGLE PROBLEM. The chassis is collided against
   * triangle geometry by SAMPLING its hull surface, and sample spacing is a
   * hard floor on how thin an obstacle can be and still register — a 0.22 m gate
   * post fell straight between the samples and the car drove through it
   * (measured in tools/postColliderRepro.mjs). Handing the vehicle the primitive
   * instead removes the floor entirely: it solves closest-point exactly, so the
   * post registers at every approach angle and speed.
   *
   * The capsule is taken along the mesh's own local +Y, so it follows any
   * rotation the prop was placed with.
   */
  collisionCapsules() {
    const out = [];
    for (const inst of this.instances) {
      inst.root.traverse((o) => {
        const c = o.userData.capsule;
        if (!c) return;
        o.updateWorldMatrix(true, false);
        const mid = new THREE.Vector3().setFromMatrixPosition(o.matrixWorld);
        // The mesh's local up, in world space — NOT (0,1,0), or a gate placed on
        // a banked piece would get an upright collider through a leaning post.
        const up = new THREE.Vector3(0, 1, 0)
          .transformDirection(o.matrixWorld).normalize();
        // Capsule ENDS are the sphere centres, so they sit a radius inside each
        // flat end of the cylinder the artist authored.
        const half = Math.max(0, c.height / 2 - c.radius);
        out.push({
          a: mid.clone().addScaledVector(up, -half),
          b: mid.clone().addScaledVector(up, half),
          radius: c.radius,
        });
      });
    }
    return out;
  }

  /** @returns {{type:string, position:number[], quaternion:number[], scale:number[]}[]} */
  /**
   * A track saves where props were PUT, not where the sim has shoved them —
   * see captureAuthored. The fallback to the live root keeps props that predate
   * authored poses (and any prop nothing has ever authored) exporting exactly as
   * before, so this cannot change a save that was already correct.
   */
  exportInstances() {
    return this.instances.map((inst) => ({
      type: inst.id,
      position: (inst.authoredPos ?? inst.root.position).toArray(),
      quaternion: (inst.authoredQuat ?? inst.root.quaternion).toArray(),
      scale: inst.root.scale.toArray(),
      // Only written when the prop actually has variants, so existing tracks
      // round-trip byte-identical and an older file simply loads as variant 0.
      ...(inst.def?.variants?.length ? { variant: inst.variant } : {}),
      ...(inst.decal ? { decal: true } : {}),
    }));
  }

  /**
   * @param {{type:string, position:number[], quaternion:number[], scale:number[]}[]} list
   *
   * REUSES THE PROPS IT ALREADY HAS, matched by type, instead of disposing every
   * instance and re-`make()`ing the lot.
   *
   * This used to be a load-only path, where a 13 ms rebuild is invisible. It is
   * now also how UNDO restores the prop layer (see registerHistoryLayer in
   * roadGame), and there it sits behind Ctrl+Z: measured at **0.675 ms per
   * prop**, so undoing a single cone drag on a 20-prop track cost 13.5 ms and a
   * 300-prop track would have hitched for ~200 ms. Almost all of that is
   * `def.make()` building geometry that is about to be identical.
   *
   * Undo is the case this is shaped for: the list is the SAME props in the same
   * order with one transform different, so every one of them is pooled and the
   * work drops to writing a position.
   *
   * Reuse needs the item to carry a full pose — `exportInstances` always writes
   * one, so this is every real save. A hand-trimmed entry missing its quaternion
   * or scale falls through to a fresh `make()` rather than inheriting whatever
   * the pooled prop happened to be wearing.
   */
  importInstances(list) {
    this.deselect();
    /** Leftovers from the outgoing layout, bucketed by type. @type {Map<string, object[]>} */
    const pool = new Map();
    for (const inst of this.instances) {
      const bucket = pool.get(inst.id);
      if (bucket) bucket.push(inst);
      else pool.set(inst.id, [inst]);
    }
    this.instances = [];
    for (const item of (Array.isArray(list) ? list : [])) {
      const def = PROP_BY_ID.get(item.type);
      if (!def || !Array.isArray(item.position)) continue;
      const hasFullPose = Array.isArray(item.quaternion) && item.quaternion.length === 4
        && Array.isArray(item.scale) && item.scale.length === 3;
      let inst = hasFullPose ? pool.get(item.type)?.pop() : null;
      if (!inst) {
        const root = def.make();
        enableMeshShadows(root);
        root.userData.isProp = true;
        // Read the authored rest offset BEFORE the saved position overwrites it.
        inst = { id: item.type, def, root, collision: def.collision, restY: root.position.y };
        this.group.add(root);
      }
      // NOT recomputed for a pooled prop: `restY` is the offset its `make()` left
      // on the root, and the root is currently wearing a SAVED position. Reading
      // it here would bake the last placement's height in as the rest offset.
      const { root } = inst;
      root.position.fromArray(item.position);
      if (Array.isArray(item.quaternion) && item.quaternion.length === 4) {
        root.quaternion.fromArray(item.quaternion);
      }
      if (Array.isArray(item.scale) && item.scale.length === 3) {
        root.scale.fromArray(item.scale);
      }
      // Both are plain fields on the instance — no mesh to rebuild — so they
      // re-apply to a pooled prop exactly as they do to a fresh one.
      setVariant(inst, item.variant ?? 0);
      inst.decal = !!item.decal;
      root.userData.propInstance = inst;
      // A loaded pose IS the authored pose — the file is the authorship.
      this.captureAuthored(inst);
      this.instances.push(inst);
    }
    // Whatever the incoming layout had no use for.
    for (const bucket of pool.values()) for (const inst of bucket) this._disposeInstance(inst);
    this.onChange?.();
  }

  /* ----- internals ----- */

  _select(inst) {
    this.onSelect?.();
    this.selected = inst;
    this.gizmo.attach(inst.root);
    this.selBox.setFromObject(inst.root);
    // Not `enabled = true` outright: placing a prop SELECTS it, and if a brush
    // is still armed that fresh gizmo would sit exactly where the next click is
    // going. See suspendGizmo.
    this._applyGizmoSuspend();
    // AFTER the assignment, unlike onSelect — which fires first because its job
    // is to clear the other gizmos, and so still sees the previous selection.
    // Anything that renders the selection needs this one.
    this.onSelectionChange?.(inst);
  }

  /**
   * Nearest prop under the cursor and HOW FAR AWAY it is — no selecting.
   *
   * Right-click selection is arbitrated in one place now (see roadGame): props,
   * movers, portals and the road builder each answer this, and whatever is
   * nearest the camera wins. Four independent pickers is what put a boost pad
   * and the road beneath it both into selection at once — and on two different
   * events, so the road's ran second and stole the gizmo the prop had claimed.
   *
   * Iterates the hits rather than taking [0]: the first intersection may be a
   * child with no instance ancestor, and giving up on it would report "nothing
   * here" for something plainly under the pointer.
   */
  hitTest(clientX, clientY) {
    if (!this.enabled) return null;
    const rect = this.domElement.getBoundingClientRect();
    this._ndc.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this._ndc, this.camera);
    for (const h of this.raycaster.intersectObjects(this.group.children, true)) {
      let o = h.object;
      while (o && !o.userData.propInstance) o = o.parent;
      if (o?.userData.propInstance) return { dist: h.distance, hit: o.userData.propInstance };
    }
    return null;
  }

  /** Select what `hitTest` found (or clear, with null). Used by the arbiter. */
  selectHit(hit) {
    if (hit) this._select(hit);
    else this.deselect();
  }

  _onKey(e) {
    if (!this.enabled || !this.selected) return;
    if (e.target instanceof HTMLInputElement) return;
    let handled = true;
    switch (e.code) {
      case "KeyW": this.setMode("translate"); break;
      // Shift+E too: that is the road builder's "rotate" and the habit
      // should not stop working because you clicked an obstacle.
      case "KeyE": this.setMode("rotate"); break;
      case "KeyR": this.setMode("scale"); break;
      // X, NOT Q. Q is the road builder's yaw nudge; having it mean
      // "toggle axes" whenever an obstacle happened to be selected was one
      // key with two meanings. X is world/local everywhere now.
      case "KeyX": this.gizmo.setSpace(this.gizmo.space === "local" ? "world" : "local"); break;
      case "Delete": case "Backspace": this.deleteSelected(); break;
      case "Escape": this.deselect(); break;
      case "KeyD": if (e.ctrlKey || e.metaKey) this.duplicateSelected(); else handled = false; break;
      // Next livery on the selected prop. A key as well as the panel swatches
      // because cycling while you look at it is how you actually pick a colour.
      case "KeyC": handled = this.cycleVariant(e.shiftKey ? -1 : 1); break;
      case "KeyV": handled = this.setSelectedDecal(!this.selected.decal); break;
      default: handled = false;
    }
    if (handled) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }

  _removeInstance(inst) {
    const i = this.instances.indexOf(inst);
    if (i >= 0) this.instances.splice(i, 1);
    this._disposeInstance(inst);
  }

  _disposeInstance(inst) {
    this.group.remove(inst.root);
    inst.root.traverse((o) => {
      if (!o.isMesh) return;
      // The deck stand-in is a second geometry riding on the first (see
      // collisionMeshes), so disposing only the visible one leaks it — and
      // importInstances disposes EVERY prop on every track load.
      o.geometry?.userData?.deckGeometry?.dispose?.();
      // Template-backed props (scenery, container, tire wall) hand out clones
      // that share ONE cached geometry per type, so deleting a single floodlight
      // must not free the buffers the others are still drawing with.
      if (!isSharedGeometry(o.geometry)) o.geometry?.dispose?.();
    });
  }
}
