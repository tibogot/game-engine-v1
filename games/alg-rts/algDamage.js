// THE FIGHTING LEAVES MARKS (you, 2026-10-01: damage states, CoH — "a map
// that tells the story of the fight"). Cheap by construction: nothing here
// runs per frame but a once-a-second health check; everything it shows is
// one of the game's existing single-draw fields, or one new instanced draw.
//
//   SANDBAGS   a wall caught by a blast (shell, mortar, grenade) is BREACHED:
//              its geometry swapped for rtsAlgeria.js's breached run (a gap,
//              the stubs slumped, bags thrown out), and its cover drops from
//              hard to soft. The cover map re-bakes once, 1.5 s after the
//              last breach (a barrage is one bake, not ten).
//   HOUSES     a shell or a mortar bomb landing on a village house sets it
//              burning (the flame field, ~25 s), then smouldering (the smoke
//              field, ~2 min), and leaves a RUBBLE heap against its wall (one
//              InstancedMesh for the whole map, up to 2 per house). The crater
//              comes from the combat already.
//   BUILDINGS  a French or ALN building under half its health smokes, thicker
//              the worse it is; destroyed, its wreck (algStructures.js) keeps
//              smoking a while. Its charring is algStructures' own.
//
// NOT done: a house does not COLLAPSE. A village is one merged mesh and
// nothing marks which of its vertices are which house — that needs a house id
// baked into the village geometry (TODO.md).
//
// Fed by algCombat.js's explosion wrapper: app.algDamage.blast(x, z, size).
import * as THREE from "three";
import { buildFrSandbagWallBreached, buildRubbleHeap } from "../../v3/render/objects/rtsAlgeria.js";
import { kitView } from "./showroom.js";

const P = {
  wallReach: 1.2,        // m past the wall's footprint a blast still breaches it
  wallMinSize: 5,        // explosion size (combat fx units) that breaches: a grenade (6) does
  houseMinSize: 7,       // a shell or a mortar bomb; not a grenade
  houseR: 5.5,           // m from a house's centre that counts as on it
  burn: 25, smoulder: 120,
  rubbleMax: 64, rubblePerHouse: 2,
  rebakeDelay: 1.5,
};
const SANDBAG_KEYS = /^sandbags\d*$/;

export function createAlgDamage(app, { showroom = {}, structures = null, ambience = null, cover = null, fire = null }) {
  // ── The walls ─────────────────────────────────────────────────────────────
  // Built at load, not at the first breach (its AO bake mid-fight is a hitch).
  const breachedGeo = buildFrSandbagWallBreached();
  const wallsNow = () => Object.entries(showroom).filter(([name, m]) => m?.isObject3D && m.parent && !m.userData.breached
    && SANDBAG_KEYS.test(m.userData?.kitKey ?? name));
  let rebakeT = null;
  const scheduleRebake = () => {
    clearTimeout(rebakeT);
    rebakeT = setTimeout(() => { try { cover?.bake(); } catch (e) { console.warn("[damage] cover bake:", e); } }, P.rebakeDelay * 1000);
  };
  function breachWalls(x, z, size) {
    if (size < P.wallMinSize) return;
    const reach = P.wallReach + size * 0.12;
    let any = false;
    for (const [, m] of wallsNow()) {
      const fp = m.geometry.userData.footprint;
      if (!fp) continue;
      const c = Math.cos(m.rotation.y), s = Math.sin(m.rotation.y);
      const dx = x - m.position.x, dz = z - m.position.z;
      const lx = c * dx - s * dz - fp.cx, lz = s * dx + c * dz - fp.cz;
      if (Math.abs(lx) > fp.hx + reach || Math.abs(lz) > fp.hz + reach) continue;
      m.geometry = breachedGeo;
      m.userData.breached = true;
      any = true;
    }
    if (any) scheduleRebake();
  }

  // ── The houses ────────────────────────────────────────────────────────────
  const houses = [];   // { x, z, village, hits, roofY }
  for (const [key, o] of Object.entries(showroom)) {
    const hs = o?.isObject3D ? o.geometry?.userData?.houses : null;
    if (!hs?.length || !/^(mechta|dechra|ksar)/.test(key)) continue;
    const c = Math.cos(o.rotation.y), s = Math.sin(o.rotation.y);
    for (const h of hs) houses.push({ x: o.position.x + h.x * c + h.z * s, z: o.position.z - h.x * s + h.z * c, village: o, hits: 0, roofY: null });
  }
  const ray = new THREE.Raycaster(), down = new THREE.Vector3(0, -1, 0), from = new THREE.Vector3();
  const roofOf = (h) => {
    if (h.roofY == null) {
      // Once per house, the first time it is hit: a ray down onto its village.
      ray.set(from.set(h.x, 400, h.z), down);
      const hit = ray.intersectObject(h.village, false)[0];
      h.roofY = hit ? hit.point.y : app.getWorldHeight(h.x, h.z) + 4;
    }
    return h.roofY;
  };

  // The rubble: one InstancedMesh, filled as houses are hit.
  const rubbleGeo = buildRubbleHeap();
  const rubble = new THREE.InstancedMesh(rubbleGeo, kitView(rubbleGeo).material, P.rubbleMax);
  rubble.name = "HouseRubble";
  rubble.count = 0;
  rubble.castShadow = rubble.receiveShadow = true;
  rubble.frustumCulled = false;     // instances anywhere on the map; one small draw
  app.scene.add(rubble);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  function addRubble(x, z) {
    if (rubble.count >= P.rubbleMax) return;
    const k = 1.3 + Math.random() * 0.5;      // a 2.6 m heap read as a stone at play zoom
    rubble.setMatrixAt(rubble.count, m4.compose(new THREE.Vector3(x, app.getWorldHeight(x, z) - 0.08, z), q.setFromAxisAngle(up, Math.random() * 6.28), sc.set(k, k * (0.8 + Math.random() * 0.4), k)));
    rubble.count++;
    rubble.instanceMatrix.needsUpdate = true;
  }

  function hitHouses(x, z, size) {
    if (size < P.houseMinSize) return;
    for (const h of houses) {
      const d = Math.hypot(h.x - x, h.z - z);
      if (d > P.houseR) continue;
      h.hits++;
      const y = roofOf(h);
      if (h.hits === 1) {
        fire?.addFire(h.x, y, h.z, 2.6, P.burn);
        ambience?.smoulder(h.x, y + 0.5, h.z, P.smoulder, { strength: 1, r: 2.2 });
      }
      if (h.hits <= P.rubblePerHouse) {
        // At the foot of the wall on the side the shell came in: walk out
        // from the house's centre toward the impact until the roof is no
        // longer overhead (a ray down onto the village), then a little more.
        let ux = (x - h.x) / (d || 1), uz = (z - h.z) / (d || 1);
        if (d < 0.5) { const a = Math.random() * 6.28; ux = Math.cos(a); uz = Math.sin(a); }
        let r = 1.5;
        for (; r < 10; r += 0.75) {
          const px = h.x + ux * r, pz = h.z + uz * r;
          ray.set(from.set(px, 400, pz), down);
          const hit = ray.intersectObject(h.village, false)[0];
          if (!hit || hit.point.y < app.getWorldHeight(px, pz) + 0.6) break;
        }
        addRubble(h.x + ux * (r + 0.6), h.z + uz * (r + 0.6));
      }
    }
  }

  // ── The buildings: smoke below half health ────────────────────────────────
  const smoking = new Map();   // structure → smoulder handle
  let checkT = 0;
  function checkBuildings(dt) {
    if ((checkT -= dt) > 0 || !structures || !ambience) return;
    checkT = 1;
    for (const r of structures.records ?? []) {
      const s = r.s, f = s.maxHp ? s.hp / s.maxHp : 1;
      const h = smoking.get(s);
      if (!s.alive) {
        // The wreck smokes ~90 s more, then dies down.
        if (h && h.left > 90) h.left = 90;
        if (!h && !r._wreckSmoke) { r._wreckSmoke = true; smoking.set(s, ambience.smoulder(s.position.x, s.position.y + Math.min(r.height, 10) * 0.5, s.position.z, 90, { strength: 0.9, r: 2 })); }
        continue;
      }
      if (f >= 0.5) continue;
      const strength = 0.35 + (0.5 - f) * 1.3;
      if (!h) smoking.set(s, ambience.smoulder(s.position.x, s.position.y + Math.min(r.height, 10) * 0.75, s.position.z, 1e6, { strength, r: 1.6 }));
      else h.strength = strength;
    }
  }
  app.addPreRenderHook((dt) => checkBuildings(Math.min(dt, 0.1)));

  return {
    params: P, houses, rubble,
    /** An explosion at (x, z) of combat-fx `size` (algCombat.js calls this). */
    blast(x, z, size = 10) {
      app.algWire?.blast(x, z, size);
      breachWalls(x, z, size);
      hitHouses(x, z, size);
    },
  };
}
