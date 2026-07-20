// Resource economy — GAME LOGIC (mesh-free, like units.js and structures.js).
//
// One currency ("supplies") and a set of FINITE nodes scattered across the map.
// Harvesters (harvesting.js) drive to a node, fill up, drive back to the base and
// unload; a node that runs dry disappears and its harvesters move to the next one.
// Finite nodes are the point: they push you outward across the map over time
// instead of letting one harvester loop next to the base forever.
//
// Nodes are placed on real, flattened sites like every other structure, so they
// never end up half-buried in a hillside.
import * as THREE from "three";
import { findBuildSite, prepareSite } from "./sitePlanner.js";

/** What each base-produced unit costs. Buildings and helipad units are free for now. */
export const UNIT_COST = {
  soldier: 50,
  jeep: 120,
  builder: 100,
  harvester: 150,
  bigtank: 260,
  tank: 420,   // the heavy: a real investment, and it shows on the field
};

const NODE_RADIUS = 5;
const NODE_AMOUNT = 1500;   // supplies in a full node
const STARTING_STOCK = 400; // enough for a harvester's worth of opening moves
const FIRST_NODE_DIST = 95; // metres from the base — a ~6 s drive at harvester speed
const NODE_SPACING = 80;    // each subsequent node this much further out

export async function createResources({ app, startingStock = STARTING_STOCK, nodeCount = 7 } = {}) {
  const nodes = [];
  let stock = startingStock;
  let earned = 0; // lifetime, for the HUD's "harvested" readout

  /** A node is a dumb record — the renderer reads `amount / maxAmount` to show wear. */
  function makeNode(x, y, z) {
    return {
      kind: "resourceNode",
      position: new THREE.Vector3(x, y, z),
      radius: NODE_RADIUS,
      amount: NODE_AMOUNT,
      maxAmount: NODE_AMOUNT,
      alive: true,
    };
  }

  /**
   * Fan nodes out in front of the base, at increasing distance.
   *
   * Distances are in METRES, not fractions of the world: the map is 2048 across,
   * so a fraction-based layout put the nearest node 643 m out — a 43-second haul
   * that made the whole economy feel broken. The first node is a short drive; each
   * one after is further up-map, so expanding is a real (and riskier) commitment.
   */
  async function placeNodes(basePos) {
    for (let i = 0; i < nodeCount; i++) {
      const dist = FIRST_NODE_DIST + i * NODE_SPACING;
      // Alternate left/right of the base's forward axis, widening as we go out.
      const ang = (i % 2 ? 1 : -1) * (0.32 + i * 0.11);
      const x = basePos.x + Math.sin(ang) * dist;
      const z = basePos.z + Math.cos(ang) * dist; // +Z is up-map, toward the enemy

      const site = findBuildSite(app, x, z, NODE_RADIUS, { searchRadius: 140, maxSpread: 6 });
      if (!site) {
        console.warn(`[rts-v3] no flat ground for resource node ${i} — skipped.`);
        continue;
      }
      await prepareSite(app, site.x, site.z, NODE_RADIUS, site.y);
      nodes.push(makeNode(site.x, site.y, site.z));
    }
  }

  /** Nearest node with supplies left, or null when the map is tapped out. */
  function nearestNode(x, z, maxDist = Infinity) {
    let best = null, bestD = maxDist * maxDist;
    for (const n of nodes) {
      if (!n.alive || n.amount <= 0) continue;
      const d = (n.position.x - x) ** 2 + (n.position.z - z) ** 2;
      if (d < bestD) { bestD = d; best = n; }
    }
    return best;
  }

  /**
   * Pull up to `want` supplies out of a node. Returns what was actually taken —
   * the last scoop off a nearly-empty node is a partial one.
   */
  function drawFrom(node, want) {
    if (!node?.alive || node.amount <= 0) return 0;
    const took = Math.min(want, node.amount);
    node.amount -= took;
    if (node.amount <= 0) { node.amount = 0; node.alive = false; }
    return took;
  }

  return {
    nodes,
    placeNodes,
    nearestNode,
    drawFrom,

    get stock() { return stock; },
    get earned() { return earned; },
    /** Live nodes remaining — the HUD warns when the map is running out. */
    get liveNodes() { return nodes.filter((n) => n.alive).length; },

    canAfford(n) { return stock >= n; },
    /** Spend if affordable. Returns false (and spends nothing) if it isn't. */
    spend(n) {
      if (stock < n) return false;
      stock -= n;
      return true;
    },
    /** A harvester unloading at the base. */
    deposit(n) {
      stock += n;
      earned += n;
    },
  };
}
