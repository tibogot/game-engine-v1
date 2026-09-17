/**
 * Susuki (miscanthus / pampas) field — the Ghost-of-Tsushima silver plumes,
 * proven in v3/susuki-lab.html.
 *
 * All the placement machinery (camera-following wrap tile, ONE compute pass for
 * paint, slope, fade, frustum cull, wind and player push, indirect draws) is the
 * shared scatter field: v3/render/scatter/scatterField.js, the same one flowers
 * and foliage use. This file is only what a susuki plant IS: its geometry, its
 * two materials and its plume texture.
 *
 * Each instance is a TUSSOCK: `tufts` stems + plumes with baked offsets,
 * per-tuft height variation and phase (aTuft vec4 attribute).
 *
 * Bending is a WORLD-SPACE vector (the field's bufDir), not a per-plant yaw:
 * wind pushes every plant the same downwind way — coherent with the grass,
 * which shares the same windTex + grassState wind params — and the player
 * push adds into the same vector, so plumes part radially around you. The
 * resting lean is added downwind in the vertex shader.
 *
 * Two PARTS of one draw: stems (crossed thin ribbons, opaque) + plumes (crossed
 * cards, alpha-tested procedural strand texture, backlit silver-lining
 * emissive). Both read the same compact list, so they always agree.
 */
import * as THREE from "three";
import {
  Fn,
  atan,
  attribute,
  cameraPosition,
  cos,
  dot,
  float,
  hash,
  instanceIndex,
  length,
  max,
  mix,
  negate,
  normalize,
  normalLocal,
  positionLocal,
  pow,
  sin,
  smoothstep,
  texture,
  time,
  uniform,
  uv,
  varying,
  vec2,
  vec3,
} from "three/tsl";
import { createBladeGeometry } from "../../../v2/core/foliage/grassGemini.js";
import { ScatterField } from "../scatter/scatterField.js";
import { terrainShade, terrainSunVisibilityHere } from "../lighting/terrainSunShadow.js";

function srgb(hex) {
  return new THREE.Color(hex);
}

export const SUSUKI_DEFAULTS = {
  density: 1,
  tufts: 1,              // stems per painted plant (optional bunching)
  plumesPerFlower: 5,    // plumes in the flower head atop each stem
  flowerSpread: 65,      // fan half-angle (deg) of the flower head
  stemHeight: 1.9,
  stemHeightVar: 0.26,   // ± fraction of stemHeight
  stemWidth: 0.03,
  stemFlex: 0.45,
  lean: 0.08,
  stemBase: "#2c4018",
  stemTip: "#6f7a40",
  plumeSize: 1.1,
  plumeWidth: 0.48,
  plumeHeight: 1.2,
  plumeDroop: 0.55,
  plumeBase: "#d0c8b2",
  plumeTip: "#f7f4ea",
  plumeAO: 0.62,
  plumeGlow: 0.2,
  backlitIntensity: 1.7,
  backlitPower: 6,
  flutter: 0.05,
  alphaTest: 0.2,
  windMul: 1,
  interactRadius: 2.2,   // player/horse push radius (m)
  interactStrength: 1.2,
  castShadows: true,     // near the camera only, like the tall foliage
  shadowDistance: 35,
  fadeStart: 150,        // radial plume fade-out window (m from camera)
  fadeEnd: 195,
  slopeMinY: 0.55,       // terrain normal.y below which susuki stops growing
  texStrands: 460,
  texSpread: 52,
  texStrandLen: 0.33,
  texDroop: 0.6,
};

// ── Plume strand texture (canvas) ────────────────────────────────────────────
// Hundreds of fine arcing white strokes fanning up-and-out from a central
// spine, a blurred low-alpha pass underneath for volume, bright dots for seed
// sparkle. Drawn white — tint / AO / backlight happen in the shader off the
// alpha channel only. Deterministic seed so redraws with equal params match.
const PLUME_TEX_W = 256;
const PLUME_TEX_H = 512;

export function drawPlumeTexture(canvas, sp) {
  let seed = 12345;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
  const W = PLUME_TEX_W, H = PLUME_TEX_H;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, W, H);
  ctx.lineCap = "round";
  const cx = W / 2;
  const spreadRad = ((sp.texSpread ?? 52) * Math.PI) / 180;
  const strands = sp.texStrands ?? 460;

  const strand = (soft) => {
    const t = Math.pow(rand(), 0.8);              // 0 base → 1 top of spine
    let x = cx + (rand() - 0.5) * 10;
    let y = H * (1 - 0.05 - t * 0.88);
    const side = rand() < 0.5 ? -1 : 1;
    let theta = -Math.PI / 2 + side * spreadRad * (0.2 + 0.8 * rand());
    const len = H * (sp.texStrandLen ?? 0.33) *
      (0.3 + 0.7 * Math.sin(Math.min(t * 1.2, 1) * Math.PI));
    const segs = 8, stepLen = len / segs;
    const curl = side * (0.04 + rand() * 0.07);
    const droop = (sp.texDroop ?? 0.6) * 0.05;
    let alpha = soft ? 0.07 + rand() * 0.07 : 0.35 + rand() * 0.55;
    let lw = soft ? 6 + rand() * 9 : 0.9 + rand() * 1.5;
    for (let k = 0; k < segs; k++) {
      const nx = x + Math.cos(theta) * stepLen * 0.6;
      const ny = y + Math.sin(theta) * stepLen;
      ctx.strokeStyle = `rgba(255,255,255,${alpha.toFixed(3)})`;
      ctx.lineWidth = lw;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(nx, ny); ctx.stroke();
      x = nx; y = ny;
      theta += curl + droop;
      alpha *= soft ? 0.85 : 0.78;
      lw *= 0.9;
    }
    return { x, y };
  };

  for (let i = 0; i < strands * 0.2; i++) strand(true);   // soft volume pass
  const tips = [];
  for (let i = 0; i < strands; i++) tips.push(strand(false));
  for (let i = 0; i < strands * 0.6; i++) {               // seed sparkle
    const tip = tips[(rand() * tips.length) | 0];
    const a = 0.4 + rand() * 0.5;
    ctx.fillStyle = `rgba(255,255,255,${a.toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(tip.x + (rand() - 0.5) * 14, tip.y + (rand() - 0.5) * 14,
            0.5 + rand() * 0.9, 0, Math.PI * 2);
    ctx.fill();
  }
}

// ── Tussock layout (shared by stem + plume geometry so they line up) ─────────
function tuftLayout(count) {
  let seed = 777;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
  const tufts = [];
  for (let i = 0; i < count; i++) {
    // golden-angle spiral: first tuft at the center, rest spread outward
    const r = i === 0 ? 0 : 0.14 + 0.3 * Math.sqrt(i / count);
    const a = i * 2.39996;
    tufts.push({
      ox: Math.cos(a) * r,
      oz: Math.sin(a) * r,
      hMul: 0.82 + rand() * 0.33,   // per-tuft height variation
      phase: rand(),                // per-tuft flutter phase
      yaw: rand() * Math.PI * 2,    // cosmetic ribbon/card rotation
    });
  }
  return tufts;
}

/** Per-vertex vec4 aTuft = (offsetX, offsetZ, heightMul, phase). */
function addTuftAttr(positions, count, t) {
  const arr = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    arr[i * 4] = t.ox; arr[i * 4 + 1] = t.oz;
    arr[i * 4 + 2] = t.hMul; arr[i * 4 + 3] = t.phase;
  }
  return arr;
}

// ── Geometry ─────────────────────────────────────────────────────────────────

/**
 * Stem cluster: `tufts` crossed thin ribbons, each pre-rotated by its own
 * cosmetic yaw and carrying its tuft offset/height/phase in aTuft. Ribbons
 * are built around the origin — the VS adds the offset AFTER bending so each
 * stem bends around its own base.
 */
export function createStemGeometry(width, tufts = 5) {
  const base = createBladeGeometry(1.0, width, 4, 0.9);
  const srcPos = base.attributes.position.array;
  const srcUv = base.attributes.uv.array;
  const srcIdx = base.index.array;
  const n = base.attributes.position.count;
  const layout = tuftLayout(tufts);

  const positions = [], uvs = [], normals = [], tuftArr = [], indices = [];
  let vertBase = 0;
  for (const t of layout) {
    // crossed ribbon = the blade + a copy pre-rotated 90°, both then rotated
    // by the tuft's cosmetic yaw (bend direction comes from the VS, in world
    // space, so this rotation is purely visual variety)
    const ca = Math.cos(t.yaw), sa = Math.sin(t.yaw);
    for (let i = 0; i < n; i++) {
      const x = srcPos[i * 3], z = srcPos[i * 3 + 2];
      positions.push(x * ca + z * sa, srcPos[i * 3 + 1], -x * sa + z * ca);
      uvs.push(srcUv[i * 2], srcUv[i * 2 + 1]);
      normals.push(0, 1, 0);
    }
    for (let i = 0; i < n; i++) {
      const x = srcPos[i * 3 + 2], z = -srcPos[i * 3]; // 90° cross
      positions.push(x * ca + z * sa, srcPos[i * 3 + 1], -x * sa + z * ca);
      uvs.push(srcUv[i * 2], srcUv[i * 2 + 1]);
      normals.push(0, 1, 0);
    }
    for (let i = 0; i < srcIdx.length; i++) indices.push(vertBase + srcIdx[i]);
    for (let i = 0; i < srcIdx.length; i++) indices.push(vertBase + n + srcIdx[i]);
    for (let i = 0; i < n * 2; i++) tuftArr.push(t.ox, t.oz, t.hMul, t.phase);
    vertBase += n * 2;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(positions), 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(uvs), 2));
  geo.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(normals), 3));
  geo.setAttribute("aTuft", new THREE.BufferAttribute(new Float32Array(tuftArr), 4));
  geo.setIndex(indices);
  base.dispose();
  return geo;
}

/**
 * Flower head: per stem, `plumesPerFlower` plumes ALL JOINED AT THE ORIGIN
 * (the stem tip) and fanning out around local +X — a feather spray, like the
 * real miscanthus flower (the GoT reference shows ~5 plumes per head).
 * Each plume is 2 crossed cards drooping along its own fan direction, with
 * per-plume length/droop variation. The VS rotates the whole head so +X
 * points DOWNWIND, so the fan spreads around the wind direction.
 */
export function createPlumeGeometry(sp, tufts = 1) {
  const W = sp.plumeWidth, H = sp.plumeHeight, droop = sp.plumeDroop;
  const plumes = Math.max(1, Math.round(sp.plumesPerFlower ?? 5));
  const spreadRad = ((sp.flowerSpread ?? 65) * Math.PI) / 180;
  const crossAngles = [0, Math.PI / 2];
  const ws = 2, hs = 6;
  const layout = tuftLayout(tufts);
  const positions = [], uvs = [], normals = [], tuftArr = [], indices = [];
  let vertBase = 0;

  // deterministic per-plume jitter
  let seed = 4242;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };

  for (const t of layout) {
    for (let k = 0; k < plumes; k++) {
      // fan angles centered on +X (downwind after the VS rotation)
      const fk = plumes === 1 ? 0 : (k / (plumes - 1)) * 2 - 1; // -1..1
      const yawK = fk * spreadRad + (rand() - 0.5) * 0.25;
      const lenMul = 0.82 + rand() * 0.28;
      const droopMul = 0.85 + rand() * 0.4 + Math.abs(fk) * 0.25; // outer droop more
      const cy = Math.cos(yawK), sy = Math.sin(yawK);

      for (const a of crossAngles) {
        const ca = Math.cos(a), sa = Math.sin(a);
        for (let j = 0; j <= hs; j++) {
          const v = j / hs;
          const y = v * H * lenMul;
          const arc = droop * droopMul * H * lenMul * v * v;
          for (let i = 0; i <= ws; i++) {
            const u01 = i / ws;
            const x0 = (u01 - 0.5) * W * 0.85; // slightly narrower per plume
            // card in plume-local space (droop along +X), then fan-rotate
            const px = x0 * ca + arc;
            const pz = -x0 * sa;
            positions.push(px * cy + pz * sy, y, -px * sy + pz * cy);
            uvs.push(u01, v);
            normals.push(sa, 0, ca);
            tuftArr.push(t.ox, t.oz, t.hMul, t.phase + k * 0.13);
          }
        }
        for (let j = 0; j < hs; j++) {
          for (let i = 0; i < ws; i++) {
            const r0 = vertBase + j * (ws + 1) + i, r1 = r0 + ws + 1;
            indices.push(r0, r1, r0 + 1, r0 + 1, r1, r1 + 1);
          }
        }
        vertBase += (hs + 1) * (ws + 1);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(positions), 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(uvs), 2));
  geo.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(normals), 3));
  geo.setAttribute("aTuft", new THREE.BufferAttribute(new Float32Array(tuftArr), 4));
  geo.setIndex(indices);
  return geo;
}

// ── System ───────────────────────────────────────────────────────────────────

// The field's wind is (wave + gust + micro) × strength × flex × 0.3; susuki was
// tuned against × stemFlex × 0.35, so its flex is scaled to match.
const SUSUKI_FLEX_TO_FIELD = 0.35 / 0.3;

export class SusukiSystem {
  /**
   * @param {object} opts
   *   scene, renderer        — three
   *   heightTex              — RGBA float, .x = terrain world Y (grassHeightTex)
   *   terrainNormalTex       — RGBA float, .xyz = terrain normal
   *   densityTex             — painted susuki density (.x)
   *   windTex                — v2 createWindTexture() output (shared with grass)
   *   worldSize              — terrain world size (m)
   *   sp                     — susuki state (SUSUKI_DEFAULTS shape)
   *   gp                     — grassState (wind params shared with the grass)
   *   tileSize, plantsPerSide — wrap-tile config (default 400 / 288 ≈ 83k)
   */
  constructor({
    scene,
    renderer,
    heightTex,
    terrainNormalTex,
    densityTex,
    windTex,
    worldSize,
    sp,
    gp,
    tileSize = 400,
    plantsPerSide = 288,
  }) {
    this.renderer = renderer;
    this.tileSize = tileSize;
    this._tufts = Math.max(1, Math.round(sp.tufts ?? 5));

    const u = (this.u = {
      uSunDir: uniform(new THREE.Vector3(0.5, 0.8, 0.3).normalize()),
      // plant
      uStemH: uniform(sp.stemHeight ?? 1.9),
      uStemHVar: uniform(sp.stemHeightVar ?? 0.26),
      uLean: uniform(sp.lean ?? 0.08),
      uStemBase: uniform(srgb(sp.stemBase ?? "#2c4018")),
      uStemTip: uniform(srgb(sp.stemTip ?? "#6f7a40")),
      // plume
      uPlumeSize: uniform(sp.plumeSize ?? 1.1),
      uPlumeBase: uniform(srgb(sp.plumeBase ?? "#d0c8b2")),
      uPlumeTip: uniform(srgb(sp.plumeTip ?? "#f7f4ea")),
      uPlumeAO: uniform(sp.plumeAO ?? 0.62),
      uPlumeGlow: uniform(sp.plumeGlow ?? 0.2),
      uBacklitInt: uniform(sp.backlitIntensity ?? 1.7),
      uBacklitPow: uniform(sp.backlitPower ?? 6),
      uFlutter: uniform(sp.flutter ?? 0.05),
    });

    const field = (this.field = new ScatterField({
      scene, renderer, name: "Susuki",
      typeCount: 1, lods: 1, parts: 2, rows: 1, ruleRow: null,
      worldSize, tileSize, plantsPerSide,
      heightTex, terrainNormalTex, densityTex, splatTex: null, windTex,
      // The tallest tussock's reach, so a plume leaning into view is kept.
      cullRadius: u.uStemH.mul(u.uStemHVar.add(1)).add(u.uPlumeSize.mul(1.6)).add(0.5),
      // Thin out across the whole fade window, and a softer slope edge — both
      // as the susuki was tuned before it moved onto the shared field.
      fadeKeepGain: 1,
      slopeBand: 0.15,
      shadows: true,
    }));
    this.group = field.group;
    this.count = field.count;
    const fu = field.u;
    fu.uCullPadNdcX.value = 0.45;
    fu.uCullPadNdcYNear.value = 0.75;
    fu.uCullPadNdcYFar.value = 0.45;
    fu.uClumping.value = 0;   // susuki has no clump noise
    const { bufPos, bufDir, compactBuf } = field.nodes;

    // ── Plume strand texture ──
    this._plumeCanvas = document.createElement("canvas");
    this._plumeCanvas.width = PLUME_TEX_W;
    this._plumeCanvas.height = PLUME_TEX_H;
    drawPlumeTexture(this._plumeCanvas, sp);
    this.plumeTex = new THREE.CanvasTexture(this._plumeCanvas);
    this.plumeTex.colorSpace = THREE.SRGBColorSpace;
    this.plumeTex.anisotropy = 8;

    // Per-plant stem height, from the plant's id.
    const stemHOf = (id) =>
      u.uStemH.mul(
        mix(float(1).sub(u.uStemHVar), float(1).add(u.uStemHVar), hash(id.add(911))),
      );
    // The field's bend vector plus the resting lean, downwind.
    const bendOf = (d) => vec2(
      d.x.add(fu.uWindDir.x.mul(u.uLean)),
      d.y.add(fu.uWindDir.y.mul(u.uLean)),
    );

    // ── Materials ──
    // — stems —
    const stemMat = new THREE.MeshStandardNodeMaterial({
      side: THREE.DoubleSide,
      roughness: 0.9,
      metalness: 0,
    });
    stemMat.envMapIntensity = 0;
    stemMat.positionNode = Fn(() => {
      const id = compactBuf.element(instanceIndex);
      const p = bufPos.element(id);
      const bend = bendOf(bufDir.element(id));
      const tuft = attribute("aTuft", "vec4");
      const h = uv().y;
      const stemH = stemHOf(id).mul(tuft.z);

      const mag = length(bend);
      const invMag = float(1).div(max(mag, float(1e-4)));
      const bendX = bend.x.mul(invMag);
      const bendZ = bend.y.mul(invMag);

      const angle = mag.mul(pow(max(h, 1e-4), 1.6)); // bend high up only
      const L = h.mul(stemH);
      const horiz = sin(angle).mul(L);
      normalLocal.assign(vec3(0, 1, 0));
      return vec3(
        positionLocal.x.add(horiz.mul(bendX)).add(tuft.x).add(p.x),
        cos(angle).mul(L).add(p.w),
        positionLocal.z.add(horiz.mul(bendZ)).add(tuft.y).add(p.y),
      );
    })();
    // Mountain shade: susuki receives no shadows, so darken it in the shade.
    stemMat.colorNode = terrainShade(mix(u.uStemBase, u.uStemTip, pow(uv().y, 1.4)));

    // — plumes —
    const plumeMat = new THREE.MeshStandardNodeMaterial({
      side: THREE.DoubleSide,
      roughness: 1,
      metalness: 0,
      alphaTest: sp.alphaTest ?? 0.2,
      alphaToCoverage: true,
    });
    plumeMat.envMapIntensity = 0;
    const vPWorld = varying(vec3(0), "v_su_w");
    const vPHue = varying(float(0), "v_su_hue");

    const rotY = (ang, v) => {
      const cc = cos(ang);
      const ss = sin(ang);
      return vec3(
        v.x.mul(cc).add(v.z.mul(ss)),
        v.y,
        negate(v.x).mul(ss).add(v.z.mul(cc)),
      );
    };

    plumeMat.positionNode = Fn(() => {
      const id = compactBuf.element(instanceIndex);
      const p = bufPos.element(id);
      const bend = bendOf(bufDir.element(id));
      const tuft = attribute("aTuft", "vec4");
      const stemH = stemHOf(id).mul(tuft.z);
      const scale = mix(float(0.8), float(1.2), hash(id.add(577))).mul(u.uPlumeSize);

      const mag = length(bend);
      const invMag = float(1).div(max(mag, float(1e-4)));
      const bendX = bend.x.mul(invMag);
      const bendZ = bend.y.mul(invMag);
      // rotY(a, (1,0,0)) = (cos a, 0, -sin a) → a = atan2(-z, x) points the
      // plume's droop (+X) along the bend/wind direction — the whole field
      // leans the same way, and parts around the player with the push vector.
      // Small per-tuft jitter keeps it organic.
      const yawA = atan(negate(bendZ), bendX)
        .add(tuft.w.sub(0.5).mul(0.5));

      // ride the stem tip: rotate the plume by the tip angle (≈ mag at h=1)
      // in the bend plane, then translate to the arc tip
      const local = positionLocal.mul(scale);
      const ca = cos(mag), sa = sin(mag);
      const bent = vec3(
        local.x.mul(ca).add(local.y.mul(sa)),
        local.y.mul(ca).sub(local.x.mul(sa)),
        local.z,
      );
      const tip = vec3(sin(mag).mul(stemH), cos(mag).mul(stemH), 0);
      const fl = sin(time.mul(5.2).add(tuft.w.mul(37)).add(positionLocal.y.mul(2.5)))
        .mul(u.uFlutter).mul(uv().y.add(0.15));
      const pR = rotY(yawA, bent.add(tip).add(vec3(fl, 0, fl.mul(0.6))));
      normalLocal.assign(vec3(0, 1, 0)); // soft top-lit fluff
      const out = vec3(
        pR.x.add(tuft.x).add(p.x),
        pR.y.add(p.w),
        pR.z.add(tuft.y).add(p.y),
      );
      vPWorld.assign(out.add(vec3(fu.uAnchorPos.x, 0, fu.uAnchorPos.z)));
      vPHue.assign(hash(id.add(3197)));
      return out;
    })();

    const plumeSample = texture(this.plumeTex, uv());
    plumeMat.opacityNode = plumeSample.a;
    // The shadow pass ignores opacityNode and alphaTest: without this every
    // plume card casts a solid rectangle.
    const uShadowAlpha = uniform(sp.alphaTest ?? 0.2);
    this._uShadowAlpha = uShadowAlpha;
    plumeMat.maskShadowNode = plumeSample.a.greaterThan(uShadowAlpha);
    const plumeSunVis = terrainSunVisibilityHere();
    plumeMat.colorNode = terrainShade(Fn(() => {
      const v = uv().y;
      const col = mix(u.uPlumeBase, u.uPlumeTip, smoothstep(0.1, 0.85, v));
      const warm = mix(col, col.mul(vec3(1.07, 1.0, 0.88)), vPHue); // straw tint
      // dense strand cores brighter than the fringe → soft interior depth
      const strandShade = mix(float(0.8), float(1), plumeSample.a);
      return warm.mul(strandShade).mul(mix(u.uPlumeAO, float(1), smoothstep(0.0, 0.5, v)));
    })(), plumeSunVis);
    plumeMat.emissiveNode = Fn(() => {
      const viewDir = normalize(cameraPosition.sub(vPWorld));
      // silver lining: light traveling -sunDir continues into the camera
      const backlit = pow(max(dot(viewDir, negate(u.uSunDir)), 0), u.uBacklitPow)
        .mul(u.uBacklitInt).mul(plumeSunVis);
      const col = mix(u.uPlumeBase, u.uPlumeTip, uv().y);
      return col.mul(backlit.add(u.uPlumeGlow));
    })();
    this._plumeMat = plumeMat;

    field.attachMaterial([stemMat, plumeMat]);
    field.rebuildType(0, (lod, part, o) => this._makePart(part, sp, o));
    this.syncFromState(sp, gp);
  }

  get meshes() { return this.field.meshes; }
  get stemMesh() { return this.field.meshes[0]; }
  get plumeMesh() { return this.field.meshes[1]; }

  _makePart(part, sp, { shadow = false } = {}) {
    // The shadow's plume head keeps two of its plumes: the spray's outline
    // on the ground reads the same, and the alpha-tested cards are what the
    // shadow pass pays for.
    const geometry = part === 0
      ? createStemGeometry(sp.stemWidth ?? 0.03, this._tufts)
      : createPlumeGeometry(shadow ? { ...sp, plumesPerFlower: Math.min(2, sp.plumesPerFlower ?? 5) } : sp, this._tufts);
    return { geometry, triangles: geometry.index.count / 3 };
  }

  init(camera) { return this.field.init(camera); }
  setEnabled(on) { this.field.setEnabled(on); }
  update(anchorPos, camera) { this.field.update(anchorPos, camera); }
  /** Near cascade cameras the shadow list draws into — see ScatterField.setShadowCameras. */
  setShadowCameras(cams) { this.field.setShadowCameras(cams); }

  /** Redraw the plume strand texture after texStrands/texSpread/... changes. */
  redrawPlumeTexture(sp) {
    drawPlumeTexture(this._plumeCanvas, sp);
    this.plumeTex.needsUpdate = true;
  }

  /** Swap plume geometry (plumeWidth/Height/Droop + tufts are baked). */
  rebuildPlumeGeometry(sp) {
    this._tufts = Math.max(1, Math.round(sp.tufts ?? this._tufts));
    this.field.rebuildType(0, (lod, part, o) => this._makePart(part, sp, o), [1]);
  }

  /** Swap stem geometry (stemWidth + tufts are baked). */
  rebuildStemGeometry(sp) {
    this._tufts = Math.max(1, Math.round(sp.tufts ?? this._tufts));
    this.field.rebuildType(0, (lod, part, o) => this._makePart(part, sp, o), [0]);
  }

  /** Live sync — sp = susuki state, gp = grassState (shared wind), sunDir. */
  syncFromState(sp, gp, sunDir) {
    this.field.syncCommon({
      wind: gp ? { ...gp, windMul: sp.windMul ?? 1 } : null,
      density: sp.density ?? 1,
      flex: (sp.stemFlex ?? 0.45) * SUSUKI_FLEX_TO_FIELD,
      interactRadius: sp.interactRadius ?? 2.2,
      interactStrength: sp.interactStrength ?? 1.2,
      fadeStart: sp.fadeStart ?? 150,
      fadeEnd: sp.fadeEnd ?? 195,
      slopeMinY: sp.slopeMinY ?? 0.55,
    });
    const u = this.u;
    u.uStemH.value = sp.stemHeight ?? 1.9;
    u.uStemHVar.value = sp.stemHeightVar ?? 0.26;
    u.uLean.value = sp.lean ?? 0.08;
    u.uStemBase.value.copy(srgb(sp.stemBase ?? "#2c4018"));
    u.uStemTip.value.copy(srgb(sp.stemTip ?? "#6f7a40"));
    u.uPlumeSize.value = sp.plumeSize ?? 1.1;
    u.uPlumeBase.value.copy(srgb(sp.plumeBase ?? "#d0c8b2"));
    u.uPlumeTip.value.copy(srgb(sp.plumeTip ?? "#f7f4ea"));
    u.uPlumeAO.value = sp.plumeAO ?? 0.62;
    u.uPlumeGlow.value = sp.plumeGlow ?? 0.2;
    u.uBacklitInt.value = sp.backlitIntensity ?? 1.7;
    u.uBacklitPow.value = sp.backlitPower ?? 6;
    u.uFlutter.value = sp.flutter ?? 0.05;
    this.field.setShadowCasters([sp.castShadows !== false], sp.shadowDistance ?? 35);
    this._uShadowAlpha.value = sp.alphaTest ?? 0.2;
    if (this._plumeMat.alphaTest !== (sp.alphaTest ?? 0.2)) {
      this._plumeMat.alphaTest = sp.alphaTest ?? 0.2;
      this._plumeMat.needsUpdate = true;
    }
    if (sunDir) u.uSunDir.value.copy(sunDir);
  }
}
