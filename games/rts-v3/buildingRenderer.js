// Building RENDERER — procedural geometry for player-built structures.
//
// Separate from structuresRenderer (which merges the fixed boot structures into
// one static mesh) because buildings appear at RUNTIME and ANIMATE: they rise out
// of the ground while the builder raises them, and the helipad's corner lights
// pulse while it's producing.
//
// Two strategies, chosen by how many of each the player can end up with:
//   • HELIPAD — one animated Group each. You build a couple; each has fiddly
//     per-instance state (pulsing corner lights), so a Group is the honest fit.
//   • TURRET  — INSTANCED (body / head / eye). Turrets are free and unlimited, so
//     a Group each would put us straight back to a draw call per building. Three
//     instanced kinds cover any number of turrets, and the rise animation is just
//     a Y offset baked into each instance matrix — instancing costs us no motion.
// The turret shape itself is shared with the enemy turrets (turretKit.js).
import * as THREE from "three";
import { materialColor } from "three/tsl";
import { makeBloomMaterial, BLOOM } from "./bloom.js";
import {
  turretBodyGeometry, turretHeadGeometry, turretEyeGeometry, turretHeadMatrix,
  TURRET_PALETTE, EYE_LOCAL,
} from "./turretKit.js";

const C_PAD = 0x2b2f36;
const C_RIM = 0x3d4550;
const C_MARK = 0xf0c020; // the landing "H"

/** Refreshing standard material — a colorNode keeps its fog uniforms live (see
 *  structuresRenderer.js for why a static mesh needs this). */
function mat(color, { rough = 0.9, metal = 0.2 } = {}) {
  const m = new THREE.MeshStandardNodeMaterial({ color, roughness: rough, metalness: metal });
  m.colorNode = materialColor;
  return m;
}

/** Procedural helipad: disc + rim + painted H + four corner lights. */
function buildHelipad(radius) {
  const g = new THREE.Group();

  // Landing disc.
  const disc = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, 1.0, 40), mat(C_PAD));
  disc.position.y = 0.5;
  disc.receiveShadow = true;
  disc.castShadow = true;
  g.add(disc);

  // Raised rim.
  const rim = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, 0.5, 40, 1, true), mat(C_RIM, { metal: 0.4 }));
  rim.position.y = 1.15;
  rim.castShadow = true;
  g.add(rim);

  // Landing "H", painted flat on the deck (three bars).
  const markMat = mat(C_MARK, { rough: 0.6 });
  const bar = (w, d, x) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.12, d), markMat);
    m.position.set(x, 1.05, 0);
    g.add(m);
  };
  bar(0.9, radius * 0.9, -radius * 0.28); // left upright
  bar(0.9, radius * 0.9, radius * 0.28);  // right upright
  const cross = new THREE.Mesh(new THREE.BoxGeometry(radius * 0.62, 0.12, 0.9), markMat);
  cross.position.set(0, 1.05, 0);
  g.add(cross);

  // Corner lights — emissive (they bloom). Kept as refs so production can pulse them.
  const lights = [];
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const L = new THREE.Mesh(
      new THREE.SphereGeometry(0.5, 12, 8),
      makeBloomMaterial({ color: 0x64d2ff, blending: THREE.NormalBlending, depthWrite: true, transparent: false }, BLOOM.beacon),
    );
    L.position.set(Math.cos(a) * (radius - 0.8), 1.4, Math.sin(a) * (radius - 0.8));
    g.add(L);
    lights.push(L);
  }

  // Total vertical extent, for the rise-from-ground construction animation.
  g.userData.height = 2.0;
  g.userData.lights = lights;
  return g;
}

const MAX_TURRETS = 128; // instance capacity — turrets are free, so be generous
const TURRET_HEIGHT = 7;  // total vertical extent, for the rise-from-ground animation

/** How far a building sinks below ground at built = 0. */
const riseOffset = (b, height) => -(1 - b.built) * (height + 1.5);

export function createBuildingRenderer({ app, buildings, healthBars = null }) {
  const { scene } = app;
  const views = new Map(); // building → Group (helipads only)
  let _t = 0;

  const roots = [];             // raycast targets for selection
  const buildingOfGroup = new Map();

  // ── Instanced turret kinds ──────────────────────────────────────────────────
  const turretMat = mat(0xffffff, { rough: 0.87, metal: 0.18 });
  turretMat.vertexColors = true; // the merged geometry carries the team palette

  const makeKind = (geometry, material, { shadow = false } = {}) => {
    const im = new THREE.InstancedMesh(geometry, material, MAX_TURRETS);
    im.count = 0;
    im.castShadow = shadow;
    im.receiveShadow = shadow;
    im.frustumCulled = false;
    scene.add(im);
    return { im, n: 0, at: [] };
  };

  const turretKinds = {
    body: makeKind(turretBodyGeometry("player"), turretMat, { shadow: true }),
    head: makeKind(turretHeadGeometry("player"), turretMat, { shadow: true }),
    // Emissive sensor — no shadow (a light casting a shadow of itself is a bug).
    eye: makeKind(turretEyeGeometry(), makeBloomMaterial(
      { color: TURRET_PALETTE.player.eye, blending: THREE.NormalBlending, depthWrite: true, transparent: false },
      BLOOM.beacon,
    )),
  };
  const kindOfMesh = new Map(Object.values(turretKinds).map((k) => [k.im, k]));
  for (const k of Object.values(turretKinds)) roots.push(k.im);

  const _m = new THREE.Matrix4();
  const _head = new THREE.Matrix4();
  const _eye = new THREE.Matrix4();
  const _eyeOffset = new THREE.Matrix4().makeTranslation(EYE_LOCAL.x, EYE_LOCAL.y, EYE_LOCAL.z);

  const push = (kind, matrix, b) => {
    if (kind.n >= MAX_TURRETS) return;
    kind.im.setMatrixAt(kind.n, matrix);
    kind.at[kind.n] = b;
    kind.n++;
  };

  function ensureView(b) {
    let g = views.get(b);
    if (g) return g;
    if (b.typeKey === "helipad") g = buildHelipad(b.radius);
    else return null;
    g.frustumCulled = false;
    scene.add(g);
    views.set(b, g);
    roots.push(g);
    buildingOfGroup.set(g, b);
    return g;
  }

  /** Resolve a raycast hit to its building (an instanced turret, or a Group child). */
  function buildingFromHit(hit) {
    const kind = kindOfMesh.get(hit.object);
    if (kind) return kind.at[hit.instanceId] ?? null;
    for (let o = hit.object; o; o = o.parent) {
      const b = buildingOfGroup.get(o);
      if (b) return b;
    }
    return null;
  }

  /** Head yaw while a turret is coming online, or null once it's under AI control. */
  function deployYaw(b) {
    if (b.built < 1) return b.deploy * 0; // still buried — hold still
    if (b.deploy >= 1) return null;       // deployed: normal targeting takes over
    // A calibration sweep: one full turn, easing to a stop. Reads as "powering up"
    // and, conveniently, shows the player which way the barrels point.
    const e = 1 - (1 - b.deploy) ** 3; // ease-out cubic
    return e * Math.PI * 2;
  }

  /** One instance in the shared health-bar field. Rides the rise so it never floats. */
  function addBar(b, y, camera) {
    if (!healthBars || !camera) return;
    healthBars.add(
      b.position.x, b.position.y + y + (b.type.barY ?? 8), b.position.z,
      b.type.barWidth ?? 6,
      b.hp / b.maxHp,
      b.team === "enemy",
      camera,
    );
  }

  function sync(dt, camera) {
    _t += dt;

    for (const k of Object.values(turretKinds)) k.n = 0;

    for (const b of buildings.list) {
      if (b.typeKey === "turret") {
        if (!b.alive) continue; // not pushed = not drawn; no per-turret mesh to hide

        // Rise out of the ground while the builder raises it. The terrain occludes
        // the buried part, so it reads as emerging rather than scaling in mid-air.
        const y = riseOffset(b, TURRET_HEIGHT);
        addBar(b, y, camera);

        // Head aim: the deploy sweep owns it until the turret is online, then the
        // target does. Without a target it simply holds its last heading.
        const sweep = deployYaw(b);
        if (sweep !== null) b.turretYaw = sweep;
        else if (b.target?.alive) {
          b.turretYaw = Math.atan2(
            b.target.position.x - b.position.x,
            b.target.position.z - b.position.z,
          );
        }

        _m.makeTranslation(b.position.x, b.position.y + y, b.position.z);
        push(turretKinds.body, _m, b);

        turretHeadMatrix(b, _head, y);
        push(turretKinds.head, _head, b);
        push(turretKinds.eye, _eye.multiplyMatrices(_head, _eyeOffset), b);
        continue;
      }

      const g = ensureView(b);
      if (!g) continue;

      if (!b.alive) { g.visible = false; continue; }
      g.visible = true;

      // Construction: the pad emerges from the ground. Below `built`=1 it's sunk,
      // and the terrain (drawn in front, depthwise) hides the buried part, so it
      // reads as rising out of the earth rather than scaling in mid-air.
      const gy = riseOffset(b, g.userData.height);
      g.position.set(b.position.x, b.position.y + gy, b.position.z);
      addBar(b, gy, camera);

      // Corner lights pulse while it's actively producing (something on the pad).
      const producing = !b.constructing && b.queue.length > 0;
      const pulse = producing ? 0.6 + 0.4 * Math.sin(_t * 6) : 0.18;
      for (const L of g.userData.lights) L.scale.setScalar(pulse + 0.5);
    }

    for (const k of Object.values(turretKinds)) {
      k.im.count = k.n;
      k.im.instanceMatrix.needsUpdate = true;
    }
  }

  return {
    sync,
    roots,             // raycast targets for selection
    buildingFromHit,   // resolve a hit to its building
    dispose() {
      for (const g of views.values()) scene.remove(g);
      views.clear();
      for (const k of Object.values(turretKinds)) {
        scene.remove(k.im);
        k.im.geometry.dispose();
      }
    },
  };
}
