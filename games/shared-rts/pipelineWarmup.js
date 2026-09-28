// PIPELINE WARM-UP — build every GPU pipeline the game will need BEFORE the
// loading screen goes, instead of in the middle of the first fight.
// Shared by nam-rts and alg-rts (identical machinery; each game calls it at
// the end of its own boot). Moved here from games/nam-rts on 2026-09-28.
//
// WHY. WebGPU builds a render pipeline the first time a (material, geometry
// layout, pass) combination is drawn, and three builds the shader for it on
// the main thread at that moment. Most of the game's effects start hidden or
// empty — the fire mesh, the smoke, muzzle flashes, rockets, every unit type
// that is not on the field yet — so their pipelines were built on the frame
// the first flame, rocket or tank appeared: measured 2026-09-24, 26 pipelines
// built mid-fight, frames of 140-240 ms and one of 987 ms at the first contact.
//
// HOW. Everything the ENGINE put in the scene is recorded when the level has
// loaded (`snapshotEngineScene`); the ocean, the waterfalls, the editor's
// gizmos are hidden there too and must NOT be warmed — they are never drawn
// in the game, and warming them would only lengthen the boot. Everything else
// — what the GAME added, and the level's shown content — is switched on for
// two frames under
// the loading screen: visible, one instance, never frustum-culled. Those two
// frames draw the beauty pass and the shadow cascades, which is what builds
// the pipelines; then everything is put back exactly as it was. Instances
// that were empty draw at whatever matrix slot 0 holds — a degenerate or
// off-screen triangle behind the loading screen, which is all a pipeline
// needs.

/**
 * Everything in the scene right now: call once the level has loaded. The set
 * also remembers which of them were SHOWN then (`shownAtLoad`): those are the
 * level's real content (the river, the props), which the game draws — they
 * get warmed; what the engine had hidden (ocean, gizmos) does not.
 */
export function snapshotEngineScene(scene) {
  const seen = new Set();
  const shown = new Set();
  scene.traverse((o) => {
    seen.add(o);
    let vis = o.visible;
    for (let p = o.parent; p && vis; p = p.parent) vis = p.visible;
    if (vis) shown.add(o);
  });
  seen.shownAtLoad = shown;
  return seen;
}

const drawable = (o) => o.isMesh || o.isPoints || o.isSprite;

/**
 * Warm the game's hidden/empty drawables for `frames` frames, then restore.
 * @param {object} app  the engine app (scene, and its own render loop)
 * @param {Set<object>} engineObjects  from snapshotEngineScene
 * @returns {Promise<{ warmed: number, ms: number }>}
 */
export async function warmGamePipelines(app, engineObjects, { frames = 2 } = {}) {
  const t0 = performance.now();
  // EVERY drawable the game will draw, not only the hidden or empty ones:
  // something visible but OFF-SCREEN is frustum-culled at boot and never
  // drawn, so its pipeline was built on the frame the camera first reached
  // it — the "camera-jump freeze", measured 2026-09-25: 158-234 ms once per
  // new place (the river close up, the enemy HQ's props). The level's own
  // objects count when they were shown at load (the river, whose chunk
  // culling had it hidden from the base); what the engine hid stays out.
  const shownAtLoad = engineObjects.shownAtLoad ?? new Set();
  const targets = [];
  app.scene.traverse((o) => {
    if (!drawable(o)) return;
    if (engineObjects.has(o) && !shownAtLoad.has(o)) return;
    const emptyInstanced = o.isInstancedMesh && o.count === 0;
    const emptyGeo = o.geometry?.isInstancedBufferGeometry && o.geometry.instanceCount === 0;
    targets.push({ o, emptyInstanced, emptyGeo });
  });

  // First value seen for every (object, key) touched, to put back at the end.
  const original = new Map();
  const set = (o, key, value) => {
    let m = original.get(o);
    if (!m) original.set(o, (m = {}));
    if (!(key in m)) m[key] = o[key];
    o[key] = value;
  };
  // Applied at the start of EVERY render in the window, not once: the game's
  // own per-frame updates (the unit renderer's count/visible, the effects'
  // show/hide) run before the render and would switch these off again.
  const apply = () => {
    for (const { o, emptyInstanced, emptyGeo } of targets) {
      set(o, "visible", true);
      for (let p = o.parent; p; p = p.parent) set(p, "visible", true);
      set(o, "frustumCulled", false);
      if (emptyInstanced && o.count === 0) set(o, "count", 1);
      if (emptyGeo && o.geometry.instanceCount === 0) set(o.geometry, "instanceCount", 1);
    }
  };
  const scene = app.scene;
  const prevHook = scene.onBeforeRender;
  scene.onBeforeRender = function (...args) {
    apply();
    return prevHook.apply(this, args);
  };
  apply();
  // The engine's loop renders these frames; wait for them to be drawn.
  for (let i = 0; i < frames + 1; i++) await new Promise((r) => requestAnimationFrame(() => r()));
  scene.onBeforeRender = prevHook;
  // Put everything back (geometries are their own entries, for instanceCount).
  for (const [o, m] of original) for (const [key, value] of Object.entries(m)) o[key] = value;
  return { warmed: targets.length, ms: Math.round(performance.now() - t0) };
}
