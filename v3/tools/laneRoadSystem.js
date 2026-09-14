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
 * Draw calls: one mesh per material — asphalt, concrete, grass, paint — so 4,
 * plus the concrete mesh in the shadow pass when curb shadows are on.
 *
 * Markings are thin geometry 1 cm above the asphalt with a depth bias on the
 * paint material, one mesh for every line, bar, tooth and arrow.
 *
 * Asphalt is the track's own material (games/modular-road-v3/
 * modularRoadMaterial.js) with its track paint switched off per vertex
 * (aPlain), so the city street and the track share one asphalt.
 */
import * as THREE from "three";
import { MeshStandardNodeMaterial } from "three/webgpu";
import {
  attribute, float, fwidth, max, mix, mx_fractal_noise_float, mx_noise_float, oneMinus, positionWorld, saturate, step, uniform,
} from "three/tsl";
import { buildRoadNetwork } from "../roads/roadNetwork.js";
import { buildLaneRoadMesh, MESH_DEFAULTS } from "../roads/mesh/laneRoadMesh.js";
import { PREVIEW_SCENES, flattenNetwork } from "../roads/mesh/previewScenes.js";
import { createRoadMaterial } from "../../games/modular-road-v3/modularRoadMaterial.js";

export function createLaneRoadToolState() {
  return {
    laneRoad: {
      scene: "all",
      visible: true,
      /** Road surface above the ground under the scene centre (flat ground only). */
      lift: 0.1,
      curbShadows: true,
      ...MESH_DEFAULTS,
      slabColor: "#9a968e",
      curbColor: "#b0ada6",
      apronColor: "#7a736a",
      grassColor: "#4f6b2f",
      // Road paint is never pure: thermoplastic white sits around 0.7–0.8 albedo.
      paintWhite: "#d6d5cf",
      paintYellow: "#d4a12c",
    },
  };
}

export class LaneRoadSystem {
  /**
   * @param {object} o
   * @param {THREE.Scene} o.scene
   * @param {{ laneRoad: object }} o.toolState
   * @param {(x:number, z:number) => number} o.groundAt   terrain height (metres)
   * @param {() => THREE.Vector3} o.viewTarget            where "place here" drops the scene
   */
  constructor({ scene, toolState, groundAt, viewTarget }) {
    this.scene = scene;
    this.params = toolState.laneRoad;
    this.groundAt = groundAt;
    this.viewTarget = viewTarget;

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
  }

  // ── Materials ──────────────────────────────────────────────────────────────

  _ensureMaterials() {
    if (this._materials) return this._materials;
    const p = this.params;
    this._uSlab = uniform(new THREE.Color(p.slabColor));
    this._uCurb = uniform(new THREE.Color(p.curbColor));
    this._uApron = uniform(new THREE.Color(p.apronColor));
    this._uGrass = uniform(new THREE.Color(p.grassColor));
    this._uPaintWhite = uniform(new THREE.Color(p.paintWhite));
    this._uPaintYellow = uniform(new THREE.Color(p.paintYellow));
    this._materials = {
      asphalt: createRoadMaterial({ side: THREE.FrontSide }),
      concrete: this._concreteMaterial(),
      grass: this._grassMaterial(),
      paint: this._paintMaterial(),
    };
    return this._materials;
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
    m.colorNode = base.mul(shade);
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

  /**
   * Paint: white or yellow per vertex (aPaint), a little worn by a world-space
   * field so a long line is not one flat sheet, and pulled toward the camera
   * by a depth bias on top of its 1 cm lift so it never fights the asphalt.
   */
  _paintMaterial() {
    const m = new MeshStandardNodeMaterial({
      roughness: 0.6, metalness: 0, side: THREE.FrontSide,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4,
    });
    const base = mix(this._uPaintWhite, this._uPaintYellow, attribute("aPaint", "float"));
    const px = max(fwidth(positionWorld.x), fwidth(positionWorld.z));
    const wear = mx_fractal_noise_float(positionWorld.mul(1.7), 2, 2.0, 0.5, 1.0)
      .mul(saturate(oneMinus(px.mul(3.0)))).mul(0.5).add(0.5);
    m.colorNode = base.mul(float(0.8).add(wear.mul(0.2)));
    m.roughnessNode = float(0.55).add(wear.sub(0.5).mul(0.2));
    return m;
  }

  syncMaterialColors() {
    if (!this._materials) return;
    const p = this.params;
    this._uPaintWhite.value.set(p.paintWhite);
    this._uPaintYellow.value.set(p.paintYellow);
    this._uSlab.value.set(p.slabColor);
    this._uCurb.value.set(p.curbColor);
    this._uApron.value.set(p.apronColor);
    this._uGrass.value.set(p.grassColor);
  }

  // ── Build ──────────────────────────────────────────────────────────────────

  /** Load a test scene centred on the view target. */
  load(key = this.params.scene) {
    if (!PREVIEW_SCENES[key]) key = "all";
    this.params.scene = key;
    const t = this.viewTarget();
    this.origin.x = t.x;
    this.origin.z = t.z;
    this.origin.ground = this.groundAt(t.x, t.z);
    this.loaded = true;
    this.rebuild();
  }

  rebuild() {
    if (!this.loaded) return;
    const p = this.params;
    const t0 = performance.now();
    const y = this.origin.ground + p.lift;
    const data = flattenNetwork(PREVIEW_SCENES[p.scene].build(), y);
    this.result = buildRoadNetwork(data, { ground: () => this.origin.ground, blocks: false });
    const t1 = performance.now();
    const mesh = buildLaneRoadMesh(this.result, p);
    const mats = this._ensureMaterials();

    let draws = 0, triangles = 0;
    for (const name of ["asphalt", "concrete", "grass", "paint"]) {
      this._setPart(name, mesh[name], mats[name]);
      if (mesh[name].triangleCount) draws++;
      triangles += mesh[name].triangleCount;
    }
    this.group.position.set(this.origin.x, 0, this.origin.z);
    this.group.visible = p.visible;
    this._applyShadows();

    this.stats = {
      roads: this.result.stats.roads,
      nodes: this.result.stats.nodes,
      junctions: this.result.stats.junctions,
      roundabouts: this.result.stats.roundabouts,
      issues: this.result.issues.filter((i) => i.level !== "info").length,
      networkMs: t1 - t0,
      meshMs: mesh.stats.ms,
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
    for (const mesh of Object.values(this._meshes)) {
      mesh.geometry.dispose();
      this.group.remove(mesh);
    }
    this._meshes = {};
    this.loaded = false;
    this.result = null;
    this.stats = null;
  }
}
