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
 * The FLN / ALN flag, 2:3: green at the hoist, white at the fly, and across
 * the join a red crescent opening toward the fly with a red five-pointed star
 * inside it. Returns a PNG data: URL.
 */
export function drawFlnDataUrl(hoistPx = 400) {
  const H = hoistPx, W = Math.round(H * 1.5);
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const g = c.getContext("2d");
  g.fillStyle = "#1f6b3a"; g.fillRect(0, 0, W / 2 + 1, H);
  g.fillStyle = "#ece8dc"; g.fillRect(W / 2, 0, W / 2, H);
  // Crescent: a red disc with an off-centre disc cut out of it (toward the fly).
  const cx = W / 2, cy = H / 2, R = H * 0.25;
  g.fillStyle = "#c8202a";
  g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.fill();
  g.globalCompositeOperation = "destination-out";
  g.beginPath(); g.arc(cx + R * 0.26, cy, R * 0.8, 0, Math.PI * 2); g.fill();
  g.globalCompositeOperation = "source-over";
  // Re-paint the cut with the field behind it (green left of the join, white right).
  g.save();
  g.beginPath(); g.arc(cx + R * 0.26, cy, R * 0.8, 0, Math.PI * 2); g.clip();
  g.fillStyle = "#1f6b3a"; g.fillRect(0, 0, W / 2 + 1, H);
  g.fillStyle = "#ece8dc"; g.fillRect(W / 2, 0, W / 2, H);
  g.restore();
  // Star, inside the crescent's opening.
  const sx = cx + R * 0.42, r = R * 0.34;
  g.fillStyle = "#c8202a";
  g.beginPath();
  for (let k = 0; k < 10; k++) {
    const a = -Math.PI / 2 + (k * Math.PI) / 5 + Math.PI / 10;
    const rr = k % 2 === 0 ? r : r * 0.4;
    g.lineTo(sx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
  }
  g.closePath(); g.fill();
  return c.toDataURL("image/png");
}

/**
 * Plant a cloth flag on a kit building's `userData.flagMount`
 * ({ pos, poleHeight } in its local frame). `mesh` is the placed building.
 * Returns { group, update(dt) } — update is the cloth's Verlet step.
 */
export function plantPostFlag(app, mesh, mount, textureUrl = drawTricoloreDataUrl()) {
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
  flag.setParam("textureUrl", textureUrl);
  app.scene.add(flag.group);
  return {
    group: flag.group,
    update: (dt) => flag.update(dt),
    /** Follow the game's wind (algWind.js): direction in degrees, strength 0..1. */
    setWind: (dirDeg, strength) => {
      flag.setParam("windDirection", dirDeg);
      flag.setParam("windIntensity", 40 + 520 * strength);
    },
    dispose: () => { app.scene.remove(flag.group); flag.dispose(); },
  };
}
