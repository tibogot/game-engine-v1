// Base flag — the v3 props Verlet cloth flag, scaled up and planted by the HQ.
//
// This is the ENGINE's flag (v2/core/props/flagFactory.js via v3/props/liveProps.js),
// not a reimplementation: a real particle/constraint cloth sim with wind. All this
// file does is size it for RTS scale, plant it beside the base on the camera side,
// and expose a texture swap for the dev panel.
import { createFlag } from "../../v3/props/liveProps.js";

// RTS scale: the prop defaults are ~4 m tall (character scale). The base hangar is
// 13 m tall, so the flag is sized to stand alongside it and read from RTS zoom.
const FLAG_PARAMS = {
  poleHeight: 30,
  poleRadius: 0.32,
  clothWidth: 11,
  clothHeight: 6.5,
  xSegs: 12,   // a bigger cloth needs a few more segments to fold nicely
  ySegs: 9,
  flagColor: "#c8322d",
  windIntensity: 300,
  windSpeed: 1000,
  windDirection: 0,
  showPole: true,
};

/**
 * Plant the flag near the base.
 *
 * `offset` is in base-local terms: +X is to the side, -Z is toward the CAMERA
 * (the RTS view looks up the map), so the default puts it front-right of the HQ
 * where you can actually see it, clear of the hangar door in the centre.
 */
export function createBaseFlag({ app, structures, offset = { x: 30, z: -16 } }) {
  const b = structures.base?.position;
  if (!b) return null;

  const flag = createFlag(FLAG_PARAMS);
  const x = b.x + offset.x;
  const z = b.z + offset.z;
  flag.group.position.set(x, app.getWorldHeight?.(x, z) ?? 0, z);
  app.scene.add(flag.group);

  let objectUrl = null;   // revoked when replaced — imported images are blob: URLs
  let hasTexture = false; // tracked here: the factory's getParams().textureUrl is stale

  // The cloth material multiplies colour × map, so a tinted flag would stain an
  // imported image (a red flag makes every photo red). Applying an image drops the
  // tint to white so the picture reads true; clearing it restores the flag colour.
  const applyTexture = (url) => {
    hasTexture = !!url;
    flag.setParam("flagColor", hasTexture ? "#ffffff" : FLAG_PARAMS.flagColor);
    flag.setParam("textureUrl", url);
  };

  return {
    group: flag.group,
    /** Verlet step — called from the game loop. */
    update(dt) { flag.update(dt); },

    /** Point the flag at an image URL (http(s):, data:, or blob:). */
    setTextureUrl(url) { applyTexture(url); },

    /** Dev panel: swap the cloth texture from a picked File. */
    setTextureFile(file) {
      if (!file) return;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = URL.createObjectURL(file);
      applyTexture(objectUrl);
    },

    /** Back to a flat colour (drops any imported image). */
    clearTexture() {
      applyTexture("");
      if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
    },

    /** The tint the cloth is currently using (dev panel keeps its picker in sync). */
    currentColor: () => (hasTexture ? "#ffffff" : FLAG_PARAMS.flagColor),

    setParam: (k, v) => flag.setParam(k, v),
    getParams: () => flag.getParams(),

    dispose() {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      app.scene.remove(flag.group);
      flag.dispose();
    },
  };
}
