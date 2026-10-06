// WRECKS (2026-10-06, Company of Heroes): a destroyed vehicle STAYS where it died — burnt
// black, its turret knocked askew — burning a while, then smoking. It is an obstacle (the nav
// grid: vehicles go round it) and HARD COVER for the men round it (the cover bake, algCover.js).
// Before, a dead vehicle simply vanished.
//
// CHEAP: one InstancedMesh per vehicle type and part (body, turret, running gear), made EMPTY at
// load so the pipeline warm-up builds their programs (a material first drawn mid-fight is a
// hitch); at most MAX at once, the oldest goes. The helicopter leaves none (it falls in the
// djebel).
import * as THREE from "three";
import { vec3 } from "three/tsl";
import { rtsObjectMaterialTinted } from "../../v3/render/objects/rtsObjectProps.js";

const P = {
  max: 16,
  sink: 0.15,          // m into the ground: a wreck sits down on its axles
  burn: 35,            // s of fire
  smoke: 120,          // s of smoke after it
  rebakeDelay: 1.5,    // s: the cover bake waits for a fight's other wrecks
};

/** The paint, darkened to char (a building's wreck does the same: algStructures.js). */
function charred(mat) {
  const m = mat.clone();
  if (mat.colorNode) m.colorNode = mat.colorNode.mul(vec3(0.17, 0.16, 0.15));
  else if (m.color) m.color.multiplyScalar(0.17);
  m.roughness = 1;
  return m;
}

/**
 * @param {object} app
 * @param {object} o
 * @param {object} o.types      the unit types (ALG_UNIT_TYPES)
 * @param {object} o.builders   { procedural key: () => geometry } (algUnits.js FR_VEHICLES)
 * @param {*}      [o.paint]    the French paint tint
 * @param {object} [o.navGrid]
 * @param {object} [o.cover]    the shared cover (bake)
 */
export function createAlgWrecks(app, { types, builders, paint = null, navGrid = null, cover = null }) {
  const mat = charred(rtsObjectMaterialTinted(paint));
  const kinds = new Map();   // type key → { body, turret, gear, pivot, hx, hz }
  for (const [key, t] of Object.entries(types)) {
    if (!t.procedural || t.isAir || !builders[t.procedural]) continue;
    const geo = builders[t.procedural]();
    geo.computeBoundingBox();
    const bb = geo.boundingBox;
    const im = (g, name) => {
      const m = new THREE.InstancedMesh(g, mat, P.max);
      m.count = 0;
      m.name = `Wreck:${key}:${name}`;
      m.castShadow = m.receiveShadow = true;
      m.frustumCulled = false;   // a handful, anywhere on the map
      app.scene.add(m);
      return m;
    };
    const tur = geo.userData.turret;
    kinds.set(key, {
      body: im(geo, "body"),
      turret: tur ? im(tur.geo, "turret") : null,
      pivot: tur ? new THREE.Vector3(...tur.pivot) : null,
      gear: geo.userData.gear ? im(geo.userData.gear, "gear") : null,
      hx: (bb.max.x - bb.min.x) / 2, hz: (bb.max.z - bb.min.z) / 2, cz: (bb.max.z + bb.min.z) / 2,
      slots: [],   // the wreck in each instance slot
    });
  }

  const wrecks = [];    // { key, x, y, z, yaw, k, nav, slot }
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), one = new THREE.Vector3(1, 1, 1), p = new THREE.Vector3();
  const tm = new THREE.Matrix4(), tq = new THREE.Quaternion();
  /** Write every instance of a kind from its list (a few: cheap). */
  function rewrite(K) {
    K.slots.forEach((w, i) => {
      e.set(w.tilt[0], w.yaw, w.tilt[1], "YXZ");
      q.setFromEuler(e);
      m4.compose(p.set(w.x, w.y, w.z), q, one);
      K.body.setMatrixAt(i, m4);
      K.gear?.setMatrixAt(i, m4);
      if (K.turret) {
        // About its own pivot, knocked round and its gun a little down.
        tq.setFromEuler(e.set(0.08, w.turretYaw, 0, "YXZ"));
        tm.compose(K.pivot, tq, one);
        K.turret.setMatrixAt(i, tm.premultiply(m4));
      }
    });
    for (const m of [K.body, K.turret, K.gear]) {
      if (!m) continue;
      m.count = K.slots.length;
      m.instanceMatrix.needsUpdate = true;
    }
  }

  let rebakeT = null;
  const scheduleRebake = () => {
    clearTimeout(rebakeT);
    rebakeT = setTimeout(() => {
      const t0 = performance.now();
      try { cover?.bake(); } catch (err) { console.warn("[wrecks] cover bake:", err); }
      lastBakeMs = performance.now() - t0;
    }, P.rebakeDelay * 1000);
  };
  let lastBakeMs = 0;

  /** A wreck's cover: two circles down its length, hard. */
  function* circlesOf(w) {
    const K = kinds.get(w.key);
    const r = Math.max(1.2, K.hx + 0.3), c = Math.cos(w.yaw), s = Math.sin(w.yaw);
    for (const f of [-0.45, 0.45]) {
      const lz = K.cz + f * K.hz * 2 * 0.6;
      yield { x: w.x + lz * s, z: w.z + lz * c, radius: r, size: 1, hard: true };
    }
  }

  /** A vehicle died: its wreck where it stood. */
  function add(u) {
    const K = kinds.get(u.typeKey);
    if (!K) return null;
    if (wrecks.length >= P.max) remove(wrecks[0]);
    const x = u.position.x, z = u.position.z, y = app.getWorldHeight(x, z) - P.sink;
    const w = {
      key: u.typeKey, x, y, z, yaw: u.heading ?? 0,
      tilt: [(Math.random() - 0.5) * 0.08, (Math.random() - 0.5) * 0.1],
      turretYaw: (Math.random() - 0.5) * 1.6, t: performance.now(),
    };
    K.slots.push(w);
    wrecks.push(w);
    rewrite(K);
    // An obstacle: its body's footprint (the box's centre may sit forward of the origin).
    const c = Math.cos(w.yaw), s = Math.sin(w.yaw);
    w.nav = navGrid?.addFootprint?.(x + K.cz * s, z + K.cz * c, K.hx, K.hz, w.yaw) ?? null;
    // It burns, then smokes.
    app.algCombat?.fire?.addFire?.(x, y + 1.2, z, 3.2, P.burn);
    app.algAmbience?.smoulder?.(x, y + 1.8, z, P.burn + P.smoke, { strength: 0.8, r: 1.6 });
    // Its cover stamped at once, only its own (a whole re-bake is ~60 ms mid-fight).
    const t0 = performance.now();
    if (cover?.addCover) cover.addCover([...circlesOf(w)]); else scheduleRebake();
    lastBakeMs = performance.now() - t0;
    return w;
  }
  function remove(w) {
    const i = wrecks.indexOf(w);
    if (i < 0) return;
    wrecks.splice(i, 1);
    const K = kinds.get(w.key);
    K.slots.splice(K.slots.indexOf(w), 1);
    rewrite(K);
    if (w.nav) { navGrid.removeFootprint(w.nav); navGrid.rebuild(); }
    scheduleRebake();
  }

  return {
    params: P, wrecks, add, remove,
    /** A vehicle type's hull box (half width, half length, centre forward), or null. */
    sizeOf(key) { const K = kinds.get(key); return K ? { hx: K.hx, hz: K.hz, cz: K.cz } : null; },
    get lastBakeMs() { return lastBakeMs; },
    /** Hard cover along each wreck (the cover bake, algCover.js). */
    *coverCircles() { for (const w of wrecks) yield* circlesOf(w); },
    dispose() { clearTimeout(rebakeT); for (const K of kinds.values()) for (const m of [K.body, K.turret, K.gear]) m?.removeFromParent(); },
  };
}
