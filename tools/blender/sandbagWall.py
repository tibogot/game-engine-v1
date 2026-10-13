"""A SANDBAG WALL BY CLOTH SIMULATION, BAG BY BAG (2026-10-14, you, beside the Fab walls: "see the gap
between the bags"). The single-bag sims (sandbagSim.py) were placed by formula afterwards: they floated
over or sank into each other. Here the WALL is built the way men build it: each bag dropped onto the
bags already laid, settling into their joints, then frozen and becoming ground for the next.

  "C:/Program Files/Blender Foundation/Blender 5.0/blender.exe" -b --factory-startup \
      --python tools/blender/sandbagWall.py -- public/models/alg/sandbagWall.glb [seed]

THE BAG: a flat sewn sack (0.62 x 0.36 m, the fabric a few cm apart) inflated by PRESSURE (the sand):
it puffs into a pillow with pointed corners ("ears"), as a real one.
THE WALL: 5 m, the game's piece (rtsAlgeria buildFrSandbagWall's layout): five courses two bags thick,
staggered by half a bag (bonded), a firing step behind (two courses), two loose bags at the ends.
Each bag's shade in a vertex colour (COLOR_0). Joined, decimated to ~30k triangles, exported.
"""
import bpy, bmesh, math, random, sys, os
from mathutils import Vector

args = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
out = args[0] if args else "sandbagWall.glb"
SEED = int(args[1]) if len(args) > 1 else 3
R = random.Random(SEED)
BL, BW, BT = 0.62, 0.38, 0.03          # the sack flat: length, width, its two sheets apart
FRAMES = 45
SHADES = [(1.0, 0.97, 0.9), (0.93, 0.86, 0.72), (0.82, 0.8, 0.74), (0.74, 0.68, 0.56), (1.05, 1.0, 0.92), (0.7, 0.72, 0.56), (0.88, 0.82, 0.7)]

for o in list(bpy.data.objects):
    bpy.data.objects.remove(o, do_unlink=True)
scene = bpy.context.scene
near = bpy.data.collections.new("near")
scene.collection.children.link(near)


def collider(o, thick=0.003):
    o.modifiers.new("Collision", "COLLISION")
    o.collision.thickness_outer = thick
    o.collision.cloth_friction = 80   # (10: the bags slid off each other — a 5-course wall settled 0.55 m high, 1.4 m deep)
    o.collision.damping = 0.6


bpy.ops.mesh.primitive_plane_add(size=12)
ground = bpy.context.object
collider(ground)
near.objects.link(ground)


def sack(seed):
    """A flat sewn sack: a thin box of cloth (the two sheets BT apart), subdivided."""
    r = random.Random(seed)
    bpy.ops.mesh.primitive_cube_add(size=1)
    o = bpy.context.object
    o.scale = (BL * r.uniform(0.95, 1.05), BW * r.uniform(0.95, 1.05), BT)
    bpy.ops.object.transform_apply(scale=True)
    bm = bmesh.new()
    bm.from_mesh(o.data)
    bmesh.ops.subdivide_edges(bm, edges=bm.edges[:], cuts=6, use_grid_fill=True)   # (12: the finer cloth went limp at the same fill)
    for v in bm.verts:
        v.co += Vector((r.uniform(-1, 1), r.uniform(-1, 1), r.uniform(-1, 1))) * 0.002
    bm.to_mesh(o.data)
    bm.free()
    return o


def run(o, frames, pressure, bending, gravity):
    m = o.modifiers.new("Cloth", "CLOTH")
    s = m.settings
    s.quality = 6
    s.mass = 0.8
    s.air_damping = 3.0
    s.tension_stiffness, s.compression_stiffness, s.shear_stiffness = 15, 15, 6
    s.bending_stiffness = bending
    s.use_pressure = True
    s.uniform_pressure_force = pressure
    s.effector_weights.gravity = 1.0 if gravity else 0.0
    m.collision_settings.collection = near
    m.collision_settings.distance_min = 0.003
    m.point_cache.frame_start, m.point_cache.frame_end = 1, frames
    scene.frame_start, scene.frame_end = 1, frames
    for f in range(1, frames + 1):
        scene.frame_set(f)
    bpy.context.view_layer.objects.active = o
    for q in bpy.context.selected_objects:
        q.select_set(False)
    o.select_set(True)
    bpy.ops.object.modifier_apply(modifier="Cloth")
    scene.frame_set(1)


# STEP 1 — THE PILLOWS: flat sacks inflated with NO GRAVITY, far from anything (a seam all round,
# pointed ears, flattish faces): 8 variants, kept out of the scene
PILLOWS = []
for k in range(8):
    p = sack(SEED * 100 + k)
    p.location = (0, 0, 50)
    bpy.ops.object.transform_apply(location=True)
    run(p, 30, 7.0 + k * 0.6, 0.05 + 0.03 * k, gravity=False)
    for v in p.data.vertices:
        v.co.z -= 50
    me = p.data.copy()
    me.use_fake_user = True
    PILLOWS.append(me)
    bpy.data.objects.remove(p, do_unlink=True)
print("[wall] pillows inflated", flush=True)


def drop(x, y, z, yaw, seed):
    r = random.Random(seed)
    o = bpy.data.objects.new("bag", PILLOWS[r.randrange(len(PILLOWS))].copy())
    scene.collection.objects.link(o)
    o.rotation_euler = (r.uniform(-0.04, 0.04), r.uniform(-0.04, 0.04), yaw + r.uniform(-0.08, 0.08) + (math.pi if r.random() < 0.5 else 0))
    o.location = (x + r.uniform(-0.015, 0.015), y + r.uniform(-0.015, 0.015), z)
    bpy.context.view_layer.objects.active = o
    o.select_set(True)
    bpy.ops.object.transform_apply(location=True, rotation=True)
    # ONLY the neighbours collide (speed): the bags already laid within 0.9 m
    for q in list(near.objects):
        if q is not ground:
            near.objects.unlink(q)
    for q in laid:
        if abs(q["cx"] - x) < 0.9 and abs(q["cy"] - y) < 0.9:
            near.objects.link(q)
    # STEP 2 — dropped onto them: it keeps its fill (pressure), sags into the joint below
    run(o, 25, 10.0, r.uniform(0.05, 0.12), gravity=True)   # (5: less than the fill it was inflated with — they went limp)
    # relax the cloth's jitter (a light smooth), then simplify to ~400 triangles: the triangles go
    # where the cloth bends, few on the flat — smooth silhouettes at the same cost
    # (the coarse sim's shape is right, its edges jagged — 2026-10-14: subdivided smooth, then simplified)
    sm = o.modifiers.new("Sub", "SUBSURF")
    sm.levels = 2
    bpy.ops.object.modifier_apply(modifier="Sub")
    tris = sum(len(p.vertices) - 2 for p in o.data.polygons)
    d = o.modifiers.new("Dec", "DECIMATE")
    d.ratio = min(1.0, 420 / max(1, tris))
    bpy.ops.object.modifier_apply(modifier="Dec")
    c = R.choices(SHADES, weights=[3, 4, 2, 2, 2, 1, 3])[0]
    v = 0.92 + R.random() * 0.16
    col = o.data.color_attributes.new("Col", "FLOAT_COLOR", "POINT")
    for dd in col.data:
        dd.color = (c[0] * v, c[1] * v, c[2] * v, 1.0)
    collider(o)
    xs = [vv.co.x for vv in o.data.vertices]; ys = [vv.co.y for vv in o.data.vertices]; zs = [vv.co.z for vv in o.data.vertices]
    o["cx"], o["cy"] = sum(xs) / len(xs), sum(ys) / len(ys)
    o["bb"] = (min(xs), max(xs), min(ys), max(ys), max(zs))
    return o


laid = []
def top_at(x, y):
    """The highest settled point near (x, y) — where the next bag starts its fall."""
    h = 0.0
    for o in laid:
        x0, x1, y0, y1, z1 = o["bb"]
        if x0 - 0.1 < x < x1 + 0.1 and y0 - 0.05 < y < y1 + 0.05:
            h = max(h, z1)
    return h


def course(length, rows, y0, c, step_off):
    n = max(1, round(length / (BL * 1.0)))   # (clear at the start: overlapping, the cloths tangled and crumpled)
    for row in range(rows):
        y = y0 + row * BW * 0.92
        for i in range(n):
            x = -length / 2 + (i + 0.5) * (length / n) + step_off * (0.5 if c % 2 else 0) * (1 if row == 0 else -1)
            if abs(x) > length / 2:
                continue
            z = top_at(x, y) + 0.04
            laid.append(drop(x, y, z, 0.0, SEED * 1000 + len(laid)))
    print(f"[wall] course {c}: {len(laid)} bags", flush=True)


QUICK = len(args) > 2 and args[2] == "quick"   # a 2 m stretch, two courses, one row: to judge the bags
L = 2.0 if QUICK else 5.0
step = BL * 1.0
for c in range(4 if QUICK else 6):
    course(L - c * 0.08, 2, 0.0, c, step)
if not QUICK:
    for c in range(2):   # the firing step behind
        course(L - 0.6, 1, BW * 2.1, c, step)
    for sx in (-1, 1):   # loose bags at the ends
        laid.append(drop(sx * (L / 2 + 0.35), 0.1, 0.12, R.uniform(0, 3), SEED * 1000 + 900 + sx))

# one mesh: joined, its bottom at 0, its plan centred; decimated; Blender Z-up -> glTF Y-up on export
bpy.ops.object.select_all(action="DESELECT")
for o in laid:
    o.modifiers.clear()
    o.select_set(True)
bpy.context.view_layer.objects.active = laid[0]
bpy.ops.object.join()
wall = bpy.context.object
wall.name = "sandbag_wall"
tris = sum(len(p.vertices) - 2 for p in wall.data.polygons)
d = wall.modifiers.new("Dec", "DECIMATE")
d.ratio = 1.0   # (each bag decimated on its own already)
bpy.ops.object.modifier_apply(modifier="Dec")
bpy.ops.object.shade_smooth()
bpy.data.objects.remove(ground, do_unlink=True)
os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
bpy.ops.export_scene.gltf(filepath=out, export_format="GLB", use_selection=False, export_texcoords=False,
                          export_materials="NONE", export_vertex_color="ACTIVE", export_yup=True)
print(f"[wall] {len(laid)} bags, {tris} -> {sum(len(p.vertices) - 2 for p in wall.data.polygons)} triangles; wrote {out}", flush=True)

# THE FAR VERSION (2026-10-14, "optimise it a lot for the game"): the same wall simplified to ~22%
# (~10k triangles) for the RTS zoom (the game swaps at ~55 m from the camera) -> <out>_far.glb
d = wall.modifiers.new("Far", "DECIMATE")
d.ratio = 0.22
bpy.ops.object.modifier_apply(modifier="Far")
far = out.replace(".glb", "_far.glb")
bpy.ops.export_scene.gltf(filepath=far, export_format="GLB", use_selection=False, export_texcoords=False,
                          export_materials="NONE", export_vertex_color="ACTIVE", export_yup=True)
print(f"[wall] far: {sum(len(p.vertices) - 2 for p in wall.data.polygons)} triangles; wrote {far}", flush=True)
