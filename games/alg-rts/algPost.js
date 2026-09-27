// THE FRENCH POST AS A STRUCTURE — selectable, produces units, and its GATE
// works: the leaves swing open before a man comes out and shut behind the
// last one. The post's mesh is the showroom's (showroom.js), its gate leaves
// children of it (userData.gate, rtsFrenchPost.js).
//
// It plugs into the shared selection through the "structures renderer"
// shape it already knows ({ roots, structureFromHit }), and into this game's
// command card through `enqueue` / `queue` / `progress` (a producer).
import * as THREE from "three";

const BUILD_TIME = { appele: 6 };      // seconds per man
const OPEN_SPEED = 1.8;               // rad/s — a heavy timber leaf
const HOLD_OPEN = 3.5;                // s after the last man, then it shuts
const OPEN_AHEAD = 0.8;               // start opening at 80% of a man's build

export function createAlgPost({ app, mesh, units, muster }) {
  const gate = mesh.geometry.userData.gate;
  const leaves = mesh.children.filter((c) => c.userData.gateLeaf);
  const yaw = mesh.rotation.y, c = Math.cos(yaw), s = Math.sin(yaw);
  /** Post-local (scaled metres) → world. */
  const toWorld = (lx, lz) => ({ x: mesh.position.x + lx * c + lz * s, z: mesh.position.z - lx * s + lz * c });
  const fp = mesh.geometry.userData.footprint;
  const centre = toWorld(fp.cx, fp.cz);

  const post = {
    isStructure: true,
    typeKey: "post",
    name: "Poste de Tighanimine",
    team: "player",
    alive: true,
    selected: false,
    hp: 2000, maxHp: 2000,
    radius: Math.hypot(fp.hx, fp.hz),
    type: { typeKey: "post", name: "Poste" },
    position: mesh.position,
    rally: { x: muster.x, z: muster.z },
    queue: [],
    progress: 0,
    setSelected(v) { post.selected = !!v; },
    enqueue(key) {
      if (post.queue.length >= 8 || !BUILD_TIME[key]) return false;
      post.queue.push(key);
      return true;
    },
  };

  let t = 0, openUntil = -1;
  // Inside the courtyard behind the gate, and just outside the arch.
  const inside = toWorld(0, gate.z + 4.5 * 1.3);
  const outside = toWorld(0, gate.z - 3.2 * 1.3);

  function update(dt) {
    t += dt;
    // Production: one man at a time.
    if (post.queue.length) {
      const key = post.queue[0];
      post.progress += dt / BUILD_TIME[key];
      if (post.progress >= OPEN_AHEAD) openUntil = Math.max(openUntil, t + HOLD_OPEN);
      if (post.progress >= 1) {
        post.progress = 0;
        post.queue.shift();
        const u = units.spawn(key, inside.x, inside.z, { snap: false });
        u?.emerge(outside.x, outside.z, post.rally.x, post.rally.z);
        openUntil = t + HOLD_OPEN;
      }
    } else post.progress = 0;
    // The gate follows: open while a man is due or on his way out.
    const open = t < openUntil;
    for (const leaf of leaves) {
      const target = open ? leaf.userData.openYaw : 0;
      const d = target - leaf.rotation.y;
      leaf.rotation.y += Math.sign(d) * Math.min(Math.abs(d), OPEN_SPEED * dt);
    }
  }

  // A PICK BOX over the whole footprint, walls high, invisible: a click in the
  // open courtyard (no geometry there) must select the post too.
  const pick = new THREE.Mesh(
    new THREE.BoxGeometry(fp.hx * 2, 7, fp.hz * 2),
    new THREE.MeshBasicMaterial({ visible: false }),
  );
  pick.position.set(fp.cx, 3.5, fp.cz);
  pick.name = "PostPick";
  mesh.add(pick);

  // The shape the shared selection picks structures with.
  const renderer = {
    roots: [mesh],
    structureFromHit(h) {
      for (let o = h.object; o; o = o.parent) if (o === mesh) return post;
      return null;
    },
  };

  /** Selected: corner brackets round the footprint (a square building). */
  function markSelected(frames) {
    frames.add(centre.x, centre.z, fp.hx + 0.6, fp.hz + 0.6, yaw, undefined, mesh.position.y + 0.8);
  }

  return {
    post, renderer, update, centre, markSelected,
    get gateOpen() { return leaves.some((l) => Math.abs(l.rotation.y) > 0.05); },
  };
}
