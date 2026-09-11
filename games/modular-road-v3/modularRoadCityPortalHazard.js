import * as THREE from "three";
import { Fn, texture, uniform } from "three/tsl";

/**
 * WHAT THE ROAD SAYS BEFORE THE HOLE.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 *
 * Over the covered section the street is intact and the whole width of it is
 * drivable — the tunnel's lid IS the street, which is the trick the underpass
 * is built on. Then at the portal the middle of that street stops being there,
 * and a wall stands across the opening so you do not drive into the trench.
 *
 * Structurally that is correct and it was still a bad experience: the first
 * thing telling you the road was about to split was the barrier itself. Every
 * real road in this situation is painted long before you reach it, because the
 * paint is the part that arrives in time. A driver gets a gore — chevrons
 * fanning out of the lane, apexes pointing back at them — and the obstruction
 * itself gets hazard stripes, so the thing you must not hit is the brightest
 * thing in the frame.
 *
 * ── WHY IT IS NOT THE CITY'S MARKING ATLAS ───────────────────────────────────
 *
 * `modularRoadCityMarkings.js` has a chevron slot and one draw for the whole
 * city, and using it was the obvious move. Two things stop it.
 *
 * It is FLAT ONLY. `createRoadMarkings` rotates its quad into XZ and composes
 * from a yaw, so it can paint the deck and can never paint the wall — and the
 * wall is half the job here. Bending a shared module into vertical placement
 * for one caller is how a shared module stops being shared.
 *
 * And the deck paint and the wall stripes want to be ONE MESH anyway: they are
 * the same warning, they are always built together, and merged they cost a
 * single draw for the whole package rather than one for each. Authoring the
 * canvas here means the UVs are written next to the artwork that fills them,
 * which is the one arrangement where a tile cannot end up upside down.
 *
 * ── COST ─────────────────────────────────────────────────────────────────────
 *
 * One draw. One 1024x256 canvas. 24 triangles for both portals.
 */
export const PORTAL_HAZARD_DEFAULTS = {
  /** The longest the chevron run may be, metres. It stops sooner on a short
   *  tunnel — see the clamp against the covered length. */
  goreLength: 38,
  /** Chevrons per approach. Five reads as a sequence; two reads as a mistake. */
  chevronCount: 5,
  /**
   * Each chevron's length along the road, as a fraction of its own half-width,
   * and the bounds that keeps it sane.
   *
   * TIED TO THE WIDTH, not fixed. The opening is nearly sixteen metres across;
   * a fixed 3.4 m chevron over that span is a 1:4.6 V, which at a driver's eye
   * height is not a chevron at all, it is a line with a kink in it. Scaling
   * with the width keeps every chevron in the fan the same SHAPE, which is
   * what makes a run of them read as one marking.
   */
  chevronLenFrac: 0.85,
  chevronLenMin: 2.0,
  chevronLenMax: 6.5,
  /** Bare road between one chevron and the next. */
  chevronGap: 3.2,
  /**
   * Narrowest chevron, as a fraction of the widest. The run FANS: the one at
   * the portal spans the opening, the one furthest back is a fifth of it, and
   * between them they draw the funnel the lane is being squeezed into.
   */
  chevronTaper: 0.22,
  /** How far above the street the deck paint sits. Same as the city's paint:
   *  enough to win the depth test at a distance, too little to drive under. */
  lift: 0.02,
  /** The object marker on the wall across the mouth, as a fraction of the
   *  parapet's height, and how far it stands off the concrete. */
  panelHeightFrac: 0.80,
  panelStandOff: 0.03,
  /** Retroreflective, like the portal boards: at night the headlights find it.
   *  See the note on the emissive below. */
  glow: 0.45,
  paint: "#eef1f5",
  stripeWarm: "#f0b429",
  stripeDark: "#1b1b1d",
};

/**
 * The artwork. Two tiles side by side in one 1024x256 strip:
 *
 *   u 0.00 - 0.25   the chevron, white on nothing, APEX AT THE RIGHT (+u)
 *   u 0.25 - 1.00   diagonal hazard stripes, opaque, for the wall panel
 *
 * ── WHY THE CHEVRON IS DRAWN ON ITS SIDE ─────────────────────────────────────
 *
 * Which way up a canvas texture ends up is genuinely hard to be sure of here.
 * The WebGPU backend passes `texture.flipY` to `copyExternalImageToTexture`,
 * so v = 0 should be the canvas BOTTOM; but the city's own marking atlas paints
 * its tiles and looks them up with the same row formula, which is only
 * self-consistent if v = 0 is the canvas TOP — and that atlas is on the roads
 * and reads correctly. One of those two things is not what it appears to be,
 * and it cannot be settled from a headless test because there is no canvas to
 * render.
 *
 * So this does not depend on the answer. The chevron's apex points along +u,
 * the axis `flipY` cannot touch, and the shape is MIRROR-SYMMETRIC about the
 * tile's horizontal centreline — so flipping v swaps its two arms for each
 * other and the image is identical either way. The direction that carries the
 * meaning is carried on the axis that cannot be got wrong.
 *
 * The stripes are diagonal and a v-flip does lean them the other way. Hazard
 * striping is drawn both ways in the real world and neither reads as an error,
 * so that one is left to fall where it falls.
 */
function hazardTexture(P) {
  if (typeof document === "undefined") return null;
  const W = 1024, H = 256;
  const cv = document.createElement("canvas");
  cv.width = W; cv.height = H;
  const c = cv.getContext("2d");
  if (!c) return null;
  c.clearRect(0, 0, W, H);

  /*
   * ── The chevron, in the first quarter, lying on its side: apex at the RIGHT,
   *    arms opening to the left, symmetric about the horizontal centreline.
   *    Mirror the y of every point below and you get the same polygon back,
   *    which is the property the whole orientation argument above rests on.
   */
  const cw = W * 0.25;
  c.fillStyle = P.paint;
  c.beginPath();
  c.moveTo(cw * 0.94, H * 0.50);   // apex
  c.lineTo(cw * 0.38, H * 0.04);   // one arm, outer edge
  c.lineTo(cw * 0.06, H * 0.04);
  c.lineTo(cw * 0.62, H * 0.50);   // the notch behind the apex
  c.lineTo(cw * 0.06, H * 0.96);   // the other arm, mirrored exactly
  c.lineTo(cw * 0.38, H * 0.96);
  c.closePath();
  c.fill();

  // ── The hazard stripes, across the rest. Drawn as a rotated rectangle sweep
  //    so the diagonal is a real 45° whatever the strip is stretched to.
  const x0 = cw;
  c.save();
  c.beginPath();
  c.rect(x0, 0, W - x0, H);
  c.clip();
  c.fillStyle = P.stripeDark;
  c.fillRect(x0, 0, W - x0, H);
  c.fillStyle = P.stripeWarm;
  const band = H * 0.62;
  for (let x = x0 - H; x < W + H; x += band * 2) {
    c.beginPath();
    c.moveTo(x, H);
    c.lineTo(x + band, H);
    c.lineTo(x + band + H, 0);
    c.lineTo(x + H, 0);
    c.closePath();
    c.fill();
  }
  c.restore();

  const tex = new THREE.CanvasTexture(cv);
  tex.name = "CityPortalHazard";
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  // `flipY` is left at its default on purpose: this texture behaves exactly
  // like every other canvas texture in the project, and nothing here depends
  // on which way up it lands. See the note on the artwork.
  tex.needsUpdate = true;
  return tex;
}

/**
 * The two tiles' UV boxes. `u1` on the chevron is its APEX edge — the corners
 * that get it are the ones nearest the portal, so the V points back up the
 * road at whoever is arriving.
 */
const UV_CHEVRON = { u0: 0.006, u1: 0.244, v0: 0.0, v1: 1.0 };
const UV_STRIPE = { u0: 0.252, u1: 0.998, v0: 0.02, v1: 0.98 };

/**
 * The paint and the object markers at both portals.
 *
 * @param {object}   opts
 * @param {object}   opts.layout   from `underpassLayout` — the covered range,
 *                                 the axis, the street height and the wall
 *                                 dimensions all come from there, because a
 *                                 marking that derives its own idea of where
 *                                 the portal is will drift away from it.
 * @param {*}        opts.uNight   the city's night factor, for the reflective
 *                                 lift. Optional.
 * @returns {null | {mesh, stats, dispose}}
 */
export function createPortalHazard({ layout, uNight = null, params = {} } = {}) {
  const P = { ...PORTAL_HAZARD_DEFAULTS, ...params };
  if (!layout || !(layout.cov1 > layout.cov0)) return null;
  const U = layout.params;
  const inner = U.roadWidth / 2 + U.wallGap;
  const covered = layout.cov1 - layout.cov0;

  const pos = [], uvs = [], nrm = [], idx = [];
  /**
   * One quad from four corners, carrying a UV box, wound to FACE `n`.
   *
   * The winding is derived from the vertices rather than written down, because
   * `at()` maps (along, across) to (x, z) one way on the x axis and the other
   * way on the z axis — the two are mirror images, so any winding written by
   * hand is correct for one orientation of the tunnel and a back face for the
   * other. The underpass's own walls learned this twice.
   *
   * Only the INDEX order is flipped, never the vertex order, so the UV box
   * stays attached to the corner it was written for and the artwork cannot
   * turn over when the facing does.
   */
  const quad = (a, b, c, d, n, uvA) => {
    const base = pos.length / 3;
    const vs = [a, b, c, d];
    for (let i = 0; i < 4; i++) {
      pos.push(vs[i].x, vs[i].y, vs[i].z);
      nrm.push(n.x, n.y, n.z);
      uvs.push(uvA[i][0], uvA[i][1]);
    }
    const ux = b.x - a.x, uy = b.y - a.y, uz = b.z - a.z;
    const vx = c.x - a.x, vy = c.y - a.y, vz = c.z - a.z;
    const faces = (uy * vz - uz * vy) * n.x
      + (uz * vx - ux * vz) * n.y
      + (ux * vy - uy * vx) * n.z;
    if (faces >= 0) idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    else idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
  };
  /** Along/across/height in the underpass's own frame, into world space. */
  const at = (along, across, y) => (layout.axis === "x"
    ? new THREE.Vector3(along, y, layout.across + across)
    : new THREE.Vector3(layout.across + across, y, along));

  const UP = new THREE.Vector3(0, 1, 0);
  const deckY = layout.top + P.lift;

  for (const [portal, intoRoof] of [[layout.cov0, 1], [layout.cov1, -1]]) {
    /*
     * ── THE GORE ───────────────────────────────────────────────────────────
     *
     * On the ROOF side of the portal, because that is the only side a driver
     * can be approaching the opening from: out in the trench the middle is a
     * hole and there is no lane there to warn.
     *
     * The run fans — widest at the portal, narrowest furthest back — so it
     * draws the shape of what is about to happen rather than just decorating
     * the deck. Apexes point back up the road at the driver, which is the way
     * a real gore is painted: you see the V pointing at you, not away.
     *
     * Clamped to the covered length, so a short tunnel gets a short run
     * instead of chevrons appearing out in the open trench at the far end.
     */
    const run = Math.min(P.goreLength, covered * 0.5);
    const n = Math.max(2, Math.round(P.chevronCount));
    let back = 1.2;
    for (let i = 0; i < n; i++) {
      // i = 0 is the one AT the portal, and the widest.
      const t = n === 1 ? 0 : i / (n - 1);
      const halfW = inner * (1 - t * (1 - P.chevronTaper));
      const len = Math.min(Math.max(halfW * P.chevronLenFrac, P.chevronLenMin), P.chevronLenMax);
      const a0 = portal + intoRoof * back;              // near the driver
      const a1 = portal + intoRoof * (back + len);      // deeper in
      // Never past the run, and never past the middle — the other portal's
      // own run starts from there and two fans meeting nose to nose is not a
      // gore, it is a pattern.
      if (back + len > run) break;
      /*
       * The tile's +u edge is the apex, and it goes on the DRIVER'S side of
       * the quad — `a0`, the edge nearer the portal they are heading for. Get
       * this the wrong way round and the run points politely into the wall.
       * `v` runs across the road, where the artwork is symmetric.
       */
      const C = UV_CHEVRON;
      quad(
        at(a0, -halfW, deckY), at(a0, halfW, deckY),
        at(a1, halfW, deckY), at(a1, -halfW, deckY),
        UP,
        [[C.u1, C.v0], [C.u1, C.v1], [C.u0, C.v1], [C.u0, C.v0]],
      );
      back += len + P.chevronGap;
    }

    /*
     * ── THE OBJECT MARKER ──────────────────────────────────────────────────
     *
     * Hazard stripes on the wall across the mouth: the face a car crossing the
     * lid head-on actually meets. It spans exactly what the wall spans —
     * between the parapets' inner faces — because a marker wider than the
     * thing it marks tells you to steer into a hole, and the lip strips either
     * side of it are road.
     *
     * The wall is built from the portal plane INTO the roof, `wallThick` deep,
     * so its outward face is at the far side of that and the panel stands just
     * proud of it.
     */
    const face = portal + intoRoof * (U.wallThick + P.panelStandOff);
    const y0 = layout.top + 0.02;
    const y1 = layout.top + U.parapetHeight * P.panelHeightFrac;
    if (y1 > y0 + 0.1) {
      // Facing back up the road at the driver — out of the roof, which is
      // where `intoRoof` points. `quad` takes it from here.
      const nrmV = layout.axis === "x"
        ? new THREE.Vector3(intoRoof, 0, 0)
        : new THREE.Vector3(0, 0, intoRoof);
      const S = UV_STRIPE;
      quad(
        at(face, -inner, y0), at(face, inner, y0),
        at(face, inner, y1), at(face, -inner, y1),
        nrmV,
        [[S.u0, S.v1], [S.u1, S.v1], [S.u1, S.v0], [S.u0, S.v0]],
      );
    }
  }

  if (!idx.length) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pos), 3));
  geo.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(nrm), 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(uvs), 2));
  geo.setIndex(idx);
  geo.computeBoundingSphere();

  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.86, metalness: 0.0 });
  mat.name = "CityPortalHazard";
  /*
   * CUTOUT, NOT BLENDED, for the same reason the city's paint is: a transparent
   * surface in this renderer's MRT setup erases the emissive attachment under
   * it, and the chevrons lie on a street that has one. `alphaTest` keeps the
   * whole thing in the opaque pass; the stripe tile is solid, so only the
   * chevrons' background is ever cut.
   */
  mat.alphaTest = 0.5;
  mat.polygonOffset = true;
  mat.polygonOffsetFactor = -2;
  mat.polygonOffsetUnits = -2;

  const map = hazardTexture(P);
  const uGlow = uniform(P.glow);
  if (map) {
    const tex = texture(map);
    mat.colorNode = tex;
    mat.opacityNode = tex.a;
    // Retroreflective at night, the same trick and the same reason as the
    // portal boards — a real hazard marker throws the headlights back at you.
    mat.emissiveNode = Fn(() => {
      const night = uNight ? uNight : uniform(0);
      return tex.rgb.mul(uGlow.mul(night));
    })();
  } else {
    mat.color = new THREE.Color(P.stripeWarm);
  }

  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = "CityPortalHazard";
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  return {
    mesh,
    stats: { draws: 1, tris: idx.length / 3 },
    dispose() {
      geo.dispose();
      mat.dispose();
      map?.dispose();
    },
  };
}
