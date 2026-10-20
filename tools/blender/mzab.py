"""THE M'ZAB TOWN HOUSES (2026-10-19, the Oued Abdi's town — games/alg-rts/AURES2_PLAN.md, the look from your
photos in assets-src/refs/algeria_town/: Ghardaïa's ochre houses packed up the knoll, the souk's arcades).
The old Ksar el Hamra's earth-and-ochre spirit, built to the new standard: the SAME builder as the whitewashed
kit (house.py: one description, three states — intact / damaged / ruin — one atlas a type, a far level), with
the M'zab's own features:

    EARTH RENDER   smooth mud render in a mixed palette (ochre, sand, pink earth, a pale blue lime wash),
                   fallen off in patches (the older coat under it, the mud brick in the holes), a dirty foot
    PARAPETS       plain, a pointed HORN at every corner; split palm-trunk WATER SPOUTS out at roof level
    WINDOWS        few and small, timber shutters
    LOGGIA         the roof gallery of arches on the terrace (the M'zab house's upper floor)
    ARCADE         the souk's shop row: a portico of round arches before its doors

  "C:/Program Files/Blender Foundation/Blender 5.0/blender.exe" -b --factory-startup \\
      --python tools/blender/mzab.py -- <out dir> [--quick] [--only dar]

Writes <out>/mzab.glb (Mzab<Type>_<State> + _Far) — then tools/optimizeGlb.mjs. Previews in
assets-src/refs/house/preview_mzab_<type>.png. Game coordinates, real metres (the game x1.3).
"""
import sys, os
sys.path.insert(0, os.path.dirname(__file__))
import bpy
import house
from house import buildKit, previews, REFS
from bkit import srgb, dust, flat, wood, paintedWood

# ── Materials ────────────────────────────────────────────────────────────────
def earth(tint, older):
    """Mud render: the clay plaster photo in the house's colour, mottled; fallen off in PATCHES — the older
    coat under it (`older`, the photo's pinker patches) and, at their hearts, the mud brick; a dirty FOOT
    (splash and damp to ~0.7 m); grey streaks under the parapet (the spouts' runs)."""
    def f(nb):
        c = nb.img("build/clay_plaster/clay_plaster_diff_1k.jpg", 0.4)
        c = nb.mix(0.78, c, srgb(tint))   # (0.62: the plaster photo's own pale beige won — every house read as pale sand)
        c = nb.scale(c, nb.mr(nb.noise(0.45, 4), 0.3, 0.7, 0.88, 1.05))
        coat = nb.mr(nb.noise(0.9, 6, 0.62, (1, 1, 1), (4.1, 0, 2.3)), 0.62, 0.65)
        c = nb.mix(coat, c, nb.mix(0.6, nb.img("build/clay_plaster/clay_plaster_diff_1k.jpg", 0.7), srgb(older)))
        brick = nb.img("build/rabdentse_ruins_wall/rabdentse_ruins_wall_diff_1k.jpg", 0.5)
        brick = nb.mix(0.45, brick, srgb(0x9c7454))
        c = nb.mix(nb.mr(nb.noise(0.9, 6, 0.62, (1, 1, 1), (4.1, 0, 2.3)), 0.71, 0.73), c, brick)
        foot = nb.math("MULTIPLY", nb.mr(nb.math("ADD", nb.gy, nb.math("MULTIPLY", nb.noise(3.0, 3), 0.25)), 0.75, 0.05), 0.5)
        c = nb.mix(foot, c, srgb(0x7d6146))
        streak = nb.math("MULTIPLY", nb.mr(nb.noise(2.6, 5, 0.6, (12, 12, 0.4)), 0.55, 0.72), 0.35)
        c = nb.mix(streak, c, srgb(0x8a7660))
        return dust(nb, c, 1.4, 0.8)
    return f
def mudBrick(nb):
    c = nb.img("build/rabdentse_ruins_wall/rabdentse_ruins_wall_diff_1k.jpg", 0.45)
    c = nb.mix(0.4, c, srgb(0xa47a58))
    return dust(nb, nb.scale(c, nb.mr(nb.noise(1.2, 4), 0.3, 0.7, 0.8, 1.05)), 1.2)
def mudRubble(nb):
    s = nb.img("build/rabdentse_ruins_wall/rabdentse_ruins_wall_diff_1k.jpg", 0.9)
    r = nb.mix(0.55, nb.img("build/clay_plaster/clay_plaster_diff_1k.jpg", 0.9), srgb(0xc99a68))
    c = nb.mix(nb.mr(nb.noise(3.0, 5, 0.6), 0.45, 0.55), nb.mix(0.4, s, srgb(0xa47a58)), r)
    return dust(nb, nb.scale(c, nb.mr(nb.island(), 0, 1, 0.7, 1.05)), 2.0, 1.2)

MATDEF = dict(house.MATDEF)
MATDEF.update({
    # (measured off the Ghardaïa photo: the ochre walls ~#d0893f in sun, the sand ones ~#d6ab6e, the pink ~#c27a62)
    "earthOchre": (0.95, earth(0xcf863c, 0xbf7350)), "earthSand": (0.95, earth(0xd6ab6e, 0xc39060)),
    "earthPink": (0.95, earth(0xc27a62, 0xad6a50)), "limeBlue": (0.95, earth(0xd2e0e4, 0xe8dfcf)),
    "earthYellow": (0.95, earth(0xd99a40, 0xc47e48)),
    "stone": (0.95, mudBrick), "rubble": (0.95, mudRubble),
    "sill": (0.9, flat(srgb(0xc29c72))), "earth": (1.0, flat(srgb(0xa8875f))),
    "shutterWood": (0.85, wood(0x8a6a48)),
})

# ── THE TYPES (real metres; front at -Z) — house.py's description, plus: ─────
#   parapet "mzab" (horns, spouts, no crenels / joists); loggia (x0 x1 z0 z1 h arches); arcade (depth, arches)
T = house.T
TYPES = {
    # two storeys round a central stair, the ROOF GALLERY (three arches) across the back of the terrace
    "dar": dict(render="earthOchre", shutter="shutterWood", door=(-0.55, 0.55, "doorBlue"), parapet="mzab",
        main=(-3.6, 3.6, -3.4, 3.4), floors=[3.0], roof=5.9, par=6.7, loggia=(-3.0, 3.0, 0.6, 2.8, 2.6, 3),
        wins=[("f", -2.6, -1.9, 1.3, 2.0, "shut"), ("f", 1.9, 2.6, 1.3, 2.0, "void"), ("f", -2.4, -1.8, 4.0, 4.6, "shut"),
              ("f", -0.3, 0.3, 4.2, 4.7, "void"), ("f", 1.8, 2.5, 4.0, 4.6, "shut"), ("l", -1.0, -0.4, 4.0, 4.6, "void"),
              ("r", 0.5, 1.1, 1.3, 1.9, "shut"), ("b", -1.5, -0.9, 4.0, 4.6, "void")],
        dmg=[((2.2, 4.3, -3.4), (0.9, 0.8, 0.7)), ((-3.6, 1.5, -1.2), (0.7, 1.0, 0.95)), ((-2.0, 6.8, -3.4), (1.1, 0.55, 0.7)), ((1.0, 7.4, 1.0), (1.2, 0.9, 0.8))],
        ruin=(3.6, 1.5), life=["pottery", "prayer", "baskets", "rug"], ground=["jars", "bench"]),
    # TALL and narrow, three storeys, the stair's head on the roof — the houses that step up the knoll
    "tour": dict(render="earthSand", shutter="shutterWood", door=(-0.5, 0.5, "wood"), parapet="mzab",
        main=(-2.6, 2.6, -2.8, 2.8), floors=[3.0, 5.9], roof=8.8, par=9.6, hut=(0.3, 2.15, 0.5, 2.35),
        wins=[("f", -1.9, -1.3, 1.4, 2.0, "shut"), ("f", -0.3, 0.3, 4.1, 4.7, "void"), ("f", 1.2, 1.8, 4.1, 4.7, "shut"),
              ("f", -1.6, -1.0, 7.0, 7.6, "shut"), ("f", 0.9, 1.5, 7.0, 7.6, "void"), ("l", -0.5, 0.1, 4.1, 4.7, "void"),
              ("r", 0.4, 1.0, 7.0, 7.6, "shut"), ("b", -0.6, 0.0, 1.4, 2.0, "void")],
        dmg=[((-1.4, 4.5, -2.8), (0.8, 0.9, 0.7)), ((2.6, 2.0, -0.6), (0.6, 0.9, 0.9)), ((1.0, 9.4, -2.8), (1.0, 0.6, 0.7)), ((-2.6, 7.4, 1.0), (0.6, 0.8, 0.9))],
        ruin=(5.0, 2.0), life=["pottery", "hay", "baskets"], ground=["jars"]),
    # LOW, one storey behind a walled yard — the town's edge
    "bas": dict(render="earthPink", shutter="shutterWood", door=(-2.2, -1.3, "doorGreen"), parapet="mzab",
        main=(-3.2, 3.2, 0.0, 4.6), floors=[], roof=3.0, par=3.7, court=(-3.2, 3.2, -4.0, 0.0, 2.4, (0.5, 1.6)),
        wins=[("f", 0.6, 1.2, 1.2, 1.8, "shut"), ("l", 1.5, 2.1, 1.2, 1.8, "void"), ("r", 2.0, 2.6, 1.2, 1.8, "shut")],
        dmg=[((-1.5, 1.3, -4.0), (0.9, 0.8, 0.6)), ((3.2, 2.0, 2.5), (0.6, 0.8, 1.0)), ((-1.0, 3.7, 4.6), (1.1, 0.5, 0.7))],
        ruin=(1.8, 0.9), life=["oven", "pottery", "mats"], ground=["jars", "sacks"]),
    # STEPPED: two storeys and a one-storey wing, its terrace reached by an outside stair — the pale blue house
    "terrasse": dict(render="limeBlue", shutter="shutterBlue", door=(-0.5, 0.5, "doorGreen"), parapet="mzab",
        main=(-3.0, 3.0, -3.0, 3.0), floors=[3.0], roof=5.9, par=6.6, annex=(3.0, 6.6, -1.2, 3.0, 3.2, 3.8), annexDoor=(4.3, 5.2), stair=True,
        wins=[("f", -2.3, -1.7, 1.3, 1.9, "shut"), ("f", 1.4, 2.0, 1.3, 1.9, "grille"), ("f", -2.0, -1.4, 4.0, 4.6, "shut"),
              ("f", 1.2, 1.8, 4.0, 4.6, "void"), ("l", -0.6, 0.0, 4.0, 4.6, "shut"), ("b", 0.5, 1.1, 4.0, 4.6, "void")],
        annexWins=[("f", 5.6, 6.1, 1.3, 1.8, "void")],
        dmg=[((1.7, 4.3, -3.0), (0.9, 0.8, 0.7)), ((-3.0, 1.4, 0.5), (0.7, 1.0, 0.95)), ((6.6, 2.4, 1.0), (0.7, 0.9, 0.9)), ((-1.8, 6.7, -3.0), (1.0, 0.5, 0.7))],
        ruin=(3.6, 1.5), life=["laundry", "pottery", "prayer"], ground=["firewood", "jars"]),
    # the SOUK's shop row: four round ARCHES before two shop doors — round the market square
    "souk": dict(render="earthYellow", shutter="shutterWood", door=(-4.4, -3.4, "doorBlue"), door2=(1.0, 2.4), parapet="mzab",
        main=(-6.0, 6.0, -2.4, 2.4), floors=[], roof=3.6, par=4.3, arcade=(2.6, 4),
        wins=[("f", -1.6, -0.9, 1.2, 2.0, "grille"), ("f", 4.0, 4.8, 1.1, 2.1, "shut"), ("l", -0.4, 0.4, 1.2, 1.9, "void"), ("b", -3.0, -2.3, 1.2, 1.9, "shut")],
        dmg=[((-3.0, 1.6, -5.0), (0.9, 0.9, 0.7)), ((6.0, 1.4, 0.5), (0.6, 0.9, 1.0)), ((2.0, 3.9, -5.0), (1.3, 0.5, 0.7))],
        ruin=(2.2, 1.0), life=["rug2", "mats", "pottery"], ground=["sacks", "bench"]),
    # the MOSQUE on the hilltop: its prayer hall, an arcade on a walled court, the tapering MINARET at the back
    # corner (the M'zab's: square, ~18 m, slots up its faces, open arches and four pointed fingers at the top)
    "mosquee": dict(render="earthSand", shutter="shutterWood", door=(-0.7, 0.7, "wood"), parapet="mzab",
        main=(-6.0, 6.0, -0.5, 6.5), floors=[], roof=4.4, par=5.1, court=(-5.95, 5.95, -6.5, -0.5, 2.6, (-0.8, 0.8)), arcade=(2.4, 4),
        minaret=(-4.25, 4.75, 1.9, 1.25, 18.0),
        wins=[("l", 1.0, 1.6, 2.2, 3.0, "void"), ("r", 1.0, 1.6, 2.2, 3.0, "void"), ("b", 2.0, 2.6, 2.2, 3.0, "void"), ("b", -1.0, -0.4, 2.2, 3.0, "void")],
        dmg=[((3.0, 2.0, 6.5), (1.0, 0.9, 0.7)), ((-4.25, 11.0, 3.2), (0.8, 0.9, 0.7)), ((6.0, 2.0, 3.0), (0.6, 0.9, 1.0)), ((-4.25, 16.5, 6.3), (0.9, 0.7, 0.6))],
        ruin=(3.2, 1.4), life=["prayer", "prayer", "mats"], ground=[]),
}

# ── THE TERRACE WALL (2026-10-20): the town's ring terraces held up where no house stands against the riser ──
# One module, 3.4 m long (4.4 in the game), laid end to end round each riser by tools/algAbdiLevel.mjs: rubble and
# mud brick with patches of the old render, its foot sunk, a chest-high PARAPET (0.7 m) over the upper terrace
# (cover for the men holding it). Origin: the lower ground, the wall's face at z = -0.3 (its front, -Z, downhill).
import math, random
def buildWall(K, name, spec, state, seed):
    R = random.Random(seed)
    G, L, H, P = "h", 1.72, spec["drop"], spec["parapet"]
    w = K.box("Wall", -L, L, -0.4, H + P, -0.3, 0.45, "terraceWall", G, 0)
    # a slight BATTER (the face leans back as it rises) and a rounded render coping on the parapet
    K.bevel(w, 0.05, 2, 30)
    K.box("Coping", -L - 0.02, L + 0.02, H + P, H + P + 0.1, -0.34, 0.1, spec["coping"], G, 0.04)
    # fallen stones at its foot, a drain hole or two
    for k in range(R.randint(2, 4)):
        K.lump(f"Stone{k}", (R.uniform(-L + 0.3, L - 0.3), 0.0, R.uniform(-0.9, -0.45)), (R.uniform(0.12, 0.25), R.uniform(0.08, 0.16), R.uniform(0.1, 0.2)), "rubble", G, seed=seed + k, sub=1)
    for k in range(2):
        x = R.uniform(-L + 0.4, L - 0.4)
        K.boolean(w, K.cutter(x - 0.09, x + 0.09, 0.35, 0.53, -0.5, -0.05, "dark"))
    if state != "intact":
        K.boolean(w, K.breach((R.uniform(-0.8, 0.8), H + P * 0.6, -0.3), (0.7, 0.45, 0.6), seed=seed, mat="stone"))
    if state == "ruin":
        top = K.skyline(-L - 1, L + 1, -1.5, 1.5, H * 0.75, 0.5, seed=seed, mat="stone")
        for o in list(K.groups[G]): K.boolean(o, top)
        K.lump("Heap", (0.0, 0.0, -0.9), (1.3, 0.4, 0.6), "rubble", G, seed=seed + 3, rough=0.45)

def terraceWall(nb):
    """Rubble and mud brick, patches of the old earth render still on it, darker toward the foot."""
    s = nb.img("build/rabdentse_ruins_wall/rabdentse_ruins_wall_diff_1k.jpg", 0.55)
    s = nb.mix(0.5, s, srgb(0xb48a64))
    r = nb.mix(0.7, nb.img("build/clay_plaster/clay_plaster_diff_1k.jpg", 0.4), srgb(0xd29a5c))
    # (mostly RENDER, the rubble in patches, a light foot — 2026-10-20: half bare rubble read dark grey by the ochre houses)
    c = nb.mix(nb.mr(nb.noise(0.8, 5, 0.62, (1, 1, 1), (2.2, 0, 7.1)), 0.36, 0.4), s, r)
    c = nb.mix(nb.math("MULTIPLY", nb.mr(nb.gy, 0.9, 0.0), 0.22), c, srgb(0x7d6146))
    return dust(nb, c, 1.4, 0.9)
MATDEF["terraceWall"] = (0.95, terraceWall)
TYPES["mur"] = dict(builder=buildWall, drop=2.0, parapet=0.7, coping="earthOchre", atlas=1024)

exported = buildKit(TYPES, MATDEF, "mzab.glb", prefix="Mzab", seed0=1830)
previews(TYPES, exported, prefix="Mzab", tag="mzab_")
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(REFS, "mzab.blend"))
print("DONE")
