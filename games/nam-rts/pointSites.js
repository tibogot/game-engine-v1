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

/** The authored sites for a level ("nam-valley.v3proj" → "nam-valley"), or null. */
export function pointSitesFor(worldName) {
  const key = String(worldName ?? "").replace(/\.v3proj$/i, "").replace(/^.*[\\/]/, "");
  return POINT_SITES[key] ?? null;
}
