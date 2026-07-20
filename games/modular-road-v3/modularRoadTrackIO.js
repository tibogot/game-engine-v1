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
}) {
  return {
    format: TRACK_FORMAT,
    version: TRACK_VERSION,
    savedAt: new Date().toISOString(),
    roadParams: clonePlainParams(roadParams),
    guardrailParams: clonePlainParams(guardrailParams),
    pieceParams: clonePlainParams(pieceParams),
    portalParams: clonePlainParams(portalParams),
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

  ctx.builder.importTrackPieces(data.pieces);
  ctx.props.importInstances(data.props);
  if (ctx.movers) ctx.movers.importInstances(data.movers);
  ctx.portals.importLayout(data.portals);

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
