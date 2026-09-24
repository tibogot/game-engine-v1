// SWEPT YARDS UNDER THE VILLAGE HUTS — and, by default, nothing under anything
// else.
//
// Every structure in this game levels its pad through `app.flattenRect` — the
// HQ, the requisition masts, the camp gate, placed objects, and anything the
// player builds mid-match (structures.js). That call already knows the
// footprint (centre, half-extents, turn), so this wraps it: a pad whose call
// asks for a `ground` in GROUNDS gets that apron decal laid under it, turned
// with the building and reaching MARGIN metres past its footprint, with the
// vegetation cleared off its core.
//
// WHY ONLY THE VILLAGE (checkpoint 2026-09-24). This first put a laterite
// apron under EVERY pad (133 at boot) and swept yards under the temple. Side
// by side with the build before it, the camp came out barer — the clearing
// stripped the ferns round every crate, and the pads merged into one flat red
// patch — and the jungle growing right up to a building is exactly what looks
// real here. Ruins in the jungle should be overgrown too. A swept yard round a
// hut is the one that is true to the place, so it is the only one left; the
// decals also cost ~0.6 ms at native, mostly those big apron boxes.
//
// SIZE. The apron art (decalPhotoArt `apron`) is a rounded rectangle whose
// solid part reaches HALF_FRACTION of the decal box from its centre, so the box
// is sized to put that edge MARGIN outside the pad. Its photo grain is baked
// for a 12 m box; a much bigger box would blow the gravel up with it, so a
// large footprint is TILED with several boxes no wider than MAX_BOX, spaced so
// each one's solid core overlaps the next (the ragged rims then only show on
// the outside).
//
// Aprons draw under the wear on them (priority below the ruts) and, like every
// ground decal here, are glued to the live ground in the shader — so it does
// not matter that the pad is levelled before or after.

const MARGIN = 2.2;          // metres of apron beyond the footprint
const HALF_FRACTION = 0.368; // art: solid edge at 0.4 · 0.92 of the box
const CORE_FRACTION = 0.6;   // art: fully opaque across ~60 % of the box
const MAX_BOX = 16;          // metres; bigger boxes stretch the grain
/**
 * The ground a pad gets, by `opts.ground` on the flattenRect call:
 *   swept     a village hut's yard: packed earth, broomed smooth
 *   (absent)  nothing — the default
 * `prefix` finds the art if the map already carries it as a slot; otherwise
 * it is added at runtime from `art`.
 */
const GROUNDS = {
  swept: {
    prefix: "sweptYard",
    art: { name: "sweptYard (photo)", albedoUrl: "/textures/decals/nam/sweptYard_1.webp", normalUrl: "/textures/decals/nam/sweptYard_1_n.webp" },
    roughness: 0.92,
  },
};

/**
 * Box centres along one axis of the footprint: `full` is the extent the
 * apron's solid edge must cover (2 · (half + MARGIN)).
 */
function tileAxis(full) {
  const one = full / (2 * HALF_FRACTION);
  if (one <= MAX_BOX) return { size: one, offsets: [0] };
  const size = MAX_BOX;
  const reach = size * 2 * HALF_FRACTION;              // solid width of one box
  const span = full - reach;                            // first centre → last
  const n = Math.ceil(span / (size * CORE_FRACTION)) + 1;
  return { size, offsets: Array.from({ length: n }, (_, i) => -span / 2 + (i * span) / (n - 1)) };
}

/**
 * @param {object} app  the engine app (needs `flattenRect` and `decals`)
 * @returns {{ count: () => number }}
 */
export function installBuildingAprons(app) {
  const decals = app.decals;
  const flatten = app.flattenRect?.bind(app);
  if (!decals || !flatten) return { count: () => 0 };

  // One slot lookup per ground, shared by every pad that asks for it (and
  // serialised, so two first pads cannot both add the same art).
  const slotPromises = {};
  let chain = Promise.resolve();
  const slot = (g) => (slotPromises[g.prefix] ??= (chain = chain.then(async () => {
    const i = decals.textures.slots.findIndex((s) => s.name.startsWith(g.prefix));
    if (i >= 0) return i;
    await decals.addSlot(g.art);               // a map without the art: bring it
    return decals.textures.slots.length - 1;
  })));

  let placed = 0;
  async function stamp(wx, wz, halfX, halfZ, y, rotY, ground) {
    const g = ground && GROUNDS[ground];
    if (!g) return;                            // no ground asked for: leave the jungle be
    const s = await slot(g);
    const cr = Math.cos(rotY), sr = Math.sin(rotY);
    const qy = Math.sin(rotY / 2), qw = Math.cos(rotY / 2);
    const ax = tileAxis(2 * (halfX + MARGIN));
    const az = tileAxis(2 * (halfZ + MARGIN));
    for (const ox of ax.offsets) {
      for (const oz of az.offsets) {
        // Same frame as flattenRect: local +X → (cos, -sin), local +Z → (sin, cos).
        const px = wx + ox * cr + oz * sr, pz = wz - ox * sr + oz * cr;
        decals.add({
          px, py: y, pz,
          qx: 0, qy, qz: 0, qw,
          slot: s, sx: ax.size, sy: 4, sz: az.size,
          opacity: 1, roughness: g.roughness, normalStrength: 1,
          angleFade: 55, edgeFade: 0.02, priority: -1,
        });
        clearPad(px, pz, ax.size, az.size, cr, sr);
        placed++;
      }
    }
  }

  // Nothing grows on a pad. A decal only paints the ground — grass and ferns
  // stood straight up through the apron — so the vegetation goes too, but only
  // inside the apron's SOLID core: circles of the core's short half-width,
  // stepped along its long axis, so a long thin pad is not cleared as a disc
  // (the ground round a mast is meant to keep its grass — it is fought over).
  function clearPad(px, pz, sx, sz, cr, sr) {
    if (!app.clearVegetation) return;
    const r = Math.min(sx, sz) * CORE_FRACTION * 0.5;
    const long = Math.max(sx, sz) * CORE_FRACTION;
    const n = Math.max(1, Math.round(long / (r * 1.4)));
    // Unit vector of the long axis, in the same turned frame as the box.
    const [ux, uz] = sx >= sz ? [cr, -sr] : [sr, cr];
    for (let i = 0; i < n; i++) {
      const t = n === 1 ? 0 : -long / 2 + r + ((long - 2 * r) * i) / (n - 1);
      app.clearVegetation(px + ux * t, pz + uz * t, r, { grass: r });
    }
  }

  app.flattenRect = async (wx, wz, halfX, halfZ, targetY, opts = {}) => {
    const r = await flatten(wx, wz, halfX, halfZ, targetY, opts);
    await stamp(wx, wz, halfX, halfZ, targetY, opts.rotY ?? 0, opts.ground);
    return r;
  };

  return { count: () => placed };
}
