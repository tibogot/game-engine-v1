// ALGERIA RTS ("Djebel") — boot: the v3 engine as a game, the Aurès map, the
// shared RTS camera and the Aurès light. No gameplay yet (games/alg-rts/TODO.md):
// this page is where the map and the new assets are judged, in the game's own
// light and camera rather than the editor's.
//
// Boot settings are nam-rts's, each measured there (games/nam-rts/namGame.js
// has the numbers): a fitted sun shadow instead of cascades, the lean terrain
// shader, top-3 layers + near/far tiling, the terrain drawn last.
//
// URL options: ?world=/levels/other.v3proj · ?light=flat (the engine's default
// light, to A/B) · ?fog=0
import { startV3App, createLevelLoader } from "../../v3/engine.js";
import { createRtsCamera } from "../shared-rts/rtsCamera.js";
import { placeShowroom } from "./showroom.js";
import { LAYOUT, VIEW_YAW } from "./layout.js";
import "../../v3/styles/editor.css";

const params = new URLSearchParams(location.search);

/**
 * THE AURÈS IN SUMMER. The war began here on 1 November 1954, but the look to
 * get right first is the one everybody pictures: a hard high sun on bare
 * ochre ground, shadows short and dark in the gullies, a sky bleached pale by
 * dust rather than blue. Latitude is the real one (35.2° N), so the sun's arc
 * is the Aurès's; mid-July, mid-afternoon.
 *
 * MEASURED (sRGB luma of the game area, play zoom, 2026-09-26):
 *                          mean   near-black   top 1%
 *   engine default light     57-76    9-21%     113-129   (a dark chocolate map)
 *   this light              118-140    0-3%     186-198
 * Bare ochre ground in a summer sun is the brightest frame of the two games
 * (nam's jungle sits at ~85): shade in the gullies stays dark, nothing else.
 * Needs skyMode "atmosphere" at boot — setWorldLight drives only that sky.
 */
export const AURES_LIGHT = {
  latitude: 35.2,
  dayOfYear: 196,
  timeOfDay: 15.2,
  // The sun carries the frame (nam's lesson: a sky-lit frame is flat), the
  // fill stays warm and low, exposure brings the mean back up.
  world: { dir: 4.8, skyFill: 0.4, hemi: 0.9, exposure: 1.45 },
  polish: { enabled: true, contrast: 1.12, saturation: 0.9, temperature: 0.16 },
  // Dust, not mist: a warm pale haze that eats the far ground and the plain.
  haze: { color: "#d9c6a4", density: 0.00055 },
};

/**
 * The plain outside the map, matched BY EYE to the textured soil beside it in
 * this light. Not the soil's mean albedo (#735a3e): a flat colour under this
 * warm sun goes orange, where the texture's stones and dust keep it a greyed
 * tan — so the match is greyer and lighter than the average. ao 0: the grid's
 * line darkening has no lines to explain on a flat plain.
 */
const PLAIN_COLOR = "#a39480";

export async function startAlgGame({ container, onStatus = () => {} } = {}) {
  onStatus("Starting engine…");
  const app = await startV3App({
    container,
    preloadPaintTextures: false,
    // The Atmosphere sky (3-LUT scattering). A game gets the old procedural
    // sky unless it asks, and setWorldLight below only drives this one.
    skyMode: "atmosphere",
    csm: { cascades: 2, maxFar: 300, enabled: false },
    light: { shadowNormalBias: 0.12 },
    terrainFeatures: { cursor: false, snow: false, baseStyle: "flat" },
    splatFeatures: { solo: false, layerBudget: 6, topK: 3, farBlend: true },
  });
  app.setFrameThrottle?.(1000);

  const levels = createLevelLoader(app, { defaultUrl: "/levels/alg-aures.v3proj", onStatus });
  const boot = await levels.loadBoot();

  // Terrain last among the opaque things (nam-rts: the dearest shader, drawn
  // first, was shaded under everything and then covered).
  for (const m of app.getTerrainMeshes?.() ?? []) m.renderOrder = 8;

  app.postFx?.setEnabled(true);
  app.postFx?.setBloomSelective(true);
  app.postFx?.setBloom({ enabled: true, strength: 0.85, threshold: 0.0, radius: 0.5 });
  app.shadows?.setEnabled?.(false);   // the fitted frustum, not cascades (nam-rts measured)

  // The plain outside the heightmap is bare ground: soil, not the editor's white.
  app.setGroundBase?.({ baseColor: PLAIN_COLOR, lineColor: PLAIN_COLOR, ao: 0 });

  if (params.get("light") !== "flat") applyAuresLight(app);

  // The new assets, on the map, until gameplay places them (showroom.js).
  if (params.get("showroom") !== "0") {
    onStatus("Placing assets…");
    app.showroom = await placeShowroom(app);
  }

  onStatus("Setting up camera…");
  const rtsCamera = createRtsCamera({ app });
  rtsCamera.setMode("rts");
  // Start over the playable side's base (layout.js).
  const base = LAYOUT.sites.find((s) => s.kind === "french");
  if (base) {
    rtsCamera.focusOn(base.x, base.z);
    // Look toward the ALN, not at our own edge; the buildings face this view.
    rtsCamera.setYaw(VIEW_YAW);
  }
  app.rtsCamera = rtsCamera;
  app.addPreRenderHook((dt) => rtsCamera.update(dt));
  // C: RTS camera ⇄ free orbit. nam binds this in its dev panel; this game
  // has none yet. Matched on the printed key (AZERTY keyboards).
  window.addEventListener("keydown", (e) => {
    if (e.repeat || e.target.matches?.("input, textarea")) return;
    if (e.key?.toLowerCase() === "c") rtsCamera.toggle();
  });

  app.setFrameThrottle?.(0);
  const hud = document.getElementById("hud");
  if (hud) hud.textContent = `${boot.loaded ? boot.name : "no level"} · WASD pan · wheel zoom · Q/E rotate · C orbit`;
  return app;
}

export function applyAuresLight(app, L = AURES_LIGHT) {
  app.sky?.set?.({ latitude: L.latitude, dayOfYear: L.dayOfYear });
  app.sky?.setTimeOfDay?.(L.timeOfDay);
  app.sky?.setWorldLight?.(L.world);
  app.postFx?.setPolish?.(L.polish);
  if (params.get("fog") === "0") return;
  app.fog?.setHeight?.({ enabled: false });
  // matchSky: the haze takes the horizon's colour, so the plain beyond the map
  // dissolves into the sky behind it instead of ending on a line.
  app.fog?.setDistance?.({ enabled: true, matchSky: true, color: L.haze.color, density: L.haze.density });
}
