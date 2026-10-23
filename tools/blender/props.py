"""SHARED PROPS — the small things every building script places, built ONCE (2026-10-23).

You: "everything in the game should be coherent — if we make a better oil drum the others shouldn't look cheap", and
"the best optimisation possible". Four scripts had four drums (motorPool, postKit, searchlightTower, supplyPoint):
a cylinder and two tori, or a cylinder alone. Here, one of each prop; the scripts call it with their own materials
and their own placement, and their kit joins and bakes it as before (one atlas, one draw).

  drum(make, nm, paint, steel, low=False, dent=0.0, seed=0, burnt=False) -> [objects]
  jerry(make, nm, paint, steel, low=False)              the 20 l jerrycan, long along x
  crate(make, nm, wood, rope, L, H, W, low=False)        a planked crate with end battens, long along x
                                                         (its top is H + CRATE_TOP: stack the next one 3 mm over that —
                                                         exactly on it, the two crates' battens line up edge to edge and z-fight)
  ammo(make, nm, paint, steel, low=False)                the steel ammunition box, long along x
  drum_paint(0xRRGGBB, rust) / steel_paint             painted steel, worn and dusty — a MATDEF entry
      make(name, bmesh, material_key) -> object   (the kit's own: K.obj(..., smooth=True), motorPool's obj)
      Built round its BASE CENTRE at the origin, its axis the game's +Y; the caller moves it (supplyPoint.move…).

Geometry in game metres through bkit.B (game x, y up, z → Blender x, -z, y), as every kit script.
"""
import math, random
import bmesh
from mathutils import Vector, Matrix, Euler
from bkit import B, srgb, dust, DUST

# ── THE DRUM'S PAINT (2026-10-23, you: "add the dust and wear") — one recipe for every kit's drums: their own colour,
# faded, each drum its own shade, rust running down from the top chime and the bungs, rust blooms, the chimes and
# hoops rubbed bright, dust on the lid and splashed up the foot. A MATDEF entry: (roughness, drum_paint(0x535a3a)).
def drum_paint(base, rust=0.5):
    def f(nb):
        b = srgb(base)
        c = nb.mix(nb.noise(1.5, 4), b, tuple(v * 0.78 for v in b))                              # sun-faded patches
        c = nb.scale(c, nb.mr(nb.geo.outputs["Random Per Island"], 0, 1, 0.86, 1.1))             # never two alike
        # rust STREAKS: a noise stretched along the height (fast round the drum, slow down it), the upper part most
        streak = nb.math("MULTIPLY", nb.mr(nb.noise(6.0, 4, stretch=(4.0, 4.0, 0.3)), 0.6, 0.7), nb.mr(nb.gy, 0.25, 0.9, 0.25, 1.0))
        c = nb.mix(nb.math("MULTIPLY", streak, 0.75 * rust), c, srgb(0x5a3016))
        c = nb.mix(nb.math("MULTIPLY", nb.mr(nb.noise(7.0, 7), 0.68, 0.75), 0.9 * rust), c, srgb(0x6a3d22))   # blooms
        # the chimes and hoops rubbed to bare steel (their convex edges)
        wear = nb.math("MULTIPLY", nb.mr(nb.geo.outputs["Pointiness"], 0.52, 0.58), nb.noise(30.0, 3))
        c = nb.mix(nb.math("MULTIPLY", wear, 1.8), c, srgb(0x7d7466))
        # dust on whatever faces up (the lid, in its sunk ring), patchy
        sep = nb.N.new("ShaderNodeSeparateXYZ"); nb.L.new(nb.geo.outputs["Normal"], sep.inputs[0])
        up = nb.math("MULTIPLY", nb.mr(sep.outputs["Z"], 0.7, 0.95), nb.mr(nb.noise(5.0, 5), 0.35, 0.7, 0.3, 0.85))
        c = nb.mix(up, c, DUST)
        return dust(nb, c, 0.55, 1.1)                                                           # and up the foot
    return f

# the props' own small materials, for every kit's MATDEF (MATDEF.update(props.PROP_MATS)): the fittings' dark steel, rope
PROP_MATS = {
    "propFittings": (0.5, drum_paint(0x2c2e2a, 0.25)),
    "propRope": (0.9, lambda nb: dust(nb, nb.mix(nb.noise(6.0, 3), srgb(0x9a8a68), srgb(0x786a4e)), 0.4, 0.6)),
}
steel_paint = drum_paint   # (the jerrycans, ammo boxes: the same painted, worn, dusty steel)

# ── THE 200-LITRE DRUM (a French army fuel drum of the war: 0.585 m across the hoops, 0.88 m tall) ───────────────
# One TURNED profile (r, y), base to lid: the bottom lid set 16 mm up inside the rolled CHIME, the body, the two
# ROLLING HOOPS pressed out of the sheet at 1/3 and 2/3, the top chime, the top lid sunk 16 mm. The hoops and chimes
# are what reads as a drum from the RTS camera (a smooth cylinder reads as a tin can); in the profile they cost rings,
# not separate tori overlapping the body (the old drums' tori sat ON the cylinder: coplanar slivers, z-fighting).
_R = 0.286          # the body's radius
_H = 0.88
def _profile(low):
    hoop = lambda y: [(_R, y - 0.02), (_R + 0.0045, y - 0.011), (_R + 0.007, y), (_R + 0.0045, y + 0.011), (_R, y + 0.02)]
    if low:   # the far level: the chimes and hoops as single steps, 12 sides
        return ([(0, 0.016), (_R - 0.012, 0.016), (_R + 0.006, 0.0), (_R + 0.006, 0.024)] + [(_R, 0.03)]
                + [(_R, 0.27), (_R + 0.007, 0.29), (_R, 0.31), (_R, 0.57), (_R + 0.007, 0.59), (_R, 0.61)]
                + [(_R, _H - 0.026), (_R + 0.006, _H - 0.02), (_R + 0.006, _H), (_R - 0.012, _H - 0.016), (0, _H - 0.016)])
    body = lambda y0, y1, n: [(_R, y0 + (y1 - y0) * k / n) for k in range(1, n)]   # rings for the dents to bend
    return ([(0, 0.016), (0.15, 0.016), (_R - 0.014, 0.016), (_R - 0.007, 0.008), (_R, 0.0), (_R + 0.0065, 0.004),
             (_R + 0.0075, 0.013), (_R + 0.005, 0.021), (_R + 0.0005, 0.027), (_R, 0.032)]
            + body(0.032, 0.27, 3) + hoop(0.29) + body(0.31, 0.57, 3) + hoop(0.59) + body(0.61, _H - 0.028, 3)
            + [(_R, _H - 0.028), (_R + 0.005, _H - 0.021), (_R + 0.0075, _H - 0.013), (_R + 0.0065, _H - 0.004),
               (_R, _H), (_R - 0.007, _H - 0.008), (_R - 0.014, _H - 0.016), (0.15, _H - 0.016), (0, _H - 0.016)])

def drum_body(low=False, dent=0.0, seed=0):
    """The drum's turned shell as a bmesh (Blender space, base centre at the origin). `dent` 0..1: a few knocks
    pressed into the body (a drum that has been thrown off a truck), out of round a little — never two alike."""
    R = random.Random(seed * 7919 + 13)
    n = 12 if low else 28
    prof = _profile(low)
    knocks = [(R.uniform(0, 2 * math.pi), R.uniform(0.12, _H - 0.12), R.uniform(0.06, 0.14), R.uniform(0.4, 1.0))
              for _ in range(R.randint(1, 3))] if dent > 0 else []
    wob = R.uniform(0, 2 * math.pi)
    bm = bmesh.new(); rings = []
    for r, y in prof:
        if r == 0:
            rings.append([bm.verts.new(B(0, y, 0))]); continue
        ring = []
        for i in range(n):
            a = 2 * math.pi * i / n
            rr = r * (1 + 0.004 * math.cos(2 * (a - wob)))                         # not quite round
            if 0.03 < y < _H - 0.03:                                               # the knocks: only the body
                for ka, ky, ks, kd in knocks:
                    da = math.atan2(math.sin(a - ka), math.cos(a - ka)) * _R
                    rr -= dent * 0.035 * kd * math.exp(-(da * da + (y - ky) ** 2) / (ks * ks))
            ring.append(bm.verts.new(B(math.cos(a) * rr, y, math.sin(a) * rr)))
        rings.append(ring)
    for k in range(len(rings) - 1):
        a, b = rings[k], rings[k + 1]
        if len(a) == 1:
            for i in range(n): bm.faces.new((a[0], b[(i + 1) % n], b[i]))
        elif len(b) == 1:
            for i in range(n): bm.faces.new((a[i], a[(i + 1) % n], b[0]))
        else:
            for i in range(n): bm.faces.new((a[i], a[(i + 1) % n], b[(i + 1) % n], b[i]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return bm

def drum_bungs(seed=0):
    """The two screwed bungs on the top lid (2" and 3/4"), hexagonal caps standing 9 mm proud of the sunk lid."""
    R = random.Random(seed * 31 + 5)
    a0 = R.uniform(0, 2 * math.pi)
    bm = bmesh.new(); y0 = _H - 0.016
    for a, r, rad, h in ((a0, 0.19, 0.03, 0.011), (a0 + math.pi * 0.92, 0.2, 0.017, 0.009)):
        cx, cz = math.cos(a) * r, math.sin(a) * r
        lo = [bm.verts.new(B(cx + math.cos(t) * rad, y0 - 0.002, cz + math.sin(t) * rad)) for t in (math.pi / 3 * i for i in range(6))]
        hi = [bm.verts.new(B(cx + math.cos(t) * rad, y0 + h, cz + math.sin(t) * rad)) for t in (math.pi / 3 * i for i in range(6))]
        for i in range(6): bm.faces.new((lo[i], lo[(i + 1) % 6], hi[(i + 1) % 6], hi[i]))
        bm.faces.new(list(reversed(lo))); bm.faces.new(hi)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return bm

def drum(make, nm, paint, steel, low=False, dent=0.0, seed=0, burnt=False):
    """A 200 l drum: its shell in `paint` (the kit's drum colour; a burnt one: its charred material), the bungs in
    `steel`. Returns the objects, built round the base centre — the caller places them."""
    parts = [make(nm, drum_body(low, dent, seed), paint)]
    if not low and not burnt:
        parts.append(make(nm + "Bungs", drum_bungs(seed), steel))
    return parts

def place(parts, at, yaw=0.0, tilt=0.0):
    """Carry a prop built round its base centre to game point `at`, turned by `yaw` (three.js rotation.y = Blender's Z
    turn) and tipped by `tilt` (about its own long axis x first). Returns the parts."""
    M = Matrix.Translation(B(*at)) @ Euler((tilt, 0.0, yaw), "XYZ").to_matrix().to_4x4()
    for o in parts:
        if o is not None: o.matrix_basis = M @ o.matrix_basis
    return parts

# ── shared bmesh helpers (game metres through B) ─────────────────────────────────────────────────────────────────
def _box(bm, x0, x1, y0, y1, z0, z1, bevel=0.0, seg=1):
    """An axis box (game coords) added to bm; `bevel`: its edges rounded (bmesh bevel, `seg` segments)."""
    v = [bm.verts.new(B(x, y, z)) for x in (x0, x1) for y in (y0, y1) for z in (z0, z1)]
    f = [bm.faces.new(q) for q in ((v[0], v[1], v[3], v[2]), (v[4], v[6], v[7], v[5]), (v[0], v[4], v[5], v[1]),
                                   (v[2], v[3], v[7], v[6]), (v[0], v[2], v[6], v[4]), (v[1], v[5], v[7], v[3]))]
    bmesh.ops.recalc_face_normals(bm, faces=f)
    if bevel > 0:
        es = list({e for q in f for e in q.edges})
        bmesh.ops.bevel(bm, geom=es + v, offset=bevel, segments=seg, affect="EDGES", profile=0.5, clamp_overlap=True)
    return f

def _cyl(bm, a, d, r, h, n=8):
    """A capped cylinder from game point a along game unit vector d, h long."""
    a = Vector(a); d = Vector(d).normalized()
    u = d.cross(Vector((0, 1, 0)) if abs(d.y) < 0.9 else Vector((1, 0, 0))).normalized(); w = d.cross(u)
    lo = [bm.verts.new(B(*(a + (u * math.cos(t) + w * math.sin(t)) * r))) for t in (2 * math.pi * i / n for i in range(n))]
    hi = [bm.verts.new(B(*(a + d * h + (u * math.cos(t) + w * math.sin(t)) * r))) for t in (2 * math.pi * i / n for i in range(n))]
    f = [bm.faces.new((lo[i], lo[(i + 1) % n], hi[(i + 1) % n], hi[i])) for i in range(n)] + [bm.faces.new(lo), bm.faces.new(list(reversed(hi)))]
    bmesh.ops.recalc_face_normals(bm, faces=f)

# ── THE JERRYCAN (the 20 l "jerrican" of the war, French army olive): 0.345 long, 0.165 thick, 0.47 high ──────────
# What reads from the RTS camera: the slab shape, the pressed X on both broad faces catching the low sun, the welded
# seam bead round the middle, the three handles and the spout's clamp cap. Origin: its base centre; long along x.
_JL, _JW, _JH = 0.345, 0.165, 0.43
def jerry_body(low=False):
    bm = bmesh.new()
    _box(bm, -_JL / 2, _JL / 2, 0, _JH, -_JW / 2, _JW / 2, 0.0 if low else 0.014, 2)
    if low: return bm
    # the seam bead: a 6 mm plate in the can's middle plane, 4 mm bigger all round (only its rim shows)
    _box(bm, -_JL / 2 - 0.004, _JL / 2 + 0.004, 0.003, _JH + 0.004, -0.003, 0.003)
    # the pressed X, both faces: two strips each, 3 / 6.5 mm proud (crossing, they must stand > 2.5 mm apart — the
    # coplanar check's tolerance — or they z-fight where they cross)
    for s in (-1, 1):
        for k, a in enumerate((math.atan2(_JH - 0.08, _JL - 0.08), -math.atan2(_JH - 0.08, _JL - 0.08))):
            L = math.hypot(_JL - 0.08, _JH - 0.08) / 2; c, sn = math.cos(a), math.sin(a)
            z0 = s * (_JW / 2 - (0.004 if k == 0 else 0.008)); z1 = s * (_JW / 2 + (0.003 if k == 0 else 0.0065))   # (every face of the two strips in its own plane: they cross)
            pts = [(-L * c - 0.011 * -sn, _JH / 2 - L * sn - 0.011 * c), (L * c - 0.011 * -sn, _JH / 2 + L * sn - 0.011 * c),
                   (L * c + 0.011 * -sn, _JH / 2 + L * sn + 0.011 * c), (-L * c + 0.011 * -sn, _JH / 2 - L * sn + 0.011 * c)]
            lo = [bm.verts.new(B(x, y, min(z0, z1))) for x, y in pts]; hi = [bm.verts.new(B(x, y, max(z0, z1))) for x, y in pts]
            f = [bm.faces.new((lo[i], lo[(i + 1) % 4], hi[(i + 1) % 4], hi[i])) for i in range(4)] + [bm.faces.new(lo), bm.faces.new(hi)]
            bmesh.ops.recalc_face_normals(bm, faces=f)
    return bm
def jerry_fittings(low=False):
    """The three handles (bars on short posts) and the spout with its clamp cap — the darker steel."""
    bm = bmesh.new()
    for k in (-1, 0, 1):
        x = -0.04 + k * 0.075
        _box(bm, x - 0.006, x + 0.006, _JH - 0.004, _JH + 0.034, -0.045, 0.045)              # the handle's bar, edge-on
    if not low:
        _cyl(bm, (0.125, _JH - 0.004, 0.0), (0.35, 1, 0), 0.022, 0.05, 10)                 # the spout
        _box(bm, 0.105, 0.155, _JH + 0.035, _JH + 0.05, -0.012, 0.012)                       # the clamp lever
    return bm
def jerry(make, nm, paint, steel, low=False):
    return [make(nm, jerry_body(low), paint), make(nm + "Fit", jerry_fittings(low), steel)]

# ── THE WOODEN CRATE (stores, ammunition): planked, END BATTENS round both ends, rope beckets ───────────────────────
CRATE_TOP = 0.004   # (the end battens stand this much over the lid: a crate stacked on the lid z-fought them)
def crate_body(L=0.8, H=0.42, W=0.46, low=False):
    bm = bmesh.new()
    _box(bm, -L / 2 + 0.02, L / 2 - 0.02, 0.004, H - 0.012,   # (4 mm up: it stands on its battens — its bottom and theirs in one plane z-fought under a stacked crate)
          -W / 2 + (0.0 if low else 0.01), W / 2 - (0.0 if low else 0.01), 0.0 if low else 0.004)   # (near: 1 cm behind its boards — the joints between them read dark)
    _box(bm, -L / 2 + 0.03, L / 2 - 0.03, H - 0.016, H, -W / 2 + 0.006, W / 2 - 0.006, 0.0 if low else 0.003)   # the lid
    for s in (-1, 1):   # the end battens: a frame of four cleats round each end, 2 cm proud (the far level too: they ARE the crate)
        x0, x1 = (L / 2 - 0.05, L / 2) if s > 0 else (-L / 2, -L / 2 + 0.05)
        _box(bm, x0, x1, 0.0, 0.06, -W / 2 - 0.012, W / 2 + 0.012, 0.0 if low else 0.004)
        _box(bm, x0, x1, H - 0.06, H + CRATE_TOP, -W / 2 - 0.012, W / 2 + 0.012, 0.0 if low else 0.004)
        for zs in (-1, 1): _box(bm, x0, x1, 0.06, H - 0.06, zs * (W / 2 + 0.012) - 0.03 * zs - 0.015, zs * (W / 2 + 0.012) - 0.03 * zs + 0.015, 0.004)
    if low: return bm
    # the boards on the long sides, over the body set 1 cm back: 4 mm joints between them read dark; 3 slightly
    # different depths, so the edges catch the light
    for k in range(3):
        y0, y1 = 0.012 + k * (H - 0.04) / 3, 0.012 + (k + 1) * (H - 0.04) / 3 - 0.004
        d = (0.0, 0.003, 0.006)[k]   # (3 mm steps: over the 2.5 mm the coplanar check calls one plane)
        for s in (-1, 1): _box(bm, -L / 2 + 0.055 + 0.002 * k, L / 2 - 0.055 - 0.002 * k, y0, y1, min(s * (W / 2 - 0.016 - 0.001 * k), s * (W / 2 + d)), max(s * (W / 2 - 0.016 - 0.001 * k), s * (W / 2 + d)))   # (each board's hidden faces in a plane of its own)
    return bm
def crate_rope(L=0.8, H=0.42, W=0.46):
    """The rope beckets on the two ends: a loop each (a flattened ring)."""
    bm = bmesh.new()
    for s in (-1, 1):
        cx = s * (L / 2 + 0.006); n = 8
        ring = []
        for i in range(n):
            t = 2 * math.pi * i / n
            ring.append([bm.verts.new(B(cx + s * (0.012 + 0.012 * math.cos(p)), H * 0.62 + 0.05 * math.sin(t) + 0.012 * math.sin(p), 0.09 * math.cos(t)))
                         for p in (2 * math.pi * k / 4 for k in range(4))])
        for i in range(n):
            for k in range(4): bm.faces.new((ring[i][k], ring[(i + 1) % n][k], ring[(i + 1) % n][(k + 1) % 4], ring[i][(k + 1) % 4]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return bm
def crate(make, nm, wood, rope, L=0.8, H=0.42, W=0.46, low=False):
    parts = [make(nm, crate_body(L, H, W, low), wood)]
    if not low: parts.append(make(nm + "Rope", crate_rope(L, H, W), rope))
    return parts

# ── THE STEEL AMMUNITION BOX (the US M2 can the French army used): 0.30 long, 0.19 high, 0.155 thick ───────────────
# Its lid a little wider than the body with a pressed rib, the hinged latch at one end, the folding handle on top.
_AL, _AH, _AW = 0.30, 0.165, 0.155
def ammo_body(low=False):
    bm = bmesh.new()
    _box(bm, -_AL / 2, _AL / 2, 0, _AH, -_AW / 2, _AW / 2, 0.0 if low else 0.008, 2)
    _box(bm, -_AL / 2 - 0.004, _AL / 2 + 0.004, _AH - 0.004, _AH + 0.026, -_AW / 2 - 0.004, _AW / 2 + 0.004, 0.0 if low else 0.006, 2)   # the lid
    if not low:
        _box(bm, -_AL / 2 + 0.03, _AL / 2 - 0.03, _AH + 0.026, _AH + 0.031, -0.025, 0.025, 0.002)                 # its rib
    return bm
def ammo_fittings(low=False):
    bm = bmesh.new()
    _box(bm, -0.06, 0.06, _AH + 0.031, _AH + 0.041, -0.009, 0.009)                                             # the handle
    if not low: _box(bm, _AL / 2 + 0.004, _AL / 2 + 0.014, _AH - 0.07, _AH + 0.02, -0.03, 0.03, 0.002)          # the latch
    return bm
def ammo(make, nm, paint, steel, low=False):
    return [make(nm, ammo_body(low), paint), make(nm + "Fit", ammo_fittings(low), steel)]
