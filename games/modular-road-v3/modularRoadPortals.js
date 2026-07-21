import * as THREE from "three";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { TIRE } from "../../v3/play/modularRoadVehicle.js";

/**
 * Paired teleport doors for modular-road test drive.
 * Place two doors in build mode — they auto-link as A ↔ B.
 */

export const DEFAULT_PORTAL_PARAMS = {
  enabled: true,
  width: 3.5,
  height: 4.5,
  /** Local +Z exit offset (m) so the car clears the trigger volume. */
  exitOffset: 2.75,
  /** Mutual cooldown after a teleport (s). */
  cooldownTime: 2.2,
  /** Min horizontal speed (m/s) toward the portal plane to trigger. */
  minEntrySpeed: 1.5,
  colorA: "#00eeff",
  colorB: "#cc66ff",
};

const _local = new THREE.Vector3();
const _worldPos = new THREE.Vector3();
const _through = new THREE.Vector3();
const _velHoriz = new THREE.Vector3();
const _exitPos = new THREE.Vector3();
const _exitQuat = new THREE.Quaternion();
const _yAxis = new THREE.Vector3(0, 1, 0);
const _invMat = new THREE.Matrix4();

function yawQuatFromObject(obj, out) {
  obj.getWorldQuaternion(out);
  const yaw = Math.atan2(
    2 * (out.w * out.y + out.x * out.z),
    1 - 2 * (out.y * out.y + out.x * out.x),
  );
  return out.setFromAxisAngle(_yAxis, yaw);
}

/** Exported for the palette thumbnail bake (roadGame bakes "portal_door"). */
export function buildPortalMesh(params, colorHex, side) {
  const W = params.width;
  const H = params.height;
  const hw = W / 2;
  const hh = H / 2;

  const root = new THREE.Group();
  root.name = side === "a" ? "PortalA" : side === "b" ? "PortalB" : "PortalDoor";

  const frameMat = new THREE.MeshStandardMaterial({
    color: 0x1a1030,
    roughness: 0.4,
    metalness: 0.7,
    emissive: side === "b" ? 0x440066 : 0x003366,
    emissiveIntensity: 0.45,
  });

  const surfaceMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    emissive: new THREE.Color(colorHex),
    emissiveIntensity: 1.35,
    transparent: true,
    opacity: 0.72,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });

  const postL = new THREE.Mesh(new THREE.BoxGeometry(0.45, H + 0.5, 0.45), frameMat);
  postL.position.set(-hw - 0.22, hh + 0.25, 0);
  postL.castShadow = true;
  root.add(postL);

  const postR = new THREE.Mesh(new THREE.BoxGeometry(0.45, H + 0.5, 0.45), frameMat);
  postR.position.set(hw + 0.22, hh + 0.25, 0);
  postR.castShadow = true;
  root.add(postR);

  const lintel = new THREE.Mesh(new THREE.BoxGeometry(W + 0.9, 0.45, 0.45), frameMat);
  lintel.position.set(0, H + 0.45, 0);
  lintel.castShadow = true;
  root.add(lintel);

  const surface = new THREE.Mesh(new THREE.PlaneGeometry(W, H), surfaceMat);
  surface.position.set(0, hh, 0.06);
  root.add(surface);

  return { root, surfaceMat, frameMat };
}

export class PortalManager {
  /**
   * @param {object} o
   * @param {THREE.Scene} o.scene
   * @param {THREE.Camera} o.camera
   * @param {HTMLElement} o.domElement
   * @param {import("three/addons/controls/OrbitControls.js").OrbitControls} o.orbit
   * @param {typeof DEFAULT_PORTAL_PARAMS} [o.params]
   * @param {() => void} [o.onChange]
   * @param {() => void} [o.onActivate] fired when a door is selected/placed (deselect other gizmos)
   */
  constructor({ scene, camera, domElement, orbit, params = DEFAULT_PORTAL_PARAMS, onChange = null, onActivate = null }) {
    this.scene = scene;
    this.camera = camera;
    this.domElement = domElement;
    this.orbit = orbit;
    this.params = params;
    this.onChange = onChange;
    this.onActivate = onActivate;
    this.buildEnabled = false;

    /** @type {{id:number,a:object,b:object,enabled:boolean,cooldown:number}[]} */
    this.pairs = [];
    /** @type {object|null} door waiting for a pair partner */
    this._pending = null;
    this._nextId = 1;
    this.selected = null;
    this._elapsed = 0;

    this.group = new THREE.Group();
    this.group.name = "PortalDoors";
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

    this.selBox = new THREE.BoxHelper(new THREE.Object3D(), 0x66ffe0);
    this.selBox.visible = false;
    scene.add(this.selBox);

    this.gizmo.addEventListener("dragging-changed", (e) => {
      if (this.orbit) this.orbit.enabled = !e.value && this.buildEnabled;
    });
    this.gizmo.addEventListener("change", () => {
      if (this.selected) this.selBox.setFromObject(this.selected.root);
    });
    this.gizmo.addEventListener("mouseUp", () => this.onChange?.());

    domElement.addEventListener("pointerdown", (e) => {
      if (!this.buildEnabled) return;
      if (e.button === 2) this._pickAt(e);
    });

    window.addEventListener("keydown", (e) => this._onKey(e), true);
  }

  setBuildEnabled(on) {
    this.buildEnabled = on;
    if (!on) this.deselect();
  }

  isUsingGizmo() {
    return this.buildEnabled && (this.gizmo.dragging || this.gizmo.axis != null);
  }

  get hasSelection() {
    return !!this.selected;
  }

  setMode(mode) {
    this.gizmo.setMode(mode);
  }

  /** Spawn a door; auto-pairs with the previous unpaired door. */
  addDoor() {
    const side = this._pending ? "b" : "a";
    const color = side === "b" ? this.params.colorB : this.params.colorA;
    const { root, surfaceMat } = buildPortalMesh(this.params, color, side);
    root.userData.isPortal = true;

    if (this.orbit?.target) {
      root.position.set(this.orbit.target.x, 0, this.orbit.target.z);
    }

    const door = {
      root,
      surfaceMat,
      side,
      pairId: null,
    };
    root.userData.portalDoor = door;
    this.group.add(root);

    if (this._pending) {
      const pair = {
        id: this._nextId++,
        a: this._pending,
        b: door,
        enabled: true,
        cooldown: 0,
      };
      this._pending.pairId = pair.id;
      door.pairId = pair.id;
      this.pairs.push(pair);
      this._pending = null;
      this._select(door);
    } else {
      this._pending = door;
      this._select(door);
    }

    this.onChange?.();
    return door;
  }

  deleteSelected() {
    if (!this.selected) return;
    const door = this.selected;
    if (door.pairId != null) {
      const idx = this.pairs.findIndex((p) => p.id === door.pairId);
      if (idx >= 0) {
        const pair = this.pairs[idx];
        this._disposeDoor(pair.a);
        this._disposeDoor(pair.b);
        this.pairs.splice(idx, 1);
      }
    } else {
      this._disposeDoor(door);
      if (this._pending === door) this._pending = null;
    }
    this.deselect();
    this.onChange?.();
  }

  clear() {
    this.deselect();
    for (const pair of this.pairs) {
      this._disposeDoor(pair.a);
      this._disposeDoor(pair.b);
    }
    this.pairs = [];
    if (this._pending) {
      this._disposeDoor(this._pending);
      this._pending = null;
    }
    this.onChange?.();
  }

  deselect() {
    this.selected = null;
    this.gizmo.detach();
    this.gizmo.enabled = false;
    this.gizmo.visible = false;
    this.selBox.visible = false;
  }

  /** Glow pulse — call every frame. */
  updateVisuals(dt) {
    this._elapsed += dt;
    const t = this._elapsed;
    const pulse = (door, phase) => {
      if (!door?.surfaceMat) return;
      door.surfaceMat.emissiveIntensity = 1.1 + 0.55 * Math.sin(t * 2.5 + phase);
      door.surfaceMat.opacity = 0.62 + 0.18 * Math.sin(t * 1.7 + phase * 0.8);
    };
    for (const pair of this.pairs) {
      pulse(pair.a, 0);
      pulse(pair.b, 1.2);
    }
    if (this._pending) pulse(this._pending, 0.4);
  }

  /**
   * Drive-mode teleport checks.
   * @param {import("./modularRoadVehicle.js").Vehicle} vehicle
   */
  updateDrive(dt, vehicle) {
    if (!this.params.enabled || !vehicle?.enabled) return;

    for (const pair of this.pairs) {
      if (!pair.enabled) continue;
      pair.cooldown = Math.max(0, pair.cooldown - dt);
      if (pair.cooldown > 0) continue;

      if (this._tryTeleport(vehicle, pair.a, pair.b)) {
        pair.cooldown = this.params.cooldownTime;
      } else if (this._tryTeleport(vehicle, pair.b, pair.a)) {
        pair.cooldown = this.params.cooldownTime;
      }
    }
  }

  _tryTeleport(vehicle, entry, exit) {
    if (!this._inTrigger(vehicle, entry)) return false;
    this._applyTeleport(vehicle, exit);
    return true;
  }

  _inTrigger(vehicle, door) {
    door.root.updateMatrixWorld(true);
    _invMat.copy(door.root.matrixWorld).invert();
    _local.copy(vehicle.body.pos).applyMatrix4(_invMat);

    const hw = this.params.width * 0.5 + 0.35;
    const h = this.params.height;
    const depth = 1.1;

    if (
      Math.abs(_local.x) > hw ||
      _local.y < -0.35 ||
      _local.y > h + 0.35 ||
      _local.z < -0.55 ||
      _local.z > depth
    ) {
      return false;
    }

    door.root.getWorldDirection(_through);
    _velHoriz.copy(vehicle.body.vel);
    _velHoriz.y = 0;
    const speed = _velHoriz.length();
    if (speed < this.params.minEntrySpeed) return false;
    _velHoriz.divideScalar(speed);
    return _velHoriz.dot(_through) > 0.25;
  }

  _applyTeleport(vehicle, exitDoor) {
    exitDoor.root.updateMatrixWorld(true);
    exitDoor.root.getWorldPosition(_worldPos);
    yawQuatFromObject(exitDoor.root, _exitQuat);
    exitDoor.root.getWorldDirection(_through);

    _exitPos.copy(_worldPos).addScaledVector(_through, this.params.exitOffset);
    _exitPos.y = _worldPos.y + TIRE.restLength + 0.15;

    vehicle.teleportTo(_exitPos, _exitQuat, { preserveSpeed: true, dampVertical: true });
  }

  _serializeDoorTransform(root) {
    return {
      position: root.position.toArray(),
      quaternion: root.quaternion.toArray(),
      scale: root.scale.toArray(),
    };
  }

  _applyDoorTransform(root, t) {
    if (Array.isArray(t.position)) root.position.fromArray(t.position);
    if (Array.isArray(t.quaternion)) root.quaternion.fromArray(t.quaternion);
    if (Array.isArray(t.scale)) root.scale.fromArray(t.scale);
  }

  /** @returns {{ pairs: object[], pending: object|null, nextId: number }} */
  exportLayout() {
    return {
      pairs: this.pairs.map((pair) => ({
        id: pair.id,
        enabled: pair.enabled,
        a: this._serializeDoorTransform(pair.a.root),
        b: this._serializeDoorTransform(pair.b.root),
      })),
      pending: this._pending ? this._serializeDoorTransform(this._pending.root) : null,
      nextId: this._nextId,
    };
  }

  /** @param {{ pairs?: object[], pending?: object|null, nextId?: number }} data */
  importLayout(data) {
    this.clear();
    if (!data) return;
    let maxId = 0;

    const spawnDoor = (side, transform) => {
      const color = side === "b" ? this.params.colorB : this.params.colorA;
      const { root, surfaceMat } = buildPortalMesh(this.params, color, side);
      root.userData.isPortal = true;
      if (transform) this._applyDoorTransform(root, transform);
      const door = { root, surfaceMat, side, pairId: null };
      root.userData.portalDoor = door;
      this.group.add(root);
      return door;
    };

    for (const row of data.pairs || []) {
      const id = row.id ?? ++maxId;
      maxId = Math.max(maxId, id);
      const doorA = spawnDoor("a", row.a);
      const doorB = spawnDoor("b", row.b);
      doorA.pairId = id;
      doorB.pairId = id;
      this.pairs.push({
        id,
        a: doorA,
        b: doorB,
        enabled: row.enabled !== false,
        cooldown: 0,
      });
    }

    if (data.pending) {
      this._pending = spawnDoor("a", data.pending);
    }

    this._nextId = Math.max(data.nextId ?? 1, maxId + 1);
    this.onChange?.();
  }

  /* ----- selection / gizmo ----- */

  _select(door) {
    this.onActivate?.();
    this.selected = door;
    this.gizmo.attach(door.root);
    this.gizmo.enabled = true;
    this.gizmo.visible = true;
    this.selBox.setFromObject(door.root);
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
      while (o && !o.userData.portalDoor) o = o.parent;
      if (o?.userData.portalDoor) {
        this._select(o.userData.portalDoor);
        return;
      }
    }
    this.deselect();
  }

  _onKey(e) {
    if (!this.buildEnabled || !this.selected) return;
    if (e.target instanceof HTMLInputElement) return;
    let handled = true;
    switch (e.code) {
      case "KeyW":
        this.setMode("translate");
        break;
      case "KeyE":
        this.setMode("rotate");
        break;
      case "KeyR":
        this.setMode("scale");
        break;
      case "KeyQ":
        this.gizmo.setSpace(this.gizmo.space === "local" ? "world" : "local");
        break;
      case "Delete":
      case "Backspace":
        this.deleteSelected();
        break;
      case "Escape":
        this.deselect();
        break;
      default:
        handled = false;
    }
    if (handled) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }

  _disposeDoor(door) {
    this.group.remove(door.root);
    door.root.traverse((o) => {
      if (o.isMesh) {
        o.geometry?.dispose?.();
        if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose?.());
        else o.material?.dispose?.();
      }
    });
  }
}
