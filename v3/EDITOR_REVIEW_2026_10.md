# Editor + engine review, 2026-10-21

This is a read-only review of the v3 editor (features, performance and robustness, code structure),
done by reading the code without opening the editor. "Measure first" means the gain is unproven
until measured with `gpuAB` / boot timing, in a quiet moment.

**Main finding:** the editor is strong at terrain and look, and weak at the DATA games read and at
protecting your work. alg-rts maps are really built by Node recipes (`tools/alg*Level.mjs`); their
gameplay layout is hand-typed JS (`games/alg-rts/layout.js`, `maps/*.js`).

## A. Bugs and risks (small fixes, high value)

1. **Nothing protects unsaved work.** There is no `beforeunload` and no autosave. Save only downloads a
   new `project-<timestamp>.v3proj`. F5, closing the tab, Load, a Vite reload and the terrain-size
   dialog (`main.js:9777`) all lose the session silently.
   → Warn before leaving the page with unsaved edits. Autosave the encoded project to IndexedDB when
   idle (`pendingLoad.js` already has the store), and offer to restore it at boot. Later: save in place.
2. **Ctrl+S can save without the last sculpt stroke.** `saveProject` (`main.js:9222`) uses
   `syncHeightmapToCPU()`, which returns early while a GPU readback is in flight (`main.js:4256`). The
   save also has no try/catch and no guard against two saves at once.
   → Call `ensureCpuHeightmapFromGpu()`, add the guard, and show errors in the status bar.
3. **Undo crosses levels.** After a load, Ctrl+Z brings back the previous level's terrain:
   `replaceHeightData` records the load as a stroke (`sculptBrush.js:1116`). Props undo
   (`propSystem.js:61`, 64 snapshots) writes old instances into the new types.
   → Clear the sculpt and props undo on load, and don't record the load as a stroke.
4. **Sculpt undo VRAM.** Full-map entries are stored RGBA float, 16 B/texel, only R used, up to 25
   entries (`sculptBrush.js:772, 1066`): 32 MB each at 1024², 128 MB at 2048², 512 MB at 4096².
   **Games pay one unused 32 MB entry per level load.**
   → Store R32F/R16F, cap the history by bytes, and fix 3 at the same time.
5. **One failing system freezes all the systems after it.** The frame update is one try
   (`main.js:4851-5223`), and only the first error of the session is logged.
   → One try per system, logging once per system.
6. **Loading a level whose snow / grass / susuki size differs keeps the OLD level's data**
   (`main.js:9431`). → Resample or clear it, and warn.
7. **Prop types leak GPU memory on every load:** `_clearAllPropTypes` / `removePropSlot` dispose only
   the InstancedMeshes (`propInstancer.js:271`), not the geometries, materials or GLB textures.

## B. Performance (measure first)

8. **The interior-fog loop runs on every pixel of every fogged material, even with zero tunnels**
   (`interiorLightingTsl.js:87-117`, built into `scene.fogNode` unconditionally,
   `worldEnvironment.js:988`): 192 capsules + 16 boxes + 16 openings. Its GPU cost was never measured.
   It may cost games real ms. → Compile it out until the first interior volume exists.
9. **River / stamp / pad drags do full-map work each frame:** `absorb(undefined)` scans every texel
   (`heightLayers.js:348`), and `uploadHeightRect` uploads the whole DataTexture (`sculptBrush.js:1157`).
   → A rect `writeTexture` plus a dirty rect, like the paint fix.
10. **Each per-map texture load re-uploads all 7 terrain layers** (`textureLibrary.js:429-551`, up to
    28× during a boot). → Use the existing `_uploadLayer`. It may shorten game boot.
11. **The measured RTS perf defaults** (instanceAttributes, shareInstanceBuilds, plantCpuCull,
    batchPlantDraws, foliageDepthPrepass) are opt-in through `rtsPerfBoot`. The editor, Thunderline
    and the other games run without them. → Make them engine defaults after measuring.
12. **File size:** the heightmap blob barely compresses. Splitting the float bytes before gzip should
    about halve it. Low priority.

## C. Missing features, ranked for YOUR games

13. **Markers and zones in levels** (named points, regions, typed splines) plus `getRiverNetwork()`
    for River v3. Today a level holds one `spawn`. alg-rts would place sites, starts and the play box
    in the editor instead of hand-typed JS. The Apocalypse boats need the river network. This is
    already planned as AUDIT #93/#94 and EDITOR_PLAN #5, and should come first.
14. **"Play this level in the game" button** (alg.html?world=…). Cheap and high value.
15. **Pre-ship level check:** missing assets (now only a console.warn, `main.js:~9345`),
    out-of-bounds objects, a perf budget. Needed before Steam.
16. **Recipe + hand edits:** re-running an alg recipe overwrites hand edits. Recipes should write BASE,
    with hand edits on layers (sculpt has this; paint, props and vegetation don't).
17. **Undo is per mode**, not global. You must be in the tool's mode to undo it; lane road, player start,
    World/look and layer operations have no undo.
18. Later: prefabs / groups (hamlets, villages), an asset browser, level templates, sky-only levels for
    Thunderline (world size min 512), and regions / streaming (parked until an open-world game starts).

## D. Structure (speeds up every future game)

19. **`main.js` is 13,908 lines** (one closure from line 250), and **games load the editor UI:**
    - 32 `ui/` imports (~10k lines);
    - the whole `editor.html` parsed into a hidden DOM;
    - 548 DOM lookups.

    → Step by step: move save/load (`main.js` 9038-9909) into `v3/io/projectApply.js` with a headless
    round-trip test, then lazy-load the editor UI one panel at a time.
20. **Tests:**
    - none for `levelLoader`, `pendingLoad`, the App handle contract or `playMode`;
    - none for sky, water, oceanpro or post FX;
    - 1 in 46 foliage modules.

    → Add an App-handle contract test and a level-load test.
21. **Duplicates to settle:**
    - 3 skies, 3 oceans, River v2 + v3 (nam-valley still holds one v2 river), 5 car-physics
      implementations;
    - rts-v3's own forks of navGrid / fogOfWar / selection;
    - 26 `render/objects/rts*.js` files (18.7k lines) that are game code inside the engine.

    → Moves, never deletions (MIGRATION.md).
22. **Stale docs:**
    - AUDIT.md's header and "Suggested order" (still says "delete v2");
    - AUDIT #81 (lane roads are NOT saved);
    - the "Still in v2" comment in `engine.js`.

    Dead save keys `groundTsl` / `meadowTsl` / `foliage` are read but never written.
    Lane road has no save at all. Spline mode is the old racing game's kit.

## Done

**A1–A5 fixed 2026-10-21**, checked in a browser on alg-aures:
- **A1:** an autosave of 12.1 MB took 0.64 s after 4 s idle. Leaving the page asks first. The
  restore bar brought the work back.
- **A2:** a save right after a stroke now equals the live ground, with 0 texels different.
- **A3 + A4:** nothing to undo after a load. Undo / redo with the one-channel snapshots are exact.
- **A5:** the frame update runs in 5 named sections.
- **Games still run:** alg-rts and Thunderline drive at 60 fps, with a clean console.

**C15 done 2026-10-21:** `npm run levels` (tools/levelCheck.mjs) checks each level for missing
files, missing embedded assets, NaN heights, instances on missing slots and unrestorable prop
slots (errors), plus out-of-world objects, clipped peaks and retired keys (warnings).
`levelCheckTest` plants each fault in a copy of a level and requires every level in
public/levels to have 0 errors.
- First run: 13 levels, 0 errors.
- One warning: nam-valley has 16 props outside its 1024 m world.

**B8 + B10 MEASURED 2026-10-21, no fix needed** (alg-aures, my own Chrome window visible):

- **B8 interior fog: free when off.** It is OFF in all 13 levels and by default, and its loops sit
  behind a runtime `If(uEnabled)`, so they never run. The question left was whether merely compiling
  the code in costs anything. A/B in the alg-rts match at 2× resolution: with the code compiled in
  4.45 ms, without it 4.50 ms (+0.05, noise 0.22).
  - The switch was verified real: the terrain fragment shader goes 95,243 → 91,789 chars.
  - The temporary switch was removed again.
- **B10 terrain texture re-uploads: small.** `_uploadAll` only flags the texture, so loads that land
  in the same frame share one upload.
  - alg-rts boot: 2 uploads in all, 11.6 ms.
  - Editor opening alg-abdi: 11 uploads over 2.6 s, 41 ms in all, never more than 7 ms in one frame.
  - Not worth changing.

## Suggested order

- **Now (small, safe; they help alg-rts too):** A1, A2, A3 + A4, A5.
- **Measure in a quiet moment:** B8 (interior fog), B10 (boot uploads).
- **Next, for alg-rts maps and the Apocalypse delta:** C13 markers + river network, C14 play button,
  C15 level check.
- **Ongoing, one small step at a time:** D19 save/load extraction + tests, then the lazy editor UI.
