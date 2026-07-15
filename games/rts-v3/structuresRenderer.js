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

const C_DOOR = 0x455066;   // hangar door
const C_ROOF = 0x2a313b;   // roof / caps

// Base hangar dimensions (origin at ground centre; +Z faces the enemy/rally).
const B_WX = 24, B_DZ = 16, B_HY = 13;  // hangar width / depth / height
const B_OW = 11, B_OH = 6.5;            // door opening width / height
const DOOR_CLOSED_Y = B_OH / 2;         // door centre when shut
const DOOR_TRAVEL = B_OH + 0.4;         // slides up out of the opening

/**
 * Player HQ — a hangar with a sliding front door, a control tower, and the
 * beacon. The static SHELL is merged into one mesh (one draw, one shadow caster);
 * only the door and the emissive parts (beacon, door-frame strips) are separate,
 * because they move / glow. The door faces +Z so produced units drive straight
 * out toward the rally point.
 */
function buildBaseView(structureMat, bloom) {
  const group = new THREE.Group();

  // ── Static shell (merged) ───────────────────────────────────────────────────
  const shell = [];
  const add = (geo, hex) => shell.push(paint(geo, hex));

  // Foundation apron under the building.
  add(new THREE.CylinderGeometry(16, 17, 1.2, 28).translate(0, 0.6, 0), C_DARK);

  const cy = B_HY / 2;
  // Back + side walls.
  add(new THREE.BoxGeometry(B_WX, B_HY, 1.2).translate(0, cy, -B_DZ / 2), C_BODY);
  add(new THREE.BoxGeometry(1.2, B_HY, B_DZ).translate(-B_WX / 2, cy, 0), C_BODY);
  add(new THREE.BoxGeometry(1.2, B_HY, B_DZ).translate(B_WX / 2, cy, 0), C_BODY);
  // Front face = two pillars either side of the door + a header above it.
  const pillarW = (B_WX - B_OW) / 2;
  const pillarX = B_OW / 2 + pillarW / 2;
  add(new THREE.BoxGeometry(pillarW, B_HY, 1.2).translate(-pillarX, cy, B_DZ / 2), C_BODY);
  add(new THREE.BoxGeometry(pillarW, B_HY, 1.2).translate(pillarX, cy, B_DZ / 2), C_BODY);
  add(new THREE.BoxGeometry(B_WX, B_HY - B_OH, 1.2).translate(0, B_OH + (B_HY - B_OH) / 2, B_DZ / 2), C_BODY);
  // Overhanging roof cap.
  add(new THREE.BoxGeometry(B_WX + 2, 1.0, B_DZ + 2).translate(0, B_HY + 0.5, 0), C_ROOF);
  // Roof vents (a little silhouette detail).
  add(new THREE.BoxGeometry(3, 1.4, 3).translate(-6, B_HY + 1.6, -3), C_DARK);
  add(new THREE.BoxGeometry(3, 1.4, 3).translate(6, B_HY + 1.6, -3), C_DARK);
  // Control tower on the back-left, taller than the hangar.
  add(new THREE.BoxGeometry(5, 20, 5).translate(-9, 10, -5), C_BODY);
  add(new THREE.BoxGeometry(6, 1, 6).translate(-9, 20.5, -5), C_ROOF);
  add(new THREE.CylinderGeometry(0.35, 0.35, 4, 8).translate(-9, 22.5, -5), C_DARK);

  const shellMesh = new THREE.Mesh(mergePainted(shell, "base"), structureMat);
  shellMesh.castShadow = true;
  shellMesh.receiveShadow = true;
  group.add(shellMesh);

  // ── Door (slides up) ────────────────────────────────────────────────────────
  const door = new THREE.Mesh(
    paint(new THREE.BoxGeometry(B_OW - 0.4, B_OH - 0.2, 0.6), C_DOOR),
    structureMat,
  );
  door.position.set(0, DOOR_CLOSED_Y, B_DZ / 2 - 0.4); // recessed so the header hides it when up
  door.castShadow = true;
  door.receiveShadow = true;
  group.add(door);

  // ── Emissive (beacon + door-frame strips), no shadow ────────────────────────
  const beacon = new THREE.Mesh(new THREE.SphereGeometry(1.0, 14, 10), bloom(0x64d2ff));
  beacon.position.set(-9, 25, -5); // atop the tower mast
  group.add(beacon);

  // Two vertical light strips flanking the door — one mesh, pulse while producing.
  const stripL = new THREE.BoxGeometry(0.4, B_OH, 0.4).translate(-(B_OW / 2 + 0.5), B_OH / 2, B_DZ / 2);
  const stripR = new THREE.BoxGeometry(0.4, B_OH, 0.4).translate(B_OW / 2 + 0.5, B_OH / 2, B_DZ / 2);
  const strips = new THREE.Mesh(mergeGeometries([stripL, stripR], false), bloom(0x64d2ff));
  group.add(strips);

  group.userData = { door, beacon, strips };
  return group;
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
  // The base is NOT in the merged mesh — it animates (sliding door), so it gets
  // its own view below. Only the turrets and dummies merge.
  const geos = {
    turret: turretGeometry(),
    dummy: dummyGeometry(),
  };
  const bodyGeoOf = (s) => (s.typeKey === "trainingDummy" ? geos.dummy : geos.turret);

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
      if (s.isBuilding) continue;      // runtime buildings have their own renderer
      if (s.typeKey === "base") continue; // the base has its own animated view
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
    // Turret eyes: emissive, no shadow (a light casting a shadow of itself is a bug).
    eye: makeKind(new THREE.SphereGeometry(0.45, 12, 8), bloom(0xff4a3a)),
  };

  const kindOfMesh = new Map(Object.values(kinds).map((k) => [k.im, k]));

  // ── Base view: its own animated group (sliding door), placed once ────────────
  const baseView = buildBaseView(structureMat, bloom);
  if (structures.base) {
    const bp = structures.base.position;
    baseView.position.set(bp.x, bp.y, bp.z);
    // The RTS camera looks UP the map (toward the enemy, +Z) from behind the base,
    // so it only ever sees the base's -Z face. Turn the HQ around so its door faces
    // the CAMERA (-Z) — otherwise the whole door animation plays where you can't
    // see it. Units muster on this near side too (structures.js).
    baseView.rotation.y = Math.PI;
    scene.add(baseView);
  }
  let doorOpen = 0; // 0 shut → 1 fully up
  let _t2 = 0;      // pulse clock for the door strips

  // Raycast targets. Selection holds this ARRAY by reference, and rebuildStatic()
  // swaps the merged mesh, so refresh it in place rather than reassigning.
  const roots = [];
  const refreshRoots = () => {
    roots.length = 0;
    if (staticMesh) roots.push(staticMesh);
    for (const k of Object.values(kinds)) roots.push(k.im);
    roots.push(baseView); // a hit on any base part resolves to the base
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

  /** Resolve a raycast hit to its structure (base view, merged body, or a kind). */
  function structureFromHit(hit) {
    // A hit on any child of the base group is the base.
    for (let o = hit.object; o; o = o.parent) {
      if (o === baseView) return structures.base;
    }

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
    _t2 += dt;
    // The static bodies only change when a structure dies or the world reloads —
    // a cheap signature catches both without rebuilding every frame.
    let key = "";
    for (const s of structures.list) {
      if (s.alive && !s.isBuilding) key += `${s.position.x.toFixed(1)},${s.position.z.toFixed(1)};`;
    }
    if (key !== staticKey) {
      staticKey = key;
      rebuildStatic();
      refreshRoots();
    }

    for (const k of Object.values(kinds)) k.n = 0;

    // ── Base view: animate the door, glow, and hide it when the base dies ──────
    const base = structures.base;
    if (base) {
      baseView.visible = base.alive;
      if (base.alive) {
        // Door opens while the base is producing (queue non-empty / mid-build),
        // so units drive out through an open door. Eased, not snapped.
        const producing = (base.queue?.length ?? 0) > 0 || (base.progress ?? 0) > 0;
        doorOpen += ((producing ? 1 : 0) - doorOpen) * Math.min(1, dt * 4);
        baseView.userData.door.position.y = DOOR_CLOSED_Y + doorOpen * DOOR_TRAVEL;
        // Door-frame strips pulse while producing, dim otherwise.
        const s = producing ? 1.2 + 0.5 * Math.sin(_t2 * 6) : 0.7;
        baseView.userData.strips.scale.set(s, 1, s);
      }
    }

    for (const s of structures.list) {
      if (!s.alive) continue;
      if (s.isBuilding) continue; // rendered by buildingRenderer

      if (s.typeKey === "turret") {
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
