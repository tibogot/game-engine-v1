import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..", "..");
const lines = fs.readFileSync(path.join(root, "v2/editor.html"), "utf8").split(/\r?\n/);
const slice = lines.slice(10536, 11115);
let body = slice.join("\n");
body = body.replace(/^\s{6}function buildSplinePanel\(app\) \{/m, "export function buildSplinePanel(app) {");
body = body.replace(
  /^\s{8}const panel = document\.createElement\("div"\);\n\s{8}panel\.id = "spline-panel";/m,
  '  const panel = document.getElementById("spline-panel");\n  if (!panel) return null;\n  panel.innerHTML = "";',
);
// De-indent by 2 spaces (was nested inside editor.html script)
body = body.split("\n").map((l) => l.replace(/^  /, "")).join("\n");

const widgets = fs.readFileSync(path.join(root, "v3/ui/splinePanelWidgets.txt"), "utf8");

const out = widgets + "\n" + body + "\n";
fs.writeFileSync(path.join(root, "v3/ui/buildSplinePanel.js"), out);
console.log("Wrote buildSplinePanel.js", out.split("\n").length, "lines");
