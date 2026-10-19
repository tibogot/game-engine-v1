// Thunderline's CAR EFFECTS — one module for the drive page and the FX lab (fx-lab.html), so what is tuned
// in the lab is what the game shows. Today they are Apex Rush's (games/modular-road-v3, the parts bin),
// driven by the same Vehicle the old game drove:
//   - tyre smoke: the flipbook look (wispy atlases, sphere puffs, the lingering bank) or the procedural
//     one, + the EXHAUST from the same pool (its pipes placed on our car's tail)
//   - sparks where the chassis scrapes a rail or wall
//   - tyre marks
// Lit by the engine's own sun and sky every frame.
import * as THREE from "three";
import { ModularRoadDriftSmoke, DEFAULT_DRIFT_SMOKE_SETTINGS } from "../../../modular-road-v3/modularRoadDriftSmoke.js";
import { FlipbookDriftSmoke, DEFAULT_FLIPBOOK_SETTINGS, loadSmokeAtlases, copyDriftSmokeState } from "../../../modular-road-v3/modularRoadDriftSmokeFlipbook.js";
import { ModularRoadSparks, DEFAULT_SPARK_SETTINGS } from "../../../modular-road-v3/modularRoadSparks.js";
import { ModularRoadTireMarks } from "../../../modular-road-v3/modularRoadTireMarks.js";

/**
 * @param app  the v3 app (scene, camera, light)
 * @param rig  createDriveRig's handle (vehicle, engine, keys, lastInput)
 * @param o.exhaust  pipe placement on THIS car, chassis frame (m): { pipeSide, pipeUp, pipeBack }
 */
export function createCarFx(app, rig, o = {}) {
  const { scene, camera } = app;
  const vehicle = rig.vehicle;
  const smokeSettings = structuredClone(DEFAULT_DRIFT_SMOKE_SETTINGS);
  if (smokeSettings.exhaust && o.exhaust) Object.assign(smokeSettings.exhaust, o.exhaust);
  const flipSettings = structuredClone(DEFAULT_FLIPBOOK_SETTINGS);
  const atlases = loadSmokeAtlases().textures;
  const looks = { flipbook: new FlipbookDriftSmoke(scene, smokeSettings, atlases, flipSettings), procedural: null };
  let smoke = looks.flipbook, look = "flipbook";
  smoke.setSprayEnabled?.(false); // the stunt roads are dry
  const sparks = new ModularRoadSparks(scene, { ...DEFAULT_SPARK_SETTINGS });
  const marks = new ModularRoadTireMarks(scene);
  const on = { smoke: true, exhaust: true, sparks: true, marks: true };

  const _dir = new THREE.Vector3();
  let lastShifting = 0;
  function syncLight() {
    _dir.copy(app.light.getDirection());
    if (_dir.lengthSq() > 1e-8) smoke.setSunDirection(_dir.normalize());
    const sun = app.light.sun, hemi = app.light.hemi;
    if (sun) smoke.setSunColor(sun.color, sun.intensity);
    if (hemi) smoke.setAmbientColors(hemi.color, hemi.groundColor);
  }

  return {
    get smoke() { return smoke; }, sparks, marks, smokeSettings, flipSettings,
    get look() { return look; },
    get on() { return { ...on }; },
    /** "flipbook" | "procedural" — the live plume carries over (an A/B of the same smoke) */
    setLook(kind) {
      if (kind === look || !(kind in looks)) return;
      looks[kind] ??= new ModularRoadDriftSmoke(scene, smokeSettings);
      const prev = smoke, next = looks[kind];
      copyDriftSmokeState(prev, next);
      prev.setVisible(false);
      prev.reset();
      next.setVisible(true);
      next.setSprayEnabled?.(false);
      smoke = next;
      look = kind;
      syncLight();
    },
    set(name, value) {
      on[name] = !!value;
      if (name === "smoke") smoke.setSmokeEnabled(on.smoke);
      if (name === "exhaust") smoke.setExhaustEnabled(on.exhaust);
      if (name === "sparks") { sparks.settings.enabled = on.sparks; if (!on.sparks) sparks.reset(); }
      if (name === "marks") { marks.mesh.visible = on.marks; if (!on.marks) marks.reset(); }
    },
    reset() { smoke.reset(); sparks.reset(); marks.reset(); },
    /** After the drive rig's frame (the car and the chase camera are where this frame draws them). */
    update(dt) {
      syncLight();
      const s = rig.engine?.s;
      const shifted = !!s && s.shifting > 0 && lastShifting <= 0;
      lastShifting = s?.shifting ?? 0;
      smoke.setEngine(Math.max(0, rig.lastInput?.throttle ?? 0), s?.rpm ?? 0, shifted);
      smoke.updateFromVehicle(vehicle, camera, dt, { Space: !!rig.lastInput?.handbrake });
      sparks.updateFromVehicle(vehicle, camera, dt);
      if (on.marks) marks.update(vehicle);
    },
    /** Live counts, for the lab's readout. */
    stats() {
      const alive = (pool) => (pool ?? []).reduce((n, p) => n + (p.life > 0 ? 1 : 0), 0);
      return { puffs: alive(smoke.particles), sparks: alive(sparks.particles) };
    },
  };
}
