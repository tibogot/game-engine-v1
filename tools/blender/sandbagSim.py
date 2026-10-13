"""SANDBAGS BY CLOTH SIMULATION (2026-10-14, you: "it looks very rigid — the Fab asset looks like a
real cloth simulation pillow, the kind of thing we can do easily in Blender"). Run headless:

  "C:/Program Files/Blender Foundation/Blender 5.0/blender.exe" -b --factory-startup \
      --python tools/blender/sandbagSim.py -- public/models/alg/sandbags.glb

Each bag: a sewn cloth box (0.70 x 0.42 x 0.24 m) filled by PRESSURE (the sand), its tied end gathered
narrower, dropped under gravity onto
  GROUND   a flat floor (the bottom course)
  VALLEY   two bags end to end with a gap between them (every course above: a bag laid across a
           joint, as a real wall is bonded) — it drapes into the gap
It slumps, flattens where it rests, folds at the seams and corners. The last frame is applied,
decimated to ~500 triangles and exported: objects bag_ground_<k>, bag_valley_<k> (the game picks).
"""
import bpy, bmesh, math, random, sys, os
from mathutils import Vector

out = sys.argv[sys.argv.index("--") + 1] if "--" in sys.argv else "sandbags.glb"
N_EACH, FRAMES = 6, 70
L, W, H = 0.70, 0.42, 0.24


def clear():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete()
    for m in list(bpy.data.meshes):
        if not m.use_fake_user:   # (the kept bags survive)
            bpy.data.meshes.remove(m)


def make_bag(seed):
    """A box of cloth, subdivided; its tied end (+X) gathered narrower; a little irregular."""
    r = random.Random(seed)
    bpy.ops.mesh.primitive_cube_add(size=1)
    o = bpy.context.object
    o.scale = (L, W, H)
    bpy.ops.object.transform_apply(scale=True)
    bm = bmesh.new()
    bm.from_mesh(o.data)
    bmesh.ops.subdivide_edges(bm, edges=bm.edges[:], cuts=9, use_grid_fill=True)
    for v in bm.verts:
        t = max(0.0, v.co.x / (L / 2))            # 0 .. 1 toward the tied end
        v.co.y *= 1 - 0.38 * t ** 2               # gathered narrower
        v.co.z *= 1 - 0.45 * t ** 2               # and flatter
        v.co += Vector((r.uniform(-1, 1), r.uniform(-1, 1), r.uniform(-1, 1))) * 0.004
    bm.to_mesh(o.data)
    bm.free()
    o.data.update()
    return o


def cloth(o, seed):
    r = random.Random(seed + 99)
    m = o.modifiers.new("Cloth", "CLOTH")
    s = m.settings
    s.quality = 8
    s.mass = 0.6
    s.air_damping = 2.0
    s.tension_stiffness = 12
    s.compression_stiffness = 12
    s.shear_stiffness = 6
    s.bending_stiffness = 0.15 + r.uniform(0, 0.25)   # jute: folds easily
    s.use_pressure = True
    s.uniform_pressure_force = r.uniform(3.0, 5.5)   # the sand: full but slumping
    s.pressure_factor = 1.0
    s.fluid_density = 0
    m.collision_settings.distance_min = 0.004
    m.collision_settings.use_self_collision = False
    m.point_cache.frame_start = 1
    m.point_cache.frame_end = FRAMES
    return m


def collider(o):
    c = o.modifiers.new("Collision", "COLLISION")
    o.collision.thickness_outer = 0.004
    o.collision.cloth_friction = 8
    return c


def rounded_box(name, size, loc):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc)
    o = bpy.context.object
    o.name = name
    o.scale = size
    bpy.ops.object.transform_apply(scale=True)
    b = o.modifiers.new("Bevel", "BEVEL")
    b.width, b.segments = 0.07, 4
    bpy.ops.object.modifier_apply(modifier=b.name)
    return o


def simulate(kind, k):
    clear()
    seed = 1000 + k * 17 + (0 if kind == "ground" else 500)
    r = random.Random(seed)
    bpy.ops.mesh.primitive_plane_add(size=6, location=(0, 0, 0))
    collider(bpy.context.object)
    drop = H / 2 + 0.03
    if kind == "valley":
        gap = r.uniform(0.04, 0.12)
        for sx in (-1, 1):
            b = rounded_box("under", (L * 0.95, W * 0.95, H * 0.62), (sx * (L / 2 + gap / 2), r.uniform(-0.04, 0.04), H * 0.31))
            collider(b)
        drop = H * 0.62 + H / 2 + 0.03
    bag = make_bag(seed)
    bag.location = (r.uniform(-0.03, 0.03), r.uniform(-0.03, 0.03), drop)
    bag.rotation_euler = (r.uniform(-0.06, 0.06), r.uniform(-0.06, 0.06), r.uniform(-0.12, 0.12))
    bpy.ops.object.transform_apply(location=True, rotation=True)
    cloth(bag, seed)
    sc = bpy.context.scene
    sc.frame_start, sc.frame_end = 1, FRAMES
    for f in range(1, FRAMES + 1):
        sc.frame_set(f)
    # apply the cloth at the last frame
    bpy.context.view_layer.objects.active = bag
    bag.select_set(True)
    bpy.ops.object.modifier_apply(modifier="Cloth")
    # simplify to ~500 triangles
    tris = sum(len(p.vertices) - 2 for p in bag.data.polygons)
    d = bag.modifiers.new("Dec", "DECIMATE")
    d.ratio = min(1.0, 300 / max(1, tris))   # (520: 800 triangles a bag after the quads split, 52k a wall)
    bpy.ops.object.modifier_apply(modifier="Dec")
    bpy.ops.object.shade_smooth()
    # the bottom at y = 0 (three: Y up), centred in plan
    me = bag.data
    zs = [v.co.z for v in me.vertices]
    cx = sum(v.co.x for v in me.vertices) / len(me.vertices)
    cy = sum(v.co.y for v in me.vertices) / len(me.vertices)
    for v in me.vertices:
        v.co.x -= cx
        v.co.y -= cy
        # ground: its bottom at 0; valley: the top of the two it rests on at 0 (it hangs below, into the joint)
        v.co.z -= min(zs) if kind == "ground" else H * 0.62
    bag.name = f"bag_{kind}_{k}"
    me.name = bag.name
    data = me.copy()
    data.name = bag.name
    data.use_fake_user = True
    return data, len(me.polygons), max(zs) - min(zs)


kept = []
for kind in ("ground", "valley"):
    for k in range(N_EACH):
        me, polys, h = simulate(kind, k)
        kept.append(me)
        print(f"[sandbag] {me.name}: {polys} faces, {h:.3f} m tall")

# the scene for export: only the kept bags, side by side (the game reads them by name)
clear()
for i, me in enumerate(kept):
    o = bpy.data.objects.new(me.name, me)
    bpy.context.scene.collection.objects.link(o)
    o.location = ((i % N_EACH) * 1.0, (i // N_EACH) * 1.0, 0)
os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
bpy.ops.export_scene.gltf(filepath=out, export_format="GLB", export_apply=True, export_texcoords=False,
                          export_materials="NONE", export_yup=True)
print(f"[sandbag] wrote {out}")
