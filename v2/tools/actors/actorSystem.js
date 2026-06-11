import * as THREE from "three";
import { MeshStandardNodeMaterial } from "three";
import {
  createActorPlayRuntime,
  updateActorPlayInstance,
} from "../../play/actorPlayRuntime.js";

/** Editor placeholders — swap for skinned GLB + mixer in play/runtime later. */
const DEFAULT_NPC_COLOR = 0x33aa88;
const DEFAULT_ENEMY_COLOR = 0x8b2549;
const ARROW_COLOR = 0xffee88;

/**
 * Unity-style actor spawns: capsule placeholders, terrain placement, transform gizmo.
 */
export class ActorSystem {
  constructor({ scene, toolState, getWorldHeight, transformControls, worldHalf = Infinity }) {
    this.scene = scene;
    this.toolState = toolState;
    this.getWorldHeight = getWorldHeight;
    this.transformControls = transformControls;
    this.worldHalf = worldHalf;
    this.instances = [];
    this.selected = null;
    this._nextId = 1;
    this._raycaster = new THREE.Raycaster();
    this._footOffset = 0;
    this.playActive = false;
    this.playGroup = new THREE.Group();
    this.playGroup.name = "ActorPlaySpawns";
    this.playGroup.visible = false;
    this.scene.add(this.playGroup);

    this._npcMat = new MeshStandardNodeMaterial({
      color: DEFAULT_NPC_COLOR,
      roughness: 0.45,
      metalness: 0,
    });
    this._enemyMat = new MeshStandardNodeMaterial({
      color: DEFAULT_ENEMY_COLOR,
      roughness: 0.45,
      metalness: 0,
    });
    this._arrowMat = new MeshStandardNodeMaterial({
      color: ARROW_COLOR,
      roughness: 0.6,
      metalness: 0,
    });
    this._arrowGeo = new THREE.ConeGeometry(0.12, 0.35, 8);
    this._arrowGeo.translate(0, 0.175, 0);
    this.syncMaterials();
    this._recomputeFootOffset();
  }

  get hasSelection() {
    return this.selected != null;
  }

  _recomputeFootOffset() {
    const p = this.toolState.actors;
    this._footOffset = p.capsuleRadius + p.capsuleHeight * 0.5;
  }

  _capsuleGeo() {
    const p = this.toolState.actors;
    return new THREE.CapsuleGeometry(p.capsuleRadius, p.capsuleHeight, 8, 16);
  }

  _centerYAtFoot(worldX, footY, worldZ) {
    return footY + this._footOffset;
  }

  _footYFromCenter(centerY) {
    return centerY - this._footOffset;
  }

  snapMeshToTerrain(mesh) {
    const p = this.toolState.actors;
    const ground = this.getWorldHeight(mesh.position.x, mesh.position.z);
    const footY = ground + (p.floorOffset ?? 0);
    mesh.position.y = this._centerYAtFoot(mesh.position.x, footY, mesh.position.z);
  }

  /** Re-ground every spawn after terrain sculpt / undo (editor + active play copies). */
  snapAllToTerrain() {
    for (const inst of this.instances) {
      const yaw = inst.mesh.rotation.y;
      this.snapMeshToTerrain(inst.mesh);
      inst.mesh.rotation.y = yaw;
      if (inst.playMesh) {
        const py = inst.playMesh.rotation.y;
        inst.playMesh.position.x = inst.mesh.position.x;
        inst.playMesh.position.z = inst.mesh.position.z;
        inst.playMesh.scale.copy(inst.mesh.scale);
        this.snapMeshToTerrain(inst.playMesh);
        inst.playMesh.rotation.y = py;
        if (inst.playRuntime) {
          inst.playRuntime.spawnX = inst.playMesh.position.x;
          inst.playRuntime.spawnZ = inst.playMesh.position.z;
          inst.playRuntime.currentYaw = py;
        }
      }
    }
  }

  syncMaterials() {
    const p = this.toolState.actors;
    this._npcMat.color.set(p.npcColor ?? DEFAULT_NPC_COLOR);
    this._enemyMat.color.set(p.enemyColor ?? DEFAULT_ENEMY_COLOR);
    this._recomputeFootOffset();
  }

  refreshCapsuleGeometry() {
    this.syncMaterials();
    for (const inst of this.instances) {
      const old = inst.mesh.geometry;
      inst.mesh.geometry = this._capsuleGeo();
      old.dispose();
      this.snapMeshToTerrain(inst.mesh);
    }
  }

  _createMesh(role, { editorArrow = false } = {}) {
    const mesh = new THREE.Mesh(this._capsuleGeo(), role === "enemy" ? this._enemyMat : this._npcMat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.isActor = true;
    mesh.userData.actorRole = role;
    mesh.userData.isPlayActor = !editorArrow;

    if (editorArrow) {
      const arrow = new THREE.Mesh(this._arrowGeo, this._arrowMat);
      arrow.name = "FacingArrow";
      arrow.rotation.x = Math.PI / 2;
      const p = this.toolState.actors;
      const fwd = p.capsuleRadius + 0.55;
      arrow.position.set(0, p.capsuleHeight * 0.15, fwd);
      mesh.add(arrow);
    }

    return mesh;
  }

  /** Copy editor spawn → play capsule, snap feet to live terrain height. */
  _spawnPlayMeshFromEditor(inst) {
    const mesh = this._createMesh(inst.role, { editorArrow: false });
    const src = inst.mesh;
    const half = this.worldHalf;
    const x = THREE.MathUtils.clamp(src.position.x, -half, half);
    const z = THREE.MathUtils.clamp(src.position.z, -half, half);
    mesh.position.set(x, src.position.y, z);
    mesh.rotation.copy(src.rotation);
    mesh.scale.copy(src.scale);
    this.snapMeshToTerrain(mesh);
    mesh.rotation.y = src.rotation.y;
    return mesh;
  }

  /**
   * Play mode: hide editor gizmos/meshes, show terrain-snapped play copies.
   */
  enterPlayMode() {
    this.exitPlayMode();
    this.deselect();
    this.syncMaterials();

    const p = this.toolState.actors;
    for (const inst of this.instances) {
      const roleDefaults =
        inst.role === "enemy" ? p.enemyDefaults : p.npcDefaults;
      if (!inst.enabled || !roleDefaults.enabled) {
        inst.mesh.visible = false;
        continue;
      }

      const playMesh = this._spawnPlayMeshFromEditor(inst);
      this.playGroup.add(playMesh);
      inst.playMesh = playMesh;
      inst.playRuntime = createActorPlayRuntime(playMesh);
      inst.mesh.visible = false;
    }

    this.playActive = true;
    this.playGroup.visible = true;
  }

  /** Restore editor capsules; remove play-only meshes. */
  exitPlayMode() {
    if (!this.playActive && this.playGroup.children.length === 0) return;

    for (const inst of this.instances) {
      inst.mesh.visible = true;
      if (inst.playMesh) {
        this.playGroup.remove(inst.playMesh);
        inst.playMesh.geometry.dispose();
        inst.playMesh = null;
      }
      inst.playRuntime = null;
      this.snapMeshToTerrain(inst.mesh);
    }

    while (this.playGroup.children.length > 0) {
      const ch = this.playGroup.children[0];
      this.playGroup.remove(ch);
      ch.geometry?.dispose?.();
    }

    this.playActive = false;
    this.playGroup.visible = false;
  }

  placeAt(point, role) {
    const r = role === "enemy" ? "enemy" : "npc";
    const mesh = this._createMesh(r, { editorArrow: true });
    const p = this.toolState.actors;
    const footY = point.y + (p.floorOffset ?? 0);
    mesh.position.set(point.x, this._centerYAtFoot(point.x, footY, point.z), point.z);
    this.scene.add(mesh);

    const inst = {
      id: this._nextId++,
      role: r,
      mesh,
      enabled: true,
      maxHp: r === "enemy" ? (p.enemyDefaults.maxHp ?? 100) : 0,
      label: "",
      dialogueId: p.dialogue?.defaultDialogueId ?? "villager_greet",
    };
    this.instances.push(inst);
    this.select(inst);
    return inst;
  }

  select(inst) {
    this.selected = inst ?? null;
    if (!inst?.mesh) {
      this.deselect();
      return;
    }
    this.transformControls.attach(inst.mesh);
    this.transformControls.enabled = true;
    this.transformControls.visible = true;
  }

  selectMesh(mesh) {
    const inst = this.instances.find((i) => i.mesh === mesh);
    if (inst) this.select(inst);
  }

  deselect() {
    this.selected = null;
    this.transformControls.detach();
    this.transformControls.enabled = false;
    this.transformControls.visible = false;
  }

  handlePointerDown(pointerNdc, camera, terrainHit) {
    if (this.playActive) return false;
    if (this.transformControls.dragging) return false;
    const meshes = this.instances.map((i) => i.mesh);
    this._raycaster.setFromCamera(pointerNdc, camera);
    const hits = this._raycaster.intersectObjects(meshes, true);
    if (hits.length > 0) {
      let obj = hits[0].object;
      while (obj.parent && !obj.userData?.isActor) obj = obj.parent;
      if (obj.userData?.isActor) {
        this.selectMesh(obj);
        return true;
      }
    }
    if (terrainHit?.point) {
      const role = this.toolState.actors.placeTool === "enemy" ? "enemy" : "npc";
      this.placeAt(terrainHit.point, role);
      return true;
    }
    return false;
  }

  deleteSelected() {
    if (!this.selected) return;
    const idx = this.instances.indexOf(this.selected);
    if (idx >= 0) {
      const inst = this.instances[idx];
      this.scene.remove(inst.mesh);
      inst.mesh.geometry.dispose();
      this.instances.splice(idx, 1);
    }
    this.deselect();
  }

  clearAll() {
    for (const inst of this.instances) {
      this.scene.remove(inst.mesh);
      inst.mesh.geometry.dispose();
    }
    this.instances = [];
    this.deselect();
  }

  clearByRole(role) {
    const keep = [];
    for (const inst of this.instances) {
      if (inst.role === role) {
        this.scene.remove(inst.mesh);
        inst.mesh.geometry.dispose();
        if (this.selected === inst) this.deselect();
      } else {
        keep.push(inst);
      }
    }
    this.instances = keep;
  }

  /** Nearest NPC in interact range (play mode only). */
  findInteractableNpc(playerPos) {
    const dlg = this.toolState.actors.dialogue;
    if (!dlg?.enabled || !playerPos) return null;
    const r2 = (dlg.interactRadius ?? 3.5) ** 2;
    let best = null;
    let bestD = r2;
    for (const inst of this.instances) {
      if (inst.role !== "npc" || !inst.playMesh || !inst.enabled) continue;
      const dx = inst.playMesh.position.x - playerPos.x;
      const dz = inst.playMesh.position.z - playerPos.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD) {
        bestD = d2;
        best = inst;
      }
    }
    return best;
  }

  getCounts() {
    let npc = 0;
    let enemy = 0;
    for (const i of this.instances) {
      if (i.role === "enemy") enemy++;
      else npc++;
    }
    return { npc, enemy, total: npc + enemy };
  }

  exportData() {
    return {
      spawns: this.instances.map((inst) => {
        const m = inst.mesh;
        return {
          id: inst.id,
          role: inst.role,
          enabled: inst.enabled !== false,
          maxHp: inst.maxHp,
          label: inst.label || "",
          dialogueId: inst.dialogueId || "",
          x: m.position.x,
          y: m.position.y,
          z: m.position.z,
          ry: m.rotation.y,
          sx: m.scale.x,
          sy: m.scale.y,
          sz: m.scale.z,
        };
      }),
    };
  }

  importData(data) {
    this.clearAll();
    const p = this.toolState.actors;
    const spawns = Array.isArray(data?.spawns)
      ? data.spawns
      : Array.isArray(data)
        ? data
        : [];
    let maxId = 0;
    for (const d of spawns) {
      const role = d.role === "enemy" ? "enemy" : "npc";
      const mesh = this._createMesh(role, { editorArrow: true });
      mesh.position.set(d.x ?? 0, d.y ?? 0, d.z ?? 0);
      mesh.rotation.y = d.ry ?? 0;
      mesh.scale.set(d.sx ?? 1, d.sy ?? 1, d.sz ?? 1);
      this.scene.add(mesh);
      const id = d.id ?? ++maxId;
      maxId = Math.max(maxId, id);
      this.instances.push({
        id,
        role,
        mesh,
        enabled: d.enabled !== false,
        maxHp: d.maxHp ?? (role === "enemy" ? 100 : 0),
        label: d.label ?? "",
        dialogueId: d.dialogueId ?? p.dialogue?.defaultDialogueId ?? "villager_greet",
      });
    }
    this._nextId = maxId + 1;
    this.deselect();
  }

  handleTransformEnd() {
    if (this.selected?.mesh) this.snapMeshToTerrain(this.selected.mesh);
  }

  /** Wander / face player while Play mode is active. */
  updatePlay(dt, playerPos) {
    if (!this.playActive || dt <= 0) return;
    const p = this.toolState.actors;
    const floorOffset = p.floorOffset ?? 0;

    for (const inst of this.instances) {
      if (!inst.playMesh || !inst.playRuntime) continue;
      const defaults =
        inst.role === "enemy" ? p.enemyDefaults : p.npcDefaults;
      if (!defaults.enabled) continue;

      updateActorPlayInstance(
        inst,
        defaults,
        dt,
        playerPos,
        this.getWorldHeight,
        floorOffset,
        this._footOffset,
        this.worldHalf,
      );
    }
  }

  forEachMeshInstance(cb) {
    const M = new THREE.Matrix4();
    for (const inst of this.instances) {
      inst.mesh.updateMatrixWorld(true);
      M.copy(inst.mesh.matrixWorld);
      cb(inst.mesh.geometry, M);
    }
  }

  undo() {}
  redo() {}

  dispose() {
    this.exitPlayMode();
    this.scene.remove(this.playGroup);
    this.clearAll();
    this._npcMat.dispose();
    this._enemyMat.dispose();
    this._arrowMat.dispose();
    this._arrowGeo.dispose();
  }
}
