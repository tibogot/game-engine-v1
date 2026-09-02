// TRACK SAVE FORMAT — sparse tuning, absolute layout, and the v1 migration.
//
// What this guards is a promise with two halves that pull against each other:
//
//   LAYOUT NEVER MOVES.   A v1 track must load in v2 as the same track, seam
//                         for seam, with every param it actually differs on
//                         still applied. A migration the user did not ask for
//                         is not allowed to reshape their work.
//
//   TUNING FOLLOWS THE BUILD. A param the user never had an opinion about must
//                         be ABSENT from the file, so retuning a default
//                         reaches old tracks instead of being overruled by a
//                         copy of the value it had on the day of the save.
//
// The bug this replaces: v1 wrote a full snapshot of every piece param onto
// every piece. Measured on the shipped saves, rushline wrote 74 params × 41
// pieces and only 10 of those keys ever differed between pieces — the rest was
// the defaults of the day, frozen, silently overruling every later fix.
import { readFileSync, existsSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GAME = join(ROOT, "games/modular-road-v3");

// No three, no DOM: modularRoadTrackIO deliberately has zero runtime imports so
// the format can be reasoned about (and tested) on its own.
const IO = await import(pathToFileURL(join(GAME, "modularRoadTrackIO.js")).href);

let fail = 0;
const check = (name, ok, note = "") => {
  if (!ok) fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${note ? `  — ${note}` : ""}`);
};
const section = (s) => console.log(`\n=== ${s} ===`);

/* ------------------------------------------------------------------------- */
/* Stubs — the managers are JSDoc types, so a plain object satisfies them.    */
/* ------------------------------------------------------------------------- */

const DEFAULTS = {
  roadParams: { width: 12, thickness: 0.6, segLen: 1.6 },
  guardrailParams: { enabled: true, beamHeight: 0.8 },
  pieceParams: { straightLength: 22, curveRadius: 26, jumpAngle: 12, bankCurl: 0.9, loopRadius: 25 },
  portalParams: { enabled: true, width: 6.5, height: 8, exitOffset: 4 },
  roadLook: { asphaltDark: 0x101010, deckBrightness: 1 },
};

const mgr = (out = []) => ({
  exportInstances: () => out,
  importInstances(v) { this.got = v; },
  exportLayout: () => out,
  importLayout(v) { this.got = v; },
});

/**
 * A builder stub that implements the BUILDER SIDE OF THE CONTRACT.
 *
 * That contract is the whole interface between the format and the engine:
 * `importTrackPieces` receives a SPARSE `pp` plus an optional set of keys to
 * take from the defaults regardless, and is responsible for resolving both
 * into the full param set every piece record carries in memory. Spelling it
 * out here rather than storing the entries raw is deliberate — a stub that
 * just echoed would let the format hand the builder something it could not
 * actually use and still report green.
 *
 * The real ModularRoadBuilder does exactly this in `resolvePieceParams`, and
 * the end-to-end section below drives that one for real.
 */
function builderStub(pieces = []) {
  return {
    pieces,
    count: pieces.length,
    lastOpts: null,
    exportTrackPieces: () => pieces,
    importTrackPieces(entries, opts = {}) {
      this.lastOpts = opts;
      this.pieces = (entries ?? []).map((e) => {
        const pp = IO.resolve(DEFAULTS.pieceParams, e.pp);
        if (opts.dropKeys) for (const k of opts.dropKeys) pp[k] = DEFAULTS.pieceParams[k];
        return { ...e, pp };
      });
      this.count = this.pieces.length;
    },
    resetHistory() { this.resetCalls = (this.resetCalls ?? 0) + 1; },
  };
}

const ctxFor = (builder, live) => ({
  builder,
  props: mgr(), movers: mgr(), portals: mgr(),
  roadParams: live.roadParams,
  guardrailParams: live.guardrailParams,
  pieceParams: live.pieceParams,
  portalParams: live.portalParams,
  roadLook: live.roadLook,
  defaults: DEFAULTS,
});

const liveCopy = () => JSON.parse(JSON.stringify(DEFAULTS));

/* ------------------------------------------------------------------------- */
section("SPARSE: a save records choices, not the state of the world");
/* ------------------------------------------------------------------------- */

{
  const untouched = IO.sparse({ straightLength: 22, curveRadius: 26 }, DEFAULTS.pieceParams);
  check("a param left at its default is not written",
    Object.keys(untouched).length === 0, JSON.stringify(untouched));

  const chosen = IO.sparse({ straightLength: 32, curveRadius: 26 }, DEFAULTS.pieceParams);
  check("a param the user changed IS written",
    chosen.straightLength === 32 && !("curveRadius" in chosen), JSON.stringify(chosen));

  // The one thing an epsilon would break. A slider that lands on 22.0001 is a
  // choice; treating it as "close enough to the default" would silently discard
  // it, and the track would come back subtly wrong with nothing to point at.
  const nudged = IO.sparse({ straightLength: 22.0001 }, DEFAULTS.pieceParams);
  check("a hair off the default still counts as a choice", nudged.straightLength === 22.0001);

  const retired = IO.sparse({ wallRideLength: 70, straightLength: 32 }, DEFAULTS.pieceParams);
  check("a param this build no longer has is not written back out",
    !("wallRideLength" in retired) && retired.straightLength === 32);

  check("`onChange` never reaches the file",
    !("onChange" in IO.sparse({ onChange: () => {}, straightLength: 32 }, DEFAULTS.pieceParams)));

  const rep = {};
  const resolved = IO.resolve(DEFAULTS.pieceParams, { straightLength: 32, wallRideLength: 70 }, rep);
  check("resolve() fills the gaps from the CURRENT defaults",
    resolved.curveRadius === 26 && resolved.straightLength === 32);
  check("...and reports what it had to ignore rather than swallowing it",
    rep.dropped?.length === 1 && rep.dropped[0] === "wallRideLength", JSON.stringify(rep));
}

/* ------------------------------------------------------------------------- */
section("ROUND TRIP: save → load is the identity");
/* ------------------------------------------------------------------------- */

{
  const live = liveCopy();
  live.pieceParams.straightLength = 32;   // a choice
  live.roadLook.deckBrightness = 1.4;     // another
  const pieces = [
    { id: "straight", chainId: 0, pp: { straightLength: 32 }, connectorIn: new Array(16).fill(0) },
    { id: "curve", chainId: 0, pp: {}, connectorIn: new Array(16).fill(0) },
  ];
  const saved = IO.exportTrack(ctxFor(builderStub(pieces), live));

  check("the file is stamped at the current version", saved.version === IO.TRACK_VERSION);
  check("only the two changed params are in the file",
    Object.keys(saved.pieceParams).length === 1 && saved.pieceParams.straightLength === 32
    && Object.keys(saved.roadLook).length === 1 && saved.roadLook.deckBrightness === 1.4,
    JSON.stringify({ pp: saved.pieceParams, look: saved.roadLook }));
  check("blocks the user never touched are written as empty, not omitted",
    saved.roadParams && Object.keys(saved.roadParams).length === 0);

  const dest = liveCopy();
  const b = builderStub();
  const res = IO.importTrack(JSON.parse(JSON.stringify(saved)), ctxFor(b, dest));
  check("it loads", res.ok, res.error);
  check("the choices came back", dest.pieceParams.straightLength === 32
    && dest.roadLook.deckBrightness === 1.4);
  check("everything else resolved to the current defaults",
    dest.pieceParams.curveRadius === 26 && dest.roadLook.asphaltDark === 0x101010);
  check("the pieces came back", b.count === 2);
  check("a clean load has nothing to report", res.notes.length === 0, JSON.stringify(res.notes));
}

/* ------------------------------------------------------------------------- */
section("INHERITANCE: the thing v1 could not do");
/* ------------------------------------------------------------------------- */

{
  // The whole point. Save a track that never expressed an opinion about
  // bankCurl, then retune bankCurl, then load: the track must take the new one.
  const live = liveCopy();
  const saved = IO.exportTrack(ctxFor(builderStub([]), live));
  check("bankCurl is absent from the save", !("bankCurl" in saved.pieceParams));

  const retuned = JSON.parse(JSON.stringify(DEFAULTS));
  retuned.pieceParams.bankCurl = 0.4;               // the build moved on
  const dest = liveCopy();
  const ctx = ctxFor(builderStub(), dest);
  ctx.defaults = retuned;
  IO.importTrack(saved, ctx);
  check("a track with no opinion INHERITS the new default",
    dest.pieceParams.bankCurl === 0.4, `got ${dest.pieceParams.bankCurl}`);

  // ...and the other half: an opinion is never overruled by a retune.
  const opinionated = liveCopy();
  opinionated.pieceParams.bankCurl = 1.6;
  const savedOpinion = IO.exportTrack(ctxFor(builderStub([]), opinionated));
  const dest2 = liveCopy();
  const ctx2 = ctxFor(builderStub(), dest2);
  ctx2.defaults = retuned;
  IO.importTrack(savedOpinion, ctx2);
  check("a track WITH an opinion keeps it through a retune",
    dest2.pieceParams.bankCurl === 1.6, `got ${dest2.pieceParams.bankCurl}`);
}

/* ------------------------------------------------------------------------- */
section("MIGRATION: v1 loads, and loads UNCHANGED");
/* ------------------------------------------------------------------------- */

// A v1 file as they were actually written: a full snapshot on every piece,
// including params the piece does not read and one that no longer exists.
const V1_SNAPSHOT = {
  straightLength: 32, curveRadius: 26, jumpAngle: 28, bankCurl: 0.9,
  loopRadius: 25, wallRideLength: 70,
};
const v1File = () => ({
  format: IO.TRACK_FORMAT,
  version: 1,
  roadParams: { width: 12, thickness: 0.6, segLen: 1.6 },
  guardrailParams: { enabled: true, beamHeight: 0.8 },
  pieceParams: { ...V1_SNAPSHOT },
  portalParams: { enabled: true, width: 3.5, height: 4.5, exitOffset: 2.75 },
  roadLook: { asphaltDark: 0x101010, deckBrightness: 1 },
  pieces: [
    { id: "straight", chainId: 0, edges: true, pp: { ...V1_SNAPSHOT }, connectorIn: new Array(16).fill(0) },
    { id: "curve", chainId: 0, edges: true, pp: { ...V1_SNAPSHOT, curveRadius: 40 }, connectorIn: new Array(16).fill(0) },
  ],
  props: [], movers: [], portals: [],
});

{
  const dest = liveCopy();
  const b = builderStub();
  const res = IO.importTrack(v1File(), ctxFor(b, dest));

  check("a v1 file still loads", res.ok, res.error);
  // Asserts the SHAPE of the chain, not one hard-coded pair: a v1 file has to
  // start at v1, climb one version per step, and land on the current version.
  // Spelling out "v1→v2" meant this failed the moment v3 was added, which is a
  // test breaking on a correct change rather than catching a wrong one.
  const wantSteps = [];
  for (let v = 1; v < IO.TRACK_VERSION; v++) wantSteps.push(`v${v}→v${v + 1}`);
  check("...and says so", res.migratedFrom === 1 && res.steps.join() === wantSteps.join(),
    `${JSON.stringify(res.steps)} vs ${JSON.stringify(wantSteps)}`);

  // GEOMETRY IS PRESERVED. Everything the v1 file differed from today's
  // defaults on is still applied — that is the contract of a migration nobody
  // asked for.
  const straight = b.pieces[0].pp;
  const curve = b.pieces[1].pp;
  check("a per-piece value the file differed on survives", curve.curveRadius === 40);
  check("a track-wide value the file differed on survives",
    straight.straightLength === 32 && straight.jumpAngle === 28,
    JSON.stringify({ s: straight.straightLength, j: straight.jumpAngle }));
  check("a value that matched the default is still the default", straight.bankCurl === 0.9);
  check("a param this build no longer has is gone, not carried",
    !("wallRideLength" in straight));

  // THE FRANKENSTEIN CHECK. v1's loader merged saved keys over the live objects
  // and left keys the file had never heard of at whatever the session had them
  // at. A key absent from an old file must resolve to the DEFAULT, not to
  // whatever the last track left behind.
  const polluted = liveCopy();
  polluted.pieceParams.loopRadius = 999;   // left over from a previous load
  const v1 = v1File();
  delete v1.pieceParams.loopRadius;        // the old file never heard of it
  for (const p of v1.pieces) delete p.pp.loopRadius;
  IO.importTrack(v1, ctxFor(builderStub(), polluted));
  check("a key the old file lacks resolves to the DEFAULT, not to leftover state",
    polluted.pieceParams.loopRadius === 25, `got ${polluted.pieceParams.loopRadius}`);

  // The pre-scale portal door, now a migration step rather than an ad-hoc
  // fixup buried in the loader.
  const portalDest = liveCopy();
  IO.importTrack(v1File(), ctxFor(builderStub(), portalDest));
  check("the 3.5 × 4.5 portal the car did not fit through is widened",
    portalDest.portalParams.width === 6.5 && portalDest.portalParams.height === 8
    && portalDest.portalParams.exitOffset === 4);
}

/* ------------------------------------------------------------------------- */
section("LEGACY PINS: naming what an old track froze, and releasing it");
/* ------------------------------------------------------------------------- */

{
  const res = IO.importTrack(v1File(), ctxFor(builderStub(), liveCopy()));
  const keys = res.legacyPins.map((p) => p.key);

  // jumpAngle sits at 28 on BOTH pieces — including the curve, which never
  // reads it. Uniform across the track and not the current default: the
  // fingerprint of a defaults snapshot rather than a decision.
  check("a uniform, stale param is identified as a pin", keys.includes("jumpAngle"),
    JSON.stringify(keys));
  check("...and the report says what it would become",
    res.legacyPins.find((p) => p.key === "jumpAngle")?.current === 12);
  // curveRadius VARIES between the two pieces, so it was authored per corner.
  check("a param that varies piece to piece is NOT a pin", !keys.includes("curveRadius"));
  // straightLength is uniform AND stale, so it is a pin too — the heuristic
  // cannot tell a track-wide choice from a snapshot, which is exactly why
  // releasing them is opt-in rather than automatic.
  check("a uniform track-wide choice is reported too (hence: opt-in)",
    keys.includes("straightLength"));
  check("the load explains itself", res.notes.some((n) => /pinned at the defaults/.test(n)),
    JSON.stringify(res.notes));

  // Default load: nothing moves.
  const plain = builderStub();
  IO.importTrack(v1File(), ctxFor(plain, liveCopy()));
  check("a PLAIN load leaves the pins in place (the track does not change shape)",
    plain.pieces[0].pp.jumpAngle === 28, `got ${plain.pieces[0].pp.jumpAngle}`);
  check("...and passes no drop list down to the builder",
    plain.lastOpts?.dropKeys == null, JSON.stringify(plain.lastOpts));

  // Opt-in rebase: the pins are released, the authored values are not.
  const rebased = builderStub();
  const out = IO.importTrack(v1File(), ctxFor(rebased, liveCopy()), { rebaseLegacy: true });
  check("Shift+Load hands the builder the keys to drop",
    rebased.lastOpts?.dropKeys instanceof Set && rebased.lastOpts.dropKeys.has("jumpAngle"));
  check("...and the pin is actually released", rebased.pieces[0].pp.jumpAngle === 12,
    `got ${rebased.pieces[0].pp.jumpAngle}`);
  check("...but never the per-piece authored ones",
    !rebased.lastOpts.dropKeys.has("curveRadius")
    && rebased.pieces[1].pp.curveRadius === 40);
  check("...and says what it did", out.rebased === true
    && out.notes.some((n) => /Rebased/.test(n)));
}

/* ------------------------------------------------------------------------- */
section("VERSION GATE");
/* ------------------------------------------------------------------------- */

{
  const future = { ...v1File(), version: IO.TRACK_VERSION + 1 };
  const res = IO.importTrack(future, ctxFor(builderStub(), liveCopy()));
  check("a file from a NEWER build is refused, not half-applied", !res.ok);
  check("...with a message that says which way the mismatch runs",
    /newer build/.test(res.error ?? ""), res.error);

  const alien = IO.importTrack({ format: "something-else", version: 2 },
    ctxFor(builderStub(), liveCopy()));
  check("a look file is still rejected as a track", !alien.ok);
}

/* ------------------------------------------------------------------------- */
section("THE SHIPPED TRACKS still load — and get much smaller");
/* ------------------------------------------------------------------------- */

for (const name of ["rushline.json", "apex-parkour.json", "airjump.json"]) {
  const path = join(GAME, name);
  if (!existsSync(path)) { console.log(`skip  ${name} (not present)`); continue; }
  const raw = JSON.parse(readFileSync(path, "utf8"));

  // Against the REAL defaults this time, pulled from the kit's frozen copies.
  // Importing the kit needs three, so read the numbers straight out of it if
  // three is unavailable — the point here is the piece count and the shrink.
  let realDefaults = DEFAULTS;
  try {
    const kit = await import(pathToFileURL(join(GAME, "modularRoadKit.js")).href);
    realDefaults = {
      roadParams: kit.ROAD_PARAM_DEFAULTS,
      guardrailParams: kit.GUARDRAIL_PARAM_DEFAULTS,
      pieceParams: kit.PIECE_PARAM_DEFAULTS,
    };
  } catch { /* no three in this environment — the DEFAULTS stub still exercises it */ }

  const before = JSON.stringify(raw).length;
  const { data } = IO.migrateTrack(raw, realDefaults);
  const after = JSON.stringify(data).length;

  check(`${name}: every piece survives the migration`,
    (data.pieces?.length ?? 0) === (raw.pieces?.length ?? 0),
    `${raw.pieces?.length} pieces`);
  check(`${name}: it is stamped v${IO.TRACK_VERSION}`, data.version === IO.TRACK_VERSION);

  if (realDefaults !== DEFAULTS) {
    const keysBefore = raw.pieces.reduce((n, p) => n + Object.keys(p.pp ?? {}).length, 0);
    const keysAfter = data.pieces.reduce((n, p) => n + Object.keys(p.pp ?? {}).length, 0);
    const detail = `${keysBefore} → ${keysAfter} params across ${raw.pieces.length} pieces, `
      + `${(before / 1024).toFixed(0)} KB → ${(after / 1024).toFixed(0)} KB`;

    // SPARSIFYING IS THE v1→v2 STEP, so only a v1 file can shrink here. This
    // asserted the shrink for every shipped track and so failed permanently on
    // apex-parkour, which was re-saved at v2 and is therefore ALREADY sparse —
    // the test was wrong, not the migration. A v2+ file must instead come
    // through unchanged, which is the real contract for it.
    if ((raw.version ?? 1) === 1) {
      check(`${name}: v1 per-piece snapshot is gone`, keysAfter < keysBefore / 3, detail);
    } else {
      check(`${name}: already sparse at v${raw.version}, migration adds no bulk`,
        keysAfter <= keysBefore, detail);
    }
  }
}

/* ------------------------------------------------------------------------- */
section("END TO END through the REAL builder");
/* ------------------------------------------------------------------------- */

// Everything above drives a stub. This drives ModularRoadBuilder itself, which
// is where the sparse shape actually has to stop: buildPiece reads plenty of
// params with no `?? pieceParams` fallback, so a sparse `pp` leaking past
// `resolvePieceParams` would not throw — it would silently build the piece with
// `undefined` lengths and produce a track full of NaN seams.
{
  const THREE = await import("three");
  const { ModularRoadBuilder } = await import(
    pathToFileURL(join(GAME, "modularRoadBuilder.js")).href);
  const mat = () => new THREE.MeshBasicMaterial();
  const fresh = () => new ModularRoadBuilder({
    scene: new THREE.Scene(), material: mat(), railMaterial: mat(),
    shellMaterial: mat(), decorMaterial: mat(),
  });

  const a = fresh();
  a.snapEnabled = false;
  for (const [id, params] of [["straight", { straightLength: 32 }], ["curve", { curveRadius: 40 }],
    ["jump", {}], ["straight", {}]]) {
    a.setActivePiece(id);
    Object.assign(a.activeParams, params);
    a.place();
  }

  const exported = JSON.parse(JSON.stringify(a.exportTrackPieces()));
  check("the real export is sparse",
    exported.every((e) => Object.keys(e.pp).length <= 1),
    JSON.stringify(exported.map((e) => Object.keys(e.pp))));
  check("...and still carries the authored values",
    exported[0].pp.straightLength === 32 && exported[1].pp.curveRadius === 40);
  check("`edges: true` is not written — it is the default, not a choice",
    exported.every((e) => !("edges" in e)));

  const bck = fresh();
  bck.importTrackPieces(exported);
  check("it reloads into the real builder", bck.pieces.length === a.pieces.length);
  check("every piece comes back with a FULL param set, not the sparse one",
    bck.pieces.every((p) => Object.keys(p.pp).length === Object.keys(a.pieces[0].pp).length),
    `${Object.keys(bck.pieces[0].pp).length} vs ${Object.keys(a.pieces[0].pp).length}`);

  // THE LAYOUT DID NOT MOVE. Seams to the metre are not enough here — the whole
  // claim is that a save is exact, so this is the full 16-float matrix.
  let worst = 0;
  for (let i = 0; i < a.pieces.length; i++) {
    const x = a.pieces[i].connectorOut.elements;
    const y = bck.pieces[i].connectorOut.elements;
    for (let k = 0; k < 16; k++) worst = Math.max(worst, Math.abs(x[k] - y[k]));
  }
  check("every seam round-trips exactly", worst < 1e-9, `worst element delta ${worst.toExponential(2)}`);

  // And a v1 file straight into the builder, bypassing migration — the harnesses
  // in tools/ do exactly this, and a full `pp` must still resolve cleanly.
  const v1Direct = fresh();
  v1Direct.importTrackPieces([{
    id: "straight", chainId: 0, edges: true,
    pp: { ...a.pieces[0].pp, wallRideLength: 70, onChange: null },
    connectorIn: a.pieces[0].connectorIn.toArray(),
  }]);
  check("a raw v1 piece record still loads (the tools/ harnesses pass these)",
    v1Direct.pieces.length === 1 && v1Direct.pieces[0].pp.straightLength === 32);
  check("...without dragging a retired key into the piece",
    !("wallRideLength" in v1Direct.pieces[0].pp));
}

/* ------------------------------------------------------------------------- */
section("REBASE IS A GESTURE, NOT A MODE");
/* ------------------------------------------------------------------------- */

// The flag is latched on the Load button (the file input's `change` fires long
// after the modifier was held), which means it has to be CONSUMED on use. It
// was not, at first: one Shift+Load left it true and every subsequent load
// silently rebased. Caught by driving the real page, and pinned here because
// the wiring lives in roadGame and cannot be imported headlessly.
{
  const game = readFileSync(join(GAME, "roadGame.js"), "utf8");
  const at = game.indexOf("rebaseLegacy");
  const around = game.slice(Math.max(0, at - 500), at + 200);
  check("the rebase flag is cleared as it is read, so it cannot become a mode",
    /loadRebase\s*=\s*false;/.test(around),
    "Shift+Load must affect exactly one load");
  check("...and it is latched from the button's own shiftKey",
    /loadRebase\s*=\s*!!e\?\.shiftKey/.test(game));
}

console.log(fail ? `\n${fail} FAILURE(S)\n` : "\nall green\n");
process.exit(fail ? 1 : 0);
