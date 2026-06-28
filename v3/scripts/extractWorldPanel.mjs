import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..", "..");
const editorLines = fs
  .readFileSync(path.join(root, "v2/editor.html"), "utf8")
  .split(/\r?\n/);

// buildWorldTab: Sun..Interior (12937–13891), skip volumetric clouds (13892–15025), then Terrain/LOD + Audio + Perf (15026–15101)
const partA = editorLines.slice(12936, 13891);
const partB = editorLines.slice(15025, 15101);
let body = [...partA, ...partB].join("\n");

body = body.replace(
  /^\s{6}function buildWorldTab\(app\) \{/m,
  "export function buildWorldPanel(app) {",
);
body = body.replace(
  /^\s{8}const container = document\.getElementById\("tab-world"\);\n\s{8}container\.innerHTML = "";/m,
  '  const container = document.getElementById("tab-world");\n  if (!container) return null;\n  container.innerHTML = "";',
);
body = body.replace(
  /app\.ui\?\.pane\.refresh\(\)/g,
  "app.ui?.pane?.refresh?.()",
);
body = body.split("\n").map((l) => l.replace(/^  /, "")).join("\n");

// _info (2333–2347) + _buildProceduralSkyControls (2363–2958) — skip duplicate _separator
const procSkyHelper =
  editorLines.slice(2332, 2347).join("\n") +
  "\n" +
  editorLines.slice(2362, 2959).join("\n");
const procDeindented = procSkyHelper
  .split("\n")
  .map((l) => l.replace(/^      /, ""))
  .join("\n");

const baseWidgets = fs.readFileSync(
  path.join(root, "v3/ui/propsPanelWidgets.txt"),
  "utf8",
);
// Drop props-only exports from the shared widget file.
const widgets = baseWidgets
  .replace(/^import[\s\S]*?\n\n/m, "")
  .replace(/\n\/\*\* Build the v2 props panel[\s\S]*$/m, "")
  .replace(/^export async function defaultBakeProceduralThumbnails[\s\S]*?\n\n/m, "");

const header = `/** V2 World tab UI — extracted from v2/editor.html buildWorldTab (no volumetric cloud sections). */\n\nfunction refreshLiveSliders() {}\n\n`;

const out =
  header +
  widgets +
  "\n" +
  procDeindented +
  "\n\n" +
  body +
  "\n";

fs.writeFileSync(path.join(root, "v3/ui/buildWorldPanel.js"), out);
console.log("Wrote buildWorldPanel.js", out.split("\n").length, "lines");
