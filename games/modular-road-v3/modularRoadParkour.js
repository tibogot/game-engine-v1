import * as THREE from "three";
import { materialColor } from "three/tsl";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { RigidBvh } from "../../v3/play/modularRoadRigidBvh.js";

/**
 * Shared geometry + ParkourMover — used by placeable static props and moving obstacles.
 */

/** Enable directional-light shadows on every mesh under root.
 *  Meshes marked `userData.noCastShadow` still receive, but never cast
 *  (glow rings, paint — shadow cost with nothing useful on the ground). */
export function enableMeshShadows(root) {
  root.traverse((o) => {
    if (o.isMesh) {
      if (!o.userData.noCastShadow) o.castShadow = true;
      o.receiveShadow = true;
    }
  });
}

/* ----------------------------------------------------------------------- */
/* Geometry helpers                                                         */
/* ----------------------------------------------------------------------- */

/**
 * Hang a DRIVE-SURFACE-ONLY stand-in off a closed solid's geometry.
 *
 * A `collision: "both"` prop is baked into the DECK BVH — what the wheels
 * probe and what the chassis deck-contact spring measures against — as well as
 * the solids BVH. With no stand-in, both channels get the same closed solid, so
 * every band whose only job is to CLOSE the mesh becomes a driving surface: an
 * underside, a flank, and worst of all the vertical cap at a ramp's lip, which
 * on the jump ramp is an 8 m wall standing exactly where the car takes off.
 *
 * MEASURED (tools/jumpRampChannels.mjs): crossing that lip, the deck-contact
 * spring fired 11–16 kN off the cap — horizontally, the cap's normal being
 * horizontal — while the car's own suspension carried at most 45 kN. Nothing
 * else on the ramp produced a deck force at all. Same shape of bug as the half
 * tube's rim caps (see buildOpenLipCollision): a closing band has no business
 * being ground.
 *
 * Carried on the GEOMETRY rather than the mesh, so it cannot come unstuck from
 * the shape it stands in for and a prop's make() needs to do nothing to opt in.
 * PropManager.collisionMeshes routes it to the deck channel; SOLIDS still get
 * the whole solid, because driving into a ramp's flank or its end wall should
 * of course still stop you. Only probing them as GROUND was ever wrong.
 *
 * @param {THREE.BufferGeometry} geo the closed solid, returned unchanged
 * @param {number[]} deckPositions flat xyz triples of the drive surface only
 */
export function attachDeckProxy(geo, deckPositions) {
  const deck = new THREE.BufferGeometry();
  deck.setAttribute("position", new THREE.Float32BufferAttribute(deckPositions, 3));
  deck.computeVertexNormals();
  deck.computeBoundingSphere();
  geo.userData.deckGeometry = deck;
  return geo;
}

/**
 * Hang a SOLIDS-ONLY stand-in off a closed solid.
 *
 * `collision: "both"` still bakes the whole mesh into the solids BVH when this
 * is missing — including the drive surface and the vertical lip cap. Hull
 * samples that dip into the wedge at takeoff then get shoved out that cap
 * (and along the steep last deck triangles), which is the "straight up at
 * the tip" pop. PropManager.collisionMeshes already honours
 * `geometry.userData.solidGeometry` the same way it honours the deck proxy.
 */
export function attachSolidProxy(geo, solidPositions) {
  const solid = new THREE.BufferGeometry();
  solid.setAttribute("position", new THREE.Float32BufferAttribute(solidPositions, 3));
  solid.computeVertexNormals();
  solid.computeBoundingSphere();
  geo.userData.solidGeometry = solid;
  return geo;
}

/** Drive ramp: low edge at y=0, z=0 (local); rises toward -Z. */
export function rampGeometry(w, l, angleRad) {
  const H = l * Math.sin(angleRad);
  const hw = w / 2;
  const zN = 0;
  const zF = -l;
  const Al = [-hw, 0, zN],
    Bl = [-hw, 0, zF],
    Cl = [-hw, H, zF];
  const Ar = [hw, 0, zN],
    Br = [hw, 0, zF],
    Cr = [hw, H, zF];
  // The sloped top on its own first — see attachDeckProxy. The vertical back
  // (Bl-Cl-Cr-Br) is this shape's lip cap and must not be drivable.
  const deckPos = [];
  const deckQuad = (a, b, c, d) => deckPos.push(...a, ...b, ...c, ...a, ...c, ...d);
  deckQuad(Al, Ar, Cr, Cl);

  const pos = deckPos.slice();
  const quad = (a, b, c, d) => pos.push(...a, ...b, ...c, ...a, ...c, ...d);
  const tri = (a, b, c) => pos.push(...a, ...b, ...c);
  quad(Al, Bl, Br, Ar);
  quad(Bl, Cl, Cr, Br);
  tri(Al, Cl, Bl);
  tri(Ar, Br, Cr);

  const TILE = 6; // same diamond-plate tile as the parkour platform
  const uvs = [];
  for (let i = 0; i < pos.length; i += 9) {
    const a = [pos[i], pos[i + 1], pos[i + 2]];
    const b = [pos[i + 3], pos[i + 4], pos[i + 5]];
    const c = [pos[i + 6], pos[i + 7], pos[i + 8]];
    const e1x = b[0] - a[0], e1y = b[1] - a[1], e1z = b[2] - a[2];
    const e2x = c[0] - a[0], e2y = c[1] - a[1], e2z = c[2] - a[2];
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
    const uvOf = (p) => {
      if (ay >= ax && ay >= az) return [p[0] / TILE, p[2] / TILE];
      if (ax >= az) return [p[2] / TILE, p[1] / TILE];
      return [p[0] / TILE, p[1] / TILE];
    };
    const ua = uvOf(a), ub = uvOf(b), uc = uvOf(c);
    uvs.push(ua[0], ua[1], ub[0], ub[1], uc[0], uc[1]);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  attachDeckProxy(geo, deckPos);
  return attachWedgeCheekSolids(geo, w, l, H, (t, rise) => t * rise);
}

/**
 * Thick-walled tube shell — smooth curved walls + flat end rings.
 *
 * A single Lathe of a rectangular profile shares vertices at the 90° corners
 * where the annular end meets the inner/outer walls, so averaged normals shade
 * the rim blotchy. This builds four pieces instead (open outer + flipped inner
 * cylinders, two RingGeometry caps), merges them, and keeps FrontSide: bore from
 * inside, skin from outside, flat caps with clean normals.
 *
 * Axis along +Y, centred on the origin. Callers rotate to the final pose
 * (openTubeGroup and Spin barrel use rotateX(π/2) for a Z-axis tube).
 *
 * @param {number} innerR interior radius (m)
 * @param {number} outerR exterior radius (m)
 * @param {number} length tube length (m)
 * @param {number} [segments] radial segments around the bore
 */
export function thickWallTubeGeometry(innerR, outerR, length, segments = 40) {
  const half = length / 2;
  const segs = Math.max(8, segments);
  const parts = [];

  parts.push(new THREE.CylinderGeometry(outerR, outerR, length, segs, 1, true));

  const inner = new THREE.CylinderGeometry(innerR, innerR, length, segs, 1, true);
  inner.scale(-1, 1, 1); // inward normals so FrontSide reads from inside the bore
  parts.push(inner);

  const botCap = new THREE.RingGeometry(innerR, outerR, segs);
  botCap.rotateX(Math.PI / 2);
  botCap.translate(0, -half, 0);
  parts.push(botCap);

  const topCap = new THREE.RingGeometry(innerR, outerR, segs);
  topCap.rotateX(-Math.PI / 2);
  topCap.translate(0, half, 0);
  parts.push(topCap);

  const geo = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

/**
 * Upper half of thickWallTubeGeometry — a vault you drive through.
 *
 * Same split as the open cylinder (inner + outer open cylinders, two end
 * rings, two ground feet). CylinderGeometry already carries radial normals,
 * and keeping the caps on their own verts means those never get averaged
 * into the curve. An extruded horseshoe shares the wall with the end faces,
 * so computeVertexNormals facets the vault even at the same segment count.
 *
 * Axis along +Y, feet in the XY plane at z = 0. Callers rotateX(π/2) for a
 * Z-axis tunnel that sits on y = 0.
 */
export function thickWallVaultGeometry(innerR, outerR, length, segments = 40) {
  const half = length / 2;
  const segs = Math.max(8, segments);
  // CylinderGeometry is x = R sin θ, z = R cos θ (θ = 0 at +Z). θ = π/2 → 3π/2
  // is the z ≤ 0 semicircle; after rotateX(π/2) that is y ≥ 0. RingGeometry is
  // x = R cos φ, y = R sin φ; the −Y end uses φ = π → 2π, the +Y end uses
  // φ = 0 → π so rotateX(−π/2) still lands on that same half.
  const cylStart = Math.PI / 2;
  const ringStart = Math.PI;
  const sweep = Math.PI;
  const parts = [];

  parts.push(new THREE.CylinderGeometry(
    outerR, outerR, length, segs, 1, true, cylStart, sweep,
  ));

  const inner = new THREE.CylinderGeometry(
    innerR, innerR, length, segs, 1, true, cylStart, sweep,
  );
  inner.scale(-1, 1, 1); // inward normals so FrontSide reads from inside the bore
  parts.push(inner);

  const botCap = new THREE.RingGeometry(innerR, outerR, segs, 1, ringStart, sweep);
  botCap.rotateX(Math.PI / 2);
  botCap.translate(0, -half, 0);
  parts.push(botCap);

  // rotateX(-π/2) mirrors the ring's Y into -Z, so this cap needs the y ≥ 0
  // half (φ = 0 → π) to land on the same z ≤ 0 vault as the shells.
  const topCap = new THREE.RingGeometry(innerR, outerR, segs, 1, 0, sweep);
  topCap.rotateX(-Math.PI / 2);
  topCap.translate(0, half, 0);
  parts.push(topCap);

  const wall = outerR - innerR;
  const mid = (innerR + outerR) / 2;
  const leftFoot = new THREE.PlaneGeometry(wall, length);
  leftFoot.translate(-mid, 0, 0);
  parts.push(leftFoot);
  const rightFoot = new THREE.PlaneGeometry(wall, length);
  rightFoot.translate(mid, 0, 0);
  parts.push(rightFoot);

  const geo = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

/**
 * Filled stand-in for {@link thickWallVaultGeometry}.
 *
 * The visual vault is two shells plus paper end-rings: at speed the hull skips
 * the 8 cm skin and sits in the 0.95 m empty wall. Two solid boxes for the
 * feet (THREE.BoxGeometry, outward winding) in the same Y-up / Z-along-tunnel
 * pose the visual has AFTER `rotateX(π/2)`, so the mesh's matrixWorld applies
 * to both. An ExtrudeGeometry horseshoe looked right and wound the sides
 * inward, which would have sucked a nearby car into the wall.
 */
export function filledVaultCollisionGeometry(innerR, outerR, length) {
  const wall = outerR - innerR;
  const mid = (innerR + outerR) / 2;
  const left = new THREE.BoxGeometry(wall, outerR, length);
  left.translate(-mid, outerR / 2, 0);
  const right = new THREE.BoxGeometry(wall, outerR, length);
  right.translate(mid, outerR / 2, 0);
  const geo = mergeGeometries([left, right], false);
  left.dispose();
  right.dispose();
  geo.computeVertexNormals();
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

/**
 * Painted-block material for parkour ramps.
 *
 * The faded cardboard look was MeshStandardMaterial + HSL sat 0.42 / lightness
 * 0.52→0.30 / roughness 0.85 — dusty brown that ate light. This is the same
 * MeshStandardNodeMaterial every other prop uses (fog via `materialColor`),
 * with plastic roughness so the colour actually reads.
 */
export function parkourMat(color) {
  const m = new THREE.MeshStandardNodeMaterial({
    color: new THREE.Color(color),
    roughness: 0.36,
    metalness: 0.08,
  });
  m.colorNode = materialColor;
  return m;
}

/** Five side-by-side test ramps (15°–55°), centred on XZ with feet on y=0. */
export function buildSlopeLabGroup(sharedMat = null) {
  const group = new THREE.Group();
  group.name = "SlopeLab";
  const slopeAngles = [15, 25, 35, 45, 55];
  // Heat map, left→right: shallow yellow → steep red. Saturated on purpose —
  // the old HSL recipe desaturated them into the same muddy brown.
  const colors = [0xffe14a, 0xffb020, 0xff8a14, 0xff5a1e, 0xef2030];
  const w = 12;
  const l = 22;
  const z = 48;
  for (let i = 0; i < slopeAngles.length; i++) {
    const m = new THREE.Mesh(
      rampGeometry(w, l, THREE.MathUtils.degToRad(slopeAngles[i])),
      sharedMat ?? parkourMat(colors[i]),
    );
    m.position.set(-42 + i * 21, 0, z);
    m.castShadow = true;
    m.receiveShadow = true;
    group.add(m);
  }
  const box = new THREE.Box3().setFromObject(group);
  const cx = (box.min.x + box.max.x) * 0.5;
  const cz = (box.min.z + box.max.z) * 0.5;
  for (const child of group.children) {
    child.position.x -= cx;
    child.position.z -= cz;
  }
  return group;
}

/**
 * Jump-lab counterpart to buildSlopeLabGroup: five side-by-side concave jump
 * ramps (kicker scoop) of increasing rise, so the takeoff lip gets steeper
 * left→right — same flat-entry shape as the "Jump ramp" prop, laid out as a
 * test row. Feet on y = 0, centred on XZ.
 */
export function buildJumpLabGroup(sharedMat = null) {
  const group = new THREE.Group();
  group.name = "JumpLab";
  const rises = [4, 7, 10, 14, 18]; // increasing lip steepness ≈ different takeoff angles
  // Cool family so a jump-lab row doesn't read as another slope-lab row.
  const colors = [0x6bff8a, 0x2ee0c0, 0x22c4ff, 0x4a8cff, 0x7a5cff];
  const w = 12;
  const l = 22;
  const z = 48;
  for (let i = 0; i < rises.length; i++) {
    const m = new THREE.Mesh(
      jumpRampGeometry(w, l, rises[i]),
      sharedMat ?? parkourMat(colors[i]),
    );
    m.position.set(-42 + i * 21, 0, z);
    m.castShadow = true;
    m.receiveShadow = true;
    group.add(m);
  }
  const box = new THREE.Box3().setFromObject(group);
  const cx = (box.min.x + box.max.x) * 0.5;
  const cz = (box.min.z + box.max.z) * 0.5;
  for (const child of group.children) {
    child.position.x -= cx;
    child.position.z -= cz;
  }
  return group;
}

/**
 * Curved drive ramp: starts at local (0,0,0) heading −Z, turns by `angleDeg`
 * (curveDir ±1), rises to `rise` with smoothstep. Low edge at y = 0.
 */
function curveRampGeometry(w, radius, angleDeg, rise, curveDir = 1, segments = 32) {
  const R = Math.max(4, radius);
  const A = THREE.MathUtils.degToRad(Math.min(120, Math.max(15, angleDeg)));
  const dir = curveDir >= 0 ? 1 : -1;
  const hw = w / 2;
  const n = Math.max(8, segments);
  const center = new THREE.Vector3(dir * R, 0, 0);
  const radius0 = new THREE.Vector3(-dir * R, 0, 0);

  const centerline = [];
  const rights = [];
  const _off = new THREE.Vector3();
  const _tan = new THREE.Vector3();
  const _up = new THREE.Vector3(0, 1, 0);
  const _right = new THREE.Vector3();

  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const phi = A * t;
    const sm = t * t * (3 - 2 * t);
    _off.copy(radius0).applyAxisAngle(_up, -dir * phi);
    centerline.push(new THREE.Vector3(center.x + _off.x, rise * sm, center.z + _off.z));
  }

  for (let i = 0; i <= n; i++) {
    const prev = centerline[Math.max(0, i - 1)];
    const next = centerline[Math.min(n, i + 1)];
    _tan.subVectors(next, prev);
    if (_tan.lengthSq() < 1e-10) _right.set(dir, 0, 0);
    else {
      _tan.normalize();
      _right.crossVectors(_up, _tan);
      if (_right.lengthSq() < 1e-10) _right.set(1, 0, 0);
      else _right.normalize();
    }
    rights.push(_right.clone());
  }

  const pos = [];
  const quad = (a, b, c, d) => {
    pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    pos.push(a.x, a.y, a.z, c.x, c.y, c.z, d.x, d.y, d.z);
  };
  const tri = (a, b, c) => pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);

  const L = (i, side) => {
    const p = centerline[i];
    const r = rights[i];
    return new THREE.Vector3(p.x + r.x * hw * side, p.y, p.z + r.z * hw * side);
  };
  const ground = (v) => new THREE.Vector3(v.x, 0, v.z);

  for (let i = 0; i < n; i++) {
    quad(L(i, -1), L(i, 1), L(i + 1, 1), L(i + 1, -1));
  }
  for (let i = 0; i < n; i++) {
    const lt0 = L(i, -1);
    const lt1 = L(i + 1, -1);
    quad(lt0, lt1, ground(lt1), ground(lt0));
    const rt0 = L(i, 1);
    const rt1 = L(i + 1, 1);
    quad(rt0, ground(rt0), ground(rt1), rt1);
  }
  tri(L(0, -1), L(0, 1), ground(L(0, 1)));
  tri(L(0, -1), ground(L(0, 1)), ground(L(0, -1)));
  tri(L(n, -1), ground(L(n, -1)), ground(L(n, 1)));
  tri(L(n, -1), ground(L(n, 1)), L(n, 1));

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

/**
 * Solid extruded kicker: flat entry z=0, profile supplied by heightAt(t) where t∈[0,1].
 *
 * The VISIBLE mesh is the closed wedge. Collision is split:
 *   deck   — drive surface only (attachDeckProxy)
 *   solids — shortened cheeks + a short inset backstop (attachSolidProxy)
 * The full-height lip cap stays visual. Putting it in solids is what launched
 * the car straight up at takeoff on the taller Jump lab lanes.
 */
/** Lip backstop height (m). Above the roof, well below even Jump lab's
 *  smallest takeoff (~4 m), so the hull never meets it as a wall on the way
 *  off. A ground-level charge from behind still hits a wall. */
const KICKER_SOLID_CAP_H = 1.7;
/** Metres the backstop sits inboard of the visual lip. Takeoff is then past
 *  the collider; driving into the back clips 1.4 m of visual, which is the
 *  trade for not having an 8–18 m wall at the kicker. */
const KICKER_SOLID_CAP_INSET = 1.4;
/**
 * How far below the drive surface the collision flanks stop (m).
 *
 * The visual sides are vertical faces up to the deck. Put those in the solids
 * tree and a car turning ON the ramp drives its hull into them — sparks, an
 * invisible wall, the car shoved back onto the piece. Slope lab does it at
 * the entry (the plane is already steep); Jump lab does it in the middle (the
 * scoop is still flat at the entry and only then steepens). Same wall, different
 * place. The hull floor sits ~16 cm above the tyres, so a wall that ends ~35 cm
 * below the deck is invisible to a car on top (you can turn off) and still a
 * wall to anyone hitting the ramp from the ground.
 *
 * Full-height flanks-only was worse than the closed wedge
 * (tools/labEdgeStickRepro.mjs: 4630 spark ticks vs 503) because the hanging
 * bodywork ground along the wall. Shortening the top is what that sweep was
 * missing.
 */
const RAMP_FLANK_DROP = 0.35;
const RAMP_FLANK_MIN = 0.12;

function lerp3(a, b, t) {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}

function clipFlankTop(top) {
  const y = top[1] - RAMP_FLANK_DROP;
  if (y < RAMP_FLANK_MIN) return null;
  return [top[0], y, top[2]];
}

function appendFlankBand(solidPos, topA, topB, botA, botB, left) {
  const squad = (a, b, c, d) => {
    solidPos.push(...a, ...b, ...c, ...a, ...c, ...d);
  };
  const emit = (b0, t0, t1, b1) => {
    if (left) squad(b0, t0, t1, b1);
    else squad(b0, b1, t1, t0);
  };
  const c0 = clipFlankTop(topA);
  const c1 = clipFlankTop(topB);
  if (c0 && c1) {
    emit(botA, c0, c1, botB);
    return;
  }
  const y0 = topA[1] - RAMP_FLANK_DROP;
  const y1 = topB[1] - RAMP_FLANK_DROP;
  if (y0 < RAMP_FLANK_MIN && y1 >= RAMP_FLANK_MIN) {
    const t = (RAMP_FLANK_MIN - y0) / (y1 - y0);
    const topC = lerp3(topA, topB, t);
    const botC = lerp3(botA, botB, t);
    const cC = clipFlankTop(topC) ?? [topC[0], RAMP_FLANK_MIN, topC[2]];
    emit(botC, cC, c1, botB);
  } else if (y0 >= RAMP_FLANK_MIN && y1 < RAMP_FLANK_MIN) {
    const t = (y0 - RAMP_FLANK_MIN) / (y0 - y1);
    const topC = lerp3(topA, topB, t);
    const botC = lerp3(botA, botB, t);
    const cC = clipFlankTop(topC) ?? [topC[0], RAMP_FLANK_MIN, topC[2]];
    emit(botA, c0, cC, botC);
  }
}

/**
 * Collision stand-in for a wedge you drive on: shortened vertical cheeks plus a
 * short inset backstop. Not the drive surface, not the full-height lip.
 *
 * Used by the planar slope ramps (which previously put the whole closed wedge
 * in solids) and the kicker/jump extrusions.
 */
export function attachWedgeCheekSolids(geo, w, length, rise, heightAt, {
  segments = 16,
  z0 = 0,
  z1 = null,
} = {}) {
  const zFar = z1 ?? (z0 - length);
  const hw = w / 2;
  const n = Math.max(2, segments);
  const H = Math.max(0.5, rise);
  const topL = [];
  const topR = [];
  const botL = [];
  const botR = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const z = z0 + (zFar - z0) * t;
    const y = heightAt(t, H);
    topL.push([-hw, y, z]);
    topR.push([hw, y, z]);
    botL.push([-hw, 0, z]);
    botR.push([hw, 0, z]);
  }
  return attachSolidProxy(geo, wedgeCheekPositions(topL, topR, botL, botR, {
    heightAt, length, H, hw,
  }));
}

function wedgeCheekPositions(topL, topR, botL, botR, { heightAt, length, H, hw }) {
  const solidPos = [];
  const n = topL.length - 1;
  for (let i = 0; i < n; i++) {
    appendFlankBand(solidPos, topL[i], topL[i + 1], botL[i], botL[i + 1], true);
    appendFlankBand(solidPos, topR[i], topR[i + 1], botR[i], botR[i + 1], false);
  }
  const inset = Math.min(KICKER_SOLID_CAP_INSET, length * 0.25);
  const tCap = 1 - inset / length;
  const yDeck = heightAt(tCap, H);
  const yCap = Math.max(0.2, Math.min(KICKER_SOLID_CAP_H, yDeck * 0.8));
  const zCap = botL[0][2] + (botL[n][2] - botL[0][2]) * tCap;
  const squad = (a, b, c, d) => solidPos.push(...a, ...b, ...c, ...a, ...c, ...d);
  squad([-hw, 0, zCap], [-hw, yCap, zCap], [hw, yCap, zCap], [hw, 0, zCap]);
  return solidPos;
}

function solidKickerExtrusion(w, length, rise, segments, heightAt) {
  const hw = w / 2;
  const n = Math.max(8, segments);
  const L = Math.max(4, length);
  const H = Math.max(0.5, rise);

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

  // THE DRIVE SURFACE, BUILT ON ITS OWN FIRST — see attachDeckProxy. The bands
  // below it (underside, both flanks, and the vertical END CAP that closes the
  // profile at the lip) close the solid and must not be drivable.
  const deckPos = [];
  const deckQuad = (a, b, c, d) => deckPos.push(...a, ...b, ...c, ...a, ...c, ...d);
  for (let i = 0; i < n; i++) deckQuad(topL[i], topR[i], topR[i + 1], topL[i + 1]);

  // The visible solid IS that surface, closed with a shell.
  const pos = deckPos.slice();
  const quad = (a, b, c, d) => pos.push(...a, ...b, ...c, ...a, ...c, ...d);
  for (let i = 0; i < n; i++) quad(botL[i], botL[i + 1], botR[i + 1], botR[i]);
  for (let i = 0; i < n; i++) quad(botL[i], topL[i], topL[i + 1], botL[i + 1]);
  for (let i = 0; i < n; i++) quad(botR[i], botR[i + 1], topR[i + 1], topR[i]);
  quad(botL[n], topL[n], topR[n], botR[n]);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  attachDeckProxy(geo, deckPos);
  return attachSolidProxy(geo, wedgeCheekPositions(topL, topR, botL, botR, {
    heightAt, length: L, H, hw,
  }));
}

/**
 * Convex kicker — surface bulges above the straight chord (y = rise×sin(t×π/2)).
 */
export function kickerRampGeometry(w, length, rise, segments = 32) {
  return solidKickerExtrusion(w, length, rise, segments, (t, H) => H * Math.sin((Math.PI / 2) * t));
}

/**
 * Concave jump ramp — scooped transition below the chord (y = rise×(1−cos(t×π/2))).
 * Flat entry, steep lip; typical stunt jump profile.
 */
export function jumpRampGeometry(w, length, rise, segments = 32) {
  return solidKickerExtrusion(w, length, rise, segments, (t, H) => H * (1 - Math.cos((Math.PI / 2) * t)));
}

/* ----------------------------------------------------------------------- */
/* Dynamic movers — a pose per tick, and a collision tree that never rebuilds */
/* ----------------------------------------------------------------------- */

const _pivotW = new THREE.Vector3();
const _r = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _liftInv = new THREE.Matrix4();
const _liftLocal = new THREE.Vector3();
const _carryV = new THREE.Vector3();
const _carryAxis = new THREE.Vector3();

/** Lift ramp, m/s². Gentle enough that a parked car's springs follow it. */
const LIFT_ACCEL = 3.2;
/** Seconds the deck stays put after the car leaves before it starts back down. */
const LIFT_DWELL = 0.8;
/** Plan-outline slack when deciding the car is aboard, metres (half a car wide). */
const CARRY_MARGIN = 1.2;
/** How far above the deck still counts as riding it. */
const CARRY_HEADROOM = 3.5;

export class ParkourMover {
  /**
   * @param {object} o
   * @param {THREE.Mesh} o.mesh collision + visual mesh
   * @param {"spin-y"|"spin-z"|"slide-z"|"slide-y"|"pendulum-x"|"lift"} o.mode
   *        `lift` is CALLED rather than cyclic — see _updateLift
   * @param {number} o.speed rad/s or phase speed
   * @param {THREE.Object3D} [o.pivot] required for spin-y / pendulum-x
   * @param {number} [o.amplitude] slide distance (m) or swing angle (rad)
   * @param {THREE.Vector3} [o.origin] rest position for slide modes
   * @param {boolean} [o.isDeck] when true, the mesh is a DRIVE SURFACE (wheel
   *        probes + deck contact) rather than a wall the chassis bounces off
   * @param {number} [o.phase0] initial motion phase (e.g. −π/2 starts elevator at bottom)
   * @param {THREE.BufferGeometry} [o.collisionGeometry] low-poly stand-in to
   *        collide against instead of the visual geometry
   * @param {THREE.Mesh} [o.solidMesh] descendant of `mesh` that acts as a WALL
   *        while `mesh` itself is the drive surface
   * @param {boolean} [o.deckCarry] when true, spin deck movers impart surface
   *        velocity to a grounded car (see applyDeckCarry)
   */
  constructor({
    mesh,
    mode,
    speed,
    pivot = null,
    amplitude = 8,
    origin = null,
    isDeck = false,
    phase0 = 0,
    collisionGeometry = null,
    solidMesh = null,
    deckCarry = false,
  }) {
    this.mesh = mesh;
    this.pivot = pivot;
    this.mode = mode;
    this.speed = speed;
    this.amplitude = amplitude;
    this.origin = origin ? origin.clone() : mesh.position.clone();
    this.isDeck = isDeck;
    /** Spinning deck surfaces that should carry the car when it is not steering. */
    this.deckCarry = deckCarry;
    /** Authored start phase, kept so a run can always begin from it. */
    this.phase0 = phase0;
    this.phase = phase0;
    this.label = mesh.name || mode;

    // ── THE TREE IS BUILT ONCE, IN THE MESH'S OWN FRAME ─────────────────────
    // A mover is a rigid body, so its triangles never move relative to each
    // other and the tree it needs is the same tree every tick. This used to be
    // a world-space `RoadBvh` rebuilt inside `update()` — 9.8 ms a tick for the
    // rotating tube, times up to 8 ticks a frame. RigidBvh bakes here and
    // transforms the QUERY instead; see that file for the measurements.
    this.bvh = new RigidBvh(mesh, collisionGeometry);
    /**
     * Optional SECOND tree, for a mover that is both a drive surface and a wall
     * (the elevator: you ride the deck, you bounce off the cage sides). It must
     * be a descendant of `mesh` so one animated transform carries both.
     */
    this.solidBvh = solidMesh ? new RigidBvh(solidMesh) : null;

    this._linVel = new THREE.Vector3();
    this._angVelW = new THREE.Vector3();

    // ── LIFT STATE ────────────────────────────────────────────────────────
    // Height above `origin`, not a phase: a called lift has no cycle to be at a
    // point in. See _updateLift.
    this._liftY = 0;
    this._liftVel = 0;
    this._emptyFor = Infinity;
  }

  /**
   * @param {number} dt seconds
   * @param {THREE.Vector3|null} [rider] the car's world position, for the modes
   *        that react to it. Null in build mode (there is no car) and for every
   *        mode that ignores it.
   */
  update(dt, rider = null) {
    if (this.mode === "lift") {
      this._updateLift(dt, rider);
      this.mesh.updateMatrixWorld(true);
      return;
    }
    this.phase += this.speed * dt;
    if (this.mode === "spin-y" && this.pivot) {
      this.pivot.rotation.x = 0;
      this.pivot.rotation.y = this.phase;
      this._angVelW.set(0, this.speed, 0).applyQuaternion(this.pivot.getWorldQuaternion(_q));
      this._linVel.set(0, 0, 0);
    } else if (this.mode === "spin-z" && this.pivot) {
      // Barrel roll about the pivot's local Z — a tube spinning about its own
      // length axis (the rotating-tube obstacle). Orient the tube by rotating
      // the ROOT; the pivot's Z stays the tube axis.
      this.pivot.rotation.set(0, 0, this.phase);
      this._angVelW.set(0, 0, this.speed).applyQuaternion(this.pivot.getWorldQuaternion(_q));
      this._linVel.set(0, 0, 0);
    } else if (this.mode === "slide-z") {
      const offset = this.amplitude * Math.sin(this.phase);
      this.mesh.position.set(this.origin.x, this.origin.y, this.origin.z + offset);
      this._linVel.set(0, 0, this.amplitude * this.speed * Math.cos(this.phase));
      this._angVelW.set(0, 0, 0);
    } else if (this.mode === "slide-y") {
      const y = this.origin.y + this.amplitude * Math.sin(this.phase);
      this.mesh.position.set(this.origin.x, y, this.origin.z);
      this._linVel.set(0, this.amplitude * this.speed * Math.cos(this.phase), 0);
      this._angVelW.set(0, 0, 0);
    } else if (this.mode === "pendulum-x" && this.pivot) {
      const angle = this.amplitude * Math.sin(this.phase);
      this.pivot.rotation.x = angle;
      const angSpeed = this.amplitude * this.speed * Math.cos(this.phase);
      this._angVelW.set(angSpeed, 0, 0).applyQuaternion(this.pivot.getWorldQuaternion(_q));
      this._linVel.set(0, 0, 0);
    }
    // The BVH needs no work here at all — it reads `mesh.matrixWorld` live.
    this.mesh.updateMatrixWorld(true);
  }

  /**
   * CALLED LIFT: parked at the bottom until the car drives on, parked at the top
   * until it drives off.
   *
   * The other modes are open-loop sine waves, which is right for an obstacle you
   * time your run against — but wrong for an elevator, which is a piece of TRACK.
   * A platform that cycles regardless means the only way up is to arrive at the
   * right moment, and the only way to leave the top is to be standing on it when
   * it happens to be there. Neither is a thing you can build a route through.
   *
   * Motion is a trapezoid — accelerate, cruise, brake to a stop on the target —
   * rather than a step to full speed. A lift that starts at 2 m/s instantly
   * yanks the suspension out from under a parked car; ramping over `LIFT_ACCEL`
   * lets the springs follow it. The brake test is the standard one: start
   * slowing when the remaining distance is no more than v²/2a.
   *
   * @param {THREE.Vector3|null} rider the car, or null when there is none
   */
  _updateLift(dt, rider) {
    const height = Math.max(0.1, this.amplitude);
    const vMax = Math.max(0.1, Math.abs(this.speed));
    const occupied = !!rider && this.isCarriedPointInside(rider);

    // A short dwell before it starts back down, so clipping the edge of the deck
    // on the way off does not immediately drop the platform under the car's rear
    // wheels. Rising is not delayed — you want it to answer at once.
    if (occupied) this._emptyFor = 0;
    else this._emptyFor += dt;
    const wantTop = occupied || this._emptyFor < LIFT_DWELL;

    const target = wantTop ? height : 0;
    const remaining = target - this._liftY;
    const dir = Math.sign(remaining);

    if (Math.abs(remaining) < 1e-4 && Math.abs(this._liftVel) < 1e-3) {
      this._liftY = target;
      this._liftVel = 0;
    } else {
      const brakeDist = (this._liftVel * this._liftVel) / (2 * LIFT_ACCEL);
      if (dir !== Math.sign(this._liftVel) && this._liftVel !== 0) {
        // Target moved to the other side mid-trip (the car got back on): brake
        // through zero rather than teleporting the velocity.
        this._liftVel += dir * LIFT_ACCEL * dt;
      } else if (Math.abs(remaining) <= brakeDist) {
        const next = Math.abs(this._liftVel) - LIFT_ACCEL * dt;
        this._liftVel = dir * Math.max(0, next);
      } else {
        const next = Math.min(vMax, Math.abs(this._liftVel) + LIFT_ACCEL * dt);
        this._liftVel = dir * next;
      }
      this._liftY += this._liftVel * dt;
      // Never overshoot the ends — a trapezoid that lands a millimetre past the
      // top would sit there jittering between the two brake branches.
      if (this._liftY > height) { this._liftY = height; this._liftVel = 0; }
      if (this._liftY < 0) { this._liftY = 0; this._liftVel = 0; }
    }

    this.mesh.position.set(this.origin.x, this.origin.y + this._liftY, this.origin.z);
    this._linVel.set(0, this._liftVel, 0);
    this._angVelW.set(0, 0, 0);
  }

  /**
   * Is `worldPoint` standing ON this mover's deck?
   *
   * Tested in the deck's own local space against its geometry bounds, so it
   * follows the platform without anyone having to declare a footprint: a point
   * counts when it is inside the plan outline (plus a margin for the car's
   * width at the edge) and within head height above the top face.
   */
  isCarriedPointInside(worldPoint) {
    const geo = this.mesh.geometry;
    if (!geo) return false;
    if (!geo.boundingBox) geo.computeBoundingBox();
    const bb = geo.boundingBox;
    _liftInv.copy(this.mesh.matrixWorld).invert();
    _liftLocal.copy(worldPoint).applyMatrix4(_liftInv);
    return (
      _liftLocal.x > bb.min.x - CARRY_MARGIN && _liftLocal.x < bb.max.x + CARRY_MARGIN &&
      _liftLocal.z > bb.min.z - CARRY_MARGIN && _liftLocal.z < bb.max.z + CARRY_MARGIN &&
      _liftLocal.y > bb.max.y - 0.5 && _liftLocal.y < bb.max.y + CARRY_HEADROOM
    );
  }

  /**
   * Back to the authored start pose.
   *
   * Movers animate in BUILD mode now, so by the time you hit drive the phase is
   * wherever the editing session left it. A race has to start from the same
   * board every time — otherwise a lap time depends on how long you spent
   * building, and a ghost replays against obstacles that are somewhere else.
   */
  resetPhase() {
    this.phase = this.phase0;
    this._liftY = 0;
    this._liftVel = 0;
    this._emptyFor = Infinity;
    this.update(0);
  }

  /** Free the collision trees. Call when the mover is deleted. */
  dispose() {
    this.bvh?.dispose();
    this.solidBvh?.dispose();
  }

  /**
   * Couple a grounded car to a spinning deck — barrel-roll carry.
   *
   * When throttle and steer are idle the car picks up the surface's tangential
   * velocity and spins about the tube axis with it; active input weakens the
   * coupling so you can still fight the barrel.
   *
   * @param {import("../../v3/play/modularRoadVehicle.js").RigidBody} body
   * @param {THREE.Vector3} riderPos car centre of mass, world space
   * @param {number} throttle −1…1
   * @param {number} steer −1…1
   * @param {number} groundedCount wheels with ground contact this substep
   * @param {number} dt substep seconds
   */
  applyDeckCarry(body, riderPos, throttle, steer, groundedCount, dt) {
    if (!this.deckCarry || groundedCount < 1) return;
    if (!riderPos || !this.isCarriedPointInside(riderPos)) return;
    if (this.mode !== "spin-z" && this.mode !== "spin-y") return;

    const idle = Math.abs(throttle) < 0.08 && Math.abs(steer) < 0.08;
    const inputMag = Math.min(1, Math.abs(throttle) + Math.abs(steer) * 0.65);
    const strength = idle ? 1 : Math.max(0.12, 1 - inputMag * 0.88);
    const k = 1 - Math.exp(-14 * dt);

    this.velocityAt(riderPos, _carryV);
    body.vel.lerp(_carryV, strength * k);

    if (this.pivot) {
      const axis = this.mode === "spin-z" ? _carryAxis.set(0, 0, 1) : _carryAxis.set(0, 1, 0);
      axis.applyQuaternion(this.pivot.getWorldQuaternion(_q));
      const wAlong = body.angVel.dot(axis);
      const targetW = this._angVelW.dot(axis);
      body.angVel.addScaledVector(axis, (targetW - wAlong) * strength * k);
    }
  }

  /** Surface velocity at a world-space contact point (for chassis coupling). */
  velocityAt(worldPoint, out) {
    if ((this.mode === "spin-y" || this.mode === "spin-z" || this.mode === "pendulum-x") && this.pivot) {
      this.pivot.getWorldPosition(_pivotW);
      _r.subVectors(worldPoint, _pivotW);
      return out.crossVectors(this._angVelW, _r);
    }
    return out.copy(this._linVel);
  }
}
