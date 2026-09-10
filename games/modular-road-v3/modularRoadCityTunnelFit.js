import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { Fn, texture, uniform } from "three/tsl";

/**
 * The fit-out of a road tunnel: the things bolted to it that make it read as
 * infrastructure rather than as a hole.
 *
 * ── WHY THIS IS ONE MODULE AND NOT FOUR ──────────────────────────────────────
 * Jet fans, sign gantries, cable trays and emergency niches are four different
 * objects, and every one of them is a handful of boxes and cylinders in grey
 * steel. Built separately they would be four draw calls and four places to get
 * the tunnel's dimensions from. Built together they are TWO — one merged
 * structure mesh, one merged emissive mesh — and the geometry is read once from
 * the bore the vault was swept from, so every piece moves if the tunnel is
 * resized and nothing has to be kept in step by hand.
 *
 * ── EVERYTHING IS MEASURED OFF THE BORE ──────────────────────────────────────
 * Nothing here has a hard-coded height. The crown, the springing and the wall
 * line all come from the profile, and clearance is subtracted from the crown
 * rather than assumed — which is what stops a sign that fits today from hanging
 * in the carriageway the first time `tunnelHeight` changes.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ────────────────────────────────────────────
 * No lights. Real jet fans and niches are lit, and adding real ones would
 * recompile every shader in the scene the moment one was toggled (see the note
 * on `Light.visible`). The emissive mesh carries the read instead, which is
 * what the vault's own battens already do.
 */

export const TUNNEL_FIT_DEFAULTS = {
  /** Headroom kept clear under anything that hangs, metres. */
  clearance: 4.2,

  /** Jet fans: pairs of them, this far apart along the tunnel. */
  fanSpacing: 78,
  fanRadius: 0.52,
  fanLength: 2.6,
  /** How far out from the centreline each fan of a pair sits, as a fraction of
   *  the bore's half width. Real ones live in the haunch, not on the crown. */
  fanOut: 0.52,

  /** Overhead direction boards. */
  signSpacing: 132,
  signWidth: 2.1,
  signHeight: 1.5,
  signThick: 0.11,
  /** The two hangers that hold it up. */
  poleRadius: 0.055,

  /** Cable trays down both walls, just under the springing. */
  trayWidth: 0.34,
  trayHeight: 0.13,
  trayDrop: 0.55,

  /** Emergency niches. */
  sosSpacing: 156,
  sosWidth: 1.15,
  sosHeight: 1.5,
  sosDepth: 0.28,

  /**
   * Galvanised steel in a dark tunnel, which is darker than "grey" suggests.
   * At 0x9aa0a6 the cable trays came out the brightest thing in the bore after
   * the neon itself and read as a second light strip; a tray is a channel you
   * barely notice, and noticing it was the tell.
   */
  colorSteel: 0x70757c,
  /**
   * A floor under the emissive so the fans and hangers have a silhouette at
   * all. Real ones are lit by the battens a metre away, which nothing here
   * models — this is the cheapest honest stand-in, and it is small enough that
   * the tunnel stays dark.
   */
  steelGlow: 0.05,
  colorDark: 0x5a5f66,
  colorSos: 0xff7a1a,
  signText: ["CENTRE", "NORD"],
};

/** The overhead board's artwork — the blue road sign, in a squarer format. */
function boardTexture(P, aspect) {
  const W = 512, H = Math.max(64, Math.round(W / aspect));
  const cv = typeof document !== "undefined" ? document.createElement("canvas") : null;
  if (!cv) return null;
  cv.width = W; cv.height = H;
  const c = cv.getContext("2d");
  if (!c) return null;
  const blue = "#14357a", ink = "#eef2f7";
  c.fillStyle = blue;
  c.fillRect(0, 0, W, H);
  const pad = Math.round(H * 0.07);
  c.strokeStyle = ink;
  c.lineWidth = Math.max(3, Math.round(H * 0.028));
  c.strokeRect(pad, pad, W - pad * 2, H - pad * 2);

  c.textBaseline = "middle";
  c.fillStyle = ink;
  const rows = P.signText.length;
  const rowH = (H - pad * 2) / rows;
  for (let i = 0; i < rows; i++) {
    const y = pad + rowH * (i + 0.5);
    c.font = `bold ${Math.round(rowH * 0.42)}px system-ui, sans-serif`;
    c.textAlign = "left";
    c.fillText(P.signText[i], pad * 2.4, y);
    // An arrow per destination, right-aligned: up for straight on, and the
    // second one turns off. Two lines is what a real board this size carries.
    const ax = W - pad * 3.2, r = rowH * 0.22;
    c.beginPath();
    if (i === 0) {
      c.moveTo(ax, y - r); c.lineTo(ax + r, y); c.lineTo(ax + r * 0.4, y);
      c.lineTo(ax + r * 0.4, y + r); c.lineTo(ax - r * 0.4, y + r);
      c.lineTo(ax - r * 0.4, y); c.lineTo(ax - r, y);
    } else {
      c.moveTo(ax + r, y - r * 0.2); c.lineTo(ax, y - r); c.lineTo(ax, y - r * 0.5);
      c.lineTo(ax - r, y - r * 0.5); c.lineTo(ax - r, y + r * 0.5);
      c.lineTo(ax + r * 0.1, y + r * 0.5); c.lineTo(ax + r * 0.1, y + r * 0.2);
    }
    c.closePath();
    c.fill();
  }
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/**
 * @param {object} opts
 * @param {ReturnType<typeof import("./modularRoadCityUnderpass.js").underpassLayout>} opts.layout
 * @param {{inner: {x: number, y: number}[]}} opts.profiles the vault's own bore
 * @param {THREE.Material} [opts.glowMaterial] the tunnel's own emissive
 */
export function createTunnelFitOut({ layout, profiles, glowMaterial = null, params = {} }) {
  if (!layout || !profiles?.inner?.length) return null;
  const P = { ...TUNNEL_FIT_DEFAULTS, ...params };

  /*
   * THE BORE, AS THE FOUR NUMBERS EVERYTHING HANGS OFF. Read from the profile
   * the vault was swept from, never re-derived: a fit-out that disagrees with
   * the tunnel puts a fan inside the concrete.
   */
  let xo = 0, apex = -Infinity;
  for (const q of profiles.inner) {
    xo = Math.max(xo, Math.abs(q.x));
    apex = Math.max(apex, q.y);
  }
  const spring = Math.min(2.85, Math.max(2.2, (layout.params.tunnelHeight ?? 5.6) * 0.38));
  const ry = Math.max(0.01, apex - spring);
  /** Height of the bore's ceiling at a given distance across the centreline. */
  const ceilAt = (x) => {
    const u = Math.min(1, Math.abs(x) / xo);
    return spring + ry * Math.sqrt(Math.max(0, 1 - u * u));
  };

  const cov0 = layout.cov0, cov1 = layout.cov1;
  const run = cov1 - cov0;
  if (run < 20) return null;

  const structure = [];
  const emissive = [];
  const panels = [];

  /** Place a local-space geometry into the tunnel at `along`, across `x`, up `y`. */
  const put = (geo, along, x, y) => {
    geo.translate(
      layout.axis === "x" ? along : layout.across + x,
      layout.roadY + y,
      layout.axis === "x" ? layout.across + x : along,
    );
    return geo;
  };
  /** A box whose length runs ALONG the tunnel, whatever axis that is. */
  const boxAlong = (len, w, h) => (layout.axis === "x"
    ? new THREE.BoxGeometry(len, h, w) : new THREE.BoxGeometry(w, h, len));

  /*
   * ── CABLE TRAYS ────────────────────────────────────────────────────────────
   *
   * A shallow channel down each wall just under the springing, which is where
   * every real tunnel puts its power and comms. Two long boxes, and it is the
   * single cheapest thing in this file per unit of "this is a real tunnel":
   * it gives the eye a horizontal line to measure the length against.
   */
  for (const s of [-1, 1]) {
    structure.push(put(
      boxAlong(run - 2, P.trayWidth, P.trayHeight),
      cov0 + run / 2, s * (xo - P.trayWidth / 2 - 0.06), spring - P.trayDrop,
    ));
  }

  /*
   * ── JET FANS ───────────────────────────────────────────────────────────────
   *
   * The pair of cylinders overhead is the most recognisable thing in a road
   * tunnel, and they are cheap: a tube, two mounting straps, a dark inlet ring.
   * They sit in the HAUNCH rather than on the crown, which is both where they
   * really go and what keeps them out of the sign's way.
   */
  const fanY = () => {
    const x = xo * P.fanOut;
    return ceilAt(x) - P.fanRadius - 0.12;
  };
  for (let a = cov0 + P.fanSpacing * 0.5; a < cov1 - 4; a += P.fanSpacing) {
    for (const s of [-1, 1]) {
      const x = s * xo * P.fanOut;
      const y = fanY();
      const tube = new THREE.CylinderGeometry(P.fanRadius, P.fanRadius, P.fanLength, 14, 1, true);
      // CylinderGeometry runs along +Y; lay it down the tunnel.
      if (layout.axis === "x") tube.rotateZ(Math.PI / 2); else tube.rotateX(Math.PI / 2);
      structure.push(put(tube, a, x, y));
      // The dark ring at the intake, so the tube does not read as a plain pipe.
      const ring = new THREE.CylinderGeometry(P.fanRadius * 0.82, P.fanRadius * 0.82, 0.1, 14, 1, true);
      if (layout.axis === "x") ring.rotateZ(Math.PI / 2); else ring.rotateX(Math.PI / 2);
      structure.push(put(ring, a - P.fanLength / 2 + 0.06, x, y));
      // Two straps up to the ceiling.
      for (const d of [-1, 1]) {
        const top = ceilAt(x);
        const hgt = Math.max(0.05, top - y - P.fanRadius * 0.2);
        const strap = new THREE.BoxGeometry(0.07, hgt, 0.07);
        structure.push(put(strap, a + d * P.fanLength * 0.3, x, y + P.fanRadius * 0.2 + hgt / 2));
      }
    }
  }

  /*
   * ── OVERHEAD DIRECTION BOARDS ──────────────────────────────────────────────
   *
   * Two hangers off the crown and a panel roughly as tall as it is wide — the
   * squarer format a lane board takes when it carries destinations rather than
   * a lane diagram.
   *
   * The panel's TOP is derived from clearance plus its own height, so the thing
   * that is guaranteed is the gap under it. Hard-coding the top instead is how
   * a sign ends up hanging in the carriageway when the tunnel is made shallower.
   */
  const boardBottom = P.clearance;
  const boardTop = boardBottom + P.signHeight;
  const boardMid = (boardBottom + boardTop) / 2;
  for (let a = cov0 + P.signSpacing * 0.62; a < cov1 - 12; a += P.signSpacing) {
    panels.push(put(boxAlong(P.signThick, P.signWidth, P.signHeight), a, 0, boardMid));
    for (const d of [-1, 1]) {
      const px = d * (P.signWidth / 2 - 0.16);
      const top = ceilAt(px);
      const hgt = Math.max(0.08, top - boardTop);
      structure.push(put(
        new THREE.CylinderGeometry(P.poleRadius, P.poleRadius, hgt, 8),
        a, px, boardTop + hgt / 2,
      ));
    }
  }

  /*
   * ── EMERGENCY NICHES ───────────────────────────────────────────────────────
   *
   * A recessed box in the wall with a lit face. Real ones are the orange thing
   * you notice every hundred metres or so, and they break up a long wall at
   * exactly the rhythm a driver reads as distance travelled.
   *
   * The lit face goes on the EMISSIVE mesh so it is visible in a dark tunnel
   * without a light source, the same trick the battens use.
   */
  for (let a = cov0 + P.sosSpacing * 0.4, k = 0; a < cov1 - 8; a += P.sosSpacing, k++) {
    const s = k % 2 === 0 ? -1 : 1;                       // alternate walls
    const x = s * (xo - P.sosDepth / 2);
    const y = spring - P.trayDrop - P.sosHeight / 2 - 0.35;
    structure.push(put(boxAlong(P.sosWidth, P.sosDepth, P.sosHeight), a, x, y));
    emissive.push(put(
      boxAlong(P.sosWidth * 0.72, 0.03, P.sosHeight * 0.4),
      a, s * (xo - P.sosDepth - 0.02), y + P.sosHeight * 0.18,
    ));
  }

  const group = new THREE.Group();
  group.name = "CityTunnelFit";
  const owned = [];
  const meshes = [];

  const steel = new THREE.MeshStandardNodeMaterial({
    color: new THREE.Color(P.colorSteel), roughness: 0.72, metalness: 0.25,
  });
  steel.name = "CityTunnelFitSteel";
  {
    const c = new THREE.Color(P.colorSteel);
    const g = uniform(P.steelGlow);
    steel.emissiveNode = Fn(() => uniform(c).mul(g))();
  }
  owned.push(steel);

  const addMerged = (list, mat, name, cast) => {
    if (!list.length) return null;
    const geo = list.length === 1 ? list[0] : mergeGeometries(list, false);
    if (list.length > 1) for (const g of list) g.dispose();
    if (!geo) return null;
    const m = new THREE.Mesh(geo, mat);
    m.name = name;
    m.castShadow = !!cast;
    m.receiveShadow = true;
    m.frustumCulled = false;
    group.add(m);
    meshes.push(m);
    return m;
  };

  addMerged(structure, steel, "CityTunnelFitSteel", false);

  if (emissive.length) {
    let mat = glowMaterial;
    if (!mat) {
      mat = new THREE.MeshStandardNodeMaterial({
        color: new THREE.Color(P.colorSos),
        emissive: new THREE.Color(P.colorSos),
        emissiveIntensity: 3.0,
      });
      mat.name = "CityTunnelFitSosFallback";
      owned.push(mat);
    }
    addMerged(emissive, mat, "CityTunnelFitSos", false);
  }

  if (panels.length) {
    const map = boardTexture(P, P.signWidth / P.signHeight);
    const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.45, metalness: 0.0 });
    mat.name = "CityTunnelFitBoard";
    if (map) {
      const tex = texture(map);
      mat.colorNode = tex;
      const uGlow = uniform(0.28);
      // Retroreflective, like the portal band: legible in a dark tunnel without
      // being a lamp.
      mat.emissiveNode = Fn(() => tex.rgb.mul(uGlow))();
    } else {
      mat.color = new THREE.Color(0x14357a);
    }
    owned.push(mat);
    const m = addMerged(panels, mat, "CityTunnelFitBoard", false);
    if (m) m.userData.map = map;
  }

  const tris = (m) => (m.geometry.index
    ? m.geometry.index.count / 3 : m.geometry.attributes.position.count / 3);

  return {
    group,
    stats: {
      draws: meshes.length,
      tris: meshes.reduce((a, m) => a + tris(m), 0),
    },
    dispose() {
      for (const m of meshes) {
        m.geometry.dispose();
        m.userData.map?.dispose();
      }
      for (const m of owned) m.dispose();
    },
  };
}
