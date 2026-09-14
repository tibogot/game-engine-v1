// v3/ui/editorLayout.js panel width clamping (v3/AUDIT.md #90): a panel keeps
// its minimum, and no drag or window size squeezes the viewport under 320 px.
import { clampPanelWidth } from "../v3/ui/editorLayout.js";

let fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  if (!ok) fail++;
};

check("a normal width passes through", clampPanelWidth("left", 300, 1920, 300) === 300);
check("left panel has a 160 px minimum", clampPanelWidth("left", 40, 1920, 300) === 160);
check("right panel has a 240 px minimum", clampPanelWidth("right", 100, 1920, 220) === 240);
check("the viewport keeps 320 px", clampPanelWidth("right", 5000, 1920, 220) === 1920 - 220 - 320);
check("widths are whole pixels", clampPanelWidth("left", 250.6, 1920, 300) === 251);
check("a tiny window still gives the panel its minimum", clampPanelWidth("left", 400, 500, 300) === 160);

if (fail) { console.log(`\n${fail} failed`); process.exit(1); }
console.log("\nall passed");
