/**
 * Waterfall path solver — pure maths, no render objects, runs headlessly
 * (tools/waterfallPathTest.mjs).
 *
 * A waterfall is authored as its LIP: a centre point on the edge, the direction
 * the water leaves in (yaw), a width and the speed it arrives with. Everything
 * below the lip is SOLVED, never drawn by hand:
 *
 *   - Each column across the width is a parcel of water thrown off the lip and
 *     integrated under gravity. Free fall is a real ballistic arc, so a fast
 *     river throws its water clear of the cliff and a trickle drops straight
 *     down the face.
 *   - Where the arc would enter the ground (terrain or a solid prop such as a
 *     procedural cliff) the water CLINGS: it is put back on the surface, loses
 *     the part of its velocity going into it, and slides with friction. A ledge
 *     part-way down therefore catches the sheet and throws it off again: a
 *     cascade, with no authoring.
 *   - A wall ahead (ground at the next step far above the parcel) stops the
 *     horizontal motion and the water runs down the face.
 *   - The column ends where it meets water below the lip (lake, river, sea —
 *     whatever `sampleWater` reports) or settles on flat ground.
 *
 * Every vertex carries its TIME OF FLIGHT. The shader keys its streak pattern on
 * the moment the water left the lip (`time − t`), so the pattern travels with
 * the water and stretches exactly as much as the water itself accelerates —
 * the thing a constant UV scroll can never do.
 *
 * Thickness follows the flow: the discharge per metre of width (lip speed ×
 * lip depth) is conserved, so a sheet that falls three times faster is a third
 * as thick. The shader turns thin into see-through and broken into strands.
 */

export const GRAVITY = 9.81;

/** Per-waterfall authoring values (shape). The look is shared (waterfallState.js). */
export const FALL_DEFAULTS = {
  /** Lip centre (the water surface at the edge), world metres. */
  px: 0, py: 0, pz: 0,
  /** Radians. The water leaves along (sin yaw, cos yaw). */
  yaw: 0,
  /** Metres across the lip. */
  width: 8,
  /** m/s over the lip. A calm stream ~1, a river in spate 4-6. */
  speed: 2.5,
  /** Metres of water going over the lip. Sets the discharge (and thickness). */
  depth: 0.5,
  /** Sideways fan-out: extra width per second of fall, as a fraction of the lip width. */
  spread: 0.12,
  /** Whitewater multiplier for this fall (1 = the shared look). */
  foam: 1,
  /** 1/s of speed lost while sliding on rock. */
  friction: 0.8,
  /**
   * Metres of flat water carried UPSTREAM of the lip — the crest. The river does
   * not stop at the edge: it runs on to it and curls over. This apron is what
   * overlaps the river's own surface, so the two read as one body of water
   * (Unreal's Water plugin and Unity do the same thing: the river mesh and the
   * fall mesh overlap at the lip rather than meeting exactly).
   */
  crest: 3,
  /**
   * How many of those crest metres lie OVER the river's own surface. Across
   * that band the fall fades out and the river fades in, so the handover is a
   * crossfade rather than a seam — and the two waters are never stacked, which
   * would absorb the light twice and read as a dark wedge at the lip.
   */
  crestOverlap: 2.5,
  /**
   * River v2 id this fall is attached to, or null. Attached, the lip IS the
   * river's mouth: position, level, heading, width and speed come from the
   * river every time it changes, and the river's conform stops at the lip.
   */
  river: null,
};

const SOLVE_DEFAULTS = {
  /** Metres of travel per integration step (the step adapts to the speed). */
  stepLength: 0.35,
  /** Metres between the crest apron's rows. */
  crestStep: 0.6,
  maxStepTime: 1 / 30,
  maxTime: 12,
  /** Metres between columns across the lip. */
  columnSpacing: 1.5,
  minColumns: 3,
  maxColumns: 24,
  /** Metres between rows down the fall. */
  rowSpacing: 0.9,
  minRows: 6,
  maxRows: 96,
  /** Metres the water rides above a surface it slides on. */
  clingOffset: 0.12,
  /** A step whose ground is this much ABOVE the parcel is a wall, not a slope. */
  wallStep: 0.6,
  /** A water surface counts only this far below the lip (the lip sits IN its river). */
  waterBelowLip: 0.3,
  /** Ground at least this flat is where water pools, unless it drops away ahead. */
  settleNormalY: 0.9,
  /** Metres looked ahead (plus half a second of travel) for a drop. */
  lookAhead: 2,
  /** Metres lower that counts as a drop ahead. */
  dropAhead: 1.5,
  /** m/s water overflows toward a drop at, however slowly it arrived. */
  settleSpeed: 0.8,
  /** Fraction of a landing's impact speed thrown forward. */
  landingCarry: 0.25,
  /** Seconds after the lip in which ground ahead is the channel rim, not a wall. */
  rimTime: 0.35,
  /** A column shorter than this fraction of the median carries no water. */
  deadFraction: 0.3,
};

/**
 * Integrate one parcel from the lip.
 * @returns {{ pts: number[], end: "water"|"ground"|"time", endY: number }}
 *   pts is a flat list of [x, y, z, t, speed, contact, over] per sample, where
 *   `over` is how much of this point lies over the river's own surface: 0 from
 *   the river's mouth down, rising to 1 at the upstream end of the crest.
 */
function integrateColumn(sx, sy, sz, vx, vy, vz, fall, o, sampleGround, sampleWater, lipDx, lipDz) {
  const pts = [];
  // The lip's own direction, for when the water has no horizontal motion to follow.
  const fh = Math.hypot(vx, vz);
  const fdx = fh > 1e-4 ? vx / fh : 0, fdz = fh > 1e-4 ? vz / fh : 1;
  // The crest runs back along the LIP, the same way for every column. Laying it
  // back along each column's own velocity instead makes the fan-out work in
  // reverse going upstream, so the crest narrows toward the river and the join
  // is visibly pinched exactly where it has to be seamless.
  const cdx = lipDx ?? fdx, cdz = lipDz ?? fdz;
  let x = sx, y = sy, z = sz, t = 0;
  let contact = 0;
  let crest = 0;
  // Filled by the crest below: the water leaves from where its surface ends up,
  // which is at or under the river's level.
  // eslint-disable-next-line prefer-const
  const push = () => pts.push(x, y, z, t, Math.hypot(vx, vy, vz), contact, crest);

  /*
   * The crest: the water carried from the river to the brink. It is laid down
   * rather than integrated, because it is the river's SURFACE, not a parcel in
   * flight.
   *
   * Its height is the river's level — but never more than `depth` above the bed
   * under it. Where the bed falls away toward the brink the surface falls with
   * it, which is the curl over the edge: a surface held flat to the last
   * centimetre instead ends as a shelf of water hanging in mid-air.
   */
  const crestLen = Math.max(0, fall.crest);
  const depthM = Math.max(0.05, fall.depth);
  let lipY = sy;
  if (crestLen > 0) {
    const overlap = Math.max(0.01, Math.min(crestLen, fall.crestOverlap));
    // Metres from the lip at which the river's own surface begins.
    const bridge = crestLen - overlap;
    const steps = Math.max(2, Math.ceil(crestLen / o.crestStep));
    for (let i = 0; i <= steps; i++) {
      const f = 1 - i / steps;
      const up = crestLen * f;                       // metres upstream of the lip
      crest = Math.max(0, Math.min(1, (up - bridge) / overlap));
      x = sx - cdx * up;
      z = sz - cdz * up;
      const g = sampleGround(x, sy + 2, z);
      y = Math.min(sy, (g?.y ?? -Infinity) + depthM);
      if (i === steps) lipY = y;
      pts.push(x, y, z, 0, Math.hypot(vx, vy, vz), 0, crest);
    }
    x = sx; y = lipY; z = sz;
  }
  crest = 0;
  push();
  const waterCap = lipY - o.waterBelowLip;
  let end = "time";
  let endY = y;

  while (t < o.maxTime) {
    const sp = Math.hypot(vx, vy, vz);
    const dt = Math.min(o.maxStepTime, o.stepLength / Math.max(sp, 0.5));
    let nvx = vx, nvy = vy - GRAVITY * dt, nvz = vz;
    if (contact) {
      const k = Math.exp(-fall.friction * dt);
      nvx *= k; nvz *= k;
      if (nvy < 0) nvy *= Math.exp(-fall.friction * 0.25 * dt);
    }
    let nx = x + nvx * dt, ny = y + nvy * dt, nz = z + nvz * dt;

    // Water below the lip ends the column exactly at the surface — where there
    // really is water: a lake is a rectangle at a level, and over its dry
    // corners the ground stands above that level.
    const wy = sampleWater(nx, nz);
    if (wy <= waterCap && ny <= wy && (sampleGround(nx, wy + 0.01, nz)?.y ?? -Infinity) < wy) {
      const f = (y - wy) / Math.max(1e-6, y - ny);
      x += (nx - x) * f; z += (nz - z) * f; y = wy;
      t += dt * f; vx = nvx; vy = nvy; vz = nvz;
      push();
      end = "water"; endY = wy;
      break;
    }

    let g = sampleGround(nx, ny + o.wallStep * 4, nz);
    if (g && g.y - ny > o.wallStep && g.y - y > o.wallStep) {
      // A wall ahead. In the first moments after the lip this is the channel's
      // own rim — the water rides over it and goes on, which is what water does
      // and what the lip of a real river looks like. Later it is rock: the
      // horizontal motion dies on it and the water runs down the face.
      if (t < o.rimTime) {
        ny = g.y + o.clingOffset;
      } else {
        nx = x; nz = z; nvx *= -0.05; nvz *= -0.05;
        g = sampleGround(nx, ny + o.wallStep, nz);
      }
    }
    const wasContact = contact;
    contact = 0;
    if (g && ny <= g.y + o.clingOffset) {
      // On (or into) the surface: ride on it and drop the velocity into it.
      if (g.y - y > o.wallStep * 4) { end = "ground"; endY = y; push(); break; }
      ny = g.y + o.clingOffset;
      const into = nvx * g.nx + nvy * g.ny + nvz * g.nz;
      if (into < 0) {
        nvx -= g.nx * into; nvy -= g.ny * into; nvz -= g.nz * into;
        // A landing throws part of its impact forward along its travel.
        if (!wasContact) {
          const h = Math.hypot(nvx, nvz);
          const fx = h > 1e-3 ? nvx / h : fdx, fz = h > 1e-3 ? nvz / h : fdz;
          nvx += fx * -into * o.landingCarry; nvz += fz * -into * o.landingCarry;
        }
      }
      contact = 1;
      if (g.ny >= o.settleNormalY) {
        // Flat ground: a pool here, unless the ground drops away ahead, in which
        // case the water overflows toward the drop (the lip itself, a ledge).
        const h = Math.hypot(nvx, nvz);
        const ax = h > 0.2 ? nvx / h : fdx, az = h > 0.2 ? nvz / h : fdz;
        let dropAhead = false;
        const reach = o.lookAhead + h * 0.5;
        for (let k = 1; k <= 4 && !dropAhead; k++) {
          const d = (reach * k) / 4;
          const ga = sampleGround(nx + ax * d, ny + o.wallStep, nz + az * d);
          if (!ga || ga.y < g.y - o.dropAhead) dropAhead = true;
        }
        if (!dropAhead) {
          x = nx; y = ny; z = nz; t += dt; vx = nvx; vy = nvy; vz = nvz;
          push();
          end = "ground"; endY = g.y;
          break;
        }
        if (h < o.settleSpeed) { nvx = ax * o.settleSpeed; nvz = az * o.settleSpeed; }
      }
    }
    x = nx; y = ny; z = nz; t += dt; vx = nvx; vy = nvy; vz = nvz;
    push();
  }
  if (end === "time") endY = y;
  return { pts, end, endY };
}

const STRIDE = 7;

/** Linear resample of one column's samples at arc-length fraction f. */
function sampleAt(pts, arc, target, out) {
  const n = arc.length;
  if (target <= 0 || n < 2) { for (let k = 0; k < STRIDE; k++) out[k] = pts[k]; return 0; }
  let i = 1;
  while (i < n - 1 && arc[i] < target) i++;
  const a0 = arc[i - 1], a1 = arc[i];
  const f = a1 > a0 ? Math.min(1, Math.max(0, (target - a0) / (a1 - a0))) : 0;
  const b0 = (i - 1) * STRIDE, b1 = i * STRIDE;
  for (let k = 0; k < STRIDE; k++) out[k] = pts[b0 + k] + (pts[b1 + k] - pts[b0 + k]) * f;
  return f;
}

/**
 * Solve a waterfall into a grid of vertices.
 *
 * @param {object} fall                    FALL_DEFAULTS fields
 * @param {object} deps
 * @param {(x:number, yFrom:number, z:number) => ({y,nx,ny,nz}|null)} deps.sampleGround
 *        the highest surface at or below yFrom (terrain, solids), with its normal
 * @param {(x:number, z:number) => number} [deps.sampleWater] water surface Y, -Infinity where dry
 * @param {object} [deps.options]          SOLVE_DEFAULTS overrides
 */
export function solveFall(fall, { sampleGround, sampleWater = () => -Infinity, options = {} } = {}) {
  const f = { ...FALL_DEFAULTS, ...fall };
  const o = { ...SOLVE_DEFAULTS, ...options };
  const width = Math.max(0.25, f.width);
  const speed = Math.max(0.05, f.speed);
  const dx = Math.sin(f.yaw), dz = Math.cos(f.yaw);
  // Across the lip: left → right when looking downstream.
  const rx = -dz, rz = dx;

  const cols = Math.max(o.minColumns, Math.min(o.maxColumns, Math.round(width / o.columnSpacing) + 1));
  const colArc = new Float32Array(cols);
  /**
   * A column that stops almost at once carries no water: its lip is in the bank,
   * or against rock. Left in the mesh it would be joined to the columns beside
   * it that fell the whole way, and the quad between them stretches the length
   * of the fall — which draws as a long white spike out of the lip.
   */
  const colDead = new Uint8Array(cols);
  const raw = [];
  let maxArc = 0;
  for (let j = 0; j < cols; j++) {
    const a = j / (cols - 1) - 0.5;
    const sx = f.px + rx * a * width, sz = f.pz + rz * a * width;
    const lat = a * width * f.spread;
    const col = integrateColumn(sx, f.py, sz, dx * speed + rx * lat, 0, dz * speed + rz * lat,
      f, o, sampleGround, sampleWater, dx, dz);
    const n = col.pts.length / STRIDE;
    const arc = new Float32Array(n);
    for (let i = 1; i < n; i++) {
      const b = i * STRIDE, p = b - STRIDE;
      arc[i] = arc[i - 1] + Math.hypot(col.pts[b] - col.pts[p], col.pts[b + 1] - col.pts[p + 1], col.pts[b + 2] - col.pts[p + 2]);
    }
    col.arc = arc;
    col.length = arc[n - 1] ?? 0;
    maxArc = Math.max(maxArc, col.length);
    colArc[j] = col.length;
    raw.push(col);
  }

  // Median length decides which columns are dead (see colDead).
  const sortedArc = Array.from(colArc).sort((a, b) => a - b);
  const medianArc = sortedArc[sortedArc.length >> 1] ?? 0;
  const crestLen = Math.max(0, f.crest);
  for (let j = 0; j < cols; j++) {
    colDead[j] = colArc[j] < Math.max(crestLen + 0.5, medianArc * o.deadFraction) ? 1 : 0;
  }
  // All of them "dead" means the whole fall is short, which is legitimate.
  if (colDead.every((d) => d)) colDead.fill(0);

  const rows = Math.max(o.minRows, Math.min(o.maxRows, Math.ceil(maxArc / o.rowSpacing) + 1));
  const count = cols * rows;
  const position = new Float32Array(count * 3);
  const time = new Float32Array(count);
  const speedA = new Float32Array(count);
  const thickness = new Float32Array(count);
  const arcA = new Float32Array(count);
  const frac = new Float32Array(count);
  const contact = new Float32Array(count);
  const crest = new Float32Array(count);
  const across = new Float32Array(count);
  const discharge = speed * Math.max(0.02, f.depth);
  const s = new Float64Array(STRIDE);

  let waterEnds = 0, maxT = 0;
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let j = 0; j < cols; j++) {
    const col = raw[j];
    const a = j / (cols - 1) - 0.5;
    for (let i = 0; i < rows; i++) {
      const fr = i / (rows - 1);
      sampleAt(col.pts, col.arc, fr * col.length, s);
      const v = j * rows + i;
      position[v * 3] = s[0]; position[v * 3 + 1] = s[1]; position[v * 3 + 2] = s[2];
      time[v] = s[3];
      speedA[v] = s[4];
      thickness[v] = Math.min(f.depth * 1.5, discharge / Math.max(0.05, s[4]));
      arcA[v] = fr * col.length;
      frac[v] = fr;
      contact[v] = s[5];
      crest[v] = s[6];
      across[v] = a;
      if (s[0] < minX) minX = s[0]; if (s[0] > maxX) maxX = s[0];
      if (s[1] < minY) minY = s[1]; if (s[1] > maxY) maxY = s[1];
      if (s[2] < minZ) minZ = s[2]; if (s[2] > maxZ) maxZ = s[2];
    }
    const last = (col.pts.length / STRIDE - 1) * STRIDE;
    col.last = last;
    maxT = Math.max(maxT, col.pts[last + 3]);
    if (col.end === "water") waterEnds++;
  }

  /*
   * WHERE THE FALL LANDS. Averaging every column is wrong wherever they do not
   * all end the same way: a sheet that half reaches the lake and half stops on
   * the bank above it would put its splash in mid-air between the two. Only the
   * columns that end the way MOST of them do are counted.
   */
  const liveCols = cols - colDead.reduce((a, b) => a + b, 0);
  const onWater = waterEnds * 2 >= Math.max(1, liveCols);
  let endX = 0, endY = 0, endZ = 0, endT = 0, endSpeed = 0, counted = 0;
  for (let j = 0; j < cols; j++) {
    const col = raw[j];
    if (colDead[j]) continue;
    if ((col.end === "water") !== onWater) continue;
    endX += col.pts[col.last]; endY += col.pts[col.last + 1]; endZ += col.pts[col.last + 2];
    endT += col.pts[col.last + 3]; endSpeed += col.pts[col.last + 4];
    counted++;
  }
  if (counted === 0) {
    for (const col of raw) {
      endX += col.pts[col.last]; endY += col.pts[col.last + 1]; endZ += col.pts[col.last + 2];
      endT += col.pts[col.last + 3]; endSpeed += col.pts[col.last + 4];
      counted++;
    }
  }
  const onWaterCount = raw.filter((c, j) => !colDead[j] && c.end === "water").length;

  // Width of the landing: spread of the first and last column ends.
  const l0 = (raw[0].pts.length / STRIDE - 1) * STRIDE, l1 = (raw[cols - 1].pts.length / STRIDE - 1) * STRIDE;
  const impactWidth = Math.hypot(raw[cols - 1].pts[l1] - raw[0].pts[l0], raw[cols - 1].pts[l1 + 2] - raw[0].pts[l0 + 2]);

  return {
    cols, rows, count,
    position, time, speed: speedA, thickness, arc: arcA, frac, contact, crest, across,
    colArc, colDead,
    width, maxTime: maxT,
    drop: f.py - endY / counted,
    impact: {
      x: endX / counted, y: endY / counted, z: endZ / counted,
      onWater,
      time: endT / counted,
      speed: endSpeed / counted,
      width: Math.max(width, impactWidth),
      dirX: dx, dirZ: dz,
    },
    bounds: { minX, minY, minZ, maxX, maxY, maxZ },
  };
}

/**
 * The direction water would leave a lip at (x, z): the steepest drop around it,
 * as a yaw. Looks a few metres out in 24 directions. Null on flat ground.
 */
export function downhillYaw(x, z, sampleHeight, { radius = 4, minDrop = 0.5 } = {}) {
  const h0 = sampleHeight(x, z);
  // Every direction votes with its drop; the result is the drop-weighted mean
  // direction. A straight edge ties many directions — the mean of the tie is
  // square to the edge, where picking "the best one" would pick a diagonal.
  let sumX = 0, sumZ = 0, any = false;
  for (let k = 0; k < 24; k++) {
    const yaw = (k / 24) * Math.PI * 2;
    const sx = Math.sin(yaw), sz = Math.cos(yaw);
    // Drops summed over several distances: the direction that meets the edge
    // soonest (straight over it, not along it) scores highest.
    let score = 0, maxDrop = 0;
    for (let s = 1; s <= 12; s++) {
      const f = (s / 12) * 2.5;
      const d = h0 - sampleHeight(x + sx * radius * f, z + sz * radius * f);
      score += Math.max(0, d);
      maxDrop = Math.max(maxDrop, d);
    }
    if (maxDrop > minDrop) { sumX += sx * score; sumZ += sz * score; any = true; }
  }
  if (!any || Math.hypot(sumX, sumZ) < 1e-6) return null;
  return Math.atan2(sumX, sumZ);
}
