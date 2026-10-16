"""THE APPELÉ FOR MIXAMO'S AUTO-RIGGER (2026-10-15, stage 3). Run on the uniform stage's file:

  "C:/Program Files/Blender Foundation/Blender 5.0/blender.exe" -b --factory-startup \
      assets-src/soldiers/appele2/appele.blend --python tools/blender/soldierMixamoExport.py -- assets-src/soldiers/appele2

Mixamo wants ONE unrigged mesh, standing in an A- or T-pose, facing the front, hands open, with its
texture. This takes the built soldier (body + sealed uniform, its baked colour map), drops the rig, the
armature modifier and every vertex group, and writes <out>/appele_mixamo.fbx (texture embedded). Before
that it CHECKS what the game will draw:
  OPEN EDGES  edges with one face, and which part they sit on (a sealed garment has none)
  CLOSE-UPS   back faces culled, as the game draws them — the sleeves, the collar, the boot tops, under
              the helmet, from several angles each (<out>/check_*.png)
"""
import bpy, bmesh, sys, os, math
from mathutils import Vector

out = os.path.abspath(sys.argv[sys.argv.index("--") + 1] if "--" in sys.argv else "appele2")
src = bpy.data.objects["Appele"]
rig = bpy.data.objects.get("Rig")

# A clean copy: modifiers applied, no rig, no groups.
bpy.ops.object.select_all(action="DESELECT")
dg = bpy.context.evaluated_depsgraph_get()
mesh = bpy.data.meshes.new_from_object(src.evaluated_get(dg))
mesh.transform(src.matrix_world)
man = bpy.data.objects.new("Appele_Mixamo", mesh)
bpy.context.scene.collection.objects.link(man)
for o in list(bpy.data.objects):
    if o is not man:
        bpy.data.objects.remove(o, do_unlink=True)
man.vertex_groups.clear()

# ── Open edges ───────────────────────────────────────────────────────────────
bm = bmesh.new(); bm.from_mesh(mesh)
open_e = [e for e in bm.edges if len(e.link_faces) == 1]
def where(z):
    return "head" if z > 1.45 else "chest/arms" if z > 1.0 else "hips/hands" if z > 0.75 else "legs" if z > 0.25 else "feet"
tally = {}
for e in open_e:
    z = (e.verts[0].co.z + e.verts[1].co.z) / 2
    tally[where(z)] = tally.get(where(z), 0) + 1
tris = sum(len(f.verts) - 2 for f in bm.faces)
# SPIKES: any edge over 30 cm is a broken vertex (a soldier's longest real edge is a few cm)
spikes = sum(1 for e in bm.edges if e.calc_length() > 0.3)
bm.free()
print("SPIKES (edges > 30 cm)", spikes)
print("OPEN EDGES", len(open_e), tally, "TRIS", tris)

# ── Close-ups, back faces culled ─────────────────────────────────────────────
scn = bpy.context.scene
scn.render.engine = "BLENDER_WORKBENCH"
sh = scn.display.shading
sh.light = "STUDIO"; sh.color_type = "TEXTURE"; sh.show_backface_culling = True; sh.show_cavity = False
scn.render.resolution_x, scn.render.resolution_y = 640, 480
world = scn.world or bpy.data.worlds.new("W"); scn.world = world
cd = bpy.data.cameras.new("C"); cd.lens = 70
cam = bpy.data.objects.new("C", cd); scn.collection.objects.link(cam); scn.camera = cam
pts = [v.co for v in mesh.vertices]
H = max(p.z for p in pts)
def shot(name, target, frm):
    cam.location = Vector(frm)
    cam.rotation_euler = (Vector(target) - cam.location).to_track_quat("-Z", "Y").to_euler()
    scn.render.filepath = os.path.join(out, f"check_{name}.png")
    bpy.ops.render.render(write_still=True)
# (he faces -Y; his left is +X)
for side, sx in (("L", 1), ("R", -1)):
    # the sleeve end: below the elbow, at his side
    shot(f"sleeve{side}_below", (sx * 0.42, 0.0, 1.12), (sx * 0.75, -0.25, 0.75))
    shot(f"sleeve{side}_front", (sx * 0.42, 0.0, 1.12), (sx * 0.55, -0.9, 1.05))
shot("collar_top", (0, 0, 1.47), (0.0, -0.35, 1.95))
shot("collar_back", (0, 0, 1.47), (0.0, 0.6, 1.75))
shot("helmet_under", (0, 0, H - 0.08), (0.0, -0.45, H - 0.35))
shot("boots", (0, 0, 0.25), (0.45, -0.8, 0.45))
shot("skirt_under", (0, 0, 0.8), (0.3, -0.6, 0.45))

# ── The FBX for Mixamo ───────────────────────────────────────────────────────
bpy.data.objects.remove(cam, do_unlink=True)
man.select_set(True)
bpy.context.view_layer.objects.active = man
path = os.path.join(out, "appele_mixamo.fbx")
bpy.ops.export_scene.fbx(filepath=path, use_selection=True, object_types={"MESH"}, apply_unit_scale=True,
                         apply_scale_options="FBX_SCALE_ALL", add_leaf_bones=False, path_mode="COPY", embed_textures=True,
                         mesh_smooth_type="FACE")
print("FBX", path, os.path.getsize(path))
