// RTS unit RENDERER — GAME code. Turns mesh-free unit data (units.js) into
// visuals: model, rotors, terrain tilt, health bar, selection ring.
//
// Today: one cloned model per unit (clones share geometry/materials, so this is
// fine for dozens). To scale to hundreds, replace THIS FILE with an
// InstancedMesh version — the unit logic, orders and combat never change.
//
// Rotor handling (main = Y spin, tail = X spin ~2.4× faster) is ported from
// rts-chibs. Rotor meshes are RENAMED on the template so the tag survives
// clone(true) — userData refs would still point at the template's own nodes.
import * as THREE from "three";
import * as SkeletonUtils from "three/addons/utils/SkeletonUtils.js";
import { getSharedGltfLoader, initGlbLoaderRenderer } from "../../v2/core/foliage/glbLoader.js";
import { bakeThumbnails } from "./thumbnails.js";
import { UNIT_TYPES, UNIT_TYPE_KEYS } from "./unitTypes.js";

// Mesh → owning unit, for selection raycasts. A WeakMap (not mesh.userData)
// keeps the link OUT of userData, which THREE deep-clones via JSON — a unit
// back-ref there would be circular and break clone(true) (thumbnail baking).
export const unitByMesh = new WeakMap();

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

function loadGltf(url) {
  return new Promise((resolve, reject) => {
    getSharedGltfLoader().load(
      url,
      (gltf) => resolve({ scene: gltf.scene, animations: gltf.animations ?? [] }),
      undefined,
      reject,
    );
  });
}

/** Normalise a model into a reusable template and rename its rotor meshes. */
function buildTemplate(gltf, { targetLength, targetHeight, excludeRotorsFromBox }) {
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
  // Vehicles scale by horizontal length; humanoids by HEIGHT (their horizontal
  // footprint is shoulder width — meaningless as a size reference).
  const scale = targetHeight
    ? targetHeight / Math.max(size.y, 1e-4)
    : targetLength / Math.max(size.x, size.z, 1e-4);
  root.scale.setScalar(scale);

  let rotors = 0;
  root.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = true;
    o.receiveShadow = true;
    const kind = rotorKind(o, root);
    if (kind === "main") { o.name = "MainRotor"; rotors++; }
    else if (kind === "tail") { o.name = "TailRotor"; rotors++; }
  });
  return { root, rotors };
}

// Selection ring: a flat ring in the XZ plane whose vertices are displaced to
// the terrain height each frame (a conforming decal). Because it hugs the
// ground we keep depthTest ON, so the unit properly occludes it — depthTest:false
// would draw the ring *over* the unit.
function makeSelectionRing(radius, color = 0x37e06b) {
  const geo = new THREE.RingGeometry(radius * 0.82, radius, 48).rotateX(-Math.PI / 2);
  const mat = new THREE.MeshBasicMaterial({
    color, transparent: true, opacity: 0.95, side: THREE.DoubleSide,
    depthWrite: false, depthTest: true,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  const ring = new THREE.Mesh(geo, mat);
  ring.visible = false;
  ring.frustumCulled = false;
  return ring;
}

/** Camera-facing health bar: dark backing + fill anchored on its left edge. */
function makeHealthBar(width, height = 0.55) {
  const group = new THREE.Group();
  const bg = new THREE.Mesh(
    new THREE.PlaneGeometry(width + 0.18, height + 0.18),
    new THREE.MeshBasicMaterial({ color: 0x0b0e13, transparent: true, opacity: 0.85, depthTest: false, depthWrite: false }),
  );
  bg.renderOrder = 1001;
  group.add(bg);

  const fill = new THREE.Mesh(
    new THREE.PlaneGeometry(width, height).translate(width / 2, 0, 0), // left-anchored
    new THREE.MeshBasicMaterial({ color: 0x3ddc60, depthTest: false, depthWrite: false }),
  );
  fill.position.set(-width / 2, 0, 0.001);
  fill.renderOrder = 1002;
  group.add(fill);
  return { group, fill };
}

export async function createUnitRenderer({ app, units }) {
  const { scene } = app;
  initGlbLoaderRenderer(app.renderer); // idempotent; wires KTX2 support

  // One template per type.
  const loaded = await Promise.all(UNIT_TYPE_KEYS.map((k) => loadGltf(UNIT_TYPES[k].url)));
  const templates = {};
  UNIT_TYPE_KEYS.forEach((k, i) => {
    const t = UNIT_TYPES[k];
    templates[k] = {
      ...buildTemplate(loaded[i].scene, {
        targetLength: t.targetLength,
        targetHeight: t.targetHeight,
        excludeRotorsFromBox: t.excludeRotorsFromBox,
      }),
      animations: loaded[i].animations,
      skinned: !!t.skinned,
    };
  });
  if (!templates.helicopter?.rotors) {
    console.info("[rts-v3] no rotor node found in heli5.glb — rotors won't spin.");
  }

  // Skinned templates MUST clone via SkeletonUtils — a plain clone(true) leaves
  // the copy's SkinnedMeshes bound to the TEMPLATE's skeleton, so every clone
  // silently deforms with (or stays frozen at) the original's pose.
  const cloneTemplateRoot = (key) => {
    const tpl = templates[key];
    return tpl.skinned ? SkeletonUtils.clone(tpl.root) : tpl.root.clone(true);
  };

  // Per-unit visuals.
  const views = new Map(); // unit → view
  const roots = [];        // raycast targets for selection

  /** Build the visuals for one unit. Also used for units spawned at runtime. */
  function addUnit(unit) {
    const t = unit.type;
    const tpl = templates[t.typeKey];
    const root = cloneTemplateRoot(t.typeKey);
    const mainRotors = [], tailRotors = [];
    root.traverse((o) => {
      if (!o.isMesh) return;
      unitByMesh.set(o, unit);
      if (o.name === "MainRotor") mainRotors.push(o);
      else if (o.name === "TailRotor") tailRotors.push(o);
    });

    // Skinned units get their own AnimationMixer (idle ⇄ run driven in sync()).
    let mixer = null, actions = null;
    if (tpl.skinned && tpl.animations.length) {
      mixer = new THREE.AnimationMixer(root);
      actions = {};
      for (const clip of tpl.animations) actions[clip.name] = mixer.clipAction(clip);
      (actions.idle ?? Object.values(actions)[0])?.play();
      // Animated bones walk out of the bind-pose bounding sphere → the whole
      // unit vanishes at screen edges. Standard fix for crowds: don't cull.
      root.traverse((o) => { if (o.isSkinnedMesh) o.frustumCulled = false; });
    }

    const ring = makeSelectionRing(t.ringRadius);
    const ringPos = ring.geometry.attributes.position;
    const ringBase = Float32Array.from(ringPos.array); // flat XZ offsets (y = 0)
    const bar = makeHealthBar(t.barWidth);

    scene.add(root, ring, bar.group);
    roots.push(root);
    views.set(unit, {
      root, ring, ringPos, ringBase, bar, mainRotors, tailRotors,
      mixer, actions, currentAction: actions ? (actions.idle ? "idle" : Object.keys(actions)[0]) : null,
      bob: Math.random() * 6, mainAngle: Math.random() * 6, tailAngle: 0,
    });
  }

  for (const unit of units.list) addUnit(unit);
  // Units built by the base at runtime get their visuals through this.
  units.setOnSpawn(addUnit);

  // UI thumbnails (clones share template geometry — safe; never dispose them).
  const thumbnails = await bakeThumbnails({
    renderer: app.renderer,
    items: UNIT_TYPE_KEYS.map((k) => ({ key: k, make: () => cloneTemplateRoot(k) })),
  });

  /** Push unit data into the meshes. Called once per frame by the game loop. */
  function sync(dt, camera) {
    for (const unit of units.list) {
      const v = views.get(unit);
      if (!v) continue;

      if (!unit.alive) {
        v.root.visible = false;
        v.ring.visible = false;
        v.bar.group.visible = false;
        continue;
      }

      const t = unit.type;
      const p = unit.position;

      const bobY = t.isAir ? Math.sin((v.bob += dt) * 1.6) * 0.25 : 0;
      v.root.position.set(p.x, p.y + bobY, p.z);

      const yaw = unit.heading + (t.facingOffset ?? 0);
      if (t.isAir || !app.getWorldNormal) {
        v.root.rotation.y = yaw; // air stays level
      } else {
        // Ground units tilt to the terrain: align local up to the surface
        // normal, then yaw around it. Slerp so it eases over bumps.
        const gn = app.getWorldNormal(p.x, p.z);
        _n.set(gn.x, gn.y, gn.z);
        _alignQ.setFromUnitVectors(_UP, _n);
        _yawQ.setFromAxisAngle(_UP, yaw);
        _targetQ.copy(_alignQ).multiply(_yawQ);
        v.root.quaternion.slerp(_targetQ, Math.min(1, dt * 12));
      }

      if (v.mainRotors.length) {
        v.mainAngle += dt * 28;
        for (const r of v.mainRotors) r.rotation.y = v.mainAngle;
      }
      if (v.tailRotors.length) {
        v.tailAngle += dt * 28 * 2.4;
        for (const r of v.tailRotors) r.rotation.x = v.tailAngle;
      }

      // Skinned units: run while moving, idle while holding (cross-faded).
      if (v.mixer) {
        const want = unit.isMoving && v.actions.run
          ? "run"
          : (v.actions.idle ? "idle" : v.currentAction);
        if (want !== v.currentAction) {
          v.actions[v.currentAction]?.fadeOut(0.15);
          v.actions[want]?.reset().fadeIn(0.15).play();
          v.currentAction = want;
        }
        v.mixer.update(dt);
      }

      // Health bar — billboard to the camera, above the unit.
      const frac = THREE.MathUtils.clamp(unit.hp / unit.maxHp, 0, 1);
      v.bar.group.position.set(p.x, p.y + (t.barY ?? 6) + bobY, p.z);
      if (camera) v.bar.group.quaternion.copy(camera.quaternion);
      v.bar.fill.scale.x = Math.max(1e-4, frac);
      v.bar.fill.material.color.setHex(frac > 0.6 ? 0x3ddc60 : frac > 0.3 ? 0xf5c542 : 0xe4483a);

      // Selection ring — drape over the terrain, only while shown.
      v.ring.visible = unit.selected;
      if (unit.selected) {
        v.ring.position.set(p.x, 0, p.z);
        for (let i = 0; i < v.ringPos.count; i++) {
          const bx = v.ringBase[i * 3], bz = v.ringBase[i * 3 + 2];
          v.ringPos.setY(i, app.getWorldHeight(p.x + bx, p.z + bz) + 0.25);
        }
        v.ringPos.needsUpdate = true;
      }
    }
  }

  return {
    thumbnails,
    roots,       // raycast targets for selection
    unitByMesh,
    addUnit,
    sync,
    dispose() {
      for (const v of views.values()) scene.remove(v.root, v.ring, v.bar.group);
      views.clear();
    },
  };
}
