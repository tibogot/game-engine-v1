import * as THREE from "three";
import { TransformControls } from "three/addons/controls/TransformControls.js";
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

    domElement.addEventListener("pointerdown", (e) => {
      if (!this.enabled) return;
      if (e.button === 2) this._pickAt(e);
    });

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

  add(typeId) {
    this.onSelect?.();
    const def = MOVER_BY_ID.get(typeId);
    if (!def) return null;
    const root = def.make();
    enableMeshShadows(root);
    root.userData.isMoverProp = true;
    if (this.orbit?.target) {
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
    this.gizmo.visible = false;
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
    this.gizmo.visible = false;
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
    this.gizmo.enabled = true;
    this.gizmo.visible = true;
    this.selBox.setFromObject(inst.root);
    this.selBox.visible = true;
  }

  _pickAt(e) {
    const rect = this.domElement.getBoundingClientRect();
    this._ndc.set(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this._ndc, this.camera);
    const hits = this.raycaster.intersectObjects(this.group.children, true);
    if (hits.length) {
      let o = hits[0].object;
      while (o && !o.userData.moverPropInstance) o = o.parent;
      if (o?.userData.moverPropInstance) {
        this._select(o.userData.moverPropInstance);
        return;
      }
    }
    this.deselect();
  }

  _onKey(e) {
    if (!this.enabled || !this.selected) return;
    if (e.target instanceof HTMLInputElement) return;
    let handled = true;
    switch (e.code) {
      case "KeyW": this.setMode("translate"); break;
      case "KeyE": this.setMode("rotate"); break;
      case "KeyR": this.setMode("scale"); break;
      case "KeyQ": this.gizmo.setSpace(this.gizmo.space === "local" ? "world" : "local"); break;
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
