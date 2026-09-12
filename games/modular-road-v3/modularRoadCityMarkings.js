// ── ROAD MARKINGS ────────────────────────────────────────────────────────────
//
// Paint on the road, as instanced quads off one atlas. One draw for every
// marking anywhere in the city, however many there are.
//
// ── WHY NOT IN THE SHADER, LIKE EVERY OTHER MARKING HERE ─────────────────────
//
// The city street draws its own arrows, bays and hatching ANALYTICALLY, in TSL,
// and that is the right answer for them: they are made of rectangles, the
// street is one material, and a rectangle costs a few instructions.
//
// It stops being the right answer twice over.
//
// TEXT IS NOT RECTANGLES. SORTIE, BUS, STOP — a glyph as closed-form geometry
// is enormous, and the street's fragment stage is already 117 kB feeding the
// compile that IS this game's load time (see modularRoadCityFacade.js). A
// canvas draws the same letters once, at build time, for nothing.
//
// AND THE VIADUCT IS NOT THE STREET. Its deck is the game's ROAD material,
// shared with the whole track, so a marking added there would appear on every
// race circuit in the game. The deck can only be painted from above.
//
// ── THE ATLAS IS DRAWN, NOT LOADED ───────────────────────────────────────────
//
// Same as the gantry and sign atlases: authored here, in code, so there is
// nothing to ship, nothing to wait for, and no 404 to design around.
//
// ── CUTOUT, NOT BLENDED ──────────────────────────────────────────────────────
//
// `alphaTest`, so these stay in the OPAQUE pass. Road paint is very nearly a
// binary mask anyway, and the alternative is worse than it looks: a transparent
// surface in this renderer's MRT setup erases the emissive attachment under it
// (see the note in v3/render/bloomMRT.js), and transparent quads lying on a
// road also have to be sorted against each other every frame.

import * as THREE from "three";
import {
  Fn, attribute, texture, uv, vec2, floor, float, uniform, mix, positionWorld,
} from "three/tsl";
import { shareInstancePipeline } from "../../v3/render/instancePipeline.js";

export const MARKING_DEFAULTS = {
  /** Atlas tile edge, pixels. Paint has no fine detail; legibility is all. */
  px: 256,
  /** Cols and rows of the atlas. Sixteen slots is far more than this needs. */
  cols: 4,
  rows: 4,
  /** How far above the road the quads sit. Enough to win the depth test at a
   *  distance, small enough that nothing can drive under one. */
  lift: 0.02,
  paint: "#e9ecef",
  paintWorn: 0.22,
};

/**
 * THE SLOTS. Index into the atlas, left to right and BOTTOM to top — the same
 * order the gantry and sign atlases use, because UV row 0 is the canvas bottom
 * and every one of these that has been authored the other way up shipped
 * upside-down text that nobody noticed for a week.
 */
export const MARK = {
  arrowStraight: 0,
  arrowDiverge: 1,
  arrowLeft: 2,
  arrowRight: 3,
  sortie: 4,
  bus: 5,
  stop: 6,
  slow: 7,
  chevron: 8,
  bike: 9,
  taxi: 10,
  school: 11,
};

/** Longest side of each slot's shape, as a fraction of the tile. Text is drawn
 *  stretched — road lettering is two or three times as tall as it is wide,
 *  because it is read at a glancing angle from a metre off the ground. */
const TEXT = {
  [MARK.sortie]: "SORTIE",
  [MARK.bus]: "BUS",
  [MARK.stop]: "STOP",
  [MARK.slow]: "RALENTIR",
  [MARK.taxi]: "TAXI",
  [MARK.school]: "ÉCOLE",
};

function paintArrow(ctx, w, h, kind) {
  const cx = w / 2;
  ctx.beginPath();
  const shaftW = w * 0.16;
  const headW = w * 0.42;
  const headH = h * 0.26;
  if (kind === MARK.arrowStraight || kind === MARK.arrowDiverge) {
    // Shaft from the bottom to the head.
    ctx.rect(cx - shaftW / 2, h * 0.30, shaftW, h * 0.52);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(cx, h * 0.08);
    ctx.lineTo(cx - headW / 2, h * 0.08 + headH);
    ctx.lineTo(cx + headW / 2, h * 0.08 + headH);
    ctx.closePath();
    ctx.fill();
  }
  if (kind === MARK.arrowDiverge || kind === MARK.arrowRight || kind === MARK.arrowLeft) {
    // A branch peeling off toward one side, which is the whole point of the
    // diverge slot: it says "this lane leaves" rather than "turn right here".
    const s = kind === MARK.arrowLeft ? -1 : 1;
    const bx = cx + s * w * 0.30;
    ctx.beginPath();
    ctx.moveTo(cx - s * shaftW * 0.2, h * 0.72);
    ctx.quadraticCurveTo(cx + s * w * 0.16, h * 0.52, bx, h * 0.34);
    ctx.lineWidth = shaftW;
    ctx.strokeStyle = ctx.fillStyle;
    ctx.lineCap = "butt";
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(bx + s * w * 0.06, h * 0.16);
    ctx.lineTo(bx - s * headW * 0.42, h * 0.30);
    ctx.lineTo(bx + s * headW * 0.30, h * 0.42);
    ctx.closePath();
    ctx.fill();
  }
}

function paintChevron(ctx, w, h) {
  ctx.lineWidth = w * 0.11;
  ctx.strokeStyle = ctx.fillStyle;
  for (let i = 0; i < 3; i++) {
    const y = h * (0.22 + i * 0.28);
    ctx.beginPath();
    ctx.moveTo(w * 0.12, y + h * 0.16);
    ctx.lineTo(w * 0.5, y);
    ctx.lineTo(w * 0.88, y + h * 0.16);
    ctx.stroke();
  }
}

function paintBike(ctx, w, h) {
  ctx.lineWidth = w * 0.06;
  ctx.strokeStyle = ctx.fillStyle;
  const r = w * 0.16;
  for (const cx of [w * 0.26, w * 0.74]) {
    ctx.beginPath();
    ctx.arc(cx, h * 0.68, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.moveTo(w * 0.26, h * 0.68);
  ctx.lineTo(w * 0.44, h * 0.40);
  ctx.lineTo(w * 0.68, h * 0.40);
  ctx.lineTo(w * 0.74, h * 0.68);
  ctx.moveTo(w * 0.44, h * 0.40);
  ctx.lineTo(w * 0.56, h * 0.68);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(w * 0.60, h * 0.34);
  ctx.lineTo(w * 0.78, h * 0.34);
  ctx.stroke();
}

/**
 * Draw the atlas.
 *
 * Headless (the tests, a bake) there is no canvas, so this hands back a 1x1
 * white texture — the same fallback the gantry atlas uses. Everything that
 * reads it keeps working; the paint is simply a solid block.
 */
export function makeMarkingAtlas(params = {}) {
  const M = { ...MARKING_DEFAULTS, ...params };
  if (typeof document === "undefined") {
    const t = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, THREE.RGBAFormat);
    t.needsUpdate = true;
    return { texture: t, cols: M.cols, rows: M.rows };
  }
  const canvas = document.createElement("canvas");
  canvas.width = M.px * M.cols;
  canvas.height = M.px * M.rows;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  for (const slot of Object.values(MARK)) {
    const col = slot % M.cols;
    // UV row 0 is the canvas BOTTOM row — see the note on MARK.
    const row = M.rows - 1 - Math.floor(slot / M.cols);
    ctx.save();
    ctx.translate(col * M.px, row * M.px);
    ctx.beginPath();
    ctx.rect(0, 0, M.px, M.px);
    ctx.clip();
    ctx.fillStyle = M.paint;
    const w = M.px, h = M.px;
    if (TEXT[slot]) {
      /*
       * STRETCHED, and it is not a stylistic choice. Road lettering is two or
       * three times as tall as it is wide because it is read at a glancing
       * angle from a metre off the ground — set at normal proportions it
       * foreshortens into an unreadable smear, which is precisely what it
       * looks like in a game that has not thought about it.
       */
      const txt = TEXT[slot];
      ctx.font = `700 ${Math.round(h * 0.34)}px Oxanium, Arial, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.save();
      ctx.translate(w / 2, h / 2);
      ctx.scale(Math.min(1, 5.2 / Math.max(3, txt.length)), 2.35);
      ctx.fillText(txt, 0, 0);
      ctx.restore();
    } else if (slot === MARK.chevron) {
      paintChevron(ctx, w, h);
    } else if (slot === MARK.bike) {
      paintBike(ctx, w, h);
    } else {
      paintArrow(ctx, w, h, slot);
    }
    ctx.restore();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.name = "CityMarkings";
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return { texture: tex, cols: M.cols, rows: M.rows };
}

/**
 * Lay markings on the road.
 *
 * @param {object} opts
 * @param {{x,y,z,yaw,w,h,tile}[]} opts.marks  world placements. `yaw` turns the
 *   quad about Y; the shape's "forward" is +Z, i.e. the way traffic reads it.
 * @returns {null | {mesh, stats, dispose}}
 */
export function createRoadMarkings({
  marks = [], params = {}, atlas = null,
  /** Whose paint this is. The module is shared, so the OWNER names the mesh —
   *  "CityMarkings" in a GPU capture tells you nothing about which road. */
  name = "CityMarkings",
} = {}) {
  if (!marks.length) return null;
  const M = { ...MARKING_DEFAULTS, ...params };
  const A = atlas || makeMarkingAtlas(M);

  const geo = new THREE.PlaneGeometry(1, 1);
  geo.rotateX(-Math.PI / 2);
  const tile = new Float32Array(marks.length);
  for (let i = 0; i < marks.length; i++) tile[i] = marks[i].tile ?? 0;
  geo.setAttribute("aTile", new THREE.InstancedBufferAttribute(tile, 1));

  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.92, metalness: 0.0 });
  mat.name = "CityMarkings";
  // Cutout, not blended — see the header.
  mat.alphaTest = 0.5;
  mat.polygonOffset = true;
  mat.polygonOffsetFactor = -2;
  mat.polygonOffsetUnits = -2;

  const uCols = uniform(A.cols), uRows = uniform(A.rows);
  const uWorn = uniform(M.paintWorn);

  /** The tile's UV window. */
  const tileUV = Fn(() => {
    /*
     * ROUNDED, and it has to be. An instanced attribute read in the FRAGMENT
     * stage is an interpolated VARYING, not the integer that was uploaded —
     * across a quad it drifts, and a slot index that drifts samples the tile
     * next door along one edge of every marking in the city.
     */
    const t = floor(attribute("aTile", "float").add(0.5));
    const col = t.mod(uCols);
    const row = uRows.sub(1.0).sub(t.div(uCols).floor());
    return vec2(uv().x.add(col).div(uCols), uv().y.add(row).div(uRows));
  });

  const tex = texture(A.texture, tileUV());
  mat.colorNode = Fn(() => {
    // Paint wears where it is driven on. A hash of the world position rather
    // than of the instance, so two markings that meet do not disagree about
    // how worn the tarmac between them is.
    const w = positionWorld.xz.mul(0.7).sin().x.mul(0.5).add(0.5).mul(uWorn);
    return mix(tex.rgb, tex.rgb.mul(0.55), w);
  })();
  mat.opacityNode = tex.a;

  const mesh = shareInstancePipeline(new THREE.InstancedMesh(geo, mat, marks.length));
  mesh.name = name;
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  const m = new THREE.Matrix4(), q = new THREE.Quaternion();
  const UP = new THREE.Vector3(0, 1, 0);
  const p = new THREE.Vector3(), s = new THREE.Vector3();
  marks.forEach((k, i) => {
    q.setFromAxisAngle(UP, k.yaw ?? 0);
    p.set(k.x, (k.y ?? 0) + M.lift, k.z);
    s.set(k.w ?? 3, 1, k.h ?? 6);
    mesh.setMatrixAt(i, m.compose(p, q, s));
  });
  mesh.instanceMatrix.needsUpdate = true;

  return {
    mesh,
    atlas: A,
    stats: { marks: marks.length, draws: 1 },
    dispose() {
      geo.dispose();
      mat.dispose();
      if (!atlas) A.texture.dispose();
    },
  };
}

/**
 * ── WHERE THE PAINT GOES ─────────────────────────────────────────────────────
 *
 * This atlas has shipped since the viaduct was built, and until now the viaduct
 * was the only thing using it: twelve authored slots, one draw for the whole
 * city, and not a letter of it anywhere a player actually drives.
 *
 * The street shader already paints what is made of rectangles — lane arrows,
 * parking bays, hatching — analytically, which is the right answer for a
 * rectangle. This places the things that are NOT rectangles: lettering, the
 * bike symbol, chevrons. So the two do not overlap in scope, and nothing here
 * makes the street's fragment stage any bigger.
 *
 * Pure: takes the grid, returns `marks` for `createRoadMarkings`. It knows
 * nothing about THREE, which is what lets the caller be the module that
 * already has the grid constants rather than a new one that would have to
 * derive them a second time and drift.
 *
 * DETERMINISTIC. Every choice keys off the street index, the lane and the step,
 * so a rebuild paints the same city. A marking that moved when the track
 * changed would be worse than no marking.
 */
export function planStreetMarks({
  laneFracs, laneDirForIndex,
  pitch, blockW, streetW, ox, oz, half, centerX, centerZ, groundY = 0,
  /** Predicates from the caller: the track corridor, and the underpass hole. */
  keepOut = null, holeAt = null,
  /** Metres between candidate slots along a lane. */
  every = 46,
  /** Clear of a junction by this much — paint inside one reads as a mistake. */
  junctionClear = 11,
} = {}) {
  const marks = [];
  const laneW = streetW / Math.max(laneFracs.length, 1);
  /*
   * PROPORTION IS THE WHOLE GAME WITH ROAD TEXT.
   *
   * In the atlas a word reads along +u and a letter stands up along +v, so the
   * quad's WIDTH carries the word and its LENGTH carries the letter height —
   * which is right, because that is how paint on a road works: the letters sit
   * side by side across the lane and each one is drawn long, so it looks
   * upright from a driver's eye a metre off the ground.
   *
   * Get the ratio wrong and it is not slightly off, it is unreadable. At
   * 2.3 m across by 5.4 m along, "TAXI" gave letters 0.57 m wide and 5.4 m
   * long — a 1:9 stretch, which renders as a pile of bars with an X in it.
   *
   * A letter wants to be roughly 2.5x its own width. The word fills ~0.95 of
   * the tile across and a text row ~0.3 of it along, so for N letters:
   *     0.3 * len = 2.5 * (0.95 * wide / N)   ->   len ~= 8 * wide / N
   */
  const wide = Math.min(laneW * 0.62, 4.6);
  const textLen = (n) => Math.min(8.0 * wide / n, laneW * 1.6);
  /** Integer hash: stable, and cheap enough to call per candidate. */
  const h = (a, b, c) => {
    let n = (a * 73856093) ^ (b * 19349663) ^ (c * 83492791);
    n = (n ^ (n >>> 13)) >>> 0;
    return (n % 1000) / 1000;
  };
  const kLo = Math.floor((-half - Math.max(ox, oz)) / pitch) - 1;
  const kHi = Math.ceil((half - Math.min(ox, oz)) / pitch) + 1;

  for (const axis of ["z", "x"]) {
    const acrossOrigin = axis === "z" ? ox : oz;
    const alongOrigin = axis === "z" ? oz : ox;
    const acrossLim = axis === "z" ? centerX : centerZ;
    const alongLim = axis === "z" ? centerZ : centerX;
    for (let k = kLo; k <= kHi; k++) {
      const base = acrossOrigin + k * pitch + blockW;
      for (let fi = 0; fi < laneFracs.length; fi++) {
        const across = base + streetW * laneFracs[fi];
        if (Math.abs(across - acrossLim) > half) continue;
        const dir = laneDirForIndex(axis, fi);
        // The quad's length runs along its local +Z, so yaw points that at the
        // direction of travel — lettering has to read for the driver, not the
        // map. +Z is yaw 0; +X is yaw +pi/2.
        const yaw = axis === "z"
          ? (dir > 0 ? 0 : Math.PI)
          : (dir > 0 ? Math.PI / 2 : -Math.PI / 2);
        const kerbMost = dir === laneDirForIndex(axis, 0) ? fi === 0 : fi === laneFracs.length - 1;

        for (let along = -half; along <= half; along += every) {
          // Junction bands are where a street of the OTHER axis crosses.
          const jRel = along - alongOrigin - blockW;
          const inJunction = ((jRel % pitch) + pitch) % pitch < streetW + junctionClear
            || ((jRel % pitch) + pitch) % pitch > pitch - junctionClear;
          if (inJunction) continue;
          if (Math.abs(along - alongLim) > half) continue;
          const x = axis === "z" ? across : along;
          const z = axis === "z" ? along : across;
          if (keepOut && keepOut(x, z)) continue;
          if (holeAt && holeAt(x, z)) continue;

          const r = h(k, fi, Math.round(along));
          // Most candidates stay bare. Paint everywhere reads as a test track.
          if (r > 0.34) continue;
          let tile, len, wq = wide;
          if (kerbMost) {
            tile = r < 0.10 ? MARK.bus : r < 0.18 ? MARK.bike : r < 0.26 ? MARK.taxi : MARK.slow;
          } else {
            tile = r < 0.12 ? MARK.sortie : r < 0.22 ? MARK.stop : MARK.school;
          }
          // Letter counts, so a long word is not crushed to fit a short one's box.
          const LETTERS = {
            [MARK.bus]: 3, [MARK.taxi]: 4, [MARK.stop]: 4,
            [MARK.sortie]: 6, [MARK.slow]: 8, [MARK.school]: 5,
          };
          if (tile === MARK.bike) {
            // A symbol, not a word: it stands up along +v like the arrows do,
            // so it wants to be taller than it is wide and not much else.
            wq = Math.min(laneW * 0.42, 2.2);
            len = wq * 1.6;
          } else {
            len = textLen(LETTERS[tile] ?? 4);
          }
          /*
           * TEXT TURNS A QUARTER TURN THAT ARROWS DO NOT.
           *
           * `PlaneGeometry` is authored in XY and rotated into XZ, which
           * transposes the tile's axes against the arrow convention the
           * viaduct established (shape's +Z along travel). An arrow is drawn
           * pointing up the tile and comes out right; a WORD is drawn reading
           * across the tile and comes out laid along the road with every
           * letter on its side.
           *
           * So text gets a quarter turn the other way and its box swapped with
           * it:
           * the word then spreads ACROSS the lane and each letter is drawn
           * long down the road, which is how paint is paired to a driver's
           * eye height — letters side by side, each one stretched so it looks
           * upright from a metre off the ground.
           */
          const isWord = tile !== MARK.bike;
          if (isWord) {
            marks.push({ x, y: groundY, z, yaw: yaw - Math.PI / 2, w: len, h: wq, tile });
          } else {
            marks.push({ x, y: groundY, z, yaw, w: wq, h: len, tile });
          }
        }
      }
    }
  }
  return marks;
}
