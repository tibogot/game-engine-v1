import * as THREE from "three";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { materialEmissive } from "three/tsl";
import { applyBloomMRT } from "../../v3/render/bloomMRT.js";
import { ParkourMover, enableMeshShadows } from "./modularRoadParkour.js";
import { isSharedGeometry, markSharedGeometry } from "./modularRoadBatching.js";
import { ELEVATOR, makeElevator } from "./modularRoadElevator.js";
import {
  buildWindmillMesh,
  isWindmillModelReady,
  preloadWindmillModel,
} from "../../v2/objects/windmill.js";

/**
 * Placeable moving obstacles — same gizmo workflow as static props, backed by
 * ParkourMover for chassis coupling and (optional) wheel-deck rebake.
 */

const V3 = THREE.Vector3;

function moverMat(color) {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: 0.55,
    metalness: 0.35,
    side: THREE.DoubleSide,
  });
}

const _visMeshBox = new THREE.Box3();

/**
 * World AABB of meshes the player can see. Hidden collision stand-ins
 * (`visible === false` / `userData.boundsIgnore`) used to inflate the
 * selection box — the wind turbine's old 26 m cylinder stuck a wireframe
 * well above the real tower.
 */
function visibleWorldBox(root, out) {
  out.makeEmpty();
  root.traverse((o) => {
    if (!o.isMesh || o.visible === false || o.userData.boundsIgnore) return;
    const geo = o.geometry;
    if (!geo) return;
    if (!geo.boundingBox) geo.computeBoundingBox();
    _visMeshBox.copy(geo.boundingBox).applyMatrix4(o.matrixWorld);
    out.union(_visMeshBox);
  });
  return out;
}

function fitTowerCollider(visualRoot) {
  const towerVis = visualRoot.getObjectByName("Circle");
  const box = new THREE.Box3();
  if (towerVis) box.setFromObject(towerVis);
  else box.setFromObject(visualRoot);
  const height = Math.max(0.5, box.max.y - box.min.y);
  const radius = Math.max(
    (box.max.x - box.min.x) * 0.5,
    (box.max.z - box.min.z) * 0.5,
    0.35,
  ) * 1.25;
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius * 1.15, height, 10));
  mesh.name = "WindmillTower";
  mesh.position.set(
    (box.min.x + box.max.x) * 0.5,
    (box.min.y + box.max.y) * 0.5,
    (box.min.z + box.max.z) * 0.5,
  );
  mesh.visible = false;
  mesh.userData.boundsIgnore = true;
  return mesh;
}

/**
 * Hole grid for the spin barrel — configurable resolution.
 *
 * @param {boolean} [opts.innerOnly] inner wall quads only (cheap collider)
 * @param {boolean} [opts.rimsOnly] hole-border quads only (glow rims)
 * @param {boolean} [opts.smoothShell] give the CYLINDER WALLS analytic radial
 *   normals instead of face normals, so they shade as a curve rather than as A
 *   flat strips. Off by default: the original barrel's faceted look is wanted.
 *
 *   Welding is not an option here the way it is for the swept road pieces —
 *   every quad pushes four fresh vertices, so nothing is shared and there is
 *   nothing to average. But a cylinder does not need averaging: the true normal
 *   at any point is radial, and the vertex position gives the angle. Only the
 *   walls get it; the end rings and the hole borders are real edges and keep
 *   their face normals.
 */
function spinBarrelHoleGrid(Ri, wall, L, holes, {
  A = 32, NZ = 16, innerOnly = false, rimsOnly = false, smoothShell = false,
} = {}) {
  const Ro = Ri + wall;
  const da = (2 * Math.PI) / A;
  const dz = L / NZ;

  const rects = holes.map((h) => {
    const na = Math.max(2, Math.round(h.span / da));
    const nz = Math.max(2, Math.round(h.len / dz));
    return {
      ia0: ((Math.round(h.a / da - na / 2) % A) + A) % A,
      na,
      iz0: Math.max(0, Math.min(NZ - nz, Math.round((h.z + L / 2) / dz - nz / 2))),
      nz,
    };
  });
  const isHole = (ia, iz) =>
    rects.some((r) => ((ia - r.ia0 + A) % A) < r.na && iz >= r.iz0 && iz < r.iz0 + r.nz);

  const pt = (ia, R, iz) => {
    const th = ia * da;
    return [R * Math.sin(th), -R * Math.cos(th), -L / 2 + iz * dz];
  };

  /** Outward radial unit at grid angle `ia`; `sign` −1 gives the inward one. */
  const radial = (ia, sign) => {
    const th = ia * da;
    return [sign * Math.sin(th), -sign * Math.cos(th), 0];
  };
  /** Flat-shaded fallback: one face normal repeated for all four corners. */
  const faceNormal = (a, b, c) => {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    return [nx / l, ny / l, nz / l];
  };

  const mkEmit = () => ({ pos: [], idx: [], nrm: [] });
  /** `ns` = per-corner normals; omitted means flat (the face's own normal). */
  const quad = (part, a, b, c, d, ns = null) => {
    const base = part.pos.length / 3;
    part.pos.push(...a, ...b, ...c, ...d);
    part.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    if (!smoothShell) return; // originals keep computeVertexNormals, untouched
    if (ns) part.nrm.push(...ns[0], ...ns[1], ...ns[2], ...ns[3]);
    else {
      const n = faceNormal(a, b, c);
      part.nrm.push(...n, ...n, ...n, ...n);
    }
  };
  const shell = mkEmit();
  const rims = mkEmit();

  for (let ia = 0; ia < A; ia++) {
    const ja = (ia + 1) % A;
    for (let iz = 0; iz < NZ; iz++) {
      if (isHole(ia, iz)) {
        if (!isHole((ia - 1 + A) % A, iz)) quad(rims, pt(ia, Ri, iz), pt(ia, Ri, iz + 1), pt(ia, Ro, iz + 1), pt(ia, Ro, iz));
        if (!isHole(ja, iz)) quad(rims, pt(ja, Ri, iz), pt(ja, Ro, iz), pt(ja, Ro, iz + 1), pt(ja, Ri, iz + 1));
        if (iz === 0 || !isHole(ia, iz - 1)) quad(rims, pt(ia, Ri, iz), pt(ia, Ro, iz), pt(ja, Ro, iz), pt(ja, Ri, iz));
        if (iz === NZ - 1 || !isHole(ia, iz + 1)) quad(rims, pt(ia, Ri, iz + 1), pt(ja, Ri, iz + 1), pt(ja, Ro, iz + 1), pt(ia, Ro, iz + 1));
        continue;
      }
      if (!rimsOnly) {
        // Corner order is (ia, ja, ja, ia) inside and (ia, ia, ja, ja) outside,
        // so the normals have to follow suit.
        //
        // THE SIGNS MATCH THE WINDING, NOT INTUITION. Reading the shape, the
        // bore's surface "should" face the axis — but these quads are wound so
        // that the face normal points the other way, and the shell is drawn
        // DoubleSide, which flips the normal for back faces in the shader. An
        // analytic normal anti-parallel to the face it belongs to therefore
        // inverts the lighting rather than smoothing it. MEASURED against the
        // faceted barrel's own normals, the first attempt came out at a uniform
        // 176.25° — that is 180° minus half a facet, i.e. exactly backwards.
        const [inA, inB] = [radial(ia, 1), radial(ja, 1)];
        quad(shell, pt(ia, Ri, iz), pt(ja, Ri, iz), pt(ja, Ri, iz + 1), pt(ia, Ri, iz + 1),
          [inA, inB, inB, inA]);
        const [outA, outB] = [radial(ia, -1), radial(ja, -1)];
        if (!innerOnly) {
          quad(shell, pt(ia, Ro, iz), pt(ia, Ro, iz + 1), pt(ja, Ro, iz + 1), pt(ja, Ro, iz),
            [outA, outA, outB, outB]);
        }
      }
    }
    if (!rimsOnly) {
      if (!isHole(ia, 0)) quad(shell, pt(ia, Ri, 0), pt(ia, Ro, 0), pt(ja, Ro, 0), pt(ja, Ri, 0));
      if (!isHole(ia, NZ - 1)) quad(shell, pt(ia, Ri, NZ), pt(ja, Ri, NZ), pt(ja, Ro, NZ), pt(ia, Ro, NZ));
    }
  }

  const toGeo = (part) => {
    if (!part.idx.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(part.pos, 3));
    g.setIndex(part.idx);
    // The analytic normals are only built when they were asked for, so the
    // original barrel takes exactly the path it always did.
    if (smoothShell && part.nrm.length === part.pos.length) {
      g.setAttribute("normal", new THREE.Float32BufferAttribute(part.nrm, 3));
    } else {
      g.computeVertexNormals();
    }
    g.computeBoundingSphere();
    return g;
  };
  return { shell: toGeo(shell), rims: toGeo(rims) };
}

/**
 * Drive-through barrel that spins about its own axis.
 *
 * Inner radius matches the kit's rideable tube. 48×20 visual grid, matte dark
 * shell, glowing rims, inner-wall-only collider (~600 tris), and deck-carry.
 *
 * ONE BUILDER, TWO TILES. The smooth variant is the same barrel with analytic
 * wall normals and a different rim colour, so keeping it as options rather than
 * a copy is what stops the two drifting the next time the barrel is tuned.
 *
 * @param {boolean} [opts.smooth] shade the cylinder walls as a curve
 * @param {number} [opts.rimColor] bloom colour of the hole rims
 */
function makeSpinBarrel({ smooth = false, rimColor = 0x38e8d8 } = {}) {
  const Ri = 8;
  const wall = 0.6;
  const L = 40;
  const deg = THREE.MathUtils.degToRad;
  const holes = spinBarrelHoles(deg);
  const { shell, rims } = spinBarrelHoleGrid(Ri, wall, L, holes, {
    A: 48, NZ: 20, smoothShell: smooth,
  });
  // The collider is unaffected by shading — same cheap grid either way.
  const { shell: collShell } = spinBarrelHoleGrid(Ri, wall, L, holes, {
    A: 24, NZ: 12, innerOnly: true,
  });

  const root = new THREE.Group();
  root.name = smooth ? "SpinBarrelSmooth" : "SpinBarrel";
  const pivot = new THREE.Object3D();
  pivot.position.set(0, Ri, 0);
  root.add(pivot);

  const mesh = new THREE.Mesh(
    shell,
    new THREE.MeshStandardMaterial({
      // High roughness softens the low-poly facets; low metalness kills the
      // sharp specular stripes that made each face read so hard.
      color: 0x2a2e32,
      metalness: 0.12,
      roughness: 0.78,
      // DoubleSide — FrontSide alone reads as a flat skin from inside the bore.
      side: THREE.DoubleSide,
    }),
  );
  mesh.name = "SpinBarrelShell";

  // Bloom rims keep the holes readable while the barrel spins.
  const rimMat = new THREE.MeshStandardNodeMaterial({
    color: new THREE.Color(rimColor),
    emissive: new THREE.Color(rimColor),
    emissiveIntensity: 4,
    roughness: 0.45,
    side: THREE.DoubleSide,
  });
  applyBloomMRT(rimMat, materialEmissive);
  mesh.add(new THREE.Mesh(rims, rimMat)); // child ⇒ visual only, no collision

  pivot.add(mesh);
  return bindMover(root, {
    mesh,
    pivot,
    mode: "spin-z",
    speed: 0.55,
    amplitude: 8,
    isDeck: true,
    deckCarry: true,
    collisionGeometry: collShell,
  });
}

/** Four staggered wall openings along the spin barrel. */
function spinBarrelHoles(deg) {
  return [
    { a: deg(0), span: deg(80), z: -12, len: 7 },
    { a: deg(100), span: deg(70), z: -4, len: 7 },
    { a: deg(200), span: deg(90), z: 4, len: 7 },
    { a: deg(300), span: deg(70), z: 12, len: 7 },
  ];
}

/**
 * Two bars at 90° around a hub — a turnstile that sweeps the lane.
 * One merged mesh so RigidBvh sees both arms (it bakes `mesh.geometry` only).
 */
function makeTourniquetGeo({ span = 18, thick = 0.95, tall = 1.55, hubR = 0.7 } = {}) {
  const armX = new THREE.BoxGeometry(span, tall, thick);
  const armZ = new THREE.BoxGeometry(thick, tall, span);
  const hub = new THREE.CylinderGeometry(hubR, hubR, tall + 0.15, 12);
  const geo = mergeGeometries([armX, armZ, hub], false);
  armX.dispose();
  armZ.dispose();
  hub.dispose();
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

/** @param {THREE.Object3D} root */
function bindMover(root, bind) {
  root.userData.moverBind = bind;
  return root;
}

/** @type {{id:string,label:string,collision:string,defaults:object,make:()=>THREE.Object3D}[]} */
export const MOVER_CATALOG = [
  {
    id: "spinbar",
    label: "Spin bar",
    collision: "solid",
    defaults: { speed: 0.85, amplitude: 8 },
    make: () => {
      const root = new THREE.Group();
      root.name = "SpinBar";
      const pivot = new THREE.Object3D();
      pivot.position.set(0, 5.5, 0);
      root.add(pivot);
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(24, 1.6, 1.6), moverMat(0xe8c040));
      pivot.add(mesh);
      return bindMover(root, { mesh, pivot, mode: "spin-y", speed: 0.85, amplitude: 8 });
    },
  },
  {
    id: "spinbar_low",
    label: "Spin bar (low)",
    collision: "solid",
    defaults: { speed: -1.1, amplitude: 8 },
    make: () => {
      const root = new THREE.Group();
      root.name = "SpinBarLow";
      const pivot = new THREE.Object3D();
      pivot.position.set(0, 2.2, 0);
      root.add(pivot);
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(20, 1.4, 1.4), moverMat(0xc07030));
      pivot.add(mesh);
      return bindMover(root, { mesh, pivot, mode: "spin-y", speed: -1.1, amplitude: 8 });
    },
  },
  {
    id: "tourniquet",
    label: "Tourniquet",
    collision: "solid",
    defaults: { speed: 0.8, amplitude: 8 },
    make: () => {
      const root = new THREE.Group();
      root.name = "Tourniquet";
      const tall = 1.55;
      const clearance = 0.4;
      const pivot = new THREE.Object3D();
      // Car-height so the arms actually hit the chassis instead of spinning
      // over the roof the way the high spin bar does.
      pivot.position.set(0, clearance + tall / 2, 0);
      root.add(pivot);
      const mesh = new THREE.Mesh(
        makeTourniquetGeo({ span: 18, thick: 0.95, tall }),
        moverMat(0xe85a3a),
      );
      mesh.name = "TourniquetCross";
      pivot.add(mesh);
      return bindMover(root, { mesh, pivot, mode: "spin-y", speed: 0.8, amplitude: 8 });
    },
  },
  {
    id: "pushgate",
    label: "Push gate",
    collision: "solid",
    defaults: { speed: 0.45, amplitude: 8 },
    make: () => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(8, 5, 3.5), moverMat(0x5080c0));
      mesh.name = "PushGate";
      return bindMover(mesh, { mesh, mode: "slide-z", speed: 0.45, amplitude: 8 });
    },
  },
  {
    id: "pendulum",
    label: "Pendulum",
    collision: "solid",
    defaults: { speed: 0.75, amplitude: 0.72 },
    make: () => {
      const root = new THREE.Group();
      root.name = "Pendulum";
      const pivot = new THREE.Object3D();
      pivot.position.set(0, 15, 0);
      root.add(pivot);
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.6, 10, 0.6), moverMat(0x555555));
      arm.position.set(0, -5, 0);
      pivot.add(arm);
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(2.8, 20, 16), moverMat(0xb04040));
      mesh.position.set(0, -10.5, 0);
      pivot.add(mesh);
      return bindMover(root, { mesh, pivot, mode: "pendulum-x", speed: 0.75, amplitude: 0.72 });
    },
  },
  {
    id: "pendulum_small",
    label: "Pendulum (small)",
    collision: "solid",
    defaults: { speed: 1.05, amplitude: 0.95 },
    make: () => {
      const root = new THREE.Group();
      root.name = "PendulumSmall";
      const pivot = new THREE.Object3D();
      pivot.position.set(0, 12, 0);
      root.add(pivot);
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(3, 3, 3), moverMat(0xd06050));
      mesh.position.set(0, -7, 0);
      pivot.add(mesh);
      return bindMover(root, { mesh, pivot, mode: "pendulum-x", speed: 1.05, amplitude: 0.95 });
    },
  },
  {
    id: "spincolumn",
    label: "Spin column",
    collision: "solid",
    defaults: { speed: 0.55, amplitude: 8 },
    make: () => {
      const root = new THREE.Group();
      root.name = "SpinColumn";
      const pivot = new THREE.Object3D();
      pivot.position.set(0, 3.5, 0);
      root.add(pivot);
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(3.5, 7, 3.5), moverMat(0x909090));
      pivot.add(mesh);
      return bindMover(root, { mesh, pivot, mode: "spin-y", speed: 0.55, amplitude: 8 });
    },
  },
  {
    id: "elevator",
    label: "Elevator",
    collision: "deck",
    // For a lift, `amplitude` is the climb in METRES of deck surface and `speed`
    // is m/s — not the half-amplitude and rad/s the cyclic modes use. See
    // ParkourMover._updateLift and modularRoadElevator.js.
    defaults: { speed: ELEVATOR.liftSpeed, amplitude: ELEVATOR.rise },
    make: () => {
      const { root, bind } = makeElevator();
      return bindMover(root, bind);
    },
  },
  {
    id: "spinbarrel",
    label: "Spin barrel",
    collision: "deck",
    defaults: { speed: 0.55, amplitude: 8 },
    make: () => makeSpinBarrel(),
  },
  {
    /*
     * THE SAME BARREL, SHADED SMOOTH — and it is a second tile rather than a
     * replacement because the faceted one is a look somebody wants.
     *
     * The walls get analytic radial normals (see spinBarrelHoleGrid's
     * smoothShell); everything else about it is identical, down to the matte
     * 0.78-roughness shell. Worth knowing: that roughness was chosen to HIDE the
     * faceting, so it is also damping the thing this variant exists to show —
     * dropping it would make the smoothness read harder, if you want that.
     *
     * Pink rims so the two are one glance apart in a track full of both.
     */
    id: "spinbarrel_smooth",
    label: "Spin barrel (smooth)",
    collision: "deck",
    defaults: { speed: 0.55, amplitude: 8 },
    make: () => makeSpinBarrel({ smooth: true, rimColor: 0xff3ea5 }),
  },
  {
    id: "windmill",
    label: "Wind turbine",
    collision: "solid",
    defaults: { speed: 0.45, amplitude: 8 },
    /**
     * THE OBJECTS-LAB WIND TURBINE, AS A MOVER RATHER THAN SCENERY.
     *
     * It looks like scenery and it is not, for one mechanical reason: scenery
     * goes through the prop INSTANCER, which is one geometry and N matrices per
     * type. That is what makes twenty street lamps cheap, and it is also why
     * nothing inside an instanced prop can move independently — there is no
     * per-instance rotor to turn. A turbine with still blades is a turbine with
     * the interesting part switched off.
     *
     * The mover system already has exactly the mechanism it wants: a pivot, a
     * spin mode, and (since the collision trees stopped rebuilding per tick) no
     * running cost for using it. `WindmillRotor` is the pivot the lab builder
     * already parents the blades and hub to.
     */
    make: () => {
      const root = new THREE.Group();
      root.name = "Windmill";
      // The GLB is preloaded at boot with the other models (roadGame.js), so by
      // the time a palette tile can be clicked this is loaded. If it somehow is
      // not, an empty root places nothing rather than throwing.
      if (!isWindmillModelReady()) return root;
      const built = buildWindmillMesh({
        points: [{ x: 0, y: 0, z: 0 }],
        params: { scale: 1.5, facePath: true },
        getWorldHeight: () => 0,
      });
      if (!built) return root;
      // NOT OURS TO FREE. `buildWindmillMesh` hands back clones of an
      // app-lifetime GLB template, and Object3D.clone() shares geometry by
      // reference — so the palette's thumbnail bake, or deleting one turbine,
      // would destroy the buffers every other turbine draws from. Marking it
      // makes every disposal path in the game skip it (see modularRoadBatching).
      markSharedGeometry(built);
      root.add(built);
      root.updateMatrixWorld(true);

      const pivot = built.getObjectByName("WindmillRotor");
      // The rotor group is the spin pivot; the mesh under it is what turns.
      const mesh = pivot?.children.find((c) => c.isMesh || c.children.length) ?? pivot;

      // The TOWER is the collider, not the blades. Fitted to the Circle mesh
      // (~9 m at catalog scale, ~0.5 m radius). A hardcoded 26 m × 4 m cylinder
      // used to dwarf the visual and inflate the selection box / thumbnail.
      const tower = fitTowerCollider(built);
      root.add(tower);

      if (!pivot || !mesh) return root;
      // Bind the TOWER as the collision mesh. The rotor still spins because it
      // is `pivot`; using the blades as `mesh` would bake a huge spinning BVH
      // and make the car bounce off empty air above the pole.
      return bindMover(root, {
        mesh: tower,
        pivot,
        mode: "spin-z",
        speed: 0.45,
        amplitude: 8,
      });
    },
  },
];

export { preloadWindmillModel };

export const MOVER_BY_ID = new Map(MOVER_CATALOG.map((m) => [m.id, m]));

export class MoverPropManager {
  constructor({
    scene, camera, domElement, orbit,
    onChange = null, onSelect = null, onSelectionChange = null,
  }) {
    this.scene = scene;
    this.camera = camera;
    this.domElement = domElement;
    this.orbit = orbit;
    this.onChange = onChange;
    this.onSelect = onSelect;
    /** Fired when the SELECTION changes (not the geometry) — drives the palette
     *  inspector. Distinct from `onSelect`, which means "clear the other
     *  systems' selections because I am taking it". */
    this.onSelectionChange = onSelectionChange;
    this.enabled = false;
    /** Handles down while a placement brush owns the pointer. See suspendGizmo. */
    this._gizmoSuspended = false;

    /** @type {{id:string, def:object, root:THREE.Object3D, collision:string, params:object, mover:ParkourMover|null}[]} */
    this.instances = [];
    this.selected = null;
    /** Cached deck/solid BVH lists — see collisionBvhs(). */
    this._bvhLists = null;
    this._bvhListsDirty = true;

    this.group = new THREE.Group();
    this.group.name = "RoadMovers";
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

    this._selBounds = new THREE.Box3();
    this.selBox = new THREE.Box3Helper(this._selBounds, 0xff8866);
    this.selBox.visible = false;
    scene.add(this.selBox);

    this.gizmo.addEventListener("dragging-changed", (e) => {
      if (this.orbit) this.orbit.enabled = !e.value && this.enabled;
    });
    this.gizmo.addEventListener("change", () => {
      if (this.selected) this._syncSelBox(this.selected.root);
    });
    this.gizmo.addEventListener("mouseUp", () => {
      this.rebuildMovers();
      this.onChange?.();
    });

    // NO RIGHT-CLICK LISTENER HERE ANY MORE. This used to select on its own,
    // on pointerDOWN, while the road builder selected on pointerUP — so a
    // right-click on something sitting on the road selected BOTH, and the
    // road's handler ran second and took the gizmo. roadGame now arbitrates
    // one right-click across every system via hitTest/selectHit.

    window.addEventListener("keydown", (e) => this._onKey(e), true);
  }

  get hasSelection() {
    return !!this.selected;
  }

  isUsingGizmo() {
    return this.enabled && (this.gizmo.dragging || this.gizmo.axis != null);
  }

  setEnabled(on) {
    this.enabled = on;
    if (!on) this.deselect();
  }

  /**
   * Put the move tool down while a placement brush owns the pointer, KEEPING the
   * selection. `setEnabled(false)` deselects, which is the opposite of what this
   * needs. See PropManager.suspendGizmo for why hovering a gizmo used to eat the
   * place-click.
   */
  suspendGizmo(on) {
    this._gizmoSuspended = !!on;
    // pointerHover early-returns while disabled, so an axis the pointer was
    // already over would stay latched and keep eating clicks.
    if (on) this.gizmo.axis = null;
    this._applyGizmoSuspend();
  }

  /** Push the suspend state onto the gizmo — `attach()` always shows the helper. */
  _applyGizmoSuspend() {
    const live = this.gizmo.object != null && !this._gizmoSuspended;
    this.gizmo.enabled = live;
    this.gizmo.getHelper().visible = live;
  }

  setMode(mode) {
    this.gizmo.setMode(mode);
  }

  /** @returns {ParkourMover[]} */
  getMovers() {
    return this.instances.map((i) => i.mover).filter(Boolean);
  }

  /**
   * @param {number} dt
   * @param {THREE.Vector3|null} [rider] the car's world position. Lifts are
   *        CALLED by it; every other mode ignores it. Null in build mode, which
   *        is why an elevator sits parked at the bottom while you author — that
   *        is its authored state, and the shaft already shows where it goes.
   */
  update(dt, rider = null) {
    for (const inst of this.instances) inst.mover?.update(dt, rider);
  }

  /** Put every mover back at its authored start phase — see ParkourMover. */
  resetPhases() {
    for (const inst of this.instances) inst.mover?.resetPhase();
  }

  /**
   * Change one tunable on the SELECTED mover, live.
   *
   * Writes straight through to the running ParkourMover as well as to the saved
   * params, so the change is visible in the editor's own animation instead of
   * only after a reload. Deliberately NOT a `rebuildMovers()`: that throws away
   * and re-bakes every collision tree, and dragging a slider would do it sixty
   * times a second for two numbers the mover reads every tick anyway.
   *
   * @param {"speed"|"amplitude"} key
   * @param {number} value
   */
  setSelectedParam(key, value) {
    const inst = this.selected;
    if (!inst || !Number.isFinite(value)) return;
    inst.params[key] = value;
    if (inst.mover) inst.mover[key] = value;
    // Some movers LOOK different at a different amplitude — the elevator's shaft
    // has to be as tall as the stroke it encloses. The bind declares the hook so
    // this stays ignorant of what an elevator is.
    if (key === "amplitude") {
      inst.root.userData.moverBind?.onAmplitude?.(inst.root, value);
    }
    this.onChange?.();
  }

  /**
   * Rebuild every mover's driver object (and, with it, its collision tree).
   *
   * `this.group`, NOT `this.scene`: this runs on every add, duplicate, delete
   * and gizmo release, and forcing the WHOLE world's matrices — terrain,
   * foliage, every track piece — to pick up a couple of platforms is the same
   * mistake `rebakeMovers` was written to undo. The movers hang off this group,
   * so its subtree is exactly what has to be current. (The group's own world
   * matrix comes from the scene root, which nothing here moves.)
   */
  rebuildMovers() {
    this.group.updateMatrixWorld(true);
    for (const inst of this.instances) {
      const cfg = this._moverConfig(inst);
      if (!cfg) continue;
      inst.mover?.dispose();
      inst.mover = new ParkourMover(cfg);
      inst.mover.update(0);
    }
    this._bvhListsDirty = true;
  }

  /**
   * The per-mover collision trees, split the way the ground adapter wants them.
   *
   * Cached and rebuilt only when the mover SET changes. It used to be rebuilt
   * per physics tick (`collisionMeshes()` + two array spreads + an `includes`
   * scan, then a full BVH bake of every mover) — see `rebakeMovers` in
   * roadGame.js for what that cost.
   *
   * @returns {{deck: RigidBvh[], solids: RigidBvh[]}}
   */
  collisionBvhs() {
    if (!this._bvhListsDirty && this._bvhLists) return this._bvhLists;
    const deck = [];
    const solids = [];
    for (const inst of this.instances) {
      const bvh = inst.mover?.bvh;
      if (!bvh) continue;
      const isDeck = inst.collision === "deck" || inst.collision === "both" || inst.mover.isDeck;
      const isSolid = inst.collision === "solid" || inst.collision === "both";
      if (isDeck) deck.push(bvh);
      if (isSolid) solids.push(bvh);
      // A deck mover can ALSO carry walls (the elevator's cage sides) — a
      // separate tree, so the plate stays a drive surface and only the sides
      // push the chassis back.
      if (inst.mover.solidBvh) solids.push(inst.mover.solidBvh);
    }
    this._bvhLists = { deck, solids };
    this._bvhListsDirty = false;
    return this._bvhLists;
  }

  /**
   * @param {string} typeId
   * @param {THREE.Vector3|null} [worldPos] where to put it — the cursor point
   *        when placed from the palette brush. Falls back to the orbit target.
   */
  add(typeId, worldPos = null) {
    this.onSelect?.();
    const def = MOVER_BY_ID.get(typeId);
    if (!def) return null;
    const root = def.make();
    enableMeshShadows(root);
    root.userData.isMoverProp = true;
    if (worldPos) {
      root.position.copy(worldPos);
    } else if (this.orbit?.target) {
      root.position.set(this.orbit.target.x, Math.max(0, this.orbit.target.y), this.orbit.target.z);
    }
    this.group.add(root);
    const inst = {
      id: typeId,
      def,
      root,
      collision: def.collision,
      params: { ...def.defaults },
      mover: null,
    };
    root.userData.moverPropInstance = inst;
    this.instances.push(inst);
    this.rebuildMovers();
    this._select(inst);
    this.onChange?.();
    return inst;
  }

  duplicateSelected() {
    if (!this.selected) return;
    const src = this.selected;
    const root = src.def.make();
    enableMeshShadows(root);
    root.userData.isMoverProp = true;
    root.position.copy(src.root.position).add(new V3(4, 0, 4));
    root.quaternion.copy(src.root.quaternion);
    root.scale.copy(src.root.scale);
    root.userData.moverBind?.onAmplitude?.(root, src.params.amplitude);
    this.group.add(root);
    const inst = {
      id: src.id,
      def: src.def,
      root,
      collision: src.collision,
      params: { ...src.params },
      mover: null,
    };
    root.userData.moverPropInstance = inst;
    this.instances.push(inst);
    this.rebuildMovers();
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

  exportInstances() {
    return this.instances.map((inst) => ({
      type: inst.id,
      position: inst.root.position.toArray(),
      quaternion: inst.root.quaternion.toArray(),
      scale: inst.root.scale.toArray(),
      speed: inst.params.speed,
      amplitude: inst.params.amplitude,
    }));
  }

  importInstances(list) {
    this.deselect();
    for (const inst of this.instances) this._disposeInstance(inst);
    this.instances = [];
    if (!Array.isArray(list)) return;
    for (const item of list) {
      const def = MOVER_BY_ID.get(item.type);
      if (!def || !Array.isArray(item.position)) continue;
      const root = def.make();
      enableMeshShadows(root);
      root.userData.isMoverProp = true;
      root.position.fromArray(item.position);
      if (Array.isArray(item.quaternion) && item.quaternion.length === 4) {
        root.quaternion.fromArray(item.quaternion);
      }
      if (Array.isArray(item.scale) && item.scale.length === 3) {
        root.scale.fromArray(item.scale);
      }
      this.group.add(root);
      const inst = {
        id: item.type,
        def,
        root,
        collision: def.collision,
        params: {
          speed: item.speed ?? def.defaults.speed,
          amplitude: item.amplitude ?? def.defaults.amplitude,
        },
        mover: null,
      };
      root.userData.moverPropInstance = inst;
      // Re-apply a SAVED amplitude to the look before the mover is built: an
      // elevator loaded with a 20 m stroke has to come back with the 20 m shaft
      // it was saved with, not the catalog default.
      root.userData.moverBind?.onAmplitude?.(root, inst.params.amplitude);
      this.instances.push(inst);
    }
    this.rebuildMovers();
    this.onChange?.();
  }

  _moverConfig(inst) {
    const b = inst.root.userData.moverBind;
    if (!b?.mesh) return null;
    const cfg = {
      mesh: b.mesh,
      pivot: b.pivot ?? null,
      mode: b.mode,
      speed: inst.params.speed ?? b.speed,
      amplitude: inst.params.amplitude ?? b.amplitude,
      isDeck: b.isDeck ?? false,
      phase0: b.phase0 ?? 0,
      // Optional low-poly stand-in declared by the catalog entry. The visual
      // mesh can then be as detailed as it likes without the physics paying for
      // it — the same split the road's guardrail uses (`collisionGeometry`).
      collisionGeometry: b.collisionGeometry ?? null,
      // A SECOND collider, for movers that are a drive surface AND a wall — the
      // elevator's cage sides. It rides the deck mesh as a child, so it needs no
      // animation of its own, only its own tree.
      solidMesh: b.solidMesh ?? null,
      deckCarry: b.deckCarry ?? false,
    };
    if (b.mode === "slide-z" || b.mode === "slide-y") {
      cfg.origin = (b.slideOrigin ?? b.mesh.position).clone();
    }
    return cfg;
  }

  _syncSelBox(root) {
    root.updateMatrixWorld(true);
    visibleWorldBox(root, this._selBounds);
    this.selBox.visible = !this._selBounds.isEmpty();
    this.selBox.updateMatrixWorld(true);
  }

  _select(inst) {
    this.onSelect?.();
    this.selected = inst;
    this.gizmo.attach(inst.root);
    this._syncSelBox(inst.root);
    this.selBox.visible = !this._selBounds.isEmpty();
    // Not `enabled = true` outright: add() selects what it just placed, and with
    // a brush still armed that fresh gizmo would sit right where the next click
    // is going.
    this._applyGizmoSuspend();
    this.onSelectionChange?.(inst);
  }

  /**
   * Nearest mover under the cursor and HOW FAR AWAY it is — no selecting.
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
      while (o && !o.userData.moverPropInstance) o = o.parent;
      if (o?.userData.moverPropInstance) return { dist: h.distance, hit: o.userData.moverPropInstance };
    }
    return null;
  }

  /** Select what `hitTest` found (or clear, with null). Used by the arbiter. */
  selectHit(hit) {
    if (hit) this._select(hit);
    else this.deselect();
  }

  /**
   * Turn the selection by an EXACT angle about one of its own axes.
   *
   * Road pieces got arrow-key steps; obstacles had only a gizmo drag, so a mover
   * you wanted at exactly 45° was a matter of dragging and squinting. The step
   * comes from roadGame (the builder's Angle step), so an obstacle and a road
   * piece turn by the same amount — one setting, not two.
   *
   * LOCAL axes, composed on the right, matching what the rotate gizmo produces
   * in its default local space and what the road's own nudge does.
   *
   * `captureAuthored` is optional-chained because only the prop system has one:
   * a gate's panel ANIMATES, so its authored pose has to be snapshotted apart
   * from the live one. Movers and portals serialise `root.quaternion` directly.
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
    this.captureAuthored?.(inst);
    this.onChange?.();
    return true;
  }

  _onKey(e) {
    if (!this.enabled || !this.selected) return;
    if (e.target instanceof HTMLInputElement) return;
    let handled = true;
    switch (e.code) {
      case "KeyW": this.setMode("translate"); break;
      case "KeyE": this.setMode("rotate"); break;
      case "KeyR": this.setMode("scale"); break;
      // X, NOT Q. Q is the road builder's yaw nudge; having it mean "toggle
      // axes" whenever an obstacle happened to be selected was one key with
      // two meanings. X is world/local everywhere now.
      case "KeyX": this.gizmo.setSpace(this.gizmo.space === "local" ? "world" : "local"); break;
      case "Delete":
      case "Backspace":
        this.deleteSelected();
        break;
      case "Escape":
        this.deselect();
        break;
      case "KeyD":
        if (e.ctrlKey || e.metaKey) this.duplicateSelected();
        else handled = false;
        break;
      default:
        handled = false;
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
    inst.mover?.dispose();
    inst.mover = null;
    this._bvhListsDirty = true;
    this.group.remove(inst.root);
    inst.root.traverse((o) => {
      // Shared template geometry (the elevator's merged cage) is marked and
      // owned elsewhere — freeing it here kills it for every other placement.
      if (o.isMesh && !isSharedGeometry(o.geometry)) o.geometry?.dispose?.();
    });
  }
}

/* ----------------------------------------------------------------------- */
/* Palette inspector for the selected mover                                 */
/* ----------------------------------------------------------------------- */

/**
 * The two numbers that decide what a moving obstacle actually DOES — how far it
 * goes and how fast — wired to the palette block in road.html.
 *
 * Until this existed they were catalog constants: every elevator on every track
 * had the same 8 m stroke at the same speed, and the only way to change one was
 * to hand-edit a saved track's JSON. `exportInstances` was already writing them
 * out per instance, so the save format needed nothing.
 *
 * ── WHAT THE SLIDERS SHOW IS NOT WHAT THE MOVER STORES ────────────────────
 * `amplitude` is a HALF-stroke for the slide modes (position = origin + A·sin φ)
 * and RADIANS for the pendulum. Neither is what someone building a track means
 * by "travel" or "swing", so the UI shows metres of full stroke and degrees, and
 * converts. The hint line underneath then spells out the derived numbers you
 * actually plan around — cycle time, and where the top of the stroke lands.
 *
 * @param {() => MoverPropManager} getManager lazily, because the manager is
 *        constructed WITH this inspector's `show` as a callback.
 */
export function createMoverInspector(getManager, { getSnapStep = null } = {}) {
  const $ = (id) => document.getElementById(id);
  const root = $("mover-inspector");
  const nameEl = $("mover-insp-name");
  const hintEl = $("mover-insp-hint");
  const speedEl = $("mover-speed");
  const speedVal = $("mover-speed-val");
  const ampRow = $("mover-amp-row");
  const ampEl = $("mover-amp");
  const ampLabel = $("mover-amp-label");
  const ampVal = $("mover-amp-val");
  if (!root || !speedEl || !ampEl) return { show() {}, refresh() {} };

  /** How each mode presents its `amplitude`, or null when it has none. */
  const AMP_UI = {
    // The lift's amplitude IS the height, in metres of deck surface — no
    // conversion, because the whole point is that the number on the slider is
    // the height you build the upper road at. Its step follows the BUILDER'S
    // grid, so the two always land on each other.
    lift: { label: "Height", unit: "m", min: 2, max: 48, step: 1, grid: true, toUi: (a) => a, fromUi: (v) => v },
    "slide-y": { label: "Travel", unit: "m", min: 1, max: 40, step: 0.1, toUi: (a) => a * 2, fromUi: (v) => v / 2 },
    "slide-z": { label: "Throw", unit: "m", min: 1, max: 40, step: 0.1, toUi: (a) => a * 2, fromUi: (v) => v / 2 },
    "pendulum-x": { label: "Swing", unit: "°", min: 5, max: 90, step: 1, toUi: (a) => a * 180 / Math.PI, fromUi: (v) => v * Math.PI / 180 },
  };

  /**
   * Speed means different things per mode, and a shared −2…2 rad/s slider makes
   * the lift unusable: 0.32 there is a crawl in m/s, not a sensible period.
   */
  const SPEED_UI = {
    lift: { min: 0.5, max: 8, step: 0.1, unit: " m/s" },
  };
  const DEFAULT_SPEED_UI = { min: -2, max: 2, step: 0.01, unit: "" };

  let current = null;

  const describe = (inst) => {
    const b = inst.root.userData.moverBind ?? {};
    const speed = inst.params.speed ?? 0;
    const amp = inst.params.amplitude ?? 0;
    const period = Math.abs(speed) > 1e-4 ? (2 * Math.PI) / Math.abs(speed) : Infinity;
    const secs = period === Infinity ? "never" : `${period.toFixed(1)} s`;
    if (b.mode === "lift") {
      // The two numbers you plan a route with: where the upper road has to be,
      // and how long the ride costs. The trip is longer than height/speed
      // because of the ramp at each end, which is close enough at these speeds
      // not to be worth spelling out.
      const trip = Math.abs(speed) > 1e-4 ? amp / Math.abs(speed) : Infinity;
      const world = (inst.root.position.y ?? 0) + amp;
      return `upper deck at y ${world.toFixed(1)} m · ~${trip.toFixed(1)} s each way · called by the car`;
    }
    if (b.mode === "slide-y") {
      // The platform rests at origin and swings ±amp, so the top of the stroke
      // is origin + amp above the ground the root sits on.
      const top = (b.slideOrigin?.y ?? 0) + amp;
      return `${(amp * 2).toFixed(1)} m stroke · ${secs} per cycle · top at ${top.toFixed(1)} m`;
    }
    if (b.mode === "slide-z") return `${(amp * 2).toFixed(1)} m stroke · ${secs} per cycle`;
    if (b.mode === "pendulum-x") return `±${(amp * 180 / Math.PI).toFixed(0)}° · ${secs} per swing`;
    return `${Math.abs(speed).toFixed(2)} rad/s · ${secs} per turn${speed < 0 ? " (reversed)" : ""}`;
  };

  const paint = () => {
    if (!current) return;
    const b = current.root.userData.moverBind ?? {};
    const ui = AMP_UI[b.mode] ?? null;
    speedVal.textContent = (current.params.speed ?? 0).toFixed(2);
    if (ui) {
      const v = ui.toUi(current.params.amplitude ?? 0);
      ampVal.textContent = `${v.toFixed(ui.step < 1 ? 1 : 0)}${ui.unit}`;
    }
    hintEl.textContent = describe(current);
  };

  speedEl.addEventListener("input", () => {
    getManager()?.setSelectedParam("speed", Number(speedEl.value));
    paint();
  });
  ampEl.addEventListener("input", () => {
    const b = current?.root.userData.moverBind ?? {};
    const ui = AMP_UI[b.mode];
    if (!ui) return;
    getManager()?.setSelectedParam("amplitude", ui.fromUi(Number(ampEl.value)));
    paint();
  });

  return {
    /** @param {object|null} inst the newly selected mover instance, or null */
    show(inst) {
      current = inst;
      if (!inst) {
        root.hidden = true;
        return;
      }
      root.hidden = false;
      nameEl.textContent = inst.def?.label ?? inst.id;
      const mode = inst.root.userData.moverBind?.mode;
      const sui = SPEED_UI[mode] ?? DEFAULT_SPEED_UI;
      speedEl.min = String(sui.min);
      speedEl.max = String(sui.max);
      speedEl.step = String(sui.step);
      speedEl.value = String(inst.params.speed ?? 0);
      const ui = AMP_UI[mode];
      // A spinner has no amplitude at all — the row is hidden rather than
      // disabled, so nothing suggests there is a number here to find.
      ampRow.hidden = !ui;
      if (ui) {
        ampLabel.textContent = ui.label;
        if (ui.grid) {
          // GRID-STEPPED, AND STARTING ON THE GRID. The lift's height is a
          // height you then build a road at, so the slider moves in the same
          // increments the builder snaps to — set the grid to 8 and every stop
          // is 8, 16, 24…, a level a piece can actually land on.
          //
          // `min` has to BE a multiple of the step, not just any lower bound: an
          // <input type=range> quantises to min + n·step, so a min of 2 with a
          // step of 8 offers 2, 10, 18 — every stop off the grid by 2 m, which
          // is exactly the alignment this is here to guarantee.
          const grid = Math.max(0.5, getSnapStep?.() ?? 1);
          ampEl.step = String(grid);
          ampEl.min = String(grid);
          ampEl.max = String(Math.floor(ui.max / grid) * grid);
        } else {
          ampEl.min = String(ui.min);
          ampEl.max = String(ui.max);
          ampEl.step = String(ui.step);
        }
        ampEl.value = String(ui.toUi(inst.params.amplitude ?? 0));
      }
      paint();
    },
    refresh: paint,
  };
}
