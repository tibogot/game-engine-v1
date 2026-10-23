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
import numpy as np
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
LENS = mat("Lens", (0.5, 0.51, 0.52), 0.2)
CHROME = mat("Chrome", (0.55, 0.56, 0.57), 0.25)
CREASE = mat("Crease", (0.16, 0.012, 0.008), 0.5)   # the bonnet's pressed-in lines: dark red, not black
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
# (the face lean, used by the body too)
FACE_TILT, FACE_PIVOT_Y = 28.0, 0.025
ZF = 0.02
# THE BODY (back + 3/4 photos: assets-src/refs/turnin-turbo/back.jpg, threequarter_right.jpg): a red box with flat
# upright sides and a crisp rounded shoulder; the top runs level back from the bezel, then rolls down into a car nose;
# fender bulges either side carry the round grey headlights low on the nose; a slate bumper band wraps the back and
# the rear of the sides, a red skirt under it. Built as cross-sections (x, y) stepped along z and lofted — no subdivision.
B_ZF, B_ZB = 0.016, -0.252        # the shell's front (the red apron under the bezel) and back
B_W, B_RC = 0.2, 0.06             # half width, plan radius of the back corners
B_TOP, B_NOSE = 0.166, 0.062      # top height (below both frames: they stand out of it); the nose at the back
B_NOSE_Z = -0.088                 # where the top starts to roll down
B_FENDER = 0.042                  # the fenders: barely raised (rear 3/4 photos), creases do the work
B_SH = 0.012                      # the shoulder radius

def b_halfwidth(z):
    zc = B_ZB + B_RC
    if z >= zc: return B_W
    d = zc - z
    return B_W - B_RC + math.sqrt(max(B_RC * B_RC - d * d, 0.0))

# the top's centre line (z, y): level, then the nose rolls over and drops steeply — every point just under the rays
# from the camera fitted to the front photo through the red body's top edge (that view shows only a narrow red band)
# The rear 3/4 photos (assets-src/refs/turnin-turbo/rear34_*.jpg): ONE long, gently crowned slope from the slate top
# band down to the bumper — no level part. Still under the front camera's rays (y <= 0.15 at z -0.128, 0.14 at -0.142).
# A short level strip first (~1 cm behind the frames, at their height): the front photo shows the sticker there.
# convex: a gentle bonnet near the top, rolling over to nearly vertical where the lamps sit (straight back photo)
NOSE_PROFILE = [(0.06, 0.17), (0.098, 0.17)] + [(0.1 + 0.142 * k / 24, 0.094 + 0.076 * max(1 - (k / 24) ** 2.2, 0) ** 0.6)
                                               for k in range(25)]
B_SKIRT = 0.036                   # the red chin under the bumper (straight back photo: ~33 mm)
B_BUMP = 0.068                    # where the red face meets the bumper (straight back photo, camera fitted)
# The back is a 911 nose (straight back photo, back_straight.png): FENDERS either side stay high and end in a face
# sloping ~55 deg that carries each lamp nearly flush; the BONNET between the creases (x +-9 cm) is lower and rolls
# gently down to the bumper.
F_TOP, F_FACE = 0.168, 0.034      # the fenders' height; how far forward of the back their face reaches
def fender_h(z):
    u = (z - B_ZB) / F_FACE                       # 0 at the back, 1 at the top of the sloped face
    if u <= 0: return B_BUMP
    g = math.sqrt(max(1 - (1 - min(u, 1.0)) ** 2, 0.0))   # a quarter round: the fender's nose rolls over (photos)
    return B_BUMP + (F_TOP - B_BUMP) * g
def bonnet_h(z):
    # a 911 hood (side photos): highest at the frames (the windscreen), sloping DOWN to the nose, then rolling over
    # (quarter ellipse, NOSE_D deep) into the upright face above the bumper
    d = z - B_ZB
    top = HOOD_REAR + (HOOD_FRONT - HOOD_REAR) * min(max((z - (B_ZB + NOSE_D)) / (-0.1 - (B_ZB + NOSE_D)), 0.0), 1.0)
    if d >= NOSE_D: return top
    return B_BUMP + (top - B_BUMP) * math.sqrt(max(1 - (1 - max(d, 0.0) / NOSE_D) ** 2, 0.0))
HOOD_FRONT, HOOD_REAR, NOSE_D = 0.162, 0.142, 0.05
def b_height(z, x):
    ax = abs(x)
    # ONE hood (rear 3/4 photos): the bonnet's profile all across, a slight bulge over each lamp — no fenders standing
    # up with a trough between them
    wf = math.exp(-((ax - 0.15) / 0.05) ** 2)
    hc = bonnet_h(z) + 0.014 * wf   # the fenders stand a little proud of the hood, carrying the lamps
    # kept under the sight line of the camera fitted to the front photo (it shows only a narrow red band over the
    # frames, the lamp shoulders just above it at the corners): a soft minimum with y = 0.167 + 0.72 (z + 0.12)
    corner = min(max((ax - 0.11) / 0.05, 0.0), 1.0); corner = corner * corner * (3 - 2 * corner)
    corner *= min(max((-0.105 - z) / 0.03, 0.0), 1.0)
    ray, k = 0.167 + 0.72 * (z + 0.12) + 0.012 * corner, 0.01
    capped = max(0.5 * (hc + ray - math.sqrt((hc - ray) ** 2 + k * k)), B_BUMP)
    w = min(max((z + 0.2) / 0.09, 0.0), 1.0)   # only near the frames: further back the upright nose rules (rear photos)
    hc = hc + (capped - hc) * w
    # in front, the shell stays inside the leaning bezel: under its face plane, 34 mm back (behind the panels) (FACE_TILT about y 25 mm)
    y_face = 0.025 + (ZF - 0.034 - z) / math.tan(math.radians(FACE_TILT))
    if z > -0.1:   # under the slate rim's top (stepped: lower over the screen) — the red poked through it as a line
        ca = math.cos(math.radians(FACE_TILT))
        st = min(max((x - (865 - 760) * 0.000294) / 0.004, 0.0), 1.0)
        _Y = lambda py: 0.205 - (py - 165) * 0.000304   # (= Y(), defined further down)
        rim_top = FACE_PIVOT_Y + ((_Y(200) * (1 - st) + _Y(262) * st) - FACE_PIVOT_Y) * ca - 0.004
        hc = min(hc, rim_top)
    return max(min(hc, y_face), 0.026)

def b_ring(z):
    w = b_halfwidth(z)
    t = min(max((B_NOSE_Z - z) / (B_NOSE_Z - B_ZB), 0.0), 1.0)
    g = min(max((-0.03 - z) / 0.05, 0.0), 1.0)   # behind the frames: the 911 body's round section (side photo)
    B_SH = 0.012 + 0.028 * g + 0.02 * t * t   # big round shoulders: the top rolls into the sides
    pts = []
    N_TOP, N_SIDE, N_ARC, N_BOT = 96, 16, 10, 10   # dense: the humps round the lamps shaded in streaks
    hl, hr = b_height(z, -w + B_SH), b_height(z, w - B_SH)
    wb = w - g * 0.022                            # the bottom is narrower (the side curves in)
    for k in range(N_BOT + 1):                    # bottom, right to left
        pts.append((wb - 2 * wb * k / N_BOT, 0.0))
    # the side BULGES (side photo: one smooth convex red surface, curving in at the bottom): x(y) bows out to w at
    # ~45 % height, in by BULGE at the shoulder and by BOTTOM at the table
    def side_x(y, h):
        u = y / max(h, 1e-6)
        return w - g * (0.022 * (1 - min(u / 0.45, 1.0)) ** 2 + 0.006 * max((u - 0.45) / 0.55, 0.0) ** 2)
    for k in range(1, N_SIDE):                    # left side up
        y = (hl - B_SH) * k / N_SIDE
        pts.append((-side_x(y, hl - B_SH), y))
    for k in range(N_ARC + 1):                    # left shoulder
        a = math.pi - (math.pi / 2) * k / N_ARC
        pts.append((-w + B_SH + B_SH * math.cos(a), hl - B_SH + B_SH * math.sin(a)))
    for k in range(1, N_TOP):                     # the top, left to right
        x = -w + B_SH + (2 * w - 2 * B_SH) * k / N_TOP
        pts.append((x, b_height(z, x)))
    for k in range(N_ARC + 1):                    # right shoulder
        a = math.pi / 2 - (math.pi / 2) * k / N_ARC
        pts.append((w - B_SH + B_SH * math.cos(a), hr - B_SH + B_SH * math.sin(a)))
    for k in range(1, N_SIDE):                    # right side down
        y = (hr - B_SH) * (1 - k / N_SIDE)
        pts.append((side_x(y, hr - B_SH), y))
    out = []
    for x, y, in pts:
        if y < B_SKIRT:                           # the chin: inset in x, and tucked forward at the back
            tk = (1 - y / B_SKIRT) ** 2
            tk = 1 - math.sqrt(max(1 - (1 - y / B_SKIRT) ** 2, 0.0))   # a quarter round: the chin's corners
            g = min(max((B_ZB + 0.11 - z) / 0.06, 0.0), 1.0)   # the side inset only at the back: the front apron is full width
            x = math.copysign(min(abs(x), w - 0.06 * tk * g), x)
            # the tuck: this row's back moves forward, the row STRETCHED evenly (a clamp folded the rings: a lumpy chin)
            zb = B_ZB + 0.05 * tk
            out.append((x, y, zb + (z - B_ZB) * (B_ZF - zb) / (B_ZF - B_ZB)))
        else:
            out.append((x, y, z))
    return out

ZS = [B_ZF + (B_ZB - B_ZF) * (1 - (1 - i / 180) ** 1.7) for i in range(181)]   # denser towards the back (the fender faces)
# the back end: the last rings shrink in to a rounded rear edge (2 mm) before the cap
rings = [b_ring(z) for z in ZS]
last = rings[-1]
cx_, cy_ = 0.0, B_NOSE * 0.5
rings.append([(cx_ + (x - cx_) * 0.985, cy_ + (y - cy_) * 0.97 if y > 0 else 0.0, z - 0.0025) for x, y, z in last])
# the back face: swept in to the centre line (each point keeps its height and depth) — a real surface, smooth; a flat cap
# over this non-planar ring (the tucked chin) triangulated into soft lumps
end = rings[-1]
rings += [[(x * k, y, z) for x, y, z in end] for k in (0.75, 0.5, 0.25, 0.0)]
loft("Shell", rings, RED, cap0=True, angle=35)

# the headlights: grey discs set into the fenders, square to the surface — a rim ring and a raised inner disc
def b_normal(z, x, e=0.001):
    hx = (b_height(z, x + e) - b_height(z, x - e)) / (2 * e)
    hz = (b_height(z + e, x) - b_height(z - e, x)) / (2 * e)
    return Vector((-hx, 1.0, -hz)).normalized()
POD_PROF = [(r * 0.95, h)   # outer ring ~73 mm across (straight back photo)
            for r, h in [(0.0, 0.0085), (0.0298, 0.0085), (0.0304, 0.0108), (0.0322, 0.0121), (0.0362, 0.0118),
                                        (0.0378, 0.0102), (0.0385, 0.007), (0.0385, -0.035)]]   # a thin ring
for sx in (-1, 1):
    x = sx * 0.156   # right out at the corners, the fender round them (straight back photo)
    # the lamp faces BACK, 18 deg up (photos), its centre where the fender's rounded corner is 127 mm high
    zc = min((B_ZB + i * 0.0005 for i in range(200)), key=lambda zz: abs(b_height(zz, x) - 0.112))   # ~14 cm up (straight back photo, camera fitted)   # on the real (capped) surface
    up = math.radians(18)
    n = Vector((0, math.sin(up), -math.cos(up)))
    n = (n + b_normal(zc, x)).normalized()   # halfway to the steep nose's own normal: the lamp sits on it
    ex = Vector((1, 0, 0)); ey = n.cross(ex).normalized()
    z_l, y_l = zc - n.z * 0.002, b_height(zc, x) - n.y * 0.002   # the ring stands just proud, its bucket behind
    lathe("Pod" + ("L" if sx < 0 else "R"), POD_PROF, GREY, gmat((x, y_l, z_l), ex, ey) @ gmat((0, 0, 0), (1, 0, 0), (0, 1, 0)), n=48)
    # the lens: a silvery dome inside the grey ring (rear 3/4 photos)
    # the lens: a FLAT glossy silver-grey disc filling the ring (back photos), lighter than the ring
    lathe("Lens" + ("L" if sx < 0 else "R"), [(0.0, 0.0093), (0.0278, 0.0093), (0.0283, 0.0088), (0.0283, 0.008)],
          LENS, gmat((x, y_l, z_l), ex, ey) @ gmat((0, 0, 0), (1, 0, 0), (0, 1, 0)), n=48)

# the bumper: a slate band round the back and the rear half of the sides, a groove along it
def bumper():
    z_start = B_ZB + B_RC + 0.012   # the bumper only wraps round the corners (side photo), ending in a ribbed cap
    path = rpoly([(-B_W, z_start), (-B_W, B_ZB), (B_W, B_ZB), (B_W, z_start)], [0, B_RC, B_RC, 0], 12)
    # 32 -> 108 mm (straight back photo): a thin top lip, a wide band, a groove, a lower band; 1 cm proud
    # 33 -> 79 mm (straight back photo, camera fitted): a lip, a wide band, a groove, a lower band; 1 cm proud;
    # its top 5 mm over where the red meets it
    prof = [(-0.006, 0.036), (0.006, 0.036), (0.0092, 0.0375), (0.0105, 0.041), (0.0105, 0.052), (0.009, 0.0535),
            (0.0105, 0.055), (0.0105, 0.066), (0.009, 0.0675), (0.0105, 0.069), (0.0105, 0.069), (0.009, 0.071),
            (0.006, 0.073), (-0.006, 0.073)]   # its top 6 mm over where the body meets it (red teeth)   # 1.5 mm over the shell's lowest top (it met it exactly: z-fight)
    rings = []
    for i, (x, z) in enumerate(path):
        p = Vector((x, z))
        a = Vector(path[max(i - 1, 0)]); b = Vector(path[min(i + 1, len(path) - 1)])
        t = (b - a).normalized(); nrm = Vector((-t.y, t.x))
        if nrm.dot(p - Vector((0, (z_start + B_ZB) / 2))) < 0: nrm = -nrm
        rings.append([(x + nrm.x * o, y, z + nrm.y * o) for o, y in prof])
    loft("Bumper", rings, SLATE, cap0=True, cap1=True, angle=50)
bumper()

# the bonnet's panel lines (back photo): a line across under the sticker, two running down to the bumper, pressed in
def panel_line(name, pts):
    """pts: (x, z) along the surface; a 1.2 mm dark groove strip following b_height."""
    ring_a, ring_b = [], []
    for i, (x, z) in enumerate(pts):
        a = Vector(pts[max(i - 1, 0)]); b = Vector(pts[min(i + 1, len(pts) - 1)])
        t = (b - a).normalized(); side = Vector((-t.y, t.x)) * 0.00035
        for ring, s in ((ring_a, 1), (ring_b, -1)):
            xx, zz = x + side.x * s, z + side.y * s
            ring.append((xx, b_height(zz, xx) + 0.00025, zz))
    me = bpy.data.meshes.new(name)
    v = ring_a + ring_b; n = len(ring_a)
    me.from_pydata([tuple(q) for q in v], [], [(i, i + 1, n + i + 1, n + i) for i in range(n - 1)])
    to_blender(me); link(name, me, CREASE)
# the creases from the top band down to the bumper, inboard of the lamps, opening out a little; the embossed panel
# outline under the band (centre, the rear 3/4 photos)
zt = B_NOSE_Z - 0.018   # start clear of the slate frames (it ran under them)
for sx in (-1, 1):
    panel_line(f"BonnetLine{sx}", [(sx * 0.079, zt + (B_ZB + 0.004 - zt) * k / 30) for k in range(31)])
r0, r1, rz0, rz1 = -0.068, 0.078, B_NOSE_Z - 0.014, B_NOSE_Z - 0.05
panel_line("BonnetRect", [(r0 + (r1 - r0) * k / 20, rz0) for k in range(21)] + [(r1, rz0 + (rz1 - rz0) * k / 12) for k in range(1, 13)]
           + [(r1 - (r1 - r0) * k / 20, rz1) for k in range(1, 21)] + [(r0, rz1 - (rz1 - rz0) * k / 12) for k in range(1, 13)])

# THE UNDERSIDE (bottom.jpg): flat red; a black battery door (4 D cells) with ribs, a white warning label, screw
# heads, four low feet. Built facing down, a hair under y = 0 (the feet lift the toy 2 mm off the table).
DOWN = lambda x, z, y=0.0: gmat((x, y, z), (1, 0, 0), (0, 0, 1))      # local +z = down
slab("BatteryDoor", [rrect(0, 0, 0.17, 0.12, 0.012)], 0.0, 0.0018, 0.0008, BLACK, DOWN(-0.02, -0.12, -0.0004))
for k in range(6):
    slab(f"BatteryRib{k}", [rrect(0, -0.045 + k * 0.018, 0.15, 0.003, 0.0012, 2)], 0.0018, 0.003, 0.0004, BLACK,
         DOWN(-0.02, -0.12, -0.0004))
slab("BatteryTab", [rrect(0, 0.068, 0.03, 0.012, 0.003)], 0.0, 0.0028, 0.0008, BLACK, DOWN(-0.02, -0.12, -0.0004))
uvplane("UnderLabel", 0.09, 0.05, DOWN(0.12, -0.05, -0.0006))
for fx, fz in ((-0.17, 0.0), (0.17, 0.0), (-0.13, -0.165), (0.13, -0.165)):   # under the body, inside the chin
    lathe(f"Foot{fx}{fz}", [(0.0, -0.002), (0.009, -0.002), (0.011, -0.001), (0.011, 0.002), (0.0, 0.002)], BLACK,
          gmat((fx, 0.0, fz), (1, 0, 0), (0, 0, -1)), n=24)
for sx_, sz_ in ((-0.15, -0.03), (0.15, -0.03), (-0.11, -0.16), (0.11, -0.16), (0.0, -0.06)):
    lathe(f"Screw{sx_}{sz_}", [(0.0, 0.0), (0.004, 0.0), (0.0035, -0.0012), (0.0, -0.0012)], GREY, gmat((sx_, -0.0002, sz_), (1, 0, 0), (0, 0, -1)), n=16)

# the black ribbed pads on each side, just ahead of the bumper's ends (the side photo)
for sx in (-1, 1):
    # the bumper's END CAP (side photo): a ribbed black block where the bumper stops on each side
    PAD = gmat((sx * (B_W + 0.004), 0.055, B_ZB + B_RC + 0.012), (0, 0, -sx), (0, 1, 0))
    slab(f"SidePad{sx}", [rrect(0, 0, 0.028, 0.06, 0.004)], -0.006, 0.012, 0.0015, BLACK, PAD)
    for k in range(5):
        slab(f"SidePadRib{sx}{k}", [rrect(0, -0.02 + k * 0.01, 0.022, 0.0035, 0.0012, 2)], 0.012, 0.0145, 0.0008, BLACK, PAD)



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
# The frames' top and side surfaces run straight back, LEVEL (the front photo shows them as slate bands above the
# windows), to a closed back end standing over the red body (the back photo's slate band). Built in world space: the
# outline is leaned like the face, then swept horizontally back.
_ca, _sa = math.cos(math.radians(FACE_TILT)), math.sin(math.radians(FACE_TILT))
def _lean(x, y, z):
    dy, dz = y - FACE_PIVOT_Y, z - ZF
    return (x, FACE_PIVOT_Y + dy * _ca + dz * _sa, ZF - dy * _sa + dz * _ca)
RIM_BACK = -0.088
# 2.5 mm outside the outline: the red shell's sides are at x +-0.2 too (coplanar = z-fighting teeth)
_front = [_lean(x * 1.0125, y, ZF - 0.0015) for x, y in outer]   # 2.5 mm wider (scaled: an offset folded at the steps)
# its back end dips into the red (a vertical back face stood up as a dark wedge where the red is lower)
# a NARROW band leaning with the face (the in-hand side photo: ~3.6 cm of slate, the red body right up to it)
RIM_DEPTH = 0.056   # overlaps the red (46 mm behind the face) a little
_mid = [(x, y, z - RIM_DEPTH * 0.6) for x, y, z in _front]
_back = [(x, y, z - RIM_DEPTH) for x, y, z in _front]
loft("BezelRim", [_front, _mid, _back], SLATE, cap1=True, angle=50, recalc=False)
for _p in bpy.data.objects["BezelRim"].data.polygons: _p.flip()   # the outline runs CCW from the front: flip outwards
bpy.data.objects["BezelRim"].data.update()
# the lip closing the 2.5 mm slot between the face's outline and the rim's front edge (you saw down into the rim: red)
_inner = [_lean(x * 0.995, y, ZF - 0.0015) for x, y in outer]
loft("BezelLip", [_inner, _front], SLATE, angle=50, recalc=False)
loft("BezelLipB", [_front, _inner], SLATE, angle=50, recalc=False)   # both windings: an open strip, seen from either side


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
Y_RED_F, Y_TOP_F, Y_TOP_B = 0.02, 0.037, 0.051
def ytop(z): return Y_TOP_F + (CZ1 - z) / (CZ1 - CZ0) * (Y_TOP_B - Y_TOP_F)
def yred(z): return ytop(z) - (Y_TOP_F - Y_RED_F)

plan = rpoly([(CX0, CZ1), (CX1_F, CZ1), (CX1, CZ0), (CX0, CZ0)], [0.006, 0.006, 0, 0], 6)   # (x, z)
def ring_at(fy, ins=0.0):
    return [(x, fy(z), z) for x, z in offset2d(plan, -ins)]
# the red base is a tapered tray (the user's corner photo): its front and side lean in towards the table — 12 mm
# narrower at the bottom than under the black housing (7 mm) — with a crisp crease where they meet
loft("Console", [ring_at(lambda z: 0.0, -0.007), ring_at(lambda z: 0.0012, -0.0064), ring_at(lambda z: yred(z) - 0.0015, 0.0),
                 ring_at(lambda z: yred(z), 0.0008)], RED, cap0=True, cap1=True, angle=25)
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
                     rrect(SLOT_U, 0.0, X(1392) - X(1300) - 0.006, tlen - 0.016, 0.0015)], -0.004, 0.005, 0.0008, BLACK, TOP)
# the channel's dark inside, under the drum (the housing is cut by the drum: its top would z-fight a flush drum)
slab("ConsoleChannel", [rrect(SLOT_U, 0.0, X(1392) - X(1300) - 0.0065, tlen - 0.0165, 0.0012)], -0.0006, 0.0004, 0.0003, BLACK, TOP)
_unused = ("ConsoleSlotFloor", [rrect(SLOT_U, 0.0, X(1392) - X(1300) - 0.004, tlen - 0.014, 0.0015)])
for k, fx in enumerate((W / 2 - 0.0035, W / 2 - 0.0105)):
    slab(f"ConsoleFin{k}", [rrect(fx, 0.006, 0.0032, tlen - 0.018, 0.0012)], 0.0, 0.015 - 0.003 * k, 0.0009, BLACK, TOP)
SLOT_W = X(1392) - X(1300)
for k in range(5):
    slab(f"ConsoleGate{k}", [rrect(SLOT_U - SLOT_W / 2 + 0.0035, -0.032 + k * 0.0165, 0.004, 0.009, 0.0008)], -0.009, -0.0005,
         0.0005, BLACK, TOP)

# the lever: a stick in the slot, the grey grip lying across it, reaching out to the right; three grooves along its
# face, a collar round the stick. Origin in the slot (the page slides it along the slot's axis, local y).
# The lever turns on a grey DRUM in the slot (axis across, x): changing gear rotates it, the lever tilts fore / aft.
# Its origin is the drum's axis (the page rotates it about local x). Pivot 16 mm under the top, mid-travel along the slot.
LEVER_PIVOT_Y, LEVER_R = -0.019, 0.016
LEVER = TOP @ Matrix.Translation((SLOT_U - 0.004, LEVER_PIVOT_Y, -LEVER_R + 0.0035))   # the crown shows 3.5 mm
slab("LeverStick", [rrect(0.0, 0.0, 0.012, 0.0065, 0.0012)], 0.0, 0.034, 0.0008, GREY, LEVER)   # the blade post
lathe("LeverDrum", [(0.0001, -0.011), (0.013, -0.011), (0.0155, -0.0095), (LEVER_R, -0.006), (LEVER_R, 0.006),
                    (0.0155, 0.0095), (0.013, 0.011), (0.0001, 0.011)], GREY, LEVER @ gmat((0, 0, 0), (0, 1, 0), (0, 0, 1)), n=48)
G0 = LEVER @ gmat((0, 0, 0), (1, 0, 0), (0, 0, 1))  # outline in (x, up), extruded along the slot
# the grip: a wedge, tallest at the left (the hollow square end), tapering to the right
grip = rpoly([(-0.007, 0.03), (0.022, 0.03), (0.04, 0.034), (0.04, 0.047), (-0.007, 0.053)], [0.0015, 0.004, 0.002, 0.002, 0.0015], 4)
slab("LeverGrip", [grip], -0.0095, 0.0095, 0.001, GREY, G0)
CAP = G0 @ gmat((-0.006, 0.0415, 0), (0, 0, 1), (0, 1, 0))   # outline in (depth, up), extruded to -x
slab("LeverCap", [rrect(0, 0, 0.0215, 0.0245, 0.0012, 3), rrect(0, 0, 0.0135, 0.0165, 0.0006, 2)], 0.0, 0.007, 0.0006, GREY, CAP)
slab("LeverCapPlug", [rrect(0, 0, 0.015, 0.018, 0.0006, 2)], 0.0, 0.0035, 0.0003, GREY, CAP)
# three grooves along the grip's top face
# ON the top edge (-0.007, 0.053) -> (0.04, 0.047): local x along it, local y across (the slot axis), local z = its normal
_d = Vector((0.047, -0.006, 0)).normalized()
TOPF = G0 @ gmat((0.0165, 0.05, 0), tuple(_d), (0, 0, -1))
for k in range(3):
    slab(f"LeverGroove{k}", [rrect(0.0, -0.0045 + k * 0.0045, 0.03, 0.0011, 0.0004, 2)], 0.0008, 0.0014, 0.0001, BLACK, TOPF)   # the grip's bevel puts its surface 1 mm out

# =================================================================================================================
# THE STEERING WHEEL — round its own centre, facing local +Z. 194 mm across, a 9.5 mm rim; four flat spokes at
# about 10, 2, 8 and 4 o'clock with a chrome line along one edge; a big hub with the TOMY badge.
# solved on the fitted camera: the hub at photo (415, 830), the rim's left / right / top / bottom on the photo's, its
# bottom just clear of the table: centre 87 mm up, 117 mm out, 92 mm radius, tilted back 24.5° — its column then runs
# back and down straight into the column boss
# solved on BOTH the front and the side 3/4 photo (cameras fitted to each; the rim's extremes + the badge in each):
# the front photo alone allows two tilts (~23 or ~57 deg give the same oval) — the side photo settles it
WHEEL_C = (-0.1032, 0.0727, 0.0929)
WHEEL_TILT = 39.6
WHEEL = gmat(WHEEL_C, (1, 0, 0), (0, math.cos(math.radians(WHEEL_TILT)), -math.sin(math.radians(WHEEL_TILT))))
RR, TR, TD = 0.0812, 0.0105, 0.0135
rim_rings = []
for i in range(96):
    a = 2 * math.pi * i / 96
    c, s = math.cos(a), math.sin(a)
    rim_rings.append([(c * (RR + TR * math.cos(b)), s * (RR + TR * math.cos(b)), TD * math.sin(b))
                      for b in (2 * math.pi * k / 16 for k in range(16))])
loft("WheelRim", rim_rings, BLACK, WHEEL, wrap=True, angle=70)
# DISHED (the photo shows the spokes' sides): each spoke runs from the hub, 9 mm back, out to the rim, tilted ~10°
DISH = 0.009
for a_deg, edge in ((160, 1), (20, 1), (206, -1), (334, -1)):
    tilt = -math.atan2(DISH, RR - 0.03)
    F = WHEEL @ Matrix.Rotation(math.radians(a_deg), 4, "Z") @ Matrix.Translation((0.03, 0, -DISH)) @ Matrix.Rotation(tilt, 4, "Y")
    L = math.hypot(RR - 0.03, DISH)
    pts = [(0.0, -0.0118), (L - 0.002, -0.0098), (L - 0.002, 0.0098), (0.0, 0.0118)]
    slab(f"WheelSpoke{a_deg}", [rpoly(pts, [0.001, 0.001, 0.001, 0.001], 2)], -0.0035, 0.0025, 0.0012, BLACK, F)
    line = [(0.008, edge * 0.0105), (L - 0.008, edge * 0.0088), (L - 0.008, edge * 0.0096), (0.008, edge * 0.0113)]
    slab(f"WheelChrome{a_deg}", [line if edge > 0 else line[::-1]], 0.0024, 0.0027, 0.0001, CHROME, F)
hub = rrect(0, -0.002, 0.086, 0.046, 0.017, 10)
slab("WheelHub", [hub], -0.022, 0.003 - DISH, 0.0016, BLACK, WHEEL)
slab("WheelHubLip", [rrect(0, 0.0155, 0.074, 0.008, 0.004, 6)], 0.001 - DISH, 0.0048 - DISH, 0.0012, BLACK, WHEEL)
uvplane("HubBadge", 0.052, 0.032, WHEEL @ Matrix.Translation((0, -0.0045, 0.0032 - DISH)))
# the column boss: a slate block ON the wheel's axis (the wheel hides it in the photo: placed by the measured wheel),
# wider at the bottom, from deep in the bezel out to 60 mm behind the hub
slab("ColumnBoss", [rpoly([(-0.04, -0.03), (0.04, -0.03), (0.032, 0.026), (-0.032, 0.026)], [0.006, 0.006, 0.008, 0.008], 6)],
     -0.16, -0.06, 0.003, SLATE, WHEEL)
# a short thick stub from the hub straight into the column boss (73 mm back along the wheel axis: the boss front)
lathe("WheelColumn", [(0.0165, -0.062), (0.0165, -0.02), (0.019, -0.017)], BLACK, WHEEL)

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
# the sticker follows the curved top (a flat plane sank into the fender bulge): a grid laid on b_height, 0.4 mm over
def top_sticker(x0, x1, zc, depth, nx=48, nz=4):
    verts, uvs, faces = [], [], []
    for j in range(nz + 1):
        for i in range(nx + 1):
            x = x1 - (x1 - x0) * i / nx            # u runs to -x: it reads from the back
            z = zc + depth / 2 - depth * j / nz    # v: front -> back = sticker top -> bottom seen from the back
            verts.append(R3 @ Vector((x, b_height(z, x) + 0.0004, z))); uvs.append((i / nx, 1 - j / nz))
    for j in range(nz):
        for i in range(nx):
            q = j * (nx + 1) + i
            faces.append((q, q + nx + 1, q + nx + 2, q + 1))
    me = bpy.data.meshes.new("TopSticker"); me.from_pydata(verts, [], faces); me.update()
    uvl = me.uv_layers.new(name="UVMap")
    for poly in me.polygons:
        for li in poly.loop_indices: uvl.data[li].uv = uvs[me.loops[li].vertex_index]
    smooth(me, 80)
    return link("TopSticker", me, FACE)
top_sticker(X(230), X(815), -0.11, 0.02)

# =================================================================================================================
# lean the face back (everything built on the upright front plane)
FACE_PARTS = ("Bezel", "ClusterFrame", "ScreenFrame", "ClusterWalls", "ScreenWalls", "CheekPill", "CheekPillSplit", "CheekButton",
              "ColumnShroud", "VentSlat", "VentBack", "ResetButton", "ResetChevron", "ResetRib", "KeyLock", "KeyBarrel",
              # the bow and its grooves lean with the lock (they were left upright: a bent key)
              "KeyHead", "KeyBow", "KeyGroove", "StripPrint", "ClusterFace", "ClusterGlass", "ClusterBack", "ScreenFilm", "ScreenGlass")
TILT = (Matrix.Translation((0, FACE_PIVOT_Y, ZF)) @ Matrix.Rotation(math.radians(-FACE_TILT), 4, "X")
        @ Matrix.Translation((0, -FACE_PIVOT_Y, -ZF)))
for ob in list(bpy.data.objects):
    if ob.name.startswith(FACE_PARTS) and ob.name != "BezelRim":   # the rim is built leaned already
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
join("Lever", ["LeverStick", "LeverGrip", "LeverCap", "LeverCapPlug", "LeverDrum"] + starts("LeverGroove"))   # grooves IN the lever mesh (a parented groove part never showed)
join("ConsoleRight", starts("ConsoleFin", "ConsoleGate", "ConsoleChannel"))
join("BonnetLines", starts("BonnetLine", "BonnetRect"))
join("SidePads", starts("SidePad"))
join("BezelLip", ["BezelLip", "BezelLipB"])
join("Underside", ["BatteryDoor", "BatteryTab"] + starts("BatteryRib", "Foot", "Screw"))
join("ResetButton", ["ResetButton", "ResetChevron"] + starts("ResetRib"))
join("KeyHead", ["KeyHead", "KeyBow"] + starts("KeyGroove"))
join("BezelDetail", ["CheekPill", "CheekPillSplit"] + starts("CheekButton", "VentSlat"))
for child, parent in (("HubBadge", "Wheel"), ("WheelChromeLines", "Wheel")):
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
