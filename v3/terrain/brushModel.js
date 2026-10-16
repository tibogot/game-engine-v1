import * as THREE from "three";

/**
 * splatmap-chunks `applySculptAt`: Alt → flatten, Ctrl → smooth, else stamp from `sculptMode`.
 * Flatten-only tool (`sculptMode === "flatten"`) always flattens without Alt.
 */
export function resolveSculptStrokeMode(toolState, pointerEvent = {}) {
  if (toolState.sculptMode === "flatten") {
    return { mode: "flatten" };
  }
  if (pointerEvent.altKey) {
    return { mode: "flatten" };
  }
  if (pointerEvent.ctrlKey || pointerEvent.metaKey) {
    return { mode: "smooth" };
  }
  if (toolState.sculptMode === "erosion") {
    return { mode: "erosion" };
  }
  // v1: Shift + noise (or terrace) uses raise/lower at -1 instead of the mode stamp.
  if (
    (toolState.sculptMode === "noise" || toolState.sculptMode === "terrace") &&
    pointerEvent.shiftKey
  ) {
    return { mode: "raiseLower" };
  }
  if (toolState.sculptMode === "noise") {
    return { mode: "noise" };
  }
  if (toolState.sculptMode === "terrace") {
    return { mode: "terrace" };
  }
  return { mode: toolState.sculptMode };
}

export function createBrushStrokeFromHit({
  hitPoint,
  toolState,
  sign,
  flattenTargetY,
  sessionBrushSeed,
  pointerEvent,
  maskData = null,
  maskSize = 0,
  maskRotation = 0,
}) {
  const radius = toolState.brush.radius;
  const strength = toolState.brush.strength;
  const useSessionSeed =
    toolState.sculptMode === "fbmPeak" || toolState.sculptMode === "noise";
  const { mode: resolvedMode } = resolveSculptStrokeMode(toolState, pointerEvent);
  let strokeSign = sign;
  if (
    resolvedMode === "raiseLower" &&
    (toolState.sculptMode === "noise" || toolState.sculptMode === "terrace") &&
    pointerEvent.shiftKey
  ) {
    strokeSign = -1;
  }
  return {
    mode: resolvedMode,
    sign: strokeSign,
    cx: hitPoint.x,
    cz: hitPoint.z,
    radius,
    strength,
    falloff: toolState.brush.falloff,
    raiseLowerStamp:
      resolvedMode === "raiseLower" ? toolState.raiseLowerStamp ?? "smooth" : "smooth",
    brushFalloff: toolState.brush.brushFalloff ?? "smooth",
    flattenTargetY,
    seed: useSessionSeed ? (sessionBrushSeed ?? 0) : Math.random() * 10000,
    minX: hitPoint.x - radius,
    maxX: hitPoint.x + radius,
    minZ: hitPoint.z - radius,
    maxZ: hitPoint.z + radius,
    maskData,
    maskSize,
    maskRotation,
    ...(toolState.sculptMode === "fbmPeak"
      ? { fbmPeak: { ...toolState.fbmPeak } }
      : {}),
    ...(toolState.sculptMode === "noise"
      ? {
          noiseScale: toolState.noiseBrush.noiseScale,
          noiseOctaves: toolState.noiseBrush.noiseOctaves,
        }
      : {}),
    ...(toolState.sculptMode === "terrace"
      ? { terrace: { ...toolState.terrace } }
      : {}),
  };
}

export function shouldApplyStroke(lastPoint, nextPoint, radius, spacingFactor) {
  if (!lastPoint) return true;
  const minDist = Math.max(0.6, radius * spacingFactor);
  return lastPoint.distanceToSquared(nextPoint) >= minDist * minDist;
}

export function worldBrushBounds(center, radius) {
  return {
    minX: center.x - radius,
    minZ: center.z - radius,
    maxX: center.x + radius,
    maxZ: center.z + radius,
  };
}

/** Tree / billboard foliage: placement attempts = πr² × density × scale × brush strength. */
export const SCATTER_DENSITY_SCALE = 0.01;

