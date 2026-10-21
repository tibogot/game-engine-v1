"""TURNIN' TURBO DASHBOARD (Tomy, 1983) — the toy's plastic shell, for games/turnin-turbo (step 2 of its PLAN.md).

Measured from a straight front photo (the toy ~40 cm wide: 0.294 mm per photo pixel), the 3/4 photo and the bezel
taken out of its shell (Raspberry Pi magazine, the Out Run conversion). GAME coordinates and metres: x right, y up,
the FRONT (the player's side) at +Z; the glTF comes out in the same frame (Blender's Y-up export undoes G()).

Parts, each its own object (the page gives them their materials by name):
    Shell         the red body: a car nose at the back (fender bulges round the headlight pods), lofted + subdivided
    Bumper        the black band round the back            Pods          the two grey headlight caps
    Bezel         the dark slate front (outlines in photo pixels, see THE FRONT FACE), BezelRim (its sides),
                  ClusterWalls / ScreenWalls (the flared window walls), BezelDetail (cheek buttons, vent slats),
                  ColumnShroud, VentBack, KeyBarrel           Console (red base), ConsoleHousing / Slot / Slide / Rail
    Wheel         rim, four spokes, hub (origin = its centre, faces its local +Z; the page spins it about that)
    KeyHead       the ignition key (origin on the lock axis)    KeyLock, ResetButton, Lever (origin at the slot)
    UV planes     ClusterFace, ScreenFilm (curved), ScreenGlass, ClusterGlass, ShifterLabel, HubBadge, TopSticker,
                  StripPrint (COUNTER RESET, OFF / ON)

    "C:/Program Files/Blender Foundation/Blender 5.0/blender.exe" -b --factory-startup \\
        --python tools/blender/turninTurbo.py -- public/models/turnin-turbo/turbo.glb
"""
import sys, os, math
import bpy, bmesh
from mathutils import Vector, Matrix

for _o in list(bpy.data.objects): bpy.data.objects.remove(_o)   # factory scene: cube, camera, light

# --- frames: build in GAME space, store in Blender space ---------------------------------------------------------
R4 = Matrix(((1, 0, 0, 0), (0, 0, -1, 0), (0, 1, 0, 0), (0, 0, 0, 1)))   # game (x, y, z) -> Blender (x, -z, y)
R3 = R4.to_3x3()

def gmat(origin=(0, 0, 0), ex=(1, 0, 0), ey=(0, 1, 0)):
    """A game-space transform: origin, local x and y axes (z = x × y)."""
    ex = Vector(ex).normalized(); ey = Vector(ey).normalized(); ez = ex.cross(ey).normalized(); ey = ez.cross(ex)
    m = Matrix.Identity(4)
    for i in range(3):
        m[i][0], m[i][1], m[i][2], m[i][3] = ex[i], ey[i], ez[i], origin[i]
    return m

def link(name, me, material, m_game=None):
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    if material: me.materials.append(material)
    if m_game is not None: ob.matrix_world = R4 @ m_game @ R4.inverted()
    return ob

def smooth(me, angle=40):
    me.polygons.foreach_set("use_smooth", [True] * len(me.polygons))
    me.set_sharp_from_angle(angle=math.radians(angle))
    me.update()

def to_blender(me):
    me.transform(R4)

MATS = {}
def mat(name, rgb, rough=0.4):
    m = bpy.data.materials.new(name)
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*rgb, 1)
    b.inputs["Roughness"].default_value = rough
    MATS[name] = m
    return m

RED = mat("Red", (0.62, 0.03, 0.02), 0.3)
SLATE = mat("Slate", (0.035, 0.042, 0.05), 0.55)
BLACK = mat("Black", (0.012, 0.012, 0.013), 0.35)
GREY = mat("Grey", (0.33, 0.34, 0.35), 0.45)
FACE = mat("Face", (0.5, 0.5, 0.5), 0.6)       # the UV planes: the page puts its own textures / shaders on them

# --- 2D outlines -----------------------------------------------------------------------------------------------
def rpoly(pts, r, seg=6):
    """A polygon with rounded corners (r: one radius or one per corner)."""
    out = []
    n = len(pts)
    for i in range(n):
        p0, p1, p2 = Vector(pts[i - 1]), Vector(pts[i]), Vector(pts[(i + 1) % n])
        rr = r[i] if isinstance(r, (list, tuple)) else r
        d1, d2 = (p0 - p1).normalized(), (p2 - p1).normalized()
        ang = math.acos(max(-1.0, min(1.0, d1.dot(d2))))
        if rr <= 0 or ang > math.pi - 1e-3:
            out.append(p1); continue
        t = rr / math.tan(ang / 2)
        a, b = p1 + d1 * t, p1 + d2 * t
        c = p1 + (d1 + d2).normalized() * (rr / math.sin(ang / 2))
        a0 = math.atan2(a.y - c.y, a.x - c.x); a1 = math.atan2(b.y - c.y, b.x - c.x)
        da = (a1 - a0 + math.pi) % (2 * math.pi) - math.pi
        for k in range(seg + 1):
            q = a0 + da * k / seg
            out.append(c + Vector((math.cos(q), math.sin(q))) * rr)
    return [(p.x, p.y) for p in out]

def rrect(cx, cy, w, h, r, seg=6):
    x0, x1, y0, y1 = cx - w / 2, cx + w / 2, cy - h / 2, cy + h / 2
    return rpoly([(x0, y0), (x1, y0), (x1, y1), (x0, y1)], r, seg)

def circle(cx, cy, r, n=32):
    return [(cx + r * math.cos(2 * math.pi * i / n), cy + r * math.sin(2 * math.pi * i / n)) for i in range(n)]

def offset2d(loop, d):
    """Offset a closed CCW loop outwards by d (miter, fine for gentle outlines)."""
    n = len(loop); out = []
    for i in range(n):
        p0, p1, p2 = Vector(loop[i - 1]), Vector(loop[i]), Vector(loop[(i + 1) % n])
        t = ((p1 - p0).normalized() + (p2 - p1).normalized()).normalized()
        nrm = Vector((t.y, -t.x))
        out.append(tuple(p1 + nrm * d))
    return out

# --- solids ----------------------------------------------------------------------------------------------------
def slab(name, loops, z0, z1, bevel, material, m_game=None, res=3):
    """Outlines (outer first, then holes) in the local XY plane, filled and extruded from local z0 to z1, every edge
    rounded by `bevel` (a Blender 2D curve: the bevel is exact round, holes come for free)."""
    cu = bpy.data.curves.new(name, "CURVE")
    cu.dimensions = "2D"; cu.fill_mode = "BOTH"
    cu.extrude = max((z1 - z0) / 2 - bevel, 0.0)
    cu.bevel_depth = bevel; cu.bevel_resolution = res
    for loop in loops:
        sp = cu.splines.new("POLY"); sp.points.add(len(loop) - 1)
        for i, (u, v) in enumerate(loop):
            sp.points[i].co = (u, v, 0, 1)
        sp.use_cyclic_u = True
    tmp = bpy.data.objects.new(name + "_c", cu)
    bpy.context.scene.collection.objects.link(tmp)
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(tmp.evaluated_get(dg))
    bpy.data.objects.remove(tmp); bpy.data.curves.remove(cu)
    me.transform(Matrix.Translation((0, 0, (z0 + z1) / 2)))
    smooth(me, 35)
    to_blender(me)
    return link(name, me, material, m_game)

def mesh_from(name, verts, faces, material, m_game=None, angle=40, subsurf=0, recalc=True):
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(v) for v in verts], [], faces)
    me.validate(); me.update()
    if recalc:
        bm = bmesh.new(); bm.from_mesh(me)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        bm.to_mesh(me); bm.free()
    to_blender(me)
    ob = link(name, me, material, m_game)
    if subsurf:
        mod = ob.modifiers.new("sub", "SUBSURF"); mod.levels = subsurf; mod.render_levels = subsurf
        dg = bpy.context.evaluated_depsgraph_get()
        me2 = bpy.data.meshes.new_from_object(ob.evaluated_get(dg))
        ob.modifiers.clear(); old = ob.data; ob.data = me2; bpy.data.meshes.remove(old)
    smooth(ob.data, angle)
    return ob

def loft(name, rings, material, m_game=None, wrap=False, cap0=False, cap1=False, angle=40, subsurf=0, recalc=True):
    """Quads between successive rings (each a closed loop of game-local points, the same count)."""
    n = len(rings[0]); verts = [v for r in rings for v in r]; faces = []
    m = len(rings)
    for a in range(m if wrap else m - 1):
        b = (a + 1) % m
        for i in range(n):
            j = (i + 1) % n
            faces.append((a * n + i, a * n + j, b * n + j, b * n + i))
    if cap0: faces.append(tuple(range(n))[::-1])
    if cap1: faces.append(tuple((m - 1) * n + i for i in range(n)))
    return mesh_from(name, verts, faces, material, m_game, angle, subsurf, recalc)

def lathe(name, prof, material, m_game=None, n=48, angle=40):
    """Revolve (r, h) points round the local z axis (h along z); r = 0 points close the pole."""
    prof = [(max(r, 0.0004), h) for r, h in prof]
    rings = [[(r * math.cos(2 * math.pi * i / n), r * math.sin(2 * math.pi * i / n), h) for i in range(n)] for r, h in prof]
    return loft(name, rings, material, m_game, cap0=True, cap1=True, angle=angle)

def uvplane(name, w, h, m_game, nx=1, ny=1, bulge=0.0):
    verts, uvs, faces = [], [], []
    for j in range(ny + 1):
        for i in range(nx + 1):
            u, v = i / nx, j / ny
            z = bulge * math.sin(math.pi * u) * math.sin(math.pi * v)
            verts.append((R3 @ Vector(((u - 0.5) * w, (v - 0.5) * h, z)))); uvs.append((u, v))
    for j in range(ny):
        for i in range(nx):
            a = j * (nx + 1) + i
            faces.append((a, a + 1, a + nx + 2, a + nx + 1))
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces); me.update()
    uvl = me.uv_layers.new(name="UVMap")
    for poly in me.polygons:
        for li in poly.loop_indices:
            uvl.data[li].uv = uvs[me.loops[li].vertex_index]
    smooth(me, 80)
    return link(name, me, FACE, m_game)

# =================================================================================================================
# THE BODY — a red shell, a car nose at the back: lofted side profiles across x, then subdivided
SX = [-0.2, -0.197, -0.19, -0.165, -0.14, -0.1, -0.05, 0.0, 0.05, 0.1, 0.14, 0.165, 0.19, 0.197, 0.2]

def body_profile(ax):
    f = math.exp(-((ax - 0.137) / 0.035) ** 2)       # the fender bulge round each headlight
    hr = 0.1 + 0.035 * f                              # top of the nose, at the back
    hm = 0.138 + 0.03 * f
    # the front stays BEHIND the bezel (its windows look into the shell), except the red apron under it
    return [(0.016, 0.0), (0.006, 0.0), (-0.06, 0.0), (-0.13, 0.0), (-0.166, 0.001), (-0.18, 0.016), (-0.187, 0.05),
            (-0.19, 0.08), (-0.188, hr - 0.03), (-0.181, hr - 0.004), (-0.166, hr + 0.01), (-0.137, hm),
            (-0.115, 0.163 + 0.012 * f), (-0.095, 0.162), (-0.072, 0.12), (-0.022, 0.03), (0.008, 0.028), (0.016, 0.024), (0.016, 0.004)]   # the apron: flat

rings = []
for x in SX:
    ax = abs(x)
    shrink = {0.2: 0.72, 0.197: 0.9, 0.19: 0.975}.get(round(ax, 3), 1.0)
    prof = body_profile(ax)
    cz, cy = -0.09, 0.09
    rings.append([(x, cy + (y - cy) * shrink, cz + (z - cz) * shrink) for z, y in prof])
loft("Shell", rings, RED, cap0=True, cap1=True, subsurf=2, angle=60)

# the headlight pods: grey caps set into the fenders, looking back and a little up
POD_PROF = [(0.0, 0.007), (0.013, 0.0066), (0.022, 0.0054), (0.027, 0.0034), (0.03, 0.0004), (0.031, -0.0045), (0.0305, -0.025)]
for sx in (-1, 1):
    up = math.radians(26)
    axis = Vector((0, math.sin(up), -math.cos(up)))
    lathe("Pod" + ("L" if sx < 0 else "R"), POD_PROF, GREY, gmat((sx * 0.134, 0.13, -0.178), (1, 0, 0), axis.cross(Vector((1, 0, 0)))))

# the bumper: a black band round the back, a rounded profile swept along a plan path
def bumper():
    path = rpoly([(-0.203, -0.05), (-0.203, -0.195), (0.203, -0.195), (0.203, -0.05)], [0, 0.05, 0.05, 0], 10)
    prof = [(-0.006, 0.046), (0.006, 0.046), (0.0095, 0.0475), (0.011, 0.051), (0.011, 0.064), (0.0095, 0.0655),
            (0.011, 0.067), (0.011, 0.08), (0.0095, 0.0835), (0.006, 0.085), (-0.006, 0.085)]
    rings = []
    for i, (x, z) in enumerate(path):
        p = Vector((x, z))
        a = Vector(path[max(i - 1, 0)]); b = Vector(path[min(i + 1, len(path) - 1)])
        t = (b - a).normalized(); nrm = Vector((-t.y, t.x))   # outward (path runs clockwise seen from above)
        if nrm.dot(p - Vector((0, -0.09))) < 0: nrm = -nrm
        rings.append([(x + nrm.x * o, y, z + nrm.y * o) for o, y in prof])
    loft("Bumper", rings, BLACK, cap0=True, cap1=True, angle=50)
bumper()

CHROME = mat("Chrome", (0.55, 0.56, 0.57), 0.25)

# =================================================================================================================
# THE FRONT FACE — every outline measured on the straight front photo (Turbo_Dashboard.png, 1600 × 1192):
#   x = (px − 760) × 0.294 mm, y = 205 mm − (py − 165) × 0.304 mm   (the bezel plane; heights checked on the
#   bezel photographed face-on out of its shell: the front photo squashes them 3 %)
# Radii are given in photo pixels too. Edges are tight: ~1 mm, as moulded ABS.
def X(px): return (px - 760) * 0.000294
def Y(py): return 0.205 - (py - 165) * 0.000304
def P(px, py): return (X(px), Y(py))
def RP(r): return r * 0.000294
def prect(x0, y0, x1, y1, r_px, seg=6):
    """A rectangle in photo px (x0 < x1, y0 above y1), CCW from bottom-left; r_px one radius or four (BL BR TR TL)."""
    rr = [RP(v) for v in r_px] if isinstance(r_px, (list, tuple)) else RP(r_px)
    return rpoly([P(x0, y1), P(x1, y1), P(x1, y0), P(x0, y0)], rr, seg)
def ppoly(pts, r_px, seg=6):
    return rpoly([P(*p) for p in pts], [RP(v) for v in r_px], seg)

ZF = 0.02            # the bezel's front plane (built upright, then the whole face leans back FACE_TILT)
EDGE = 0.0011        # its edge radius
# The face leans back like a dashboard: 28° about its bottom edge (y 25 mm). Found by fitting the camera to the
# front photo for several tilts: at 28° the fit is best (the photo was taken ~40° above the table) AND the wheel
# and console it implies agree with the 3/4 photo (console ~12 cm deep, wheel ~12 cm out, its column straight into
# the column boss).
FACE_TILT, FACE_PIVOT_Y = 28.0, 0.025

# the bezel: one slate moulding — the cluster frame (tallest, with the left cheek), the screen frame stepped down at
# 865 px, the bottom strip; two tabs drop over the red apron round the reset button and the key
# front-face top edges: the cluster frame at 200 px, the screen frame stepped down at 262 px (above them, the top
# surfaces running back ~38 mm); the cheek's front face 80..150 px, its inner wall angling back to the panel at 205
BEZEL_MAIN = [(80, 740), (1105, 740), (1105, 668), (1440, 668), (1440, 262), (865, 262), (865, 200), (165, 200), (80, 290)]
BEZEL_MAIN_R = [10, 4, 0, 12, 70, 4, 8, 14, 14]
BEZEL_PTS = [(80, 740), (742, 740), (742, 812), (820, 812), (820, 740), (845, 740), (845, 806), (968, 806), (968, 740),
             (1105, 740), (1105, 668), (1440, 668), (1440, 262), (865, 262), (865, 200), (165, 200), (80, 290)]
BEZEL_R = [10, 0, 6, 6, 0, 0, 40, 40, 0, 4, 0, 12, 70, 4, 8, 14, 14]
CL_OPEN = (150, 232, 848, 640, 6)          # cluster opening in the frame
CL_PANEL = (205, 232, 845, 625, 3)         # the printed panel, 2 cm back: the cheek's inner wall angles back 16 mm
SC_OPEN = (905, 310, 1360, 625, 22)        # screen opening
SC_GLASS = (922, 330, 1350, 620, 26)       # the curved glass, 12 mm back
VENT = (995, 675, 1090, 722, 4)
KEY_C, KEY_R = (906, 750), 0.0165
RESET = (750, 726, 812, 808, 5)

holes = [prect(*CL_OPEN), prect(*SC_OPEN), prect(*VENT), prect(*RESET), circle(*P(*KEY_C), KEY_R + 0.0004, 48)]
slab("Bezel", [ppoly(BEZEL_PTS, BEZEL_R)] + holes, ZF - 0.006, ZF, EDGE, SLATE)
# its sides wrap back 45 mm into the red shell (the top surface you see from above)
outer = ppoly(BEZEL_MAIN, BEZEL_MAIN_R)
loft("BezelRim", [[(x, y, ZF - 0.0015) for x, y in outer], [(x, y, ZF - 0.04) for x, y in outer]], SLATE, angle=50, recalc=False)
# (outer CCW, front -> back: these faces look inwards; flip them)
_rim = bpy.data.objects["BezelRim"].data
for p in _rim.polygons: p.flip()
_rim.update()

FR = 0.009     # how far the cluster frame (with the cheek) and the screen frame stand out of the strip
cl_frame = ppoly([(80, 700), (150, 700), (150, 232), (848, 232), (848, 655), (865, 655), (865, 200), (165, 200), (80, 290)],
                 [8, 0, 6, 6, 0, 0, 8, 14, 14])
slab("ClusterFrame", [cl_frame], ZF - 0.001, ZF + FR, EDGE, SLATE)
FR_S = 0.014   # the screen's frame is a deeper box (the photo shows its top surface well)
slab("ScreenFrame", [ppoly([(865, 648), (1440, 648), (1440, 262), (865, 262)], [0, 12, 70, 4]), prect(*SC_OPEN)],
     ZF - 0.001, ZF + FR_S, EDGE, SLATE)

def flare(name, a, za, b, zb):
    """The inner walls of a window: from the opening (a, at za) to the face behind (b, at zb)."""
    ra, rb = prect(*a), prect(*b)
    assert len(ra) == len(rb)
    loft(name, [[(x, y, za) for x, y in ra], [(x, y, zb) for x, y in rb]], SLATE, angle=50, recalc=False)
flare("ClusterWalls", CL_OPEN, ZF + FR - 0.002, CL_PANEL, ZF - 0.0262)
flare("ScreenWalls", SC_OPEN, ZF + FR_S - 0.002, SC_GLASS, ZF - 0.0195)

# the left cheek: a rocker (a pill in a groove, split across) and three square push buttons
pill = prect(94, 366, 137, 432, 21, 8)
slab("CheekPill", [pill, offset2d(pill, -0.0011)], ZF + FR - 0.001, ZF + FR + 0.0007, 0.0003, SLATE)
slab("CheekPillSplit", [prect(96, 398, 135, 401, 0, 1)], ZF + FR - 0.001, ZF + FR + 0.0005, 0.0002, SLATE)
for k, (x0, y0, x1, y1) in enumerate([(97, 462, 145, 507), (107, 520, 155, 560), (112, 578, 158, 620)]):
    slab(f"CheekButton{k}", [prect(x0, y0, x1, y1, 4)], ZF + FR - 0.002, ZF + FR + 0.0016, 0.0007, SLATE)

# the column boss: a big slate wedge out of the bezel under the cluster, behind the hub; the column goes into it
shroud = ppoly([(282, 738), (522, 738), (556, 630), (248, 630)], [8, 8, 6, 6])
slab("ColumnShroud", [shroud], ZF - 0.004, ZF + 0.034, 0.0015, SLATE)

# vent: three slats in the slot, a dark box behind
for k in range(3):
    y = 684 + k * 13
    slab(f"VentSlat{k}", [prect(1000, y, 1085, y + 5, 1, 2)], ZF - 0.006, ZF - 0.0015, 0.0005, SLATE)
slab("VentBack", [prect(990, 670, 1095, 727, 2)], ZF - 0.03, ZF - 0.008, 0.001, BLACK)

# counter reset: a grey button (a chevron above, four ribs below) in its slate pocket
cx, cy = P((RESET[0] + RESET[2]) / 2, (RESET[1] + RESET[3]) / 2)
bw, bh = 0.0118, 0.0128
RB = gmat((cx, cy - 0.001, ZF))
slab("ResetButton", [rrect(0, 0, bw, bh, 0.0009)], -0.012, 0.0095, 0.0007, GREY, RB)
chev = [(-0.0028, 0.0018), (0.0, 0.0044), (0.0028, 0.0018), (0.0023, 0.0013), (0.0, 0.0034), (-0.0023, 0.0013)]
slab("ResetChevron", [chev], 0.0095, 0.0099, 0.0001, GREY, RB)
for k in range(4):
    slab(f"ResetRib{k}", [rrect(0, -0.0052 + k * 0.0014, bw - 0.004, 0.0006, 0.0002, 2)], 0.0095, 0.01, 0.0001, GREY, RB)

# the ignition: a silver ring round a black barrel, the black key in it (origin on the lock axis; OFF as photographed)
KC = P(*KEY_C)
lathe("KeyLock", [(KEY_R, -0.01), (KEY_R, 0.0012), (KEY_R - 0.0008, 0.0026), (KEY_R - 0.0035, 0.0028), (0.0118, 0.0018),
                  (0.0112, 0.0005)], CHROME, gmat((KC[0], KC[1], ZF)), n=64)
lathe("KeyBarrel", [(0.0112, -0.01), (0.0112, -0.0004), (0.0, -0.0004)], BLACK, gmat((KC[0], KC[1], ZF)), n=48)
# the key (after the user's spare-part model): a round collar on the barrel, and the flat bow standing out of the
# lock along its axis — wider than tall, the top corners chamfered, a hole near the top with five grooves either side
# of it on both faces; small edges (~0.5 mm). It turns about the lock axis (the page: KeyHead's local z).
KEYM = gmat((KC[0], KC[1], ZF - 0.0004)) @ Matrix.Rotation(math.radians(-38), 4, "Z")   # OFF, as on the photo
lathe("KeyHead", [(0.0068, 0.0), (0.0068, 0.0016), (0.0062, 0.0024), (0.0036, 0.0027), (0.0, 0.0027)], BLACK, KEYM, n=48)
# outline in (width, out along the axis), thickness across; drawn at 20 mm, scaled to the photo's ~26 × 24 mm
BOW = KEYM @ gmat((0, 0, 0), (1, 0, 0), (0, 0, 1)) @ Matrix.Diagonal((1.1, 1.3, 1.0, 1.0))
bow = rpoly([(-0.0052, 0.0022), (0.0052, 0.0022), (0.0052, 0.0058), (0.0108, 0.0068), (0.0108, 0.0158), (0.0074, 0.0204),
             (-0.0074, 0.0204), (-0.0108, 0.0158), (-0.0108, 0.0068), (-0.0052, 0.0058)],
            [0.0005, 0.0005, 0.0012, 0.0016, 0.0012, 0.0012, 0.0012, 0.0012, 0.0016, 0.0012], 3)
slab("KeyBow", [bow, circle(0.0, 0.0153, 0.0021, 24)], -0.002, 0.002, 0.0005, BLACK, BOW)
for side in (-1, 1):
    for k in range(5):
        for face in (-1, 1):
            z0 = 0.002 if face > 0 else -0.0023
            slab(f"KeyGroove{side}{k}{face}", [rrect(side * 0.0068, 0.0093 + k * 0.0021, 0.0058, 0.0007, 0.0003, 2)],
                 z0, z0 + 0.0003, 0.0001, BLACK, BOW)

# printing on the strip: COUNTER RESET, OFF / ON (a transparent decal the page draws)
uvplane("StripPrint", X(1000) - X(730), Y(668) - Y(705), gmat(((X(730) + X(1000)) / 2, (Y(668) + Y(705)) / 2, ZF + 0.00025)))

# =================================================================================================================
# THE GEAR CONSOLE — a red base under a black housing, its top a ramp up to the face; the label on the left, the
# lever slot with its grey slide, a raised rail on the right. Placed by rays from the camera fitted to the front
# photo (?ref in the page): front bottom edge on the table 11.6 cm out, top 35 mm there, 50 mm where it meets the
# face; the right side narrows towards the front.
CX0, CX1 = X(1106), X(1436)
CX1_F = 0.189
CZ0, CZ1 = 0.0, 0.116
Y_RED_F, Y_TOP_F, Y_TOP_B = 0.014, 0.035, 0.05
def ytop(z): return Y_TOP_F + (CZ1 - z) / (CZ1 - CZ0) * (Y_TOP_B - Y_TOP_F)
def yred(z): return ytop(z) - (Y_TOP_F - Y_RED_F)

plan = rpoly([(CX0, CZ1), (CX1_F, CZ1), (CX1, CZ0), (CX0, CZ0)], [0.006, 0.006, 0, 0], 6)   # (x, z)
def ring_at(fy, ins=0.0):
    return [(x, fy(z), z) for x, z in offset2d(plan, -ins)]
loft("Console", [ring_at(lambda z: 0.0, 0.002), ring_at(lambda z: 0.002), ring_at(lambda z: yred(z) - 0.001),
                 ring_at(lambda z: yred(z), 0.0008)], RED, cap0=True, cap1=True, angle=50)
loft("ConsoleHousing", [ring_at(lambda z: yred(z) - 0.0005, 0.0005), ring_at(lambda z: ytop(z) - 0.0012),
                        ring_at(lambda z: ytop(z), 0.0012)], BLACK, cap0=True, cap1=True, angle=45)

slope_dir = Vector((0, Y_TOP_B - Y_TOP_F, -(CZ1 - CZ0))).normalized()     # along the top, to the back
tlen = (Vector((0, Y_TOP_B - Y_TOP_F, CZ1 - CZ0))).length
TOP = gmat(((CX0 + CX1) / 2, (Y_TOP_F + Y_TOP_B) / 2, (CZ0 + CZ1) / 2), (1, 0, 0), slope_dir)
W = CX1 - CX0
# the label (left), the slot and its grey slide (middle), the raised right rail
uvplane("ShifterLabel", X(1300) - X(1150), tlen - 0.012, TOP @ Matrix.Translation(((X(1150) + X(1300)) / 2 - (CX0 + CX1) / 2, -0.002, 0.0003)))
SLOT_U = (X(1300) + X(1392)) / 2 - (CX0 + CX1) / 2
slab("ConsoleSlot", [rrect(SLOT_U, 0.0, X(1392) - X(1300), tlen - 0.01, 0.002),
                     rrect(SLOT_U, 0.0, X(1392) - X(1300) - 0.006, tlen - 0.016, 0.0015)], -0.014, 0.0002, 0.0005, BLACK, TOP)
slab("ConsoleSlotFloor", [rrect(SLOT_U, 0.0, X(1392) - X(1300) - 0.004, tlen - 0.014, 0.0015)], -0.015, -0.013, 0.0004, BLACK, TOP)
slab("ConsoleRail", [rrect(W / 2 - 0.0085, 0.004, 0.016, tlen - 0.01, 0.0025)], 0.0, 0.016, 0.0014, BLACK, TOP)

# the lever: a stick in the slot, the grey grip lying across it, reaching out to the right; three grooves along its
# face, a collar round the stick. Origin in the slot (the page slides it along the slot's axis, local y).
LEVER = TOP @ Matrix.Translation((SLOT_U - 0.004, 0.0, 0.0))
slab("LeverStick", [rrect(0.0, 0.0, 0.007, 0.009, 0.0008)], -0.013, 0.009, 0.0006, GREY, LEVER)
slab("LeverBlock", [rrect(0.0, 0.0, 0.011, 0.013, 0.001)], 0.004, 0.0145, 0.0008, GREY, LEVER)
G_Y0, G_Y1, G_D = 0.0135, 0.0305, 0.02             # the grip (front photo: ~60 mm with its cap, ~17 tall)
G0 = LEVER @ gmat((0, 0, 0), (1, 0, 0), (0, 0, 1))  # outline in (x, up), extruded along the slot; +z = the front
slab("LeverGrip", [rrect(0.0215, (G_Y0 + G_Y1) / 2, 0.052, G_Y1 - G_Y0, 0.0014, 4)], -G_D / 2, G_D / 2, 0.001, GREY, G0)
CAP = G0 @ gmat((-0.0045, (G_Y0 + G_Y1) / 2, 0), (0, 0, 1), (0, 1, 0))   # outline in (depth, up), extruded to -x
slab("LeverCap", [rrect(0, 0, G_D - 0.003, G_Y1 - G_Y0 - 0.003, 0.0009, 3), rrect(0, 0, G_D - 0.008, G_Y1 - G_Y0 - 0.008, 0.0005, 2)],
     0.0, 0.01, 0.0005, GREY, CAP)
slab("LeverCapPlug", [rrect(0, 0, G_D - 0.007, G_Y1 - G_Y0 - 0.007, 0.0005, 2)], 0.0, 0.0055, 0.0003, GREY, CAP)
for k in range(3):   # three grooves along the grip's front face, on its right part
    slab(f"LeverGroove{k}", [rrect(0.029, G_Y0 + 0.0045 + k * 0.004, 0.034, 0.0009, 0.0004, 2)], G_D / 2 - 0.0003,
         G_D / 2 + 0.00025, 0.0001, BLACK, G0)

# =================================================================================================================
# THE STEERING WHEEL — round its own centre, facing local +Z. 194 mm across, a 9.5 mm rim; four flat spokes at
# about 10, 2, 8 and 4 o'clock with a chrome line along one edge; a big hub with the TOMY badge.
# solved on the fitted camera: the hub at photo (415, 830), the rim's left / right / top / bottom on the photo's, its
# bottom just clear of the table: centre 87 mm up, 117 mm out, 92 mm radius, tilted back 24.5° — its column then runs
# back and down straight into the column boss
WHEEL_C = (-0.0934, 0.0873, 0.1175)
WHEEL_TILT = 24.5
WHEEL = gmat(WHEEL_C, (1, 0, 0), (0, math.cos(math.radians(WHEEL_TILT)), -math.sin(math.radians(WHEEL_TILT))))
RR, TR, TD = 0.0839, 0.0078, 0.0088
rim_rings = []
for i in range(96):
    a = 2 * math.pi * i / 96
    c, s = math.cos(a), math.sin(a)
    rim_rings.append([(c * (RR + TR * math.cos(b)), s * (RR + TR * math.cos(b)), TD * math.sin(b))
                      for b in (2 * math.pi * k / 16 for k in range(16))])
loft("WheelRim", rim_rings, BLACK, WHEEL, wrap=True, angle=70)
for a_deg, edge in ((154, 1), (26, 1), (218, -1), (322, -1)):
    a = math.radians(a_deg); c, s = math.cos(a), math.sin(a)
    rot = lambda pts: [(x * c - y * s, x * s + y * c) for x, y in pts]
    pts = rot([(0.03, -0.0088), (RR - 0.003, -0.0074), (RR - 0.003, 0.0074), (0.03, 0.0088)])
    slab(f"WheelSpoke{a_deg}", [rpoly(pts, [0.001, 0.001, 0.001, 0.001], 2)], -0.0075, -0.0015, 0.0012, BLACK, WHEEL)
    line = rot([(0.036, edge * 0.0078), (RR - 0.008, edge * 0.0066), (RR - 0.008, edge * 0.0074), (0.036, edge * 0.0086)])
    slab(f"WheelChrome{a_deg}", [line if edge > 0 else line[::-1]], -0.0016, -0.0013, 0.0001, CHROME, WHEEL)
hub = rrect(0, 0, 0.08, 0.057, 0.016, 8)
slab("WheelHub", [hub], -0.014, 0.003, 0.0022, BLACK, WHEEL)
uvplane("HubBadge", 0.05, 0.03, WHEEL @ Matrix.Translation((0, 0, 0.0032)))
lathe("WheelColumn", [(0.011, -0.1), (0.011, -0.02), (0.014, -0.018)], BLACK, WHEEL)

# =================================================================================================================
# the faces the page textures: the cluster panel, the film (curved like the frosted screen), the glass, the sticker
def rect_c(r):
    x0, y0, x1, y1, _ = r
    return (X(x0) + X(x1)) / 2, (Y(y0) + Y(y1)) / 2, X(x1) - X(x0), Y(y0) - Y(y1)
cx, cy, w, h = rect_c(CL_PANEL)
uvplane("ClusterFace", w + 0.002, h + 0.002, gmat((cx, cy - 0.0051, ZF - 0.0237)))   # parallax: see FACE_TILT
cx, cy, w, h = rect_c(CL_OPEN)
uvplane("ClusterGlass", w, h, gmat((cx, cy, ZF - 0.0045)))
slab("ClusterBack", [rrect(cx, cy, w + 0.01, h + 0.01, 0.004)], ZF - 0.027, ZF - 0.025, 0.0005, BLACK)
cx, cy, w, h = rect_c(SC_GLASS)
uvplane("ScreenFilm", w + 0.004, h + 0.004, gmat((cx, cy, ZF - 0.0185)), 24, 16, 0.0035)
uvplane("ScreenGlass", w + 0.001, h + 0.001, gmat((cx, cy, ZF - 0.0128)), 24, 16, 0.003)
# the TURNIN' TURBO DASHBOARD sticker on the red top, just behind the bezel (left of centre)
uvplane("TopSticker", X(815) - X(230), 0.02, gmat(((X(230) + X(815)) / 2, 0.1655, -0.102), (-1, 0, 0), (0, 0, 1)))

# =================================================================================================================
# lean the face back (everything built on the upright front plane)
FACE_PARTS = ("Bezel", "BezelRim", "ClusterFrame", "ScreenFrame", "ClusterWalls", "ScreenWalls", "CheekPill", "CheekPillSplit", "CheekButton",
              "ColumnShroud", "VentSlat", "VentBack", "ResetButton", "ResetChevron", "ResetRib", "KeyLock", "KeyBarrel",
              "KeyHead", "StripPrint", "ClusterFace", "ClusterGlass", "ClusterBack", "ScreenFilm", "ScreenGlass")
TILT = (Matrix.Translation((0, FACE_PIVOT_Y, ZF)) @ Matrix.Rotation(math.radians(-FACE_TILT), 4, "X")
        @ Matrix.Translation((0, -FACE_PIVOT_Y, -ZF)))
for ob in list(bpy.data.objects):
    if ob.name.startswith(FACE_PARTS):
        ob.matrix_world = R4 @ TILT @ R4.inverted() @ ob.matrix_world

def join(name, names):
    obs = [bpy.data.objects[n] for n in names]
    with bpy.context.temp_override(active_object=obs[0], selected_editable_objects=obs, selected_objects=obs):
        bpy.ops.object.join()
    obs[0].name = name
    return obs[0]
def starts(*pre): return [n for n in bpy.data.objects.keys() if n.startswith(pre)]

join("Wheel", ["WheelRim"] + starts("WheelSpoke", "WheelHub"))
join("WheelChromeLines", starts("WheelChrome"))
join("Lever", ["LeverStick", "LeverBlock", "LeverGrip", "LeverCap", "LeverCapPlug"])
join("LeverGrooves", starts("LeverGroove"))
join("ResetButton", ["ResetButton", "ResetChevron"] + starts("ResetRib"))
join("KeyHead", ["KeyHead", "KeyBow"] + starts("KeyGroove"))
join("BezelDetail", ["CheekPill", "CheekPillSplit"] + starts("CheekButton", "VentSlat"))
for child, parent in (("HubBadge", "Wheel"), ("WheelChromeLines", "Wheel"), ("LeverGrooves", "Lever")):
    c, p = bpy.data.objects[child], bpy.data.objects[parent]
    c.parent = p
    c.matrix_parent_inverse = p.matrix_world.inverted()

tris = sum(len(p.vertices) - 2 for o in bpy.data.objects if o.type == "MESH" for p in o.data.polygons)
print("TURBO objects", len(bpy.data.objects), "tris", tris)
for o in sorted(bpy.data.objects, key=lambda o: o.name):
    print(f"  {o.name:18s} {len(o.data.polygons):6d} faces  dims {tuple(round(d, 3) for d in o.dimensions)}")

out = sys.argv[sys.argv.index("--") + 1] if "--" in sys.argv else "turbo.glb"
os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
bpy.ops.export_scene.gltf(filepath=os.path.abspath(out), export_format="GLB", export_yup=True, export_apply=True,
                          export_texcoords=True, export_normals=True, export_materials="EXPORT")
print("wrote", out)
