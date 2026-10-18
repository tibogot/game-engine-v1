# Render the game's Lotus (the dev car) from the pilot's cameras — the proportions/stance reference.
# blender -b -P render_lotus.py -- <out_dir>
import bpy, sys, os, math
from mathutils import Vector
out_dir = sys.argv[sys.argv.index("--") + 1]
os.makedirs(out_dir, exist_ok=True)
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
root = "C:/Users/tibog/AppData/Local/Temp/claude/c--Users-tibog-Downloads-game-engine-v1/1fd055c6-35b2-4d98-a5b6-87b520b86d2d/scratchpad/car/"
for f in ["lotus_ref.glb"]:
    try:
        bpy.ops.import_scene.gltf(filepath=root + f)
        print("IMPORTED", f)
    except Exception as e:
        print("IMPORT FAILED", f, e)
# bounds of what came in
mn = Vector((1e9,) * 3); mx = Vector((-1e9,) * 3)
for o in scene.objects:
    if o.type == "MESH":
        for c in o.bound_box:
            w = o.matrix_world @ Vector(c)
            mn = Vector(map(min, mn, w)); mx = Vector(map(max, mx, w))
print("BOUNDS", tuple(round(v, 3) for v in mn), tuple(round(v, 3) for v in mx))

# turn it to our frame (+Y forward) and centre it between its axles (measured: axle midpoint at y = -0.15)
for o in scene.objects:
    if o.type == "MESH" and o.parent is None or (o.type == "EMPTY" and o.parent is None):
        o.rotation_euler.z += math.pi
        o.location = (o.location.x, o.location.y, o.location.z)
bpy.context.view_layer.update()
import importlib.util
spec = importlib.util.spec_from_file_location("studio", os.path.join(os.path.dirname(__file__), "studio.py"))
studio = importlib.util.module_from_spec(spec); spec.loader.exec_module(studio)
# re-centre after the turn
mn = Vector((1e9,) * 3); mx = Vector((-1e9,) * 3)
for o in scene.objects:
    if o.type == "MESH":
        for c in o.bound_box:
            w = o.matrix_world @ Vector(c); mn = Vector(map(min, mn, w)); mx = Vector(map(max, mx, w))
dy = 2.586 - mx.y  # front tip at +2.586 (the game frame)
for o in scene.objects:
    if o.parent is None: o.location.y += dy
studio.studio(scene)
studio.engine(scene)
studio.shoot(scene, out_dir, "lotus")
