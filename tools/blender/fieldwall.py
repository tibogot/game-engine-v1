"""THE FIELD WALLS (2026-10-20, PIECES_INVENTORY.md — you: "the fields look cheap"): the dry-stone walls round
the Aurès' plots, a 2.4 m MODULE laid end to end along a plot's sides (the game instances it: hundreds of
segments, so each is LIGHT — every stone a jittered hull of ~12 triangles). Field stones of every size in rough
courses, a row of capstones on top; three VARIANTS so a run never repeats; three STATES (the damage system's):

    INTACT    knee-high (0.85 m), the courses and capstones
    DAMAGED   BREACHED: a gap through it, its stones fallen in a heap in front
    RUIN      tumbled down to half height, stones scattered both sides

  "C:/Program Files/Blender Foundation/Blender 5.0/blender.exe" -b --factory-startup \\
      --python tools/blender/fieldwall.py -- <out dir> [--quick]

Writes <out>/fieldwalls.glb (WallA_Intact … WallC_Ruin + _Far) — then tools/optimizeGlb.mjs. Origin: the wall's
foot, centred; it runs along local X (-1.2 … 1.2), its faces at ±Z. Real metres (the game x1.3).
"""
import sys, os, math, random
sys.path.insert(0, os.path.dirname(__file__))
import bpy, bmesh
import house
from house import buildKit, previews, REFS
from bkit import B, srgb, dust

L, HGT, TH = 1.2, 0.85, 0.28   # half length, height, half thickness (at the foot; it batters in)

def stoneMat(tint):
    def f(nb):
        c = nb.img("build/rabdentse_ruins_wall/rabdentse_ruins_wall_diff_1k.jpg", 0.9)
        # (mostly the TINT, the photo's grain under it: the ruin-wall photo is dark — the atlas averaged 90/255
        # and the walls drew near-black beside the 150/255 ground, 2026-10-20)
        c = nb.mix(0.8, c, srgb(tint))
        c = nb.scale(c, nb.mr(nb.island(), 0, 1, 0.8, 1.18))   # every stone its own shade
        return dust(nb, c, 1.6, 1.1)
    return f
MATDEF = dict(house.MATDEF)
MATDEF.update({"fieldStone": (0.95, stoneMat(0xe2d2b4)), "capStone": (0.95, stoneMat(0xeadcc0))})   # (sun-bleached limestone: its camera side is in shade)

def stone(K, G, nm, c, size, R, mat="fieldStone"):
    """A field stone: the hull of ~12 points on a flattened ellipsoid, each pushed in or out, the whole tilted a
    little — an irregular lump, ~20 triangles. (A jittered box's 8 corners read as BRICKS — 2026-10-20.)"""
    bm = bmesh.new()
    tx, tz = R.uniform(-0.18, 0.18), R.uniform(-0.18, 0.18)   # its tilt
    vs = []
    # (points SPREAD evenly over it — a Fibonacci sphere — each pushed a little: a rounded lump; random points
    # made sharp shards, 2026-10-20)
    N = 14
    for i in range(N):
        u = 1 - 2 * (i + 0.5) / N; v = i * 2.399963 + R.uniform(-0.3, 0.3)
        r = math.sqrt(max(0.0, 1 - u * u)) * R.uniform(0.86, 1.0)
        px, py, pz = r * math.cos(v) * size[0], u * size[1] * R.uniform(0.88, 1.0), r * math.sin(v) * size[2]
        py += px * tx + pz * tz
        vs.append(bm.verts.new(B(c[0] + px, c[1] + py, c[2] + pz)))
    bmesh.ops.convex_hull(bm, input=vs)
    return K.obj(nm, bm, mat, G)

def buildWall(K, name, spec, state, seed):
    R = random.Random(seed)
    G = "h"
    top = HGT if state == "intact" else HGT if state == "damaged" else HGT * 0.5
    gap = (R.uniform(-0.4, 0.4), 0.55) if state == "damaged" else None   # (centre, half width) of the breach
    y, course, k = 0.0, 0, 0
    while y < top - 0.08:
        ch = R.uniform(0.12, 0.24)                                      # a course's height
        th = TH - (y / HGT) * 0.08                                       # the batter: thinner up
        x = -L + (0.12 if course % 2 else 0.0)
        while x < L - 0.05:
            w = R.uniform(0.14, 0.42) if R.random() < 0.8 else R.uniform(0.42, 0.6)   # (a big one now and then)
            cx = min(x + w / 2, L - 0.06)
            hole = gap and abs(cx - gap[0]) < gap[1] and y > 0.05
            ruinGone = state == "ruin" and R.random() < (0.15 + 0.5 * (y / top))
            if not hole and not ruinGone:
                for side in (-1, 1):                                     # two faces of stones, rubble between
                    stone(K, G, f"S{k}{side}", (cx + R.uniform(-0.03, 0.03), y + ch / 2, side * th * R.uniform(0.45, 0.6)), (w * 0.64, ch * 0.72, th * 0.56), R)
                k += 1
            x += w + R.uniform(0.0, 0.03)
        y += ch * 0.92
        course += 1
    # the CAPSTONES: flat stones across the top, on edge here and there
    if state == "intact" or state == "damaged":
        x = -L
        while x < L - 0.05:
            w = R.uniform(0.2, 0.32)
            cx = min(x + w / 2, L - 0.08)
            if not (gap and abs(cx - gap[0]) < gap[1]):
                stone(K, G, f"Cap{k}", (cx, top + 0.05, 0), (w / 2, R.uniform(0.05, 0.08), TH * 0.75), R, "capStone")
            k += 1
            x += w + 0.01
    # the fallen: a heap in front of the breach, or scattered both sides of a ruin
    fallen = 9 if state == "damaged" else 16 if state == "ruin" else 0
    for i in range(fallen):
        if state == "damaged":
            px, pz = gap[0] + R.uniform(-0.6, 0.6), -R.uniform(0.35, 0.9)
        else:
            px, pz = R.uniform(-L, L), R.choice((-1, 1)) * R.uniform(0.35, 1.0)
        s = R.uniform(0.08, 0.15)
        stone(K, G, f"F{i}", (px, s * 0.6, pz), (s * 1.3, s * 0.7, s), R)

TYPES = {t: dict(builder=buildWall, atlas=1024, aoDist=0.22) for t in ("a", "b", "c")}   # (the stones packed: a short AO, or every one baked black)

exported = buildKit(TYPES, MATDEF, "fieldwalls.glb", prefix="Wall", seed0=1954)
previews(TYPES, exported, prefix="Wall", tag="wall_", spacing=3.2, frame=0.16)
print("DONE")
