// Paint-mode undo for edits that are not splat pixels (v3/tools/paintSystem.js
// recordAction) — used by procedural paint layer settings (AUDIT 9). They share
// the stroke history, so Ctrl+Z walks back through strokes and layer edits in
// the order they happened.
import { SplatMap, SPLAT_RES } from "../v3/terrain/splatMap.js";
import { PaintSystem } from "../v3/tools/paintSystem.js";

let fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  if (!ok) fail++;
};

const centre = (SPLAT_RES / 2) * SPLAT_RES + SPLAT_RES / 2;
const w1 = (sm) => sm.data0[centre * 4];                // layer 1 weight byte at (0,0)

function makeSystem() {
  const paintState = {
    activeLayer: 1, brushOpacity: 1, targetStrength: 1,
    brush: { radius: 20, strength: 1, falloff: 0, spacingFactor: 0.1 },
    noiseMask: 0, noiseScale: 3, noiseOctaves: 3, noiseEdgeOnly: false,
    maskRotation: 0, maskRandomRotation: false, maskFollowStroke: false,
  };
  const sm = new SplatMap();
  const ps = new PaintSystem({ paintState, splatMap: sm });
  // The "procedural layer" under test: a plain object the action restores.
  const layer = { value: 0 };
  const edit = (to, t) => {
    const before = { value: layer.value };
    layer.value = to;
    return ps.recordAction({ key: "proc:0", before, after: { value: layer.value }, apply: (s) => { layer.value = s.value; }, now: t });
  };
  const stroke = () => { ps.beginStroke(0, 0); ps.endStroke(); };
  return { ps, sm, layer, edit, stroke };
}

// ── A slider drag is ONE step ──
{
  const { ps, layer, edit } = makeSystem();
  for (let i = 1; i <= 30; i++) edit(i, 1000 + i * 16);     // 30 inputs, 16 ms apart
  check("a 30-tick drag records one undo step", ps.undoStack.length === 1, `steps=${ps.undoStack.length}`);
  ps.undo();
  check("undoing it returns to where the drag started", layer.value === 0, `value=${layer.value}`);
  ps.redo();
  check("redo goes to where the drag ended", layer.value === 30, `value=${layer.value}`);
}

// ── Two drags with a pause are TWO steps ──
{
  const { ps, layer, edit } = makeSystem();
  edit(5, 1000); edit(6, 1016);
  edit(9, 3000); edit(10, 3016);                            // > 800 ms later
  check("drags separated by a pause are separate steps", ps.undoStack.length === 2);
  ps.undo();
  check("the first undo only reverts the second drag", layer.value === 6, `value=${layer.value}`);
}

// ── A drag that ends where it started leaves nothing to undo ──
{
  const { ps, edit } = makeSystem();
  edit(4, 1000); edit(2, 1016); edit(0, 1032);
  check("a drag back to the start leaves no step", ps.undoStack.length === 0, `steps=${ps.undoStack.length}`);
  check("an edit that changes nothing records nothing", edit(0, 5000) === false && ps.undoStack.length === 0);
}

// ── Strokes and layer edits interleave in order ──
{
  const { ps, sm, layer, edit, stroke } = makeSystem();
  edit(1, 1000);          // layer edit
  stroke();               // paint
  edit(2, 1100);          // layer edit — only 100 ms after the first, but a stroke is in between
  check("a stroke between two edits keeps them separate", ps.undoStack.length === 3, `steps=${ps.undoStack.length}`);
  ps.undo();
  check("undo 1: the latest layer edit", layer.value === 1 && w1(sm) === 255);
  ps.undo();
  check("undo 2: the stroke", layer.value === 1 && w1(sm) === 0, `w=${w1(sm)}`);
  ps.undo();
  check("undo 3: the first layer edit", layer.value === 0);
  ps.redo(); ps.redo(); ps.redo();
  check("redo replays all three in order", layer.value === 2 && w1(sm) === 255);
}

// ── A new edit after undo clears redo ──
{
  const { ps, edit } = makeSystem();
  edit(1, 1000);
  ps.undo();
  edit(7, 5000);
  check("a new edit after undo clears the redo stack", ps.redoStack.length === 0 && ps.undoStack.length === 1);
}

// ── Undo then edit again does not coalesce into the undone step ──
{
  const { ps, layer, edit } = makeSystem();
  edit(1, 1000);
  ps.undo();
  edit(3, 1010);          // 10 ms later, same key
  ps.undo();
  check("an edit right after undo is its own step", layer.value === 0, `value=${layer.value}`);
}

// ── Project load forgets everything ──
{
  const { ps, edit, stroke } = makeSystem();
  edit(1, 1000); stroke();
  ps.clearHistory();
  check("clearHistory empties both stacks", ps.undoStack.length === 0 && ps.redoStack.length === 0 && ps.undo() === false);
}

console.log(fail === 0 ? "\nall passed" : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
