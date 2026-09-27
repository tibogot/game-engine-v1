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

export const ALG_COVER = { ...COVER, concealFloor: 0.2, concealCeil: 0.65, maxConcealment: 0.6 };

/** Stone and sandbags: hard cover. */
const HARD = new Set(["frenchPost", "sangar", "mgNest", "mortarPit", "sandbags1", "sandbags2", "dechra", "mechta", "mechta2", "koubba", "caveEntrance", "sasPost", "armsCache", "alnCamp", "wellHamlet1", "wellHamlet2"]);
/** No cover at all: wire, brush, thorn, flat ground, a lattice. */
const NONE = new Set(["wire1", "wire2", "ambushScreen", "mineMarker", "zeriba1", "zeriba2", "helipad", "searchlight", "cemetery"]);

/** A placed piece's footprint as circles (world), turned with it. */
function circlesOf(mesh, hard) {
  const fp = mesh.geometry?.userData?.footprint;
  if (!fp) return [];
  const c = Math.cos(mesh.rotation.y), s = Math.sin(mesh.rotation.y);
  const out = [];
  const put = (lx, lz, r) => {
    const x = fp.cx + lx, z = fp.cz + lz;
    out.push({ x: mesh.position.x + x * c + z * s, z: mesh.position.z - x * s + z * c, radius: r, size: 1, hard });
  };
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
  const cover = createCover({
    app, worldSize: app.worldSize ?? 1024, params: ALG_COVER,
    *extra() {
      for (const [key, mesh] of Object.entries(showroom)) {
        if (!mesh?.isObject3D || NONE.has(key) || !mesh.parent) continue;
        yield* circlesOf(mesh, HARD.has(key));
      }
    },
  });
  const stamped = cover.bake();
  const overlay = createCoverOverlay({ app, cover, isArmed });
  return { cover, overlay, stamped };
}
