/**
 * Hi-Z — a max-depth pyramid of the last frame, for occlusion culling on the GPU.
 *
 * WHAT IT ANSWERS. "Was every pixel this sphere would cover already covered by
 * something NEARER last frame?" If so, the sphere is hidden behind a hill or a
 * building and the cull compute skips it. Each pyramid texel holds the FARTHEST
 * depth of the pixels under it (standard depth: 0 near, 1 far), so one texel
 * says "everything here is at least this close". A sphere whose NEAREST point
 * is behind that is behind all of it.
 *
 * WHY A STORAGE BUFFER AND NOT A MIPPED TEXTURE. Depth formats cannot be
 * mipmapped or written from a compute pass, so the pyramid is a copy anyway,
 * and a copy into one mipped float texture means reading mip i-1 while writing
 * mip i. three binds a sampled texture with ALL its mips, so the two views
 * overlap and WebGPU rejects the dispatch. A flat buffer with one region per
 * level has no views at all.
 *
 * LEVEL LAYOUT. Level 0 is a QUARTER of the depth buffer (ceil): one texel per
 * 4×4 pixels. The test picks the level where a sphere spans at most one texel,
 * so levels finer than that only served spheres under ~4 px, which cost
 * nothing to draw anyway. Each level halves the last, down to 1×1. A texel of
 * level L covers exactly the depth pixels [t·2^(L+2), (t+1)·2^(L+2)) — ceil
 * sizes and clamped gathers keep that exact at odd edges (a clamped read only
 * ever repeats a pixel the texel already covers) — so a pixel coordinate maps
 * to any level by a shift.
 *
 * TWO DISPATCHES, NOT ONE PER LEVEL:
 *   A  one 16×16 workgroup per 64×64-pixel tile reads its pixels once, writes
 *      level 0, and reduces levels 1–4 in workgroup memory;
 *   B  one workgroup finishes levels 5+ (tiny: 30×14 texels and down at 1080p).
 *
 * WHAT IT COSTS, AND WHY (lab, 2026-09-30, 1919×888, 4× MSAA, GPU held at
 * ~780 MHz). ~0.5 ms, the same as the first version's 11 dispatches — so the
 * dispatch count was never the cost. A pass reading ONE depth texel costs the
 * same as a pass reading none (+0.013 ms), so it is not a decompress either.
 * It is the reads: every pixel of a multisampled depth surface, and even
 * sample 0 alone drags the other samples' memory with it. Cheaper needs FEWER
 * depth pixels read (a low-res occluder pre-pass, or a non-MSAA depth), not a
 * smarter reduction.
 *
 * LAST FRAME'S DEPTH, LAST FRAME'S CAMERA. The pyramid is built right after the
 * scene renders, and the test projects spheres with the view it was built
 * with (`prevView`), not the current one. Anything that projects outside last
 * frame's screen, or crosses its near plane, is kept: there is no depth there
 * to judge it by. A frame without a build must `invalidate()`.
 *
 * MSAA. With antialias on, the scene pass depth is multisampled; three binds it
 * as texture_depth_multisampled_2d and textureLoad reads sample 0. That can be
 * off by a sub-pixel sliver at an edge, which the ≥4-px footprint of level 0
 * makes irrelevant.
 */
import * as THREE from "three";
import {
  Fn, If, ceil, clamp, exp2, float, floor, instancedArray, int, ivec2, localId, log2,
  max, min, sqrt, storageBarrier, textureLoad, uint, uniform, uniformArray, vec4,
  workgroupArray, workgroupBarrier, workgroupId,
} from "three/tsl";

/** Level 0 texel = 2^BASE depth pixels a side. */
const BASE = 2;
/** Level-0 texels per workgroup side in pass A (16×16 = 256 threads). */
const TILE = 16;
/** Levels 0..WG_LEVELS-1 are made inside pass A's workgroup (16 → 1). */
const WG_LEVELS = 5;
/** Pass B's single workgroup. */
const B_THREADS = 256;

export class HiZPyramid {
  /**
   * @param {object} o
   *   renderer      WebGPURenderer
   *   depthTexture  THREE.DepthTexture the scene pass renders into
   */
  constructor({ renderer, depthTexture }) {
    this.renderer = renderer;
    this.depthTexture = depthTexture;
    this.width = 0;
    this.height = 0;
    this.levels = 0;
    this.valid = false;   // no pyramid until the first build: the test keeps everything

    this.u = {
      uEnabled: uniform(1),
      uValid: uniform(0),
      uPrevView: uniform(new THREE.Matrix4()),
      uP00: uniform(1),
      uP11: uniform(1),
      uP22: uniform(0),     // projectionMatrix.elements[10]
      uP32: uniform(0),     // projectionMatrix.elements[14]
      uNear: uniform(0.1),
      uDepthW: uniform(1),
      uDepthH: uniform(1),
      uLevelCount: uniform(1),
    };
    // (w, h, offset, 0) per level. Fixed length: 16 levels of quarter-res
    // cover 262k pixels a side.
    this._levelInfo = Array.from({ length: 16 }, () => new THREE.Vector4(1, 1, 0, 0));
    this.u.uLevels = uniformArray(this._levelInfo, "vec4");

    // The buffer node is swapped on resize; the test reads it through this
    // indirection, so fields compiled against the pyramid are rebuilt too.
    this.buf = null;
    this.builds = [];
    this.extraBuilds = [];   // measurement copies (makeBuildCopies); empty in real use
    this.version = 0;
  }

  /**
   * Size the pyramid for a depth buffer of w×h (drawing-buffer pixels). Call
   * before building anything that tests against it; `build` also calls it.
   * Returns true when it reallocated — tests compiled earlier hold the old
   * buffer and must be rebuilt (`version` changes too).
   */
  resize(w, h) { return this._allocate(w, h); }

  _allocate(w, h) {
    if (w === this.width && h === this.height && this.buf) return false;
    this.width = w;
    this.height = h;
    const dims = [];
    const s = 1 << BASE;
    let lw = Math.ceil(w / s), lh = Math.ceil(h / s), offset = 0;
    for (;;) {
      dims.push({ w: lw, h: lh, offset });
      offset += lw * lh;
      if (lw === 1 && lh === 1) break;
      lw = Math.ceil(lw / 2);
      lh = Math.ceil(lh / 2);
    }
    if (dims.length > this._levelInfo.length) dims.length = this._levelInfo.length;
    this.levels = dims.length;
    this.total = offset;
    this.dims = dims;
    dims.forEach((d, i) => this._levelInfo[i].set(d.w, d.h, d.offset, 0));
    this.u.uLevelCount.value = this.levels;
    this.u.uDepthW.value = w;
    this.u.uDepthH.value = h;

    this.buf = instancedArray(offset, "float");
    this.builds = this._makeBuilds();
    this.valid = false;
    this.u.uValid.value = 0;
    this.version++;
    return true;
  }

  /**
   * MEASUREMENT ONLY: `n` independent copies of the whole build, to run in one
   * compute() with the real one. The real cost of the build is then
   * (copies' delta) / n. Running the SAME nodes n times does not work: the
   * compute timestamp did not grow (measured 2026-09-30, x10 read lower).
   * The copies write the same values to the same buffer, so they are harmless.
   */
  makeBuildCopies(n) {
    const out = [];
    for (let i = 0; i < n; i++) out.push(...this._makeBuilds());
    return out;
  }

  /**
   * MEASUREMENT ONLY: one thread that reads ONE depth texel (readDepth) or
   * none, writing texel 0 of the pyramid's last level (the same value a build
   * leaves there, give or take a frame). If one texel costs about as much as
   * a whole build, the cost is getting AT the depth surface (an MSAA depth
   * decompress / layout change), not the pyramid's own work.
   */
  makeDepthProbe(readDepth) {
    const buf = this.buf, last = this.dims[this.dims.length - 1];
    const depth = this.depthTexture;
    return Fn(() => {
      const v = readDepth ? textureLoad(depth, ivec2(int(0), int(0))) : float(1);
      buf.element(uint(last.offset)).assign(max(buf.element(uint(last.offset)), v));
    })().compute(1, [1]);
  }

  _makeBuilds() {
    const { dims, width: W, height: H, buf } = this;
    const depth = this.depthTexture;
    const S = 1 << BASE;
    const d0 = dims[0];
    const tilesX = Math.ceil(d0.w / TILE), tilesY = Math.ceil(d0.h / TILE);
    const at = (d, x, y) => buf.element(uint(d.offset).add(y.mul(uint(d.w))).add(x));
    const store = (d, x, y, v) => If(x.lessThan(uint(d.w)).and(y.lessThan(uint(d.h))), () => { at(d, x, y).assign(v); });

    // ── A: pixels → level 0, then levels 1..4 in workgroup memory ──
    const passA = Fn(() => {
      const sA = workgroupArray("float", TILE * TILE);
      const sB = workgroupArray("float", (TILE / 2) * (TILE / 2));
      const lid = localId.x;
      const tx = lid.mod(uint(TILE)), ty = lid.div(uint(TILE));
      const wg = workgroupId.x;
      const gx = wg.mod(uint(tilesX)), gy = wg.div(uint(tilesX));

      // Level 0: the farthest of this texel's S×S pixels, clamped at the
      // edges (a clamped read repeats a pixel this texel already covers).
      const x0 = gx.mul(uint(TILE)).add(tx), y0 = gy.mul(uint(TILE)).add(ty);
      const m = float(0).toVar();
      for (let j = 0; j < S; j++) {
        const py = int(min(y0.mul(uint(S)).add(uint(j)), uint(H - 1)));
        for (let i = 0; i < S; i++) {
          const px = int(min(x0.mul(uint(S)).add(uint(i)), uint(W - 1)));
          m.assign(max(m, textureLoad(depth, ivec2(px, py))));
        }
      }
      store(dims[0], x0, y0, m);
      sA.element(lid).assign(m);
      workgroupBarrier();

      // Levels 1..4, ping-ponging between the two shared arrays: level k has
      // n = TILE >> k texels a side in this tile, read from n*2 of level k-1.
      let src = sA, dst = sB;
      for (let k = 1; k < WG_LEVELS && k < dims.length; k++) {
        const n = TILE >> k, srcN = n * 2;
        const read = src, write = dst;
        If(tx.lessThan(uint(n)).and(ty.lessThan(uint(n))), () => {
          const i00 = ty.mul(uint(2 * srcN)).add(tx.mul(2));
          const v = max(max(read.element(i00), read.element(i00.add(1))),
            max(read.element(i00.add(uint(srcN))), read.element(i00.add(uint(srcN + 1)))));
          write.element(ty.mul(uint(n)).add(tx)).assign(v);
          store(dims[k], gx.mul(uint(n)).add(tx), gy.mul(uint(n)).add(ty), v);
        });
        workgroupBarrier();
        [src, dst] = [dst, src];
      }
    })().compute(tilesX * tilesY * TILE * TILE, [TILE * TILE]);

    const builds = [passA];

    // ── B: levels WG_LEVELS.. from the buffer, one workgroup, level by level ──
    if (dims.length > WG_LEVELS) {
      builds.push(Fn(() => {
        const lid = localId.x;
        for (let k = WG_LEVELS; k < dims.length; k++) {
          const s = dims[k - 1], d = dims[k];
          const n = d.w * d.h;
          for (let base = 0; base < n; base += B_THREADS) {
            const i = lid.add(uint(base));
            If(i.lessThan(uint(n)), () => {
              const x = i.mod(uint(d.w)), y = i.div(uint(d.w));
              const sx0 = x.mul(2), sy0 = y.mul(2);
              const sx1 = min(sx0.add(1), uint(s.w - 1)), sy1 = min(sy0.add(1), uint(s.h - 1));
              at(d, x, y).assign(max(max(at(s, sx0, sy0), at(s, sx1, sy0)), max(at(s, sx0, sy1), at(s, sx1, sy1))));
            });
          }
          // The next level reads what this one wrote.
          storageBarrier();
        }
      })().compute(B_THREADS, [B_THREADS]));
    }
    return builds;
  }

  /**
   * Mark the pyramid unusable — call on any frame it was NOT rebuilt. Its
   * depth and camera are then older than last frame, and projecting the
   * current world against an old viewpoint can hide what is now in view.
   * Until the next build the test keeps everything.
   */
  invalidate() {
    this.valid = false;
    this.u.uValid.value = 0;
  }

  /**
   * Build the pyramid from the depth the scene just rendered, and remember the
   * camera it was rendered with. Call after the scene pass, every frame.
   * @returns {boolean} true when the buffer was reallocated — fields that read
   *   it must rebuild their compute (see GpuInstanceField.setHiZ)
   */
  build(camera) {
    const img = this.depthTexture.image;
    const changed = this._allocate(img.width, img.height);
    const work = this.extraBuilds.length ? this.builds.concat(this.extraBuilds) : this.builds;
    if (work.length) this.renderer.compute(work);
    const u = this.u;
    u.uPrevView.value.copy(camera.matrixWorldInverse);
    const e = camera.projectionMatrix.elements;
    u.uP00.value = e[0];
    u.uP11.value = e[5];
    u.uP22.value = e[10];
    u.uP32.value = e[14];
    u.uNear.value = camera.near;
    this.valid = true;
    u.uValid.value = 1;
    return changed;
  }

  /**
   * TSL: 1 when a world-space sphere may be visible, 0 when the pyramid proves
   * it hidden. Conservative everywhere it cannot judge.
   *
   * The screen rectangle is the EXACT bound of the projected sphere, per axis
   * (the tangent lines from the eye in the x–depth and y–depth planes), not the
   * centre's projection ± r/depth — that one under-covers a sphere near the
   * screen edge, and an under-covered rectangle culls things that show.
   */
  visibleNode(center, radius) {
    const u = this.u;
    const buf = this.buf;
    return Fn(() => {
      const vis = float(1).toVar();
      const vc = u.uPrevView.mul(vec4(center, 1)).xyz;
      const d = vc.z.negate();                      // forward distance
      const r = radius;
      If(u.uEnabled.mul(u.uValid).greaterThan(0.5).and(d.sub(r).greaterThan(u.uNear)), () => {
        // Tangents in the x–d plane: (x, d) turned by ±asin(r/L), scaled by L.
        const tx = sqrt(max(vc.x.mul(vc.x).add(d.mul(d)).sub(r.mul(r)), 0));
        const xa = vc.x.mul(tx).sub(d.mul(r)), da = vc.x.mul(r).add(d.mul(tx));
        const xb = vc.x.mul(tx).add(d.mul(r)), db = vc.x.mul(r).negate().add(d.mul(tx));
        const nxa = u.uP00.mul(xa).div(da), nxb = u.uP00.mul(xb).div(db);
        const ty = sqrt(max(vc.y.mul(vc.y).add(d.mul(d)).sub(r.mul(r)), 0));
        const ya = vc.y.mul(ty).sub(d.mul(r)), ea = vc.y.mul(r).add(d.mul(ty));
        const yb = vc.y.mul(ty).add(d.mul(r)), eb = vc.y.mul(r).negate().add(d.mul(ty));
        const nya = u.uP11.mul(ya).div(ea), nyb = u.uP11.mul(yb).div(eb);
        // NDC → pixels. Depth rows run top-down, NDC y runs up.
        const px0 = min(nxa, nxb).mul(0.5).add(0.5).mul(u.uDepthW);
        const px1 = max(nxa, nxb).mul(0.5).add(0.5).mul(u.uDepthW);
        const py0 = float(0.5).sub(max(nya, nyb).mul(0.5)).mul(u.uDepthH);
        const py1 = float(0.5).sub(min(nya, nyb).mul(0.5)).mul(u.uDepthH);
        const onScreen = px0.greaterThanEqual(0).and(py0.greaterThanEqual(0))
          .and(px1.lessThanEqual(u.uDepthW)).and(py1.lessThanEqual(u.uDepthH));
        If(onScreen, () => {
          // The level where the rectangle spans at most one texel, so at
          // most 2×2 texels cover it. A texel of level L is 2^(L+BASE) px.
          const size = max(max(px1.sub(px0), py1.sub(py0)), 1);
          const lvl = clamp(ceil(log2(size)).sub(BASE), 0, u.uLevelCount.sub(1));
          const info = u.uLevels.element(int(lvl));
          const scale = exp2(lvl.add(BASE).negate());
          const wMax = info.x.sub(1), hMax = info.y.sub(1);
          const x0 = uint(clamp(floor(px0.mul(scale)), 0, wMax));
          const x1 = uint(clamp(floor(px1.mul(scale)), 0, wMax));
          const y0 = uint(clamp(floor(py0.mul(scale)), 0, hMax));
          const y1 = uint(clamp(floor(py1.mul(scale)), 0, hMax));
          const off = uint(info.z), w = uint(info.x);
          const at = (x, y) => buf.element(off.add(y.mul(w)).add(x));
          const farthest = max(max(at(x0, y0), at(x1, y0)), max(at(x0, y1), at(x1, y1)));
          // Depth of the sphere's nearest point, as the depth buffer stores it.
          const dn = d.sub(r);
          const zNear = u.uP32.sub(u.uP22.mul(dn)).div(dn);
          If(zNear.greaterThan(farthest), () => { vis.assign(0); });
        });
      });
      return vis;
    })();
  }
}
