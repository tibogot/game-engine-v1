"""THE SCANNED STONE LIBRARY (2026-10-21, you: "the stones of the sangar look very cheap and not AAA at all" → real scans).
Poly Haven CC0 scans (assets-src/scans/polyhaven/: namaqualand_rocks_01, namaqualand_stones_01, rock_07, stone_01,
boulder_01 — the 2k glTFs) made into a library of DRY-STONE WALL STONES for the Blender pieces (sangar.py, and the
dechra, wells, field walls after it):

  EACH STONE   turned to lie on its broadest face (its principal axes: the longest along X, the thinnest up), its
               foot on z = 0, centred; two levels from the scan's own mesh — NEAR ~180 triangles, FAR ~50 (collapse
               decimation, the scan's UVs kept: its colour, normal and AO maps still fit)
  ITS MATERIAL the scan's, its colour pulled toward the Aurès' limestone (desaturated, tinted, lifted) — the piece's
               bake then takes colour AND NORMALS from it (bkit.bake normals=True)

  "C:/Program Files/Blender Foundation/Blender 5.0/blender.exe" -b --factory-startup --python tools/blender/scanStones.py

Writes assets-src/scans/stones_lib.blend: objects Stone00_Near … StoneNN_Far (hidden templates).
"""
import bpy, os, glob, math
import numpy as np
from mathutils import Matrix, Vector

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SCANS = os.path.join(ROOT, "assets-src", "scans", "polyhaven")
OUT = os.path.join(ROOT, "assets-src", "scans", "stones_lib.blend")
NEAR, FAR = 120, 40   # (180 / 50: a sangar of ~320 stones came to 58k triangles)
TINT = (0.80, 0.74, 0.62)        # linear: the pale limestone the scans' browns and pinks are pulled toward

bpy.ops.wm.read_factory_settings(use_empty=True)

def tintMaterial(m):
    """Base colour = the scan's photo, desaturated, multiplied toward the limestone tint, lifted a little."""
    nt = m.node_tree; N, L = nt.nodes, nt.links
    pb = next(n for n in N if n.type == "BSDF_PRINCIPLED")
    src = pb.inputs["Base Color"].links[0].from_socket if pb.inputs["Base Color"].links else None
    if src is None: return
    hs = N.new("ShaderNodeHueSaturation"); hs.inputs["Saturation"].default_value = 0.35; hs.inputs["Value"].default_value = 1.25
    L.new(src, hs.inputs["Color"])
    mx = N.new("ShaderNodeMix"); mx.data_type = "RGBA"; mx.blend_type = "MULTIPLY"; mx.clamp_factor = True
    mx.inputs[0].default_value = 0.65
    L.new(hs.outputs["Color"], mx.inputs[6]); mx.inputs[7].default_value = (*TINT, 1.0)
    L.new(mx.outputs[2], pb.inputs["Base Color"])

stones = []
for g in sorted(glob.glob(SCANS + "/*/*_2k.gltf")):
    if "boulder" in g: continue   # (a 1.9 m lichened boulder: no wall stone — and it would not decimate)
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=g)
    for o in sorted((x for x in set(bpy.data.objects) - before if x.type == "MESH"), key=lambda x: x.name):
        stones.append(o)
    for m in {s.data.materials[0] for s in stones if s.data.materials}:
        if not m.get("tinted"): tintMaterial(m); m["tinted"] = True

for k, o in enumerate(stones):
    # the world transform into the mesh, then the principal axes: longest → X, middle → Y, thinnest → Z (up)
    o.data.transform(o.matrix_world); o.matrix_world = Matrix.Identity(4)
    P = np.array([v.co[:] for v in o.data.vertices])
    c = P.mean(0); C = np.cov((P - c).T)
    w, V = np.linalg.eigh(C)                       # ascending: V[:, 2] the longest
    R = np.stack([V[:, 2], V[:, 1], V[:, 0]])      # rows: the new X, Y, Z
    if np.linalg.det(R) < 0: R[1] *= -1
    M = Matrix([[*R[0], 0], [*R[1], 0], [*R[2], 0], [0, 0, 0, 1]]) @ Matrix.Translation(Vector(-c))
    o.data.transform(M)
    P = np.array([v.co[:] for v in o.data.vertices])
    lo, hi = P.min(0), P.max(0)
    o.data.transform(Matrix.Translation(Vector((-(lo[0] + hi[0]) / 2, -(lo[1] + hi[1]) / 2, -lo[2]))))
    tris = sum(len(p.vertices) - 2 for p in o.data.polygons)
    for lvl, target in (("Near", NEAR), ("Far", FAR)):
        d = o.copy(); d.data = o.data.copy(); d.name = f"Stone{k:02d}_{lvl}"
        bpy.context.scene.collection.objects.link(d)
        md = d.modifiers.new("D", "DECIMATE"); md.decimate_type = "COLLAPSE"; md.ratio = min(1.0, target / tris)
        bpy.ops.object.select_all(action="DESELECT"); d.select_set(True); bpy.context.view_layer.objects.active = d
        bpy.ops.object.modifier_apply(modifier="D")
        bpy.ops.object.shade_smooth()
        d["scan"] = o.name
        print("STONE", d.name, o.name, tuple(round(x, 3) for x in d.dimensions), sum(len(p.vertices) - 2 for p in d.data.polygons))
    bpy.data.objects.remove(o, do_unlink=True)

for o in bpy.data.objects:
    if o.type != "MESH": bpy.data.objects.remove(o, do_unlink=True)
bpy.ops.file.make_paths_absolute()
bpy.ops.wm.save_as_mainfile(filepath=OUT)
print("LIB", OUT, len(stones), "stones")
