// Structures RENDERER — procedural geometry for the base and enemy turrets.
// Mirrors unitRenderer: all visuals here, logic stays mesh-free in structures.js.
//
// Every structure is built from boxes and cylinders and NEVER changes shape, so
// each KIND of rigid piece is baked into one geometry (per-part color kept in a
// vertex-color attribute) and drawn as a single InstancedMesh shared by every
// structure of that kind. Six turrets are one draw, not six — and a seventh
// turret, or a sixtieth, costs nothing.
//
// Only pieces that genuinely differ stay apart:
//   • turret HEADS are their own instanced kind — they yaw independently
//   • beacons / eyes are their own kinds — emissive MRT material (they bloom)
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { materialColor } from "three/tsl";
import { makeBloomMaterial, BLOOM } from "./bloom.js";

const MAX_PER_KIND = 64; // instance capacity per structure kind

const C_BODY = 0x5a6472;
const C_DARK = 0x333a45;
const C_ENEMY = 0x6e4a4a;
const C_MARK = 0xff6a3a;

/**
 * The shared material for every structure kind.
 *
 * `vertexColors` carries the per-part color that used to need one material per
 * part. The `colorNode` is NOT cosmetic: an InstancedMesh never moves (its
 * instances do), and three's NodeMaterialObserver only re-uploads uniforms for a
 * material that carries a node — so without it the scene fog uniforms FREEZE at
 * whatever they were on first render. `materialColor` just reads the material's
 * own (white) color uniform. See unitRenderer.js for the same fix.
 */
function makeStructureMaterial() {
  const m = new THREE.MeshStandardNodeMaterial({
    color: 0xffffff, // white: the vertex colors ARE the color
    roughness: 0.87,
    metalness: 0.18,
    vertexColors: true,
  });
  m.colorNode = materialColor;
  return m;
}

/** Tag every vertex of `geo` with `hex`, so merged parts keep their colors. */
function paint(geo, hex) {
  const c = new THREE.Color(hex); // already in linear working space
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = c.r;
    arr[i * 3 + 1] = c.g;
    arr[i * 3 + 2] = c.b;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(arr, 3));
  return geo;
}

/**
 * Merge painted parts into one geometry.
 *
 * mergeGeometries returns null on ANY attribute mismatch, so an untagged part
 * would silently delete a whole structure — throw instead of shipping a missing base.
 */
function mergePainted(parts, name) {
  const geo = mergeGeometries(parts, false);
  if (!geo) throw new Error(`[rts-v3] ${name}: mergeGeometries failed (attribute mismatch)`);
  return geo;
}

// ── The rigid geometry of each kind, built once ──────────────────────────────

/** Player HQ: platform, main block, corner pillars, beacon mast. */
function baseGeometry() {
  const parts = [
    paint(new THREE.CylinderGeometry(15, 16.5, 1.6, 24).translate(0, 0.8, 0), C_DARK),
    paint(new THREE.BoxGeometry(16, 9, 16).translate(0, 6, 0), C_BODY),
    paint(new THREE.BoxGeometry(10, 4, 10).translate(0, 12.5, 0), C_BODY),
    paint(new THREE.CylinderGeometry(0.35, 0.35, 6, 8).translate(0, 17.5, 0), C_DARK),
  ];
  for (const [px, pz] of [[-7.5, -7.5], [7.5, -7.5], [-7.5, 7.5], [7.5, 7.5]]) {
    parts.push(paint(new THREE.CylinderGeometry(1.3, 1.6, 13, 10).translate(px, 6.5, pz), C_DARK));
  }
  return mergePainted(parts, "base");
}

/** Unarmed practice target — bright so it's easy to spot near the base. */
function dummyGeometry() {
  return mergePainted([
    paint(new THREE.CylinderGeometry(2.2, 2.6, 0.5, 12).translate(0, 0.25, 0), C_DARK),
    paint(new THREE.BoxGeometry(3, 3, 3).translate(0, 2, 0), C_ENEMY),
    paint(new THREE.BoxGeometry(3.1, 0.5, 3.1).translate(0, 2.8, 0), C_MARK),
  ], "trainingDummy");
}

/** Turret pedestal (static) — the head is a separate kind. */
function turretGeometry() {
  return mergePainted([
    paint(new THREE.CylinderGeometry(4, 4.6, 1.2, 16).translate(0, 0.6, 0), C_DARK),
    paint(new THREE.CylinderGeometry(2, 2.4, 3.5, 12).translate(0, 2.8, 0), C_ENEMY),
  ], "turret");
}

/** Turret head + barrel. Its origin is the yaw pivot, HEAD_Y above the pedestal. */
function turretHeadGeometry() {
  const barrel = paint(new THREE.CylinderGeometry(0.36, 0.42, 5, 10), C_DARK);
  barrel.rotateX(Math.PI / 2);   // lay it along +Z
  barrel.translate(0, 0.2, 2.6); // …pointing out of the head
  return mergePainted([
    paint(new THREE.BoxGeometry(3.4, 2.4, 3.6), C_ENEMY),
    barrel,
  ], "turretHead");
}

const HEAD_Y = 5.2;                                   // head pivot above the pedestal
const MUZZLE_LOCAL = new THREE.Vector3(0, 0.2, 5.1);  // in head space
const BEACON_Y = 21;                                  // base beacon, above the mast
const EYE_LOCAL = new THREE.Vector3(0, 0.95, 1.1);    // in head space

export const structureByMesh = new WeakMap(); // kept for API compatibility

export function createStructuresRenderer({ app, structures, healthBars }) {
  const { scene } = app;

  // ── One merged mesh for every static structure body ─────────────────────────
  // Structure bodies NEVER move (only on a world reload, or when one is
  // destroyed), so they're merged into a single world-space mesh: one draw, and
  // — the part that actually matters — ONE shadow caster. The shadow pass redraws
  // every caster once per CSM cascade, so caster COUNT, not mesh count, is what
  // sets the shadow bill.
  //
  // Not a BatchedMesh: it looks like the right tool (many geometries, one draw,
  // per-instance culling), but this WebGPU backend has no `multi-draw-indirect`,
  // so three falls back to ONE DRAW PER INSTANCE — measured at 19 draws for 16
  // structures, worse than what we started with.
  //
  // Not an InstancedMesh either: the bodies are four different geometries, and
  // instancing them per kind loses the per-object frustum culling that separate
  // meshes got for free.
  const geos = {
    base: baseGeometry(),
    turret: turretGeometry(),
    dummy: dummyGeometry(),
  };
  const bodyGeoOf = (s) => (
    s.typeKey === "base" ? geos.base : s.typeKey === "trainingDummy" ? geos.dummy : geos.turret
  );

  const structureMat = makeStructureMaterial();
  let staticMesh = null;
  let staticRanges = []; // [{ s, endTri }] — maps a hit triangle back to its structure
  let staticKey = "";    // rebuild only when the set of live structures changes

  /** Rebuild the merged body mesh (rare: a death, or a world reload). */
  function rebuildStatic() {
    if (staticMesh) {
      scene.remove(staticMesh);
      staticMesh.geometry.dispose();
      staticMesh = null;
    }
    staticRanges = [];

    const parts = [];
    let tri = 0;
    for (const s of structures.list) {
      if (!s.alive) continue;
      const g = bodyGeoOf(s).clone();
      g.translate(s.position.x, s.position.y, s.position.z);
      parts.push(g);
      tri += (g.index ? g.index.count : g.attributes.position.count) / 3;
      staticRanges.push({ s, endTri: tri });
    }
    if (!parts.length) return;

    const merged = mergeGeometries(parts, false);
    if (!merged) throw new Error("[rts-v3] structure bodies: mergeGeometries failed");
    staticMesh = new THREE.Mesh(merged, structureMat);
    staticMesh.castShadow = true;
    staticMesh.receiveShadow = true;
    scene.add(staticMesh);
  }

  const bloom = (color) => makeBloomMaterial(
    { color, blending: THREE.NormalBlending, depthWrite: true, transparent: false },
    BLOOM.beacon,
  );

  /** An instanced kind: `n` live instances this frame, `at[i]` → the structure. */
  const makeKind = (geometry, material, { shadow = false } = {}) => {
    const im = new THREE.InstancedMesh(geometry, material, MAX_PER_KIND);
    im.count = 0;
    im.castShadow = shadow;
    im.receiveShadow = shadow;
    im.frustumCulled = false;
    scene.add(im);
    return { im, n: 0, at: [] };
  };

  const kinds = {
    // Turret heads yaw independently, so they can't join the static merge.
    head: makeKind(turretHeadGeometry(), structureMat, { shadow: true }),
    // Emissive lamps: their own bloom-MRT material, and no shadow (a light source
    // casting a shadow of itself reads as a bug).
    beacon: makeKind(new THREE.SphereGeometry(1.1, 14, 10), bloom(0x64d2ff)),
    eye: makeKind(new THREE.SphereGeometry(0.45, 12, 8), bloom(0xff4a3a)),
  };

  const kindOfMesh = new Map(Object.values(kinds).map((k) => [k.im, k]));

  // Raycast targets. Selection holds this ARRAY by reference, and rebuildStatic()
  // swaps the merged mesh, so refresh it in place rather than reassigning.
  const roots = [];
  const refreshRoots = () => {
    roots.length = 0;
    if (staticMesh) roots.push(staticMesh);
    for (const k of Object.values(kinds)) roots.push(k.im);
  };

  const _m = new THREE.Matrix4();
  const _head = new THREE.Matrix4();
  const _pos = new THREE.Vector3();
  const _quat = new THREE.Quaternion();
  const _scale = new THREE.Vector3(1, 1, 1);
  const _muzzle = new THREE.Vector3();
  const _up = new THREE.Vector3(0, 1, 0);
  const _eye = new THREE.Matrix4();
  const _eyeOffset = new THREE.Matrix4().makeTranslation(EYE_LOCAL.x, EYE_LOCAL.y, EYE_LOCAL.z);

  /** World matrix of a turret's head (its yaw pivot). */
  const headMatrix = (s, out) => out.compose(
    _pos.set(s.position.x, s.position.y + HEAD_Y, s.position.z),
    _quat.setFromAxisAngle(_up, s.turretYaw ?? 0),
    _scale,
  );

  const push = (kind, matrix, s) => {
    if (kind.n >= MAX_PER_KIND) return;
    kind.im.setMatrixAt(kind.n, matrix);
    kind.at[kind.n] = s;
    kind.n++;
  };

  /** World-space muzzle point of a turret (where its tracer should start). */
  function muzzleOf(s) {
    if (s.typeKey !== "turret") {
      return _muzzle.set(s.position.x, s.position.y + 6, s.position.z).clone();
    }
    headMatrix(s, _head);
    return _muzzle.copy(MUZZLE_LOCAL).applyMatrix4(_head).clone();
  }

  /** Resolve a raycast hit to its structure (merged body, or an instanced kind). */
  function structureFromHit(hit) {
    const kind = kindOfMesh.get(hit.object);
    if (kind) return kind.at[hit.instanceId] ?? null;

    if (hit.object === staticMesh) {
      // The bodies are merged, so the hit names a TRIANGLE, not an object. The
      // merge recorded where each structure's triangles end, so a scan finds it.
      for (const r of staticRanges) {
        if (hit.faceIndex < r.endTri) return r.s;
      }
    }
    return null;
  }

  function sync(dt, camera) {
    // The static bodies only change when a structure dies or the world reloads —
    // a cheap signature catches both without rebuilding every frame.
    let key = "";
    for (const s of structures.list) {
      if (s.alive) key += `${s.position.x.toFixed(1)},${s.position.z.toFixed(1)};`;
    }
    if (key !== staticKey) {
      staticKey = key;
      rebuildStatic();
      refreshRoots();
    }

    for (const k of Object.values(kinds)) k.n = 0;

    for (const s of structures.list) {
      if (!s.alive) continue;

      if (s.typeKey === "base") {
        _m.compose(
          _pos.set(s.position.x, s.position.y + BEACON_Y, s.position.z),
          _quat.identity(), _scale,
        );
        push(kinds.beacon, _m, s);
      } else if (s.typeKey === "turret") {
        // Head tracks its target, and the eye rides in head space.
        if (s.target?.alive) {
          const dx = s.target.position.x - s.position.x;
          const dz = s.target.position.z - s.position.z;
          s.turretYaw = Math.atan2(dx, dz);
        }
        headMatrix(s, _head);
        push(kinds.head, _head, s);
        push(kinds.eye, _eye.multiplyMatrices(_head, _eyeOffset), s);
      }

      // Health bar — one instance in the shared field (see healthBar.js).
      healthBars.add(
        s.position.x, s.position.y + (s.type.barY ?? 10), s.position.z,
        s.type.barWidth ?? 6,
        s.hp / s.maxHp,
        s.team === "enemy",
        camera,
      );
    }

    for (const k of Object.values(kinds)) {
      k.im.count = k.n;
      k.im.instanceMatrix.needsUpdate = true;
    }
  }

  return {
    roots,             // raycast targets for selection
    structureByMesh,   // legacy; structures have no per-structure mesh any more
    structureFromHit,  // resolves a raycast hit to its structure
    muzzleOf,
    sync,
    dispose() {
      if (staticMesh) scene.remove(staticMesh);
      for (const k of Object.values(kinds)) scene.remove(k.im);
    },
  };
}
