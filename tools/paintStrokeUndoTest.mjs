/**
 * A painted stroke undoes and redoes to the exact bytes — with the pre-stroke
 * state copied lazily, tile by tile (paintSystem.js _ensurePre), instead of the
 * whole map at stroke start.
 * Run: node tools/paintStrokeUndoTest.mjs   (picked up by npm test)
 */
import { SplatMap, SPLAT_RES } from "../v3/terrain/splatMap.js";
import { PaintSystem } from "../v3/tools/paintSystem.js";
import { WORLD_SIZE } from "../v3/terrain/heightmapTexture.js";

let pass = 0, fail = 0;
function ok(name, cond, extra = "") {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
}

const paintState = {
  activeLayer: 1, brushOpacity: 1, targetStrength: 1,
  brush: { radius: 30, strength: 0.7, falloff: 1, spacingFactor: 0.15 },
  noiseMask: 0, noiseScale: 3, noiseOctaves: 3, noiseEdgeOnly: false,
};
const sm = new SplatMap();
const ps = new PaintSystem({ paintState, splatMap: sm });

// Existing paint everywhere, so the stroke has something to scale down.
for (let i = 0; i < sm.data0.length; i += 4) { sm.data0[i + 1] = 90; sm.data1[i] = 40; }
const snap = () => [sm.data0.slice(), sm.data1.slice(), sm.holeUser.slice()];
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const before = snap();

// A long diagonal stroke across many 64² tiles, then a second layer crossing it.
const H = WORLD_SIZE * 0.4;
ps.beginStroke(-H, -H);
for (let t = 0; t <= 1.0001; t += 0.02) ps.continueStroke(-H + 2 * H * t, -H + 1.2 * H * t);
ps.endStroke();
const afterOne = snap();
ok("the stroke changed the paint", !same(afterOne[0], before[0]));

paintState.activeLayer = 5;
ps.beginStroke(H, -H);
for (let t = 0; t <= 1.0001; t += 0.05) ps.continueStroke(H - 2 * H * t, -H + 2 * H * t);
ps.endStroke();
const afterTwo = snap();

ps.undo();
const u1 = snap();
ok("undo of stroke 2 restores stroke 1's bytes (slice 0)", same(u1[0], afterOne[0]));
ok("… slice 1", same(u1[1], afterOne[1]));
ps.undo();
const u0 = snap();
ok("undo of stroke 1 restores the original bytes (slice 0)", same(u0[0], before[0]));
ok("… slice 1", same(u0[1], before[1]));
ok("… holes", same(u0[2], before[2]));
ps.redo(); ps.redo();
const r2 = snap();
ok("redo twice is stroke 2 again", same(r2[0], afterTwo[0]) && same(r2[1], afterTwo[1]));

// A stroke that touches nothing records nothing.
const depth = ps.undoStack.length;
ps.beginStroke(WORLD_SIZE * 2, WORLD_SIZE * 2); ps.endStroke();
ok("a stroke outside the map adds no undo step", ps.undoStack.length === depth);
ok("the map is " + SPLAT_RES + "²", sm.res === SPLAT_RES);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
