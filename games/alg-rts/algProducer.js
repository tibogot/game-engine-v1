// A PRODUCTION BUILDING — selectable, trains or builds units, and its GATE or
// DOORS work: the leaves swing open before a unit comes out and shut behind
// the last one. The building's mesh is the showroom's (showroom.js), its
// leaves children of it (geometry userData.gate: the post's gate,
// rtsFrenchPost.js; the motor pool's garage doors, rtsAlgeria.js).
//
// It plugs into the shared selection through the "structures renderer"
// shape it already knows ({ roots, structureFromHit }), and into this game's
// command card through `enqueue` / `queue` / `progress` (a producer).
import * as THREE from "three";

const OPEN_SPEED = 1.8;               // rad/s — a heavy leaf
const HOLD_OPEN = 3.5;                // s after the last unit, then it shuts
const OPEN_AHEAD = 0.8;               // start opening at 80% of a unit's build

/**
 * @param {object} o
 * @param {THREE.Mesh} o.mesh       the placed building (its leaves are children)
 * @param {object} o.units          the shared units
 * @param {string} o.typeKey        "post", "motorPool" — what the command card offers
 * @param {string} [o.team]         "player" (default) or "enemy" (the ALN's cave)
 * @param {string} o.name
 * @param {number} o.maxHp
 * @param {Record<string, number>} o.builds   unit key → seconds to build
 * @param {[number, number]} o.inside   post-local (scaled m): where a unit appears
 * @param {[number, number]} o.outside  post-local: where it is out of the gate
 * @param {{x:number,z:number}} o.rally  where it goes then (world)
 * @param {{hold:number, rise:number, deckY:number}} [o.launch]  a HELIPAD: the
 *   aircraft appears on the deck (`deckY` above the pad's origin), its rotor
 *   spools up for `hold` s, it rises over `rise` s, then flies to the rally.
 *   No `outside` then: nothing walks out.
 */
export function createAlgProducer({ mesh, units, typeKey, name, maxHp, builds, inside: inL, outside: outL = inL, rally, launch = null, team = "player" }) {
  const leaves = mesh.children.filter((c) => c.userData.gateLeaf);
  const yaw = mesh.rotation.y, c = Math.cos(yaw), s = Math.sin(yaw);
  /** Building-local (scaled metres) → world. */
  const toWorld = (lx, lz) => ({ x: mesh.position.x + lx * c + lz * s, z: mesh.position.z - lx * s + lz * c });
  const fp = mesh.geometry.userData.footprint;
  const centre = toWorld(fp.cx, fp.cz);

  const structure = {
    isStructure: true,
    typeKey,
    name,
    team,
    alive: true,
    selected: false,
    hp: maxHp, maxHp,
    radius: Math.hypot(fp.hx, fp.hz),
    type: { typeKey, name },
    position: mesh.position,
    rally: { x: rally.x, z: rally.z },
    queue: [],
    progress: 0,
    setSelected(v) { structure.selected = !!v; },
    enqueue(key) {
      if (structure.queue.length >= 8 || !builds[key]) return false;
      structure.queue.push(key);
      return true;
    },
  };

  let t = 0, openUntil = -1;
  const inside = toWorld(...inL), outside = toWorld(...outL);
  const lifting = [];   // helipad: { u, at } — sent to the rally once clear of the pad

  function update(dt) {
    t += dt;
    // Production: one unit at a time.
    if (structure.queue.length) {
      const key = structure.queue[0];
      structure.progress += dt / builds[key];
      if (structure.progress >= OPEN_AHEAD) openUntil = Math.max(openUntil, t + HOLD_OPEN);
      if (structure.progress >= 1) {
        structure.progress = 0;
        structure.queue.shift();
        const u = units.spawn(key, inside.x, inside.z, { snap: false, team });
        if (u && launch) {
          // On the deck, nose to where it will go; ghosted so the machines
          // hovering above do not shove it off the pad while it spools up.
          u.faceToward(structure.rally.x, structure.rally.z);
          u.launch(launch.rise, { hold: launch.hold, fromY: mesh.position.y + launch.deckY });
          u.ghost = true;
          lifting.push({ u, at: t + launch.hold + launch.rise * 0.35 });
        } else u?.emerge(outside.x, outside.z, structure.rally.x, structure.rally.z);
        openUntil = t + HOLD_OPEN;
      }
    } else structure.progress = 0;
    // Aircraft off the pad: once they are climbing, on to the rally.
    for (let i = lifting.length - 1; i >= 0; i--) {
      const { u, at } = lifting[i];
      if (t < at) continue;
      u.ghost = false;
      if (u.alive) u.orderTo(structure.rally.x, structure.rally.z);
      lifting.splice(i, 1);
    }
    // The leaves follow: open while a unit is due or on its way out.
    const open = t < openUntil;
    for (const leaf of leaves) {
      const target = open ? leaf.userData.openYaw : 0;
      const d = target - leaf.rotation.y;
      leaf.rotation.y += Math.sign(d) * Math.min(Math.abs(d), OPEN_SPEED * dt);
    }
  }

  // A PICK BOX over the whole footprint, walls high, invisible: a click in an
  // open courtyard or an open bay (no geometry there) must select it too.
  const pick = new THREE.Mesh(
    new THREE.BoxGeometry(fp.hx * 2, 7, fp.hz * 2),
    new THREE.MeshBasicMaterial({ visible: false }),
  );
  pick.position.set(fp.cx, 3.5, fp.cz);
  pick.name = `${typeKey}Pick`;
  mesh.add(pick);

  /** Selected: corner brackets round the footprint (a square building). */
  function markSelected(frames) {
    frames.add(centre.x, centre.z, fp.hx + 0.6, fp.hz + 0.6, yaw, undefined, mesh.position.y + 0.8);
  }

  return {
    structure, update, centre, markSelected, mesh,
    /** World points: where a unit appears, and where it is out (the AI sends the ALN back to the cave's). */
    inside, outside,
    get gateOpen() { return leaves.some((l) => Math.abs(l.rotation.y) > 0.05); },
  };
}

/**
 * The game's producers and ONE structures renderer over them all, the shape
 * the shared selection takes.
 */
export function createStructuresRenderer(producers) {
  return {
    roots: producers.map((p) => p.mesh),
    structureFromHit(h) {
      for (let o = h.object; o; o = o.parent) {
        const p = producers.find((q) => q.mesh === o);
        if (p) return p.structure;
      }
      return null;
    },
  };
}
