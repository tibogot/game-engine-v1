// ============================================================================
// THE ELEVATED MOTORWAY: is it in the air, out of the way, and driven on?
//
// A viaduct is the one thing in the city that occupies the space everything
// else leaves empty, which means it is the one thing that can collide with
// everything else — and every one of those collisions is silent. A skybridge
// through the deck, a pier standing in a traffic lane, a car floating beside
// the road instead of on it: all of them build, draw and run at full speed.
//
// So the checks here are mostly clearances, and each one is stated as the
// arithmetic that has to keep holding rather than as a number somebody typed.
// ============================================================================
import { register } from "node:module";

register("./threeWebgpuHook.mjs", import.meta.url);
const THREE = await import("three/webgpu");
const { viaductLayout, createCityViaduct } =
  await import("../games/modular-road-v3/modularRoadCityViaduct.js");
const { roadParams } = await import("../games/modular-road-v3/modularRoadKit.js");
const { BRIDGE_DEFAULTS } = await import("../games/modular-road-v3/modularRoadCityBridges.js");
const { CITY_DEFAULTS, createModularRoadCity } = await import("../games/modular-road-v3/modularRoadCity.js");
const { LANE_FRACS, laneDirForIndex, FURNITURE_DEFAULTS } =
  await import("../games/modular-road-v3/modularRoadCityFurniture.js");

let pass = 0, fail = 0;
const check = (name, ok, extra = "") => {
  if (ok) { pass++; console.log(`PASS  ${name}${extra ? `  — ${extra}` : ""}`); }
  else { fail++; console.log(`FAIL  ${name}${extra ? `  — ${extra}` : ""}`); }
};

const P = CITY_DEFAULTS;
const pitch = (P.blockLots + P.streetLots) * P.lotSize;
const blockW = P.blockLots * P.lotSize;
const streetW = Math.max(P.streetLots * P.lotSize, 1);
const L = viaductLayout({ P, originCellX: 0, originCellZ: 0 });
check("a layout is produced", !!L, L ? `${L.axis} axis at ${L.across}` : "null");

// ── IT IS ABOVE A STREET, NOT A BLOCK ───────────────────────────────────────
{
  let f = L.across % pitch;
  if (f < 0) f += pitch;
  check("the viaduct runs above a street, not through a block",
    f >= blockW - 1e-6 && f <= pitch + 1e-6, `${f.toFixed(1)} into a ${blockW} m block + ${streetW} m street`);
  check("and it is on that street's centre line",
    Math.abs(f - (blockW + streetW / 2)) < 1e-6, `${f.toFixed(2)} vs ${blockW + streetW / 2}`);
}

// ── THE ONE HEIGHT CONSTRAINT ───────────────────────────────────────────────
// Skybridges cross at `bridgeLow` of the shorter tower, and both towers must
// clear `bridgeMinHeight`. So this is the lowest one that can ever exist, and
// nothing about the viaduct may reach it. Break this and a glazed link runs
// straight through the deck, in a city where you have to be under it to see.
{
  const lowestBridge = BRIDGE_DEFAULTS.bridgeMinHeight * BRIDGE_DEFAULTS.bridgeLow;
  check("the whole viaduct stays below the lowest possible skybridge",
    L.railTop < lowestBridge,
    `parapet top ${L.railTop.toFixed(2)} m vs skybridge floor ${lowestBridge.toFixed(2)} m`);
  // Worth stating separately: it is a clearance, not a coincidence. If the
  // margin ever falls under a metre somebody has been tuning towards a crash.
  check("with a metre of margin, not a coincidence", lowestBridge - L.railTop > 1.0,
    `${(lowestBridge - L.railTop).toFixed(2)} m of margin`);
}

// ── YOU CAN DRIVE UNDER IT ──────────────────────────────────────────────────
{
  const tallest = Math.max(FURNITURE_DEFAULTS.lampHeight ?? 0, 9.0);
  check("the deck clears the tallest street furniture",
    L.deckBottom > tallest, `underside ${L.deckBottom} m vs ${tallest} m`);
}

// ── NO PIER STANDS IN A TRAFFIC LANE ────────────────────────────────────────
// Piers sit on the street's centre line and the ground lanes sit either side
// of it, so this is a real clearance and not a tautology — narrow the street,
// widen the pier, or move a lane fraction and it stops being true. A pier in a
// lane is cars driving through concrete, every lap, with no warning.
{
  const V = L.params;
  const pierHalf = Math.max(V.pierWidth, V.pierDepth) / 2;
  // Half a car's width, from the collision model: `carRadius` is 0.80.
  const carHalf = 0.9;
  let worst = Infinity, at = "";
  // The lanes on the street the viaduct runs above are the ones at risk: the
  // piers share that street's `across` range.
  const base = L.across - streetW / 2;
  for (let fi = 0; fi < LANE_FRACS.length; fi++) {
    const laneAcross = base + streetW * LANE_FRACS[fi];
    const d = Math.abs(laneAcross - L.across);
    if (d < worst) { worst = d; at = `lane ${fi} (${laneDirForIndex(L.axis, fi) > 0 ? "+" : "-"})`; }
  }
  check("no pier stands in a ground traffic lane", worst > pierHalf + carHalf,
    `${worst.toFixed(2)} m from the centre line to ${at}, needs ${(pierHalf + carHalf).toFixed(2)}`);
}

// ── NO PIER STANDS IN A JUNCTION ────────────────────────────────────────────
{
  const bad = L.piers.filter((q) => {
    const along = L.axis === "x" ? q.x : q.z;
    let f = along % pitch;
    if (f < 0) f += pitch;
    return f >= blockW;
  });
  check("piers span the junctions rather than standing in them",
    bad.length === 0, `${L.piers.length} piers, ${bad.length} in a junction`);
  check("there are piers at all", L.piers.length > 10, `${L.piers.length}`);
}

// ── THE DECK LANES ARE ON THE DECK ──────────────────────────────────────────
{
  const V = L.params;
  // Inside the KERB now, not a parapet: the deck is a road-kit sweep, so its
  // drivable width is the section width less a kerb at each side.
  const edge = V.deckWidth / 2 - roadParams.railWidth;
  const off = L.laneAcross.map((a) => Math.abs(a - L.across));
  check("every deck lane is inside the kerbs", Math.max(...off) < edge,
    `outermost ${Math.max(...off).toFixed(2)} m vs ${edge.toFixed(2)} m`);
  check("the deck lanes keep right, same rule as the street",
    laneDirForIndex(L.axis, 0) === -laneDirForIndex(L.axis, 3),
    "outer lanes oppose");
}

// ── TWO DRAWS, AND THE CARS ARE ACTUALLY UP THERE ───────────────────────────
{
  const city = createModularRoadCity({ params: { extent: 700 } });
  const meshes = [];
  city.group.traverse((o) => { if (o.isMesh && /Viaduct/.test(o.name)) meshes.push(o); });
  check("the viaduct is four draws — deck, rail, shafts, caps", meshes.length === 4,
    meshes.map((m) => m.name).join(", "));
  check("the city reports a viaduct", !!city.stats.viaduct, JSON.stringify(city.stats.viaduct));

  // A camera under the deck, so everything nearby is in range.
  const cam = { position: new THREE.Vector3(0, 3, 0) };
  for (let i = 0; i < 6; i++) { cam.position.y += 0.01; city.update(0.4, cam); }

  /*
   * THE CARS ARE READ OFF THE RENDERED MATRICES, not off the model.
   *
   * The model carrying a `y` proves nothing: the whole change is one `?? ` in
   * the pose loop, and if it had not landed there the motorway's traffic would
   * simply drive along the pavement under its own road — at the right speed, in
   * the right lanes, facing the right way. Only the matrix says where it is.
   */
  const heights = [];
  city.group.traverse((o) => {
    if (!o.isInstancedMesh || !/^CityTraffic_/.test(o.name)) return;
    const e = o.instanceMatrix.array;
    for (let i = 0; i < o.count; i++) heights.push(e[i * 16 + 13]);
  });
  const cityViaduct = city.stats.viaduct;
  const deckY = viaductLayout({ P, originCellX: 0, originCellZ: 0 }).deckY;
  const up = heights.filter((y) => y > deckY - 1).length;
  const down = heights.filter((y) => y < 3).length;
  check("some traffic is drawn ON the deck", up > 10, `${up} of ${heights.length} cars above ${deckY.toFixed(1)} m`);
  check("and the street traffic is still on the street", down > 10, `${down} at ground level`);
  check("nothing is drawn between the two", up + down === heights.length,
    `${heights.length - up - down} cars at neither height`);
  check("the deck carries piers worth reporting", cityViaduct.piers > 5 && cityViaduct.draws === 4,
    JSON.stringify(cityViaduct));

  /*
   * ── IT IS ACTUALLY IN THE DRIVE-SURFACE BVH ───────────────────────────────
   *
   * The city has to HAND OVER its deck, in the shape the game's collision bake
   * collects — `{deck, solids}`, the same contract the dock uses. Without this
   * the viaduct is a road you fall straight through, which looks completely
   * correct right up until you land on it.
   */
  const col = city.viaductCollision();
  check("the city hands over a drive surface", col.deck.length === 1,
    `${col.deck.length} deck meshes`);
  check("and a solid guardrail to stay on it", col.solids.length === 1,
    `${col.solids.length} solid meshes`);
  check("the deck it hands over is the deck you can see",
    col.deck[0] === meshes.find((m) => m.name === "CityViaductDeck"),
    "same object, no proxy");
  check("the guardrail collider is NOT drawn",
    col.solids[0].visible === false && !col.solids[0].parent,
    "invisible and out of the scene graph");
  // Every collision mesh must carry the two things RoadBvh reads off it.
  for (const m of [...col.deck, ...col.solids]) {
    check(`${m.name} is bakeable`, !!m.geometry && !!m.matrixWorld);
  }
  city.dispose();
}

// ── THE SLIP ROADS ──────────────────────────────────────────────────────────
//
// A ramp has to satisfy four things at once, and three of them are invisible
// until you drive it: it must fit in the street, it must clear the deck it
// left, it must not be steeper than a car can take, and it must arrive at
// street level rather than a metre above or below it.
{
  const V = L.params;
  check("there are ramps", (L.ramps ?? []).length >= 2, `${(L.ramps ?? []).length}`);

  // FIT AND CLEARANCE, as the two inequalities rather than as the numbers that
  // currently satisfy them. Widen the deck or the ramp and this is what fails.
  check("a ramp clears the deck it diverges from",
    V.rampOffset - V.rampWidth / 2 >= V.deckWidth / 2 - 1e-9,
    `inner edge ${(V.rampOffset - V.rampWidth / 2).toFixed(2)} vs deck edge ${(V.deckWidth / 2).toFixed(2)}`);
  check("and still fits inside the street",
    V.rampOffset + V.rampWidth / 2 <= streetW / 2 + 1e-9,
    `outer edge ${(V.rampOffset + V.rampWidth / 2).toFixed(2)} vs kerb ${(streetW / 2).toFixed(2)}`);

  for (let r = 0; r < L.ramps.length; r++) {
    const path = L.ramps[r].path;
    // ARRIVES AT THE STREET. A ramp ending in the air is a jump; one ending
    // below the street is a hole. Both draw perfectly.
    const end = path[path.length - 1];
    check(`ramp ${r} arrives at street level`, Math.abs(end.y - P.groundY) < 0.25,
      `ends at ${end.y.toFixed(2)} m`);
    check(`ramp ${r} starts on the deck`, Math.abs(path[0].y - L.deckY) < 0.1,
      `starts at ${path[0].y.toFixed(2)} vs deck ${L.deckY.toFixed(2)}`);

    // DRIVABLE. Measured as the real grade between stations, not as the
    // average — the eased profile is deliberately steeper in the middle, and
    // the average would hide exactly the part that matters.
    let steepest = 0;
    for (let i = 1; i < path.length; i++) {
      const run = Math.hypot(path[i].x - path[i - 1].x, path[i].z - path[i - 1].z);
      if (run < 1e-6) continue;
      steepest = Math.max(steepest, Math.abs(path[i].y - path[i - 1].y) / run);
    }
    check(`ramp ${r} is never steeper than 12%`, steepest < 0.12,
      `steepest ${(steepest * 100).toFixed(1)}%`);

    /*
     * IT MUST NOT DESCEND WHILE IT IS STILL OVER THE DECK.
     *
     * This is the one that was actually wrong. The first version eased the
     * lateral move and the descent over the same window, so around forty
     * metres in the ramp surface was inside the main slab — a road that draws
     * correctly and is a wall when you reach it. Diverge first, then descend.
     */
    const deckEdge = V.deckWidth / 2;
    let worst = null;
    for (const q of path) {
      const lat = Math.abs((L.axis === "x" ? q.z : q.x) - L.across);
      if (lat >= deckEdge) continue;                 // clear of the deck
      const below = L.deckY - q.y;
      if (below > 0.05 && (worst === null || below > worst)) worst = below;
    }
    check(`ramp ${r} is clear of the deck before it drops`, worst === null,
      worst === null ? "never under it" : `${worst.toFixed(2)} m below the deck while still over it`);
  }
}

// ── THE PIERS ARE SOLID ─────────────────────────────────────────────────────
//
// They were not, and nothing said so. `enabled()` in the obstacle table was a
// POSITIONAL array indexed by KIND — five entries for six kinds — so every
// pier was written into the table, counted in the stats, and then skipped by
// the one line that decides what is solid. The structure drew, you could park
// under it, and you could drive straight through the columns.
{
  const city = createModularRoadCity({ params: { extent: 700 } });
  const full = viaductLayout({ P: { ...P, extent: 700 }, originCellX: 0, originCellZ: 0 });
  const pier = full.piers.find((q) => Math.abs(q.top - full.deckBottom) < 1e-6);
  const caps = city.obstacleCapsulesNear(pier.x, pier.z, 10);
  const fat = caps.filter((c) => c.radius > 1.0);
  check("a viaduct pier is a solid capsule", fat.length >= 1,
    `${fat.length} fat of ${caps.length} capsules at (${pier.x}, ${pier.z})`);
  check("and it reaches from the ground to the deck",
    fat.length > 0 && fat[0].a.y < 2 && fat[0].b.y > full.deckBottom - 2.5,
    fat.length ? `${fat[0].a.y.toFixed(1)} to ${fat[0].b.y.toFixed(1)} m` : "none");
  check("the obstacle table counts them", city.stats.obstacles.piers > 5,
    `${city.stats.obstacles.piers} piers`);
  city.dispose();
}

// ── THE TRIANGLE BUDGET ─────────────────────────────────────────────────────
//
// A 2.4 km road is not free, and unlike everything else in the city it goes
// into a BVH the chassis is sampled against every frame. Reported, and held to
// a ceiling that is a tripwire rather than a target: the numbers matter most
// when somebody later makes the section denser without noticing what it feeds.
{
  const full = viaductLayout({ P, originCellX: 0, originCellZ: 0 });
  const built = createCityViaduct({ layout: full });
  const st = built.stats;
  console.log(`       ${st.lengthM} m · deck ${st.deckTris} tris · rail ${st.railTris} drawn, `
    + `${st.railColTris} collided · ${st.piers} piers`);
  check("the deck's collision geometry stays under 20k triangles", st.deckTris < 20000,
    `${st.deckTris}`);
  // The whole point of the proxy: the barrier the chassis is sampled against
  // must be far cheaper than the barrier that is drawn.
  check("the guardrail collision proxy is cheaper than the visible rail",
    st.railColTris < st.railTris * 0.5, `${st.railColTris} vs ${st.railTris}`);
  built.dispose();
}

console.log(`\n${fail === 0 ? "ALL PASS" : `${fail} FAILURE(S)`}  (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
