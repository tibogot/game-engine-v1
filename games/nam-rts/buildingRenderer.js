// Building RENDERER — procedural geometry for player-built structures.
//
// Separate from structuresRenderer (which merges the fixed boot structures into
// one static mesh) because buildings appear at RUNTIME and ANIMATE: they rise out
// of the ground while the builder raises them, and the helipad's corner lights
// pulse while it's producing.
//
// The shapes are the parts kit's (v3/render/objects/rtsBuildables.js). Two
// strategies, chosen by how many of each the player can end up with:
//   • HELIPAD, RADIO — one animated Group each (shared geometry). You build a
//     couple; each has per-instance state (pulsing lamps), so a Group fits.
//   • TURRET — the M60 gun pit, INSTANCED (pit / gun). Turrets are free and
//     unlimited, so a Group each would put us back to a draw call per building.
//     Two instanced kinds cover any number, and the rise animation is just a Y
//     offset baked into each instance matrix — instancing costs us no motion.
// The enemy's turrets are still turretKit.js (structuresRenderer).
import * as THREE from "three";
import { makeBloomMaterial, BLOOM } from "./bloom.js";
import { buildRadioTower } from "./radioKit.js";
import { rtsObjectMaterial } from "../../v3/render/objects/rtsObjectProps.js";
import { stencilMesh } from "../../v3/render/objects/rtsStencils.js";
import {
  GUN_PIT_HEAD_Y, buildGunPitBody, buildGunPitGun, buildHelipad, buildRadioPost,
} from "../../v3/render/objects/rtsBuildables.js";

const lamp = (color, r) => new THREE.Mesh(
  new THREE.SphereGeometry(r, 10, 6),
  makeBloomMaterial({ color, blending: THREE.NormalBlending, depthWrite: true, transparent: false }, BLOOM.beacon),
);

/** A kit building: one mesh, its markings riding as a child. Geometry shared. */
function kitView(geo) {
  const g = new THREE.Group();
  const m = new THREE.Mesh(geo, rtsObjectMaterial());
  m.castShadow = m.receiveShadow = true;
  const st = stencilMesh(geo.userData.stencil);
  if (st) m.add(st);
  g.add(m);
  g.userData.height = geo.userData.height ?? 3;
  return g;
}

let _helipadGeo = null, _radioGeo = null;

/** The PSP helipad (rtsBuildables) with its four corner lamps, which pulse
 *  while a helicopter is being readied. */
function helipadView() {
  _helipadGeo ??= buildHelipad();
  const g = kitView(_helipadGeo);
  const lights = [];
  const mat = lamp(0xffc46a, 0.2).material;
  for (const [x, y, z] of _helipadGeo.userData.lights) {
    const L = new THREE.Mesh(new THREE.SphereGeometry(0.2, 10, 6), mat);
    L.position.set(x, y, z);
    g.add(L);
    lights.push(L);
  }
  g.userData.lights = lights;
  return g;
}

/** The radio post (rtsBuildables), with a red aviation light on the mast head
 *  that pulses once it is on the air. */
function radioView() {
  _radioGeo ??= buildRadioPost();
  const g = kitView(_radioGeo);
  const S = 1.3, hw = 1.1 * S;
  const beacon = lamp(0xff3a2a, 0.22);
  beacon.position.set(-hw - 3.2 * S, 11 * S + 0.15, -0.4 * S);   // the mast head (rtsFirebaseProps radio station)
  g.add(beacon);
  g.userData.beacon = beacon;
  return g;
}

const MAX_TURRETS = 128; // instance capacity — turrets are free, so be generous
const TURRET_HEIGHT = 2.4; // total vertical extent, for the rise-from-ground animation

/** How far a building sinks below ground at built = 0. */
const riseOffset = (b, height) => -(1 - b.built) * (height + 1.5);

export function createBuildingRenderer({ app, buildings, healthBars = null }) {
  const { scene } = app;
  const views = new Map(); // building → Group (helipads only)
  let _t = 0;

  const roots = [];             // raycast targets for selection
  const buildingOfGroup = new Map();

  // ── Instanced gun pits: the pit, and the M60 that turns ─────────────────────
  const kitMat = rtsObjectMaterial();

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
    body: makeKind(buildGunPitBody(), kitMat, { shadow: true }),
    head: makeKind(buildGunPitGun(), kitMat, { shadow: true }),
  };
  const kindOfMesh = new Map(Object.values(turretKinds).map((k) => [k.im, k]));
  for (const k of Object.values(turretKinds)) roots.push(k.im);

  const _m = new THREE.Matrix4();
  const _head = new THREE.Matrix4();
  const _q = new THREE.Quaternion();
  const _p = new THREE.Vector3();
  const _one = new THREE.Vector3(1, 1, 1);
  const _up = new THREE.Vector3(0, 1, 0);
  /** The gun's world matrix: on its post, yawed, riding the rise. */
  const gunMatrix = (b, out, yOffset) => out.compose(
    _p.set(b.position.x, b.position.y + GUN_PIT_HEAD_Y + yOffset, b.position.z),
    _q.setFromAxisAngle(_up, b.turretYaw ?? 0), _one,
  );

  const push = (kind, matrix, b) => {
    if (kind.n >= MAX_TURRETS) return;
    kind.im.setMatrixAt(kind.n, matrix);
    kind.at[kind.n] = b;
    kind.n++;
  };

  function ensureView(b) {
    let g = views.get(b);
    if (g) return g;
    if (b.typeKey === "helipad") g = helipadView();
    else if (b.typeKey === "radio") g = radioView();
    else if (b.typeKey === "captureNode") g = buildRadioTower("capture");
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

  /**
   * Selected: square buildings (helipad, radio post) get corner brackets round
   * their footprint, round ones (gun pit, supply relay) a ring. Enemy red.
   */
  const ROUND = new Set(["turret", "captureNode"]);
  function markSelected(b) {
    if (!b.selected || !b.alive) return;
    const tint = b.team === "enemy" ? 0xff6a5a : undefined;
    const fp = b.footprint;
    if (fp && !ROUND.has(b.typeKey)) app.selectionFrames?.add(b.position.x + fp.cx, b.position.z + fp.cz, fp.hx + 0.6, fp.hz + 0.6, 0, tint);
    else app.selectionRings?.add(b.position.x, b.position.z, b.radius + 1, tint);
  }

  /** One instance in the shared health-bar field. Rides the rise so it never floats. */
  function addBar(b, y, camera) {
    markSelected(b);
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
        push(turretKinds.head, gunMatrix(b, _head, y), b);
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

      // Radio / relay beacons pulse when online.
      const online = !b.constructing && b.built >= 1;
      const pulse = online ? 0.65 + 0.35 * Math.sin(_t * (b.typeKey === "captureNode" ? 4.2 : 3)) : 0.2;
      if (g.userData.beacon) g.userData.beacon.scale.setScalar(pulse + 0.35);
      if (g.userData.lip) g.userData.lip.scale.setScalar(pulse + 0.25);
      if (g.userData.ring) {
        g.userData.ring.visible = online;
        g.userData.ring.scale.setScalar(pulse + 0.5);
      }

      // Corner lights pulse while it's actively producing (helipad only).
      if (g.userData.lights) {
        const producing = !b.constructing && b.queue.length > 0;
        const helPulse = producing ? 0.6 + 0.4 * Math.sin(_t * 6) : 0.18;
        for (const L of g.userData.lights) L.scale.setScalar(helPulse + 0.5);
      }
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
