# Far grass

`rocky_terrain_02_c.webp` — Poly Haven **Rocky Terrain 02** (CC0,
https://polyhaven.com/a/rocky_terrain_02), the 1k diffuse jpg re-saved as a
1024² WebP (quality 88). An aerial photo 90 m across: the scale the RTS
camera sees grass at past the blades.

Read by `v3/terrain/groundCache.js` (FAR GRASS): only its luminance is used,
hex-tiled, as detail on the blades' own average colour, baked into the
ground cache where grass is painted. Size in metres: `farGrassSize` (90).
