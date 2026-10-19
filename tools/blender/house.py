"""THE WHITEWASHED HOUSE, PILOT (2026-10-19, you, after CoH 3's North Africa: "don't you think it reads better
than the brown ones we have … would you be able to make as fine a house as this?"). A village house of the
Algerian coast and towns, late 1950s: rubble-stone walls under a LIME render, the blue band brushed round its
foot, a flat roof behind a crenellated parapet, timber joists' ends through the wall, shutters, an outside
stair to the annex's terrace, a stair hut on the roof. THREE STATES from the same description — the
groundwork of building damage (CoH's breaches and ruins):

    INTACT   as built and lived in: the roof's clutter, a rug over the parapet, jars, a bench
    DAMAGED  breached (the stone shows in every hole), crenels shot away, pocked, a shutter hanging, rubble
    RUIN     the upper storey broken off along a ragged line, the floors fallen in, rubble heaped inside and out

  "C:/Program Files/Blender Foundation/Blender 5.0/blender.exe" -b --factory-startup \
      --python tools/blender/house.py -- <out dir> [--quick]

Writes <out>/house1.glb (House_Intact, House_Damaged, House_Ruin: one object, one atlas each) — then
tools/optimizeGlb.mjs. Previews in assets-src/refs/house/. Game coordinates (x along the front, y up, FRONT at
-Z), real metres: the game draws it x1.3, its buildings' scale (games/alg-rts/algHouse.js).
"""
import bpy, sys, os, math, random
sys.path.insert(0, os.path.dirname(__file__))
import bkit
from bkit import B, srgb, NB, dust, flat, wood, paintedWood, Kit, tris

out = os.path.abspath(sys.argv[sys.argv.index("--") + 1] if "--" in sys.argv else os.path.join(bkit.ROOT, "public", "models", "alg"))
os.makedirs(out, exist_ok=True)
REFS = os.path.join(bkit.ROOT, "assets-src", "refs", "house"); os.makedirs(REFS, exist_ok=True)
QUICK = "--quick" in sys.argv
bpy.ops.object.select_all(action="SELECT"); bpy.ops.object.delete()

# ── Materials ────────────────────────────────────────────────────────────────
def render(nb):
    """Lime render over rubble stone: chalk-white, uneven; fallen off in patches (the stone under it);
    the BLUE band brushed round the foot, chipped; grey streaks down from the parapet and the sills."""
    c = nb.img("build/white_plaster_rough_01/white_plaster_rough_01_diff_1k.jpg", 0.55)
    c = nb.mix(0.55, c, srgb(0xeee7d8))
    c = nb.scale(c, nb.mr(nb.noise(0.6, 4), 0.3, 0.7, 0.86, 1.04))
    stone = nb.img("build/rabdentse_ruins_wall/rabdentse_ruins_wall_diff_1k.jpg", 0.45)
    peel = nb.mr(nb.noise(1.7, 8, 0.66, (1, 1, 1), (1.3, 0, 4.4)), 0.665, 0.69)
    c = nb.mix(peel, c, stone)
    band = nb.mr(nb.math("ADD", nb.gy, nb.math("MULTIPLY", nb.noise(6.0, 3), 0.06)), 0.97, 0.94)
    chips = nb.mr(nb.noise(9.0, 6, 0.6), 0.6, 0.64)
    blue = nb.mix(nb.noise(2.5, 3), srgb(0x2f6c9f), srgb(0x22527c))
    c = nb.mix(nb.math("MULTIPLY", band, nb.math("SUBTRACT", 1.0, chips)), c, blue)
    streak = nb.math("MULTIPLY", nb.mr(nb.noise(3.2, 5, 0.6, (9, 9, 0.45)), 0.5, 0.7), 0.45)
    c = nb.mix(streak, c, srgb(0x9a9286))
    c = nb.mix(nb.math("MULTIPLY", nb.mr(nb.point(), 0.53, 0.6), 0.35), c, srgb(0xb3a892))   # the arrises worn
    return dust(nb, c, 1.5, 1.0)
def stone(nb):
    c = nb.img("build/rabdentse_ruins_wall/rabdentse_ruins_wall_diff_1k.jpg", 0.45)
    c = nb.mix(0.25, c, srgb(0xb09a7c))
    return dust(nb, nb.scale(c, nb.mr(nb.noise(1.2, 4), 0.3, 0.7, 0.8, 1.05)), 1.2)
def rubble(nb):
    s = nb.img("build/rabdentse_ruins_wall/rabdentse_ruins_wall_diff_1k.jpg", 0.9)
    r = nb.mix(0.6, nb.img("build/white_plaster_rough_01/white_plaster_rough_01_diff_1k.jpg", 0.9), srgb(0xe0d8c8))
    c = nb.mix(nb.mr(nb.noise(3.0, 5, 0.6), 0.45, 0.55), s, r)
    return dust(nb, nb.scale(c, nb.mr(nb.island(), 0, 1, 0.7, 1.05)), 2.0, 1.2)
def rugStripes(nb):
    st = nb.math("FRACT", nb.math("MULTIPLY", nb.gx, 2.6))
    c = nb.mix(nb.mr(st, 0.33, 0.35), srgb(0x9c2a22), srgb(0x274a7a))
    c = nb.mix(nb.mr(st, 0.66, 0.68), c, srgb(0xc7952f))
    c = nb.mix(nb.math("MULTIPLY", nb.mr(nb.math("FRACT", nb.math("MULTIPLY", nb.gx, 13.0)), 0.45, 0.5), 0.35), c, srgb(0xe2d6bd))
    return dust(nb, nb.scale(c, nb.mr(nb.noise(4.0, 4), 0.3, 0.7, 0.75, 1.0)), 6.5, 0.4)
def hay(nb):
    c = nb.mix(nb.noise(18.0, 6, 0.7, (1, 1, 4)), srgb(0xc9a75c), srgb(0x8e7135))
    return dust(nb, c, 0.3)

MATDEF = {
    "render": (0.95, render), "stone": (0.95, stone), "rubble": (0.95, rubble),
    "sill": (0.9, flat(srgb(0xc9bda6))), "dark": (1.0, flat(srgb(0x1c1814), 0.0)),
    "doorBlue": (0.8, paintedWood(0x2d6497)), "shutter": (0.8, paintedWood(0x3d7f78)), "shutterBlue": (0.8, paintedWood(0x356f9e)),
    "wood": (0.9, wood()), "woodDark": (0.9, wood(0x7a6650)), "iron": (0.6, flat(srgb(0x2a2724), 0.4)),
    "jar": (0.9, flat(srgb(0xa1603d))), "basket": (0.9, wood(0xb08a55)), "hay": (1.0, hay), "rug": (0.95, rugStripes),
    "earth": (1.0, flat(srgb(0xa8875f))),
}

# ── The dimensions (real metres; front at -Z) ────────────────────────────────
X0, X1, Z0, Z1, T = -3.8, 3.8, -3.0, 3.0, 0.45       # the main block, its walls' thickness
F1, F2, ROOF, PAR = 3.1, 3.35, 6.0, 6.8               # upper floor slab (bottom, top), roof slab bottom, parapet top
AX0, AX1, AZ0, AZ1, AH, APAR = 3.8, 7.6, -0.9, 3.0, 3.3, 3.8   # the annex
DOOR = (-0.65, 0.65, 0.0, 2.35)
WIN_G = [(-3.05, -2.05), (2.05, 3.05)]               # ground-floor windows (front), y 1.0-2.15
WIN_U = [(-2.75, -1.85), (-0.45, 0.45), (1.85, 2.75)]   # upper windows (front), y 4.0-5.1

def build(K, state, seed):
    R = random.Random(seed)
    G = "h"
    dmg, ruin = state != "intact", state == "ruin"
    shells = []
    def shell(name, x0, x1, z0, z1, h, holes):
        """A rendered masonry block, hollow, its openings cut through (holes: face, a0, a1, y0, y1)."""
        o = K.box(name, x0, x1, 0.0, h, z0, z1, "render", G, 0)
        K.boolean(o, K.cutter(x0 + T, x1 - T, 0.06, h + 1, z0 + T, z1 - T, "render"))
        for f, a0, a1, y0, y1 in holes:
            if f == "f": K.boolean(o, K.cutter(a0, a1, y0, y1, z0 - 0.2, z0 + T + 0.2, "render"))
            if f == "b": K.boolean(o, K.cutter(a0, a1, y0, y1, z1 - T - 0.2, z1 + 0.2, "render"))
            if f == "l": K.boolean(o, K.cutter(x0 - 0.2, x0 + T + 0.2, y0, y1, a0, a1, "render"))
            if f == "r": K.boolean(o, K.cutter(x1 - T - 0.2, x1 + 0.2, y0, y1, a0, a1, "render"))
        shells.append(o)
        return o
    holes = [("f", *DOOR)] + [("f", a, b, 1.0, 2.15) for a, b in WIN_G] + [("f", a, b, 4.0, 5.1) for a, b in WIN_U]
    holes += [("l", -1.4, -0.5, 1.0, 2.1), ("l", 0.6, 1.5, 4.0, 5.0), ("b", -2.2, -1.3, 4.0, 5.0), ("b", 1.0, 1.9, 1.0, 2.0)]
    # the joists' holes: a row of small dark squares under the roof, front and back (CoH's houses)
    main = shell("Main", X0, X1, Z0, Z1, PAR, holes)
    K.bevel(main, 0.035, 2, 30)
    annex = shell("Annex", AX0 - T, AX1, AZ0, AZ1, APAR, [("f", 5.0, 5.95, 0.0, 2.15), ("f", 6.5, 7.1, 1.1, 1.9)])
    K.bevel(annex, 0.03, 2, 30)
    # the slabs: the upper floor, the roofs (rendered on top), set into the walls
    K.box("Floor1", X0 + T - 0.02, X1 - T + 0.02, F1, F2, Z0 + T - 0.02, Z1 - T + 0.02, "woodDark", G, 0)
    K.box("Roof", X0 + T - 0.02, X1 - T + 0.02, ROOF, ROOF + 0.24, Z0 + T - 0.02, Z1 - T + 0.02, "render", G, 0)
    K.box("RoofA", AX0, AX1 - T + 0.02, AH - 0.22, AH, AZ0 + T - 0.02, AZ1 - T + 0.02, "render", G, 0)
    K.box("Ground", X0 + T, X1 - T, 0.0, 0.06, Z0 + T, Z1 - T, "earth", G, 0)
    # COPING and CRENELS on the parapets
    for nm, (x0, x1, z0, z1, top) in (("M", (X0, X1, Z0, Z1, PAR)), ("A", (AX0, AX1, AZ0, AZ1, APAR))):
        for fa, (a0, a1, fixed, along) in (("f", (x0, x1, z0, "x")), ("b", (x0, x1, z1, "x")), ("l", (z0, z1, x0, "z")), ("r", (z0, z1, x1, "z"))):
            if nm == "A" and fa == "l": continue                      # (against the main block)
            n = max(2, int((a1 - a0) / 0.95))
            for k in range(n + 1):
                if k % 2: continue
                u = a0 + (a1 - a0) * k / n; w = 0.22
                u0, u1 = max(a0, u - w), min(a1, u + w)
                if along == "x": K.box(f"Crenel{nm}{fa}{k}", u0, u1, top, top + 0.34, fixed - 0.01 if fa == "f" else fixed - T + 0.01, fixed + T - 0.01 if fa == "f" else fixed + 0.01, "render", G, 0.02)
                else: K.box(f"Crenel{nm}{fa}{k}", fixed - 0.01 if fa == "l" else fixed - T + 0.01, fixed + T - 0.01 if fa == "l" else fixed + 0.01, top, top + 0.34, u0, u1, "render", G, 0.02)
    # the JOISTS' ENDS through the front and back walls, under the roof
    for zf, s in ((Z0, -1), (Z1, 1)):
        for k in range(9):
            x = X0 + 0.55 + k * (X1 - X0 - 1.1) / 8
            K.box(f"Joist{s}{k}", x - 0.07, x + 0.07, ROOF - 0.18, ROOF - 0.04, zf + s * 0.02 if s > 0 else zf - 0.3, zf + 0.3 if s > 0 else zf + 0.02, "woodDark", G, 0.01)
    # SILLS, the DOOR, the WINDOWS (dark inside; shutters open or closed; grilles on the ground floor)
    K.box("Step", DOOR[0] - 0.25, DOOR[1] + 0.25, 0.0, 0.18, Z0 - 0.5, Z0 + 0.02, "sill", G, 0.02)
    K.box("Step2", DOOR[0] - 0.1, DOOR[1] + 0.1, 0.18, 0.32, Z0 - 0.24, Z0 + 0.02, "sill", G, 0.02)
    K.box("Lintel", DOOR[0] - 0.12, DOOR[1] + 0.12, DOOR[3], DOOR[3] + 0.16, Z0 - 0.02, Z0 + 0.08, "woodDark", G, 0.01)
    zd = Z0 + T * 0.6
    for s, (xa, xb) in enumerate(((DOOR[0] + 0.03, -0.006), (0.006, DOOR[1] - 0.03))):
        K.box(f"Door{s}", xa, xb, 0.02, DOOR[3] - 0.03, zd, zd + 0.06, "doorBlue", G, 0.008)
        for y in (0.5, 1.2, 1.9):
            K.box(f"DoorBand{s}{y}", xa + 0.06, xb - 0.06, y - 0.04, y + 0.04, zd - 0.025, zd, "doorBlue", G, 0.005)
        for k in range(4):
            K.cyl(f"Stud{s}{k}", (xa + (xb - xa) * (0.25 + 0.5 * (k % 2)), 0.9 + (k // 2) * 0.7, zd - 0.025), 0.022, 0.0, "iron", G, 6, w=0)
    def window(nm, face, a0, a1, y0, y1, kind):
        """kind: 'open' (shutters folded back), 'shut', 'grille', 'void' (dark, nothing)."""
        sill_w = 0.08
        if face == "f":
            z = Z0; K.box(f"{nm}Sill", a0 - sill_w, a1 + sill_w, y0 - 0.06, y0 + 0.01, z - 0.08, z + 0.2, "sill", G, 0.01)
            K.box(f"{nm}Dark", a0, a1, y0, y1, z + T - 0.08, z + T - 0.04, "dark", G, 0)
            if kind == "shut":
                for s, (u0, u1) in enumerate(((a0 + 0.02, (a0 + a1) / 2 - 0.005), ((a0 + a1) / 2 + 0.005, a1 - 0.02))):
                    K.box(f"{nm}Sh{s}", u0, u1, y0 + 0.02, y1 - 0.02, z + 0.12, z + 0.16, "shutter", G, 0.006)
            if kind == "open":
                w = (a1 - a0) / 2
                for s, ue in ((-1, a0), (1, a1)):
                    u0, u1 = (ue - w - 0.03, ue - 0.03) if s < 0 else (ue + 0.03, ue + w + 0.03)
                    if dmg and s > 0 and nm == "WU2": continue    # (one torn off)
                    K.box(f"{nm}Sh{s}", u0, u1, y0 + 0.02, y1 - 0.02, z - 0.07, z - 0.03, "shutter", G, 0.006)
            if kind == "grille":
                for k in range(5):
                    u = a0 + (a1 - a0) * (k + 0.5) / 5
                    K.rod(f"{nm}Bar{k}", (u, y0 - 0.02, z + 0.08), (u, y1 + 0.02, z + 0.08), 0.012, "iron", G, 6)
        else:
            x = X0 if face == "l" else X1; sgn = -1 if face == "l" else 1
            K.box(f"{nm}Sill", x - 0.2 if sgn > 0 else x - 0.08 * 0 - 0.08, x + 0.08 if sgn > 0 else x + 0.2, y0 - 0.06, y0 + 0.01, a0 - sill_w, a1 + sill_w, "sill", G, 0.01)
            xi = x + T - 0.08 if sgn < 0 else x - T + 0.04
            K.box(f"{nm}Dark", xi, xi + 0.04, y0, y1, a0, a1, "dark", G, 0)
            if kind == "shut":
                xs = x + 0.12 if sgn < 0 else x - 0.16
                K.box(f"{nm}Sh", xs, xs + 0.04, y0 + 0.02, y1 - 0.02, a0 + 0.02, a1 - 0.02, "shutterBlue", G, 0.006)
    window("WG0", "f", *WIN_G[0], 1.0, 2.15, "grille"); window("WG1", "f", *WIN_G[1], 1.0, 2.15, "shut")
    for k, (a, b) in enumerate(WIN_U): window(f"WU{k}", "f", a, b, 4.0, 5.1, ["open", "void", "open"][k])
    window("WL0", "l", -1.4, -0.5, 1.0, 2.1, "shut"); window("WL1", "l", 0.6, 1.5, 4.0, 5.0, "void")
    K.box("ADoor", 5.03, 5.92, 0.02, 2.12, AZ0 + T * 0.6, AZ0 + T * 0.6 + 0.06, "wood", G, 0.008)
    K.box("AWinDark", 6.5, 7.1, 1.1, 1.9, AZ0 + T - 0.08, AZ0 + T - 0.04, "dark", G, 0)
    K.box("AWinSill", 6.42, 7.18, 1.04, 1.11, AZ0 - 0.08, AZ0 + 0.2, "sill", G, 0.01)
    # the OUTSIDE STAIR up the annex's end to its terrace: solid masonry, rendered
    for k in range(11):
        z = 2.75 - k * 0.32; y = (k + 1) * 0.3
        K.box(f"Stair{k}", AX1, AX1 + 0.85, 0.0, y, z - 0.32, z, "render", G, 0.015)
    K.box("StairWall", AX1 + 0.78, AX1 + 0.95, 0.0, 1.0, -0.8, 2.75, "render", G, 0.02)
    # the STAIR HUT on the main roof, its door a dark opening
    hut = K.box("Hut", 1.5, 3.3, ROOF + 0.2, ROOF + 2.4, 0.6, 2.55, "render", G, 0)
    K.boolean(hut, K.cutter(1.95, 2.75, ROOF + 0.24, ROOF + 2.1, 0.5, 0.75, "render"))
    K.bevel(hut, 0.03, 2, 30)
    K.box("HutDark", 1.95, 2.75, ROOF + 0.24, ROOF + 2.1, 0.8, 0.84, "dark", G, 0)
    K.box("HutRoof", 1.42, 3.38, ROOF + 2.4, ROOF + 2.52, 0.52, 2.63, "render", G, 0.02)
    # LIFE: the roof's clutter, the rug over the parapet, jars and a bench by the door
    if not ruin:
        K.lump("Hay", (-2.2, ROOF + 0.24, 1.6), (0.75, 0.42, 0.55), "hay", G, seed=3, rough=0.18)
        for k, (x, z) in enumerate(((-0.9, 1.9), (-0.4, 2.2))):
            K.cyl(f"Basket{k}", (x, ROOF + 0.24, z), 0.26, 0.32, "basket", G, 12, r2=0.3)
        K.cyl("RoofJar", (0.4, ROOF + 0.24, 2.3), 0.22, 0.55, "jar", G, 12, r2=0.1)
        rug = K.box("Rug", -1.6, -0.2, PAR - 1.3, PAR + 0.02, Z0 - 0.05, Z0 - 0.02, "rug", G, 0)
        K.box("RugTop", -1.6, -0.2, PAR, PAR + 0.03, Z0 - 0.05, Z0 + T, "rug", G, 0)
        for k, x in enumerate((-1.55, -1.1)):
            K.cyl(f"Jar{k}", (x, 0.0, Z0 - 0.45), 0.24 - k * 0.04, 0.62 - k * 0.1, "jar", G, 12, r2=0.11)
        K.box("Bench", 1.2, 2.6, 0.0, 0.42, Z0 - 0.48, Z0 - 0.02, "render", G, 0.03)
        for k in range(5):
            K.rod(f"Wood{k}", (AX0 + 0.3 + k * 0.05, 0.08 + (k % 2) * 0.1, AZ0 - 0.35), (AX0 + 1.2 + k * 0.05, 0.08 + (k % 2) * 0.1, AZ0 - 0.55), 0.05, "woodDark", G, 6)
    if dmg:
        # BREACHES: the stone shows on every broken face (the cutter's material); PARAPETS shot away; POCKS
        for k, (c, sz) in enumerate((((2.3, 4.5, Z0), (0.95, 0.85, 0.7)), ((X0, 1.3, -1.6), (0.7, 1.0, 0.95)),
                                      ((-2.6, PAR + 0.1, Z0), (1.2, 0.55, 0.7)), ((AX1, 2.6, 0.4), (0.7, 0.9, 0.9)))):
            cut = K.breach(c, sz, seed=seed * 7 + k, mat="stone")
            for o in shells + [o for o in K.groups[G] if o.name.startswith(("Crenel", "Joist"))]: K.boolean(o, cut)
        for k in range(14):
            x = R.uniform(X0 + 0.4, X1 - 0.4); y = R.uniform(0.8, 5.6)
            K.boolean(main, K.breach((x, y, Z0), (0.07, 0.07, 0.12), seed=seed * 13 + k, mat="stone", rough=0.3))
        # RUBBLE under the breaches; a crenel's block fallen
        for k in range(18 if not ruin else 0):
            bx, bz = R.choice(((2.3, Z0 - 0.7), (X0 - 0.8, -1.6), (-2.6, Z0 - 0.8), (AX1 + 1.2, 0.4)))
            K.lump(f"Rub{k}", (bx + R.uniform(-0.9, 0.9), 0.0, bz + R.uniform(-0.6, 0.6)), (R.uniform(0.12, 0.3), R.uniform(0.08, 0.2), R.uniform(0.12, 0.28)), "rubble", G, seed=k + seed, sub=1)
        if not ruin:
            K.lump("RubHeap", (2.3, 0.0, Z0 - 0.6), (0.9, 0.35, 0.55), "rubble", G, seed=seed + 5)
            K.lump("RubHeap2", (X0 - 0.55, 0.0, -1.6), (0.55, 0.3, 0.9), "rubble", G, seed=seed + 6)
    if ruin:
        # the upper storey broken off along a ragged line; the floors fallen in
        top = K.skyline(X0 - 1.5, AX1 + 1.5, Z0 - 1.5, Z1 + 1.5, 3.9, 1.6, seed=seed, mat="stone")
        # (2.6 x 2.0 left most of the floor standing: it read as a roofless house, not a collapse — the lab)
        hole = K.breach((-0.2, F1, 0.3), (3.3, 1.2, 2.6), seed=seed + 9, mat="stone")
        for o in list(K.groups[G]):
            K.boolean(o, top)
            if o.name.startswith("Floor1"): K.boolean(o, hole)
        cutA = K.breach((6.2, AH, 1.2), (1.6, 0.9, 1.5), seed=seed + 4, mat="stone")
        for o in list(K.groups[G]):
            if o.name.startswith(("RoofA", "Annex")): K.boolean(o, cutA)
        # what fell: a slab's end tilted down, joists, heaps inside and at the foot
        slab = K.box("Fallen", -1.8, 0.8, 0.0, 0.24, -0.6, 1.6, "woodDark", G, 0)
        slab.rotation_euler = (math.radians(12), math.radians(-25), math.radians(5)); slab.location = B(0, 1.0, 0)
        for k in range(4):
            K.rod(f"Beam{k}", (-2.5 + k * 1.3, 0.1, 1.9 - k * 0.3), (-1.2 + k * 0.9, 2.6 - k * 0.3, 0.2 + k * 0.4), 0.08, "woodDark", G, 6)
        K.lump("HeapIn", (-0.6, 0.0, 0.4), (2.4, 1.1, 1.9), "rubble", G, seed=seed + 2, rough=0.4)
        K.lump("HeapIn2", (5.8, 0.0, 1.0), (1.5, 0.8, 1.3), "rubble", G, seed=seed + 3, rough=0.4)
        for k, (c, sz) in enumerate((((2.0, 0, Z0 - 1.0), (1.6, 0.6, 0.9)), ((X0 - 1.0, 0, 0.6), (0.9, 0.5, 1.7)), ((-1.0, 0, Z1 + 0.9), (1.5, 0.45, 0.8)))):
            K.lump(f"HeapOut{k}", c, sz, "rubble", G, seed=seed + 20 + k, rough=0.45)
        for k in range(26):
            a = R.uniform(0, 6.28); r = R.uniform(4.6, 6.2)
            K.lump(f"Rub{k}", (math.cos(a) * r * 1.2 + 1.2, 0.0, math.sin(a) * r * 0.9), (R.uniform(0.12, 0.34), R.uniform(0.08, 0.22), R.uniform(0.12, 0.3)), "rubble", G, seed=k + seed, sub=1)

STATES = ("intact", "damaged", "ruin")
K = Kit(MATDEF, ("h",))
objs = []
for i, state in enumerate(STATES):
    K.groups["h"] = []
    build(K, state, 1958 + i)
    o = K.join(f"House_{state.capitalize()}", K.groups["h"])
    K.drop_cutters()
    print("TRIS", o.name, tris(o))
    objs.append(o)
S_ = 512 if QUICK else 2048
for o in objs:
    # (the other states stand at the same origin: hidden, or the AO counts them as occluders — every wall black)
    for q in objs: q.hide_render = q is not o
    K.bake(o, S_, o.name, REFS, samples_ao=16 if QUICK else 96)
for q in objs: q.hide_render = False
for i, o in enumerate(objs): o.location.x = 0      # (all at the origin: the game shows one at a time)
K.export(os.path.join(out, "house1.glb"), objs)

# ── Previews (workbench, the baked textures): each state from the RTS camera's angle ──
scn = bpy.context.scene
scn.render.engine = "BLENDER_WORKBENCH"
sh = scn.display.shading; sh.light = "STUDIO"; sh.color_type = "TEXTURE"
scn.render.resolution_x, scn.render.resolution_y = 1200, 800
cd = bpy.data.cameras.new("C"); cam = bpy.data.objects.new("C", cd); scn.collection.objects.link(cam); scn.camera = cam
def shot(name, frm, tgt, lens=40):
    cd.lens = lens; cam.location = B(*frm); cam.rotation_euler = (B(*tgt) - cam.location).to_track_quat("-Z", "Y").to_euler()
    # (not "house_intact.png": Windows ignores case — it overwrote the baked atlas House_Intact.png)
    scn.render.filepath = os.path.join(REFS, f"preview_{name}.png"); bpy.ops.render.render(write_still=True)
for o in objs: o.hide_render = True
for o in objs:
    o.hide_render = False
    shot(o.name.split("_")[1].lower(), (-14, 15, -19), (1.5, 2.5, 0))
    o.hide_render = True
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(REFS, "house1.blend"))
print("DONE")
