// THE FRONT'S CAMP, LIVED IN — what turns the résidence and its sheds from
// buildings standing in a meadow into a base. GAME code. Your ask
// (2026-09-26): "enemy base dressing". Run AFTER the jungle canopy and palm
// fringe are painted (they paint over earlier clearings).
//
//   · THE COMPOUND: trampled earth under every shed and down the paths that
//     join them to the résidence (the swept-yard ground decal, in strips),
//     the grass and ferns gone from it.
//   · THE TREES THINNED round it: the palms had swallowed the east wing.
//     A camp under the trees is right — a camp nobody can see from the RTS
//     camera is not; the crowns keep to the edge.
//   · WIRE: concertina coils in a broken arc across the front, the way in
//     left open at the road. One merged mesh.
//   · A CAPTURED M35, stripped: wheels gone, on log blocks, bonnet up,
//     crates of what came off it beside it.
//   · AMMUNITION stacked along the résidence's arcade.
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { buildM35 } from "../../v3/render/objects/rtsVehicles.js";
import { buildCrateStack } from "../../v3/render/objects/rtsFirebaseProps.js";
import { rtsObjectMaterial } from "../../v3/render/objects/rtsObjectProps.js";

const SWEPT = { prefix: "sweptYard", art: { name: "sweptYard (photo)", albedoUrl: "/textures/decals/nam/sweptYard_1.webp", normalUrl: "/textures/decals/nam/sweptYard_1_n.webp" } };

/** A concertina coil run: `pts` a polyline on the ground. One geometry. */
function concertinaGeometry(app, pts, { radius = 0.45, pitch = 0.22 } = {}) {
  const geos = [];
  for (let k = 0; k < pts.length - 1; k++) {
    const a = pts[k], b = pts[k + 1];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    if (len < 0.5) continue;
    const dir = new THREE.Vector3((b.x - a.x) / len, 0, (b.z - a.z) / len);
    const side = new THREE.Vector3(-dir.z, 0, dir.x);
    const turns = Math.floor(len / pitch);
    const helix = [];
    for (let i = 0; i <= turns * 8; i++) {
      const t = i / 8, s = (t * pitch) / len;
      const ang = t * Math.PI * 2;
      const x = a.x + (b.x - a.x) * s, z = a.z + (b.z - a.z) * s;
      const g = app.getWorldHeight(x, z);
      // The coil sags a little between pickets and is squashed flat-ish.
      const r = radius * (0.92 + 0.08 * Math.sin(s * Math.PI * 7));
      helix.push(new THREE.Vector3(
        x + side.x * Math.cos(ang) * r + dir.x * Math.sin(ang) * 0.05,
        g + radius * 0.9 + Math.sin(ang) * r * 0.85,
        z + side.z * Math.cos(ang) * r + dir.z * Math.sin(ang) * 0.05,
      ));
    }
    geos.push(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(helix), helix.length, 0.012, 3, false));
    // Pickets: an angle-iron stake every 3 m.
    for (let d = 0; d <= len; d += 3) {
      const x = a.x + dir.x * d, z = a.z + dir.z * d;
      const post = new THREE.BoxGeometry(0.05, 1.2, 0.05);
      post.translate(x, app.getWorldHeight(x, z) + 0.55, z);
      geos.push(post);
    }
  }
  const g = geos.length ? mergeGeometries(geos.map((q) => (q.index ? q.toNonIndexed() : q)), false) : null;
  g?.computeVertexNormals();
  return g;
}

/**
 * @param app     the engine app
 * @param placed  placedObjects (the camp's pieces are in it)
 * @param camp    { first, last } — the slice of placed.pieces that is the camp
 */
export async function dressEnemyCamp(app, placed, camp) {
  const hq = app.structures?.enemyBase?.position;
  if (!hq) return null;
  const pieces = placed.pieces.slice(camp.first, camp.last);
  const out = { yards: 0, wire: 0 };

  // ── The trees thinned, the compound's floor trampled ─────────────────────
  // Crowns stay beyond ~40 m; inside, only scattered bananas and the camp's
  // own bamboo. Round each shed a wider clear.
  for (let r = 0; r <= 42; r += 7) {
    const n = Math.max(1, Math.round((2 * Math.PI * r) / 8));
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2;
      app.clearVegetation?.(hq.x + Math.cos(a) * r, hq.z + Math.sin(a) * r, 7, { edge: 2 });
    }
  }
  const decals = app.decals;
  let slot = decals?.textures?.slots?.findIndex((s) => s.name.startsWith(SWEPT.prefix)) ?? -1;
  if (decals && slot < 0) { await decals.addSlot(SWEPT.art); slot = decals.textures.slots.length - 1; }
  const yard = (x, z, sx, sz, rotY = 0) => {
    if (!decals || slot < 0) return;
    decals.add({
      px: x, py: app.getWorldHeight(x, z), pz: z,
      qx: 0, qy: Math.sin(rotY / 2), qz: 0, qw: Math.cos(rotY / 2),
      slot, sx, sy: 4, sz, opacity: 1, roughness: 0.92, normalStrength: 1, angleFade: 55, edgeFade: 0.02, priority: -1,
    });
    // Trampled: the grass goes too, in the patch's solid core, stepped along
    // its long axis (a path is a strip, not a disc).
    const r = Math.min(sx, sz) * 0.32, long = Math.max(sx, sz) * 0.36;
    const ux = sx >= sz ? Math.cos(rotY) : Math.sin(rotY), uz = sx >= sz ? -Math.sin(rotY) : Math.cos(rotY);
    for (let d = -long + r; d <= long - r + 1e-6; d += Math.max(1, r)) {
      app.clearVegetation?.(x + ux * d, z + uz * d, r, { grass: r, edge: 0.6 });
    }
    out.yards++;
  };
  // Under the résidence's forecourt, and round every shed.
  yard(hq.x, hq.z - 14, 26, 16);
  for (const p of pieces) {
    const { px, pz, hx, hz } = p.fp;
    if (hx < 1.2 && hz < 1.2) continue;            // a jar or a foxhole: no yard
    yard(px, pz, Math.min(16, 2 * hx + 6), Math.min(16, 2 * hz + 6), p.rotY);
  }
  // Paths: worn from the EDGE of the forecourt (not all from one point: a
  // starburst reads as drawn), wandering a little, to each building.
  let pseed = 17;
  const prnd = () => ((pseed = (pseed * 16807) % 2147483647) / 2147483647);
  for (const p of pieces) {
    const { px, pz, hx, hz } = p.fp;
    if (hx < 2 && hz < 2) continue;
    // The forecourt is a 26 x 16 m ellipse round (hq.x, hq.z - 14).
    const fx = hq.x, fz = hq.z - 14;
    const ang = Math.atan2((pz - fz) / 8, (px - fx) / 13);
    const ax = fx + Math.cos(ang) * 12, az = fz + Math.sin(ang) * 7.5;
    const len = Math.hypot(px - ax, pz - az);
    if (len < 6) continue;
    const nx = -(pz - az) / len, nz = (px - ax) / len;          // across the path
    const amp = 1.5 + prnd() * 2.5, ph = prnd() * 6.28;
    const at = (d) => {
      const f = d / len, w = Math.sin(f * Math.PI) * Math.sin(f * 5 + ph) * amp;
      return { x: ax + (px - ax) * f + nx * w, z: az + (pz - az) * f + nz * w };
    };
    for (let d = 0; d < len - 3; d += 4.5) {
      const q0 = at(d), q1 = at(Math.min(len, d + 4.5));
      yard((q0.x + q1.x) / 2, (q0.z + q1.z) / 2, 3.6, 8, Math.atan2(q1.x - q0.x, q1.z - q0.z));
    }
  }

  // ── Wire: a broken arc across the front (−Z), open at the road ───────────
  // Along the whole front, broken wherever it must not run: on the painted
  // track (the way in stays open), on water or steep ground, through a gun
  // position or a building. Runs shorter than 6 m are dropped.
  const R = 62;
  const mat = new THREE.MeshStandardMaterial({ color: 0x4a4a46, roughness: 0.55, metalness: 0.6 });
  mat.name = "Concertina";
  const blockers = [
    ...(app.structures?.list ?? []).filter((q) => q.alive).map((q) => ({ x: q.position.x, z: q.position.z, r: 9 })),
    ...placed.pieces.map((q) => ({ x: q.fp.px, z: q.fp.pz, r: Math.hypot(q.fp.hx, q.fp.hz) + 2 })),
  ];
  const wireOk = (x, z) => {
    const w = app.samplePaintWeights?.(x, z);
    if (w && w[4] > 0.25) return false;                                  // the dirt track
    if ((app.getWaterLevelAt?.(x, z) ?? -Infinity) > app.getWorldHeight(x, z) - 0.3) return false;
    if (app.getWorldNormal(x, z).y < 0.8) return false;
    return !blockers.some((q) => (q.x - x) ** 2 + (q.z - z) ** 2 < q.r * q.r);
  };
  const runs = [];
  let cur = [];
  for (let a = -2.7; a <= -0.45 + 1e-6; a += 0.03) {
    const x = hq.x + Math.cos(a) * R, z = hq.z + Math.sin(a) * R;
    if (wireOk(x, z)) cur.push({ x, z });
    else { if (cur.length) runs.push(cur); cur = []; }
  }
  if (cur.length) runs.push(cur);
  for (const pts of runs) {
    if (pts.length < 4) continue;                                        // < ~6 m
    const geo = concertinaGeometry(app, pts);
    if (!geo) continue;
    const m = new THREE.Mesh(geo, mat);
    m.name = "Concertina";
    m.castShadow = true; m.receiveShadow = true;
    app.scene.add(m);
    for (const q of pts) app.clearVegetation?.(q.x, q.z, 2.2, { grass: 1.6 });
    out.wire++;
  }

  // ── The captured truck, stripped, and the ammunition ─────────────────────
  const items = [];
  const kitMesh = (geo) => new THREE.Mesh(geo, rtsObjectMaterial());
  const truckGeo = buildM35({ seed: 351 });          // the hull alone: its wheels are gone
  const truck = kitMesh(truckGeo);
  truck.rotation.z = 0.03;
  // On blocks: the hull stands 0.35 m lower than on its wheels would put it.
  const t = { x: hq.x + 30, z: hq.z - 22 };
  items.push({ obj: truck, x: t.x, z: t.z, rotY: 0.55, clear: 5, cover: true, nav: true, merge: false });
  // What came off it, and the rounds for the guns.
  items.push({ obj: kitMesh(buildCrateStack({ seed: 71 })), x: t.x - 4, z: t.z - 3, rotY: 0.2, clear: 2 });
  items.push({ obj: kitMesh(buildCrateStack({ seed: 73 })), x: t.x - 5.5, z: t.z - 0.5, rotY: 1.1, clear: 2 });
  for (let k = 0; k < 3; k++) {
    items.push({ obj: kitMesh(buildCrateStack({ seed: 80 + k })), x: hq.x - 7 + k * 5, z: hq.z - 9.5, rotY: (k - 1) * 0.15, clear: 1.5 });
  }
  await placed.place(items);
  // The hull sat on its pad at wheel height: down onto its blocks.
  truck.position.y -= 0.35;
  truck.updateMatrixWorld(true);
  yard(t.x, t.z, 14, 12, 0.55);
  return out;
}
