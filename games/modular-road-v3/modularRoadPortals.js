import * as THREE from "three";
import { materialColor, materialEmissive } from "three/tsl";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { applyBloomMRT } from "../../v3/render/bloomMRT.js";
import { TIRE } from "../../v3/play/modularRoadVehicle.js";

/**
 * Paired teleport doors for modular-road test drive.
 * Place two doors in build mode — they auto-link as A ↔ B.
 */

export const DEFAULT_PORTAL_PARAMS = {
  enabled: true,
  // Opening is sized for the Emira hull (2.10 m wide, 4.85 m long, ~1.3 m tall)
  // with room to drive through off-centre. The old 3.5 × 4.5 sat under the car.
  width: 6.5,
  height: 8,
  /** Local +Z exit offset (m) so the car clears the trigger volume. */
  exitOffset: 4,
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

function portalMat(hex, opts = {}) {
  const m = new THREE.MeshStandardNodeMaterial({
    color: new THREE.Color(hex),
    roughness: opts.roughness ?? 0.7,
    metalness: opts.metalness ?? 0.1,
    emissive: new THREE.Color(opts.emissive ?? 0x000000),
    emissiveIntensity: opts.emissiveIntensity ?? 1,
    transparent: !!opts.transparent,
    opacity: opts.opacity ?? 1,
    depthWrite: opts.depthWrite ?? true,
    side: opts.side ?? THREE.FrontSide,
  });
  m.envMapIntensity = 0;
  m.colorNode = materialColor;
  if (opts.bloom) {
    applyBloomMRT(m, materialEmissive);
    m.userData.bloom = true;
  }
  return m;
}

/** Three downward V's — header marker on the live (−Z) face. */
function entryChevronGeometry(W, beam) {
  const hw = Math.min(0.48, W * 0.07);
  const hh = Math.min(0.52, beam * 0.62);
  const xs = [-W * 0.26, 0, W * 0.26];
  const pos = [];
  for (const x of xs) {
    // CCW from +Z; the mesh is rotated 180° so FrontSide faces the approach.
    pos.push(x, -hh, 0, x - hw, hh, 0, x + hw, hh, 0);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  return geo;
}

function yawQuatFromObject(obj, out) {
  obj.getWorldQuaternion(out);
  const yaw = Math.atan2(
    2 * (out.w * out.y + out.x * out.z),
    1 - 2 * (out.y * out.y + out.x * out.x),
  );
  return out.setFromAxisAngle(_yAxis, yaw);
}

/** Exported for the palette thumbnail bake (roadGame bakes "portal_door").
 *  Live face is local −Z (drive toward +Z through the sheet). +Z is the dead back. */
export function buildPortalMesh(params, colorHex, side) {
  const W = params.width;
  const H = params.height;
  const hw = W / 2;
  const hh = H / 2;
  const beam = 0.75;
  const sheet = 0.06;

  const root = new THREE.Group();
  root.name = side === "a" ? "PortalA" : side === "b" ? "PortalB" : "PortalDoor";

  const frameMat = portalMat(0x1a1030, {
    roughness: 0.4,
    metalness: 0.7,
    emissive: side === "b" ? 0x440066 : 0x003366,
    emissiveIntensity: 0.35,
  });

  const surfaceMat = portalMat(colorHex, {
    roughness: 0.22,
    metalness: 0.05,
    emissive: colorHex,
    emissiveIntensity: 4.2,
    transparent: true,
    opacity: 0.78,
    depthWrite: false,
    bloom: true,
  });

  const backMat = portalMat(0x08060e, {
    roughness: 0.88,
    metalness: 0.25,
    emissive: new THREE.Color(colorHex).multiplyScalar(0.06).getHex(),
    emissiveIntensity: 0.4,
  });

  const chevronMat = portalMat(colorHex, {
    roughness: 0.22,
    metalness: 0.05,
    emissive: colorHex,
    emissiveIntensity: 5.5,
    bloom: true,
  });

  const postL = new THREE.Mesh(new THREE.BoxGeometry(beam, H + 0.7, beam), frameMat);
  postL.position.set(-hw - beam * 0.5, hh + 0.35, 0);
  postL.castShadow = true;
  root.add(postL);

  const postR = new THREE.Mesh(new THREE.BoxGeometry(beam, H + 0.7, beam), frameMat);
  postR.position.set(hw + beam * 0.5, hh + 0.35, 0);
  postR.castShadow = true;
  root.add(postR);

  const lintel = new THREE.Mesh(new THREE.BoxGeometry(W + beam * 2, beam, beam), frameMat);
  lintel.position.set(0, H + beam, 0);
  lintel.castShadow = true;
  root.add(lintel);

  // Live sheet faces the approach (−Z). FrontSide, so the dead side never sees it.
  const surface = new THREE.Mesh(new THREE.PlaneGeometry(W - 0.08, H - 0.08), surfaceMat);
  surface.rotation.y = Math.PI;
  surface.position.set(0, hh, -sheet);
  root.add(surface);

  // Opaque shutter on +Z — culled from the live side, so the sheet stays see-through.
  const back = new THREE.Mesh(new THREE.PlaneGeometry(W + 0.04, H + 0.04), backMat);
  back.position.set(0, hh, sheet);
  back.castShadow = true;
  root.add(back);

  const chevrons = new THREE.Mesh(entryChevronGeometry(W, beam), chevronMat);
  chevrons.rotation.y = Math.PI;
  chevrons.position.set(0, H + beam * 0.35, -beam * 0.5 - 0.04);
  root.add(chevrons);

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
    /** Handles down while a placement brush owns the pointer. See suspendGizmo. */
    this._gizmoSuspended = false;

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

    // NO RIGHT-CLICK LISTENER HERE ANY MORE. This used to select on its own,
    // on pointerDOWN, while the road builder selected on pointerUP — so a
    // right-click on something sitting on the road selected BOTH, and the
    // road's handler ran second and took the gizmo. roadGame now arbitrates
    // one right-click across every system via hitTest/selectHit.

    window.addEventListener("keydown", (e) => this._onKey(e), true);
  }

  setBuildEnabled(on) {
    this.buildEnabled = on;
    if (!on) this.deselect();
  }

  /**
   * Put the move tool down while a placement brush owns the pointer, KEEPING the
   * selection. `setBuildEnabled(false)` deselects, which is the opposite of what
   * this needs. See PropManager.suspendGizmo for why hovering a gizmo used to eat
   * the place-click.
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
  addDoor(worldPos = null) {
    const side = this._pending ? "b" : "a";
    const color = side === "b" ? this.params.colorB : this.params.colorA;
    const { root, surfaceMat } = buildPortalMesh(this.params, color, side);
    root.userData.isPortal = true;

    if (worldPos) {
      root.position.copy(worldPos);
    } else if (this.orbit?.target) {
      root.position.set(this.orbit.target.x, this.orbit.target.y, this.orbit.target.z);
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
    this.gizmo.getHelper().visible = false;
    this.selBox.visible = false;
  }

  /** Glow pulse — call every frame. */
  updateVisuals(dt) {
    this._elapsed += dt;
    const t = this._elapsed;
    const pulse = (door, phase) => {
      if (!door?.surfaceMat) return;
      door.surfaceMat.emissiveIntensity = 3.6 + 1.2 * Math.sin(t * 2.5 + phase);
      door.surfaceMat.opacity = 0.68 + 0.14 * Math.sin(t * 1.7 + phase * 0.8);
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
    this.selBox.setFromObject(door.root);
    this.selBox.visible = true;
    // Not `enabled = true` outright — a brush may own the pointer. See
    // suspendGizmo.
    this._applyGizmoSuspend();
  }

  /**
   * Nearest portal under the cursor and HOW FAR AWAY it is — no selecting.
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
    // buildEnabled, not `.enabled` — this class never had that flag (props do).
    // The arbiter called hitTest on every right-click, got null, and the door
    // was the one obstacle you could not pick.
    if (!this.buildEnabled) return null;
    const rect = this.domElement.getBoundingClientRect();
    this._ndc.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this._ndc, this.camera);
    for (const h of this.raycaster.intersectObjects(this.group.children, true)) {
      let o = h.object;
      while (o && !o.userData.portalDoor) o = o.parent;
      if (o?.userData.portalDoor) return { dist: h.distance, hit: o.userData.portalDoor };
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
   * Road pieces got arrow-key steps; obstacles had only a gizmo drag, so a portal
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
      // X, NOT Q. Q is the road builder's yaw nudge; having it mean "toggle
      // axes" whenever an obstacle happened to be selected was one key with
      // two meanings. X is world/local everywhere now.
      case "KeyX":
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
