// The tricolour on the French post — the engine's Verlet cloth flag
// (v3/props/liveProps.js createFlag), the same one nam-rts flies over its
// base (games/nam-rts/baseFlag.js), planted on the post's flagMount and
// drawn with a tricolour texture.
import { createFlag } from "../../v3/props/liveProps.js";

/**
 * The tricolour, 2:3, vertical bands of equal width: blue at the hoist,
 * white, red — the army's faded paint colours, not screen primaries.
 * Returns a PNG data: URL for the cloth's texture slot.
 */
export function drawTricoloreDataUrl(hoistPx = 400) {
  const H = hoistPx, W = Math.round(H * 1.5);
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const g = c.getContext("2d");
  ["#1f3f8f", "#ece8dc", "#c1272d"].forEach((col, k) => {
    g.fillStyle = col;
    g.fillRect(Math.round((k * W) / 3), 0, Math.ceil(W / 3) + 1, H);
  });
  return c.toDataURL("image/png");
}

/**
 * Plant a cloth tricolour on a kit building's `userData.flagMount`
 * ({ pos, poleHeight } in its local frame). `mesh` is the placed building.
 * Returns { group, update(dt) } — update is the cloth's Verlet step.
 */
export function plantPostFlag(app, mesh, mount) {
  const flag = createFlag({
    poleHeight: mount.poleHeight,
    poleRadius: 0.12,
    // 2:3, a garrison flag's size for a 13 m pole.
    clothWidth: 3.6,
    clothHeight: 2.4,
    xSegs: 12, ySegs: 8,
    flagColor: "#ffffff",
    windIntensity: 300,
    windSpeed: 1000,
    windDirection: 0,
    showPole: true,
  });
  mesh.updateMatrixWorld(true);
  const p = mesh.localToWorld(flag.group.position.set(...mount.pos).clone());
  flag.group.position.copy(p);
  flag.setParam("textureUrl", drawTricoloreDataUrl());
  app.scene.add(flag.group);
  return { group: flag.group, update: (dt) => flag.update(dt), dispose: () => { app.scene.remove(flag.group); flag.dispose(); } };
}
