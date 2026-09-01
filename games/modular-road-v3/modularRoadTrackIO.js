/**
 * Save / load modular-road track layouts as JSON.
 *
 * ── WHAT A TRACK FILE IS FOR ────────────────────────────────────────────────
 *
 * Two different kinds of number end up in a save, and they want OPPOSITE
 * things from time:
 *
 *   LAYOUT   — which pieces, in what order, at what seam. This must never move.
 *              A track you built in March has to load in August as the same
 *              track, whatever the engine has learned since.
 *
 *   TUNING   — how long a straight is, how hard a bank curls, how bright the
 *              deck is. This should FOLLOW THE BUILD. When `bankCurl` is
 *              retuned because the old value read as a fold, every track that
 *              never had an opinion about `bankCurl` wants the new one.
 *
 * Version 1 stored both the same way — absolutely — and stored the tuning once
 * PER PIECE. Measured on the shipped saves: rushline wrote 74 params on each of
 * its 41 pieces, and only 10 of those keys carried any per-piece information at
 * all. The other 64 were the same number copied 41 times: a frozen photograph
 * of the defaults as they stood on the day of the save.
 *
 * That is the whole of "my old track kept the shape of things I changed since".
 * It also produced a subtler failure. Loading merged the saved keys over the
 * live objects and left keys the file had never heard of at their current
 * defaults — so a v1 rushline came back carrying `wallRideLength` (a piece type
 * that no longer exists) while missing `bankRise`, `linesBloom` and `wetTint`.
 * Half March, half August, in a combination that had never shipped.
 *
 * ── WHAT VERSION 2 STORES ───────────────────────────────────────────────────
 *
 * Layout absolutely, exactly as before — `connectorIn` is still a baked world
 * matrix, because "my track must not move" is a real requirement and deriving
 * seams from intent would let a default change shift a bridge off its pillars.
 *
 * Tuning SPARSELY: a param is written only when it differs from this build's
 * pristine baseline (ROAD_PARAM_DEFAULTS and friends, captured at module init
 * in the kit). So the file says only what you actually chose, and absence has a
 * meaning it never had in v1 — "I had no opinion, use whatever is current".
 * A key you dialled in differs from the baseline and is written verbatim; a key
 * you never touched is omitted and inherits future retunes for free.
 *
 * The same rule kills the Frankenstein state: the schema IS the defaults
 * object, so a key the current build does not define is dropped on load and
 * reported, rather than riding along invisibly forever.
 */

export const TRACK_FORMAT = "modular-road-track";
export const TRACK_VERSION = 2;

/** Versions this build can read. Anything older is migrated up on load. */
export const TRACK_MIN_VERSION = 1;

function clonePlainParams(obj) {
  if (!obj || typeof obj !== "object") return {};
  const out = { ...obj };
  delete out.onChange;
  return out;
}

/**
 * Value equality for authored params.
 *
 * Exact, deliberately — no epsilon. These are numbers a person typed or a
 * slider stepped to, not the output of a simulation, so "22" either is or is
 * not the default. An epsilon here would silently drop a genuine 22.0001 the
 * user nudged to, which is the one thing a save must never do.
 *
 * Goes through JSON because the value set is not all numbers: `loopHalf` is a
 * string, the guardrail flags are booleans, and the look colours are ints.
 */
function sameValue(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a && b && typeof a === "object") return JSON.stringify(a) === JSON.stringify(b);
  return false;
}

/**
 * The keys of `obj` that differ from `defaults` — the user's actual choices.
 *
 * Keys absent from `defaults` are DROPPED, not carried: `defaults` is the
 * schema as well as the baseline, so a param this build no longer has is not
 * something to preserve, it is something to stop writing. `onChange` never
 * survives — it is a live callback, not format.
 *
 * @param {object} obj
 * @param {object} defaults
 * @returns {object} sparse override set (a plain, JSON-safe object)
 */
export function sparse(obj, defaults) {
  const out = {};
  if (!obj || typeof obj !== "object") return out;
  if (!defaults || typeof defaults !== "object") return clonePlainParams(obj);
  for (const key of Object.keys(obj)) {
    if (key === "onChange") continue;
    if (!(key in defaults)) continue;
    if (sameValue(obj[key], defaults[key])) continue;
    out[key] = obj[key];
  }
  return out;
}

/**
 * `defaults` overlaid with a saved sparse override set.
 *
 * Unknown keys are counted into `report.dropped` rather than merged, so a load
 * can TELL you it ignored something instead of leaving you to wonder why an
 * old track drives differently.
 *
 * @param {object} defaults
 * @param {object} saved
 * @param {{dropped?: string[]}} [report]
 * @returns {object} a full param set
 */
export function resolve(defaults, saved, report) {
  const out = clonePlainParams(defaults);
  if (!saved || typeof saved !== "object") return out;
  for (const key of Object.keys(saved)) {
    if (key === "onChange") continue;
    if (!(key in out)) {
      if (report) (report.dropped ||= []).push(key);
      continue;
    }
    out[key] = saved[key];
  }
  return out;
}

/**
 * Write a resolved param set INTO the live object the engine reads.
 *
 * In place, not by replacement, because `roadParams` and friends are module
 * singletons that half the kit closed over at import time — handing back a new
 * object would leave every one of those references pointing at the old one.
 * `onChange` is preserved for the same reason: it is the live wiring.
 */
function applyResolved(target, resolved) {
  if (!target || !resolved) return;
  for (const key of Object.keys(resolved)) {
    if (key === "onChange") continue;
    target[key] = resolved[key];
  }
}

/* ------------------------------------------------------------------------- */
/* Migration                                                                  */
/* ------------------------------------------------------------------------- */

/**
 * The blocks that carry tuning, and where their baseline comes from.
 *
 * One list rather than five hand-written branches, because the failure mode
 * this format had was precisely a block being handled slightly differently from
 * its neighbours and nobody noticing for months.
 */
const PARAM_BLOCKS = ["roadParams", "guardrailParams", "pieceParams", "portalParams", "roadLook"];

/**
 * v1 → v2: sparsify. Same track, far less of it.
 *
 * PRESERVES GEOMETRY EXACTLY, which is the only acceptable behaviour for a
 * migration the user did not ask for. Every v1 value that differs from today's
 * baseline is kept as an explicit override, so the track loads pixel-identical
 * to how it loaded before this change.
 *
 * The cost of that safety is honest and worth naming: a v1 file cannot tell us
 * which of its numbers were CHOSEN and which were merely the defaults of the
 * day, so values that have merely drifted since are pinned along with the real
 * choices. Those are collected into `legacyPins` and reported — and they are
 * exactly what `rebaseLegacy` exists to release.
 */
function migrateV1toV2(data, defaults) {
  const out = { ...data, version: 2 };

  for (const block of PARAM_BLOCKS) {
    const base = defaults?.[block];
    if (!base || !data[block]) continue;
    out[block] = sparse(data[block], base);
  }

  // Per-piece params get the same treatment. `pp` in v1 is a full snapshot of
  // every piece type's params, so this is where the 64-of-74 redundancy goes.
  const pieceBase = defaults?.pieceParams;
  if (Array.isArray(data.pieces) && pieceBase) {
    out.pieces = data.pieces.map((p) => (
      p && typeof p === "object" && p.pp ? { ...p, pp: sparse(p.pp, pieceBase) } : p
    ));
  }

  // Pre-scale tracks stored the 3.5 × 4.5 door the car did not fit through.
  // Kept as a migration step rather than the ad-hoc fixup it used to be inside
  // importTrack: it is a format change like any other, and it belongs on the
  // path where every other format change is written down.
  const pp = out.portalParams;
  if (pp && pp.width === 3.5 && pp.height === 4.5) {
    pp.width = 6.5;
    pp.height = 8;
    if (pp.exitOffset === 2.75) pp.exitOffset = 4;
  }

  return out;
}

/** version → the function that turns it into the next version up. */
const MIGRATIONS = { 1: migrateV1toV2 };

/**
 * Bring a track file up to TRACK_VERSION, one step at a time.
 *
 * A chain rather than a switch so that adding v3 means writing ONE function
 * that assumes a well-formed v2 — never a fresh set of "was this saved before
 * or after X" tests scattered through the loader. That scattering is how v1
 * ended up with the portal fixup living inside `importTrack`.
 *
 * @returns {{data: object, from: number|null, steps: string[]}}
 */
export function migrateTrack(data, defaults) {
  let cur = data;
  const from = typeof data?.version === "number" ? data.version : null;
  const steps = [];
  let guard = 0;
  while (typeof cur.version === "number" && cur.version < TRACK_VERSION) {
    const step = MIGRATIONS[cur.version];
    if (!step) break;
    const before = cur.version;
    cur = step(cur, defaults);
    steps.push(`v${before}→v${cur.version}`);
    if (++guard > 16) break; // a migration that failed to advance the version
  }
  return { data: cur, from: from === TRACK_VERSION ? null : from, steps };
}

/**
 * The params a v1 track pinned only because the build has moved on since.
 *
 * A key qualifies when EVERY piece in the file carries the same value for it
 * and that value is not the current default. Uniform-across-the-track is the
 * signal: `curveRadius` varies piece to piece because it was authored per
 * corner, whereas `jumpAngle` sitting at exactly 28 on all 41 pieces —
 * including the straights, which never read it — is the fingerprint of a
 * defaults snapshot, not of a decision.
 *
 * This is a REPORT, not an action. It is what turns "my old track behaves
 * oddly" into a list you can read.
 */
function legacyPinsOf(pieces, pieceDefaults) {
  const pins = [];
  if (!Array.isArray(pieces) || !pieces.length || !pieceDefaults) return pins;
  const withPp = pieces.filter((p) => p && typeof p.pp === "object");
  if (!withPp.length) return pins;

  const keys = new Set();
  for (const p of withPp) for (const k of Object.keys(p.pp)) keys.add(k);

  for (const key of keys) {
    if (!(key in pieceDefaults)) continue;
    // Present on every piece, and identical on every piece.
    if (!withPp.every((p) => key in p.pp)) continue;
    const v = withPp[0].pp[key];
    if (!withPp.every((p) => sameValue(p.pp[key], v))) continue;
    if (sameValue(v, pieceDefaults[key])) continue;
    pins.push({ key, pinned: v, current: pieceDefaults[key], pieces: withPp.length });
  }
  pins.sort((a, b) => a.key.localeCompare(b.key));
  return pins;
}

/* ------------------------------------------------------------------------- */
/* Export / import                                                            */
/* ------------------------------------------------------------------------- */

/**
 * @param {object} ctx
 * @param {import("./modularRoadBuilder.js").ModularRoadBuilder} ctx.builder
 * @param {import("./modularRoadProps.js").PropManager} ctx.props
 * @param {import("./modularRoadPortals.js").PortalManager} ctx.portals
 * @param {import("./modularRoadMoverProps.js").MoverPropManager} ctx.movers
 * @param {object} ctx.roadParams
 * @param {object} ctx.guardrailParams
 * @param {object} ctx.pieceParams
 * @param {object} [ctx.portalParams]
 * @param {object} [ctx.roadLook] surface appearance (see ROAD_LOOK_KEYS)
 * @param {object} [ctx.defaults] pristine baselines, keyed like the blocks
 *   above. Omit and the save falls back to writing every param in full — a v1
 *   -shaped file at a v2 version number, which still loads correctly, just
 *   without the inheritance. That fallback is why the game can save before the
 *   road material exists.
 */
export function exportTrack({
  builder,
  props,
  movers,
  portals,
  roadParams,
  guardrailParams,
  pieceParams,
  portalParams,
  roadLook,
  defaults,
}) {
  const live = { roadParams, guardrailParams, pieceParams, portalParams, roadLook };
  const out = {
    format: TRACK_FORMAT,
    version: TRACK_VERSION,
    savedAt: new Date().toISOString(),
  };
  for (const block of PARAM_BLOCKS) {
    const base = defaults?.[block];
    out[block] = base ? sparse(live[block], base) : clonePlainParams(live[block]);
  }
  // Pieces sparsify themselves — the builder owns PIECE_DEFAULTS and is the only
  // thing that knows a piece record's shape.
  out.pieces = builder.exportTrackPieces();
  out.props = props.exportInstances();
  out.movers = movers.exportInstances();
  out.portals = portals.exportLayout();
  return out;
}

/**
 * @param {unknown} data
 * @param {object} ctx — same shape as exportTrack
 * @param {object} [opts]
 * @param {boolean} [opts.rebaseLegacy] drop a v1 file's defaults-of-the-day
 *   pins so the track picks up this build's tuning. OFF by default: it changes
 *   the shape of an existing track, which is the user's call, never a silent
 *   consequence of opening a file.
 * @returns {{ok: boolean, error?: string, pieceCount?: number,
 *   migratedFrom?: number|null, steps?: string[], dropped?: object,
 *   legacyPins?: object[], rebased?: boolean, notes?: string[]}}
 */
export function importTrack(data, ctx, opts = {}) {
  if (!data || typeof data !== "object") {
    return { ok: false, error: "Invalid track file." };
  }
  if (data.format !== TRACK_FORMAT) {
    return { ok: false, error: `Unknown format (expected ${TRACK_FORMAT}).` };
  }
  if (typeof data.version !== "number" || data.version < TRACK_MIN_VERSION) {
    return { ok: false, error: `Unsupported version ${data.version}.` };
  }
  if (data.version > TRACK_VERSION) {
    // Forward-incompatible, and say so usefully: this is a file from a NEWER
    // build, not a corrupt one, and the fix is to update rather than to debug.
    return {
      ok: false,
      error: `Track was saved by a newer build (v${data.version}; this one reads v${TRACK_VERSION}).`,
    };
  }

  const defaults = ctx.defaults ?? {};
  const notes = [];

  // The legacy-pin report is computed on the RAW v1 pieces, before migration
  // sparsifies them — afterwards a pin and a genuine choice look identical,
  // which is the whole reason this has to happen here.
  const legacyPins = data.version === 1
    ? legacyPinsOf(data.pieces, defaults.pieceParams)
    : [];

  const { data: track, from: migratedFrom, steps } = migrateTrack(data, defaults);

  const rebased = !!opts.rebaseLegacy && legacyPins.length > 0;
  const pinnedKeys = rebased ? new Set(legacyPins.map((p) => p.key)) : null;

  const dropped = {};
  for (const block of PARAM_BLOCKS) {
    const target = block === "portalParams" ? ctx.portalParams : ctx[block];
    const base = defaults[block];
    if (!target) continue;
    // No baseline for this block (the look before the deck exists) — fall back
    // to the v1 behaviour of merging whatever the file has. Absent keys keep
    // their current values, which is the same thing "sparse" would have meant.
    if (!base) {
      if (track[block]) applyResolved(target, clonePlainParams(track[block]));
      continue;
    }
    const rep = {};
    applyResolved(target, resolve(base, track[block], rep));
    if (rep.dropped?.length) dropped[block] = rep.dropped;
  }

  ctx.builder.importTrackPieces(track.pieces, { dropKeys: pinnedKeys });
  ctx.props.importInstances(track.props);
  if (ctx.movers) ctx.movers.importInstances(track.movers);
  ctx.portals.importLayout(track.portals);

  // AFTER the objects, not before. `importTrackPieces` resets the history itself
  // — correctly, for the pieces — but props/movers/portals are history layers
  // now and they are imported on the lines above it, so that baseline described
  // the road from the NEW track and the objects from the OLD one. The first
  // object edit after a load then committed a step whose undo dragged the
  // previous track's props back onto the map. Re-seed once everything has landed.
  ctx.builder.resetHistory?.();

  if (steps.length) notes.push(`Migrated ${steps.join(", ")}.`);
  for (const [block, keys] of Object.entries(dropped)) {
    notes.push(`${block}: dropped ${keys.length} key(s) this build no longer has (${keys.join(", ")}).`);
  }
  if (legacyPins.length && !rebased) {
    notes.push(
      `${legacyPins.length} param(s) pinned at the defaults of the day this track was saved ` +
      `(${legacyPins.map((p) => `${p.key} ${p.pinned}→${p.current}`).join(", ")}). ` +
      `Load with Rebase to take this build's values instead.`,
    );
  }
  if (rebased) {
    notes.push(`Rebased ${legacyPins.length} legacy pin(s) onto this build's defaults.`);
  }

  return {
    ok: true,
    pieceCount: ctx.builder.count,
    migratedFrom,
    steps,
    dropped,
    legacyPins,
    rebased,
    notes,
  };
}

export function downloadTrackJson(track, filename = "modular-road-track.json") {
  const json = JSON.stringify(track, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** File name for a track download. Strips characters the OS will not accept. */
export function trackDownloadName(name) {
  const cleaned = String(name ?? "")
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "");
  const base = cleaned || "modular-road-track";
  return /\.json$/i.test(base) ? base : `${base}.json`;
}

/**
 * @param {(data: object) => void | Promise<void>} onLoad
 * @returns {HTMLInputElement}
 */
export function createTrackFileInput(onLoad) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".json,application/json";
  input.hidden = true;
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      await onLoad(data);
    } catch (err) {
      console.error("[modular-road] track load failed", err);
      alert(`Failed to load track: ${err.message || err}`);
    }
  });
  document.body.appendChild(input);
  return input;
}
