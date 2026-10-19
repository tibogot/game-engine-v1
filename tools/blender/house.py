"""THE WHITEWASHED HOUSES (2026-10-19, you, after CoH 3's North Africa: "it reads better than the brown ones";
the pilot then: "it looks cool — we will need some variants, different small assets on top of buildings, like
prayer rugs, pottery … optimised very well, with LOD, and LOD for the shadows too"). Village houses of the
Algerian coast and towns, late 1950s: rubble-stone walls under a LIME render, a coloured band brushed round
their foot, flat roofs behind crenellated parapets, timber joists' ends through the wall, shutters. A KIT of
house TYPES, each built from one description in THREE STATES — the groundwork of building damage:

    INTACT   as built and lived in: its roof's and doorstep's LIFE (prayer rugs, pottery, baskets, hay,
             firewood, a laundry line, a bread oven, mats, sacks — picked per type)
    DAMAGED  breached (the stone in every hole), parapets shot away, pocked, rubble at the foot
    RUIN     broken off along a ragged line, the floors / roof fallen in, rubble heaped inside and out

OPTIMISED: per type, its three states share ONE 2048 atlas (UVs packed together, baked colour x AO); each
state has a NEAR and a FAR level (decimated ~30 %, the same atlas — no new texture); the game draws the far
one from its LOD distance and in the SUN'S SHADOW (a THREE.LOD picks its level per camera: the shadow camera
is far — algHouse.js).

  "C:/Program Files/Blender Foundation/Blender 5.0/blender.exe" -b --factory-startup \
      --python tools/blender/house.py -- <out dir> [--quick] [--only maison]

Writes <out>/houses.glb (House<Type>_<State> + _Far) — then tools/optimizeGlb.mjs. Previews in
assets-src/refs/house/. Game coordinates (x along the front, y up, FRONT at -Z), real metres (the game x1.3).
"""
import bpy, sys, os, math, random
sys.path.insert(0, os.path.dirname(__file__))
import bkit
from bkit import B, srgb, dust, flat, wood, paintedWood, Kit, tris

out = os.path.abspath(sys.argv[sys.argv.index("--") + 1] if "--" in sys.argv else os.path.join(bkit.ROOT, "public", "models", "alg"))
os.makedirs(out, exist_ok=True)
REFS = os.path.join(bkit.ROOT, "assets-src", "refs", "house"); os.makedirs(REFS, exist_ok=True)
QUICK = "--quick" in sys.argv
ONLY = sys.argv[sys.argv.index("--only") + 1] if "--only" in sys.argv else None
bpy.ops.object.select_all(action="SELECT"); bpy.ops.object.delete()

# ── Materials ────────────────────────────────────────────────────────────────
def render(band, bandH=0.95):
    """Lime render over rubble stone: chalk-white, uneven; fallen off in patches (the stone under it); a
    coloured BAND brushed round the foot (`band` hex, or None), chipped; grey streaks; the arrises worn."""
    def f(nb):
        c = nb.img("build/white_plaster_rough_01/white_plaster_rough_01_diff_1k.jpg", 0.55)
        c = nb.mix(0.55, c, srgb(0xeee7d8))
        c = nb.scale(c, nb.mr(nb.noise(0.6, 4), 0.3, 0.7, 0.86, 1.04))
        stone = nb.img("build/rabdentse_ruins_wall/rabdentse_ruins_wall_diff_1k.jpg", 0.45)
        peel = nb.mr(nb.noise(1.7, 8, 0.66, (1, 1, 1), (1.3, 0, 4.4)), 0.665, 0.69)
        c = nb.mix(peel, c, stone)
        if band is not None:
            b = nb.mr(nb.math("ADD", nb.gy, nb.math("MULTIPLY", nb.noise(6.0, 3), 0.06)), bandH + 0.02, bandH - 0.01)
            chips = nb.mr(nb.noise(9.0, 6, 0.6), 0.6, 0.64)
            col = nb.mix(nb.noise(2.5, 3), srgb(band), tuple(v * 0.72 for v in srgb(band)))
            c = nb.mix(nb.math("MULTIPLY", b, nb.math("SUBTRACT", 1.0, chips)), c, col)
        streak = nb.math("MULTIPLY", nb.mr(nb.noise(3.2, 5, 0.6, (9, 9, 0.45)), 0.5, 0.7), 0.45)
        c = nb.mix(streak, c, srgb(0x9a9286))
        c = nb.mix(nb.math("MULTIPLY", nb.mr(nb.point(), 0.53, 0.6), 0.35), c, srgb(0xb3a892))
        return dust(nb, c, 1.5, 1.0)
    return f
def stone(nb):
    c = nb.img("build/rabdentse_ruins_wall/rabdentse_ruins_wall_diff_1k.jpg", 0.45)
    c = nb.mix(0.25, c, srgb(0xb09a7c))
    return dust(nb, nb.scale(c, nb.mr(nb.noise(1.2, 4), 0.3, 0.7, 0.8, 1.05)), 1.2)
def rubble(nb):
    s = nb.img("build/rabdentse_ruins_wall/rabdentse_ruins_wall_diff_1k.jpg", 0.9)
    r = nb.mix(0.6, nb.img("build/white_plaster_rough_01/white_plaster_rough_01_diff_1k.jpg", 0.9), srgb(0xe0d8c8))
    c = nb.mix(nb.mr(nb.noise(3.0, 5, 0.6), 0.45, 0.55), s, r)
    return dust(nb, nb.scale(c, nb.mr(nb.island(), 0, 1, 0.7, 1.05)), 2.0, 1.2)
def stripes(a, b, cc, freq=2.6):
    def f(nb):
        st = nb.math("FRACT", nb.math("MULTIPLY", nb.gx, freq))
        c = nb.mix(nb.mr(st, 0.33, 0.35), srgb(a), srgb(b))
        c = nb.mix(nb.mr(st, 0.66, 0.68), c, srgb(cc))
        c = nb.mix(nb.math("MULTIPLY", nb.mr(nb.math("FRACT", nb.math("MULTIPLY", nb.gx, freq * 5)), 0.45, 0.5), 0.35), c, srgb(0xe2d6bd))
        return dust(nb, nb.scale(c, nb.mr(nb.noise(4.0, 4), 0.3, 0.7, 0.75, 1.0)), 9.0, 0.4)
    return f
def prayerRug(nb):
    """A prayer rug laid out: a deep red field, a border, a lighter niche — from above it reads as a rug."""
    c = nb.mix(nb.noise(6.0, 4), srgb(0x8e1f1c), srgb(0x6f1716))
    edge = nb.math("MAXIMUM", nb.mr(nb.math("ABSOLUTE", nb.math("FRACT", nb.math("MULTIPLY", nb.gx, 1.2))), 0.88, 0.92), nb.mr(nb.math("FRACT", nb.math("MULTIPLY", nb.gz, 0.9)), 0.9, 0.94))
    c = nb.mix(edge, c, srgb(0xc89a3d))
    c = nb.mix(nb.math("MULTIPLY", nb.mr(nb.noise(14.0, 3), 0.55, 0.62), 0.5), c, srgb(0x23406b))
    return dust(nb, c, 9.0, 0.3)
def hay(nb):
    return dust(nb, nb.mix(nb.noise(18.0, 6, 0.7, (1, 1, 4)), srgb(0xc9a75c), srgb(0x8e7135)), 0.3)

MATDEF = {
    "renderBlue": (0.95, render(0x2f6c9f)), "renderOchre": (0.95, render(0xc0922f)), "renderTeal": (0.95, render(0x3d7f78)),
    "renderPlain": (0.95, render(None)), "renderGreen": (0.95, render(0x5f7d3a, 1.2)),
    "stone": (0.95, stone), "rubble": (0.95, rubble),
    "sill": (0.9, flat(srgb(0xc9bda6))), "dark": (1.0, flat(srgb(0x1c1814), 0.0)),
    "doorBlue": (0.8, paintedWood(0x2d6497)), "doorGreen": (0.8, paintedWood(0x3e6b3c)), "doorRed": (0.8, paintedWood(0x8a3b2a)),
    "shutterTeal": (0.8, paintedWood(0x3d7f78)), "shutterBlue": (0.8, paintedWood(0x356f9e)), "shutterRed": (0.8, paintedWood(0x8f4a32)),
    "shutterGreen": (0.8, paintedWood(0x4f7a46)),
    "wood": (0.9, wood()), "woodDark": (0.9, wood(0x7a6650)), "iron": (0.6, flat(srgb(0x2a2724), 0.4)),
    "jar": (0.9, flat(srgb(0xa1603d))), "jarPale": (0.9, flat(srgb(0xc4a17a))), "jarGlazed": (0.6, flat(srgb(0x2f5f6e))),
    "basket": (0.9, wood(0xb08a55)), "hay": (1.0, hay),
    "rug": (0.95, stripes(0x9c2a22, 0x274a7a, 0xc7952f)), "rug2": (0.95, stripes(0x2d5b3a, 0xb7882e, 0x7e1f2a, 3.4)),
    "prayerRug": (0.95, prayerRug), "cloth1": (0.9, flat(srgb(0xd9d2c0), 9)), "cloth2": (0.9, flat(srgb(0x4a6fa0), 9)),
    "cloth3": (0.9, flat(srgb(0xa8462f), 9)), "canvas": (0.9, flat(srgb(0xb3a079), 9)), "sack": (0.95, flat(srgb(0xa58f69))),
    "earth": (1.0, flat(srgb(0xa8875f))), "oven": (1.0, flat(srgb(0xb08a63))),
}

# ── THE TYPES (real metres; front at -Z) ─────────────────────────────────────
#   main: x0 x1 z0 z1, floors [slab bottoms], roof (slab bottom), par (parapet top); annex (x0 x1 z0 z1 h par)
#   door: (a0, a1, mat); wins: (face, a0, a1, y0, y1, kind); dmg: breaches ((c), (half-size)); ruin: (h, amp)
T = 0.45
TYPES = {
    # the pilot: two storeys + an annex with its terrace and outside stair, a roof hut
    "maison": dict(render="renderBlue", shutter="shutterTeal", door=(-0.65, 0.65, "doorBlue"),
        main=(-3.8, 3.8, -3.0, 3.0), floors=[3.1], roof=6.0, par=6.8, annex=(3.8, 7.6, -0.9, 3.0, 3.3, 3.8), stair=True, hut=(1.5, 3.3, 0.6, 2.55),
        wins=[("f", -3.05, -2.05, 1.0, 2.15, "grille"), ("f", 2.05, 3.05, 1.0, 2.15, "shut"), ("f", -2.75, -1.85, 4.0, 5.1, "open"),
              ("f", -0.45, 0.45, 4.0, 5.1, "void"), ("f", 1.85, 2.75, 4.0, 5.1, "open"), ("l", -1.4, -0.5, 1.0, 2.1, "shut"),
              ("l", 0.6, 1.5, 4.0, 5.0, "void"), ("b", -2.2, -1.3, 4.0, 5.0, "shut"), ("b", 1.0, 1.9, 1.0, 2.0, "void")],
        annexWins=[("f", 6.5, 7.1, 1.1, 1.9, "void")], annexDoor=(5.0, 5.95),
        dmg=[((2.3, 4.5, -3.0), (0.95, 0.85, 0.7)), ((-3.8, 1.3, -1.6), (0.7, 1.0, 0.95)), ((-2.6, 6.9, -3.0), (1.2, 0.55, 0.7)), ((7.6, 2.6, 0.4), (0.7, 0.9, 0.9))],
        ruin=(3.9, 1.6), life=["rug", "hay", "pottery", "baskets", "prayer"], ground=["jars", "bench", "firewood"]),
    # one storey round a walled COURTYARD (its gate on the front), a laundry line on the roof
    "cour": dict(render="renderOchre", shutter="shutterBlue", door=(-2.2, -1.2, "doorGreen"),
        main=(-3.4, 3.4, 0.0, 5.0), floors=[], roof=3.2, par=3.9, court=(-3.4, 3.4, -4.2, 0.0, 2.3, (0.6, 2.0)),
        wins=[("f", 0.4, 1.3, 1.0, 2.0, "shut"), ("f", 2.0, 2.8, 1.0, 2.0, "grille"), ("l", 1.5, 2.4, 1.0, 2.0, "void"), ("r", 2.0, 2.9, 1.0, 2.0, "shut")],
        dmg=[((1.5, 1.6, 0.0), (0.8, 0.9, 0.7)), ((-3.4, 2.4, -2.0), (0.6, 0.8, 1.1)), ((2.0, 3.9, 5.0), (1.1, 0.5, 0.7))],
        ruin=(1.9, 0.9), life=["laundry", "oven", "pottery", "mats"], ground=["jars", "sacks", "firewood"]),
    # tall and narrow: two storeys, a timber BALCONY on the upper front, a roof hut
    "haute": dict(render="renderTeal", shutter="shutterRed", door=(-0.5, 0.5, "doorRed"),
        main=(-2.6, 2.6, -2.8, 2.8), floors=[3.1], roof=6.1, par=6.9, hut=(0.2, 2.0, 0.3, 2.2), balcony=(-1.6, 1.6),
        wins=[("f", -2.0, -1.2, 1.0, 2.1, "grille"), ("f", -0.55, 0.55, 3.4, 5.4, "door"), ("f", 1.3, 2.0, 4.0, 5.0, "shut"),
              ("l", -1.0, -0.1, 4.0, 5.0, "open"), ("r", 0.2, 1.1, 1.0, 2.0, "shut"), ("b", -0.9, 0.0, 4.0, 5.0, "void")],
        dmg=[((-1.6, 4.4, -2.8), (0.8, 0.9, 0.7)), ((2.6, 1.6, -1.0), (0.6, 0.9, 0.9)), ((1.4, 7.0, -2.8), (1.0, 0.55, 0.7))],
        ruin=(3.6, 1.5), life=["prayer", "pottery", "baskets", "barrel"], ground=["jars", "bench"]),
    # long and low: a SHOP — two doors, a canvas AWNING over one, crates of pots out front
    "boutique": dict(render="renderGreen", shutter="shutterGreen", door=(-3.2, -2.1, "doorBlue"),
        main=(-4.6, 4.6, -2.6, 2.6), floors=[], roof=3.4, par=4.0, door2=(0.6, 2.2), awning=(0.2, 2.6),
        wins=[("f", -1.4, -0.6, 1.1, 2.1, "shut"), ("f", 3.2, 4.0, 1.1, 2.1, "grille"), ("l", -0.5, 0.4, 1.1, 2.0, "void"), ("b", -2.0, -1.1, 1.1, 2.0, "shut")],
        dmg=[((-2.4, 1.8, -2.6), (0.9, 0.9, 0.7)), ((4.6, 1.2, 0.5), (0.6, 0.9, 1.0)), ((0.6, 4.1, -2.6), (1.4, 0.5, 0.7))],
        ruin=(2.0, 1.0), life=["rug2", "mats", "pottery", "hay"], ground=["potsForSale", "sacks", "bench"]),
}

def build(K, name, spec, state, seed):
    R = random.Random(seed)
    G = "h"
    dmg, ruin = state != "intact", state == "ruin"
    REND = spec["render"]
    X0, X1, Z0, Z1 = spec["main"]; PAR = spec["par"]; ROOF = spec["roof"]
    shells = []
    def shell(nm, x0, x1, z0, z1, h, holes, mat):
        o = K.box(nm, x0, x1, 0.0, h, z0, z1, mat, G, 0)
        K.boolean(o, K.cutter(x0 + T, x1 - T, 0.06, h + 1, z0 + T, z1 - T, mat))
        for f, a0, a1, y0, y1 in holes:
            if f == "f": K.boolean(o, K.cutter(a0, a1, y0, y1, z0 - 0.2, z0 + T + 0.2, mat))
            if f == "b": K.boolean(o, K.cutter(a0, a1, y0, y1, z1 - T - 0.2, z1 + 0.2, mat))
            if f == "l": K.boolean(o, K.cutter(x0 - 0.2, x0 + T + 0.2, y0, y1, a0, a1, mat))
            if f == "r": K.boolean(o, K.cutter(x1 - T - 0.2, x1 + 0.2, y0, y1, a0, a1, mat))
        K.bevel(o, 0.035, 2, 30)
        shells.append(o)
        return o
    d0, d1, dmat = spec["door"]
    holes = [("f", d0, d1, 0.0, 2.3)] + [(w[0], w[1], w[2], w[3], w[4]) for w in spec["wins"]]
    if "door2" in spec: holes.append(("f", spec["door2"][0], spec["door2"][1], 0.0, 2.3))
    shell("Main", X0, X1, Z0, Z1, PAR, holes, REND)
    rects = [(X0, X1, Z0, Z1, PAR, False)]
    for k, fy in enumerate(spec["floors"]):
        K.box(f"Floor{k}", X0 + T - 0.02, X1 - T + 0.02, fy, fy + 0.25, Z0 + T - 0.02, Z1 - T + 0.02, "woodDark", G, 0)
    K.box("Roof", X0 + T - 0.02, X1 - T + 0.02, ROOF, ROOF + 0.24, Z0 + T - 0.02, Z1 - T + 0.02, REND, G, 0)
    K.box("Ground", X0 + T, X1 - T, 0.0, 0.06, Z0 + T, Z1 - T, "earth", G, 0)
    if "annex" in spec:
        ax0, ax1, az0, az1, ah, apar = spec["annex"]
        holes_a = [("f", spec["annexDoor"][0], spec["annexDoor"][1], 0.0, 2.15)] + [(w[0], w[1], w[2], w[3], w[4]) for w in spec.get("annexWins", [])]
        shell("Annex", ax0 - T, ax1, az0, az1, apar, holes_a, REND)
        K.box("RoofA", ax0, ax1 - T + 0.02, ah - 0.22, ah, az0 + T - 0.02, az1 - T + 0.02, REND, G, 0)
        rects.append((ax0, ax1, az0, az1, apar, True))
    if "court" in spec:
        cx0, cx1, cz0, cz1, ch, (g0, g1) = spec["court"]
        wall = K.box("Court", cx0, cx1, 0.0, ch, cz0, cz1 + 0.1, REND, G, 0)
        K.boolean(wall, K.cutter(cx0 + 0.4, cx1 - 0.4, -0.1, ch + 1, cz0 + 0.4, cz1 + 0.5, REND))
        K.boolean(wall, K.cutter(g0, g1, 0.0, 2.0, cz0 - 0.2, cz0 + 0.6, REND))
        K.bevel(wall, 0.03, 2, 30); shells.append(wall)
        K.box("CourtCoping", cx0 - 0.03, cx1 + 0.03, ch, ch + 0.08, cz0 - 0.03, cz0 + 0.43, "sill", G, 0.015)
        K.box("Gate", g0 + 0.03, g1 - 0.03, 0.02, 1.95, cz0 + 0.15, cz0 + 0.2, dmat, G, 0.006)
        K.box("CourtFloor", cx0 + 0.4, cx1 - 0.4, 0.0, 0.04, cz0 + 0.4, cz1, "earth", G, 0)
    # COPING + CRENELS on every parapet (not on an annex's side against the main block)
    for ri, (x0, x1, z0, z1, top, isAnnex) in enumerate(rects):
        for fa, (a0, a1, fixed, along) in (("f", (x0, x1, z0, "x")), ("b", (x0, x1, z1, "x")), ("l", (z0, z1, x0, "z")), ("r", (z0, z1, x1, "z"))):
            if isAnnex and fa == "l": continue
            n = max(2, int((a1 - a0) / 0.95))
            for k in range(0, n + 1, 2):
                u = a0 + (a1 - a0) * k / n; u0, u1 = max(a0, u - 0.22), min(a1, u + 0.22)
                if along == "x": K.box(f"Crenel{ri}{fa}{k}", u0, u1, top, top + 0.34, fixed - 0.01 if fa == "f" else fixed - T + 0.01, fixed + T - 0.01 if fa == "f" else fixed + 0.01, REND, G, 0.02)
                else: K.box(f"Crenel{ri}{fa}{k}", fixed - 0.01 if fa == "l" else fixed - T + 0.01, fixed + T - 0.01 if fa == "l" else fixed + 0.01, top, top + 0.34, u0, u1, REND, G, 0.02)
    # the JOISTS' ENDS through the front and back walls
    nj = max(4, int((X1 - X0) / 0.85))
    for zf, s in ((Z0, -1), (Z1, 1)):
        for k in range(nj + 1):
            x = X0 + 0.55 + k * (X1 - X0 - 1.1) / nj
            K.box(f"Joist{s}{k}", x - 0.07, x + 0.07, ROOF - 0.18, ROOF - 0.04, zf + 0.02 if s > 0 else zf - 0.3, zf + 0.3 if s > 0 else zf + 0.02, "woodDark", G, 0.01)
    # the DOOR(s)
    def door(a0, a1, mat):
        K.box(f"Step{a0}", a0 - 0.25, a1 + 0.25, 0.0, 0.18, Z0 - 0.5, Z0 + 0.02, "sill", G, 0.02)
        K.box(f"Lintel{a0}", a0 - 0.12, a1 + 0.12, 2.3, 2.46, Z0 - 0.02, Z0 + 0.08, "woodDark", G, 0.01)
        zd = Z0 + T * 0.6; mid = (a0 + a1) / 2
        for s, (xa, xb) in enumerate(((a0 + 0.03, mid - 0.006), (mid + 0.006, a1 - 0.03))):
            K.box(f"Door{a0}{s}", xa, xb, 0.02, 2.27, zd, zd + 0.06, mat, G, 0.008)
            for y in (0.5, 1.2, 1.9): K.box(f"DoorBand{a0}{s}{y}", xa + 0.06, xb - 0.06, y - 0.04, y + 0.04, zd - 0.025, zd, mat, G, 0.005)
    door(d0, d1, dmat)
    if "door2" in spec: door(spec["door2"][0], spec["door2"][1], "doorGreen")
    # the WINDOWS (dark inside; shutters open / shut; grilles; a balcony door)
    SH = spec["shutter"]
    def window(nm, face, a0, a1, y0, y1, kind, x0=X0, x1=X1, z0=Z0, z1=Z1):
        if face in ("f", "b"):
            z = z0 if face == "f" else z1; sg = -1 if face == "f" else 1
            K.box(f"{nm}Sill", a0 - 0.08, a1 + 0.08, y0 - 0.06, y0 + 0.01, min(z - sg * 0.08, z + sg * 0.2), max(z - sg * 0.08, z + sg * 0.2), "sill", G, 0.01)
            zi = z - sg * (T - 0.08)
            K.box(f"{nm}Dark", a0, a1, y0, y1, min(zi, zi - sg * 0.04), max(zi, zi - sg * 0.04), "dark", G, 0)
            if kind == "shut" or kind == "door":
                zs = z - sg * 0.12
                for s, (u0, u1) in enumerate(((a0 + 0.02, (a0 + a1) / 2 - 0.005), ((a0 + a1) / 2 + 0.005, a1 - 0.02))):
                    K.box(f"{nm}Sh{s}", u0, u1, y0 + 0.02, y1 - 0.02, min(zs, zs - sg * 0.04), max(zs, zs - sg * 0.04), SH, G, 0.006)
            if kind == "open" and face == "f" and not (dmg and nm.endswith("2")):
                w = (a1 - a0) / 2
                for s, ue in ((-1, a0), (1, a1)):
                    u0, u1 = (ue - w - 0.03, ue - 0.03) if s < 0 else (ue + 0.03, ue + w + 0.03)
                    K.box(f"{nm}Op{s}", u0, u1, y0 + 0.02, y1 - 0.02, z - 0.07, z - 0.03, SH, G, 0.006)
            if kind == "grille":
                zb = z - sg * 0.08
                for k in range(5):
                    u = a0 + (a1 - a0) * (k + 0.5) / 5
                    K.rod(f"{nm}Bar{k}", (u, y0 - 0.02, zb), (u, y1 + 0.02, zb), 0.012, "iron", G, 6)
        else:
            x = x0 if face == "l" else x1; sg = -1 if face == "l" else 1
            K.box(f"{nm}Sill", min(x + sg * 0.08 * -1, x + sg * 0.2), max(x + sg * 0.08 * -1, x + sg * 0.2), y0 - 0.06, y0 + 0.01, a0 - 0.08, a1 + 0.08, "sill", G, 0.01)
            xi = x - sg * (T - 0.08)
            K.box(f"{nm}Dark", min(xi, xi - sg * 0.04), max(xi, xi - sg * 0.04), y0, y1, a0, a1, "dark", G, 0)
            if kind in ("shut", "open"):
                xs = x - sg * 0.12
                K.box(f"{nm}Sh", min(xs, xs - sg * 0.04), max(xs, xs - sg * 0.04), y0 + 0.02, y1 - 0.02, a0 + 0.02, a1 - 0.02, SH, G, 0.006)
    for k, w in enumerate(spec["wins"]): window(f"W{k}", *w)
    if "annex" in spec:
        ax0, ax1, az0, az1, ah, apar = spec["annex"]
        a0, a1 = spec["annexDoor"]
        K.box("ADoor", a0 + 0.03, a1 - 0.03, 0.02, 2.12, az0 + T * 0.6, az0 + T * 0.6 + 0.06, "wood", G, 0.008)
        for k, w in enumerate(spec.get("annexWins", [])): window(f"AW{k}", *w, x0=ax0 - T, x1=ax1, z0=az0, z1=az1)
        if spec.get("stair"):
            for k in range(11):
                z = az1 - 0.25 - k * 0.32; y = (k + 1) * 0.3
                K.box(f"Stair{k}", ax1, ax1 + 0.85, 0.0, y, z - 0.32, z, REND, G, 0.015)
            K.box("StairWall", ax1 + 0.78, ax1 + 0.95, 0.0, 1.0, az0 + 0.1, az1 - 0.25, REND, G, 0.02)
    if "hut" in spec:
        hx0, hx1, hz0, hz1 = spec["hut"]
        hut = K.box("Hut", hx0, hx1, ROOF + 0.2, ROOF + 2.4, hz0, hz1, REND, G, 0)
        hm = (hx0 + hx1) / 2
        K.boolean(hut, K.cutter(hm - 0.4, hm + 0.4, ROOF + 0.24, ROOF + 2.1, hz0 - 0.1, hz0 + 0.15, REND))
        K.bevel(hut, 0.03, 2, 30); shells.append(hut)
        K.box("HutDark", hm - 0.4, hm + 0.4, ROOF + 0.24, ROOF + 2.1, hz0 + 0.2, hz0 + 0.24, "dark", G, 0)
        K.box("HutRoof", hx0 - 0.08, hx1 + 0.08, ROOF + 2.4, ROOF + 2.52, hz0 - 0.08, hz1 + 0.08, REND, G, 0.02)
    if "balcony" in spec:
        b0, b1 = spec["balcony"]
        K.box("Balcony", b0, b1, 3.3, 3.42, Z0 - 0.9, Z0 + 0.05, "woodDark", G, 0.01)
        for k in range(9):
            x = b0 + 0.05 + k * (b1 - b0 - 0.1) / 8
            K.box(f"BalPost{k}", x - 0.03, x + 0.03, 3.42, 4.35, Z0 - 0.88, Z0 - 0.82, "wood", G, 0.004)
        K.box("BalRail", b0, b1, 4.3, 4.38, Z0 - 0.9, Z0 - 0.8, "wood", G, 0.006)
        for x in (b0 + 0.1, b1 - 0.1): K.rod(f"Brace{x}", (x, 2.5, Z0 + 0.02), (x, 3.32, Z0 - 0.75), 0.05, "woodDark", G, 6)
    if "awning" in spec:
        a0, a1 = spec["awning"]
        K.box("Awning", a0, a1, 2.55, 2.6, Z0 - 1.5, Z0 + 0.02, "canvas", G, 0)
        for x in (a0 + 0.08, a1 - 0.08): K.rod(f"AwnPole{x}", (x, 0.0, Z0 - 1.45), (x, 2.55, Z0 - 1.45), 0.035, "woodDark", G, 6)
    # LIFE on the roof and at the door
    if not ruin:
        roofLife(K, R, X0 + T + 0.3, X1 - T - 0.3, Z0 + T + 0.3, Z1 - T - 0.3, ROOF + 0.24, spec["life"], spec.get("hut"), PAR, Z0)
        groundLife(K, R, spec, Z0)
    if dmg:
        for k, (c, sz) in enumerate(spec["dmg"]):
            cut = K.breach(c, sz, seed=seed * 7 + k, mat="stone")
            for o in shells + [o for o in K.groups[G] if o.name.startswith(("Crenel", "Joist", "Floor", "Roof", "Hut", "Balcony", "BalPost", "BalRail"))]: K.boolean(o, cut)
        for k in range(12):
            x = R.uniform(X0 + 0.4, X1 - 0.4); y = R.uniform(0.8, min(PAR - 1.0, 5.6))
            K.boolean(shells[0], K.breach((x, y, Z0), (0.07, 0.07, 0.12), seed=seed * 13 + k, mat="stone", rough=0.3))
        if not ruin:
            for k, (c, sz) in enumerate(spec["dmg"]):
                gx, gz = c[0], c[2]
                gz = gz - 0.6 if abs(gz - Z0) < 0.01 else gz; gx = gx - 0.6 if abs(gx - X0) < 0.01 else (gx + 0.6 if gx >= X1 - 0.01 else gx)
                K.lump(f"RubHeap{k}", (gx, 0.0, gz), (0.8, 0.3, 0.55), "rubble", G, seed=seed + 5 + k)
                for j in range(5):
                    K.lump(f"Rub{k}{j}", (gx + R.uniform(-1.0, 1.0), 0.0, gz + R.uniform(-0.6, 0.6)), (R.uniform(0.12, 0.3), R.uniform(0.08, 0.2), R.uniform(0.12, 0.28)), "rubble", G, seed=seed + k * 9 + j, sub=1)
    if ruin:
        h, amp = spec["ruin"]
        ax1 = spec["annex"][1] if "annex" in spec else X1
        top = K.skyline(X0 - 1.5, ax1 + 1.5, Z0 - 5.0, Z1 + 1.5, h, amp, seed=seed, mat="stone")
        for o in list(K.groups[G]): K.boolean(o, top)
        cx, cz = (X0 + X1) / 2, (Z0 + Z1) / 2
        if spec["floors"]:
            hole = K.breach((cx + 0.3, spec["floors"][0], cz + 0.3), ((X1 - X0) * 0.43, 1.2, (Z1 - Z0) * 0.43), seed=seed + 9, mat="stone")
            for o in list(K.groups[G]):
                if o.name.startswith("Floor"): K.boolean(o, hole)
        slab = K.box("Fallen", cx - 1.3, cx + 1.3, 0.0, 0.24, cz - 1.0, cz + 1.0, "woodDark", G, 0)
        slab.rotation_euler = (math.radians(12), math.radians(-25), math.radians(5)); slab.location = B(0, 1.0, 0)
        for k in range(4):
            K.rod(f"Beam{k}", (X0 + 1.2 + k * 1.2, 0.1, Z1 - 1.0 - k * 0.3), (X0 + 2.4 + k * 0.9, h - 1.2 - k * 0.2, cz - 0.8 + k * 0.4), 0.08, "woodDark", G, 6)
        K.lump("HeapIn", (cx, 0.0, cz), ((X1 - X0) * 0.32, 1.0, (Z1 - Z0) * 0.32), "rubble", G, seed=seed + 2, rough=0.4)
        for k, (c, sz) in enumerate((((X1 - 1.5, 0, Z0 - 1.0), (1.5, 0.55, 0.85)), ((X0 - 0.9, 0, cz), (0.85, 0.5, 1.6)), ((cx, 0, Z1 + 0.9), (1.4, 0.45, 0.8)))):
            K.lump(f"HeapOut{k}", c, sz, "rubble", G, seed=seed + 20 + k, rough=0.45)
        rx = (X1 - X0) / 2 + 2.0; rz = (Z1 - Z0) / 2 + 2.0
        for k in range(22):
            a = R.uniform(0, 6.28)
            K.lump(f"Rub{k}", (cx + math.cos(a) * rx * R.uniform(0.8, 1.15), 0.0, cz + math.sin(a) * rz * R.uniform(0.8, 1.15)), (R.uniform(0.12, 0.34), R.uniform(0.08, 0.22), R.uniform(0.12, 0.3)), "rubble", G, seed=k + seed, sub=1)

# ── LIFE: the small things a house lives with (picked per type) ───────────────
def roofLife(K, R, x0, x1, z0, z1, y, kinds, hut, par, zFront):
    G = "h"
    taken = []
    def spot(w, d):
        for _ in range(40):
            x = R.uniform(x0 + w, x1 - w); z = R.uniform(z0 + d, z1 - d)
            if hut and hut[0] - w - 0.2 < x < hut[1] + w + 0.2 and hut[2] - d - 0.2 < z < hut[3] + d + 0.2: continue
            if all(abs(x - a) > w + aw + 0.15 or abs(z - b) > d + ad + 0.15 for a, b, aw, ad in taken):
                taken.append((x, z, w, d)); return x, z
        return None
    for kind in kinds:
        if kind in ("rug", "rug2"):                       # over the front parapet, airing
            x = R.uniform(x0 + 1.0, x1 - 1.0)
            K.box(f"RugF{x:.1f}", x - 0.7, x + 0.7, par - 1.3, par + 0.02, zFront - 0.05, zFront - 0.02, kind, G, 0)
            K.box(f"RugT{x:.1f}", x - 0.7, x + 0.7, par, par + 0.03, zFront - 0.05, zFront + T, kind, G, 0)
        elif kind == "prayer":                            # laid out on the roof, toward Mecca (east-ish)
            p = spot(0.4, 0.65)
            if p: K.box(f"Prayer{p[0]:.1f}", p[0] - 0.36, p[0] + 0.36, y, y + 0.015, p[1] - 0.6, p[1] + 0.6, "prayerRug", G, 0)
        elif kind == "hay":
            p = spot(0.75, 0.55)
            if p: K.lump(f"Hay{p[0]:.1f}", (p[0], y, p[1]), (0.7, 0.42, 0.5), "hay", G, seed=R.randint(0, 99), rough=0.18)
        elif kind == "pottery":                           # amphorae, pots and a glazed jug in a huddle
            p = spot(0.6, 0.5)
            if not p: continue
            for k in range(R.randint(3, 5)):
                px, pz = p[0] + R.uniform(-0.45, 0.45), p[1] + R.uniform(-0.35, 0.35); m = R.choice(("jar", "jar", "jarPale", "jarGlazed"))
                if R.random() < 0.5: K.cyl(f"Amph{px:.2f}", (px, y, pz), 0.17, 0.55, m, G, 10, r2=0.07)
                else: K.lump(f"Pot{px:.2f}", (px, y, pz), (0.2, 0.26, 0.2), m, G, seed=k, rough=0.05)
        elif kind == "baskets":
            p = spot(0.55, 0.4)
            if p:
                for k in range(2): K.cyl(f"Basket{p[0]:.1f}{k}", (p[0] + k * 0.5 - 0.25, y, p[1] + R.uniform(-0.15, 0.15)), 0.24, 0.3, "basket", G, 12, r2=0.28)
        elif kind == "laundry":                           # a line across the roof, three cloths
            za = R.uniform(z0 + 0.6, z1 - 0.6)
            K.rod(f"LinePostA{za:.1f}", (x0 + 0.3, y, za), (x0 + 0.3, y + 1.7, za), 0.03, "woodDark", G, 6)
            K.rod(f"LinePostB{za:.1f}", (x1 - 0.3, y, za), (x1 - 0.3, y + 1.7, za), 0.03, "woodDark", G, 6)
            K.rod(f"Line{za:.1f}", (x0 + 0.3, y + 1.65, za), (x1 - 0.3, y + 1.65, za), 0.006, "iron", G, 4)
            for k, m in enumerate(("cloth1", "cloth2", "cloth3", "cloth1")):
                cx = x0 + 0.9 + k * (x1 - x0 - 1.8) / 3
                K.box(f"Cloth{k}{za:.1f}", cx - 0.35, cx + 0.35, y + 0.95 + R.uniform(0, 0.2), y + 1.64, za - 0.01, za + 0.01, m, G, 0)
        elif kind == "oven":                              # the bread oven (tabouna): a clay dome, its mouth
            p = spot(0.6, 0.6)
            if p:
                K.lump(f"Oven{p[0]:.1f}", (p[0], y, p[1]), (0.55, 0.6, 0.55), "oven", G, seed=7, rough=0.08)
                K.box(f"OvenMouth{p[0]:.1f}", p[0] - 0.15, p[0] + 0.15, y + 0.05, y + 0.32, p[1] - 0.56, p[1] - 0.5, "dark", G, 0)
        elif kind == "mats":                              # reed mats rolled up
            p = spot(0.6, 0.3)
            if p:
                for k in range(2): K.rod(f"Mat{p[0]:.1f}{k}", (p[0] - 0.55, y + 0.11, p[1] + k * 0.24), (p[0] + 0.55, y + 0.11, p[1] + k * 0.24), 0.11, "basket", G, 8)
        elif kind == "barrel":
            p = spot(0.35, 0.35)
            if p: K.cyl(f"Barrel{p[0]:.1f}", (p[0], y, p[1]), 0.3, 0.85, "shutterBlue", G, 12)
def groundLife(K, R, spec, Z0):
    G = "h"
    X0, X1 = spec["main"][0], spec["main"][1]
    d0 = spec["door"][0]
    for kind in spec["ground"]:
        if kind == "jars":
            for k in range(2): K.cyl(f"GJar{k}", (d0 - 0.6 - k * 0.42, 0.0, Z0 - 0.45), 0.24 - k * 0.04, 0.62 - k * 0.1, "jar", G, 12, r2=0.11)
        elif kind == "bench":
            x = X1 - 1.9 if X1 - 1.9 > spec["door"][1] + 0.5 else X0 + 0.5
            K.box("Bench", x, x + 1.3, 0.0, 0.42, Z0 - 0.48, Z0 - 0.02, spec["render"], G, 0.03)
        elif kind == "firewood":
            for k in range(5): K.rod(f"Wood{k}", (X1 - 1.4 + k * 0.05, 0.08 + (k % 2) * 0.1, Z0 - 0.4), (X1 - 0.5 + k * 0.05, 0.08 + (k % 2) * 0.1, Z0 - 0.62), 0.05, "woodDark", G, 6)
        elif kind == "sacks":
            for k in range(3): K.lump(f"Sack{k}", (X0 + 0.7 + k * 0.5, 0.0, Z0 - 0.45), (0.24, 0.3, 0.2), "sack", G, seed=k + 3, rough=0.12)
        elif kind == "potsForSale":                       # the shop's wares under the awning
            a0, a1 = spec["awning"]
            for k in range(7):
                x = a0 + 0.3 + k * (a1 - a0 - 0.6) / 6
                m = ("jar", "jarPale", "jarGlazed")[k % 3]
                if k % 2: K.cyl(f"Ware{k}", (x, 0.0, Z0 - 0.9), 0.17, 0.5, m, G, 10, r2=0.06)
                else: K.lump(f"Ware{k}", (x, 0.0, Z0 - 0.9), (0.2, 0.24, 0.2), m, G, seed=k, rough=0.05)

# ── Build, bake (three states, one atlas a type), far levels, export ──────────
STATES = ("intact", "damaged", "ruin")
K = Kit(MATDEF, ("h",))
exported = []
S_ = 512 if QUICK else 2048
for ti, (tname, spec) in enumerate(TYPES.items()):
    if ONLY and tname != ONLY: continue
    objs = []
    for si, state in enumerate(STATES):
        K.groups["h"] = []
        build(K, tname, spec, state, 1958 + ti * 10 + si)
        o = K.join(f"House{tname.capitalize()}_{state.capitalize()}", K.groups["h"])
        K.drop_cutters()
        objs.append(o)
    K.bake(objs, S_, f"House{tname.capitalize()}", REFS, samples_ao=16 if QUICK else 80)
    for o in objs:
        f = K.far(o, 0.3)
        print("TRIS", o.name, tris(o), "far", tris(f))
        exported += [o, f]
K.export(os.path.join(out, "houses.glb"), exported)

# ── Previews (workbench, the baked textures): each type's states side by side ──
scn = bpy.context.scene
scn.render.engine = "BLENDER_WORKBENCH"
sh = scn.display.shading; sh.light = "STUDIO"; sh.color_type = "TEXTURE"
scn.render.resolution_x, scn.render.resolution_y = 1500, 700
cd = bpy.data.cameras.new("C"); cam = bpy.data.objects.new("C", cd); scn.collection.objects.link(cam); scn.camera = cam
for o in scn.objects:
    if o.type == "MESH": o.hide_render = True
names = [o.name for o in exported if not o.name.endswith("_Far")]
for tname in TYPES:
    row = [n for n in names if n.startswith(f"House{tname.capitalize()}_")]
    if not row: continue
    for i, n in enumerate(row):
        o = bpy.data.objects[n]; o.hide_render = False; o.location.x = i * 16
    cd.lens = 40; cam.location = B(-6, 22, -28); cam.rotation_euler = (B(16, 2, 0) - cam.location).to_track_quat("-Z", "Y").to_euler()
    scn.render.filepath = os.path.join(REFS, f"preview_{tname}.png"); bpy.ops.render.render(write_still=True)
    for n in row:
        o = bpy.data.objects[n]; o.hide_render = True; o.location.x = 0
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(REFS, "houses.blend"))
print("DONE")
