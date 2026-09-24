/**
 * Projected decals — the Unreal / Unity model: a decal is an oriented BOX that
 * paints a texture onto whatever surface lies inside it (terrain, props, roads,
 * rocks), projected along the box's own −Y.
 *
 * HOW A PIXEL IS PAINTED. Every decal is drawn as the back faces of its box.
 * For each pixel of the box, the scene depth under it gives the real surface
 * point on the same view ray; that point goes into the decal's local space, and
 * if it is inside the unit box its XZ is the texture coordinate. So the decal
 * follows any geometry exactly — no decal mesh is ever built or re-conformed
 * when the terrain is sculpted or a prop moves.
 *
 * LIT LIKE THE SURFACE. The decal is a MeshStandardNodeMaterial: its colour,
 * roughness and (optionally normal-mapped) normal go through the engine's
 * lighting, and `receivedShadowPositionNode` points the shadow lookup at the
 * real surface point instead of the box, so a decal in shade is in shade. The
 * normal is rebuilt from the depth's screen-space derivatives, then bent by
 * the decal's normal map in a frame aligned to the decal.
 *
 * WHY BACK FACES AND A REVERSED DEPTH TEST (GreaterEqual): a back face that is
 * behind the scene surface covers exactly the pixels where that surface passes
 * through the box — and it still works when the camera is INSIDE the box, where
 * front faces would be clipped away and the decal would vanish.
 *
 * PERFORMANCE
 *   - ONE draw call for every decal: instanced boxes, per-instance matrices and
 *     parameters in instanced attributes.
 *   - Two texture-array bindings total, whatever the number of decal types
 *     (decalTextures.js).
 *   - Culling (sphere vs frustum) and sorting run on the CPU, and only when the
 *     camera moved or a decal changed; the instance buffers are re-uploaded only
 *     then. Sorting by priority keeps overlapping decals in a stable order —
 *     a GPU compaction would shuffle them and flicker.
 *   - No extra depth copy: it reads the engine's ONE shared scene-depth grab
 *     (lakeMaterial.js), taken once per frame by whichever of water or decals
 *     draws first — water sits at renderOrder 10, after the ordinary opaque
 *     objects. (A second viewportDepthTexture node bound the multisampled depth
 *     buffer itself and invalidated the whole frame on WebGPU.)
 *   - Fragment cost only where a box covers the screen, and the surface test
 *     discards most of it cheaply.
 *
 * GROUND ONLY, when given `groundHeight`. A screen-space decal paints whatever
 * opaque surface is inside its box — and on nam-rts that was the jeeps and
 * soldiers driving through a road's wheel ruts, and the buildings standing on
 * a crater. The surface point the shader already reconstructs is compared with
 * the terrain's own height at that XZ (one heightmap tap) and the decal fades
 * out over 0.35-0.75 m above it: ground and road keep it, anything standing on
 * them does not. The half metre of slack covers the clipmap mesh sitting a
 * little off the heightmap it was built from. The price is that a decal cannot
 * be laid on a raised prop (a bridge deck) while this is on.
 *
 * Without `groundHeight` it is the old rule, as Unity's screen-space decals
 * without rendering layers: anything opaque inside the box receives the decal.
 * Either way the angle fade stops it smearing onto steep sides.
 */
import * as THREE from "three";
import {
  Fn, Discard, abs, attribute, cameraFar, cameraNear, cameraWorldMatrix, cross, dFdx, dFdy,
  dot, float, max, normalize, perspectiveDepthToViewZ, positionLocal, positionView, screenUV,
  select, smoothstep, texture, vec2, vec3, vec4, cameraViewMatrix, int, varying,
  cameraPosition, positionWorld, viewZToPerspectiveDepth,
} from "three/tsl";
import { DecalTextures, DEFAULT_DECAL_SLOTS } from "./decalTextures.js";
import { sceneDepthGrab } from "../water/lakeMaterial.js";
import { decalMatrix, pickDecal, remapSlotsAfterRemove } from "./decalMath.js";

export const DECAL_DEFAULTS = {
  slot: 0,
  /** Metres: width (X), projection depth (Y), length (Z). */
  sx: 4, sy: 2, sz: 4,
  opacity: 1,
  tint: "#ffffff",
  roughness: 0.85,
  normalStrength: 1,
  /** Degrees: surfaces tilted more than this from the projection stop receiving it. */
  angleFade: 70,
  /** Fraction of the box edge (XZ) spent fading out. */
  edgeFade: 0.04,
  /** Higher draws on top where decals overlap. */
  priority: 0,
};

let _nextId = 1;
const STRIDE = 36;

const _m = new THREE.Matrix4();
const _inv = new THREE.Matrix4();
const _frustum = new THREE.Frustum();
const _pv = new THREE.Matrix4();
const _sphere = new THREE.Sphere();
const _c = new THREE.Color();

export class DecalSystem {
  /**
   * @param {object} o
   * @param {THREE.Scene} o.scene
   * @param {(ref:string) => string|null} [o.resolveUrl] turns a saved texture
   *   reference (e.g. "asset:<hash>") into a loadable URL
   */
  /**
   * @param {object} o
   * @param {function} [o.groundHeight]  (wx, wz) TSL nodes → terrain Y node; when
   *   given, decals land on the ground only (see the header)
   */
  constructor({ scene, resolveUrl, groundHeight = null }) {
    this._groundHeight = groundHeight;
    this.decals = [];
    this.textures = new DecalTextures({ resolveUrl });
    this.group = new THREE.Group();
    this.group.name = "Decals";
    scene.add(this.group);

    this._capacity = 0;
    this._dirty = true;          // decal data or order changed
    this._camKey = "";
    this.visibleCount = 0;

    this._buildMesh(256);
    this.ready = this.setSlots(DEFAULT_DECAL_SLOTS);
  }

  // ── Data ────────────────────────────────────────────────────────────────

  /** Add a decal. Pass position, quaternion (projection = local −Y) and any DECAL_DEFAULTS. */
  add(params) {
    const d = { px: 0, py: 0, pz: 0, qx: 0, qy: 0, qz: 0, qw: 1, ...DECAL_DEFAULTS, ...params };
    // Keep a given id (undo restores them) unless it is taken.
    if (!Number.isInteger(d.id) || this.get(d.id)) d.id = _nextId;
    _nextId = Math.max(_nextId, d.id + 1);
    this.decals.push(d);
    this.markDirty();
    return d;
  }

  /** A copy of decal `id`, moved by `offset` (world XYZ). */
  duplicate(id, offset = { x: 0, y: 0, z: 0 }) {
    const src = this.get(id);
    if (!src) return null;
    const { id: _, ...rest } = src;
    return this.add({ ...rest, px: src.px + offset.x, py: src.py + offset.y, pz: src.pz + offset.z });
  }

  /** Decal list with ids, as a string — for undo. Slots are not part of it. */
  snapshot() { return JSON.stringify(this.decals); }

  restore(snap) {
    this.decals.length = 0;
    for (const d of JSON.parse(snap)) this.add(d);
    this.markDirty();
  }

  // ── Texture slots ───────────────────────────────────────────────────────

  /** Replace every slot ({ name, albedoUrl, normalUrl }); resolves when the arrays are rebuilt. */
  async setSlots(slots) {
    await this.textures.setSlots(slots);
    this._onTexturesRebuilt();
  }

  addSlot(slot) {
    return this.setSlots([...this.textures.slots, slot]);
  }

  updateSlot(i, patch) {
    const slots = this.textures.slots.map((s) => ({ ...s }));
    if (!slots[i]) return Promise.resolve();
    Object.assign(slots[i], patch);
    return this.setSlots(slots);
  }

  /** Remove slot i. Decals using it fall back to slot 0; later indices shift down. */
  removeSlot(i) {
    const slots = this.textures.slots.filter((_, k) => k !== i);
    remapSlotsAfterRemove(this.decals, i);
    this.markDirty();
    return this.setSlots(slots);
  }

  /**
   * Nearest decal box the ray enters, as { decal, distance } (null if none).
   * Boxes stand above the ground, so for "what did I click" prefer pick() with
   * the surface point; this is for boxes floating free of anything to click.
   */
  raycast(ray) {
    let best = null;
    const r = new THREE.Ray();
    const box = new THREE.Box3(new THREE.Vector3(-0.5, -0.5, -0.5), new THREE.Vector3(0.5, 0.5, 0.5));
    const hit = new THREE.Vector3();
    for (const d of this.decals) {
      this.matrixOf(d, _m);
      r.copy(ray).applyMatrix4(_inv.copy(_m).invert());
      if (!r.intersectBox(box, hit)) continue;
      const dist = hit.applyMatrix4(_m).distanceTo(ray.origin);
      if (!best || dist < best.distance) best = { decal: d, distance: dist };
    }
    return best;
  }

  remove(id) {
    const i = this.decals.findIndex((d) => d.id === id);
    if (i < 0) return false;
    this.decals.splice(i, 1);
    this.markDirty();
    return true;
  }

  get(id) { return this.decals.find((d) => d.id === id) ?? null; }

  clear() { this.decals.length = 0; this.markDirty(); }

  markDirty() { this._dirty = true; }

  /** The decal's world matrix (unit box → world). */
  matrixOf(d, target = new THREE.Matrix4()) {
    return decalMatrix(d, target);
  }

  /** The decal painted on top at this surface point — what a click on it selects. */
  pick(point) {
    return pickDecal(this.decals, point);
  }

  exportData() {
    return {
      slots: this.textures.slots.map((s) => ({ ...s })),
      decals: this.decals.map(({ id, ...rest }) => ({ ...rest })),
    };
  }

  /**
   * Replace everything with saved data (null = no decals, default slots).
   * Texture references stay as saved; the textures resolve them to URLs.
   */
  async importData(data) {
    this.decals.length = 0;
    for (const d of data?.decals ?? []) {
      const { id: _, ...rest } = d;
      this.add(rest);
    }
    this.markDirty();
    const slots = data?.slots?.length ? data.slots : DEFAULT_DECAL_SLOTS;
    if (JSON.stringify(slots) !== JSON.stringify(this.textures.slots)) await this.setSlots(slots);
  }

  // ── Rendering ───────────────────────────────────────────────────────────

  _buildMesh(capacity) {
    this._capacity = capacity;
    const box = new THREE.BoxGeometry(1, 1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = box.index;
    geo.setAttribute("position", box.getAttribute("position"));
    // ONE interleaved per-instance buffer (WebGPU allows 8 vertex buffers per
    // draw; nine separate attributes would not fit, and one buffer is one upload).
    // Per instance, 9 × vec4 = 36 floats:
    //   aM0-2  unit box → world, rows      aI0-2  world → unit box, rows
    //   aP     slot, opacity, normalStrength, cos(angleFade)
    //   aC     tint.rgb, roughness          aE     edgeFade, 0, 0, 0
    const buf = new THREE.InstancedInterleavedBuffer(new Float32Array(capacity * STRIDE), STRIDE, 1);
    buf.setUsage(THREE.DynamicDrawUsage);
    ["aM0", "aM1", "aM2", "aI0", "aI1", "aI2", "aP", "aC", "aE"].forEach((name, k) => {
      geo.setAttribute(name, new THREE.InterleavedBufferAttribute(buf, 4, k * 4));
    });
    this._buf = buf;
    geo.instanceCount = 0;
    // The boxes are positioned by the vertex shader; bounds never cull the draw.
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);

    if (this.mesh) {
      this.mesh.geometry.dispose();
      this.mesh.geometry = geo;
    } else {
      this.material = this._buildMaterial();
      this.mesh = new THREE.Mesh(geo, this.material);
      this.mesh.frustumCulled = false;
      this.mesh.name = "DecalBoxes";
      // After the opaque surfaces it reads, before the water (renderOrder 10).
      this.mesh.renderOrder = 9;
      // Hidden until update() has decals to draw: a render before that (the boot
      // precompile) must not bind the depth grab on the multisampled canvas.
      this.mesh.visible = false;
      this.group.add(this.mesh);
    }
    this._dirty = true;
  }

  /**
   * GRAB-FREE decals (ground-only systems only): find the ground on each
   * pixel's view ray by marching the heightmap inside the box instead of
   * reading the scene-depth grab, and write that point's depth so a unit
   * standing on the decal still hides it (normal depth test, not the box's
   * GreaterEqual back-face trick). Measured 2026-09-24 (nam-rts, x1.55 res):
   * with the river grab-free, ONE decal on screen still cost 1.1 ms — the
   * full-screen depth copy — and the camp's 24 cost 1.9. ~5 heightmap taps
   * per decal pixel instead (see the solve below).
   */
  setGrabFree(on) {
    on = !!on && !!this._groundHeight;
    if (on === !!this._grabFree) return;
    this._grabFree = on;
    const old = this.material;
    this.material = this._buildMaterial();
    if (this.mesh) this.mesh.material = this.material;
    this._onTexturesRebuilt?.();
    old?.dispose?.();
  }

  _buildMaterial() {
    const mat = new THREE.MeshStandardNodeMaterial();
    // NOT in the transparent queue: on a multisampled canvas, three's transparent
    // pass cannot copy the depth (the copy came out multisampled and the whole
    // frame was rejected). In the opaque queue at renderOrder 9 — after the
    // ordinary opaque objects, just BEFORE the water (10), so water covers an
    // underwater decal and its colour grab includes the decals — with explicit alpha blending,
    // which WebGPU pipelines honour for CustomBlending even when not transparent.
    mat.transparent = false;
    mat.blending = THREE.CustomBlending;
    mat.blendEquation = THREE.AddEquation;
    mat.blendSrc = THREE.SrcAlphaFactor;
    mat.blendDst = THREE.OneMinusSrcAlphaFactor;
    mat.blendSrcAlpha = THREE.ZeroFactor;
    mat.blendDstAlpha = THREE.OneFactor;
    mat.depthWrite = false;
    mat.depthTest = true;
    mat.depthFunc = THREE.GreaterEqualDepth;
    mat.side = THREE.BackSide;
    mat.metalness = 0;
    mat.fog = true;

    const m0 = attribute("aM0", "vec4"), m1 = attribute("aM1", "vec4"), m2 = attribute("aM2", "vec4");

    // GLUED TO THE LIVE GROUND. A box only paints where the ground passes
    // through it, and its height was fixed when it was placed — so any later
    // change to the terrain under it (a game levelling a camp at boot, a
    // building pad dug mid-match, a sculpt in the editor) left it floating or
    // buried, and it silently stopped drawing. nam-rts lost its whole base's
    // wear that way: ruts at y 18.4 over ground levelled to 12.0.
    //
    // So, when decals are ground-only, each box is shifted vertically by the
    // ground's height under its CENTRE minus its own: sampled in the vertex
    // stage (8 taps a box), passed to the fragment stage, and applied to the
    // surface point before it goes into box space, so both agree. A decal that
    // was on the ground is unchanged (shift 0); one the ground moved under
    // follows it. The saved `py` is never touched.
    const groundShiftV = this._groundHeight
      ? this._groundHeight(m0.w, m2.w).sub(m1.w)
      : float(0);
    const groundShift = this._groundHeight ? varying(groundShiftV, "decalGroundShift") : float(0);

    mat.positionNode = Fn(() => {
      const p = vec4(positionLocal, 1);
      return vec3(dot(m0, p), dot(m1, p).add(groundShiftV), dot(m2, p));
    })();

    this._albedoNode = texture(this.textures.albedo);
    this._normalNode = texture(this.textures.normal);
    const grabFree = !!this._grabFree;
    let surfaceWorld;
    if (grabFree) {
      // The ground on this pixel's view ray.
      const gh = this._groundHeight;
      surfaceWorld = Fn(() => {
        // Solve ray.y = ground(ray.xz) by fixed-point steps from where the
        // ray crosses the box's own middle height: t += (ground - y) / dir.y.
        // Inside a decal box the ground is nearly flat and the RTS ray steep,
        // so 4 steps (4 taps) land within centimetres. A 12-step march with 4
        // halvings (16 taps a pixel — the first grab-free version) cost as
        // much as the depth copy it replaced (1.84 ms at the camp).
        const dir = normalize(positionWorld.sub(cameraPosition)).toVar();
        const dy = select(abs(dir.y).lessThan(0.05), float(-0.05), dir.y).toVar();
        const midY = m1.w.add(groundShift);
        const t = midY.sub(cameraPosition.y).div(dy).toVar();
        for (let k = 0; k < 4; k++) {
          const q = cameraPosition.add(dir.mul(t));   // the LIVE ground: no box shift
          t.addAssign(gh(q.x, q.z).sub(q.y).div(dy));
        }
        const hit = cameraPosition.add(dir.mul(t)).toVar();
        // Not converged (a cliff inside the box): leave the pixel alone.
        Discard(abs(hit.y.sub(gh(hit.x, hit.z))).greaterThan(0.4));
        return hit;
      })().toVar("decalSurfaceWorld");
      // Depth at the ground point, pulled 0.3 m toward the camera: the clipmap
      // mesh sits a little off the heightmap it is built from.
      mat.depthFunc = THREE.LessEqualDepth;
      mat.depthNode = Fn(() => {
        const toCam = normalize(cameraPosition.sub(surfaceWorld));
        const vz = cameraViewMatrix.mul(vec4(surfaceWorld.add(toCam.mul(0.3)), 1)).z;
        return viewZToPerspectiveDepth(vz, cameraNear, cameraFar);
      })();
    } else {
      const depthTex = sceneDepthGrab;
      // The real surface point on this pixel's view ray, in view and world space.
      const surfaceView = Fn(() => {
        const sceneZ = perspectiveDepthToViewZ(depthTex.sample(screenUV).r, cameraNear, cameraFar);
        return positionView.mul(sceneZ.div(positionView.z));
      })().toVar("decalSurfaceView");
      surfaceWorld = cameraWorldMatrix.mul(vec4(surfaceView, 1)).xyz.toVar("decalSurfaceWorld");
    }

    const i0 = attribute("aI0", "vec4"), i1 = attribute("aI1", "vec4"), i2 = attribute("aI2", "vec4");
    const P = attribute("aP", "vec4"), C = attribute("aC", "vec4"), E = attribute("aE", "vec4");
    const local = Fn(() => {
      // Into the box as it is DRAWN: shifted onto the ground (see above).
      const w = vec4(surfaceWorld.sub(vec3(0, groundShift, 0)), 1);
      return vec3(dot(i0, w), dot(i1, w), dot(i2, w));
    })().toVar("decalLocal");

    // Decal axes in world space (columns of the box matrix).
    const axisX = normalize(vec3(m0.x, m1.x, m2.x));
    const axisY = normalize(vec3(m0.y, m1.y, m2.y));

    // Geometric normal of the receiving surface, from the depth's derivatives,
    // turned to face the camera.
    const surfN = grabFree ? Fn(() => {
      // From the heightmap's own slope: the marched point is too coarse to
      // differentiate cleanly.
      const gh = this._groundHeight, e = float(0.6);
      const hx = gh(surfaceWorld.x.add(e), surfaceWorld.z).sub(gh(surfaceWorld.x.sub(e), surfaceWorld.z));
      const hz = gh(surfaceWorld.x, surfaceWorld.z.add(e)).sub(gh(surfaceWorld.x, surfaceWorld.z.sub(e)));
      return normalize(vec3(hx.negate(), e.mul(2), hz.negate()));
    })().toVar("decalSurfN") : Fn(() => {
      const n = normalize(cross(dFdx(surfaceWorld), dFdy(surfaceWorld))).toVar();
      const toCam = cameraWorldMatrix.mul(vec4(0, 0, 0, 1)).xyz.sub(surfaceWorld);
      return select(dot(n, toCam).lessThan(0), n.negate(), n);
    })().toVar("decalSurfN");

    const uvD = vec2(local.x.add(0.5), float(0.5).sub(local.z));
    const layer = int(P.x.add(0.5));
    const albedo = this._albedoNode.sample(uvD).depth(layer);

    const coverage = Fn(() => {
      const inside = float(1).sub(smoothstep(0.5, 0.5001, max(max(abs(local.x), abs(local.y)), abs(local.z))));
      const edge = E.x.max(1e-3);
      const edgeFade = smoothstep(0, edge, float(0.5).sub(abs(local.x)))
        .mul(smoothstep(0, edge, float(0.5).sub(abs(local.z))));
      // Fade toward the top and bottom of the projection depth, not a hard cut.
      const depthFade = float(1).sub(smoothstep(0.35, 0.5, abs(local.y)));
      const facing = dot(surfN, axisY);
      const angle = smoothstep(P.w, P.w.add(0.15), facing);
      const cov = inside.mul(edgeFade).mul(depthFade).mul(angle);
      if (!this._groundHeight) return cov;
      // Ground only: gone by 0.75 m above the terrain at this XZ.
      const above = surfaceWorld.y.sub(this._groundHeight(surfaceWorld.x, surfaceWorld.z));
      return cov.mul(float(1).sub(smoothstep(0.35, 0.75, above)));
    })().toVar("decalCoverage");

    mat.opacityNode = Fn(() => {
      const a = albedo.a.mul(P.y).mul(coverage);
      Discard(a.lessThan(0.002));
      return a;
    })();
    mat.colorNode = albedo.rgb.mul(C.xyz);
    mat.roughnessNode = C.w;

    mat.normalNode = Fn(() => {
      const nTex = this._normalNode.sample(uvD).depth(layer).xyz.mul(2).sub(1);
      const T = normalize(axisX.sub(surfN.mul(dot(axisX, surfN))));
      const B = cross(surfN, T);
      const strength = P.z;
      const nMapped = normalize(T.mul(nTex.x.mul(strength)).add(B.mul(nTex.y.mul(strength))).add(surfN.mul(nTex.z)));
      return cameraViewMatrix.mul(vec4(nMapped, 0)).xyz.normalize();
    })();

    // Shadows and lights at the painted surface, not at the box face.
    mat.receivedShadowPositionNode = surfaceWorld;
    return mat;
  }

  _onTexturesRebuilt() {
    this._albedoNode.value = this.textures.albedo;
    this._normalNode.value = this.textures.normal;
    this.markDirty();
  }

  /** Per frame: re-cull and re-upload only when the camera or the decals changed. */
  update(camera) {
    const e = camera.matrixWorld.elements, pe = camera.projectionMatrix.elements;
    const camKey = `${e[12].toFixed(2)},${e[13].toFixed(2)},${e[14].toFixed(2)},${e[8].toFixed(3)},${e[9].toFixed(3)},${e[10].toFixed(3)},${pe[0].toFixed(3)},${pe[5].toFixed(3)}`;
    if (!this._dirty && camKey === this._camKey) return;
    this._camKey = camKey;
    this._dirty = false;

    if (this.decals.length > this._capacity) {
      let cap = this._capacity;
      while (cap < this.decals.length) cap *= 2;
      this._buildMesh(cap);
    }

    _pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_pv, camera.coordinateSystem);
    const vis = [];
    for (const d of this.decals) {
      _sphere.center.set(d.px, d.py, d.pz);
      // + slack for the GPU's ground glue: the box is drawn where the ground
      // is now, which can be metres off the saved py (see _buildMaterial).
      _sphere.radius = 0.5 * Math.hypot(d.sx, d.sy, d.sz) + (this._groundHeight ? 8 : 0);
      if (_frustum.intersectsSphere(_sphere)) vis.push(d);
    }
    vis.sort((a, b) => a.priority - b.priority || a.id - b.id);

    const arr = this._buf.array;
    const layers = Math.max(1, this.textures.slots.length);
    for (let k = 0; k < vis.length; k++) {
      const d = vis[k];
      this.matrixOf(d, _m);
      _inv.copy(_m).invert();
      const me = _m.elements, ie = _inv.elements;
      // Column-major elements → rows.
      const slot = Math.min(Math.max(0, d.slot | 0), layers - 1);
      _c.set(d.tint);
      arr.set([
        me[0], me[4], me[8], me[12], me[1], me[5], me[9], me[13], me[2], me[6], me[10], me[14],
        ie[0], ie[4], ie[8], ie[12], ie[1], ie[5], ie[9], ie[13], ie[2], ie[6], ie[10], ie[14],
        slot, d.opacity, d.normalStrength, Math.cos((d.angleFade * Math.PI) / 180),
        _c.r, _c.g, _c.b, d.roughness,
        d.edgeFade, 0, 0, 0,
      ], k * STRIDE);
    }
    this._buf.clearUpdateRanges();
    this._buf.addUpdateRange(0, Math.max(STRIDE, vis.length * STRIDE));
    this._buf.needsUpdate = true;
    this.mesh.geometry.instanceCount = vis.length;
    this.mesh.visible = vis.length > 0;
    this.visibleCount = vis.length;
  }
}
