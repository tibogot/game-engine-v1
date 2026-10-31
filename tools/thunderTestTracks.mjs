// node tools/thunderTestTracks.mjs — writes games/thunderline/campaign/tests.json: Claude's physics test tracks (the same ones it drives) — built from piece chains
import fs from "node:fs";
const S = "straight_64", Y = 40;
const M = (x, y, z) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
const chain = (ids) => { const pieces = []; let parent = null; ids.forEach((id, k) => { pieces.push({ uid: k + 1, id, open: false, M: M(0, Y, 0), parent, flightFrom: null }); parent = k + 1; }); return pieces; };
const course = (ids) => chain(["start_line", ...ids, "finish_line"]);
// a road, a GAP of G m with the next road H m lower (Apex Rush's gaps), then the finish
const gap = (G, H) => {
  const zEnd = -(36 + 128), y2 = Y - H, z2 = zEnd - G;
  return [
    { uid: 1, id: "start_line", open: false, M: M(0, Y, 0), parent: null, flightFrom: null },
    { uid: 2, id: S, open: false, M: M(0, Y, 0), parent: 1, flightFrom: null },
    { uid: 3, id: S, open: false, M: M(0, Y, 0), parent: 2, flightFrom: null },
    { uid: 4, id: S, open: false, M: M(0, y2, z2), parent: null, flightFrom: 3 },
    { uid: 5, id: S, open: false, M: M(0, y2, z2), parent: 4, flightFrom: null },
    { uid: 6, id: "finish_line", open: false, M: M(0, y2, z2), parent: 5, flightFrom: null },
  ];
};
const T = [
  ["Turns · 90° (48 m and 96 m)", "Corner speeds: 96 m ≈ flat out, 48 m ≈ 140 km/h.", course([S, S, "turn_48_90", S, "turn_48_90_L", S, "turn_96_90", S, "turn_96_90_L", S, S])],
  ["Turns · U-turns 48 m", "~140 km/h on the grip, more with a drift.", course([S, S, S, "turn_48_180", S, S, "turn_48_180_L", S, S])],
  ["Turns · hairpins 24 m", "~85 km/h on the grip, ~130 with a handbrake drift.", course([S, S, S, "hairpin_24", S, S, "hairpin_24_L", S, S])],
  ["Turns · twisty", "S-bend, snake, brake turn, sweep, fast 45°.", course([S, "s_bend_96", "snake_60", S, "brake_turn_32", S, "sweep_160_45", "turn_96_45_L", S])],
  ["Stunt · loop", "", course([S, S, S, "loop_28", S, S])],
  ["Stunt · half loop + roll", "", course([S, S, S, "half_loop_28", S, S])],
  ["Stunt · twist 360°", "", course([S, S, S, "twist_120", S, S])],
  ["Stunt · sky loop", "", course([S, S, S, "sky_loop", S, S])],
  ["Stunt · wall ride 90°", "", course([S, S, S, "wallride_90", S, S])],
  ["Stunt · helix up 360°", "", course([S, S, S, "helix_up_360", S, S])],
  ["Stunt · U-turn wall", "No jump on the way in (2026-10-31).", course([S, S, S, "uturn_wall_32", S, S])],
  ["Slopes · slopes, platforms, rollers", "Flat out: no hops (rollers: a skim).", course([S, S, S, "slope_up_12", S, "slope_down_12", S, "platform_up_12", "platform_down_12", S, "rollers_64", S, S])],
  ["Banks · two banked 45°", "Bank in, 45° + 45°, bank out (the shift you felt).", course([S, S, S, "bank_in_22", "banked_turn_45", "banked_turn_45", "bank_out_22", S, S])],
  ["Banks · banked 180°", "", course([S, S, S, "bank_in_22", "banked_turn_180", "bank_out_22", S, S])],
  ["Banks · banked straight", "Bank in, two banked straights, bank out.", course([S, S, "bank_in_22", "banked_straight_64", "banked_straight_64", "bank_out_22", S, S])],
  ["Gaps · 40 m, 4 m lower", "A road ends, a gap, the next road (land ~180 km/h).", gap(40, 4)],
  ["Gaps · 20 m, same height", "The ledge catch: lands from ~150 km/h.", gap(20, 0)],
  ["Gaps · 40 m, same height", "", gap(40, 0)],
  ["Gaps · 60 m, 8 m lower", "Land ~220 km/h.", gap(60, 8)],
  ["Gaps · two Gap jump pieces", "The Gap jump catches 120–220 km/h.", course([S, S, "gap_jump", S, "gap_jump", S])],
  ["Mixed · many pieces", "Turns, sweeps, S-bend, snake, slopes, rollers, banks, brake turn — the long check.", course([S, S, "turn_96_45_L", S, "sweep_160_30", "s_bend_96", "snake_60", S, "slope_up_12", "slope_down_12", "rollers_64", S, "bank_in_22_L", "banked_turn_45_L", "bank_out_22_L", S, "turn_48_90", S, "turn_48_90_L", S, "turn_96_90_L", S, "brake_turn_32", S, S])],
];
const out = { tier: "tests", name: "Test tracks", tracks: T.map(([name, description, pieces], k) => ({ id: `tests-${k + 1}`, name, tier: "tests", track: { pieces, nextUid: Math.max(...pieces.map((p) => p.uid)) + 1, world: "flat_grid", ...(description ? { description } : {}) } })) };
fs.writeFileSync(new URL("../games/thunderline/campaign/tests.json", import.meta.url), JSON.stringify(out));
console.log(out.tracks.length, "tracks", fs.statSync(new URL("../games/thunderline/campaign/tests.json", import.meta.url)).size, "bytes");
