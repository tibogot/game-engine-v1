// RTS minimap — GAME UI (player-facing). Bottom-left panel, adapted from the
// rts-chibs minimap to the v3 engine handle.
//
//   • Hidden until the player builds a Radio Station (CoH intel gate).
//   • Bakes the terrain once (height shading + slope for cliffs + water tint).
//   • FoW shroud overlay when fog of war is active.
//   • Each frame draws unit blips and the camera's ground footprint rectangle.
//   • Click / drag to move the RTS camera there.
import * as THREE from "three";

const BAKE_RES = 160;
const VIEW_PX  = 210;

const _plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const _ray = new THREE.Raycaster();
const _ndc = new THREE.Vector2();
const _hit = new THREE.Vector3();
const _NDC_CORNERS = [[-1, -1], [1, -1], [1, 1], [-1, 1]];

function lerpRgb(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function bakeTerrain(app) {
  const res = BAKE_RES;
  const map = app.worldSize ?? 1000;
  const half = map * 0.5;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = res;
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(res, res);
  const data = img.data;

  const wzOf = (py) => (0.5 - py / (res - 1)) * map;
  const wxOf = (px) => half - (px / (res - 1)) * map;

  const heights = new Float32Array(res * res);
  let minH = Infinity, maxH = -Infinity;
  for (let py = 0; py < res; py++) {
    const wz = wzOf(py);
    for (let px = 0; px < res; px++) {
      const wx = wxOf(px);
      const h = app.getWorldHeight(wx, wz);
      heights[py * res + px] = h;
      if (h < minH) minH = h;
      if (h > maxH) maxH = h;
    }
  }
  const span = Math.max(1, maxH - minH);
  const grassLow = [52, 78, 44], grassHigh = [90, 118, 66];
  const cliff = [124, 100, 72], cliffSteep = [150, 120, 84];
  const water = [40, 92, 130];

  for (let py = 0; py < res; py++) {
    const wz = wzOf(py);
    for (let px = 0; px < res; px++) {
      const i = py * res + px;
      const wx = wxOf(px);
      const h = heights[i];
      let rgb;
      const wl = app.getWaterLevelAt ? app.getWaterLevelAt(wx, wz) : -Infinity;
      if (wl > h) rgb = water;
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

export function createMinimap({ app, units, buildings = null, structures = null, fogOfWar = null }) {
  const map = app.worldSize ?? 1000;
  let terrain = bakeTerrain(app);

  const root = document.createElement("div");
  root.id = "rts-minimap";
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = VIEW_PX;
  root.appendChild(canvas);
  document.body.appendChild(root);

  const hint = document.createElement("div");
  hint.id = "rts-minimap-hint";
  hint.textContent = "Build a Radio Station for tactical map intel";
  document.body.appendChild(hint);

  const ctx = canvas.getContext("2d");

  const style = document.createElement("style");
  style.textContent = `
    #rts-minimap {
      position: fixed; left: 12px; bottom: 12px; z-index: 55;
      width: ${VIEW_PX}px; height: ${VIEW_PX}px; padding: 6px;
      background: rgba(16,18,22,0.72); border: 1px solid rgba(255,255,255,0.1);
      border-radius: 10px; backdrop-filter: blur(6px);
      display: none;
    }
    #rts-minimap.show { display: block; }
    #rts-minimap canvas { width: 100%; height: 100%; border-radius: 6px; cursor: crosshair; display: block; }
    #rts-minimap-hint {
      position: fixed; left: 12px; bottom: 12px; z-index: 54;
      padding: 8px 12px; max-width: ${VIEW_PX}px;
      font: 11px/1.35 system-ui, sans-serif; color: #9aa4b2;
      background: rgba(16,18,22,0.55); border: 1px dashed rgba(255,255,255,0.12);
      border-radius: 8px;
    }
    #rts-minimap-hint.hide { display: none; }
  `;
  document.head.appendChild(style);

  const worldToMini = (x, z) => ({ x: (0.5 - x / map) * VIEW_PX, y: (0.5 - z / map) * VIEW_PX });

  let dragging = false;
  const jump = (ev) => {
    const rect = canvas.getBoundingClientRect();
    const wx = (0.5 - (ev.clientX - rect.left) / rect.width) * map;
    const wz = (0.5 - (ev.clientY - rect.top) / rect.height) * map;
    app.rtsCamera?.focusOn?.(wx, wz);
  };
  const onDown = (e) => { dragging = true; jump(e); e.preventDefault(); };
  const onMove = (e) => { if (dragging) jump(e); };
  const onUp = () => { dragging = false; };
  canvas.addEventListener("pointerdown", onDown);
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);

  function hasRadioIntel() {
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
    return pts;
  }

  function drawBlip(x, y, u) {
    const s = u.isAir ? 4 : 3.4;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(u.heading ?? 0);
    ctx.fillStyle = u.selected ? "#ffffff" : (u.isAir ? "#63e0d0" : "#58a8ff");
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

  function drawHq(x, y, hostile) {
    ctx.fillStyle = hostile ? "#ff6a5a" : "#64d2ff";
    ctx.strokeStyle = hostile ? "rgba(255,106,90,0.95)" : "rgba(100,210,255,0.95)";
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.rect(x - 4.5, y - 4.5, 9, 9);
    ctx.fill();
    ctx.stroke();
  }

  function draw() {
    const intel = hasRadioIntel();
    root.classList.toggle("show", intel);
    hint.classList.toggle("hide", intel);

    ctx.clearRect(0, 0, VIEW_PX, VIEW_PX);
    if (!intel) return;

    ctx.drawImage(terrain, 0, 0, VIEW_PX, VIEW_PX);

    if (fogOfWar?.enabled && fogOfWar.miniCanvas) {
      ctx.drawImage(fogOfWar.miniCanvas, 0, 0, VIEW_PX, VIEW_PX);
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
    rebuildTerrain() { terrain = bakeTerrain(app); },
    dispose() {
      canvas.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      root.remove(); hint.remove(); style.remove();
    },
  };
}
