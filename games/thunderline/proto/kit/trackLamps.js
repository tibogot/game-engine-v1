// THE TRACK'S LAMPS AT NIGHT (user, 2026-11-01: "the scenery could be important, especially the street lights for a night
// time track"): every placed prop whose kind has `lights` (obstacles.js: the Street lights) gets real point lights from
// the engine's pool (app.localLights: tiled, no shadows — v3/render/lighting/localLights.js), at its lamp heads. They
// follow the sky: off by day, up to full through dusk into night (app.sky.night). One manager per page: sync() when the
// track's props change; it updates itself each frame (a few numbers: no allocation, nothing while nothing changes).
import * as THREE from "three";
import { OBSTACLES, shapeOf, streetLensMaterial } from "./obstacles.js";

export function createTrackLamps(app) {
  const L = app.localLights;
  let lamps = []; // { h: pool handle, cd }
  let lastNight = -1;
  const _p = new THREE.Vector3(), _M = new THREE.Matrix4();

  function sync(props = []) {
    for (const l of lamps) l.h.remove();
    lamps = [];
    lastNight = -1;
    if (!L) return;
    for (const p of props) {
      const def = OBSTACLES[p.kind];
      if (!def?.lights) continue;
      _M.fromArray(p.M);
      for (const l of shapeOf(p.kind, p).lights) {
        _p.set(l.x, l.y, l.z).applyMatrix4(_M);
        lamps.push({ h: L.add({ position: _p, color: l.color, intensity: 0, range: l.range, importance: 1 }), cd: l.cd });
      }
    }
  }
  function update() {
    const night = app.sky?.night ?? 0;
    if (Math.abs(night - lastNight) < 1e-3) return;
    lastNight = night;
    for (const l of lamps) l.h.set({ intensity: l.cd * night });
    streetLensMaterial().emissiveIntensity = 0.25 + 3.5 * night; // (the lenses glow with it)
  }
  const tick = () => { update(); requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  return { sync, update, get count() { return lamps.length; } };
}
