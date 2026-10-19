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
    """a SMOOTH curve through [(y, v)] given front→rear (y descending): cubic Hermite with Catmull-Rom
    slopes (round 6 — the piecewise-linear profiles put a kink at every key y, read as ripples in the paint)"""
    if y >= pts[0][0]: return pts[0][1]
    if y <= pts[-1][0]: return pts[-1][1]
    n = len(pts)
    def slope(i):
        a, b = pts[max(i - 1, 0)], pts[min(i + 1, n - 1)]
        return (b[1] - a[1]) / (b[0] - a[0])
    for i in range(n - 1):
        (y0, v0), (y1, v1) = pts[i], pts[i + 1]
        if y1 <= y <= y0:
            h = y1 - y0; t = (y - y0) / h
            m0, m1 = slope(i) * h, slope(i + 1) * h
            t2, t3 = t * t, t * t * t
            return (2 * t3 - 3 * t2 + 1) * v0 + (t3 - 2 * t2 + t) * m0 + (-2 * t3 + 3 * t2) * v1 + (t3 - t2) * m1
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
    return 0.12 * g(y - AXF, 0.62) + 0.09 * g(y - AXR, 0.58)
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
        (glass_x, zt + 0.02 + 0.7 * fz),      # 9 glass base (cabin) / hood side (hood): the valley rides up with the fender
        (roof_edge_x, lerp(zt + 0.02 + 0.15 * fz, zrf - 0.035, c)),  # 10 roof edge / hood mid
        (lerp(0.30, 0.34, c), zrf - 0.008),  # 11 roof / hood near the middle
        (0.0, zrf),                 # 12 centre
    ]
    if y > 2.40:   # round the nose off in plan and elevation (it ended in a big flat plate)
        t = ((y - 2.40) / (Y_FRONT - 2.40)) ** 2
        pts = [(x * (1 - 0.13 * t), lerp(z, 0.34, 0.22 * t)) for x, z in pts]
    if y < -2.20:  # and the tail (it ended in a flat box)
        t = ((-2.20 - y) / (-2.20 - Y_REAR)) ** 2
        pts = [(x * (1 - 0.07 * t), lerp(z, 0.58, 0.10 * t)) for x, z in pts]
    return pts

# the section between its points: smooth (cubic Hermite) across the fender / hood / roof, where flat
# facets made the paint lumpy; the crease, the skirt steps and (in the cabin) the glass edges stay sharp
SUB = {7: 3, 8: 3, 9: 3, 10: 4, 11: 4}   # faces per segment (others: 1)
def sec_slopes(y, pts):
    c = cabin(y)
    soft = {7: 1.0, 8: 1.0 - 0.7 * c, 9: 1.0 - c, 10: 1.0 - c, 11: 1.0, 12: 1.0}
    ext = pts + [(-pts[11][0], pts[11][1])]
    m = []
    for k in range(13):
        f = soft.get(k, 0.0)
        a, b = ext[max(k - 1, 0)], ext[k + 1]
        m.append(((b[0] - a[0]) * 0.5 * f, (b[1] - a[1]) * 0.5 * f))
    return m
def sec_point(pts, m, u):
    k = min(int(u), len(pts) - 2); t = u - k
    if k not in SUB: return (lerp(pts[k][0], pts[k + 1][0], t), lerp(pts[k][1], pts[k + 1][1], t))
    t2, t3 = t * t, t * t * t
    h00, h10, h01, h11 = 2 * t3 - 3 * t2 + 1, t3 - 2 * t2 + t, -2 * t3 + 3 * t2, t3 - t2
    return tuple(h00 * pts[k][j] + h10 * m[k][j] + h01 * pts[k + 1][j] + h11 * m[k + 1][j] for j in (0, 1))
def curve_point(y, u):
    pts = section(y); return sec_point(pts, sec_slopes(y, pts), u)
def section_dense(y):
    """(points, band of the face that starts at each point)"""
    pts = section(y); m = sec_slopes(y, pts)
    out, bands = [], []
    for k in range(12):
        n = SUB.get(k, 1)
        for j in range(n):
            out.append(sec_point(pts, m, k + j / n)); bands.append(k)
    out.append(pts[12]); bands.append(12)
    return out, bands

# stations: dense, with every key y included
ys = set([Y_FRONT, Y_REAR, 2.5, 2.4, 2.3, 2.2, 0.62, -0.08, -0.82, -1.78, AXF, AXR])
y = Y_FRONT
while y > Y_REAR:
    ys.add(round(y, 4)); y -= 0.08
ys = sorted(ys, reverse=True)

def build_body():
    bm = bmesh.new()
    rows = []
    for y in ys:
        half, BANDS = section_dense(y)
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
    _, BANDS = section_dense(0.0); half_n = len(BANDS)
    win = {"winds": [], "rear": [], "sideR": [], "sideL": []}
    for f, si, i in faces:
        ymid = (ys[si] + ys[si + 1]) / 2
        band = BANDS[i if i < half_n - 1 else (2 * (half_n - 1) - 1 - i)] if i >= 0 else -1  # mirror the band index
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

import time
BOOL_SOLVER = os.environ.get("CAR_BOOL", "FAST")  # round 5 stalled >10 min on EXACT with the denser body
def boolean(target, cutter, op="DIFFERENCE"):
    t0 = time.time(); name = cutter.name
    if os.environ.get("CAR_NOBOOL"):
        bpy.data.objects.remove(cutter, do_unlink=True); return
    mod = target.modifiers.new("b", "BOOLEAN"); mod.operation = op; mod.object = cutter
    for s in (BOOL_SOLVER, "FLOAT", "FAST"):  # Blender 5 renamed FAST → FLOAT
        try: mod.solver = s; break
        except Exception: pass
    bpy.context.view_layer.objects.active = target
    bpy.ops.object.modifier_apply(modifier=mod.name)
    bpy.data.objects.remove(cutter, do_unlink=True)
    print(f"BOOL {name} {mod_solver_name(target)} {time.time() - t0:.1f}s", flush=True)
def mod_solver_name(_): return BOOL_SOLVER

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
ARCH_Z, ARCH_R, ARCH_XIN = WR + 0.01, WR + 0.05, 0.87   # arch centre height, radius, the well's inner wall

def body_x(y, z):
    """the body side's x at height z (walks the outer profile, points 1 → 8)"""
    sec = [curve_point(y, 3 + k / 6) for k in range(31)]   # points 3 → 8 on the smooth curve (not the skirt's jog)
    if z <= sec[0][1]: return sec[0][0]
    for (x0, z0), (x1, z1) in zip(sec, sec[1:]):
        if z0 <= z <= z1 and z1 > z0: return lerp(x0, x1, (z - z0) / (z1 - z0))
    return sec[-1][0]

for y0 in (AXF, AXR):
    for s in (-1, 1):
        # the FAST solver sometimes silently does nothing (the front arches in round 6): check, and retry
        # with the cutter nudged off the stations / section points
        for attempt in range(6):
            j = 0.0037 * attempt
            # the cutter is DARK: the well walls the boolean leaves behind take its material (in round 5
            # they were paint, seen through the arch as a ghost ring round the wheel)
            c = cyl("cut", (s * (ARCH_XIN + 0.35 + j), y0 + j, ARCH_Z), ARCH_R, 0.70, "grille", verts=48)
            c.rotation_euler.x = 0.004 * attempt
            boolean(body, c)
            inside = [v for v in body.data.vertices if s * v.co.x > ARCH_XIN + 0.03 and
                      (v.co.y - y0) ** 2 + (v.co.z - ARCH_Z) ** 2 < (ARCH_R - 0.02) ** 2]
            print(f"ARCH CHECK y0={y0} s={s} try {attempt}: {len(inside)} body verts left inside", flush=True)
            if not inside: break

ARC = [math.radians(-28 + 236 * k / 40) for k in range(41)]   # low at the front, over the top, low at the rear
ARC_LIP = [math.radians(-11 + 202 * k / 40) for k in range(41)]  # the lip stops above the black skirt
def arch_lip(y0, s):
    """the flare: a rounded lip that grows out of the body surface round the arch edge"""
    bm = bmesh.new(); rows = []
    for a in ARC_LIP:
        dy, dz = math.cos(a), math.sin(a)
        row = []
        # (radius, x offset from the body surface): inside the edge → the lip's crown → back to the body
        for dr, dx in ((-0.004, -0.035), (0.0, 0.010), (0.012, 0.024), (0.030, 0.016), (0.055, -0.006)):
            r = ARCH_R + dr; yy, zz = y0 + dy * r, ARCH_Z + dz * r
            row.append(bm.verts.new((s * (body_x(yy, zz) + dx), yy, zz)))
        rows.append(row)
    for ra, rb in zip(rows, rows[1:]):
        for i in range(len(ra) - 1):
            q = (ra[i], rb[i], rb[i + 1], ra[i + 1])
            bm.faces.new(q if s > 0 else tuple(reversed(q)))
    me = bpy.data.meshes.new("Lip"); bm.to_mesh(me); bm.free()
    o = bpy.data.objects.new("ArchLip", me); scene.collection.objects.link(o)
    me.materials.append(M["paint"])
    for p in me.polygons: p.use_smooth = True
    return o

def arch_liner(y0, s):
    """the wheel well: a dark tub (arc surface + inner wall) so the arch never shows the hollow shell"""
    bm = bmesh.new(); rows = []
    r = ARCH_R + 0.004
    for a in ARC:
        dy, dz = math.cos(a), math.sin(a)
        yy, zz = y0 + dy * r, ARCH_Z + dz * r
        rows.append((bm.verts.new((s * ARCH_XIN, yy, zz)), bm.verts.new((s * (body_x(yy, zz) - 0.03), yy, zz))))
    for (a1, b1), (a2, b2) in zip(rows, rows[1:]):
        bm.faces.new((a1, a2, b2, b1))
    cen = bm.verts.new((s * ARCH_XIN, y0, ARCH_Z - 0.10))
    for (a1, _), (a2, _) in zip(rows, rows[1:]):
        bm.faces.new((cen, a1, a2))
    me = bpy.data.meshes.new("Liner"); bm.to_mesh(me); bm.free()
    o = bpy.data.objects.new("ArchLiner", me); scene.collection.objects.link(o)
    me.materials.append(M["grille"])
    return o

for y0 in (AXF, AXR):
    for s in (-1, 1):
        arch_lip(y0, s)

# ---------------- the front: intakes, splitter, headlights ----------------
zf = z_rocker(Y_FRONT)
boolean(body, box("cut", (0, Y_FRONT, 0.30), (1.0, 0.5, 0.17), "grille"))   # dark walls: a clean black opening                  # central intake
box("Grille", (0, Y_FRONT - 0.16, 0.30), (0.98, 0.04, 0.16), "grille")
for k in range(3):
    box("GrilleBar", (0, Y_FRONT - 0.13, 0.25 + k * 0.045), (0.97, 0.025, 0.005), "trim")
box("Splitter", (0, Y_FRONT - 0.07, 0.13), (1.46, 0.20, 0.02), "trim")

# headlights + corner vents (round 6): SHAPED PATCHES that follow the body. A patch is a grid over
# (t: rear → front along y, v: −1 → +1 across the section index band); each row's band is centred on
# c(t) with half width h(t) * a shape that rounds the ends, and every vertex is pushed out along the
# body's normal. The boundary ring tucks just under the paint: a crisp bevelled edge, no float, no z-fight.
def surf(y, u):
    x, z = curve_point(y, u)
    return Vector((x, y, z))
def surf_n(y, u):
    du = surf(y, u + 0.02) - surf(y, u - 0.02)
    dy = surf(y + 0.01, u) - surf(y - 0.01, u)
    n = dy.cross(du).normalized()
    return n if n.x + n.z > 0 else -n
def shaped_patch(name, y0, y1, c0, c1, h0, h1, lift, m, s, ny=14, nu=6, round_=0.35, edge=0.006):
    bm = bmesh.new(); grid = []
    for a_ in range(ny + 1):
        t = a_ / ny; y = lerp(y0, y1, t)
        h = lerp(h0, h1, t) * max(0.18, math.sin(math.pi * t) ** round_)
        c = lerp(c0, c1, t); row = []
        for b_ in range(nu + 1):
            v = -1 + 2 * b_ / nu
            p = surf(y, c + v * h)
            border = a_ in (0, ny) or b_ in (0, nu)
            p = p + surf_n(y, c + v * h) * (lift - (lift + edge) * border)
            row.append(bm.verts.new((s * p.x, p.y, p.z)))
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
    # the headlight: a swept blade from high on the fender (rear) down round the nose corner (front)
    shaped_patch("HeadLens", 1.98, 2.50, 8.75, 7.05, 0.62, 0.85, 0.010, "housing", s)
    shaped_patch("DRL", 2.00, 2.47, 9.05, 7.62, 0.10, 0.10, 0.016, "drl", s, ny=14, nu=1, round_=0.2, edge=0.004)
    shaped_patch("LampMain", 2.26, 2.44, 7.65, 7.20, 0.36, 0.34, 0.016, "lamp", s, ny=6, nu=3, round_=0.5, edge=0.004)
    shaped_patch("Indicator", 2.04, 2.15, 8.50, 8.30, 0.22, 0.22, 0.016, "amber", s, ny=3, nu=2, round_=0.4, edge=0.004)
    # the corner vent: a dark slanted recess low on the bumper corner
    shaped_patch("SideIntake", 2.16, 2.50, 4.0, 3.55, 0.75, 0.55, 0.004, "grille", s, ny=10, nu=4, round_=0.25, edge=0.010)

# ---------------- the rear: taillight band, diffuser, exhausts ----------------
# a recessed dark light bar across the tail, a thin red LED line in it, and a C-shaped lamp at each end
boolean(body, box("cut", (0, Y_REAR, 0.79), (1.46, 0.16, 0.10), "housing"))
box("TailHousing", (0, Y_REAR + 0.055, 0.79), (1.44, 0.03, 0.095), "housing")
box("TailBand", (0, Y_REAR + 0.045, 0.79), (1.04, 0.012, 0.018), "tail")
for s in (-1, 1):
    box("TailLampTop", (s * 0.61, Y_REAR + 0.045, 0.818), (0.20, 0.012, 0.022), "tail")
    box("TailLampBot", (s * 0.61, Y_REAR + 0.045, 0.762), (0.20, 0.012, 0.022), "tail")
    box("TailLampEnd", (s * 0.705, Y_REAR + 0.045, 0.79), (0.022, 0.012, 0.078), "tail")
box("RearValance", (0, Y_REAR, 0.385), (1.30, 0.02, 0.15), "trim")   # a dark lower panel: the exhausts sit in it
box("Diffuser", (0, Y_REAR + 0.12, 0.20), (1.40, 0.30, 0.06), "trim", rot=(math.radians(-12), 0, 0))
for k in range(-2, 3):
    box("DiffFin", (k * 0.26, Y_REAR + 0.10, 0.20), (0.012, 0.30, 0.10), "trim", rot=(math.radians(-12), 0, 0))
for s in (-1, 1):
    cyl("Exhaust", (s * 0.20, Y_REAR + 0.02, 0.36), 0.058, 0.16, "chrome", rot=(math.pi / 2, 0, 0), verts=24)
    cyl("ExhaustIn", (s * 0.20, Y_REAR - 0.056, 0.36), 0.046, 0.012, "grille", rot=(math.pi / 2, 0, 0), verts=24)

# ---------------- mirrors, wing ----------------
for s in (-1, 1):
    # a slim stalk off the door top and an aero pod (a squashed sphere, flat dark glass at its back)
    my, mz = 0.44, z_top(0.44) + 0.10
    box("MirrorArm", (s * (W(my) - 0.04), my + 0.01, mz - 0.05), (0.13, 0.04, 0.022), "trim", rot=(0, s * math.radians(-25), 0))
    bpy.ops.mesh.primitive_uv_sphere_add(segments=20, ring_count=12, radius=1, location=(s * (W(my) + 0.04), my, mz))
    m = bpy.context.active_object; m.name = "Mirror"; m.scale = (0.10, 0.075, 0.055)
    bpy.ops.object.transform_apply(scale=True, location=False)
    for v in m.data.vertices:
        if v.co.y < 0: v.co.y *= 0.35   # flat back
    m.data.materials.append(M["paint"])
    box("MirrorGlass", (s * (W(my) + 0.04), my - 0.028, mz), (0.17, 0.004, 0.08), "glass")
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
SMOOTH = ("ArchLip", "HeadLens", "Lamp", "DRL", "Indicator", "SideIntake", "Mirror")
for o in scene.objects:
    if o.type == "MESH" and o is not body and not o.name.startswith("Wheel"):
        sm = o.name.startswith(SMOOTH) and not o.name.startswith("MirrorArm")
        for p in o.data.polygons: p.use_smooth = sm

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

if "--close" in args:   # close-ups for checking details (front corner, front arch from the side, hood from above)
    cam = scene.camera
    for name, pos, tgt in [("closeNose", (2.6, 4.6, 1.3), (0.6, 2.1, 0.55)), ("closeArch", (3.6, 1.4, 0.7), (0.9, 1.4, 0.5)),
                           ("closeHood", (1.8, 4.2, 2.6), (0.0, 1.2, 0.7))]:
        cam.location = pos
        cam.rotation_euler = (Vector(tgt) - Vector(pos)).to_track_quat("-Z", "Y").to_euler()
        scene.render.filepath = os.path.join(out_dir, f"car_{name}.png")
        bpy.ops.render.render(write_still=True)

sys.stdout.flush(); os._exit(0)   # Blender 5 hung on exit after the renders
