import * as THREE from "three";
// Collision radius is shared so the visual offset and the body can never drift.
import {
  PHYSICS_PROP_TYPES,
  CONE_SCALE,
  GATE_WIDTH,
  GATE_HEIGHT,
  GATE_BASE_Y,
  GATE_POST_RADIUS,
  GATE_POST_HEIGHT,
} from "./modularRoadPropPhysics.js";
import { SCENERY_CATALOG, makeSceneryProp } from "./modularRoadScenery.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { materialEmissive, materialColor } from "three/tsl";
import { applyBloomMRT } from "../../v3/render/bloomMRT.js";
import { computeFrames, buildProfile, buildTunnelGeometry } from "./modularRoadKit.js";
import {
  kickerRampGeometry,
  jumpRampGeometry,
  buildSlopeLabGroup,
  buildJumpLabGroup,
  enableMeshShadows,
} from "./modularRoadParkour.js";

/**
 * Free-placement props for the modular road. Unlike auto-chained track pieces,
 * props are standalone objects (box, wall, ramp, cylinders, ring gate, air tunnel)
 * positioned by hand with a shared TransformControls gizmo — the same pattern as
 * the v2 editor props mode (W/E/R = move/rotate/scale, right-click select).
 *
 * Each prop carries a `collision` role so the page can bake it into the right
 * BVH:
 *   - "deck"  → drive surface (wheel raycasts): ramps, the floor of a tube
 *   - "solid" → chassis wall collision only (no wheel ground): wall panels, air-tunnel shell
 *   - "both"  → drive on top AND blocked at the sides: boxes
 *   - "none"  → pure decoration you pass through: ring gates
 */

const V3 = THREE.Vector3;

// Boost-pad footprint (shared by the visual + its trigger zone).
const BOOST_W = 10; // width across the deck (m)
const BOOST_D = 20; // length along travel (m)
const BOOST_H = 0.12; // slab thickness (flush decal)

// Scratch objects for the per-frame trigger-zone test (no per-frame allocation).
const _fieldInv = new THREE.Matrix4();
const _fieldLocal = new V3();
const _fieldFwd = new V3();

/* ----------------------------------------------------------------------- */
/* Prop geometry builders                                                   */
/* ----------------------------------------------------------------------- */

/** Right-triangular prism ramp: base on y=0, rising from +Z (low) to -Z (high). */
function rampGeometry(L = 18, H = 6, W = 14) {
  const hw = W / 2;
  const zN = L / 2; // near (low) edge
  const zF = -L / 2; // far (high) edge
  const Al = [-hw, 0, zN], Bl = [-hw, 0, zF], Cl = [-hw, H, zF];
  const Ar = [hw, 0, zN], Br = [hw, 0, zF], Cr = [hw, H, zF];
  const pos = [];
  const quad = (a, b, c, d) => pos.push(...a, ...b, ...c, ...a, ...c, ...d);
  const tri = (a, b, c) => pos.push(...a, ...b, ...c);
  quad(Al, Ar, Cr, Cl); // sloped top (drive surface)
  quad(Al, Bl, Br, Ar); // bottom
  quad(Bl, Cl, Cr, Br); // vertical back
  tri(Al, Cl, Bl); // left cap
  tri(Ar, Br, Cr); // right cap
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

/** A short run of tunnel arch (reuses the kit's shell sweep) on a straight line. */
function airTunnelGeometry(length = 36, height = 9) {
  const n = Math.max(2, Math.ceil(length / 2));
  const pts = [];
  for (let i = 0; i <= n; i++) pts.push(new V3(0, 0, -length * (i / n)));
  const frames = computeFrames(pts);
  const profileData = buildProfile();
  const geo = buildTunnelGeometry(frames, profileData, { tunnelHeight: height });
  // Re-centre on Z so the gizmo pivot sits in the middle of the run.
  geo.translate(0, 0, length / 2);
  geo.computeBoundingSphere();
  return geo;
}

/** Thick-walled pipe: outer shell, inner liner, and annular end caps (still hollow to drive through). */
function openTubeGroup(outerR = 9, length = 30, wall = 0.65, segments = 40) {
  const innerR = outerR - wall;
  const half = length / 2;
  const tubeMat = mat(0x3a7bd5, { metalness: 0.55, roughness: 0.4, side: THREE.DoubleSide });
  const innerMat = mat(0x3a7bd5, { metalness: 0.55, roughness: 0.4, side: THREE.BackSide });

  const root = new THREE.Group();
  root.name = "OpenCylinder";

  root.add(new THREE.Mesh(new THREE.CylinderGeometry(outerR, outerR, length, segments, 1, true), tubeMat));
  root.add(new THREE.Mesh(new THREE.CylinderGeometry(innerR, innerR, length, segments, 1, true), innerMat));

  for (const y of [half, -half]) {
    const cap = new THREE.Mesh(new THREE.RingGeometry(innerR, outerR, segments), tubeMat);
    cap.rotation.x = -Math.PI / 2;
    cap.position.y = y;
    root.add(cap);
  }

  root.rotation.x = Math.PI / 2;
  root.position.set(0, outerR, 0); // bottom of the pipe rests on the ground
  return root;
}

/**
 * Flush deck pad: dark slab + bright emissive chevrons pointing along local −Z
 * (the "forward" the car is meant to enter from). The effect (boost / launch)
 * comes from the prop's `field` trigger zone (see PropManager.applyFields), not
 * the geometry — this is just the look. Used by both the boost and launch pads.
 */
function flatPadGroup(w, d, color, name = "Pad") {
  const g = new THREE.Group();
  g.name = name;
  const base = new THREE.Mesh(
    new THREE.BoxGeometry(w, BOOST_H, d),
    mat(0x0d1116, { roughness: 0.5, metalness: 0.25, emissive: 0x0a1f24, emissiveIntensity: 0.5 }),
  );
  base.position.y = BOOST_H / 2 + 0.04; // sit flush just above the deck
  g.add(base);

  const y = BOOST_H + 0.06;
  const hw = w * 0.34;
  const aLen = Math.min(3.4, d * 0.22); // arrowhead length
  const gap = d * 0.24;
  const pos = [];
  for (let i = 0; i < 3; i++) {
    const zBack = gap - i * gap; // base edge; tip is aLen further forward (−Z)
    pos.push(0, y, zBack - aLen, hw, y, zBack, -hw, y, zBack); // tip, right, left
  }
  const chevGeo = new THREE.BufferGeometry();
  chevGeo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  chevGeo.computeVertexNormals();
  const chev = new THREE.Mesh(
    chevGeo,
    mat(color, { roughness: 0.3, emissive: color, emissiveIntensity: 5, side: THREE.DoubleSide }),
  );
  g.add(chev);
  return g;
}

/**
 * Emissive chevrons pointing along local −Z, laid flat at deck level.
 * Shared arrow-drawing for the pad decals (no slab — see flatDecalGroup).
 */
function chevronRunMesh(w, d, color, y = 0.06) {
  const hw = w * 0.34;
  const aLen = Math.min(3.4, d * 0.22);
  const gap = d * 0.24;
  const pos = [];
  for (let i = 0; i < 3; i++) {
    const zBack = gap - i * gap;
    pos.push(0, y, zBack - aLen, hw, y, zBack, -hw, y, zBack); // tip, right, left
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  return new THREE.Mesh(
    geo,
    mat(color, { roughness: 0.3, emissive: color, emissiveIntensity: 5, side: THREE.DoubleSide }),
  );
}

/**
 * TRUE flat decal: no slab at all — just the emissive chevrons plus a faint
 * translucent tint rectangle, hugging the deck like paint. Same trigger-field
 * effects as the pad props; use this version when the raised pad base would
 * read as an obstacle (banked decks, tube floors, narrow roads).
 */
function flatDecalGroup(w, d, color, name = "Decal") {
  const g = new THREE.Group();
  g.name = name;
  const tint = new THREE.Mesh(
    new THREE.PlaneGeometry(w, d),
    mat(0x0d1116, { roughness: 0.55, opacity: 0.45, side: THREE.DoubleSide }),
  );
  tint.rotation.x = -Math.PI / 2;
  tint.position.y = 0.03;
  g.add(tint, chevronRunMesh(w, d, color));
  return g;
}

/**
 * Circular launch decal: concentric emissive rings painted flat on the deck
 * (reads as a vertical-launch target rather than a directional strip).
 */
function launchDecalGroup(radius = 5.5, color = 0xffae33) {
  const g = new THREE.Group();
  g.name = "LaunchDecal";
  const tint = new THREE.Mesh(
    new THREE.CircleGeometry(radius, 40),
    mat(0x0d1116, { roughness: 0.55, opacity: 0.45, side: THREE.DoubleSide }),
  );
  tint.rotation.x = -Math.PI / 2;
  tint.position.y = 0.03;
  g.add(tint);
  for (const [rFrac, i] of [[0.92, 4], [0.6, 3.2], [0.28, 2.4]]) {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(radius * rFrac - 0.35, radius * rFrac, 40),
      mat(color, { roughness: 0.3, emissive: color, emissiveIntensity: i, side: THREE.DoubleSide }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.06;
    g.add(ring);
  }
  return g;
}

/**
 * Tube booster decal: a ring of emissive chevrons wrapped around the INSIDE of
 * a cylinder, all pointing along −Z — the boost-pad look bent into a hoop, for
 * mounting inside tube pieces (or the rotating tube). Authored with its axis at
 * the group ORIGIN and the group lifted by the tube radius, so surface-snapping
 * onto a tube floor puts the band dead on the tube's axis.
 */
function boostTubeGroup(r = 7.3, len = 5.2, color = 0x18ffd0) {
  const g = new THREE.Group();
  g.name = "BoostTube";

  // Faint translucent sleeve so the band reads as one object.
  const sleeve = new THREE.Mesh(
    new THREE.CylinderGeometry(r + 0.15, r + 0.15, len, 48, 1, true),
    mat(0x0d1116, { roughness: 0.55, opacity: 0.35, side: THREE.DoubleSide }),
  );
  sleeve.rotation.x = Math.PI / 2; // axis along Z
  g.add(sleeve);

  // Bright hoops at both mouths.
  for (const z of [-len / 2, len / 2]) {
    const hoop = new THREE.Mesh(
      new THREE.TorusGeometry(r + 0.2, 0.14, 12, 48), // torus already lies in XY → axis = Z
      mat(color, { roughness: 0.35, emissive: color, emissiveIntensity: 3.5 }),
    );
    hoop.position.z = z;
    g.add(hoop);
  }

  // Chevrons around the inner surface, tips toward −Z (the boost direction).
  const K = 10;
  const dphi = 2.2 / r; // ~2.2 m arc half-width per arm
  const zTip = -len * 0.32;
  const zBack = len * 0.32;
  const pos = [];
  for (let k = 0; k < K; k++) {
    const phi = (2 * Math.PI * k) / K;
    const p = (ph, z) => pos.push(Math.cos(ph) * r, Math.sin(ph) * r, z);
    p(phi, zTip); // tip
    p(phi + dphi, zBack); // arm
    p(phi - dphi, zBack); // arm
  }
  const chevGeo = new THREE.BufferGeometry();
  chevGeo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  chevGeo.computeVertexNormals();
  g.add(new THREE.Mesh(
    chevGeo,
    mat(color, { roughness: 0.3, emissive: color, emissiveIntensity: 5, side: THREE.DoubleSide }),
  ));

  g.position.y = r; // rest offset: snapping to a tube floor centres the band on the axis
  return g;
}

/** Functional boost ring: an emissive cyan torus gate that slingshots the car
 *  forward when driven through. Distinct cyan glow (vs the orange Glow ring). */
function boostRingGroup() {
  const m = new THREE.Mesh(
    new THREE.TorusGeometry(8.5, 0.9, 18, 56),
    mat(0x18ffd0, { roughness: 0.35, metalness: 0.1, emissive: 0x18ffd0, emissiveIntensity: 4.5 }),
  );
  m.geometry.translate(0, 10, 0); // lift so the hole clears the ground
  return m;
}

/* ----------------------------------------------------------------------- */
/* Prop catalog                                                             */
/* ----------------------------------------------------------------------- */

/** Shared look for the emissive "Glow box" prop. Edited live via the inspector;
 *  high emissiveIntensity (>1) so it blooms against any sky (folio-2025 style). */
export const glowPropParams = { color: "#ff5a1e", intensity: 6 };

/**
 * Where a placed prop's feet land.
 *
 * Props used to keep whatever y `make()` authored, so anything dropped near an
 * elevated road piece just hung in the air at its rest height. Both surfaces are
 * already available to the game (the deck BVH for road, `app.getWorldHeight` for
 * terrain) — this just asks for one.
 *
 * THREE modes, not two, and the third is the one that matters:
 *   • auto   — road if there is any under the point, else terrain. Right ~90% of
 *              the time, so it is the default.
 *   • ground — terrain ONLY. The escape hatch: placing a prop on the ground
 *              UNDERNEATH an elevated road is exactly the parkour case, and auto
 *              would snap it up onto the deck above. Unfixable without this.
 *   • road   — deck ONLY. Nothing placed if there is no road under the point.
 *   • free   — no snapping; drag the Y axis by hand.
 *
 * In every snapped mode Y is DRIVEN by the surface, so dragging the gizmo's Y
 * axis does nothing — that is what `free` is for. A predictable rule beats a
 * clever one that sometimes lets you nudge height and sometimes doesn't.
 */
export const SURFACE_SNAP = { mode: "auto" };
export const SURFACE_SNAP_MODES = ["auto", "ground", "road", "free"];

/**
 * Write a material's emissive into the bloom buffer.
 *
 * Built from `materialEmissive`, a LIVE node, so later changes to `.emissive` /
 * `.emissiveIntensity` (see applyGlowParams) update the glow with no mrtNode
 * rebuild.
 *
 * Goes through v3's BloomMRTNode (applyBloomMRT), NOT stock mrt(): these
 * materials are also rendered into a plain offscreen RenderTarget by
 * bakeRoadThumbnails() for the palette tiles, and on three r184 a stock mrtNode
 * there emits a zero-member WGSL output struct and kills the renderer.
 */
function applyPropBloom(material) {
  applyBloomMRT(material, materialEmissive);
  material.userData.bloom = true;
  return material;
}

/**
 * Standard prop material.
 *
 * NODE material, not MeshStandardMaterial — v3's bloom is SELECTIVE: only the
 * emissive MRT buffer blooms, and `mrtNode` is a NodeMaterial property. The lab
 * bloomed the whole scene's bright pixels, so `emissive` plus a high
 * `emissiveIntensity` glowed there for free; here that alone does nothing.
 *
 * `bloom` defaults on for emissiveIntensity > 1 — the props MEANT to glow
 * (chevrons 5, boost ring 4.5, glow box/ring 6) opt in, while incidental
 * emissive (a 0.4 metal sheen, the 0.5 pad slab) stays out of the bloom buffer.
 * Pass `bloom` explicitly to override either way.
 */
function mat(color, opts = {}) {
  const emissiveIntensity = opts.emissiveIntensity ?? 1;
  const m = new THREE.MeshStandardNodeMaterial({
    color: new THREE.Color(color),
    roughness: opts.roughness ?? 0.7,
    metalness: opts.metalness ?? 0.1,
    emissive: new THREE.Color(opts.emissive ?? 0x000000),
    emissiveIntensity,
    side: opts.side ?? THREE.FrontSide,
  });
  if (opts.opacity != null && opts.opacity < 1) {
    m.transparent = true;
    m.opacity = opts.opacity;
    m.depthWrite = false; // translucent decal tint — never occlude the deck
  }
  if (opts.map) m.map = opts.map;
  // KEEPS THE FOG LIVE. three's WebGPU backend only re-uploads a render object's
  // uniforms when its material carries a NODE property — scene-level uniforms
  // behind `scene.fogNode` are not tracked — so a plain-node material on a prop
  // that never moves would keep whatever fog it first rendered with forever,
  // while the track around it updates. Props are exactly that: static world
  // geometry. `materialColor` leaves `.color` (and `.map`, which it multiplies
  // in) authoritative, so this changes nothing about how the prop looks.
  m.colorNode = materialColor;
  if (opts.bloom ?? emissiveIntensity > 1) applyPropBloom(m);
  return m;
}

/**
 * The swing gate's red panel with its white hazard band, as a 1-D texture.
 *
 * Built once and shared by every gate ever placed: it is 4×64 pixels, so the
 * cost of caching it is nil next to handing each gate its own. `v` runs up the
 * panel on a BoxGeometry's ±Z faces, which is exactly the axis the band needs.
 */
let _gateStripeTex = null;
function gateStripeTexture() {
  if (_gateStripeTex) return _gateStripeTex;
  const H = 64;
  const band = Math.round((0.26 / GATE_HEIGHT) * H); // same 0.26 m band as before
  const data = new Uint8Array(H * 4);
  for (let i = 0; i < H; i++) {
    // v=0 is the BOTTOM of the face, so the band lands mid-panel either way.
    const inBand = Math.abs(i - H / 2) < band / 2;
    const c = inBand ? [244, 244, 244] : [226, 59, 46];
    data[i * 4] = c[0]; data[i * 4 + 1] = c[1]; data[i * 4 + 2] = c[2]; data[i * 4 + 3] = 255;
  }
  // 1 px wide: the band only varies vertically, and the GPU samples a 1×64 the
  // same as a 4×64 for a third of the memory.
  _gateStripeTex = new THREE.DataTexture(data, 1, H);
  _gateStripeTex.colorSpace = THREE.SRGBColorSpace;
  _gateStripeTex.wrapS = _gateStripeTex.wrapT = THREE.ClampToEdgeWrapping;
  _gateStripeTex.needsUpdate = true;
  return _gateStripeTex;
}

/**
 * Diagonal-free hazard banding for the pole — yellow/black rings up its length.
 *
 * Same shared-and-painted approach as the gate stripe: stacking real ring meshes
 * would be a draw call each AND put every ring's cap coplanar with the shaft.
 */
let _poleBandTex = null;
function poleBandTexture() {
  const H = 128;
  if (_poleBandTex) return _poleBandTex;
  const data = new Uint8Array(H * 4);
  for (let i = 0; i < H; i++) {
    const dark = Math.floor(i / 8) % 2 === 0;
    const c = dark ? [26, 26, 28] : [232, 176, 32];
    data[i * 4] = c[0]; data[i * 4 + 1] = c[1]; data[i * 4 + 2] = c[2]; data[i * 4 + 3] = 255;
  }
  _poleBandTex = new THREE.DataTexture(data, 1, H);
  _poleBandTex.colorSpace = THREE.SRGBColorSpace;
  _poleBandTex.wrapS = _poleBandTex.wrapT = THREE.ClampToEdgeWrapping;
  _poleBandTex.needsUpdate = true;
  return _poleBandTex;
}

/**
 * @typedef {object} PropDef
 * @property {string} id
 * @property {string} label
 * @property {string} collision  Role in the TRIANGLE bake: none|deck|solid|both.
 *   Capsule colliders are a SEPARATE channel and are collected regardless — see
 *   PropManager.collisionCapsules() — so a prop can be `none` here and still
 *   block the car. Scenery is the case that needs it: its meshes are decor and
 *   only its masts and legs are solid.
 * @property {string} [category] Palette tab. Defaults to "obstacles".
 * @property {() => THREE.Object3D} make
 */
/** @type {PropDef[]} */
export const PROP_CATALOG = [
  // ── PHYSICS PROPS ───────────────────────────────────────────────────────────
  // `collision: "none"` is deliberate: these are simulated by PropPhysics and
  // must NOT go into the static collision bake. Baking them would weld a cone to
  // the track — the car would hit an immovable invisible wall where the cone was
  // authored, and the visible cone would fly off on its own.
  {
    id: "cone",
    label: "Traffic cone",
    collision: "none",
    make: () => {
      const g = new THREE.Group();
      g.name = "Cone";
      // A real traffic cone is NOT a pointed cone: it is a truncated taper with
      // a FLAT TOP, standing on a square flanged base, with two retroreflective
      // collars. The pointed-ConeGeometry version read as a party hat.
      //
      // Built as a LATHE so the silhouette curves slightly inward like moulded
      // PVC instead of being a dead-straight ramp, and so the base flange and
      // body are one continuous surface rather than two parts intersecting.
      //
      // Authored as a MOTORWAY cone (~0.93 m) rather than a footpath one:
      // against a 4.85 m car anything shorter reads as a toy. CONE_SCALE then
      // multiplies the whole silhouette — shared with the collision proxy in
      // modularRoadPropPhysics.js so the two cannot drift.
      const S = CONE_SCALE;
      const H = 0.93 * S;
      const profile = [
        new THREE.Vector2(0.278, 0.0),    // flange edge
        new THREE.Vector2(0.263, 0.033),
        new THREE.Vector2(0.198, 0.045),  // flange tucks in
        new THREE.Vector2(0.177, 0.083),
        new THREE.Vector2(0.150, 0.21),   // slight concave sweep up the body
        new THREE.Vector2(0.119, 0.42),
        new THREE.Vector2(0.083, 0.66),
        new THREE.Vector2(0.057, 0.84),
        new THREE.Vector2(0.051, 0.93),   // FLAT top, not a point
        new THREE.Vector2(0.0, 0.93),
      ].map((v) => v.multiplyScalar(S));
      const body = new THREE.Mesh(
        new THREE.LatheGeometry(profile, 20),
        mat(0xf4581a, { roughness: 0.55, metalness: 0.0 }),
      );
      // Two collars, the upper one narrower — they follow the taper, so each
      // needs its own radii or they float off the surface.
      const collar = (yBottom, h, rB, rT) => {
        const m = new THREE.Mesh(
          new THREE.CylinderGeometry(rT, rB, h, 20, 1, true),
          mat(0xeef0f2, { roughness: 0.35, metalness: 0.15 }),
        );
        m.position.y = yBottom + h / 2;
        return m;
      };
      const square = new THREE.Mesh(
        new THREE.BoxGeometry(0.55 * S, 0.042 * S, 0.55 * S),
        mat(0x141417, { roughness: 0.9 }),
      );
      square.position.y = 0.021 * S;
      g.add(
        square, body,
        collar(0.45 * S, 0.17 * S, 0.113 * S, 0.097 * S),
        collar(0.70 * S, 0.105 * S, 0.076 * S, 0.067 * S),
      );

      // ── SIT ON THE GROUND, AND ROTATE ABOUT THE MIDDLE ──────────────────────
      // Two constraints that pull opposite ways:
      //  • PropManager keeps the authored y on placement (it only sets x/z), so
      //    make() must leave the prop ground-flush.
      //  • The rigid body integrates about the ROOT, so the root has to be the
      //    cone's CENTRE — put it at the base and a knocked cone pivots on its
      //    tip like a spinning top.
      // Satisfy both: drop the geometry by the collision radius, then lift the
      // ROOT by the same amount. Base lands on y=0, root sits at the centre.
      // Taken from PHYSICS_PROP_TYPES so the two can never drift apart — the
      // earlier hardcoded copy is exactly how it ended up half-buried.
      const R = PHYSICS_PROP_TYPES.cone.radius;
      g.children.forEach((c) => { c.position.y -= R; });
      g.position.y = R;
      return g;
    },
  },
  {
    id: "flag",
    label: "Banner flag",
    collision: "none",
    // Just the POLE. The CLOTH is drawn by ModularRoadFlags as a single
    // instanced mesh across every flag on the track — see that file for why it
    // is a shader wave rather than the engine's Verlet cloth. The pole stays a
    // real prop mesh so the gizmo has something to grab and right-click picking
    // still works; an empty root would be unselectable.
    make: () => {
      const g = new THREE.Group();
      g.name = "BannerFlag";
      const pole = new THREE.Mesh(
        new THREE.CylinderGeometry(0.07, 0.09, 6, 10),
        mat(0xb9c0c8, { roughness: 0.35, metalness: 0.75 }),
      );
      pole.position.y = 3;
      const finial = new THREE.Mesh(
        new THREE.SphereGeometry(0.11, 10, 8),
        mat(0xd8dee6, { roughness: 0.25, metalness: 0.85 }),
      );
      finial.position.y = 6.05;
      const base = new THREE.Mesh(
        new THREE.CylinderGeometry(0.34, 0.42, 0.16, 12),
        mat(0x23262b, { roughness: 0.85 }),
      );
      base.position.y = 0.08;
      g.add(base, pole, finial);
      return g;
    },
  },
  {
    id: "gate",
    label: "Swing gate",
    /**
     * SPLIT COLLISION, unlike the cone above. The post is a fixed steel column
     * bolted to the deck and clipping through it read as a bug, so the gate opts
     * IN to the static solids bake — and the panel opts back out per-mesh
     * (`noCollide`), because a swinging panel baked into a static BVH is exactly
     * the invisible-wall failure the cone's comment describes.
     *
     * Safe only because the post is a cylinder ON the hinge axis: PropPhysics
     * rotates the whole prop root by the gate angle, so every other child moves
     * in world space, but a cylinder spun about its own axis has an unchanged
     * footprint and the baked snapshot stays correct.
     */
    collision: "solid",
    make: () => {
      const g = new THREE.Group();
      g.name = "Gate";
      // Hinge post at the LOCAL ORIGIN — the panel swings about it, so the prop's
      // placement point IS the hinge.
      // Panel size comes from GATE_*, shared with the hinge simulation in
      // modularRoadPropPhysics.js — the panel you SEE, the panel the car is
      // resisted by, and the collider wireframe all read the same numbers.
      const W = GATE_WIDTH;
      const H = GATE_HEIGHT;
      const Y = GATE_BASE_Y + H / 2; // panel centre; bottom sits at GATE_BASE_Y
      const post = new THREE.Mesh(
        new THREE.CylinderGeometry(GATE_POST_RADIUS, GATE_POST_RADIUS, GATE_POST_HEIGHT, 10),
        mat(0x9aa0a8, { roughness: 0.45, metalness: 0.6 }),
      );
      post.position.y = GATE_POST_HEIGHT / 2;
      // Collided as an exact capsule rather than as triangles — a 0.22 m post is
      // thinner than the chassis hull's sample spacing, so the sampled path
      // cannot see it reliably. See PropManager.collisionCapsules().
      post.userData.capsule = { radius: GATE_POST_RADIUS, height: GATE_POST_HEIGHT };
      // THE STRIPE IS PAINTED, NOT BUILT.
      //
      // It used to be a second box 2 cm proud of the panel and exactly as wide,
      // which put its ±X end caps EXACTLY coplanar with the panel's — guaranteed
      // z-fighting, and the 2 cm front offset is below depth-buffer resolution
      // once the gate is any distance away, so the whole band shimmered. Insetting
      // the box would only push the flicker further out, never remove it.
      //
      // A texture removes the second surface entirely, so there is nothing left to
      // fight, and it drops the gate from three meshes to two. The texture is
      // built once for the whole catalog, not per gate.
      const panel = new THREE.Mesh(
        new THREE.BoxGeometry(W, H, 0.09),
        mat(0xffffff, {
          roughness: 0.65, emissive: 0x3a0a06, emissiveIntensity: 0.4,
          map: gateStripeTexture(),
        }),
      );
      panel.position.set(W / 2, Y, 0); // extends along +X from the hinge
      // The moving half stays out of the static bake — see `collision` above.
      panel.userData.noCollide = true;
      g.add(post, panel);
      return g;
    },
  },
  {
    id: "pole",
    label: "Pole",
    /**
     * A round obstacle you have to steer around — and the first prop built on
     * the capsule collider from the outset rather than retrofitted onto it.
     *
     * `solid`, but every mesh here is either a capsule or excluded, so it
     * contributes ZERO triangles to the static bake. That is the point: a pole
     * is exactly the shape triangle sampling handles worst (see the sample-gap
     * note on CHASSIS_HULL.sampleSpacing), and exactly the shape an analytic
     * primitive handles perfectly.
     */
    collision: "solid",
    make: () => {
      const g = new THREE.Group();
      g.name = "Pole";
      const R = 0.36;   // fat enough to read as a hazard from a moving car
      const H = 7.0;
      const shaft = new THREE.Mesh(
        new THREE.CylinderGeometry(R, R, H, 14),
        mat(0xc8ccd2, { roughness: 0.4, metalness: 0.7 }),
      );
      shaft.position.y = H / 2;
      shaft.userData.capsule = { radius: R, height: H };
      // Hazard bands, painted rather than stacked as rings — same z-fighting
      // reasoning as the swing gate's stripe, and it keeps the pole at one draw.
      shaft.material.map = poleBandTexture();
      shaft.material.color.set(0xffffff);
      // A footing so it reads as bolted down rather than dropped in. Squat and
      // wide, so it never decides a contact the shaft should have owned — it is
      // excluded from collision entirely and the capsule covers the whole height.
      const base = new THREE.Mesh(
        new THREE.CylinderGeometry(R * 2.1, R * 2.4, 0.22, 14),
        mat(0x2a2d33, { roughness: 0.85 }),
      );
      base.position.y = 0.11;
      base.userData.noCollide = true;
      g.add(shaft, base);
      return g;
    },
  },
  {
    id: "box",
    label: "Box",
    collision: "both",
    make: () => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(8, 4, 8), mat(0x8a9099, { roughness: 0.85 }));
      m.geometry.translate(0, 2, 0); // sit on the ground
      return m;
    },
  },
  {
    id: "wall",
    label: "Wall",
    collision: "solid",
    make: () => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.8, 4, 22), mat(0x804040, { roughness: 0.75 }));
      m.geometry.translate(0, 2, 0); // rest on the ground
      return m;
    },
  },
  {
    id: "ramp",
    label: "Slope ramp",
    collision: "both",
    make: () => new THREE.Mesh(rampGeometry(18, 6, 14), mat(0xe8912d, { roughness: 0.8 })),
  },
  {
    id: "slopelab",
    label: "Slope lab",
    collision: "both",
    make: () => buildSlopeLabGroup(),
  },
  {
    id: "jumplab",
    label: "Jump lab",
    collision: "both",
    make: () => buildJumpLabGroup(),
  },
  {
    id: "glowbox",
    label: "Glow box",
    collision: "both",
    make: () => {
      const m = new THREE.Mesh(
        new THREE.BoxGeometry(6, 12, 3),
        mat(glowPropParams.color, {
          roughness: 0.5,
          emissive: glowPropParams.color,
          emissiveIntensity: glowPropParams.intensity,
        }),
      );
      m.geometry.translate(0, 6, 0); // rest on the ground
      m.userData.isGlow = true;
      return m;
    },
  },
  {
    id: "boostpad",
    label: "Boost pad",
    collision: "none", // flush decal — you drive through it; the field does the work
    make: () => flatPadGroup(BOOST_W, BOOST_D, 0x18ffd0, "BoostPad"),
    // Trigger zone (local box around `center`): while inside, accelerate along the
    // pad's forward (−Z). `apply` is the reusable effect hook (see applyFields).
    field: {
      center: [0, 1.5, 0],
      half: [BOOST_W / 2, 2.5, BOOST_D / 2],
      apply(vehicle, dt, fwd) {
        const body = vehicle.body;
        const target = 62; // ~223 km/h target speed along the pad
        const along = body.vel.dot(fwd);
        if (along < target) body.vel.addScaledVector(fwd, Math.min(150 * dt, target - along));
      },
    },
  },
  {
    id: "launchpad",
    label: "Launch pad",
    collision: "none",
    make: () => flatPadGroup(11, 12, 0xffae33, "LaunchPad"),
    // Flings the car UP (set, not add → one clean launch) with a forward arc.
    field: {
      center: [0, 1.5, 0],
      half: [5.5, 2.5, 6],
      apply(vehicle, dt, fwd) {
        const body = vehicle.body;
        const up = 18; // launch speed (≈16 m of air)
        if (body.vel.y < up) body.vel.y = up;
        const fwdTarget = 22; // a little forward so it arcs, not straight up
        const along = body.vel.dot(fwd);
        if (along < fwdTarget) body.vel.addScaledVector(fwd, Math.min(90 * dt, fwdTarget - along));
      },
    },
  },
  {
    id: "boostring",
    label: "Boost ring",
    collision: "none",
    make: () => boostRingGroup(),
    // Slingshot forward when flying through the hole (trigger sits at the lifted
    // ring centre, a thin slab along the ring's axis).
    field: {
      // Tall, thin slab spanning the ring's vertical plane (ground → hole), so it
      // fires whether you drive through the arch or fly through the hole mid-jump.
      center: [0, 7, 0],
      half: [8, 9, 3.5],
      apply(vehicle, dt, fwd) {
        const body = vehicle.body;
        const target = 70; // strong punch through the gate
        const along = body.vel.dot(fwd);
        if (along < target) body.vel.addScaledVector(fwd, Math.min(700 * dt, target - along));
      },
    },
  },
  {
    id: "boostdecal",
    label: "Boost decal",
    collision: "none", // pure paint — chevrons + tint, zero slab
    make: () => flatDecalGroup(BOOST_W, BOOST_D, 0x18ffd0, "BoostDecal"),
    field: {
      center: [0, 1.5, 0],
      half: [BOOST_W / 2, 2.5, BOOST_D / 2],
      apply(vehicle, dt, fwd) {
        const body = vehicle.body;
        const target = 62; // same push as the boost pad — only the look differs
        const along = body.vel.dot(fwd);
        if (along < target) body.vel.addScaledVector(fwd, Math.min(150 * dt, target - along));
      },
    },
  },
  {
    id: "launchdecal",
    label: "Launch decal",
    collision: "none",
    make: () => launchDecalGroup(5.5, 0xffae33),
    field: {
      center: [0, 1.5, 0],
      half: [5.5, 2.5, 5.5],
      apply(vehicle, dt, fwd) {
        const body = vehicle.body;
        const up = 18; // same launch as the pad — set, not add → one clean pop
        if (body.vel.y < up) body.vel.y = up;
        const fwdTarget = 22;
        const along = body.vel.dot(fwd);
        if (along < fwdTarget) body.vel.addScaledVector(fwd, Math.min(90 * dt, fwdTarget - along));
      },
    },
  },
  {
    id: "boosttube",
    label: "Booster (tube)",
    collision: "none",
    make: () => boostTubeGroup(),
    // The band's axis sits at the group origin (make() lifts the root by the
    // tube radius), so the field is a fat slab across the whole cross-section:
    // boost fires wherever you are on the tube wall — floor, side, or ceiling.
    field: {
      center: [0, 0, 0],
      half: [7.6, 7.6, 3],
      apply(vehicle, dt, fwd) {
        const body = vehicle.body;
        const target = 68; // punchier than the flat pad — tubes eat speed
        const along = body.vel.dot(fwd);
        if (along < target) body.vel.addScaledVector(fwd, Math.min(400 * dt, target - along));
      },
    },
  },
  {
    id: "kickerramp",
    label: "Convex kicker",
    collision: "both",
    make: () =>
      new THREE.Mesh(
        kickerRampGeometry(14, 20, 7, 32),
        mat(0xc07840, { roughness: 0.82 }),
      ),
  },
  {
    id: "jumpkicker",
    label: "Jump ramp",
    collision: "both",
    make: () =>
      new THREE.Mesh(
        jumpRampGeometry(14, 22, 8, 32),
        mat(0x886838, { roughness: 0.82 }),
      ),
  },
  {
    id: "tube",
    label: "Open cylinder",
    collision: "deck",
    make: () => openTubeGroup(),
  },
  {
    id: "cylinder_full",
    label: "Solid cylinder",
    collision: "both",
    make: () => {
      const r = 0.55;
      const len = 8;
      const m = new THREE.Mesh(
        new THREE.CylinderGeometry(r, r, len, 20),
        mat(0x707880, { roughness: 0.88 }),
      );
      m.geometry.rotateZ(Math.PI / 2); // axis along X — log lying on the floor
      m.geometry.translate(0, r, 0);
      return m;
    },
  },
  {
    id: "ring",
    label: "Ring (gate)",
    collision: "none",
    make: () => {
      const m = new THREE.Mesh(
        new THREE.TorusGeometry(9, 1, 18, 56),
        mat(0xf1c40f, { metalness: 0.7, roughness: 0.3, emissive: 0x6b5300, emissiveIntensity: 0.4 }),
      );
      m.geometry.translate(0, 10, 0); // lift so the hole is off the ground
      return m;
    },
  },
  {
    id: "glowring",
    label: "Glow ring",
    collision: "none",
    make: () => {
      // Orange emissive gate ring — same live-tuned glow params as the Glow box.
      const m = new THREE.Mesh(
        new THREE.TorusGeometry(9, 1, 18, 56),
        mat(glowPropParams.color, {
          roughness: 0.45,
          metalness: 0.0,
          emissive: glowPropParams.color,
          emissiveIntensity: glowPropParams.intensity,
        }),
      );
      m.geometry.translate(0, 10, 0); // lift so the hole clears the ground
      m.userData.isGlow = true;
      return m;
    },
  },
  {
    id: "airtunnel",
    label: "Tunnel (air)",
    collision: "solid",
    make: () => new THREE.Mesh(airTunnelGeometry(36, 9), mat(0x5b6168, { roughness: 0.92, side: THREE.DoubleSide })),
  },

  // ── SCENERY ────────────────────────────────────────────────────────────────
  // Roadside dressing from the v2 objects lab, on its own palette tab because it
  // is not gameplay: obstacles are things you must avoid, these are things that
  // make the avoiding look like somewhere. See modularRoadScenery.js for how the
  // lab's spline objects become single placeable props (and for why their
  // materials have to be rebuilt before they go anywhere near v3's fog).
  //
  // `collision: "none"` refers to the TRIANGLE bake only — each of these carries
  // capsule colliders on its masts and legs, which is the channel that can
  // actually see something that thin.
  ...SCENERY_CATALOG.map((s) => ({
    id: s.id,
    label: s.label,
    collision: "none",
    category: "scenery",
    make: () => makeSceneryProp(s.id) ?? new THREE.Group(),
  })),
];

export const PROP_BY_ID = new Map(PROP_CATALOG.map((p) => [p.id, p]));

/* ----------------------------------------------------------------------- */
/* Manager                                                                  */
/* ----------------------------------------------------------------------- */

export class PropManager {
  /**
   * @param {object} o
   * @param {THREE.Scene} o.scene
   * @param {THREE.Camera} o.camera
   * @param {HTMLElement} o.domElement
   * @param {import("three/addons/controls/OrbitControls.js").OrbitControls} o.orbit
   * @param {() => void} [o.onChange] fired when props are added/removed/moved (collision is now stale)
   * @param {() => void} [o.onSelect] fired when a prop is selected (deselect other gizmos)
   * @param {(x:number,y:number,z:number,mode:string)=>number|null} [o.getSurfaceY]
   *        surface height under a point for the current snap mode — see
   *        SURFACE_SNAP. `y` is the prop's current height; the search runs
   *        downward from there.
   */
  constructor({
    scene, camera, domElement, orbit,
    onChange = null, onSelect = null, getSurfaceY = null,
  }) {
    this.getSurfaceY = getSurfaceY;
    this.scene = scene;
    this.camera = camera;
    this.domElement = domElement;
    this.orbit = orbit;
    this.onChange = onChange;
    this.onSelect = onSelect;
    this.enabled = false;

    /** @type {{id:string, def:object, root:THREE.Object3D, collision:string}[]} */
    this.instances = [];
    this.selected = null;

    this.group = new THREE.Group();
    this.group.name = "RoadProps";
    scene.add(this.group);

    this.raycaster = new THREE.Raycaster();
    this._ndc = new THREE.Vector2();

    this.gizmo = new TransformControls(camera, domElement);
    this.gizmo.setMode("translate");
    this.gizmo.setSpace("local");
    this.gizmo.enabled = false;
    this.gizmo.visible = false;
    this.gizmo.size = 0.9;
    scene.add(this.gizmo.getHelper());

    this.selBox = new THREE.BoxHelper(new THREE.Object3D(), 0xffe066);
    this.selBox.visible = false;
    scene.add(this.selBox);

    this.gizmo.addEventListener("dragging-changed", (e) => {
      if (this.orbit) this.orbit.enabled = !e.value && this.enabled;
    });
    this.gizmo.addEventListener("change", () => {
      if (!this.selected) return;
      // LIVE while dragging, so the prop visibly hugs the surface as it moves
      // rather than snapping only on release. Translate mode only — during a
      // rotate or scale the position is not what is changing, and re-snapping
      // there would fight a prop deliberately tilted onto banking.
      if (this.gizmo.mode === "translate") this.snapToSurface(this.selected);
      this.selBox.setFromObject(this.selected.root);
    });
    this.gizmo.addEventListener("mouseUp", () => this.onChange?.());

    domElement.addEventListener("pointerdown", (e) => {
      if (!this.enabled) return;
      if (e.button === 2) this._pickAt(e); // right-click select / deselect
    });

    // Gizmo hotkeys run in the capture phase so they take priority over the
    // builder's bubble-phase shortcuts (e.g. R = flip, Backspace = undo).
    window.addEventListener("keydown", (e) => this._onKey(e), true);
  }

  get hasSelection() {
    return !!this.selected;
  }

  /** True while the user is grabbing/hovering a gizmo handle (suppress placing). */
  isUsingGizmo() {
    return this.enabled && (this.gizmo.dragging || this.gizmo.axis != null);
  }

  setEnabled(on) {
    this.enabled = on;
    if (!on) this.deselect();
  }

  setMode(mode) {
    this.gizmo.setMode(mode);
  }

  /**
   * Push the shared glow params onto every placed glow prop (box + ring).
   *
   * No mrtNode rebuild needed: the bloom node is `materialEmissive`, which three
   * resolves as emissive × emissiveIntensity through live uniform accessors — so
   * writing these three properties updates the glow AND the bloom together.
   */
  applyGlowParams() {
    for (const inst of this.instances) {
      if (inst.id !== "glowbox" && inst.id !== "glowring") continue;
      inst.root.traverse((o) => {
        if (o.isMesh && o.material) {
          o.material.color.set(glowPropParams.color);
          o.material.emissive.set(glowPropParams.color);
          o.material.emissiveIntensity = glowPropParams.intensity;
        }
      });
    }
  }

  /**
   * Apply every placed "field" prop's effect to the car this frame (boost pads,
   * and future launch/slow/wind zones). Reusable trigger-zone test: transform the
   * car into each prop's local space, check its `field.half` box, and if inside
   * call `field.apply(vehicle, dt, padForward)`. Call once per drive-physics step.
   */
  applyFields(vehicle, dt) {
    if (!vehicle?.body) return;
    for (const inst of this.instances) {
      const f = inst.def.field;
      if (!f) continue;
      const root = inst.root;
      root.updateMatrixWorld();
      _fieldInv.copy(root.matrixWorld).invert();
      _fieldLocal.copy(vehicle.body.pos).applyMatrix4(_fieldInv); // car in pad space
      const [hx, hy, hz] = f.half;
      const cx = f.center?.[0] ?? 0;
      const cy = f.center?.[1] ?? 0;
      const cz = f.center?.[2] ?? 0;
      if (
        Math.abs(_fieldLocal.x - cx) <= hx &&
        Math.abs(_fieldLocal.y - cy) <= hy &&
        Math.abs(_fieldLocal.z - cz) <= hz
      ) {
        // Pad forward = local −Z in world, flattened horizontal.
        _fieldFwd.set(0, 0, -1).applyQuaternion(root.quaternion);
        _fieldFwd.y = 0;
        if (_fieldFwd.lengthSq() > 1e-6) {
          _fieldFwd.normalize();
          f.apply(vehicle, dt, _fieldFwd, root);
        }
      }
    }
  }

  /**
   * Spawn a prop and select it.
   *
   * @param {string} typeId
   * @param {THREE.Vector3|null} [worldPos] where to put it. This is the normal
   *        path — the palette arms a cursor BRUSH and the game passes the point
   *        under the mouse. Omitting it falls back to the camera's orbit target,
   *        which is what the API-only callers (and track import) use.
   */
  add(typeId, worldPos = null) {
    this.onSelect?.();
    const def = PROP_BY_ID.get(typeId);
    if (!def) return null;
    const root = def.make();
    enableMeshShadows(root);
    root.userData.isProp = true;
    // `restY` is the offset make() authored — 0 for ground-flush props, or a
    // deliberate lift like the pipe's radius. Captured BEFORE the spawn position
    // overwrites y, so snapping can add it back and keep the prop's feet on the
    // surface. (Read straight off root.position.y below, this silently became
    // the CAMERA's height the moment the spawn started setting y.)
    const restY = root.position.y;
    if (worldPos) {
      // Placed under the cursor: the caller already picked a real surface point,
      // so the snap below only has to re-add restY and resolve the mode.
      root.position.copy(worldPos);
    } else if (this.orbit?.target) {
      // Spawn where the camera is looking — INCLUDING its height.
      //
      // This used to take x/z only and leave y at `restY`, so the downward
      // surface search started ~2 m above the world floor. That is fine on a
      // ground-level track and wrong everywhere else: the game's default build
      // height is 40 m (DEFAULT_BUILD_HEIGHT), and a deck up there is ABOVE the
      // ray, so it can never be hit. MEASURED with a deck at y=40.5:
      //     auto/ground → y=0.5, the terrain 40 m BELOW the track
      //     road        → refused, prop left at y=0 with no feedback
      // i.e. in the mode the game boots in, every prop landed under the road.
      //
      // The old comment justified it as "don't yank it up to the camera's y,
      // which is what made props hover" — true BEFORE snapToSurface existed and
      // nothing pulled them back down. It now sets y = surface + restY, so
      // seeding from the camera lands the prop ON the deck rather than above it.
      // MoverPropManager.add() has always used the full target for this reason.
      root.position.copy(this.orbit.target);
    }
    this.group.add(root);
    const inst = { id: typeId, def, root, collision: def.collision, restY };
    root.userData.propInstance = inst;
    this.instances.push(inst);
    // A PROP YOU JUST ADDED MUST NEVER BE LEFT HANGING IN MID-AIR.
    //
    // Spawning at the camera's height (above) is what lets a prop land on the
    // elevated deck you are looking at — but it also means the spawn point is
    // EMPTY SPACE, so a snap that finds nothing leaves the prop floating there
    // rather than near the ground. "road" is the mode that can fail: it returns
    // null rather than falling back to terrain, deliberately, so that dragging a
    // prop off the road does not silently teleport it downhill. MEASURED with a
    // deck at y=40.5 and the camera on it but off to one side:
    //     road, no deck under the camera → prop left at y=39.2, in the sky
    // That refusal is right for a DRAG (there is a previous position worth
    // keeping) and wrong for a PLACEMENT (there is not).
    //
    // So placement falls back to `auto` — road if there is any, else terrain.
    // "free" is exempt: it means "do not move my prop", and spawning at the
    // camera is precisely what you want when you are about to place it by hand.
    if (!this.snapToSurface(inst) && SURFACE_SNAP.mode !== "free") {
      this.snapToSurface(inst, "auto");
    }
    this._select(inst);
    this.onChange?.();
    return inst;
  }

  duplicateSelected() {
    if (!this.selected) return;
    const src = this.selected;
    const root = src.def.make();
    enableMeshShadows(root);
    root.userData.isProp = true;
    root.position.copy(src.root.position).add(new V3(4, 0, 4));
    root.quaternion.copy(src.root.quaternion);
    root.scale.copy(src.root.scale);
    this.group.add(root);
    const inst = { id: src.id, def: src.def, root, collision: src.collision, restY: src.restY ?? 0 };
    root.userData.propInstance = inst;
    this.instances.push(inst);
    this.snapToSurface(inst); // the +4,+4 offset may have landed on a different surface
    this._select(inst);
    this.onChange?.();
  }

  deleteSelected() {
    if (!this.selected) return;
    this._removeInstance(this.selected);
    this.selected = null;
    this.gizmo.detach();
    this.gizmo.enabled = false;
    this.gizmo.visible = false;
    this.selBox.visible = false;
    this.onChange?.();
  }

  clear() {
    this.deselect();
    for (const inst of this.instances) this._disposeInstance(inst);
    this.instances = [];
    this.onChange?.();
  }

  deselect() {
    this.selected = null;
    this.gizmo.detach();
    this.gizmo.enabled = false;
    this.gizmo.visible = false;
    this.selBox.visible = false;
  }

  /**
   * Drop a prop onto the surface under it, preserving its authored rest offset.
   *
   * `restY` is whatever `make()` left on the root — for most props 0 (they are
   * authored ground-flush), for others a deliberate offset like the pipe's
   * radius or the cone's collision radius. Adding it back is what keeps a cone's
   * BASE on the road rather than burying it by a radius.
   *
   * @returns {boolean} true if it moved (i.e. a surface was found)
   */
  snapToSurface(inst, modeOverride = null) {
    if (!inst || !this.getSurfaceY) return false;
    const mode = modeOverride ?? SURFACE_SNAP.mode;
    if (mode === "free") return false;
    const p = inst.root.position;
    // The prop's CURRENT height is passed so the search looks DOWNWARD from
    // where it already is. That is what makes "auto" behave: a prop sitting on
    // the terrain under an elevated road finds the terrain, not the deck 20 m
    // above it — while dragging the same prop up onto the road finds the deck.
    const y = this.getSurfaceY(p.x, p.y, p.z, mode);
    if (y === null || y === undefined || !Number.isFinite(y)) return false;
    p.y = y + (inst.restY ?? 0);
    return true;
  }

  /** Re-snap every prop — after a track load, or a snap-mode change. */
  snapAll() {
    let n = 0;
    for (const inst of this.instances) if (this.snapToSurface(inst)) n++;
    if (n) this.onChange?.();
    return n;
  }

  /** Meshes split by collision role, for the page's BVH bake. */
  collisionMeshes() {
    const deck = [];
    const solids = [];
    for (const inst of this.instances) {
      if (inst.collision === "none") continue;
      inst.root.traverse((o) => {
        if (!o.isMesh) return;
        // PER-MESH OPT-OUT. A prop can be part static, part simulated — the swing
        // gate's POST never moves and must be solid, while its PANEL is driven by
        // PropPhysics and would be welded into the static bake as an invisible
        // wall across the doorway. The prop-level `collision` flag alone cannot
        // express that, so a mesh may exclude itself.
        //
        // `capsule` implies the same exclusion: that mesh is collided EXACTLY as
        // a primitive instead (see collisionCapsules), and having it in both
        // channels would resolve the same contact twice.
        if (o.userData.noCollide || o.userData.capsule) return;
        if (inst.collision === "deck" || inst.collision === "both") deck.push(o);
        if (inst.collision === "solid" || inst.collision === "both") solids.push(o);
      });
    }
    return { deck, solids };
  }

  /**
   * World-space capsule colliders, from meshes tagged
   * `userData.capsule = { radius, height }`.
   *
   * A ROUND POST IS NOT A TRIANGLE PROBLEM. The chassis is collided against
   * triangle geometry by SAMPLING its hull surface, and sample spacing is a
   * hard floor on how thin an obstacle can be and still register — a 0.22 m gate
   * post fell straight between the samples and the car drove through it
   * (measured in tools/postColliderRepro.mjs). Handing the vehicle the primitive
   * instead removes the floor entirely: it solves closest-point exactly, so the
   * post registers at every approach angle and speed.
   *
   * The capsule is taken along the mesh's own local +Y, so it follows any
   * rotation the prop was placed with.
   */
  collisionCapsules() {
    const out = [];
    for (const inst of this.instances) {
      inst.root.traverse((o) => {
        const c = o.userData.capsule;
        if (!c) return;
        o.updateWorldMatrix(true, false);
        const mid = new THREE.Vector3().setFromMatrixPosition(o.matrixWorld);
        // The mesh's local up, in world space — NOT (0,1,0), or a gate placed on
        // a banked piece would get an upright collider through a leaning post.
        const up = new THREE.Vector3(0, 1, 0)
          .transformDirection(o.matrixWorld).normalize();
        // Capsule ENDS are the sphere centres, so they sit a radius inside each
        // flat end of the cylinder the artist authored.
        const half = Math.max(0, c.height / 2 - c.radius);
        out.push({
          a: mid.clone().addScaledVector(up, -half),
          b: mid.clone().addScaledVector(up, half),
          radius: c.radius,
        });
      });
    }
    return out;
  }

  /** @returns {{type:string, position:number[], quaternion:number[], scale:number[]}[]} */
  exportInstances() {
    return this.instances.map((inst) => ({
      type: inst.id,
      position: inst.root.position.toArray(),
      quaternion: inst.root.quaternion.toArray(),
      scale: inst.root.scale.toArray(),
    }));
  }

  /** @param {{type:string, position:number[], quaternion:number[], scale:number[]}[]} list */
  importInstances(list) {
    this.deselect();
    for (const inst of this.instances) this._disposeInstance(inst);
    this.instances = [];
    if (!Array.isArray(list)) return;
    for (const item of list) {
      const def = PROP_BY_ID.get(item.type);
      if (!def || !Array.isArray(item.position)) continue;
      const root = def.make();
      enableMeshShadows(root);
      root.userData.isProp = true;
      // Read the authored rest offset BEFORE the saved position overwrites it.
      const restY = root.position.y;
      root.position.fromArray(item.position);
      if (Array.isArray(item.quaternion) && item.quaternion.length === 4) {
        root.quaternion.fromArray(item.quaternion);
      }
      if (Array.isArray(item.scale) && item.scale.length === 3) {
        root.scale.fromArray(item.scale);
      }
      this.group.add(root);
      const inst = { id: item.type, def, root, collision: def.collision, restY };
      root.userData.propInstance = inst;
      this.instances.push(inst);
    }
    this.onChange?.();
  }

  /* ----- internals ----- */

  _select(inst) {
    this.onSelect?.();
    this.selected = inst;
    this.gizmo.attach(inst.root);
    this.gizmo.enabled = true;
    this.gizmo.visible = true;
    this.selBox.setFromObject(inst.root);
    this.selBox.visible = true;
  }

  _pickAt(e) {
    const rect = this.domElement.getBoundingClientRect();
    this._ndc.set(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this._ndc, this.camera);
    const hits = this.raycaster.intersectObjects(this.group.children, true);
    if (hits.length) {
      let o = hits[0].object;
      while (o && !o.userData.propInstance) o = o.parent;
      if (o?.userData.propInstance) {
        this._select(o.userData.propInstance);
        return;
      }
    }
    this.deselect();
  }

  _onKey(e) {
    if (!this.enabled || !this.selected) return;
    if (e.target instanceof HTMLInputElement) return;
    let handled = true;
    switch (e.code) {
      case "KeyW": this.setMode("translate"); break;
      case "KeyE": this.setMode("rotate"); break;
      case "KeyR": this.setMode("scale"); break;
      case "KeyQ": this.gizmo.setSpace(this.gizmo.space === "local" ? "world" : "local"); break;
      case "Delete": case "Backspace": this.deleteSelected(); break;
      case "Escape": this.deselect(); break;
      case "KeyD": if (e.ctrlKey || e.metaKey) this.duplicateSelected(); else handled = false; break;
      default: handled = false;
    }
    if (handled) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }

  _removeInstance(inst) {
    const i = this.instances.indexOf(inst);
    if (i >= 0) this.instances.splice(i, 1);
    this._disposeInstance(inst);
  }

  _disposeInstance(inst) {
    this.group.remove(inst.root);
    inst.root.traverse((o) => {
      if (o.isMesh) o.geometry?.dispose?.();
    });
  }
}
