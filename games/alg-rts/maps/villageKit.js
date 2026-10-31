// THE VILLAGE KIT'S PLACING (2026-10-29 — moved out of maps/auresNew.js for Oued Abdi, you: "start working on the port …
// AAA Company of Heroes type of assets"): the house kits' footprints and the helpers that lay out a map's TOWN field rows
// — a ring village, a stone hamlet, a terraced dechra, a koubba and its cemetery. Each row:
//   [type, state, x, y (null: algGame levels a pad), z, yaw, footprint cx, cz, half x, half z, meta?]
// ── The houses: the kits' footprints (local real metres x0 x1 z0 z1, the front at -Z; the game ×1.3 — tools/algAbdiLevel.mjs
// and maps/training.js) ────────────────────────────────────────────────────────────────────────────────────────
export const FOOT = { dar: [-3.6, 3.6, -3.9, 3.4], tour: [-2.6, 2.6, -3.3, 2.8], bas: [-3.2, 3.2, -4.0, 4.6], terrasse: [-3.0, 7.45, -3.5, 3.0],
  souk: [-6.0, 6.0, -5.0, 2.4], mosquee: [-6.0, 6.0, -6.5, 6.5], maison: [-3.8, 8.45, -3.5, 3.0], haute: [-2.6, 2.6, -3.7, 2.8], cour: [-3.4, 3.4, -4.2, 5.0],
  boutique: [-4.6, 4.6, -3.6, 2.6],
  // the MECHTA (tools/blender/mechta.py): its walls, the doorstep, the ladder and the jars out front
  petite: [-2.7, 2.7, -2.9, 2.2], etage: [-3.7, 3.7, -3.5, 2.9], pente: [-3.5, 4.45, -4.1, 2.9],   // (pente: its outside stair on the right)
  appentis: [-1.85, 1.85, -1.7, 1.65], enclos: [-4.0, 4.0, -3.0, 3.0], tabouna: [-0.9, 0.9, -1.15, 0.8],
  // the DECHRA's (DECHRA_PLAN.md): the mosque and its minaret, a terrace wall's module (its face at z -0.3), the lane steps
  masjid: [-4.6, 6.6, -4.1, 3.6], soutien: [-2.0, 2.0, -0.3, 0.65], escalier: [-1.25, 1.25, -2.45, 1.05], djemaa: [-3.0, 3.0, -1.5, 1.45],
  // the koubba and its enclosure (mechta.py KB_HAWSH)
  koubba: [-6.0, 6.0, -5.95, 5.85], hawsh: [-6.0, 6.0, -5.95, 5.85],
  // the farm's (FARM_PLAN.md): the sheepfold and its pen (the hurdle knocked flat out to -6.8), the threshing floor
  bergerie: [-5.3, 5.3, -6.8, 4.5], aire: [-3.55, 3.55, -3.55, 3.55],
  // the oasis's (OASIS_PLAN.md): the spring (its seguia out to -3.45, its trough to the right), a garden fence's 4 m module
  ain: [-2.5, 3.5, -3.5, 2.1], djerid: [-2.0, 2.0, -0.25, 0.25],
  // the PORT's (tools/blender/port.py, PORT_PLAN.md): the row houses' and the magasin's walls (its loading step out front),
  // the church (the tower and its steps at -Z, the buttresses at the sides), a mole length (its harbour face at -Z), the
  // quay's props, a boat
  quai: [-4.2, 4.2, -3.5, 3.5], cafe: [-4.8, 4.8, -3.75, 3.75], etroite: [-2.8, 2.8, -3.5, 3.5], magasin: [-8.0, 8.0, -4.4, 4.0],
  eglise: [-7.4, 7.4, -12.4, 9.2], mole: [-5.0, 5.0, -3.0, 3.0], phare: [-5.0, 5.0, -3.0, 3.0],
  etal: [-2.5, 2.05, -1.34, 0.95], caisses: [-1.63, 2.54, -0.73, 1.3], filets: [-2.07, 2.08, -1.48, 0.5], barque: [-3.8, 3.8, -1.2, 1.2],
  pave: [-5.0, 5.0, -4.06, 4.0], lampadaire: [-0.25, 0.25, -0.7, 0.25] };
export const HS = 1.3;
export const rotY = (th, lx, lz) => [lx * Math.cos(th) + lz * Math.sin(th), -lx * Math.sin(th) + lz * Math.cos(th)];
/** A house whose FOOTPRINT's centre is (cx, cz), its front toward (tx, tz): the town field's row (y null: a pad). */
export function house(type, state, cx, cz, tx, tz) {
  const [x0, x1, z0, z1] = FOOT[type].map((v) => v * HS), th = Math.atan2(-(tx - cx), -(tz - cz));
  const [ox, oz] = rotY(th, (x0 + x1) / 2, (z0 + z1) / 2);
  return [type, state, cx - ox, null, cz - oz, th, cx, cz, (x1 - x0) / 2, (z1 - z0) / 2];
}
/**
 * A village: its houses on an ARC round a small square at (sx, sz), their fronts toward it — the arc on the side away
 * from the camera (north, -Z) so every front faces the player at three-quarters (you: buildings face the camera), a
 * gap of `gap` m between neighbours' FRONT corners (the fronts converge on the square). `ring`: [radius of the footprints'
 * centres, from°, to°] (atan2(z, x) degrees: -90 = north).
 */
export function village(sx, sz, types, { ring = [22, -168, -12], gap = 3.5, damaged = -1 } = {}) {
  const [R, a0, a1] = ring, out = [];
  let a = (a0 * Math.PI) / 180;
  types.forEach((ty, k) => {
    const [x0, x1, z0, z1] = FOOT[ty].map((v) => v * HS), w = x1 - x0, Rf = R - (z1 - z0) / 2;
    a += (w / 2) / Rf;
    if (a > (a1 * Math.PI) / 180) return;
    out.push(house(ty, k === damaged ? "damaged" : "intact", sx + R * Math.cos(a), sz + R * Math.sin(a), sx, sz));
    a += (w / 2 + gap) / Rf;
  });
  return out;
}
/**
 * A STONE HAMLET, a CLUSTER (2026-10-27, you: "for the layout we should make it better — do what you think will look the
 * best"; the arc read as a ring of lone houses round a 48 m square): the houses SHOULDER TO SHOULDER in short rows, their
 * fronts toward the camera (south, +Z); a second row behind across a 3 m lane (its doors on the lane); a house at each
 * side of a small square in front, facing in — the village's point in that square. Local metres from the site:
 * a row `{ types, x, z }` starts at x (its left end) with its FRONT line at z; `states` per index; a side house
 * `{ type, x, z }` its footprint's centre, facing the square. Each house its own levelled pad (algGame).
 * The hamlet's smaller pieces (the mechta kit's — the town's PROPS: no garrison, no sight box): a row's `yards` (its
 * houses' indices) get a WALLED YARD behind them, its open side 15 cm into the house's back wall; `props`
 * `{ type, x, z }` (a lean-to, an oven) their footprint's centre, facing the camera. Returns { houses, props }.
 */
export function hamlet(sx, sz, { rows, sides = [], props = [] }) {
  const houses = [], extra = [];
  for (const { types, x, z, gap = 0.2, states = {}, yards = [] } of rows) {
    let lx = x;
    types.forEach((ty, k) => {
      const [x0, x1, z0, z1] = FOOT[ty].map((v) => v * HS), w = x1 - x0, d = z1 - z0;
      const cx = sx + lx + w / 2, cz = sz + z - d / 2 + (k % 2 ? -0.5 : 0.3);   // (the fronts a little in and out: no ruled line)
      houses.push(house(ty, states[k] ?? "intact", cx, cz, cx, cz + 50));
      if (yards.includes(k)) {   // (the house's back wall 0.1 m in from its footprint's back; the yard 3 m deep)
        const front = cz - d / 2 + 0.1 * HS + 0.15, yz = front - FOOT.enclos[3] * HS;
        extra.push(house("enclos", "intact", cx, yz, cx, yz + 50));
      }
      lx += w + gap;
    });
  }
  for (const { type, x, z, state = "intact" } of sides) houses.push(house(type, state, sx + x, sz + z, sx, sz + z));
  for (const { type, x, z, state = "intact" } of props) extra.push(house(type, state, sx + x, sz + z, sx + x, sz + z + 50));
  return { houses, props: extra };
}
/**
 * A TERRACED VILLAGE (2026-10-27, DECHRA_PLAN.md — the stone dechra): rows of houses up the slope, each row on its
 * TERRACE, a dry-stone retaining wall along each terrace's downhill edge, steps up through the walls. In the slope's
 * frame: `f` the way DOWNHILL (the houses' fronts face it), u along the contour, v downhill from the site.
 *   rows   { types, u, v, level }   v the row's FRONT line; its houses shoulder to shoulder from u
 *   walls  { u0, v, level, n }      n wall modules from u0, their face at v, standing on terrace `level` - 1
 *   props  { type, u, v, level, pad } (steps, the djemaa…) their footprint's centre
 * Each row carries { site, level, pad } (its 11th field): algGame stands it at the village's base (its level-0 houses'
 * mean ground) + level × 2.6 m (a wall's height), levelling a pad there — the walls and steps (pad false) unlevelled.
 */
const TERRACE_G = 2.0 * HS;
export function terraced(key, sx, sz, [fx, fz], { rows, walls = [], props = [] }) {
  const n = Math.hypot(fx, fz), f = [fx / n, fz / n], r = [-f[1], f[0]];
  const at = (u, v) => [sx + u * r[0] + v * f[0], sz + u * r[1] + v * f[1]];
  const facing = (cx, cz) => [cx + f[0] * 50, cz + f[1] * 50];
  const houses = [], extra = [];
  for (const { types, u, v, level, gap = 0.2, states = {} } of rows) {
    let lu = u;
    types.forEach((ty, k) => {
      const [x0, x1, z0, z1] = FOOT[ty].map((q) => q * HS), w = x1 - x0, d = z1 - z0;
      const [cx, cz] = at(lu + w / 2, v - d / 2 + (k % 2 ? -0.4 : 0.2));
      houses.push([...house(ty, states[k] ?? "intact", cx, cz, ...facing(cx, cz)), { site: key, level }]);
      lu += w + gap;
    });
  }
  for (const { u0, v, level, n: count } of walls) {
    const [x0, x1, z0, z1] = FOOT.soutien.map((q) => q * HS), L = x1 - x0, d = z1 - z0;
    for (let i = 0; i < count; i++) {
      const [cx, cz] = at(u0 + L * (i + 0.5), v - d / 2);   // (end to end: one module's end face against the next's)
      extra.push([...house("soutien", "intact", cx, cz, ...facing(cx, cz)), { site: key, level: level - 1, pad: false }]);
    }
  }
  for (const { type, u, v, level, pad = true, state = "intact" } of props) {
    const [cx, cz] = at(u, v);
    extra.push([...house(type, state, cx, cz, ...facing(cx, cz)), { site: key, level, pad }]);
  }
  return { houses, props: extra };
}

/**
 * THE KOUBBA AND ITS CEMETERY (2026-10-29, the mechta kit): the marabout's tomb at (kx, kz) facing the camera (its pad
 * levelled); the graves round (cx, cz), each on the slope as it is (algGame: `ground`), every one laid toward Mecca —
 * the axis 18° (NNE–SSW), the head NNE (the body on its right side, facing the qibla, ~108°) — in loose rows, some
 * missing, a few whitewashed; a low broken wall along their feet. `cols` x `rows` the grid before the gaps. Town props.
 */
export function koubbaAndCemetery(kx, kz, cx, cz, { seed = 1958, cols = 7, rows = 5 } = {}) {
  const props = kx == null ? [] : [house("koubba", "intact", kx, kz, kx, kz + 50), house("hawsh", "intact", kx, kz, kx, kz + 50)];   // (its enclosure: its own piece)
  if (cx == null) return props;
  const th = Math.PI - (18 * Math.PI) / 180;   // (the grave's local +Z, its head, toward NNE)
  let st = seed;
  const rnd = () => ((st = (st * 9301 + 49297) % 233280) / 233280);
  const at = (lx, lz) => { const [ox, oz] = rotY(th, lx, lz); return [cx + ox, cz + oz]; };
  const [hx, hz] = [0.62 * HS, 1.45 * HS];
  for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) {
    if (rnd() < 0.3) continue;   // (0.18: 29 graves in a ruled grid — a field of loaves)
    const [x, z] = at((i - (cols - 1) / 2) * 2.7 + (rnd() - 0.5) * 1.0, (j - (rows - 1) / 2) * 4.1 + (rnd() - 0.5) * 1.4);
    const r = rnd();   // (a few whitewashed, some old heaps, most slab-kerbed)
    props.push([r < 0.14 ? "tombeb" : r < 0.36 ? "tombec" : "tombe", "intact", x, null, z, th + (rnd() - 0.5) * 0.1, x, z, hx, hz, { ground: true }]);
  }
  // the low wall along the graves' feet, a gap between its two lengths (each 4 m real, ×1.3)
  const foot = -((rows - 1) / 2) * 4.1 - 3.0;
  for (const lx of [-cols * 0.8, cols * 0.8 - 1.0]) { const [x, z] = at(lx, foot); props.push(["murette", "intact", x, null, z, th, x, z, 2.0 * HS, 0.25 * HS, { ground: true, upright: true }]); }
  return props;
}

/**
 * AN OASIS GARDEN (2026-10-30, OASIS_PLAN.md): its palm-rib fence (djerid, 4 m modules end to end) round a plot whose
 * north-west corner is (x0, z0), `nx` modules along x, `nz` along z; `gate` [edge "n" | "s" | "w" | "e", module index]
 * left open (the way in); `damaged` the indices (in the order laid) knocked about. Each module on the ground as it is.
 */
export function garden(x0, z0, nx, nz, { gate = ["n", 0], damaged = [] } = {}) {
  const L = 4.0 * HS, out = [];
  const lay = (edge, i, cx, cz, tx, tz) => {
    if (gate[0] === edge && gate[1] === i) return;
    out.push([...house("djerid", damaged.includes(out.length) ? "damaged" : "intact", cx, cz, tx, tz), { ground: true, upright: true }]);
  };
  for (let i = 0; i < nx; i++) {   // the north and south lengths (their fronts out)
    const cx = x0 + L * (i + 0.5);
    lay("n", i, cx, z0, cx, z0 - 50);
    lay("s", i, cx, z0 + nz * L, cx, z0 + nz * L + 50);
  }
  for (let j = 0; j < nz; j++) {   // the west and east (30 cm in from the corners: never two walls in one place)
    const cz = z0 + L * (j + 0.5);
    lay("w", j, x0 + 0.3, cz, x0 - 50, cz);
    lay("e", j, x0 + nx * L - 0.3, cz, x0 + nx * L + 50, cz);
  }
  return out;
}
