/**
 * Save / load modular-road track layouts as JSON.
 */

export const TRACK_FORMAT = "modular-road-track";
export const TRACK_VERSION = 1;

function clonePlainParams(obj) {
  if (!obj || typeof obj !== "object") return {};
  const out = { ...obj };
  delete out.onChange;
  return out;
}

function assignPlainParams(target, source) {
  if (!source || typeof source !== "object") return;
  for (const key of Object.keys(source)) {
    if (key === "onChange") continue;
    target[key] = source[key];
  }
}

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
}) {
  return {
    format: TRACK_FORMAT,
    version: TRACK_VERSION,
    savedAt: new Date().toISOString(),
    roadParams: clonePlainParams(roadParams),
    guardrailParams: clonePlainParams(guardrailParams),
    pieceParams: clonePlainParams(pieceParams),
    portalParams: clonePlainParams(portalParams),
    // Surface appearance, kept beside the geometry params it belongs with. A
    // plain object on purpose: this module knows nothing about materials or
    // three, and stays loadable without them. Optional, so tracks saved before
    // looks were portable still load — they just keep the material defaults.
    roadLook: clonePlainParams(roadLook),
    pieces: builder.exportTrackPieces(),
    props: props.exportInstances(),
    movers: movers.exportInstances(),
    portals: portals.exportLayout(),
  };
}

/**
 * @param {unknown} data
 * @param {object} ctx — same shape as exportTrack
 * @returns {{ ok: boolean, error?: string, pieceCount?: number }}
 */
export function importTrack(data, ctx) {
  if (!data || typeof data !== "object") {
    return { ok: false, error: "Invalid track file." };
  }
  if (data.format !== TRACK_FORMAT) {
    return { ok: false, error: `Unknown format (expected ${TRACK_FORMAT}).` };
  }
  if (data.version !== TRACK_VERSION) {
    return { ok: false, error: `Unsupported version ${data.version} (expected ${TRACK_VERSION}).` };
  }

  assignPlainParams(ctx.roadParams, data.roadParams);
  assignPlainParams(ctx.guardrailParams, data.guardrailParams);
  assignPlainParams(ctx.pieceParams, data.pieceParams);
  if (ctx.portalParams && data.portalParams) assignPlainParams(ctx.portalParams, data.portalParams);
  // Filled in for the caller to push at its material — importTrack does not
  // touch the renderer. Absent in pre-look saves, and left untouched then, so
  // loading an old track does not reset a look the user just dialled in.
  if (ctx.roadLook && data.roadLook) assignPlainParams(ctx.roadLook, data.roadLook);

  ctx.builder.importTrackPieces(data.pieces);
  ctx.props.importInstances(data.props);
  if (ctx.movers) ctx.movers.importInstances(data.movers);
  ctx.portals.importLayout(data.portals);

  // AFTER the objects, not before. `importTrackPieces` resets the history itself
  // — correctly, for the pieces — but props/movers/portals are history layers
  // now and they are imported on the lines above it, so that baseline described
  // the road from the NEW track and the objects from the OLD one. The first
  // object edit after a load then committed a step whose undo dragged the
  // previous track's props back onto the map. Re-seed once everything has landed.
  ctx.builder.resetHistory?.();

  return { ok: true, pieceCount: ctx.builder.count };
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
