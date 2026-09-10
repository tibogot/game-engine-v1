import * as THREE from "three";
import { Fn, mix, positionWorld, texture, uniform, vec3, vec4 } from "three/tsl";

/**
 * The blue direction board over a tunnel mouth.
 *
 * ── WHY IT IS A BAND AND NOT A GANTRY PANEL ──────────────────────────────────
 * The city already draws proper overhead gantries (modularRoadCityGantry.js),
 * and the obvious move was to hang one of those here. The geometry says no.
 *
 * The bore's crown sits `tunnelHeight` above the road — 5.6 m — and the street
 * runs at `depth` above that same road, 6.5 m. So the headwall between the top
 * of the arch and the pavement is 0.92 m tall, and a gantry panel is 2.7 m. The
 * alternative, hanging one INSIDE the tunnel, puts its bottom edge 2.7 m over
 * the carriageway, which is under half the clearance a real one keeps and reads
 * as a mistake to anyone who has driven under a real one.
 *
 * A band is what actually goes there. Portal signage on a real underpass is
 * wide and short for exactly this reason — the wall it is bolted to is wide and
 * short — and it carries the route, the destination and the headroom rather
 * than a lane diagram. So this is not a compromise standing in for a gantry; it
 * is the sign that belongs on a portal.
 *
 * ── COST ─────────────────────────────────────────────────────────────────────
 * Both boards are one merged geometry: eight triangles, one draw, one 1024x96
 * canvas texture. No instancing, because two of a thing is not worth an
 * instanced mesh's attribute plumbing.
 */
export const PORTAL_SIGN_DEFAULTS = {
  /** How much of the headwall band the board takes up, and how wide it runs. */
  width: 11.0,
  heightFrac: 0.72,
  /** Stand-off from the headwall, so it reads as bolted on rather than painted. */
  standOff: 0.09,
  /** Signs are retroreflective; at night the headlights find them. This is the
   *  floor that keeps one legible when nothing is pointing at it. */
  glow: 0.35,
  colorBlue: 0x14357a,
  text: "CITY CENTRE",
  route: "A12",
  headroom: "5.4m",
};

/** The artwork: one strip, drawn once, shared by both boards. */
function signTexture(P, aspect) {
  /*
   * THE CANVAS TAKES ITS SHAPE FROM THE BOARD, never the other way round. The
   * band's height falls out of `depth` and `tunnelHeight`, so a fixed canvas
   * would stretch the lettering by whatever those happen to be — the same trap
   * the gantry atlas warns about, and the kind of wrong that is obvious on
   * screen and invisible in the source.
   */
  const W = 1024, H = Math.max(48, Math.round(W / aspect));
  const cv = typeof document !== "undefined" ? document.createElement("canvas") : null;
  if (!cv) return null;
  cv.width = W; cv.height = H;
  const c = cv.getContext("2d");
  if (!c) return null;

  const blue = `#${P.colorBlue.toString(16).padStart(6, "0")}`;
  const mid = H / 2;
  const pad = Math.round(H * 0.14);
  c.fillStyle = blue;
  c.fillRect(0, 0, W, H);
  // The white keyline every European direction board has, inset from the edge.
  c.strokeStyle = "#eef2f7";
  c.lineWidth = Math.max(3, Math.round(H * 0.06));
  c.strokeRect(pad, pad, W - pad * 2, H - pad * 2);

  c.textBaseline = "middle";
  const big = Math.round(H * 0.46);

  // Route badge, left.
  const bw = Math.round(H * 1.9), bh = Math.round(H * 0.56);
  c.fillStyle = "#eef2f7";
  c.fillRect(pad * 2.2, mid - bh / 2, bw, bh);
  c.fillStyle = blue;
  c.font = `bold ${Math.round(H * 0.4)}px system-ui, sans-serif`;
  c.textAlign = "center";
  c.fillText(P.route, pad * 2.2 + bw / 2, mid);

  // Destination.
  c.fillStyle = "#eef2f7";
  c.font = `bold ${big}px system-ui, sans-serif`;
  c.textAlign = "left";
  c.fillText(P.text, pad * 2.2 + bw + H * 0.5, mid);

  // Straight-on arrow, centre-right.
  const ax = W * 0.66, ay = mid, r = H * 0.3;
  c.beginPath();
  c.moveTo(ax, ay - r);
  c.lineTo(ax + r, ay);
  c.lineTo(ax + r * 0.42, ay);
  c.lineTo(ax + r * 0.42, ay + r);
  c.lineTo(ax - r * 0.42, ay + r);
  c.lineTo(ax - r * 0.42, ay);
  c.lineTo(ax - r, ay);
  c.closePath();
  c.fill();

  // Headroom, right — the one number a tunnel sign always carries.
  c.font = `bold ${Math.round(H * 0.42)}px system-ui, sans-serif`;
  c.textAlign = "right";
  c.fillText(P.headroom, W - pad * 2.2, mid);

  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/**
 * @param {object} opts
 * @param {ReturnType<typeof import("./modularRoadCityUnderpass.js").underpassLayout>} opts.layout
 * @param {*} [opts.uNight] 0 by day, 1 at night — drives the retroreflective lift.
 */
export function createPortalSigns({ layout, uNight = null, params = {} }) {
  if (!layout) return null;
  const P = { ...PORTAL_SIGN_DEFAULTS, ...params };
  const U = layout.params;

  /*
   * THE BAND, MEASURED FROM THE TUNNEL RATHER THAN GUESSED. Crown to street is
   * whatever `depth` and `tunnelHeight` happen to be; the board takes a share
   * of it and sits centred, so changing either dimension moves the sign with
   * the wall instead of leaving it floating or buried.
   */
  const crownY = layout.roadY + U.tunnelHeight;
  const band = layout.top - crownY;
  if (band < 0.35) return null;                 // no wall to bolt it to
  const h = band * P.heightFrac;
  const midY = (crownY + layout.top) / 2;

  const geoms = [];
  for (const [along, dir] of [[layout.cov0, -1], [layout.cov1, 1]]) {
    const g = new THREE.PlaneGeometry(P.width, h);
    /*
     * FACING OUT OF THE TUNNEL, which is the only side it is read from.
     *
     * `dir` is which way "out" is at this portal: -1 at the entry, +1 at the
     * exit. A PlaneGeometry faces +Z, so the ENTRY board is the one that has to
     * turn round — it was the other way about at first, and both boards ended
     * up facing into the tunnel where they are back-faces and drawn for nobody.
     */
    if (layout.axis === "x") g.rotateY(dir > 0 ? Math.PI / 2 : -Math.PI / 2);
    else if (dir < 0) g.rotateY(Math.PI);
    const off = P.standOff * dir;
    g.translate(
      layout.axis === "x" ? along + off : layout.across,
      midY,
      layout.axis === "x" ? layout.across : along + off,
    );
    geoms.push(g);
  }
  const geo = mergeTwo(geoms);
  for (const g of geoms) g.dispose();

  const map = signTexture(P, P.width / h);
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.42, metalness: 0.0 });
  mat.name = "CityPortalSign";
  const uGlow = uniform(P.glow);
  if (map) {
    const tex = texture(map);
    mat.colorNode = tex;
    /*
     * RETROREFLECTIVE, CHEAPLY. A real board throws the headlights straight
     * back at you, which no BRDF here models. Lifting the emissive at night by
     * a fixed amount gets the read — legible in the dark, not a lamp — for the
     * cost of one lerp, and keeps it out of the daytime image entirely.
     */
    mat.emissiveNode = Fn(() => {
      const night = uNight ? uNight : uniform(0);
      return tex.rgb.mul(uGlow.mul(night));
    })();
  } else {
    mat.color = new THREE.Color(P.colorBlue);
  }
  void positionWorld; void mix; void vec3; void vec4;

  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = "CityPortalSign";
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  return {
    mesh,
    stats: { draws: 1, tris: geo.index ? geo.index.count / 3 : geo.attributes.position.count / 3 },
    dispose() {
      geo.dispose();
      mat.dispose();
      map?.dispose();
    },
  };
}

/** Two plane geometries into one buffer, without dragging in BufferGeometryUtils. */
function mergeTwo(list) {
  let vTotal = 0, iTotal = 0;
  for (const g of list) {
    vTotal += g.attributes.position.count;
    iTotal += g.index.count;
  }
  const pos = new Float32Array(vTotal * 3);
  const nrm = new Float32Array(vTotal * 3);
  const uvs = new Float32Array(vTotal * 2);
  const idx = new Uint16Array(iTotal);
  let vo = 0, io = 0;
  for (const g of list) {
    const p = g.attributes.position, n = g.attributes.normal, u = g.attributes.uv, ix = g.index;
    pos.set(p.array, vo * 3);
    nrm.set(n.array, vo * 3);
    uvs.set(u.array, vo * 2);
    for (let i = 0; i < ix.count; i++) idx[io + i] = ix.getX(i) + vo;
    vo += p.count; io += ix.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  out.setAttribute("normal", new THREE.BufferAttribute(nrm, 3));
  out.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  return out;
}
