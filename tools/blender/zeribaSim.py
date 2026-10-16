"""THE ZERIBA IN BLENDER (2026-10-14, you: "what are these things near the villager house?" — the flock's
pen, its thorn brush read as a ring of baskets). A shepherd's pen of the Aurès (assets-src/refs/zeriba/,
a goat pen of piled thorn): cut thorn bushes piled in a ring chest high, crowns OUTWARD, a dense tangle
of dead grey branches you can half see through; a gap (the entrance) closed at night; a stone trough
and a heap of fodder inside.

  "C:/Program Files/Blender Foundation/Blender 5.0/blender.exe" -b --factory-startup \\
      --python tools/blender/zeribaSim.py -- public/models/alg/zeriba.glb [seed] [radius]

EACH BUSH: a trunk and its branches forking (three orders), each bending as it goes — curves with a
small bevel (4-sided), their radius tapering — then a mesh. ~55 bushes round the ring, leaning out,
turned and tilted at random, overlapping: no gaps but the entrance. A low dense core of short
branches along the ground. Each branch's shade in COLOR_0 (dead grey to brown, the twigs paler).
Blender's Y here is the game's Z (turned 180° before export, as sandbagWall.py): the gap at -Z.
Near ~45k triangles, far (~22%) -> <out>_far.glb.
"""
import bpy, bmesh, math, random, sys, os
from mathutils import Vector, Matrix

args = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
out = args[0] if args else "zeriba.glb"
SEED = int(args[1]) if len(args) > 1 else 81
RAD = float(args[2]) if len(args) > 2 else 8.45      # the kit's: r 6.5 x finish()'s 1.3
BARE = len(args) > 3 and args[3] == "bare"         # no trough or fodder (the farmstead's small pen)
R = random.Random(SEED)

for o in list(bpy.data.objects):
    bpy.data.objects.remove(o, do_unlink=True)

# (the shades as SEEN (sRGB) -> stored LINEAR: COLOR_0 is linear — written as sRGB they came out bone white)
GREY = [tuple(c ** 2.2 for c in g) for g in [(0.36, 0.33, 0.29), (0.31, 0.28, 0.24), (0.4, 0.36, 0.31), (0.28, 0.23, 0.18), (0.34, 0.28, 0.21)]]

# ── THE BRANCHES: polylines (points, radii, shade) ───────────────────────────────────────────────
LINES = []
# segment length by branch order (2026-10-14, the optimisation: 0.18-0.2 m drew 37k a small pen)
SEG = [0.35, 0.4, 0.45, 0.5]

def grow(p, d, length, rad, order, r):
    """A branch from p along d: bending as it goes; its children forking off; the tip thin."""
    pts, rads = [p.copy()], [rad]
    n = max(2, int(length / SEG[order]))
    step = length / n
    q, dd = p.copy(), d.normalized()
    kids = []
    for i in range(1, n + 1):
        dd = (dd + Vector((r.uniform(-1, 1), r.uniform(-1, 1), r.uniform(-1, 0.7))) * 0.35).normalized()
        q = q + dd * step
        if q.z < 0.02:
            q.z = 0.02
            dd.z = abs(dd.z)
        pts.append(q.copy())
        rads.append(rad * (1 - 0.8 * i / n) + 0.004)
        if order < 3 and i < n and r.random() < (0.55 if order == 0 else 0.42):
            side = Vector((r.uniform(-1, 1), r.uniform(-1, 1), r.uniform(-0.2, 0.8)))
            kids.append((q.copy(), (dd + side * 0.9).normalized(), length * r.uniform(0.35, 0.6), rads[-1] * 0.7, order + 1))
    shade = r.choice(GREY)
    if order >= 2:
        shade = tuple(min(1, c * 1.25) for c in shade)   # the twigs paler, sun-bleached
    LINES.append((pts, rads, shade, order))
    for k in kids:
        grow(*k, r)

def bush(x, y, out_dir, r):
    """A cut thorn bush laid on the pile: its trunk's end toward the pen, its crown leaning out."""
    base = Vector((x, y, 0.05 + r.uniform(0, 0.25)))
    for _ in range(r.randint(5, 7)):    # main stems from the cut end (denser: 3-5 left the ring see-through)
        d = Vector((out_dir.x + r.uniform(-0.7, 0.7), out_dir.y + r.uniform(-0.7, 0.7), r.uniform(0.35, 1.1)))
        grow(base + Vector((r.uniform(-0.2, 0.2), r.uniform(-0.2, 0.2), 0)), d, r.uniform(1.1, 1.9), r.uniform(0.025, 0.04), 0, r)

n = max(20, round(56 * RAD / 8.45))   # bushes in proportion to the ring
GAP = 0.11 * 8.45 / RAD                 # the gap ~1.8 m whatever the ring
for k in range(n):
    a = (k / n) * math.pi * 2 + R.uniform(-0.03, 0.03)
    # the gap toward -Y (the game's -Z, the front), ~1.6 m
    if abs(math.atan2(math.sin(a + math.pi / 2), math.cos(a + math.pi / 2))) < GAP:
        continue
    rr = RAD + R.uniform(-0.45, 0.25)
    c, s = math.cos(a), math.sin(a)
    bush(c * (rr - 0.5), s * (rr - 0.5), Vector((c, s, 0)), R)
    # the low core: short stems laid along the ring, filling the bottom
    for _ in range(5):
        t = Vector((-s, c, 0))
        p = Vector((c * rr + R.uniform(-0.3, 0.3), s * rr + R.uniform(-0.3, 0.3), 0.05))
        grow(p, (t * R.choice([-1, 1]) + Vector((c, s, 0)) * R.uniform(-0.4, 0.4) + Vector((0, 0, R.uniform(0.05, 0.35)))), R.uniform(0.9, 1.5), 0.022, 1, R)
print(f"[zeriba] {len(LINES)} branches", flush=True)
for o_ in range(4):
    sel = [l for l in LINES if l[3] == o_]
    print(f"[zeriba] order {o_}: {len(sel)} branches, {sum((len(l[0]) - 1) * 6 for l in sel)} triangles", flush=True)

# ── TO A MESH: one curve, a spline per branch, a TRIANGLE bevel (3 sides) ─────────────────────────
bpy.ops.curve.primitive_bezier_circle_add(radius=1)
prof = bpy.context.object
prof.data.splines.clear()
sp = prof.data.splines.new("POLY")
sp.points.add(2)
for i in range(3):
    t = i / 3 * math.pi * 2
    sp.points[i].co = (math.cos(t), math.sin(t), 0, 1)
sp.use_cyclic_u = True
bpy.ops.curve.primitive_bezier_circle_add(radius=1)
flat = bpy.context.object
flat.data.splines.clear()
sf = flat.data.splines.new("POLY")
sf.points.add(1)
sf.points[0].co = (-1, 0, 0, 1)
sf.points[1].co = (1, 0, 0, 1)


def to_mesh(lines, name, profile=None, sides=3):
    cu = bpy.data.curves.new(name, "CURVE")
    cu.dimensions = "3D"
    cu.bevel_mode = "OBJECT"
    cu.bevel_object = profile or prof
    cu.resolution_u = 1
    cu.use_fill_caps = False
    for pts, rads, _, _ in lines:
        spl = cu.splines.new("POLY")
        spl.points.add(len(pts) - 1)
        for i, (p, r_) in enumerate(zip(pts, rads)):
            spl.points[i].co = (p.x, p.y, p.z, 1)
            spl.points[i].radius = r_
    o = bpy.data.objects.new(name, cu)
    bpy.context.scene.collection.objects.link(o)
    bpy.ops.object.select_all(action="DESELECT")
    bpy.context.view_layer.objects.active = o
    o.select_set(True)
    bpy.ops.object.convert(target="MESH")
    o = bpy.context.object
    col = o.data.color_attributes.new("Col", "FLOAT_COLOR", "POINT")
    vi = 0
    for pts, _, shade, _ in lines:
        for _ in range(len(pts) * sides):
            if vi < len(col.data):
                v = R.uniform(0.9, 1.1)
                col.data[vi].color = (shade[0] * v, shade[1] * v, shade[2] * v, 1)
            vi += 1
    o.data.color_attributes.active_color = col
    o.data.color_attributes.render_color_index = 0
    return o


# ── INSIDE: a stone trough, the fodder heap ──────────────────────────────────────────────────────
def lump(name, loc, scale, shade, subdiv=2, jitter=0.12):
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=subdiv, radius=1, location=loc)
    o = bpy.context.object
    o.name = name
    for v in o.data.vertices:
        v.co *= 1 + R.uniform(-jitter, jitter)
    o.scale = scale
    bpy.ops.object.transform_apply(location=False, scale=True)
    c = o.data.color_attributes.new("Col", "FLOAT_COLOR", "POINT")
    for d in c.data:
        k = R.uniform(0.85, 1.1)
        d.color = (shade[0] * k, shade[1] * k, shade[2] * k, 1)
    o.data.color_attributes.active_color = c
    return o

extra = []
for i in range(0 if BARE else 5):   # the trough: rough stones in a row, a hollow suggested by a darker middle
    extra.append(lump("trough", (-1.95 + i * 0.5, 1.95, 0.18), (0.32, 0.28, 0.22), (0.55, 0.5, 0.44), 1, 0.2))
if not BARE:
    extra.append(lump("fodder", (2.6, 2.85, 0.0), (1.2, 1.0, 0.75), (0.62, 0.52, 0.33), 2, 0.15))

# ── JOIN, TURN, EXPORT: the near (everything), the far (no twigs) — each BUILT, not decimated
# (decimating thin branches tore them into shards)
os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
kw = dict(export_format="GLB", use_selection=True, export_texcoords=False, export_materials="NONE",
          export_vertex_color="ACTIVE", export_yup=True)


def export(objs, path):
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    z = bpy.context.object
    z.rotation_euler = (0, 0, math.pi)
    bpy.ops.object.transform_apply(rotation=True)
    z.data.color_attributes.active_color = z.data.color_attributes[0]
    bpy.ops.object.select_all(action="DESELECT")
    z.select_set(True)
    bpy.ops.export_scene.gltf(filepath=path, **kw)
    tris = sum(len(p.vertices) - 2 for p in z.data.polygons)
    bpy.data.objects.remove(z, do_unlink=True)
    return tris


thick = [l for l in LINES if l[3] <= 1]
twigs = [l for l in LINES if l[3] >= 2]
near_objs = [to_mesh(thick, "brush"), to_mesh(twigs, "twigs", flat, 2)] + extra
print(f"[zeriba] near: {export(near_objs, out)} triangles; wrote {out}", flush=True)
extra2 = [lump("trough", (-1.95 + i * 0.5, 1.95, 0.18), (0.32, 0.28, 0.22), (0.55, 0.5, 0.44), 1, 0.2) for i in range(0 if BARE else 5)]
if not BARE:
    extra2.append(lump("fodder", (2.6, 2.85, 0.0), (1.2, 1.0, 0.75), (0.62, 0.52, 0.33), 1, 0.15))
far = out.replace(".glb", "_far.glb")
# the far: the main branches only, every other point kept (the twigs are a blur from 55 m on)
coarse = [(l[0][::2] + ([l[0][-1]] if len(l[0]) % 2 == 0 else []), l[1][::2] + ([l[1][-1]] if len(l[1]) % 2 == 0 else []), l[2], l[3]) for l in LINES if l[3] <= 1]
coarse = [l for l in coarse if len(l[0]) >= 2]
print(f"[zeriba] far: {export([to_mesh(coarse, 'brushFar')] + extra2, far)} triangles; wrote {far}", flush=True)
