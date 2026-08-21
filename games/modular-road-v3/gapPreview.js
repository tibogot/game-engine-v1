import * as THREE from "three";
import { color, uniform } from "three/tsl";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { applyBloomMRT } from "../../v3/render/bloomMRT.js";
import { solveGapArc } from "./gapArc.js";

/**
 * Trajectory preview for gap authoring — the core aid of the air-stunt builder.
 *
 * An arc from the open connector at a reference speed shows where a jump taken
 * at that pace lands; you then drop a landing chain on the marked point. The
 * maths, and what it does and does not model, lives in gapArc.js.
 *
 * This half is just the drawing: a red polyline for the arc and a green
 * ring-on-a-pole at the landing, both of them GLOWING. v3's bloom is SELECTIVE
 * — the post chain blooms the emissive MRT buffer and nothing else — so an
 * unlit build aid has to opt in through applyBloomMRT or it renders as a flat
 * matte line that the sky washes out at exactly the distances a big jump puts
 * the marker at.
 */

/**
 * Emissive boost into the bloom buffer. roadGame runs selective bloom at
 * threshold 0 / strength 0.9, so this is a straight glow multiplier — for scale,
 * the neon road tubes sit at 3.0 and the collectibles at 5.0.
 *
 * THE TWO ARE NOT ON THE SAME SCALE, and the gap is much wider than it looks: a
 * WebGPU line is always exactly one pixel wide (there is no linewidth), so the
 * arc feeds a fraction of the energy into the bloom pyramid that a solid mesh of
 * the same colour does, and has to be over-driven to read as equally bright. The
 * marker is a real mesh and needs the opposite treatment — at the arc's 9.0 it
 * blew out to a white blob that had lost both its green and its ring shape.
 * Checked on screen, not reasoned about.
 *
 * If you want a genuinely fat glowing ribbon rather than a hot hairline, that
 * needs Line2/LineSegments2, not a bigger number here.
 *
 * Live-tunable through GapPreview#setGlow() — these are uniforms, not baked
 * constants, so you can dial them from the console without a rebuild.
 */
const ARC_GLOW = 9.0;
const MARKER_GLOW = 2.5;
const ARC_COLOR = 0xff3b30;
const MARKER_COLOR = 0x35e07a;

export class GapPreview {
  /**
   * @param {object} opts
   * @param {THREE.Scene} opts.scene
   * @param {number} [opts.gravity]
   * @param {number} [opts.dragK] see solveGapArc. Live-tunable through the
   *        public `.dragK` field, because AERO.drag and CHASSIS.mass are both
   *        dev-panel sliders.
   * @param {Function} [opts.surfaceHit] see solveGapArc — what the arc can land
   *        ON, as opposed to the imaginary plane at launch height.
   * @param {number} [opts.maxPoints] arc vertex budget — at 1/30 s per segment,
   *        400 covers a 13 s flight, past the solver's own 12 s cap.
   */
  constructor({ scene, gravity = 9.81, dragK = 0, surfaceHit = null, maxPoints = 400 }) {
    this.gravity = gravity;
    this.dragK = dragK;
    /** @type {((from:THREE.Vector3,to:THREE.Vector3)=>({x,y,z}|null))|null}
     *  See solveGapArc. Without it a level open end draws an arc to nowhere. */
    this.surfaceHit = surfaceHit;
    this.maxPoints = maxPoints;
    this.landing = null; // { pos, vel, dist, time, onSurface } | null

    const geo = new THREE.BufferGeometry();
    this._positions = new Float32Array(maxPoints * 3);
    geo.setAttribute(
      "position",
      new THREE.BufferAttribute(this._positions, 3).setUsage(THREE.DynamicDrawUsage),
    );
    geo.setDrawRange(0, 0);
    this._arcGlow = uniform(ARC_GLOW);
    this._markerGlow = uniform(MARKER_GLOW);
    // NODE materials, not the stock ones: `mrtNode` is a NodeMaterial property,
    // so LineBasicMaterial/MeshBasicMaterial cannot write the emissive buffer at
    // all. `toneMapped: false` keeps the glow from being compressed back down
    // into the same grey as the rest of the frame — and the arc is drawn at FULL
    // opacity, because a 1px line already had little enough to give the bloom
    // without throwing away another 10% of it.
    const lineMat = new THREE.LineBasicNodeMaterial({
      color: ARC_COLOR, transparent: true, opacity: 1.0,
      depthWrite: false, toneMapped: false,
    });
    applyBloomMRT(lineMat, color(ARC_COLOR).mul(this._arcGlow));
    this.line = new THREE.Line(geo, lineMat);
    this.line.name = "GapArc";
    this.line.frustumCulled = false;
    this.line.renderOrder = 3;

    // Landing marker: a flat ring + a short pole so it reads against the sky.
    // One mesh: they share a material, so two objects were a free extra draw.
    const ringMat = new THREE.MeshBasicNodeMaterial({
      color: MARKER_COLOR, transparent: true, opacity: 0.9,
      depthWrite: false, toneMapped: false,
    });
    applyBloomMRT(ringMat, color(MARKER_COLOR).mul(this._markerGlow));
    const ringGeo = new THREE.TorusGeometry(2.6, 0.22, 8, 32);
    ringGeo.rotateX(Math.PI / 2);
    const poleGeo = new THREE.CylinderGeometry(0.12, 0.12, 4, 6);
    poleGeo.translate(0, 2, 0);
    const markerGeo = mergeGeometries([ringGeo, poleGeo], false);
    ringGeo.dispose();
    poleGeo.dispose();
    this.marker = new THREE.Mesh(markerGeo, ringMat);
    this.marker.name = "GapLanding";
    this.marker.visible = false;

    this.group = new THREE.Group();
    this.group.name = "GapPreview";
    this.group.add(this.line, this.marker);
    this.group.visible = false;
    scene.add(this.group);
  }

  setVisible(v) { this.group.visible = !!v; }

  /**
   * Dial the glow without a rebuild — both are uniforms.
   * @param {{arc?:number, marker?:number}} g
   */
  setGlow({ arc, marker } = {}) {
    if (arc != null) this._arcGlow.value = arc;
    if (marker != null) this._markerGlow.value = marker;
  }

  /**
   * Recompute the arc from the open connector.
   * @param {THREE.Matrix4} connector  open-end connector (Z col = −travel)
   * @param {number} refSpeed          launch speed (m/s)
   * @param {number} landingDrop       metres BELOW launch height to land (0 = level)
   * @returns {{pos:THREE.Vector3, vel:THREE.Vector3, dist:number, time:number} | null}
   */
  update(connector, refSpeed, landingDrop = 0) {
    const pos = this._positions;
    let n = 0;
    // NOTHING IS DRAWN FROM A NON-FINITE INPUT. The arc is a pure function of
    // the connector and the speed, so one NaN in either makes every one of the
    // 400 vertices NaN — and three then reports it once per frame from a place
    // that says nothing about where it came from:
    //
    //   "computeBoundingSphere(): Computed radius is NaN. The position
    //    attribute is likely to have NaN values."
    //
    // Both inputs come from outside: `connector` is the builder's open end,
    // which is derived from the last piece's exit matrix (and from the ORBIT
    // TARGET when a chain is reseeded at the cursor — that target tracks the car
    // in drive mode, so a NaN car poisons the builder too), and `refSpeed` is a
    // dev-panel number. Refusing here keeps a bad value a hidden aid instead of
    // a per-frame stack trace, and leaves the last good arc's data alone.
    if (!Number.isFinite(refSpeed) || !Number.isFinite(landingDrop)
        || !connector || connector.elements.some((v) => !Number.isFinite(v))) {
      this.line.geometry.setDrawRange(0, 0);
      this.landing = null;
      this.marker.visible = false;
      return null;
    }
    const landing = solveGapArc(connector, refSpeed, {
      gravity: this.gravity,
      dragK: this.dragK,
      landingDrop,
      surfaceHit: this.surfaceHit,
      sample: (x, y, z) => {
        if (n >= this.maxPoints) return false;
        pos[n * 3] = x; pos[n * 3 + 1] = y; pos[n * 3 + 2] = z;
        n++;
        return n < this.maxPoints;
      },
    });

    this.line.geometry.setDrawRange(0, n);
    this.line.geometry.attributes.position.needsUpdate = true;
    this.line.geometry.computeBoundingSphere();

    this.landing = landing;
    this.marker.visible = !!landing;
    if (landing) this.marker.position.copy(landing.pos);
    return landing;
  }

  dispose() {
    this.line.geometry.dispose();
    this.line.material.dispose();
    this.marker.traverse((o) => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
    this.group.parent?.remove(this.group);
  }
}
