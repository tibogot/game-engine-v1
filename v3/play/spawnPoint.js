import * as THREE from "three";

/**
 * Player start — the world position + facing play mode spawns the character at.
 *
 * The editor stores only { x, z, yaw }; the Y is re-sampled from the ground
 * every time the terrain changes (and again by play mode on enter), so sculpting
 * under the marker never leaves it buried or floating.
 */

const CAP_R = 0.4;
const CAP_H = 1.2;

/** Keep yaw in (-π, π] so the panel's -180..180 slider always matches the state. */
function wrapPi(a) {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

export function createSpawnPointSystem({ scene, getGroundY }) {
  const state = { x: 0, z: 0, yaw: 0 };
  let placed = false;
  let editActive = false;

  const group = new THREE.Group();
  group.name = "SpawnPoint";
  group.visible = false;
  group.renderOrder = 999;
  scene.add(group);

  const ghostMat = new THREE.MeshBasicMaterial({
    color: 0x3fd6a0, transparent: true, opacity: 0.35, depthTest: false,
  });
  const lineMat = new THREE.MeshBasicMaterial({
    color: 0x3fd6a0, transparent: true, opacity: 0.9, depthTest: false,
  });

  const ghost = new THREE.Mesh(new THREE.CapsuleGeometry(CAP_R, CAP_H, 4, 12), ghostMat);
  ghost.position.y = CAP_R + CAP_H / 2;
  group.add(ghost);

  const ring = new THREE.Mesh(new THREE.RingGeometry(0.9, 1.05, 40), lineMat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.02;
  group.add(ring);

  // Facing arrow — points along -Z of the group, which is the character's forward.
  const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.32, 0.8, 12), lineMat);
  arrow.rotation.x = -Math.PI / 2;
  arrow.position.set(0, 0.05, -1.5);
  group.add(arrow);

  function syncTransform() {
    group.position.set(state.x, getGroundY(state.x, state.z), state.z);
    group.rotation.y = state.yaw;
    group.visible = placed;
  }

  function setEmphasis(on) {
    const o = on ? 0.55 : 0.3;
    ghostMat.opacity = o;
    lineMat.opacity = on ? 1 : 0.75;
  }

  return {
    group,
    state,
    get placed() { return placed; },

    /** World position; yaw optional (kept when omitted). */
    setPosition(x, z, yaw = null) {
      state.x = x;
      state.z = z;
      if (yaw != null) state.yaw = wrapPi(yaw);
      placed = true;
      syncTransform();
    },

    setYaw(yaw) {
      state.yaw = wrapPi(yaw);
      syncTransform();
    },

    /** Face the point (tx,tz) — used for click-drag placement. */
    aimAt(tx, tz) {
      const dx = tx - state.x;
      const dz = tz - state.z;
      if (dx * dx + dz * dz < 0.25) return;   // too close to read a direction
      state.yaw = wrapPi(Math.atan2(dx, dz) + Math.PI); // group forward is -Z
      syncTransform();
    },

    clear() {
      placed = false;
      group.visible = false;
    },

    /** Re-drape on the (possibly re-sculpted) ground. */
    refreshHeight() {
      if (placed) syncTransform();
    },

    setEditActive(on) {
      editActive = on;
      setEmphasis(on);
    },

    setVisible(v) {
      group.visible = !!v && placed;
    },

    /** { x, y, z, yaw } for play mode, or null when nothing is placed. */
    getSpawn() {
      if (!placed) return null;
      return { x: state.x, y: getGroundY(state.x, state.z), z: state.z, yaw: state.yaw };
    },

    exportData() {
      return placed ? { x: state.x, z: state.z, yaw: state.yaw } : null;
    },

    importData(d) {
      if (!d || !Number.isFinite(d.x) || !Number.isFinite(d.z)) {
        placed = false;
        group.visible = false;
        return;
      }
      state.x = d.x;
      state.z = d.z;
      state.yaw = Number.isFinite(d.yaw) ? wrapPi(d.yaw) : 0;
      placed = true;
      syncTransform();
      setEmphasis(editActive);
    },
  };
}
