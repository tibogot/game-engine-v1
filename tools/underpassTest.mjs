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
const { underpassLayout, createCityUnderpass, underpassOpenAt, underpassFootprint, underpassDip } =
  await import("../games/modular-road-v3/modularRoadCityUnderpass.js");
const { CITY_DEFAULTS, createModularRoadCity } =
  await import("../games/modular-road-v3/modularRoadCity.js");
const { roadParams, vaultProfiles, buildProfile, pieceParams } =
  await import("../games/modular-road-v3/modularRoadKit.js");

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
  /*
   * AND NO GROUND OVER THE COVERED PART EITHER — which is the assertion this
   * test had exactly backwards, and it cost three attempts at the wrong bug.
   *
   * The reasoning for the old version was reasonable and wrong: the street over
   * the tunnel is real, you drive on it, so the height function should report
   * it. But a height FUNCTION has no notion of above or below. Reporting street
   * level there means reporting it to the car six metres underneath as well,
   * and that car's suspension spends every frame trying to climb to it.
   * MEASURED: into the portal at 12 m/s, out of it at 12 m/s straight UP.
   *
   * The street above is held up by a mesh instead (`CityUnderpassLid`), because
   * a mesh is directional and a height function is not.
   */
  check("and NO ground over the covered part either",
    !isFinite(city.streetHeightAt(...at((full.cov0 + full.cov1) / 2))),
    `streetHeightAt returned ${city.streetHeightAt(...at((full.cov0 + full.cov1) / 2))}`);
  // Beside the corridor the street is untouched, roof or no roof — the hole is
  // as wide as the trench and not a metre wider.
  const beside = full.axis === "x"
    ? [(full.cov0 + full.cov1) / 2, full.across + full.holeHalf + 3]
    : [full.across + full.holeHalf + 3, (full.cov0 + full.cov1) / 2];
  check("but the street beside the roof is untouched",
    isFinite(city.streetHeightAt(...beside)));
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
  check("the road is handed over as a drive surface",
    col.deck.some((m) => m.name === "CityUnderpassRoad"),
    col.deck.map((m) => m.name).join(", "));

  /*
   * ── AND THE LID WITH IT ────────────────────────────────────────────────────
   *
   * The street over the roofed section, as geometry, because the height
   * function had to be switched off there. Three things have to hold at once or
   * it trades one bug for another: it must be in the DECK channel (a solid
   * would be a wall the chassis fights from inside the tunnel), it must be
   * invisible (the street plane is already drawn there), and it must sit at
   * street level, not at the roof.
   */
  /*
   * THE LIP IS GROUND. The street is cut at the lip's outer edge, so the strip
   * between the last solid street and the wall is the lip plate — and the
   * parapet mesh is a SOLID, which only the chassis is pushed out of. Wheels
   * find ground with a downward ray through the DECK channel, and nothing was
   * there over the lip: a wheel that hung past the edge found the tunnel road
   * seven metres down and the car tipped in. So the lip quads are also a deck,
   * and every one of them must face UP or a wheel ray passes straight through.
   */
  {
    const lipDeck = col.deck.find((m) => m.name === "CityUnderpassLipDeck");
    check("the parapet lip is a deck, so a wheel over it has ground", !!lipDeck,
      col.deck.map((m) => m.name).join(", "));
    if (lipDeck) {
      const g = lipDeck.geometry, pos = g.attributes.position, idx = g.index;
      let down = 0, tris = 0, atStreet = 0;
      const v = (i, k) => pos.getComponent(idx.getX(i), k);
      for (let t2 = 0; t2 + 2 < idx.count; t2 += 3) {
        const ux = v(t2 + 1, 0) - v(t2, 0), uy = v(t2 + 1, 1) - v(t2, 1), uz = v(t2 + 1, 2) - v(t2, 2);
        const vx = v(t2 + 2, 0) - v(t2, 0), vy = v(t2 + 2, 1) - v(t2, 1), vz = v(t2 + 2, 2) - v(t2, 2);
        const ny = uz * vx - ux * vz;
        tris++;
        if (ny < 0) down++;
        if (Math.abs(v(t2, 1) - L.top) < 1e-3) atStreet++;
      }
      check("...every lip triangle faces up", tris > 0 && down === 0, `${down} of ${tris} face down`);
      check("...and lies at street level", atStreet === tris, `${atStreet} of ${tris} at top=${L.top}`);
    }
  }
  /*
   * ANYTHING PAINTED WITH THE WALL MATERIAL MUST CARRY ITS SHADE.
   *
   * `wallMaterial` multiplies the concrete by `vertexColor().rgb.r`. The trench
   * wall packs a shade into the red channel of a `color` attribute; a geometry
   * that shares the material without that attribute reads ZERO and renders
   * black. That is how the deck end wall shipped invisible — the collider was
   * right and the paint was gone, and a black wall on a dark deck edge is
   * indistinguishable from no wall at all. Reported from the game as "an
   * invisible mesh blocks the car"; a day of collider-hunting could not see it
   * because it was not a collision bug.
   */
  {
    const walls = col.solids.find((m) => m.name === "CityUnderpassWalls");
    const sharing = [...col.solids, ...col.deck].filter((m) => walls && m.material === walls.material);
    const bare = sharing.filter((m) => !m.geometry.attributes.color);
    check("every mesh sharing the wall material carries a color (shade) attribute",
      sharing.length >= 2 && bare.length === 0,
      `${sharing.map((m) => m.name).join(", ")}${bare.length ? " — NO shade: " + bare.map((m) => m.name).join(", ") : ""}`);
    const ew = sharing.find((m) => m.name === "CityUnderpassDeckEndWalls");
    if (ew) {
      const c = ew.geometry.attributes.color;
      let minR = 1e9;
      for (let i = 0; i < c.count; i++) minR = Math.min(minR, c.getX(i));
      check("...and the end walls' shade is not zero (black)", minR > 0.5, `min red ${minR}`);
    }
  }
  const lid = col.deck.find((m) => m.name === "CityUnderpassLid");
  check("and the lid that replaces the street's height function", !!lid);
  if (lid) {
    check("the lid is collision, not scenery", lid.visible === false);
    const lp = lid.geometry.attributes.position;
    let lo = Infinity, hi = -Infinity;
    for (let v = 0; v < lp.count; v++) { lo = Math.min(lo, lp.getY(v)); hi = Math.max(hi, lp.getY(v)); }
    check("the lid lies at street level", Math.abs(lo - L.top) < 1e-6 && Math.abs(hi - L.top) < 1e-6,
      `y ${lo.toFixed(2)}..${hi.toFixed(2)} vs street ${L.top}`);
    // It must span the roof exactly: short, and there is a gap with no surface
    // at all; long, and it roofs over the open trench the player falls into.
    const along = (v) => (L.axis === "x" ? lp.getX(v) : lp.getZ(v));
    let aLo = Infinity, aHi = -Infinity;
    for (let v = 0; v < lp.count; v++) { aLo = Math.min(aLo, along(v)); aHi = Math.max(aHi, along(v)); }
    check("and spans the roofed section exactly",
      Math.abs(aLo - L.cov0) < 1e-6 && Math.abs(aHi - L.cov1) < 1e-6,
      `${aLo.toFixed(1)}..${aHi.toFixed(1)} vs portals ${L.cov0}..${L.cov1}`);
  }
  // The vault's shell is solid again: it was switched off while the entry
  // launch was being hunted (removing it halved the launch, which was true and
  // a red herring — the heightfield was pressing the car into it), and without
  // it the tunnel wall is a curtain you drive through into the earth.
  /*
   * THREE SOLIDS, and the third is the one that was missing for a long time.
   *
   * The lid over the covered section is a drivable deck the FULL width of the
   * trench, and at the portal it just stops. The only thing guarding that edge
   * was the parapet's own end cap — about 1.2 m of pentagon against a ~16 m
   * opening. It was reported from the game as "an invisible wall": head-on, a
   * wall seen end-on is a few pixels, and everywhere else across the deck
   * there was nothing to hit at all.
   */
  check("and the walls, the vault and the deck end walls as solids", col.solids.length === 3,
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
  /*
   * SEVEN: road, vault, glow, walls, portal signs, and a light shaft at each
   * mouth.
   *
   * The number is asserted rather than merely printed because everything here
   * is deliberately merged into as few meshes as it can be — the gutter, the
   * risers, the headwalls and the mouth barriers all live in the WALL mesh
   * precisely so they cost nothing extra. An eighth draw means something was
   * built as its own mesh that should have been written into an existing one.
   *
   * The two shafts are the one place that rule is knowingly broken: each needs
   * its own portal plane in its uniforms, and a single hull covering both would
   * span the whole 374 m tunnel and shade a fortune in fragments that can never
   * be lit. They are frustum-culled and 34 m deep, so in practice you are
   * inside at most one of them at a time.
   */
  /*
   * EIGHT: road, vault, glow, walls, portal signs, and the fit-out's three —
   * steel, emergency niches, overhead boards. The two light shafts are OFF
   * (see `shafts` in the underpass defaults); switching them on makes it ten.
   *
   * Asserted rather than printed because everything here is deliberately merged
   * into as few meshes as it can be. The gutter, risers, headwalls and mouth
   * barriers all live in the WALL mesh; the fans, trays, hangers and niche
   * bodies are ONE merged steel mesh however many of them there are. An
   * eleventh draw means something was built as its own mesh that should have
   * been merged into an existing one.
   *
   */
  check("eight draws for the whole thing", st.draws === 8, `${st.draws}`);
  check("and it stays under 20k triangles",
    st.roadTris + st.vaultTris + st.wallTris < 20000,
    `${st.roadTris + st.vaultTris + st.wallTris}`);
  built.dispose();
}

// ── THE TRENCH IS INSIDE ONE BLOCK ──────────────────────────────────────────
//
// This is the bug that made the whole thing unplayable, and it looked like a
// respawn glitch rather than a layout mistake. The open trench was 135 m
// starting mid-block against a 170 m pitch, so it reached straight across the
// next junction — and driving along THAT cross street dropped the car six
// metres into a road it could not see, past the fall threshold, back to the
// start. The hole was correct. The geometry was correct. The place was not.
{
  const U = L.params;
  check("the ramp fits inside a block", U.rampLength <= L.blockSpan,
    `${U.rampLength} m ramp in a ${L.blockSpan} m block`);
  for (const r of L.openRects) {
    const lo = L.axis === "x" ? r.minX : r.minZ;
    const hi = L.axis === "x" ? r.maxX : r.maxZ;
    // Every metre of an open trench must be in the SAME block: a junction
    // between its ends is a street with a hole across it.
    const b0 = Math.floor(lo / pitch), b1 = Math.floor(hi / pitch);
    const f0 = ((lo % pitch) + pitch) % pitch, f1 = ((hi % pitch) + pitch) % pitch;
    check("an open trench never reaches a junction",
      b0 === b1 && f0 < blockW + 1e-6 && f1 < blockW + 1e-6,
      `${lo.toFixed(0)}..${hi.toFixed(0)} sits ${f0.toFixed(0)}..${f1.toFixed(0)} into a ${blockW} m block`);
  }
  // And the roof has to cover every junction between the portals, which is the
  // same statement from the other side.
  const first = Math.ceil((L.cov0 - blockW) / pitch);
  let uncovered = 0;
  for (let j = first; j * pitch + blockW < L.a1; j++) {
    const jStart = j * pitch + blockW, jEnd = (j + 1) * pitch;
    if (jEnd < L.a0 || jStart > L.a1) continue;
    if (jStart < L.cov0 - 1e-6 || jEnd > L.cov1 + 1e-6) uncovered++;
  }
  check("every junction the road passes under is roofed", uncovered === 0,
    `${uncovered} junctions over open trench`);
}

// ── YOU CANNOT FALL IN FROM THE SIDE ────────────────────────────────────────
//
// The trench is 18 m of missing street in a 34 m road, so there IS still street
// either side of the hole — and nothing to stop a car that drifts across from
// dropping into a road it cannot see. The parapet is part of the wall mesh,
// which is already a solid, so it costs no draw and no new collision.
{
  const built = createCityUnderpass({ layout: L });
  let walls = null;
  built.group.traverse((o) => { if (o.name === "CityUnderpassWalls") walls = o; });
  const pos = walls.geometry.getAttribute("position");
  let above = 0, aboveCovered = 0, atMouth = 0;
  for (let i = 0; i < pos.count; i++) {
    if (pos.getY(i) < P.groundY + 0.3) continue;
    above++;
    const along = L.axis === "x" ? pos.getX(i) : pos.getZ(i);
    if (along <= L.cov0 + 1e-6 || along >= L.cov1 - 1e-6) continue;
    /*
     * EXCEPT RIGHT AT THE MOUTH, where there SHOULD be a wall above street
     * level over the roof: the parapet turns the corner and runs across the
     * top of the arch. Without it the street over the tunnel ended at a bare
     * edge above a six-metre drop, which nothing real is built like — and
     * which nothing stopped a car from driving over, since only the two side
     * walls were solid.
     *
     * It is a metre deep at most, so anything further in is the old bug: a
     * barrier down the middle of a street with nothing wrong with it.
     */
    if (along < L.cov0 + 1 || along > L.cov1 - 1) { atMouth++; continue; }
    aboveCovered++;
  }
  check("there is a parapet above street level", above > 0, `${above} vertices`);
  check("and it turns the corner across the mouth", atMouth > 0,
    `${atMouth} vertices over the roof at the portals`);
  check("but none over the covered section", aboveCovered === 0,
    `${aboveCovered} parapet vertices over the roof`);
  built.dispose();
}

// ── NO KERBS WHERE IT IS STILL A STREET ─────────────────────────────────────
//
// The road is swept with the game's kerbed section, which is right in the
// trench and wrong at the two ends, where it is at grade and simply IS the
// street. A pair of red-and-white kerbs running across an ordinary road is the
// give-away — and like the viaduct's gore, the shape and the PAINT stop by two
// different mechanisms, so both are checked.
{
  const built = createCityUnderpass({ layout: L });
  const road = built.collisionMeshes().deck[0];
  const g = road.geometry;
  const pos = g.getAttribute("position");
  const zone = g.getAttribute("aZone");
  check("the road carries a zone attribute", !!zone);
  let atGrade = 0, deep = 0;
  for (let i = 0; i < pos.count; i++) {
    if (zone.getX(i) < 1.5) continue;                  // not kerb-painted
    const y = pos.getY(i);
    if (y > P.groundY - 0.6) atGrade++;
    if (y < P.groundY - 3) deep++;
  }
  check("no kerb paint where the road is at street level", atGrade === 0,
    `${atGrade} kerb-zoned vertices at grade`);
  check("but kerbs down in the trench", deep > 0, `${deep} kerb-zoned vertices below -3 m`);
  built.dispose();
}

// ── THE VAULT IS THE WALL UNDER THE ROOF ────────────────────────────────────
//
// The trench walls used to be built along the WHOLE run, which was wrong three
// ways at once. Their inner face landed a centimetre from the vault's own wall
// (`_vaultInnerProfile` springs from hw + 0.34), so the chassis got two
// conflicting pushes in a frame and the car was thrown into the air. Their lip
// ran at street level over a section that still HAS a street, so two coplanar
// surfaces fought over the same pixels — a strip of "floating road" over the
// tunnel. And it was several hundred metres of geometry doing what the tunnel
// around it was already doing.
{
  const built = createCityUnderpass({ layout: L });
  let walls = null;
  built.group.traverse((o) => { if (o.name === "CityUnderpassWalls") walls = o; });
  const pos = walls.geometry.getAttribute("position");
  /*
   * WHAT IS FORBIDDEN IS A WALL THAT CLIMBS, not any vertex at all.
   *
   * Two things under the roof are deliberate and must not trip this:
   *
   *   · the GUTTER, which floors the 34 cm between the road edge (7.50) and
   *     the wall line (7.84) for the whole run — the slot you could see the
   *     sky through — and which lies flat ON the road, going nowhere near the
   *     vault's wall face;
   *   · the wall across the MOUTH, which stands on the roof but only within
   *     half a metre of the portal.
   *
   * The bug was a wall rising from the road to street level whose inner face
   * sat a centimetre from the vault's. So: anything under the roof that has
   * climbed off the road, away from the portals.
   */
  let underRoof = 0;
  for (let i = 0; i < pos.count; i++) {
    const along = L.axis === "x" ? pos.getX(i) : pos.getZ(i);
    if (along <= L.cov0 + 2 || along >= L.cov1 - 2) continue;
    if (pos.getY(i) < L.roadY + 0.5) continue;      // flat on the road: the gutter
    underRoof++;
  }
  check("no trench wall inside the covered section", underRoof === 0,
    `${underRoof} wall vertices under the roof`);

  // And where they DO exist, their inner face has to line up with the vault's,
  // or the two meet at the portal with a step between them.
  const U = L.params;
  check("the trench wall continues the vault's line exactly",
    Math.abs(U.roadWidth / 2 + U.wallGap - (U.roadWidth / 2 + 0.34)) < 1e-9,
    `wallGap ${U.wallGap} vs the vault's 0.34`);
  built.dispose();
}

/*
 * ── WHICH CARS BELONG TO THE TUNNEL ────────────────────────────────────────
 *
 * Standing inside the tunnel's carriageway is NOT the same as driving down it,
 * and getting that wrong makes the tests below accuse the traffic model of a
 * bug it does not have. Every junction over the tunnel is roofed, so the cross
 * street runs across the carriageway at street level several times along the
 * run — perfectly correct, and indistinguishable from "a car standing on the
 * roof" if you only look at where it is. MEASURED while writing this: 219
 * cars flagged, 219 of them cross traffic, 0 of them travelling down the
 * tunnel.
 *
 * So the discriminator is the HEADING. The instance matrix's third column is
 * the model's nose after the yaw, so a car on the tunnel's axis has its
 * forward vector along that axis and a car crossing it does not.
 */
const headingAlong = (e, o, axis) => {
  const fx = e[o + 8], fz = e[o + 10];
  return axis === "x" ? Math.abs(fx) > Math.abs(fz) : Math.abs(fz) > Math.abs(fx);
};

// ── THE STREET'S TRAFFIC GOES DOWN THE TUNNEL ───────────────────────────────
//
// A traffic lane is an infinite straight line with one constant height, and it
// knew nothing about the underpass: the two inner lanes of the street it runs
// under passed directly over the open trench, six metres up, on a road that is
// not there.
//
// Hiding them over the hole was the first answer, and it looked like what it
// was — cars winking out at the portal and back in at the far end. So the lanes
// DIVE now, and this checks the thing that actually matters: not that nothing
// is over the hole, but that what is over the hole is IN it.
{
  const city = createModularRoadCity({ params: { extent: 700 } });
  const full = underpassLayout({ P: { ...P, extent: 700 }, originCellX: 0, originCellZ: 0 });
  const open = underpassOpenAt(full);
  const dip = underpassDip(full);
  const alongOf = (x, z) => (full.axis === "x" ? x : z);

  // Two camera stops: one at the open trench, one in the middle of the roofed
  // section. The second is the one that would have caught the launch bug — the
  // covered part is where a lane with no height is most obviously wrong and
  // least obviously visible.
  const stops = [
    (full.a0 + full.cov0) / 2,
    (full.cov0 + full.cov1) / 2,
  ];
  let drawn = 0, wrongHeight = 0, inTunnel = 0, worst = 0;
  for (const a of stops) {
    const cam = { position: new THREE.Vector3(
      full.axis === "x" ? a : full.across, 3, full.axis === "x" ? full.across : a) };
    for (let i = 0; i < 8; i++) { cam.position.y += 0.01; city.update(0.4, cam); }
    city.group.traverse((o) => {
      if (!o.isInstancedMesh || !/^CityTraffic_/.test(o.name)) return;
      const e = o.instanceMatrix.array;
      for (let i = 0; i < o.count; i++) {
        const x = e[i * 16 + 12], y = e[i * 16 + 13], z = e[i * 16 + 14];
        drawn++;
        if (y > 3) continue;                      // the viaduct, nowhere near this
        const acr = full.axis === "x" ? z : x;
        if (Math.abs(acr - full.across) > dip.half || !headingAlong(e, i * 16, full.axis)) {
          // Not driving down the tunnel: it must not be over the hole at all.
          // Cross traffic is exempt — it crosses on the roof, which is street.
          if (open(x, z) && !headingAlong(e, i * 16, full.axis)) continue;
          if (open(x, z)) wrongHeight++;
          continue;
        }
        // In it: its height has to be the ROAD's height where it stands, not
        // the street's. This is the assertion the hidden-car version could not
        // make, because a car that is not drawn has no height to be wrong.
        const want = dip.yAt(alongOf(x, z));
        const err = Math.abs(y - want);
        if (err > worst) worst = err;
        if (err > 0.6) wrongHeight++;
        if (full.top - want > 1) inTunnel++;
      }
    });
  }
  check("there is traffic near the trench to check", drawn > 20, `${drawn} cars drawn`);
  check("and some of it is actually down in the tunnel", inTunnel > 0,
    `${inTunnel} cars below street level`);
  check("every car in the tunnel's lanes rides the tunnel's road", wrongHeight === 0,
    `${wrongHeight} of ${drawn} off the road, worst ${worst.toFixed(2)} m`);
  city.dispose();
}

// ── AND NOBODY TURNS INTO IT ────────────────────────────────────────────────
//
// Every junction over the tunnel is roofed, so a car on the cross street sits
// directly above a lane that is six metres down. Without a guard it would turn
// into that lane and drop through the roof of its own city.
{
  const full = underpassLayout({ P: { ...P, extent: 700 }, originCellX: 0, originCellZ: 0 });
  const dip = underpassDip(full);
  const city = createModularRoadCity({ params: { extent: 700 } });
  const alongOf = (x, z) => (full.axis === "x" ? x : z);
  const cam = { position: new THREE.Vector3(
    full.axis === "x" ? (full.cov0 + full.cov1) / 2 : full.across, 3,
    full.axis === "x" ? full.across : (full.cov0 + full.cov1) / 2) };
  let stranded = 0, seen = 0;
  // Long enough for turns to be attempted at every junction in view.
  for (let i = 0; i < 400; i++) {
    cam.position.y += 0.001;
    city.update(i * 0.25, cam);
    city.group.traverse((o) => {
      if (!o.isInstancedMesh || !/^CityTraffic_/.test(o.name)) return;
      const e = o.instanceMatrix.array;
      for (let j = 0; j < o.count; j++) {
        const x = e[j * 16 + 12], y = e[j * 16 + 13], z = e[j * 16 + 14];
        if (y > 3) continue;
        const acr = full.axis === "x" ? z : x;
        if (Math.abs(acr - full.across) > dip.half) continue;
        if (!headingAlong(e, j * 16, full.axis)) continue;   // crossing, not driving it
        seen++;
        // Inside the carriageway, at street height, where the road is deep:
        // that is a car that turned in and is standing on the roof.
        const want = dip.yAt(alongOf(x, z));
        if (full.top - want > 1 && Math.abs(y - full.top) < 0.5) stranded++;
      }
    });
  }
  check("cars were watched over the roofed section", seen > 50, `${seen} samples`);
  check("none of them is standing on the tunnel roof", stranded === 0,
    `${stranded} of ${seen} at street level over a deep road`);
  city.dispose();
}

// ── EVERY STEP HAS A FACE ON IT ────────────────────────────────────────────
//
// From the mouth to `wIn` the street is cut at the ROAD's edge, because there
// is no wall yet to fill anything wider — and the road is already descending.
// So the street's cut edge and the road below are separated by a step of up to
// thirty centimetres, and nothing was on its vertical face. The street plane is
// single-sided, so from a low camera you looked in through that slot, under the
// street, and out at the world: two bright wedges down either side of the ramp,
// widening exactly as the road dropped away.
//
// A NOTE ON HOW THIS WAS FOUND, because it matters for the next one. The ground
// under the city is the terrain CLIPMAP — a displaced grid whose hole is cut in
// the SHADER. Ray-casting the scene therefore reports a solid surface where
// nothing is drawn, and every geometric probe called this closed. What found it
// was painting the renderer's background magenta with the sky still drawn, so
// magenta means "nothing was rendered here", and counting the pixels: 12 left
// after the wedges were closed, both at the corner where the riser hands over
// to the wall. Trust the framebuffer over the geometry for anything you can
// SEE through.
{
  const built = createCityUnderpass({ layout: L });
  let walls = null;
  built.group.traverse((o) => { if (o.name === "CityUnderpassWalls") walls = o; });
  const pos = walls.geometry.attributes.position;
  const half = L.params.roadWidth / 2;
  const inner = half + L.params.wallGap;
  const alongOf = (i) => (L.axis === "x" ? pos.getX(i) : pos.getZ(i));
  const acrossOf = (i) => (L.axis === "x" ? pos.getZ(i) : pos.getX(i)) - L.across;

  // The riser: vertices at the ROAD's edge, at street level, over the stretch
  // where the hole is still road-wide. Without it there is no face on the step.
  let riserTop = 0, riserFoot = 0;
  for (let i = 0; i < pos.count; i++) {
    const a = alongOf(i);
    if (a > L.wIn + 1e-6 && a < L.wOut - 1e-6) continue;
    if (Math.abs(Math.abs(acrossOf(i)) - half) > 1e-3) continue;
    if (Math.abs(pos.getY(i) - L.top) < 1e-3) riserTop++;
    else riserFoot++;
  }
  check("the mouth step has a face at street level", riserTop > 4,
    `${riserTop} vertices at the road edge, street height`);
  check("...and a foot on the road", riserFoot > 4,
    `${riserFoot} at the road edge, road height`);

  /*
   * AND THE CORNER WHERE IT HANDS OVER. The hole widens from the road edge to
   * the wall line at one station; on the mouth side the street covers that
   * 34 cm strip and on the tunnel side the gutter does, thirty centimetres
   * lower. That transverse step needs a face too — it was the last twelve
   * pixels of sky.
   */
  let capVerts = 0;
  for (let i = 0; i < pos.count; i++) {
    const a = alongOf(i);
    if (Math.abs(a - L.wIn) > 0.6 && Math.abs(a - L.wOut) > 0.6) continue;
    const acr = Math.abs(acrossOf(i));
    if (acr < half - 1e-3 || acr > inner + 1e-3) continue;
    if (Math.abs(pos.getY(i) - L.top) < 1e-3) capVerts++;
  }
  check("and the corner where it hands over to the wall is capped", capVerts >= 4,
    `${capVerts} cap vertices across the gutter strip`);
  built.dispose();
}

// ── AND NO SLOT BETWEEN THE ROAD AND THE WALL ──────────────────────────────
//
// The road is swept `roadWidth` wide, so its edge is at 7.50 m. The wall's
// inner face is at `roadWidth / 2 + wallGap` = 7.84, because that is where the
// VAULT springs from and the two have to be one continuous surface through the
// portal. Neither is wrong, and between them was a 34 cm slot running the whole
// length of the trench with nothing under it — you looked down it and out at
// the sky.
//
// So it is floored, like the drainage channel a real cut has at the foot of its
// retaining wall. Fire straight down the middle of that band and demand a floor
// — in the open trench AND under the roof, because the gap is the same in both
// and only the vault's skirt was ever hiding the second one.
{
  const built = createCityUnderpass({ layout: L });
  let walls = null;
  built.group.traverse((o) => { if (o.name === "CityUnderpassWalls") walls = o; });
  /*
   * The wall is NON-INDEXED — it is split so its corners shade flat, which a
   * concrete box needs — so walk triangles by vertex, not by index. `tri`
   * copes with either, because the vault beside it is still indexed.
   */
  const pos = walls.geometry.attributes.position, idx = walls.geometry.index;
  const triCount = (idx ? idx.count : pos.count) / 3;
  const vi = (t, k) => (idx ? idx.getX(t * 3 + k) : t * 3 + k);
  // Front faces only. A floor that is wound downwards is not drawn from above,
  // which is exactly as open as no floor at all.
  const floorUnder = (ox, oy, oz) => {
    const dx = 0, dy = -1, dz = 0;
    let best = Infinity;
    for (let t = 0; t < triCount; t++) {
      const i0 = vi(t, 0), i1 = vi(t, 1), i2 = vi(t, 2);
      const Ax = pos.getX(i0), Ay = pos.getY(i0), Az = pos.getZ(i0);
      const e1x = pos.getX(i1) - Ax, e1y = pos.getY(i1) - Ay, e1z = pos.getZ(i1) - Az;
      const e2x = pos.getX(i2) - Ax, e2y = pos.getY(i2) - Ay, e2z = pos.getZ(i2) - Az;
      const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
      const det = e1x * px + e1y * py + e1z * pz;
      if (det < 1e-10) continue;
      const inv = 1 / det;
      const tx = ox - Ax, ty = oy - Ay, tz = oz - Az;
      const u = (tx * px + ty * py + tz * pz) * inv;
      if (u < 0 || u > 1) continue;
      const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
      const v = (dx * qx + dy * qy + dz * qz) * inv;
      if (v < 0 || u + v > 1) continue;
      const tt = (e2x * qx + e2y * qy + e2z * qz) * inv;
      if (tt > 0.001 && tt < best) best = tt;
    }
    return best;
  };

  const half = L.params.roadWidth / 2;
  const wallFace = half + L.params.wallGap;
  const yAlong = (a) => {
    // The road's own height at this station, from the layout's path.
    let best = null, bd = Infinity;
    for (const q of L.path) {
      const qa = L.axis === "x" ? q.x : q.z;
      if (Math.abs(qa - a) < bd) { bd = Math.abs(qa - a); best = q; }
    }
    return best.y;
  };

  let open = 0, tested = 0, firstOpen = null;
  const spots = [
    ["the open trench", (L.cov0 + Math.max(L.a0, L.cov0 - 60)) / 2],
    ["just inside the portal", L.cov0 + 20],
    ["the middle of the tunnel", (L.cov0 + L.cov1) / 2],
    ["the far trench", L.cov1 + 20],
  ];
  for (const [, a] of spots) {
    const y = yAlong(a);
    if (L.top - y < 0.4) continue;                 // still at grade: no slot yet
    for (let f = 0.1; f <= 0.9; f += 0.1) {
      const lat = half + (wallFace - half) * f;
      for (const s of [-1, 1]) {
        tested++;
        const ox = L.axis === "x" ? a : L.across + s * lat;
        const oz = L.axis === "x" ? L.across + s * lat : a;
        if (floorUnder(ox, y + 0.4, oz) > 0.9) {
          open++;
          if (!firstOpen) firstOpen = `${(s * lat).toFixed(2)} m across at ${a.toFixed(0)}`;
        }
      }
    }
  }
  check("the gutter band was sampled", tested > 40, `${tested} probes`);
  check("there is a floor the whole way between road and wall", open === 0,
    `${open} of ${tested} open to the void${firstOpen ? `, first at ${firstOpen}` : ""}`);
  built.dispose();
}

// ── THE BORE STARTS AT THE MOUTH, NOT BEHIND IT ────────────────────────────
//
// `buildVaultTunnel` normally sets the inner surface BACK from the mouth by
// `_VAULT_PORTAL`, so the slanted ring between the two shells reads as a
// three-dimensional reveal instead of a paper cutout. That is right for a
// free-standing tunnel and wrong here, because the headwall already forms the
// portal face: the reveal left a 72 cm RECESS behind it, a ring of nothing
// between the wall and the start of the bore.
//
// The headwall is single-sided — it faces the trench — so from INSIDE the
// tunnel a grazing sight line went through its back face, into the void above
// the vault, and out at the sky. MEASURED from a camera in the tunnel by
// counting rendered background pixels: 246 of them crossing the portal plane
// at y = -1.05, across +/-3.3 — just outside the arch, just under its crown.
// After turning the reveal off: 4, all within 3.3% of the arch's own outline,
// which is its anti-aliased silhouette.
{
  const built = createCityUnderpass({ layout: L });
  let vault = null;
  built.group.traverse((o) => { if (o.name === "CityUnderpassVault") vault = o; });
  const pos = vault.geometry.attributes.position;
  const alongOf = (i) => (L.axis === "x" ? pos.getX(i) : pos.getZ(i));
  /*
   * A centimetre of tolerance, not a millimetre: the sweep's own end ring
   * spreads about 12 mm along the axis, so a tighter window calls a bore that
   * starts exactly at the mouth "set back" and fails for no reason. The thing
   * being tested is a 72 cm recess — it does not need millimetre precision.
   */
  /*
   * 20 cm, because the sweep's end ring is not perfectly planar: the frames
   * tilt on the ramp, so the profile spreads a few centimetres along the axis.
   * It still separates the two cases cleanly — the reveal would have put the
   * inner ring 72 cm in, three times outside this window.
   */
  const EPS = 0.2;
  let atEntry = 0, atExit = 0;
  for (let i = 0; i < pos.count; i++) {
    const a = alongOf(i);
    if (Math.abs(a - L.cov0) < EPS) atEntry++;
    else if (Math.abs(a - L.cov1) < EPS) atExit++;
  }
  /*
   * BOTH SHELLS, and that is what distinguishes the fix from the bug.
   *
   * With the reveal on, only the OUTER profile reaches the mouth — the inner
   * one starts 72 cm further in — so the portal plane carries one ring's worth
   * of vertices. With it off, both are there and it carries two. Counting the
   * rings is the whole test; an earlier version looked for "nothing in the
   * first 70 cm" instead and failed the moment an ordinary station happened to
   * land near the portal, which says nothing about a reveal.
   */
  const { inner } = vaultProfiles(buildProfile(roadParams, true),
    { ...pieceParams, tunnelHeight: L.params.tunnelHeight });
  const twoRings = inner.length * 2 - 4;
  check("both shells reach the entry portal plane", atEntry >= twoRings,
    `${atEntry} vertices at cov0, want >= ${twoRings} (one ring is ${inner.length})`);
  check("and the exit portal plane", atExit >= twoRings,
    `${atExit} vertices at cov1`);
  built.dispose();
}

// ── THE PORTAL IS A WALL WITH A HOLE IN IT ──────────────────────────────────
//
// The vault is a SHELL, not a solid: above its crown there is nothing at all,
// and the street plane over that nothing is single-sided. So from the open
// trench you looked OVER the arch, through the earth, and out at the far side
// of the city — and from the ramp, at the sky.
//
// The headwall closes it. This is the assertion that actually matters, and the
// one whose absence let a broken first attempt look finished: fire a ray down
// the tunnel's axis at every point of the portal's cross-section and demand
// that it is stopped, unless it is going through the bore you drive through.
//
// It caught a real bug immediately. The rectangle had been sized to the trench
// wall's outer face (8.34 m), but the vault's shell is thick and its OUTSIDE
// reaches 8.62 m — so around the springing the arch was already outside the
// rectangle, the projection had nowhere to push it, and the quads collapsed
// into a 4.3 m tall slot down each side of the portal.
{
  const built = createCityUnderpass({ layout: L });
  let walls = null;
  built.group.traverse((o) => { if (o.name === "CityUnderpassWalls") walls = o; });
  check("the trench wall mesh exists to carry the headwall", !!walls);

  const { inner } = vaultProfiles(buildProfile(roadParams, true),
    { ...pieceParams, tunnelHeight: L.params.tunnelHeight });
  /*
   * THE HOLE IS THE BORE YOU DRIVE THROUGH — the INNER profile, not the outer
   * one. Testing against the outer profile excuses the whole thickness of the
   * shell, which is a 78 cm annulus round the mouth that something still has
   * to close (the vault's own mouth bevel does). Measured in the running game
   * before this was tightened: two rays threaded exactly there, entering the
   * portal plane at y = -0.27 — above the inner ceiling, below the outer crown.
   *
   * The profile is an open outline, both ends at the skirt, so closing it back
   * to the first point gives the polygon the crossing test needs.
   */
  const poly = [...inner, inner[0]];
  const inBore = (ax, ay) => {
    let hit = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i], b = poly[j];
      if ((a.y > ay) !== (b.y > ay)
        && ax < ((b.x - a.x) * (ay - a.y)) / (b.y - a.y) + a.x) hit = !hit;
    }
    return hit;
  };

  // The vault counts too: the mouth bevel is what closes the shell's own
  // thickness, and the headwall picks up from its outer edge. Either one
  // missing is a hole, so the ray is fired at both.
  let vault = null;
  built.group.traverse((o) => { if (o.name === "CityUnderpassVault") vault = o; });
  check("the vault shell exists to close its own thickness", !!vault);
  const parts = [walls, vault].filter(Boolean).map((m) => ({
    pos: m.geometry.attributes.position, idx: m.geometry.index,
  })).map((e) => ({
    ...e,
    triCount: (e.idx ? e.idx.count : e.pos.count) / 3,
    vi: (t, k) => (e.idx ? e.idx.getX(t * 3 + k) : t * 3 + k),
  }));

  /*
   * The nearest front-facing hit, as a distance — not a yes/no.
   *
   * A sloped ray that is NOT stopped at the portal usually hits something
   * eventually (the far end of the tunnel, a wall three hundred metres away),
   * so "did it hit anything" quietly passes the exact case this test exists
   * for. What has to be true is that it is stopped AT the portal.
   *
   * Back faces are skipped throughout: they are not drawn, so they do not
   * occlude, and treating them as solid is how the leak hid — the sight line
   * left through the OUTSIDE of the vault shell, from the inside.
   */
  const nearest = (ox, oy, oz, dx, dy, dz) => {
    let best = Infinity;
    for (const { pos, triCount, vi } of parts) {
    for (let t = 0; t < triCount; t++) {
      const i0 = vi(t, 0), i1 = vi(t, 1), i2 = vi(t, 2);
      const Ax = pos.getX(i0), Ay = pos.getY(i0), Az = pos.getZ(i0);
      const e1x = pos.getX(i1) - Ax, e1y = pos.getY(i1) - Ay, e1z = pos.getZ(i1) - Az;
      const e2x = pos.getX(i2) - Ax, e2y = pos.getY(i2) - Ay, e2z = pos.getZ(i2) - Az;
      const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
      const det = e1x * px + e1y * py + e1z * pz;
      if (det < 1e-10) continue;                       // back-facing or edge-on
      const inv = 1 / det;
      const tx = ox - Ax, ty = oy - Ay, tz = oz - Az;
      const u = (tx * px + ty * py + tz * pz) * inv;
      if (u < 0 || u > 1) continue;
      const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
      const v = (dx * qx + dy * qy + dz * qz) * inv;
      if (v < 0 || u + v > 1) continue;
      const tt = (e2x * qx + e2y * qy + e2z * qz) * inv;
      if (tt > 0.01 && tt < best) best = tt;
    }
    }
    return best;
  };

  // Both portals, because they are wound in opposite directions and getting one
  // of them backwards makes a wall that is invisible from the side you stand on.
  /*
   * ── AND FROM EVERY ANGLE, NOT JUST STRAIGHT ON ─────────────────────────────
   *
   * Three eye heights down in the trench, each aiming at the sample point, so
   * the rays arrive sloped. This is not thoroughness for its own sake: the
   * straight-on ray was the ONE case that was never broken. The leak that got
   * through an all-green version of this test was a grazing sight line
   * entering the ring around the mouth near the crown and climbing out through
   * the back of the shell — invisible to a ray with no slope on it.
   */
  const EYES = [0.6, 3.0, 5.8];
  for (const [name, along, dir] of [["entry", L.cov0, 1], ["exit", L.cov1, -1]]) {
    const start = along - dir * 12;
    let open = 0, tested = 0, bore = 0, firstOpen = null;
    /*
     * SAMPLE WHAT CAN ACTUALLY BE SEEN: the trench's own cross-section, from
     * the road surface up to street level. Wider than the trench is inside the
     * earth beside it and below the road is under it — nobody can put an eye
     * in either, so demanding wall there only invents failures.
     */
    for (let ax = -L.holeHalf + 0.05; ax <= L.holeHalf - 0.05; ax += 0.25) {
      for (let ay = 0.05; ay <= L.top - L.roadY - 0.05; ay += 0.25) {
        if (inBore(ax, ay)) { bore++; continue; }       // the hole you drive through
        tested++;
        const ox = L.axis === "x" ? along : L.across + ax;
        const oz = L.axis === "x" ? L.across + ax : along;
        const ty = L.roadY + ay;
        for (const eye of EYES) {
          const ex = L.axis === "x" ? start : L.across + ax * 0.35;
          const ez = L.axis === "x" ? L.across + ax * 0.35 : start;
          const ey = L.roadY + eye;
          let vx = ox - ex, vy = ty - ey, vz = oz - ez;
          const len = Math.hypot(vx, vy, vz) || 1;
          vx /= len; vy /= len; vz /= len;
          // Stopped AT the portal, within a hand's breadth of it — not by
          // something three hundred metres further down the tunnel.
          if (nearest(ex, ey, ez, vx, vy, vz) > len + 0.2) {
            open++;
            if (!firstOpen) {
              firstOpen = `(${ax.toFixed(2)}, ${ay.toFixed(2)}) from eye ${eye}`;
            }
            break;
          }
        }
      }
    }
    check(`the ${name} portal has a bore to drive through`, bore > 100, `${bore} samples inside it`);
    check(`and everything around the ${name} bore is solid wall`, open === 0,
      `${open} of ${tested} see straight through${firstOpen ? `, first at ${firstOpen}` : ""}`);
  }
  built.dispose();
}

// ── THE ROOF STARTS AT THE PORTAL, TO THE MILLIMETRE ────────────────────────
//
// A sweep can only begin AT a station. Left to an even spacing the nearest one
// to `cov0` was six metres inside it, so six metres of trench had no roof AND
// no wall — and because the street plane above is single-sided, standing in the
// tunnel you looked up through it at the sky.
{
  const on = (a) => L.path.some((q) => Math.abs((L.axis === "x" ? q.x : q.z) - a) < 1e-6);
  check("there is a station exactly at the entry portal", on(L.cov0), `${L.cov0}`);
  check("and exactly at the exit portal", on(L.cov1), `${L.cov1}`);
  check("and at both mouths", on(L.a0) && on(L.a1), `${L.a0} / ${L.a1}`);
}

// ── THE MOUTH HAS NO STEP ───────────────────────────────────────────────────
//
// The hole used to begin only once the road was 0.35 m down, which left the
// street plane lying on top of the first twenty-odd metres of ramp. Driving in
// that is a drop; driving OUT it is a 35 cm wall the car climbs and is thrown
// by. It is the "thin piece of road going straight while the ramp goes down".
{
  const open = underpassOpenAt(L);
  const at = (along) => (L.axis === "x" ? [along, L.across] : [L.across, along]);
  // Every metre of ramp between the mouth and the portal must be cut.
  let covered = 0;
  for (let a = L.a0 + 0.5; a < L.cov0; a += 2) if (!open(...at(a))) covered++;
  check("the street never lies over the ramp", covered === 0,
    `${covered} metres of ramp still under street plane`);

  /*
   * AND THE CUT IS NARROW AT THE MOUTH. The trench is wider than the road, and
   * at the mouth there are no walls yet to fill the difference — cutting full
   * width there would open a slot beside the road with nothing in it.
   */
  const U = L.params;
  const beside = L.axis === "x"
    ? [L.a0 + 4, L.across + U.roadWidth / 2 + 1] : [L.across + U.roadWidth / 2 + 1, L.a0 + 4];
  check("but no wider than the road while the walls have no height",
    !open(...beside), `${U.roadWidth / 2 + 1} m out at the mouth is still street`);
  // ...and it DOES widen once they do, or the trench walls stand on tarmac.
  const deep = L.axis === "x"
    ? [L.cov0 - 20, L.across + U.roadWidth / 2 + 1] : [L.across + U.roadWidth / 2 + 1, L.cov0 - 20];
  check("and it widens once they do", open(...deep), "full width down the trench");
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
