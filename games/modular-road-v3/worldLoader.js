// Load .v3proj worlds into the modular-road game. Same contract as
// games/rts-v3/worldLoader.js: the v3 EDITOR authors the world, this game just
// loads it. Default boot uses world.v3proj; callers can also load other saved
// projects from disk (dev panel) or via ?world= URL.
//
// NOTE the split (deliberate): the WORLD is a .v3proj authored in v3/editor.html,
// the TRACK is standalone JSON handled by modularRoadTrackIO.js. One world can
// host many tracks, and a track can be shared without shipping a terrain.
import { decodeProjectFile, isProjectFile } from "../../v3/io/projectIO.js";
import { saveTerrainConfig, HEIGHTMAP_SIZE, WORLD_SIZE, MAX_HEIGHT } from "../../v3/terrain/heightmapTexture.js";
import { stashPendingHeightmap } from "../../v3/io/pendingLoad.js";

/** Flat empty terrain — a stunt track supplies its own scenery, so the world
 *  under it only has to exist and not get in the way. */
export const DEFAULT_WORLD_URL = "/games/modular-road-v3/stunt.v3proj";

const PENDING_KEY = "modular-road-v3.pendingWorld";
const LOG = "[ModularRoad-v3]";

function terrainMismatch(t) {
  return t.heightmapSize !== HEIGHTMAP_SIZE
    || Math.round(t.worldSize) !== WORLD_SIZE
    || Math.round(t.maxHeight) !== MAX_HEIGHT;
}

/** Boot path: load the shipped default world, or fall back to procedural terrain. */
export async function loadDefaultWorld(app, { onStatus } = {}) {
  try {
    const res = await fetch(DEFAULT_WORLD_URL, { method: "HEAD" });
    if (!res.ok) {
      console.warn(
        `${LOG} No world file at ${DEFAULT_WORLD_URL}. `
        + "Save a project from v3/editor.html and drop it here as world.v3proj.",
      );
      return { name: "procedural default", loaded: false };
    }
    onStatus?.("Loading world…");
    await app.loadProjectFromUrl(DEFAULT_WORLD_URL);
    return { name: "world.v3proj", loaded: true };
  } catch (err) {
    console.warn(`${LOG} Default world load failed:`, err);
    return { name: "procedural default", loaded: false };
  }
}

/** Load a project from a served URL (e.g. ?world=/maps/foo.v3proj). */
export async function loadWorldFromUrl(app, url, { onStatus } = {}) {
  onStatus?.("Loading world…");
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch "${url}" (${res.status})`);
  const buf = await res.arrayBuffer();
  const name = url.split("/").pop() || url;
  return loadWorldFromBuffer(app, buf, { name, onStatus });
}

/** Load a .v3proj from raw bytes. Reloads the page when terrain size differs. */
export async function loadWorldFromBuffer(app, buf, { name = "project", onStatus } = {}) {
  if (!isProjectFile(buf)) throw new Error("Not a .v3proj file.");
  const d = decodeProjectFile(buf);
  const t = d.terrain ?? {};
  if (terrainMismatch(t)) {
    const ok = window.confirm(
      `This project is a ${Math.round(t.worldSize)} m world (${t.heightmapSize}², max ${Math.round(t.maxHeight)} m).\n`
      + "Reload the game at that terrain size to open it?",
    );
    if (!ok) return { name, loaded: false, reloaded: false };
    saveTerrainConfig(t);
    sessionStorage.setItem(PENDING_KEY, name);
    await stashPendingHeightmap(buf);
    location.reload();
    return { name, loaded: false, reloaded: true };
  }
  onStatus?.(`Loading ${name}…`);
  await app.loadProjectFromBuffer(buf);
  return { name, loaded: true, reloaded: false };
}

/** Load a .v3proj File from a file picker or drag-and-drop. */
export async function loadWorldFromFile(app, file, opts = {}) {
  const buf = await file.arrayBuffer();
  return loadWorldFromBuffer(app, buf, { name: file.name, ...opts });
}

/** Resolve the boot world: stashed reload, explicit ?world= URL, else default. */
export async function loadBootWorld(app, { onStatus } = {}) {
  const pendingName = sessionStorage.getItem(PENDING_KEY);
  if (pendingName) {
    sessionStorage.removeItem(PENDING_KEY);
    onStatus?.(`Loading ${pendingName}…`);
    // startV3App imports the stashed buffer right after boot — AWAIT it, or the
    // track gets baked against pre-import terrain and the world swaps in under it.
    await (app.pendingWorldImport ?? new Promise((r) => setTimeout(r, 300)));
    return { name: pendingName, loaded: true };
  }

  const param = new URLSearchParams(location.search).get("world");
  if (param) {
    try {
      return await loadWorldFromUrl(app, param, { onStatus });
    } catch (err) {
      console.warn(`${LOG} ?world=${param} failed, using default:`, err);
    }
  }
  return loadDefaultWorld(app, { onStatus });
}
