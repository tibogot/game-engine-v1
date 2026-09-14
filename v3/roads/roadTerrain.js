// Ground height functions for the lab and tests. The 3D engine will pass the
// real heightmap sampler instead — buildRoadNetwork only needs (x, z) → y.

const g = (x, z, cx, cz, r, h) => h * Math.exp(-((x - cx) ** 2 + (z - cz) ** 2) / (2 * r * r));

export const TERRAINS = {
  flat: { label: "Flat", fn: () => 0 },
  hills: {
    label: "Hills + valley",
    fn: (x, z) =>
      g(x, z, 260, -180, 170, 26) +
      g(x, z, -300, 160, 150, 22) +
      g(x, z, 120, 260, 120, 14) +
      g(x, z, -120, -300, 140, 18) -
      18 * Math.exp(-((x - 10 + z * 0.25) ** 2) / (2 * 42 * 42)) +
      2.2 * Math.sin(x / 57) * Math.cos(z / 71),
  },
};

export function terrainFn(name) {
  return (TERRAINS[name] || TERRAINS.flat).fn;
}
