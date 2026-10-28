// THE ASSET LAB'S CATALOGUE (asset-lab.html — user, 2026-10-28: "all my games I'm building labs to build the assets on
// this lab page … a lab page that shows the new assets we are making"). One entry per asset the game draws, new or
// still the old one, with where it stands; a rejected try stays as an old version with its verdict. The list of record
// is games/thunderline/TODO.md "AAA obstacles & signs"; this is what the lab shows of it.
//
//   kind      a knockable prop kind (physProps.js): its Blender model (the new look) and the procedural one (old)
//   obstacle  its entry in obstacles.js OBSTACLES: the arrangement as placed in the game, or the old look of a fixed one
//   status    "game" in the game · "judge" made, for you to judge · "making" being made · "planned"

export const SECTIONS = [
  { id: "obstacles", label: "Obstacles", note: "On the road: knocked flying, or driven round. Real motorsport props." },
  { id: "signs", label: "Signs", note: "Beside and over the road: trackside boards and banners." },
];

export const STATUS = {
  game: { label: "In the game", color: "#9dff00" },
  judge: { label: "To judge", color: "#ffd23f" },
  making: { label: "Making", color: "#3fd2ff" },
  planned: { label: "Planned", color: "#8b8b95" },
};

export const ENTRIES = [
  {
    id: "tyre", section: "obstacles", label: "Tyre stack", kind: "tyre", obstacle: "ob_tyres", status: "game",
    about: "A worn truck tyre (385/65 R22.5) at the stack's 1.4 m: chevron lugs as geometry, a bulging sidewall with " +
      "rim-protector ribs and raised lettering, dust in the grooves. Three stacked; they scatter when hit.",
    script: "tools/blender/thunderTyre.py",
  },
  { id: "barrel", section: "obstacles", label: "Oil drum", kind: "barrel", obstacle: "ob_barrel", status: "game",
    about: "A 200 L steel drum at the game's 1.5 m: rolled rims, two rolling hoops, a recessed lid with its bung caps, " +
      "the weld seam, a few dents; red paint chipped to steel or rust where it gets knocked, rust run down from the top, " +
      "grime at the foot, a white stencil and a worn label. It rolls away.",
    script: "tools/blender/thunderBarrel.py" },
  { id: "cone", section: "obstacles", label: "Traffic cone", kind: "cone", obstacle: "ob_cone", status: "game",
    about: "A 0.93 m motorway cone: fluorescent red-orange PVC, open at the top, flared into a heavy recycled-rubber base; " +
      "two retroreflective sleeves (microprism, peeling a little), tyre scuffs, dust at the foot, the standard moulded " +
      "on the flange. Knocked flying; the cone row uses it too.",
    script: "tools/blender/thunderCone.py" },
  { id: "cones", section: "obstacles", label: "Cone row", kind: "cone", obstacle: "ob_cones", status: "game",
    about: "Six cones across the road (the same cone)." },
  { id: "gates", section: "obstacles", label: "Swing gates", kind: "gate", obstacle: "ob_swing_gate", status: "planned",
    about: "A steel tube frame on hinged posts with a chevron banner: smash through." },
  { id: "pole", section: "obstacles", label: "Bollard", obstacle: "ob_pole", status: "planned",
    about: "A steel bollard with reflective bands on a bolted base plate — the pole, the slalom and the pole gate." },
  { id: "block", section: "obstacles", label: "Stunt box", obstacle: "ob_block", status: "planned",
    about: "A steel-framed box with a diamond-plate top (you land on it) and chevron edges." },
  { id: "wall_door", section: "obstacles", label: "Wall · door", obstacle: "ob_wall_door", status: "planned",
    about: "A stunt wall: panels on a truss frame, the door trimmed and lit." },
  { id: "wall_hole", section: "obstacles", label: "Wall · hole", obstacle: "ob_wall_hole", status: "planned",
    about: "The same wall in the air, its hole trimmed and lit." },
  { id: "sg_start", section: "signs", label: "Start", obstacle: "sg_start", status: "planned", about: "The start board." },
  { id: "sg_finish", section: "signs", label: "Finish", obstacle: "sg_finish", status: "planned", about: "The finish board." },
  { id: "sg_chevron", section: "signs", label: "Chevron", obstacle: "sg_chevron", status: "planned", about: "A turn's chevron boards." },
  { id: "sg_aim", section: "signs", label: "Aim", obstacle: "sg_aim", status: "planned", about: "The aim marker." },
];
