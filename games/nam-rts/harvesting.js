// Harvester AI — GAME LOGIC. Drives every harvester's node→base→node loop.
//
// Its own driver (like combat.js) rather than logic inside units.js: units.js owns
// movement and knows nothing about what a unit is FOR, and the loop here is pure
// order-issuing on top of the same moveOrder/orderTo API the player uses.
//
// The loop is a four-state machine per harvester:
//
//   toNode ──arrive──> filling ──full/dry──> toBase ──arrive──> unloading ──┐
//      ^                                                                    │
//      └────────────────────────────────────────────────────────────────────┘
//
// Orders are only re-issued on a STATE CHANGE or when the unit has gone idle, so
// a player who manually move-orders a harvester keeps control until it arrives —
// then the loop quietly picks it back up. That's the RTS convention and it avoids
// the AI fighting the player for the steering wheel every frame.
const ARRIVE_PAD = 4;    // metres of slack on "am I there yet"
const REPATH_SAFETY = 4; // seconds — only a stuck-recovery net, not the normal path
const DEST_EPS = 2;      // metres; a destination move smaller than this isn't worth re-pathing

const flatDist = (a, bx, bz) => Math.hypot(a.position.x - bx, a.position.z - bz);

export function createHarvesting({ units, structures, resources }) {
  /**
   * Per-unit state lives on the unit under `harvest`, created lazily so a
   * harvester spawned at any time joins the loop with no registration step.
   */
  function stateOf(u) {
    if (!u.harvest) {
      u.harvest = { state: "toNode", carrying: 0, node: null, repathT: 0, dest: null };
    }
    return u.harvest;
  }

  /** Where a harvester unloads: just outside the base footprint, on the door side. */
  function dropPoint() {
    const b = structures.base;
    if (!b?.alive) return null;
    return { x: b.position.x, z: b.position.z - (b.radius + 6), y: b.position.y };
  }

  /**
   * Send the unit somewhere. Re-issuing an order runs A* again, so only do it when
   * something actually changed: a new destination, or the unit went idle (arrived
   * short, or got stuck). The timer is a slow safety net for a harvester wedged
   * against geometry — NOT the normal path, which is issued once per leg.
   */
  function driveTo(u, h, x, z, dt) {
    h.repathT -= dt;
    const moved = !h.dest || Math.hypot(h.dest.x - x, h.dest.z - z) > DEST_EPS;
    if (moved || !u.isMoving || h.repathT <= 0) {
      u.orderTo(x, z);
      h.dest = { x, z };
      h.repathT = REPATH_SAFETY;
    }
  }

  function update(dt) {
    const drop = dropPoint();

    for (const u of units.list) {
      if (!u.alive || u.type?.typeKey !== "harvester") continue;
      // A harvester the player explicitly sent to attack something is theirs.
      if (u.attackTarget) continue;

      const cfg = u.type.harvest;
      const h = stateOf(u);

      switch (h.state) {
        case "toNode": {
          // Lost the node (someone else drained it) — find another.
          if (!h.node?.alive || h.node.amount <= 0) {
            h.node = resources.nearestNode(u.position.x, u.position.z);
            h.repathT = 0; // new destination, re-path now
          }
          if (!h.node) {
            // Map is tapped out. Head home rather than idling in the field.
            if (h.carrying > 0) { h.state = "toBase"; h.repathT = 0; }
            continue;
          }
          const n = h.node;
          if (flatDist(u, n.position.x, n.position.z) <= n.radius + u.radius + ARRIVE_PAD) {
            u.haltMovement();
            h.state = "filling";
          } else {
            driveTo(u, h, n.position.x, n.position.z, dt);
          }
          break;
        }

        case "filling": {
          const n = h.node;
          if (!n?.alive || n.amount <= 0) {
            // Node died under us. Go home if we're carrying anything, else re-seek.
            h.state = h.carrying > 0 ? "toBase" : "toNode";
            h.node = null;
            h.repathT = 0;
            break;
          }
          const want = Math.min(cfg.rate * dt, cfg.capacity - h.carrying);
          h.carrying += resources.drawFrom(n, want);
          if (h.carrying >= cfg.capacity - 0.001) {
            h.state = "toBase";
            h.repathT = 0;
          }
          break;
        }

        case "toBase": {
          if (!drop) continue; // base is gone — nothing to do but sit
          if (flatDist(u, drop.x, drop.z) <= u.radius + ARRIVE_PAD + 4) {
            u.haltMovement();
            h.state = "unloading";
          } else {
            driveTo(u, h, drop.x, drop.z, dt);
          }
          break;
        }

        case "unloading": {
          const given = Math.min(cfg.unloadRate * dt, h.carrying);
          h.carrying -= given;
          resources.deposit(given);
          if (h.carrying <= 0.001) {
            h.carrying = 0;
            h.state = "toNode";
            h.repathT = 0;
          }
          break;
        }
      }
    }
  }

  return {
    update,
    /** Player right-clicked a node: assign it and restart the loop there. */
    assignNode(u, node) {
      if (u?.type?.typeKey !== "harvester" || !node?.alive) return false;
      const h = stateOf(u);
      h.node = node;
      h.repathT = 0;
      // Carrying a full load? Finish the delivery first, then use the new node.
      if (h.state !== "toBase" && h.state !== "unloading") h.state = "toNode";
      return true;
    },
    /** For the HUD / command card. */
    stateOf,
  };
}
