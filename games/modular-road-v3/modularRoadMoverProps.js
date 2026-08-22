import * as THREE from "three";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { materialEmissive } from "three/tsl";
import { applyBloomMRT } from "../../v3/render/bloomMRT.js";
import { ParkourMover, enableMeshShadows } from "./modularRoadParkour.js";

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

/**
 * Rotating-tube shell + hole-rim geometry.
 *
 * A drive-through tube (axis along local Z, centred on the origin) whose wall
 * has rectangular holes punched through it. Built as an (angle × length) grid
 * of cells; holes are INTEGER cell ranges, so hole borders align with the grid
 * and the rims come out as clean curved rectangles. Solid cells emit an inner
 * and an outer wall quad; every hole↔solid boundary emits a radial rim quad.
 * Rims are returned separately so they can glow (you need to see the holes
 * coming while the tube spins).
 *
 * θ = 0 is the tube BOTTOM; position on the circle = (R·sinθ, −R·cosθ, z).
 *
 * @param {number} Ri inner (drivable) radius
 * @param {number} wall wall thickness
 * @param {number} L tube length
 * @param {{a:number, span:number, z:number, len:number}[]} holes
 *        a/span = angular centre/width (rad), z/len = centre/length (m)
 * @returns {{shell: THREE.BufferGeometry, rims: THREE.BufferGeometry}}
 */
function rotoTubeGeometries(Ri, wall, L, holes) {
  const Ro = Ri + wall;
  const A = 64; // angular cells
  const NZ = Math.max(8, Math.round(L / 1.25)); // length cells
  const da = (2 * Math.PI) / A;
  const dz = L / NZ;

  // Holes as integer cell ranges (angular range wraps).
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

  const mkEmit = () => ({ pos: [], idx: [] });
  const quad = (part, a, b, c, d) => {
    const base = part.pos.length / 3;
    part.pos.push(...a, ...b, ...c, ...d);
    part.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  const shell = mkEmit();
  const rims = mkEmit();

  for (let ia = 0; ia < A; ia++) {
    const ja = (ia + 1) % A;
    for (let iz = 0; iz < NZ; iz++) {
      if (isHole(ia, iz)) {
        // Rim quads on every edge shared with a solid neighbour.
        if (!isHole((ia - 1 + A) % A, iz)) quad(rims, pt(ia, Ri, iz), pt(ia, Ri, iz + 1), pt(ia, Ro, iz + 1), pt(ia, Ro, iz));
        if (!isHole(ja, iz)) quad(rims, pt(ja, Ri, iz), pt(ja, Ro, iz), pt(ja, Ro, iz + 1), pt(ja, Ri, iz + 1));
        if (iz === 0 || !isHole(ia, iz - 1)) quad(rims, pt(ia, Ri, iz), pt(ia, Ro, iz), pt(ja, Ro, iz), pt(ja, Ri, iz));
        if (iz === NZ - 1 || !isHole(ia, iz + 1)) quad(rims, pt(ia, Ri, iz + 1), pt(ja, Ri, iz + 1), pt(ja, Ro, iz + 1), pt(ia, Ro, iz + 1));
        continue;
      }
      quad(shell, pt(ia, Ri, iz), pt(ja, Ri, iz), pt(ja, Ri, iz + 1), pt(ia, Ri, iz + 1)); // inner wall
      quad(shell, pt(ia, Ro, iz), pt(ia, Ro, iz + 1), pt(ja, Ro, iz + 1), pt(ja, Ro, iz)); // outer wall
    }
    // Annular end caps (solid cells only — a hole reaching an end stays open).
    if (!isHole(ia, 0)) quad(shell, pt(ia, Ri, 0), pt(ia, Ro, 0), pt(ja, Ro, 0), pt(ja, Ri, 0));
    if (!isHole(ia, NZ - 1)) quad(shell, pt(ia, Ri, NZ), pt(ja, Ri, NZ), pt(ja, Ro, NZ), pt(ia, Ro, NZ));
  }

  const toGeo = (part) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(part.pos, 3));
    g.setIndex(part.idx);
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  };
  return { shell: toGeo(shell), rims: toGeo(rims) };
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
    defaults: { speed: 0.32, amplitude: 5 },
    make: () => {
      const elevTravel = 5;
      const elevHalf = 0.45;
      const elevDeckTop = 1;
      const elevOriginY = elevDeckTop - elevHalf + elevTravel;
      const root = new THREE.Group();
      root.name = "Elevator";
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(10, 0.9, 12),
        new THREE.MeshStandardMaterial({ color: 0x8098a8, roughness: 0.85, side: THREE.DoubleSide }),
      );
      mesh.name = "ElevatorPlatform";
      const railL = new THREE.Mesh(new THREE.BoxGeometry(0.5, 2.2, 12), moverMat(0x607888));
      railL.position.set(-5.25, 1.1, 0);
      const railR = new THREE.Mesh(new THREE.BoxGeometry(0.5, 2.2, 12), moverMat(0x607888));
      railR.position.set(5.25, 1.1, 0);
      mesh.add(railL, railR);
      mesh.position.set(0, elevOriginY, 0);
      root.add(mesh);
      return bindMover(root, {
        mesh,
        mode: "slide-y",
        speed: 0.32,
        amplitude: elevTravel,
        isDeck: true,
        phase0: -Math.PI / 2,
        slideOrigin: new V3(0, elevOriginY, 0),
      });
    },
  },
  {
    id: "rototube",
    label: "Rotating tube",
    collision: "deck",
    defaults: { speed: 0.55, amplitude: 8 },
    make: () => {
      // Drive-through barrel that spins about its own axis. The wall is the
      // road (inner radius matches the kit's rideable tube, so it lines up with
      // Tube pieces), and rectangular holes are punched through it — as the
      // tube turns, a hole sweeping under the car is bare sky. isDeck: the
      // shell rebakes into the wheel BVH every tick, so the missing cells are
      // really missing for physics too.
      const Ri = 8;
      const wall = 0.6;
      const L = 40;
      const deg = THREE.MathUtils.degToRad;
      const { shell, rims } = rotoTubeGeometries(Ri, wall, L, [
        { a: deg(0), span: deg(80), z: -12, len: 7 },
        { a: deg(100), span: deg(70), z: -4, len: 7 },
        { a: deg(200), span: deg(90), z: 4, len: 7 },
        { a: deg(300), span: deg(70), z: 12, len: 7 },
      ]);
      const root = new THREE.Group();
      root.name = "RotoTube";
      const pivot = new THREE.Object3D();
      pivot.position.set(0, Ri, 0); // inner floor rests on y = 0
      root.add(pivot);
      // Glossy metal barrel — low roughness so the spin reads in the highlights.
      const mesh = new THREE.Mesh(
        shell,
        new THREE.MeshStandardMaterial({
          color: 0x8fb6cc,
          metalness: 0.85,
          roughness: 0.16,
          side: THREE.DoubleSide,
        }),
      );
      mesh.name = "RotoTubeShell";
      // Emissive hole rims (bloomed) — you must SEE the holes coming around.
      const rimMat = new THREE.MeshStandardNodeMaterial({
        color: new THREE.Color(0xff5a1e),
        emissive: new THREE.Color(0xff5a1e),
        emissiveIntensity: 4,
        roughness: 0.4,
        side: THREE.DoubleSide,
      });
      applyBloomMRT(rimMat, materialEmissive);
      mesh.add(new THREE.Mesh(rims, rimMat)); // child ⇒ visual only, no collision
      pivot.add(mesh);
      return bindMover(root, { mesh, pivot, mode: "spin-z", speed: 0.55, amplitude: 8, isDeck: true });
    },
  },
];

export const MOVER_BY_ID = new Map(MOVER_CATALOG.map((m) => [m.id, m]));

export class MoverPropManager {
  constructor({ scene, camera, domElement, orbit, onChange = null, onSelect = null }) {
    this.scene = scene;
    this.camera = camera;
    this.domElement = domElement;
    this.orbit = orbit;
    this.onChange = onChange;
    this.onSelect = onSelect;
    this.enabled = false;
    /** Handles down while a placement brush owns the pointer. See suspendGizmo. */
    this._gizmoSuspended = false;

    /** @type {{id:string, def:object, root:THREE.Object3D, collision:string, params:object, mover:ParkourMover|null}[]} */
    this.instances = [];
    this.selected = null;

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

    this.selBox = new THREE.BoxHelper(new THREE.Object3D(), 0xff8866);
    this.selBox.visible = false;
    scene.add(this.selBox);

    this.gizmo.addEventListener("dragging-changed", (e) => {
      if (this.orbit) this.orbit.enabled = !e.value && this.enabled;
    });
    this.gizmo.addEventListener("change", () => {
      if (this.selected) this.selBox.setFromObject(this.selected.root);
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

  getDeckMovers() {
    return this.getMovers().filter((m) => m.isDeck);
  }

  update(dt) {
    for (const inst of this.instances) inst.mover?.update(dt);
  }

  rebuildMovers() {
    this.scene.updateMatrixWorld(true);
    for (const inst of this.instances) {
      const cfg = this._moverConfig(inst);
      if (!cfg) continue;
      inst.mover = new ParkourMover(cfg);
      inst.mover.update(0);
    }
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
    this.selected = null;
    this.gizmo.detach();
    this.gizmo.enabled = false;
    this.gizmo.getHelper().visible = false;
    this.selBox.visible = false;
  }

  collisionMeshes() {
    const deck = [];
    const solids = [];
    for (const inst of this.instances) {
      const b = inst.root.userData.moverBind;
      if (!b?.mesh) continue;
      if (inst.collision === "deck" || inst.collision === "both") deck.push(b.mesh);
      if (inst.collision === "solid" || inst.collision === "both") solids.push(b.mesh);
    }
    return { deck, solids };
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
    };
    if (b.mode === "slide-z" || b.mode === "slide-y") {
      cfg.origin = (b.slideOrigin ?? b.mesh.position).clone();
    }
    return cfg;
  }

  _select(inst) {
    this.onSelect?.();
    this.selected = inst;
    this.gizmo.attach(inst.root);
    this.selBox.setFromObject(inst.root);
    this.selBox.visible = true;
    // Not `enabled = true` outright: add() selects what it just placed, and with
    // a brush still armed that fresh gizmo would sit right where the next click
    // is going.
    this._applyGizmoSuspend();
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
    this.group.remove(inst.root);
    inst.root.traverse((o) => {
      if (o.isMesh) o.geometry?.dispose?.();
    });
  }
}
