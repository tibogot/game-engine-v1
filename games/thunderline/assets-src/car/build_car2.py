# Thunderline pilot car, ROUND 4 — a rebuild (rounds 1–3 were a blockout; user: "far from good enough").
# blender -b -P build_car2.py -- <out_dir> [--lotus]   (--lotus: the game's Lotus as a ghost reference)
# A generic 90s-style coupe, not any real car (trademark). +Y forward, +Z up, X right, metres.
# THE LOTUS HARD POINTS (the game's physics is tuned to them, measured in the game): axles y = ±1.40,
# wheel centres x = ±0.92, wheel radius 0.374, body from y = +2.586 to −2.387, roof ~1.30–1.40.
import bpy, bmesh, math, sys, os, importlib.util
from mathutils import Vector, Matrix

args = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else ["."]
out_dir = args[0]
here = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("studio", os.path.join(here, "studio.py"))
studio = importlib.util.module_from_spec(spec); spec.loader.exec_module(studio)

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene

# ---------------- materials ----------------
def mat(name, color, metal=0.0, rough=0.5, emit=None, strength=0.0, coat=0.0):
    m = bpy.data.materials.new(name); m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*color, 1)
    b.inputs["Metallic"].default_value = metal
    b.inputs["Roughness"].default_value = rough
    if coat and "Coat Weight" in b.inputs: b.inputs["Coat Weight"].default_value = coat
    if emit:
        b.inputs["Emission Color"].default_value = (*emit, 1)
        b.inputs["Emission Strength"].default_value = strength
    return m
M = {
    "paint": mat("Paint", (0.50, 0.48, 0.46), metal=0.55, rough=0.28, coat=0.6),
    "trim": mat("Trim", (0.025, 0.025, 0.028), rough=0.55),
    "glass": mat("Glass", (0.015, 0.02, 0.025), rough=0.05),
    "grille": mat("Grille", (0.01, 0.01, 0.012), rough=0.7),
    "tyre": mat("Tyre", (0.025, 0.025, 0.025), rough=0.9),
    "rim": mat("Rim", (0.07, 0.07, 0.075), metal=0.85, rough=0.32),
    "disc": mat("Disc", (0.35, 0.35, 0.36), metal=0.9, rough=0.45),
    "caliper": mat("Caliper", (0.6, 0.05, 0.03), rough=0.4),
    "lamp": mat("Lamp", (0.9, 0.9, 0.9), emit=(1, 0.97, 0.92), strength=8),
    "drl": mat("DRL", (0.9, 0.95, 1.0), emit=(0.85, 0.95, 1.0), strength=5),
    "housing": mat("Housing", (0.04, 0.045, 0.05), metal=0.6, rough=0.25),
    "tail": mat("Tail", (0.35, 0.01, 0.01), emit=(1.0, 0.04, 0.02), strength=4),
    "amber": mat("Amber", (0.8, 0.4, 0.0), emit=(1, 0.45, 0.0), strength=2),
    "chrome": mat("Chrome", (0.8, 0.8, 0.8), metal=1.0, rough=0.12),
}

AXF, AXR, TRACK, WR, WW = 1.40, -1.40, 0.92, 0.374, 0.30
Y_FRONT, Y_REAR = 2.586, -2.387

# ---------------- the body's shape, as functions of y ----------------
def g(d, s): return math.exp(-(d / s) ** 2)
def smooth01(t): t = min(1, max(0, t)); return t * t * (3 - 2 * t)
def lerp(a, b, t): return a + (b - a) * t
def piece(y, pts):
    """piecewise-linear through [(y, v)] given front→rear (y descending)"""
    if y >= pts[0][0]: return pts[0][1]
    for (y0, v0), (y1, v1) in zip(pts, pts[1:]):
        if y1 <= y <= y0: return lerp(v0, v1, (y0 - y) / (y0 - y1))
    return pts[-1][1]

def W(y):
    """half width of the body side at y: doors 1.00, swelling over each wheel, rounded nose and tail"""
    w = 1.00 + 0.075 * g(y - AXF, 0.55) + 0.09 * g(y - AXR, 0.62)
    if y > 1.95: w -= 0.30 * ((y - 1.95) / (Y_FRONT - 1.95)) ** 2
    if y < -1.95: w -= 0.16 * ((-1.95 - y) / (-1.95 - Y_REAR)) ** 2
    return w
def z_rocker(y): return piece(y, [(Y_FRONT, 0.17), (2.0, 0.17), (1.0, 0.19), (-1.0, 0.19), (-2.0, 0.24), (Y_REAR, 0.30)])
def z_crease(y): return piece(y, [(Y_FRONT, 0.44), (2.1, 0.58), (1.4, 0.64), (0.0, 0.67), (-1.4, 0.71), (-2.1, 0.74), (Y_REAR, 0.70)])
def z_top(y):   # where the side turns into the hood / beltline / deck
    return piece(y, [(Y_FRONT, 0.50), (2.35, 0.58), (1.9, 0.68), (1.4, 0.74), (0.9, 0.80), (0.62, 0.84), (0.0, 0.88), (-1.0, 0.90), (-1.75, 0.93), (-2.2, 0.95), (Y_REAR, 0.90)])
def fender(y):  # how much the fender/haunch tops rise over each wheel (the Lotus has tall arches)
    return 0.15 * g(y - AXF, 0.46) + 0.09 * g(y - AXR, 0.52)
def z_hood(y):  # the hood / deck centre (power dome on the hood)
    return z_top(y) + piece(y, [(Y_FRONT, 0.01), (2.2, 0.04), (1.2, 0.05), (0.62, 0.03), (-1.75, 0.02), (Y_REAR, 0.0)])
def cabin(y):   # 0 on the hood/deck, 1 under the roof, eased across the windshield and the rear glass
    if y > 0.62: return 0.0
    if y > -0.08: return smooth01((0.62 - y) / 0.70)
    if y > -0.82: return 1.0
    if y > -1.78: return 1 - smooth01((-0.82 - y) / 0.96)
    return 0.0
def z_roof(y): return piece(y, [(-0.08, 1.31), (-0.45, 1.315), (-0.82, 1.30)]) if -0.82 <= y <= -0.08 else (1.31 if y > -0.08 else 1.30)

def section(y):
    """the right half of the section at y, bottom → roof centre: 13 points (x, z) + the band each starts"""
    w, zr, zc, zt = W(y), z_rocker(y), z_crease(y), z_top(y)
    fz = fender(y)
    zc_f, zt_f = zc + 0.75 * fz, zt + fz  # the crease and the fender top swell over each wheel
    c = cabin(y)
    zh = z_hood(y)
    zrf = lerp(zh, z_roof(y), c)          # the roof centre: the hood at c = 0, the roof at c = 1
    glass_x = lerp(w - 0.24, w - 0.15, c)  # the glass base sits in from the shoulder (a ledge)
    roof_edge_x = lerp(w - 0.36, 0.67, c)
    pts = [
        (w - 0.16, zr - 0.03),      # 0 underside
        (w - 0.03, zr),             # 1 rocker bottom
        (w + 0.005, zr + 0.07),     # 2 rocker face (the skirt sticks out a touch)
        (w - 0.03, zr + 0.12),      # 3 the step into the lower door
        (w - 0.025, lerp(zr + 0.12, zc_f, 0.5)),  # 4 lower door, slightly hollow
        (w + 0.01, zc_f - 0.035),   # 5 below the crease: the side's fullest
        (w, zc_f),                  # 6 THE SHOULDER CREASE
        (w - 0.05, lerp(zc_f, zt_f, 0.6)),      # 7 fender / quarter top
        (w - 0.10, zt_f),           # 8 the fender's crown / the beltline
        (glass_x, zt + 0.015),      # 9 glass base (cabin) / hood side (hood)
        (roof_edge_x, lerp(zt + 0.02, zrf - 0.035, c)),  # 10 roof edge / hood mid
        (lerp(0.30, 0.34, c), zrf - 0.008),  # 11 roof / hood near the middle
        (0.0, zrf),                 # 12 centre
    ]
    return pts

# stations: dense, with every key y included
ys = set([Y_FRONT, Y_REAR, 2.5, 2.4, 2.3, 2.2, 0.62, -0.08, -0.82, -1.78, AXF, AXR])
y = Y_FRONT
while y > Y_REAR:
    ys.add(round(y, 4)); y -= 0.11
ys = sorted(ys, reverse=True)

def build_body():
    bm = bmesh.new()
    rows = []
    for y in ys:
        half = section(y)
        right = [Vector((x, y, z)) for x, z in half]
        left = [Vector((-x, y, z)) for x, z in reversed(half[:-1])]
        rows.append([bm.verts.new(v) for v in right + left])
    n = len(rows[0])
    faces = []
    for si, (a, b) in enumerate(zip(rows, rows[1:])):
        for i in range(n - 1):
            f = bm.faces.new((a[i], a[i + 1], b[i + 1], b[i])); faces.append((f, si, i))
        f = bm.faces.new((a[n - 1], a[0], b[0], b[n - 1])); faces.append((f, si, -1))
    bm.faces.new(list(reversed(rows[0]))); bm.faces.new(rows[-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    # materials by band: 0 paint, 1 trim (rocker / skirt + underside), 2 glass
    half_n = 13
    win = {"winds": [], "rear": [], "sideR": [], "sideL": []}
    for f, si, i in faces:
        ymid = (ys[si] + ys[si + 1]) / 2
        band = i if i < half_n - 1 else (2 * (half_n - 1) - 1 - i) if i >= 0 else -1  # mirror the band index
        if i == -1 or band in (0, 1):
            f.material_index = 1  # underside + rocker: black skirt
        c = cabin(ymid)
        if band == 9 and -1.25 < ymid < 0.50 and c > 0.15:
            (win["sideR"] if i < half_n - 1 else win["sideL"]).append(f)
        if band in (10, 11) and c > 0.55:
            if 0.62 > ymid > -0.08: win["winds"].append(f)
            elif -0.82 > ymid > -1.78: win["rear"].append(f)
    for faces_ in win.values():
        if faces_:
            bmesh.ops.inset_region(bm, faces=faces_, thickness=0.045, depth=-0.012)
            for f in faces_: f.material_index = 2
    me = bpy.data.meshes.new("Body"); bm.to_mesh(me); bm.free()
    ob = bpy.data.objects.new("Body", me); scene.collection.objects.link(ob)
    for k in ("paint", "trim", "glass"): me.materials.append(M[k])
    return ob

body = build_body()

def boolean(target, cutter, op="DIFFERENCE"):
    mod = target.modifiers.new("b", "BOOLEAN"); mod.operation = op; mod.object = cutter; mod.solver = "EXACT"
    bpy.context.view_layer.objects.active = target
    bpy.ops.object.modifier_apply(modifier=mod.name)
    bpy.data.objects.remove(cutter, do_unlink=True)

def box(name, loc, size, m, rot=(0, 0, 0), link=True):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc, rotation=rot)
    o = bpy.context.active_object; o.name = name; o.scale = size
    bpy.ops.object.transform_apply(scale=True, rotation=True, location=False)
    if m: o.data.materials.append(M[m])
    return o

def cyl(name, loc, r, depth, m, rot=(0, math.pi / 2, 0), verts=24):
    bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=r, depth=depth, location=loc, rotation=rot)
    o = bpy.context.active_object; o.name = name
    if m: o.data.materials.append(M[m])
    return o

# ---------------- wheel arches + flared lips ----------------
for y0 in (AXF, AXR):
    for s in (-1, 1):
        boolean(body, cyl("cut", (s * 1.12, y0, WR + 0.035), WR + 0.065, 0.62, None, verts=32))

def arch_lip(y0, s):
    """a flared lip round the arch: a strip from just inside the cut to a little outside the body"""
    bm = bmesh.new()
    r0, r1 = WR + 0.06, WR + 0.105
    ring = []
    for k in range(29):
        a = math.radians(-14 + 208 * k / 28)  # from a little below the front, over the top, to the rear
        dy, dz = math.cos(a), math.sin(a)
        yy = y0 + dy * r0
        x_in = W(yy) - 0.03
        x_out = W(y0 + dy * r1) + 0.035
        inner = bm.verts.new((s * x_in, yy, WR + 0.035 + dz * r0))
        outer = bm.verts.new((s * x_out, y0 + dy * r1, WR + 0.035 + dz * r1))
        ring.append((inner, outer))
    for (a1, b1), (a2, b2) in zip(ring, ring[1:]):
        bm.faces.new((a1, a2, b2, b1) if s > 0 else (a1, b1, b2, a2))
    bmesh.ops.solidify(bm, geom=bm.faces[:], thickness=0.03)
    me = bpy.data.meshes.new("Lip"); bm.to_mesh(me); bm.free()
    o = bpy.data.objects.new("ArchLip", me); scene.collection.objects.link(o)
    me.materials.append(M["paint"])
for y0 in (AXF, AXR):
    for s in (-1, 1):
        arch_lip(y0, s)

# ---------------- the front: intakes, splitter, headlights ----------------
zf = z_rocker(Y_FRONT)
boolean(body, box("cut", (0, Y_FRONT, 0.30), (1.0, 0.5, 0.17), None))                  # central intake
box("Grille", (0, Y_FRONT - 0.16, 0.30), (0.98, 0.04, 0.16), "grille")
for k in range(3):
    box("GrilleBar", (0, Y_FRONT - 0.13, 0.25 + k * 0.045), (0.97, 0.025, 0.005), "trim")
for s in (-1, 1):
    surface_patch("SideIntake", 2.30, 2.52, 2.2, 4.4, 0.006, "grille", s, 3, 3)  # flush, on the bumper corner
box("Splitter", (0, Y_FRONT - 0.06, 0.13), (1.70, 0.20, 0.02), "trim")

# headlights: a LAMP CLUSTER laid on the nose-corner surface — a dark glossy lens following the panel
# (points 7 → 10 of the section, y 2.06 → 2.40), two lamps and an LED strip set into it
def surface_patch(name, y0, y1, i0, i1, lift, m, s, ny=6, nu=5, shrink=0.0):
    bm = bmesh.new(); grid = []
    for a_ in range(ny + 1):
        y = y0 + (y1 - y0) * a_ / ny
        sec = section(y)
        row = []
        for b_ in range(nu + 1):
            t = i0 + (i1 - i0) * (shrink + (1 - 2 * shrink) * b_ / nu)
            k = min(int(t), len(sec) - 2); f = t - k
            x = lerp(sec[k][0], sec[k + 1][0], f); z = lerp(sec[k][1], sec[k + 1][1], f)
            row.append(bm.verts.new((s * x, y, z + lift)))
        grid.append(row)
    for a_ in range(ny):
        for b_ in range(nu):
            q = (grid[a_][b_], grid[a_][b_ + 1], grid[a_ + 1][b_ + 1], grid[a_ + 1][b_])
            bm.faces.new(q if s > 0 else tuple(reversed(q)))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free()
    o = bpy.data.objects.new(name, me); scene.collection.objects.link(o); me.materials.append(M[m])
    return o
for s in (-1, 1):
    surface_patch("HeadLens", 2.08, 2.42, 7.2, 9.6, 0.006, "housing", s)
    surface_patch("LampA", 2.26, 2.36, 7.6, 8.2, 0.011, "lamp", s, 2, 2)
    surface_patch("LampB", 2.14, 2.24, 8.0, 8.6, 0.011, "lamp", s, 2, 2)
    surface_patch("DRL", 2.10, 2.40, 7.25, 7.4, 0.012, "drl", s, 4, 1)
    surface_patch("Indicator", 2.36, 2.42, 7.3, 8.0, 0.012, "amber", s, 1, 2)

# ---------------- the rear: taillight band, diffuser, exhausts ----------------
boolean(body, box("cut", (0, Y_REAR, 0.80), (1.74, 0.16, 0.13), None))
box("TailBand", (0, Y_REAR + 0.065, 0.80), (1.72, 0.03, 0.115), "tail")
for s in (-1, 1):
    cyl("TailLamp", (s * 0.62, Y_REAR + 0.045, 0.80), 0.045, 0.03, "lamp", rot=(math.pi / 2, 0, 0), verts=16)
box("Diffuser", (0, Y_REAR + 0.12, 0.20), (1.40, 0.30, 0.06), "trim", rot=(math.radians(-12), 0, 0))
for k in range(-2, 3):
    box("DiffFin", (k * 0.26, Y_REAR + 0.10, 0.20), (0.012, 0.30, 0.10), "trim", rot=(math.radians(-12), 0, 0))
for s in (-1, 1):
    cyl("Exhaust", (s * 0.34, Y_REAR + 0.03, 0.27), 0.05, 0.14, "chrome", rot=(math.pi / 2, 0, 0), verts=20)
    cyl("ExhaustIn", (s * 0.34, Y_REAR - 0.04, 0.27), 0.04, 0.02, "grille", rot=(math.pi / 2, 0, 0), verts=20)

# ---------------- mirrors, wing ----------------
for s in (-1, 1):
    my, mz = 0.50, z_top(0.5) + 0.07
    box("MirrorArm", (s * (W(my) - 0.08), my, mz - 0.03), (0.16, 0.05, 0.03), "trim")
    m = box("Mirror", (s * (W(my) + 0.03), my - 0.02, mz), (0.13, 0.10, 0.09), "paint")
    # taper the housing: narrower at the back (a wedge, not a brick)
    for v in m.data.vertices:
        if v.co.y < 0: v.co.z *= 0.75; v.co.x *= 0.9
for s in (-1, 1):
    box("WingStand", (s * 0.62, -2.08, z_top(-2.08) + 0.11), (0.03, 0.14, 0.20), "trim", rot=(math.radians(-8), 0, 0))
    box("Endplate", (s * 0.86, -2.11, z_top(-2.1) + 0.25), (0.012, 0.36, 0.14), "trim")
wing = box("Wing", (0, -2.11, z_top(-2.1) + 0.24), (1.72, 0.32, 0.03), "trim", rot=(math.radians(10), 0, 0))
box("Gurney", (0, -2.26, z_top(-2.1) + 0.27), (1.70, 0.012, 0.04), "trim")

# ---------------- wheels: turned tyre, dished rim with 5 twin spokes, disc + caliper ----------------
def lathe(name, prof, m, segs=36, smooth=True):
    """revolve [(r, x)] about the X axis"""
    bm = bmesh.new()
    verts = [bm.verts.new((x, 0, r)) for r, x in prof]
    edges = [bm.edges.new((a, b)) for a, b in zip(verts, verts[1:])]
    bmesh.ops.spin(bm, geom=verts + edges, cent=(0, 0, 0), axis=(1, 0, 0), angle=2 * math.pi, steps=segs, use_duplicate=False)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free()
    o = bpy.data.objects.new(name, me); scene.collection.objects.link(o)
    me.materials.append(M[m])
    for p in me.polygons: p.use_smooth = smooth
    return o

def wheel(y0, s):
    parts = []
    h = WW / 2
    tyre = lathe("Tyre", [(0.27, -h), (0.335, -h - 0.005), (0.36, -h + 0.02), (WR, -h + 0.05), (WR, h - 0.05), (0.36, h - 0.02), (0.335, h + 0.005), (0.27, h)], "tyre", 48)
    rim = lathe("Rim", [(0.255, -h + 0.02), (0.262, h - 0.04), (0.285, h - 0.01), (0.29, h + 0.01), (0.272, h + 0.012), (0.262, h - 0.02)], "rim", 40)
    hub = lathe("Hub", [(0.0, h - 0.01), (0.06, h - 0.01), (0.075, h - 0.04), (0.08, h - 0.12)], "rim", 20)
    disc = lathe("Disc", [(0.06, -0.02), (0.24, -0.02), (0.24, 0.0), (0.06, 0.0)], "disc", 32)
    parts += [tyre, rim, hub, disc]
    cal = box("Caliper", (0.03, -0.12, 0.17), (0.07, 0.16, 0.10), "caliper")
    parts.append(cal)
    for k in range(5):
        a = k * 2 * math.pi / 5
        for off in (-0.07, 0.07):
            aa = a + off
            sp = box("Spoke", (0, 0, 0), (0.022, 0.032, 0.21), "rim")
            # a spoke from the hub to the lip, leaning out (the dish)
            sp.matrix_world = Matrix.Rotation(aa, 4, "X") @ Matrix.Translation((h - 0.045, 0, 0.17)) @ Matrix.Rotation(math.radians(-14), 4, "Y")
            parts.append(sp)
    # join, then place: mirror for the left side (the dish faces out)
    for o in parts: o.select_set(False)
    bpy.ops.object.select_all(action="DESELECT")
    for o in parts: o.select_set(True)
    bpy.context.view_layer.objects.active = tyre
    bpy.ops.object.join()
    w = bpy.context.active_object; w.name = f"Wheel_{'F' if y0 > 0 else 'R'}{'R' if s > 0 else 'L'}"
    w.scale = (s, 1, 1)
    w.location = (s * TRACK, y0, WR)
    return w

for y0 in (AXF, AXR):
    for s in (-1, 1):
        wheel(y0, s)

# SMOOTH BY ANGLE on the body: the facets of the dense mesh read as stripes when flat-shaded; under
# ~28° they blend, and the real edges (the crease, the arches, the cuts, the window frames) stay crisp
bpy.ops.object.select_all(action="DESELECT")
body.select_set(True); bpy.context.view_layer.objects.active = body
try:
    bpy.ops.object.shade_smooth_by_angle(angle=math.radians(28))
except Exception as e:
    print("smooth by angle failed", e)
for o in scene.objects:
    if o.type == "MESH" and o is not body and not o.name.startswith("Wheel"):
        for p in o.data.polygons: p.use_smooth = False

if "--lotus" in args:
    # the Lotus as a translucent GHOST over ours: proportions check
    bpy.ops.import_scene.gltf(filepath=os.path.join(here, "lotus_ref.glb"))
    ghost = bpy.data.materials.new("Ghost"); ghost.use_nodes = True
    gb = ghost.node_tree.nodes["Principled BSDF"]; gb.inputs["Base Color"].default_value = (0.1, 0.5, 1.0, 1); gb.inputs["Alpha"].default_value = 0.25
    ghost.blend_method = "BLEND" if hasattr(ghost, "blend_method") else ghost.blend_method
    turn = Matrix.Translation((0, -0.15, 0)) @ Matrix.Rotation(math.pi, 4, "Z")  # world origin, then axle midpoint to 0
    for o in bpy.context.selected_objects:
        if o.type == "MESH":
            o.data.materials.clear(); o.data.materials.append(ghost)
        if o.parent is None:
            o.matrix_world = turn @ o.matrix_world
    bpy.context.view_layer.update()

studio.studio(scene)
studio.engine(scene)
studio.shoot(scene, out_dir, "car")
