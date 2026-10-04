// SMOKE COLUMNS — what a screening cloud MEANS: does it stand between two men?
// The sight half of a smoke system, with no drawing in it (alg-rts draws its
// screens with its own lit puffs; combat.js asks `occlusionBetween`).
//
// The model is nam-rts/smokeField.js's (read its notes: BEER-LAMBERT optical
// depth along the line, not a coverage fraction; a GAUSSIAN column, not a
// cylinder, so a man stepping a metre at the rim doesn't flip seen/hidden),
// taken out of nam's file so both games share it. Here each column carries
// its own numbers instead of naming one of nam's kinds. (nam's own smokeField
// still has its copy; the nam rebuild should use this one.)
//
// Pure: sources are plain objects, the sim steps them on its fixed clock.
//
//   source = { alive, x, z, age, life, strength (0..1),
//              radius, growth (m: full-bloom radius = radius + growth),
//              bloom (s to full size), losOpacity (0..1 straight through the
//              middle of a full cloud) }

/** How much smoke sits between two points, 0..1. */
export function smokeOcclusion(sources, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const segLen = Math.hypot(dx, dz);
  if (segLen < 1e-3) return 0;
  const inv = 1 / (segLen * segLen);
  let tau = 0;
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    if (!s.alive || s.losOpacity <= 0) continue;
    // A cloud blocks as it looks: blooming in, thinning over its last 45%.
    const bloom = Math.min(1, s.age / Math.max(0.01, s.bloom));
    const fade = 1 - Math.max(0, (s.age - s.life * 0.55) / Math.max(0.01, s.life * 0.45));
    const amount = s.strength * bloom * Math.max(0, Math.min(1, fade));
    if (amount <= 0) continue;
    const R = (s.radius + s.growth) * (0.35 + 0.65 * bloom);
    // Closest approach of the SEGMENT: a cloud behind the shooter blocks nothing.
    const t = Math.max(0, Math.min(1, ((s.x - ax) * dx + (s.z - az) * dz) * inv));
    const cx = ax + dx * t, cz = az + dz * t;
    const d2 = (s.x - cx) ** 2 + (s.z - cz) ** 2;
    const cut = R * 2.2;
    if (d2 >= cut * cut) continue;
    const dMax = 2 * (s.radius + s.growth);
    const sigma = -Math.log(1 - Math.min(0.999, s.losOpacity)) / dMax;
    // Capped by the path: two men 5 m apart inside a cloud have 5 m of it between them.
    const column = Math.min(segLen, 2 * R * Math.exp(-2.5 * d2 / (R * R)));
    tau += sigma * column * amount;
  }
  return tau <= 0 ? 0 : 1 - Math.exp(-tau);
}

/** Age the columns (the sim's fixed clock). */
export function stepSmokeColumns(sources, dt) {
  for (const s of sources) {
    if (!s.alive) continue;
    s.age += dt;
    if (s.age >= s.life) s.alive = false;
  }
}
