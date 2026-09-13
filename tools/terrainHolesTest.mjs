// Terrain holes live in the splat map's slice 1 alpha (v3/terrain/splatMap.js).
// They are NOT paint: the eraser, Clear and Fill must keep them, the paint
// flag must ignore them, and only the hole card (and Alt on it) changes them.
import { SplatMap, SPLAT_RES, HOLE_LAYER, HOLE_ERASE_LAYER } from "../v3/terrain/splatMap.js";
import { WORLD_SIZE } from "../v3/terrain/heightmapTexture.js";

let fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  if (!ok) fail++;
};
// falloff 0 = a hard-edged stamp (full strength everywhere inside the radius),
// so a single erase stamp fully covers a smaller hole.
const stamp = (sm, activeLayer, cx = 0, cz = 0, radius = WORLD_SIZE * 0.05) =>
  sm.applySplatStroke({ cx, cz, radius, strength: 1, falloff: 0, activeLayer });
const alphaSum = (sm) => { let n = 0; for (let i = 3; i < sm.data1.length; i += 4) n += sm.data1[i]; return n; };

const sm = new SplatMap();
check("a fresh map has no holes and no paint", !sm.hasAnyHoles() && !sm.hasAnyPaint());

stamp(sm, HOLE_LAYER);
check("painting a hole sets hasAnyHoles", sm.hasAnyHoles());
sm._hasPaintDirty = true;
check("a hole is not paint (hasAnyPaint stays false)", !sm.hasAnyPaint());
check("holeAt the centre is a hole", sm.holeAt(0, 0) > 0.9, sm.holeAt(0, 0).toFixed(3));
check("holeAt far away is solid", sm.holeAt(WORLD_SIZE * 0.4, WORLD_SIZE * 0.4) === 0);

const holesBefore = alphaSum(sm);
stamp(sm, 0); // the paint eraser, right over the hole
check("the paint eraser leaves holes alone", alphaSum(sm) === holesBefore);

stamp(sm, 3); // paint layer 3 over the hole
check("painting a layer leaves holes alone", alphaSum(sm) === holesBefore);
check("painting a layer is paint", sm.hasAnyPaint());

sm.clearAll();
check("Clear removes paint but keeps holes", !sm.hasAnyPaint() && alphaSum(sm) === holesBefore);

sm.fillAllWithLayer(2);
check("Fill with a layer keeps holes", alphaSum(sm) === holesBefore);
const d0Before = sm.data0.slice();
sm.fillAllWithLayer(HOLE_LAYER);
check("Fill with the hole card does nothing", alphaSum(sm) === holesBefore && sm.data0.every((v, i) => v === d0Before[i]));

stamp(sm, HOLE_ERASE_LAYER, 0, 0, WORLD_SIZE * 0.1);
check("Alt on the hole card fills the hole back in", alphaSum(sm) === 0, `alpha sum ${alphaSum(sm)}`);
check("…and hasAnyHoles goes back to false", !sm.hasAnyHoles());

// Undo path: copyRect / pasteRect must carry holes and refresh the flag.
stamp(sm, HOLE_LAYER);
const full = { x: 0, y: 0, w: SPLAT_RES, h: SPLAT_RES };
const withHole = sm.copyRect(full);
stamp(sm, HOLE_ERASE_LAYER, 0, 0, WORLD_SIZE * 0.1);
check("(setup) hole erased", !sm.hasAnyHoles());
sm.pasteRect(withHole);
check("pasting an undo patch brings the hole back", sm.hasAnyHoles() && sm.holeAt(0, 0) > 0.9);

sm.clearHoleChannel();
check("clearHoleChannel removes every hole", !sm.hasAnyHoles() && alphaSum(sm) === 0);

console.log(fail ? `\n${fail} FAILED` : "\nall good");
process.exit(fail ? 1 : 0);
