// COVER AND CONCEALMENT IN THE AURÈS — the shared rule (games/shared-rts/
// cover.js: concealment stops you being SEEN, cover stops you being HURT;
// firing gives a concealed man away for 4 s) with this map's numbers and its
// own obstacles:
//
//   CONCEALMENT  the painted scrub, cedars and palms. MEASURED on
//                alg-aures' walkable ground: 82.5% has none at all, the
//                scrub patches sit at 0.5-0.6 (6.5%), a thin band 0.1-0.4.
//                So it is rare and worth seeking: from 0.2 up, full at 0.65
//                — typical scrub takes ~half off the range you are seen at.
//                Nobody hides in the open valley; the ALN lives in the scrub.
//   COVER        the placed pieces, as rows of circles over their footprints
//                (the map has no rock props): HARD for stone and sandbags —
//                the post's walls, the sangar, the MG nest, the mortar pit,
//                the sandbag runs, the dechra, the mechtas, the koubba, the
//                cave's rocks; soft for the rest. Barbed wire, the brush
//                screen, the thorn pens and flat pads are no cover.
//
// V (as nam): hold to see it over the ground round the cursor — GREEN cover
// (you survive), CYAN concealment (you are not seen).
import { COVER, createCover } from "../shared-rts/cover.js";
import { createCoverOverlay } from "../shared-rts/coverOverlay.js";

//   TERRAIN      a wadi's bank, a crest, a terrace riser (shared cover.js
//                terrainCover): the ground toward the shooter rising into
//                the line of fire. A man in a wadi bed is covered from the
//                plain, not from a man on the bank above him.
//   WALLS        a piece can list its own wall lines (userData.coverLines,
//                rtsAlgVillage.js): a garden's dry-stone walls, the terrace
//                walls, the dechra's courtyards — hard cover along the wall,
//                not over the plot it encloses.
export const ALG_COVER = { ...COVER, concealFloor: 0.2, concealCeil: 0.65, maxConcealment: 0.6, terrainCover: 0.5 };

/** Stone and sandbags: hard cover. */
const HARD = new Set(["frenchPost", "sangar", "mgNest", "mortarPit", "sandbags", "sandbags1", "sandbags2", "dechra", "ksar", "mechta", "mechta2", "koubba", "caveEntrance", "sasPost", "armsCache", "alnCamp", "wellHamlet1", "wellHamlet2"]);
/** No cover at all: wire, brush, thorn, flat ground, a lattice. */
const NONE = new Set(["wire", "wire1", "wire2", "ambushScreen", "mineMarker", "zeriba1", "zeriba2", "helipad", "searchlight", "cemetery"]);

/** A placed piece's footprint as circles (world), turned with it. */
function circlesOf(mesh, hard) {
  const ud = mesh.geometry?.userData;
  const fp = ud?.footprint;
  if (!fp) return [];
  const c = Math.cos(mesh.rotation.y), s = Math.sin(mesh.rotation.y);
  const out = [];
  const put = (lx, lz, r, h = hard, ox = fp.cx, oz = fp.cz) => {
    const x = ox + lx, z = oz + lz;
    out.push({ x: mesh.position.x + x * c + z * s, z: mesh.position.z - x * s + z * c, radius: r, size: 1, hard: h });
  };
  // WALL LINES (piece frame, scaled): circles 1.2 m every 1.6 m along each.
  for (const w of ud.coverLines ?? []) {
    for (let i = 0; i < w.pts.length - 1; i++) {
      const [ax, az] = w.pts[i], [bx, bz] = w.pts[i + 1];
      const k = Math.max(1, Math.round(Math.hypot(bx - ax, bz - az) / 1.6));
      for (let j = 0; j <= k; j++) put(ax + ((bx - ax) * j) / k, az + ((bz - az) * j) / k, 1.2, w.hard ?? true, 0, 0);
    }
  }
  // `coverPerimeter: false`: the lines are all the cover it gives (a garden,
  // terraces), or none at all (a threshing floor: flat).
  if (ud.coverPerimeter === false) return out;
  const along = (h, r) => {
    const span = Math.max(0, h - r), n = Math.max(1, Math.round((2 * span) / (r * 1.4)) + 1);
    return Array.from({ length: n }, (_, i) => (n === 1 ? 0 : -span + (2 * span * i) / (n - 1)));
  };
  if (Math.min(fp.hx, fp.hz) > 6) {
    // A BIG building (the post, the dechra, a mechta): cover along its
    // walls, not over its courtyard and forecourt — tiled over the whole
    // footprint, a man 35 m out in front of the post's gate had cover 0.94
    // in the open (measured).
    const r = 2;
    for (const lx of along(fp.hx, r)) { put(lx, -fp.hz + r, r); put(lx, fp.hz - r, r); }
    for (const lz of along(fp.hz, r)) { put(-fp.hx + r, lz, r); put(fp.hx - r, lz, r); }
    return out;
  }
  // A small piece: circles of radius r, 1.4 r apart, over the footprint (one
  // row for a run of sandbags, a patch for a pit).
  const r = Math.max(0.9, Math.min(3, fp.hx, fp.hz));
  for (const lx of along(fp.hx, r)) for (const lz of along(fp.hz, r)) put(lx, lz, r);
  return out;
}

export function createAlgCover(app, { showroom = {}, isArmed = () => true } = {}) {
  // AMBUSH SCREENS conceal (no cover: brush stops no bullet): the strip just
  // BEHIND the hedge (its +z, where the water skin lies) reads as full scrub.
  // Collected at every bake, so one the ALN raises counts once it stands.
  const screens = [];
  const concealExtra = (x, z) => {
    for (const q of screens) {
      const dx = x - q.x, dz = z - q.z;
      const lx = q.c * dx - q.s * dz, lz = q.s * dx + q.c * dz;
      if (Math.abs(lx - q.fp.cx) <= q.fp.hx * 0.72 && lz >= q.fp.cz - 0.6 && lz <= q.fp.cz + q.fp.hz + 2.4) return 1;
    }
    // Beside a prickly-pear hedge (algFields.js).
    return app.algFields?.concealAt(x, z) ?? 0;
  };
  const cover = createCover({
    app, worldSize: app.worldSize ?? 1024, params: ALG_COVER, concealExtra,
    *extra() {
      screens.length = 0;
      // The field walls (algFields.js; made after this — the game re-bakes).
      if (app.algFields) yield* app.algFields.coverCircles();
      // The rock outcrops (algLandmarks.js).
      if (app.algLandmarks) yield* app.algLandmarks.coverCircles();
      // The vehicle wrecks (algWrecks.js).
      if (app.algWrecks) yield* app.algWrecks.coverCircles();
      for (const [name, mesh] of Object.entries(showroom)) {
        // A sapper's piece is listed as "built:<kind>:<n>"; its kind decides.
        const key = mesh?.userData?.kitKey ?? name;
        if (key === "ambushScreen" && mesh?.parent && mesh.geometry?.userData?.footprint) {
          screens.push({ x: mesh.position.x, z: mesh.position.z, c: Math.cos(mesh.rotation.y), s: Math.sin(mesh.rotation.y), fp: mesh.geometry.userData.footprint });
        }
        if (!mesh?.isObject3D || NONE.has(key) || !mesh.parent) continue;
        // A breached sandbag wall (algDamage.js): knee-high stubs, soft cover.
        yield* circlesOf(mesh, HARD.has(key) && !mesh.userData.breached);
      }
    },
  });
  const stamped = cover.bake();
  const overlay = createCoverOverlay({ app, cover, isArmed });
  return { cover, overlay, stamped };
}
