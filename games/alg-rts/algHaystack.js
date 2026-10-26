// THE HAYSTACKS (2026-10-26, you: the props' hay "look really like some low poly assets, very cheap"; the straw-card one
// "far better … that's the minimum level we want for assets, nothing cheaper"). tools/blender/haystack.py builds it: a
// lumpy core under ~550 alpha-tested STRAW CARDS (HayNear, ~4.6k triangles) and a coarser stack with ~110 bigger cards
// (HayFar, ~0.8k) — each level ONE mesh on ONE sheet (public/textures/props/haystack.png), so one draw a level for
// every haystack on the map: the villages' stackyards (algVillageLife) and the pens' and farmyards' (algPenProps).
//
// NO POP: near and far CROSS-FADE over FADE (a screen-space dither — each instance's weight; the far draws exactly the
// pixels the near gives up, so the two never stack or leave a hole). WIND: the stack leans a little with the gusts,
// its straw tips flutter (the flutter weight read from the UV — the straw half, v: 0 at a card's root, 1 at its tip).
// FOG: the game's, as every lit material. MIPMAPS: built here, each level's alpha scaled so the straw keeps its
// coverage (Castaño, The Witness — v3/render/foliage/alphaCoverageMips.js explains it; that one is for white masks,
// this sheet carries its colour): strands one texel wide dissolve down a plain mip chain and the stack went bald.
//
// One field for the game (and the lab): add() a haystack in the world or ATTACHED to a piece (a pen moves with it);
// update(camera) each frame. ?hay=0 = without.
import * as THREE from "three";
import { attribute, clamp, float, fract, mix, normalLocal, positionLocal, screenCoordinate, select, sin, step, texture, time, transformNormalToView, uniform, uv, vec2, vec3 } from "three/tsl";
import { getSharedGltfLoader } from "../../v3/render/foliage/glbLoader.js";

/** Where the far level takes over (world m from the camera): near under FADE[0], far past FADE[1], dithered between. */
export const HAY_FADE = [52, 66];
const S = 1.3;        // (the stack in real metres; the game draws props ×1.3)
const OFF = typeof location !== "undefined" && new URLSearchParams(location.search).get("hay") === "0";

let _p = null, _parts = null;
/** Load the model and its sheet once. Null when missing. */
export function loadHaystack() {
  return (_p ??= Promise.all([
    getSharedGltfLoader().loadAsync("/models/alg/haystack.glb"),
    new THREE.ImageLoader().loadAsync("/textures/props/haystack.png"),
  ]).then(([gltf, img]) => {
    const near = gltf.scene.getObjectByName("HayNear"), far = gltf.scene.getObjectByName("HayFar");
    if (!near?.isMesh || !far?.isMesh) return null;
    const tex = coverageTexture(img);
    const local = (o) => { o.updateMatrix(); return o.matrix.clone(); };   // (the meshopt node transform: undoes the quantisation)
    _parts = { near: { geo: near.geometry, local: local(near), mat: hayMaterial(tex) }, far: { geo: far.geometry, local: local(far), mat: hayMaterial(tex, true) } };
    _field?.rebuild();
    return _parts;
  }).catch((e) => { console.warn("[haystack]", e); return null; }));
}

/** The sheet with COVERAGE-PRESERVING mipmaps: colour averaged by alpha, each level's alpha scaled to keep the
 *  fraction of texels passing the 0.5 test that the full-size sheet has. */
function coverageTexture(img) {
  const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
  const g = c.getContext("2d"); g.drawImage(img, 0, 0);
  let w = c.width, h = c.height, px = g.getImageData(0, 0, w, h).data;
  // (the canvas premultiplies: a transparent texel's colour comes back BLACK, and the filtering dragged it into every
  // strand's edge — the stack drew grey. Those texels take the straw's mean colour.)
  { let r = 0, gg = 0, b = 0, n = 0;
    for (let i = 0; i < px.length; i += 4) if (px[i + 3] > 200) { r += px[i]; gg += px[i + 1]; b += px[i + 2]; n++; }
    r /= n; gg /= n; b /= n;
    for (let i = 0; i < px.length; i += 4) if (px[i + 3] < 8) { px[i] = r; px[i + 1] = gg; px[i + 2] = b; } }
  const cover = (a, s) => { let n = 0; for (let i = 3; i < a.length; i += 4) if (a[i] * s >= 127.5) n++; return n / (a.length / 4); };
  const target = cover(px, 1);
  const mips = [{ data: new Uint8Array(px), width: w, height: h }];
  while (w > 1 || h > 1) {
    const nw = Math.max(1, w >> 1), nh = Math.max(1, h >> 1), out = new Uint8Array(nw * nh * 4);
    for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
      let r = 0, gg = 0, b = 0, a = 0;
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        const i = ((Math.min(h - 1, y * 2 + dy)) * w + Math.min(w - 1, x * 2 + dx)) * 4, al = px[i + 3];
        r += px[i] * al; gg += px[i + 1] * al; b += px[i + 2] * al; a += al;
      }
      const o = (y * nw + x) * 4;
      if (a > 0) { out[o] = r / a; out[o + 1] = gg / a; out[o + 2] = b / a; } else { const i = ((y * 2) * w + x * 2) * 4; out[o] = px[i]; out[o + 1] = px[i + 1]; out[o + 2] = px[i + 2]; }
      out[o + 3] = a / 4;
    }
    // the alpha scale that keeps the coverage (a bisection)
    let lo = 1, hi = 8;
    for (let k = 0; k < 14; k++) { const m = (lo + hi) / 2; if (cover(out, m) < target) lo = m; else hi = m; }
    for (let i = 3; i < out.length; i += 4) out[i] = Math.min(255, out[i] * hi);
    mips.push({ data: out, width: nw, height: nh });
    px = out; w = nw; h = nh;
  }
  const t = new THREE.DataTexture(mips[0].data, mips[0].width, mips[0].height, THREE.RGBAFormat);
  t.mipmaps = mips;
  t.colorSpace = THREE.SRGBColorSpace;
  t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = false; t.anisotropy = 4;
  t.flipY = false;   // (the PNG's rows as drawn: the canvas reads them top-down, as the glTF's UVs expect)
  t.needsUpdate = true;
  return t;
}

// THE WIND (algWind via showroom: setHayWind) — the stack's lean and the straw's flutter
const uWind = uniform(new THREE.Vector3(Math.cos(3.49), 0, Math.sin(3.49)));   // (direction × strength, local-ish: see below)
const uGust = uniform(0.55);
/** Follow the game's wind (dir in radians, strength 0..1). */
export function setHayWind(dirRad, strength) { uWind.value.set(Math.cos(dirRad), 0, Math.sin(dirRad)); uGust.value = strength; }

function hayMaterial(tex, far = false) {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.95, metalness: 0, side: THREE.DoubleSide });
  m.name = far ? "HaystackFar" : "Haystack";
  const t = texture(tex, uv());
  // per instance: x = its NEAR weight (1 near … 0 far), y = its wind phase
  const data = attribute("iHay", "vec2");
  // the dither: interleaved gradient noise on the screen — the near keeps the pixels under its weight, the far the rest
  const ign = fract(float(52.9829189).mul(fract(screenCoordinate.xy.dot(vec2(0.06711056, 0.00583715)))));
  const keep = far ? step(data.x, ign) : step(ign, data.x).mul(step(0.001, data.x));
  m.colorNode = t.rgb.mul(attribute("color", "vec3"));
  m.opacityNode = t.a.mul(keep);
  m.alphaTest = 0.5;
  // the WIND: the whole stack leans a few cm at its top with the gusts; the straw's tips flutter faster
  const y = positionLocal.y, hgt = clamp(y.div(2.6), 0, 1);
  const ph = data.y, tt = time;
  const gust = sin(tt.mul(0.9).add(ph)).mul(0.6).add(sin(tt.mul(2.3).add(ph.mul(1.7))).mul(0.4)).mul(uGust);
  const tip = select(uv().x.lessThan(0.5), uv().y, float(0));   // (the straw half — glTF flips v: 0 at a card's root, 1 at its tip)
  const flutter = sin(tt.mul(5.1).add(ph).add(y.mul(3.1)).add(positionLocal.x.mul(2.3))).mul(tip).mul(uGust).mul(far ? 0 : 0.035);
  m.positionNode = positionLocal.add(uWind.mul(hgt.mul(hgt).mul(gust).mul(0.06).add(flutter))).add(vec3(0, flutter.mul(0.3), 0));
  // the VOLUME's normals (haystack.py: from the stack's axis), not flipped on a card's back face — a card seen from
  // behind is the same straw, lit the same
  m.normalNode = transformNormalToView(normalLocal);
  return m;
}

// ── THE FIELD: every haystack, two instanced meshes (near, far) ───────────────────────────────────────────────────────
let _field = null;
/** The game's (and the lab's) one field of haystacks. */
export function haystackField() {
  if (_field) return _field;
  const root = new THREE.Group(); root.name = "Haystacks";
  const items = [];   // { parent, local: Matrix4, phase, force }
  const sets = {};
  const _w = new THREE.Matrix4(), _p = new THREE.Vector3();
  function make(level, n) {
    const P = _parts[level];
    const geo = P.geo.clone();
    geo.setAttribute("iHay", new THREE.InstancedBufferAttribute(new Float32Array(n * 2), 2));
    const im = new THREE.InstancedMesh(geo, P.mat, n);
    im.count = 0; im.castShadow = im.receiveShadow = true; im.frustumCulled = false;
    im.name = level === "near" ? "HaystackNear" : "HaystackFar";
    root.add(im);
    return im;
  }
  const visibleChain = (o) => { for (let q = o; q; q = q.parent) if (!q.visible) return false; return true; };
  const sceneOf = (o) => { let q = o; while (q.parent) q = q.parent; return q.isScene ? q : null; };
  const f = (_field = {
    root,
    /** A haystack: world (`parent` null) or attached to a piece (pen spots: the piece's local frame). `force`: "near" |
     *  "far" (the lab's side-by-side). */
    add(parent, x, y, z, yaw = 0, scale = 1, force = null) {
      const local = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw), new THREE.Vector3(1, 1, 1).multiplyScalar(S * scale));
      items.push({ parent, local, phase: ((x * 12.9898 + z * 78.233) % 6.283 + 6.283) % 6.283, force });
      f.rebuild();
      return items.length - 1;
    },
    /** Remove every haystack attached under `obj` (a piece taken out of the lab). */
    dropUnder(obj) {
      for (let i = items.length - 1; i >= 0; i--) { for (let q = items[i].parent; q; q = q.parent) if (q === obj) { items.splice(i, 1); break; } }
      f.rebuild();
    },
    rebuild() {
      if (!_parts) return;
      for (const im of Object.values(sets)) { root.remove(im); im.geometry.dispose(); }
      const n = Math.max(1, items.length);
      sets.near = make("near", n); sets.far = make("far", n);
    },
    /** Per frame, with the MAIN camera: each haystack's near weight, its matrices into the near and far sets. */
    update(camera) {
      if (OFF || !_parts || !sets.near) return;
      let nn = 0, nf = 0;
      const dn = sets.near.geometry.attributes.iHay, df = sets.far.geometry.attributes.iHay;
      for (const it of items) {
        if (it.parent) {
          if (!visibleChain(it.parent)) continue;
          const sc = sceneOf(it.parent);
          if (!sc) continue;                             // (its piece taken out of the scene: the lab's other entries)
          if (root.parent !== sc) sc.add(root);          // (the lab: its own scene)
          _w.multiplyMatrices(it.parent.matrixWorld, it.local);
        } else _w.copy(it.local);
        _p.setFromMatrixPosition(_w);
        const d = _p.distanceTo(camera.position);
        let k = it.force === "near" ? 1 : it.force === "far" ? 0 : THREE.MathUtils.clamp((HAY_FADE[1] - d) / (HAY_FADE[1] - HAY_FADE[0]), 0, 1);
        if (k > 0) { sets.near.setMatrixAt(nn, _m.multiplyMatrices(_w, _parts.near.local)); dn.setXY(nn, k, it.phase); nn++; }
        if (k < 1) { sets.far.setMatrixAt(nf, _m.multiplyMatrices(_w, _parts.far.local)); df.setXY(nf, k, it.phase); nf++; }
      }
      for (const [im, n, a] of [[sets.near, nn, dn], [sets.far, nf, df]]) {
        im.count = n; im.instanceMatrix.needsUpdate = true; a.needsUpdate = true;
      }
    },
    /** Haystacks, and the draws this frame (near + far; ×2 with the shadow pass). */
    stats() { return { haystacks: items.length, near: sets.near?.count ?? 0, far: sets.far?.count ?? 0 }; },
  });
  loadHaystack();
  return f;
}
const _m = new THREE.Matrix4();
