import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const mainPath = path.join(root, "v3/app/main.js");
let s = fs.readFileSync(mainPath, "utf8");

const startMarker = "  const splineObjGrid     = document.getElementById(\"spline-obj-grid\");";
const endMarker = "  // Sync prop instance while gizmo is dragging.";
const start = s.indexOf(startMarker);
const end = s.indexOf(endMarker);
if (start < 0 || end < 0 || end <= start) {
  console.error("Markers not found", { start, end });
  process.exit(1);
}

const insert = `  buildSplinePanel({
    toolState: splineToolState,
    splineSystem: splineSys,
    getProceduralObjectOptions: () => PROCEDURAL_OBJECT_OPTIONS,
    rebuildInteriorVolumes: () => {},
    splineChanged: () => splineSys._rebuildVisual(),
    splineDeleteSelected: () => splineSys.deleteSelected(),
    splineClearAll: () => splineSys.clearAll(),
    splineSelectedYChanged: () => splineSys.setSelectedPointY(splineState.selectedPointY),
    splineClosedChanged: () => splineSys.setClosed(splineState.closed),
    splinePreview: () => splineSys.preview(),
    splineBake: () => {
      const { placed } = splineSys.bakePlacement();
      if (placed > 0) refreshPropCount();
    },
    splineClearPreview: () => splineSys.clearPreview(),
    splineApplyPlateau: () => {
      const changed = splineSys.applyPlateau();
      if (!changed) {
        console.warn("[V3] Plateau requires v2 terrainStore — not yet wired in v3.");
        return;
      }
      requestHeightmapReadback();
      splineSys.syncGuardrailsToGround();
      splineSys.syncKerbsToGround();
      splineSys.syncLinearFeaturesToGround();
    },
    splineClearTunnels: () => splineSys.clearTunnels(),
    splineClearLinearFeatures: () => splineSys.clearLinearFeatures(),
    splineKerbSelect: () => splineSys.selectActiveKerb(),
    splineKerbApply: () => splineSys.syncActiveKerbFromToolState(),
    splineKerbDelete: () => splineSys.deleteActiveKerb(),
    splineKerbDuplicate: () => splineSys.duplicateActiveKerb(),
    splineKerbSuggestFromCurvature: () => splineSys.suggestKerbFromRoadCurvature(),
    splineKerbLiveChanged: (changedKey) => {
      if (changedKey === "activeKerbIndex") {
        splineSys.selectActiveKerb();
        return;
      }
      if (!splineState.kerbAutoApplyActive) return;
      splineSys.syncActiveKerbFromToolState();
    },
  });

  applySplineModeEffects();

`;

s = s.slice(0, start) + insert + s.slice(end);
fs.writeFileSync(mainPath, s);
console.log("Spliced spline panel wiring into main.js");
