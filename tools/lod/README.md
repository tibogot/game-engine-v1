# LOD — far levels made from the near, and proved

2026-10-31. The far levels of Blender kits used to be built or baked separately. They always differed somewhere:
window bars changed colour, a roof changed at the switch, a door lost its planks. This folder replaces that with the
approach the industry uses (Simplygon, InstaLOD, meshoptimizer's own guidance), plus a check that proves the result.

## How it works

1. **Blender builds and bakes the NEAR level only.** A kit opts in with `autoLod=True` in its type spec. tools/blender/
   house.py `buildKit` then exports no `_Far` meshes.
2. **`autoLod.mjs` makes each far FROM its near** after the merge, inside `tools/blenderKit.mjs`:
   - meshoptimizer `simplifyWithAttributes` keeps the near's UV seams and normals, so the far has the same UVs and
     the same texture. Colour cannot differ.
   - The error budget is absolute, in metres: **one screen pixel at the switch distance**. That is
     `2·d·tan(fov/2)/px / scale`, which is 14.8 mm at 60 m with fov 26°, 1440 px, and the kit drawn ×1.3. Shape can
     move by at most a pixel where the game switches.
   - Shading keeps the near's normals on every vertex that stays: vertices are removed, never moved.
   - Folds: if a collapse puts two triangles on one plane (z-fighting the near didn't have), that primitive is redone
     at half, a quarter, then a tenth of the budget.
3. **`lodCheck.mjs` proves it.** Every near/far pair is rendered in software, textured and lit with its own normals, from
   the RTS camera at the switch distance, from 8 directions. A pixel counts as different only if nothing within 1 px of
   it in the other image is close in colour. The build fails past 1 % of the piece's pixels, and diff images go to
   `.cache/blender/<kit>/lodcheck/`.

The kits that build their own far levels (every kit made before this) are left as they were. autoLod skips any node
that already has a `_Far`, and only the auto-made pairs are gated.

## Measured on the port kit (2026-10-31)

| Far levels | Pixels differing at the switch (worst of 8 views) |
|---|---|
| Built in Blender (the old way) | 1.7 – 10.7 % on every pair — the roofs and the doors' edges |
| Made by autoLod | 0.02 – 0.6 % — every pair passes |

Run either tool alone:

    node tools/lod/autoLod.mjs <in.glb> [out.glb] [--replace] [--switch 60] [--scale 1.3] [--px 1440] [--fov 26]
    node tools/lod/lodCheck.mjs <file.glb> [--out <dir>] [--bar 1] [--only <name>]

## Limits (what it cannot do)

- **Separate small parts can't be merged.** A roof of 8 000 separate tiles keeps most of its triangles, because each
  tile is a closed piece. For triangle savings, model repeated detail as continuous surfaces (a course of tiles as one
  corrugated strip), not thousands of solids.
- **One far level.** A third level for 120 m+ (a 2-pixel budget there) is the natural next step.
