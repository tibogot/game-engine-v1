import * as THREE from "three";
import { Fn, uniform, attribute, mix, texture, float } from "three/tsl";
// Marks are sized from the fitted wheel (see MARK_WIDTH_FRAC). No import cycle:
// the vehicle module knows nothing about tyre marks.
import { WHEEL } from "../../v3/play/modularRoadVehicle.js";

function lin(hex) {
  return new THREE.Color(hex);
}

/**
 * WHAT A TYRE LEAVES ON A WET ROAD IS A LIGHT LINE, NOT A DARK ONE.
 *
 * This was backwards, and it is the sort of thing that reads as "wrong" long
 * before anyone can say why. A tyre on standing water SQUEEGEES it: the contact
 * patch pushes the film aside and briefly exposes asphalt that is darker than
 * dry road but much lighter than the soaked, mirror-flat surface around it. So
 * a wet skid is a *clearing*. Drawing the dry road's near-black rubber ribbon
 * over a wet deck gets the sign of the effect exactly wrong.
 *
 * Both marks materials now take their colour from these rather than from the
 * texture, which costs nothing: the skid PNG is PURE BLACK with all of its
 * detail in the alpha channel, so its RGB never carried information — tinting
 * it could only ever produce black, which is why this could not be fixed by
 * setting `color`. Using the map for alpha alone and supplying the colour makes
 * the wet case expressible and leaves the dry case pixel-identical.
 */
const MARK_LOOK = {
  /** Dry: rubber laid on asphalt. The original flat-ribbon colour. */
  rubber: 0x010101,
  /** Wet: asphalt with the water pushed off it. Not dry-road bright — the road
   *  is still damp under the tyre, just no longer carrying a film. */
  cleared: 0x414852,
  /** How strongly a cleared line shows, relative to a rubber mark. Lower: a
   *  squeegeed strip is a subtle tonal break, not a black stripe. */
  clearedAlpha: 0.55,
};

/**
 * Rear-wheel skid ribbons for modular-road test drive.
 * Pattern follows v2 play-mode drift marks (ring buffer, vertex alpha) but is
 * standalone — no imports from v2 or Starter-Kit-Racing.
 */

const MAX_SEGMENTS = 4096;
const VERTS_PER_SEGMENT = 6;
const FLOATS_PER_SEGMENT = VERTS_PER_SEGMENT * 3;
const COLOR_FLOATS_PER_SEGMENT = VERTS_PER_SEGMENT * 4;
const UV_FLOATS_PER_SEGMENT = VERTS_PER_SEGMENT * 2;

/**
 * TEXTURED SKID MARKS — an alternative look, switchable at runtime against the
 * original flat ribbon (`setStyle`). Both styles share this one geometry and
 * ring buffer, so switching is just a material swap: nothing to rebuild, and
 * the flat ribbon stays available as a fallback.
 *
 * Kept as one class rather than two because the emit logic — drift detection,
 * contact points, ring buffer, fade — is identical for both. Only the material
 * differs. UVs are written unconditionally (+192 KB) so a switch needs no
 * regeneration.
 */
/** Look the marks ship with. "solid" is the flat-ribbon fallback. */
export const DEFAULT_MARK_STYLE = "textured";

export const SKID_TEXTURE_URL = "/textures/skid_mark01.png";

/** Metres of track per repeat of the texture along the mark. */
const TILE_LENGTH = 6.0;

/**
 * Contact-patch width as a fraction of the TYRE's width.
 *
 * Derived from `WHEEL.thickness` rather than hardcoded, so it follows whichever
 * wheel is fitted — the procedural wheel is 0.24 m but the Lotus GLB is 0.289 m,
 * and a fixed number would be wrong for one of them. `setWheelStyle` rewrites
 * WHEEL.thickness on the swap, so the marks re-width for free.
 *
 * Slightly under 1: a tyre's shoulders carry less load than the centre, so the
 * mark it leaves is a little narrower than the carcass.
 *
 * (Was a flat 0.09 HALF-width — a 0.18 m mark under a 0.24 m tyre, i.e. 75%.
 * Too narrow to read as a tyre print.)
 */
const MARK_WIDTH_FRAC = 0.92;
const MARK_Y_OFFSET = 0.045;
const MIN_SEGMENT_LENGTH = 0.035;
const INTENSITY_MIN = 0.15;
const INTENSITY_MAX = 0.9;
const INV_INTENSITY_RANGE = 1 / (INTENSITY_MAX - INTENSITY_MIN);

/** Minimum horizontal speed (m/s) before marks are emitted. */
const ENTRY_SPEED = 8;
const DRIFT_ANGLE_MIN = 0.1;
/** How strongly a tyre at its LONGITUDINAL limit marks the road, vs a sideways
 *  slide. Under 1 because a straight-line stop is a shorter, cleaner event than
 *  a drift and should read as a firm line, not a black smear. 0 disables it. */
const BRAKE_MARK = 0.75;

const _dir = new THREE.Vector3();
const _side = new THREE.Vector3();
const _pL = new THREE.Vector3();
const _pR = new THREE.Vector3();
const _cL = new THREE.Vector3();
const _cR = new THREE.Vector3();
const _chassisFwd = new THREE.Vector3();
const _velHoriz = new THREE.Vector3();
const _rearContact0 = new THREE.Vector3();
const _rearContact1 = new THREE.Vector3();
const _scratchVel = new THREE.Vector3();
const _wheelFwd = new THREE.Vector3();
const _wheelRight = new THREE.Vector3();

export class ModularRoadTireMarks {
  constructor(scene) {
    const positions = new Float32Array(MAX_SEGMENTS * FLOATS_PER_SEGMENT);
    const colors = new Float32Array(MAX_SEGMENTS * COLOR_FLOATS_PER_SEGMENT);
    for (let i = 0; i < MAX_SEGMENTS * VERTS_PER_SEGMENT; i++) {
      const o = i * 4;
      colors[o] = 1;
      colors[o + 1] = 1;
      colors[o + 2] = 1;
    }

    const geometry = new THREE.BufferGeometry();
    const posAttr = new THREE.BufferAttribute(positions, 3);
    posAttr.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("position", posAttr);

    const colorAttr = new THREE.BufferAttribute(colors, 4);
    colorAttr.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("color", colorAttr);

    // u runs ALONG the mark (distance / TILE_LENGTH), v ACROSS it (0..1).
    // Written for both styles so switching never has to regenerate anything.
    const uvs = new Float32Array(MAX_SEGMENTS * UV_FLOATS_PER_SEGMENT);
    const uvAttr = new THREE.BufferAttribute(uvs, 2);
    uvAttr.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("uv", uvAttr);

    geometry.setDrawRange(0, 0);

    /**
     * Shared by BOTH mark materials, so one call to `setWetness` moves the
     * solid ribbon and the textured one together and they can never disagree
     * about the weather.
     */
    this.markUniforms = {
      wetness: uniform(0),
      rubber: uniform(lin(MARK_LOOK.rubber)),
      cleared: uniform(lin(MARK_LOOK.cleared)),
      clearedAlpha: uniform(MARK_LOOK.clearedAlpha),
    };

    const material = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    });
    this._applyMarkNodes(material, null);

    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 20;
    this.mesh.visible = false;
    scene.add(this.mesh);

    this.positions = positions;
    this.colors = colors;
    this.uvs = uvs;
    this.geometry = geometry;
    this.segmentIndex = 0;
    this.drawCount = 0;
    // `dist` is metres laid down since this mark started — it drives u, so the
    // texture flows continuously along the streak instead of per-segment.
    this.states = [
      { prev: new THREE.Vector3(), active: false, dist: 0, prevAlpha: 0 },
      { prev: new THREE.Vector3(), active: false, dist: 0, prevAlpha: 0 },
    ];

    this.style = "solid";
    this._solidMaterial = material;
    this._texturedMaterial = null;
    this._skidTexture = null;
    // TEXTURED is the shipped look. Applied through setStyle rather than by
    // assigning `style` directly, because the textured material and its texture
    // are built lazily in there — and setStyle already falls back to solid if
    // the PNG fails to load, so this cannot leave the marks invisible.
    this.setStyle(DEFAULT_MARK_STYLE);
  }

  /**
   * Colour and opacity for a marks material, wet-aware.
   *
   * `vertexColors: true` is gone on purpose. The geometry's colour attribute is
   * vec4 with rgb pinned to 1 and the FADE carried in alpha — the rgb was never
   * doing anything — so reading `.a` explicitly says what is actually happening
   * and frees the colour to come from a uniform. The ring buffer, the fade and
   * every write into that attribute are untouched.
   *
   * @param {THREE.NodeMaterial} mat
   * @param {THREE.Texture|null} tex  skid map; only its ALPHA is used (the PNG
   *   is pure black, so its rgb never carried anything)
   */
  _applyMarkNodes(mat, tex) {
    const u = this.markUniforms;
    const vAlpha = attribute("color", "vec4").w;
    mat.colorNode = mix(u.rubber, u.cleared, u.wetness);
    const texA = tex ? texture(tex).a : null;
    mat.opacityNode = Fn(() => {
      const base = texA ? vAlpha.mul(texA) : vAlpha;
      // A squeegeed line is a subtler mark than laid rubber — see clearedAlpha.
      return base.mul(mix(float(1), u.clearedAlpha, u.wetness));
    })();
    // Same convention as the road material's `_roadUniforms`: the bag is
    // reachable from the material so a panel or a console can poke the look
    // without going through the owning class.
    mat._markUniforms = u;
    mat.needsUpdate = true;
  }

  /**
   * How wet the road is, 0..1 — drives marks from "rubber laid down" to "water
   * pushed aside". Called by the game whenever the weather moves; see the note
   * on MARK_LOOK for why the sign of this matters so much.
   */
  setWetness(v) {
    this.markUniforms.wetness.value = Math.max(0, Math.min(1, v || 0));
  }

  /**
   * Swap the look: "solid" (flat dark ribbon) or "textured" (skid_mark01.png).
   * Geometry is shared, so this is a material swap and nothing more — the solid
   * ribbon is always available as a fallback if the texture doesn't convince.
   */
  setStyle(style) {
    const want = style === "textured" ? "textured" : "solid";
    this.style = want;
    if (want === "solid") {
      this.mesh.material = this._solidMaterial;
      return want;
    }
    if (!this._texturedMaterial) {
      this._texturedMaterial = new THREE.MeshBasicNodeMaterial({
        // The PNG is pure black with all its detail in ALPHA, so it is used as
        // a MASK and the colour comes from the uniforms — which is what makes a
        // wet mark expressible at all. A tint could never lift pure black, so
        // the old `color: 0xffffff` × black map was locked to a dark ribbon
        // whatever the weather did.
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -4,
        polygonOffsetUnits: -4,
      });
      // Until the PNG arrives the mask is just the vertex fade, so the marks
      // are a plain ribbon for a frame or two rather than invisible.
      this._applyMarkNodes(this._texturedMaterial, null);
      new THREE.TextureLoader().load(
        SKID_TEXTURE_URL,
        (tex) => {
          // MIRRORED repeat along the mark, and this is the important bit:
          // measured, the texture does NOT tile — its left edge fades to alpha 0
          // but its right edge is still at 0.53, so plain RepeatWrapping shows a
          // hard seam every TILE_LENGTH. Mirroring makes each repeat a flip of
          // the last, so 0.53 always meets 0.53 and 0 meets 0 — continuous.
          tex.wrapS = THREE.MirroredRepeatWrapping;
          tex.wrapT = THREE.ClampToEdgeWrapping; // v is across the mark: never tile
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.anisotropy = 8; // marks are viewed at a very grazing angle
          this._skidTexture = tex;
          // Rebuild the graph now the mask exists. `map` is deliberately NOT
          // set: a NodeMaterial's colorNode replaces the whole diffuse path,
          // so a map assigned alongside it is simply never read — which would
          // look exactly like the texture failing to load.
          this._applyMarkNodes(this._texturedMaterial, tex);
        },
        undefined,
        (err) => {
          console.warn("[modular-road] skid texture failed, staying solid:", SKID_TEXTURE_URL, err);
          this.setStyle("solid");
        },
      );
    }
    this.mesh.material = this._texturedMaterial;
    return want;
  }

  reset() {
    this.segmentIndex = 0;
    this.drawCount = 0;
    this.geometry.setDrawRange(0, 0);
    this.mesh.visible = false;
    this.states[0].active = false;
    this.states[1].active = false;
    this.states[0].dist = 0;
    this.states[1].dist = 0;
  }

  /** @param {import("./modularRoadVehicle.js").Vehicle} vehicle */
  update(vehicle) {
    if (!vehicle?.enabled) {
      this._track(null, false, 0, this.states[0]);
      this._track(null, false, 0, this.states[1]);
      return;
    }

    const body = vehicle.body;
    _velHoriz.copy(body.vel);
    _velHoriz.y = 0;
    const speed = _velHoriz.length();

    _chassisFwd.set(0, 0, 1).applyQuaternion(body.quat);
    _chassisFwd.y = 0;
    if (_chassisFwd.lengthSq() > 1e-8) _chassisFwd.normalize();

    let driftAngle = 0;
    if (speed > 0.5 && _chassisFwd.lengthSq() > 1e-8) {
      driftAngle = Math.acos(
        THREE.MathUtils.clamp(_velHoriz.dot(_chassisFwd) / speed, -1, 1),
      );
    }

    const driftAmount = THREE.MathUtils.clamp(
      (driftAngle - DRIFT_ANGLE_MIN) / 0.5,
      0,
      1,
    );
    const handbrake = !!vehicle.input?.handbrake;
    const handbrakeAmount = handbrake
      ? THREE.MathUtils.smoothstep(speed, ENTRY_SPEED, ENTRY_SPEED * 2.2)
      : 0;

    let rearSlip = 0;
    let rearOver = 0;
    let rearIdx = 0;
    let p0 = null;
    let p1 = null;
    let g0 = false;
    let g1 = false;
    for (const tire of vehicle.tires) {
      if (tire.canSteer) continue;
      const contact = rearIdx === 0 ? _rearContact0 : _rearContact1;
      if (tire.grounded) {
        contact.copy(tire.hitPoint).addScaledVector(tire.hitNormal, MARK_Y_OFFSET);
        if (rearIdx === 0) {
          p0 = _rearContact0;
          g0 = true;
        } else {
          p1 = _rearContact1;
          g1 = true;
        }

        body.getVelocityAtPoint(tire.worldPos, _scratchVel);
        _wheelFwd.set(0, 0, 1).applyQuaternion(body.quat);
        _wheelRight.set(1, 0, 0).applyQuaternion(body.quat);
        const vLat = Math.abs(_scratchVel.dot(_wheelRight));
        const vLong = Math.abs(_scratchVel.dot(_wheelFwd));
        const vRef = Math.max(vLong, 3.5);
        rearSlip = Math.max(rearSlip, vLat / vRef);
        rearOver = Math.max(rearOver, tire.overDemand ?? 0);
      }
      rearIdx++;
    }

    const slipAmount = THREE.MathUtils.clamp(rearSlip * 0.85, 0, 1);
    // HARD BRAKING LAYS RUBBER TOO.
    //
    // Every term above measures LATERAL slip, so a straight-line stop — measured
    // at 1.71 g, 40 m/s to standstill in 44 m — produced exactly zero marks: the
    // car has no sideways velocity, so as far as this module was concerned
    // nothing was happening. `tire.overDemand` is how far past its grip the
    // tyre's longitudinal demand went, which is the same thing in the other axis.
    //
    // Speed-gated separately from `emit` so marks fade out as the car slows
    // instead of stopping dead at ENTRY_SPEED and leaving a blunt line end.
    const brakeAmount = BRAKE_MARK > 0
      ? THREE.MathUtils.clamp(rearOver * BRAKE_MARK, 0, 1)
        * THREE.MathUtils.smoothstep(speed, ENTRY_SPEED, ENTRY_SPEED * 2)
      : 0;
    const driftIntensity = Math.max(driftAmount, handbrakeAmount, slipAmount, brakeAmount);
    const inAir = vehicle.groundedCount === 0;
    const emit =
      !inAir &&
      speed > ENTRY_SPEED &&
      driftIntensity > INTENSITY_MIN;

    this._track(p0, emit && g0, driftIntensity, this.states[0]);
    this._track(p1, emit && g1, driftIntensity, this.states[1]);
  }

  _track(point, emit, intensity, state) {
    if (!point) {
      state.active = false;
      return;
    }
    // Restart the texture run whenever a new mark begins, so every streak opens
    // at u=0 (the texture's faded end) instead of mid-pattern.
    // Clearing `prevAlpha` too, or a new streak's first segment would ramp from
    // whatever the LAST one ended on and open with a bright leading edge.
    if (emit && !state.active) { state.dist = 0; state.prevAlpha = 0; }
    if (emit && state.active) this._addSegment(state.prev, point, intensity, state);
    state.prev.copy(point);
    state.active = emit;
  }

  _addSegment(prev, curr, intensity, state) {
    _dir.subVectors(curr, prev);
    _dir.y = 0;
    const len = _dir.length();
    if (len < MIN_SEGMENT_LENGTH) return;
    _dir.divideScalar(len);

    // Half-width, read from the fitted wheel each segment so a wheel-style swap
    // is picked up immediately (see MARK_WIDTH_FRAC).
    _side.set(_dir.z, 0, -_dir.x).multiplyScalar(WHEEL.thickness * MARK_WIDTH_FRAC * 0.5);
    _pL.copy(prev).add(_side);
    _pR.copy(prev).sub(_side);
    _cL.copy(curr).add(_side);
    _cR.copy(curr).sub(_side);

    const offset = this.segmentIndex * FLOATS_PER_SEGMENT;
    const p = this.positions;
    p[offset + 0] = _pL.x;
    p[offset + 1] = _pL.y;
    p[offset + 2] = _pL.z;
    p[offset + 3] = _pR.x;
    p[offset + 4] = _pR.y;
    p[offset + 5] = _pR.z;
    p[offset + 6] = _cL.x;
    p[offset + 7] = _cL.y;
    p[offset + 8] = _cL.z;
    p[offset + 9] = _pR.x;
    p[offset + 10] = _pR.y;
    p[offset + 11] = _pR.z;
    p[offset + 12] = _cR.x;
    p[offset + 13] = _cR.y;
    p[offset + 14] = _cR.z;
    p[offset + 15] = _cL.x;
    p[offset + 16] = _cL.y;
    p[offset + 17] = _cL.z;

    const alpha = THREE.MathUtils.clamp(
      (intensity - INTENSITY_MIN) * INV_INTENSITY_RANGE,
      0,
      1,
    );
    // ── ALPHA HAS TO RAMP ACROSS THE SEGMENT, NOT SIT FLAT ON IT ───────────
    //
    // One segment is one FRAME of travel, and `intensity` comes from tyre slip,
    // which jitters frame to frame. Writing this frame's alpha to all six
    // vertices made every segment a flat patch with a HARD STEP at each join —
    // a visible ladder of rectangles behind the wheels, and worse the faster you
    // go, because a segment at 34 m/s is 0.57 m long against 7 cm at walking
    // pace. It looked like a particle artefact and is nothing of the kind.
    //
    // Giving the two leading vertices the previous frame's value makes the
    // ramp continuous ACROSS joins, because a segment's trailing edge and the
    // next one's leading edge then carry the same number. Vertex order is
    // (pL, pR, cL, pR, cR, cL) — indices 0, 1, 3 are the previous edge.
    const prevAlpha = state.prevAlpha ?? alpha;
    const PREV_VERTS = [0, 1, 3];
    const colorOffset = this.segmentIndex * COLOR_FLOATS_PER_SEGMENT;
    for (let i = 0; i < VERTS_PER_SEGMENT; i++) {
      this.colors[colorOffset + i * 4 + 3] = PREV_VERTS.includes(i) ? prevAlpha : alpha;
    }
    state.prevAlpha = alpha;

    // UVs — u advances with real distance travelled so the texture flows along
    // the streak continuously rather than restarting per segment. Vertex order
    // is (pL, pR, cL, pR, cR, cL); v is 0 on the left edge, 1 on the right.
    const u0 = state.dist / TILE_LENGTH;
    state.dist += len;
    const u1 = state.dist / TILE_LENGTH;
    const uvOffset = this.segmentIndex * UV_FLOATS_PER_SEGMENT;
    const uv = this.uvs;
    uv[uvOffset + 0] = u0; uv[uvOffset + 1] = 0;  // pL
    uv[uvOffset + 2] = u0; uv[uvOffset + 3] = 1;  // pR
    uv[uvOffset + 4] = u1; uv[uvOffset + 5] = 0;  // cL
    uv[uvOffset + 6] = u0; uv[uvOffset + 7] = 1;  // pR
    uv[uvOffset + 8] = u1; uv[uvOffset + 9] = 1;  // cR
    uv[uvOffset + 10] = u1; uv[uvOffset + 11] = 0; // cL

    const posAttr = this.geometry.attributes.position;
    posAttr.addUpdateRange(offset, FLOATS_PER_SEGMENT);
    posAttr.needsUpdate = true;
    const colorAttr = this.geometry.attributes.color;
    colorAttr.addUpdateRange(colorOffset, COLOR_FLOATS_PER_SEGMENT);
    colorAttr.needsUpdate = true;
    const uvAttr = this.geometry.attributes.uv;
    uvAttr.addUpdateRange(uvOffset, UV_FLOATS_PER_SEGMENT);
    uvAttr.needsUpdate = true;

    this.segmentIndex = (this.segmentIndex + 1) % MAX_SEGMENTS;
    if (this.drawCount < MAX_SEGMENTS * VERTS_PER_SEGMENT) {
      this.drawCount += VERTS_PER_SEGMENT;
      this.geometry.setDrawRange(0, this.drawCount);
    }
    this.mesh.visible = this.drawCount > 0;
  }
}
