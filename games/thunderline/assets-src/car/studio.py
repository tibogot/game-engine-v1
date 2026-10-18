# The pilot car's photo studio, shared by every render (our car and the Lotus reference), so they are
# always shot the same: a soft key, a fill, a rim light that draws the facets, a graded grey world,
# a floor that catches a soft shadow. Cameras: front 3/4, side, rear 3/4 (+Y is the car's front).
import bpy, math, os
from mathutils import Vector

def studio(scene):
    world = bpy.data.worlds.new("World"); scene.world = world
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.20, 0.21, 0.24, 1)
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.55
    bpy.ops.mesh.primitive_plane_add(size=60, location=(0, 0, 0))
    floor = bpy.context.active_object
    fm = bpy.data.materials.new("Floor"); fm.use_nodes = True
    b = fm.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (0.30, 0.31, 0.33, 1); b.inputs["Roughness"].default_value = 0.55
    floor.data.materials.append(fm)
    for loc, energy, size in [((5, 5, 6), 1400, 5), ((-6, 1, 4), 600, 6), ((-1, -7, 3.5), 900, 3), ((0, 0, 8), 500, 8)]:
        bpy.ops.object.light_add(type="AREA", location=loc)
        L = bpy.context.active_object
        L.data.energy = energy; L.data.size = size
        L.rotation_euler = (Vector((0, 0, 0.6)) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()

def engine(scene, fast=True):
    ok = False
    if fast:
        for e in ("BLENDER_EEVEE_NEXT", "BLENDER_EEVEE"):
            try:
                scene.render.engine = e; ok = True; print("ENGINE", e); break
            except Exception:
                pass
    if not ok:
        scene.render.engine = "CYCLES"; scene.cycles.samples = 32; scene.cycles.use_denoising = True
        print("ENGINE CYCLES")
    scene.render.resolution_x = 1280; scene.render.resolution_y = 720
    try: scene.view_settings.view_transform = "AgX"
    except Exception: scene.view_settings.view_transform = "Filmic"

VIEWS = {"front34": (6.0, 6.4, 1.8), "side": (8.6, 0.0, 1.1), "rear34": (-5.8, -6.6, 2.1), "front": (0.0, 9.0, 1.2)}

def shoot(scene, out_dir, prefix, views=VIEWS):
    os.makedirs(out_dir, exist_ok=True)
    cam_data = bpy.data.cameras.new("Cam"); cam_data.lens = 50
    cam = bpy.data.objects.new("Cam", cam_data); scene.collection.objects.link(cam); scene.camera = cam
    for name, pos in views.items():
        cam.location = pos
        cam.rotation_euler = (Vector((0, 0, 0.6)) - Vector(pos)).to_track_quat("-Z", "Y").to_euler()
        scene.render.filepath = os.path.join(out_dir, f"{prefix}_{name}.png")
        bpy.ops.render.render(write_still=True)
    print("RENDERED", out_dir)
