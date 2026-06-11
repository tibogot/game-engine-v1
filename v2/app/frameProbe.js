/**
 * frameProbe — TEMPORARY per-frame perf-attribution probe.
 *
 * Goal: when the FPS drops during a fast orbit, tell WHICH of three causes
 * dominates, instead of guessing:
 *   #1 pipeline-compile stalls  — render-side spike on frames where new meshes
 *                                 were built (first draw compiles the pipeline).
 *   #2 rebuild thrash           — CPU build time (foliage/prop/chunk) dominates
 *                                 the spike (meshes disposed on frustum exit,
 *                                 rebuilt on re-entry).
 *   #3 horizon overdraw         — render-bound spike with NO builds and high
 *                                 draw-call / triangle counts.
 *
 * It splits each frame into update blocks vs render submit, counts lazy
 * InstancedMesh (re)builds, and records the worst spike frames.
 *
 * Usage from the browser devtools console:
 *   frameProbe.reset()     // start a clean capture window
 *   ...orbit fast for ~5 s...
 *   frameProbe.report()    // print the table + a verdict
 *
 * To remove: delete the import + the "frameProbe wiring" block in main.js and
 * this file. Nothing else depends on it.
 */

const MAX_SPIKES = 60;
const HIST = 240; // frames kept for the running median (~4 s @ 60 fps)

export const frameProbe = {
  // per-frame block timings (ms) — written by the render loop
  t: { stream: 0, props: 0, foliage: 0, grass: 0, misc: 0, render: 0 },
  // per-frame (re)build counters — incremented by the wrapped build methods
  c: {
    foliage: 0, foliageMs: 0,
    billboard: 0, billboardMs: 0,
    tree: 0, treeMs: 0,
    prop: 0, propMs: 0,
    chunk: 0, chunkMs: 0,
  },
  draws: 0,
  tris: 0,

  _frames: 0,
  _dt: [],
  _spikes: [],
  _capturing: true,

  beginFrame() {
    const t = this.t;
    t.stream = t.props = t.foliage = t.grass = t.misc = t.render = 0;
    const c = this.c;
    c.foliage = c.foliageMs = 0;
    c.billboard = c.billboardMs = 0;
    c.tree = c.treeMs = 0;
    c.prop = c.propMs = 0;
    c.chunk = c.chunkMs = 0;
  },

  endFrame(dtMs, draws, tris) {
    this.draws = draws;
    this.tris = tris;
    if (!this._capturing) return;
    this._frames++;
    this._dt.push(dtMs);
    if (this._dt.length > HIST) this._dt.shift();

    const med = this._median();
    const builds =
      this.c.foliage + this.c.billboard + this.c.tree + this.c.prop + this.c.chunk;
    const buildMs =
      this.c.foliageMs + this.c.billboardMs + this.c.treeMs + this.c.propMs + this.c.chunkMs;

    // Spike = noticeably worse than the running median frame time.
    if (med > 0 && dtMs > Math.max(med * 1.8, med + 6)) {
      this._spikes.push({
        dt: +dtMs.toFixed(1),
        med: +med.toFixed(1),
        stream: +this.t.stream.toFixed(1),
        props: +this.t.props.toFixed(1),
        foliage: +this.t.foliage.toFixed(1),
        grass: +this.t.grass.toFixed(1),
        misc: +this.t.misc.toFixed(1),
        render: +this.t.render.toFixed(1),
        builds,
        buildMs: +buildMs.toFixed(1),
        fol: this.c.foliage,
        bb: this.c.billboard,
        tree: this.c.tree,
        prop: this.c.prop,
        chunk: this.c.chunk,
        draws: this.draws,
        ktris: Math.round(this.tris / 1000),
      });
      if (this._spikes.length > MAX_SPIKES) this._spikes.shift();
    }
  },

  _median() {
    if (this._dt.length < 8) return 0;
    const s = [...this._dt].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  },

  reset() {
    this._frames = 0;
    this._dt.length = 0;
    this._spikes.length = 0;
    this._capturing = true;
    console.log(
      "%c[frameProbe] capture reset — orbit fast for a few seconds, then run frameProbe.report()",
      "color:#4ad",
    );
  },

  report() {
    const med = this._median();
    const fps = med > 0 ? (1000 / med).toFixed(0) : "?";
    console.log(
      `%c[frameProbe] ${this._frames} frames · median ${med.toFixed(1)}ms (${fps} fps) · ${this._spikes.length} spike frames`,
      "font-weight:bold;color:#4ad",
    );
    if (!this._spikes.length) {
      console.log(
        "No spikes captured. Orbit faster/wider, or the frame was already steady. " +
          "Columns once spikes appear: dt vs render vs buildMs tell the story.",
      );
      return;
    }
    console.table(this._spikes);

    // ---- verdict heuristic over the captured spikes ----
    const withBuilds = this._spikes.filter((s) => s.builds > 0);
    const noBuilds = this._spikes.filter((s) => s.builds === 0);
    const avg = (arr, k) =>
      arr.length ? arr.reduce((a, s) => a + s[k], 0) / arr.length : 0;

    const pctBuild = ((withBuilds.length / this._spikes.length) * 100).toFixed(0);
    const avgBuildMs = avg(withBuilds, "buildMs");
    const avgRenderOnBuild = avg(withBuilds, "render");
    const avgRenderNoBuild = avg(noBuilds, "render");
    const avgDrawsNoBuild = avg(noBuilds, "draws");
    const avgKtrisNoBuild = avg(noBuilds, "ktris");

    const lines = [];
    if (withBuilds.length) {
      lines.push(
        `• ${pctBuild}% of spikes coincide with NEW mesh builds (foliage/prop/chunk).`,
      );
      if (avgBuildMs >= avgRenderOnBuild) {
        lines.push(
          `  → CPU build time dominates (avg buildMs ${avgBuildMs.toFixed(1)} ≥ render ${avgRenderOnBuild.toFixed(1)}).`,
        );
        lines.push(
          `  → CAUSE #2: rebuild thrash. Fix = stop disposing foliage/prop meshes on frustum exit (toggle visible instead) / raise the prune threshold.`,
        );
      } else {
        lines.push(
          `  → render-side spike on build frames (render ${avgRenderOnBuild.toFixed(1)} > buildMs ${avgBuildMs.toFixed(1)}).`,
        );
        lines.push(
          `  → CAUSE #1: first-draw pipeline compilation. Fix = precompile foliage/prop pipelines at load (the compileAsync trick you already use for terrain LODs).`,
        );
      }
    }
    if (noBuilds.length) {
      lines.push(
        `• ${noBuilds.length} spike(s) with NO builds, render avg ${avgRenderNoBuild.toFixed(1)}ms, draws avg ${avgDrawsNoBuild.toFixed(0)}, ktris avg ${avgKtrisNoBuild.toFixed(0)}.`,
      );
      lines.push(
        `  → CAUSE #3 (overdraw / horizon load) if these are render-bound and sustained. Fix = pull grass/foliage max distance in + fade with distance fog at altitude.`,
      );
    }
    console.log("%c[frameProbe] verdict:\n" + lines.join("\n"), "color:#8c8");
  },
};

if (typeof window !== "undefined") {
  window.frameProbe = frameProbe;
  console.log(
    "%c[frameProbe] loaded — frameProbe.reset() then orbit then frameProbe.report()",
    "color:#4ad",
  );
}
