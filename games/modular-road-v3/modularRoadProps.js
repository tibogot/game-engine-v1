import * as THREE from "three";
// Collision radius is shared so the visual offset and the body can never drift.
import { PHYSICS_PROP_TYPES } from "./modularRoadPropPhysics.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { materialEmissive } from "three/tsl";
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
  if (opts.bloom ?? emissiveIntensity > 1) applyPropBloom(m);
  return m;
}

/** @type {{id:string,label:string,collision:string,make:()=>THREE.Object3D}[]} */
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
      // Sized like a MOTORWAY cone (~0.93 m) rather than a footpath one: against
      // a 4.85 m car anything shorter reads as a toy.
      const H = 0.93;
      const profile = [
        new THREE.Vector2(0.278, 0.0),    // flange edge
        new THREE.Vector2(0.263, 0.033),
        new THREE.Vector2(0.198, 0.045),  // flange tucks in
        new THREE.Vector2(0.177, 0.083),
        new THREE.Vector2(0.150, 0.21),   // slight concave sweep up the body
        new THREE.Vector2(0.119, 0.42),
        new THREE.Vector2(0.083, 0.66),
        new THREE.Vector2(0.057, 0.84),
        new THREE.Vector2(0.051, H),      // FLAT top, not a point
        new THREE.Vector2(0.0, H),
      ];
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
        new THREE.BoxGeometry(0.55, 0.042, 0.55),
        mat(0x141417, { roughness: 0.9 }),
      );
      square.position.y = 0.021;
      g.add(square, body, collar(0.45, 0.17, 0.113, 0.097), collar(0.70, 0.105, 0.076, 0.067));

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
    collision: "none",
    make: () => {
      const g = new THREE.Group();
      g.name = "Gate";
      // Hinge post at the LOCAL ORIGIN — the panel swings about it, so the prop's
      // placement point IS the hinge.
      const post = new THREE.Mesh(
        new THREE.CylinderGeometry(0.11, 0.11, 1.9, 10),
        mat(0x9aa0a8, { roughness: 0.45, metalness: 0.6 }),
      );
      post.position.y = 0.95;
      const panel = new THREE.Mesh(
        new THREE.BoxGeometry(2.2, 1.5, 0.09),
        mat(0xe23b2e, { roughness: 0.65, emissive: 0x3a0a06, emissiveIntensity: 0.4 }),
      );
      panel.position.set(1.1, 0.9, 0); // extends along +X from the hinge
      const stripe = new THREE.Mesh(
        new THREE.BoxGeometry(2.2, 0.26, 0.11),
        mat(0xf4f4f4, { roughness: 0.6 }),
      );
      stripe.position.set(1.1, 0.9, 0);
      g.add(post, panel, stripe);
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

  /** Spawn a prop near the orbit target (or origin) and select it. */
  add(typeId) {
    this.onSelect?.();
    const def = PROP_BY_ID.get(typeId);
    if (!def) return null;
    const root = def.make();
    enableMeshShadows(root);
    root.userData.isProp = true;
    if (this.orbit?.target) {
      // Spawn under wherever the camera is looking, but keep the prop's authored
      // rest height (make() leaves y = 0 for ground-flush props, or sets a resting
      // offset like the pipe's radius) — don't yank it up to the camera target's y,
      // which is what made props hover above the ground.
      root.position.x = this.orbit.target.x;
      root.position.z = this.orbit.target.z;
    }
    this.group.add(root);
    // `restY` is the offset make() authored — 0 for ground-flush props, or a
    // deliberate lift like the pipe's radius. Captured BEFORE any snapping, so
    // snapping can add it back and keep the prop's feet on the surface.
    const inst = { id: typeId, def, root, collision: def.collision, restY: root.position.y };
    root.userData.propInstance = inst;
    this.instances.push(inst);
    this.snapToSurface(inst);
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
  snapToSurface(inst) {
    if (!inst || !this.getSurfaceY) return false;
    const mode = SURFACE_SNAP.mode;
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
        if (inst.collision === "deck" || inst.collision === "both") deck.push(o);
        if (inst.collision === "solid" || inst.collision === "both") solids.push(o);
      });
    }
    return { deck, solids };
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
