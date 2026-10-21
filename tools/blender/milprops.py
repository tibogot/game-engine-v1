"""MILITARY PROPS, SHARED (2026-10-21, you: "the gun and the projector look very cheap, not AAA — do way better, of course
very optimised"): the detailed pieces several buildings carry, built ONE way so every one in the game matches —

  aa52(K, at, yaw, t, ...)          the AA-52 machine gun (the French army's of the period): finned barrel jacket and
                                    flash hider, the folded bipod under it, carrying handle, sights, the receiver and its
                                    feed cover, pistol grip and shaped stock, the belt from its box into the feed;
                                    `tripod`: on its tripod (the MG nest) or not (the mirador's, on the rail)
  searchlight(K, at, yaw, t, ...)   the army's 60 cm searchlight: a drum with cooling fins, a front rim with clamps
                                    round a dark glass, the silver reflector seen through it, a rear cap, a U-yoke on its
                                    trunnions over a pedestal, two handles, the power cable

Each takes the far switch from drystone (LOW: the fins, clamps, sights, rounds dropped — the silhouette kept).
Placed in game metres of the piece being built: `at` the mount's point, `yaw` the direction it faces (0: toward -Z).
Materials: the piece's MATDEF must hold MILPROP_MATS.
"""
import math
from mathutils import Vector
from bkit import B, gv, srgb, dust
import drystone
from drystone import tag

def _steel(base, wear=0.2):
    def f(nb):
        c = nb.mix(nb.noise(1.5, 4), srgb(base), tuple(v * 0.8 for v in srgb(base)))
        w = nb.math("MULTIPLY", nb.mr(nb.point(), 0.52, 0.6), nb.noise(25.0, 3))
        return nb.mix(nb.math("MULTIPLY", w, 1.5 * wear), c, srgb(0x8a8578))
    return f
def _flat(rgb):
    return lambda nb: nb.mix(nb.noise(4.0, 3), rgb, tuple(v * 0.88 for v in rgb))
def _reflector(nb):
    # the silver bowl seen through the glass: concentric bright and dark rings round a dark centre
    # (radius from the object's own centre — the face's position in the bake, measured in the drum's frame by the
    # generated coordinates): bright silver rings, darker toward the rim
    tc = nb.N.new("ShaderNodeTexCoord"); sep = nb.N.new("ShaderNodeSeparateXYZ"); nb.L.new(tc.outputs["Generated"], sep.inputs[0])
    dx = nb.math("SUBTRACT", sep.outputs["X"], 0.5); dz = nb.math("SUBTRACT", sep.outputs["Z"], 0.5)
    r = nb.math("SQRT", nb.math("ADD", nb.math("MULTIPLY", dx, dx), nb.math("MULTIPLY", dz, dz)))
    ring = nb.math("SINE", nb.math("MULTIPLY", r, 60.0))
    c = nb.mix(nb.mr(ring, -1, 1, 0.0, 1.0), srgb(0x8e989e), srgb(0xe6ecee))
    return nb.mix(nb.mr(r, 0.3, 0.5, 0.0, 1.0), c, srgb(0x5a6268))
MILPROP_MATS = {
    "mpGun": (0.45, _steel(0x262826, 0.18)), "mpGunOlive": (0.6, _steel(0x434b35, 0.22)), "mpWood": (0.8, _steel(0x4a3424, 0.1)),
    "mpBrass": (0.35, _steel(0xb08a42, 0.05)), "mpLamp": (0.55, _steel(0x4a523e, 0.25)), "mpLampDark": (0.5, _steel(0x2a2c28, 0.2)),
    "mpGlass": (0.15, _flat(srgb(0x1c2428))), "mpReflector": (0.2, _reflector), "mpCable": (0.8, _flat(srgb(0x161614))),
    "mpSilver": (0.15, _flat(srgb(0xd8dee0))), "mpSilverDark": (0.2, _flat(srgb(0x9aa3a8))),
}
LOW = lambda: drystone.LOW

class Frame:
    """Local (x right, y up, z back — the barrel / the lens toward -z) → game, at `at` turned by `yaw` (rotation.y)."""
    def __init__(s, at, yaw): s.o = gv(*at); s.c = math.cos(yaw); s.s = math.sin(yaw)
    def __call__(s, x, y, z): return (s.o.x + x * s.c + z * s.s, s.o.y + y, s.o.z - x * s.s + z * s.c)

def _rod(K, nm, a, b, r, mat, t, n=8):
    return tag(K.rod(nm, a, b, r, mat, "h", n=max(4, n // 2) if LOW() else n), t)
def _box(K, nm, F, c, size, mat, t, w=0.004):
    """A box of half sizes (x, y, z) at local c, turned with the frame (its 8 corners, a hull)."""
    import bmesh
    bm = bmesh.new()
    vs = [bm.verts.new(B(*F(c[0] + sx * size[0], c[1] + sy * size[1], c[2] + sz * size[2]))) for sx in (-1, 1) for sy in (-1, 1) for sz in (-1, 1)]
    bmesh.ops.convex_hull(bm, input=vs)
    return tag(K.bevel(K.obj(nm, bm, mat, "h"), 0 if LOW() else w, 2, 40), t)
def _tube(K, nm, F, a, b, r0, r1, mat, t, n=12, caps=True, inward=False):
    """A cone / cylinder between local points a and b (radii r0, r1)."""
    import bmesh
    A, Bv = gv(*F(*a)), gv(*F(*b))
    d = (Bv - A); L_ = d.length; d.normalize()
    up = gv(0, 1, 0) if abs(d.y) < 0.95 else gv(1, 0, 0)
    u = d.cross(up).normalized(); v = u.cross(d).normalized()
    n = max(6, n // 2) if LOW() else n
    bm = bmesh.new()
    r0v = [bm.verts.new(B(*(A + (u * math.cos(q) + v * math.sin(q)) * r0))) for q in (2 * math.pi * i / n for i in range(n))]
    r1v = [bm.verts.new(B(*(Bv + (u * math.cos(q) + v * math.sin(q)) * r1))) for q in (2 * math.pi * i / n for i in range(n))]
    for i in range(n):
        j = (i + 1) % n; bm.faces.new((r0v[i], r0v[j], r1v[j], r1v[i]))
    if caps: bm.faces.new(r0v); bm.faces.new(list(reversed(r1v)))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    if inward:   # (an inner wall, seen from inside: its faces toward the axis)
        bm.normal_update()
        for f in bm.faces:
            c = f.calc_center_median(); ax = A + d * (d.dot(c - A))
            if f.normal.dot(ax - c) < 0: f.normal_flip()
    return tag(K.obj(nm, bm, mat, "h", smooth=True), t)

def aa52(K, nm, at, yaw, t, tripod=False, tripodDrop=0.75):
    """The AA-52 at its mount point `at` (the cradle's pivot), barrel toward the frame's -z."""
    F = Frame(at, yaw)
    # the receiver, its feed cover, the rear trunnion block
    _box(K, nm + "Recv", F, (0, 0.03, 0.08), (0.035, 0.05, 0.22), "mpGun", t)
    _box(K, nm + "Cover", F, (0, 0.088, 0.02), (0.03, 0.012, 0.14), "mpGun", t)
    _box(K, nm + "Mount", F, (0, -0.035, 0.0), (0.03, 0.025, 0.05), "mpGun", t)
    # the barrel: a finned jacket over the first third, the bare barrel, the flash hider
    _tube(K, nm + "Jacket", F, (0, 0.03, -0.14), (0, 0.03, -0.42), 0.024, 0.024, "mpGun", t, 10)
    if not LOW():
        for k in range(7):   # the cooling fins / holes read as rings
            z = -0.17 - k * 0.035
            _tube(K, f"{nm}Fin{k}", F, (0, 0.03, z), (0, 0.03, z - 0.008), 0.029, 0.029, "mpGun", t, 10)
    _tube(K, nm + "Barrel", F, (0, 0.03, -0.42), (0, 0.03, -0.8), 0.012, 0.011, "mpGun", t, 8)
    _tube(K, nm + "Flash", F, (0, 0.03, -0.8), (0, 0.03, -0.88), 0.017, 0.02, "mpGun", t, 8)
    # the carrying handle, the sights
    _rod(K, nm + "HandleA", F(0, 0.055, -0.22), F(0, 0.13, -0.24), 0.007, "mpGun", t, 6)
    _rod(K, nm + "HandleB", F(0, 0.13, -0.24), F(0, 0.13, -0.33), 0.009, "mpGunOlive", t, 6)
    if not LOW():
        _box(K, nm + "FSight", F, (0, 0.06, -0.79), (0.003, 0.022, 0.004), "mpGun", t, 0)
        _box(K, nm + "RSight", F, (0, 0.105, 0.12), (0.012, 0.012, 0.01), "mpGun", t, 0)
    # the bipod folded under the barrel
    for sx in (-1, 1):
        _rod(K, f"{nm}Bipod{sx}", F(sx * 0.015, 0.0, -0.42), F(sx * 0.022, -0.012, -0.72), 0.006, "mpGun", t, 5)
    # pistol grip, trigger guard, the shaped stock (wood)
    _box(K, nm + "Grip", F, (0, -0.06, 0.2), (0.016, 0.055, 0.022), "mpWood", t)
    _box(K, nm + "Stock", F, (0, 0.0, 0.42), (0.022, 0.04, 0.11), "mpWood", t)
    _box(K, nm + "Butt", F, (0, -0.03, 0.53), (0.024, 0.07, 0.025), "mpWood", t)
    # the belt box on the left, the belt into the feed
    _box(K, nm + "BeltBox", F, (-0.13, -0.04, 0.03), (0.055, 0.08, 0.1), "mpGunOlive", t)
    if not LOW():
        for k in range(7):
            x = -0.08 + k * 0.012
            _rod(K, f"{nm}Round{k}", F(x, 0.03 - abs(k - 3) * 0.004, 0.035), F(x, 0.03 - abs(k - 3) * 0.004, -0.01), 0.005, "mpBrass", t, 5)
    if tripod:
        for k in range(3):
            a = k / 3 * 2 * math.pi + math.pi / 2
            foot = F(math.cos(a) * 0.55, -tripodDrop, math.sin(a) * 0.55 + 0.1)
            _rod(K, f"{nm}Leg{k}", F(0, -0.06, 0.05), foot, 0.016, "mpGunOlive", t, 6)
            _rod(K, f"{nm}Shoe{k}", foot, (foot[0], foot[1] + 0.025, foot[2]), 0.028, "mpGunOlive", t, 6)
        _tube(K, nm + "Head", F, (0, -0.1, 0.05), (0, -0.06, 0.05), 0.04, 0.035, "mpGunOlive", t, 10)

def _annulus(K, nm, F, y, z0, z1, r0, r1, mat, t, n=24):
    """A ring facing -z between radii r0 (at z0) and r1 (at z1), about the local axis (0, y, *)."""
    import bmesh
    n = 12 if LOW() else n
    bm = bmesh.new()
    a = [bm.verts.new(B(*F(math.cos(q) * r0, y + math.sin(q) * r0, z0))) for q in (2 * math.pi * i / n for i in range(n))]
    b = [bm.verts.new(B(*F(math.cos(q) * max(r1, 0.001), y + math.sin(q) * max(r1, 0.001), z1))) for q in (2 * math.pi * i / n for i in range(n))]
    for i in range(n):
        j = (i + 1) % n; bm.faces.new((a[i], a[j], b[j], b[i]))
    # facing the FRONT (-z), every face (recalc on an open ring guessed — half the rings faced in and were culled)
    front = B(*F(0, y, -1)) - B(*F(0, y, 0))
    bm.normal_update()
    for f in bm.faces:
        if f.normal.dot(front) < 0: f.normal_flip()
    return tag(K.obj(nm, bm, mat, "h", smooth=True), t)

def searchlight(K, nm, at, yaw, t, pedestal=0.9, part="all"):
    """The 60 cm searchlight: its pedestal's foot at `at`, the drum's axis `pedestal` m up, the lens toward -z.
    `part`: "base" the fixed pedestal only, "head" the turning yoke and drum only (the searchlight tower's lamp: its
    own mesh the game sweeps; no cable), "all" both."""
    F = Frame(at, yaw)
    R0, L0, y = 0.33, 0.55, pedestal
    # the pedestal: a tapered post and a round base; the fork's turntable
    if part != "head":
        _tube(K, nm + "Base", F, (0, 0, 0), (0, 0.06, 0), 0.22, 0.2, "mpLampDark", t, 14)
        _tube(K, nm + "Post", F, (0, 0.06, 0), (0, y - 0.42, 0), 0.06, 0.05, "mpLamp", t, 10)
        _tube(K, nm + "Turntable", F, (0, y - 0.44, 0), (0, y - 0.38, 0), 0.14, 0.14, "mpLampDark", t, 14)
    if part == "base": return
    # the U-yoke: two arms up to the trunnions
    for sx in (-1, 1):
        _box(K, f"{nm}Arm{sx}", F, (sx * (R0 + 0.04), y - 0.2, 0), (0.018, 0.2, 0.04), "mpLamp", t)
        _tube(K, f"{nm}Trunnion{sx}", F, (sx * (R0 + 0.01), y, 0), (sx * (R0 + 0.07), y, 0), 0.045, 0.045, "mpLampDark", t, 10)
    _box(K, nm + "Fork", F, (0, y - 0.4, 0), (R0 + 0.06, 0.018, 0.04), "mpLamp", t)
    # the drum: the body, the front rim proud of it, the rear cap
    # (OPEN tubes: closed, their front caps sat in front of the reflector and hid it — a flat grey disc, 2026-10-21)
    _tube(K, nm + "Drum", F, (0, y, L0 / 2), (0, y, -L0 / 2), R0 * 0.94, R0, "mpLamp", t, 20, caps=False)
    _tube(K, nm + "Rim", F, (0, y, -L0 / 2), (0, y, -L0 / 2 - 0.06), R0 + 0.025, R0 + 0.025, "mpLampDark", t, 20, caps=False)
    _annulus(K, nm + "RimFace", F, y, -L0 / 2 - 0.06, -L0 / 2 - 0.06, R0 + 0.025, R0 * 0.95, "mpLampDark", t)
    # the INNER SLEEVE from the rim's face back to the reflector's edge (open, the gap showed the empty drum — "it
    # seems hollow", 2026-10-21)
    _tube(K, nm + "Sleeve", F, (0, y, -L0 / 2 - 0.06), (0, y, -L0 / 2 + 0.035), R0 * 0.95, R0 * 0.95, "mpLampDark", t, 20, caps=False, inward=True)
    _tube(K, nm + "Cap", F, (0, y, L0 / 2), (0, y, L0 / 2 + 0.12), R0 * 0.94, R0 * 0.55, "mpLampDark", t, 20)
    # the silver reflector seen through the clear glass (an opaque dark "glass" over it read as a flat grey disc,
    # 2026-10-21), its bulb at the centre; set back in the rim
    # the reflector as REAL rings (a painted pattern blurs in any atlas): concentric silver bands, dished in to the centre
    bands = 6 if not LOW() else 3
    for k in range(bands):
        r0, r1 = R0 * 0.95 * (bands - k) / bands, R0 * 0.95 * (bands - k - 1) / bands
        z0, z1 = -L0 / 2 + 0.02 + 0.12 * (1 - (r0 / R0) ** 2), -L0 / 2 + 0.02 + 0.12 * (1 - (r1 / R0) ** 2)
        _annulus(K, f"{nm}Ref{k}", F, y, z0, z1, r0, r1, "mpSilver" if k % 2 == 0 else "mpSilverDark", t)
    # the lamp: a socket from the reflector's centre, the bulb on it (a rounded glass)
    _tube(K, nm + "Socket", F, (0, y, -L0 / 2 + 0.12), (0, y, -L0 / 2 + 0.02), 0.03, 0.03, "mpLampDark", t, 10)
    _tube(K, nm + "Bulb", F, (0, y, -L0 / 2 + 0.02), (0, y, -L0 / 2 - 0.04), 0.05, 0.035, "mpSilver", t, 12)
    _tube(K, nm + "BulbTip", F, (0, y, -L0 / 2 - 0.04), (0, y, -L0 / 2 - 0.06), 0.035, 0.012, "mpSilver", t, 12)
    if not LOW():
        for k in range(8):   # the cooling fins round the drum's back
            z = L0 / 2 - 0.04 - k * 0.035
            _tube(K, f"{nm}Fin{k}", F, (0, y, z), (0, y, z - 0.012), R0 + 0.02, R0 + 0.02, "mpLampDark", t, 20)
        for k in range(6):   # the rim's clamps
            a = k / 6 * 2 * math.pi
            _box(K, f"{nm}Clamp{k}", F, (math.cos(a) * (R0 + 0.03), y + math.sin(a) * (R0 + 0.03), -L0 / 2 - 0.03), (0.02, 0.02, 0.035), "mpLampDark", t, 0)
        for sx in (-1, 1):   # the two handles on the back
            _rod(K, f"{nm}Handle{sx}", F(sx * 0.12, y + 0.18, L0 / 2 + 0.05), F(sx * 0.12, y + 0.18, L0 / 2 + 0.2), 0.012, "mpLampDark", t, 6)
        # the power cable from the cap down the post
        pts = [F(0.05, y - 0.05, L0 / 2 + 0.1), F(0.12, y - 0.3, 0.3), F(0.1, 0.3, 0.12), F(0.18, 0.02, 0.2)]
        if part == "all":
            for i in range(3): _rod(K, f"{nm}Cable{i}", pts[i], pts[i + 1], 0.012, "mpCable", t, 6)

# ── THE 81 mm MORTAR (Brandt mle 27/31, 2026-10-21 — the mortar pit) ───────────────────────────────────────────────
# Its frame is the OLD piece's (rtsAlgeria buildMortarPit): the baseplate at the origin, the tube from (0, 0.05, 0)
# 1.28 m at 55° toward -z (the game reads its muzzle there — algMortarPit pitMouth), the bipod's head 0.78 up the tube.
MORTAR_TILT, MORTAR_L = math.radians(35), 1.28
def mortarAlong(t): return (0, 0.05 + math.cos(MORTAR_TILT) * t, -math.sin(MORTAR_TILT) * t)

def mortar81(K, nm, t, at=(0, 0, 0), yaw=0.0):
    F = Frame(at, yaw)
    A = mortarAlong
    # the baseplate: a ribbed steel plate, its socket and the ball the tube's foot sits in
    _box(K, nm + "Plate", F, (0, 0.03, 0.05), (0.27, 0.025, 0.24), "mpGunOlive", t, 0.01)
    if not LOW():
        for k in (-1, 0, 1):
            _box(K, f"{nm}Rib{k}", F, (k * 0.16, 0.065, 0.05), (0.012, 0.02, 0.22), "mpGunOlive", t, 0)
        _box(K, nm + "RibX", F, (0, 0.065, 0.05), (0.25, 0.02, 0.012), "mpGunOlive", t, 0)
    _tube(K, nm + "Socket", F, (0, 0.05, 0), (0, 0.11, 0), 0.07, 0.06, "mpGun", t, 12)
    # the tube: the breech cap, the barrel (a little slimmer to the mouth), the muzzle ring
    _tube(K, nm + "Breech", F, A(-0.02), A(0.12), 0.06, 0.058, "mpGun", t, 14)
    _tube(K, nm + "Tube", F, A(0.12), A(MORTAR_L - 0.03), 0.045, 0.043, "mpGunOlive", t, 14)
    _tube(K, nm + "Mouth", F, A(MORTAR_L - 0.03), A(MORTAR_L), 0.05, 0.05, "mpGun", t, 14, caps=False)
    # the collar round the tube at the bipod's head, its two shock absorbers along the tube
    hx, hy, hz = A(0.78)
    _tube(K, nm + "Collar", F, A(0.74), A(0.84), 0.07, 0.07, "mpGun", t, 12)
    for sx in (-1, 1):
        a0, a1 = A(0.6), A(0.86)
        _tube(K, f"{nm}Shock{sx}", F, (sx * 0.08, a0[1], a0[2]), (sx * 0.08, a1[1], a1[2]), 0.024, 0.024, "mpGun", t, 8)
    # the bipod: two legs from the head to their spades, the chain between, the elevating column with its crank,
    # the traversing screw across the head
    feet = [(sx * 0.36, 0.0, hz - 0.4) for sx in (-1, 1)]
    for k, (fx, fy, fz) in enumerate(feet):
        _rod(K, f"{nm}Leg{k}", F(0, hy - 0.08, hz), F(fx, fy + 0.04, fz), 0.019, "mpGunOlive", t, 7)
        _box(K, f"{nm}Spade{k}", F, (fx, 0.02, fz), (0.05, 0.02, 0.035), "mpGun", t, 0)
    if not LOW():
        _rod(K, nm + "Chain", F(feet[0][0] * 0.55, 0.3, hz - 0.22), F(feet[1][0] * 0.55, 0.3, hz - 0.22), 0.006, "mpGun", t, 4)
    _tube(K, nm + "Column", F, (0, hy - 0.08, hz), (0, 0.32, hz - 0.18), 0.026, 0.022, "mpGun", t, 8)
    _rod(K, nm + "Crank", F(0, 0.32, hz - 0.18), F(0.1, 0.3, hz - 0.22), 0.008, "mpGun", t, 5)
    _tube(K, nm + "Traverse", F, (-0.12, hy - 0.08, hz), (0.12, hy - 0.08, hz), 0.022, 0.022, "mpGun", t, 8)
    if not LOW():
        _rod(K, nm + "TravHandle", F(0.12, hy - 0.08, hz), F(0.2, hy - 0.16, hz), 0.007, "mpGun", t, 5)
    # the sight on the left of the collar
    _box(K, nm + "Sight", F, (-0.13, hy + 0.04, hz), (0.03, 0.06, 0.05), "mpGunOlive", t)
    if not LOW():
        _tube(K, nm + "SightGlass", F, (-0.13, hy + 0.12, hz), (-0.13, hy + 0.12, hz + 0.08), 0.016, 0.016, "mpGun", t, 8)

def bomb81(K, nm, F, c, d, t, mat="mpGunOlive"):
    """An 81 mm bomb lying from c along direction d (local): the teardrop body, the fuze, the tail and its fins."""
    c, d = Vector(c), Vector(d).normalized()
    p = lambda s: tuple(c + d * s)
    _tube(K, nm + "Fuze", F, p(0.0), p(0.05), 0.012, 0.025, "mpBrass", t, 8)
    _tube(K, nm + "Nose", F, p(0.05), p(0.14), 0.025, 0.04, mat, t, 10)
    _tube(K, nm + "Body", F, p(0.14), p(0.26), 0.04, 0.036, mat, t, 10)
    _tube(K, nm + "Tail", F, p(0.26), p(0.4), 0.014, 0.014, mat, t, 6)
    if not LOW():
        q = d.cross(Vector((0, 1, 0))).normalized() if abs(d.y) < 0.9 else Vector((1, 0, 0))
        r = d.cross(q).normalized()
        for k, e in enumerate((q, r, -q, -r)):
            s0 = c + d * 0.34
            _rod(K, f"{nm}Fin{k}", F(*s0), F(*(s0 + d * 0.06 + e * 0.035)), 0.006, mat, t, 3)

# ── SHARED EARTH (2026-10-21: the MG nest, the mortar pit, the fortified point) ─────────────────────────────────────
import os as _os
import bpy as _bpy
_GROUND = _os.path.join(_os.path.dirname(__file__), "..", "..", "public", "textures", "ground")
def groundPhoto(nb, folder, file, sc, data=False):
    im = _bpy.data.images.load(_os.path.abspath(_os.path.join(_GROUND, folder, file)), check_existing=True)
    if data: im.colorspace_settings.name = "Non-Color"
    mp = nb.N.new("ShaderNodeMapping"); nb.L.new(nb.tc.outputs["Object"], mp.inputs["Vector"]); mp.inputs["Scale"].default_value = (sc, sc, sc)
    n = nb.N.new("ShaderNodeTexImage"); n.image = im; n.projection = "BOX"; n.projection_blend = 0.3
    nb.L.new(mp.outputs["Vector"], n.inputs["Vector"]); return n.outputs["Color"]
def earthMat(tint=0xb09070, sc=0.45):
    """Dug spoil: the photographed dry mud (half strength over a brown) with its RELIEF on the BSDF (normals=True)."""
    def f(nb):
        c = groundPhoto(nb, "brown_mud_dry", "brown_mud_dry_diff_1k.jpg", sc)
        c = nb.mix(0.5, c, srgb(tint))
        c = nb.mix(1.0, c, (0.62, 0.52, 0.4), "MULTIPLY")
        c = nb.mix(nb.math("MULTIPLY", nb.mr(nb.noise(1.2, 4), 0.45, 0.7), 0.5), c, tuple(v * 0.8 for v in srgb(tint)))
        pb = next(n for n in nb.N if n.type == "BSDF_PRINCIPLED")
        nm = nb.N.new("ShaderNodeNormalMap"); nm.inputs["Strength"].default_value = 1.4
        nb.L.new(groundPhoto(nb, "brown_mud_dry", "brown_mud_dry_nor_gl_1k.jpg", sc, True), nm.inputs["Color"])
        nb.L.new(nm.outputs["Normal"], pb.inputs["Normal"])
        return c
    return f
def timberMat(tint):
    def f(nb):
        c = nb.mix(1.0, nb.img("build/raw_plank_wall/raw_plank_wall_diff_1k.jpg", 0.9), srgb(tint), "MULTIPLY")
        return dust(nb, nb.scale(c, nb.mr(nb.island(), 0, 1, 0.78, 1.15)), 0.9)
    return f

# ── CLOTH SHADING, BAKED (2026-10-22, you: "push the fold shading and stitching") ───────────────────────────────────
def foldShade(nb, c, k=1.0):
    """The cloth's own curvature (Cycles' pointiness, baked into the atlas: free in the game): the creases darker, the
    ridges of its folds lighter — the shading a canvas has between its ties."""
    # (NOT Cycles' pointiness: with it the bakes crashed in ccl::create_mesh, every time — the curvature is computed in
    # Python, clothKit.writeFold, into a "fold" attribute: R the curvature round 0.5, G 1 where it was written)
    at = nb.N.new("ShaderNodeAttribute"); at.attribute_name = "fold"
    sep = nb.N.new("ShaderNodeSeparateColor"); nb.L.new(at.outputs["Color"], sep.inputs[0])
    p, has = sep.outputs["Red"], sep.outputs["Green"]
    crease = nb.mr(p, 0.3, 0.5, 1.0 - 0.45 * k, 1.0)
    ridge = nb.mr(p, 0.5, 0.7, 1.0, 1.0 + 0.2 * k)
    shaded = nb.scale(nb.scale(c, crease), ridge)
    return nb.mix(has, c, shaded)

def stitched(base, thread=0x9a8e70, pitch=0.032):   # (a dirty thread: a bright one read as zip tape)
    """A SEAM's strip: its own canvas `base` (a material function), rows of stitches over it — short light dashes of
    thread every `pitch` m (a grid of them in space: on a seam a hand's width across, two or three rows of running
    stitch), each a little dark where it pulls the cloth."""
    def f(nb):
        c = base(nb)
        sep = nb.N.new("ShaderNodeSeparateXYZ"); nb.L.new(nb.geo.outputs["Position"], sep.inputs[0])
        k = 2 * math.pi / pitch
        sx = nb.math("SINE", nb.math("MULTIPLY", sep.outputs["X"], k))
        sy = nb.math("SINE", nb.math("MULTIPLY", sep.outputs["Y"], k * 0.5))
        sz = nb.math("SINE", nb.math("MULTIPLY", sep.outputs["Z"], k))
        d = nb.math("MULTIPLY", nb.math("MULTIPLY", sx, sz), sy)
        st = nb.mr(nb.math("ABSOLUTE", d), 0.42, 0.55, 0.0, 0.75)                     # the thread (sparse, half-seen)
        pull = nb.mr(nb.math("ABSOLUTE", d), 0.2, 0.4, 0.0, 1.0)                      # its shadow round it
        c = nb.mix(nb.math("MULTIPLY", pull, 0.25), c, nb.scale(c, 0.7))
        return nb.mix(st, c, srgb(thread))
    return f
