const GIZMO_MODES = new Set([
  "cliffs",
  "props",
  "actors",
  "water",
  "waterfall",
  "decals",
  "fullRoad",
  "smartRoad",
]);

export function createHud() {
  const el = document.getElementById("hud");
  return {
    update({ perf, toolState, sculptSystem }) {
      if (!el) return;
      const lines = [
        `fps: ${perf.fps.toFixed(1)}  frame: ${perf.frameMs.toFixed(2)} ms`,
        `chunks active: ${perf.activeChunks}  tris≈ ${perf.trisApprox.toLocaleString()}`,
        `stream created/remesh/unload: ${perf.stream.created}/${perf.stream.remeshed}/${perf.stream.unloaded}`,
        `queues create/remesh/unload: ${perf.queues.create}/${perf.queues.remesh}/${perf.queues.unload}`,
        `mode: ${toolState.mode} (${toolState.sculptMode})  surface: ${toolState.terrainSurface}`,
        `brush radius=${toolState.brush.radius.toFixed(1)} strength=${toolState.brush.strength.toFixed(2)} shape=${toolState.brush.falloff.toFixed(2)}`,
        `LMB raise · Shift+LMB lower · Ctrl+LMB smooth · Alt+LMB flatten`,
        `Raise/lower: Smooth = Shape falloff · Plateau = v1 flat inner 60% ring (ignores Shape)`,
        `Noise stamp: Shift+LMB = lower brush (v1); radial falloff is (1-r)^2, not Shape slider`,
        `Ramp: A/B LMB · R clears A · strength/2.5 blend · Ramp shape: edge + grade curve (see pane)`,
        `Erosion stamp: v1 hydraulic droplets · Brush strength scales droplet count (~90 at default)`,
        `wheel: Shift = radius, Alt = strength`,
        `undo=${sculptSystem.undoStack.length} redo=${sculptSystem.redoStack.length}`,
      ];
      if (GIZMO_MODES.has(toolState.mode) && toolState.gizmo) {
        const g = toolState.gizmo;
        const snap =
          g.rotationSnapDeg > 0
            ? `Shift = snap ${g.rotationSnapDeg}°`
            : `snap off`;
        lines.push(
          `gizmo: ${g.space === "local" ? "LOCAL" : "WORLD"} · ${snap} · Q toggles space · outer ring = screen-space rotate`,
        );
      }
      el.textContent = lines.join("\n");
    },
  };
}

