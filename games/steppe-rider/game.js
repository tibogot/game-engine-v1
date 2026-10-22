// STEPPE RIDER — the horse game (side project; user, 2026-10-21). Built like the other games: the
// engine (startV3App) loads an editor level, the game adds what is played — here the horse lab's
// riding (v3/horse-lab/kit.js): the horse and the rider on the level's REAL TERRAIN.
// First world: public/levels/steppe.v3proj (tools/steppeLevel.mjs) — a test course on the grid
// ground (ramps 5–30°, a cross slope, rolling hills, moguls, ditches, a ridge, a bowl, a big hill)
// with far mountains on the horizon. Texturing, grass and rivers come later.
import { startV3App, createLevelLoader } from "../../v3/engine.js";
import { createRidingKit } from "../../v3/horse-lab/kit.js";
import { SPOTS } from "./spots.js";

const DEFAULT_LEVEL = "/levels/steppe.v3proj";

export async function startSteppeRider({ container, hud, onStatus = () => {} } = {}) {
  const params = new URLSearchParams(location.search);
  onStatus("Starting engine…");
  const app = await startV3App({
    container,
    skyMode: "skypro",
    cloudShadows: true,
    terrainFeatures: { cursor: false },
    splatFeatures: { solo: false },
    preloadPaintTextures: false,
  });
  const levels = createLevelLoader(app, { defaultUrl: DEFAULT_LEVEL, onStatus });
  const level = await levels.loadBoot();

  // the light: an afternoon sun (?tod=<hour>)
  const tod = Number(params.get("tod"));
  app.sky?.setMode?.("skypro");
  app.sky?.setTimeOfDay?.(params.has("tod") && Number.isFinite(tod) ? tod : 15.5);

  // the level for the horse: the terrain is the ground (no meshes yet)
  const world = {
    ground: [], blockers: [],
    heightAt: (x, z) => app.getWorldHeight(x, z),
    normalAt: (x, z) => { const n = app.getWorldNormal(x, z); return n ? { x: n.x, y: n.y, z: n.z } : null; },   // (a shared vector: copied)
  };
  // the game owns the camera: the orbit controls only look where the kit says
  app.controls.enabled = false;
  const kit = await createRidingKit({
    scene: app.scene, renderer: app.renderer, camera: app.camera, controls: app.controls, world,
    spawn: SPOTS.spawn, riderKind: params.get("rider") === "ybot" ? "ybot" : "robot", onStatus,
  });
  app.addPreUpdateHook(function steppeRider(dt) { kit.update(dt); });

  // ── the HUD: what the horse does, and a teleport to each piece of the course ──
  let statLine = null;
  if (hud) {
    const title = document.createElement("div");
    title.textContent = `Steppe rider · ${level.loaded ? level.name : "no level"}`;
    statLine = document.createElement("div");
    statLine.className = "stat";
    hud.append(title, statLine);
    SPOTS.pieces.forEach((p, i) => {
      const b = document.createElement("button");
      b.textContent = `${i < 9 ? i + 1 + "  " : ""}${p.label}`;
      b.onclick = () => { go(p); b.blur(); };
      hud.append(b);
    });
    const help = document.createElement("div");
    help.className = "note";
    help.textContent = "Click: mouse = camera (Esc frees) · W A S D relative to the camera · tap Shift faster, X slower, hold Shift gallop · Space jump · F off / on · V bow · L lance · C free camera (the horse keeps its line) · , slow motion · P pause";
    hud.append(help);
  }
  const go = (p) => {
    if (kit.rider.mode !== "riding") return;
    kit.placeAt(p);
  };
  // (the physical keys 1-9 or the numpad: on AZERTY the top row types & é " ' … without Shift)
  addEventListener("keydown", (e) => { const n = +(/^(?:Digit|Numpad)(\d)$/.exec(e.code)?.[1] ?? e.key); if (n >= 1 && n <= 9 && SPOTS.pieces[n - 1] && !e.repeat) go(SPOTS.pieces[n - 1]); });
  let t = 0;
  app.addPreUpdateHook(function steppeHud(dt) {
    t += dt;
    if (!statLine || t < 0.2) return;
    t = 0;
    const s = kit.status();
    statLine.textContent = `${s.gear} · ${s.gait} · ${s.speed.toFixed(1)} m/s · pitch ${s.pitchDeg.toFixed(0)}° roll ${s.rollDeg.toFixed(0)}°${s.note ? " · " + s.note : ""}`;
  });

  return { app, kit, level };
}
