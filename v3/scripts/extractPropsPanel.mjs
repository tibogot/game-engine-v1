import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const lines = fs.readFileSync(path.join(root, "v2/editor.html"), "utf8").split(/\r?\n/);
const slice = lines.slice(4857, 5480);
let body = slice.join("\n");
body = body.replace(/^\s{6}function buildPropsPanel\(app\) \{/m, "export function buildPropsPanel(app) {");
body = body.replace(
  /^\s{8}const panel = document\.createElement\("div"\);\n\s{8}panel\.id = "props-panel";/m,
  '  const panel = document.getElementById("props-panel");\n  if (!panel) return null;\n  panel.innerHTML = "";',
);
body = body.split("\n").map((l) => l.replace(/^  /, "")).join("\n");

const widgets = fs.readFileSync(path.join(root, "v3/ui/propsPanelWidgets.txt"), "utf8");
const out = widgets + "\n" + body + "\n";
fs.writeFileSync(path.join(root, "v3/ui/buildPropsPanel.js"), out);
console.log("Wrote buildPropsPanel.js", out.split("\n").length, "lines");
