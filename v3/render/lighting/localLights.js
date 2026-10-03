// LOCAL LIGHTS — fires, lanterns, lamps, muzzle flashes: many small point lights at night.
//
// Measured in v3/lights-lab.html (2026-10-04, 2160x1098, MSAA 4): three's default lighting puts
// every light into every lit material's shader key, so a light that APPEARS rebuilds the world's
// shaders (a 1209 ms frame), and every pixel pays for every light (12.3 ms at 128). TiledLighting
// keeps point lights out of the shader key (they live in a texture) and a compute pass bins them
// per 32-px screen tile: 0.89 ms at 32 lights, 1.19 at 128, 1.57 at 256, 3.5 ms for a new light.
//
//   installTiledLighting(renderer)   BEFORE anything compiles (right after renderer.init())
//   const L = createLocalLights({ scene, max })
//   const h = L.add({ position, color, intensity, range, flicker, ttl, importance })
//   h.set({ intensity, ... }); h.remove();   L.update(dt, camera) once a frame, before the render
//
// Every light lives in a pool made at boot (nothing is allocated mid-game). Each frame the live
// lights are ranked — brightness x range^2 / distance^2 to the camera, x importance — and written
// into the pool in that order: TiledLighting keeps at most 8 lights per tile, in list order, so a
// crowded spot drops the faintest, not whichever was added last. Pool lights are NEVER hidden or
// shown (a light first turning visible rebuilt every shader: see the pool below) — a spare one
// sits at intensity 0, parked far below the world.
//
// Water (Ocean Pro, lakes, rivers) builds its own lighting and is not lit by these.

import * as THREE from "three/webgpu";
import TiledLightsNode from "three/addons/tsl/lighting/TiledLightsNode.js";

/*
 * three r184's TiledLighting, made fit for the engine. Measured in the editor on the bay
 * (2026-10-04), the add-on as shipped ran its tile pass 79 TIMES A FRAME and 128 lights cost
 * +3.5 ms where the lab measured +0.5. Four problems, four fixes:
 *
 * 1. EVERY MATERIAL WITH ITS OWN LIGHTING INPUT GOT ITS OWN TILE GRID. NodeMaterial.setupLights
 *    (r184 NodeMaterial.js:1050) asks the lighting for a NEW lights node whenever a material adds
 *    an AO / environment / light-map term — under TiledLighting a whole TiledLightsNode each, with
 *    its own 1024-light texture and its own compute pass every render. FIX: one MASTER node for the
 *    main scene does the binning; every other node is a FOLLOWER that reads the master's buffers
 *    (same shader loop, no compute, no texture of its own).
 * 2. THE TILE PASS RAN ON EVERY RENDER OF THE SCENE (shadow cascades, probes). FIX: the master
 *    bins once per frame, for the main camera only (shadow passes evaluate no lighting).
 * 3. THE DISPATCH WAS 32x TOO BIG: count = w*h / tileSize instead of / tileSize^2. FIX: the real
 *    tile count.
 * 4. A CRASH: customCacheKey() reads the compute program before updateProgram() has built it
 *    ("reading 'getCacheKey' of null" every frame). FIX: built as the node is made.
 *
 * Other scenes (bakes, thumbnails, tint scenes) get three's plain lights: no local lights there.
 */
const _plainLights = new WeakMap();

class MasterTiledLightsNode extends TiledLightsNode {
  /** @param {number} maxLights  the pool's size: the light texture (uploaded every frame) and the tile loop's bound */
  constructor(maxLights) {
    super(maxLights);
    // (2) never per render: createLocalLights' update() drives it once a frame (drive()). Most lit
    // materials use a follower, so the master is often in no shader graph at all.
    this.updateBeforeType = THREE.NodeUpdateType.NONE;
    this._keep = [];
  }
  create(width, height) {
    super.create(width, height);
    // (3) one invocation per tile
    this._compute.count = Math.floor(width / this.tileSize) * Math.floor(height / this.tileSize);
  }
  updateBefore() {}
  /** Bin `lights` (in priority order) into the tiles for `camera`. */
  drive(renderer, camera, lights) {
    this.tiledLights.length = 0;
    for (const l of lights) this.tiledLights.push(l);
    TiledLightsNode.prototype.updateBefore.call(this, { renderer, camera });
  }
  // the renderer hands the scene's lights over every render; the tiles keep the pool's order
  // (no allocation: this runs on every render pass)
  setLights(lights) {
    const keep = this._keep, t = this.tiledLights;
    keep.length = 0;
    for (let i = 0; i < t.length; i++) keep.push(t[i]);
    super.setLights(lights);
    t.length = 0;
    for (let i = 0; i < keep.length; i++) t.push(keep[i]);
    return this;
  }
}

/** A material's own lights node: the master's tiles and light texture, no compute of its own. */
class FollowerTiledLightsNode extends TiledLightsNode {
  constructor(master) {
    super();
    this._master = master;
    this.updateBeforeType = THREE.NodeUpdateType.NONE;
  }
  updateProgram() {}
  updateBefore() {}
  customCacheKey() {
    return this._master._compute.getCacheKey() + THREE.LightsNode.prototype.customCacheKey.call(this);
  }
}
// the master's buffers, read at shader-build time (after a resize the master's cache key changes,
// so every follower rebuilds against the new ones); the base constructor's assignments are dropped
for (const k of ["_bufferSize", "_lightIndexes", "_screenTileIndex", "_compute", "_lightsTexture", "_lightsCount", "_cameraViewMatrix", "_cameraProjectionMatrix", "_screenSize"]) {
  Object.defineProperty(FollowerTiledLightsNode.prototype, k, {
    get() { return this._master?.[k] ?? null; },
    set() {},
    configurable: true,
  });
}

class LocalTiledLighting extends THREE.Lighting {
  constructor(renderer) {
    super();
    this._renderer = renderer;
    this._mainScene = null;
    this._master = null;
  }
  /** The scene whose local lights are drawn, and the pool's size. */
  setMain(scene, maxLights) {
    this._mainScene = scene;
    this._master = new MasterTiledLightsNode(maxLights);
    this._master.updateProgram(this._renderer); // (4)
  }
  createNode(lights = []) {
    if (!this._master) return new THREE.LightsNode().setLights(lights);
    return new FollowerTiledLightsNode(this._master).setLights(lights);
  }
  getNode(scene) {
    if (scene.isQuadMesh || scene !== this._mainScene || !this._master) {
      let n = _plainLights.get(scene);
      if (!n) { n = new THREE.LightsNode(); _plainLights.set(scene, n); }
      return n;
    }
    return this._master;
  }
}

/**
 * Swap the renderer's lighting for tiled point lights. Call before the first render; then
 * createLocalLights({ scene, camera }) names the main scene and camera.
 */
export function installTiledLighting(renderer) {
  renderer.lighting = new LocalTiledLighting(renderer);
  return renderer.lighting;
}

/**
 * @param {object} o
 * @param {THREE.Scene} o.scene
 * @param {THREE.Camera} [o.camera]  the main camera (the tiles are binned for it)
 * @param {THREE.WebGPURenderer} [o.renderer]  with installTiledLighting done
 * @param {number} [o.max=128]  pool size (lights drawn at once). Every pool light is handed to
 *   the renderer on every render pass, so the pool is kept to what a busy night needs (alg-rts:
 *   ~50 at most); a game with more passes its own.
 */
export function createLocalLights({ scene, camera, renderer, max = 128 }) {
  const tiled = renderer?.lighting instanceof LocalTiledLighting ? renderer.lighting : null;
  tiled?.setMain(scene, max);
  void camera;
  const group = new THREE.Group();
  group.name = "LocalLights";
  // Matrices by hand, for the active lights only: three would recompose all `max` every frame,
  // and the tile pass reads them BEFORE the render's own matrix update.
  group.matrixAutoUpdate = false;
  scene.add(group);
  const pool = [];
  /*
   * THE POOL NEVER CHANGES WHAT THE RENDERER SEES. A pool light turning visible for the first
   * time rebuilt every shader in the world (MEASURED in alg-rts, 2026-10-04: 53 render
   * pipelines, a 0.9-1.2 s frame on every blast that used a slot no flash had used before) —
   * even with point lights out of the lights node's key. So every pool light is visible from
   * boot and stays visible; a spare one has intensity 0 and is parked far below the world, where
   * it falls in no tile. The tiles get only the active lights (drive()).
   */
  const PARK = -1e6;
  for (let i = 0; i < max; i++) {
    const l = new THREE.PointLight(0xffffff, 0, 0.01, 2);
    l.castShadow = false;
    l.matrixAutoUpdate = false;
    l.position.set(0, PARK, 0);
    group.add(l);
    l.updateMatrix(); l.updateMatrixWorld();
    pool.push(l);
  }
  let lastDrawn = -1;

  /** @type {Set<object>} */
  const live = new Set();
  let time = 0;
  const ranked = [];
  const _c = new THREE.Vector3();

  function add({ position, color = 0xffa040, intensity = 6, range = 12, flicker = 0, ttl = Infinity, importance = 1 } = {}) {
    const rec = {
      position: new THREE.Vector3().copy(position ?? _c.set(0, 0, 0)),
      color: new THREE.Color(color),
      intensity, range, flicker, ttl, importance,
      phase: Math.random() * 100, score: 0,
    };
    live.add(rec);
    return {
      rec,
      // (called every frame by flickering, fading and moving lights: no allocation)
      set(p) {
        if (p.position) rec.position.copy(p.position);
        if (p.color !== undefined) rec.color.set(p.color);
        if (p.intensity !== undefined) rec.intensity = p.intensity;
        if (p.range !== undefined) rec.range = p.range;
        if (p.flicker !== undefined) rec.flicker = p.flicker;
        if (p.ttl !== undefined) rec.ttl = p.ttl;
        if (p.importance !== undefined) rec.importance = p.importance;
        return this;
      },
      remove() { live.delete(rec); },
      get alive() { return live.has(rec); },
    };
  }

  /** Rank the live lights and write the best `max` into the pool. */
  function update(dt, camera) {
    time += dt;
    ranked.length = 0;
    camera.getWorldPosition(_c);
    for (const r of live) {
      if (r.ttl !== Infinity) { r.ttl -= dt; if (r.ttl <= 0) { live.delete(r); continue; } }
      if (!(r.intensity > 0)) continue;
      const d2 = Math.max(1, r.position.distanceToSquared(_c));
      r.score = r.intensity * r.range * r.range * r.importance / d2;
      ranked.push(r);
    }
    ranked.sort((a, b) => b.score - a.score);
    const n = Math.min(ranked.length, max);
    // the slots used last frame and not now are parked (only those: the rest are parked already)
    for (let i = n; i < Math.max(lastDrawn, 0); i++) {
      const l = pool[i];
      l.intensity = 0; l.distance = 0.01; l.position.set(0, PARK, 0);
      l.updateMatrix(); l.updateMatrixWorld();
    }
    for (let i = 0; i < n; i++) {
      const l = pool[i], r = ranked[i];
      let k = 1;
      if (r.flicker > 0) k = 1 - r.flicker * (0.5 - 0.5 * Math.sin(time * 13 + r.phase) * Math.sin(time * 7.3 + r.phase * 1.7));
      l.position.copy(r.position);
      l.color.copy(r.color);
      l.intensity = r.intensity * k;
      l.distance = r.range;
      l.updateMatrix(); l.updateMatrixWorld();
    }
    // bin them into the screen tiles for this view, once a frame — and not at all while none is lit
    // (by day): one empty pass clears the tiles, then the pass and its upload stop
    if (tiled && (n > 0 || lastDrawn !== 0)) {
      camera.updateMatrixWorld();
      active.length = 0;
      for (let i = 0; i < n; i++) active.push(pool[i]);
      tiled._master.drive(renderer, camera, active);
    }
    lastDrawn = n;
  }
  const active = [];

  function clear() { live.clear(); }

  function dispose() {
    scene.remove(group);
    for (const l of pool) l.dispose?.();
  }

  return { add, update, clear, dispose, group, max, get count() { return live.size; }, get drawn() { return Math.min(ranked.length, max); } };
}
