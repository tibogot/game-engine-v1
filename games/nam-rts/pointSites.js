// Requisition point SITES, per map — real ground, not a fan.
//
// Chosen on nam-valley by PATH length from each HQ (navGrid.findPath, with the
// bridge landings graded), not by straight distance: the camp gate, the river
// and the terraces make the two very different. The seven balance — your
// total walk to all of them is 4,499 m, the enemy's 4,570 m (HQ to HQ 1,228):
//
//   A  Hill 47        386 / 852    yours to lose — a knoll above the camp
//   B  South Bridge   426 / 881    the west bank over the south bridge
//   C  North Bridge   675 / 593    the east landing of the gorge bridge
//   D  Hill 83        664 / 786    the summit of the central massif
//   E  Hill 45        624 / 621    the dead-centre of the east flank
//   F  Hill 69        948 / 288    theirs — the ridge over their valley
//   G  Hill 48        776 / 549    theirs — the east shoulder
//
// (your path / theirs, metres). Hills are named for their height, the way the
// army named them. A map with no entry here falls back to the old fan.
export const POINT_SITES = {
  "nam-valley": [
    { letter: "A", name: "Hill 47", x: 100, z: -230 },
    { letter: "B", name: "South Bridge", x: -238, z: -282 },
    { letter: "C", name: "North Bridge", x: -115, z: -147 },
    { letter: "D", name: "Hill 83", x: 13, z: 37 },
    { letter: "E", name: "Hill 45", x: 227, z: 17 },
    { letter: "F", name: "Hill 69", x: -150, z: 150 },
    { letter: "G", name: "Hill 48", x: 168, z: 151 },
  ],
};

/**
 * The Front's TUNNEL ENTRANCES (rtsEnemyKit.buildTunnelEntrance): where its
 * men come up. All in jungle (foliage density 0.55–0.73 at the site) and all
 * on its side of the map — two forward on the flanks, two behind its ridge —
 * measured by path like the points (your path / theirs):
 *
 *   west flank   884 / 433      east flank   713 / 529
 *   west ridge  1007 / 233      north       1189 / 142
 *
 * The bare summit and the open east ridge were left out: a tunnel in the open
 * is a hole with a man standing in it.
 */
export const TUNNEL_SITES = {
  "nam-valley": [
    { x: -210, z: 70 },
    { x: 257, z: 97 },
    { x: -110, z: 185 },
    { x: -23, z: 239 },
  ],
};

const mapKey = (worldName) => String(worldName ?? "").replace(/\.v3proj$/i, "").replace(/^.*[\\/]/, "");

/** The authored sites for a level ("nam-valley.v3proj" → "nam-valley"), or null. */
export function pointSitesFor(worldName) {
  return POINT_SITES[mapKey(worldName)] ?? null;
}

/** The level's tunnel entrances, or an empty list. */
export function tunnelSitesFor(worldName) {
  return TUNNEL_SITES[mapKey(worldName)] ?? [];
}
