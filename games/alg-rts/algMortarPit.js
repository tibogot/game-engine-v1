// THE MORTAR PIT, NEW STANDARD (2026-10-11, you: "the mortars… we could make better"). Before: a big
// smooth dome of a berm, a tiny mortar reading as a camera tripod, one ring of kit sandbags.
// Now (algMasonry.js's materials): a LOW berm of the pit's own spoil (gravelly earth, the photo's
// relief), burlap sandbags in two courses on its crest, open at the back; the ammunition — plank
// crates, the rounds in their tubes; the kit keeps what it does well: the 81 mm mortar itself (its
// own mesh: algStructures turns it toward the target) and the red-and-white aiming stakes.
// No floor of its own: the levelled ground is the pit's floor (a disc on it would z-fight).
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { buildMortarPit, grainSack } from "../../v3/render/objects/rtsAlgeria.js";
import { newSite, siteGroup } from "./algMasonry.js";
import { simulatedWallMesh } from "./algSandbags.js";
import { RTS_SCALE } from "./algUnitTypes.js";

function hash01(i, seed) { let h = Math.imul(i + 1, 374761393) ^ Math.imul(seed, 668265263); h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967295; }

/**
 * The berm: a ring of heaped earth from rIn (it meets the pit's floor) to rOut, its crest at rC.
 * World metres. The back (+Z) lower, where the crew comes in.
 */
function berm(rIn, rC, rOut, hC, seed) {
  const n = 56, m = 8, pos = [], idx = [];
  for (let j = 0; j <= m; j++) for (let i = 0; i < n; i++) {
    const a = -(i / n) * Math.PI * 2, f = j / m, r = rIn + (rOut - rIn) * f;   // (a decreasing: faces up)
    const back = Math.max(0, Math.sin(a)) ** 2;                               // +Z: the way in, lower
    const crest = r < rC ? Math.sin(((r - rIn) / (rC - rIn)) * Math.PI / 2) : Math.cos(((r - rC) / (rOut - rC)) * Math.PI / 2) ** 1.4;
    const wob = 1 + (hash01(i * 7 + j, seed) - 0.5) * 0.18;
    const y = (j === 0 || j === m ? -0.12 : -0.12 + (hC + 0.12) * crest * wob * (1 - 0.55 * back));
    pos.push(Math.cos(a) * r, y, Math.sin(a) * r);
  }
  for (let j = 0; j < m; j++) for (let i = 0; i < n; i++) {
    const a = j * n + i, b = j * n + ((i + 1) % n), c = (j + 1) * n + ((i + 1) % n), d = (j + 1) * n + i;
    idx.push(a, d, c, a, c, b);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

export function buildMortarPitV2({ seed = 31 } = {}) {
  // The kit's piece: the mortar (userData.gun) and the stakes only.
  const kit = buildMortarPit({ seed, modern: true });
  // The mortar at the MORTAR TEAMS' 81 mm size (its mouth ~1.17 m up: algMortarTeam mortierFr). It was
  // drawn 1.35× (mouth 1.93 m, 2026-10-11, "a true 81 read as a tripod"): its kneeling loader could not
  // reach the mouth (you, 2026-10-16). Its own copy: the kit's geometry may be shared.
  const PIECE = 0.82;
  kit.userData.gun = { ...kit.userData.gun, geo: kit.userData.gun.geo.clone().scale(PIECE, PIECE, PIECE), muzzle: kit.userData.gun.muzzle.map((v) => v * PIECE) };
  const site = newSite();
  const rIn = 2.35, rC = 2.85, rOut = 3.75, hC = 0.5;
  site.spoil.push(berm(rIn, rC, rOut, hC, seed));
  // THE SANDBAGS on the crest: two courses, staggered, shoulder to shoulder; open at the back —
  // simulated in Blender (sandbagWall.py "pit") when loaded, else the kit's grain sacks.
  const simBags = simulatedWallMesh("SandbagPit", "pit");
  for (let c = 0; c < (simBags ? 0 : 2); c++) {
    const rad = rC - 0.05 - c * 0.06, n = Math.round((2 * Math.PI * rad) / 0.6);
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2 + (c % 2) * (Math.PI / n);
      if (Math.sin(a) > 0.8) continue;   // the way in (+Z)
      const g = grainSack(0.66, 0.26, 0.4, seed + c * 61 + k).rotateY(-a + Math.PI / 2 + (hash01(k, seed + c) - 0.5) * 0.15);
      site.hessian.push(g.translate(Math.cos(a) * rad, hC - 0.06 + c * 0.22, Math.sin(a) * rad));
    }
  }
  // THE AMMUNITION at the back: crates (one on another), the rounds' tubes stacked beside.
  for (let k = 0; k < 3; k++) site.planks.push(new THREE.BoxGeometry(0.9, 0.34, 0.52).rotateY((hash01(k + 9, seed) - 0.5) * 0.25).translate(-1.15 + (k % 2) * 0.06, 0.17 + Math.floor(k / 2) * 0.34, 1.6 + (k === 1 ? 0.6 : 0)));
  for (let r = 0; r < 3; r++) for (let i = 0; i < 3 - r; i++) {
    // (at 1.2 / 1.5 the stack ran into the parapet's bags — 2026-10-17: pulled in, clear of them)
    site.metal.push(new THREE.CylinderGeometry(0.075, 0.075, 0.7, 8).rotateX(Math.PI / 2).translate(0.85 + i * 0.16 + r * 0.08, 0.08 + r * 0.135, 1.1));
  }
  const { group } = siteGroup(site, "MortarPit");
  // THE BERM at every distance (you, 2026-10-19: zoomed out, the ring of bags floated): "spoil" is in
  // siteGroup's DETAIL level (gone past 70 m — meant for small heaps), but here it is the pit itself.
  const bermMesh = group.getObjectByName("MortarPit:spoil");
  if (bermMesh) group.add(bermMesh);
  // The placement ghost's shape (algBuild): everything merged, positions only.
  const all = [];
  group.traverse((o) => { if (o.isMesh) { const g = new THREE.BufferGeometry(); g.setAttribute("position", o.geometry.attributes.position); g.setIndex(o.geometry.index); all.push(g); } });
  kit.userData.ghost = mergeGeometries(all);
  if (simBags) group.add(simBags);
  kit.userData.extra = [group];
  kit.userData.footprint = { cx: 0, cz: 0, hx: rOut, hz: rOut };
  kit.userData.height = 1.4;
  // ITS CREW (algBuild places them when the pit is finished): the gunner and the loader — where they
  // start; once it is built they follow the piece as it turns (pitCrewPlace).
  kit.userData.crew = [{ x: 0.95, z: 0.35, yaw: Math.PI }, { x: -0.55, z: 1.25, yaw: Math.PI * 0.75 }];
  return kit;
}

// Where the crew kneel by the piece: the mortar team's (algMortarTeam.js) — the loader his palms'
// reach from the mouth, on a flank; the gunner behind the baseplate, a little to the same side.
const REACH = 0.64 * RTS_SCALE, GUNNER_BACK = 0.6 * RTS_SCALE, GUNNER_SIDE = 0.14 * RTS_SCALE;
const _m = new THREE.Vector3(), _b = new THREE.Vector3(), _cd = new THREE.Vector3();

/** The mouth of the pit's mortar, in the world (where a bomb leaves). `gun`: the pit's Gun mesh. */
export function pitMouth(mesh, gun, out = new THREE.Vector3()) {
  const mz = mesh.geometry.userData.gun?.muzzle;
  return mz ? gun.localToWorld(out.set(mz[0], mz[1], mz[2])) : gun.getWorldPosition(out).add(_b.set(0, 1.2, 0));
}

/**
 * THE CREW FOLLOW THE PIECE (2026-10-16, you: "the loader isn't at the mouth"): the mortar turns to
 * each target, the figures stood where the pit was built — the loader by the crates, metres from the
 * tube. Every frame, from the gun's turn: the loader beside the mouth facing it, the gunner behind the
 * baseplate facing the tube. The flank: the one away from the camera (the tube not hidden behind the
 * men), chosen while the piece TURNS and kept while it is laid (no swap mid-round). `turning`: the gun
 * still swinging to its target.
 */
export function pitCrewPlace(app, mesh, gun, turning = false) {
  const figs = mesh?.userData?.crewFigures;
  if (!figs?.length || !gun) return;
  const Y = mesh.rotation.y + gun.rotation.y, fx = -Math.sin(Y), fz = -Math.cos(Y);   // the barrel: local −Z
  const rx = -fz, rz = fx;                                                             // its right
  if (mesh.userData.crewFlank == null || turning) {
    app.camera?.getWorldDirection?.(_cd);
    mesh.userData.crewFlank = rx * _cd.x + rz * _cd.z >= 0 ? 1 : -1;
  }
  const k = mesh.userData.crewFlank;
  gun.getWorldPosition(_b);
  pitMouth(mesh, gun, _m);
  const H = (x, z) => app.getWorldHeight?.(x, z) ?? _b.y;
  const put = (f, x, z, lx, lz) => { f.x = x; f.z = z; f.y = H(x, z); f.yaw = Math.atan2(lx - x, lz - z); };
  const gunner = figs[0], loader = figs[1];
  put(gunner, _b.x - fx * GUNNER_BACK + rx * k * GUNNER_SIDE, _b.z - fz * GUNNER_BACK + rz * k * GUNNER_SIDE, _b.x + fx * 0.3, _b.z + fz * 0.3);
  if (loader) put(loader, _m.x + rx * k * REACH, _m.z + rz * k * REACH, _m.x, _m.z);
}

/**
 * THE PIT'S CREW AT EACH ROUND (2026-10-16 — the mortar teams' clips, now on the pit's two figures:
 * algBuild gives them the role "mortarRest"). The loader drops the bomb in — his clip started just
 * before its drop (the round is already leaving) — ducks, and kneels at rest again; the gunner lays the
 * piece for a few seconds after. `mesh`: the pit (its userData.crewFigures).
 */
export function pitCrewShot(app, mesh) {
  const figs = mesh?.userData?.crewFigures, R = app.algUnitRenderer;
  if (!figs?.length || !R?.setStaticClip) return;
  const loader = figs[1] ?? figs[0];
  R.setStaticClip(loader, "mortarLoad", { t0: 1.15, then: "mortarRest", after: 1.25 });
  if (figs[1]) R.setStaticClip(figs[0], "mortarLay", { then: "mortarRest", after: 6 });
}
