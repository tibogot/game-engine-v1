"""NOT USED (dropped 2026-10-20, the same day: its 16-triangle lens pads read flat beside the engine's procedural
prickly pear — the game lays that one along MAP.fields.hedges, algGame.js. Kept for its far-level-from-the-same-seed
idea, house.py farBuilder.)

THE PRICKLY-PEAR HEDGES (2026-10-20, PIECES_INVENTORY.md "prickly-pear hedges: real cactus models"): the opuntia
hedge of every Maghreb village and field — a 3 m MODULE laid end to end along a plot's side or a piste (the game
instances it, like the field walls). Four plants a module, each a woody grey trunk and pads branching up to
five tiers: every pad an oval LENS (a ring of 8 points and a bulged centre each face, 16 triangles), the next
tier growing from the top rim of the last, each turned to its own plane. Dry pads fallen at the foot, the red /
orange figs on the top rims. Three VARIANTS; three STATES (the damage system's):

    INTACT    head-high, dense
    DAMAGED   CRUSHED through the middle (a vehicle drove through it): the pads down on the ground there
    RUIN      dried out and fallen: low stumps of grey wood, brown pads on the ground

  "C:/Program Files/Blender Foundation/Blender 5.0/blender.exe" -b --factory-startup \\
      --python tools/blender/hedge.py -- <out dir> [--quick]

Writes <out>/hedges.glb (HedgeA_Intact … HedgeC_Ruin + _Far) — then tools/optimizeGlb.mjs. Origin: the hedge's
foot, centred; it runs along local X (-1.5 … 1.5). Real metres (the game x1.3).
"""
import sys, os, math, random
sys.path.insert(0, os.path.dirname(__file__))
import bpy, bmesh
from mathutils import Vector
import house
from house import buildKit, previews
from bkit import B, srgb, dust

L = 1.5   # half length of the module

def padMat(base, dark, dots=0.5):
    def f(nb):
        c = nb.mix(nb.noise(3.0, 4), srgb(base), srgb(dark))
        # the AREOLES: pale dots over the pad, the spines' bases
        d = nb.mr(nb.noise(55.0, 2, 0.5), 0.63, 0.68, 0.0, dots)
        c = nb.mix(d, c, srgb(0xd8d2a8))
        c = nb.scale(c, nb.mr(nb.island(), 0, 1, 0.8, 1.16))   # every pad its own shade
        return dust(nb, c, 0.45, 0.8)
    return f
def plainMat(base, dark, top=0.5):
    def f(nb):
        c = nb.mix(nb.noise(6.0, 4), srgb(base), srgb(dark))
        return dust(nb, nb.scale(c, nb.mr(nb.island(), 0, 1, 0.85, 1.12)), top, 0.8)
    return f
MATDEF = dict(house.MATDEF)
MATDEF.update({
    "cactusPad": (0.75, padMat(0xb6c992, 0x98b27c)),            # glaucous green, sun-warmed
    "cactusOld": (0.85, padMat(0xc4c296, 0xa6ac84, 0.3)),       # the lower, corking pads
    "cactusDry": (0.95, plainMat(0xb39a6c, 0x8c7450)),          # dead and dried
    "cactusWood": (0.95, plainMat(0x948a78, 0x6f6658)),         # the grey trunk
    "pricklyFruit": (0.6, plainMat(0xd8683a, 0xc9a040, 0.0)),   # the figs, red to yellow
})

def nrm(v): return v.normalized() if v.length > 1e-6 else Vector((0, 1, 0))
def rot(v, axis, a):   # Rodrigues: v turned by a round axis
    return v * math.cos(a) + axis.cross(v) * math.sin(a) + axis * axis.dot(v) * (1 - math.cos(a))

def pad(K, G, nm, p0, ax, n, hl, hw, th, mat, R, far=False):
    """A pad: an oval lens from its foot p0 along ax (unit), its faces along ±n; half length / width, thickness.
    FAR: the same pad on a ring of 5 (10 triangles, not 16) — it draws the same random numbers either way, so the
    near and far plants grow alike pad for pad."""
    bm = bmesh.new()
    s = nrm(n.cross(ax))
    c = p0 + ax * hl * 0.92
    ring = []
    ks = [R.uniform(0.94, 1.04) for _ in range(8)]
    N = 5 if far else 8
    for i in range(N):
        a = 2 * math.pi * i / N
        k = ks[i * 8 // N]
        p = c + ax * (math.cos(a) * hl * k) + s * (math.sin(a) * hw * k)
        ring.append(bm.verts.new(B(*p)))
    f = bm.verts.new(B(*(c + n * th))); b = bm.verts.new(B(*(c - n * th)))
    for i in range(N):
        j = (i + 1) % N
        bm.faces.new((f, ring[i], ring[j])); bm.faces.new((b, ring[j], ring[i]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return K.obj(nm, bm, mat, G, smooth=True)

def fruit(K, G, nm, c, R, far=False):
    r, h = R.uniform(0.022, 0.03), R.uniform(0.035, 0.045)
    if far: return None                                   # (a fig is a pixel out there)
    bm = bmesh.new(); vs = []
    for i in range(10):
        u = 1 - 2 * (i + 0.5) / 10; v = i * 2.4
        q = math.sqrt(max(0.0, 1 - u * u))
        vs.append(bm.verts.new(B(c.x + q * math.cos(v) * r, c.y + u * h, c.z + q * math.sin(v) * r)))
    bmesh.ops.convex_hull(bm, input=vs)
    return K.obj(nm, bm, "pricklyFruit", G, smooth=True)

class Grower:
    def __init__(s, K, R, state, far=False):
        s.K, s.R, s.state, s.k, s.far = K, R, state, 0, far
    def name(s, t): s.k += 1; return f"{t}{s.k}"
    def grow(s, p0, ax, n, tier, maxTier, mat):
        R = s.R
        hl, hw = R.uniform(0.24, 0.31) * (1 - tier * 0.05), R.uniform(0.15, 0.19) * (1 - tier * 0.05)
        pad(s.K, "h", s.name("P"), p0, ax, n, hl, hw, 0.022, mat, R, s.far)
        c = p0 + ax * hl * 0.92
        sd = nrm(n.cross(ax))
        if tier >= maxTier:
            # the top tier: figs on the rim
            if s.state == "intact" and R.random() < 0.55:
                for i in range(R.randint(1, 4)):
                    a = R.uniform(-1.1, 1.1)
                    fruit(s.K, "h", s.name("F"), c + ax * (math.cos(a) * hl * 1.02) + sd * (math.sin(a) * hw * 1.02) + Vector((0, 0.02, 0)), R, s.far)
            return
        kids = R.choice((2, 2, 3, 3)) if tier == 0 else R.choice((1, 2, 2)) if tier == 1 else R.choice((0, 1, 1, 2))
        for i in range(kids):
            a = R.uniform(-1.0, 1.0)
            foot = c + ax * (math.cos(a) * hl * 0.9) + sd * (math.sin(a) * hw * 0.9)
            d = nrm(ax * math.cos(a * 1.4) + sd * math.sin(a * 1.4) + Vector((0, R.uniform(0.2, 0.5), 0)))
            # (its own plane: the parent's normal made square to the new axis, then turned round it)
            nn = nrm(n - d * n.dot(d))
            nn = rot(nn, d, R.uniform(0.4, 1.4) * R.choice((-1, 1)))
            s.grow(foot, d, nn, tier + 1, maxTier, "cactusPad")
    def plant(s, x, z, height):
        """One opuntia: a short lean trunk, old pads at its head, green tiers above."""
        R = s.R
        lean = Vector((R.uniform(-0.15, 0.15), 1, R.uniform(-0.15, 0.15))).normalized()
        top = Vector((x, 0, z)) + lean * (0.22 * height)
        s.K.rod(s.name("T"), (x, -0.05, z), tuple(top), R.uniform(0.05, 0.075), "cactusWood", "h", n=4 if s.far else 6)
        maxTier = 3 if height > 0.8 else 2
        for i in range(R.choice((3, 3, 4))):
            ang = R.uniform(0, 2 * math.pi)
            d = nrm(Vector((math.cos(ang) * 0.9, 1, math.sin(ang) * 0.5)))
            n = nrm(Vector((-math.sin(ang), 0, math.cos(ang))))
            n = nrm(n - d * n.dot(d))
            s.grow(top, d, n, 0 if s.state != "ruin" else 2, maxTier, "cactusOld" if s.state != "ruin" else "cactusDry")
    def fallen(s, x, z, mat):
        R = s.R
        a = R.uniform(0, 2 * math.pi)
        ax = Vector((math.cos(a), R.uniform(-0.1, 0.25), math.sin(a))).normalized()
        n = nrm(Vector((0, 1, 0)) - ax * ax.y)
        n = rot(n, ax, R.uniform(-0.5, 0.5))
        pad(s.K, "h", s.name("D"), Vector((x, 0.03, z)), ax, n, R.uniform(0.15, 0.21), R.uniform(0.1, 0.13), 0.02, mat, R, s.far)

def buildHedge(K, name, spec, state, seed, far=False):
    R = random.Random(seed)
    g = Grower(K, R, state, far)
    xs = [c + R.uniform(-0.12, 0.12) for c in (-1.12, -0.37, 0.37, 1.12)]
    for i, x in enumerate(xs):
        z = (0.3 if i % 2 else -0.3) + R.uniform(-0.12, 0.12)   # (two staggered rows: a hedge has depth)
        if state == "damaged" and i in (1, 2):
            # CRUSHED: the middle plant down on the ground, a stump left
            K.rod(g.name("T"), (x, -0.05, z), (x + 0.05, 0.25, z), 0.06, "cactusWood", "h", n=6)
            for j in range(10):
                g.fallen(x + R.uniform(-0.7, 0.7), z + R.uniform(-0.6, 0.6), R.choice(("cactusPad", "cactusPad", "cactusDry")))
            continue
        if state == "ruin":
            if R.random() < 0.7: g.plant(x, z, 0.5)
            for j in range(7):
                g.fallen(x + R.uniform(-0.6, 0.6), z + R.uniform(-0.7, 0.7), R.choice(("cactusDry", "cactusDry", "cactusPad")))
            continue
        g.plant(x, z, R.uniform(0.9, 1.15))
    # dry pads at the foot of a standing hedge
    if state != "ruin":
        for j in range(R.randint(3, 6)):
            g.fallen(R.uniform(-L, L), R.choice((-1, 1)) * R.uniform(0.3, 0.7), "cactusDry")

farHedge = lambda K, name, spec, state, seed: buildHedge(K, name, spec, state, seed, far=True)
TYPES = {t: dict(builder=buildHedge, farBuilder=farHedge, atlas=1024, aoDist=0.2) for t in ("a", "b", "c")}   # (the pads packed: a short AO, or the inside bakes black)

exported = buildKit(TYPES, MATDEF, "hedges.glb", prefix="Hedge", seed0=1962)
previews(TYPES, exported, prefix="Hedge", tag="hedge_", spacing=4.0, frame=0.2)
print("DONE")
