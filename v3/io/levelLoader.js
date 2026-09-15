/**
 * Loading a level (.v3proj) into a game.
 *
 *   const levels = createLevelLoader(app, { defaultUrl: "/games/my-game/level.v3proj", onStatus });
 *   const boot = await levels.loadBoot();          // → { name, loaded }
 *   await levels.loadFile(fileFromAPicker);
 *
 * THE TERRAIN SIZE IS A BOOT DECISION. Heightmap resolution, world size and
 * max height are fixed when the engine starts, so a level of another size
 * cannot be swapped in live: its bytes are stashed (IndexedDB), the size is
 * saved, the page reloads at that size, and the engine imports the stash on
 * the next boot (`app.pendingWorldImport`). loadBoot() recognises that second
 * boot and waits for the import instead of loading the default over it.
 *
 * Every successful load ends with `app.refreshWorldHeights()`: rivers and lakes
 * carve the terrain after the project's own height sync, so without it the
 * first `getWorldHeight` calls read the pre-carve ground.
 *
 * No HEAD probe for the default level: Vite's dev server answers a missing
 * file with index.html and a 200, so "does it exist" is decided by reading the
 * bytes (isProjectFile), not the status.
 */
import { decodeProjectFile, isProjectFile } from "./projectIO.js";
import { saveTerrainConfig, HEIGHTMAP_SIZE, WORLD_SIZE, MAX_HEIGHT } from "../terrain/heightmapTexture.js";
import { stashPendingHeightmap } from "./pendingLoad.js";

/** True when a project's terrain differs from the size this page booted at. */
export function terrainSizeDiffers(t) {
  return t.heightmapSize !== HEIGHTMAP_SIZE
    || Math.round(t.worldSize) !== WORLD_SIZE
    || Math.round(t.maxHeight) !== MAX_HEIGHT;
}

/**
 * @param {object} app  the handle from startV3App
 * @param {object} [o]
 * @param {string} [o.defaultUrl]   the level loadBoot/loadDefault use
 * @param {(msg: string) => void} [o.onStatus]
 * @param {boolean | ((t: object, name: string) => boolean)} [o.confirmResize]
 *   For a level the PLAYER picks (loadFile, loadBuffer, loadUrl) of another
 *   terrain size: true (reload without asking), false (refuse), or a function
 *   (default: window.confirm). The game's own levels (loadBoot, loadDefault)
 *   always reload without asking — before this loader, a size mismatch there
 *   silently dropped the heightmap and left flat ground under the props.
 * @param {string} [o.urlParam]  query parameter naming a level to boot, "world" by default; null to ignore
 */
export function createLevelLoader(app, {
  defaultUrl = null,
  onStatus = () => {},
  confirmResize = askToReload,
  urlParam = "world",
} = {}) {
  // Per page, so two games on one origin never pick up each other's reload.
  const pendingKey = `v3.pendingLevel:${location.pathname}`;
  const nameOf = (url) => url.split("/").pop() || url;

  async function finish(name) {
    await app.refreshWorldHeights?.();
    return { name, loaded: true };
  }

  async function loadBuffer(buf, { name = "level", ask = confirmResize } = {}) {
    if (!isProjectFile(buf)) throw new Error(`"${name}" is not a .v3proj file.`);
    const t = decodeProjectFile(buf).terrain ?? {};
    if (terrainSizeDiffers(t)) {
      const ok = typeof ask === "function" ? ask(t, name) : !!ask;
      if (!ok) return { name, loaded: false };
      saveTerrainConfig(t);
      sessionStorage.setItem(pendingKey, name);
      await stashPendingHeightmap(buf);
      location.reload();
      // The page is going away: never resolve, so a booting game does not go on
      // placing its world on the old terrain while the reload is in flight.
      return new Promise(() => {});
    }
    onStatus(`Loading ${name}…`);
    await app.loadProjectFromBuffer(buf);
    return finish(name);
  }

  async function loadUrl(url, { ask = confirmResize } = {}) {
    onStatus("Loading level…");
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch "${url}" (${res.status})`);
    return loadBuffer(await res.arrayBuffer(), { name: nameOf(url), ask });
  }

  async function loadFile(file) {
    return loadBuffer(await file.arrayBuffer(), { name: file.name });
  }

  /** The game's shipped level; `{ loaded: false }` (the procedural terrain stays) when it is missing or broken. */
  async function loadDefault() {
    if (!defaultUrl) return { name: "procedural default", loaded: false };
    try {
      return await loadUrl(defaultUrl, { ask: true });
    } catch (err) {
      console.warn(`[V3] Default level ${defaultUrl} not loaded:`, err);
      return { name: "procedural default", loaded: false };
    }
  }

  /** Boot: the level stashed across a size reload, else ?world=<url>, else the default. */
  async function loadBoot() {
    const pendingName = sessionStorage.getItem(pendingKey);
    if (pendingName) {
      sessionStorage.removeItem(pendingKey);
      onStatus(`Loading ${pendingName}…`);
      await app.pendingWorldImport;
      return finish(pendingName);
    }
    const param = urlParam ? new URLSearchParams(location.search).get(urlParam) : null;
    if (param) {
      try {
        return await loadUrl(param, { ask: true });
      } catch (err) {
        console.warn(`[V3] ?${urlParam}=${param} not loaded, using the default:`, err);
      }
    }
    return loadDefault();
  }

  return { loadBoot, loadDefault, loadUrl, loadFile, loadBuffer };
}

function askToReload(t, name) {
  return window.confirm(
    `"${name}" is a ${Math.round(t.worldSize)} m world (${t.heightmapSize}², max ${Math.round(t.maxHeight)} m).\n`
    + "Reload at that terrain size to open it?",
  );
}
