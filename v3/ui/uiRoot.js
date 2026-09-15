/**
 * Where the engine finds its editor interface elements.
 *
 * The editor page: in the page itself (`document`). A game that gives the
 * engine its own container: in a hidden copy of the editor markup that is never
 * attached to the page (v3/AUDIT.md #103). The editor code that still runs
 * during a game's boot then works on that copy — nothing appears on screen, and
 * the game page needs none of editor.html. As editor code moves out of the
 * game's boot, the copy shrinks to nothing and goes away.
 *
 * Every lookup of an editor element by id or selector goes through here, never
 * `document` directly. Elements the engine adds to `document.body` itself
 * (overlays, HUDs) are not editor markup and are looked up normally.
 */

let root = null;

/** `document`, or a detached element holding the editor markup. */
export function setUiRoot(r) {
  root = r;
}

export function uiById(id) {
  if (!root || root === document) return document.getElementById(id);
  return root.querySelector(`#${CSS.escape(id)}`);
}

export function uiQuery(selector) {
  return (root ?? document).querySelector(selector);
}

export function uiQueryAll(selector) {
  return (root ?? document).querySelectorAll(selector);
}

/**
 * A detached, never-attached copy of the editor page's `#app` markup, for a
 * game's boot. Loaded on demand so the editor never downloads it twice.
 */
export async function createHiddenEditorMarkup() {
  const { default: html } = await import("../editor.html?raw");
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const app = parsed.getElementById("app");
  if (!app) throw new Error("v3/editor.html has no #app");
  // Adopted into THIS document (canvases get contexts, events work) but never
  // attached: nothing renders, nothing takes input.
  return document.importNode(app, true);
}
