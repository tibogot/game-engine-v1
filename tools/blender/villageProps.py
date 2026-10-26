"""THE VILLAGE PROPS (2026-10-24, you: "the village looks nice but it's like a circle with nothing at the centre — it
feels empty"; "everything coherent … best optimisation"; "think assets as modular"). The life of a village square,
each prop its OWN piece the game places one by one (an instanced field: a draw per prop for the whole map), built and
baked like the houses — their materials (house.py MATDEF: the stone, the clay, the hay, the wood), so a jar on a
square is the jar on a roof.

  WELL      a round dry-stone curb, two forked posts and a crossbar, the pulley, the rope, a leather bucket on the lip
  TROUGH    a hollowed stone trough for the animals, water dark in it
  JARS      a huddle of turned clay jars (big amphora, a pot, a glazed jug) — three variants (jars, jars2, jars3)
  BENCH     a mud-plaster bench (a dukkana) with a stone seat
  OVEN      the tabouna: a clay dome on a low base, its mouth, a heap of brushwood beside it
  (HAY     tools/blender/haystack.py — the straw-card stack)
  WOOD      firewood: split logs in a stack, a brush bundle, the chopping block with its axe
  HIVES     cork cylinders on a stone shelf, a flat stone on each

Real metres (the game ×1.3, as the houses). Near + far, one atlas each (tools/glbLodShadingCheck.mjs gates them).

  "C:/Program Files/Blender Foundation/Blender 5.0/blender.exe" -b --factory-startup \\
      --python tools/blender/villageProps.py -- <out dir> [--quick]

Writes <out>/vprops.glb (Village<Type>_Intact + _Far) — then tools/optimizeGlb.mjs --etc1s.
"""
import sys, os, math, random
sys.path.insert(0, os.path.dirname(__file__))
import bpy, bmesh
import house
from house import buildKit
import drystone
from drystone import stone, tag
from bkit import B

MATDEF = dict(house.MATDEF)
LOW = lambda: drystone.LOW

def lathe(K, nm, at, prof, mat, n=14, t=0.0, jitter=0.0, seed=0):
    """A turned shape: `prof` [(r, y)] bottom to top (r 0 = closed), revolved round the game's +Y at `at`."""
    if LOW(): n = max(6, n // 2)
    x0, y0, z0 = at
    bm = bmesh.new(); rings = []
    for r, y in prof:
        if r <= 1e-4: rings.append([bm.verts.new(B(x0, y0 + y, z0))]); continue
        J = random.Random(seed * 131 + int(y * 100))   # (`jitter`: each vertex pushed in / out — straw, not a turned pot)
        rr = [r * (1 + (J.uniform(-1, 1) * jitter if jitter else 0)) for _ in range(n)]
        rings.append([bm.verts.new(B(x0 + math.cos(2 * math.pi * i / n) * rr[i], y0 + y + (J.uniform(-1, 1) * jitter * 0.5 if jitter else 0), z0 + math.sin(2 * math.pi * i / n) * rr[i])) for i in range(n)])
    for a, b in zip(rings, rings[1:]):
        if len(a) == 1: [bm.faces.new((a[0], b[(i + 1) % n], b[i])) for i in range(n)]
        elif len(b) == 1: [bm.faces.new((a[i], a[(i + 1) % n], b[0])) for i in range(n)]
        else: [bm.faces.new((a[i], a[(i + 1) % n], b[(i + 1) % n], b[i])) for i in range(n)]
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return tag(K.obj(nm, bm, mat, "h", smooth=True), t)

AMPHORA = [(0, 0.0), (0.06, 0.0), (0.15, 0.08), (0.21, 0.25), (0.22, 0.38), (0.18, 0.5), (0.09, 0.6), (0.07, 0.66), (0.085, 0.7), (0.07, 0.72), (0, 0.71)]
POT = [(0, 0.0), (0.1, 0.0), (0.2, 0.08), (0.24, 0.2), (0.21, 0.32), (0.14, 0.38), (0.15, 0.41), (0.12, 0.42), (0, 0.4)]
JUG = [(0, 0.0), (0.07, 0.0), (0.12, 0.06), (0.13, 0.16), (0.08, 0.26), (0.05, 0.33), (0.065, 0.36), (0, 0.35)]

def jars(variant):
    def f(K, tname, spec, state, seed):
        R = random.Random(seed + variant * 31)
        spots = [(0, 0), (0.42, 0.12), (-0.38, 0.18), (0.12, 0.45), (-0.1, -0.4)][: 3 + variant]
        for k, (x, z) in enumerate(spots):
            shape, m = R.choice([(AMPHORA, "jar"), (AMPHORA, "jarPale"), (POT, "jar"), (POT, "jarPale"), (JUG, "jarGlazed")])
            s = R.uniform(0.85, 1.15) * (1.25 if k == 0 else 1.0)
            lathe(K, f"Jar{k}", (x, 0, z), [(r * s, y * s) for r, y in shape], m, 14)
    return f

def well(K, tname, spec, state, seed):
    R = random.Random(seed)
    # the curb: a ring of split stones, two courses, a flat capstone ring; the shaft dark inside
    rad, n = 0.82, 16 if not LOW() else 10
    for c in range(2 if not LOW() else 1):
        for i in range(n):
            a = 2 * math.pi * (i + 0.5 * c) / n
            stone(K, f"Curb{c}{i}", (math.cos(a) * rad, 0.2 + c * 0.32, math.sin(a) * rad), (0.2, 0.17, 0.16), R, 0, mat="stone", yaw=-a + math.pi / 2)
    # the COPING: capstones round the top, chunky, a little proud of the curb (you, 2026-10-24: one smooth pale ring "looks
    # like a flat ring")
    nc = 12 if not LOW() else 8
    for i in range(nc):
        a = 2 * math.pi * (i + 0.25) / nc
        stone(K, f"Cap{i}", (math.cos(a) * 0.84, 0.72, math.sin(a) * 0.84), (0.27, 0.09, 0.2), R, 0, mat="stone", yaw=-a + math.pi / 2, box=0.55)
    lathe(K, "Shaft", (0, 0.02, 0), [(0.0, 0.0), (0.64, 0.0), (0.64, 0.7)], "dark", 16)
    # two forked posts, the crossbar, the pulley wheel, the rope down into the dark
    for s in (-1, 1):
        tag(K.rod(f"Post{s}", (s * 1.05, 0, 0.05), (s * 1.0, 2.15, 0.0), 0.075, "woodDark", "h", 7), 0)
        tag(K.rod(f"Fork{s}", (s * 1.0, 2.05, 0), (s * 1.12, 2.35, 0.02), 0.045, "woodDark", "h", 6), 0)
    tag(K.rod("Bar", (-1.12, 2.22, 0), (1.12, 2.22, 0), 0.06, "woodDark", "h", 7), 0)
    lathe(K, "Pulley", (0, 2.08, -0.03), [(0.0, 0.0), (0.16, 0.0), (0.16, 0.06), (0.0, 0.06)], "wood", 12)
    if not LOW(): tag(K.rod("Rope", (0, 2.16, 0.0), (0, 0.4, 0.0), 0.012, "basket", "h", 4), 0)
    # the leather bucket on the lip
    lathe(K, "Bucket", (0.8, 0.8, 0.42), [(0, 0), (0.12, 0), (0.15, 0.22), (0.13, 0.24), (0, 0.23)], "woodDark", 10)

def trough(K, tname, spec, state, seed):
    R = random.Random(seed)
    L, W, H = 1.9, 0.62, 0.48
    K.box("Floor", -L / 2, L / 2, 0, 0.12, -W / 2, W / 2, "stone", "h", 0.04)
    for s in (-1, 1):
        K.box(f"Side{s}", -L / 2, L / 2, 0.1, H, s * W / 2 - (0.11 if s > 0 else 0), s * W / 2 + (0.11 if s < 0 else 0), "stone", "h", 0.04)
        K.box(f"End{s}", s * L / 2 - (0.12 if s > 0 else 0), s * L / 2 + (0.12 if s < 0 else 0), 0.1, H, -W / 2 + 0.11, W / 2 - 0.11, "stone", "h", 0.04)
    K.box("Water", -L / 2 + 0.13, L / 2 - 0.13, 0.12, H - 0.12, -W / 2 + 0.12, W / 2 - 0.12, "jarGlazed", "h", 0)
    if not LOW():
        for k in range(3): stone(K, f"Step{k}", (R.uniform(-0.7, 0.7), 0.05, W / 2 + 0.35 + R.uniform(0, 0.2)), (0.2, 0.06, 0.16), R, 0, mat="stone")

def bench(K, tname, spec, state, seed):
    K.box("Base", -1.1, 1.1, 0, 0.38, -0.25, 0.25, "renderPlain", "h", 0.05)
    K.box("Seat", -1.15, 1.15, 0.38, 0.45, -0.29, 0.29, "sill", "h", 0.02)

def oven(K, tname, spec, state, seed):
    R = random.Random(seed)
    lathe(K, "Base", (0, 0, 0), [(0, 0), (0.78, 0), (0.8, 0.18), (0, 0.18)], "earth", 14)
    lathe(K, "Dome", (0, 0.16, 0), [(0, 0), (0.66, 0), (0.68, 0.18), (0.6, 0.42), (0.42, 0.6), (0.18, 0.7), (0.1, 0.72), (0.12, 0.78), (0.0, 0.78)], "oven", 16)
    K.box("Mouth", -0.17, 0.17, 0.2, 0.48, -0.69, -0.63, "dark", "h", 0)
    if not LOW():   # the brushwood heaped beside it
        for k in range(6):
            a = R.uniform(-0.4, 0.4)
            tag(K.rod(f"Brush{k}", (0.95, 0.05 + k * 0.04, 0.2 + k * 0.05), (1.6 + R.uniform(0, 0.2), 0.08 + k * 0.03, 0.2 + a), 0.035, "woodDark", "h", 5), 0)

# (THE HAY: tools/blender/haystack.py since 2026-10-26 — the straw-card stack; this lumpy lathe one, "very cheap", is gone)

def wood(K, tname, spec, state, seed):
    R = random.Random(seed)
    for row in range(3):   # split logs, three courses, each a little shorter
        for k in range(5 - row):
            z = (k - (4 - row) / 2) * 0.2
            tag(K.rod(f"Log{row}{k}", (-0.7 + row * 0.05, 0.09 + row * 0.16, z), (0.7 - row * 0.05, 0.09 + row * 0.16, z + R.uniform(-0.03, 0.03)), 0.085, "woodDark", "h", 6), 0)
    K.lump("Brush", (1.25, 0, 0.1), (0.5, 0.35, 0.4), "basket", "h", seed=3, rough=0.4)
    lathe(K, "Block", (-1.25, 0, 0.2), [(0, 0), (0.24, 0), (0.25, 0.42), (0, 0.42)], "wood", 10)
    if not LOW():
        tag(K.rod("Haft", (-1.25, 0.42, 0.2), (-1.05, 0.95, 0.35), 0.025, "wood", "h", 5), 0)
        K.box("Axe", -1.3, -1.18, 0.38, 0.5, 0.15, 0.25, "iron", "h", 0.01)

def hives(K, tname, spec, state, seed):
    R = random.Random(seed)
    K.box("Shelf", -1.3, 1.3, 0, 0.4, -0.35, 0.35, "stone", "h", 0.05)
    for k in range(4):
        x = -0.95 + k * 0.63
        tag(K.rod(f"Hive{k}", (x, 0.62, -0.3), (x + R.uniform(-0.02, 0.02), 0.62, 0.32), 0.21, "basket", "h", 10), 0)
        stone(K, f"Cap{k}", (x, 0.88, 0.0), (0.22, 0.04, 0.3), R, 0, mat="stone", box=0.6)

TYPES = {
    "well": dict(builder=well, atlas=1024, aoDist=0.4),
    "trough": dict(builder=trough, atlas=512, aoDist=0.3),
    "jars": dict(builder=jars(0), atlas=512, aoDist=0.15),
    "jars2": dict(builder=jars(1), atlas=512, aoDist=0.15),
    "jars3": dict(builder=jars(2), atlas=512, aoDist=0.15),
    "bench": dict(builder=bench, atlas=256, aoDist=0.2),
    "oven": dict(builder=oven, atlas=512, aoDist=0.3),
    "wood": dict(builder=wood, atlas=512, aoDist=0.2, farRatio=0.75),   # (thin 6-sided logs: decimated hard they lost their round)
    "hives": dict(builder=hives, atlas=512, aoDist=0.25),
}
for k, v in TYPES.items():
    v.setdefault("states", ["intact"]); v.setdefault("smoothAngle", 40); v.setdefault("weighted", False); v.setdefault("farRatio", 0.4)
exported = buildKit(TYPES, MATDEF, "vprops.glb", prefix="Village", seed0=1962)

# previews (assets-src/refs/house)
scn = bpy.context.scene
scn.render.engine = "BLENDER_WORKBENCH"
sh = scn.display.shading; sh.light = "STUDIO"; sh.color_type = "TEXTURE"
scn.render.resolution_x, scn.render.resolution_y = 500, 400
cd = bpy.data.cameras.new("PC"); cam = bpy.data.objects.new("PC", cd); scn.collection.objects.link(cam); scn.camera = cam
for o in scn.objects:
    if o.type == "MESH": o.hide_render = True
for o in exported:
    if o.name.endswith("_Far"): continue
    o.hide_render = False
    cam.location = B(3.2, 3.0, -4.2); cam.rotation_euler = (B(0, 0.7, 0) - cam.location).to_track_quat("-Z", "Y").to_euler()
    scn.render.filepath = os.path.join(house.REFS, f"preview_{o.name}.png"); bpy.ops.render.render(write_still=True)
    o.hide_render = True
print("DONE")
