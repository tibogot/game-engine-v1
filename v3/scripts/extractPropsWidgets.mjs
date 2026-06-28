import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const lines = fs.readFileSync(path.join(root, "v2/editor.html"), "utf8").split(/\r?\n/);
const dedent = (slice) => slice.map((l) => l.replace(/^      /, "")).join("\n");

const dropHelpers = dedent(lines.slice(1825, 1900));
const widgets = dedent(lines.slice(2079, 2335));

const out = `import { bakeObjectThumbnails } from "../../v2/tools/objectThumbnails.js";
import { proceduralThumbnailItems } from "../../v2/core/props/proceduralObjectProps.js";

const _checkSvg =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';

${dropHelpers}

${widgets}

/** Default bake helper wired from main.js renderer. */
export async function defaultBakeProceduralThumbnails(renderer, size = 192) {
  return bakeObjectThumbnails({
    renderer,
    size,
    items: proceduralThumbnailItems(),
  });
}

/** Build the v2 props panel into #props-panel. */

`;

fs.writeFileSync(path.join(root, "v3/ui/propsPanelWidgets.txt"), out);
console.log("Wrote propsPanelWidgets.txt");
