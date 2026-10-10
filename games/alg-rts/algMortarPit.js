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
  // The mortar a third bigger than life: at the RTS camera's distance a true 81 mm read as a tripod
  // (CoH's guns are drawn big the same way). Its own copy: the kit's geometry may be shared.
  kit.userData.gun = { ...kit.userData.gun, geo: kit.userData.gun.geo.clone().scale(1.35, 1.35, 1.35) };
  const site = newSite();
  const rIn = 2.35, rC = 2.85, rOut = 3.75, hC = 0.5;
  site.spoil.push(berm(rIn, rC, rOut, hC, seed));
  // THE SANDBAGS on the crest: two courses, staggered, shoulder to shoulder; open at the back.
  for (let c = 0; c < 2; c++) {
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
    site.metal.push(new THREE.CylinderGeometry(0.075, 0.075, 0.7, 8).rotateX(Math.PI / 2).translate(1.2 + i * 0.16 + r * 0.08, 0.08 + r * 0.135, 1.5));
  }
  const { group } = siteGroup(site, "MortarPit");
  // The placement ghost's shape (algBuild): everything merged, positions only.
  const all = [];
  group.traverse((o) => { if (o.isMesh) { const g = new THREE.BufferGeometry(); g.setAttribute("position", o.geometry.attributes.position); g.setIndex(o.geometry.index); all.push(g); } });
  kit.userData.ghost = mergeGeometries(all);
  kit.userData.extra = [group];
  kit.userData.footprint = { cx: 0, cz: 0, hx: rOut, hz: rOut };
  kit.userData.height = 1.4;
  // ITS CREW (algBuild places them when the pit is finished): one at the mortar, one at the rounds.
  kit.userData.crew = [{ x: 0.95, z: 0.35, yaw: Math.PI }, { x: -0.55, z: 1.25, yaw: Math.PI * 0.75 }];
  return kit;
}
