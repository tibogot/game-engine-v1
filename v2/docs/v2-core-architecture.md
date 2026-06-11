# V2 Terrain Core Architecture

## Current Scope

V2 intentionally includes only:

- Fixed-grid chunk streaming
- LOD with hysteresis and frame budgets
- Terrain meshing and geometry pooling
- Tile-only material
- Sculpt tool family (raise/lower, flatten, smooth, noise)
- Terrain-only undo/redo
- Minimal light/sky + perf HUD + organized Tweakpane

## Runtime Flow

1. Camera position drives chunk visibility in `ChunkStreamManager`.
2. Manager computes needed chunks and queue ops (`create`, `remesh`, `unload`).
3. Budgets cap work per frame to keep frame pacing stable.
4. `TerrainMesher` reads chunk data from `TerrainStore` and builds chunk geometry.
5. Sculpt writes height deltas to `TerrainStore`, then marks dirty keys for remesh.

## Perf Gate Checklist (Phase 5)

Use this before adding paint/foliage/props/FX systems:

- Chunk seams remain crack-free while orbiting quickly across LOD rings.
- Sustained sculpt drag across chunk boundaries does not create visual splits.
- Frame pacing remains stable while sculpting (`frame ms` does not spike repeatedly).
- Stream queues recover to near-zero after camera stops moving.
- Undo/redo restores sculpted terrain deterministically.
- No unbounded growth in active chunk count for a fixed camera path.

## Expected Debug Surface

HUD/Tweakpane should always show:

- FPS + frame time
- Active chunk count + approximate triangle count
- Stream ops per frame (create/remesh/unload)
- Queue depth (create/remesh/unload)
- Sculpt mode + shared brush parameters

