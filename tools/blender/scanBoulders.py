"""THE BIG LOOSE STONES FROM SCANS (2026-10-22, you: the game's big stones "look like eggs, not realistic AAA at all";
the small ones are fine). The 0.6-1.5 m lumps and boulders of algStones.js become Poly Haven CC0 scans
(assets-src/scans/polyhaven/) — REBUILT the way a game rock is made, not decimated:

  1 THE SCAN    imported (15-25k triangles, an OPEN shell: scanned lying on the ground), resting as it was scanned
                (only turned about the vertical: its longest side along X), its longest side scaled to 1 m.
  2 THE LOW     a WATERTIGHT mesh round it: the scan's convex hull, remeshed into even triangles, SHRINKWRAPPED onto the
                scan's surface (its dents and ridges back), then simplified to `TRIS`. Closed underneath — the first
                version (the scan itself decimated to 380 and its hole filled) was a torn tent with a hole (you, close up).
  3 THE BAKE    the full scan's COLOUR and its SURFACE (normal map: every crack and grain of the 25k-triangle original)
                baked onto the low one's own new UVs (Cycles, selected → active), 512 px each.

  "C:/Program Files/Blender Foundation/Blender 5.0/blender.exe" -b --factory-startup --python tools/blender/scanBoulders.py -- <out.glb>
  then: node tools/optimizeGlb.mjs <out.glb> public/models/alg/boulders.glb

Meshes Boulder00 … BoulderNN, each its own material (map + normalMap).
"""
import bpy, bmesh, os, sys, math
import numpy as np
from mathutils import Matrix, Vector

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SCANS = os.path.join(ROOT, "assets-src", "scans", "polyhaven")
OUT = sys.argv[sys.argv.index("--") + 1] if "--" in sys.argv else os.path.join(ROOT, "public", "models", "alg", "boulders_raw.glb")
TRIS = 800
TEX = 512
# (boulder_01: a hollow lichened boulder in loose triangles; stone_01: a flat cobble — not boulders; rock_07: a dark
# basalt, mean 0.18 — black in the game against the Aurès limestone, seen)
# (2026-10-22: the Namaqualand ROCKS — 20 cm chips scanned from above, open shells — scaled to boulders showed holes,
# arches and flat sides however rebuilt. These are the Namaqualand BOULDER scans, whole rocks 0.7-3 m, CLOSED all round —
# checked rendered from below; boulder_02, open underneath, left out)
PICK = [
    ("namaqualand_boulder_03", None),
    # ("namaqualand_boulder_04": its flat rust-coloured base stood out as an orange plate however sunk — seen)
    ("namaqualand_boulder_05", None),
    ("namaqualand_boulder_06", None),
]

bpy.ops.wm.read_factory_settings(use_empty=True)
scn = bpy.context.scene
scn.render.engine = "CYCLES"; scn.cycles.device = "CPU"; scn.cycles.samples = 4
scn.render.bake.margin = 6

imported = {}
for scan, _ in PICK:
    if scan in imported: continue
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=os.path.join(SCANS, scan, f"{scan}_2k.gltf"))
    imported[scan] = [o for o in set(bpy.data.objects) - before if o.type == "MESH"]

def select(*objs, active=None):
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs: o.select_set(True)
    bpy.context.view_layer.objects.active = active or objs[0]

def apply(o, mod):
    select(o); bpy.ops.object.modifier_apply(modifier=mod.name)

out = []
for k, (scan, name) in enumerate(PICK):
    hi = imported[scan][0] if name is None else next(x for x in imported[scan] if x.name == name)
    name = name or hi.name
    hi.data.transform(hi.matrix_world); hi.matrix_world = Matrix.Identity(4)
    # as scanned, turned about Z, longest side 1 m, foot on z = 0
    P = np.array([v.co[:] for v in hi.data.vertices]); c = P.mean(0)
    w, V = np.linalg.eigh(np.cov((P - c)[:, :2].T))
    hi.data.transform(Matrix.Rotation(-math.atan2(V[1, 1], V[0, 1]), 4, "Z") @ Matrix.Translation(Vector(-c)))
    P = np.array([v.co[:] for v in hi.data.vertices]); lo_, hi_ = P.min(0), P.max(0)
    s = 1.0 / max(hi_[0] - lo_[0], hi_[1] - lo_[1])
    hi.data.transform(Matrix.Scale(s, 4) @ Matrix.Translation(Vector((-(lo_[0] + hi_[0]) / 2, -(lo_[1] + hi_[1]) / 2, -lo_[2]))))

    # THE LOW: the closed scan itself, VOXEL-REMESHED (one watertight surface, even triangles), then simplified
    me = hi.data.copy(); me.materials.clear()
    lo = bpy.data.objects.new(f"Boulder{k:02d}", me); scn.collection.objects.link(lo)
    rm = lo.modifiers.new("R", "REMESH"); rm.mode = "VOXEL"; rm.voxel_size = 0.012; apply(lo, rm)
    # only the rock's MAIN BODY (a loose fragment in a scan file became a thin orange flap on it — seen)
    bm = bmesh.new(); bm.from_mesh(lo.data)
    parts, seen = [], set()
    for f0 in bm.faces:
        if f0.index in seen: continue
        stack, part = [f0], []
        seen.add(f0.index)
        while stack:
            f = stack.pop(); part.append(f)
            for e in f.edges:
                for g in e.link_faces:
                    if g.index not in seen: seen.add(g.index); stack.append(g)
        parts.append(part)
    keep = max(parts, key=lambda p: sum(f.calc_area() for f in p))
    drop = [f for p in parts if p is not keep for f in p]
    if drop: bmesh.ops.delete(bm, geom=drop, context="FACES")
    bm.to_mesh(lo.data); bm.free()
    print("PARTS", lo.name, len(parts), "kept 1")
    n0 = sum(len(p.vertices) - 2 for p in lo.data.polygons)
    dc = lo.modifiers.new("D", "DECIMATE"); dc.decimate_type = "COLLAPSE"; dc.ratio = min(1.0, TRIS / n0); apply(lo, dc)
    select(lo); bpy.ops.object.shade_smooth()

    # UVs and the bake targets
    select(lo); bpy.ops.object.mode_set(mode="EDIT"); bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.01)
    bpy.ops.object.mode_set(mode="OBJECT")
    mat = bpy.data.materials.new(f"Boulder{k:02d}"); mat.use_nodes = True
    lo.data.materials.append(mat)
    N, L = mat.node_tree.nodes, mat.node_tree.links
    bsdf = N["Principled BSDF"]
    col = bpy.data.images.new(f"Boulder{k:02d}_col", TEX, TEX, alpha=False)
    nor = bpy.data.images.new(f"Boulder{k:02d}_nor", TEX, TEX, alpha=False); nor.colorspace_settings.name = "Non-Color"
    tc = N.new("ShaderNodeTexImage"); tc.image = col
    tn = N.new("ShaderNodeTexImage"); tn.image = nor
    ext = 0.04
    # colour: the scan's base colour only
    select(hi, lo, active=lo); N.active = tc
    scn.render.bake.use_selected_to_active = True; scn.render.bake.cage_extrusion = ext; scn.render.bake.max_ray_distance = 0.25
    scn.render.bake.use_pass_direct = False; scn.render.bake.use_pass_indirect = False; scn.render.bake.use_pass_color = True
    bpy.ops.object.bake(type="DIFFUSE")
    N.active = tn
    bpy.ops.object.bake(type="NORMAL", normal_space="TANGENT")
    # the low's material: its baked colour and normal
    L.new(tc.outputs["Color"], bsdf.inputs["Base Color"])
    nm = N.new("ShaderNodeNormalMap"); L.new(tn.outputs["Color"], nm.inputs["Color"]); L.new(nm.outputs["Normal"], bsdf.inputs["Normal"])
    bsdf.inputs["Roughness"].default_value = 0.95
    px = np.array(col.pixels[:]).reshape(-1, 4)[:, :3]
    print("BAKE", lo.name, "colour mean", np.round(px.mean(0), 3), "black share", round(float((px.sum(1) < 0.02).mean()), 3))
    for img in (col, nor): img.pack()
    out.append(lo)
    print("BOULDER", lo.name, name, tuple(round(x, 3) for x in lo.dimensions), sum(len(p.vertices) - 2 for p in lo.data.polygons))

for o in list(bpy.data.objects):
    if o not in out: bpy.data.objects.remove(o, do_unlink=True)
bpy.ops.export_scene.gltf(filepath=OUT, export_format="GLB", export_apply=True, export_yup=True,
                          export_image_format="JPEG", export_texcoords=True, export_normals=True)
print("GLB", OUT)
