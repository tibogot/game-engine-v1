// v3/render/culling/cpuCull.js — the CPU half of the culling / LOD rules (CULLING_LOD_SPEC.md R1,
// R3). Pinned two ways: lodTier against VERBATIM copies of the hand-written tier code it replaced
// (propInstancer._pickTier, treeLodRenderer's trunk tiers), and sphereVisibleCpu against a JS
// port of the GPU test (gpuCull.frustumVisibleAtClip), on many random cases each.
import * as THREE from "three";
import { lodTier, TIER_UNSET, LOD_HYSTERESIS, paddedClipPlanes, sphereVisibleCpu } from "../v3/render/culling/cpuCull.js";

let fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  if (!ok) fail++;
};
let seed = 12345;
const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);

// ── The OLD code, verbatim (2026-10-26) ─────────────────────────────────────────────────────
const H = 0.1;
// v3/tools/propInstancer.js _pickTier — tiers 0,1,2 drawn, 3 hidden
function oldPropTier(dist2, tier, d0, d1, dF) {
  const out2 = (1 + H) ** 2, in2 = (1 - H) ** 2;
  if (tier > 3 || tier === TIER_UNSET) {
    if (dist2 > dF) return 3;
    if (dist2 > d1) return 2;
    if (dist2 > d0) return 1;
    return 0;
  }
  const [d0o, d0i, d1o, d1i, dFo, dFi] = [d0 * out2, d0 * in2, d1 * out2, d1 * in2, dF * out2, dF * in2];
  if (tier === 3) return dist2 < dFi ? (dist2 < d1i ? (dist2 < d0i ? 0 : 1) : 2) : 3;
  if (tier === 2) return dist2 > dFo ? 3 : (dist2 < d1i ? (dist2 < d0i ? 0 : 1) : 2);
  if (tier === 1) return dist2 > dFo ? 3 : (dist2 > d1o ? 2 : (dist2 < d0i ? 0 : 1));
  return dist2 > dFo ? 3 : (dist2 > d1o ? 2 : (dist2 > d0o ? 1 : 0));
}
// v3/render/foliage/treeLodRenderer.js — tiers 0,1 drawn, 2 hidden, 255 unset
function oldTrunkTier(dist2, tier, lod0D2, fadeD2) {
  const out2 = (1 + H) * (1 + H), in2 = (1 - H) * (1 - H);
  const lod0OutD2 = lod0D2 * out2, lod0InD2 = lod0D2 * in2, fadeOutD2 = fadeD2 * out2, fadeInD2 = fadeD2 * in2;
  if (tier > 2) {
    tier = dist2 > fadeD2 ? 2 : dist2 > lod0D2 ? 1 : 0;
  } else if (tier === 2) {
    if (dist2 < fadeInD2) tier = dist2 < lod0InD2 ? 0 : 1;
  } else if (tier === 1) {
    if (dist2 > fadeOutD2) tier = 2;
    else if (dist2 < lod0InD2) tier = 0;
  } else {
    if (dist2 > fadeOutD2) tier = 2;
    else if (dist2 > lod0OutD2) tier = 1;
  }
  return tier;
}
// gpuCull.frustumVisibleAtClip, ported to JS (step(a, b) = b >= a ? 1 : 0)
function gpuVisible(clip, fx, fy, radius, padX, padYNear, padYFar) {
  const depth = Math.max(Math.abs(clip.w), 1e-4);
  const nx = clip.x / depth, ny = clip.y / depth, nz = clip.z / depth;
  const rX = fx * radius / depth + padX, rY = fy * radius / depth;
  const inX = nx >= -1 - rX && nx <= 1 + rX;
  const inY = ny >= -1 - rY - padYNear && ny <= 1 + rY + padYFar;
  const inFront = clip.w >= 0 && nz <= 1;
  const nearCamera = Math.abs(clip.w) <= radius;
  return nearCamera || (inX && inY && inFront);
}

check("hysteresis is the engine's 0.1", LOD_HYSTERESIS === H);

// ── lodTier = the prop instancer's 4 tiers ───────────────────────────────────────────────────
{
  let bad = 0, first = "";
  for (let i = 0; i < 200000; i++) {
    const d0 = 5 + rnd() * 60, d1 = d0 + rnd() * 80, dF = d1 + rnd() * 200;
    const e = [d0 * d0, d1 * d1, dF * dF];
    // distances clustered round the edges, where hysteresis matters
    const pick = [d0, d1, dF][Math.floor(rnd() * 3)] * (0.8 + rnd() * 0.4);
    const dist2 = (rnd() < 0.8 ? pick : rnd() * dF * 1.5) ** 2;
    const prev = rnd() < 0.1 ? TIER_UNSET : Math.floor(rnd() * 4);
    const a = oldPropTier(dist2, prev, e[0], e[1], e[2]), b = lodTier(dist2, prev, e);
    if (a !== b) { bad++; if (!first) first = `dist2 ${dist2.toFixed(1)} prev ${prev} edges ${e.map((x) => x.toFixed(1))}: old ${a}, new ${b}`; }
  }
  check("lodTier = propInstancer._pickTier on 200k cases", bad === 0, bad ? `${bad} differ, e.g. ${first}` : "");
}

// ── lodTier = the trunk renderer's 3 tiers ───────────────────────────────────────────────────
{
  let bad = 0, first = "";
  for (let i = 0; i < 200000; i++) {
    const d0 = 10 + rnd() * 100, dF = d0 + rnd() * 400;
    const e = [d0 * d0, dF * dF];
    const pick = [d0, dF][Math.floor(rnd() * 2)] * (0.8 + rnd() * 0.4);
    const dist2 = (rnd() < 0.8 ? pick : rnd() * dF * 1.5) ** 2;
    const prev = rnd() < 0.1 ? TIER_UNSET : Math.floor(rnd() * 3);
    const a = oldTrunkTier(dist2, prev, e[0], e[1]), b = lodTier(dist2, prev, e);
    if (a !== b) { bad++; if (!first) first = `dist2 ${dist2.toFixed(1)} prev ${prev}: old ${a}, new ${b}`; }
  }
  check("lodTier = treeLodRenderer's trunk tiers on 200k cases", bad === 0, bad ? `${bad} differ, e.g. ${first}` : "");
}

// ── Hysteresis behaves: no flicker on a boundary, jumps allowed ──────────────────────────────
{
  const e = [50 * 50, 150 * 150];
  let t = lodTier(49 * 49, TIER_UNSET, e);
  check("first sight: plain threshold", t === 0 && lodTier(51 * 51, TIER_UNSET, e) === 1);
  t = lodTier(52 * 52, t, e);
  check("inside the band: stays (no flip at 52 m)", t === 0);
  t = lodTier(56 * 56, t, e);
  check("past d·1.1: demotes", t === 1);
  t = lodTier(48 * 48, t, e);
  check("back inside the band: stays (no flip at 48 m)", t === 1);
  t = lodTier(44 * 44, t, e);
  check("under d·0.9: promotes", t === 0);
  check("a jump straight to hidden", lodTier(400 * 400, 0, e) === 2);
  check("a jump straight back to tier 0", lodTier(10 * 10, 2, e) === 0);
}

// ── sphereVisibleCpu = the GPU frustum test ─────────────────────────────────────────────────
{
  let bad = 0, kept = 0, first = "";
  const cam = new THREE.PerspectiveCamera(60, 16 / 9, 0.5, 2000);
  const M = new THREE.Matrix4(), v = new THREE.Vector4();
  for (let c = 0; c < 400; c++) {
    cam.fov = 30 + rnd() * 60; cam.aspect = 1 + rnd(); cam.updateProjectionMatrix();
    cam.position.set(rnd() * 200 - 100, rnd() * 80, rnd() * 200 - 100);
    cam.lookAt(rnd() * 200 - 100, rnd() * 20, rnd() * 200 - 100);
    cam.updateMatrixWorld(true);
    M.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    const fx = cam.projectionMatrix.elements[0], fy = cam.projectionMatrix.elements[5];
    for (let k = 0; k < 500; k++) {
      const r = 0.2 + rnd() * 20, px = rnd() * 0.6, pyn = rnd() * 0.8, pyf = rnd() * 0.5;
      const x = rnd() * 600 - 300, y = rnd() * 120 - 20, z = rnd() * 600 - 300;
      v.set(x, y, z, 1).applyMatrix4(M);
      const g = gpuVisible(v, fx, fy, r, px, pyn, pyf);
      const p = sphereVisibleCpu(paddedClipPlanes(M.elements, fx, fy, r, px, pyn, pyf), x, y, z, r);
      if (g) kept++;
      // a hair's tolerance on the boundary itself: a·p + d vs a float divide
      if (g !== p) {
        const margin = Math.min(...paddedClipPlanes(M.elements, fx, fy, r, px, pyn, pyf).map((q) => Math.abs(q[0] * x + q[1] * y + q[2] * z + q[3])));
        if (margin > 1e-6) { bad++; if (!first) first = `gpu ${g} cpu ${p} r ${r.toFixed(2)}`; }
      }
    }
  }
  check("sphereVisibleCpu = gpuCull.frustumVisibleAtClip on 200k spheres", bad === 0, bad ? `${bad} differ, e.g. ${first}` : `${kept} kept`);
}

if (fail) { console.log(`\n${fail} FAILED`); process.exit(1); }
console.log("\nall cpuCull checks passed");
