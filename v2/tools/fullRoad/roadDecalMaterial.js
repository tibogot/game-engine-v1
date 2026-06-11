import * as THREE from "three";

// ─────────────────────────────────────────────────────────────────────────────
// PROCEDURAL ROAD DECAL MATERIALS (Canvas-based for compatibility)
// ─────────────────────────────────────────────────────────────────────────────

const textureCache = new Map();

function getOrCreateTexture(type, params) {
  const key = `${type}_${params.stripeCount}_${params.color}`;
  if (textureCache.has(key)) {
    return textureCache.get(key);
  }
  
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext("2d");
  
  // Clear with transparency
  ctx.clearRect(0, 0, 256, 256);
  
  // Draw based on type
  drawDecal(ctx, type, params);
  
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;
  
  textureCache.set(key, texture);
  return texture;
}

function drawDecal(ctx, type, params) {
  const w = 256;
  const h = 256;
  const color = params.color || "#ffffff";
  const stripeCount = params.stripeCount || 8;
  
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  
  switch (type) {
    case "zebraCrossing":
      drawZebraCrossing(ctx, w, h, stripeCount, color);
      break;
    case "ladderCrossing":
      drawLadderCrossing(ctx, w, h, stripeCount, color);
      break;
    case "stopLine":
      drawStopLine(ctx, w, h, color);
      break;
    case "arrowStraight":
      drawArrowStraight(ctx, w, h, color);
      break;
    case "arrowLeft":
      drawArrowLeft(ctx, w, h, color);
      break;
    case "arrowRight":
      drawArrowRight(ctx, w, h, color);
      break;
    case "arrowStraightLeft":
      drawArrowStraightLeft(ctx, w, h, color);
      break;
    case "arrowStraightRight":
      drawArrowStraightRight(ctx, w, h, color);
      break;
    case "giveWay":
      drawGiveWayTriangle(ctx, w, h, color);
      break;
    case "speedCircle":
      drawSpeedCircle(ctx, w, h, color);
      break;
    case "parkingLines":
      drawParkingLines(ctx, w, h, color);
      break;
    default:
      drawZebraCrossing(ctx, w, h, stripeCount, color);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ZEBRA CROSSING
// ─────────────────────────────────────────────────────────────────────────────

function drawZebraCrossing(ctx, w, h, stripeCount, color) {
  ctx.fillStyle = color;
  const stripeWidth = w / stripeCount;
  for (let i = 0; i < stripeCount; i += 2) {
    ctx.fillRect(i * stripeWidth, 0, stripeWidth, h);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// LADDER CROSSING
// ─────────────────────────────────────────────────────────────────────────────

function drawLadderCrossing(ctx, w, h, stripeCount, color) {
  ctx.fillStyle = color;
  const borderWidth = h * 0.1;
  
  // Top and bottom borders
  ctx.fillRect(0, 0, w, borderWidth);
  ctx.fillRect(0, h - borderWidth, w, borderWidth);
  
  // Vertical bars
  const barWidth = w / stripeCount * 0.4;
  const spacing = w / stripeCount;
  for (let i = 0; i < stripeCount; i++) {
    const x = i * spacing + spacing / 2 - barWidth / 2;
    ctx.fillRect(x, borderWidth, barWidth, h - borderWidth * 2);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// STOP LINE
// ─────────────────────────────────────────────────────────────────────────────

function drawStopLine(ctx, w, h, color) {
  ctx.fillStyle = color;
  const lineHeight = h * 0.35;
  ctx.fillRect(0, h / 2 - lineHeight / 2, w, lineHeight);
}

// ─────────────────────────────────────────────────────────────────────────────
// ARROW STRAIGHT ↑
// ─────────────────────────────────────────────────────────────────────────────

function drawArrowStraight(ctx, w, h, color) {
  ctx.fillStyle = color;
  const cx = w / 2;
  
  // Shaft
  const shaftWidth = w * 0.15;
  const shaftTop = h * 0.35;
  const shaftBottom = h * 0.95;
  ctx.fillRect(cx - shaftWidth / 2, shaftTop, shaftWidth, shaftBottom - shaftTop);
  
  // Arrow head
  ctx.beginPath();
  ctx.moveTo(cx, h * 0.05);
  ctx.lineTo(cx + w * 0.25, h * 0.4);
  ctx.lineTo(cx - w * 0.25, h * 0.4);
  ctx.closePath();
  ctx.fill();
}

// ─────────────────────────────────────────────────────────────────────────────
// ARROW LEFT ←
// ─────────────────────────────────────────────────────────────────────────────

function drawArrowLeft(ctx, w, h, color) {
  ctx.fillStyle = color;
  const cy = h / 2;
  
  // Shaft
  const shaftHeight = h * 0.12;
  ctx.fillRect(w * 0.35, cy - shaftHeight / 2, w * 0.6, shaftHeight);
  
  // Arrow head
  ctx.beginPath();
  ctx.moveTo(w * 0.05, cy);
  ctx.lineTo(w * 0.4, cy - h * 0.22);
  ctx.lineTo(w * 0.4, cy + h * 0.22);
  ctx.closePath();
  ctx.fill();
}

// ─────────────────────────────────────────────────────────────────────────────
// ARROW RIGHT →
// ─────────────────────────────────────────────────────────────────────────────

function drawArrowRight(ctx, w, h, color) {
  ctx.fillStyle = color;
  const cy = h / 2;
  
  // Shaft
  const shaftHeight = h * 0.12;
  ctx.fillRect(w * 0.05, cy - shaftHeight / 2, w * 0.6, shaftHeight);
  
  // Arrow head
  ctx.beginPath();
  ctx.moveTo(w * 0.95, cy);
  ctx.lineTo(w * 0.6, cy - h * 0.22);
  ctx.lineTo(w * 0.6, cy + h * 0.22);
  ctx.closePath();
  ctx.fill();
}

// ─────────────────────────────────────────────────────────────────────────────
// ARROW STRAIGHT + LEFT ↑←
// ─────────────────────────────────────────────────────────────────────────────

function drawArrowStraightLeft(ctx, w, h, color) {
  ctx.fillStyle = color;
  const cx = w / 2;
  const cy = h / 2;
  
  // Vertical shaft
  const shaftWidth = w * 0.12;
  ctx.fillRect(cx - shaftWidth / 2, h * 0.35, shaftWidth, h * 0.6);
  
  // Straight arrow head
  ctx.beginPath();
  ctx.moveTo(cx, h * 0.08);
  ctx.lineTo(cx + w * 0.2, h * 0.35);
  ctx.lineTo(cx - w * 0.2, h * 0.35);
  ctx.closePath();
  ctx.fill();
  
  // Horizontal shaft to left
  const hShaftHeight = h * 0.1;
  ctx.fillRect(w * 0.25, cy - hShaftHeight / 2, cx - w * 0.25, hShaftHeight);
  
  // Left arrow head
  ctx.beginPath();
  ctx.moveTo(w * 0.08, cy);
  ctx.lineTo(w * 0.28, cy - h * 0.15);
  ctx.lineTo(w * 0.28, cy + h * 0.15);
  ctx.closePath();
  ctx.fill();
}

// ─────────────────────────────────────────────────────────────────────────────
// ARROW STRAIGHT + RIGHT ↑→
// ─────────────────────────────────────────────────────────────────────────────

function drawArrowStraightRight(ctx, w, h, color) {
  ctx.fillStyle = color;
  const cx = w / 2;
  const cy = h / 2;
  
  // Vertical shaft
  const shaftWidth = w * 0.12;
  ctx.fillRect(cx - shaftWidth / 2, h * 0.35, shaftWidth, h * 0.6);
  
  // Straight arrow head
  ctx.beginPath();
  ctx.moveTo(cx, h * 0.08);
  ctx.lineTo(cx + w * 0.2, h * 0.35);
  ctx.lineTo(cx - w * 0.2, h * 0.35);
  ctx.closePath();
  ctx.fill();
  
  // Horizontal shaft to right
  const hShaftHeight = h * 0.1;
  ctx.fillRect(cx, cy - hShaftHeight / 2, w * 0.25, hShaftHeight);
  
  // Right arrow head
  ctx.beginPath();
  ctx.moveTo(w * 0.92, cy);
  ctx.lineTo(w * 0.72, cy - h * 0.15);
  ctx.lineTo(w * 0.72, cy + h * 0.15);
  ctx.closePath();
  ctx.fill();
}

// ─────────────────────────────────────────────────────────────────────────────
// GIVE WAY TRIANGLE △
// ─────────────────────────────────────────────────────────────────────────────

function drawGiveWayTriangle(ctx, w, h, color) {
  ctx.strokeStyle = color;
  ctx.lineWidth = w * 0.08;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  
  // Inverted triangle outline (pointing down)
  ctx.beginPath();
  ctx.moveTo(w / 2, h * 0.85);
  ctx.lineTo(w * 0.1, h * 0.15);
  ctx.lineTo(w * 0.9, h * 0.15);
  ctx.closePath();
  ctx.stroke();
}

// ─────────────────────────────────────────────────────────────────────────────
// SPEED CIRCLE ○
// ─────────────────────────────────────────────────────────────────────────────

function drawSpeedCircle(ctx, w, h, color) {
  ctx.strokeStyle = color;
  ctx.lineWidth = w * 0.08;
  
  ctx.beginPath();
  ctx.arc(w / 2, h / 2, w * 0.38, 0, Math.PI * 2);
  ctx.stroke();
}

// ─────────────────────────────────────────────────────────────────────────────
// PARKING LINES
// ─────────────────────────────────────────────────────────────────────────────

function drawParkingLines(ctx, w, h, color) {
  ctx.fillStyle = color;
  const lineWidth = w * 0.08;
  
  // Left line
  ctx.fillRect(0, 0, lineWidth, h);
  // Right line
  ctx.fillRect(w - lineWidth, 0, lineWidth, h);
  // Bottom line
  ctx.fillRect(0, h - lineWidth, w, lineWidth);
}

// ─────────────────────────────────────────────────────────────────────────────
// CREATE MATERIAL
// ─────────────────────────────────────────────────────────────────────────────

export function createDecalMaterial(type, params, isPreview = false) {
  const texture = getOrCreateTexture(type, params);
  
  const mat = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    side: THREE.DoubleSide,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -10,
    polygonOffsetUnits: -10,
    opacity: isPreview ? 0.6 : 1.0,
  });
  
  return mat;
}

export function clearTextureCache() {
  for (const tex of textureCache.values()) {
    tex.dispose();
  }
  textureCache.clear();
}

export const DECAL_TYPES = [
  { id: "zebraCrossing", label: "Zebra Crossing" },
  { id: "ladderCrossing", label: "Ladder Crossing" },
  { id: "stopLine", label: "Stop Line" },
  { id: "arrowStraight", label: "Arrow ↑" },
  { id: "arrowLeft", label: "Arrow ←" },
  { id: "arrowRight", label: "Arrow →" },
  { id: "arrowStraightLeft", label: "Arrow ↑←" },
  { id: "arrowStraightRight", label: "Arrow ↑→" },
  { id: "giveWay", label: "Give Way △" },
  { id: "speedCircle", label: "Speed Circle ○" },
  { id: "parkingLines", label: "Parking Lines" },
];
