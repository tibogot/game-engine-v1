// REFLECTIONS IN THE PADDY WATER — screen-space, in the post chain. GAME code.
// Your ask (2026-09-25): "if only SSR could make the reflection it would be
// nice to see how it looks and the perf".
//
// Why screen space: every terrace is its own water height, so a mirror render
// (the scene drawn again, flipped) would be one per terrace. Why in the POST
// chain: the scene pass there already holds the frame's colour and depth, so
// there is no screen copy to pay (the river's and the decals' grab cost
// 1.1-2.7 ms each).
//
// Per pixel: the world point under it, from the depth. If that point lies ON
// paddy water (a level map of the block, 0.5 m: the water's height or none),
// the view ray is mirrored (with a small moving ripple) and marched through
// the depth buffer in world-sized steps; where it passes behind something on
// screen, that something — a bank, the rice, a tree, a soldier — is what the
// water shows, mixed over what was there (the material's sky mirror).
// Everything else on screen leaves after one texel read.
import * as THREE from "three";
import {
  Break, Fn, If, Loop, abs, clamp, float, int, ivec2, min, mix, normalize, perspectiveDepthToViewZ, reflect,
  colorToDirection, screenUV, smoothstep, textureLoad, uniform, vec2, vec3, vec4,
} from "three/tsl";

export const PADDY_SSR_PARAMS = { enabled: true, strength: 0.8, steps: 28 };

/** `level`: { data: Float32Array (water y, or -1e4), nx, nz, x0, z0, cell }. */
export function createPaddyReflections(app, level, params = {}) {
  const P = { ...PADDY_SSR_PARAMS, ...params };
  const tex = new THREE.DataTexture(level.data, level.nx, level.nz, THREE.RedFormat, THREE.FloatType);
  tex.magFilter = tex.minFilter = THREE.NearestFilter;
  tex.needsUpdate = true;

  const uInvProj = uniform(new THREE.Matrix4());
  const uCamWorld = uniform(new THREE.Matrix4());
  const uView = uniform(new THREE.Matrix4());
  const uProj = uniform(new THREE.Matrix4());
  const uCamPos = uniform(new THREE.Vector3());
  const uOrigin = uniform(new THREE.Vector2(level.x0, level.z0));
  const uCell = uniform(level.cell);
  const uStrength = uniform(P.enabled ? P.strength : 0);
  const uDebug = uniform(0);   // 1: red = hit, blue = water but missed
  // The scene pass's pixel size (its depth is MULTISAMPLED: WGSL has no
  // textureDimensions(tex, level) for that, so the size comes from JS).
  const uSize = uniform(new THREE.Vector2(1, 1));
  let pass = null;
  const NX = level.nx, NZ = level.nz;

  function node(color, ctx = {}) {
    const scenePass = ctx.scenePass;
    if (!scenePass) return color;
    const depthTex = scenePass.getTextureNode("depth");
    const colorTex = scenePass.getTextureNode("output");
    // The scene's own normals (the post pipeline's MRT, view space): the
    // water's flatness per pixel, exactly where its shader drew water — and
    // its ripples, so the reflection moves with the surface you see.
    const normalTex = scenePass.getTextureNode("normal");
    const near = scenePass._cameraNear, far = scenePass._cameraFar;
    pass = scenePass;
    return Fn(() => {
      const out = vec4(color).toVar();
      // The world point under this pixel (as fogBanks.js does it).
      const ndc = vec2(screenUV.x, float(1).sub(screenUV.y)).mul(2).sub(1);
      const n4 = uInvProj.mul(vec4(ndc.x, ndc.y, -1, 1)), f4 = uInvProj.mul(vec4(ndc.x, ndc.y, 1, 1));
      const viewDir = normalize(f4.xyz.div(f4.w).sub(n4.xyz.div(n4.w)));
      const d = normalize(uCamWorld.mul(vec4(viewDir, 0)).xyz);
      const viewZ = scenePass.getViewZNode();
      const dist = viewZ.div(min(viewDir.z, -1e-4));
      const p = uCamPos.add(d.mul(dist));
      const nView = colorToDirection(normalTex.sample(screenUV).rgb);
      const nWorld = normalize(uCamWorld.mul(vec4(nView, 0)).xyz);
      // On paddy water? The level map says the water's height there.
      const g = p.xz.sub(uOrigin).div(uCell);
      const inside = g.x.greaterThanEqual(0).and(g.y.greaterThanEqual(0)).and(g.x.lessThan(NX)).and(g.y.lessThan(NZ));
      If(inside.and(uStrength.greaterThan(0)), () => {
        const lv = textureLoad(tex, ivec2(int(g.x), int(g.y))).r;
        If(abs(p.y.sub(lv)).lessThan(0.3).and(nWorld.y.greaterThan(0.93)), () => {
          // The surface's own normal (its ripples), softened for the mirror.
          const N = normalize(mix(vec3(0, 1, 0), nWorld, 0.35));
          const R = reflect(d, N);
          const size = uSize;
          const hit = float(0).toVar(), hitUV = vec2(0).toVar(), tHit = float(0).toVar(), tPrev = float(0).toVar();
          const tt = float(0.25).toVar(), stepLen = float(0.3).toVar();
          // Where the ray at distance t lands on screen, and how far behind
          // what is drawn there it is (positive = behind).
          const probe = (t) => {
            const q = p.add(R.mul(t));
            const qv = uView.mul(vec4(q, 1));
            const clip = uProj.mul(qv);
            const qn = clip.xy.div(clip.w);
            const uvq = vec2(qn.x.mul(0.5).add(0.5), float(0.5).sub(qn.y.mul(0.5)));
            const sz = perspectiveDepthToViewZ(textureLoad(depthTex, ivec2(uvq.clamp(0, 0.9999).mul(size))).r, near, far);
            return { uvq, behind: sz.sub(qv.z) };
          };
          Loop(P.steps, () => {
            const q = p.add(R.mul(tt));
            const qv = uView.mul(vec4(q, 1));
            const clip = uProj.mul(qv);
            const qn = clip.xy.div(clip.w);
            const uvq = vec2(qn.x.mul(0.5).add(0.5), float(0.5).sub(qn.y.mul(0.5)));
            If(uvq.x.lessThan(0).or(uvq.x.greaterThan(1)).or(uvq.y.lessThan(0)).or(uvq.y.greaterThan(1)), () => { Break(); });
            const px = ivec2(uvq.mul(size));
            const sz = perspectiveDepthToViewZ(textureLoad(depthTex, px).r, near, far);
            // Behind what is on screen there, but not far behind (a thin
            // thing, not the ground a long way past it).
            const behind = sz.sub(qv.z);
            If(behind.greaterThan(0).and(behind.lessThan(stepLen.mul(2).add(0.6))), () => {
              hit.assign(1); hitUV.assign(uvq); tHit.assign(tt);
              Break();
            });
            tPrev.assign(tt);
            tt.addAssign(stepLen);
            stepLen.mulAssign(1.14);
          });
          If(hit.greaterThan(0), () => {
            // Refine between the last miss and the hit: the coarse steps
            // otherwise leave a sawtooth under every bank.
            const lo = tPrev.toVar(), hi = tHit.toVar();
            Loop(5, () => {
              const mid = lo.add(hi).mul(0.5);
              const pr = probe(mid);
              If(pr.behind.greaterThan(0), () => { hi.assign(mid); hitUV.assign(pr.uvq); }).Else(() => { lo.assign(mid); });
            });
            const hc = textureLoad(colorTex, ivec2(hitUV.mul(size))).rgb;
            // Fades: toward the screen's edges (where the march loses what it
            // would hit) and with the distance travelled.
            const edge = smoothstep(0, 0.08, min(min(hitUV.x, float(1).sub(hitUV.x)), min(hitUV.y, float(1).sub(hitUV.y))));
            const onWater = smoothstep(0.93, 0.975, nWorld.y).mul(float(1).sub(smoothstep(0.15, 0.3, abs(p.y.sub(lv)))));
            const k = uStrength.mul(edge).mul(onWater).mul(float(1).sub(smoothstep(18, 40, tHit)));
            out.assign(vec4(mix(out.rgb, hc.mul(vec3(0.82, 0.88, 0.9)), clamp(k, 0, 1)), out.a));
          });
          If(uDebug.greaterThan(0), () => { out.assign(vec4(mix(vec3(0, 0, 1), vec3(1, 0, 0), hit), 1)); });
        });
      });
      return out;
    })();
  }

  return {
    params: P, uDebug,
    node,
    set(key, v) {
      P[key] = v;
      uStrength.value = P.enabled ? P.strength : 0;
    },
    /** Per frame: the camera. */
    update() {
      const cam = app.camera;
      uInvProj.value.copy(cam.projectionMatrixInverse);
      uCamWorld.value.copy(cam.matrixWorld);
      uView.value.copy(cam.matrixWorldInverse);
      uProj.value.copy(cam.projectionMatrix);
      uCamPos.value.setFromMatrixPosition(cam.matrixWorld);
      const rt = pass?.renderTarget;
      if (rt) uSize.value.set(rt.width, rt.height);
    },
  };
}
