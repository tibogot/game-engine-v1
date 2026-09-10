// ============================================================================
// THE UNDERPASS: is there actually a hole, and can you get into it?
//
// Three of its four pieces are borrowed and proven — the road is the same sweep
// the viaduct uses, the vault is the track's own tunnel, and both materials are
// already compiled. The fourth is new and is the only one that can fail
// quietly: A HOLE IN THE GROUND has to be cut in two completely separate
// places, and each one alone looks like a finished feature.
//
//   Cut the geometry and not the height function, and you drive across a
//   visible hole on invisible tarmac.
//   Cut the height function and not the geometry, and you fall through a road
//   that is still drawn under your wheels.
//
// So both are checked, against the same rectangles.
// ============================================================================
import { register } from "node:module";

register("./threeWebgpuHook.mjs", import.meta.url);
const THREE = await import("three/webgpu");
const { underpassLayout, createCityUnderpass, underpassOpenAt, underpassFootprint } =
  await import("../games/modular-road-v3/modularRoadCityUnderpass.js");
const { CITY_DEFAULTS, createModularRoadCity } =
  await import("../games/modular-road-v3/modularRoadCity.js");
const { roadParams } = await import("../games/modular-road-v3/modularRoadKit.js");

let pass = 0, fail = 0;
const check = (name, ok, extra = "") => {
  if (ok) { pass++; console.log(`PASS  ${name}${extra ? `  — ${extra}` : ""}`); }
  else { fail++; console.log(`FAIL  ${name}${extra ? `  — ${extra}` : ""}`); }
};

const P = CITY_DEFAULTS;
const pitch = (P.blockLots + P.streetLots) * P.lotSize;
const blockW = P.blockLots * P.lotSize;
const streetW = Math.max(P.streetLots * P.lotSize, 1);
const L = underpassLayout({ P, originCellX: 0, originCellZ: 0 });
check("a layout is produced", !!L, L ? `${L.axis} axis at ${L.across}` : "null");

// ── IT IS UNDER A STREET ────────────────────────────────────────────────────
{
  let f = ((L.across % pitch) + pitch) % pitch;
  check("the underpass runs under a street, not under a block",
    f >= blockW - 1e-6, `${f.toFixed(1)} into a ${blockW} m block + ${streetW} m street`);
  const U = L.params;
  // The trench, walls and lip all have to fit between the kerbs, or the hole
  // opens into the pavement and the buildings behind it.
  check("the whole trench fits inside the street",
    L.holeHalf <= streetW / 2, `${L.holeHalf.toFixed(2)} m vs ${(streetW / 2).toFixed(1)} m`);
  void U;
}

// ── THE ROOF DOES NOT BREAK THROUGH THE STREET ──────────────────────────────
//
// The vault's crown stands `tunnelHeight` above the road with about 0.4 m of
// shell on top, so if the road is not deep enough the tunnel's back comes up
// through the street it is running under — and from above that does not read as
// a bug, it reads as a concrete kerb nobody ordered.
{
  const U = L.params;
  const crown = L.roadY + U.tunnelHeight + 0.45;
  check("the vault stays below the street it runs under", crown < P.groundY - 0.3,
    `crown at ${crown.toFixed(2)} m, street at ${P.groundY}`);
}

// ── DRIVABLE ────────────────────────────────────────────────────────────────
{
  let steep = 0;
  for (let i = 1; i < L.path.length; i++) {
    const run = Math.hypot(L.path[i].x - L.path[i - 1].x, L.path[i].z - L.path[i - 1].z);
    if (run > 1e-6) steep = Math.max(steep, Math.abs(L.path[i].y - L.path[i - 1].y) / run);
  }
  check("never steeper than 8%", steep < 0.08, `steepest ${(steep * 100).toFixed(1)}%`);
  check("it starts and ends at street level",
    Math.abs(L.path[0].y - P.groundY) < 0.25
      && Math.abs(L.path[L.path.length - 1].y - P.groundY) < 0.25,
    `${L.path[0].y.toFixed(2)} and ${L.path[L.path.length - 1].y.toFixed(2)}`);
  let deepest = 0;
  for (const q of L.path) deepest = Math.max(deepest, P.groundY - q.y);
  check("and it actually goes underground", deepest > 4, `${deepest.toFixed(1)} m down`);
}

// ── THE HOLE IS ONLY WHERE THE TRENCH IS OPEN ───────────────────────────────
//
// The covered middle needs NO hole: the street plane is the tunnel's lid. A
// single rectangle over the whole run would open a slot down the middle of a
// street that is supposed to be intact — and you would see daylight from
// inside the tunnel.
{
  const open = underpassOpenAt(L);
  const at = (along) => (L.axis === "x" ? [along, L.across] : [L.across, along]);
  check("the covered middle is NOT cut", !open(...at((L.cov0 + L.cov1) / 2)));
  check("but the trenches are",
    open(...at((L.cov0 + L.a0) / 2 + L.params.rampLength * 0.2))
      || open(...at(L.cov0 - 20)),
    "open near the portal");
  check("and the street beyond the run is untouched",
    !open(...at(L.a0 - 60)) && !open(...at(L.a1 + 60)));
  // Off to the side of the trench there must still be street, or the hole is
  // wider than the road and eats the pavement.
  const side = L.axis === "x"
    ? [L.cov0 - 20, L.across + L.holeHalf + 2] : [L.across + L.holeHalf + 2, L.cov0 - 20];
  check("the pavement beside the trench is still street", !open(...side));
}

// ── BOTH CUTS AGREE ─────────────────────────────────────────────────────────
//
// This is the one that matters. The geometry hole and the height function have
// to describe the SAME rectangles — each alone is a finished-looking feature
// and a broken one.
{
  const city = createModularRoadCity({ params: { extent: 700 } });
  const full = underpassLayout({ P: { ...P, extent: 700 }, originCellX: 0, originCellZ: 0 });
  check("the city built one", !!city.stats.underpass, JSON.stringify(city.stats.underpass));

  const at = (along) => (full.axis === "x" ? [along, full.across] : [full.across, along]);
  const mid = (full.cov0 + full.a0) / 2;
  check("there is NO ground over the open trench",
    !isFinite(city.streetHeightAt(...at(mid))),
    `streetHeightAt returned ${city.streetHeightAt(...at(mid))}`);
  check("there IS ground over the covered part",
    isFinite(city.streetHeightAt(...at((full.cov0 + full.cov1) / 2))),
    "the street plane is the tunnel's lid");
  check("and ground everywhere else",
    isFinite(city.streetHeightAt(...at(full.a0 - 80))));

  /*
   * AND THE PLANE ITSELF HAS THE HOLE IN IT. Cut in geometry rather than
   * discarded per pixel — the ground is the largest surface in the game and an
   * alpha test on it costs early-Z everywhere, to save nothing.
   */
  let plane = null;
  city.group.traverse((o) => { if (o.name === "CityStreets") plane = o; });
  check("the street plane exists", !!plane);
  const tris = plane.geometry.index
    ? plane.geometry.index.count / 3 : plane.geometry.attributes.position.count / 3;
  check("the ground plane was cut, not discarded", tris > 2 && tris < 200,
    `${tris} triangles (two means no hole; hundreds means a grid)`);

  // No triangle may cover the middle of an open trench.
  const pos = plane.geometry.getAttribute("position");
  const ix = plane.geometry.index;
  const px = plane.position.x, pz = plane.position.z;
  const hole = full.openRects[0];
  const hx = (hole.minX + hole.maxX) / 2, hz = (hole.minZ + hole.maxZ) / 2;
  let covering = 0;
  for (let t = 0; t < ix.count; t += 3) {
    const xs = [], zs = [];
    for (let k = 0; k < 3; k++) {
      const v = ix.getX(t + k);
      xs.push(pos.getX(v) + px);
      zs.push(pos.getZ(v) + pz);
    }
    if (hx >= Math.min(...xs) && hx <= Math.max(...xs)
      && hz >= Math.min(...zs) && hz <= Math.max(...zs)) covering++;
  }
  check("no ground triangle spans the open trench", covering === 0,
    `${covering} triangles over the hole`);
  city.dispose();
}

// ── IT IS SOMETHING YOU CAN DRIVE ON ────────────────────────────────────────
{
  const built = createCityUnderpass({ layout: L });
  const col = built.collisionMeshes();
  check("the road is handed over as a drive surface", col.deck.length === 1,
    col.deck.map((m) => m.name).join(", "));
  check("and the walls and the vault as solids", col.solids.length === 2,
    col.solids.map((m) => m.name).join(", "));
  for (const m of [...col.deck, ...col.solids]) {
    check(`${m.name} is bakeable`, !!m.geometry && !!m.matrixWorld);
  }
  /*
   * THE WALLS ARE WHAT KEEP YOU IN THE TRENCH, and they are a BOX rather than a
   * sheet on purpose: the chassis is sampled against triangles, and a
   * single-sided plane is something a fast car finds its way through.
   */
  const walls = col.solids.find((m) => m.name === "CityUnderpassWalls");
  check("the trench has walls at all", !!walls);
  const st = built.stats;
  console.log(`       ${st.lengthM} m, ${st.coveredM} covered, ${st.depthM} m down · `
    + `road ${st.roadTris} · vault ${st.vaultTris} · walls ${st.wallTris} · ${st.draws} draws`);
  check("four draws for the whole thing", st.draws === 4, `${st.draws}`);
  check("and it stays under 20k triangles",
    st.roadTris + st.vaultTris + st.wallTris < 20000,
    `${st.roadTris + st.vaultTris + st.wallTris}`);
  built.dispose();
}

// ── NOTHING STANDS ON THE HOLE ──────────────────────────────────────────────
{
  const city = createModularRoadCity({ params: { extent: 700 } });
  const full = underpassLayout({ P: { ...P, extent: 700 }, originCellX: 0, originCellZ: 0 });
  const foot = underpassFootprint(full, 0);
  let onIt = 0;
  for (const c of city.obstacleCapsulesNear(full.across, (full.a0 + full.a1) / 2, 220)) {
    const x = (c.a.x + c.b.x) / 2, z = (c.a.z + c.b.z) / 2;
    // Only things standing at street level matter — the underpass's own walls
    // are not in this table.
    if (c.a.y > P.groundY + 3) continue;
    if (foot(x, z)) onIt++;
  }
  check("no street furniture stands over the underpass", onIt === 0,
    `${onIt} capsules on it`);
  city.dispose();
}

console.log(`\n${fail === 0 ? "ALL PASS" : `${fail} FAILURE(S)`}  (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
