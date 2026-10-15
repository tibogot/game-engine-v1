// BOOK CARD — one camera-facing card playing a baked Fire Pro book, shaded as the
// game's lit smoke (games/shared-rts/litSmoke.js) does, plus the flame's own light:
//
//   six-way   each axis's map on the sun's side, weighted by L² (sums to 1)
//   smoke     tint × (sun × lit × 0.65 + ambient)     — Fire Pro's direct factor, so the
//             card and the live volume beside it answer the same sun the same way
//   flame     B.a² × emissionMax, coloured by M.b (green/red warmth) — premultiplied,
//             it ADDS light (a thin flame has little opacity and all its glow)
//   motion    both frames slid along M.rg before they are mixed (litSmoke's blend)
import * as THREE from "three";
import { BloomMRTNode } from "../render/bloomMRT.js";
import { float, floor, fract, mix, positionWorld, saturate, select, smoothstep, texture, uniform, uv, vec2, vec3, vec4, max } from "three/tsl";

/** Atlas bytes (frame 0 top-left) → textures (row 0 = v 0, so the rows go bottom-up). */
export function bookTextures({ W, H, A, B, M }) {
  const make = (src, srgb) => {
    const data = new Uint8Array(src.length), row = W * 4;
    for (let y = 0; y < H; y++) data.set(src.subarray(y * row, (y + 1) * row), (H - 1 - y) * row);
    const t = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.UnsignedByteType);
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.minFilter = THREE.LinearFilter; t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = false;
    t.needsUpdate = true;
    return t;
  };
  return { a: make(A, true), b: make(B, true), mv: make(M, false) };
}

/** Saved webp atlases, loaded as the game would (TextureLoader, flipY). */
export async function loadBookTextures(base) {
  const meta = await (await fetch(`${base}.json`, { cache: "no-store" })).json();
  const load = (url, srgb) => new Promise((res, rej) => new THREE.TextureLoader().load(`${url}?v=${Date.now()}`, (t) => {
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.generateMipmaps = false; t.minFilter = THREE.LinearFilter;
    res(t);
  }, undefined, rej));
  const [a, b, mv] = await Promise.all([load(`${base}_a.webp`, true), load(`${base}_b.webp`, true), load(`${base}_mv.webp`, false)]);
  return { meta, tex: { a, b, mv } };
}

/**
 * `groundAt(x, z)` (optional, TSL nodes → the ground's height node): fade into the REAL terrain
 * under each pixel (a game passes its heightmap tap, terrainDrape.drapeY). Without it the card
 * fades above one height (uGroundY) — on a slope the ground rose through the card before the
 * fade and the depth test cut it there in a hard line (the flamethrower in the battle lab).
 */
export function createBookCard({ groundAt = null } = {}) {
  const uAge = uniform(0);            // 0..1 through the book
  const uLoop = uniform(0);
  const uSunL = uniform(new THREE.Vector3(0, 1, 0));   // the sun in the card's frame
  const uSun = uniform(new THREE.Color(3, 3, 3));
  const uAmb = uniform(new THREE.Color(0.4, 0.45, 0.5));
  const uTint = uniform(new THREE.Color(0.2, 0.2, 0.2));
  const uFireK = uniform(1);
  const uEmax = uniform(1);
  const uMvScale = uniform(24);
  const uMotion = uniform(1);
  const uFade = uniform(1);
  // AXIAL cards (a flamethrower's stream): how far along the card the stream has reached
  // from the nozzle (0..1 of the rest of the card), and where the nozzle sits on it (u).
  const uReach = uniform(1), uAnchorU = uniform(0);
  // The left edge's fade: 12% as litSmoke, none on an axial card (its nozzle sits at the edge).
  const uFadeL = uniform(0.12);
  // INTO THE GROUND softly (m; 0 = off): a card tilted to face the camera dips under the
  // ground, and the depth test cut it there in a hard straight line (the flamethrower's belly).
  const uGroundY = uniform(0), uGroundFade = uniform(0.6);           // the whole card (a one-shot fades out at its end)
  const uFrames = uniform(64);
  const uBloom = uniform(0.3);        // share of the flame's light written to the bloom buffer
  const uCols = uniform(8), uRows = uniform(8), uInset = uniform(0.5 / 192);

  // Placeholder textures until the first bake: TSL fixes the texture nodes at build.
  const blank = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1);
  blank.needsUpdate = true;
  const tA = texture(blank), tB = texture(blank), tM = texture(blank);

  const cellUV = (idx, local) => {
    const col = idx.mod(uCols), row = floor(idx.div(uCols));
    const q = local.clamp(uInset, float(1).sub(uInset));
    return vec2(col.add(q.x).div(uCols), uRows.sub(1).sub(row).add(q.y).div(uRows));
  };

  // Plain node expressions (no Fn): the colour and the BLOOM output share every sample.
  const { shade, bloomOut } = (() => {
    const last = uFrames.sub(1);
    // A one-shot plays frame 0 → N-1 over its life; a loop wraps N-1 → 0.
    const f = select(uLoop.greaterThan(0.5), fract(uAge).mul(uFrames), uAge.clamp(0, 1).mul(last));
    const f0 = floor(f), w = fract(f);
    const f1 = select(uLoop.greaterThan(0.5), f0.add(1).mod(uFrames), f0.add(1).min(last));
    const local = uv();
    const mvTex = tM.sample(cellUV(f0, local));
    const mv = mvTex.xy.sub(0.5).div(uMvScale).mul(uMotion);
    const l0 = local.sub(mv.mul(w)), l1 = local.add(mv.mul(float(1).sub(w)));
    const A = mix(tA.sample(cellUV(f0, l0)), tA.sample(cellUV(f1, l1)), w);
    const B = mix(tB.sample(cellUV(f0, l0)), tB.sample(cellUV(f1, l1)), w);
    const warm = mix(mvTex.z, tM.sample(cellUV(f1, l1)).z, w);
    const L = uSunL, L2 = L.mul(L);
    const lit = L2.x.mul(select(L.x.greaterThan(0), A.x, B.x))
      .add(L2.y.mul(select(L.y.greaterThan(0), A.y, B.y)))
      .add(L2.z.mul(select(L.z.greaterThan(0), A.z, B.z)));
    const smoke = vec3(uTint).mul(vec3(uSun).mul(lit).mul(0.65).add(vec3(uAmb)));
    // Blackbody-ish from green/red: deep red (g/r .2) → orange → yellow-white (g/r .8+).
    const flameCol = vec3(1, warm, warm.mul(warm).mul(warm).mul(0.9));
    const lum = flameCol.dot(vec3(0.2126, 0.7152, 0.0722));
    const E = B.w.mul(B.w).mul(uEmax).mul(uFireK);
    const glow = flameCol.div(max(lum, float(1e-4))).mul(E);
    // The card's outer 12% fades, as litSmoke's: smoke that leaves the bake box (a
    // plume past the top, wind past the side) ends softly, not on a square edge.
    const e = uv().min(float(1).sub(uv()));
    const reachEdge = uAnchorU.add(uReach.mul(float(1).sub(uAnchorU)));
    let border = smoothstep(0, uFadeL.max(1e-4), uv().x).mul(smoothstep(0, 0.12, float(1).sub(uv().x))).mul(smoothstep(0, 0.12, e.y))
      .mul(float(1).sub(smoothstep(reachEdge.sub(0.04), reachEdge, uv().x)));
    const groundY = groundAt ? groundAt(positionWorld.x, positionWorld.z) : uGroundY;
    const ground = select(uGroundFade.greaterThan(0), saturate(positionWorld.y.sub(groundY).div(uGroundFade.max(1e-3))), float(1));
    border = border.mul(ground);
    const a = A.w.mul(border).mul(uFade);
    const light = glow.mul(border).mul(uFade);
    return { shade: vec4(smoke.mul(a).add(light), a), bloomOut: vec4(light.mul(uBloom), a) };
  })();

  const material = new THREE.MeshBasicNodeMaterial({
    transparent: true, depthWrite: false, depthTest: true, side: THREE.DoubleSide,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
  });
  material.colorNode = shade.xyz;
  material.opacityNode = shade.w;
  material.fog = false;
  // THE FLAME GLOWS in a game's selective bloom (its emissive MRT buffer, v3/render/bloomMRT.js);
  // on a plain target (the labs) this collapses to the normal output.
  material.mrtNode = new BloomMRTNode({ emissive: bloomOut });

  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
  mesh.name = "Baked book card";
  mesh.frustumCulled = false;
  mesh.renderOrder = 10;
  mesh.visible = false;

  const _r = new THREE.Vector3(), _u = new THREE.Vector3(), _b = new THREE.Vector3(), _m = new THREE.Matrix4(), _y = new THREE.Vector3();
  return {
    mesh,
    u: { uFireK, uMotion, uTint, uSun, uSunL, uAmb, uFade, uReach, uGroundY, uGroundFade, uBloom },
    /** Show a book: textures { a, b, mv } and its meta. */
    setBook(tex, meta) {
      tA.value = tex.a; tB.value = tex.b; tM.value = tex.mv;
      uCols.value = meta.cols; uRows.value = meta.rows; uFrames.value = meta.frames;
      uInset.value = 0.5 / meta.cell;
      uMvScale.value = meta.mvScale; uEmax.value = meta.emissionMax;
      uLoop.value = meta.loop ? 1 : 0;
      mesh.visible = true;
    },
    /** Per frame: where the book is (0..1, loops wrap), the camera, and the scene's light. */
    update({ age, camera, center, size, sunDir, sunColor, ambient }) {
      uAge.value = age;
      uFadeL.value = 0.12; uReach.value = 1; uAnchorU.value = 0;
      mesh.position.copy(center);
      mesh.quaternion.copy(camera.quaternion);
      mesh.scale.setScalar(size);
      camera.matrixWorld.extractBasis(_r, _u, _b);
      uSunL.value.set(sunDir.dot(_r), sunDir.dot(_u), sunDir.dot(_b)).normalize();
      uSun.value.copy(sunColor);
      uAmb.value.copy(ambient);
    },
    /**
     * Per frame, an AXIAL card: its X runs along `axis` (the stream: nozzle → aim) and it turns
     * about that line to face the camera, its Y toward the sky; the book's nozzle point
     * (`meta.anchor`, card uv) sits on `nozzle`. `reach` 0..1 grows the stream out of the
     * nozzle. Returns how side-on the stream is to the camera (1 side-on … 0 end-on): a flat
     * card collapses to a line end-on, so the caller fades it (and draws something else).
     */
    updateAxial({ age, camera, nozzle, axis, anchor, size, reach = 1, sunDir, sunColor, ambient }) {
      uAge.value = age;
      uReach.value = reach;
      uFadeL.value = 0;
      uAnchorU.value = anchor[0];
      _r.copy(axis).normalize();
      _b.setFromMatrixPosition(camera.matrixWorld).sub(nozzle);
      const dist = _b.length();
      _b.addScaledVector(_r, -_b.dot(_r));                  // toward the camera, square to the stream
      const side = dist > 1e-6 ? _b.length() / dist : 0;
      if (_b.lengthSq() < 1e-8) _b.set(0, 1, 0).addScaledVector(_r, -_r.y);
      _b.normalize();
      _u.crossVectors(_b, _r);
      // Keep the book's up (its smoke rises) toward the sky: mirror the card if Y points down.
      const flip = _u.y < 0 ? -1 : 1;
      _u.multiplyScalar(flip);
      // The rotation takes the right-handed frame (Y unflipped); the mirror is the scale.
      mesh.quaternion.setFromRotationMatrix(_m.makeBasis(_r, _y.copy(_u).multiplyScalar(flip), _b));
      mesh.scale.set(size, size * flip, size);
      mesh.position.copy(nozzle)
        .addScaledVector(_r, (0.5 - anchor[0]) * size)
        .addScaledVector(_u, (0.5 - anchor[1]) * size);
      uSunL.value.set(sunDir.dot(_r), sunDir.dot(_u), sunDir.dot(_b)).normalize();
      uSun.value.copy(sunColor);
      uAmb.value.copy(ambient);
      return side;
    },
  };
}
