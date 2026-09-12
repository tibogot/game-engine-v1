// ROAD BLOCKS — the three things you put across a lane, placeable by hand.
//
//   Road block         plastic, water-filled, white or red. Light.
//   Concrete barrier   a jersey. Heavy, and the one that shoves YOU.
//   Road plate         steel, lying over a hole. You drive across it.
//
// The last two already existed as CITY clutter, scattered by the roadworks
// generator, and nothing could place one. This suite covers the three things
// that had to be true for them to become props, and one bug it found on the way.
//
// ── THE BUG ──────────────────────────────────────────────────────────────────
//
// `box(w, h, d, x, y, z)` in the clutter module puts a part's BOTTOM at `y`.
// The jersey barrier and the trench plate were authored as if `y` were the
// part's CENTRE — read that way their numbers are continuous and correct, so
// nothing looked wrong in the source, and nothing looked wrong in the city
// either because they are small objects seen from a moving car under LOD.
// MEASURED before the fix:
//
//     jerseyGeo   y 0.080 -> 1.050     floating 8 cm, 1.05 m tall not 0.84,
//                                      with a 5 cm and an 8 cm gap THROUGH it
//     plateGeo    y 0.006 -> 0.075     the slab hovering 2.5 cm off the road
//     every other y 0.000 -> ...
//     clutter shape
//
// A placed prop is looked at from two metres away in the editor, so this had to
// be right before either could be placed. The invariant below — every clutter
// shape stands on y = 0 — is what would have caught it, and now does.
//
// ── AND THE THING THAT MUST NOT DRIFT ────────────────────────────────────────
//
// There are now two constructions of each shape: the city merges one painted
// geometry because it draws hundreds as one InstancedMesh, and a prop is a Group
// of flat-coloured parts because that is what the prop instancer collapses into
// a single draw. So the SHAPE lives in a table neither owns, and the test that
// earns its keep is the one that measures both and demands they agree. This
// codebase has paid for the alternative: the city street is a hand copy of the
// track asphalt and the two drifted for months.
//
// The plastic block's own geometry checks — jersey prism, handle trough, cap
// windings, no stripe texture — were already here and are kept verbatim below.
//
// Run: node tools/roadBlockTest.mjs
import { register } from "node:module";
import { readFileSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let fail = 0;
const check = (n, c, d = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`); if (!c) fail++; };

register("./threeWebgpuHook.mjs", import.meta.url);
const THREE = await import("three/webgpu");
const game = (f) => pathToFileURL(join(ROOT, "games/modular-road-v3", f)).href;

const CLUTTER = await import(game("modularRoadCityClutter.js"));
const { PropManager, PROP_BY_ID, PROP_CATALOG, ROAD_BLOCK_COLORS, WATER_BARRIER_SIZE } =
  await import(game("modularRoadProps.js"));
const { PropInstancer } = await import(game("modularRoadPropInstancer.js"));

const PROPS_SRC = readFileSync(join(ROOT, "games/modular-road-v3/modularRoadProps.js"), "utf8");

const _box = new THREE.Box3();
const boundsOf = (obj) => { obj.updateMatrixWorld(true); return _box.setFromObject(obj).clone(); };
const boundsOfGeo = (geo) => { geo.computeBoundingBox(); return geo.boundingBox.clone(); };
const sameBox = (a, b, tol = 1e-6) =>
  a.min.distanceTo(b.min) < tol && a.max.distanceTo(b.max) < tol;
const fmt = (b) => `y ${b.min.y.toFixed(3)}→${b.max.y.toFixed(3)} x ${
  (b.max.x - b.min.x).toFixed(3)} z ${(b.max.z - b.min.z).toFixed(3)}`;

/** A PropManager with no DOM, so the REAL add()/stackSnap/collisionMeshes run. */
function bareManager() {
  const m = Object.create(PropManager.prototype);
  m.scene = new THREE.Scene();
  m.group = new THREE.Group();
  m.scene.add(m.group);
  m.instances = [];
  m.selected = null;
  m.orbit = null;
  m.onChange = null;
  m.onSelect = null;
  m.onSelectionChange = null;
  m.getSurfaceY = null;           // "free" placement: nothing to fight the test
  m.gizmo = { attach() {}, detach() {}, enabled: false, visible: false, axis: null,
    _helper: { visible: false }, getHelper() { return this._helper; } };
  m.selBox = { setFromObject() {}, visible: false };
  m._disposeInstance = () => {};
  return m;
}

const BLOCKS = ["roadblock", "jersey", "roadplate"];

console.log("\n═══ ROAD BLOCKS ═══\n");

const def = PROP_CATALOG.find((d) => d.id === "roadblock");

console.log("=== THE PLASTIC BLOCK, EXACTLY AS IT SHIPPED ===");
// Every assertion below is the original roadBlockTest, unchanged. The block
// itself did not change when the other two arrived — it only gained a `stack`
// footprint — and these are what say so.
{
  check("roadblock is in the obstacles catalog", !!def && def.label === "Road block");
  check("solid collision (not a deck)", def?.collision === "solid");
  check("white + red variants (instance tint, no stripe texture)",
    Array.isArray(def?.variants) && def.variants.length === 2
    && ROAD_BLOCK_COLORS.length === 2
    && !PROPS_SRC.includes("roadBlockStripeTexture"));
}

console.log("\n=== ONE FRONTSIDE PRISM ===");
{
  const root = def.make();
  const meshes = [];
  root.traverse((o) => { if (o.isMesh) meshes.push(o); });
  check("one mesh", meshes.length === 1, `${meshes.length} meshes`);
  const mesh = meshes[0];
  check("FrontSide", mesh.material.side === THREE.FrontSide);
  check("sits on the ground", Math.abs(mesh.geometry.boundingBox.min.y) < 1e-6);
  const tris = mesh.geometry.attributes.position.count / 3;
  check("under 80 triangles", tris < 80, `${tris} tris`);
  check("no stripe map — colour is instance tint", !mesh.material.map);
  check("tintable for white/red variants", mesh.userData.tintable === true);

  const pos = mesh.geometry.attributes.position;
  const nrm = mesh.geometry.attributes.normal;
  const box = mesh.geometry.boundingBox;
  const baseW = box.max.z - box.min.z;
  const topY = box.max.y;
  let topW = 0;
  let troughY = topY;
  const P = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    P.fromBufferAttribute(pos, i);
    if (P.y > topY - 0.02) topW = Math.max(topW, 2 * Math.abs(P.z));
    if (Math.abs(P.z) < 0.05) troughY = Math.min(troughY, P.y);
  }
  check("jersey: base wider than the top lips",
    baseW > 0.5 && topW > 0 && topW < baseW * 0.5,
    `base ${baseW.toFixed(2)} m, top ${topW.toFixed(2)} m`);
  check("handle trough is cut into the top",
    troughY < topY - 0.05, `trough ${troughY.toFixed(2)} vs top ${topY.toFixed(2)}`);

  let frontOut = 0, frontIn = 0, capOut = 0, capIn = 0, topUp = 0;
  const hx = (mesh.geometry.boundingBox.max.x - mesh.geometry.boundingBox.min.x) / 2;
  for (let i = 0; i < pos.count; i += 3) {
    const nx = nrm.getX(i), ny = nrm.getY(i), nz = nrm.getZ(i);
    const x = (pos.getX(i) + pos.getX(i + 1) + pos.getX(i + 2)) / 3;
    const y = (pos.getY(i) + pos.getY(i + 1) + pos.getY(i + 2)) / 3;
    const z = (pos.getZ(i) + pos.getZ(i + 1) + pos.getZ(i + 2)) / 3;
    if (z > 0.25 && y < 0.2) (nz > 0.5 ? frontOut++ : frontIn++);
    if (x > hx - 0.05) (nx > 0.5 ? capOut++ : capIn++);
    if (ny > 0.85 && y > topY - 0.02) topUp++;
  }
  check("foot faces outward (+Z)", frontOut > 0 && frontIn === 0,
    `${frontOut} out / ${frontIn} in`);
  check("+X cap faces out", capOut > 0 && capIn === 0,
    `${capOut} out / ${capIn} in`);
  check("top lips face up", topUp > 0, `${topUp} tris`);
}

console.log("=== ONE SILHOUETTE, TWO CONSTRUCTIONS ===");
{
  // The city's merged painted geometry against the prop's Group of boxes. Equal
  // to the micron or one of them has been edited alone.
  const kit = CLUTTER.buildClutterKit();
  for (const [id, geoName] of [["jersey", "jerseyGeo"], ["roadplate", "plateGeo"]]) {
    const fromCity = boundsOfGeo(kit[geoName]);
    const fromProp = boundsOf(PROP_BY_ID.get(id).make());
    check(`the placed ${id} is the same object the city scatters`,
      sameBox(fromCity, fromProp), `city ${fmt(fromCity)}  ·  prop ${fmt(fromProp)}`);
  }

  // …and it is the same object because it is read from one table, not typed out
  // twice. A passing bbox with two copies of the numbers passes until somebody
  // edits one.
  check("the prop catalog reads the city's tables rather than copying them",
    /import \{[^}]*\bJERSEY_BARRIER\b[^}]*\bTRENCH_PLATE\b[^}]*\} from "\.\/modularRoadCityClutter\.js"/.test(PROPS_SRC));
  check("...and the city builds its own geometry from them too",
    /const jerseyGeo = blockGeometry\(JERSEY_BARRIER\);/.test(
      readFileSync(join(ROOT, "games/modular-road-v3/modularRoadCityClutter.js"), "utf8")));
}

console.log("\n=== EVERYTHING STANDS ON THE ROAD ===");
{
  // The invariant the two were breaking. Stated for the whole kit, not just the
  // two that were wrong, because the next shape added here will be authored by
  // copying one of these.
  const kit = CLUTTER.buildClutterKit();
  for (const [name, geo] of Object.entries(kit)) {
    const b = boundsOfGeo(geo);
    check(`${name} sits on y = 0`, Math.abs(b.min.y) < 1e-6, `min.y ${b.min.y.toFixed(4)}`);
  }

  // Total heights, stated out loud: a jersey is 0.84 m, the same as the water
  // barrier beside it, and the plate is 5 cm of steel.
  check("the jersey is 0.84 m tall, not the 1.05 the centre-misread made it",
    Math.abs(boundsOfGeo(kit.jerseyGeo).max.y - 0.84) < 1e-6,
    `${boundsOfGeo(kit.jerseyGeo).max.y.toFixed(3)} m`);
  check("the plate is 5 cm of steel lying flat",
    Math.abs(boundsOfGeo(kit.plateGeo).max.y - 0.05) < 1e-6,
    `${boundsOfGeo(kit.plateGeo).max.y.toFixed(3)} m`);

  // NO GAP THROUGH THE BARRIER, which is what the misread actually cost: the
  // foot ended 5 cm below where the batter began and the batter 8 cm below the
  // upstand, so you could see daylight through a concrete barrier. Walk the
  // structural parts bottom-up and require each to start where the last ended.
  const structural = CLUTTER.JERSEY_BARRIER.parts
    .filter((p) => p.d >= 0.26 && p.h >= 0.16)           // the band is paint, not structure
    .sort((a, b) => a.y - b.y);
  let gapped = 0;
  let prevTop = 0;
  for (const p of structural) {
    if (p.y > prevTop + 1e-9) gapped++;
    prevTop = Math.max(prevTop, p.y + p.h);
  }
  check("the jersey's profile is continuous from the road to its top",
    gapped === 0 && Math.abs(prevTop - CLUTTER.JERSEY_BARRIER.size.height) < 1e-9,
    `${gapped} gap(s), stack reaches ${prevTop.toFixed(3)} m`);

  // A placement keeps the y `make()` authored (restY) and adds it back after the
  // surface snap, so a block whose make() lifts its root lands that far in the
  // air. All three must author 0.
  for (const id of BLOCKS) {
    const root = PROP_BY_ID.get(id).make();
    check(`${id} authors restY = 0, so a placement lands it flush`,
      root.position.y === 0, `root.y ${root.position.y}`);
  }
}

console.log("\n=== A LINE WITH NO GAP ===");
{
  // A line of concrete exists to leave no gap — a gap between two barriers is a
  // gap you could drive into, and the city's own generator lays them end to end
  // for that reason (cityKitTest: 0 of 588 gapped). Placed by hand that means
  // eyeballing 2.40 m over and over, so all three blocks declare a `stack`
  // footprint and PropManager.stackSnap does it.
  for (const id of BLOCKS) {
    const def = PROP_BY_ID.get(id);
    check(`${id} declares a footprint to snap rows against`,
      !!def.stack && def.stack.length > 0 && def.stack.width > 0,
      JSON.stringify(def.stack));
  }

  // THE FOOTPRINT MUST BE THE BLOCK'S OWN, or a row snaps by a length the block
  // does not have and the gap comes back. The strongest form of that is identity
  // — the catalog hands stackSnap the very object the shape was built from, so
  // there is nothing to keep in agreement.
  check("the jersey snaps by the table it was built from",
    PROP_BY_ID.get("jersey").stack === CLUTTER.JERSEY_BARRIER.size);
  check("...and so does the plate",
    PROP_BY_ID.get("roadplate").stack === CLUTTER.TRENCH_PLATE.size);
  check("...and the plastic barrier by its own constant",
    PROP_BY_ID.get("roadblock").stack === WATER_BARRIER_SIZE);

  // What may differ from the mesh, and by how much. Both table-driven blocks
  // carry ONE part that is paint rather than structure and overhangs slightly —
  // the jersey's reflective band by 1 cm a side, the plate's yellow rim by 3 cm —
  // and the snap has to follow the STRUCTURE, because that is the face that meets
  // the neighbour. So the mesh is allowed to be a little wider than the snap and
  // never narrower, and the overhang has to be the decoration it claims to be.
  for (const [id, spec] of [["jersey", CLUTTER.JERSEY_BARRIER], ["roadplate", CLUTTER.TRENCH_PLATE]]) {
    const b = boundsOf(PROP_BY_ID.get(id).make());
    const overX = (b.max.x - b.min.x) - spec.size.length;
    const overZ = (b.max.z - b.min.z) - spec.size.width;
    const structural = spec.parts.filter((p) => p.w <= spec.size.length + 1e-9);
    check(`${id}'s structure never overhangs the footprint it snaps by`,
      overX >= -1e-9 && overZ >= -1e-9 && overX < 0.07 && overZ < 0.07,
      `paint overhangs x ${overX.toFixed(3)} z ${overZ.toFixed(3)}`);
    check(`...and the widest structural part IS that footprint`,
      structural.some((p) => Math.abs(p.w - spec.size.length) < 1e-9
        && Math.abs(p.d - spec.size.width) < 1e-9),
      `${structural.length} structural part(s) of ${spec.parts.length}`);
  }

  // The plastic barrier is one merged mesh with no decoration on top, so for it
  // the footprint and the silhouette are simply the same thing.
  {
    const b = boundsOf(PROP_BY_ID.get("roadblock").make());
    check("the plastic barrier's silhouette IS its footprint",
      Math.abs((b.max.x - b.min.x) - WATER_BARRIER_SIZE.length) < 1e-6
      && Math.abs((b.max.z - b.min.z) - WATER_BARRIER_SIZE.width) < 1e-6
      && Math.abs(b.max.y - WATER_BARRIER_SIZE.height) < 1e-6, fmt(b));
  }

  // THE REAL stackSnap, on the real manager.
  const mgr = bareManager();
  const first = mgr.add("jersey", new THREE.Vector3(0, 0, 0));
  const L = PROP_BY_ID.get("jersey").stack.length;

  // Click past the end, on the road (y = the block's feet).
  const beyond = new THREE.Vector3(L / 2 + 0.3, 0, 0);
  const snap = mgr.stackSnap("jersey", beyond);
  check("clicking past the end of a barrier snaps the next one end to end",
    !!snap && Math.abs(snap.position.x - L) < 1e-6 && Math.abs(snap.position.z) < 1e-6,
    snap ? `x ${snap.position.x.toFixed(3)} (want ${L})` : "no snap");
  check("...which leaves a gap of exactly nothing",
    !!snap && Math.abs(snap.position.distanceTo(first.root.position) - L) < 1e-6);

  // AT AN ANGLE, which is the case a world grid could never serve: the offset is
  // rotated into the first block's frame and the rotation is copied, so a line
  // you started at 37° stays a line.
  const YAW = THREE.MathUtils.degToRad(37);
  const angled = bareManager();
  const a = angled.add("jersey", new THREE.Vector3(10, 0, -4));
  a.root.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), YAW);
  a.root.updateMatrixWorld(true);
  const along = new THREE.Vector3(L / 2 + 0.3, 0, 0)
    .applyQuaternion(a.root.quaternion).add(a.root.position);
  const s2 = angled.stackSnap("jersey", along);
  check("a row started at an angle stays a row",
    !!s2 && Math.abs(s2.position.distanceTo(a.root.position) - L) < 1e-6,
    s2 ? `${s2.position.distanceTo(a.root.position).toFixed(4)} m apart` : "no snap");
  check("...and the next block copies the first one's rotation",
    !!s2 && s2.quaternion.angleTo(a.root.quaternion) < 1e-6);

  // The plate tiles in BOTH axes — one is 2.60 × 2.00 m, which covers a trench
  // and not a junction, so a crossing is several of them meeting flush.
  const plates = bareManager();
  plates.add("roadplate", new THREE.Vector3(0, 0, 0));
  const PS = PROP_BY_ID.get("roadplate").stack;
  const px = plates.stackSnap("roadplate", new THREE.Vector3(PS.length / 2 + 0.3, 0, 0));
  const pz = plates.stackSnap("roadplate", new THREE.Vector3(0, 0, PS.width / 2 + 0.3));
  check("plates tile along the road", !!px && Math.abs(px.position.x - PS.length) < 1e-6,
    px ? `x ${px.position.x.toFixed(2)}` : "no snap");
  check("...and across it", !!pz && Math.abs(pz.position.z - PS.width) < 1e-6,
    pz ? `z ${pz.position.z.toFixed(2)}` : "no snap");

  check("the plastic barrier's footprint is one constant, not three copies",
    WATER_BARRIER_SIZE.length === 2.2 && WATER_BARRIER_SIZE.width === 0.56,
    JSON.stringify(WATER_BARRIER_SIZE));
  check("...and its geometry, its collision box and its snap all read it",
    /roadBlockGeometry\(S\.length, S\.height\)/.test(PROPS_SRC)
    && /new THREE\.BoxGeometry\(S\.length, S\.height, S\.width\)/.test(PROPS_SRC)
    && /stack: WATER_BARRIER_SIZE,/.test(PROPS_SRC));
}

console.log("\n=== WHAT THE CAR ACTUALLY HITS ===");
{
  // THE JERSEY IS ONE UPRIGHT BOX, not its own profile. Two reasons, both of
  // which this codebase has already been bitten by: the batter is a ramp that
  // launches a car that clips it, and the 26 cm top is a lid the hull parks on.
  // Baking the visible parts would also put the foot's 9 cm shoulder in the
  // solids tree as a ledge to perch on.
  const mgr = bareManager();
  mgr.add("jersey", new THREE.Vector3(0, 0, 0));
  const { deck, solids } = mgr.collisionMeshes();
  check("a jersey is one solid and nothing else", solids.length === 1, `${solids.length} solid(s)`);
  check("...and it is not in the deck channel — you do not drive on a barrier",
    deck.length === 0, `${deck.length} deck entr(ies)`);
  if (solids.length === 1) {
    const S = CLUTTER.JERSEY_BARRIER.size;
    const b = boundsOfGeo(solids[0].geometry);
    check("the proxy is an upright box over the whole footprint",
      Math.abs(b.min.y) < 1e-6
      && Math.abs(b.max.y - S.height) < 1e-6
      && Math.abs((b.max.x - b.min.x) - S.length) < 1e-6
      && Math.abs((b.max.z - b.min.z) - S.width) < 1e-6, fmt(b));
    check("...which is 12 triangles, not the 48 you can see",
      solids[0].geometry.index.count / 3 === 12,
      `${solids[0].geometry.index.count / 3} tris`);
  }

  // THE PLATE IS IN NO CHANNEL AT ALL, which is not what its shape wants and is
  // what the game measured. `deck` is the obvious role — driving across it is the
  // entire object — and it made the plate stand on ITSELF: the placement snap
  // searches down through the very tree the plate is baked into, and
  // hitIsOwnDeck only discounts hits more than DECK_SELF_SKIP above the root.
  // Re-snapping a placed plate, which is what a gizmo drag does, walked it
  // 0 -> 0 -> 0.05 and left it floating. `none` is also what the city does with
  // the same object, and at 5 cm it costs nothing to drive over.
  const pm = bareManager();
  pm.add("roadplate", new THREE.Vector3(0, 0, 0));
  const pc = pm.collisionMeshes();
  check("a road plate is in no collision channel", pc.deck.length === 0 && pc.solids.length === 0,
    `${pc.deck.length} deck, ${pc.solids.length} solids`);
  check("...and both its parts say so, so a change of role cannot bake two steps",
    PROP_BY_ID.get("roadplate").make().children.every((c) => c.userData.noCollide));

  // The plastic one keeps the behaviour it shipped with.
  const wm = bareManager();
  wm.add("roadblock", new THREE.Vector3(0, 0, 0));
  const wc = wm.collisionMeshes();
  check("the plastic barrier is still one solid box and no deck",
    wc.solids.length === 1 && wc.deck.length === 0
    && Math.abs((boundsOfGeo(wc.solids[0].geometry).max.x
      - boundsOfGeo(wc.solids[0].geometry).min.x) - WATER_BARRIER_SIZE.length) < 1e-6);
}

console.log("\n=== NOTHING IN THE DECK CHANNEL IS THINNER THAN THE SELF-SKIP ===");
{
  // THE GENERAL RULE the plate broke, stated once so the next thin prop does not
  // have to be found in the game. A prop in the deck channel is baked into the
  // tree the placement snap reads, so it WILL hit its own surface; hitIsOwnDeck
  // discounts that only above DECK_SELF_SKIP. A prop thinner than that margin
  // cannot tell its own top from the road it rests on, and climbs by its own
  // height every time it is dragged.
  const GAME = readFileSync(join(ROOT, "games/modular-road-v3/roadGame.js"), "utf8");
  const m = /const DECK_SELF_SKIP = ([\d.]+);/.exec(GAME);
  check("DECK_SELF_SKIP parses out of the game", !!m, m?.[1]);
  const SKIP = m ? Number(m[1]) : NaN;

  // 4x the margin, not 1x: the plate CLEARED it by a centimetre and still failed,
  // so "clears it" is not the bar. The thinnest real deck prop is the asphalt lot
  // at 0.80 m, twenty times over, so this costs nothing to demand.
  const FLOOR = SKIP * 4;
  const thin = [];
  for (const def of PROP_CATALOG) {
    if (def.collision !== "deck" && def.collision !== "both") continue;
    let root;
    try { root = def.make(); } catch { continue; }
    const b = boundsOf(root);
    const h = b.max.y - b.min.y;
    // GLB-backed props (container, tire wall) make() empty until their fetch
    // resolves, so there is no height to measure here. propShadowTest owns that.
    if (!Number.isFinite(h)) continue;
    if (h < FLOOR) thin.push(`${def.id} ${h.toFixed(3)}m`);
  }
  check(`every deck prop is thicker than ${FLOOR.toFixed(2)} m`, thin.length === 0,
    thin.join(", ") || "thinnest is well clear");
}

console.log("\n=== ONE DRAW EACH ===");
{
  // A draw call is one material, so a prop costs a batch per distinct LOOK — and
  // the jersey is four shades. collapsePlainParts folds them into a single
  // vertex-shaded part, which is the whole reason these are built as plain
  // `mat()` boxes instead of handing over the city's pre-painted geometry
  // (bakePlainAttrs keeps position/normal/uv and rebuilds the colour from
  // material.color, so a `color` attribute would be dropped and the barrier
  // would come out one flat grey).
  // This subsumes the old INSTANCER section, which asserted the same thing for
  // the plastic block alone.
  const inst = new PropInstancer(new THREE.Scene(), { instances: [] }, PROP_CATALOG, () => true);
  for (const id of BLOCKS) {
    const parts = inst._template(id);
    check(`${id} is one draw however many it costs to look right`,
      parts.length === 1, `${parts.length} part(s)`);
  }

  // A slab lying ON the road contributes nothing but a shadow-map draw, per
  // cascade. FLAT_PROP_HEIGHT (0.2 m) is meant to catch exactly this and the
  // plate is 0.05, so it should come out of the box with casting off.
  const plate = inst._template("roadplate");
  check("the plate casts no shadow — it is flat on the road",
    plate.every((p) => !p.castShadow));
  check("...while a barrier you can see the silhouette of does",
    inst._template("jersey").some((p) => p.castShadow));
}

console.log(`\n${fail === 0 ? "ALL PASS" : `${fail} FAILED`}`);
process.exit(fail === 0 ? 0 : 1);
