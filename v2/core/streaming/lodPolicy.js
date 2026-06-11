export function pickLodByDistance(distance, config) {
  const levels = config.lod.levels;
  for (const level of levels) {
    if (distance <= level.maxDistance) return level;
  }
  return levels[levels.length - 1];
}

export function pickLodWithHysteresis(distance, currentSegments, config) {
  const levels = config.lod.levels;
  let currentIdx = levels.findIndex((x) => x.segments === currentSegments);
  if (currentIdx < 0) currentIdx = 0;
  const fresh = pickLodByDistance(distance, config);
  const freshIdx = levels.indexOf(fresh);
  if (freshIdx <= currentIdx) return fresh;
  const curMax = levels[currentIdx].maxDistance;
  if (curMax === Infinity) return levels[currentIdx];
  if (distance <= curMax * (1 + config.lod.hysteresis)) return levels[currentIdx];
  return fresh;
}

