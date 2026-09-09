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
const { viaductLayout } = await import("../games/modular-road-v3/modularRoadCityViaduct.js");
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
  const edge = V.deckWidth / 2 - V.parapetThickness;
  const off = L.laneAcross.map((a) => Math.abs(a - L.across));
  check("every deck lane is inside the parapets", Math.max(...off) < edge,
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
  check("the viaduct is two draws", meshes.length === 2, meshes.map((m) => m.name).join(", "));
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
  const deckY = viaductLayout({ P, originCellX: 0, originCellZ: 0 }).deckTop;
  const up = heights.filter((y) => y > deckY - 1).length;
  const down = heights.filter((y) => y < 3).length;
  check("some traffic is drawn ON the deck", up > 10, `${up} of ${heights.length} cars above ${deckY.toFixed(1)} m`);
  check("and the street traffic is still on the street", down > 10, `${down} at ground level`);
  check("nothing is drawn between the two", up + down === heights.length,
    `${heights.length - up - down} cars at neither height`);
  check("the deck carries piers worth reporting", cityViaduct.piers > 5 && cityViaduct.draws === 2,
    JSON.stringify(cityViaduct));
  city.dispose();
}

console.log(`\n${fail === 0 ? "ALL PASS" : `${fail} FAILURE(S)`}  (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
