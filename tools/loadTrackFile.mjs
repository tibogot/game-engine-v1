// Read a track file the way the GAME reads it — migrated, and with every
// piece's params resolved to a full set.
//
// WHY THIS EXISTS. Since the v2 format, a saved piece carries only the params
// that differ from the kit's shipped numbers (see modularRoadTrackIO). The
// harnesses in here call `KIT.buildPiece(e.id, conn, e.pp, ...)` directly
// rather than going through the builder, so they would hand a SPARSE object to
// a function that reads `pp.straightLength` with no fallback — which does not
// throw. It builds a piece of length `undefined` and quietly produces a track
// of NaN vertices, and every measurement taken off it would be nonsense that
// still printed a number.
//
// They kept working only because the shipped .json files happen to still be v1
// on disk. Two of them take a path argument, so "happens to" was never good
// enough.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

/**
 * @param {string} root repo root
 * @param {string} relPath track file, relative to root
 * @returns {Promise<{track: object, rp: object, gp: object, pieces: object[]}>}
 *   `pieces` are the raw entries with `pp` replaced by a resolved full set;
 *   `rp`/`gp` are the road and guardrail params with the file's overrides on
 *   top of the kit's, which is what every caller was already building by hand.
 */
export async function loadTrackFile(root, relPath) {
  const GAME = join(root, "games/modular-road-v3");
  const KIT = await import(pathToFileURL(join(GAME, "modularRoadKit.js")).href);
  const IO = await import(pathToFileURL(join(GAME, "modularRoadTrackIO.js")).href);

  const defaults = {
    roadParams: KIT.ROAD_PARAM_DEFAULTS,
    guardrailParams: KIT.GUARDRAIL_PARAM_DEFAULTS,
    pieceParams: KIT.PIECE_PARAM_DEFAULTS,
  };
  const raw = JSON.parse(readFileSync(join(root, relPath), "utf8"));
  const { data: track } = IO.migrateTrack(raw, defaults);

  // Against the LIVE objects, not the frozen defaults: a harness may have set
  // `KIT.roadParams.width` before calling, and the file's own override still
  // has to win over that. Same shape the callers hand-rolled.
  const rp = { ...KIT.roadParams, ...(track.roadParams ?? {}) };
  const gp = { ...KIT.guardrailParams, ...(track.guardrailParams ?? {}) };

  const pieces = (track.pieces ?? []).map((e) => ({
    ...e,
    pp: IO.resolve(KIT.PIECE_PARAM_DEFAULTS, e.pp),
  }));

  return { track, rp, gp, pieces };
}
