import * as THREE from "three";
import { MeshBasicNodeMaterial } from "three";
import {
  attribute,
  float,
  vec3,
  pow,
  sub,
  abs,
  smoothstep,
  mul,
  mix,
  add,
} from "three/tsl";
import {
  loadTreeGlbFromUrl,
  getSharedGltfLoader,
} from "../core/foliage/glbLoader.js";
import { setupPlayModeCarAudio } from "./carAudioSetup.js";
import {
  CarPhysics,
  DEFAULT_JEEP_TUNING,
  DEFAULT_LOTUS_CHASSIS,
  DEFAULT_LOTUS_COLLISION_HULL,
} from "./carPhysics.js";
import { LotusPhysics, DEFAULT_LOTUS_PHYSICS_PARAMS } from "./lotusPhysics.js";
import {
  RigidBody as VvvRigidBody,
  Tire as VvvTire,
  applyVvvStabilizer,
  applyVvvWallProbes,
  createDefaultVvvWheelLayout,
  createDefaultVvvWallProbes,
  deriveVvvTireFromVehicle,
  DEFAULT_VVV_CHASSIS,
  DEFAULT_VVV_WHEEL,
  DEFAULT_VVV_TIRE,
  DEFAULT_VVV_WALL,
  VVV_GRAVITY,
} from "./vvvCarPhysics.js";
import { Vehicle as ModularVehicle } from "./modularRoadVehicle.js";
import { createVehicleGround } from "./modularRoadGround.js";
import { RoadBvh } from "./modularRoadBvh.js";

// ============================================================
// === VVV CAR scratch (module-scope; reused across frames to avoid GC).
// ============================================================
const _vvvAxisX = new THREE.Vector3(1, 0, 0);
const _vvvAxisY = new THREE.Vector3(); // chassis-up in world (recomputed)
const _vvvAxisY_local = new THREE.Vector3(0, 1, 0);
const _vvvAxisY_world = new THREE.Vector3(0, 1, 0);
const _vvvFwdW = new THREE.Vector3();
const _vvvSteerQ = new THREE.Quaternion();
const _vvvSpinQ = new THREE.Quaternion();
const _vvvTireVel = new THREE.Vector3();
const _vvvOffset = new THREE.Vector3();
const _vvvArrowDir = new THREE.Vector3();

// === STUNT chase-camera scratch (faithful port of modular-road's updateChaseCamera).
const _stCamDesired = new THREE.Vector3();
const _stCamLook = new THREE.Vector3();
const _stCamV = new THREE.Vector3();
const _stCamFwd = new THREE.Vector3();
const _stCamTgtH = new THREE.Vector3();
const _stWorldUp = new THREE.Vector3(0, 1, 0);

const CAP_R = 0.4;
const CAP_H = 1.2;
const GRAVITY = 20.0;
const JUMP_VEL = 11.0;
const MOVE_SPEED = 12;
// Safety net for the new hole feature: if the player drops below this Y
// (e.g. fell into a terrain hole with no cave to catch them), the next update
// tick snaps them back to spawn. Lower than any plausible sculpted terrain
// (sculptClampMin defaults to ~-200) but higher than the hole sentinel (-1e7).
const KILLPLANE_Y = -500;

const CHAR_MODEL = "../models/UA1+UA2_compressed.glb";
const CHAR_KATANA = "../models/katana.glb";
const CHAR_HAT = "../models/asian_conical_hat_compressed.glb";
const CHAR_HEIGHT = 2.5;
const CHAR_WALK_SPEED = 4.0;
const CHAR_RUN_SPEED = 8.0;
const CHAR_JUMP_VEL = 11.0;
const CHAR_GRAVITY = 20.0;
const CHAR_ROLL_PEAK = 13.0;
const CHAR_GLIDE_FALL_SPEED = 3.0;
const CHAR_SLIDE_SPEED = 10.0;
const CHAR_SLIDE_MAX_TIME = 1.2;
const PI = Math.PI;

const PLANE_MAX_FWD = 56;
const PLANE_MAX_FWD_BOOST = 78;
const PLANE_SHIFT_ACCEL_MULT = 1.5;
const PLANE_MAX_REV = 18;
const PLANE_ACCEL = 10.5;
const PLANE_BRAKE = 26;
const PLANE_REV_ACCEL = 8;
const PLANE_COAST = 3.8;
const PLANE_DRAG = 0.014;
const PLANE_DECK_ALT = 1.15;
const PLANE_DECK_COAST_MULT = 2.1;
const CAM_DIST = 8;
const CAM_COLLISION_OFFSET = 0.3;
const CAM_COLLISION_EASE_OUT = 5;
const CAM_SENS_X = 0.002;
const CAM_SENS_Y = 0.002;
const ISO_PITCH = 1.0;
const ISO_DIST_DEFAULT = 26;
const ISO_DIST_MIN = 10;
const ISO_DIST_MAX = 70;
const ISO_YAW_ROT_SPEED = 1.6;
const ISO_MOVE_RING_Y_OFFSET = 0.08;
const ISO_HOVER_PICK_MIN_MS = 16;

const FLY_MOUSE_SENS_X = 0.0022;
const FLY_MOUSE_SENS_Y = 0.00235;
const FLY_PITCH_MIN = -1.22;
const FLY_PITCH_MAX = 0.9;
const FLY_PITCH_CLIMB_SCALE = 26;
const FLY_PITCH_DIVE_MULT = 1.82;
const FLY_ROLL_MAX = 0.78;
const FLY_ROLL_VEL_SCALE = 0.0042;
const FLY_ROLL_SMOOTH = 10;
const FLY_ROLL_TARGET_DECAY = 5;
const FLY_BARREL_DURATION = 0.88;
const FLY_SURFACE_ALT = 1.35;
const FLY_SURFACE_SPEED = 16;
const FLY_AILERON_RATE = 2.8;
const ISO_FLY_YAW_RATE = 1.9;
const ISO_FLY_CLIMB_RATE = 28;
const ISO_FLY_DESCEND_RATE = 48;
const ISO_FLY_CHASE_SMOOTH = 5.5;

// Drift car physics — arcade model
const CAR_MODEL = "../models/bruno.glb";
const LOTUS_MODEL = "../models/lotusclaude2.glb";
/** Lotus wheels for VVV mode (same asset as models/lotus-circuit-parkour.html). */
const VVV_WHEEL_GLB = "../models/lotusrealsize2.glb";
/** Per-side inset (m) from playMode `_loadLotus` track estimate — tyres tuck under body. */
const VVV_HUB_TRACK_INSET = 0.08;
/** VVV chase camera defaults (separate from Lotus `lotusCam`). */
const DEFAULT_VVV_CAM = {
  distance: 5,
  height: 0.7,
  lookAtY: 1.2,
  chaseSpeed: 7.5,
  driftLag: 1.8,
  fov: 75,
  speedPullBack: 1,
  chassisRollClamp: 0.2,
  chassisPitchClamp: 0.3,
};
const CAR_MODEL_YAW = Math.PI / 2;
const CAR_MODEL_SCALE = 1.9;
const CAR_ACCEL = 26;
const CAR_ACCEL_BOOST = 52;
const CAR_BRAKE = 35;
const CAR_REVERSE_ACCEL = 12;
const CAR_MAX_SPEED = 45;
const CAR_MAX_SPEED_BOOST = 72;
const CAR_MAX_REVERSE = 10;
const CAR_COAST = 1.35;
const CAR_DRAG = 0.0042;
const CAR_TURN_RATE = 1.0;
const CAR_TURN_RATE_DRIFT = 2.0;
const CAR_GRIP_NORMAL = 12;
const CAR_GRIP_DRIFT = 0.8;
const CAR_GRIP_BRAKE_TURN = 2.0;
const CAR_DRIFT_ENTRY_SPEED = 8;
const CAR_RIDE_HEIGHT = 0.48;
const CAR_WHEEL_RADIUS = 0.42;
const CAR_DRIFT_ANGLE_MIN = 0.1;
const CAR_CAM_DIST = 8.5;
const CAR_CAM_HEIGHT = 3.2;
const CAR_CAM_CHASE_SPEED = 3.5;
const CAR_CAM_DRIFT_LAG = 1.8;
const CAR_HANDBRAKE_DECEL = 3;
const CAR_HALF_WIDTH = 1.1;
const CAR_HALF_LENGTH = 2.5;
const CAR_BODY_HEIGHT = 0.8;
const CAR_GRAVITY = 28;
const CAR_EDGE_DROP_THRESHOLD = 0.25;
const CAR_MAX_SLOPE_COS = 0.5; // ~60° max climbable slope (cos(60°) ≈ 0.5)
const CAR_SLOPE_SAMPLE_EPS = 0.5;
const CAR_COLLISION_SKIN = 0.08;
const CAR_COLLISION_ITERS = 3;
const CAR_STEP_OVER_HEIGHT = 1.0;
const CAR_NITRO_KEY = "KeyN";
const CAR_NITRO_ACCEL_BONUS = 22;
const CAR_NITRO_MAX_SPEED_BONUS = 26;
const CAR_NITRO_DRAIN_PER_SEC = 0.32;
const CAR_NITRO_REGEN_PER_SEC = 0.14;
const CAR_NITRO_MIN_TO_USE = 0.05;
/** Center-bottom speed / drift / nitro panel — kept in DOM for future readouts; hidden by default. */
const SHOW_LEGACY_CAR_HUD_RECT = false;
/** Mechanical speedo: faster rise, slower fall (inertia). */
const CAR_HUD_SPEED_SMOOTH_UP = 15;
const CAR_HUD_SPEED_SMOOTH_DOWN = 6;
const CAR_HUD_NITRO_SMOOTH = 10;
/** Flight HUD readouts (separate from car nitro tank until plane boost is wired). */
const PLANE_HUD_SPEED_SMOOTH = 14;
const PLANE_HUD_ALT_SMOOTH = 10;
const PLANE_HUD_NITRO_SMOOTH = 10;
/** Thrust reserve shown in flight HUD; gameplay drain/regen hooks in later. */
const PLANE_NITRO_FULL = 1;
/** Ease Shift boost & nitro power in/out so speed cap / thrust don’t snap on key release. */
const CAR_BOOST_BLEND_SMOOTH = 12;
const CAR_NITRO_FX_BLEND_SMOOTH = 16;

function _expSmoothStep(current, target, dtSec, rate) {
  const a = 1 - Math.exp(-rate * dtSec);
  return current + (target - current) * a;
}

/** Degrees in (-180, 180] for HUD bank readout. */
function _bankDegFromRad(rad) {
  let d = (rad * 180) / Math.PI;
  d = ((((d + 180) % 360) + 360) % 360) - 180;
  return d;
}

const CAR_BASE_ACCEL_LOW_SPEED_MUL = 0.52;
const CAR_BASE_ACCEL_RAMP_TO_KMH = 100;
const CAR_BODY_ROLL_MAX = 0.2;
const CAR_BODY_PITCH_MAX = 0.25;
const CAR_BODY_TERRAIN_ROLL_MAX = 0.28;
const CAR_BODY_TERRAIN_PITCH_MAX = 0.32;
const CAR_BODY_SMOOTH = 5;
const CAR_TERRAIN_BODY_SMOOTH = 13;
const CAR_WHEEL_BASE = 1.9;
const CAR_TRACK = 1.1;
const CAR_SUSP_TRAVEL = 0.45;
const CAR_SUSP_SMOOTH = 18;

const DRIFT_MARK_MAX_SEGMENTS = 4096;
const DRIFT_MARK_VERTS_PER_SEGMENT = 6;
const DRIFT_MARK_FLOATS_PER_SEGMENT = DRIFT_MARK_VERTS_PER_SEGMENT * 3;
const DRIFT_MARK_COLOR_FLOATS_PER_SEGMENT = DRIFT_MARK_VERTS_PER_SEGMENT * 4;
const DRIFT_MARK_WIDTH = 0.09;
const DRIFT_MARK_Y_OFFSET = 0.045;
const DRIFT_MARK_MIN_SEGMENT_LENGTH = 0.035;
const DRIFT_MARK_INTENSITY_MIN = 0.15;
const DRIFT_MARK_INTENSITY_MAX = 0.9;
const DRIFT_MARK_INV_INTENSITY_RANGE =
  1 / (DRIFT_MARK_INTENSITY_MAX - DRIFT_MARK_INTENSITY_MIN);

const DRIFT_SMOKE_POOL_SIZE = 256;
const DRIFT_SMOKE_VERTS_PER_PARTICLE = 6;
const DRIFT_SMOKE_FLOATS_PER_PARTICLE = DRIFT_SMOKE_VERTS_PER_PARTICLE * 3;
const DRIFT_SMOKE_COLOR_FLOATS_PER_PARTICLE =
  DRIFT_SMOKE_VERTS_PER_PARTICLE * 4;
const DRIFT_SMOKE_UV_FLOATS_PER_PARTICLE = DRIFT_SMOKE_VERTS_PER_PARTICLE * 2;
const DRIFT_SMOKE_TEXTURE = "/textures/smoke.png";
const DRIFT_SMOKE_EMIT_RATE = 48;
const DRIFT_SMOKE_LIFE_MIN = 0.65;
const DRIFT_SMOKE_LIFE_MAX = 1.45;
const DRIFT_SMOKE_SIZE_MIN = 0.55;
const DRIFT_SMOKE_SIZE_MAX = 1.05;
const DRIFT_SMOKE_SIZE_GROWTH = 2.6;
const DRIFT_SMOKE_OPACITY = 0.55;
const DRIFT_SMOKE_RISE = 0.75;
const DRIFT_SMOKE_SPREAD = 0.55;
const DRIFT_SMOKE_SPEED_DRAG = 0.12;
const DRIFT_SMOKE_COLOR = new THREE.Color(0x6a6c76);
const DRIFT_SMOKE_INTENSITY_MIN = 0.04;

const TRAIL_SEG = 90;
const TRAIL_HALF_W = 0.038;
const TRAIL_MAX_DIST = 8.0;

const GUN_FIRE_RATE = 12;
const GUN_BULLET_SPEED = 240;
const GUN_BULLET_MAX_DIST = 600;
const GUN_BULLET_SIZE = 0.7;
const GUN_BULLET_POOL = 64;
const GUN_TRACER_COLOR = 0xfff0a0;

const PLANE_MODEL = "../models/wenning_carsten_gameart_plane_compressed.glb";

/* ── Shared TSL trail material ── */
function createTrailMaterial() {
  const mat = new MeshBasicNodeMaterial({
    side: THREE.DoubleSide,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const trUV = attribute("trailUV");
  const lenT = trUV.x;
  const lenFade = pow(sub(float(1.0), lenT), float(1.6));
  const edge = abs(sub(trUV.y, float(0.5))).mul(float(2));
  const edgeFade = sub(float(1.0), smoothstep(float(0.15), float(0.95), edge));
  const alpha = mul(lenFade, edgeFade, float(0.72));
  const coreColor = mix(vec3(1.0, 1.0, 1.0), vec3(0.65, 0.85, 1.0), lenT);
  const coreBright = sub(float(1.0), smoothstep(float(0.0), float(0.55), edge));
  mat.colorNode = add(coreColor, mul(vec3(0.3, 0.25, 0.2), coreBright));
  mat.opacityNode = alpha;
  return mat;
}

const _trDir = new THREE.Vector3();
const _trSide = new THREE.Vector3();
const _trUp = new THREE.Vector3(0, 1, 0);
const _trTipWorld = new THREE.Vector3();
const _dmDir = new THREE.Vector3();
const _dmSide = new THREE.Vector3();
const _dmPL = new THREE.Vector3();
const _dmPR = new THREE.Vector3();
const _dmCL = new THREE.Vector3();
const _dmCR = new THREE.Vector3();
const _smokeRight = new THREE.Vector3();
const _smokeUp = new THREE.Vector3();
const _smokeCorner = new THREE.Vector3();
const _smokeHalfRight = new THREE.Vector3();
const _smokeHalfUp = new THREE.Vector3();
const _smokeUvs = [0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 0, 1];

class DriftMarks {
  constructor(scene) {
    const positions = new Float32Array(
      DRIFT_MARK_MAX_SEGMENTS * DRIFT_MARK_FLOATS_PER_SEGMENT,
    );
    const colors = new Float32Array(
      DRIFT_MARK_MAX_SEGMENTS * DRIFT_MARK_COLOR_FLOATS_PER_SEGMENT,
    );
    for (
      let i = 0;
      i < DRIFT_MARK_MAX_SEGMENTS * DRIFT_MARK_VERTS_PER_SEGMENT;
      i++
    ) {
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
    geometry.setDrawRange(0, 0);

    const material = new THREE.MeshBasicMaterial({
      color: 0x111111,
      transparent: true,
      vertexColors: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    });

    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 20;
    this.mesh.visible = false;
    scene.add(this.mesh);

    this.positions = positions;
    this.colors = colors;
    this.geometry = geometry;
    this.segmentIndex = 0;
    this.drawCount = 0;
    this.states = [
      { prev: new THREE.Vector3(), active: false },
      { prev: new THREE.Vector3(), active: false },
    ];
  }

  reset() {
    this.segmentIndex = 0;
    this.drawCount = 0;
    this.geometry.setDrawRange(0, 0);
    this.mesh.visible = false;
    this.states[0].active = false;
    this.states[1].active = false;
  }

  update(rearPoints, emit, intensity, rearGrounded = null) {
    const e0 = emit && (!rearGrounded || rearGrounded[0]);
    const e1 = emit && (!rearGrounded || rearGrounded[1]);
    this._track(rearPoints[0], e0, intensity, this.states[0]);
    this._track(rearPoints[1], e1, intensity, this.states[1]);
  }

  _track(point, emit, intensity, state) {
    if (!point) {
      state.active = false;
      return;
    }
    if (emit && state.active) this._addSegment(state.prev, point, intensity);
    state.prev.copy(point);
    state.active = emit;
  }

  _addSegment(prev, curr, intensity) {
    _dmDir.subVectors(curr, prev);
    _dmDir.y = 0;
    const len = _dmDir.length();
    if (len < DRIFT_MARK_MIN_SEGMENT_LENGTH) return;
    _dmDir.divideScalar(len);

    _dmSide.set(_dmDir.z, 0, -_dmDir.x).multiplyScalar(DRIFT_MARK_WIDTH);
    _dmPL.copy(prev).add(_dmSide);
    _dmPR.copy(prev).sub(_dmSide);
    _dmCL.copy(curr).add(_dmSide);
    _dmCR.copy(curr).sub(_dmSide);

    const offset = this.segmentIndex * DRIFT_MARK_FLOATS_PER_SEGMENT;
    const p = this.positions;
    p[offset + 0] = _dmPL.x;
    p[offset + 1] = _dmPL.y;
    p[offset + 2] = _dmPL.z;
    p[offset + 3] = _dmPR.x;
    p[offset + 4] = _dmPR.y;
    p[offset + 5] = _dmPR.z;
    p[offset + 6] = _dmCL.x;
    p[offset + 7] = _dmCL.y;
    p[offset + 8] = _dmCL.z;
    p[offset + 9] = _dmPR.x;
    p[offset + 10] = _dmPR.y;
    p[offset + 11] = _dmPR.z;
    p[offset + 12] = _dmCR.x;
    p[offset + 13] = _dmCR.y;
    p[offset + 14] = _dmCR.z;
    p[offset + 15] = _dmCL.x;
    p[offset + 16] = _dmCL.y;
    p[offset + 17] = _dmCL.z;

    const alpha = THREE.MathUtils.clamp(
      (intensity - DRIFT_MARK_INTENSITY_MIN) * DRIFT_MARK_INV_INTENSITY_RANGE,
      0,
      1,
    );
    const colorOffset = this.segmentIndex * DRIFT_MARK_COLOR_FLOATS_PER_SEGMENT;
    for (let i = 0; i < DRIFT_MARK_VERTS_PER_SEGMENT; i++) {
      this.colors[colorOffset + i * 4 + 3] = alpha;
    }

    const posAttr = this.geometry.attributes.position;
    posAttr.addUpdateRange(offset, DRIFT_MARK_FLOATS_PER_SEGMENT);
    posAttr.needsUpdate = true;
    const colorAttr = this.geometry.attributes.color;
    colorAttr.addUpdateRange(colorOffset, DRIFT_MARK_COLOR_FLOATS_PER_SEGMENT);
    colorAttr.needsUpdate = true;

    this.segmentIndex = (this.segmentIndex + 1) % DRIFT_MARK_MAX_SEGMENTS;
    if (
      this.drawCount <
      DRIFT_MARK_MAX_SEGMENTS * DRIFT_MARK_VERTS_PER_SEGMENT
    ) {
      this.drawCount += DRIFT_MARK_VERTS_PER_SEGMENT;
      this.geometry.setDrawRange(0, this.drawCount);
    }
    this.mesh.visible = this.drawCount > 0;
  }
}

class DriftSmoke {
  constructor(scene, settings) {
    this.settings = settings || {};
    const positions = new Float32Array(
      DRIFT_SMOKE_POOL_SIZE * DRIFT_SMOKE_FLOATS_PER_PARTICLE,
    );
    const colors = new Float32Array(
      DRIFT_SMOKE_POOL_SIZE * DRIFT_SMOKE_COLOR_FLOATS_PER_PARTICLE,
    );
    const uvs = new Float32Array(
      DRIFT_SMOKE_POOL_SIZE * DRIFT_SMOKE_UV_FLOATS_PER_PARTICLE,
    );
    for (let i = 0; i < DRIFT_SMOKE_POOL_SIZE; i++) {
      uvs.set(_smokeUvs, i * DRIFT_SMOKE_UV_FLOATS_PER_PARTICLE);
    }

    const geometry = new THREE.BufferGeometry();
    const posAttr = new THREE.BufferAttribute(positions, 3);
    posAttr.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("position", posAttr);
    const colorAttr = new THREE.BufferAttribute(colors, 4);
    colorAttr.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("color", colorAttr);
    geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
    geometry.setDrawRange(0, 0);

    const map = new THREE.TextureLoader().load(
      DRIFT_SMOKE_TEXTURE,
      undefined,
      undefined,
      (err) =>
        console.warn(
          "[V2] Failed to load drift smoke texture:",
          DRIFT_SMOKE_TEXTURE,
          err,
        ),
    );
    map.colorSpace = THREE.SRGBColorSpace;
    const material = new THREE.MeshBasicMaterial({
      map,
      color: 0xffffff,
      transparent: true,
      vertexColors: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 22;
    this.mesh.visible = false;
    scene.add(this.mesh);

    this.positions = positions;
    this.colors = colors;
    this.geometry = geometry;
    this.material = material;
    this.map = map;
    this.particles = Array.from({ length: DRIFT_SMOKE_POOL_SIZE }, () => ({
      life: 0,
      maxLife: 1,
      position: new THREE.Vector3(),
      velocity: new THREE.Vector3(),
      size: 1,
      rotation: 0,
      spin: 0,
    }));
    this.emitIndex = 0;
    this.emitAccum = [0, 0];
  }

  reset() {
    for (const p of this.particles) p.life = 0;
    this.emitAccum[0] = 0;
    this.emitAccum[1] = 0;
    this.geometry.setDrawRange(0, 0);
    this.mesh.visible = false;
  }

  update(dt, rearPoints, emit, intensity, velocityX, velocityZ, camera) {
    const s = this.settings;
    if (s.enabled === false) emit = false;
    if (emit) {
      const emitRate =
        (s.emitRate ?? DRIFT_SMOKE_EMIT_RATE) *
        THREE.MathUtils.clamp(intensity, 0, 1);
      for (let i = 0; i < rearPoints.length; i++) {
        const point = rearPoints[i];
        if (!point) continue;
        this.emitAccum[i] += emitRate * dt;
        while (this.emitAccum[i] >= 1) {
          this.emitAt(point, intensity, velocityX, velocityZ);
          this.emitAccum[i] -= 1;
        }
      }
    } else {
      this.emitAccum[0] = 0;
      this.emitAccum[1] = 0;
    }

    camera.updateMatrixWorld();
    _smokeRight.set(1, 0, 0).applyQuaternion(camera.quaternion).normalize();
    _smokeUp.set(0, 1, 0).applyQuaternion(camera.quaternion).normalize();

    let alive = 0;
    for (const p of this.particles) {
      if (p.life <= 0) continue;
      p.life -= dt;
      if (p.life <= 0) continue;

      const age = 1 - p.life / p.maxLife;
      p.velocity.multiplyScalar(Math.max(0, 1 - dt * 0.85));
      p.position.addScaledVector(p.velocity, dt);
      p.rotation += p.spin * dt;

      const size =
        p.size * (1 + age * (s.sizeGrowth ?? DRIFT_SMOKE_SIZE_GROWTH));
      const alpha = (s.opacity ?? DRIFT_SMOKE_OPACITY) * (1 - age) * (1 - age);
      this._writeParticle(alive++, p.position, size, p.rotation, alpha);
    }

    const vertCount = alive * DRIFT_SMOKE_VERTS_PER_PARTICLE;
    this.geometry.setDrawRange(0, vertCount);
    this.mesh.visible = vertCount > 0;
    if (vertCount > 0) {
      const posAttr = this.geometry.attributes.position;
      posAttr.addUpdateRange(0, alive * DRIFT_SMOKE_FLOATS_PER_PARTICLE);
      posAttr.needsUpdate = true;
      const colorAttr = this.geometry.attributes.color;
      colorAttr.addUpdateRange(
        0,
        alive * DRIFT_SMOKE_COLOR_FLOATS_PER_PARTICLE,
      );
      colorAttr.needsUpdate = true;
    }
  }

  emitAt(point, intensity, velocityX, velocityZ) {
    const s = this.settings;
    const p = this.particles[this.emitIndex];
    this.emitIndex = (this.emitIndex + 1) % DRIFT_SMOKE_POOL_SIZE;

    const speed = Math.hypot(velocityX, velocityZ);
    const dirX = speed > 1e-4 ? velocityX / speed : 0;
    const dirZ = speed > 1e-4 ? velocityZ / speed : 0;
    const sideJitter = (Math.random() - 0.5) * (s.spread ?? DRIFT_SMOKE_SPREAD);
    p.position.set(
      point.x - dirX * (0.12 + Math.random() * 0.25) + sideJitter * dirZ,
      point.y + 0.02 + Math.random() * 0.1,
      point.z - dirZ * (0.12 + Math.random() * 0.25) - sideJitter * dirX,
    );
    p.velocity.set(
      -dirX * speed * (s.drag ?? DRIFT_SMOKE_SPEED_DRAG) +
        (Math.random() - 0.5) * 0.45,
      (s.rise ?? DRIFT_SMOKE_RISE) * (0.65 + Math.random() * 0.7),
      -dirZ * speed * (s.drag ?? DRIFT_SMOKE_SPEED_DRAG) +
        (Math.random() - 0.5) * 0.45,
    );
    const lifeMin = Math.max(0.05, s.lifeMin ?? DRIFT_SMOKE_LIFE_MIN);
    const lifeMax = Math.max(lifeMin, s.lifeMax ?? DRIFT_SMOKE_LIFE_MAX);
    p.maxLife = THREE.MathUtils.lerp(lifeMin, lifeMax, Math.random());
    p.life = p.maxLife;
    const sizeMin = Math.max(0.01, s.sizeMin ?? DRIFT_SMOKE_SIZE_MIN);
    const sizeMax = Math.max(sizeMin, s.sizeMax ?? DRIFT_SMOKE_SIZE_MAX);
    p.size =
      THREE.MathUtils.lerp(sizeMin, sizeMax, Math.random()) *
      THREE.MathUtils.lerp(0.75, 1.25, THREE.MathUtils.clamp(intensity, 0, 1));
    p.rotation = Math.random() * Math.PI * 2;
    p.spin = (Math.random() - 0.5) * 1.7;
  }

  _writeParticle(index, center, size, rotation, alpha) {
    const smokeColor = DRIFT_SMOKE_COLOR;
    if (this.settings.color) smokeColor.set(this.settings.color);
    const half = size * 0.5;
    const cosR = Math.cos(rotation);
    const sinR = Math.sin(rotation);
    const posOffset = index * DRIFT_SMOKE_FLOATS_PER_PARTICLE;
    const colorOffset = index * DRIFT_SMOKE_COLOR_FLOATS_PER_PARTICLE;
    const corners = [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ];
    for (let i = 0; i < DRIFT_SMOKE_VERTS_PER_PARTICLE; i++) {
      const x = corners[i][0];
      const y = corners[i][1];
      const rx = (x * cosR - y * sinR) * half;
      const ry = (x * sinR + y * cosR) * half;
      _smokeHalfRight.copy(_smokeRight).multiplyScalar(rx);
      _smokeHalfUp.copy(_smokeUp).multiplyScalar(ry);
      _smokeCorner.copy(center).add(_smokeHalfRight).add(_smokeHalfUp);

      const po = posOffset + i * 3;
      this.positions[po] = _smokeCorner.x;
      this.positions[po + 1] = _smokeCorner.y;
      this.positions[po + 2] = _smokeCorner.z;

      const co = colorOffset + i * 4;
      this.colors[co] = smokeColor.r;
      this.colors[co + 1] = smokeColor.g;
      this.colors[co + 2] = smokeColor.b;
      this.colors[co + 3] = alpha;
    }
  }
}

function createWingTrailMesh(scene, trailMat) {
  const vertCount = (TRAIL_SEG + 1) * 2;
  const positions = new Float32Array(vertCount * 3);
  const trailUVs = new Float32Array(vertCount * 2);
  const indices = [];
  for (let i = 0; i < TRAIL_SEG; i++) {
    const v = i * 2;
    indices.push(v, v + 1, v + 2, v + 1, v + 3, v + 2);
  }
  for (let i = 0; i <= TRAIL_SEG; i++) {
    const u = i / TRAIL_SEG;
    trailUVs[i * 2 * 2] = u;
    trailUVs[i * 2 * 2 + 1] = 0;
    trailUVs[(i * 2 + 1) * 2] = u;
    trailUVs[(i * 2 + 1) * 2 + 1] = 1;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("trailUV", new THREE.BufferAttribute(trailUVs, 2));
  geo.setIndex(indices);
  const mesh = new THREE.Mesh(geo, trailMat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 12;
  mesh.visible = false;
  scene.add(mesh);
  return { mesh, history: [] };
}

function sampleTrail(trail, planeInner, localOffset) {
  _trTipWorld.copy(localOffset);
  planeInner.localToWorld(_trTipWorld);
  const hist = trail.history;
  if (hist.length > 0) {
    const d = _trTipWorld.distanceTo(hist[0]);
    if (d < 0.002) return;
    if (d > TRAIL_MAX_DIST && hist.length > 1) hist.length = 0;
  }
  hist.unshift(_trTipWorld.clone());
  if (hist.length > TRAIL_SEG + 1) hist.length = TRAIL_SEG + 1;
}

function rebuildTrail(trail) {
  const pos = trail.mesh.geometry.attributes.position;
  const hist = trail.history;
  const n = Math.min(hist.length, TRAIL_SEG + 1);
  for (let i = 0; i < n; i++) {
    const p = hist[i];
    if (i < n - 1) _trDir.subVectors(hist[i], hist[i + 1]).normalize();
    else if (n > 1) _trDir.subVectors(hist[n - 2], hist[n - 1]).normalize();
    else _trDir.set(0, 0, 1);
    _trSide.crossVectors(_trDir, _trUp);
    if (_trSide.lengthSq() < 1e-6) _trSide.set(1, 0, 0);
    else _trSide.normalize();
    const t = i / TRAIL_SEG;
    const w = TRAIL_HALF_W * (1 - t * 0.4);
    const vi = i * 2;
    pos.setXYZ(
      vi,
      p.x - _trSide.x * w,
      p.y - _trSide.y * w,
      p.z - _trSide.z * w,
    );
    pos.setXYZ(
      vi + 1,
      p.x + _trSide.x * w,
      p.y + _trSide.y * w,
      p.z + _trSide.z * w,
    );
  }
  for (let i = n; i <= TRAIL_SEG; i++) {
    const vi = i * 2;
    const lp = n > 0 ? hist[n - 1] : { x: 0, y: 0, z: 0 };
    pos.setXYZ(vi, lp.x, lp.y, lp.z);
    pos.setXYZ(vi + 1, lp.x, lp.y, lp.z);
  }
  pos.needsUpdate = true;
}

/* ── Bullet pool helpers ── */
const _bFwd = new THREE.Vector3();
const _bMuz = new THREE.Vector3();
const _bToCam = new THREE.Vector3();
const _bRight = new THREE.Vector3();
const _camColTarget = new THREE.Vector3();
const _camColDir = new THREE.Vector3();
const _bPerp = new THREE.Vector3();
const _bMat4 = new THREE.Matrix4();
const _bStep = new THREE.Vector3();

function createBulletPool(scene) {
  const geo = new THREE.PlaneGeometry(0.18, 1.4);
  const mat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(GUN_TRACER_COLOR),
    transparent: true,
    opacity: 1,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  const group = new THREE.Group();
  group.frustumCulled = false;
  scene.add(group);
  const pool = [];
  for (let i = 0; i < GUN_BULLET_POOL; i++) {
    const m = new THREE.Mesh(geo, mat);
    m.frustumCulled = false;
    m.matrixAutoUpdate = false;
    m.visible = false;
    m.renderOrder = 11;
    group.add(m);
    pool.push({
      mesh: m,
      pos: new THREE.Vector3(),
      dir: new THREE.Vector3(),
      dist: 0,
      alive: false,
    });
  }
  return { group, pool, geo, mat };
}

function fireBullet(pool, origin, dir) {
  for (const b of pool) {
    if (!b.alive) {
      b.alive = true;
      b.pos.copy(origin);
      b.dir.copy(dir).normalize();
      b.dist = 0;
      b.mesh.visible = true;
      return;
    }
  }
}

function updateBullets(pool, camera, dtSec) {
  for (const b of pool) {
    if (!b.alive) continue;
    _bStep.copy(b.dir).multiplyScalar(GUN_BULLET_SPEED * dtSec);
    b.pos.add(_bStep);
    b.dist += GUN_BULLET_SPEED * dtSec;
    if (b.dist > GUN_BULLET_MAX_DIST) {
      b.alive = false;
      b.mesh.visible = false;
      continue;
    }
    _bToCam.subVectors(camera.position, b.pos);
    _bRight.crossVectors(b.dir, _bToCam);
    if (_bRight.lengthSq() < 1e-6) _bRight.set(1, 0, 0);
    else _bRight.normalize();
    _bPerp.crossVectors(_bRight, b.dir).normalize();
    const sz = GUN_BULLET_SIZE;
    _bRight.multiplyScalar(sz);
    const dScaled = _bStep.copy(b.dir).multiplyScalar(sz);
    _bPerp.multiplyScalar(sz);
    _bMat4.makeBasis(_bRight, dScaled, _bPerp);
    _bMat4.setPosition(b.pos);
    b.mesh.matrix.copy(_bMat4);
  }
}

function clearBullets(pool) {
  for (const b of pool) {
    b.alive = false;
    b.mesh.visible = false;
  }
}

const MODE_ORDER = [
  "capsule",
  "char",
  "fly",
  "car",
  "lotus",
  "vvv",
  "rts",
  "stunt",
];
const MODE_META = {
  capsule: { label: "Capsule", icon: "◉", digit: "1" },
  char: { label: "Character", icon: "🧝", digit: "2" },
  fly: { label: "Flight", icon: "✈", digit: "3" },
  car: { label: "Bruno", icon: "🚙", digit: "4" },
  lotus: { label: "Lotus", icon: "🏎", digit: "5" },
  vvv: { label: "VVV (rigid)", icon: "🚗", digit: "6" },
  rts: { label: "Director", icon: "🎬", digit: "7" },
  stunt: { label: "Stunt", icon: "🏁", digit: "8" },
};

export class PlayMode {
  constructor({
    scene,
    camera,
    renderer,
    controls,
    getWorldHeight,
    getTerrainHeight,
    worldHalf,
    cliffBvh,
    isBarrierBlocked,
    smokeSettings,
    carSettings,
    carAudioSettings,
    spawnSettings,
    cameraCollisionSettings,
    audioSystem,
    excludeFromReflection,
    onSpawnChanged,
    getStuntRoadMeshes,
    getStuntRoadSolidMeshes,
  }) {
    this._getStuntRoadMeshes = getStuntRoadMeshes || (() => []);
    this._getStuntRoadSolidMeshes = getStuntRoadSolidMeshes || (() => []);
    this._stuntRoadBvh = null;
    this._stuntRoadSolidsBvh = null;
    this.scene = scene;
    this.camera = camera;
    this.renderer = renderer;
    this.controls = controls;
    this.getWorldHeight = getWorldHeight;
    this.getTerrainHeight = getTerrainHeight || getWorldHeight;
    this.worldHalf = worldHalf;
    this.cliffBvh = cliffBvh || null;
    this.isBarrierBlocked = isBarrierBlocked || null;
    this.carSettings = carSettings || {};
    this.carAudioSettings = carAudioSettings || {};
    this._excludeFromReflection = excludeFromReflection || null;
    this.spawnSettings = spawnSettings || null;
    this._onSpawnChanged =
      typeof onSpawnChanged === "function" ? onSpawnChanged : null;
    this.cameraCollisionSettings = cameraCollisionSettings || null;
    /** @type {object | null} */
    this._audioSystem = audioSystem || null;
    /** @type {(() => void) | null} */
    this._disposeCarAudio = null;
    if (audioSystem) {
      this._disposeCarAudio = setupPlayModeCarAudio(this, audioSystem);
    }
    this._playerGroundY = 0;

    this.active = false;
    /** Set by DialogueRunner — blocks player locomotion while a line is showing. */
    this.dialogueMovementLock = false;
    this.camView = "follow";
    this.moveMode = "capsule";
    this.playerPos = new THREE.Vector3();
    this.velY = 0;
    this.inAir = false;
    this.camYaw = 0;
    this.camPitch = 0.35;
    this._camCollisionDist = 1;
    this.isoYaw = Math.PI / 4;
    this.isoDist = ISO_DIST_DEFAULT;
    this.savedCamPos = null;
    this.savedTarget = null;
    this.keysHeld = {};
    this._lastMx = 0;
    this._lastMz = 0;
    /** Editor windowed play: no pointer lock; RMB drag to look; pointer unlock does not exit play. */
    this._editorRelaxedPointer = false;
    this._rmbLookActive = false;

    // RTS / Director camera state (no pawn — pure top-down free camera)
    this.rtsFocusX = 0;
    this.rtsFocusZ = 0;
    this.rtsYaw = 0;
    this.rtsRmbDrag = false;
    this._rtsMouseX = 0;
    this._rtsMouseY = 0;

    // Fly state
    this.flyHeading = 0;
    this.flyPitch = 0;
    this.flyRoll = 0;
    this.flyRollTarget = 0;
    this.flyHeight = 0;
    this.flyBarrelActive = false;
    this.flyBarrelPhase = 0;
    this.flyBarrelDir = 1;
    this.flyGroundCamYawOff = 0;
    this.flyAileronAngle = 0;

    // Capsule mesh
    const geo = new THREE.CapsuleGeometry(CAP_R, CAP_H, 4, 8);
    const mat = new THREE.MeshStandardMaterial({
      color: 0xff6633,
      roughness: 0.7,
    });
    this.capsule = new THREE.Mesh(geo, mat);
    this.capsule.castShadow = true;
    this.capsule.visible = false;
    scene.add(this.capsule);

    // Plane mesh + contrails
    this.planeRoot = null;
    this._planeInner = null;
    this.planeLoaded = false;
    this._trailMat = createTrailMaterial();
    this._wingTrails = [];
    this._wingOffsets = [];
    this._bullets = createBulletPool(scene);
    this._muzzleOffsets = [];
    this._muzzleIdx = 0;
    this._gunCooldown = 0;
    this._loadPlane();

    this._onKeyDown = this._onKeyDown.bind(this);
    this._onKeyUp = this._onKeyUp.bind(this);
    this._onMouseMove = this._onMouseMove.bind(this);
    this._onPointerLockChange = this._onPointerLockChange.bind(this);
    this._onIsoClick = this._onIsoClick.bind(this);
    this._onIsoPointerMove = this._onIsoPointerMove.bind(this);
    this._onIsoWheel = this._onIsoWheel.bind(this);
    this._onRelaxedPointerDown = this._onRelaxedPointerDown.bind(this);
    this._onRelaxedPointerUp = this._onRelaxedPointerUp.bind(this);
    this._onRelaxedContextMenu = this._onRelaxedContextMenu.bind(this);
    this._onRtsPointerDown = this._onRtsPointerDown.bind(this);
    this._onRtsPointerUp = this._onRtsPointerUp.bind(this);
    this._onRtsContextMenu = this._onRtsContextMenu.bind(this);
    this._moveTarget = null;

    this._raycaster = new THREE.Raycaster();
    this._pointer = new THREE.Vector2();
    this._isoPickHit = new THREE.Vector3();
    this._lastIsoHoverPickMs = 0;
    const isoRingGeo = new THREE.RingGeometry(1.05, 1.35, 48);
    const isoRingMat = new THREE.MeshBasicMaterial({
      color: 0x66ddff,
      transparent: true,
      opacity: 0.65,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.isoHoverRing = new THREE.Mesh(isoRingGeo, isoRingMat);
    this.isoHoverRing.rotation.x = -Math.PI / 2;
    this.isoHoverRing.renderOrder = 1;
    this.isoHoverRing.visible = false;
    scene.add(this.isoHoverRing);
    this.isoTargetRing = new THREE.Mesh(isoRingGeo, isoRingMat.clone());
    this.isoTargetRing.material.opacity = 0.9;
    this.isoTargetRing.rotation.x = -Math.PI / 2;
    this.isoTargetRing.renderOrder = 1;
    this.isoTargetRing.visible = false;
    scene.add(this.isoTargetRing);
    this.planeSpeed = 0;
    /** Plane-only thrust reserve (HUD + future boost); not shared with `carNitro`. */
    this.planeNitro = PLANE_NITRO_FULL;
    this._planeHudSpdSmooth = 0;
    this._planeHudAltSmooth = 0;
    this._planeHudNitroSmooth = PLANE_NITRO_FULL;
    this._flyHud = null;
    this._flyHudSpd = null;
    this._flyHudAlt = null;
    this._flyHudPitch = null;
    this._flyHudBank = null;
    this._flyHudHorizonLayer = null;
    this._flyHudNitroPct = null;
    this._flyHudNitroBar = null;
    this._flyHudLevelHint = null;
    this._createFlyHud();

    // Character state
    this.charRoot = null;
    this.charInner = null;
    this.charMixer = null;
    this.charActions = null;
    this.charCurrentAction = null;
    this.charLoaded = false;
    this.charYaw = 0;
    this.charVelY = 0;
    this.charInAir = false;
    this.charCrouching = false;
    this.charAttacking = false;
    this.charRolling = false;
    this.charRollYaw = 0;
    this.charRollStart = 0;
    this.charRollDuration = 0.8;
    this.charJumpPhase = "none";
    this.charGliding = false;
    this.charGliderPoseActive = false;
    this.charSpacePrev = false;
    this.charKite = null;
    this.charSlidePhase = "none";
    this.charSlideYaw = 0;
    this.charSlideStart = 0;
    this.charSpellPhase = "none";
    this.charSpellExitRequested = false;
    this._loadCharacter();

    // Car drift state
    this.carRoot = null;
    this.carChassis = null;
    this.carWheels = [];
    this.carLoaded = false;
    this.carHeading = 0;
    this.carVx = 0;
    this.carVz = 0;
    this.carDrifting = false;
    this.carDriftAngle = 0;
    this.carWheelSpin = 0;
    this.carSteerSmooth = 0;
    this.carCamYaw = 0;
    this.carVelY = 0;
    this.carInAir = false;
    this.carOnSteepSlope = false;
    this.carNitro = 1.0;
    this._carPhysics = new CarPhysics();
    this._lotusPhysics = new LotusPhysics();
    this._driftBoostMeter = 0;
    this._driftBoostActive = false;
    this._hudKmhSmooth = 0;
    this._hudNitroSmooth = 1;
    this._carBoostBlend = 0;
    this._carNitroFxBlend = 0;
    this.carBodyRoll = 0;
    this.carBodyPitch = 0;
    this.carTerrainRoll = 0;
    this.carTerrainPitch = 0;
    this._carTerrainPitchTarget = 0;
    this._carTerrainRollTarget = 0;
    this._wheelWorldXZs = new Float32Array(8);
    this.driftMarks = new DriftMarks(scene);
    this.smokeSettings = smokeSettings || {};
    this.driftSmoke = new DriftSmoke(scene, this.smokeSettings);
    this._carRearContactPoints = [new THREE.Vector3(), new THREE.Vector3()];
    this._carRearContactGrounded = [false, false];
    this._carHud = null;
    this._carHudSpd = null;
    this._carHudAngle = null;
    this._carHudNitro = null;
    // Circular speedometer refs
    this._carSpeedometer = null;
    this._speedoNeedle = null;
    this._speedoDigital = null;
    this._speedoRpmBar = null;
    this._speedoGear = null;
    this._loadCar();
    this._createCarHud();
    this._createCarSpeedometer();

    // Lotus car state
    this.lotusRoot = null;
    this.lotusChassis = null;
    this.lotusWheels = [];
    this.lotusLoaded = false;
    this._lotusChassisMetrics = null;
    this._lotusChassisVisual = null;
    this._lotusWheelHubLocalY = 0;
    this.lotusCam = {
      distance: 5.5,
      height: 0.7,
      lookAtY: 1.4,
      chaseSpeed: 7.5,
      driftLag: 1.8,
      fov: 70,
      speedPullBack: 1,
      chassisRollClamp: 0.2,
      chassisPitchClamp: 0.3,
    };
    this.vvvCam = { ...DEFAULT_VVV_CAM };
    /** Low-passed body.pos.y for the chase camera. Suppresses suspension bob
     *  and airblend pops on takeoff / landing. Initialised lazily. */
    this._vvvCamFocusYSmooth = null;
    /** Low-passed camera position for VVV (matches standalone's CAM_LERP). */
    this._vvvCamPosSmooth = null;
    this._lotusCamDistSmooth = 0;
    this._vvvCamDistSmooth = 0;
    this._lotusBlinkerSide = 0;
    this._lotusBlinkerTime = 0;
    this._lotusBlinkerAutoHold = 0;
    this._lotusCamGui = null;
    this._vvvCamGui = null;
    this._jeepTuningGui = null;
    /** @type {Record<string, number> | null} */
    this._jeepGuiLive = null;
    /** Controllers for live jeep telemetry rows (lil-gui). */
    this._jeepGuiLiveCtrls = [];
    this._lotusLoadPromise = this._loadLotus();
    this._initLotusCamGui();
    this._initVvvGui();
    this._initJeepTuningGui();

    // === VVV rigid-body car state (see v2/play/vvvCarPhysics.js) ===
    // Per-instance copies of the default tunings so tweakpane can mutate them
    // without affecting the standalone defaults.
    this._vvvChassis = { ...DEFAULT_VVV_CHASSIS };
    this._vvvWheel = { ...DEFAULT_VVV_WHEEL };
    this._vvvTire = { ...DEFAULT_VVV_TIRE };
    this._vvvWall = { ...DEFAULT_VVV_WALL };
    this._vvvBody = new VvvRigidBody({
      mass: this._vvvChassis.mass,
      size: this._vvvChassis,
    });
    this._vvvLayout = createDefaultVvvWheelLayout();
    this._vvvTires = this._vvvLayout.map(
      (w) =>
        new VvvTire({
          name: w.name,
          localPos: w.pos,
          steer: w.steer,
          drive: w.drive,
        }),
    );
    this._vvvWallProbes = createDefaultVvvWallProbes(this._vvvChassis);
    /** Accumulated visual spin angle per wheel (radians). */
    this._vvvWheelSpin = [0, 0, 0, 0];
    /** Smoothed steer input −1..+1, exponential ease toward target. */
    this._vvvSteerSmooth = 0;
    /** Substeps per frame for the rigid-body integrator. */
    this._vvvSubsteps = 4;
    this.vvvLoaded = false;
    this.vvvRoot = null;
    this.vvvChassisPivot = null;
    this.vvvChassisMesh = null;
    this.vvvWheels = [];
    this.vvvWheelsLoaded = false;
    /** Force-arrow debug (matches `models/lotus-vvv-physics.html`). */
    this._vvvVis = { showArrows: true, arrowScale: 0.0008 };
    this._vvvArrowGroup = null;
    this._vvvForceArrows = null;
    /** Hub positions vs geometric center (before `comLower`). Filled when GLB loads. */
    this._vvvHubBase = null;
    this._setupVvvCar();
    this._loadVvvCarVisuals();

    // === Stunt car (byte-faithful modular-road Vehicle + v2 ground adapter) ===
    // Self-contained: owns its chassis/wheel meshes and runs its own physics
    // step. The ground adapter feeds it v2's analytic terrain + cliffBvh (and a
    // road BVH later) through the duck-typed groundBvh interface it expects.
    this._stuntVehicle = new ModularVehicle({
      scene: this.scene,
      showArrows: true,
    });
    this._stuntVehicle.getFloorY = (x, z) => this.getTerrainHeight(x, z);
    this._stuntGround = createVehicleGround({
      getTerrainHeight: (x, z) => this.getTerrainHeight(x, z),
      cliffBvh: this.cliffBvh,
    });
    this._stuntVehicle.enabled = false;
    this._stuntVehicle.group.visible = false;
    // Exact modular-road follow camera (trails travel direction, tilts look to
    // the landing). Separate from the VVV chase cam — see _updateStuntCamera.
    this._stuntCam = {
      fov: 60,
      dist: 7.5,
      height: 3.2,
      lookAhead: 5.5,
      lookUp: 1.2,
      minSpeed: 3.0,
      maxLookPitch: 0.85,
      headingLerp: 4.0,
      lookLerp: 5.0,
      posLerp: 7.0,
    };
    this._stuntCamHeading = new THREE.Vector3(0, 0, 1);
    this._stuntCamLookDir = new THREE.Vector3(0, 0, 1);
    this._stuntCamInit = false;
    /** Low-passed body Y for the FREE/detached orbit target — kills the
     *  suspension micro-bob so the free camera doesn't drift up/down. */
    this._stuntCamFocusYSmooth = null;

    this._modePill = null;
    this._modePillIcon = null;
    this._modePillLabel = null;
    this._modePillKey = null;
    this._createModePill();

    // Radial mode wheel state
    this._wheelEl = null;
    this._wheelCursorEl = null;
    this._wheelHubLabelEl = null;
    this._wheelSlotEls = {};
    this._wheelOpen = false;
    this._wheelArmed = false;
    this._wheelHoldTimer = null;
    this._wheelCursor = { x: 0, y: 0 };
    this._wheelHover = null;
    this._createModeWheel();

    // Free-orbit detach camera state (Unreal "Eject" pattern)
    this.detached = false;
    this._detachWasPointerLocked = false;
    this._detachBadge = null;
    this._createDetachBadge();

    // Per-mode camera tuning (FOV + chase distance + mouse sens).
    // Lotus / Bruno keep their richer dedicated GUIs and read from their own settings objects;
    // this object covers the modes that previously had no UI (capsule / char / fly / iso).
    this.cameraTuning = {
      capsule: {
        fov: 60,
        distance: CAM_DIST,
        sensX: CAM_SENS_X,
        sensY: CAM_SENS_Y,
      },
      char: {
        fov: 60,
        distance: CAM_DIST,
        sensX: CAM_SENS_X,
        sensY: CAM_SENS_Y,
      },
      fly: {
        fov: 60,
        distance: CAM_DIST,
        sensX: FLY_MOUSE_SENS_X,
        sensY: FLY_MOUSE_SENS_Y,
      },
      car: { fov: 60 }, // car uses carSettings for the rest
      lotus: { fov: this.lotusCam.fov },
      vvv: { ...DEFAULT_VVV_CAM },
      iso: { fov: 60, pitch: ISO_PITCH },
      rts: {
        fov: 50,
        distance: 60,
        pitch: 0.95,
        panSpeed: 40,
        rotateSens: 0.003,
        edgePan: false,
        edgePanZone: 24,
        edgePanSpeed: 30,
      },
    };
    this._loadCameraTuning();
    this._cameraTuningGui = null;
    this._cameraTuningGuiFolder = null;
    this._cameraTuningGuiModeShown = null;
    this._initCameraTuningGui();

    // Pause / time-scale controls (P = pause toggle, \ = cycle slow-mo, N = frame step)
    this.paused = false;
    this.timeScale = 1;
    this._frameStepPending = 0;
    this._pauseBadge = null;
    this._pauseBadgeLabel = null;
    this._createPauseBadge();

    // Transient toast (respawn / bookmark feedback)
    this._toastEl = null;
    this._toastInner = null;
    this._toastTimer = null;
    this._createToast();
  }

  _createModePill() {
    const el = document.createElement("div");
    el.id = "play-mode-pill";
    el.style.cssText = [
      "position:fixed",
      "bottom:20px",
      "left:20px",
      "z-index:7",
      "display:none",
      "pointer-events:none",
      "font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,sans-serif",
      "font-variant-numeric:tabular-nums",
      "-webkit-font-smoothing:antialiased",
      "filter:drop-shadow(0 12px 32px rgba(0,0,0,0.55))",
    ].join(";");
    el.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;padding:8px 14px 8px 10px;border-radius:999px;background:rgba(6,10,14,0.72);backdrop-filter:blur(14px) saturate(1.2);-webkit-backdrop-filter:blur(14px) saturate(1.2);border:1px solid rgba(120,175,200,0.22);box-shadow:inset 0 1px 0 rgba(255,255,255,0.06),0 0 0 1px rgba(0,0,0,0.35),0 8px 22px rgba(0,0,0,0.4);">
        <div id="play-mode-pill-icon" style="display:flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:50%;background:linear-gradient(145deg,rgba(120,170,220,0.35),rgba(40,60,90,0.6));color:#f2f8fc;font-size:16px;line-height:1;">◉</div>
        <div style="display:flex;flex-direction:column;gap:1px;">
          <div style="font-size:8px;font-weight:600;letter-spacing:0.2em;color:rgba(140,175,195,0.7);text-transform:uppercase;">Play mode</div>
          <div style="display:flex;align-items:baseline;gap:8px;">
            <span id="play-mode-pill-label" style="font-size:14px;font-weight:700;color:#f2f8fc;letter-spacing:-0.01em;">Capsule</span>
            <span id="play-mode-pill-view" style="font-size:8px;font-weight:700;letter-spacing:0.16em;color:rgba(180,210,230,0.85);text-transform:uppercase;padding:2px 6px;border-radius:999px;background:rgba(110,150,180,0.18);border:1px solid rgba(140,175,200,0.25);">TPS</span>
            <span id="play-mode-pill-key" style="font-size:9px;font-weight:600;letter-spacing:0.16em;color:rgba(140,175,195,0.7);text-transform:uppercase;">1 · hold G</span>
          </div>
        </div>
      </div>`;
    document.body.appendChild(el);
    this._modePill = el;
    this._modePillIcon = el.querySelector("#play-mode-pill-icon");
    this._modePillLabel = el.querySelector("#play-mode-pill-label");
    this._modePillKey = el.querySelector("#play-mode-pill-key");
    this._modePillView = el.querySelector("#play-mode-pill-view");
  }

  _updateModePill() {
    if (!this._modePill) return;
    const meta = MODE_META[this.moveMode];
    if (!meta) return;
    if (this._modePillIcon) this._modePillIcon.textContent = meta.icon;
    if (this._modePillLabel) this._modePillLabel.textContent = meta.label;
    if (this._modePillKey)
      this._modePillKey.textContent = `${meta.digit} · G wheel · F free cam`;
    if (this._modePillView) {
      if (this.moveMode === "rts") {
        // RTS has its own camera scheme; TPS/ISO badge doesn't apply.
        this._modePillView.style.display = "none";
      } else {
        this._modePillView.style.display = "";
        const isIso = this.camView === "iso";
        this._modePillView.textContent = isIso ? "ISO" : "TPS";
        this._modePillView.style.color = isIso
          ? "#ffd9a0"
          : "rgba(180,210,230,0.85)";
        this._modePillView.style.background = isIso
          ? "rgba(195,145,75,0.22)"
          : "rgba(110,150,180,0.18)";
        this._modePillView.style.borderColor = isIso
          ? "rgba(225,170,90,0.4)"
          : "rgba(140,175,200,0.25)";
      }
    }
  }

  _createModeWheel() {
    const RING_R = 130; // slot ring radius (px)
    const overlay = document.createElement("div");
    overlay.id = "mode-wheel-overlay";
    overlay.style.cssText = [
      "position:fixed",
      "inset:0",
      "z-index:8",
      "display:none",
      "pointer-events:none",
      "background:radial-gradient(circle at center,rgba(4,8,12,0.55),rgba(4,8,12,0.25) 60%,transparent 80%)",
      "backdrop-filter:blur(6px) saturate(1.05)",
      "-webkit-backdrop-filter:blur(6px) saturate(1.05)",
      "font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,sans-serif",
      "-webkit-font-smoothing:antialiased",
    ].join(";");

    const wheel = document.createElement("div");
    wheel.style.cssText = [
      "position:absolute",
      "left:50%",
      "top:50%",
      "width:360px",
      "height:360px",
      "transform:translate(-50%,-50%)",
    ].join(";");

    const ring = document.createElement("div");
    ring.style.cssText = [
      "position:absolute",
      "left:50%",
      "top:50%",
      `width:${RING_R * 2}px`,
      `height:${RING_R * 2}px`,
      "margin-left:" + -RING_R + "px",
      "margin-top:" + -RING_R + "px",
      "border-radius:50%",
      "border:1px dashed rgba(160,200,225,0.18)",
      "box-shadow:inset 0 0 60px rgba(0,0,0,0.4)",
    ].join(";");
    wheel.appendChild(ring);

    const n = MODE_ORDER.length;
    for (let i = 0; i < n; i++) {
      const name = MODE_ORDER[i];
      const meta = MODE_META[name];
      const ang = -Math.PI / 2 + (i * Math.PI * 2) / n;
      const cx = Math.cos(ang) * RING_R;
      const cy = Math.sin(ang) * RING_R;
      const slot = document.createElement("div");
      slot.dataset.mode = name;
      slot.style.cssText = [
        "position:absolute",
        "left:50%",
        "top:50%",
        "width:84px",
        "height:84px",
        `transform:translate(calc(-50% + ${cx}px),calc(-50% + ${cy}px))`,
        "border-radius:50%",
        "background:rgba(6,10,14,0.78)",
        "backdrop-filter:blur(14px) saturate(1.2)",
        "-webkit-backdrop-filter:blur(14px) saturate(1.2)",
        "border:1px solid rgba(120,175,200,0.25)",
        "box-shadow:inset 0 1px 0 rgba(255,255,255,0.06),0 8px 22px rgba(0,0,0,0.45)",
        "display:flex",
        "flex-direction:column",
        "align-items:center",
        "justify-content:center",
        "gap:2px",
        "color:#f2f8fc",
        "transition:transform 120ms ease,background 120ms ease,border-color 120ms ease,box-shadow 120ms ease",
      ].join(";");
      slot.innerHTML = `
        <div style="font-size:22px;line-height:1;">${meta.icon}</div>
        <div style="font-size:10px;font-weight:700;letter-spacing:0.02em;">${meta.label}</div>
        <div style="font-size:8px;font-weight:600;letter-spacing:0.16em;color:rgba(140,175,195,0.7);text-transform:uppercase;">Key ${meta.digit}</div>
      `;
      wheel.appendChild(slot);
      this._wheelSlotEls[name] = slot;
    }

    const hub = document.createElement("div");
    hub.style.cssText = [
      "position:absolute",
      "left:50%",
      "top:50%",
      "width:120px",
      "height:120px",
      "margin-left:-60px",
      "margin-top:-60px",
      "border-radius:50%",
      "background:rgba(4,8,12,0.82)",
      "border:1px solid rgba(120,175,200,0.22)",
      "box-shadow:inset 0 1px 0 rgba(255,255,255,0.05),0 0 24px rgba(0,0,0,0.5)",
      "display:flex",
      "flex-direction:column",
      "align-items:center",
      "justify-content:center",
      "text-align:center",
      "padding:0 10px",
    ].join(";");
    hub.innerHTML = `
      <div style="font-size:8px;font-weight:600;letter-spacing:0.22em;color:rgba(140,175,195,0.7);text-transform:uppercase;">Play mode</div>
      <div id="mode-wheel-hub-label" style="font-size:14px;font-weight:700;color:#f2f8fc;margin-top:4px;">—</div>
      <div style="font-size:8px;font-weight:500;letter-spacing:0.1em;color:rgba(140,175,195,0.55);margin-top:6px;text-transform:uppercase;">Release to pick</div>
    `;
    wheel.appendChild(hub);

    const cursor = document.createElement("div");
    cursor.style.cssText = [
      "position:absolute",
      "left:50%",
      "top:50%",
      "width:10px",
      "height:10px",
      "margin-left:-5px",
      "margin-top:-5px",
      "border-radius:50%",
      "background:#f2f8fc",
      "box-shadow:0 0 12px rgba(255,255,255,0.6),0 0 4px rgba(140,200,255,0.8)",
      "pointer-events:none",
      "transform:translate(0,0)",
    ].join(";");
    wheel.appendChild(cursor);

    overlay.appendChild(wheel);
    document.body.appendChild(overlay);

    this._wheelEl = overlay;
    this._wheelCursorEl = cursor;
    this._wheelHubLabelEl = hub.querySelector("#mode-wheel-hub-label");
  }

  _armWheelHold() {
    if (this._wheelHoldTimer || this._wheelOpen) return;
    this._wheelArmed = true;
    this._wheelHoldTimer = setTimeout(() => {
      this._wheelHoldTimer = null;
      if (this._wheelArmed && this.active) this._openModeWheel();
    }, 180);
  }

  _openModeWheel() {
    if (!this._wheelEl || this._wheelOpen) return;
    this._wheelOpen = true;
    this._wheelCursor.x = 0;
    this._wheelCursor.y = 0;
    this._wheelHover = null;
    this._refreshWheelVisual();
    this._wheelEl.style.display = "block";
  }

  _closeModeWheel(commit) {
    if (this._wheelHoldTimer) {
      clearTimeout(this._wheelHoldTimer);
      this._wheelHoldTimer = null;
    }
    this._wheelArmed = false;
    if (!this._wheelOpen) return;
    this._wheelOpen = false;
    if (this._wheelEl) this._wheelEl.style.display = "none";
    if (commit && this._wheelHover && this._wheelHover !== this.moveMode) {
      this._setMoveMode(this._wheelHover);
    }
    this._wheelHover = null;
  }

  _feedWheelMouse(dx, dy) {
    if (!this._wheelOpen) return;
    const RING_R = 130;
    this._wheelCursor.x += dx;
    this._wheelCursor.y += dy;
    const mag = Math.hypot(this._wheelCursor.x, this._wheelCursor.y);
    const maxR = RING_R + 30;
    if (mag > maxR) {
      const s = maxR / mag;
      this._wheelCursor.x *= s;
      this._wheelCursor.y *= s;
    }
    this._refreshWheelVisual();
  }

  _refreshWheelVisual() {
    const { x, y } = this._wheelCursor;
    if (this._wheelCursorEl) {
      this._wheelCursorEl.style.transform = `translate(${x}px,${y}px)`;
    }
    const mag = Math.hypot(x, y);
    const DEAD_R = 40;
    let hover = null;
    if (mag > DEAD_R) {
      const ang = Math.atan2(y, x);
      const n = MODE_ORDER.length;
      let best = -1;
      let bestDiff = Infinity;
      for (let i = 0; i < n; i++) {
        const slotAng = -Math.PI / 2 + (i * Math.PI * 2) / n;
        let d = Math.abs(
          ((ang - slotAng + Math.PI * 3) % (Math.PI * 2)) - Math.PI,
        );
        if (d < bestDiff) {
          bestDiff = d;
          best = i;
        }
      }
      if (best >= 0) hover = MODE_ORDER[best];
    }
    if (hover !== this._wheelHover) {
      this._wheelHover = hover;
      for (const name of MODE_ORDER) {
        const el = this._wheelSlotEls[name];
        if (!el) continue;
        if (name === hover) {
          el.style.background = "rgba(60,120,170,0.55)";
          el.style.borderColor = "rgba(180,220,250,0.7)";
          el.style.boxShadow =
            "inset 0 1px 0 rgba(255,255,255,0.1),0 10px 28px rgba(60,140,200,0.45),0 0 22px rgba(120,200,255,0.35)";
          el.style.transform =
            el.style.transform.replace(/scale\([^)]*\)/, "") + " scale(1.12)";
        } else {
          el.style.background = "rgba(6,10,14,0.78)";
          el.style.borderColor = "rgba(120,175,200,0.25)";
          el.style.boxShadow =
            "inset 0 1px 0 rgba(255,255,255,0.06),0 8px 22px rgba(0,0,0,0.45)";
          el.style.transform = el.style.transform.replace(
            /\s*scale\([^)]*\)/,
            "",
          );
        }
      }
      if (this._wheelHubLabelEl) {
        this._wheelHubLabelEl.textContent = hover
          ? MODE_META[hover].label
          : MODE_META[this.moveMode].label;
      }
    }
  }

  _createDetachBadge() {
    const el = document.createElement("div");
    el.id = "play-detach-badge";
    el.style.cssText = [
      "position:fixed",
      "top:20px",
      "left:50%",
      "transform:translateX(-50%)",
      "z-index:7",
      "display:none",
      "pointer-events:none",
      "font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,sans-serif",
      "-webkit-font-smoothing:antialiased",
      "filter:drop-shadow(0 12px 32px rgba(0,0,0,0.55))",
    ].join(";");
    el.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;padding:8px 16px;border-radius:999px;background:rgba(14,8,4,0.78);backdrop-filter:blur(14px) saturate(1.2);-webkit-backdrop-filter:blur(14px) saturate(1.2);border:1px solid rgba(225,170,90,0.45);box-shadow:inset 0 1px 0 rgba(255,255,255,0.06),0 0 0 1px rgba(0,0,0,0.35),0 8px 22px rgba(0,0,0,0.4),0 0 24px rgba(225,170,90,0.18);">
        <div style="display:flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:50%;background:linear-gradient(145deg,rgba(255,200,120,0.5),rgba(180,110,40,0.6));color:#fff5e0;font-size:13px;line-height:1;">📷</div>
        <div style="display:flex;align-items:baseline;gap:10px;">
          <span style="font-size:11px;font-weight:700;letter-spacing:0.22em;color:#ffd9a0;text-transform:uppercase;">Free camera</span>
          <span style="font-size:9px;font-weight:600;letter-spacing:0.16em;color:rgba(225,190,150,0.7);text-transform:uppercase;">F · re-attach</span>
        </div>
      </div>`;
    document.body.appendChild(el);
    this._detachBadge = el;
  }

  _enterDetached() {
    if (this.detached || !this.active) return;
    this.detached = true;
    this._detachWasPointerLocked = !!document.pointerLockElement;
    if (document.pointerLockElement) document.exitPointerLock();
    this.renderer.domElement.style.cursor = "";
    this._rmbLookActive = false;
    // Save and relax OrbitControls limits — the editor caps min distance at 15
    // and polar at ~88° for terrain work; for pawn inspection we want close-up and underside.
    this._detachSavedMinDist = this.controls.minDistance;
    this._detachSavedMaxDist = this.controls.maxDistance;
    this._detachSavedMaxPolar = this.controls.maxPolarAngle;
    this._detachSavedMinPolar = this.controls.minPolarAngle;
    this.controls.minDistance = 0.5;
    this.controls.maxDistance = 200;
    this.controls.maxPolarAngle = Math.PI;
    this.controls.minPolarAngle = 0;
    // Seed orbit target on current pawn so the initial orbit feels natural.
    const ty = this._getDetachedOrbitTargetY();
    this.controls.target.set(this.playerPos.x, ty, this.playerPos.z);
    this.controls.enabled = true;
    if (this._detachBadge) this._detachBadge.style.display = "block";
  }

  _exitDetached() {
    if (!this.detached) return;
    this.detached = false;
    this.controls.enabled = false;
    // Restore saved OrbitControls limits
    if (this._detachSavedMinDist !== undefined)
      this.controls.minDistance = this._detachSavedMinDist;
    if (this._detachSavedMaxDist !== undefined)
      this.controls.maxDistance = this._detachSavedMaxDist;
    if (this._detachSavedMaxPolar !== undefined)
      this.controls.maxPolarAngle = this._detachSavedMaxPolar;
    if (this._detachSavedMinPolar !== undefined)
      this.controls.minPolarAngle = this._detachSavedMinPolar;
    if (this._detachBadge) this._detachBadge.style.display = "none";
    if (!this.active) return;
    if (this._editorRelaxedPointer) {
      this.renderer.domElement.style.cursor = "";
    } else if (this._detachWasPointerLocked) {
      this.renderer.domElement.style.cursor = "none";
      try {
        this.renderer.domElement.requestPointerLock();
      } catch (_) {
        /* browser will block if not in a user gesture; that's ok, next click re-locks */
      }
    }
    this._detachWasPointerLocked = false;
  }

  _toggleDetached() {
    if (this.detached) this._exitDetached();
    else this._enterDetached();
  }

  _loadCameraTuning() {
    try {
      const raw = localStorage.getItem("v2.playCameraTuning");
      if (!raw) return;
      const parsed = JSON.parse(raw);
      for (const mode of Object.keys(this.cameraTuning)) {
        if (!parsed[mode]) continue;
        for (const k of Object.keys(this.cameraTuning[mode])) {
          if (
            typeof parsed[mode][k] === "number" &&
            Number.isFinite(parsed[mode][k])
          ) {
            this.cameraTuning[mode][k] = parsed[mode][k];
          }
        }
      }
      if (this.vvvCam && parsed.vvv) {
        for (const k of Object.keys(this.vvvCam)) {
          if (
            typeof parsed.vvv[k] === "number" &&
            Number.isFinite(parsed.vvv[k])
          ) {
            this.vvvCam[k] = parsed.vvv[k];
          }
        }
      }
      if (this.lotusCam && typeof parsed.lotus?.fov === "number") {
        this.lotusCam.fov = parsed.lotus.fov;
      }
    } catch (_) {
      /* ignore */
    }
  }

  _saveCameraTuning() {
    try {
      if (this.lotusCam && this.cameraTuning.lotus) {
        this.cameraTuning.lotus.fov = this.lotusCam.fov;
      }
      if (this.vvvCam && this.cameraTuning.vvv) {
        Object.assign(this.cameraTuning.vvv, this.vvvCam);
      }
      localStorage.setItem(
        "v2.playCameraTuning",
        JSON.stringify(this.cameraTuning),
      );
    } catch (_) {
      /* ignore quota */
    }
  }

  _applyCameraFov() {
    let fov;
    if (this.moveMode === "stunt") fov = this._stuntCam.fov;
    else if (this.moveMode === "vvv") fov = this.vvvCam.fov;
    else if (this.moveMode === "lotus") fov = this.lotusCam.fov;
    else fov = this.cameraTuning[this.moveMode]?.fov ?? 60;
    if (this.camera.fov !== fov) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
  }

  async _initCameraTuningGui() {
    try {
      const { GUI } =
        await import("https://cdn.jsdelivr.net/npm/lil-gui@0.20.0/dist/lil-gui.esm.min.js");
      const gui = new GUI({ title: "Play Camera", width: 280 });
      gui.domElement.style.position = "fixed";
      gui.domElement.style.top = "10px";
      gui.domElement.style.left = "10px";
      gui.domElement.style.display = "none"; // hidden until play active
      this._cameraTuningGui = gui;
      this._rebuildCameraTuningGui();
    } catch (_) {
      /* offline / blocked */
    }
  }

  _rebuildCameraTuningGui() {
    const gui = this._cameraTuningGui;
    if (!gui) return;
    if (this._cameraTuningGuiFolder) {
      this._cameraTuningGuiFolder.destroy();
      this._cameraTuningGuiFolder = null;
    }
    // Stunt's camera controls live in the custom editor Play panel, not this
    // lil-gui (which is hidden in Stunt) — skip building a folder for it.
    if (this.moveMode === "stunt") {
      this._cameraTuningGuiModeShown = "stunt";
      return;
    }
    const mode = this.moveMode;
    const meta = MODE_META[mode];
    const title = meta ? `${meta.icon}  ${meta.label}` : mode;
    const folder = gui.addFolder(title);
    this._cameraTuningGuiFolder = folder;
    this._cameraTuningGuiModeShown = mode;

    const onAny = () => {
      this._applyCameraFov();
      this._saveCameraTuning();
    };

    if (mode === "lotus") {
      // Lotus's full panel lives in the lil-gui created by _initLotusCamGui; just expose FOV here.
      folder.add(this.lotusCam, "fov", 40, 110, 1).name("FOV").onChange(onAny);
      folder
        .add(
          {
            open: () =>
              this._lotusCamGui &&
              (this._lotusCamGui.domElement.style.display = ""),
          },
          "open",
        )
        .name("Open Lotus panel ↗");
    } else if (mode === "car") {
      const t = this.cameraTuning.car;
      folder.add(t, "fov", 40, 110, 1).name("FOV").onChange(onAny);
      if (this.carSettings) {
        folder
          .add(this.carSettings, "cameraDistance", 4, 24, 0.25)
          .name("Distance")
          .onChange(onAny);
        folder
          .add(this.carSettings, "cameraHeight", 1, 10, 0.1)
          .name("Height")
          .onChange(onAny);
        folder
          .add(this.carSettings, "cameraChaseSpeed", 0.5, 12, 0.1)
          .name("Chase speed")
          .onChange(onAny);
        folder
          .add(this.carSettings, "cameraDriftLag", 0, 5, 0.1)
          .name("Drift lag")
          .onChange(onAny);
      }
    } else if (mode === "vvv") {
      const vc = this.vvvCam;
      folder.add(vc, "fov", 40, 110, 1).name("FOV").onChange(onAny);
      folder.add(vc, "distance", 2, 16, 0.1).name("Distance").onChange(onAny);
      folder.add(vc, "height", 0.5, 8, 0.1).name("Height").onChange(onAny);
      folder.add(vc, "lookAtY", 0, 4, 0.1).name("Look-at Y").onChange(onAny);
      folder
        .add(vc, "chaseSpeed", 1, 12, 0.1)
        .name("Chase speed")
        .onChange(onAny);
      folder.add(vc, "driftLag", 0, 5, 0.1).name("Drift lag").onChange(onAny);
      folder
        .add(vc, "speedPullBack", 0, 8, 0.1)
        .name("Speed pull-back")
        .onChange(onAny);
      folder
        .add(
          {
            open: () =>
              this._vvvCamGui &&
              (this._vvvCamGui.domElement.style.display = ""),
          },
          "open",
        )
        .name("Open VVV panel ↗");
    } else if (mode === "fly") {
      const t = this.cameraTuning.fly;
      folder.add(t, "fov", 40, 110, 1).name("FOV").onChange(onAny);
      folder
        .add(t, "distance", 3, 24, 0.25)
        .name("Chase distance")
        .onChange(onAny);
      folder
        .add(t, "sensX", 0.0005, 0.01, 0.0001)
        .name("Mouse sens X")
        .onChange(this._saveCameraTuning.bind(this));
      folder
        .add(t, "sensY", 0.0005, 0.01, 0.0001)
        .name("Mouse sens Y")
        .onChange(this._saveCameraTuning.bind(this));
    } else if (mode === "iso") {
      const t = this.cameraTuning.iso;
      folder.add(t, "fov", 30, 90, 1).name("FOV").onChange(onAny);
      folder
        .add(t, "pitch", 0.4, 1.4, 0.01)
        .name("Pitch (rad)")
        .onChange(this._saveCameraTuning.bind(this));
    } else if (mode === "rts") {
      const t = this.cameraTuning.rts;
      folder.add(t, "fov", 30, 90, 1).name("FOV").onChange(onAny);
      folder
        .add(t, "distance", 6, 400, 1)
        .name("Distance")
        .onChange(this._saveCameraTuning.bind(this));
      folder
        .add(t, "pitch", 0.4, Math.PI / 2 - 0.05, 0.01)
        .name("Pitch (rad)")
        .onChange(this._saveCameraTuning.bind(this));
      folder
        .add(t, "panSpeed", 5, 200, 1)
        .name("Pan speed")
        .onChange(this._saveCameraTuning.bind(this));
      folder
        .add(t, "rotateSens", 0.0005, 0.01, 0.0005)
        .name("Rotate sens")
        .onChange(this._saveCameraTuning.bind(this));
      folder
        .add(t, "edgePan")
        .name("Edge pan")
        .onChange(this._saveCameraTuning.bind(this));
      folder
        .add(t, "edgePanZone", 8, 80, 1)
        .name("Edge zone (px)")
        .onChange(this._saveCameraTuning.bind(this));
    } else {
      // capsule / char
      const t = this.cameraTuning[mode];
      folder.add(t, "fov", 40, 110, 1).name("FOV").onChange(onAny);
      folder
        .add(t, "distance", 3, 24, 0.25)
        .name("Chase distance")
        .onChange(onAny);
      folder
        .add(t, "sensX", 0.0005, 0.01, 0.0001)
        .name("Mouse sens X")
        .onChange(this._saveCameraTuning.bind(this));
      folder
        .add(t, "sensY", 0.0005, 0.01, 0.0001)
        .name("Mouse sens Y")
        .onChange(this._saveCameraTuning.bind(this));
    }

    folder
      .add(
        {
          reset: () => {
            const defaults = {
              capsule: {
                fov: 60,
                distance: CAM_DIST,
                sensX: CAM_SENS_X,
                sensY: CAM_SENS_Y,
              },
              char: {
                fov: 60,
                distance: CAM_DIST,
                sensX: CAM_SENS_X,
                sensY: CAM_SENS_Y,
              },
              fly: {
                fov: 60,
                distance: CAM_DIST,
                sensX: FLY_MOUSE_SENS_X,
                sensY: FLY_MOUSE_SENS_Y,
              },
              car: { fov: 60 },
              lotus: { fov: 70 },
              vvv: { ...DEFAULT_VVV_CAM },
              iso: { fov: 60, pitch: ISO_PITCH },
              rts: {
                fov: 50,
                distance: 60,
                pitch: 0.95,
                panSpeed: 40,
                rotateSens: 0.003,
                edgePan: false,
                edgePanZone: 24,
                edgePanSpeed: 30,
              },
            }[mode];
            if (!defaults) return;
            Object.assign(this.cameraTuning[mode], defaults);
            if (mode === "lotus") this.lotusCam.fov = defaults.fov;
            if (mode === "vvv") Object.assign(this.vvvCam, defaults);
            this._applyCameraFov();
            this._saveCameraTuning();
            this._rebuildCameraTuningGui();
          },
        },
        "reset",
      )
      .name("↺ Reset to defaults");
    folder.open();
  }

  _refreshCameraTuningGuiVisible() {
    if (!this._cameraTuningGui) return;
    // Hidden in Stunt — its camera controls live in the custom editor Play panel.
    const show = this.active && this.moveMode !== "stunt";
    this._cameraTuningGui.domElement.style.display = show ? "" : "none";
  }

  _createPauseBadge() {
    const el = document.createElement("div");
    el.id = "play-pause-badge";
    el.style.cssText = [
      "position:fixed",
      "top:20px",
      "right:20px",
      "z-index:7",
      "display:none",
      "pointer-events:none",
      "font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,sans-serif",
      "-webkit-font-smoothing:antialiased",
      "filter:drop-shadow(0 12px 32px rgba(0,0,0,0.55))",
    ].join(";");
    el.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;padding:8px 16px;border-radius:999px;background:rgba(4,10,18,0.78);backdrop-filter:blur(14px) saturate(1.2);-webkit-backdrop-filter:blur(14px) saturate(1.2);border:1px solid rgba(110,180,240,0.45);box-shadow:inset 0 1px 0 rgba(255,255,255,0.06),0 0 0 1px rgba(0,0,0,0.35),0 8px 22px rgba(0,0,0,0.4),0 0 24px rgba(80,160,240,0.16);">
        <div id="play-pause-badge-icon" style="display:flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:50%;background:linear-gradient(145deg,rgba(120,180,255,0.5),rgba(30,80,160,0.6));color:#e8f4ff;font-size:12px;line-height:1;">⏸</div>
        <div style="display:flex;align-items:baseline;gap:10px;">
          <span id="play-pause-badge-label" style="font-size:11px;font-weight:700;letter-spacing:0.22em;color:#a8d4ff;text-transform:uppercase;">Paused</span>
          <span style="font-size:9px;font-weight:600;letter-spacing:0.16em;color:rgba(168,212,255,0.65);text-transform:uppercase;">P · \\ · N step</span>
        </div>
      </div>`;
    document.body.appendChild(el);
    this._pauseBadge = el;
    this._pauseBadgeLabel = el.querySelector("#play-pause-badge-label");
    this._pauseBadgeIcon = el.querySelector("#play-pause-badge-icon");
  }

  _updatePauseBadge() {
    if (!this._pauseBadge) return;
    const showSlowMo = !this.paused && this.timeScale !== 1;
    const show = this.active && (this.paused || showSlowMo);
    this._pauseBadge.style.display = show ? "block" : "none";
    if (!show) return;
    if (this.paused) {
      this._pauseBadgeIcon.textContent = "⏸";
      this._pauseBadgeLabel.textContent = "Paused";
    } else {
      this._pauseBadgeIcon.textContent = "⏵";
      this._pauseBadgeLabel.textContent = `${this.timeScale}× slow-mo`;
    }
  }

  _togglePause() {
    if (!this.active) return;
    this.paused = !this.paused;
    // Clear held movement keys on pause so user doesn't accelerate on resume
    if (this.paused) {
      for (const k of [
        "KeyW",
        "KeyA",
        "KeyS",
        "KeyD",
        "ArrowUp",
        "ArrowDown",
        "ArrowLeft",
        "ArrowRight",
        "Space",
        "ShiftLeft",
        "ShiftRight",
      ]) {
        delete this.keysHeld[k];
      }
    }
    this._updatePauseBadge();
  }

  _cycleSlowMo() {
    if (!this.active) return;
    const order = [1, 0.5, 0.25, 0.1];
    const i = order.indexOf(this.timeScale);
    this.timeScale = order[(i + 1) % order.length];
    this._updatePauseBadge();
  }

  _stepOneFrame() {
    if (!this.active || !this.paused) return;
    this._frameStepPending = 1;
  }

  _createToast() {
    const el = document.createElement("div");
    el.id = "play-toast";
    el.style.cssText = [
      "position:fixed",
      "top:70px",
      "left:50%",
      "transform:translateX(-50%)",
      "z-index:8",
      "opacity:0",
      "pointer-events:none",
      "transition:opacity 180ms ease",
      "font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,sans-serif",
      "-webkit-font-smoothing:antialiased",
      "filter:drop-shadow(0 12px 32px rgba(0,0,0,0.55))",
    ].join(";");
    el.innerHTML = `<div id="play-toast-inner" style="padding:9px 18px;border-radius:999px;background:rgba(8,14,10,0.82);backdrop-filter:blur(14px) saturate(1.2);-webkit-backdrop-filter:blur(14px) saturate(1.2);border:1px solid rgba(140,220,160,0.45);box-shadow:inset 0 1px 0 rgba(255,255,255,0.06),0 8px 22px rgba(0,0,0,0.4),0 0 24px rgba(120,200,140,0.22);font-size:11px;font-weight:700;letter-spacing:0.18em;color:#c8f5d4;text-transform:uppercase;">message</div>`;
    document.body.appendChild(el);
    this._toastEl = el;
    this._toastInner = el.querySelector("#play-toast-inner");
    this._toastTimer = null;
  }

  _showToast(text, accent = "green") {
    if (!this._toastEl) return;
    const palette =
      accent === "amber"
        ? {
            bg: "rgba(14,10,8,0.82)",
            border: "rgba(225,170,90,0.45)",
            color: "#ffd9a0",
            glow: "rgba(225,170,90,0.22)",
          }
        : {
            bg: "rgba(8,14,10,0.82)",
            border: "rgba(140,220,160,0.45)",
            color: "#c8f5d4",
            glow: "rgba(120,200,140,0.22)",
          };
    this._toastInner.textContent = text;
    this._toastInner.style.background = palette.bg;
    this._toastInner.style.borderColor = palette.border;
    this._toastInner.style.color = palette.color;
    this._toastInner.style.boxShadow = `inset 0 1px 0 rgba(255,255,255,0.06),0 8px 22px rgba(0,0,0,0.4),0 0 24px ${palette.glow}`;
    this._toastEl.style.opacity = "1";
    if (this._toastTimer) clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => {
      if (this._toastEl) this._toastEl.style.opacity = "0";
      this._toastTimer = null;
    }, 1400);
  }

  _bookmarkSpawn() {
    if (!this.active) return;
    if (!this.spawnSettings) {
      this._showToast("⚠ Spawn settings unavailable", "amber");
      return;
    }
    const spawn = this.spawnSettings;
    spawn.enabled = true;
    spawn.x = this.playerPos.x;
    spawn.y = this.playerPos.y;
    spawn.z = this.playerPos.z;
    spawn.yawDeg = THREE.MathUtils.radToDeg(this._currentYaw());
    if (this._onSpawnChanged) this._onSpawnChanged();
    this._showToast("📍 Spawn bookmarked");
  }

  _updateRtsCamera(dtSec) {
    const t = this.cameraTuning.rts;
    const keys = this.keysHeld;
    const sprint = keys.ShiftLeft || keys.ShiftRight ? 2.5 : 1;
    // Pan speed scales with zoom — closer = slower, like Google Maps.
    const distScale = Math.max(0.25, t.distance / 60);
    const panSpeed = t.panSpeed * sprint * distScale;

    // WASD / arrows pan in camera-aligned screen space.
    let panX = 0,
      panZ = 0;
    if (keys.KeyW || keys.ArrowUp) panZ -= 1;
    if (keys.KeyS || keys.ArrowDown) panZ += 1;
    if (keys.KeyA || keys.ArrowLeft) panX -= 1;
    if (keys.KeyD || keys.ArrowRight) panX += 1;

    // Edge pan (opt-in)
    if (t.edgePan && document.hasFocus()) {
      const w = window.innerWidth,
        h = window.innerHeight;
      const z = t.edgePanZone;
      if (this._rtsMouseX < z) panX -= 1;
      else if (this._rtsMouseX > w - z) panX += 1;
      if (this._rtsMouseY < z) panZ -= 1;
      else if (this._rtsMouseY > h - z) panZ += 1;
    }

    // Normalize so diagonal isn't faster
    const mlen = Math.hypot(panX, panZ);
    if (mlen > 0) {
      panX /= mlen;
      panZ /= mlen;
    }

    // Rotate pan vector by RTS yaw → world-space pan
    const sinY = Math.sin(this.rtsYaw);
    const cosY = Math.cos(this.rtsYaw);
    const worldDx = (panX * cosY - panZ * sinY) * panSpeed * dtSec;
    const worldDz = (panX * sinY + panZ * cosY) * panSpeed * dtSec;
    if (worldDx !== 0 || worldDz !== 0) {
      this.rtsFocusX += worldDx;
      this.rtsFocusZ += worldDz;
      const half = this.worldHalf || Infinity;
      this.rtsFocusX = THREE.MathUtils.clamp(this.rtsFocusX, -half, half);
      this.rtsFocusZ = THREE.MathUtils.clamp(this.rtsFocusZ, -half, half);
    }

    // Q / E rotate yaw
    if (keys.KeyQ) this.rtsYaw += 1.4 * dtSec;
    if (keys.KeyE) this.rtsYaw -= 1.4 * dtSec;

    // Compose camera from focus + yaw/pitch/distance
    const pitch = THREE.MathUtils.clamp(t.pitch, 0.25, Math.PI / 2 - 0.05);
    const dist = Math.max(2, t.distance);
    const focusY = this.getWorldHeight(this.rtsFocusX, this.rtsFocusZ);
    const hOff = Math.cos(pitch) * dist;
    const vOff = Math.sin(pitch) * dist;
    const camX = this.rtsFocusX - Math.sin(this.rtsYaw) * hOff;
    const camZ = this.rtsFocusZ - Math.cos(this.rtsYaw) * hOff;
    const camY = focusY + vOff;
    this.camera.up.set(0, 1, 0);
    this.camera.position.set(camX, camY, camZ);
    this.camera.lookAt(this.rtsFocusX, focusY, this.rtsFocusZ);
  }

  _createFlyHud() {
    const el = document.createElement("div");
    el.id = "fly-hud";
    el.style.cssText = [
      "position:fixed",
      "bottom:20px",
      "right:20px",
      "z-index:6",
      "display:none",
      "pointer-events:none",
      "font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,sans-serif",
      "font-variant-numeric:tabular-nums",
      "-webkit-font-smoothing:antialiased",
      "filter:drop-shadow(0 16px 40px rgba(0,0,0,0.65))",
    ].join(";");
    el.innerHTML = `
      <div style="display:flex;align-items:stretch;gap:0;border-radius:18px;overflow:hidden;background:rgba(6,10,14,0.72);backdrop-filter:blur(14px) saturate(1.2);-webkit-backdrop-filter:blur(14px) saturate(1.2);border:1px solid rgba(120,175,200,0.22);box-shadow:inset 0 1px 0 rgba(255,255,255,0.06),0 0 0 1px rgba(0,0,0,0.35),0 8px 32px rgba(0,0,0,0.4);">
        <div style="display:flex;flex-direction:column;justify-content:space-between;padding:14px 16px 14px 18px;min-width:188px;gap:10px;border-right:1px solid rgba(255,255,255,0.06);">
          <div>
            <div style="font-size:9px;font-weight:600;letter-spacing:0.2em;color:rgba(140,175,195,0.75);text-transform:uppercase;">Indicated airspeed</div>
            <div style="display:flex;align-items:baseline;gap:8px;margin-top:4px;">
              <span id="fly-hud-spd" style="font-size:38px;font-weight:700;line-height:1;color:#f2f8fc;letter-spacing:-0.02em;text-shadow:0 1px 0 rgba(0,0,0,0.45),0 0 24px rgba(100,180,220,0.2);">0</span>
              <span style="font-size:11px;font-weight:500;color:rgba(130,160,180,0.65);">m/s</span>
            </div>
          </div>
          <div style="display:flex;align-items:stretch;gap:0;border-radius:10px;background:rgba(0,0,0,0.22);border:1px solid rgba(255,255,255,0.05);overflow:hidden;">
            <div style="flex:1;padding:8px 10px;text-align:center;">
              <div style="font-size:8px;font-weight:600;letter-spacing:0.16em;color:rgba(130,165,188,0.7);">AGL</div>
              <div style="margin-top:2px;"><span id="fly-hud-alt" style="font-size:19px;font-weight:700;color:#e8f2f8;">0</span><span style="font-size:10px;color:rgba(120,150,170,0.55);">m</span></div>
            </div>
            <div style="width:1px;background:rgba(255,255,255,0.07);flex-shrink:0;"></div>
            <div style="flex:1;padding:8px 10px;text-align:center;">
              <div style="font-size:8px;font-weight:600;letter-spacing:0.16em;color:rgba(130,165,188,0.7);">PITCH</div>
              <div style="margin-top:2px;"><span id="fly-hud-pitch" style="font-size:19px;font-weight:700;color:#e8f2f8;">0</span><span style="font-size:10px;color:rgba(120,150,170,0.55);">°</span></div>
            </div>
            <div style="width:1px;background:rgba(255,255,255,0.07);flex-shrink:0;"></div>
            <div style="flex:1;padding:8px 10px;text-align:center;">
              <div style="font-size:8px;font-weight:600;letter-spacing:0.16em;color:rgba(130,165,188,0.7);">BANK</div>
              <div style="margin-top:2px;"><span id="fly-hud-bank" style="font-size:19px;font-weight:700;color:#e8f2f8;">0</span><span style="font-size:10px;color:rgba(120,150,170,0.55);">°</span></div>
            </div>
          </div>
          <div id="fly-hud-level-hint" style="align-self:flex-end;font-size:8px;font-weight:600;letter-spacing:0.18em;padding:5px 11px;border-radius:999px;opacity:0;transition:opacity 0.22s ease;color:rgba(185,245,215,0.95);background:rgba(45,120,85,0.35);border:1px solid rgba(100,200,150,0.35);text-transform:uppercase;">Wings level</div>
          <div>
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:5px;">
              <span style="font-size:8px;font-weight:600;letter-spacing:0.18em;color:rgba(200,155,115,0.85);text-transform:uppercase;">Thrust reserve</span>
              <span id="fly-hud-nitro-pct" style="font-size:10px;font-weight:700;color:rgba(255,220,185,0.95);">100%</span>
            </div>
            <div style="height:6px;border-radius:999px;overflow:hidden;background:rgba(0,0,0,0.35);box-shadow:inset 0 1px 2px rgba(0,0,0,0.5);">
              <div id="fly-hud-nitro-bar" style="width:100%;height:100%;border-radius:999px;background:linear-gradient(90deg,#c45a28,#e8a060);box-shadow:0 0 12px rgba(230,140,70,0.35);"></div>
            </div>
          </div>
        </div>
        <div style="padding:12px 14px 12px 10px;display:flex;align-items:center;justify-content:center;background:linear-gradient(180deg,rgba(255,255,255,0.03),transparent);">
          <div style="position:relative;width:124px;height:124px;border-radius:50%;padding:3px;background:linear-gradient(145deg,rgba(90,110,125,0.5),rgba(20,28,36,0.9));box-shadow:inset 0 1px 0 rgba(255,255,255,0.12),0 4px 16px rgba(0,0,0,0.35);">
            <div style="position:relative;width:100%;height:100%;border-radius:50%;overflow:hidden;background:#030608;box-shadow:inset 0 0 0 1px rgba(0,0,0,0.6);">
              <div id="fly-hud-horizon-layer" style="position:absolute;left:50%;top:50%;width:260%;height:260%;margin-left:-130%;margin-top:-130%;transform:rotate(0deg);background:radial-gradient(ellipse 55% 42% at 50% 18%,rgba(180,220,255,0.35) 0%,transparent 55%),linear-gradient(180deg,#0d2844 0%,#1e5078 32%,#4e8eb8 47%,#7ab8cf 49.2%,#c9a06a 50.2%,#6d5a42 51.5%,#2a241c 100%);"></div>
              <div style="position:absolute;inset:0;border-radius:50%;pointer-events:none;box-shadow:inset 0 0 36px rgba(0,0,0,0.55);"></div>
              <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;">
                <div style="display:flex;align-items:center;gap:0;">
                  <div style="width:22px;height:3px;border-radius:2px 0 0 2px;background:linear-gradient(90deg,rgba(255,255,255,0.08),rgba(255,250,235,0.95));box-shadow:-1px 0 6px rgba(255,255,255,0.25);"></div>
                  <div style="width:5px;height:5px;border-radius:50%;background:#f8fafc;box-shadow:0 0 6px rgba(255,255,255,0.5);"></div>
                  <div style="width:22px;height:3px;border-radius:0 2px 2px 0;background:linear-gradient(90deg,rgba(255,250,235,0.95),rgba(255,255,255,0.08));box-shadow:1px 0 6px rgba(255,255,255,0.25);"></div>
                </div>
              </div>
              <div style="position:absolute;top:8px;left:0;right:0;text-align:center;font-size:7px;font-weight:600;letter-spacing:0.24em;color:rgba(160,195,215,0.55);text-transform:uppercase;">Horizon</div>
            </div>
          </div>
        </div>
      </div>`;
    document.body.appendChild(el);
    this._flyHud = el;
    this._flyHudSpd = el.querySelector("#fly-hud-spd");
    this._flyHudAlt = el.querySelector("#fly-hud-alt");
    this._flyHudPitch = el.querySelector("#fly-hud-pitch");
    this._flyHudBank = el.querySelector("#fly-hud-bank");
    this._flyHudHorizonLayer = el.querySelector("#fly-hud-horizon-layer");
    this._flyHudNitroPct = el.querySelector("#fly-hud-nitro-pct");
    this._flyHudNitroBar = el.querySelector("#fly-hud-nitro-bar");
    this._flyHudLevelHint = el.querySelector("#fly-hud-level-hint");
  }

  _createCarHud() {
    /* Legacy rectangular HUD — still mounted so SHOW_LEGACY_CAR_HUD_RECT can re-enable it without rebuilding. */
    const el = document.createElement("div");
    el.id = "car-hud";
    el.style.cssText =
      "position:fixed;bottom:18px;left:50%;transform:translateX(-50%);" +
      "background:linear-gradient(180deg,rgba(15,19,28,0.9),rgba(8,10,16,0.86));" +
      "border:1px solid rgba(120,160,220,0.35);border-radius:12px;" +
      "padding:10px 16px 12px;min-width:330px;z-index:5;display:none;pointer-events:none;" +
      "box-shadow:0 10px 30px rgba(0,0,0,0.45),inset 0 1px 0 rgba(255,255,255,0.06);" +
      "font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,sans-serif;";
    el.innerHTML = `
      <div style="display:flex;align-items:flex-end;justify-content:space-between;gap:14px;">
        <div style="display:flex;flex-direction:column;gap:2px;">
          <div style="font-size:11px;letter-spacing:1.5px;color:#9db2d3;">SPEED</div>
          <div style="display:flex;align-items:flex-end;gap:8px;">
            <span id="car-hud-spd" style="font-size:44px;line-height:1;font-weight:800;color:#eaf2ff;text-shadow:0 0 16px rgba(116,176,255,0.3);">0</span>
            <span style="font-size:13px;color:#9db2d3;padding-bottom:5px;letter-spacing:1px;">KM/H</span>
          </div>
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:5px;min-width:110px;">
          <div style="font-size:11px;letter-spacing:1.2px;color:#9db2d3;">DRIFT ANGLE</div>
          <div><span id="car-hud-angle" style="font-size:24px;font-weight:700;color:#ff8a5c;">0</span><span style="font-size:14px;color:#ffb293;">°</span></div>
        </div>
      </div>
      <div style="margin-top:9px;display:flex;align-items:center;gap:10px;">
        <span style="font-size:11px;letter-spacing:1.2px;color:#8ed8ff;min-width:42px;">NITRO</span>
        <div style="flex:1;height:8px;background:rgba(120,150,190,0.22);border-radius:999px;overflow:hidden;">
          <div id="car-hud-nitro-bar" style="width:100%;height:100%;background:linear-gradient(90deg,#36c2ff,#7de8ff);box-shadow:0 0 12px rgba(94,220,255,0.55);"></div>
        </div>
        <span id="car-hud-nitro" style="font-size:12px;color:#9ee8ff;min-width:40px;text-align:right;">100%</span>
      </div>
    `;
    document.body.appendChild(el);
    this._carHud = el;
    this._carHudSpd = el.querySelector("#car-hud-spd");
    this._carHudAngle = el.querySelector("#car-hud-angle");
    this._carHudNitro = el.querySelector("#car-hud-nitro");
    this._carHudNitroBar = el.querySelector("#car-hud-nitro-bar");
  }

  _createCarSpeedometer() {
    const size = 200;
    const el = document.createElement("div");
    el.id = "car-speedometer";
    el.style.cssText = `
      position: fixed;
      bottom: 20px;
      right: 20px;
      width: ${size}px;
      height: ${size}px;
      z-index: 6;
      display: none;
      pointer-events: none;
      font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
    `;

    const maxSpeed = 280;
    const startAngle = 135;
    const endAngle = 405;
    const tickCount = 15;

    let ticksHtml = "";
    let labelsHtml = "";
    for (let i = 0; i <= tickCount; i++) {
      const speed = (i / tickCount) * maxSpeed;
      const angle = startAngle + (i / tickCount) * (endAngle - startAngle);
      const rad = (angle * Math.PI) / 180;
      const cx = size / 2;
      const cy = size / 2;
      const innerR = size * 0.36;
      const outerR = size * 0.42;
      const labelR = size * 0.29;

      const x1 = cx + Math.cos(rad) * innerR;
      const y1 = cy + Math.sin(rad) * innerR;
      const x2 = cx + Math.cos(rad) * outerR;
      const y2 = cy + Math.sin(rad) * outerR;
      const lx = cx + Math.cos(rad) * labelR;
      const ly = cy + Math.sin(rad) * labelR;

      const isMajor = i % 3 === 0;
      const tickColor = speed > 220 ? "#ff4444" : "#ffffff";
      const tickWidth = isMajor ? 3 : 1.5;
      const tickOpacity = isMajor ? 0.9 : 0.4;

      ticksHtml += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" 
        stroke="${tickColor}" stroke-width="${tickWidth}" opacity="${tickOpacity}" stroke-linecap="round"/>`;

      if (isMajor) {
        const labelColor = speed > 220 ? "#ff6666" : "#aabbcc";
        labelsHtml += `<text x="${lx}" y="${ly}" fill="${labelColor}" font-size="11" 
          font-weight="600" text-anchor="middle" dominant-baseline="middle">${Math.round(speed)}</text>`;
      }
    }

    el.innerHTML = `
      <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" style="position:absolute;top:0;left:0;">
        <defs>
          <radialGradient id="speedoBg" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stop-color="#1a2233"/>
            <stop offset="70%" stop-color="#0d1219"/>
            <stop offset="100%" stop-color="#060a0f"/>
          </radialGradient>
          <linearGradient id="rpmGrad" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stop-color="#00aaff"/>
            <stop offset="50%" stop-color="#00ff88"/>
            <stop offset="80%" stop-color="#ffaa00"/>
            <stop offset="100%" stop-color="#ff3333"/>
          </linearGradient>
          <filter id="needleGlow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="3" result="blur"/>
            <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
          </filter>
          <filter id="outerGlow" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="8" result="blur"/>
            <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
          </filter>
        </defs>
        
        <!-- Outer ring glow -->
        <circle cx="${size / 2}" cy="${size / 2}" r="${size * 0.48}" fill="none" stroke="rgba(0,170,255,0.15)" stroke-width="4" filter="url(#outerGlow)"/>
        
        <!-- Background -->
        <circle cx="${size / 2}" cy="${size / 2}" r="${size * 0.46}" fill="url(#speedoBg)" stroke="rgba(100,140,180,0.3)" stroke-width="2"/>
        
        <!-- Speed arc background -->
        <circle cx="${size / 2}" cy="${size / 2}" r="${size * 0.39}" fill="none" stroke="rgba(255,255,255,0.05)" stroke-width="8"
          stroke-dasharray="${size * 2.45 * 0.75} ${size * 2.45}" stroke-dashoffset="${-size * 2.45 * 0.125}"
          transform="rotate(0 ${size / 2} ${size / 2})"/>
        
        <!-- Ticks -->
        ${ticksHtml}
        
        <!-- Labels -->
        ${labelsHtml}
        
        <!-- RPM arc background -->
        <path id="rpm-arc-bg" d="M ${size * 0.25} ${size * 0.72} A ${size * 0.22} ${size * 0.22} 0 0 1 ${size * 0.75} ${size * 0.72}"
          fill="none" stroke="rgba(255,255,255,0.1)" stroke-width="6" stroke-linecap="round"/>
        
        <!-- RPM arc fill -->
        <path id="speedo-rpm-bar" d="M ${size * 0.25} ${size * 0.72} A ${size * 0.22} ${size * 0.22} 0 0 1 ${size * 0.75} ${size * 0.72}"
          fill="none" stroke="url(#rpmGrad)" stroke-width="6" stroke-linecap="round"
          stroke-dasharray="0 999"/>
        
        <!-- Center decorative rings -->
        <circle cx="${size / 2}" cy="${size / 2}" r="${size * 0.15}" fill="rgba(20,30,45,0.9)" stroke="rgba(100,150,200,0.3)" stroke-width="1"/>
        <circle cx="${size / 2}" cy="${size / 2}" r="${size * 0.08}" fill="rgba(40,60,90,0.8)" stroke="rgba(150,200,255,0.2)" stroke-width="1"/>
        
        <!-- Needle (polygon points up = 270° in same convention as tick angles; rotate by tickAngle − 270) -->
        <g id="speedo-needle" transform="rotate(${startAngle - 270} ${size / 2} ${size / 2})" filter="url(#needleGlow)">
          <polygon points="${size / 2},${size * 0.18} ${size / 2 - 4},${size / 2} ${size / 2 + 4},${size / 2}" 
            fill="#ff3333" stroke="#ff6666" stroke-width="0.5"/>
          <circle cx="${size / 2}" cy="${size / 2}" r="6" fill="#222" stroke="#ff4444" stroke-width="2"/>
        </g>
      </svg>
      
      <!-- Digital speed display -->
      <div style="position:absolute;top:58%;left:50%;transform:translate(-50%,-50%);text-align:center;">
        <div id="speedo-digital" style="font-size:32px;font-weight:800;color:#fff;text-shadow:0 0 20px rgba(0,170,255,0.6);letter-spacing:-1px;">0</div>
        <div style="font-size:10px;color:#6688aa;letter-spacing:2px;margin-top:-2px;">KM/H</div>
      </div>
      
      <!-- Gear indicator -->
      <div style="position:absolute;bottom:12%;left:50%;transform:translateX(-50%);text-align:center;">
        <div style="font-size:9px;color:#556677;letter-spacing:1px;">GEAR</div>
        <div id="speedo-gear" style="font-size:22px;font-weight:700;color:#00ddff;text-shadow:0 0 12px rgba(0,220,255,0.5);">N</div>
      </div>
      
      <!-- N2O: label + compact refill/drain bar (no % — saves space) -->
      <div style="position:absolute;top:9%;left:50%;transform:translateX(-50%);width:58px;text-align:center;">
        <div style="font-size:10px;font-weight:700;color:#36c2ff;text-shadow:0 0 8px rgba(54,194,255,0.55);letter-spacing:0.4px;">N2O</div>
        <div style="margin-top:3px;height:4px;background:rgba(120,150,190,0.28);border-radius:999px;overflow:hidden;">
          <div id="speedo-nitro-fill" style="width:100%;height:100%;border-radius:999px;background:linear-gradient(90deg,#36c2ff,#7de8ff);box-shadow:0 0 8px rgba(94,220,255,0.45);"></div>
        </div>
      </div>
    `;

    document.body.appendChild(el);
    this._carSpeedometer = el;
    this._speedoNeedle = el.querySelector("#speedo-needle");
    this._speedoDigital = el.querySelector("#speedo-digital");
    this._speedoRpmBar = el.querySelector("#speedo-rpm-bar");
    this._speedoGear = el.querySelector("#speedo-gear");
    this._speedoNitroFill = el.querySelector("#speedo-nitro-fill");
  }

  async _loadCar() {
    try {
      const gltf = await new Promise((resolve, reject) => {
        getSharedGltfLoader().load(
          `${CAR_MODEL}?v=bruno-v2`,
          resolve,
          undefined,
          reject,
        );
      });
      const src = gltf.scene;
      let chassisSrc = null;
      let wheelSrc = null;
      src.traverse((o) => {
        if (!chassisSrc && /^chassis(\.|\d|$)/.test(o.name)) chassisSrc = o;
        if (!wheelSrc && /^wheelContainer(\.|\d|$)/.test(o.name)) wheelSrc = o;
      });
      if (!chassisSrc || !wheelSrc) {
        console.warn(
          "[V2] bruno.glb missing chassis/wheelContainer nodes; falling back to raw scene.",
        );
        if (!chassisSrc) chassisSrc = src;
        if (!wheelSrc) wheelSrc = src.clone(true);
      }

      const chassisVisual = chassisSrc.clone(true);
      chassisVisual.position.set(0, 0, 0);
      chassisVisual.rotation.set(0, CAR_MODEL_YAW, 0);
      chassisVisual.scale.setScalar(1);
      const strays = [];
      chassisVisual.traverse((o) => {
        if (/^wheelContainer(\.|\d|$)/.test(o.name)) strays.push(o);
        if (o.isMesh || o.isSkinnedMesh) {
          o.castShadow = true;
          o.receiveShadow = true;
        }
      });
      strays.forEach((s) => s.parent?.remove(s));

      this.carChassis = new THREE.Group();
      this.carChassis.rotation.order = "YXZ";
      this.carChassis.add(chassisVisual);

      this.carRoot = new THREE.Group();
      this.carRoot.rotation.order = "YXZ";
      this.carRoot.scale.setScalar(CAR_MODEL_SCALE);
      this.carRoot.add(this.carChassis);
      this.carRoot.visible = false;
      this.scene.add(this.carRoot);
      if (this._excludeFromReflection)
        this._excludeFromReflection(this.carRoot);

      const hw = CAR_WHEEL_BASE * 0.5;
      const ht = CAR_TRACK * 0.5;
      const wheelOffsets = [
        { x: -ht, z: -hw, steer: true, name: "FL" },
        { x: ht, z: -hw, steer: true, name: "FR" },
        { x: -ht, z: hw, steer: false, name: "RL" },
        { x: ht, z: hw, steer: false, name: "RR" },
      ];
      this.carWheels = wheelOffsets.map((w) => {
        const container = wheelSrc.clone(true);
        container.position.set(w.x, -CAR_RIDE_HEIGHT, w.z);
        const isLeft = w.x < 0;
        container.rotation.set(0, CAR_MODEL_YAW + (isLeft ? Math.PI : 0), 0);
        let suspension = null;
        let cylinder = null;
        container.traverse((c) => {
          if (!suspension && /^wheelSuspension(\.|\d|$)/.test(c.name))
            suspension = c;
          if (!cylinder && /^wheelCylinder(\.|\d|$)/.test(c.name)) cylinder = c;
          if (c.isMesh || c.isSkinnedMesh) {
            c.castShadow = true;
            c.receiveShadow = true;
          }
        });
        // Wheels on carChassis so they tilt with body pitch/roll (like Bruno Simon's folio)
        this.carChassis.add(container);
        return {
          container,
          suspension: suspension || container,
          cylinder: cylinder || container,
          offset: new THREE.Vector3(w.x, 0, w.z),
          steer: w.steer,
          isLeft,
          name: w.name,
          contactWorld: new THREE.Vector3(),
        };
      });

      this.carLoaded = true;
      if (this.active && this.moveMode === "car") {
        this.carRoot.visible = true;
        this.capsule.visible = false;
      }

      // Debug wireframe mode for Bruno
      this._carDebugWire = false;
      if (this._carDebugWire) {
        chassisVisual.visible = false;
        const bodyGeo = new THREE.BoxGeometry(
          CAR_TRACK * 2,
          CAR_BODY_HEIGHT,
          CAR_WHEEL_BASE * 2,
        );
        const bodyWire = new THREE.Mesh(
          bodyGeo,
          new THREE.MeshBasicMaterial({ color: 0x00ff88, wireframe: true }),
        );
        bodyWire.position.y = CAR_RIDE_HEIGHT + CAR_BODY_HEIGHT * 0.5;
        bodyWire.rotation.y = CAR_MODEL_YAW;
        this.carChassis.add(bodyWire);
        this._carDebugBody = bodyWire;

        // Ground contact dots
        this._carDebugContactDots = [];
        const dotGeo = new THREE.SphereGeometry(0.08, 6, 4);
        const dotMat = new THREE.MeshBasicMaterial({ color: 0xffff00 });
        for (let i = 0; i < 4; i++) {
          const dot = new THREE.Mesh(dotGeo, dotMat);
          this.scene.add(dot);
          this._carDebugContactDots.push(dot);
        }
      }

      console.log(
        "[V2] Bruno car loaded, wheels:",
        this.carWheels.map((w) => w.name).join(", "),
      );
    } catch (err) {
      console.warn("[V2] Failed to load car model:", err);
    }
  }

  async _loadLotus() {
    try {
      const gltf = await new Promise((resolve, reject) => {
        getSharedGltfLoader().load(
          `${LOTUS_MODEL}?v=lotus-v1`,
          resolve,
          undefined,
          reject,
        );
      });
      const src = gltf.scene;
      let chassisSrc = null;
      let wheelSrc = null;
      src.traverse((o) => {
        if (!chassisSrc && /^chassis(\.|\d|$)/.test(o.name)) chassisSrc = o;
        if (!wheelSrc && /^wheelContainer(\.|\d|$)/.test(o.name)) wheelSrc = o;
      });
      if (!chassisSrc || !wheelSrc) {
        console.warn(
          "[V2] lotusclaude2.glb missing chassis/wheelContainer nodes; fallback.",
        );
        if (!chassisSrc) chassisSrc = src;
        if (!wheelSrc) wheelSrc = src.clone(true);
      }

      const chassisVisual = chassisSrc.clone(true);
      chassisVisual.position.set(0, 0, 0);
      chassisVisual.rotation.set(0, CAR_MODEL_YAW, 0);
      chassisVisual.scale.setScalar(1);
      const strays = [];
      chassisVisual.traverse((o) => {
        if (/^wheelContainer(\.|\d|$)/.test(o.name)) strays.push(o);
        if (o.isMesh || o.isSkinnedMesh) {
          o.castShadow = true;
          o.receiveShadow = true;
        }
      });
      strays.forEach((s) => s.parent?.remove(s));

      // Setup emissive lights on headlights, taillights, brake lights (split left/right for blinkers)
      this._lotusLightMeshes = {
        headlights: [],
        taillightLeft: [],
        taillightRight: [],
        brakeLeft: [],
        brakeRight: [],
      };
      chassisVisual.traverse((o) => {
        if (!o.isMesh) return;
        const n = o.name;
        if (/HEADLIGHT_LENS/i.test(n)) {
          this._lotusLightMeshes.headlights.push(o);
          if (o.material) {
            o.material = o.material.clone();
            o.material.emissive = new THREE.Color(1.0, 0.95, 0.8);
            o.material.emissiveIntensity = 4;
          }
        } else if (/TAILLIGHT_LENS/i.test(n)) {
          const isLeft = /_LEFT/i.test(n);
          (isLeft
            ? this._lotusLightMeshes.taillightLeft
            : this._lotusLightMeshes.taillightRight
          ).push(o);
          if (o.material) {
            o.material = o.material.clone();
            o.material.emissive = new THREE.Color(1.0, 0.05, 0.02);
            o.material.emissiveIntensity = 2;
          }
        } else if (/BRAKES_/i.test(n)) {
          const isLeft = /_LEFT/i.test(n);
          (isLeft
            ? this._lotusLightMeshes.brakeLeft
            : this._lotusLightMeshes.brakeRight
          ).push(o);
          if (o.material) {
            o.material = o.material.clone();
            o.material.emissive = new THREE.Color(1.0, 0.0, 0.0);
            o.material.emissiveIntensity = 2;
          }
        }
      });

      this.lotusChassis = new THREE.Group();
      this.lotusChassis.rotation.order = "YXZ";
      this.lotusChassis.add(chassisVisual);

      chassisVisual.updateMatrixWorld(true);
      const cBox = new THREE.Box3().setFromObject(chassisVisual);
      const cSize = new THREE.Vector3();
      const cCenter = new THREE.Vector3();
      cBox.getSize(cSize);
      cBox.getCenter(cCenter);
      this._lotusChassisMetrics = { cSize, cCenter, cMinY: cBox.min.y };

      const halfTrack = cSize.z * 0.459;
      const halfWB = cSize.x * 0.287;
      const wheelYOff = cBox.min.y + cSize.y * 0.23;
      const wbShift = cSize.x * -0.024;
      this._lotusChassisVisual = chassisVisual;

      const layout = [
        { x: halfWB + wbShift, z: -halfTrack, steer: true, name: "FL" },
        { x: halfWB + wbShift, z: halfTrack, steer: true, name: "FR" },
        { x: -halfWB + wbShift, z: -halfTrack, steer: false, name: "RL" },
        { x: -halfWB + wbShift, z: halfTrack, steer: false, name: "RR" },
      ];

      this.lotusWheels = layout.map((w) => {
        const container = wheelSrc.clone(true);
        // Hub XZ must match `offset` exactly: suspension + drift use `offset` only (Bruno hubs sit on origin).
        container.position.set(cCenter.x + w.x, wheelYOff, cCenter.z + w.z);
        const isLeft = w.z < 0;
        container.rotation.set(0, CAR_MODEL_YAW + (isLeft ? 0 : Math.PI), 0);
        let suspension = null;
        let cylinder = null;
        container.traverse((c) => {
          if (!suspension && /^wheelSuspension(\.|\d|$)/.test(c.name))
            suspension = c;
          if (!cylinder && /^wheelCylinder(\.|\d|$)/.test(c.name)) cylinder = c;
          if (c.isMesh || c.isSkinnedMesh) {
            c.castShadow = true;
            c.receiveShadow = true;
          }
        });
        this.lotusChassis.add(container);
        return {
          container,
          suspension: suspension || container,
          cylinder: cylinder || container,
          offset: new THREE.Vector3(cCenter.x + w.x, 0, cCenter.z + w.z),
          steer: w.steer,
          isLeft,
          name: w.name,
          contactWorld: new THREE.Vector3(),
        };
      });

      this.lotusRoot = new THREE.Group();
      this.lotusRoot.rotation.order = "YXZ";
      this.lotusRoot.scale.setScalar(CAR_MODEL_SCALE);
      this.lotusRoot.add(this.lotusChassis);

      // Headlight ground spill (warm white, front of car)
      const headlightGlow = new THREE.PointLight(0xfff5e0, 2.5, 8, 1.5);
      headlightGlow.position.set(
        cCenter.x + cSize.x * 0.45,
        cCenter.y + chassisVisual.position.y,
        cCenter.z,
      );
      this.lotusChassis.add(headlightGlow);

      // Taillight ground spill (red, rear of car)
      const taillightGlow = new THREE.PointLight(0xff1a00, 1.8, 5, 1.5);
      taillightGlow.position.set(
        cCenter.x - cSize.x * 0.45,
        cCenter.y + chassisVisual.position.y,
        cCenter.z,
      );
      this.lotusChassis.add(taillightGlow);
      this._lotusTaillightGlow = taillightGlow;

      this.lotusRoot.visible = false;
      this.scene.add(this.lotusRoot);
      if (this._excludeFromReflection)
        this._excludeFromReflection(this.lotusRoot);

      // Normalize footprint to match Bruno's visual size
      this.lotusRoot.position.set(0, 0, 0);
      this.lotusRoot.updateMatrixWorld(true);
      const fitBox = new THREE.Box3().setFromObject(this.lotusRoot, true);
      const fitSize = new THREE.Vector3();
      fitBox.getSize(fitSize);
      const footprint = Math.max(fitSize.x, fitSize.z, 0.001);
      const TARGET_FOOTPRINT = 5.5;
      const normalize = TARGET_FOOTPRINT / footprint;
      if (Number.isFinite(normalize) && normalize > 0.08 && normalize < 200) {
        this.lotusRoot.scale.multiplyScalar(normalize);
      }

      // Compute ground offset once (avoids per-frame AABB which churns WebGPU render targets)
      this.lotusRoot.updateMatrixWorld(true);
      const groundBox = new THREE.Box3().setFromObject(this.lotusRoot, true);
      this._lotusGroundOffset = -groundBox.min.y;

      this.lotusLoaded = true;
      this._lotusWheelHubLocalY = wheelYOff;
      if (this.active && this.moveMode === "lotus") {
        this.lotusRoot.visible = true;
        this.capsule.visible = false;
      }
      console.log(
        "[V2] Lotus car loaded, wheels:",
        this.lotusWheels.map((w) => w.name).join(", "),
      );
    } catch (err) {
      console.warn("[V2] Failed to load Lotus model:", err);
    }
  }

  // ============================================================
  // === VVV CAR (rigid-body) — visual setup + per-frame update
  // ============================================================
  /** Empty root; chassis + wheels loaded from `lotusrealsize2.glb` in `_loadVvvCarVisuals`. */
  _setupVvvCar() {
    const root = new THREE.Group();
    root.rotation.order = "YXZ";
    root.visible = false;
    const pivot = new THREE.Group();
    root.add(pivot);

    this.scene.add(root);
    this.vvvRoot = root;
    this.vvvChassisPivot = pivot;
    this.vvvChassisMesh = null;
    this.vvvLoaded = true;
    this._setupVvvForceArrows();
  }

  /**
   * Hub layout + physics chassis dims from lotusrealsize2 chassis AABB (real scale, +Z fwd).
   * Same coefficients as playMode `_loadLotus`, but X/Z swapped because VVV skips CAR_MODEL_YAW.
   */
  _applyVvvLayoutFromChassisMetrics({ cSize, cCenter, cMinY }) {
    const halfTrack = Math.max(0.35, cSize.x * 0.459 - VVV_HUB_TRACK_INSET);
    const halfWB = cSize.z * 0.287;
    const wbShift = cSize.z * -0.024;
    const hubY = cMinY + cSize.y * 0.23 - cCenter.y;

    const specs = [
      { name: "FL", x: -halfTrack, z: halfWB + wbShift, steer: true },
      { name: "FR", x: halfTrack, z: halfWB + wbShift, steer: true },
      { name: "RL", x: -halfTrack, z: -halfWB + wbShift, steer: false },
      { name: "RR", x: halfTrack, z: -halfWB + wbShift, steer: false },
    ];

    this._vvvHubBase = specs.map((s) => ({
      name: s.name,
      steer: s.steer,
      x: s.x,
      y: hubY,
      z: s.z,
    }));
    this._applyVvvComToWheelLayout();

    const C = this._vvvChassis;
    C.width = cSize.x;
    C.height = cSize.y;
    C.length = cSize.z;
    this._vvvBody.rebuildInertia({ mass: C.mass, size: C });
    this._vvvWallProbes = createDefaultVvvWallProbes(C);

    return { halfTrack, halfWB, hubY, wbShift };
  }

  /** Rebuild hub `localPos` from `_vvvHubBase` + `comLower` (CoM below mesh center). */
  _applyVvvComToWheelLayout() {
    if (!this._vvvHubBase || this._vvvHubBase.length !== 4) return;
    const drop = this._vvvChassis.comLower ?? 0;
    for (let i = 0; i < 4; i++) {
      const b = this._vvvHubBase[i];
      const cfg = this._vvvLayout[i];
      cfg.name = b.name;
      cfg.steer = b.steer;
      cfg.pos.set(b.x, b.y + drop, b.z);
      this._vvvTires[i].localPos.copy(cfg.pos);
      this._vvvTires[i].canSteer = b.steer;
      this._vvvTires[i].name = b.name;
      const w = this.vvvWheels?.[i];
      if (w) w.hubLocal.copy(cfg.pos);
    }
    this._rederiveVvvTireTuning();
  }

  /** Spring rest length / ray range from measured hubs + tyre radius.
   *  Uses standalone gravity (9.81) — keeping the original spring/damper tune. */
  _rederiveVvvTireTuning() {
    const hubLocalY = this._vvvLayout[0]?.pos.y ?? -0.1;
    Object.assign(
      this._vvvTire,
      deriveVvvTireFromVehicle({
        mass: this._vvvChassis.mass,
        wheelRadius: this._vvvWheel.radius,
        hubLocalY,
        gravity: VVV_GRAVITY,
      }),
    );
  }

  /** Per-wheel force arrows: suspension (green), steering (blue), drive (red). */
  _setupVvvForceArrows() {
    const group = new THREE.Group();
    group.visible = false;
    this.scene.add(group);
    this._vvvArrowGroup = group;
    this._vvvForceArrows = this._vvvTires.map(() => {
      const up = new THREE.ArrowHelper(
        new THREE.Vector3(0, 1, 0),
        new THREE.Vector3(),
        0.1,
        0x60ff80,
        0.18,
        0.1,
      );
      const side = new THREE.ArrowHelper(
        new THREE.Vector3(1, 0, 0),
        new THREE.Vector3(),
        0.1,
        0x4090ff,
        0.18,
        0.1,
      );
      const fwd = new THREE.ArrowHelper(
        new THREE.Vector3(0, 0, 1),
        new THREE.Vector3(),
        0.1,
        0xff5060,
        0.18,
        0.1,
      );
      group.add(up, side, fwd);
      return { up, side, fwd };
    });
  }

  _placeVvvForceArrow(arrow, origin, force) {
    const mag = force.length();
    if (mag < 1e-3) {
      arrow.setLength(0.001, 0.001, 0.001);
      return;
    }
    _vvvArrowDir.copy(force).normalize();
    arrow.position.copy(origin);
    arrow.setDirection(_vvvArrowDir);
    const scale = this._vvvVis.arrowScale;
    const visLen = Math.min(3.5, mag * scale);
    arrow.setLength(
      visLen,
      Math.min(0.25, visLen * 0.18),
      Math.min(0.16, visLen * 0.12),
    );
  }

  /** wheelContainer origin ≠ hub; same fix as lotus-circuit-parkour.html. */
  _measureVvvWheelHubOffset(wheelSrc) {
    const hubOff = new THREE.Vector3();
    const probe = wheelSrc.clone(true);
    probe.position.set(0, 0, 0);
    probe.rotation.set(0, 0, 0);
    probe.scale.set(1, 1, 1);
    probe.updateMatrixWorld(true);
    let cyl = null;
    probe.traverse((c) => {
      if (!cyl && /^wheelCylinder(\.|\d|$)/.test(c.name)) cyl = c;
    });
    if (!cyl) {
      probe.traverse((c) => {
        if (!cyl && c.isMesh && /TYRE|TIRE/i.test(c.name)) cyl = c;
      });
    }
    if (cyl) {
      new THREE.Box3().setFromObject(cyl).getCenter(hubOff);
    }
    return hubOff;
  }

  _findVvvWheelCylinder(container) {
    let cylinder = null;
    container.traverse((c) => {
      if (!cylinder && /^wheelCylinder(\.|\d|$)/.test(c.name)) cylinder = c;
      if (!cylinder && c.isMesh && /TYRE|TIRE/i.test(c.name)) cylinder = c;
    });
    return cylinder;
  }

  _scaleVvvWheelContainer(container, targetRadius) {
    container.updateMatrixWorld(true);
    const cylinder = this._findVvvWheelCylinder(container);
    if (!cylinder) return null;
    const _box = new THREE.Box3().setFromObject(cylinder);
    const _size = new THREE.Vector3();
    _box.getSize(_size);
    const meshR = Math.max(_size.y, _size.z) * 0.5;
    const s = targetRadius / Math.max(meshR, 0.01);
    container.scale.setScalar(s);
    return cylinder;
  }

  /** Wheel on `vvvRoot` at measured hub; container keeps fixed Lotus rim facing. */
  _attachVvvWheelVisual(container, cylinder, cfg, lotusLeft, hubLocal) {
    container.visible = true;
    container.traverse((o) => {
      if (o.isMesh || o.isSkinnedMesh) o.visible = true;
    });
    container.position.copy(hubLocal);
    this.vvvRoot.add(container);
    return {
      container,
      cylinder: cylinder || container,
      hubLocal: hubLocal.clone(),
      isLeft: lotusLeft,
      steer: cfg.steer,
      name: cfg.name,
    };
  }

  /** Chassis + four wheels from lotusrealsize2.glb (real scale, matched layout). */
  async _loadVvvCarVisuals() {
    try {
      const gltf = await new Promise((resolve, reject) => {
        getSharedGltfLoader().load(
          `${VVV_WHEEL_GLB}?v=vvv-realsize-chassis`,
          resolve,
          undefined,
          reject,
        );
      });
      let chassisSrc = null;
      let wheelSrc = null;
      gltf.scene.traverse((o) => {
        if (!chassisSrc && /^chassis(\.|\d|$)/.test(o.name)) chassisSrc = o;
        if (!wheelSrc && /^wheelContainer(\.|\d|$)/.test(o.name)) wheelSrc = o;
      });
      if (!chassisSrc || !wheelSrc) {
        console.warn(
          "[V2] VVV lotusrealsize2: missing chassis/wheelContainer in",
          VVV_WHEEL_GLB,
        );
        return;
      }

      const chassisVisual = chassisSrc.clone(true);
      chassisVisual.position.set(0, 0, 0);
      chassisVisual.rotation.set(0, 0, 0);
      chassisVisual.scale.setScalar(1);
      const strays = [];
      chassisVisual.traverse((o) => {
        if (/^wheelContainer(\.|\d|$)/.test(o.name)) strays.push(o);
        if (o.isMesh || o.isSkinnedMesh) {
          o.castShadow = true;
          o.receiveShadow = true;
        }
      });
      strays.forEach((s) => s.parent?.remove(s));

      chassisVisual.updateMatrixWorld(true);
      const cBox = new THREE.Box3().setFromObject(chassisVisual);
      const cSize = new THREE.Vector3();
      const cCenter = new THREE.Vector3();
      cBox.getSize(cSize);
      cBox.getCenter(cCenter);
      chassisVisual.position.set(-cCenter.x, -cCenter.y, -cCenter.z);
      this.vvvChassisPivot.add(chassisVisual);
      this.vvvChassisMesh = chassisVisual;
      if (this._excludeFromReflection)
        this._excludeFromReflection(this.vvvRoot);

      this._applyVvvLayoutFromChassisMetrics({
        cSize,
        cCenter,
        cMinY: cBox.min.y,
      });

      const hubOff = this._measureVvvWheelHubOffset(wheelSrc);
      const W = this._vvvWheel;
      const nativeProbe = wheelSrc.clone(true);
      nativeProbe.traverse((c) => {
        if (c.isMesh || c.isSkinnedMesh) c.position.sub(hubOff);
      });
      nativeProbe.updateMatrixWorld(true);
      const nativeCyl = this._findVvvWheelCylinder(nativeProbe);
      if (nativeCyl) {
        const _box = new THREE.Box3().setFromObject(nativeCyl);
        const _sz = new THREE.Vector3();
        _box.getSize(_sz);
        const meshR = Math.max(_sz.y, _sz.z) * 0.5;
        if (meshR > 0.1) W.radius = meshR;
      }

      this._rederiveVvvTireTuning();

      this.vvvWheels = this._vvvLayout.map((cfg) => {
        const container = wheelSrc.clone(true);
        const lotusLeft = cfg.name === "FL" || cfg.name === "RL";
        container.rotation.set(0, lotusLeft ? Math.PI : 0, 0);
        container.traverse((c) => {
          if (c.isMesh || c.isSkinnedMesh) {
            c.position.sub(hubOff);
            c.castShadow = true;
            c.receiveShadow = true;
          }
        });
        const cylinder = this._scaleVvvWheelContainer(container, W.radius);
        return this._attachVvvWheelVisual(
          container,
          cylinder,
          cfg,
          lotusLeft,
          cfg.pos,
        );
      });

      this.vvvWheelsLoaded = this.vvvWheels.length === 4;
      if (this.vvvWheelsLoaded) {
        console.log(
          "[V2] VVV lotusrealsize2 loaded — chassis",
          cSize.x.toFixed(2),
          "×",
          cSize.y.toFixed(2),
          "×",
          cSize.z.toFixed(2),
          "m, wheel R",
          W.radius.toFixed(3),
          "m:",
          this.vvvWheels.map((w) => w.name).join(", "),
        );
      } else {
        console.warn("[V2] VVV wheels: expected 4, got", this.vvvWheels.length);
      }
    } catch (err) {
      console.warn("[V2] Failed to load VVV car visuals:", err);
      this.vvvWheelsLoaded = false;
    }
  }

  /** Build the BVH-backed ground & wall query callbacks once per frame. */
  _buildVvvQueries() {
    const bvh = this.cliffBvh;
    const getTH = this.getTerrainHeight || this.getWorldHeight;

    // Ground query — BVH along the probe ray + terrain height at ray origin XZ.
    // Negative distance (surface above origin) is kept so bottom-out can recover.
    // EXCEPT when the origin is deeply below the surface (> ~1.25m): that means
    // the car is inside a tunnel/cave under solid terrain, and the heightfield
    // above must not masquerade as ground — the BVH (tunnel floor) is the only
    // valid surface there. Shallow negatives stay so clip-through recovery works.
    const VVV_UNDER_TERRAIN_CUTOFF = -1.25;
    const groundQuery = (ox, oy, oz, dx, dy, dz, maxDist) => {
      let best = null;

      if (bvh?.baked) {
        const bvhHit = bvh.raycast3D(ox, oy, oz, dx, dy, dz, maxDist);
        if (bvhHit) best = bvhHit;
      }

      if (getTH) {
        const terrainY = getTH(ox, oz);
        if (isFinite(terrainY)) {
          const vertDist = oy - terrainY;
          if (vertDist <= maxDist && vertDist >= VVV_UNDER_TERRAIN_CUTOFF) {
            const terrainHit = {
              distance: Math.max(vertDist, -1.0),
              point: { x: ox, y: terrainY, z: oz },
            };
            if (!best || terrainHit.distance < best.distance) {
              best = terrainHit;
            }
          }
        }
      }

      return best;
    };

    // Wall query — uses cliffBvh.raycast3D and filters out drivable surfaces
    // (|normal.y| > 0.7 = floor/ramp top, ignore). Only near-vertical surfaces
    // (walls, cliff faces) get reported.
    const wallQuery = (ox, oy, oz, dx, dy, dz, maxDist) => {
      if (!bvh?.baked) return null;
      const hit = bvh.raycast3D(ox, oy, oz, dx, dy, dz, maxDist);
      if (!hit) return null;
      if (Math.abs(hit.normal.y) > 0.7) return null;
      return hit;
    };

    return { groundQuery, wallQuery };
  }

  /** Run one frame of VVV physics: substepped force application + integration,
   *  then sync `playerPos` and `carHeading` for the rest of play mode (camera,
   *  HUD) to read. Input is throttle/steer/handbrake plucked from `this._keys`. */
  _updateVvvCar(dtSec) {
    const body = this._vvvBody;
    const tires = this._vvvTires;
    const T = this._vvvTire;
    const W = this._vvvWheel;
    const WL = this._vvvWall;
    const keys = this.keysHeld || {};

    // --- INPUT ---
    const left = keys.KeyA || keys.ArrowLeft ? 1 : 0;
    const right = keys.KeyD || keys.ArrowRight ? 1 : 0;
    const fwd = keys.KeyW || keys.ArrowUp ? 1 : 0;
    const back = keys.KeyS || keys.ArrowDown ? 1 : 0;
    const steerTarget = left - right;
    const throttle = fwd - back;
    const handbrake = !!keys.Space;
    // Exponential ease the steer input.
    const k = 1 - Math.exp(-T.steerSmooth * dtSec);
    this._vvvSteerSmooth += (steerTarget - this._vvvSteerSmooth) * k;
    const steerAngle = this._vvvSteerSmooth * T.maxSteerAngle;

    // --- PROBES ---
    const { groundQuery, wallQuery } = this._buildVvvQueries();

    // --- PHYSICS STEP (substepped semi-implicit Euler) ---
    const sub = Math.max(1, this._vvvSubsteps);
    const subDt = dtSec / sub;
    for (let s = 0; s < sub; s++) {
      body.forceAccum.y += -VVV_GRAVITY * body.mass;

      // Tire forces
      const ctx = {
        steerAngle,
        throttle,
        handbrake,
        groundQuery,
        tireT: T,
        wheelT: W,
      };
      for (let i = 0; i < tires.length; i++) tires[i].apply(body, subDt, ctx);

      // Wall probes (cliffBvh)
      applyVvvWallProbes(body, this._vvvWallProbes, WL, wallQuery);

      // Anti-roll stabilizer
      applyVvvStabilizer(body, tires, T);

      // Integrate + angular cap
      body.integrate(subDt);
      body.capAngularVelocity(T.maxAngVel);
    }

    // --- VISUAL WHEEL SPIN (accumulate per wheel from forward speed) ---
    for (let i = 0; i < tires.length; i++) {
      const t = tires[i];
      const cfg = this._vvvLayout[i];
      // Wheel forward direction in world (chassis fwd, then steer for fronts)
      _vvvFwdW.set(0, 0, 1).applyQuaternion(body.quat);
      if (cfg.steer && steerAngle !== 0) {
        _vvvAxisY.set(0, 1, 0).applyQuaternion(body.quat);
        _vvvSteerQ.setFromAxisAngle(_vvvAxisY, steerAngle);
        _vvvFwdW.applyQuaternion(_vvvSteerQ);
      }
      body.getVelocityAtPoint(t.worldPos, _vvvTireVel);
      const fwdSpeed = _vvvTireVel.dot(_vvvFwdW);
      this._vvvWheelSpin[i] += (fwdSpeed / W.radius) * dtSec;
      // Wrap to keep FP bounded
      if (this._vvvWheelSpin[i] > Math.PI * 2)
        this._vvvWheelSpin[i] -= Math.PI * 2;
      if (this._vvvWheelSpin[i] < -Math.PI * 2)
        this._vvvWheelSpin[i] += Math.PI * 2;
    }

    this.playerPos.x = body.pos.x;
    this.playerPos.y = body.pos.y;
    this.playerPos.z = body.pos.z;

    // Low-pass body.y for the chase camera (12 / s). Standalone smooths camera
    // position with CAM_LERP=6; we smooth the LOOK target instead because the
    // v2 chase camera assigns position instantly each frame.
    if (this._vvvCamFocusYSmooth == null) {
      this._vvvCamFocusYSmooth = body.pos.y;
    } else {
      const k = 1 - Math.exp(-12 * dtSec);
      this._vvvCamFocusYSmooth += (body.pos.y - this._vvvCamFocusYSmooth) * k;
    }
    // Heading from chassis forward projected on XZ (stable when body pitches/rolls).
    // Euler-Y from the full quat jitters under suspension and makes the chase cam shake.
    _vvvFwdW.set(0, 0, 1).applyQuaternion(body.quat);
    let heading = Math.atan2(_vvvFwdW.x, _vvvFwdW.z) - Math.PI;
    while (heading > Math.PI) heading -= 2 * Math.PI;
    while (heading < -Math.PI) heading += 2 * Math.PI;
    this.carHeading = heading;
    this.carVx = body.vel.x;
    this.carVz = body.vel.z;
  }

  /** Position + orient the box chassis and 4 wheel meshes from body state.
   *  Called from the per-frame visual section (alongside Bruno/Lotus). */
  _syncVvvVisuals(dtSec) {
    if (!this.vvvLoaded) return;
    const showVvv = this.moveMode === "vvv";
    this.vvvRoot.visible = showVvv;
    if (this.vvvWheels) {
      for (const w of this.vvvWheels) {
        w.container.visible = showVvv && this.vvvWheelsLoaded;
      }
    }
    if (this._vvvArrowGroup) {
      this._vvvArrowGroup.visible = showVvv && this._vvvVis.showArrows;
    }
    if (!showVvv) return;

    const body = this._vvvBody;
    const tires = this._vvvTires;
    const T = this._vvvTire;
    const W = this._vvvWheel;
    const C = this._vvvChassis;

    // Root follows body CoM in world space (same pattern as lotusRoot). The mesh
    // uses local offsets only — do NOT write world coords into child.position while
    // the root stays at (0,0,0) or the chase camera reads vvvRoot.position.y ≈ 0.
    this.vvvRoot.position.copy(body.pos);
    this.vvvRoot.quaternion.copy(body.quat);
    this.vvvChassisPivot.position.set(0, C.visualLift + (C.comLower ?? 0), 0);

    // Wheels on vvvRoot: hub layout from GLB + vertical droop along body Y.
    const steerAngle = this._vvvSteerSmooth * T.maxSteerAngle;
    const visK = 1 - Math.exp(-T.suspVisSmooth * dtSec);
    if (!this.vvvWheelsLoaded) {
      this._syncVvvForceArrows(tires);
      return;
    }
    for (let i = 0; i < tires.length; i++) {
      const t = tires[i];
      const cfg = this._vvvLayout[i];
      const w = this.vvvWheels[i];
      if (!w) continue;

      const targetDist = t.grounded ? t.hitDistance : T.restLength;
      if (t._vvvSmoothDist === undefined) t._vvvSmoothDist = targetDist;
      t._vvvSmoothDist += (targetDist - t._vvvSmoothDist) * visK;
      const suspExt = Math.max(0, t._vvvSmoothDist - W.radius);
      w.container.position.set(
        w.hubLocal.x,
        w.hubLocal.y - suspExt,
        w.hubLocal.z,
      );
      const baseYaw = w.isLeft ? Math.PI : 0;
      w.container.rotation.set(0, baseYaw + (cfg.steer ? steerAngle : 0), 0);
      const spinSign = w.isLeft ? 1 : -1;
      if (w.cylinder) w.cylinder.rotation.x = spinSign * this._vvvWheelSpin[i];
    }
    this._syncVvvForceArrows(tires);
  }

  _syncVvvForceArrows(tires) {
    const arrows = this._vvvForceArrows;
    if (!arrows || !this._vvvVis.showArrows) return;
    for (let i = 0; i < tires.length; i++) {
      const t = tires[i];
      const a = arrows[i];
      if (!a) continue;
      this._placeVvvForceArrow(a.up, t.worldPos, t.lastSuspension);
      this._placeVvvForceArrow(a.side, t.worldPos, t.lastSteering);
      this._placeVvvForceArrow(a.fwd, t.worldPos, t.lastAccel);
    }
  }

  /** Teleport the VVV body to a spawn position (called when activating mode
   *  or after a respawn). The +π in the quaternion converts v2's heading
   *  convention (heading=0 ⇒ forward = world −Z) to the standalone VVV
   *  module's convention (chassis-local +Z is the chassis forward axis).
   *  The reverse conversion happens in _updateVvvCar when syncing carHeading. */
  /** Chase-cam anchor Y: terrain + nominal ride height — not raw CoM (springs bob). */
  /** Orbit target height while F-detached — avoids spring bob on rigid-body CoM. */
  _getDetachedOrbitTargetY() {
    if (this.moveMode === "vvv") {
      const speed = Math.sqrt(
        this.carVx * this.carVx + this.carVz * this.carVz,
      );
      return (
        this._getVvvCameraFocusY(
          this.playerPos.x,
          this.playerPos.z,
          this.playerPos.y,
          speed,
        ) + (this.vvvCam?.lookAtY ?? 1.2)
      );
    }
    if (this.moveMode === "lotus" && this.lotusRoot) {
      return this.lotusRoot.position.y + (this.lotusCam?.lookAtY ?? 1.4);
    }
    if (this.moveMode === "stunt") {
      return (this._stuntCamFocusYSmooth ?? this.playerPos.y) + 1.0;
    }
    return this.playerPos.y + 1.0;
  }

  /** Smoothed chase-cam Y. Tracks the rigid body CoM but with a low-pass that
   *  kills the suspension micro-bob and gives the standalone's planted feel. */
  _getVvvCameraFocusY(px, pz, bodyY /* , speed */) {
    if (this._vvvCamFocusYSmooth == null) this._vvvCamFocusYSmooth = bodyY;
    return this._vvvCamFocusYSmooth;
  }

  _vvvSpawnAt(x, y, z, headingRad = 0) {
    const body = this._vvvBody;
    body.pos.set(x, y, z);
    body.vel.set(0, 0, 0);
    body.angVel.set(0, 0, 0);
    body.quat.setFromAxisAngle(_vvvAxisY_world, headingRad + Math.PI);
    body.forceAccum.set(0, 0, 0);
    body.torqueAccum.set(0, 0, 0);
    this._vvvSteerSmooth = 0;
    for (let i = 0; i < 4; i++) this._vvvWheelSpin[i] = 0;
    this._vvvCamFocusYSmooth = null;
    this._vvvCamPosSmooth = null;
  }

  /** Stunt car: drive the byte-faithful modular-road Vehicle from v2 input +
   *  the terrain/cliff ground adapter, then sync the generic car state the
   *  shared chase camera / HUD read (playerPos, carHeading, carVx/Vz). */
  _updateStuntCar(dtSec) {
    const v = this._stuntVehicle;
    if (!v) return;
    const keys = this.keysHeld || {};
    const left = keys.KeyA || keys.ArrowLeft ? 1 : 0;
    const right = keys.KeyD || keys.ArrowRight ? 1 : 0;
    const fwd = keys.KeyW || keys.ArrowUp ? 1 : 0;
    const back = keys.KeyS || keys.ArrowDown ? 1 : 0;
    const spinR = keys.KeyE ? 1 : 0;
    const spinL = keys.KeyQ ? 1 : 0;
    const controls = {
      steerTarget: left - right,
      throttle: fwd - back,
      handbrake: !!keys.Space,
      yaw: spinR - spinL,
    };
    // cliffBvh may bake/rebake after construction — keep the adapter current.
    this._stuntGround.setCliffBvh(this.cliffBvh);
    v.setBvh(this._stuntGround.ground, this._stuntGround.solids);
    v.update(dtSec, controls);

    const b = v.body;
    this.playerPos.x = b.pos.x;
    this.playerPos.y = b.pos.y;
    this.playerPos.z = b.pos.z;
    this.carVx = b.vel.x;
    this.carVz = b.vel.z;
    // Heading from chassis forward on XZ (stable under pitch/roll), matching the
    // VVV convention so the shared chase camera reads it correctly.
    _vvvFwdW.set(0, 0, 1).applyQuaternion(b.quat);
    let heading = Math.atan2(_vvvFwdW.x, _vvvFwdW.z) - Math.PI;
    while (heading > Math.PI) heading -= 2 * Math.PI;
    while (heading < -Math.PI) heading += 2 * Math.PI;
    this.carHeading = heading;

    // Low-pass body Y (12/s) for the free/detached orbit target — same trick as
    // the VVV camera, so the suspension micro-bob doesn't drift the free cam.
    if (this._stuntCamFocusYSmooth == null) {
      this._stuntCamFocusYSmooth = b.pos.y;
    } else {
      this._stuntCamFocusYSmooth +=
        (b.pos.y - this._stuntCamFocusYSmooth) * (1 - Math.exp(-12 * dtSec));
    }

    // Feed v2's shared drift-marks / drift-smoke / car-audio systems.
    this.carInAir = v.groundedCount === 0;
    // Slip angle: lateral vs longitudinal velocity in the chassis frame (0 when
    // driving/reversing straight, → ~π/2 when sliding fully sideways).
    const lon = b.vel.x * _vvvFwdW.x + b.vel.z * _vvvFwdW.z;
    const lat = b.vel.x * _vvvFwdW.z - b.vel.z * _vvvFwdW.x;
    this.carDriftAngle = Math.atan2(Math.abs(lat), Math.abs(lon) + 0.5);
    const vxz = Math.hypot(b.vel.x, b.vel.z);
    this.carDrifting =
      !this.carInAir &&
      vxz > CAR_DRIFT_ENTRY_SPEED &&
      this.carDriftAngle > 0.32;
    // Rear-wheel ground contacts (RL=2, RR=3) for tire marks + smoke origins.
    for (let i = 0; i < 2; i++) {
      const t = v.tires[2 + i];
      const wp = t.worldPos;
      const gy = this.getWorldHeight(wp.x, wp.z) + DRIFT_MARK_Y_OFFSET;
      this._carRearContactPoints[i].set(wp.x, gy, wp.z);
      this._carRearContactGrounded[i] = t.grounded;
    }
  }

  /** Bake the authored Spline Road into the stunt car's drive-surface BVH so the
   *  wheels probe it (and DECK contact keeps the chassis on the thin deck). Called
   *  on stunt-mode entry; re-call to refresh after editing the road. */
  _bakeStuntRoad() {
    this.scene.updateMatrixWorld(true);
    // Deck → wheel-probe BVH.
    const meshes = (this._getStuntRoadMeshes() || []).filter(
      (m) => m && m.geometry,
    );
    if (meshes.length) {
      if (!this._stuntRoadBvh) this._stuntRoadBvh = new RoadBvh();
      this._stuntRoadBvh.bakeFromMeshes(meshes);
      this._stuntGround.setRoadBvh(
        this._stuntRoadBvh.baked ? this._stuntRoadBvh : null,
      );
    } else {
      this._stuntGround.setRoadBvh(null);
    }
    // Side barriers → chassis-collision solids BVH.
    const solids = (this._getStuntRoadSolidMeshes() || []).filter(
      (m) => m && m.geometry,
    );
    if (solids.length) {
      if (!this._stuntRoadSolidsBvh) this._stuntRoadSolidsBvh = new RoadBvh();
      this._stuntRoadSolidsBvh.bakeFromMeshes(solids);
      this._stuntGround.setRoadSolidsBvh(
        this._stuntRoadSolidsBvh.baked ? this._stuntRoadSolidsBvh : null,
      );
    } else {
      this._stuntGround.setRoadSolidsBvh(null);
    }
  }

  /** Stunt chase camera — byte-faithful port of modular-road's
   *  updateChaseCamera: trails the car's TRAVEL direction (not its facing), so
   *  mid-air spins/loops don't whip the view, and the look tilts up climbing /
   *  down falling so you see the landing. */
  _updateStuntCamera(dt) {
    const v = this._stuntVehicle;
    if (!v) return;
    const C = this._stuntCam;
    const pos = v.body.pos;
    const vel = v.body.vel;
    const speed = vel.length();
    const grounded = v.groundedCount > 0;
    _stCamFwd.set(0, 0, 1).applyQuaternion(v.body.quat); // car facing (fallback)
    const reversing = grounded && vel.dot(_stCamFwd) < -0.5;

    // 3D look direction: travel dir when moving, else the car's facing.
    if (speed > C.minSpeed && !reversing)
      _stCamV.copy(vel).multiplyScalar(1 / speed);
    else _stCamV.copy(_stCamFwd);

    // Horizontal trail heading: velocity when moving forward; facing on the
    // ground; held steady in the air at low horizontal speed.
    const hSpeed = Math.hypot(vel.x, vel.z);
    if (hSpeed > C.minSpeed && !reversing) {
      _stCamTgtH.set(vel.x, 0, vel.z).multiplyScalar(1 / hSpeed);
    } else if (grounded) {
      _stCamTgtH.set(_stCamFwd.x, 0, _stCamFwd.z);
      if (_stCamTgtH.lengthSq() > 1e-6) _stCamTgtH.normalize();
      else _stCamTgtH.copy(this._stuntCamHeading);
    } else {
      _stCamTgtH.copy(this._stuntCamHeading);
    }

    if (!this._stuntCamInit) {
      this._stuntCamHeading.copy(_stCamTgtH);
      this._stuntCamLookDir.copy(_stCamV);
      this._stuntCamInit = true;
    }

    const kh = 1 - Math.exp(-C.headingLerp * dt);
    this._stuntCamHeading.lerp(_stCamTgtH, kh);
    if (this._stuntCamHeading.lengthSq() < 1e-6)
      this._stuntCamHeading.copy(_stCamTgtH);
    this._stuntCamHeading.normalize();

    const kl = 1 - Math.exp(-C.lookLerp * dt);
    this._stuntCamLookDir.lerp(_stCamV, kl);
    if (this._stuntCamLookDir.y > C.maxLookPitch)
      this._stuntCamLookDir.y = C.maxLookPitch;
    else if (this._stuntCamLookDir.y < -C.maxLookPitch)
      this._stuntCamLookDir.y = -C.maxLookPitch;
    if (this._stuntCamLookDir.lengthSq() < 1e-6)
      this._stuntCamLookDir.copy(_stCamV);
    this._stuntCamLookDir.normalize();

    _stCamDesired
      .copy(pos)
      .addScaledVector(this._stuntCamHeading, -C.dist)
      .addScaledVector(_stWorldUp, C.height);
    const kp = 1 - Math.exp(-C.posLerp * dt);
    this.camera.position.lerp(_stCamDesired, kp);

    _stCamLook.copy(pos).addScaledVector(this._stuntCamLookDir, C.lookAhead);
    _stCamLook.y += C.lookUp;
    this.camera.lookAt(_stCamLook);
  }

  async _initLotusCamGui() {
    try {
      const { GUI } =
        await import("https://cdn.jsdelivr.net/npm/lil-gui@0.20.0/dist/lil-gui.esm.min.js");
      const gui = new GUI({ title: "Lotus", width: 300 });
      gui.domElement.style.position = "fixed";
      gui.domElement.style.top = "10px";
      gui.domElement.style.right = "10px";

      const cam = gui.addFolder("Camera");
      cam.add(this.lotusCam, "distance", 2, 16, 0.1).name("Distance");
      cam.add(this.lotusCam, "height", 0.5, 8, 0.1).name("Height");
      cam.add(this.lotusCam, "lookAtY", 0, 4, 0.1).name("Look-at Y");
      cam.add(this.lotusCam, "chaseSpeed", 1, 12, 0.1).name("Chase Speed");
      cam.add(this.lotusCam, "driftLag", 0, 5, 0.1).name("Drift Lag");
      cam
        .add(this.lotusCam, "speedPullBack", 0, 8, 0.1)
        .name("Speed Pull-back");
      cam
        .add(this.lotusCam, "chassisRollClamp", 0.01, 0.5, 0.01)
        .name("Chassis roll clamp (visual)");
      cam
        .add(this.lotusCam, "chassisPitchClamp", 0.01, 0.5, 0.01)
        .name("Chassis pitch clamp (visual)");
      cam
        .add(this.lotusCam, "fov", 40, 110, 1)
        .name("FOV")
        .onChange(() => this._applyLotusFov());
      cam
        .add(
          {
            log: () => console.log("lotusCam:", JSON.stringify(this.lotusCam)),
          },
          "log",
        )
        .name("Log camera JSON");

      const lp = this._lotusPhysics.params;
      const eng = gui.addFolder("Physics — engine");
      eng.add(lp, "accel", 5, 90, 1).name("Accel");
      eng.add(lp, "accelBoost", 10, 130, 1).name("Accel (boost)");
      eng.add(lp, "brake", 5, 70, 1).name("Brake");
      eng.add(lp, "reverseAccel", 2, 35, 0.5).name("Reverse accel");
      eng.add(lp, "maxSpeed", 15, 160, 1).name("Max speed");
      eng.add(lp, "maxSpeedBoost", 25, 200, 1).name("Max speed (boost)");
      eng.add(lp, "coast", 0.1, 6, 0.05).name("Coast");
      eng.add(lp, "drag", 0, 0.025, 0.0005).name("Drag");
      eng.add(lp, "handbrakeDecel", 1, 22, 0.5).name("Handbrake decel");
      eng
        .add(lp, "baseAccelLowSpeedMul", 0.2, 1, 0.02)
        .name("Low-speed accel ×");
      eng.add(lp, "baseAccelRampToKmh", 30, 260, 5).name("Accel ramp (km/h)");

      const steer = gui.addFolder("Physics — steering");
      steer.add(lp, "turnRate", 0.15, 5, 0.05).name("Turn rate");
      steer.add(lp, "turnRateDrift", 0.15, 7, 0.05).name("Turn (drift)");
      steer.add(lp, "turnRateCounter", 0.15, 5, 0.05).name("Turn (counter)");

      const grip = gui.addFolder("Physics — grip");
      grip.add(lp, "gripBase", 2, 45, 0.5).name("Grip base");
      grip.add(lp, "gripSpeedDecay", 0, 0.55, 0.01).name("Grip speed decay");
      grip.add(lp, "gripMinSpeed", 0.5, 18, 0.25).name("Grip floor");
      grip.add(lp, "gripHandbrake", 0.05, 2.5, 0.05).name("Grip (handbrake)");
      grip
        .add(lp, "gripHandbrakeApplyRate", 1, 35, 0.5)
        .name("Handbrake grip on");
      grip.add(lp, "gripRecoveryRate", 1, 35, 0.5).name("Grip recovery");
      grip.add(lp, "gripCounterBonus", 0, 12, 0.25).name("Counter-steer bonus");
      grip.add(lp, "gripBrakeTurn", 0.5, 9, 0.1).name("Brake + turn cap");

      const drift = gui.addFolder("Physics — drift");
      drift.add(lp, "driftEntrySpeed", 1, 45, 0.5).name("Entry speed");
      drift.add(lp, "driftAngleMin", 0.01, 0.35, 0.005).name("Angle enter");
      drift.add(lp, "driftAngleExit", 0.01, 0.25, 0.005).name("Angle exit");

      const dboost = gui.addFolder("Physics — drift boost");
      dboost.add(lp, "driftBoostBuildRate", 0, 6, 0.1).name("Build rate");
      dboost.add(lp, "driftBoostMax", 0.1, 3.5, 0.05).name("Meter max");
      dboost
        .add(lp, "driftBoostAngleMin", 0.05, 0.55, 0.01)
        .name("Boost angle min");
      dboost
        .add(lp, "driftBoostAngleMax", 0.2, 1.6, 0.02)
        .name("Boost angle max");
      dboost
        .add(lp, "driftBoostAnglePenaltyEnd", 0.5, 2.5, 0.05)
        .name("Angle penalty end");
      dboost.add(lp, "driftBoostSpeedAdd", 0, 45, 1).name("Speed add");
      dboost.add(lp, "driftBoostDuration", 0.2, 6, 0.1).name("Duration scale");
      dboost
        .add(lp, "driftBoostQualifyTime", 0.1, 2.5, 0.05)
        .name("Qualify time");

      const body = gui.addFolder("Physics — dynamics / wheels");
      body
        .add(lp, "bodyRollMax", 0.05, 0.45, 0.01)
        .name("Drift roll strength (sim)");
      body
        .add(lp, "bodyPitchMax", 0.05, 0.45, 0.01)
        .name("Pitch response cap (sim)");
      body.add(lp, "bodySmooth", 1, 28, 0.5).name("Body smooth");
      body.add(lp, "wheelRadius", 0.15, 0.85, 0.01).name("Wheel radius");

      const nitro = gui.addFolder("Physics — nitro / blend");
      nitro.add(lp, "nitroAccelBonus", 0, 50, 1).name("Nitro accel +");
      nitro.add(lp, "nitroMaxSpeedBonus", 0, 55, 1).name("Nitro max spd +");
      nitro.add(lp, "nitroDrainPerSec", 0.05, 1, 0.02).name("Nitro drain/s");
      nitro.add(lp, "nitroRegenPerSec", 0.02, 0.6, 0.02).name("Nitro regen/s");
      nitro.add(lp, "nitroMinToUse", 0.01, 0.25, 0.01).name("Min to use");
      nitro.add(lp, "boostBlendSmooth", 1, 45, 1).name("Boost blend smooth");
      nitro.add(lp, "nitroFxBlendSmooth", 1, 45, 1).name("Nitro FX smooth");

      const terr = gui.addFolder("Physics — terrain");
      terr.add(lp, "gravity", 5, 55, 1).name("Gravity");
      terr
        .add(lp, "rideHeight", 0.1, 1.1, 0.02)
        .name("Ride height")
        .onChange((v) => {
          this._carPhysics.lotusHull.rideHeight = v;
          this._carPhysics.lotusChassis.rideHeight = v;
          if (this._lotusCamGui) {
            for (const c of this._lotusCamGui.controllersRecursive()) {
              c.updateDisplay();
            }
          }
        });
      terr.add(lp, "maxSlopeCos", 0.1, 0.99, 0.01).name("Max slope cos");
      terr.add(lp, "wheelBase", 0.8, 4.2, 0.05).name("Wheelbase");
      terr.add(lp, "track", 0.5, 2.6, 0.05).name("Track width");
      terr
        .add(lp, "wheelBvhRayPadAboveHub", 0.2, 4, 0.05)
        .name("BVH ray pad (tunnel)");
      terr
        .add(lp, "wheelBvHMaxAboveHub", 0.6, 10, 0.05)
        .name("BVH max above hub");

      const lh = this._carPhysics.lotusHull;
      const resetLotusHull = () => {
        const d = DEFAULT_LOTUS_COLLISION_HULL;
        while (lh.hullSpheres.length < d.hullSpheres.length) {
          lh.hullSpheres.push({ ...d.hullSpheres[lh.hullSpheres.length] });
        }
        while (lh.hullSpheres.length > d.hullSpheres.length) {
          lh.hullSpheres.pop();
        }
        for (let i = 0; i < d.hullSpheres.length; i++) {
          Object.assign(lh.hullSpheres[i], d.hullSpheres[i]);
        }
        for (const k of Object.keys(d)) {
          if (k === "hullSpheres") continue;
          lh[k] = d[k];
        }
        for (const c of gui.controllersRecursive()) {
          c.updateDisplay();
        }
      };
      const col = gui.addFolder("Collision hull (Lotus)");
      lh.hullSpheres.forEach((hs, idx) => {
        const hf = col.addFolder(hs.label || `sphere ${idx}`);
        hf.add(hs, "fwd", -2.8, 2.8, 0.02).name("Fwd offset");
        hf.add(hs, "right", -1.2, 1.2, 0.02).name("Right offset");
        hf.add(hs, "y", 0.06, 1.1, 0.01).name("Y above root");
        hf.add(hs, "r", 0.12, 0.85, 0.01).name("Radius");
      });
      col.add(lh, "sweepFwdMargin", 0, 2, 0.02).name("Sweep margin");
      col.add(lh, "probeHalfLength", 0.3, 2.2, 0.02).name("Probe half-length");
      col.add(lh, "probeHalfWidth", 0.12, 1.2, 0.02).name("Probe half-width");
      col.add(lh, "probeYLow", -0.15, 0.5, 0.01).name("Probe Y low + ride");
      col.add(lh, "probeYHigh", 0.15, 1.1, 0.01).name("Probe Y high + ride");
      col.add(lh, "stepOverHeight", 0.2, 2, 0.05).name("Step-over max Y");
      col.add({ resetLotusHull }, "resetLotusHull").name("Reset Lotus hull");

      const ch = this._carPhysics.lotusChassis;
      const resetLotusChassis = () => {
        Object.assign(ch, { ...DEFAULT_LOTUS_CHASSIS });
        const p = this._lotusPhysics.params;
        ch.rideHeight = p.rideHeight;
        ch.gravity = p.gravity;
        ch.wheelBase = p.wheelBase;
        ch.track = p.track;
        ch.maxSlopeCos = p.maxSlopeCos;
        ch.wheelBvhRayPadAboveHub = p.wheelBvhRayPadAboveHub;
        ch.wheelBvHMaxAboveHub = p.wheelBvHMaxAboveHub;
        for (const c of gui.controllersRecursive()) {
          c.updateDisplay();
        }
      };
      const suspF = gui.addFolder("Chassis springs (Lotus = Bruno pipeline)");
      suspF.add(ch, "suspStiffness", 20, 200, 1).name("Stiffness");
      suspF.add(ch, "suspDampCompress", 1, 25, 0.5).name("Damp compress");
      suspF.add(ch, "suspDampRelax", 0.5, 15, 0.25).name("Damp relax");
      suspF.add(ch, "suspMaxTravel", 0.15, 1.0, 0.02).name("Max travel");
      suspF.add(ch, "mass", 0.3, 6, 0.05).name("Mass (sim)");
      suspF.add(ch, "jumpImpulse", 0, 22, 0.5).name("Jump impulse");
      suspF.add(ch, "airPitchSmooth", 1, 22, 0.5).name("Air pitch smooth");
      suspF
        .add({ resetLotusChassis }, "resetLotusChassis")
        .name("Reset chassis defaults");

      gui
        .add(
          {
            resetPhysics: () => {
              Object.assign(
                this._lotusPhysics.params,
                DEFAULT_LOTUS_PHYSICS_PARAMS,
              );
              resetLotusChassis();
              this._carPhysics.lotusHull.rideHeight =
                this._lotusPhysics.params.rideHeight;
              for (const c of gui.controllersRecursive()) {
                c.updateDisplay();
              }
            },
          },
          "resetPhysics",
        )
        .name("Reset physics defaults");
      gui
        .add(
          {
            logPhysics: () =>
              console.log("lotusPhysics:", JSON.stringify(lp, null, 2)),
          },
          "logPhysics",
        )
        .name("Log physics JSON");

      gui.domElement.style.display = "none";
      this._lotusCamGui = gui;
    } catch (err) {
      console.warn("[V2] lil-gui load failed:", err);
    }
  }

  async _initVvvGui() {
    try {
      const { GUI } =
        await import("https://cdn.jsdelivr.net/npm/lil-gui@0.20.0/dist/lil-gui.esm.min.js");
      const gui = new GUI({ title: "VVV (rigid)", width: 300 });
      gui.domElement.style.position = "fixed";
      gui.domElement.style.top = "10px";
      gui.domElement.style.right = "10px";

      const T = this._vvvTire;
      const C = this._vvvChassis;
      const WL = this._vvvWall;
      const body = this._vvvBody;

      const rebuildInertia = () => {
        body.rebuildInertia({ mass: C.mass, size: C });
      };

      const susp = gui.addFolder("Suspension");
      susp.add(T, "springStrength", 5000, 150000, 500).name("Spring k");
      susp.add(T, "damper", 0, 20000, 50).name("Damper");
      susp.add(T, "restLength", 0.2, 1.5, 0.01).name("Rest length");
      susp.add(T, "rayLength", 0.3, 2.0, 0.01).name("Ray length");
      susp.add(T, "rayPadAbove", 0, 1.5, 0.01).name("Ray pad above");
      susp.add(T, "rayForwardBias", 0, 1.0, 0.05).name("Fwd/rear bias");
      susp.add(T, "rayLateralBias", 0, 1.5, 0.05).name("Lateral bias");
      susp.add(T, "bottomOutThresh", 0.3, 1.0, 0.05).name("Bottom-out start");
      susp.add(T, "bottomOutMult", 0, 30, 0.5).name("Bottom-out mult");
      susp.add(T, "suspVisSmooth", 0, 40, 0.5).name("Susp visual smooth");

      const steer = gui.addFolder("Steering & grip");
      steer.add(T, "maxSteerAngle", 0.1, 1.2, 0.01).name("Max steer (rad)");
      steer.add(T, "steerSmooth", 1, 30, 0.5).name("Steer smooth");
      steer.add(T, "gripFront", 0, 1, 0.01).name("Grip front");
      steer.add(T, "gripRear", 0, 1, 0.01).name("Grip rear");
      steer.add(T, "gripHandbrake", 0, 1, 0.01).name("Grip handbrake");
      steer.add(T, "frictionCoeff", 0.3, 12, 0.1).name("Friction μ");
      steer.add(T, "maxAngVel", 3, 20, 0.5).name("Max ω (rad/s)");
      steer.add(T, "stabilizerStrength", 0, 30000, 200).name("Anti-roll");
      steer.add(T, "stabilizerRollDamp", 0, 15000, 100).name("Roll damp");

      const drive = gui.addFolder("Drive");
      drive.add(T, "accelForce", 500, 20000, 100).name("Accel (N)");
      drive.add(T, "topSpeed", 5, 80, 1).name("Top speed (m/s)");
      drive.add(T, "powerCurveExp", 0.5, 4, 0.1).name("Power curve exp");
      drive.add(T, "brakeForce", 0, 30000, 100).name("Brake (N)");
      drive.add(T, "reverseAccel", 0, 10000, 100).name("Reverse (N)");
      drive
        .add(T, "brakeReverseThreshold", 0, 5, 0.05)
        .name("Brake/rev thresh");
      drive.add(T, "engineBrake", 0, 5000, 50).name("Engine brake");

      const wall = gui.addFolder("Wall probes");
      wall.add(WL, "probeRange", 0.05, 2.0, 0.01).name("Probe range");
      wall.add(WL, "stiffness", 5000, 800000, 5000).name("Stiffness");
      wall.add(WL, "damper", 0, 40000, 200).name("Damper");
      wall.add(WL, "clampPenFrac", 0, 1.0, 0.05).name("Vel-clamp pen");

      const ch = gui.addFolder("Chassis");
      ch.add(C, "mass", 400, 4000, 50)
        .name("Mass (kg)")
        .onChange(rebuildInertia);
      ch.add(C, "width", 0.8, 4.0, 0.05).name("Width").onChange(rebuildInertia);
      ch.add(C, "height", 0.3, 2.5, 0.05)
        .name("Height")
        .onChange(rebuildInertia);
      ch.add(C, "length", 1.5, 6.0, 0.05)
        .name("Length")
        .onChange(rebuildInertia);
      ch.add(C, "visualLift", -0.5, 2.0, 0.01).name("Visual lift");
      ch.add(C, "comLower", 0, 0.45, 0.01)
        .name("CoM lower (m)")
        .onChange(() => this._applyVvvComToWheelLayout());

      gui.add(this, "_vvvSubsteps", 1, 8, 1).name("Physics substeps");

      const vis = gui.addFolder("Visual");
      vis
        .add(this._vvvVis, "showArrows")
        .name("Force arrows")
        .onChange((v) => {
          if (this._vvvArrowGroup) {
            this._vvvArrowGroup.visible = v && this.moveMode === "vvv";
          }
        });
      vis
        .add(this._vvvVis, "arrowScale", 0.0001, 0.005, 0.0001)
        .name("Arrow scale");

      gui
        .add(
          {
            reset: () => {
              Object.assign(this._vvvChassis, DEFAULT_VVV_CHASSIS);
              Object.assign(this._vvvWheel, DEFAULT_VVV_WHEEL);
              Object.assign(this._vvvTire, DEFAULT_VVV_TIRE);
              Object.assign(this._vvvWall, DEFAULT_VVV_WALL);
              this._vvvSubsteps = 6;
              this._vvvVis.showArrows = true;
              this._vvvVis.arrowScale = 0.0008;
              rebuildInertia();
              this._applyVvvComToWheelLayout();
              this._vvvSubsteps = 4;
              for (const c of gui.controllersRecursive()) c.updateDisplay();
            },
          },
          "reset",
        )
        .name("Reset defaults");

      gui.domElement.style.display = "none";
      this._vvvCamGui = gui;
    } catch (err) {
      console.warn("[V2] VVV lil-gui load failed:", err);
    }
  }

  _applyLotusFov() {
    if (this.camera.fov !== this.lotusCam.fov) {
      this.camera.fov = this.lotusCam.fov;
      this.camera.updateProjectionMatrix();
    }
  }

  _restoreDefaultFov() {
    if (this.camera.fov !== 60) {
      this.camera.fov = 60;
      this.camera.updateProjectionMatrix();
    }
  }

  async _initJeepTuningGui() {
    try {
      const { GUI } =
        await import("https://cdn.jsdelivr.net/npm/lil-gui@0.20.0/dist/lil-gui.esm.min.js");
      const gui = new GUI({ title: "Bruno (jeep)", width: 320 });
      gui.domElement.style.position = "fixed";
      gui.domElement.style.top = "10px";
      gui.domElement.style.left = "10px";
      gui.domElement.style.right = "auto";

      const j = this._carPhysics.jeep;
      const resetJeep = () => {
        const d = DEFAULT_JEEP_TUNING;
        while (j.hullSpheres.length < d.hullSpheres.length) {
          j.hullSpheres.push({ ...d.hullSpheres[j.hullSpheres.length] });
        }
        while (j.hullSpheres.length > d.hullSpheres.length) {
          j.hullSpheres.pop();
        }
        for (let i = 0; i < d.hullSpheres.length; i++) {
          Object.assign(j.hullSpheres[i], d.hullSpheres[i]);
        }
        for (const k of Object.keys(d)) {
          if (k === "hullSpheres") continue;
          j[k] = d[k];
        }
        for (const c of gui.controllersRecursive()) {
          c.updateDisplay();
        }
      };

      const live = {
        netVert: 0,
        springSum: 0,
        weight: 0,
        velY: 0,
        grounded: 0,
        c0: 0,
        c1: 0,
        c2: 0,
        c3: 0,
        f0: 0,
        f1: 0,
        f2: 0,
        f3: 0,
      };
      this._jeepGuiLive = live;
      this._jeepGuiLiveCtrls.length = 0;
      const liveF = gui.addFolder("Live telemetry");
      const addRo = (prop, label) => {
        const c = liveF.add(live, prop).name(label).disable();
        this._jeepGuiLiveCtrls.push(c);
      };
      addRo("netVert", "Net vertical force");
      addRo("springSum", "Spring sum (4 wheels)");
      addRo("weight", "Weight (m·g)");
      addRo("velY", "Body vel Y");
      addRo("grounded", "Wheels grounded");
      addRo("c0", "FL compression");
      addRo("c1", "FR compression");
      addRo("c2", "RL compression");
      addRo("c3", "RR compression");
      addRo("f0", "FL spring N");
      addRo("f1", "FR spring N");
      addRo("f2", "RL spring N");
      addRo("f3", "RR spring N");
      liveF.open();

      const hullRoot = gui.addFolder("Hull — compound spheres");
      j.hullSpheres.forEach((h, idx) => {
        const hf = hullRoot.addFolder(h.label || `sphere ${idx}`);
        hf.add(h, "fwd", -2.8, 2.8, 0.02).name("Fwd offset");
        hf.add(h, "right", -1.2, 1.2, 0.02).name("Right offset");
        hf.add(h, "y", 0.08, 1.4, 0.01).name("Y above ground");
        hf.add(h, "r", 0.12, 1.2, 0.01).name("Radius");
      });
      hullRoot.add(j, "sweepFwdMargin", 0, 2.5, 0.02).name("Sweep margin");

      const probe = gui.addFolder("Wall probes (XZ depenetrate)");
      probe.add(j, "probeHalfLength", 0.35, 3.2, 0.02).name("Half-length");
      probe.add(j, "probeHalfWidth", 0.15, 1.6, 0.02).name("Half-width");
      probe.add(j, "probeYLow", -0.2, 0.8, 0.01).name("Probe Y low + ride");
      probe.add(j, "probeYHigh", 0.2, 1.5, 0.01).name("Probe Y high + ride");
      probe.add(j, "probeSearchRadius", 0.15, 1.2, 0.02).name("Search radius");
      probe
        .add(j, "probePenetrationSlack", 0.08, 0.8, 0.01)
        .name("Penetration slack");
      probe.add(j, "collisionSkin", 0.02, 0.3, 0.005).name("Collision skin");
      probe.add(j, "stepOverHeight", 0.2, 2.5, 0.05).name("Step-over max Y");

      const susp = gui.addFolder("Suspension");
      susp.add(j, "rideHeight", 0.15, 1.2, 0.01).name("Ride height");
      susp.add(j, "suspStiffness", 10, 220, 1).name("Stiffness");
      susp.add(j, "suspDampCompress", 0.5, 30, 0.5).name("Damp compress");
      susp.add(j, "suspDampRelax", 0.2, 18, 0.25).name("Damp relax");
      susp.add(j, "suspMaxTravel", 0.1, 1.2, 0.02).name("Max travel");
      susp.add(j, "mass", 0.2, 8, 0.05).name("Mass (sim)");
      susp.add(j, "gravity", 5, 55, 0.5).name("Gravity");
      susp.add(j, "airPitchSmooth", 0.5, 18, 0.5).name("Air pitch smooth");
      susp.add(j, "jumpImpulse", 0, 22, 0.5).name("Jump impulse");

      const whBvh = gui.addFolder("Wheel BVH (no tunnel ceiling)");
      whBvh
        .add(j, "wheelBvhRayPadAboveHub", 0.2, 4, 0.05)
        .name("Ray start above hub");
      whBvh
        .add(j, "wheelBvHMaxAboveHub", 0.6, 10, 0.05)
        .name("Max hit above hub");

      const geom = gui.addFolder("Terrain pitch / roll");
      geom.add(j, "wheelBase", 0.8, 4.5, 0.05).name("Wheelbase (sample)");
      geom.add(j, "track", 0.5, 2.8, 0.05).name("Track (sample)");
      geom.add(j, "maxSlopeCos", 0.15, 0.99, 0.01).name("Max slope cos");

      gui.add({ resetJeep }, "resetJeep").name("Reset jeep defaults");
      gui
        .add(
          {
            logJeep: () => console.log("jeep:", JSON.stringify(j, null, 2)),
          },
          "logJeep",
        )
        .name("Log jeep JSON");

      gui.domElement.style.display = "none";
      this._jeepTuningGui = gui;
    } catch (err) {
      console.warn("[V2] Bruno jeep GUI load failed:", err);
    }
  }

  _updateJeepGuiTelemetry() {
    if (!this._jeepGuiLive || !this._jeepGuiLiveCtrls.length) return;
    if (!this.active || this.moveMode !== "car") return;
    const t = this._carPhysics.telemetry;
    const live = this._jeepGuiLive;
    live.netVert = t.netVerticalForce;
    live.springSum = t.totalSpringForce;
    live.weight = t.weight;
    live.velY = this.carVelY;
    live.grounded = t.groundedCount;
    live.f0 = t.wheelForce[0];
    live.f1 = t.wheelForce[1];
    live.f2 = t.wheelForce[2];
    live.f3 = t.wheelForce[3];
    live.c0 = t.compression[0];
    live.c1 = t.compression[1];
    live.c2 = t.compression[2];
    live.c3 = t.compression[3];
    for (const c of this._jeepGuiLiveCtrls) {
      c.updateDisplay();
    }
  }

  _loadCharacter() {
    const loader = getSharedGltfLoader();

    loader.load(
      CHAR_MODEL,
      (gltf) => {
        const model = gltf.scene;
        model.traverse((o) => {
          if (o.isMesh || o.isSkinnedMesh) {
            o.castShadow = true;
            o.receiveShadow = true;
            o.frustumCulled = false;
          }
        });
        const box = new THREE.Box3().setFromObject(model);
        const size = new THREE.Vector3();
        box.getSize(size);
        const scale = CHAR_HEIGHT / (size.y || 1);
        model.scale.setScalar(scale);
        box.setFromObject(model);
        model.position.y -= box.min.y;

        this.charInner = model;
        this.charRoot = new THREE.Group();
        this.charRoot.add(model);
        this.charRoot.visible = false;
        this.scene.add(this.charRoot);
        if (this._excludeFromReflection)
          this._excludeFromReflection(this.charRoot);

        // Kite (paraglider)
        {
          const kg = new THREE.Group();
          const shape = new THREE.Shape();
          shape.moveTo(0, -0.7);
          shape.lineTo(-1.6, 0.6);
          shape.lineTo(1.6, 0.6);
          shape.closePath();
          const canopy = new THREE.Mesh(
            new THREE.ShapeGeometry(shape),
            new THREE.MeshStandardMaterial({
              color: 0x2563eb,
              roughness: 0.5,
              metalness: 0.1,
              side: THREE.DoubleSide,
            }),
          );
          canopy.castShadow = true;
          canopy.rotation.x = -0.5;
          canopy.position.set(0, 0.15, 0);
          kg.add(canopy);
          const bar = new THREE.Mesh(
            new THREE.BoxGeometry(0.7, 0.04, 0.04),
            new THREE.MeshStandardMaterial({
              color: 0x1f2937,
              roughness: 0.4,
              metalness: 0.3,
            }),
          );
          bar.castShadow = true;
          bar.position.set(0, -0.6, 0.35);
          bar.rotation.x = 0.25;
          kg.add(bar);
          kg.position.set(0, CHAR_HEIGHT * 0.95, -0.35);
          kg.rotation.set(0.12, PI / 2, 0);
          kg.visible = false;
          this.charRoot.add(kg);
          this.charKite = kg;
        }

        // Bone lookup
        const findBone = (names) => {
          for (const n of names) {
            const b = model.getObjectByName(n);
            if (b) return b;
          }
          let hit = null;
          model.traverse((o) => {
            if (hit) return;
            const nm = (o.name || "").toLowerCase();
            if (
              /hand[_.-]?r|righthand|handright/.test(nm) &&
              names[0].toLowerCase().includes("hand")
            )
              hit = o;
            if (/head/.test(nm) && names[0].toLowerCase().includes("head"))
              hit = o;
          });
          return hit;
        };
        const rightHand = findBone([
          "DEF-handR",
          "hand.R",
          "mixamorigRightHand",
          "RightHand",
        ]);
        const headBone = findBone([
          "DEF-head",
          "head",
          "Head",
          "mixamorigHead",
        ]);

        // Katana
        if (rightHand) {
          const sg = new THREE.Group();
          sg.position.set(-0.07, 0.115, -0.2);
          sg.rotation.set(-1.37, 1.8, -2.21);
          rightHand.add(sg);
          loader.load(
            CHAR_KATANA,
            (kg) => {
              const ks = kg.scene;
              ks.traverse((o) => {
                if (o.isMesh) {
                  o.castShadow = true;
                  o.receiveShadow = true;
                }
              });
              const kb = new THREE.Box3().setFromObject(ks);
              const ksz = new THREE.Vector3();
              kb.getSize(ksz);
              const kscale = 1.0 / (Math.max(ksz.x, ksz.y, ksz.z) || 1);
              ks.scale.setScalar(kscale);
              kb.setFromObject(ks);
              ks.position.set(-kb.min.x, -kb.min.y, -kb.min.z);
              sg.add(ks);
            },
            undefined,
            (e) => console.warn("[char] katana load failed:", e),
          );
        }

        // Hat
        if (headBone) {
          loader.load(
            CHAR_HAT,
            (hg) => {
              const hs = hg.scene;
              hs.traverse((o) => {
                if (o.isMesh) {
                  o.castShadow = true;
                  o.receiveShadow = true;
                }
              });
              const hatScale = CHAR_HEIGHT / 1.8;
              hs.scale.setScalar(0.65 * hatScale);
              hs.position.set(0, 0.2, 0);
              headBone.add(hs);
            },
            undefined,
            (e) => console.warn("[char] hat load failed:", e),
          );
        }

        // Animations
        if (gltf.animations?.length) {
          this.charMixer = new THREE.AnimationMixer(model);
          const pick = (baseNames) => {
            for (const base of baseNames) {
              const hit = gltf.animations.find(
                (a) => a.name === base + "_Armature" || a.name === base,
              );
              if (hit) return hit;
            }
            return null;
          };
          const idleClip = pick(["Idle_Loop"]) || gltf.animations[0];
          const walkClip = pick(["Walk_Loop"]) || idleClip;
          const runClip = pick(["Sprint_Loop", "Jog_Fwd_Loop"]) || walkClip;
          const jumpStartClip = pick(["Jump_Start"]);
          const jumpLoopClip =
            pick(["Jump_Loop", "NinjaJump_Idle_Loop"]) ||
            jumpStartClip ||
            idleClip;
          const jumpLandClip = pick(["Jump_Land"]) || idleClip;
          const glideClip = pick(["NinjaJump_Idle_Loop"]) || jumpLoopClip;
          const attackClip = pick(["Sword_Attack", "Sword_Attack_RM"]);
          const crouchClip = pick(["Crouch_Idle_Loop"]) || idleClip;
          const crouchWalkClip = pick(["Crouch_Fwd_Loop"]) || crouchClip;
          const rollClip = pick(["Roll", "Roll_RM"]) || idleClip;
          const slideStartClip = pick(["Slide_Start"]);
          const slideLoopClip = pick(["Slide_Loop"]) || slideStartClip;
          const slideExitClip = pick(["Slide_Exit"]) || slideLoopClip;
          const spellEnterClip = pick(["Spell_Simple_Enter"]);
          const spellIdleClip = pick(["Spell_Simple_Idle_Loop"]);
          const spellShootClip = pick(["Spell_Simple_Shoot"]);
          const spellExitClip = pick(["Spell_Simple_Exit"]);

          const mk = (clip, loopOnce) => {
            if (!clip) return null;
            const a = this.charMixer
              .clipAction(clip)
              .setLoop(loopOnce ? THREE.LoopOnce : THREE.LoopRepeat);
            if (loopOnce) a.clampWhenFinished = true;
            return a;
          };

          const idleAction = mk(idleClip, false);
          const walkAction = mk(walkClip, false);
          const runAction = mk(runClip, false);
          const jumpStartAction = mk(jumpStartClip, true);
          const jumpLoopAction = mk(jumpLoopClip, false);
          const jumpLandAction = mk(jumpLandClip, true);
          const glideAction = mk(glideClip, false);
          if (jumpStartAction) jumpStartAction.timeScale = 1.4;
          if (jumpLandAction) jumpLandAction.timeScale = 1.8;
          const crouchAction = mk(crouchClip, false);
          const crouchWalkAction = mk(crouchWalkClip, false);
          const attackAction = mk(attackClip, true);
          const rollAction = mk(rollClip, true);
          if (rollAction) {
            const d = rollAction.getClip()?.duration;
            if (d && d > 0) this.charRollDuration = d;
          }
          const slideStartAction = mk(slideStartClip, true);
          const slideLoopAction = mk(slideLoopClip, false);
          const slideExitAction = mk(slideExitClip, true);
          const spellEnterAction = mk(spellEnterClip, true);
          const spellIdleAction = mk(spellIdleClip, false);
          const spellShootAction = mk(spellShootClip, true);
          const spellExitAction = mk(spellExitClip, true);

          idleAction.play();
          this.charActions = {
            idle: idleAction,
            walk: walkAction,
            run: runAction,
            jumpStart: jumpStartAction,
            jumpLoop: jumpLoopAction,
            jumpLand: jumpLandAction,
            glide: glideAction,
            crouch: crouchAction,
            crouchWalk: crouchWalkAction,
            attack: attackAction,
            roll: rollAction,
            slideStart: slideStartAction,
            slideLoop: slideLoopAction,
            slideExit: slideExitAction,
            spellEnter: spellEnterAction,
            spellIdle: spellIdleAction,
            spellShoot: spellShootAction,
            spellExit: spellExitAction,
          };
          this.charCurrentAction = idleAction;

          this.charMixer.addEventListener("finished", (e) => {
            if (attackAction && e.action === attackAction) {
              this.charAttacking = false;
              return;
            }
            if (rollAction && e.action === rollAction) {
              this.charRolling = false;
              return;
            }
            if (jumpStartAction && e.action === jumpStartAction) {
              if (this.charInAir && jumpLoopAction) {
                this.charJumpPhase = "loop";
                jumpLoopAction.reset().enabled = true;
                jumpLoopAction
                  .crossFadeFrom(jumpStartAction, 0.08, false)
                  .play();
                this.charCurrentAction = jumpLoopAction;
              }
              return;
            }
            if (jumpLandAction && e.action === jumpLandAction) {
              this.charJumpPhase = "none";
              return;
            }
            if (slideStartAction && e.action === slideStartAction) {
              if (this.charSlidePhase === "start" && slideLoopAction) {
                this.charSlidePhase = "loop";
                slideLoopAction.reset().enabled = true;
                slideLoopAction
                  .crossFadeFrom(slideStartAction, 0.1, false)
                  .play();
                this.charCurrentAction = slideLoopAction;
              }
              return;
            }
            if (slideExitAction && e.action === slideExitAction) {
              this.charSlidePhase = "none";
              return;
            }
            if (spellEnterAction && e.action === spellEnterAction) {
              if (this.charSpellPhase !== "enter") return;
              if (this.charSpellExitRequested && spellExitAction) {
                this.charSpellPhase = "exit";
                spellExitAction.reset().enabled = true;
                spellExitAction
                  .crossFadeFrom(spellEnterAction, 0.12, false)
                  .play();
                this.charCurrentAction = spellExitAction;
              } else if (spellIdleAction) {
                this.charSpellPhase = "idle";
                spellIdleAction.reset().enabled = true;
                spellIdleAction
                  .crossFadeFrom(spellEnterAction, 0.12, false)
                  .play();
                this.charCurrentAction = spellIdleAction;
              }
              return;
            }
            if (spellShootAction && e.action === spellShootAction) {
              if (this.charSpellPhase !== "shoot") return;
              if (this.charSpellExitRequested && spellExitAction) {
                this.charSpellPhase = "exit";
                spellExitAction.reset().enabled = true;
                spellExitAction
                  .crossFadeFrom(spellShootAction, 0.12, false)
                  .play();
                this.charCurrentAction = spellExitAction;
              } else if (spellIdleAction) {
                this.charSpellPhase = "idle";
                spellIdleAction.reset().enabled = true;
                spellIdleAction
                  .crossFadeFrom(spellShootAction, 0.12, false)
                  .play();
                this.charCurrentAction = spellIdleAction;
              }
              return;
            }
            if (spellExitAction && e.action === spellExitAction) {
              this.charSpellPhase = "none";
              this.charSpellExitRequested = false;
              if (idleAction) {
                idleAction.reset().enabled = true;
                idleAction.crossFadeFrom(spellExitAction, 0.2, false).play();
                this.charCurrentAction = idleAction;
              }
              return;
            }
          });
        }
        this.charLoaded = true;
        if (this.active && this.moveMode === "char") {
          this.charRoot.visible = true;
          this.capsule.visible = false;
        }
        console.log("[V2] Character loaded");
      },
      undefined,
      (err) => console.warn("[V2] Character load failed:", err),
    );
  }

  _charSetAction(next, fade = 0.18) {
    if (!this.charActions || !next || next === this.charCurrentAction) return;
    next.enabled = true;
    next.reset();
    next.crossFadeFrom(this.charCurrentAction, fade, false).play();
    this.charCurrentAction = next;
  }

  async _loadPlane() {
    try {
      const { submeshes } = await loadTreeGlbFromUrl(PLANE_MODEL);
      const inner = new THREE.Group();
      for (const sm of submeshes) {
        const mesh = new THREE.Mesh(sm.geometry, sm.material);
        mesh.applyMatrix4(sm.localMatrix);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        inner.add(mesh);
      }
      inner.rotation.y = Math.PI;
      inner.updateMatrixWorld(true);
      const box0 = new THREE.Box3().setFromObject(inner);
      if (!box0.isEmpty()) {
        const size0 = box0.getSize(new THREE.Vector3());
        const max0 = Math.max(size0.x, size0.y, size0.z);
        const targetSpan = 2.8 * (CAP_H + 2 * CAP_R);
        inner.scale.setScalar(targetSpan / max0);
        inner.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(inner);
        inner.position.set(
          -((box.min.x + box.max.x) * 0.5),
          -box.min.y,
          -((box.min.z + box.max.z) * 0.5),
        );
      }
      this.planeRoot = new THREE.Group();
      this.planeRoot.rotation.order = "YXZ";
      this.planeRoot.add(inner);
      this.planeRoot.visible = false;
      this.scene.add(this.planeRoot);
      if (this._excludeFromReflection)
        this._excludeFromReflection(this.planeRoot);
      this._planeInner = inner;

      // Create wingtip contrails
      inner.updateMatrixWorld(true);
      const wingBox = new THREE.Box3().setFromObject(inner);
      const wbSz = new THREE.Vector3();
      wingBox.getSize(wbSz);
      const tipXL = wingBox.min.x;
      const tipXR = wingBox.max.x;
      const zBack = wingBox.max.z - wbSz.z * 0.08;
      const yMid = (wingBox.min.y + wingBox.max.y) * 0.5;
      const tmpW = new THREE.Vector3();

      tmpW.set(tipXL, yMid, zBack);
      inner.worldToLocal(tmpW);
      this._wingOffsets.push(tmpW.clone());
      this._wingTrails.push(createWingTrailMesh(this.scene, this._trailMat));

      tmpW.set(tipXR, yMid, zBack);
      inner.worldToLocal(tmpW);
      this._wingOffsets.push(tmpW.clone());
      this._wingTrails.push(createWingTrailMesh(this.scene, this._trailMat));

      // Gun muzzle offsets (inboard from wingtips, near nose)
      const zFront = wingBox.min.z + wbSz.z * 0.05;
      const wingHalfX = wbSz.x * 0.5;
      const muzzleHalfSpan = wingHalfX * 0.42;
      const cxW = (wingBox.min.x + wingBox.max.x) * 0.5;
      tmpW.set(cxW - muzzleHalfSpan, yMid, zFront);
      inner.worldToLocal(tmpW);
      this._muzzleOffsets.push(tmpW.clone());
      tmpW.set(cxW + muzzleHalfSpan, yMid, zFront);
      inner.worldToLocal(tmpW);
      this._muzzleOffsets.push(tmpW.clone());

      this.planeLoaded = true;
      if (this.active && this.moveMode === "fly") {
        this.planeRoot.visible = true;
        this.capsule.visible = false;
      }
    } catch (err) {
      console.warn("[V2] Failed to load plane model:", err);
    }
  }

  get flying() {
    return this.moveMode === "fly" && this.planeLoaded;
  }
  get carMode() {
    return (
      this.moveMode === "car" ||
      this.moveMode === "lotus" ||
      this.moveMode === "vvv" ||
      this.moveMode === "stunt"
    );
  }
  get vvvDriving() {
    return this.moveMode === "vvv";
  }
  /** Rigid-body cars (own physics, kinematic car paths gated off): vvv + stunt. */
  get rigidDriving() {
    return this.moveMode === "vvv" || this.moveMode === "stunt";
  }

  _clearTrails() {
    for (const trail of this._wingTrails) {
      trail.history.length = 0;
      trail.mesh.visible = false;
    }
  }

  _updateTrails() {
    if (!this._planeInner || this._wingTrails.length === 0) return;
    if (this.planeRoot?.visible) {
      this._planeInner.updateMatrixWorld(true);
      for (let i = 0; i < this._wingTrails.length; i++) {
        sampleTrail(
          this._wingTrails[i],
          this._planeInner,
          this._wingOffsets[i],
        );
        rebuildTrail(this._wingTrails[i]);
        this._wingTrails[i].mesh.visible = true;
      }
    } else {
      this._clearTrails();
      clearBullets(this._bullets.pool);
    }
  }

  /**
   * @param {object} [opts]
   * @param {boolean} [opts.editorRelaxedPointer] — If true, keep system cursor and UI (no pointer lock). Use RMB drag on canvas to look around in follow / fly.
   */
  enter(opts = {}) {
    if (this.active) return;
    this.active = true;
    this.camView = "follow";
    this.moveMode = "capsule";
    this.velY = 0;
    this.inAir = false;
    this.isoYaw = Math.PI / 4;
    this.isoDist = ISO_DIST_DEFAULT;
    this._moveTarget = null;
    this.flyHeight = 0;
    this.flyPitch = 0;
    this.flyRoll = 0;
    this.flyRollTarget = 0;
    this.flyBarrelActive = false;
    this.flyBarrelPhase = 0;
    this.flyAileronAngle = 0;

    this.savedCamPos = this.camera.position.clone();
    this.savedTarget = this.controls.target.clone();
    const spawn = this.spawnSettings;
    if (spawn?.enabled) {
      const half = this.worldHalf || Infinity;
      this.playerPos.set(
        THREE.MathUtils.clamp(spawn.x || 0, -half, half),
        0,
        THREE.MathUtils.clamp(spawn.z || 0, -half, half),
      );
    } else {
      this.playerPos.set(this.controls.target.x, 0, this.controls.target.z);
    }
    this.playerPos.y = this.getWorldHeight(this.playerPos.x, this.playerPos.z);
    this.camYaw = spawn?.enabled
      ? THREE.MathUtils.degToRad(spawn.yawDeg || 0)
      : 0;
    this.camPitch = 0.35;
    this._camCollisionDist = 1;

    this.capsule.visible = true;
    if (this.planeRoot) this.planeRoot.visible = false;
    if (this.charRoot) this.charRoot.visible = false;
    if (this.carRoot) this.carRoot.visible = false;
    if (this.lotusRoot) this.lotusRoot.visible = false;
    this.driftMarks.reset();
    this.driftSmoke.reset();
    this._clearTrails();
    clearBullets(this._bullets.pool);
    this.controls.enabled = false;

    document.addEventListener("keydown", this._onKeyDown);
    document.addEventListener("keyup", this._onKeyUp);
    document.addEventListener("mousemove", this._onMouseMove);
    document.addEventListener("pointerlockchange", this._onPointerLockChange);
    this.renderer.domElement.addEventListener("click", this._onIsoClick);
    this.renderer.domElement.addEventListener(
      "pointermove",
      this._onIsoPointerMove,
    );
    this.renderer.domElement.addEventListener("wheel", this._onIsoWheel, {
      passive: false,
    });
    this.renderer.domElement.addEventListener(
      "pointerdown",
      this._onRtsPointerDown,
    );
    this.renderer.domElement.addEventListener(
      "pointerup",
      this._onRtsPointerUp,
    );
    this.renderer.domElement.addEventListener(
      "contextmenu",
      this._onRtsContextMenu,
    );

    this._editorRelaxedPointer = !!opts.editorRelaxedPointer;
    this._rmbLookActive = false;
    if (this._editorRelaxedPointer) {
      this.renderer.domElement.style.cursor = "";
      this._attachRelaxedPointerListeners();
    } else {
      this.renderer.domElement.style.cursor = "none";
      this.renderer.domElement.requestPointerLock();
    }

    if (this._modePill) this._modePill.style.display = "block";
    this._updateModePill();
    this._applyCameraFov();
    if (this._cameraTuningGuiModeShown !== this.moveMode) {
      this._rebuildCameraTuningGui();
    }
    this._refreshCameraTuningGuiVisible();
    this.paused = false;
    this.timeScale = 1;
    this._frameStepPending = 0;
    this._updatePauseBadge();
  }

  _attachRelaxedPointerListeners() {
    const el = this.renderer.domElement;
    el.addEventListener("pointerdown", this._onRelaxedPointerDown);
    el.addEventListener("pointerup", this._onRelaxedPointerUp);
    el.addEventListener("contextmenu", this._onRelaxedContextMenu);
  }

  _detachRelaxedPointerListeners() {
    const el = this.renderer.domElement;
    el.removeEventListener("pointerdown", this._onRelaxedPointerDown);
    el.removeEventListener("pointerup", this._onRelaxedPointerUp);
    el.removeEventListener("contextmenu", this._onRelaxedContextMenu);
  }

  /** Call when toggling editor immersive vs windowed while play stays active. */
  setEditorPointerMode(relaxed) {
    if (!this.active) return;
    this._rmbLookActive = false;
    this._detachRelaxedPointerListeners();
    if (document.pointerLockElement) document.exitPointerLock();
    this._editorRelaxedPointer = !!relaxed;
    const el = this.renderer.domElement;
    if (relaxed) {
      el.style.cursor = "";
      this._attachRelaxedPointerListeners();
    } else if (this.camView === "follow") {
      el.style.cursor = "none";
      el.requestPointerLock();
    } else {
      el.style.cursor = "";
    }
  }

  _onRelaxedPointerDown(e) {
    if (!this.active || !this._editorRelaxedPointer) return;
    if (e.button === 2) {
      e.preventDefault();
      this._rmbLookActive = true;
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch (_) {
        /* ignore */
      }
    }
  }

  _onRelaxedPointerUp(e) {
    if (!this.active || !this._editorRelaxedPointer) return;
    if (e.button === 2) {
      this._rmbLookActive = false;
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch (_) {
        /* ignore */
      }
    }
  }

  _onRelaxedContextMenu(e) {
    if (!this.active || !this._editorRelaxedPointer) return;
    e.preventDefault();
  }

  _onRtsPointerDown(e) {
    if (!this.active || this.moveMode !== "rts" || this.detached) return;
    if (e.button === 2) {
      e.preventDefault();
      this.rtsRmbDrag = true;
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch (_) {
        /* ignore */
      }
    }
  }

  _onRtsPointerUp(e) {
    if (!this.active) return;
    if (e.button === 2 && this.rtsRmbDrag) {
      this.rtsRmbDrag = false;
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch (_) {
        /* ignore */
      }
    }
  }

  _onRtsContextMenu(e) {
    if (!this.active || this.moveMode !== "rts") return;
    e.preventDefault();
  }

  exit() {
    if (!this.active) return;
    if (this.detached) this._exitDetached();
    this.active = false;
    this._moveTarget = null;
    this.isoHoverRing.visible = false;
    this.isoTargetRing.visible = false;
    for (const k of Object.keys(this.keysHeld)) delete this.keysHeld[k];

    this.capsule.visible = false;
    if (this.planeRoot) this.planeRoot.visible = false;
    if (this.charRoot) this.charRoot.visible = false;
    if (this.carRoot) this.carRoot.visible = false;
    if (this.lotusRoot) this.lotusRoot.visible = false;
    if (this.vvvRoot) this.vvvRoot.visible = false;
    if (this.vvvWheels) {
      for (const w of this.vvvWheels) w.container.visible = false;
    }
    if (this._flyHud) this._flyHud.style.display = "none";
    if (this._carHud) this._carHud.style.display = "none";
    if (this._carSpeedometer) this._carSpeedometer.style.display = "none";
    if (this._modePill) this._modePill.style.display = "none";
    this._closeModeWheel(false);
    this._refreshCameraTuningGuiVisible();
    this.paused = false;
    this.timeScale = 1;
    this._frameStepPending = 0;
    if (this._pauseBadge) this._pauseBadge.style.display = "none";
    if (this.camera.fov !== 60) {
      this.camera.fov = 60;
      this.camera.updateProjectionMatrix();
    }
    if (this._lotusCamGui) this._lotusCamGui.domElement.style.display = "none";
    if (this._vvvCamGui) this._vvvCamGui.domElement.style.display = "none";
    if (this._jeepTuningGui)
      this._jeepTuningGui.domElement.style.display = "none";
    this.planeSpeed = 0;
    this.planeNitro = PLANE_NITRO_FULL;
    this._planeHudSpdSmooth = 0;
    this._planeHudAltSmooth = 0;
    this._planeHudNitroSmooth = PLANE_NITRO_FULL;
    this.carVx = 0;
    this.carVz = 0;
    this.carNitro = 1.0;
    this._hudKmhSmooth = 0;
    this._hudNitroSmooth = 1;
    this._carBoostBlend = 0;
    this._carNitroFxBlend = 0;
    this.carBodyRoll = 0;
    this.carBodyPitch = 0;
    this.carTerrainRoll = 0;
    this.carTerrainPitch = 0;
    this.driftMarks.reset();
    this.driftSmoke.reset();
    this._clearTrails();
    clearBullets(this._bullets.pool);

    this.camera.up.set(0, 1, 0);
    if (this.savedCamPos) this.camera.position.copy(this.savedCamPos);
    if (this.savedTarget) {
      this.controls.target.copy(this.savedTarget);
      this.camera.lookAt(this.savedTarget);
    }
    this.controls.enabled = true;

    document.removeEventListener("keydown", this._onKeyDown);
    document.removeEventListener("keyup", this._onKeyUp);
    document.removeEventListener("mousemove", this._onMouseMove);
    document.removeEventListener(
      "pointerlockchange",
      this._onPointerLockChange,
    );
    this.renderer.domElement.removeEventListener("click", this._onIsoClick);
    this.renderer.domElement.removeEventListener(
      "pointermove",
      this._onIsoPointerMove,
    );
    this.renderer.domElement.removeEventListener("wheel", this._onIsoWheel);
    this.renderer.domElement.removeEventListener(
      "pointerdown",
      this._onRtsPointerDown,
    );
    this.renderer.domElement.removeEventListener(
      "pointerup",
      this._onRtsPointerUp,
    );
    this.renderer.domElement.removeEventListener(
      "contextmenu",
      this._onRtsContextMenu,
    );

    this._detachRelaxedPointerListeners();
    this._editorRelaxedPointer = false;
    this._rmbLookActive = false;
    if (document.pointerLockElement) document.exitPointerLock();
    this.renderer.domElement.style.cursor = "";
  }

  /**
   * Snap the player back to the configured spawn point and clear all per-mode
   * velocity / airborne state. Called by the killplane safety net when the
   * player has fallen below `KILLPLANE_Y` (typically because they walked into
   * a terrain hole with no cave to catch them). Uses `getWorldHeight` rather
   * than `getTerrainHeight` for the Y snap so a spawn point that happens to
   * sit over a hole still lands on the heightfield's underlying surface —
   * they'll drop in again next frame, but at least they won't loop while
   * already below the world.
   */
  _respawnToSpawn() {
    const spawn = this.spawnSettings;
    const half = this.worldHalf || Infinity;
    let sx, sz, syaw;
    if (spawn?.enabled) {
      sx = THREE.MathUtils.clamp(spawn.x || 0, -half, half);
      sz = THREE.MathUtils.clamp(spawn.z || 0, -half, half);
      syaw = THREE.MathUtils.degToRad(spawn.yawDeg || 0);
    } else {
      sx = this.controls.target.x;
      sz = this.controls.target.z;
      syaw = 0;
    }
    this.playerPos.x = sx;
    this.playerPos.z = sz;
    this.playerPos.y = this.getWorldHeight(sx, sz);

    this.velY = 0;
    this.inAir = false;
    this.charVelY = 0;
    this.charInAir = false;
    this.charJumpPhase = "none";
    this.charGliding = false;
    this.carVelY = 0;
    this.carInAir = false;
    this.carOnSteepSlope = false;
    this.carVx = 0;
    this.carVz = 0;
    this.planeSpeed = 0;
    this.flyHeight = this.playerPos.y + 2;

    this.camYaw = syaw;
    this.charYaw = syaw;
    this.carHeading = syaw;
    this.carCamYaw = syaw;
    this.flyHeading = syaw;
  }

  update(dtSec) {
    if (!this.active) return;
    dtSec = Math.min(dtSec, 0.05);
    // Time controls: paused → dt=0 (unless single frame-step requested), slow-mo → dt scaled.
    if (this.paused) {
      if (this._frameStepPending > 0) {
        dtSec = 1 / 60;
        this._frameStepPending--;
      } else {
        dtSec = 0;
      }
    } else if (this.timeScale !== 1) {
      dtSec *= this.timeScale;
    }

    // Killplane: if the player has dropped well below the world (e.g. fell
    // into a terrain hole with no cave under it), teleport them back to
    // spawn. Flying players are exempt — pilots may legitimately fly low.
    if (!this.flying && this.playerPos.y < KILLPLANE_Y) {
      this._respawnToSpawn();
    }

    // RTS / Director mode — pure top-down free camera, no pawn updates.
    if (this.moveMode === "rts" && !this.detached) {
      this._updateRtsCamera(dtSec);
      return;
    }

    const iso = this.camView === "iso";
    const keys = this.keysHeld;
    const flying = this.flying;

    // Iso yaw rotation (capsule only, fly chases heading)
    if (iso && !flying) {
      if (keys.BracketLeft) this.isoYaw += ISO_YAW_ROT_SPEED * dtSec;
      if (keys.BracketRight) this.isoYaw -= ISO_YAW_ROT_SPEED * dtSec;
    }

    // Iso fly: A/D yaw the plane
    if (flying && iso) {
      if (keys.KeyA || keys.ArrowLeft)
        this.flyHeading += ISO_FLY_YAW_RATE * dtSec;
      if (keys.KeyD || keys.ArrowRight)
        this.flyHeading -= ISO_FLY_YAW_RATE * dtSec;
    }

    // Movement direction
    let mx = 0,
      mz = 0;
    if (flying) {
      // Throttle-style airspeed
      const thr =
        keys.KeyW || keys.ArrowUp ? 1 : keys.KeyS || keys.ArrowDown ? -1 : 0;
      const drag = PLANE_DRAG * this.planeSpeed * Math.abs(this.planeSpeed);
      let coast = PLANE_COAST;
      const deckAgl =
        this.flyHeight -
        this.getWorldHeight(this.playerPos.x, this.playerPos.z);
      if (deckAgl < PLANE_DECK_ALT) coast *= PLANE_DECK_COAST_MULT;
      if (thr === 1) {
        let a = PLANE_ACCEL;
        if (keys.ShiftLeft || keys.ShiftRight) a *= PLANE_SHIFT_ACCEL_MULT;
        this.planeSpeed += a * dtSec;
      } else if (thr === -1) {
        if (this.planeSpeed > 0.55) this.planeSpeed -= PLANE_BRAKE * dtSec;
        else this.planeSpeed -= PLANE_REV_ACCEL * dtSec;
      } else {
        if (this.planeSpeed > 0)
          this.planeSpeed = Math.max(
            0,
            this.planeSpeed - (coast + drag) * dtSec,
          );
        else if (this.planeSpeed < 0)
          this.planeSpeed = Math.min(
            0,
            this.planeSpeed + (coast + drag) * dtSec,
          );
      }
      const maxFwd =
        keys.ShiftLeft || keys.ShiftRight ? PLANE_MAX_FWD_BOOST : PLANE_MAX_FWD;
      this.planeSpeed = THREE.MathUtils.clamp(
        this.planeSpeed,
        -PLANE_MAX_REV,
        maxFwd,
      );
      if (Math.abs(this.planeSpeed) < 0.04 && thr === 0) this.planeSpeed = 0;
      const spdAbs = Math.abs(this.planeSpeed);
      if (spdAbs > 1e-4) {
        const sg = Math.sign(this.planeSpeed);
        mx = -Math.sin(this.flyHeading) * sg;
        mz = -Math.cos(this.flyHeading) * sg;
      }
    } else if (this.carMode && !this.rigidDriving) {
      // Rigid cars (VVV/Stunt) bypass the kinematic Bruno/Lotus input block —
      // their physics reads keys directly and drives the body via forces.
      const forward = keys.KeyW || keys.ArrowUp;
      const backward = keys.KeyS || keys.ArrowDown;
      const leftKey = keys.KeyA || keys.ArrowLeft;
      const rightKey = keys.KeyD || keys.ArrowRight;
      const handbrake = keys.Space;
      const nitroHeld = !!keys[CAR_NITRO_KEY];
      const boostKeys = keys.ShiftLeft || keys.ShiftRight;

      // ── Shared arcade drift model (Bruno + Lotus) ──
      const carFeel = this.carSettings;
      const accelScale = carFeel.accelScale ?? 1;
      const maxSpeedScale = carFeel.maxSpeedScale ?? 1;

      // Current speed from velocity vector
      const curSpeed = Math.sqrt(
        this.carVx * this.carVx + this.carVz * this.carVz,
      );

      // Heading direction
      const hx = -Math.sin(this.carHeading);
      const hz = -Math.cos(this.carHeading);

      // Throttle / brake applied along heading
      const nitroActive =
        nitroHeld && this.carNitro > CAR_NITRO_MIN_TO_USE && !backward;

      this._carBoostBlend = _expSmoothStep(
        this._carBoostBlend,
        boostKeys ? 1 : 0,
        dtSec,
        CAR_BOOST_BLEND_SMOOTH,
      );
      this._carNitroFxBlend = _expSmoothStep(
        this._carNitroFxBlend,
        nitroActive ? 1 : 0,
        dtSec,
        CAR_NITRO_FX_BLEND_SMOOTH,
      );

      const accelBase = THREE.MathUtils.lerp(
        CAR_ACCEL,
        CAR_ACCEL_BOOST,
        this._carBoostBlend,
      );
      let accel =
        (accelBase + this._carNitroFxBlend * CAR_NITRO_ACCEL_BONUS) *
        accelScale;
      if (!boostKeys && !nitroActive) {
        const speedKmh = curSpeed * 3.6;
        const rampT = THREE.MathUtils.smoothstep(
          speedKmh,
          0,
          CAR_BASE_ACCEL_RAMP_TO_KMH,
        );
        const accelMul = THREE.MathUtils.lerp(
          CAR_BASE_ACCEL_LOW_SPEED_MUL,
          1.0,
          rampT,
        );
        accel *= accelMul;
      }
      // Reduce acceleration on steep slopes
      if (this.carOnSteepSlope) {
        accel *= 0.1;
      }
      if (forward) {
        this.carVx += hx * accel * dtSec;
        this.carVz += hz * accel * dtSec;
      } else if (backward) {
        if (curSpeed > 1) {
          this.carVx -= hx * CAR_BRAKE * accelScale * dtSec;
          this.carVz -= hz * CAR_BRAKE * accelScale * dtSec;
        } else {
          this.carVx -= hx * CAR_REVERSE_ACCEL * accelScale * dtSec;
          this.carVz -= hz * CAR_REVERSE_ACCEL * accelScale * dtSec;
        }
      } else if (curSpeed > 0.05) {
        const decel = CAR_COAST / curSpeed;
        this.carVx -= this.carVx * decel * dtSec;
        this.carVz -= this.carVz * decel * dtSec;
      } else {
        this.carVx = 0;
        this.carVz = 0;
      }

      // Handbrake: slight decel
      if (handbrake && curSpeed > 0.1) {
        const decel = CAR_HANDBRAKE_DECEL / curSpeed;
        this.carVx -= this.carVx * decel * dtSec;
        this.carVz -= this.carVz * decel * dtSec;
      }

      // Drag
      const speed2 = this.carVx * this.carVx + this.carVz * this.carVz;
      if (speed2 > 0.01) {
        const spd = Math.sqrt(speed2);
        const dragForce = CAR_DRAG * spd;
        const factor = Math.max(0, 1 - dragForce * dtSec);
        this.carVx *= factor;
        this.carVz *= factor;
      }

      // Clamp speed (boost / nitro caps ease via blended factors — avoids instant snap on Shift release)
      const maxBase = THREE.MathUtils.lerp(
        CAR_MAX_SPEED,
        CAR_MAX_SPEED_BOOST,
        this._carBoostBlend,
      );
      const maxSpd =
        (maxBase + this._carNitroFxBlend * CAR_NITRO_MAX_SPEED_BONUS) *
        maxSpeedScale;
      const newSpeed = Math.sqrt(
        this.carVx * this.carVx + this.carVz * this.carVz,
      );
      if (newSpeed > maxSpd) {
        const s = maxSpd / newSpeed;
        this.carVx *= s;
        this.carVz *= s;
      }

      // Nitro tank
      if (nitroActive && curSpeed > 1) {
        this.carNitro = Math.max(
          0,
          this.carNitro - CAR_NITRO_DRAIN_PER_SEC * dtSec,
        );
      } else {
        this.carNitro = Math.min(
          1,
          this.carNitro + CAR_NITRO_REGEN_PER_SEC * dtSec,
        );
      }

      // Steering — rotate heading
      let steerInput = 0;
      if (leftKey) steerInput = 1;
      if (rightKey) steerInput = -1;

      if (steerInput !== 0 && curSpeed > 0.5) {
        const turnRate = this.carDrifting ? CAR_TURN_RATE_DRIFT : CAR_TURN_RATE;
        this.carHeading += steerInput * turnRate * dtSec;
      }

      // Grip: project velocity onto heading, get forward and lateral components
      const fwdDot = this.carVx * hx + this.carVz * hz;
      const rx = Math.cos(this.carHeading);
      const rz = -Math.sin(this.carHeading);
      const latDot = this.carVx * rx + this.carVz * rz;

      // Choose grip strength
      let grip;
      if (handbrake && curSpeed > CAR_DRIFT_ENTRY_SPEED && steerInput !== 0) {
        grip = CAR_GRIP_DRIFT;
      } else if (backward && steerInput !== 0 && curSpeed > 3) {
        grip = CAR_GRIP_BRAKE_TURN;
      } else {
        grip = CAR_GRIP_NORMAL;
      }

      // Kill lateral velocity based on grip (high grip = car follows heading)
      const lateralKill = 1 - Math.exp(-grip * dtSec);
      this.carVx -= rx * latDot * lateralKill;
      this.carVz -= rz * latDot * lateralKill;

      // Drift detection
      this.carDriftAngle =
        curSpeed > 1 ? Math.abs(Math.atan2(latDot, Math.abs(fwdDot))) : 0;
      this.carDrifting =
        this.carDriftAngle > CAR_DRIFT_ANGLE_MIN &&
        curSpeed > CAR_DRIFT_ENTRY_SPEED;

      const latSign = Math.sign(latDot);
      const speedForRoll = Math.sqrt(
        this.carVx * this.carVx + this.carVz * this.carVz,
      );
      const driftRollSpeedGain = THREE.MathUtils.smoothstep(
        speedForRoll,
        8,
        24,
      );
      const driftRoll =
        -latSign *
        Math.min(CAR_BODY_ROLL_MAX, this.carDriftAngle * 0.85) *
        driftRollSpeedGain;
      const throttlePitch = forward ? 0.055 : backward ? -0.08 : 0;
      const speedNorm = Math.min(1, curSpeed / Math.max(1, CAR_MAX_SPEED));
      const dynamicPitch = -speedNorm * 0.05;
      const targetDynRoll = this.carDrifting ? driftRoll : 0;
      const targetDynPitch = dynamicPitch + throttlePitch;
      const smooth = 1 - Math.exp(-CAR_BODY_SMOOTH * dtSec);
      this.carBodyRoll = THREE.MathUtils.lerp(
        this.carBodyRoll,
        targetDynRoll,
        smooth,
      );
      this.carBodyPitch = THREE.MathUtils.lerp(
        this.carBodyPitch,
        targetDynPitch,
        smooth,
      );

      // Wheel spin
      this.carWheelSpin -= (fwdDot / CAR_WHEEL_RADIUS) * dtSec;

      // Movement output
      mx = this.carVx;
      mz = this.carVz;
    } else {
      const moveYaw = iso ? this.isoYaw : this.camYaw;
      if (keys.KeyW || keys.ArrowUp) {
        mx -= Math.sin(moveYaw);
        mz -= Math.cos(moveYaw);
      }
      if (keys.KeyS || keys.ArrowDown) {
        mx += Math.sin(moveYaw);
        mz += Math.cos(moveYaw);
      }
      if (keys.KeyA || keys.ArrowLeft) {
        mx -= Math.cos(moveYaw);
        mz += Math.sin(moveYaw);
      }
      if (keys.KeyD || keys.ArrowRight) {
        mx += Math.cos(moveYaw);
        mz -= Math.sin(moveYaw);
      }
    }

    if (!this.carMode) {
      this._carBoostBlend = 0;
      this._carNitroFxBlend = 0;
    }

    // Iso click-to-move is for on-foot modes; vehicles keep their own controls.
    if (iso && !flying && !this.carMode && this._moveTarget) {
      if (mx !== 0 || mz !== 0) {
        this._moveTarget = null;
        this.isoTargetRing.visible = false;
      } else {
        const dx = this._moveTarget.x - this.playerPos.x;
        const dz = this._moveTarget.z - this.playerPos.z;
        if (Math.hypot(dx, dz) < 0.35) {
          this._moveTarget = null;
          this.isoTargetRing.visible = false;
        } else {
          mx = dx;
          mz = dz;
        }
      }
    }

    const charMode = this.moveMode === "char" && this.charLoaded;
    const charRunning = charMode && (keys.ShiftLeft || keys.ShiftRight);
    const inRoll = charMode && this.charRolling;
    const inSlide = charMode && this.charSlidePhase !== "none";

    // Crouch (hold Ctrl, matches v1)
    if (charMode) {
      this.charCrouching =
        !this.charInAir &&
        !this.charRolling &&
        !inSlide &&
        !this.charAttacking &&
        (keys.ControlLeft || keys.ControlRight);
    }

    // Roll early exit at 75% when input held (matches v1)
    if (inRoll) {
      const _inputHeld =
        keys.KeyW ||
        keys.KeyA ||
        keys.KeyS ||
        keys.KeyD ||
        keys.ArrowUp ||
        keys.ArrowDown ||
        keys.ArrowLeft ||
        keys.ArrowRight;
      if (_inputHeld) {
        const rollT =
          (performance.now() - this.charRollStart) /
          1000 /
          this.charRollDuration;
        if (rollT >= 0.75) {
          this.charRolling = false;
          const tgt = this.charCrouching
            ? this.charActions?.crouchWalk
            : charRunning
              ? this.charActions?.run
              : this.charActions?.walk;
          if (tgt && this.charActions?.roll) {
            tgt.enabled = true;
            tgt.reset();
            tgt.crossFadeFrom(this.charActions.roll, 0.15, false).play();
            this.charCurrentAction = tgt;
          }
        }
      }
    }

    // Roll direction override (v1 uses sin/cos without negation, speed via _moveSpeed)
    let _charRollSpeed = 0;
    if (charMode && this.charRolling) {
      const elapsed = (performance.now() - this.charRollStart) / 1000;
      const t = Math.min(1, elapsed / this.charRollDuration);
      _charRollSpeed = CHAR_ROLL_PEAK * Math.cos(t * PI * 0.5);
      mx = Math.sin(this.charRollYaw);
      mz = Math.cos(this.charRollYaw);
    }

    // Slide direction override
    if (charMode && this.charSlidePhase !== "none") {
      mx = Math.sin(this.charSlideYaw);
      mz = Math.cos(this.charSlideYaw);
      if (this.charSlidePhase === "loop") {
        const elapsed = (performance.now() - this.charSlideStart) / 1000;
        if (
          (elapsed >= CHAR_SLIDE_MAX_TIME || !keys.KeyX) &&
          this.charActions?.slideExit
        ) {
          this.charSlidePhase = "exit";
          const se = this.charActions.slideExit;
          se.reset().enabled = true;
          se.crossFadeFrom(this.charCurrentAction, 0.12, false).play();
          this.charCurrentAction = se;
        }
      }
    }

    // Attack/spell freeze movement
    const inSpell = this.charSpellPhase !== "none";
    if (charMode && (this.charAttacking || inSpell)) {
      mx = 0;
      mz = 0;
    }

    if (this.dialogueMovementLock) {
      mx = 0;
      mz = 0;
      this._moveTarget = null;
      this.isoTargetRing.visible = false;
    }

    const mlen = Math.hypot(mx, mz);
    const carDriving = this.carMode;
    const vvvDriving = this.vvvDriving;
    const rigidDriving = this.rigidDriving;

    // Rigid-body cars (VVV + Stunt) run their own physics + sync playerPos /
    // carHeading BEFORE the kinematic carDriving paths below execute. Those
    // paths gate themselves with `!rigidDriving` so they no-op here. Camera /
    // HUD downstream read playerPos+carHeading and work transparently.
    if (vvvDriving) {
      this._updateVvvCar(dtSec);
    } else if (this.moveMode === "stunt") {
      this._updateStuntCar(dtSec);
    }

    const moveSpeed = flying
      ? Math.abs(this.planeSpeed)
      : carDriving
        ? 1
        : charMode
          ? this.charRolling
            ? _charRollSpeed
            : inSlide
              ? CHAR_SLIDE_SPEED
              : this.charCrouching
                ? CHAR_WALK_SPEED * 0.5
                : charRunning
                  ? CHAR_RUN_SPEED
                  : CHAR_WALK_SPEED
          : MOVE_SPEED;
    const prevPosX = this.playerPos.x;
    const prevPosZ = this.playerPos.z;
    if (mlen > 0) {
      let stepX, stepZ;
      if (carDriving) {
        stepX = mx * dtSec;
        stepZ = mz * dtSec;
      } else {
        stepX = (mx / mlen) * moveSpeed * dtSec;
        stepZ = (mz / mlen) * moveSpeed * dtSec;
      }

      if (this.cliffBvh?.baked && !flying) {
        if (carDriving && !rigidDriving) {
          const _vehSf =
            this.moveMode === "lotus"
              ? this.lotusRoot?.scale.x || 1
              : this.carRoot?.scale.x || CAR_MODEL_SCALE;
          const resolved = this._carPhysics.resolveMovement(
            this.playerPos.x,
            this.playerPos.z,
            stepX,
            stepZ,
            this.playerPos.y,
            this.carHeading,
            this.carVx,
            this.carVz,
            this.cliffBvh,
            _vehSf,
            this.moveMode === "lotus" ? this._carPhysics.lotusHull : null,
          );
          stepX = resolved.x - this.playerPos.x;
          stepZ = resolved.z - this.playerPos.z;
          this.carVx = resolved.vx;
          this.carVz = resolved.vz;
        } else {
          const margin = CAP_R + 0.05;
          const stepLen = Math.hypot(stepX, stepZ);
          const castDist = stepLen + margin;
          const px = this.playerPos.x;
          const pz = this.playerPos.z;
          const footY = this.playerPos.y + CAP_R;
          const waistY = this.playerPos.y + CAP_R + CAP_H * 0.5;
          const headY = this.playerPos.y + CAP_R + CAP_H;

          let blocked = false;
          const rayHeights = [footY, waistY, headY];
          for (let ri = 0; ri < 3; ri++) {
            const hit = this.cliffBvh.raycastLateral(
              px,
              rayHeights[ri],
              pz,
              stepX,
              stepZ,
              castDist,
            );
            if (hit) {
              const nx = hit.normal.x;
              const nz = hit.normal.z;
              const nLen = Math.hypot(nx, nz);
              if (nLen > 0.01) {
                const nnx = nx / nLen;
                const nnz = nz / nLen;
                const dot = stepX * nnx + stepZ * nnz;
                if (dot < 0) {
                  stepX -= dot * nnx;
                  stepZ -= dot * nnz;

                  const slideHit = this.cliffBvh.raycastLateral(
                    px,
                    rayHeights[ri],
                    pz,
                    stepX,
                    stepZ,
                    Math.hypot(stepX, stepZ) + margin,
                  );
                  if (slideHit) {
                    stepX = 0;
                    stepZ = 0;
                    blocked = true;
                  }
                  break;
                }
              }
            }
          }
        }
      }

      if (this.isBarrierBlocked) {
        const nx = this.playerPos.x + stepX;
        const nz = this.playerPos.z + stepZ;
        if (this.isBarrierBlocked(nx, nz)) {
          const canSlideX = !this.isBarrierBlocked(nx, this.playerPos.z);
          const canSlideZ = !this.isBarrierBlocked(this.playerPos.x, nz);
          if (canSlideX) {
            stepZ = 0;
            if (carDriving) this.carVz *= 0.25;
          } else if (canSlideZ) {
            stepX = 0;
            if (carDriving) this.carVx *= 0.25;
          } else {
            stepX = 0;
            stepZ = 0;
            if (carDriving) {
              this.carVx *= 0.1;
              this.carVz *= 0.1;
            }
          }
        }
      }

      const wh = this.worldHalf;
      this.playerPos.x = THREE.MathUtils.clamp(
        this.playerPos.x + stepX,
        -wh,
        wh,
      );
      this.playerPos.z = THREE.MathUtils.clamp(
        this.playerPos.z + stepZ,
        -wh,
        wh,
      );
    }

    // Ground height — cast downward from player's current Y + step-up margin,
    // not from infinity. This prevents teleporting to wall tops when walking
    // through doorways/holes — the ray only sees surfaces at or below the player.
    const terrainY = this.getTerrainHeight(this.playerPos.x, this.playerPos.z);
    let groundY = terrainY;
    if (this.cliffBvh?.baked) {
      const stepUp = 1.0;
      const fromY = this.playerPos.y + stepUp;
      const bvhY = this.cliffBvh.raycastHeightFrom(
        this.playerPos.x,
        fromY,
        this.playerPos.z,
      );
      // When the player is *underneath* the terrain (e.g. inside a cave they
      // fell into through a hole), the terrain surface is above their head
      // and must not be treated as ground — otherwise they'd snap back up.
      // In that case the BVH (cave floor) is the only valid ground; if the
      // BVH didn't catch them either, fall back to the hole sentinel.
      if (terrainY > fromY) groundY = bvhY ?? terrainY;
      else if (bvhY != null && bvhY > terrainY) groundY = bvhY;
    }
    const prevY = this.playerPos.y;
    const capsuleBase = CAP_R + CAP_H * 0.5;

    // Fly altitude — flyHeight is absolute world Y
    if (flying) {
      const agl = this.flyHeight - groundY;
      const spd = Math.abs(this.planeSpeed);
      const onDeck = agl < FLY_SURFACE_ALT && spd < FLY_SURFACE_SPEED;

      if (iso) {
        let climbDelta = 0;
        if (keys.Space) climbDelta += ISO_FLY_CLIMB_RATE * dtSec;
        if (keys.ShiftLeft || keys.ShiftRight)
          climbDelta -= ISO_FLY_DESCEND_RATE * dtSec;
        this.flyHeight = Math.max(groundY, this.flyHeight + climbDelta);
        const pitchTarget =
          climbDelta > 0.01 ? 0.3 : climbDelta < -0.01 ? -0.3 : 0;
        this.flyPitch = THREE.MathUtils.lerp(
          this.flyPitch,
          pitchTarget,
          1 - Math.exp(-9 * dtSec),
        );
      } else {
        const diveMult = this.flyPitch < 0 ? FLY_PITCH_DIVE_MULT : 1;
        this.flyHeight = Math.max(
          groundY,
          this.flyHeight +
            this.flyPitch * FLY_PITCH_CLIMB_SCALE * diveMult * dtSec,
        );
      }

      // Surface lock — taxi mode: decay pitch/roll/altitude toward ground when near surface at low speed
      if (onDeck) {
        const deckRate = 1 - Math.exp(-4 * dtSec);
        this.flyPitch = THREE.MathUtils.lerp(this.flyPitch, 0, deckRate);
        this.flyRollTarget = THREE.MathUtils.lerp(
          this.flyRollTarget,
          0,
          deckRate,
        );
        this.flyHeight = THREE.MathUtils.lerp(
          this.flyHeight,
          groundY,
          deckRate,
        );
      }

      // Barrel roll
      if (this.flyBarrelActive) {
        this.flyBarrelPhase += dtSec / FLY_BARREL_DURATION;
        if (this.flyBarrelPhase >= 1) {
          this.flyBarrelActive = false;
          this.flyBarrelPhase = 0;
        }
      }

      // Roll smoothing
      const dtRoll = Math.min(dtSec, 0.08);
      this.flyRollTarget = THREE.MathUtils.lerp(
        this.flyRollTarget,
        0,
        1 - Math.exp(-FLY_ROLL_TARGET_DECAY * dtRoll),
      );
      this.flyRoll = THREE.MathUtils.lerp(
        this.flyRoll,
        this.flyRollTarget,
        1 - Math.exp(-FLY_ROLL_SMOOTH * dtRoll),
      );

      // Aileron roll (Z / C) — persistent, camera follows
      if (!onDeck) {
        if (keys.KeyZ) this.flyAileronAngle += FLY_AILERON_RATE * dtSec;
        if (keys.KeyC) this.flyAileronAngle -= FLY_AILERON_RATE * dtSec;
      } else {
        const lvl = 1 - Math.exp(-3 * dtSec);
        this.flyAileronAngle *= 1 - lvl;
        if (Math.abs(this.flyAileronAngle) < 0.01) this.flyAileronAngle = 0;
      }
    } else if (charMode) {
      this.flyHeight = 0;

      // Glider toggle: rising-edge Space while airborne (checked BEFORE jump
      // so holding Space from the jump press doesn't immediately open it)
      const _charSpaceEdge = keys.Space && !this.charSpacePrev;
      if (_charSpaceEdge && this.charInAir) {
        this.charGliding = !this.charGliding;
      }

      // Character jump
      if (
        !this.charInAir &&
        !this.charCrouching &&
        !this.charRolling &&
        !this.charAttacking &&
        !inSlide &&
        this.charJumpPhase !== "land" &&
        keys.Space
      ) {
        this.charVelY = CHAR_JUMP_VEL;
        this.charInAir = true;
        if (this.charActions?.jumpStart) {
          this.charJumpPhase = "start";
          const js = this.charActions.jumpStart;
          js.reset().enabled = true;
          js.crossFadeFrom(this.charCurrentAction, 0.08, false).play();
          this.charCurrentAction = js;
        } else if (this.charActions?.jumpLoop) {
          this.charJumpPhase = "loop";
          const jl = this.charActions.jumpLoop;
          jl.reset().enabled = true;
          jl.crossFadeFrom(this.charCurrentAction, 0.08, false).play();
          this.charCurrentAction = jl;
        }
      }
      this.charSpacePrev = !!keys.Space;

      if (this.charInAir) {
        this.charVelY -= CHAR_GRAVITY * dtSec;
        if (this.charGliding) {
          this.charVelY = Math.max(this.charVelY, -CHAR_GLIDE_FALL_SPEED);
        }
        const prevY = this.charRoot ? this.charRoot.position.y : groundY;
        this.playerPos.y = prevY + this.charVelY * dtSec;
        if (this.charVelY > 0 && this.cliffBvh?.baked) {
          const headTop = this.playerPos.y + CAP_R * 2 + CAP_H;
          const ceilY = this.cliffBvh.raycastUp(
            this.playerPos.x,
            headTop,
            this.playerPos.z,
            this.charVelY * dtSec + 0.1,
          );
          if (ceilY != null) {
            this.playerPos.y = ceilY - CAP_R * 2 - CAP_H;
            this.charVelY = 0;
          }
        }
        if (this.playerPos.y <= groundY) {
          this.playerPos.y = groundY;
          this.charVelY = 0;
          this.charInAir = false;
          this.charGliding = false;
          const landInputHeld =
            keys.KeyW ||
            keys.KeyA ||
            keys.KeyS ||
            keys.KeyD ||
            keys.ArrowUp ||
            keys.ArrowDown ||
            keys.ArrowLeft ||
            keys.ArrowRight;
          if (landInputHeld && this.charActions) {
            this.charJumpPhase = "none";
            const tgt = charRunning
              ? this.charActions.run
              : this.charActions.walk;
            if (tgt) {
              tgt.enabled = true;
              tgt.reset();
              tgt.crossFadeFrom(this.charCurrentAction, 0.12, false).play();
              this.charCurrentAction = tgt;
            }
          } else if (this.charActions?.jumpLand) {
            this.charJumpPhase = "land";
            const jl = this.charActions.jumpLand;
            jl.reset().enabled = true;
            jl.crossFadeFrom(this.charCurrentAction, 0.1, false).play();
            this.charCurrentAction = jl;
          } else {
            this.charJumpPhase = "none";
          }
        }
      } else {
        const drop = prevY - groundY;
        if (drop > 0.4) {
          this.charInAir = true;
          this.charVelY = 0;
          this.playerPos.y = prevY;
          if (this.charActions?.jumpLoop && this.charJumpPhase !== "loop") {
            this.charJumpPhase = "loop";
            const jl = this.charActions.jumpLoop;
            jl.reset().enabled = true;
            jl.crossFadeFrom(this.charCurrentAction, 0.15, false).play();
            this.charCurrentAction = jl;
          }
        } else {
          this.playerPos.y = groundY;
        }
      }

      // Yaw
      if (inSpell) {
        let targetYaw = this.camYaw + PI;
        while (targetYaw > PI) targetYaw -= 2 * PI;
        while (targetYaw < -PI) targetYaw += 2 * PI;
        let dYaw = targetYaw - this.charYaw;
        while (dYaw > PI) dYaw -= 2 * PI;
        while (dYaw < -PI) dYaw += 2 * PI;
        this.charYaw += dYaw * (1 - Math.exp(-14 * dtSec));
      } else if (
        mlen > 0 &&
        !this.charRolling &&
        !this.charAttacking &&
        !inSlide
      ) {
        const targetYaw = Math.atan2(mx, mz);
        let dYaw = targetYaw - this.charYaw;
        while (dYaw > PI) dYaw -= 2 * PI;
        while (dYaw < -PI) dYaw += 2 * PI;
        this.charYaw += dYaw * (1 - Math.exp(-14 * dtSec));
      }
    } else if (carDriving && !rigidDriving) {
      // Rigid cars (VVV/Stunt) bypass this block entirely — their physics
      // already ran above and synced playerPos / carHeading.
      this.flyHeight = 0;
      const _isLotus = this.moveMode === "lotus";
      const _sf = _isLotus
        ? this.lotusRoot?.scale.x || CAR_MODEL_SCALE
        : this.carRoot?.scale.x || CAR_MODEL_SCALE;

      if (_isLotus) {
        const lc = this._carPhysics.lotusChassis;
        const lp = this._lotusPhysics.params;
        lc.rideHeight = lp.rideHeight;
        lc.gravity = lp.gravity;
        lc.wheelBase = lp.wheelBase;
        lc.track = lp.track;
        lc.maxSlopeCos = lp.maxSlopeCos;
        lc.wheelBvhRayPadAboveHub = lp.wheelBvhRayPadAboveHub;
        lc.wheelBvHMaxAboveHub = lp.wheelBvHMaxAboveHub;
        this._carPhysics.lotusHull.rideHeight = lp.rideHeight;

        if (this.lotusWheels.length >= 4) {
          const hy = this.carHeading - CAR_MODEL_YAW + Math.PI;
          const c = Math.cos(hy);
          const s = Math.sin(hy);
          for (let i = 0; i < 4; i++) {
            const w = this.lotusWheels[i];
            const lx = w.offset.x * _sf;
            const lz = w.offset.z * _sf;
            this._wheelWorldXZs[i * 2] = this.playerPos.x + lx * c + lz * s;
            this._wheelWorldXZs[i * 2 + 1] = this.playerPos.z - lx * s + lz * c;
          }
        } else {
          for (let _wi = 0; _wi < 4; _wi++) {
            this._wheelWorldXZs[_wi * 2] = this.playerPos.x;
            this._wheelWorldXZs[_wi * 2 + 1] = this.playerPos.z;
          }
        }
      } else if (this.carWheels.length >= 4) {
        const _sinH = Math.sin(this.carHeading);
        const _cosH = Math.cos(this.carHeading);
        for (let _wi = 0; _wi < 4; _wi++) {
          const _lx = this.carWheels[_wi].offset.x * _sf;
          const _lz = this.carWheels[_wi].offset.z * _sf;
          this._wheelWorldXZs[_wi * 2] =
            this.playerPos.x + _lx * _cosH + _lz * _sinH;
          this._wheelWorldXZs[_wi * 2 + 1] =
            this.playerPos.z - _lx * _sinH + _lz * _cosH;
        }
      } else {
        for (let _wi = 0; _wi < 4; _wi++) {
          this._wheelWorldXZs[_wi * 2] = this.playerPos.x;
          this._wheelWorldXZs[_wi * 2 + 1] = this.playerPos.z;
        }
      }

      this._carPhysics.inAir = this.carInAir;
      this._carPhysics.velY = this.carVelY;
      const vert = this._carPhysics.updateSuspension(
        this.playerPos.y,
        this._wheelWorldXZs,
        _sf,
        this.carHeading,
        dtSec,
        this.getTerrainHeight,
        this.cliffBvh,
        this.carVx,
        this.carVz,
        false,
        _isLotus ? this._carPhysics.lotusChassis : null,
      );
      this.playerPos.y = vert.y;
      this.carVelY = this._carPhysics.velY;
      this.carInAir = this._carPhysics.inAir;
      this.carOnSteepSlope = this._carPhysics.onSteepSlope;
      this._carSlopeX = vert.slopeX;
      this._carSlopeZ = vert.slopeZ;
      this._carTerrainPitchTarget = vert.terrainPitch;
      this._carTerrainRollTarget = vert.terrainRoll;
      if (vert.slideVx || vert.slideVz) {
        this.carVx += vert.slideVx;
        this.carVz += vert.slideVz;
        if (vert.tooSteep) {
          const nx2 = vert.slideVx,
            nz2 = vert.slideVz;
          const nL = Math.hypot(nx2, nz2);
          if (nL > 1e-6) {
            const upDot = this.carVx * (nx2 / nL) + this.carVz * (nz2 / nL);
            if (upDot < 0) {
              this.carVx -= (nx2 / nL) * upDot * 0.8;
              this.carVz -= (nz2 / nL) * upDot * 0.8;
            }
          }
        }
      }
    } else {
      this.flyHeight = 0;

      // Capsule jump / gravity
      if (keys.Space && !this.inAir) {
        this.velY = JUMP_VEL;
        this.inAir = true;
      }
      if (this.inAir) {
        this.velY -= GRAVITY * dtSec;
        this.playerPos.y += this.velY * dtSec;
        if (this.velY > 0 && this.cliffBvh?.baked) {
          const headTop = this.playerPos.y + CAP_R * 2 + CAP_H;
          const ceilY = this.cliffBvh.raycastUp(
            this.playerPos.x,
            headTop,
            this.playerPos.z,
            this.velY * dtSec + 0.1,
          );
          if (ceilY != null) {
            this.playerPos.y = ceilY - CAP_R * 2 - CAP_H;
            this.velY = 0;
          }
        }
        if (this.playerPos.y <= groundY) {
          this.playerPos.y = groundY;
          this.velY = 0;
          this.inAir = false;
        }
      } else {
        const drop = prevY - groundY;
        if (drop > 0.4) {
          this.inAir = true;
          this.velY = 0;
          this.playerPos.y = prevY;
        } else {
          this.playerPos.y = groundY;
        }
      }
    }

    // Plane BVH collision — multi-ray: forward, left wing, right wing, up, down
    if (flying && this.cliffBvh?.baked) {
      const px = this.playerPos.x;
      const py = this.flyHeight;
      const pz = this.playerPos.z;
      const cosP = Math.cos(this.flyPitch);
      const sinP = Math.sin(this.flyPitch);
      const sinH = Math.sin(this.flyHeading);
      const cosH = Math.cos(this.flyHeading);
      const fwdX = -sinH * cosP;
      const fwdY = sinP;
      const fwdZ = -cosH * cosP;
      const rightX = cosH;
      const rightZ = -sinH;
      const planeRadius = 2.5;
      const wingSpan = 3.0;

      const moveDx = px - prevPosX;
      const moveDz = pz - prevPosZ;
      const moveLen = Math.hypot(moveDx, moveDz);
      // Swept collision stops high-speed tunneling through thin geometry.
      if (moveLen > 1e-5) {
        const sweep = this.cliffBvh.raycast3D(
          prevPosX,
          py,
          prevPosZ,
          moveDx,
          0,
          moveDz,
          moveLen + planeRadius,
        );
        if (sweep) {
          const nx = moveDx / moveLen;
          const nz = moveDz / moveLen;
          const safeDist = Math.max(0, sweep.distance - planeRadius * 0.9);
          this.playerPos.x = prevPosX + nx * safeDist;
          this.playerPos.z = prevPosZ + nz * safeDist;
          this.planeSpeed *= 0.75;
        }
      }

      const probeDist = Math.max(planeRadius, planeRadius + moveLen);
      const rays = [
        { dx: fwdX, dy: fwdY, dz: fwdZ, dist: probeDist },
        { dx: rightX, dy: 0, dz: rightZ, dist: wingSpan },
        { dx: -rightX, dy: 0, dz: -rightZ, dist: wingSpan },
        { dx: 0, dy: 1, dz: 0, dist: 1.5 },
        { dx: 0, dy: -1, dz: 0, dist: 1.5 },
      ];

      for (const r of rays) {
        const hit = this.cliffBvh.raycast3D(
          px,
          py,
          pz,
          r.dx,
          r.dy,
          r.dz,
          r.dist,
        );
        if (hit) {
          const pushDist = r.dist - hit.distance;
          if (pushDist > 0) {
            this.playerPos.x -= r.dx * pushDist;
            this.flyHeight -= r.dy * pushDist;
            this.playerPos.z -= r.dz * pushDist;
            if (this.flyHeight < groundY) this.flyHeight = groundY;
          }
        }
      }
    }

    // Capsule visual
    const capsuleCY = this.playerPos.y + capsuleBase;
    this.capsule.visible =
      this.moveMode === "capsule" ||
      (this.moveMode === "fly" && !this.planeLoaded) ||
      (this.moveMode === "char" && !this.charLoaded) ||
      (this.moveMode === "car" && !this.carLoaded) ||
      (this.moveMode === "lotus" && !this.lotusLoaded) ||
      (this.moveMode === "vvv" && !this.vvvLoaded);
    this.capsule.position.set(this.playerPos.x, capsuleCY, this.playerPos.z);
    if (mlen > 0) {
      this._lastMx = mx / mlen;
      this._lastMz = mz / mlen;
    }
    if (this._lastMx !== 0 || this._lastMz !== 0) {
      this.capsule.rotation.y =
        Math.atan2(this._lastMx, this._lastMz) + Math.PI;
    }

    // Character visual + animation
    if (this.charRoot) {
      this.charRoot.visible = charMode;
      if (charMode) {
        this.charRoot.position.set(
          this.playerPos.x,
          this.playerPos.y,
          this.playerPos.z,
        );
        this.charRoot.rotation.y = this.charYaw;
        if (this.charKite) this.charKite.visible = this.charGliding;
        // Glider pose
        if (this.charActions) {
          const wantGlide = this.charGliding && this.charActions.glide;
          if (wantGlide && !this.charGliderPoseActive) {
            this.charGliderPoseActive = true;
            const ga = this.charActions.glide;
            ga.reset().enabled = true;
            ga.crossFadeFrom(this.charCurrentAction, 0.15, false).play();
            this.charCurrentAction = ga;
          } else if (!wantGlide && this.charGliderPoseActive) {
            this.charGliderPoseActive = false;
            if (this.charInAir && this.charActions.jumpLoop) {
              const jl = this.charActions.jumpLoop;
              jl.reset().enabled = true;
              jl.crossFadeFrom(this.charCurrentAction, 0.15, false).play();
              this.charCurrentAction = jl;
              this.charJumpPhase = "loop";
            }
          }
        }
        // Locomotion picker
        if (
          this.charActions &&
          !this.charAttacking &&
          !this.charRolling &&
          !this.charGliderPoseActive &&
          this.charSlidePhase === "none" &&
          this.charJumpPhase === "none" &&
          this.charSpellPhase === "none"
        ) {
          let target = null;
          if (this.charCrouching)
            target =
              mlen > 0 ? this.charActions.crouchWalk : this.charActions.crouch;
          else if (mlen > 0)
            target = charRunning ? this.charActions.run : this.charActions.walk;
          else target = this.charActions.idle;
          if (target) this._charSetAction(target);
        }
        if (this.charMixer) this.charMixer.update(dtSec);
      }
    }

    // Plane visual
    if (this.planeRoot) {
      this.planeRoot.visible = flying;
      if (flying) {
        this.planeRoot.position.set(
          this.playerPos.x,
          this.flyHeight,
          this.playerPos.z,
        );
        let barrelAdd = 0;
        if (this.flyBarrelActive) {
          const t = Math.min(1, this.flyBarrelPhase);
          barrelAdd = t * t * (3 - 2 * t) * Math.PI * 2 * this.flyBarrelDir;
        }
        if (iso) {
          this.planeRoot.rotation.set(
            0,
            this.flyHeading,
            barrelAdd + this.flyAileronAngle,
          );
        } else {
          this.planeRoot.rotation.set(
            this.flyPitch,
            this.flyHeading,
            this.flyRoll + barrelAdd + this.flyAileronAngle,
          );
        }
      }
    }

    // Car visual — Bruno
    const isBruno = this.moveMode === "car";
    const isLotus = this.moveMode === "lotus";
    let anyCarRendered = false;

    // Hide debug contact dots when not in Bruno mode
    if (this._carDebugContactDots) {
      const show = isBruno && this.carLoaded;
      for (const d of this._carDebugContactDots) d.visible = show;
    }

    if (this.carRoot) {
      this.carRoot.visible = isBruno && this.carLoaded;
      if (isBruno && this.carLoaded) {
        anyCarRendered = true;
        const scaleFactor = this.carRoot.scale.x || CAR_MODEL_SCALE;
        const halfWB = CAR_WHEEL_BASE * 0.5;
        const halfTr = CAR_TRACK * 0.5;

        // Step 1: Body position from center ground (stable, single sample)
        const rootY =
          this.playerPos.y + (CAR_RIDE_HEIGHT + CAR_WHEEL_RADIUS) * scaleFactor;
        this.carRoot.position.set(this.playerPos.x, rootY, this.playerPos.z);
        this.carRoot.rotation.y = this.carHeading;

        // Step 2: Body pitch/roll from 4-wheel contact plane
        const targetPitch = this._carTerrainPitchTarget || 0;
        const targetRoll = this._carTerrainRollTarget || 0;

        const terrainSmooth = 1 - Math.exp(-CAR_TERRAIN_BODY_SMOOTH * dtSec);
        if (this.carInAir) {
          this.carTerrainPitch = THREE.MathUtils.lerp(
            this.carTerrainPitch,
            this._carPhysics.airPitch,
            terrainSmooth,
          );
          this.carTerrainRoll = THREE.MathUtils.lerp(
            this.carTerrainRoll,
            0,
            terrainSmooth,
          );
        } else {
          this.carTerrainPitch = THREE.MathUtils.lerp(
            this.carTerrainPitch,
            targetPitch,
            terrainSmooth,
          );
          this.carTerrainRoll = THREE.MathUtils.lerp(
            this.carTerrainRoll,
            targetRoll,
            terrainSmooth,
          );
        }

        const finalPitch = THREE.MathUtils.clamp(
          this.carTerrainPitch + this.carBodyPitch,
          -CAR_BODY_PITCH_MAX * 1.2,
          CAR_BODY_PITCH_MAX * 1.2,
        );
        const finalRoll = THREE.MathUtils.clamp(
          this.carTerrainRoll + this.carBodyRoll,
          -CAR_BODY_ROLL_MAX,
          CAR_BODY_ROLL_MAX,
        );
        this.carChassis.rotation.set(finalPitch, 0, finalRoll);

        // Step 3: Wheels positioned via suspension length in chassis-local space (like Bruno's folio)
        let rearIdx = 0;
        for (let i = 0; i < this.carWheels.length; i++) {
          const w = this.carWheels[i];
          const lx = w.offset.x * scaleFactor;
          const lz = w.offset.z * scaleFactor;
          const wx =
            this.playerPos.x +
            lx * Math.cos(this.carHeading) +
            lz * Math.sin(this.carHeading);
          const wz =
            this.playerPos.z -
            lx * Math.sin(this.carHeading) +
            lz * Math.cos(this.carHeading);

          const grounded = i < 4 && this._carPhysics.wheelGrounded[i];
          let targetLocalY;
          if (this.carInAir || !grounded) {
            targetLocalY = -CAR_RIDE_HEIGHT;
          } else {
            const suspLen = this._carPhysics.wheelSuspLengths[i];
            targetLocalY = -suspLen / scaleFactor;
            targetLocalY = Math.min(
              targetLocalY,
              -CAR_RIDE_HEIGHT + CAR_SUSP_TRAVEL,
            );
            targetLocalY = Math.max(
              targetLocalY,
              -CAR_RIDE_HEIGHT - CAR_SUSP_TRAVEL,
            );
          }
          if (w._smoothLocalY === undefined) w._smoothLocalY = targetLocalY;
          w._smoothLocalY +=
            (targetLocalY - w._smoothLocalY) * Math.min(1, 25 * dtSec);
          w.container.position.set(w.offset.x, w._smoothLocalY, w.offset.z);

          const contactY = grounded
            ? this._carPhysics.wheelContactYs[i]
            : this.playerPos.y;
          w.contactWorld.set(wx, contactY + DRIFT_MARK_Y_OFFSET, wz);
          if (!w.steer) {
            if (rearIdx < this._carRearContactPoints.length) {
              this._carRearContactPoints[rearIdx].copy(w.contactWorld);
              this._carRearContactGrounded[rearIdx] = grounded;
              rearIdx++;
            }
          }
        }

        // Steering + wheel spin
        const _steerTarget =
          (keys.KeyA || keys.ArrowLeft ? 0.4 : 0) +
          (keys.KeyD || keys.ArrowRight ? -0.4 : 0);
        this.carSteerSmooth = THREE.MathUtils.lerp(
          this.carSteerSmooth,
          _steerTarget,
          1 - Math.exp(-12 * dtSec),
        );
        for (const w of this.carWheels) {
          const baseYaw = CAR_MODEL_YAW + (w.isLeft ? Math.PI : 0);
          w.container.rotation.y =
            baseYaw + (w.steer ? this.carSteerSmooth : 0);
          if (w.cylinder)
            w.cylinder.rotation.z = (w.isLeft ? -1 : 1) * this.carWheelSpin;
        }
      }
    }

    // Car visual — Lotus
    if (this.lotusRoot) {
      this.lotusRoot.visible = isLotus && this.lotusLoaded;
      if (isLotus && this.lotusLoaded) {
        anyCarRendered = true;
        const scaleFactor = this.lotusRoot.scale.x || CAR_MODEL_SCALE;

        // Lotus yaw: PI offset because the GLB front faces +Z (opposite to Bruno)
        this.lotusRoot.rotation.y = this.carHeading - CAR_MODEL_YAW + Math.PI;

        // Lotus body + wheels: driven by same CarPhysics suspension as Bruno
        const lc = this._carPhysics.lotusChassis;
        const hyWheel = this.carHeading - CAR_MODEL_YAW + Math.PI;
        const c = Math.cos(hyWheel);
        const s = Math.sin(hyWheel);
        const targetPitch = this._carTerrainPitchTarget || 0;
        const targetRoll = this._carTerrainRollTarget || 0;
        const terrainSmooth = 1 - Math.exp(-CAR_TERRAIN_BODY_SMOOTH * dtSec);
        if (this.carInAir) {
          this.carTerrainPitch = THREE.MathUtils.lerp(
            this.carTerrainPitch,
            this._carPhysics.airPitch,
            terrainSmooth,
          );
          this.carTerrainRoll = THREE.MathUtils.lerp(
            this.carTerrainRoll,
            0,
            terrainSmooth,
          );
        } else {
          this.carTerrainPitch = THREE.MathUtils.lerp(
            this.carTerrainPitch,
            targetPitch,
            terrainSmooth,
          );
          this.carTerrainRoll = THREE.MathUtils.lerp(
            this.carTerrainRoll,
            targetRoll,
            terrainSmooth,
          );
        }
        const finalPitch = THREE.MathUtils.clamp(
          this.carTerrainPitch + this.carBodyPitch,
          -CAR_BODY_PITCH_MAX * 1.2,
          CAR_BODY_PITCH_MAX * 1.2,
        );
        const finalRoll = THREE.MathUtils.clamp(
          this.carTerrainRoll + this.carBodyRoll,
          -CAR_BODY_ROLL_MAX,
          CAR_BODY_ROLL_MAX,
        );
        this.lotusChassis.rotation.set(-finalRoll, 0, finalPitch);

        const suspMax = lc.suspMaxTravel;
        const hubRef = this._lotusWheelHubLocalY || 0;
        let rearIdx = 0;
        for (let i = 0; i < this.lotusWheels.length; i++) {
          const w = this.lotusWheels[i];
          const lx = w.offset.x * scaleFactor;
          const lz = w.offset.z * scaleFactor;
          const wx = this.playerPos.x + lx * c + lz * s;
          const wz = this.playerPos.z - lx * s + lz * c;
          const grounded = i < 4 && this._carPhysics.wheelGrounded[i];
          let targetLocalY;
          if (this.carInAir || !grounded) {
            targetLocalY = hubRef;
          } else {
            const suspLen = this._carPhysics.wheelSuspLengths[i];
            const suspDelta = -suspLen / scaleFactor + lc.rideHeight;
            targetLocalY = hubRef + suspDelta;
            targetLocalY = Math.min(targetLocalY, hubRef + suspMax);
            targetLocalY = Math.max(targetLocalY, hubRef - suspMax);
          }
          if (w._smoothLocalY === undefined) w._smoothLocalY = hubRef;
          w._smoothLocalY +=
            (targetLocalY - w._smoothLocalY) * Math.min(1, 25 * dtSec);
          w.container.position.set(w.offset.x, w._smoothLocalY, w.offset.z);
          const h = this._carPhysics.wheelContactYs[i];
          w.contactWorld.set(wx, h + DRIFT_MARK_Y_OFFSET, wz);
          if (!w.steer) {
            if (rearIdx < this._carRearContactPoints.length) {
              this._carRearContactPoints[rearIdx].copy(w.contactWorld);
              this._carRearContactGrounded[rearIdx] = grounded;
              rearIdx++;
            }
          }
        }

        const _steerTarget =
          (keys.KeyA || keys.ArrowLeft ? 0.4 : 0) +
          (keys.KeyD || keys.ArrowRight ? -0.4 : 0);
        this.carSteerSmooth = THREE.MathUtils.lerp(
          this.carSteerSmooth,
          _steerTarget,
          1 - Math.exp(-12 * dtSec),
        );
        for (const w of this.lotusWheels) {
          const baseYaw = CAR_MODEL_YAW + (w.isLeft ? 0 : Math.PI);
          w.container.rotation.y =
            baseYaw + (w.steer ? this.carSteerSmooth : 0);
          if (w.cylinder) {
            w.cylinder.rotation.x = (w.isLeft ? 1 : -1) * this.carWheelSpin;
            w.cylinder.rotation.z = 0;
          }
        }

        const rootY = this.playerPos.y + (this._lotusGroundOffset || 0);
        this.lotusRoot.position.set(this.playerPos.x, rootY, this.playerPos.z);

        // Brake lights + turn signals (blinkers)
        const braking = keys.Space || keys.KeyS || keys.ArrowDown;
        const leftKey = keys.KeyA || keys.ArrowLeft;
        const rightKey = keys.KeyD || keys.ArrowRight;
        const carSpeed = Math.sqrt(
          this.carVx * this.carVx + this.carVz * this.carVz,
        );

        // Blinker: manual Q/E override, or auto when holding turn key >0.3s at speed
        let blinkerSide = 0;
        if (keys.KeyQ) blinkerSide = -1;
        else if (keys.KeyE) blinkerSide = 1;
        else {
          if (leftKey && carSpeed > 3) this._lotusBlinkerAutoHold += dtSec;
          else if (rightKey && carSpeed > 3)
            this._lotusBlinkerAutoHold += dtSec;
          else this._lotusBlinkerAutoHold = 0;

          if (this._lotusBlinkerAutoHold > 0.3) {
            blinkerSide = leftKey ? -1 : 1;
          }
        }

        if (blinkerSide !== 0) {
          this._lotusBlinkerTime += dtSec;
          this._lotusBlinkerSide = blinkerSide;
        } else {
          this._lotusBlinkerTime = 0;
          this._lotusBlinkerSide = 0;
        }

        const blinkOn =
          this._lotusBlinkerSide !== 0 &&
          Math.floor(this._lotusBlinkerTime * 3 * 2) % 2 === 0;
        const blinkLeft = blinkOn && this._lotusBlinkerSide === -1;
        const blinkRight = blinkOn && this._lotusBlinkerSide === 1;

        if (this._lotusLightMeshes) {
          const brakeBase = braking ? 8 : 2;
          const tailBase = braking ? 4 : 2;
          const blinkBoost = 10;

          for (const m of this._lotusLightMeshes.brakeLeft) {
            if (m.material)
              m.material.emissiveIntensity = blinkLeft ? blinkBoost : brakeBase;
          }
          for (const m of this._lotusLightMeshes.brakeRight) {
            if (m.material)
              m.material.emissiveIntensity = blinkRight
                ? blinkBoost
                : brakeBase;
          }
          for (const m of this._lotusLightMeshes.taillightLeft) {
            if (m.material)
              m.material.emissiveIntensity = blinkLeft ? blinkBoost : tailBase;
          }
          for (const m of this._lotusLightMeshes.taillightRight) {
            if (m.material)
              m.material.emissiveIntensity = blinkRight ? blinkBoost : tailBase;
          }
        }
        if (this._lotusTaillightGlow) {
          this._lotusTaillightGlow.intensity = braking ? 4.5 : 1.8;
        }
      }
    }

    // Car visual — VVV rigid body. Mesh visibility + per-frame position+
    // orientation are handled in _syncVvvVisuals (lotusrealsize2 chassis + wheels).
    this._syncVvvVisuals(dtSec);

    // Stunt car owns its meshes and positions them inside vehicle.update();
    // here we only toggle visibility with the active mode.
    if (this._stuntVehicle) {
      this._stuntVehicle.group.visible = this.moveMode === "stunt";
    }

    // Drift marks & smoke (shared by the kinematic cars + the stunt rigid car)
    if (anyCarRendered || this.moveMode === "stunt") {
      const speed = Math.sqrt(
        this.carVx * this.carVx + this.carVz * this.carVz,
      );
      const handbrake = keys.Space;
      const driftAmount = THREE.MathUtils.clamp(
        (this.carDriftAngle - CAR_DRIFT_ANGLE_MIN) / 0.5,
        0,
        1,
      );
      const handbrakeAmount = handbrake
        ? THREE.MathUtils.smoothstep(
            speed,
            CAR_DRIFT_ENTRY_SPEED,
            CAR_DRIFT_ENTRY_SPEED * 2.2,
          )
        : 0;
      const driftIntensity = Math.max(driftAmount, handbrakeAmount);
      const emitMarks =
        !this.carInAir &&
        speed > CAR_DRIFT_ENTRY_SPEED &&
        driftIntensity > DRIFT_MARK_INTENSITY_MIN;
      const emitSmoke =
        !this.carInAir &&
        speed > CAR_DRIFT_ENTRY_SPEED * 0.55 &&
        (driftIntensity >
          (this.smokeSettings.trigger ?? DRIFT_SMOKE_INTENSITY_MIN) ||
          (handbrake && speed > CAR_DRIFT_ENTRY_SPEED * 0.55));
      this.driftMarks.update(
        this._carRearContactPoints,
        emitMarks,
        driftIntensity,
        this._carRearContactGrounded,
      );
      this.driftSmoke.update(
        dtSec,
        this._carRearContactPoints,
        emitSmoke,
        Math.max(driftIntensity, handbrake ? 0.45 : 0),
        this.carVx,
        this.carVz,
        this.camera,
      );
    } else {
      this.driftMarks.update(this._carRearContactPoints, false, 0);
      this.driftSmoke.update(
        dtSec,
        this._carRearContactPoints,
        false,
        0,
        0,
        0,
        this.camera,
      );
    }

    // Flight HUD (avionics strip + mini attitude)
    if (this._flyHud) {
      if (flying) {
        this._flyHud.style.display = "";
        let barrelAdd = 0;
        if (this.flyBarrelActive) {
          const t = Math.min(1, this.flyBarrelPhase);
          barrelAdd = t * t * (3 - 2 * t) * Math.PI * 2 * this.flyBarrelDir;
        }
        const bankRad = iso
          ? barrelAdd + this.flyAileronAngle
          : this.flyRoll + barrelAdd + this.flyAileronAngle;
        const bankDeg = _bankDegFromRad(bankRad);
        const pitchDeg = Math.round((this.flyPitch * 180) / Math.PI);

        const spdTgt = Math.abs(this.planeSpeed);
        const dSpd = spdTgt - this._planeHudSpdSmooth;
        const spdRate =
          dSpd > 0 ? PLANE_HUD_SPEED_SMOOTH : PLANE_HUD_SPEED_SMOOTH * 0.55;
        this._planeHudSpdSmooth = _expSmoothStep(
          this._planeHudSpdSmooth,
          spdTgt,
          dtSec,
          spdRate,
        );
        const aglTgt = this.flyHeight - groundY;
        this._planeHudAltSmooth = _expSmoothStep(
          this._planeHudAltSmooth,
          aglTgt,
          dtSec,
          PLANE_HUD_ALT_SMOOTH,
        );
        this._planeHudNitroSmooth = _expSmoothStep(
          this._planeHudNitroSmooth,
          this.planeNitro,
          dtSec,
          PLANE_HUD_NITRO_SMOOTH,
        );

        this._flyHudSpd.textContent = Math.round(this._planeHudSpdSmooth);
        this._flyHudAlt.textContent = Math.round(this._planeHudAltSmooth);
        this._flyHudPitch.textContent = pitchDeg;
        this._flyHudBank.textContent = Math.round(bankDeg);

        if (this._flyHudHorizonLayer) {
          this._flyHudHorizonLayer.style.transform = `rotate(${-bankDeg}deg)`;
        }
        const level = Math.abs(bankDeg) < 3.5;
        if (this._flyHudLevelHint) {
          this._flyHudLevelHint.style.opacity = level ? "1" : "0";
        }
        const nitroPct = Math.round(this._planeHudNitroSmooth * 100);
        if (this._flyHudNitroPct) {
          this._flyHudNitroPct.textContent = `${nitroPct}%`;
          this._flyHudNitroPct.style.color =
            this._planeHudNitroSmooth > 0.2
              ? "rgba(255,220,190,0.95)"
              : "rgba(255,150,150,0.95)";
        }
        if (this._flyHudNitroBar) {
          this._flyHudNitroBar.style.width = `${nitroPct}%`;
          this._flyHudNitroBar.style.background =
            this._planeHudNitroSmooth > 0.2
              ? "linear-gradient(90deg,#b84820,#e8a060)"
              : "linear-gradient(90deg,#a03030,#c07070)";
        }
      } else {
        this._flyHud.style.display = "none";
      }
    }

    // Car HUD: optional legacy center panel + circular speedometer (always when driving)
    let kmhTrue = 0;
    if (carDriving) {
      kmhTrue =
        Math.sqrt(this.carVx * this.carVx + this.carVz * this.carVz) *
        3.6 *
        (this.carSettings.speedometerScale ?? 1);
      const dK = kmhTrue - this._hudKmhSmooth;
      const rate = dK > 0 ? CAR_HUD_SPEED_SMOOTH_UP : CAR_HUD_SPEED_SMOOTH_DOWN;
      this._hudKmhSmooth += dK * (1 - Math.exp(-rate * dtSec));
      this._hudNitroSmooth = _expSmoothStep(
        this._hudNitroSmooth,
        this.carNitro,
        dtSec,
        CAR_HUD_NITRO_SMOOTH,
      );
    } else {
      this._hudKmhSmooth = 0;
      this._hudNitroSmooth = this.carNitro;
    }
    const kmh = Math.round(this._hudKmhSmooth);
    const kmhDisp = this._hudKmhSmooth;
    if (SHOW_LEGACY_CAR_HUD_RECT && this._carHud) {
      if (carDriving) {
        this._carHud.style.display = "";
        this._carHudSpd.textContent = kmh;
        this._carHudAngle.textContent = Math.round(
          (this.carDriftAngle * 180) / Math.PI,
        );
        this._carHudAngle.style.color = this.carDrifting
          ? "#ff3300"
          : "#ff6633";
        if (this._carHudNitro) {
          const nitroPct = Math.round(this._hudNitroSmooth * 100);
          this._carHudNitro.textContent = `${nitroPct}%`;
          this._carHudNitro.style.color =
            this._hudNitroSmooth > 0.2 ? "#9ee8ff" : "#ff8c8c";
          if (this._carHudNitroBar) {
            this._carHudNitroBar.style.width = `${nitroPct}%`;
            this._carHudNitroBar.style.background =
              this._hudNitroSmooth > 0.2
                ? "linear-gradient(90deg,#36c2ff,#7de8ff)"
                : "linear-gradient(90deg,#ff7a7a,#ffb36b)";
          }
        }
      } else {
        this._carHud.style.display = "none";
      }
    } else if (this._carHud) {
      this._carHud.style.display = "none";
    }
    if (this._carSpeedometer) {
      // Stunt mode gets its own HUD later — hide the default speedometer for now.
      if (carDriving && this.moveMode !== "stunt") {
        this._carSpeedometer.style.display = "";
        const maxSpeed = 280;
        const startAngle = 135;
        const endAngle = 405;
        const speedRatio = Math.min(kmhDisp / maxSpeed, 1);
        const tickAngle = startAngle + speedRatio * (endAngle - startAngle);
        // Ticks use clockwise-from-right angles; needle mesh points up (=270°). SVG rotate(clockwise).
        const needleRotateDeg = tickAngle - 270;
        if (this._speedoNeedle) {
          this._speedoNeedle.setAttribute(
            "transform",
            `rotate(${needleRotateDeg} 100 100)`,
          );
        }
        if (this._speedoDigital) {
          this._speedoDigital.textContent = kmh;
          this._speedoDigital.style.color =
            kmhDisp > 220 ? "#ff6666" : "#ffffff";
        }
        const gearSpeeds = [0, 40, 80, 130, 180, 230, 280];
        let gear = 1;
        for (let g = 1; g < gearSpeeds.length; g++) {
          if (kmhDisp >= gearSpeeds[g - 1]) gear = g;
        }
        const gearMin = gearSpeeds[gear - 1] || 0;
        const gearMax = gearSpeeds[gear] || maxSpeed;
        const rpmRatio = Math.min(
          (kmhDisp - gearMin) / (gearMax - gearMin + 1),
          1,
        );
        if (this._speedoRpmBar) {
          const arcLength = 110;
          const fillLen = rpmRatio * arcLength;
          this._speedoRpmBar.setAttribute("stroke-dasharray", `${fillLen} 999`);
        }
        if (this._speedoGear) {
          this._speedoGear.textContent = kmhDisp < 5 ? "N" : gear;
          this._speedoGear.style.color = gear >= 5 ? "#ff8844" : "#00ddff";
        }
        if (this._speedoNitroFill) {
          const nitroPct = Math.round(this._hudNitroSmooth * 100);
          this._speedoNitroFill.style.width = `${nitroPct}%`;
          this._speedoNitroFill.style.background =
            this._hudNitroSmooth > 0.2
              ? "linear-gradient(90deg,#36c2ff,#7de8ff)"
              : "linear-gradient(90deg,#ff7a7a,#ffb36b)";
        }
      } else {
        this._carSpeedometer.style.display = "none";
      }
    }

    // Wingtip contrails
    this._updateTrails();

    // Plane gun
    if (this._gunCooldown > 0) this._gunCooldown -= dtSec;
    if (
      flying &&
      this._muzzleOffsets.length > 0 &&
      keys.KeyE &&
      this._gunCooldown <= 0
    ) {
      this._planeInner.updateMatrixWorld(true);
      _bFwd.set(0, 0, -1).applyQuaternion(this.planeRoot.quaternion);
      const muz = this._muzzleOffsets[this._muzzleIdx];
      this._muzzleIdx = (this._muzzleIdx + 1) % this._muzzleOffsets.length;
      _bMuz.copy(muz);
      this._planeInner.localToWorld(_bMuz);
      fireBullet(this._bullets.pool, _bMuz, _bFwd);
      this._gunCooldown = 1 / GUN_FIRE_RATE;
    }
    updateBullets(this._bullets.pool, this.camera, dtSec);

    // Camera
    const charLookY = this.playerPos.y + CHAR_HEIGHT * 0.75;
    const isLotusMode = this.moveMode === "lotus";
    // Stunt reuses the VVV chase camera (both sync playerPos/carHeading/carVx/Vz).
    const isVvvMode = this.moveMode === "vvv";
    const _lc = isVvvMode ? this.vvvCam : isLotusMode ? this.lotusCam : null;
    const _carLookYOff = _lc ? _lc.lookAtY : 1.2;
    const carLookY = carDriving
      ? (isVvvMode
          ? this.playerPos.y + _carLookYOff
          : (isLotusMode ? this.lotusRoot : this.carRoot)?.position.y +
            _carLookYOff) || this.playerPos.y + _carLookYOff
      : 0;
    const lookAtY = flying
      ? this.flyHeight + 0.45
      : carDriving
        ? carLookY
        : charMode
          ? charLookY
          : capsuleCY + 0.6;

    // Lotus / Bruno tuning GUIs
    if (this._lotusCamGui)
      this._lotusCamGui.domElement.style.display = isLotusMode ? "" : "none";
    if (this._vvvCamGui)
      this._vvvCamGui.domElement.style.display = isVvvMode ? "" : "none";
    if (this._jeepTuningGui) {
      const showJeep = this.active && this.moveMode === "car";
      this._jeepTuningGui.domElement.style.display = showJeep ? "" : "none";
    }
    this._updateJeepGuiTelemetry();

    if (this.detached) {
      // Smoothly track the pawn so orbit stays useful while sim continues.
      const tgt = this.controls.target;
      const lerp = 1 - Math.exp(-6 * dtSec);
      const orbitY = this._getDetachedOrbitTargetY();
      tgt.x += (this.playerPos.x - tgt.x) * lerp;
      tgt.y += (orbitY - tgt.y) * lerp;
      tgt.z += (this.playerPos.z - tgt.z) * lerp;
      this.controls.update();
      return;
    }

    // Stunt uses the dedicated modular-road follow camera (no v2 camera-collision
    // raising — matches the showcase feel). Early-return skips the chase blocks
    // and the collision pass below, equivalent to the collision-disabled path.
    if (this.moveMode === "stunt") {
      this._updateStuntCamera(dtSec);
      return;
    }

    if (carDriving && !iso) {
      let camFocusX = this.playerPos.x;
      let camFocusY = this.playerPos.y;
      let camFocusZ = this.playerPos.z;
      const vvvSpeed = isVvvMode
        ? Math.sqrt(this.carVx * this.carVx + this.carVz * this.carVz)
        : 0;
      if (isVvvMode) {
        camFocusY = this._getVvvCameraFocusY(
          camFocusX,
          camFocusZ,
          this.playerPos.y,
          vvvSpeed,
        );
      }

      let chaseTarget = this.carHeading;
      if (this.carDrifting) {
        const rx = Math.cos(this.carHeading);
        const rz = -Math.sin(this.carHeading);
        const latSign = Math.sign(this.carVx * rx + this.carVz * rz);
        const driftOff =
          latSign *
          this.carDriftAngle *
          (_lc
            ? _lc.driftLag
            : (this.carSettings.cameraDriftLag ?? CAR_CAM_DRIFT_LAG));
        chaseTarget += driftOff;
      }
      let camDelta = chaseTarget - this.carCamYaw;
      while (camDelta > Math.PI) camDelta -= 2 * Math.PI;
      while (camDelta < -Math.PI) camDelta += 2 * Math.PI;
      // Idle VVV body still rocks on springs — freeze yaw chase until moving.
      if (!isVvvMode || vvvSpeed > 0.4) {
        this.carCamYaw +=
          camDelta *
          (1 -
            Math.exp(
              -(_lc
                ? _lc.chaseSpeed
                : (this.carSettings.cameraChaseSpeed ?? CAR_CAM_CHASE_SPEED)) *
                dtSec,
            ));
      }

      const _camBaseDist = _lc
        ? _lc.distance
        : (this.carSettings.cameraDistance ?? CAR_CAM_DIST);
      const _camHeight = _lc
        ? _lc.height
        : (this.carSettings.cameraHeight ?? CAR_CAM_HEIGHT);
      // Speed-dependent pull-back (racing game feel)
      let _camDist = _camBaseDist;
      if (_lc) {
        const carSpeed = Math.sqrt(
          this.carVx * this.carVx + this.carVz * this.carVz,
        );
        const pullSpeed = isVvvMode ? vvvSpeed : carSpeed;
        const speedRatio =
          isVvvMode && pullSpeed < 1.2
            ? 0
            : THREE.MathUtils.clamp(
                pullSpeed / Math.max(1, CAR_MAX_SPEED),
                0,
                1,
              );
        const targetPullBack = speedRatio * _lc.speedPullBack;
        const pullSmooth = isVvvMode
          ? this._vvvCamDistSmooth
          : this._lotusCamDistSmooth;
        const nextPull = THREE.MathUtils.lerp(
          pullSmooth,
          targetPullBack,
          1 - Math.exp(-3 * dtSec),
        );
        if (isVvvMode) this._vvvCamDistSmooth = nextPull;
        else this._lotusCamDistSmooth = nextPull;
        _camDist = _camBaseDist + nextPull;
      }
      const vvvLookY = isVvvMode ? camFocusY + _carLookYOff : lookAtY;
      const camBehindX = camFocusX + Math.sin(this.carCamYaw) * _camDist;
      const camBehindZ = camFocusZ + Math.cos(this.carCamYaw) * _camDist;
      const camY = (isVvvMode ? vvvLookY : lookAtY) + _camHeight;
      if (isVvvMode) {
        // Lerp the actual camera position toward the chase target — matches
        // standalone CAM_LERP=6/s. Avoids the camera snapping during the
        // suspension/airborne transition. Lookat target is already filtered.
        if (this._vvvCamPosSmooth == null) {
          this._vvvCamPosSmooth = new THREE.Vector3(
            camBehindX,
            camY,
            camBehindZ,
          );
          this.camera.position.copy(this._vvvCamPosSmooth);
        } else {
          const kCam = 1 - Math.exp(-6 * dtSec);
          this._vvvCamPosSmooth.x +=
            (camBehindX - this._vvvCamPosSmooth.x) * kCam;
          this._vvvCamPosSmooth.y += (camY - this._vvvCamPosSmooth.y) * kCam;
          this._vvvCamPosSmooth.z +=
            (camBehindZ - this._vvvCamPosSmooth.z) * kCam;
          this.camera.position.copy(this._vvvCamPosSmooth);
        }
      } else {
        this.camera.position.set(camBehindX, camY, camBehindZ);
      }
      this.camera.lookAt(camFocusX, isVvvMode ? vvvLookY : lookAtY, camFocusZ);
    } else if (iso) {
      if (flying) {
        let yawDelta = this.flyHeading - this.isoYaw;
        while (yawDelta > Math.PI) yawDelta -= 2 * Math.PI;
        while (yawDelta < -Math.PI) yawDelta += 2 * Math.PI;
        this.isoYaw +=
          yawDelta *
          (1 - Math.exp(-ISO_FLY_CHASE_SMOOTH * Math.min(dtSec, 0.1)));
      }
      const isoPitch = this.cameraTuning.iso?.pitch ?? ISO_PITCH;
      const hDist = this.isoDist * Math.cos(isoPitch);
      const vDist = this.isoDist * Math.sin(isoPitch);
      this.camera.position.set(
        this.playerPos.x + Math.sin(this.isoYaw) * hDist,
        lookAtY + vDist,
        this.playerPos.z + Math.cos(this.isoYaw) * hDist,
      );
      this.camera.lookAt(this.playerPos.x, lookAtY, this.playerPos.z);
    } else {
      const camOrbitYaw = flying
        ? this.flyHeading + this.flyGroundCamYawOff
        : this.camYaw;
      const followDist = this.cameraTuning[this.moveMode]?.distance ?? CAM_DIST;
      const hDist = followDist * Math.cos(this.camPitch);
      const vDist = followDist * Math.sin(this.camPitch);
      const sinH = Math.sin(camOrbitYaw);
      const cosH = Math.cos(camOrbitYaw);
      const a = flying ? this.flyAileronAngle : 0;
      const sinA = Math.sin(a);
      const cosA = Math.cos(a);
      this.camera.position.set(
        this.playerPos.x + sinH * hDist - cosH * sinA * vDist,
        lookAtY + cosA * vDist,
        this.playerPos.z + cosH * hDist + sinH * sinA * vDist,
      );
      this.camera.up.set(-cosH * sinA, cosA, sinH * sinA);
      this.camera.lookAt(this.playerPos.x, lookAtY, this.playerPos.z);
    }

    // Camera collision — raise camera above terrain/BVH surfaces, keep full distance.
    // All knobs come from toolState.playCamera so the editor UI can tweak / disable live.
    const camCfg = this.cameraCollisionSettings;
    const camColEnabled = !!(camCfg && camCfg.enabled === true);
    if (!camColEnabled) {
      // Relax pulled-in distance back out so re-enabling doesn't snap.
      this._camCollisionDist = 1;
      return;
    }
    const camColOffset = camCfg?.offset ?? CAM_COLLISION_OFFSET;
    const camColEaseOut = camCfg?.easeOut ?? CAM_COLLISION_EASE_OUT;
    const floorClampEnabled = camCfg
      ? camCfg.floorClampEnabled !== false
      : true;
    const wallPullEnabled = camCfg ? camCfg.wallPullEnabled !== false : true;

    const camTarget = _camColTarget;
    camTarget.set(this.playerPos.x, lookAtY, this.playerPos.z);
    const camPos = this.camera.position;

    // Floor clamp: keep camera above terrain (not BVH — ramps/slopes are player surfaces, not camera barriers)
    if (floorClampEnabled) {
      const floorAtCam = this.getWorldHeight(camPos.x, camPos.z);
      const minCamY = floorAtCam + camColOffset + 1.0;
      if (camPos.y < minCamY) {
        const targetCamY = minCamY;
        const liftSmooth = 1 - Math.exp(-8 * dtSec);
        camPos.y = camPos.y + (targetCamY - camPos.y) * liftSmooth;
        this.camera.lookAt(camTarget.x, camTarget.y, camTarget.z);
      }
    }

    // Wall pull-in: only for vertical surfaces (walls, not floors/ramps)
    if (wallPullEnabled) {
      _camColDir.subVectors(camPos, camTarget);
      const fullDist = _camColDir.length();
      if (fullDist > 0.01) {
        _camColDir.divideScalar(fullDist);
        let allowedDist = fullDist;

        if (this.cliffBvh?.baked) {
          const hit = this.cliffBvh.raycast3D(
            camTarget.x,
            camTarget.y,
            camTarget.z,
            _camColDir.x,
            _camColDir.y,
            _camColDir.z,
            fullDist,
          );
          if (hit && Math.abs(hit.normal.y) < 0.3) {
            const hitDist = hit.distance - camColOffset;
            if (hitDist < allowedDist) allowedDist = hitDist;
          }
        }

        const ratio = Math.max(0.1, allowedDist / fullDist);
        if (ratio < this._camCollisionDist) {
          this._camCollisionDist = ratio;
        } else {
          this._camCollisionDist +=
            (ratio - this._camCollisionDist) *
            (1 - Math.exp(-camColEaseOut * dtSec));
        }

        if (this._camCollisionDist < 0.999) {
          camPos.lerpVectors(camTarget, camPos, this._camCollisionDist);
          this.camera.lookAt(camTarget.x, camTarget.y, camTarget.z);
        }
      }
    } else {
      this._camCollisionDist = 1;
    }
  }

  _currentYaw() {
    switch (this.moveMode) {
      case "char":
        return this.charYaw;
      case "fly":
        return this.flyHeading;
      case "car":
      case "lotus":
      case "stunt":
        return this.carHeading;
      case "rts":
        return this.rtsYaw;
      case "capsule":
      default:
        return this.capsule ? this.capsule.rotation.y : 0;
    }
  }

  _toggleMoveMode() {
    const i = MODE_ORDER.indexOf(this.moveMode);
    const next = MODE_ORDER[(i + 1) % MODE_ORDER.length] || MODE_ORDER[0];
    this._setMoveMode(next);
  }

  _setMoveMode(target) {
    if (!MODE_META[target] || target === this.moveMode) return;
    const yaw = this._currentYaw();
    const wasRts = this.moveMode === "rts";
    this._moveTarget = null;
    this.isoHoverRing.visible = false;
    this.isoTargetRing.visible = false;
    if (target === "char") {
      this.moveMode = "char";
      this.charYaw = yaw;
      this.charVelY = 0;
      this.charInAir = false;
      this.charGliding = false;
      this.charGliderPoseActive = false;
      this.charSpacePrev = false;
      this.charCrouching = false;
      this.charAttacking = false;
      this.charRolling = false;
      this.charSlidePhase = "none";
      this.charJumpPhase = "none";
      this.charSpellPhase = "none";
      this.charSpellExitRequested = false;
      if (this.charKite) this.charKite.visible = false;
    } else if (target === "fly") {
      this.moveMode = "fly";
      this.flyHeading = yaw;
      this.flyHeight = this.playerPos.y;
      this.flyPitch = 0;
      this.flyRoll = 0;
      this.flyRollTarget = 0;
      this.flyBarrelActive = false;
      this.flyBarrelPhase = 0;
      this.flyGroundCamYawOff = 0;
      this.flyAileronAngle = 0;
      this.planeSpeed = 0;
    } else if (target === "car") {
      this.moveMode = "car";
      this.carHeading = yaw;
      this.carCamYaw = yaw;
      this.carVx = 0;
      this.carVz = 0;
      this.carDrifting = false;
      this.carDriftAngle = 0;
      this.playerPos.y = this.getWorldHeight(
        this.playerPos.x,
        this.playerPos.z,
      );
      this.flyHeight = 0;
      this.flyAileronAngle = 0;
      this.carVelY = 0;
      this.carInAir = false;
      this.carOnSteepSlope = false;
      this._carPhysics._initialized = false;
      this.driftMarks.reset();
      this.driftSmoke.reset();
      this._clearTrails();
      clearBullets(this._bullets.pool);
    } else if (target === "lotus") {
      this.moveMode = "lotus";
      this.carHeading = yaw;
      this.carCamYaw = yaw;
      this.carVx = 0;
      this.carVz = 0;
      this.carDrifting = false;
      this.carDriftAngle = 0;
      this.carVelY = 0;
      this.carInAir = false;
      this.carOnSteepSlope = false;
      this.playerPos.y = this.getWorldHeight(
        this.playerPos.x,
        this.playerPos.z,
      );
      this._carPhysics._initialized = false;
      this._driftBoostMeter = 0;
      this._driftBoostActive = false;
      this._lotusPhysics._handbrakeBlend = 0;
      this._lotusPhysics._driftTime = 0;
      this._lotusPhysics.driftBoostMeter = 0;
      this._lotusPhysics._driftBoostActive = false;
      this.driftMarks.reset();
      this.driftSmoke.reset();
    } else if (target === "vvv") {
      this.moveMode = "vvv";
      this.carHeading = yaw;
      this.carCamYaw = yaw;
      this.carVx = 0;
      this.carVz = 0;
      const groundY = this.getWorldHeight(this.playerPos.x, this.playerPos.z);
      const hubY = this._vvvLayout[0]?.pos.y ?? -0.1;
      const rest = this._vvvTire.restLength ?? 0.55;
      const k = this._vvvTire.springStrength || 65000;
      // Per-wheel weight ÷ k = static spring deflection. Spawning 5 cm above
      // equilibrium lets the spring settle instead of being pre-loaded.
      const staticDef = (this._vvvChassis.mass * VVV_GRAVITY * 0.25) / k;
      const spawnY = groundY + rest - staticDef + Math.abs(hubY) + 0.05;
      this._vvvSpawnAt(this.playerPos.x, spawnY, this.playerPos.z, yaw);
      this.playerPos.x = this._vvvBody.pos.x;
      this.playerPos.y = this._vvvBody.pos.y;
      this.playerPos.z = this._vvvBody.pos.z;
      this._lotusCamDistSmooth = 0;
      this.driftMarks.reset();
      this.driftSmoke.reset();
    } else if (target === "stunt") {
      this.moveMode = "stunt";
      this.carHeading = yaw;
      this.carCamYaw = yaw;
      this.carVx = 0;
      this.carVz = 0;
      this.carDrifting = false;
      this.carDriftAngle = 0;
      const sv = this._stuntVehicle;
      const gy = this.getWorldHeight(this.playerPos.x, this.playerPos.z);
      const spawnY = gy + 1.0; // a little above terrain so the suspension settles
      const sq = new THREE.Quaternion().setFromAxisAngle(
        _vvvAxisY_world,
        yaw + Math.PI,
      );
      sv.setSpawn(
        new THREE.Vector3(this.playerPos.x, spawnY, this.playerPos.z),
        sq,
      );
      sv.respawn();
      sv.enabled = true;
      sv.group.visible = true;
      this.playerPos.y = spawnY;
      // Bake the authored spline road into the wheel-probe BVH so it's drivable.
      this._bakeStuntRoad();
      // Re-center the dedicated stunt follow camera on (re)entry.
      this._stuntCamInit = false;
      this._stuntCamFocusYSmooth = null;
      this.driftMarks.reset();
      this.driftSmoke.reset();
    } else if (target === "rts") {
      this.moveMode = "rts";
      // Seed focus point on the pawn so the camera arrives where it makes sense.
      this.rtsFocusX = this.playerPos.x;
      this.rtsFocusZ = this.playerPos.z;
      this.rtsYaw = yaw;
      this.carVx = 0;
      this.carVz = 0;
      this.rtsRmbDrag = false;
      // Hide all pawn visuals (per-frame visibility logic is skipped by the RTS early-return)
      if (this.capsule) this.capsule.visible = false;
      if (this.charRoot) this.charRoot.visible = false;
      if (this.carRoot) this.carRoot.visible = false;
      if (this.lotusRoot) this.lotusRoot.visible = false;
      if (this.planeRoot) this.planeRoot.visible = false;
      // Release pointer lock so cursor is visible for edge-pan / RMB drag
      if (document.pointerLockElement) document.exitPointerLock();
      this.renderer.domElement.style.cursor = "";
      this._rmbLookActive = false;
    } else {
      this.moveMode = "capsule";
      if (this.capsule) this.capsule.rotation.y = yaw;
      this.carVx = 0;
      this.carVz = 0;
      this.playerPos.y = this.getWorldHeight(
        this.playerPos.x,
        this.playerPos.z,
      );
      this.flyHeight = 0;
      this.flyPitch = 0;
      this.flyRoll = 0;
      this.flyRollTarget = 0;
      this.flyBarrelActive = false;
      this.flyBarrelPhase = 0;
      this.flyAileronAngle = 0;
      this.planeSpeed = 0;
      this.driftMarks.reset();
      this.driftSmoke.reset();
    }
    this._updateModePill();
    this._applyCameraFov();
    if (this._cameraTuningGuiModeShown !== this.moveMode) {
      this._rebuildCameraTuningGui();
    }
    this._refreshCameraTuningGuiVisible();
    // Leaving RTS back to a pawn mode → re-acquire pointer lock (immersive only)
    if (
      wasRts &&
      target !== "rts" &&
      this.camView !== "iso" &&
      !this._editorRelaxedPointer
    ) {
      this.renderer.domElement.style.cursor = "none";
      try {
        this.renderer.domElement.requestPointerLock();
      } catch (_) {
        /* ignore */
      }
    }
  }

  _onKeyDown(event) {
    if (!this.active) return;
    this.keysHeld[event.code] = true;

    if (!event.repeat && event.code === "KeyG") {
      event.preventDefault();
      if (this.detached) return; // ignore mode-switch while detached
      this._armWheelHold();
      return;
    }

    if (!event.repeat && event.code === "KeyF") {
      event.preventDefault();
      this._toggleDetached();
      return;
    }

    if (!event.repeat && event.code === "Escape") {
      if (this._wheelOpen) {
        event.preventDefault();
        this._closeModeWheel(false);
        return;
      }
      if (this.detached) {
        event.preventDefault();
        this._exitDetached();
        return;
      }
    }

    if (!event.repeat && event.code === "KeyP") {
      event.preventDefault();
      this._togglePause();
      return;
    }
    if (!event.repeat && event.code === "Backslash") {
      event.preventDefault();
      this._cycleSlowMo();
      return;
    }
    if (!event.repeat && event.code === "KeyN" && this.paused) {
      event.preventDefault();
      this._stepOneFrame();
      return;
    }

    if (!event.repeat && event.code === "Home") {
      event.preventDefault();
      if (event.shiftKey) {
        this._bookmarkSpawn();
      } else {
        this._respawnToSpawn();
        this._showToast("📍 Respawned", "amber");
      }
      return;
    }

    if (!event.repeat && event.code && !this.detached) {
      let digit = null;
      if (event.code.startsWith("Digit")) digit = event.code.slice(5);
      else if (
        event.code.startsWith("Numpad") &&
        /^Numpad[0-9]$/.test(event.code)
      )
        digit = event.code.slice(6);
      if (digit) {
        const target = MODE_ORDER.find(
          (name) => MODE_META[name].digit === digit,
        );
        if (target) {
          event.preventDefault();
          this._setMoveMode(target);
          return;
        }
      }
    }

    if (
      !event.repeat &&
      event.code === "KeyQ" &&
      this.flying &&
      !this.flyBarrelActive
    ) {
      event.preventDefault();
      this.flyBarrelActive = true;
      this.flyBarrelPhase = 0;
      this.flyBarrelDir = this.flyRoll >= 0 ? 1 : -1;
      return;
    }

    // Character actions (matches v1 keybindings: R=attack, C=roll, X=slide)
    const _charMode = this.moveMode === "char" && this.charLoaded;
    if (_charMode && !event.repeat) {
      const inSlide = this.charSlidePhase !== "none";
      const _inSpell = this.charSpellPhase !== "none";
      const busy = this.charRolling || this.charAttacking || inSlide;
      // Attack (R)
      if (
        event.code === "KeyR" &&
        this.charActions?.attack &&
        !busy &&
        !_inSpell &&
        !this.charInAir
      ) {
        event.preventDefault();
        this.charAttacking = true;
        const a = this.charActions.attack;
        a.reset().enabled = true;
        a.crossFadeFrom(this.charCurrentAction, 0.12, false).play();
        this.charCurrentAction = a;
        return;
      }
      // Roll (C) — works mid-air too (matches v1)
      if (
        event.code === "KeyC" &&
        this.charActions?.roll &&
        !busy &&
        !_inSpell
      ) {
        event.preventDefault();
        this.charRolling = true;
        this.charRollYaw = this.charYaw;
        this.charRollStart = performance.now();
        const r = this.charActions.roll;
        r.reset().enabled = true;
        r.crossFadeFrom(this.charCurrentAction, 0.1, false).play();
        this.charCurrentAction = r;
        return;
      }
      // Slide (X) — requires movement keys held, ground only
      if (
        event.code === "KeyX" &&
        this.charActions?.slideStart &&
        !busy &&
        !_inSpell &&
        !this.charInAir
      ) {
        const movingKeys =
          this.keysHeld.KeyW ||
          this.keysHeld.KeyA ||
          this.keysHeld.KeyS ||
          this.keysHeld.KeyD ||
          this.keysHeld.ArrowUp ||
          this.keysHeld.ArrowDown ||
          this.keysHeld.ArrowLeft ||
          this.keysHeld.ArrowRight;
        if (movingKeys) {
          event.preventDefault();
          this.charSlidePhase = "start";
          this.charSlideYaw = this.charYaw;
          this.charSlideStart = performance.now();
          const ss = this.charActions.slideStart;
          ss.reset().enabled = true;
          ss.crossFadeFrom(this.charCurrentAction, 0.1, false).play();
          this.charCurrentAction = ss;
          return;
        }
      }
      // Spell toggle (Q)
      if (event.code === "KeyQ") {
        event.preventDefault();
        if (
          this.charSpellPhase === "none" &&
          !busy &&
          this.charActions?.spellEnter
        ) {
          this.charSpellPhase = "enter";
          this.charSpellExitRequested = false;
          const se = this.charActions.spellEnter;
          se.reset().enabled = true;
          se.crossFadeFrom(this.charCurrentAction, 0.15, false).play();
          this.charCurrentAction = se;
        } else if (
          (this.charSpellPhase === "idle" ||
            this.charSpellPhase === "enter" ||
            this.charSpellPhase === "shoot") &&
          this.charActions?.spellExit
        ) {
          this.charSpellExitRequested = true;
          if (this.charSpellPhase === "idle") {
            this.charSpellPhase = "exit";
            const sx = this.charActions.spellExit;
            sx.reset().enabled = true;
            sx.crossFadeFrom(this.charCurrentAction, 0.12, false).play();
            this.charCurrentAction = sx;
          }
        }
        return;
      }
      // Spell shoot (J)
      if (
        event.code === "KeyJ" &&
        this.charSpellPhase === "idle" &&
        !this.charSpellExitRequested &&
        this.charActions?.spellShoot
      ) {
        event.preventDefault();
        this.charSpellPhase = "shoot";
        const ss = this.charActions.spellShoot;
        ss.reset().enabled = true;
        ss.crossFadeFrom(this.charCurrentAction, 0.12, false).play();
        this.charCurrentAction = ss;
        return;
      }
    }

    if (!event.repeat && event.code === "KeyV") {
      event.preventDefault();
      this.camView = this.camView === "follow" ? "iso" : "follow";
      if (this.camView === "iso") {
        if (document.pointerLockElement) document.exitPointerLock();
        this.renderer.domElement.style.cursor = "";
        this.isoYaw = this.carMode
          ? this.carHeading
          : this.flying
            ? this.flyHeading
            : this.camYaw;
      } else {
        this._moveTarget = null;
        this.isoHoverRing.visible = false;
        this.isoTargetRing.visible = false;
        if (this._editorRelaxedPointer) {
          this.renderer.domElement.style.cursor = "";
        } else {
          this.renderer.domElement.style.cursor = "none";
          this.renderer.domElement.requestPointerLock();
        }
      }
      this._updateModePill();
    }

    if (event.code.startsWith("Arrow")) event.preventDefault();
    if (event.code === "Space") event.preventDefault();
  }

  _onKeyUp(event) {
    if (!this.active) return;
    delete this.keysHeld[event.code];
    if (event.code === "KeyG") {
      if (this._wheelOpen) {
        this._closeModeWheel(true);
      } else if (this._wheelArmed) {
        if (this._wheelHoldTimer) {
          clearTimeout(this._wheelHoldTimer);
          this._wheelHoldTimer = null;
        }
        this._wheelArmed = false;
        this._toggleMoveMode();
      }
    }
  }

  _onMouseMove(event) {
    if (!this.active) return;
    if (this._wheelOpen) {
      this._feedWheelMouse(event.movementX || 0, event.movementY || 0);
      return;
    }
    if (this.detached) return; // OrbitControls handles mouse during detach
    if (this.moveMode === "rts") {
      // Track absolute screen pos for edge-pan
      this._rtsMouseX = event.clientX || 0;
      this._rtsMouseY = event.clientY || 0;
      if (this.rtsRmbDrag) {
        const t = this.cameraTuning.rts;
        this.rtsYaw -= (event.movementX || 0) * (t?.rotateSens ?? 0.003);
      }
      return;
    }
    const locked = !!document.pointerLockElement;
    const relaxedLook =
      this._editorRelaxedPointer && this._rmbLookActive && !locked;
    if (!locked && !relaxedLook) return;

    if (this.flying) {
      const mx = event.movementX;
      const my = event.movementY;
      const flyT = this.cameraTuning.fly;
      const fSensX = flyT?.sensX ?? FLY_MOUSE_SENS_X;
      const fSensY = flyT?.sensY ?? FLY_MOUSE_SENS_Y;
      const agl =
        this.flyHeight -
        this.getWorldHeight(this.playerPos.x, this.playerPos.z);
      const spd = Math.abs(this.planeSpeed);
      const onDeck = agl < FLY_SURFACE_ALT && spd < FLY_SURFACE_SPEED;
      if (onDeck) {
        this.flyGroundCamYawOff -= mx * fSensX;
      } else {
        this.flyGroundCamYawOff = 0;
        this.flyHeading -= mx * fSensX;
        this.flyPitch = THREE.MathUtils.clamp(
          this.flyPitch + my * fSensY,
          FLY_PITCH_MIN,
          FLY_PITCH_MAX,
        );
        this.flyRollTarget = THREE.MathUtils.clamp(
          this.flyRollTarget - mx * FLY_ROLL_VEL_SCALE,
          -FLY_ROLL_MAX,
          FLY_ROLL_MAX,
        );
      }
      return;
    }

    if (this.carMode) return;

    const t = this.cameraTuning[this.moveMode];
    const sx = t?.sensX ?? CAM_SENS_X;
    const sy = t?.sensY ?? CAM_SENS_Y;
    this.camYaw -= event.movementX * sx;
    this.camPitch += event.movementY * sy;
    this.camPitch = Math.max(0.05, Math.min(Math.PI * 0.45, this.camPitch));
  }

  _onPointerLockChange() {
    if (this._editorRelaxedPointer) return;
    if (this.detached) return;
    if (this.moveMode === "rts") return;
    if (!document.pointerLockElement && this.active && this.camView !== "iso") {
      this._exitCallback?.();
    }
  }

  _onIsoClick(event) {
    if (!this.active || this.camView !== "iso" || event.button !== 0) return;
    if (this.flying || this.carMode || this.detached) return;
    event.preventDefault();
    const hit = this._pickIsoTerrain(event);
    if (!hit) return;
    if (!this._moveTarget) this._moveTarget = new THREE.Vector3();
    this._moveTarget.copy(hit);
    this.isoTargetRing.visible = true;
    this.isoTargetRing.position.set(
      hit.x,
      hit.y + ISO_MOVE_RING_Y_OFFSET,
      hit.z,
    );
  }

  _onIsoPointerMove(event) {
    if (
      !this.active ||
      this.camView !== "iso" ||
      this.flying ||
      this.carMode ||
      this.detached
    ) {
      this.isoHoverRing.visible = false;
      return;
    }
    if (event.timeStamp - this._lastIsoHoverPickMs < ISO_HOVER_PICK_MIN_MS)
      return;
    this._lastIsoHoverPickMs = event.timeStamp;
    const hit = this._pickIsoTerrainApprox(event);
    if (!hit) {
      this.isoHoverRing.visible = false;
      return;
    }
    this.isoHoverRing.visible = true;
    this.isoHoverRing.position.set(
      hit.x,
      hit.y + ISO_MOVE_RING_Y_OFFSET,
      hit.z,
    );
  }

  _pickIsoTerrainApprox(event) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this._pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this._pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this._raycaster.setFromCamera(this._pointer, this.camera);
    const origin = this._raycaster.ray.origin;
    const dir = this._raycaster.ray.direction;
    if (dir.y > -1e-4) return null;

    const t = (this.playerPos.y - origin.y) / dir.y;
    if (t < 0) return null;
    const x = origin.x + dir.x * t;
    const z = origin.z + dir.z * t;
    return this._isoPickHit.set(x, this.getTerrainHeight(x, z), z);
  }

  _pickIsoTerrain(event) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this._pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this._pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this._raycaster.setFromCamera(this._pointer, this.camera);
    const origin = this._raycaster.ray.origin;
    const dir = this._raycaster.ray.direction;
    if (dir.y > -1e-4) return null;

    let t = 0.4;
    let step = 0.4;
    let prevT = 0;
    let prevAbove = origin.y - this.getTerrainHeight(origin.x, origin.z) > 0;
    for (let i = 0; i < 240; i++) {
      const px = origin.x + dir.x * t;
      const py = origin.y + dir.y * t;
      const pz = origin.z + dir.z * t;
      const groundY = this.getTerrainHeight(px, pz);
      const above = py - groundY > 0;
      if (!above && prevAbove) {
        let lo = prevT;
        let hi = t;
        for (let j = 0; j < 12; j++) {
          const mid = (lo + hi) * 0.5;
          const mx = origin.x + dir.x * mid;
          const my = origin.y + dir.y * mid;
          const mz = origin.z + dir.z * mid;
          if (my - this.getTerrainHeight(mx, mz) > 0) lo = mid;
          else hi = mid;
        }
        const ft = (lo + hi) * 0.5;
        return this._isoPickHit.set(
          origin.x + dir.x * ft,
          origin.y + dir.y * ft,
          origin.z + dir.z * ft,
        );
      }
      prevAbove = above;
      prevT = t;
      t += step;
      if (t > 1200) break;
      if (step < 18) step *= 1.025;
    }
    return null;
  }

  _onIsoWheel(event) {
    if (!this.active || this.detached) return;
    // RTS zoom
    if (this.moveMode === "rts") {
      event.preventDefault();
      const t = this.cameraTuning.rts;
      const dir = event.deltaY < 0 ? -1 : 1;
      // Logarithmic zoom feel: smaller step when closer
      const step = Math.max(2, t.distance * 0.12) * dir;
      t.distance = THREE.MathUtils.clamp(t.distance + step, 6, 400);
      this._saveCameraTuning();
      return;
    }
    if (this.camView !== "iso") return;
    event.preventDefault();
    const dir = event.deltaY < 0 ? -1 : 1;
    this.isoDist = THREE.MathUtils.clamp(
      this.isoDist + dir * 2,
      ISO_DIST_MIN,
      ISO_DIST_MAX,
    );
  }

  set onExit(fn) {
    this._exitCallback = fn;
  }

  /**
   * Rebuild car Howls (loop sprite regions, clip paths). Call after editing loop ms in Tweakpane.
   */
  rebuildCarAudio() {
    if (this._disposeCarAudio) {
      this._disposeCarAudio();
      this._disposeCarAudio = null;
    }
    if (this._audioSystem) {
      this._disposeCarAudio = setupPlayModeCarAudio(this, this._audioSystem);
    }
  }

  dispose() {
    this.exit();
    if (this._disposeCarAudio) {
      this._disposeCarAudio();
      this._disposeCarAudio = null;
    }
    this.scene.remove(this.capsule);
    this.capsule.geometry.dispose();
    this.capsule.material.dispose();
    this.scene.remove(this.isoHoverRing);
    this.scene.remove(this.isoTargetRing);
    this.isoHoverRing.geometry.dispose();
    this.isoHoverRing.material.dispose();
    this.isoTargetRing.material.dispose();
    for (const trail of this._wingTrails) {
      this.scene.remove(trail.mesh);
      trail.mesh.geometry.dispose();
    }
    this._trailMat.dispose();
    this.scene.remove(this._bullets.group);
    this._bullets.geo.dispose();
    this._bullets.mat.dispose();
    if (this.planeRoot) {
      this.scene.remove(this.planeRoot);
      this.planeRoot.traverse((o) => {
        if (o.isMesh) {
          o.geometry?.dispose();
          o.material?.dispose();
        }
      });
    }
    if (this.charRoot) {
      this.scene.remove(this.charRoot);
      this.charRoot.traverse((o) => {
        if (o.isMesh || o.isSkinnedMesh) {
          o.geometry?.dispose();
          o.material?.dispose();
        }
      });
    }
    if (this.carRoot) {
      this.scene.remove(this.carRoot);
      this.carRoot.traverse((o) => {
        if (o.isMesh) {
          o.geometry?.dispose();
          o.material?.dispose();
        }
      });
    }
    if (this.lotusRoot) {
      this.scene.remove(this.lotusRoot);
      this.lotusRoot.traverse((o) => {
        if (o.isMesh) {
          o.geometry?.dispose();
          o.material?.dispose();
        }
      });
    }
    if (this._carHud) this._carHud.remove();
    if (this._carSpeedometer) this._carSpeedometer.remove();
    if (this._flyHud) {
      this._flyHud.remove();
      this._flyHud = null;
    }
    if (this._modePill) {
      this._modePill.remove();
      this._modePill = null;
    }
    if (this._wheelHoldTimer) {
      clearTimeout(this._wheelHoldTimer);
      this._wheelHoldTimer = null;
    }
    if (this._wheelEl) {
      this._wheelEl.remove();
      this._wheelEl = null;
      this._wheelCursorEl = null;
      this._wheelHubLabelEl = null;
      this._wheelSlotEls = {};
    }
    if (this._detachBadge) {
      this._detachBadge.remove();
      this._detachBadge = null;
    }
    if (this._cameraTuningGui) {
      this._cameraTuningGui.destroy();
      this._cameraTuningGui = null;
      this._cameraTuningGuiFolder = null;
    }
    if (this._pauseBadge) {
      this._pauseBadge.remove();
      this._pauseBadge = null;
    }
    if (this._toastTimer) {
      clearTimeout(this._toastTimer);
      this._toastTimer = null;
    }
    if (this._toastEl) {
      this._toastEl.remove();
      this._toastEl = null;
    }
    if (this._lotusCamGui) {
      this._lotusCamGui.destroy();
      this._lotusCamGui = null;
    }
    if (this._vvvCamGui) {
      this._vvvCamGui.destroy();
      this._vvvCamGui = null;
    }
    if (this._jeepTuningGui) {
      this._jeepTuningGui.destroy();
      this._jeepTuningGui = null;
    }
  }
}
