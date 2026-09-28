// THE ALGERIA GAME'S MINIMAP — own file (copy of nam-rts/minimap.js, 2026-09-27).
// RTS minimap — GAME UI (player-facing). The HUD bar's left slot (hudBar.js),
// adapted from the rts-chibs minimap to the v3 engine handle.
//
//   • Locked until the player builds a Radio Station (CoH intel gate): the
//     slot shows a dead screen stamped NO RADIO, not a line of floating text.
//   • Bakes the terrain once (height shading + slope for cliffs + water tint).
//   • FoW shroud overlay when fog of war is active.
//   • Each frame draws unit blips and the camera's ground footprint rectangle.
//   • Click / drag to move the RTS camera there.
//   • ORIENTED LIKE COMPANY OF HEROES: up on the minimap = the start camera's
//     forward (`upYaw`, layout.js VIEW_YAW), so our post sits at the BOTTOM and
//     the enemy at the top. The world square is diagonal to that view here, so
//     the map shows as a turned square with dark corners (never cropped).
import * as THREE from "three";

const BAKE_RES = 160;
const VIEW_PX  = 160;   // fills the HUD bar's left slot

const _plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const _ray = new THREE.Raycaster();
const _ndc = new THREE.Vector2();
const _hit = new THREE.Vector3();
const _NDC_CORNERS = [[-1, -1], [1, -1], [1, 1], [-1, 1]];

function lerpRgb(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/**
 * World ↔ minimap for a map turned so world direction (sin upYaw, cos upYaw)
 * points up. Right on the minimap = the camera's screen-right, (-cos, sin).
 * It frames `area` (the PLAYABLE box, {x0, x1, z0, z1}; the world by default)
 * scaled so the whole turned square fits the canvas. `world`: the terrain's
 * edge (the fog of war's image covers all of it).
 */
function makeFrame(area, upYaw, px, world) {
  const fx = Math.sin(upYaw), fz = Math.cos(upYaw), rx = -fz, rz = fx;
  const cx = (area.x0 + area.x1) / 2, cz = (area.z0 + area.z1) / 2;
  const size = Math.max(area.x1 - area.x0, area.z1 - area.z0);
  const k = px / (size * (Math.abs(fx) + Math.abs(fz)));   // world m → minimap px
  const c = px / 2;
  return {
    area,
    toMini: (x, z) => ({ x: c + ((x - cx) * rx + (z - cz) * rz) * k, y: c - ((x - cx) * fx + (z - cz) * fz) * k }),
    toWorld: (mx, my) => {
      const u = (mx - c) / k, v = (c - my) / k;
      return { x: cx + rx * u + fx * v, z: cz + rz * u + fz * v };
    },
    upYaw,
    /**
     * The canvas transform that draws a WORLD-ALIGNED image of the whole map
     * (the fog of war's miniCanvas: pixel (u, v) = world x = map/2 − u·m,
     * z = map/2 − v·m, m = map / its width) onto this turned minimap.
     */
    worldImageTransform(imgPx) {
      const m = world / imgPx, h = world / 2;
      return [-k * m * rx, k * m * fx, -k * m * rz, k * m * fz,
        c + k * ((h - cx) * rx + (h - cz) * rz), c - k * ((h - cx) * fx + (h - cz) * fz)];
    },
  };
}

function bakeTerrain(app, frame) {
  const res = BAKE_RES;
  const map = app.worldSize ?? 1000;
  const half = map * 0.5;
  const scale = VIEW_PX / res;
  const OFF = [22, 20, 16];      // beyond the map's edge
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = res;
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(res, res);
  const data = img.data;

  const worldOf = (px, py) => frame.toWorld((px + 0.5) * scale, (py + 0.5) * scale);
  // Inside the map AND the framed (playable) area; the rest reads as off-map.
  const A = frame.area;
  const inside = (w) => Math.abs(w.x) <= half && Math.abs(w.z) <= half && w.x >= A.x0 && w.x <= A.x1 && w.z >= A.z0 && w.z <= A.z1;

  const heights = new Float32Array(res * res);
  let minH = Infinity, maxH = -Infinity;
  for (let py = 0; py < res; py++) {
    for (let px = 0; px < res; px++) {
      const w = worldOf(px, py);
      if (!inside(w)) continue;
      const h = app.getWorldHeight(w.x, w.z);
      heights[py * res + px] = h;
      if (h < minH) minH = h;
      if (h > maxH) maxH = h;
    }
  }
  const span = Math.max(1, maxH - minH);
  // The Aurès: ochre valley floors going pale on the heights, the gullies and
  // cliffs a darker rust (nam's jungle greens replaced).
  const grassLow = [150, 118, 78], grassHigh = [196, 170, 128];
  const cliff = [118, 82, 56], cliffSteep = [92, 62, 44];
  const water = [52, 110, 104];   // oasis green-blue

  for (let py = 0; py < res; py++) {
    for (let px = 0; px < res; px++) {
      const i = py * res + px;
      const w = worldOf(px, py), wx = w.x, wz = w.z;
      const h = heights[i];
      let rgb;
      const wl = app.getWaterLevelAt ? app.getWaterLevelAt(wx, wz) : -Infinity;
      if (!inside(w)) rgb = OFF;
      else if (wl > h) rgb = water;
      else {
        const n = app.getWorldNormal(wx, wz);
        const slope = 1 - n.y;
        const hn = (h - minH) / span;
        rgb = slope > 0.18
          ? lerpRgb(cliff, cliffSteep, Math.min(1, (slope - 0.18) / 0.35))
          : lerpRgb(grassLow, grassHigh, hn);
      }
      const p = i * 4;
      data[p] = rgb[0]; data[p + 1] = rgb[1]; data[p + 2] = rgb[2]; data[p + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

export function createMinimap({ app, units, buildings = null, structures = null, fogOfWar = null, requisition = null, mount = document.body, intel = null, upYaw = 0, area = null }) {
  const map = app.worldSize ?? 1000;
  // upYaw = 0 is nam's old fixed layout (+z up, +x left). `area`: the
  // playable box the map frames (Sand & Blood's PLAY); the world by default.
  const box = area ?? { x0: -map / 2, x1: map / 2, z0: -map / 2, z1: map / 2 };
  const frame = makeFrame(box, upYaw, VIEW_PX, map);
  let terrain = bakeTerrain(app, frame);

  const root = document.createElement("div");
  root.id = "rts-minimap";
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = VIEW_PX;
  root.appendChild(canvas);
  mount.appendChild(root);

  const ctx = canvas.getContext("2d");

  const style = document.createElement("style");
  style.textContent = `
    #rts-minimap { width: 100%; height: 100%; }
    #rts-minimap canvas {
      width: 100%; height: 100%; display: block; cursor: crosshair;
      border: 1px solid var(--hud-edge-hi); border-radius: var(--hud-radius);
    }
    #rts-minimap.locked canvas { cursor: default; }
  `;
  document.head.appendChild(style);

  const worldToMini = frame.toMini;

  let dragging = false;
  const jump = (ev) => {
    const rect = canvas.getBoundingClientRect();
    const w = frame.toWorld((ev.clientX - rect.left) / rect.width * VIEW_PX, (ev.clientY - rect.top) / rect.height * VIEW_PX);
    app.rtsCamera?.focusOn?.(Math.max(box.x0, Math.min(box.x1, w.x)), Math.max(box.z0, Math.min(box.z1, w.z)));
  };
  const onDown = (e) => { if (!hasRadioIntel()) return; dragging = true; jump(e); e.preventDefault(); };
  const onMove = (e) => { if (dragging) jump(e); };
  const onUp = () => { dragging = false; };
  canvas.addEventListener("pointerdown", onDown);
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);

  // The Algeria game: the post has its own radio mast — the map from the
  // start. (nam locks it until a radio station is built.) Kept as a hook.
  function hasRadioIntel() {
    if (intel) return intel();
    if (!buildings?.list) return false;
    return buildings.list.some(
      (b) => b.alive && b.typeKey === "radio" && !b.constructing && b.built >= 1,
    );
  }

  function cameraFootprint() {
    const cam = app.camera;
    _plane.constant = -(app.controls?.target?.y ?? 0);
    const pts = [];
    for (const [nx, ny] of _NDC_CORNERS) {
      _ndc.set(nx, ny);
      _ray.setFromCamera(_ndc, cam);
      if (!_ray.ray.intersectPlane(_plane, _hit)) return null;
      pts.push({ x: _hit.x, z: _hit.z });
    }
    // The top corners of a low camera meet the ground near the horizon: cap
    // the far edge at 2.5x the near edge's reach, so the view reads as a
    // trapezoid (CoH), not a wedge across the whole map.
    const t = app.controls?.target ?? { x: 0, z: 0 };
    const near = Math.max(Math.hypot(pts[0].x - t.x, pts[0].z - t.z), Math.hypot(pts[1].x - t.x, pts[1].z - t.z));
    const cap = near * 2.5;
    for (const p of pts) {
      const d = Math.hypot(p.x - t.x, p.z - t.z);
      if (d > cap) { p.x = t.x + (p.x - t.x) * cap / d; p.z = t.z + (p.z - t.z) * cap / d; }
    }
    return pts;
  }

  function drawBlip(x, y, u) {
    const s = u.isAir ? 4 : 3.4;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(frame.upYaw - (u.heading ?? 0));   // world heading → turned map
    ctx.fillStyle = u.selected ? "#ffffff" : u.team === "enemy" ? "#ff6a5a" : (u.isAir ? "#63e0d0" : "#58a8ff");
    ctx.strokeStyle = "rgba(10,20,40,0.7)";
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(0, -s);
    ctx.lineTo(-s * 0.7, s * 0.8);
    ctx.lineTo(s * 0.7, s * 0.8);
    ctx.closePath();
    ctx.fill(); ctx.stroke();
    ctx.restore();
  }

  function drawCaptureNode(x, y) {
    ctx.save();
    ctx.translate(x, y);
    ctx.strokeStyle = "rgba(72,200,255,0.95)";
    ctx.fillStyle = "rgba(72,200,255,0.18)";
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(0, 0, 5, 0, Math.PI * 2);
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = "#48c8ff";
    ctx.fillRect(-1.5, -6, 3, 5);
    ctx.restore();
  }

  /** A requisition point: a diamond in its owner's colour, the capture as an arc round it. */
  function drawPoint(x, y, p) {
    const col = p.owner === "player" ? "#58a8ff" : p.owner === "enemy" ? "#ff6a5a" : "#d8cfae";
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = col;
    ctx.strokeStyle = "rgba(10,12,8,0.8)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, -4.5); ctx.lineTo(4.5, 0); ctx.lineTo(0, 4.5); ctx.lineTo(-4.5, 0);
    ctx.closePath(); ctx.fill(); ctx.stroke();
    if (Math.abs(p.progress) > 0.01 && Math.abs(p.progress) < 0.999) {
      ctx.strokeStyle = p.progress > 0 ? "#58a8ff" : "#ff6a5a";
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.arc(0, 0, 7, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.abs(p.progress));
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawHq(x, y, hostile) {
    ctx.fillStyle = hostile ? "#ff6a5a" : "#64d2ff";
    ctx.strokeStyle = hostile ? "rgba(255,106,90,0.95)" : "rgba(100,210,255,0.95)";
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.rect(x - 4.5, y - 4.5, 9, 9);
    ctx.fill();
    ctx.stroke();
  }

  /**
   * No radio, no map: a dead screen — faint static, scan lines and a stencil
   * stamp. Redrawn a few times a second so the static lives, not every frame.
   */
  let lockT = 0;
  function drawLocked() {
    const now = performance.now();
    if (now - lockT < 180) return;
    lockT = now;
    ctx.fillStyle = "#15170f";
    ctx.fillRect(0, 0, VIEW_PX, VIEW_PX);
    for (let i = 0; i < 420; i++) {
      const v = 30 + Math.random() * 40;
      ctx.fillStyle = `rgb(${v},${v + 4},${v - 6})`;
      ctx.fillRect(Math.random() * VIEW_PX, Math.random() * VIEW_PX, 1 + Math.random() * 2, 1);
    }
    ctx.fillStyle = "rgba(0,0,0,0.25)";
    for (let y = 0; y < VIEW_PX; y += 3) ctx.fillRect(0, y, VIEW_PX, 1);
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillStyle = "#8d8a78";
    ctx.font = "bold 15px 'Segoe UI', system-ui, sans-serif";
    ctx.fillText("NO  RADIO", VIEW_PX / 2, VIEW_PX / 2 - 8);
    ctx.font = "9px 'Segoe UI', system-ui, sans-serif";
    ctx.fillStyle = "#6b6a5c";
    ctx.fillText("BUILD A RADIO STATION", VIEW_PX / 2, VIEW_PX / 2 + 12);
  }

  function draw() {
    const intel = hasRadioIntel();
    root.classList.toggle("locked", !intel);
    if (!intel) { drawLocked(); return; }
    lockT = 0;

    ctx.clearRect(0, 0, VIEW_PX, VIEW_PX);

    ctx.drawImage(terrain, 0, 0, VIEW_PX, VIEW_PX);

    if (fogOfWar?.enabled && fogOfWar.miniCanvas) {
      // The shroud is world-aligned; turn it with the map.
      ctx.save();
      ctx.setTransform(...frame.worldImageTransform(fogOfWar.miniCanvas.width));
      ctx.drawImage(fogOfWar.miniCanvas, 0, 0);
      ctx.restore();
    }

    const pb = structures?.base;
    if (pb?.alive) {
      const { x, y } = worldToMini(pb.position.x, pb.position.z);
      drawHq(x, y, false);
    }
    const eb = structures?.enemyBase;
    if (eb?.alive) {
      if (!fogOfWar?.enabled || fogOfWar.isVisible(eb.position.x, eb.position.z)) {
        const { x, y } = worldToMini(eb.position.x, eb.position.z);
        drawHq(x, y, true);
      }
    }

    if (buildings?.list) {
      for (const b of buildings.list) {
        if (!b.alive || b.typeKey !== "captureNode" || b.constructing || b.built < 1) continue;
        if (fogOfWar?.enabled && !fogOfWar.isExplored(b.position.x, b.position.z)) continue;
        const { x, y } = worldToMini(b.position.x, b.position.z);
        drawCaptureNode(x, y);
      }
    }

    for (const p of requisition?.points ?? []) {
      if (fogOfWar?.enabled && !fogOfWar.isExplored(p.position.x, p.position.z)) continue;
      const { x, y } = worldToMini(p.position.x, p.position.z);
      drawPoint(x, y, p);
    }

    for (const u of units.list) {
      if (!u.alive) continue;
      if (fogOfWar?.enabled && u.team !== "player" && !fogOfWar.isVisible(u.position.x, u.position.z)) continue;
      const { x, y } = worldToMini(u.position.x, u.position.z);
      drawBlip(x, y, u);
    }

    const fp = cameraFootprint();
    if (fp) {
      ctx.beginPath();
      for (let i = 0; i < fp.length; i++) {
        const { x, y } = worldToMini(fp[i].x, fp[i].z);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fillStyle = "rgba(255,255,255,0.10)";
      ctx.strokeStyle = "rgba(255,255,255,0.9)";
      ctx.lineWidth = 1.5;
      ctx.fill(); ctx.stroke();
    }
  }

  return {
    root,
    draw,
    hasRadioIntel,
    rebuildTerrain() { terrain = bakeTerrain(app, frame); },
    dispose() {
      canvas.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      root.remove(); style.remove();
    },
  };
}
