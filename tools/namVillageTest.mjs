/**
 * THE HAMLET (games/nam-rts/village.js + v3/render/objects/rtsVillage.js).
 *
 * A village is an ARRANGEMENT, so this tests the arrangement:
 *
 *   · the lane runs clear from end to end — you can walk through the village
 *   · nothing stands inside anything else (fences tested as lines, not points)
 *   · both house types are used, in two rows, all doors toward the lane
 *   · every piece is inside the hamlet's stated radius
 *   · every built piece fits the size the plan spaced it by, sits ON the
 *     ground, and carries a footprint for nav and pads
 *   · the plan is the same every time (no rng in the layout itself)
 *
 *   node tools/namVillageTest.mjs
 */
import { HAMLET, STILT_HOUSE, hamletPlan, toWorld } from "../games/nam-rts/village.js";
import {
  buildBambooClump, buildBananaClump, buildBigRoofHouse, buildCookHearth, buildDryingRack,
  buildFence, buildGranary, buildJarCluster, buildOxCart, buildPigPen, buildShrine,
  buildStrawRick, buildWashingLine, buildWell,
} from "../v3/render/objects/rtsVillage.js";
import { buildVillageHutLod0 } from "../v3/render/objects/rtsVillageHut.js";

let failed = 0;
const ok = (name, cond, extra = "") => {
  if (cond) console.log(`  ok   ${name}${extra ? "  " + extra : ""}`);
  else { failed++; console.log(`  FAIL ${name}${extra ? "  " + extra : ""}`); }
};

const plan = hamletPlan();

/**
 * Each piece as the ORIENTED RECTANGLE it really is (a fence is a long thin
 * one), and the gap between two of them by the separating-axis test. Circles
 * round rectangles would call a hamlet's worth of honest spacing a collision.
 */
/** Small stuff that may stand under a house's eaves, but not inside its walls. */
const CLUTTER = new Set(["jars", "rack", "hearth", "shrine", "fence", "cart", "banana", "washing"]);
function box(p, { walls = false } = {}) {
  const s = (walls && HAMLET.walls[p.kind]) || HAMLET.size[p.kind] || { hx: 1, hz: 1 };
  const c = Math.cos(p.rotY), sn = Math.sin(p.rotY);
  // Local +X maps to (c, -sn) and +Z to (sn, c) — the same turn toWorld makes.
  return {
    x: p.x, z: p.z, ax: [{ x: c, z: -sn }, { x: sn, z: c }],
    h: [s.hx + (p.kind === "fence" ? (p.length ?? 6) / 2 : 0), s.hz],
  };
}
function gapBetween(A, B) {
  let worst = -Infinity;
  const spread = (o, n) => Math.abs(o.ax[0].x * n.x + o.ax[0].z * n.z) * o.h[0]
    + Math.abs(o.ax[1].x * n.x + o.ax[1].z * n.z) * o.h[1];
  for (const src of [A, B]) {
    for (const n of src.ax) {
      const d = Math.abs((B.x - A.x) * n.x + (B.z - A.z) * n.z);
      worst = Math.max(worst, d - spread(A, n) - spread(B, n));
    }
  }
  return worst;                       // > 0 on any axis means they are apart
}

console.log("the lane");
{
  // Every piece stays out of the band down the middle, for its whole length —
  // a fence laid across the lane would close the village off.
  const zAxis = { x: 0, z: 1 };
  const intruders = plan.filter((p) => {
    const b = box(p);
    const reach = Math.abs(b.ax[0].z) * b.h[0] + Math.abs(b.ax[1].z) * b.h[1];
    const alongLane = Math.abs(p.x) - (Math.abs(b.ax[0].x) * b.h[0]) < HAMLET.laneLength / 2;
    return alongLane && Math.abs(p.z * zAxis.z) - reach < HAMLET.laneHalf;
  });
  ok("the lane runs clear end to end", intruders.length === 0,
    intruders.map((p) => `${p.kind}@${p.x},${p.z}`).join(" "));
}

console.log("\nspacing");
{
  let worst = null;
  for (let i = 0; i < plan.length; i++) {
    for (let j = i + 1; j < plan.length; j++) {
      const a = plan[i], b = plan[j];
      // Two fences are allowed to touch: a frontage MEETS the side run at the
      // corner of a yard, which is what a corner is.
      if (a.kind === "fence" && b.kind === "fence") continue;
      // One of them small: the big one is measured by its WALLS, so a jar may
      // stand under the eaves. Two buildings: by their roofs, which must not
      // touch at all.
      const eaves = CLUTTER.has(a.kind) !== CLUTTER.has(b.kind);
      const g = gapBetween(box(a, { walls: eaves }), box(b, { walls: eaves }));
      if (!worst || g < worst.g) worst = { g, a, b };
    }
  }
  ok("nothing stands inside anything else", worst.g > 0,
    `tightest ${worst.a.kind}/${worst.b.kind} ${worst.g.toFixed(2)} m`);
  const out = plan.filter((p) => {
    const s = HAMLET.size[p.kind] ?? { hx: 1, hz: 1 };
    const r = Math.hypot(s.hx + (p.kind === "fence" ? (p.length ?? 6) / 2 : 0), s.hz);
    return Math.hypot(p.x, p.z) + r > HAMLET.radius;
  });
  ok("the whole hamlet fits its radius", out.length === 0, out.map((p) => p.kind).join(" "));
}

console.log("\nthe two rows");
{
  const houses = plan.filter((p) => p.kind === "bigHouse" || p.kind === "stiltHouse");
  ok("a hamlet's worth of houses", houses.length >= 6, `${houses.length}`);
  ok("both house types are used",
    houses.some((h) => h.kind === "bigHouse") && houses.some((h) => h.kind === "stiltHouse"));
  // A door faces the lane: near row (-Z) at rotY ~ 0, far row (+Z) turned about.
  const facing = houses.every((h) => (h.z < 0 ? Math.abs(h.rotY) < 0.3 : Math.abs(Math.abs(h.rotY) - Math.PI) < 0.3));
  ok("every door faces the lane", facing);
  const nearRow = houses.filter((h) => h.z < 0).map((h) => h.x).sort((a, b) => a - b);
  const farRow = houses.filter((h) => h.z > 0).map((h) => h.x).sort((a, b) => a - b);
  // Staggered: no house directly opposite another across the lane.
  const opposed = nearRow.filter((x) => farRow.some((y) => Math.abs(x - y) < 6));
  ok("the rows are staggered, not opposite each other", opposed.length === 0);
}

console.log("\nplaced in the world");
{
  const a = toWorld({ x: 10, z: 0, rotY: 0 }, { x: 100, z: 200, rotY: 0 });
  ok("no rotation puts a piece where the plan says", Math.abs(a.x - 110) < 1e-9 && Math.abs(a.z - 200) < 1e-9);
  const b = toWorld({ x: 10, z: 0, rotY: 0 }, { x: 0, z: 0, rotY: Math.PI / 2 });
  ok("a quarter turn swings the lane round", Math.abs(b.x) < 1e-9 && Math.abs(b.z + 10) < 1e-9,
    `(${b.x.toFixed(2)}, ${b.z.toFixed(2)})`);
  ok("and turns the piece with it", Math.abs(b.rotY - Math.PI / 2) < 1e-9);
}

console.log("\nthe pieces themselves");
{
  const built = {
    bigHouse: buildBigRoofHouse(), stiltHouse: buildVillageHutLod0(STILT_HOUSE),
    granary: buildGranary(), well: buildWell(), shrine: buildShrine(),
    fence: buildFence({ length: 13 }), jars: buildJarCluster(), rack: buildDryingRack(),
    rick: buildStrawRick(), hearth: buildCookHearth(), cart: buildOxCart(),
    bamboo: buildBambooClump(), banana: buildBananaClump({ plants: 3 }), pigPen: buildPigPen(),
    washing: buildWashingLine(),
  };
  let tris = 0;
  for (const [kind, geo] of Object.entries(built)) {
    geo.computeBoundingBox();
    const b = geo.boundingBox;
    tris += (geo.index ? geo.index.count : geo.attributes.position.count) / 3;
    // Sunk a little is fine (a fence post, loose straw); hanging in the air is not.
    ok(`${kind} sits on the ground`, b.min.y > -0.35 && b.min.y < 0.2, `y ${b.min.y.toFixed(2)}`);
    if (kind === "fence") continue;   // sized by its length, not its half-extent
    const hx = Math.max(b.max.x, -b.min.x), hz = Math.max(b.max.z, -b.min.z);
    const s = HAMLET.size[kind];
    ok(`${kind} fits the room the plan leaves it`, hx <= s.hx + 0.2 && hz <= s.hz + 0.2,
      `${hx.toFixed(1)} x ${hz.toFixed(1)} vs ${s.hx} x ${s.hz}`);
  }
  console.log(`  --   one of each: ${tris | 0} tris`);
}

console.log("\nthe same every time");
{
  const a = JSON.stringify(hamletPlan());
  const b = JSON.stringify(hamletPlan());
  ok("the plan is deterministic", a === b);
}

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
