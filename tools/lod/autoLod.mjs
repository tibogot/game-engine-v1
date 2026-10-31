/**
 * AUTO LOD — every far level made FROM its near, never built apart (2026-10-31, you: "make the best tool for this for
 * future use in my games … SOLID with no problems at all").
 *
 * Why: a far level built or baked separately (its own UVs, its own texture region, its own simplified parts) differed
 * from its near every time — white window bars gone brown, a roof that "changes too much", a door's straps. The way the
 * industry avoids it (Simplygon, InstaLOD, Nanite's clusters; meshoptimizer's own guidance): ONE UV layout and ONE
 * texture for every level, the far a SIMPLIFICATION of the near that treats the UV seams and normals as part of its error,
 * and an ERROR BUDGET tied to the screen — the far may move the surface at most what one pixel covers at the distance
 * the game switches. Then:
 *   - colour cannot differ (the same UVs into the same texture);
 *   - shape can differ by at most ~1 px where the switch happens (the bound IS the simplifier's error);
 *   - shading: the near's normals kept on every vertex that stays (simplifyWithAttributes removes vertices, it does not
 *     move them — no "far shades unlike its near").
 *
 *   node tools/lod/autoLod.mjs <in.glb> [out.glb] [--switch 60] [--scale 1.3] [--px 1440] [--fov 26] [--max-ratio 1]
 *
 * For every mesh node <name> with no <name>_Far beside it: <name>_Far, a sibling with the same transform, the same
 * material, the same attributes (positions, normals, UVs, colours … all kept on the kept vertices). Prints
 * AUTOLOD <name> <near tris> -> <far tris> (err <world m>). A far that saves under 10 % is not written (the game uses the
 * near at every distance: nothing to differ).
 *
 * The budget: one pixel at the switch distance — world metres per pixel = 2 · d · tan(fov/2) / screen px — in the GLB's
 * own units (`scale`: the game draws the kit ×1.3, so a kit metre is 1.3 game metres).
 */
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { MeshoptSimplifier } from "meshoptimizer";
import { coplanarOverlaps } from "../lib/coplanar.mjs";

/** Coplanar overlapping triangle pairs (z-fighting) of positions P under index I — the coplanar gate's own test. */
function overlaps(P, I) {
  return coplanarOverlaps({ attributes: { position: { count: P.length / 3, getX: (i) => P[3 * i], getY: (i) => P[3 * i + 1], getZ: (i) => P[3 * i + 2] } },
    index: { count: I.length, getX: (k) => I[k] } }).pairs;
}

/** World metres (the GLB's units) one screen pixel covers at the switch. */
export function pixelError({ switchAt = 60, scale = 1.3, px = 1440, fov = 26, pixels = 1 } = {}) {
  return (pixels * 2 * switchAt * Math.tan((fov * Math.PI) / 360)) / px / scale;
}

/** The far primitive data for one near primitive: { index, keep (old vertex ids), err } or null (nothing gained). */
export function simplifyPrimitive(prim, eps) {
  const pos = prim.getAttribute("POSITION"); if (!pos) return null;
  const n = pos.getCount();
  const P = new Float32Array(n * 3); for (let i = 0; i < n; i++) { const v = pos.getElement(i, []); P.set(v, i * 3); }
  const idxA = prim.getIndices();
  const I = idxA ? Uint32Array.from(idxA.getArray()) : Uint32Array.from({ length: n }, (_, i) => i);
  // the attributes that steer the collapse: normals (an angle) and UVs (in TEXELS of a 2048 atlas) — weighted so a
  // change of ~10° of normal, or of one texel, costs what the position budget allows
  const N = prim.getAttribute("NORMAL"), UV = prim.getAttribute("TEXCOORD_0");
  const stride = (N ? 3 : 0) + (UV ? 2 : 0);
  const A = new Float32Array(Math.max(1, n * stride)), W = [];
  if (N) W.push(...[1, 1, 1].map(() => eps / 0.17));
  if (UV) W.push(...[1, 1].map(() => eps * 2048));
  for (let i = 0; i < n; i++) {
    let o = i * stride;
    if (N) { const v = N.getElement(i, []); A[o++] = v[0]; A[o++] = v[1]; A[o++] = v[2]; }
    if (UV) { const v = UV.getElement(i, []); A[o++] = v[0]; A[o++] = v[1]; }
  }
  // (no LockBorder: a kit mesh's open borders — a wall's foot under the ground — may move within the budget like any edge;
  // ErrorAbsolute: the budget in metres, not relative to the mesh's size)
  const [out, err] = stride
    ? MeshoptSimplifier.simplifyWithAttributes(I, P, 3, A, stride, W, null, 0, eps, ["ErrorAbsolute"])
    : MeshoptSimplifier.simplify(I, P, 3, 0, eps, ["ErrorAbsolute"]);
  if (out.length > I.length * 0.9) return null;
  // (a collapse can fold two triangles onto one plane — z-fighting the near never had: the coplanar gate failed on two of
  // the port's far levels. The caller halves the budget and tries again — 2026-10-31)
  if (overlaps(P, out) > overlaps(P, I)) return { folded: true };
  // compact: the vertices still used, in first-use order
  const remap = new Map(), keep = [];
  const index = new Uint32Array(out.length);
  for (let k = 0; k < out.length; k++) { let j = remap.get(out[k]); if (j === undefined) { j = keep.length; remap.set(out[k], j); keep.push(out[k]); } index[k] = j; }
  return { index, keep, err, before: I.length / 3, after: out.length / 3 };
}

/** Adds the far levels to a gltf-transform Document. Returns [{ name, near, far, err }]. */
export async function addFarLevels(doc, opts = {}) {
  await MeshoptSimplifier.ready;
  const eps = opts.eps ?? pixelError(opts);
  const root = doc.getRoot(), report = [];
  const names = new Set(root.listNodes().map((nd) => nd.getName()));
  for (const node of root.listNodes()) {
    const mesh = node.getMesh(), name = node.getName();
    if (!mesh || name.endsWith("_Far") || names.has(`${name}_Far`) || (opts.only && !opts.only(name))) continue;
    const far = doc.createMesh(`${mesh.getName() || name}_Far`);
    let near = 0, after = 0, gained = false, err = 0;
    for (const prim of mesh.listPrimitives()) {
      let s = null;
      for (const k of [1, 0.5, 0.25, 0.1]) { s = simplifyPrimitive(prim, eps * k); if (!s?.folded) break; }
      if (s?.folded) s = null;   // (still folding at a tenth of the budget: this primitive kept whole)
      const fp = doc.createPrimitive().setMaterial(prim.getMaterial()).setMode(prim.getMode());
      if (s) {
        gained = true; err = Math.max(err, s.err); near += s.before; after += s.after;
        for (const sem of prim.listSemantics()) {
          const src = prim.getAttribute(sem), size = src.getElementSize(), arr = src.getArray();
          const dst = new arr.constructor(s.keep.length * size);
          for (let i = 0; i < s.keep.length; i++) for (let c = 0; c < size; c++) dst[i * size + c] = arr[s.keep[i] * size + c];
          fp.setAttribute(sem, doc.createAccessor().setType(src.getType()).setArray(dst).setNormalized(src.getNormalized()).setBuffer(src.getBuffer()));
        }
        fp.setIndices(doc.createAccessor().setType("SCALAR").setArray(s.index).setBuffer(prim.getIndices()?.getBuffer() ?? root.listBuffers()[0]));
      } else {   // (this primitive kept whole: its accessors shared with the near)
        const t = (prim.getIndices()?.getCount() ?? prim.getAttribute("POSITION").getCount()) / 3; near += t; after += t;
        for (const sem of prim.listSemantics()) fp.setAttribute(sem, prim.getAttribute(sem));
        if (prim.getIndices()) fp.setIndices(prim.getIndices());
      }
      far.addPrimitive(fp);
    }
    if (!gained || after > near * 0.9) { far.dispose(); report.push({ name, near, far: near, err: 0, skipped: true }); continue; }
    const fn = doc.createNode(`${name}_Far`).setMesh(far).setTranslation(node.getTranslation()).setRotation(node.getRotation()).setScale(node.getScale());
    const parent = node.getParentNode();
    if (parent) parent.addChild(fn); else for (const sc of root.listScenes()) if (sc.listChildren().includes(node)) sc.addChild(fn);
    report.push({ name, near, far: after, err });
  }
  return report;
}

// ── CLI ──
if (process.argv[1]?.replace(/\\/g, "/").endsWith("tools/lod/autoLod.mjs")) {
  const args = process.argv.slice(2), arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? Number(args[i + 1]) : d; };
  const files = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--")));
  if (!files[0]) { console.log("usage: node tools/lod/autoLod.mjs <in.glb> [out.glb] [--switch 60] [--scale 1.3] [--px 1440] [--fov 26]"); process.exit(1); }
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const doc = await io.read(files[0]);
  if (args.includes("--replace")) for (const nd of doc.getRoot().listNodes()) if (nd.getName().endsWith("_Far")) { nd.getMesh()?.dispose(); nd.dispose(); }   // (the old far levels out first)
  const o = { switchAt: arg("--switch", 60), scale: arg("--scale", 1.3), px: arg("--px", 1440), fov: arg("--fov", 26) };
  console.log(`AUTOLOD budget ${(pixelError(o) * 1000).toFixed(1)} mm (1 px at ${o.switchAt} m, fov ${o.fov}, ${o.px} px, x${o.scale})`);
  for (const r of await addFarLevels(doc, o)) console.log(`AUTOLOD ${r.name} ${r.near} -> ${r.far}${r.skipped ? " (kept: under 10 % saved)" : ` (err ${(r.err * 1000).toFixed(1)} mm)`}`);
  await io.write(files[1] ?? files[0], doc);
}
