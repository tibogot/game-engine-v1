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
  clothWidth: 12.35,   // 1.9 : 1, the US flag's own proportion
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
 * The US flag of the war years (50 stars from July 1960), drawn to the
 * federal specification (Executive Order 10834): hoist 1, fly 1.9, thirteen
 * stripes, a union 7 stripes deep and 0.76 of the hoist wide, 50 stars in nine
 * rows alternating six and five. Drawn, not downloaded: exact at any size,
 * nothing to ship. Returns a PNG data: URL for the cloth's texture slot.
 */
export function drawUsFlagDataUrl(hoistPx = 520) {
  const H = hoistPx, W = Math.round(H * 1.9);
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const g = c.getContext("2d");
  const stripe = H / 13;
  for (let i = 0; i < 13; i++) {
    g.fillStyle = i % 2 === 0 ? "#b22234" : "#ffffff";
    g.fillRect(0, Math.round(i * stripe), W, Math.ceil(stripe) + 1);
  }
  const uw = H * 0.76, uh = stripe * 7;
  g.fillStyle = "#3c3b6e";
  g.fillRect(0, 0, uw, uh);
  // Stars: 11 column steps across (E/12 = 0.063), 10 row steps down (F/10 =
  // 0.054); rows of six on even rows, five offset on odd. Diameter 0.0616.
  const star = (cx, cy, r) => {
    g.beginPath();
    for (let k = 0; k < 10; k++) {
      const a = -Math.PI / 2 + (k * Math.PI) / 5;
      const rr = k % 2 === 0 ? r : r * 0.382;
      g.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
    }
    g.closePath(); g.fill();
  };
  g.fillStyle = "#ffffff";
  const r = (H * 0.0616) / 2;
  for (let row = 0; row < 9; row++) {
    const y = (row + 1) * (uh / 10);
    const odd = row % 2 === 1;
    for (let col = 0; col < (odd ? 5 : 6); col++) {
      const x = (2 * col + (odd ? 2 : 1)) * (uw / 12);
      star(x, y, r);
    }
  }
  return c.toDataURL("image/png");
}

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
  const plant = () => {
    const base = structures.base.position; // base may move when re-seated
    const x = base.x + offset.x;
    const z = base.z + offset.z;
    flag.group.position.set(x, app.getWorldHeight?.(x, z) ?? 0, z);
  };
  plant();
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
  applyTexture(drawUsFlagDataUrl());

  return {
    group: flag.group,
    /** Verlet step — called from the game loop. */
    update(dt) { flag.update(dt); },

    /** Re-plant beside the base on the current terrain (after a world load). */
    reanchor: plant,

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
