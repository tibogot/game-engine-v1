/**
 * Grass push field — Ghost of Tsushima's displacement buffer.
 *
 * Anything can bend grass: the player, a car's wheels, an NPC, a game's own
 * objects. Each stamps a disk into a small texture around the grass anchor;
 * the grass compute reads it and bends blades outward from where they were
 * pushed. The pushes fade back over `recovery` seconds, so a path through a
 * meadow stays parted for a moment and then springs back.
 *
 * Built like the snow trail (terrain/snowSystem.js): ping-pong render targets
 * that scroll with the anchor in whole texels, stamps as a uniform array read
 * by one fullscreen pass with an early break at the stamp count.
 *
 * COST DISCIPLINE. 256² covering 64 m (0.25 m a texel — a character is a few
 * texels, which is all a bend needs). The pass runs only on frames that stamp,
 * or while an earlier push is still recovering; after that the field is left
 * alone and costs nothing. A pawn standing still also settles to no passes
 * once its unchanged stamps have outlasted the recovery window. MEASURED
 * 2026-09-17: one pass with 8 stamps ≈ 0.09 ms. The grass reads it with ONE
 * tap, only on the near rings, only for blades that survived the cull.
 *
 * Texel = (rg: push direction × amount in XZ, b: unused, a: 1). Signed, so the
 * pass writes through fragmentNode and the targets are half float.
 */
import * as THREE from "three";
import { QuadMesh } from "three/webgpu";
import {
  Break, Fn, If, Loop, float, int, length, max, mix, smoothstep, step, texture, uniform, uniformArray, uv, vec2, vec4,
} from "three/tsl";

const RES = 256;
const WORLD = 64;
const MAX_STAMPS = 32;

export function createGrassPushField({ renderer }) {
  const params = {
    /** Seconds for a push to fade to ~37%; about 3× this until it is gone. */
    recovery: 2.5,
  };

  const makeRT = () => {
    const rt = new THREE.RenderTarget(RES, RES, {
      format: THREE.RGBAFormat,
      type: THREE.HalfFloatType,
      colorSpace: THREE.NoColorSpace,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: false,
      depthBuffer: false,
    });
    rt.texture.flipY = false;
    return rt;
  };
  const rts = [makeRT(), makeRT()];
  let ri = 0;

  function clearAll() {
    const prevRT = renderer.getRenderTarget();
    const prevCol = new THREE.Color();
    renderer.getClearColor(prevCol);
    const prevA = renderer.getClearAlpha();
    renderer.setClearColor(new THREE.Color(0, 0, 0), 1);
    for (const rt of rts) { renderer.setRenderTarget(rt); renderer.clear(true, false, false); }
    renderer.setRenderTarget(prevRT);
    renderer.setClearColor(prevCol, prevA);
  }
  clearAll();

  // What the grass samples. Its .value swaps to the freshly written target, so
  // consumers must read it with `.sample(uv)` (texture(node, uv) would bake the
  // build-time texture in — see snowSystem.js).
  const textureNode = texture(rts[0].texture);
  const srcNode = texture(rts[0].texture);

  const stampVecs = Array.from({ length: MAX_STAMPS }, () => new THREE.Vector4());
  // Per stamp: xy = unit direction the object is moving (0 when still).
  const moveVecs = Array.from({ length: MAX_STAMPS }, () => new THREE.Vector4());
  const pu = {
    shiftUV: uniform(new THREE.Vector2()),
    keep: uniform(1),
    count: uniform(0),
    stamps: uniformArray(stampVecs, "vec4"),
    moves: uniformArray(moveVecs, "vec4"),
  };

  const passMat = new THREE.MeshBasicNodeMaterial();
  passMat.toneMapped = passMat.fog = passMat.depthTest = passMat.depthWrite = false;
  passMat.fragmentNode = Fn(() => {
    const here = uv();
    const src = here.add(pu.shiftUV);
    const inB = step(float(0), src.x).mul(step(src.x, float(1)))
      .mul(step(float(0), src.y)).mul(step(src.y, float(1)));
    const push = srcNode.sample(src.clamp(0, 1)).xy.mul(inB).mul(pu.keep).toVar("push");
    Loop({ start: int(0), end: int(MAX_STAMPS), type: "int", condition: "<" }, ({ i }) => {
      If(float(i).greaterThanEqual(pu.count), () => { Break(); });
      const s = pu.stamps.element(i);
      const m = pu.moves.element(i).xy;
      const d = here.sub(s.xy);
      const dist = length(d);
      const f = smoothstep(s.z, s.z.mul(0.35), dist).mul(s.w);
      // A moving object pushes grass the way it goes: along its path, and
      // forward-outward beside it. Purely radial parting made every stamp
      // push the grass behind it BACKWARD, so a walked trail leaned toward
      // where the walker came from. A still object (m = 0) stays radial.
      const radial = d.div(max(dist, float(1e-5)));
      const side = radial.sub(m.mul(radial.dot(m)));
      const dirRaw = side.mul(0.6).add(m);
      const cand = dirRaw.div(max(length(dirRaw), float(1e-5))).mul(f);
      // Keep the stronger push: overlapping stamps never add up past 1.
      push.assign(mix(push, cand, step(length(push), length(cand))));
    });
    return vec4(push, float(0), float(1));
  })();
  const passQuad = new QuadMesh(passMat);

  const center = new THREE.Vector2(0, 0); // world XZ of the field centre (texel-snapped)
  const pendingShift = new THREE.Vector2(0, 0);
  let stampCount = 0;
  let liveFor = 0; // seconds of recovery left before the field is all but empty
  // Steady state: a pawn standing still stamps the same disks every frame.
  // Once they have not changed for the whole recovery window, every texel
  // has settled (saturated under the stamps, zero elsewhere) and the pass
  // would write back exactly what is there — so it is skipped until the
  // stamps change or the field scrolls.
  let prevSig = NaN;
  let steadyFor = 0;

  /** Follow the grass anchor, in whole texels so the content does not swim. */
  function setAnchor(x, z) {
    const ts = WORLD / RES;
    const nx = Math.round(x / ts) * ts;
    const nz = Math.round(z / ts) * ts;
    const dx = Math.round((nx - center.x) / ts);
    const dz = Math.round((nz - center.y) / ts);
    if (dx === 0 && dz === 0) return;
    pendingShift.x += dx;
    pendingShift.y += dz;
    center.set(nx, nz);
  }

  /**
   * Push grass away from (x, z) this frame. Call every frame an object should
   * push; a moving object leaves a trail that recovers over `params.recovery`.
   * @param radius metres, @param strength 0..1
   * @param dirX,dirZ direction the object is moving (any length; 0,0 = still)
   */
  function stamp(x, z, radius, strength = 1, dirX = 0, dirZ = 0) {
    if (stampCount >= MAX_STAMPS) return;
    const u = (x - center.x) / WORLD + 0.5;
    const v = (z - center.y) / WORLD + 0.5;
    const r = radius / WORLD;
    if (u < -r || u > 1 + r || v < -r || v > 1 + r) return;
    const len = Math.hypot(dirX, dirZ);
    moveVecs[stampCount].set(len > 1e-6 ? dirX / len : 0, len > 1e-6 ? dirZ / len : 0, 0, 0);
    stampVecs[stampCount++].set(u, v, r, Math.max(0, Math.min(1, strength)));
  }

  /**
   * Run the pass if anything needs it. Call once per frame after stamping.
   * @returns {boolean} whether a pass ran (for measurement)
   */
  function update(dt) {
    let sig = stampCount;
    for (let i = 0; i < stampCount; i++) {
      const v = stampVecs[i];
      const mv = moveVecs[i];
      sig = (sig * 31 + Math.round(mv.x * 64) * 3 + Math.round(mv.y * 64) * 5) % 2147483647;
      // Bounded rolling hash (a plain ×31 chain overflows to Infinity and
      // would call every frame "steady").
      sig = (sig * 31 + Math.round(v.x * 4096) * 7 + Math.round(v.y * 4096) * 13
        + Math.round(v.z * 4096) + Math.round(v.w * 64)) % 2147483647;
    }
    const shifted = pendingShift.x !== 0 || pendingShift.y !== 0;
    steadyFor = (stampCount > 0 && sig === prevSig && !shifted) ? steadyFor + dt : 0;
    prevSig = sig;
    if (stampCount > 0 && steadyFor > params.recovery * 3) { stampCount = 0; return false; }

    if (stampCount > 0) liveFor = params.recovery * 3;
    if (liveFor <= 0) { pendingShift.set(0, 0); return false; }
    liveFor -= dt;

    const wi = 1 - ri;
    srcNode.value = rts[ri].texture;
    pu.shiftUV.value.set(pendingShift.x / RES, pendingShift.y / RES);
    pu.keep.value = Math.exp(-dt / Math.max(0.05, params.recovery));
    pu.count.value = stampCount;

    const prevRT = renderer.getRenderTarget();
    renderer.setRenderTarget(rts[wi]);
    passQuad.render(renderer);
    renderer.setRenderTarget(prevRT);

    ri = wi;
    textureNode.value = rts[wi].texture;
    stampCount = 0;
    pendingShift.set(0, 0);
    if (liveFor <= 0) clearAll(); // the tail is below visible: leave it clean, not faint
    return true;
  }

  /** Drop every push at once (leaving play mode, loading a project). */
  function reset() {
    stampCount = 0;
    liveFor = 0;
    steadyFor = 0;
    prevSig = NaN;
    pendingShift.set(0, 0);
    clearAll();
  }

  return {
    params,
    /** For the grass: { textureNode, center (Vector2, live), worldSize } */
    field: { textureNode, center, worldSize: WORLD },
    setAnchor, stamp, update, reset,
    get active() { return liveFor > 0; },
  };
}
