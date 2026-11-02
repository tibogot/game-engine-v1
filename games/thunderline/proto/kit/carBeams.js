// THE CAR'S VISIBLE BEAMS (user, 2026-11-02: "that light don't really look realistic … my old car game … a lab where I
// was using some volumetric light for the car"): the old game's beams (modular-road-v3 modularRoadHeadlightBeam.js and its
// headlight-lab.html) on our car — light scattered IN THE AIR along each headlamp's cone (a short march along the view
// ray inside a hull cone, clipped by the scene's depth), and a glare flare on each lens. The pool on the road stays the
// vehicle's two spot lights (HEADLIGHTS); the cone, the colour and the aim are read from them, so haze and pool agree.
//
// COST (measured in the old game, both lamps, chase camera): ~0.6 ms floor (half of it the depth copy) + ~0.03 ms a step:
// 12 steps ≈ 0.9 ms, + 4 draws. Only while the headlights are on: by day the beams and flares are hidden.
import { createHeadlightBeams } from "../../../modular-road-v3/modularRoadHeadlightBeam.js";
import { HEADLIGHTS } from "../../../../v3/play/modularRoadVehicle.js";
import { applyBloomMRT } from "../../../../v3/render/bloomMRT.js";

export const BEAM_FX = {
  // (thin: from the chase camera the view runs DOWN the cone, through all of its haze — at the old game's 0.55 / 0.42 it
  // read as a fog machine; from the front and the side it still shows)
  range: 45, // m of visible haze (the pool on the road reaches further; a long hull only costs pixels)
  media: 0.2, // how much is in the air
  intensity: 0.25,
  steps: 12,
  glare: true,
  glareSize: 1.3,
  glareIntensity: 1.1,
};

/** Beams on `vehicle`'s two lamp mounts (vehicle.headlampNodes). sync() after a HEADLIGHTS change, update() once a frame. */
export function createCarBeams(vehicle) {
  const beams = createHeadlightBeams({
    params: { ...BEAM_FX },
    // only the GLARE blooms: the haze through the selective bloom becomes a wash over the bonnet (the old game's finding)
    decorate: (material, kind, colorNode) => { if (kind === "glare") applyBloomMRT(material, colorNode); },
  });
  for (const node of vehicle.headlampNodes) beams.attach(node);
  let on = null, hullKey = "";
  function sync() {
    const B = beams.params;
    Object.assign(B, BEAM_FX);
    B.angle = HEADLIGHTS.angle;
    B.penumbra = HEADLIGHTS.penumbra;
    B.color = HEADLIGHTS.color;
    B.range = Math.min(BEAM_FX.range, HEADLIGHTS.distance);
    on = HEADLIGHTS.enabled;
    B.glare = BEAM_FX.glare && on;
    beams.applyParams();
    const key = `${B.angle}|${B.range}|${B.hullSpread}`;
    if (key !== hullKey) { hullKey = key; beams.rebuildHull(); }
    beams.setEnabled(on);
  }
  sync();
  return {
    beams, sync,
    update(dt, camera) {
      if (HEADLIGHTS.enabled !== on) sync(); // the switch (sky or L key) moved
      if (on) beams.update(dt, camera);
    },
    dispose: () => beams.dispose(),
  };
}
