// v3/tools/snapshotHistory.js — the undo history roads and lakes use
// (v3/AUDIT.md #85): commit-after-edit, drags as one step, coalesced slider
// bursts, no step for no-op edits, reset on load.
import { createSnapshotHistory } from "../v3/tools/snapshotHistory.js";

let fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  if (!ok) fail++;
};

let clock = 0;
const model = { items: [], selected: null };
const h = createSnapshotHistory({
  capture: () => JSON.stringify(model.items),   // selection deliberately left out
  restore: (s) => { model.items = JSON.parse(s); },
  now: () => clock,
  max: 5,
});
const items = () => JSON.stringify(model.items);

h.record(() => model.items.push({ x: 1 }));
h.record(() => model.items.push({ x: 2 }));
check("two edits are two steps", h.canUndo && h.undo() && items() === '[{"x":1}]');
check("redo brings the edit back", h.redo() && items() === '[{"x":1},{"x":2}]');
check("nothing to redo after that", !h.redo());

model.selected = 1;
check("a selection-only change adds no step", h.commit() === false);

// A drag: many moves, one commit on release.
for (let i = 0; i < 20; i++) model.items[0].x = 10 + i;
h.commit();
h.undo();
check("a whole drag is one step", items() === '[{"x":1},{"x":2}]');
h.redo();

// A slider burst with a coalesce key.
for (let i = 0; i < 10; i++) { model.items[1].x = 100 + i; clock += 100; h.commit({ coalesce: "size" }); }
h.undo();
check("a slider burst is one step", items() === '[{"x":29},{"x":2}]', items());
h.redo();
clock += 5000;
model.items[1].x = 500; h.commit({ coalesce: "size" });
h.undo();
check("the same slider much later is a new step", items() === '[{"x":29},{"x":109}]', items());
h.redo();

model.items.push({ x: 3 }); h.commit();
h.undo();
check("an edit after undo…", items() === '[{"x":29},{"x":500}]');
model.items.push({ x: 9 }); h.commit();
check("…clears redo", !h.redo());

for (let i = 0; i < 10; i++) { model.items.push({ x: i }); h.commit(); }
let steps = 0;
while (h.undo()) steps++;
check("history is capped", steps === 5, `${steps}`);

model.items = [{ loaded: true }];   // a project load replaces the state wholesale
h.reset();
check("reset forgets everything", !h.canUndo && !h.canRedo);
model.items = []; h.commit();
check("the first undo after reset goes back to the loaded state, no further",
  h.undo() && items() === '[{"loaded":true}]' && !h.undo());

if (fail) { console.log(`\n${fail} failed`); process.exit(1); }
console.log("\nall passed");
