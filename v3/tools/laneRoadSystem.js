/**
 * v3/tools/laneRoadSystem.js — Lane Road mode (preview of the lane-based road
 * engine in 3D).
 *
 * Loads a test network (v3/roads/mesh/previewScenes.js), builds it with
 * buildRoadNetwork, turns that into meshes with buildLaneRoadMesh, and shows
 * them in the editor under its real lights. Nothing else in the editor is
 * touched: Smart Road 2 (road mode) is a separate system, and this group is
 * not saved in the project.
 *
 * Draw calls: one mesh per material — asphalt, concrete, grass — so 3, plus
 * the concrete mesh in the shadow pass when curb shadows are on.
 *
 * ASPHALT is the shared city-street surface (v3/render/roads/asphaltSurface.js):
 * cellular stones, streaked macro tone, resurfacing patches, relief normal, wet
 * film — with the lane road's markings handed in through its `paint` hook
 * (v3/render/roads/laneRoadPaint.js), so the paint shares its wear and water.
 *
 * WET is a build-time choice (a clearcoat is compiled in or not), so toggling
 * it swaps the asphalt material; the amounts are uniforms.
 *
 * TERRAIN FIT (fitTerrain on): the network is built on the ground — node
 * planes, grade-limited profiles, crown and banking (v3/roads/roadSurface.js)
 * — and the terrain is graded to it through its OWN RoadConformSystem (the
 * Smart Road conform: a base snapshot taken on entering the mode, each live
 * re-grade restores the last one first, Bake keeps it). The network drapes on
 * that base, so grading never feeds back into the road. Off: the old flat
 * plate at `lift` over the scene centre, terrain untouched.
 *
 * COLLISION: collisionMeshes() → { deck, solids }, the same shape the
 * modular-road game's city hands its collision bake. deck = asphalt, concrete,
 * grass (wheels climb kerbs); solids = collision-only walls round islands and
 * raised medians (never drawn).
 */
import * as THREE from "three";
import { MeshStandardNodeMaterial } from "three/webgpu";
import {
  abs, attribute, float, fract, fwidth, max, mix, mx_fractal_noise_float, mx_noise_float, oneMinus, positionWorld, saturate, smoothstep, step, uniform, uv,
} from "three/tsl";
import { buildRoadNetwork } from "../roads/roadNetwork.js";
import { buildLaneRoadMesh, MESH_DEFAULTS } from "../roads/mesh/laneRoadMesh.js";
import { PREVIEW_SCENES, flattenNetwork } from "../roads/mesh/previewScenes.js";
import { createLaneRoadPaint, PAINT_DEFAULTS } from "../render/roads/laneRoadPaint.js";
import { createAsphaltMaterial, laneRoadFrame, syncAsphaltUniforms, ASPHALT_DEFAULTS } from "../render/roads/asphaltSurface.js";
import { groundTargetAt, SURFACE_DEFAULTS } from "../roads/roadSurface.js";

export function createLaneRoadToolState() {
  return {
    laneRoad: {
      scene: "all",
      visible: true,
      /** Build on the terrain and grade it to the roads (off: flat plate at `lift`). */
      fitTerrain: true,
      /** Terrain blend width past the road's property line (m). 6 m read as a cliff over a 6-8 m cut. */
      shoulder: 14,
      /** How far the terrain sits under the road surface inside the footprint (m). */
      embed: 0.3,
      crown: SURFACE_DEFAULTS.crown,
      banking: SURFACE_DEFAULTS.banking,
      /** Flat plate only: road surface above the ground under the scene centre. */
      lift: 0.1,
      /** Drivable road width vs real (1 = real, 3.25 m lanes). 1.3 ≈ a game-widened
       *  4.2 m lane for the 2.1 m car. Sidewalks, paint and curves stay real. */
      roadScale: 1.3,
      curbShadows: true,
      ...MESH_DEFAULTS,
      ...PAINT_DEFAULTS,
      // City street pavement and kerb (modularRoadCityStreets.js walkColor / kerbColor).
      slabColor: "#74767a",
      curbColor: "#8d8f92",
      slabSize: 1.6,
      // Asphalt look — the shared city-street surface; see ASPHALT_DEFAULTS.
      asphaltDark: hex(ASPHALT_DEFAULTS.asphaltDark),
      asphaltLight: hex(ASPHALT_DEFAULTS.asphaltLight),
      deckBrightness: ASPHALT_DEFAULTS.deckBrightness,
      patchAmount: ASPHALT_DEFAULTS.patchAmount,
      patchChance: ASPHALT_DEFAULTS.patchChance,
      chipRelief: ASPHALT_DEFAULTS.chipRelief,
      gritRelief: ASPHALT_DEFAULTS.gritRelief,
      apronColor: "#7a736a",
      grassColor: "#4f6b2f",
      wet: false,
      wetAmount: 0.8,
      puddleAmount: 1,
    },
  };
}

const hex = (n) => `#${n.toString(16).padStart(6, "0")}`;
/** Asphalt panel keys: colours as #hex in the panel, numbers in the material. */
const ASPHALT_KEYS = ["asphaltDark", "asphaltLight", "deckBrightness", "patchAmount", "patchChance", "chipRelief", "gritRelief", "wetAmount", "puddleAmount"];

const PAINT_UNIFORM_KEYS = Object.keys(PAINT_DEFAULTS).filter((k) => !k.startsWith("paint"));

export class LaneRoadSystem {
  /**
   * @param {object} o
   * @param {THREE.Scene} o.scene
   * @param {{ laneRoad: object }} o.toolState
   * @param {(x:number, z:number) => number} o.groundAt   terrain height (metres)
   * @param {() => THREE.Vector3} o.viewTarget            where "place here" drops the scene
   * @param {import("./roadConformSystem.js").RoadConformSystem} [o.conform]  this system's own conform
   * @param {() => void} [o.onTerrainEdited]  push cpuHeightmap edits to the GPU (one undoable stroke)
   */
  constructor({ scene, toolState, groundAt, viewTarget, conform = null, onTerrainEdited = () => {} }) {
    this.scene = scene;
    this.params = toolState.laneRoad;
    this.groundAt = groundAt;
    this.viewTarget = viewTarget;
    this.conform = conform;
    this.onTerrainEdited = onTerrainEdited;
    this._gradeTimer = 0;
    /** RoadConformSystem's view of this network (it was written for Smart Road's system). */
    this._conformView = {
      getFootprints: () => this._footprints(),
      roadSurfaceH: (x, z) => this._gradeTarget(x, z),
      params: { width: 0 }, // widths come per footprint (halfWs)
    };
    this.gradeStats = null;

    this.group = new THREE.Group();
    this.group.name = "LaneRoads";
    scene.add(this.group);

    /** Scene centre in world x/z and the ground height it sits on. */
    this.origin = { x: 0, z: 0, ground: 0 };
    this.loaded = false;
    this.result = null;
    this.stats = null;
    this._materials = null;
    this._meshes = {};
    this._paint = null;
  }

  // ── Materials ──────────────────────────────────────────────────────────────

  _ensureMaterials() {
    if (this._materials) return this._materials;
    const p = this.params;
    this._uSlab = uniform(new THREE.Color(p.slabColor));
    this._uCurb = uniform(new THREE.Color(p.curbColor));
    this._uApron = uniform(new THREE.Color(p.apronColor));
    this._uGrass = uniform(new THREE.Color(p.grassColor));
    this._paint = createLaneRoadPaint(p);
    this._materials = {
      asphalt: this._asphaltMaterial(),
      concrete: this._concreteMaterial(),
      grass: this._grassMaterial(),
    };
    return this._materials;
  }

  _asphaltMaterial() {
    const p = this.params;
    const params = {};
    for (const k of ASPHALT_KEYS) params[k] = typeof p[k] === "string" ? parseInt(p[k].slice(1), 16) : p[k];
    return createAsphaltMaterial({ frame: laneRoadFrame, params, paint: this._paint.hook, wet: p.wet, side: THREE.FrontSide });
  }

  /** Asphalt look sliders and colours → the live material's uniforms. */
  syncAsphalt() {
    const p = this.params;
    syncAsphaltUniforms(this._materials?.asphalt, Object.fromEntries(ASPHALT_KEYS.map((k) => [k, p[k]])));
  }

  /** Wet on/off compiles the water film in or out: swap the asphalt material. */
  setWet(on) {
    this.params.wet = on;
    if (!this._materials) return;
    const old = this._materials.asphalt;
    this._materials.asphalt = this._asphaltMaterial();
    if (this._meshes.asphalt) this._meshes.asphalt.material = this._materials.asphalt;
    old.dispose();
  }

  syncWetAmounts() {
    this.syncAsphalt();
  }

  /**
   * World-space concrete: a slow tonal field plus a fine speckle that fades out
   * once it is smaller than a pixel. `aKind` picks slab / curb stone / apron.
   */
  _concreteMaterial() {
    const m = new MeshStandardNodeMaterial({ roughness: 0.85, metalness: 0, side: THREE.FrontSide });
    const kind = attribute("aKind", "float");
    const macro = mx_fractal_noise_float(positionWorld.mul(0.35), 3, 2.0, 0.5, 1.0).mul(0.5).add(0.5);
    const px = max(fwidth(positionWorld.x), fwidth(positionWorld.z));
    const fineFade = saturate(oneMinus(px.mul(12.0)));
    const fine = mx_noise_float(positionWorld.mul(6.0)).mul(0.5).mul(fineFade).add(0.5);
    const tone = macro.mul(0.55).add(fine.mul(0.45));
    const shade = tone.sub(0.5).mul(0.35).add(1.0);
    let base = mix(this._uSlab, this._uCurb, step(0.5, kind));
    base = mix(base, this._uApron, step(1.5, kind));
    // Paving slab joints, as the city street draws them (2 cm, 16% darker), on
    // slab tops only. uv runs along/across a road's sidewalk strips, so the
    // joints follow the street; corner pieces use plan x/z.
    const size = uniform(this.params.slabSize);
    const cuv = uv();
    const aa = max(fwidth(cuv.x), fwidth(cuv.y)).div(size);
    const joint1 = (c) => {
      const d = float(0.5).sub(abs(fract(c.div(size)).sub(0.5)));
      const hw = float(0.02).div(size);
      return smoothstep(hw.add(aa), hw.sub(aa), d);
    };
    const joint = max(joint1(cuv.x), joint1(cuv.y)).mul(oneMinus(step(0.5, kind)));
    m.colorNode = base.mul(shade).mul(oneMinus(joint.mul(0.16)));
    m.roughnessNode = float(0.86).add(fine.sub(0.5).mul(0.12)).sub(step(0.5, kind).mul(0.06));
    return m;
  }

  _grassMaterial() {
    const m = new MeshStandardNodeMaterial({ roughness: 0.95, metalness: 0, side: THREE.FrontSide });
    const macro = mx_fractal_noise_float(positionWorld.mul(0.2), 3, 2.0, 0.5, 1.0).mul(0.5).add(0.5);
    const px = max(fwidth(positionWorld.x), fwidth(positionWorld.z));
    const fine = mx_noise_float(positionWorld.mul(4.0)).mul(0.5).mul(saturate(oneMinus(px.mul(8.0)))).add(0.5);
    m.colorNode = this._uGrass.mul(macro.mul(0.5).add(fine.mul(0.35)).add(0.55));
    return m;
  }

  syncMaterialColors() {
    if (!this._materials) return;
    const p = this.params;
    this._uSlab.value.set(p.slabColor);
    this._uCurb.value.set(p.curbColor);
    this._uApron.value.set(p.apronColor);
    this._uGrass.value.set(p.grassColor);
    const w = this._paint.uniforms;
    w.paintWhite.value.set(p.paintWhite);
    w.paintYellow.value.set(p.paintYellow);
  }

  syncPaintWear() {
    if (!this._paint) return;
    for (const k of PAINT_UNIFORM_KEYS) this._paint.uniforms[k].value = this.params[k];
  }

  // ── Build ──────────────────────────────────────────────────────────────────

  /** Load a test scene centred on the view target. */
  load(key = this.params.scene) {
    if (!PREVIEW_SCENES[key]) key = "all";
    this.params.scene = key;
    // The old grade comes off first, so the base stays the ungraded terrain.
    this.removeGrade();
    const t = this.viewTarget();
    this.origin.x = t.x;
    this.origin.z = t.z;
    this.origin.ground = this._ground(t.x, t.z);
    this.loaded = true;
    this.rebuild();
  }

  /** Ground the network is built on: the conform's pre-grade base when there is one. */
  _ground(x, z) {
    return this.conform?.hasBase ? this.conform.sampleGround(x, z) : this.groundAt(x, z);
  }

  get fitting() {
    return !!(this.params.fitTerrain && this.conform?.hasBase);
  }

  rebuild() {
    if (!this.loaded) return;
    const p = this.params;
    const t0 = performance.now();
    const ox = this.origin.x, oz = this.origin.z;
    let data = PREVIEW_SCENES[p.scene].build();
    let ground;
    if (this.fitting) {
      ground = (x, z) => this._ground(x + ox, z + oz);
    } else {
      data = flattenNetwork(data, this.origin.ground + p.lift);
      ground = () => this.origin.ground;
    }
    data.roadScale = p.roadScale;
    this.result = buildRoadNetwork(data, { ground, blocks: false, surface: { crown: p.crown, banking: p.banking } });
    const t1 = performance.now();
    const mesh = buildLaneRoadMesh(this.result, p);
    const mats = this._ensureMaterials();
    this._paint.setAtlas(mesh.atlas);

    let draws = 0, triangles = 0;
    for (const name of ["asphalt", "concrete", "grass"]) {
      this._setPart(name, mesh[name], mats[name]);
      if (mesh[name].triangleCount) draws++;
      triangles += mesh[name].triangleCount;
    }
    this._setSolids(mesh.solids);
    this.group.position.set(this.origin.x, 0, this.origin.z);
    this.group.visible = p.visible;
    this._applyShadows();
    if (this.fitting) this.scheduleGrade();
    else this.removeGrade();

    this.stats = {
      roads: this.result.stats.roads,
      nodes: this.result.stats.nodes,
      junctions: this.result.stats.junctions,
      roundabouts: this.result.stats.roundabouts,
      issues: this.result.issues.filter((i) => i.level !== "info").length,
      networkMs: t1 - t0,
      meshMs: mesh.stats.ms,
      atlasMs: mesh.atlas?.stats.ms ?? 0,
      atlas: mesh.atlas ? `${mesh.atlas.width}×${mesh.atlas.height} @ ${(mesh.atlas.texel * 100).toFixed(0)} cm, ${(mesh.atlas.stats.bytes / 1e6).toFixed(1)} MB` : "none",
      totalMs: performance.now() - t0,
      vertices: mesh.stats.vertices,
      triangles,
      draws,
    };
  }

  _setPart(name, part, material) {
    let mesh = this._meshes[name];
    if (!part.triangleCount) {
      if (mesh) { mesh.geometry.dispose(); this.group.remove(mesh); delete this._meshes[name]; }
      return;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(part.position, 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(part.normal, 3));
    geo.setAttribute("uv", new THREE.BufferAttribute(part.uv, 2));
    for (const [attr, a] of Object.entries(part.attributes)) geo.setAttribute(attr, new THREE.BufferAttribute(a.array, a.itemSize));
    geo.setIndex(new THREE.BufferAttribute(part.index, 1));
    geo.computeBoundingSphere();
    geo.computeBoundingBox();
    if (mesh) {
      mesh.geometry.dispose();
      mesh.geometry = geo;
    } else {
      mesh = new THREE.Mesh(geo, material);
      mesh.name = `LaneRoad_${name}`;
      mesh.receiveShadow = true;
      this.group.add(mesh);
      this._meshes[name] = mesh;
    }
  }

  /** Collision-only island walls: in the group (for its transform), never drawn. */
  _setSolids(part) {
    if (this._solids) {
      this._solids.geometry.dispose();
      this.group.remove(this._solids);
      this._solids = null;
    }
    if (!part?.triangleCount) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(part.position, 3));
    geo.setIndex(new THREE.BufferAttribute(part.index, 1));
    geo.computeBoundingSphere();
    this._solids = new THREE.Mesh(geo);
    this._solids.name = "LaneRoad_solids";
    this._solids.visible = false;
    this.group.add(this._solids);
  }

  /**
   * What cars collide with, in the modular-road game's shape:
   *   deck   — drive surfaces (wheel probes, deck contact): asphalt, concrete, grass
   *   solids — chassis walls: the island / median walls
   * Empty while hidden or not loaded.
   */
  collisionMeshes() {
    if (!this.loaded || !this.params.visible) return { deck: [], solids: [] };
    return {
      deck: Object.values(this._meshes),
      solids: this._solids ? [this._solids] : [],
    };
  }

  // ── Terrain grading ────────────────────────────────────────────────────────

  /** Road spines (world x/z, half width to the property line) and node discs. */
  _footprints() {
    const r = this.result;
    if (!r) return [];
    const ox = this.origin.x, oz = this.origin.z;
    const out = [];
    for (const rr of r.roads) {
      if (!rr.footMid || rr.footMid.length < 2) continue;
      out.push({ pts: rr.footMid.map((p) => ({ x: p[0] + ox, z: p[1] + oz })), halfWs: Array.from(rr.halfW) });
    }
    for (const n of r.nodes) {
      if (!n.reach || n.kind === "continuation" || n.kind === "isolated") continue;
      out.push({ pts: [{ x: n.x + ox, z: n.z + oz }], halfWs: [n.reach] });
    }
    return out;
  }

  /**
   * Terrain height wanted at world (x, z): under the road, the surface less
   * `embed`; past its edge, just under the top of what is there (sidewalk top,
   * or the asphalt edge where there is no sidewalk), where the shoulder starts.
   */
  _gradeTarget(wx, wz) {
    const p = this.params;
    const g = groundTargetAt(this.result, wx - this.origin.x, wz - this.origin.z, { curbHeight: p.curbHeight, reach: p.shoulder + 10 });
    if (!g) return this._ground(wx, wz);
    return g.out > 0 ? g.y - 0.05 : g.y - p.embed;
  }

  /** Debounced live grade: one undoable terrain stroke per edit, not per slider tick. */
  scheduleGrade() {
    clearTimeout(this._gradeTimer);
    this._gradeTimer = setTimeout(() => this.applyGradeNow(), 250);
  }

  applyGradeNow() {
    clearTimeout(this._gradeTimer);
    this._gradeTimer = 0;
    if (!this.fitting || !this.result) return;
    const t0 = performance.now();
    const changed = this.conform.applyLive(this._conformView, this._conformParams());
    const t1 = performance.now();
    if (changed) this.onTerrainEdited();
    this.gradeStats = { conformMs: t1 - t0, pushMs: performance.now() - t1, changed };
  }

  /** Flush a pending grade (leaving the mode). */
  flushGrade() {
    if (this._gradeTimer) this.applyGradeNow();
  }

  _conformParams() {
    // Embed is folded into _gradeTarget (it differs inside and outside the footprint).
    return { sidewalk: false, flattenDepth: 0, shoulder: this.params.shoulder };
  }

  /** Keep the current grade: it becomes the new base terrain. */
  bakeGrade() {
    if (!this.conform?.hasBase) return;
    this.flushGrade();
    if (this.conform.bake(this._conformView, this._conformParams())) this.onTerrainEdited();
  }

  /** Put the terrain back as it was before the live grade. */
  removeGrade() {
    clearTimeout(this._gradeTimer);
    this._gradeTimer = 0;
    if (this.conform?.removeGrade()) this.onTerrainEdited();
  }

  /** Entering the mode: fresh base from the current terrain, then re-drape. */
  rebaseTerrain() {
    if (!this.conform) return;
    this.conform.rebase();
    if (this.loaded) this.rebuild();
  }

  _applyShadows() {
    // Only the concrete casts: its curb faces are what throw the 15 cm shadow
    // line onto the asphalt. Flat asphalt and grass tops add nothing visible.
    for (const [name, mesh] of Object.entries(this._meshes)) {
      mesh.castShadow = name === "concrete" && this.params.curbShadows;
    }
  }

  setVisible(v) {
    this.params.visible = v;
    this.group.visible = v;
  }

  setCurbShadows(v) {
    this.params.curbShadows = v;
    this._applyShadows();
  }

  clear() {
    this.removeGrade();
    for (const mesh of Object.values(this._meshes)) {
      mesh.geometry.dispose();
      this.group.remove(mesh);
    }
    this._meshes = {};
    this._setSolids(null);
    this._paint?.setAtlas(null);
    this.loaded = false;
    this.result = null;
    this.stats = null;
  }
}
