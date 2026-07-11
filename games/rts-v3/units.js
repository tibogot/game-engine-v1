// RTS units — GAME code. A small generic unit system: a helicopter (air) and a
// tank (ground), each selectable and movable. Proves the game↔engine loop:
//   • models load through the engine's shared GLTF loader,
//   • units sit on the terrain via app.getWorldHeight,
//   • a move order flies/drives them to a target (selection.js issues orders).
//
// Rotor handling (node names, main=Y spin, tail=X spin ~2.4× faster) is ported
// from the older rts-chibs project so it matches heli5.glb's node layout.
import * as THREE from "three";
import { getSharedGltfLoader, initGlbLoaderRenderer } from "../../v2/core/foliage/glbLoader.js";

// Scratch for terrain-aligned orientation (reused; single-threaded).
const _UP = new THREE.Vector3(0, 1, 0);
const _n = new THREE.Vector3();
const _alignQ = new THREE.Quaternion();
const _yawQ = new THREE.Quaternion();
const _targetQ = new THREE.Quaternion();

// ── Rotor node detection (from rts-chibs) ──────────────────────────────────────
function isRotorMeshName(name) {
  const n = (name || "").toLowerCase();
  if (!n) return false;
  if (/tail/.test(n) && /rotor|prop|blade/.test(n)) return true;
  return /rotor|propeller|blade|\bprop\b|object_14\.001(?:_\d+)?$/.test(n);
}
function isTailRotorMeshName(name) {
  const n = (name || "").toLowerCase();
  return /tail/.test(n) && /rotor|prop|blade/.test(n);
}
function rotorKind(obj, root) {
  if (isTailRotorMeshName(obj.name)) return "tail";
  if (isRotorMeshName(obj.name)) return "main";
  let p = obj.parent;
  while (p && p !== root) {
    const pn = (p.name || "").toLowerCase();
    if (isTailRotorMeshName(p.name)) return "tail";
    if (pn === "rotor" || pn === "mainrotor" || isRotorMeshName(p.name)) return "main";
    if (pn === "tailrotor") return "tail";
    p = p.parent;
  }
  return null;
}

function loadGltfScene(url) {
  return new Promise((resolve, reject) => {
    getSharedGltfLoader().load(url, (gltf) => resolve(gltf.scene), undefined, reject);
  });
}

/** Build a selection ring that lies flat on the ground; hidden until selected. */
function makeSelectionRing(radius, color) {
  const geo = new THREE.RingGeometry(radius * 0.82, radius, 40);
  const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false });
  const ring = new THREE.Mesh(geo, mat);
  ring.rotation.x = -Math.PI / 2;
  ring.visible = false;
  ring.renderOrder = 999;
  return ring;
}

/**
 * Normalise a loaded model: recenter, sit on the ground, scale to targetLength,
 * collect rotor nodes. `excludeRotorsFromBox` measures the fuselage only.
 */
function buildTemplate(gltf, { targetLength, excludeRotorsFromBox }) {
  const root = new THREE.Group();
  const holder = new THREE.Group();
  holder.add(gltf);
  root.add(holder);
  root.updateMatrixWorld(true);

  const box = new THREE.Box3();
  let hasBody = false;
  root.traverse((o) => {
    if (!o.isMesh) return;
    if (excludeRotorsFromBox && rotorKind(o, root)) return;
    box.expandByObject(o);
    hasBody = true;
  });
  if (!hasBody) box.setFromObject(root);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  holder.position.set(-center.x, -box.min.y, -center.z);
  const horiz = Math.max(size.x, size.z, 1e-4);
  root.scale.setScalar(targetLength / horiz);

  const mainRotors = [], tailRotors = [];
  root.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = true;
    o.receiveShadow = true;
    const kind = rotorKind(o, root);
    if (kind === "main") mainRotors.push(o);
    else if (kind === "tail") tailRotors.push(o);
  });
  return { root, mainRotors, tailRotors };
}

/** One movable, selectable unit. */
function makeUnit(app, cfg, template, navGrid) {
  const { scene, getWorldHeight } = app;
  const { root, mainRotors, tailRotors } = template;
  const groundAt = (x, z) => (getWorldHeight ? getWorldHeight(x, z) : 0);

  const pos = new THREE.Vector3(cfg.x, 0, cfg.z);
  const target = new THREE.Vector3(cfg.x, 0, cfg.z);
  const waypoints = []; // ground path from navGrid; empty for air/direct moves
  let heading = 0, mainAngle = 0, tailAngle = 0, bob = Math.random() * 6;

  const ring = makeSelectionRing(cfg.ringRadius, cfg.ringColor ?? 0x37e06b);
  scene.add(ring);
  scene.add(root);

  const unit = {
    root,
    isAir: !!cfg.isAir,
    selected: false,
    get position() { return pos; },
    setSelected(v) { unit.selected = v; ring.visible = v; },
    /** Direct straight-line move (used by air units). */
    moveTo(x, z) { waypoints.length = 0; target.set(x, 0, z); },
    /** Order to a destination — ground units pathfind around steep terrain. */
    orderTo(x, z) {
      if (cfg.isAir || !navGrid) { unit.moveTo(x, z); return; }
      const path = navGrid.findPath(pos.x, pos.z, x, z);
      if (path && path.length) { waypoints.length = 0; waypoints.push(...path); }
      else unit.moveTo(x, z); // no route found — fall back to straight line
    },
    update(dt) {
      // Advance through any waypoints we've reached; steer toward the next.
      while (waypoints.length) {
        const wp = waypoints[0];
        const arrive = waypoints.length > 1 ? Math.max(2, cfg.speed * dt * 1.5) : 0.6;
        if (Math.hypot(wp.x - pos.x, wp.z - pos.z) <= arrive) waypoints.shift();
        else { target.set(wp.x, 0, wp.z); break; }
      }

      const dx = target.x - pos.x, dz = target.z - pos.z;
      const dh = Math.hypot(dx, dz);
      if (dh > 0.4) {
        const step = Math.min(cfg.speed * dt, dh);
        pos.x += (dx / dh) * step;
        pos.z += (dz / dh) * step;
        heading = Math.atan2(dx, dz);
      }
      const ground = groundAt(pos.x, pos.z);
      pos.y = ground + (cfg.hover ?? 0);

      const bobY = cfg.isAir ? Math.sin((bob += dt) * 1.6) * 0.25 : 0;
      root.position.set(pos.x, pos.y + bobY, pos.z);

      const yaw = heading + (cfg.facingOffset ?? 0);
      if (cfg.isAir || !app.getWorldNormal) {
        root.rotation.y = yaw; // air units stay level
      } else {
        // Ground units tilt to the terrain: align local up to the surface
        // normal, then yaw around it. Slerp so it eases over bumps.
        const gn = app.getWorldNormal(pos.x, pos.z);
        _n.set(gn.x, gn.y, gn.z);
        _alignQ.setFromUnitVectors(_UP, _n);
        _yawQ.setFromAxisAngle(_UP, yaw);
        _targetQ.copy(_alignQ).multiply(_yawQ);
        root.quaternion.slerp(_targetQ, Math.min(1, dt * 12));
      }

      if (mainRotors.length) { mainAngle += dt * 28; for (const r of mainRotors) r.rotation.y = mainAngle; }
      if (tailRotors.length) { tailAngle += dt * 28 * 2.4; for (const r of tailRotors) r.rotation.x = tailAngle; }

      ring.position.set(pos.x, ground + 0.15, pos.z);
    },
    dispose() { scene.remove(root); scene.remove(ring); },
  };

  // Tag every mesh so a selection raycast can resolve back to this unit.
  root.traverse((o) => { if (o.isMesh) o.userData.unit = unit; });
  unit.update(0);
  return unit;
}

export async function createUnits({ app, navGrid = null } = {}) {
  initGlbLoaderRenderer(app.renderer); // idempotent; wires KTX2 support

  const [heliGltf, jeepGltf] = await Promise.all([
    loadGltfScene("/models/heli5.glb"),
    loadGltfScene("/models/jeep_compressed.glb"),
  ]);

  const heliTpl = buildTemplate(heliGltf, { targetLength: 12, excludeRotorsFromBox: true });
  const jeepTpl = buildTemplate(jeepGltf, { targetLength: 5, excludeRotorsFromBox: false });
  if (!heliTpl.mainRotors.length) {
    const names = []; heliTpl.root.traverse((o) => o.name && names.push(o.name));
    console.info("[rts-v3] no rotor node in heli5.glb — rotors won't spin. Nodes:", names.join(", "));
  }

  const units = [
    makeUnit(app, { x: 0,  z: 0,  isAir: true,  hover: 8, speed: 40, ringRadius: 9, facingOffset: 0, ringColor: 0x37e06b }, heliTpl, navGrid),
    makeUnit(app, { x: 24, z: 0,  isAir: false, hover: 0, speed: 20, ringRadius: 4, facingOffset: 0, ringColor: 0x37e06b }, jeepTpl, navGrid),
  ];

  // One shared loop drives every unit.
  let last = performance.now(), raf;
  const tick = () => {
    const now = performance.now();
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    for (const u of units) u.update(dt);
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);

  return {
    list: units,
    dispose() { cancelAnimationFrame(raf); for (const u of units) u.dispose(); },
  };
}
