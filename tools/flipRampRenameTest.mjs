// THE FLIP RAMP RENAME — does a track saved before it still load?
//
// The piece was `loopback` with six `loopback*` tuning keys; it is now
// `flip_ramp` with `flipRamp*`. A piece id is the ONE thing in a track file that
// cannot be inherited from a default — layout is absolute — so without a
// migration every track saved before the rename names a piece that no longer
// exists, and loads as a hole where the ramp was.
//
// This is the guard on that, and on the two things a rename this shape can
// quietly leave behind: a tile still pointing at the old base, and the old names
// surviving somewhere in the kit.
//
//   node tools/flipRampRenameTest.mjs
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { readFileSync, readdirSync } from "node:fs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GAME = join(ROOT, "games/modular-road-v3");
const { migrateTrack, TRACK_VERSION } = await import(
  pathToFileURL(join(GAME, "modularRoadTrackIO.js")).href);
const { PIECE_BY_ID, PIECE_PARAM_DEFAULTS, FOLLOW_ROAD } = await import(
  pathToFileURL(join(GAME, "modularRoadKit.js")).href);
const { CATEGORY_PRESETS } = await import(
  pathToFileURL(join(GAME, "modularRoadBuilder.js")).href);

let fail = 0;
const check = (name, ok, note = "") => {
  if (!ok) fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${note ? `  — ${note}` : ""}`);
};

console.log("\nTHE FLIP RAMP RENAME\n");

/* ── 1. THE PIECE ─────────────────────────────────────────────────────────── */

check("the piece is called flip_ramp", PIECE_BY_ID.has("flip_ramp"));
check("and nothing answers to loopback any more", !PIECE_BY_ID.has("loopback"));
check("it is still the one road-hold ramp", FOLLOW_ROAD.has("flip_ramp") && !FOLLOW_ROAD.has("loopback"));

const oldKeys = Object.keys(PIECE_PARAM_DEFAULTS).filter((k) => k.startsWith("loopback"));
check("no loopback* tuning keys are left in the kit", oldKeys.length === 0, oldKeys.join(", "));
const newKeys = ["flipRampRadius", "flipRampAngle", "flipRampFace",
  "flipRampTopRadius", "flipRampExit", "flipRampEase"];
const absent = newKeys.filter((k) => !(k in PIECE_PARAM_DEFAULTS));
check("and all six flipRamp* keys are there", absent.length === 0, absent.join(", "));

/* ── 2. THE MIGRATION ─────────────────────────────────────────────────────── */

const old = {
  version: 3,
  pieces: [
    { id: "start", chainId: 0 },
    { id: "loopback", chainId: 0 },
    { id: "straight", chainId: 0 },
  ],
  pieceParams: { loopbackRadius: 21, loopbackStraight: 7.5, curveRadius: 30 },
};
const { data, steps } = migrateTrack(old, {});

check(`a v3 save is carried to v${TRACK_VERSION}`, data.version === TRACK_VERSION,
  `${steps.join(", ") || "no steps"}`);
check("the ramp is renamed in the layout",
  data.pieces[1].id === "flip_ramp",
  `piece 1 is "${data.pieces[1].id}"`);
check("every other piece is untouched",
  data.pieces[0].id === "start" && data.pieces[2].id === "straight");
check("its tuning keys come across with their values",
  data.pieceParams.flipRampRadius === 21 && data.pieceParams.flipRampFace === 7.5,
  JSON.stringify(data.pieceParams));
check("and the old key names are gone",
  !("loopbackRadius" in data.pieceParams) && !("loopbackStraight" in data.pieceParams));
check("unrelated tuning is left alone", data.pieceParams.curveRadius === 30);

// Sparse means a track that never tuned the ramp has nothing to rename, and the
// migration must not invent keys for it — an invented key would PIN that value
// at today's default forever, which is the whole thing sparse saves avoid.
const bare = migrateTrack({ version: 3, pieces: [{ id: "loopback" }] }, {}).data;
check("a save with no ramp tuning gains no keys",
  !bare.pieceParams || Object.keys(bare.pieceParams).length === 0,
  JSON.stringify(bare.pieceParams ?? null));

/* ── 3. WHAT A RENAME LEAVES BEHIND ───────────────────────────────────────── */

const tiles = Object.values(CATEGORY_PRESETS).flat();
const stale = tiles.filter((t) => t.base === "loopback");
check("no palette tile still points at the old base", stale.length === 0,
  stale.map((t) => t.id).join(", "));
const ramps = tiles.filter((t) => t.base === "flip_ramp");
check("the flip ramp tiles found the new base", ramps.length >= 2,
  ramps.map((t) => t.id).join(", ") || "none");
// The piece took the name the tile used to have, so the tile had to give it up:
// verticalTubeTest forbids a preset named after a piece.
check("and no tile is named after the piece", !tiles.some((t) => t.id === "flip_ramp"),
  tiles.filter((t) => t.id.startsWith("flip_ramp")).map((t) => t.id).join(", "));

/* ── 4. THE SHIPPED TRACKS ────────────────────────────────────────────────── */

const shipped = readdirSync(GAME).filter((f) => f.endsWith(".json"));
const stillOld = [], withRamp = [];
for (const f of shipped) {
  let t;
  try { t = JSON.parse(readFileSync(join(GAME, f), "utf8")); } catch { continue; }
  if (!Array.isArray(t?.pieces)) continue;
  const loaded = migrateTrack(t, {}).data;
  if (loaded.pieces.some((p) => p?.id === "loopback")) stillOld.push(f);
  const n = loaded.pieces.filter((p) => p?.id === "flip_ramp").length;
  if (n) withRamp.push(`${f} (${n})`);
  const keys = Object.keys(loaded.pieceParams ?? {}).filter((k) => k.startsWith("loopback"));
  if (keys.length) stillOld.push(`${f}: ${keys.join(", ")}`);
}
check(`no shipped track still carries the old names (${shipped.length} files)`,
  stillOld.length === 0, stillOld.join(" | "));
check("and the ones with a flip ramp resolve it", withRamp.length > 0, withRamp.join(", ") || "none found");

// Deliberately NOT a blanket "every shipped track resolves to real pieces".
// That check was written first and it fails — rushline.json is a v1 track naming
// a piece `checkpoint`, where the kit only has `checkpoint_new`. That is a real
// problem and it predates this rename by a long way, so it does not belong to
// this suite: a guard that goes red for something it is not guarding is a guard
// people learn to ignore.

console.log(fail ? `\n${fail} FAILURE(S)\n` : "\nall checks green\n");
process.exit(fail ? 1 : 0);
