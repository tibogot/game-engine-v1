import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { seededRand } from "./woodUtils.js";
import { legSpan, archVoussoirs, WORLD_UP } from "./trestle.js";

/**
 * Procedural Roman / medieval aqueduct along a spline.
 *
 * The trestle idea taken to its natural conclusion: the water channel on top
 * is authored (dead level, or with the faint downhill grade a real aqueduct
 * needs to make the water flow), and the STONE PIERS each reach down to the
 * ground beneath themselves. Cross a valley and the middle piers grow tall
 * while the ones near the rims stay short — the arcade above them is
 * unchanged, because everything above a pier top is invariant.
 *
 * Piers carry a semicircular arcade (real voussoir blocks), an optional
 * second tier of smaller arches for tall crossings (Pont du Gard), a cornice
 * band, and a channel with parapet walls and optional water.
 *
 * Cost: ONE merged vertex-colored mesh for all the masonry + an optional
 * water mesh. Blocky by design — the per-block colour jitter is what sells
 * the stone.
 */

export const AQUEDUCT_DEFAULTS = {
  pathSegments: 60,

  deckHeight: 9, // channel top above the HIGHER end's ground
  grade: 0.3, // % downhill fall from start to end (real aqueducts ~0.1–0.3%)

  width: 2.6, // structural width (across the path)

  pierSpacing: 7, // metres between pier centres = arch span
  pierWidthTop: 1.5, // pier thickness along the path, at the top
  pierBatter: 0.25, // extra thickness at the base (taper) — 0 = straight column
  pierEmbed: 0.6, // sink into the ground
  pierMaxHeight: 0, // 0 = unlimited (that's the point of a viaduct)
  pierBlocks: true, // build the pier out of stacked courses
  courseHeight: 0.55, // stone course height

  arches: true,
  archCount: 11, // voussoirs per arch
  archThickness: 0.55,
  archRise: 1.0, // 1 = semicircle, <1 = flatter segmental arch
  archJoint: 0.03, // visible joint gap between blocks

  tier2: false, // upper row of small arches (Pont du Gard look)
  tier2Count: 3, // small arches per main bay
  tier2Height: 1.8,

  spandrel: true, // fill the wall between arch and channel
  cornice: true,
  corniceDrop: 0.35,
  corniceOut: 0.22,

  channel: true,
  channelDepth: 0.75,
  channelWidth: 1.1,
  parapet: 0.35, // parapet wall thickness

  water: true,
  waterLevel: 0.55, // fraction of channel depth
  waterColor: "#3f7f8c",

  stoneA: "#b9ad97",
  stoneB: "#8e836f",
  stoneVar: 0.5, // per-block A↔B blend spread
  roughness: 0.92,
  metalness: 0.0,
  seed: 31,
};

// ── builder ────────────────────────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {THREE.Vector3[]|{x,y,z}[]} opts.points
 * @param {boolean} [opts.closed]
 * @param {object} [opts.params]
 * @param {(x:number,z:number)=>number} [opts.getWorldHeight]
 * @returns {THREE.Group|null}
 */
export function buildAqueductMesh({
  points,
  closed = false,
  params = {},
  getWorldHeight = () => 0,
}) {
  if (!Array.isArray(points) || points.length < 2) return null;
  const p = { ...AQUEDUCT_DEFAULTS, ...params };

  const pts3 = points.map((pt) => new THREE.Vector3(pt.x, 0, pt.z));
  const curve = new THREE.CatmullRomCurve3(pts3, !!closed, "catmullrom", 0.5);
  const length = curve.getLength();
  const halfW = Math.max(0.5, p.width) * 0.5;

  const y0 = getWorldHeight(points[0].x, points[0].z);
  const yN = getWorldHeight(
    points[points.length - 1].x,
    points[points.length - 1].z,
  );

  // Channel top: level with the higher rim, falling very slightly toward the
  // far end (that faint grade is what actually moves the water).
  const startY = Math.max(y0, yN) + p.deckHeight;
  const fall = length * (p.grade / 100);
  const deckY = (t) => startY - fall * t;

  const group = new THREE.Group();
  group.name = "Aqueduct";

  const allGeos = [];
  const _c = new THREE.Color();
  const stoneA = new THREE.Color(p.stoneA);
  const stoneB = new THREE.Color(p.stoneB);

  const unitBox = new THREE.BoxGeometry(1, 1, 1);
  unitBox.deleteAttribute("uv");
  const m = new THREE.Matrix4();
  const scl = new THREE.Vector3();

  // every block gets its own stone tone — this is what makes it read as masonry
  const stoneCol = (k) => {
    const t = seededRand(p.seed, k) * p.stoneVar;
    return _c.copy(stoneA).lerp(stoneB, THREE.MathUtils.clamp(t, 0, 1));
  };
  const pushBox = (matrix, color) => {
    const g = unitBox.clone();
    g.applyMatrix4(matrix);
    const n = g.attributes.position.count;
    const buf = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      buf[i * 3] = color.r;
      buf[i * 3 + 1] = color.g;
      buf[i * 3 + 2] = color.b;
    }
    g.setAttribute("color", new THREE.BufferAttribute(buf, 3));
    allGeos.push(g);
  };

  const frameAt = (t) => {
    const e = 0.002;
    const a = curve.getPointAt(THREE.MathUtils.clamp(t - e, 0, 1));
    const b = curve.getPointAt(THREE.MathUtils.clamp(t + e, 0, 1));
    const fwd = b.sub(a).setY(0).normalize();
    if (fwd.lengthSq() < 1e-9) fwd.set(0, 0, 1);
    const right = new THREE.Vector3().crossVectors(WORLD_UP, fwd).normalize();
    return { right, fwd };
  };
  const at = (t) => {
    const c = curve.getPointAt(THREE.MathUtils.clamp(t, 0, 1));
    return new THREE.Vector3(c.x, deckY(t), c.z);
  };

  // ── pier stations ──
  const bays = Math.max(1, Math.round(length / Math.max(2, p.pierSpacing)));
  const pierCount = bays + 1;

  // channel/deck structure occupies the top; piers spring from below it
  const deckStruct =
    (p.cornice ? p.corniceDrop : 0) +
    (p.channel ? p.channelDepth + 0.25 : 0.4) +
    (p.tier2 ? p.tier2Height : 0);

  const piers = [];
  let blockId = 0;

  for (let i = 0; i < pierCount; i++) {
    const t = pierCount === 1 ? 0.5 : i / (pierCount - 1);
    const f = frameAt(t);
    const c = at(t);
    const topY = c.y - deckStruct; // pier top = arch springing line
    const leg = legSpan(topY, getWorldHeight(c.x, c.z), {
      embed: p.pierEmbed,
      maxLength: p.pierMaxHeight,
      minLength: 0.5,
    });
    piers.push({ t, f, c, topY, leg });

    // pier shaft — stacked courses, tapering (battered) toward the base
    const courses = p.pierBlocks
      ? Math.max(1, Math.round(leg.length / Math.max(0.15, p.courseHeight)))
      : 1;
    const ch = leg.length / courses;
    for (let k = 0; k < courses; k++) {
      const yMid = leg.bottomY + ch * (k + 0.5);
      const up = (yMid - leg.bottomY) / Math.max(0.01, leg.length); // 0 base → 1 top
      const taper = p.pierWidthTop + p.pierBatter * (1 - up);
      scl.set(halfW * 2 * (0.92 + 0.08 * (1 - up)), ch * 0.98, taper);
      m.makeBasis(f.right, WORLD_UP, f.fwd)
        .scale(scl)
        .setPosition(c.x, yMid, c.z);
      pushBox(m, stoneCol(blockId++));
    }
  }

  // ── arcade: semicircular arches between consecutive pier tops ──
  if (p.arches && pierCount > 1) {
    for (let i = 0; i < pierCount - 1; i++) {
      const A = piers[i];
      const B = piers[i + 1];
      // spring from the inner faces of the two piers
      const a = new THREE.Vector3(A.c.x, A.topY, A.c.z).addScaledVector(
        A.f.fwd,
        p.pierWidthTop * 0.5,
      );
      const b = new THREE.Vector3(B.c.x, B.topY, B.c.z).addScaledVector(
        B.f.fwd,
        -p.pierWidthTop * 0.5,
      );
      const mats = archVoussoirs(a, b, {
        count: p.archCount,
        thickness: p.archThickness,
        depth: halfW * 2 * 0.9,
        riseScale: p.archRise,
        gap: p.archJoint,
      });
      for (const mm of mats) pushBox(mm, stoneCol(blockId++));

      // Spandrel: the wall filling the gap between the arch's crown and the
      // deck underside. Skipped when tier 2 is on — the small arcade occupies
      // exactly that zone.
      if (p.spandrel && !p.tier2) {
        const span = a.distanceTo(b);
        const crown = A.topY + span * 0.5 * p.archRise + p.archThickness * 0.5;
        const wallTop = Math.max(A.c.y, B.c.y) - deckStruct;
        if (crown < wallTop - 0.05) {
          const mid = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5);
          const h = wallTop - crown;
          scl.set(span * 0.9, h, halfW * 2 * 0.86);
          m.makeBasis(A.f.right, WORLD_UP, A.f.fwd)
            .scale(scl)
            .setPosition(mid.x, crown + h * 0.5, mid.z);
          pushBox(m, stoneCol(blockId++));
        }
      }
    }
  }

  // ── tier 2: a row of small arches above each main bay (Pont du Gard) ──
  if (p.tier2 && pierCount > 1) {
    const nSmall = Math.max(1, p.tier2Count | 0);
    for (let i = 0; i < pierCount - 1; i++) {
      const A = piers[i];
      const B = piers[i + 1];
      const baseY = Math.max(A.c.y, B.c.y) - deckStruct + p.tier2Height;
      // small piers + arches evenly across the bay
      for (let k = 0; k <= nSmall; k++) {
        const t = THREE.MathUtils.lerp(A.t, B.t, k / nSmall);
        const f = frameAt(t);
        const c = at(t);
        const colTop = baseY;
        const colBot = baseY - p.tier2Height;
        scl.set(halfW * 2 * 0.8, p.tier2Height, p.pierWidthTop * 0.55);
        m.makeBasis(f.right, WORLD_UP, f.fwd)
          .scale(scl)
          .setPosition(c.x, (colTop + colBot) * 0.5, c.z);
        pushBox(m, stoneCol(blockId++));
      }
      for (let k = 0; k < nSmall; k++) {
        const ta = THREE.MathUtils.lerp(A.t, B.t, k / nSmall);
        const tb = THREE.MathUtils.lerp(A.t, B.t, (k + 1) / nSmall);
        const fa = frameAt(ta);
        const ca = at(ta);
        const cb = at(tb);
        const springY = baseY;
        const a = new THREE.Vector3(ca.x, springY, ca.z).addScaledVector(
          fa.fwd,
          p.pierWidthTop * 0.28,
        );
        const b = new THREE.Vector3(cb.x, springY, cb.z).addScaledVector(
          fa.fwd,
          -p.pierWidthTop * 0.28,
        );
        const mats = archVoussoirs(a, b, {
          count: Math.max(3, (p.archCount * 0.6) | 0),
          thickness: p.archThickness * 0.6,
          depth: halfW * 2 * 0.78,
          riseScale: p.archRise,
          gap: p.archJoint,
        });
        for (const mm of mats) pushBox(mm, stoneCol(blockId++));
      }
    }
  }

  // ── cornice band + channel walls, swept as block courses along the path ──
  const segs = Math.max(12, p.pathSegments | 0);
  const bandBlocks = Math.max(4, Math.round(length / 1.2));

  if (p.cornice) {
    for (let i = 0; i < bandBlocks; i++) {
      const t = (i + 0.5) / bandBlocks;
      const f = frameAt(t);
      const c = at(t);
      const y = c.y - (p.channel ? p.channelDepth + 0.25 : 0.4) - p.corniceDrop * 0.5;
      scl.set(
        (halfW + p.corniceOut) * 2,
        p.corniceDrop,
        (length / bandBlocks) * 1.02,
      );
      m.makeBasis(f.right, WORLD_UP, f.fwd).scale(scl).setPosition(c.x, y, c.z);
      pushBox(m, stoneCol(blockId++));
    }
  }

  if (p.channel) {
    const chW = Math.min(p.channelWidth, halfW * 2 - 0.2);
    const floorY = -(p.channelDepth) - 0.125;
    for (let i = 0; i < bandBlocks; i++) {
      const t = (i + 0.5) / bandBlocks;
      const f = frameAt(t);
      const c = at(t);
      const blockLen = (length / bandBlocks) * 1.02;

      // channel floor slab
      scl.set(halfW * 2, 0.25, blockLen);
      m.makeBasis(f.right, WORLD_UP, f.fwd)
        .scale(scl)
        .setPosition(c.x, c.y + floorY, c.z);
      pushBox(m, stoneCol(blockId++));

      // two parapet walls flanking the water trough
      for (const s of [-1, 1]) {
        const off = chW * 0.5 + p.parapet * 0.5;
        const pos = new THREE.Vector3(c.x, c.y - p.channelDepth * 0.5, c.z)
          .addScaledVector(f.right, s * off);
        scl.set(p.parapet, p.channelDepth, blockLen);
        m.makeBasis(f.right, WORLD_UP, f.fwd)
          .scale(scl)
          .setPosition(pos.x, pos.y, pos.z);
        pushBox(m, stoneCol(blockId++));
      }
    }

    // ── water ribbon inside the trough (its own thin mesh) ──
    if (p.water) {
      const pos = [];
      const idx = [];
      const wy = -p.channelDepth * (1 - p.waterLevel);
      for (let i = 0; i <= segs; i++) {
        const t = i / segs;
        const f = frameAt(t);
        const c = at(t);
        const hw = chW * 0.5 - 0.02;
        const l = new THREE.Vector3(c.x, c.y + wy, c.z).addScaledVector(f.right, -hw);
        const r = new THREE.Vector3(c.x, c.y + wy, c.z).addScaledVector(f.right, hw);
        pos.push(l.x, l.y, l.z, r.x, r.y, r.z);
      }
      for (let i = 0; i < segs; i++) {
        const a = i * 2;
        idx.push(a, a + 1, a + 3, a, a + 3, a + 2);
      }
      const wg = new THREE.BufferGeometry();
      wg.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      wg.setIndex(idx);
      wg.computeVertexNormals();
      const wmesh = new THREE.Mesh(
        wg,
        new THREE.MeshStandardMaterial({
          color: new THREE.Color(p.waterColor),
          roughness: 0.15,
          metalness: 0.0,
        }),
      );
      wmesh.receiveShadow = true;
      group.add(wmesh);
    }
  }

  // ── merge all masonry into ONE vertex-colored mesh ──
  unitBox.dispose();
  const merged = mergeGeometries(allGeos, false);
  allGeos.forEach((g) => g.dispose());
  if (merged) {
    const mesh = new THREE.Mesh(
      merged,
      new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: p.roughness,
        metalness: p.metalness,
        flatShading: true, // reads as cut stone
      }),
    );
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }

  return group;
}

/** Fixed hero span — a long crossing so the arcade is visible. */
export const AQUEDUCT_HERO_POINTS = [
  { x: -24, y: 0, z: -14 },
  { x: 24, y: 0, z: -14 },
];
