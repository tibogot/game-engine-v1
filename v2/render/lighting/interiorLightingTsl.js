import * as THREE from "three";
import {
  Fn,
  float,
  int,
  vec3,
  uniform,
  uniformArray,
  positionWorld,
  smoothstep,
  clamp,
  max,
  min,
  mix,
  Loop,
  If,
} from "three/tsl";
import {
  INTERIOR_MAX_BOXES,
  INTERIOR_MAX_OPEN_ENDS,
  INTERIOR_MAX_SEGMENTS,
} from "./interiorVolumeRegistry.js";

/**
 * Scene.fogNode hook: mixes toward a dark interior color based on world position.
 * Works on all materials that respect scene fog (terrain, props, tunnel mesh, etc.).
 */
export function createInteriorLightingNodes(registry) {
  const uEnabled = uniform(0);
  const uStrength = uniform(0.82);
  const uColor = uniform(new THREE.Color("#0c0e14").convertSRGBToLinear());

  const uSegCount = uniform(0);
  const uSegA = uniformArray(
    new Array(INTERIOR_MAX_SEGMENTS).fill(null).map(() => new THREE.Vector4()),
    "vec4",
  );
  const uSegB = uniformArray(
    new Array(INTERIOR_MAX_SEGMENTS).fill(null).map(() => new THREE.Vector4()),
    "vec4",
  );

  const uBoxCount = uniform(0);
  const uBoxCenter = uniformArray(
    new Array(INTERIOR_MAX_BOXES).fill(null).map(() => new THREE.Vector4()),
    "vec4",
  );
  const uBoxHalf = uniformArray(
    new Array(INTERIOR_MAX_BOXES).fill(null).map(() => new THREE.Vector4()),
    "vec4",
  );

  const uOpenCount = uniform(0);
  const uOpenPos = uniformArray(
    new Array(INTERIOR_MAX_OPEN_ENDS).fill(null).map(() => new THREE.Vector4()),
    "vec4",
  );

  const capsuleFactor = Fn(([p, a, b, radius, softness]) => {
    const ab = b.sub(a);
    const lenSq = ab.dot(ab).max(float(1e-8));
    const t = clamp(p.sub(a).dot(ab).div(lenSq), float(0), float(1));
    const closest = a.add(ab.mul(t));
    const dist = p.distance(closest);
    const edge = radius.mul(softness);
    const innerR = radius.sub(edge).max(float(0));
    const outerR = radius.add(edge);
    return float(1).sub(smoothstep(innerR, outerR, dist));
  });

  const boxFactor = Fn(([p, center, half, soft]) => {
    const local = p.sub(center).abs();
    const hx = half.x;
    const hy = half.y;
    const hz = half.z;
    const sx = hx.mul(soft);
    const sy = hy.mul(soft);
    const sz = hz.mul(soft);
    const fx = float(1).sub(smoothstep(hx.sub(sx), hx, local.x));
    const fy = float(1).sub(smoothstep(hy.sub(sy), hy, local.y));
    const fz = float(1).sub(smoothstep(hz.sub(sz), hz, local.z));
    return fx.mul(fy).mul(fz);
  });

  const interiorFactorNode = Fn(() => {
    const p = positionWorld;
    const factor = float(0).toVar("interiorFactor");

    Loop({ start: int(0), end: int(INTERIOR_MAX_SEGMENTS), type: "int", condition: "<" }, ({ i }) => {
      const active = i.lessThan(uSegCount);
      const a4 = uSegA.element(i);
      const b4 = uSegB.element(i);
      const a = vec3(a4.x, a4.y, a4.z);
      const b = vec3(b4.x, b4.y, b4.z);
      const segF = capsuleFactor(p, a, b, a4.w, b4.w);
      factor.assign(max(factor, segF.mul(active)));
    });

    Loop({ start: int(0), end: int(INTERIOR_MAX_BOXES), type: "int", condition: "<" }, ({ i }) => {
      const active = i.lessThan(uBoxCount);
      const c4 = uBoxCenter.element(i);
      const h4 = uBoxHalf.element(i);
      const center = vec3(c4.x, c4.y, c4.z);
      const half = vec3(h4.x, h4.y, h4.z);
      const boxF = boxFactor(p, center, half, h4.w);
      factor.assign(max(factor, boxF.mul(active)));
    });

    const openingMul = float(1).toVar("openingMul");
    Loop({ start: int(0), end: int(INTERIOR_MAX_OPEN_ENDS), type: "int", condition: "<" }, ({ i }) => {
      const active = i.lessThan(uOpenCount);
      const e = uOpenPos.element(i);
      const endPos = vec3(e.x, e.y, e.z);
      const fade = e.w.max(float(0.001));
      const d = p.distance(endPos);
      const m = smoothstep(float(0), fade, d);
      openingMul.assign(min(openingMul, mix(float(1), m, active)));
    });

    factor.assign(factor.mul(openingMul));
    return clamp(factor, float(0), float(1));
  })();

  // When disabled, skip capsule/box loops entirely (was running 192+ iters per pixel × all fog materials).
  const interiorFogFactorNode = Fn(() => {
    const out = float(0).toVar("interiorFogOut");
    If(uEnabled.greaterThan(0.5), () => {
      out.assign(interiorFactorNode.mul(uStrength));
    });
    return out;
  })();

  function syncFromRegistry(registryRef, interior) {
    const enabled = interior?.enabled ? 1 : 0;
    uEnabled.value = enabled;
    uStrength.value = interior?.strength ?? 0.82;
    uColor.value.set(interior?.color ?? "#0c0e14").convertSRGBToLinear();

    const segN = Math.min(registryRef.segments.length, INTERIOR_MAX_SEGMENTS);
    uSegCount.value = segN;
    for (let i = 0; i < INTERIOR_MAX_SEGMENTS; i++) {
      const s = registryRef.segments[i];
      if (s) {
        uSegA.array[i].set(s.ax, s.ay, s.az, s.radius);
        uSegB.array[i].set(s.bx, s.by, s.bz, s.softness);
      } else {
        uSegA.array[i].set(0, 0, 0, 0);
        uSegB.array[i].set(0, 0, 0, 0);
      }
    }

    const boxN = Math.min(registryRef.boxes.length, INTERIOR_MAX_BOXES);
    uBoxCount.value = boxN;
    for (let i = 0; i < INTERIOR_MAX_BOXES; i++) {
      const b = registryRef.boxes[i];
      if (b) {
        uBoxCenter.array[i].set(b.cx, b.cy, b.cz, 1);
        uBoxHalf.array[i].set(b.hx, b.hy, b.hz, b.softness);
      } else {
        uBoxCenter.array[i].set(0, 0, 0, 0);
        uBoxHalf.array[i].set(0, 0, 0, 0);
      }
    }

    const openN = Math.min(registryRef.openEnds.length, INTERIOR_MAX_OPEN_ENDS);
    uOpenCount.value = openN;
    for (let i = 0; i < INTERIOR_MAX_OPEN_ENDS; i++) {
      const e = registryRef.openEnds[i];
      if (e) {
        uOpenPos.array[i].set(e.x, e.y, e.z, e.fade ?? 8);
      } else {
        uOpenPos.array[i].set(0, 0, 0, 1);
      }
    }
  }

  return {
    uEnabled,
    uStrength,
    uColor,
    interiorFactorNode,
    interiorFogFactorNode,
    syncFromRegistry,
  };
}
