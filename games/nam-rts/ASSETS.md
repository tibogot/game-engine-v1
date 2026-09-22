# nam-rts — what it loads from `public/`

The list of files an RTS-only build has to ship (for Vercel and Steam).
Everything else in `public/` (715 MB) belongs to other games or the editor.

How this was made (2026-09-22): followed the import chain from `nam.html`
(405 JS files, including the parts of the v3 engine it pulls in) and read the
manifest of `levels/nam-valley.v3proj`. It was **not** a network capture.
Before shipping, confirm it once in DevTools → Network (reload with the cache
disabled, play a match, sort by size).

JS, the shaders and `cloudNoiseWorker.js` are bundled by Vite and are not listed here.

## Must ship (~100 MB)

| File | Size | Loaded by | Notes |
|---|---|---|---|
| `levels/nam-valley.v3proj` | 62.8 MB | namGame.js | The map. Inside: splat 32 MB, foliagePaint 8 MB, heightmap 4 MB, 16 embedded ground textures ~11.5 MB, 8 embedded decal PNGs ~1.4 MB |
| `textures/pbr_materials/cliff_rocks_07_2k/` basecolor, normal_gl, roughness, ambientocclusion | 24.7 MB | map layer "Cliff Rock" | normal_gl is a **12 MB PNG**; AO 6 MB |
| `textures/pbr_materials/Ground037/` Color, NormalGL, Roughness, AmbientOcclusion | 5.7 MB | map layer "Beach sand" | |
| `textures/pbr_materials/Snow010A/` Color, NormalGL, Roughness, AmbientOcclusion | 3.3 MB | map layer "Snow" | Snow layer in a Vietnam map: check whether it is painted anywhere |
| `models/testsolanim.glb` | 704 KB | unitTypes.js (soldier) | Skinned soldier. Check its licence (Mixamo) |
| `textures/revo_noise_atlas.png` | 640 KB | revoGrassSystem.js | map uses grass system "revo" |
| `textures/crater-decal.png` | 628 KB | craterSystem.js + map decal slot "Crater" | |
| `textures/namlogowebp.webp` | 288 KB | nam.html | title logo |
| `models/rts/container_001_compressed.glb` | 145 KB | campLayout.js | |
| `models/rts/hedgehog_001_compressed.glb` | 133 KB | campLayout.js | tank traps |
| `textures/nam-cover.webp` | 124 KB | nam.html | title art |
| `textures/waterNormal.webp` | 112 KB | v3/app/main.js | map has lakes + rivers |
| `textures/crackroad.jpg` | 92 KB | map decal slot "Cracks" | |
| `textures/butterfly.png` | 56 KB | ambientAtlas.js | map ambient "Butterflies" |
| `textures/leaf1-tiny.png` | 20 KB | ambientAtlas.js | map ambient "Falling leaves" |
| `textures/grid.png` | 8 KB | terrainLOD.js | loaded eagerly by the terrain |

## Only with a URL flag

| File | Size | When |
|---|---|---|
| `models/rts/carmilitary_compressed.glb` | 14 KB | the Harvester, only with `?econ=harvest` (requisition replaced harvesting) |
| any `.v3proj` | — | `?world=/path/file.v3proj` (dev) |

## Downloaded today but thrown away (~47 MB): fix this before shipping

nam-rts does not pass `preloadPaintTextures: false` to the engine (the road game
and empty-game do). So at boot the engine downloads all 7 default ground sets,
and then the map replaces 4 of them with its own embedded textures:

| Set | Size (4 maps) |
|---|---|
| `pbr_materials/Rock028` | 19.3 MB |
| `pbr_materials/Rock058` | 16.5 MB |
| `pbr_materials/Grass005` | 5.6 MB |
| `pbr_materials/Cobblestone_Irregular_Floor_001_SD` | 5.6 MB |

The other three defaults (Ground037, cliff_rocks_07, Snow010A) are the ones the
map uses, so those stay on the must-ship list.

## Not needed (engine code the RTS imports but never uses)

Seen in the import chain, but play mode, the editor or other maps load them, not this game:
UA1+UA2, Husky, fox, katana, conical hat (play-mode cast, lazy), bruno.glb,
heli5.glb, the plane (flight mode), `brush-stamps/` (sculpt tool),
v2 prop textures (Concrete030, ground_tiles_01, asphalt_track), leaf
billboards and `leaf_atlas.png`, lens flare PNGs, `.hdr` skies (map uses
`skyMode: atmosphere`, `hdr: null`), trunk GLBs (all 8 tree slots have
`presetFile: null` and there are 0 tree instances). Vegetation, rocks,
bridges and vehicles are all built in code.

## Easy ways to shrink the download

1. Turn off the default preload: −47 MB.
2. Re-save the cliff_rocks_07 normal/AO PNGs as JPG/WebP, or embed 1k versions: most of 24.7 MB.
3. The map file: check that Vercel gzips `.v3proj` (unknown extension →
   maybe not). The 32 MB splat is the biggest blob in it.
4. Delete the Snow layer if nothing is painted with it.
