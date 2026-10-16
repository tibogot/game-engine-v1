import { Fn, float, floor, vec2 } from "three/tsl";

/** Infinite tile: shift local offsets when anchor moves, wrap into [-half, half]. */
export const wrapTileOffsetXZ = Fn(([offsetXZ, deltaXZ, tileSize]) => {
  const shifted = offsetXZ.sub(deltaXZ);
  const half = tileSize.mul(0.5);
  const wrappedX = shifted.x.add(half).mod(tileSize).sub(half);
  const wrappedZ = shifted.y.add(half).mod(tileSize).sub(half);
  return vec2(wrappedX, wrappedZ);
});
