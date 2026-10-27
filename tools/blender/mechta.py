"""THE MECHTA — the Aurès stone hamlet's houses (2026-10-27, games/alg-rts/MECHTA_PLAN.md; you: "ok go ahead"). The
Chaouia house of the mountain villages (Ghoufi, Menaa, Tighanimine), for the NEW maps only (the old Aurès keeps its
runtime hamlet, algMasonry): house.py's builder (one description, three states, one atlas a type, a far level) with
the mechta's own features:

    STONE          rough local stone, ochre-grey as the ground (the game tiles the dry-stone photo over it)
    TIMBER COURSES flat bands of juniper logs in the walls, on the bigger houses (Ghoufi) — cut at the openings
    ROOF           a flat terrace of packed clay, the beams' ends through the walls, a LOW UNEVEN LIP (no crenels),
                   a wooden spout; hay, pots, baskets on it
    OPENINGS       one low plank door, a few small holes high up
    UPPER ROOM     (etage) set back on the roof, open on a LOGGIA of wooden posts
    STATES         intact / damaged (breached, the lip shot away) / ruin (stumps, the upper room fallen, beams in)

  "C:/Program Files/Blender Foundation/Blender 5.0/blender.exe" -b --factory-startup \\
      --python tools/blender/mechta.py -- <out dir> [--quick] [--only petite]

Writes <out>/mechta.glb (Mechta<Type>_<State> + _Far) — then tools/optimizeGlb.mjs --etc1s. Previews in
assets-src/refs/house/preview_mechta_<type>.png. Game coordinates, real metres (the game x1.3), FRONT at -Z.
"""
import sys, os, math, random
sys.path.insert(0, os.path.dirname(__file__))
import bpy
import house
from house import buildKit, previews, REFS, T
from bkit import srgb, dust, wood

# ── Materials ────────────────────────────────────────────────────────────────
def mechtaStone(nb):
    """The Aurès' rough stone: the ruined-wall photo pulled to the ground's ochre-grey, every stone its own shade."""
    c = nb.img("build/rabdentse_ruins_wall/rabdentse_ruins_wall_diff_1k.jpg", 0.45)
    c = nb.mix(0.55, c, srgb(0xb08a60))   # (0.35 of 0xb4946c: the photo's grey won — lilac-grey walls in the lab)
    c = nb.scale(c, nb.mr(nb.noise(1.1, 4), 0.3, 0.7, 0.82, 1.06))
    # a darker foot (splash, damp) and paler streaks under the lip
    c = nb.mix(nb.math("MULTIPLY", nb.mr(nb.gy, 0.7, 0.0), 0.3), c, srgb(0x7a6247))
    return dust(nb, c, 1.3, 0.9)
def clay(nb):
    """The terrace's packed clay (and the lip's top): the clay plaster photo, earth brown, cracked dry in patches."""
    c = nb.img("build/clay_plaster/clay_plaster_diff_1k.jpg", 0.5)
    c = nb.mix(0.9, c, srgb(0x7a5c40))   # (0.7 of 0xa58462, then 0x957352: still cream in the lab — a terrace takes the full sun, so it is darker than the ground it reads as)
    c = nb.scale(c, nb.mr(nb.noise(0.7, 5), 0.3, 0.7, 0.85, 1.05))
    return dust(nb, c, 1.6, 1.0)

MATDEF = dict(house.MATDEF)
def mechtaRubble(nb):
    """Fallen stone and clay (the whitewashed kit's rubble has its lime render in it)."""
    s = nb.mix(0.55, nb.img("build/rabdentse_ruins_wall/rabdentse_ruins_wall_diff_1k.jpg", 0.9), srgb(0xa8855c))
    c = nb.mix(nb.mr(nb.noise(3.0, 5, 0.6), 0.5, 0.58), s, srgb(0x8f7152))
    return dust(nb, nb.scale(c, nb.mr(nb.island(), 0, 1, 0.75, 1.05)), 2.0, 1.2)

MATDEF.update({
    "stone": (0.95, mechtaStone), "rubble": (0.95, mechtaRubble),   # (house.build's breaches and heaps: this stone, no lime)
    "stoneMechta": (0.95, mechtaStone),    # (class 2: "stone" in its name — the game's dry-stone photo)
    "renderClay": (0.95, clay),            # (class 1: the M'zab's mud render photo — algHouse SURFACE_KITS)
    "timberCourse": (0.9, wood(0x6b5741)), # (class 3)
})

# ── THE TYPES (real metres; front at -Z) — house.py's description (plain parapet), plus:
#   courses: [heights] of the timber bands; upper: (x0 x1 z0 z1 h) the loggia room on the roof; spouts: [x];
#   ladder: a ladder up the front
TYPES = {
    # ONE ROOM, one storey, a ladder to its roof — the hamlet's commonest house
    "petite": dict(render="stoneMechta", shutter="woodDark", door=(-1.5, -0.62, "woodDark"), plain=True,
        main=(-2.6, 2.6, -2.1, 2.1), floors=[], roof=2.55, par=3.02, courses=[], spouts=[0.6], ladder=1.6,
        wins=[("f", 0.75, 1.15, 1.65, 2.0, "void"), ("r", -0.25, 0.15, 1.7, 2.05, "void")],
        dmg=[((0.95, 0.8, -2.1), (0.7, 0.7, 0.6)), ((2.6, 0.95, 1.15), (0.55, 0.75, 0.7))],   # (clear of the openings: a window's dark and sill left floating in a hole)
        ruin=(1.4, 0.7), life=["hay", "pottery"], ground=["jars"]),
    # TWO ROOMS, timber courses, the UPPER ROOM on the back-left of the roof, open on its loggia (Ghoufi)
    "etage": dict(render="stoneMechta", shutter="woodDark", door=(-0.5, 0.42, "woodDark"), plain=True,
        main=(-3.6, 3.6, -2.8, 2.8), floors=[], roof=3.0, par=3.48, courses=[0.95, 2.05], spouts=[2.2],
        upper=(-3.27, 0.55, -1.0, 2.47, 2.3),   # (its back and side 12 cm INTO the parapet: never one plane with its face)
        wins=[("f", -2.6, -2.15, 1.9, 2.32, "void"), ("f", 2.0, 2.42, 1.9, 2.32, "void"), ("l", 0.4, 0.82, 1.9, 2.3, "void"), ("b", -1.0, -0.58, 2.0, 2.4, "void")],
        dmg=[((1.2, 0.9, -2.8), (0.7, 0.75, 0.65)), ((-3.6, 0.9, 0.8), (0.6, 0.75, 0.8)), ((0.55, 4.3, 0.9), (0.6, 0.7, 0.8))],   # (clear of the openings and the loggia's posts)
        ruin=(1.9, 0.9), life=["hay", "pottery", "baskets"], ground=["jars", "firewood", "sacks"]),
}

def buildMechta(K, name, spec, state, seed):
    R = random.Random(seed + 101)
    G = "h"
    dmg, ruin = state != "intact", state == "ruin"
    X0, X1, Z0, Z1 = spec["main"]; ROOF, PAR = spec["roof"], spec["par"]
    house.build(K, name, dict(spec, life=[]), state, seed)   # (the roof's life below: the upper room kept clear)
    made = list(K.groups[G])
    main = made[0]
    # SOFTER CORNERS (2026-10-27, you: "you said you can do better"): the shell's bevel 3.5 cm -> 9 (dry stone has no arris)
    for md in main.modifiers:
        if md.type == "BEVEL": md.width, md.segments = 0.09, 2
    # THE RUIN'S ROOF fallen IN (not house.py's one flat slab — it read as a plank floor): its earth heaped inside, the
    # reed layer and the beams broken into it
    if ruin:
        for o in [o for o in made if o.name.startswith("Fallen")]:
            K.groups[G].remove(o); bpy.data.objects.remove(o, do_unlink=True)
        made = list(K.groups[G])
        cx, cz = (X0 + X1) / 2, (Z0 + Z1) / 2
        K.lump("RoofMound", (cx + 0.25, 0.0, cz - 0.2), ((X1 - X0) * 0.36, 0.85, (Z1 - Z0) * 0.33), "renderClay", G, seed=seed + 61, rough=0.4)
        for k in range(9):
            a = R.uniform(0, 6.28); r0, r1 = R.uniform(0.2, 0.6), R.uniform(1.1, 1.9)
            y = R.uniform(0.45, 0.75)
            K.rod(f"Reed{k}", (cx + math.cos(a) * r0, y + 0.15, cz + math.sin(a) * r0 * 0.8), (cx + math.cos(a) * r1, y - 0.35, cz + math.sin(a) * r1 * 0.8), 0.025, "woodDark", G, 5)
        for k in range(3):
            x = X0 + 1.0 + k * (X1 - X0 - 2.0) / 2
            K.rod(f"RoofBeam{k}", (x + R.uniform(-0.3, 0.3), 0.35, cz + R.uniform(-0.6, 0.6)), (x + R.uniform(-0.5, 0.5), spec["ruin"][0] * 0.8, Z1 - T - 0.1), 0.09, "woodDark", G, 6)
    # the mechta's surfaces: a clay terrace, timber sills, stone steps
    for o in made:
        if o.name == "Roof": o.data.materials[0] = K.mat("renderClay")
        elif o.name.endswith("Sill"): o.data.materials[0] = K.mat("timberCourse")
        elif o.name.startswith("Step"): o.data.materials[0] = K.mat(spec["render"])
    # a stone SOCLE under it (a house on a slope: its foot never floats)
    K.box("Socle", X0 - 0.05, X1 + 0.05, -0.8, 0.03, Z0 - 0.05, Z1 + 0.05, spec["render"], G, 0)
    extras = []
    # THE LOW UNEVEN LIP: the shell's top broken a little (no crenels, no straight edge)
    if not ruin:
        K.boolean(main, K.skyline(X0 - 1, X1 + 1, Z0 - 1, Z1 + 1, PAR - 0.06, 0.08, seed=seed + 40, mat="renderClay"))
    # THE TIMBER COURSES: a band of logs round the walls at each height, cut at the openings it crosses
    holes = [("f", spec["door"][0], spec["door"][1], 0.0, 2.3)] + [w[:5] for w in spec["wins"]]
    for ci, y in enumerate(spec.get("courses", [])):
        y1 = y + 0.14
        faces = {"f": K.box(f"Course{ci}f", X0 - 0.04, X1 + 0.04, y, y1, Z0 - 0.04, Z0 + 0.06, "timberCourse", G, 0.01),
                 "b": K.box(f"Course{ci}b", X0 - 0.04, X1 + 0.04, y, y1, Z1 - 0.06, Z1 + 0.04, "timberCourse", G, 0.01),
                 # (the sides stop short of the front and back bands: no shared corner volume, no coplanar tops)
                 "l": K.box(f"Course{ci}l", X0 - 0.035, X0 + 0.06, y, y1, Z0 + 0.07, Z1 - 0.07, "timberCourse", G, 0.01),
                 "r": K.box(f"Course{ci}r", X1 - 0.06, X1 + 0.035, y, y1, Z0 + 0.07, Z1 - 0.07, "timberCourse", G, 0.01)}
        for f, a0, a1, h0, h1 in holes:
            if h1 < y or h0 > y1: continue
            a0, a1 = a0 - 0.02, a1 + 0.02   # (2 cm wider than the opening: its cut ends never in one plane with the opening's sides)
            if f in ("f", "b"):
                z = Z0 if f == "f" else Z1
                K.boolean(faces[f], K.cutter(a0, a1, h0, h1, z - 0.2, z + 0.2))
            else:
                x = X0 if f == "l" else X1
                K.boolean(faces[f], K.cutter(x - 0.2, x + 0.2, h0, h1, a0, a1))
        extras += faces.values()
    # THE SPOUTS: a split log out of the lip at roof level, throwing the rain off the front
    for k, x in enumerate(spec.get("spouts", [])):
        extras.append(K.rod(f"Spout{k}", (x, ROOF + 0.32, Z0 + 0.15), (x, ROOF + 0.24, Z0 - 0.55), 0.07, "woodDark", G, 6))
    # THE UPPER ROOM on its loggia (not in a ruin: fallen in)
    upperRect = None
    if "upper" in spec and not ruin:
        ux0, ux1, uz0, uz1, uh = spec["upper"]
        y0 = ROOF + 0.24
        up = K.box("Upper", ux0, ux1, y0 - 0.02, y0 + uh + 0.42, uz0, uz1, spec["render"], G, 0)
        K.boolean(up, K.cutter(ux0 + 0.4, ux1 - 0.4, y0 + 0.04, y0 + uh + 1.0, uz0 + 0.4, uz1 - 0.4))
        lo0, lo1, lt = ux0 + 0.55, ux1 - 0.55, y0 + uh - 0.4                 # the loggia's opening, across the front
        K.boolean(up, K.cutter(lo0, lo1, y0 + 0.3, lt, uz0 - 0.2, uz0 + 0.6))
        K.boolean(up, K.cutter(ux1 - 0.6, ux1 + 0.2, y0 + 1.0, y0 + 1.4, uz0 + 1.3, uz0 + 1.7))   # a hole on its side
        K.boolean(up, K.skyline(ux0 - 1, ux1 + 1, uz0 - 1, uz1 + 1, y0 + uh + 0.36, 0.07, seed=seed + 41))
        K.bevel(up, 0.035, 2, 30)
        extras.append(up)
        extras.append(K.box("UpperRoof", ux0 + 0.38, ux1 - 0.38, y0 + uh, y0 + uh + 0.22, uz0 + 0.38, uz1 - 0.38, "renderClay", G, 0))
        # its posts and their beam in the opening's depth, the beams' ends over it
        n = max(3, round((lo1 - lo0) / 1.0))   # (two posts at least: one read thin)
        for k in range(1, n):
            x = lo0 + (lo1 - lo0) * k / n
            extras.append(K.rod(f"Post{k}", (x, y0 + 0.3, uz0 + 0.22), (x, lt, uz0 + 0.22), 0.085, "timberCourse", G, 7))
        extras.append(K.box("LoggiaBeam", lo0 - 0.1, lo1 + 0.1, lt - 0.15, lt + 0.02, uz0 + 0.1, uz0 + 0.34, "timberCourse", G, 0.01))
        for k in range(5):
            x = ux0 + 0.5 + k * (ux1 - ux0 - 1.0) / 4
            extras.append(K.box(f"UJoist{k}", x - 0.07, x + 0.07, y0 + uh - 0.16, y0 + uh - 0.03, uz0 - 0.28, uz0 + 0.02, "woodDark", G, 0.01))
        upperRect = (ux0, ux1, uz0, uz1)
    # A LADDER up the front to the roof (the one-room house)
    if spec.get("ladder") and not dmg:   # (damaged: knocked down)
        lx = spec["ladder"]
        for s in (-0.22, 0.22):
            extras.append(K.rod(f"LadRail{s}", (lx + s, 0.0, Z0 - 0.75), (lx + s, PAR + 0.4, Z0 - 0.05), 0.035, "woodDark", G, 6))
        for k in range(8):
            f = (k + 0.6) / 8.6
            y, z = (PAR + 0.4) * f, Z0 - 0.75 + 0.7 * f
            extras.append(K.rod(f"LadRung{k}", (lx - 0.22, y, z), (lx + 0.22, y, z), 0.022, "woodDark", G, 5))
    # FIREWOOD on the roof now and then (the oven's)
    if not ruin and R.random() < 0.7:
        fx = (X0 + X1) / 2 + (1.2 if upperRect else 0.0); fz = Z1 - T - 0.55
        for k in range(6):
            extras.append(K.rod(f"RoofWood{k}", (fx - 0.6, ROOF + 0.3 + (k % 2) * 0.09, fz - 0.25 + k * 0.09), (fx + 0.6, ROOF + 0.3 + (k % 2) * 0.09, fz - 0.2 + k * 0.08), 0.045, "woodDark", G, 6))
    # THE ROOF'S LIFE (house.py's), the upper room's corner kept clear
    if not ruin:
        house.roofLife(K, R, X0 + T + 0.3, X1 - T - 0.3, Z0 + T + 0.3, Z1 - T - 0.3, ROOF + 0.24, spec["life"], upperRect, PAR, Z0)
    # the house's DAMAGE on these parts too: the same breaches, 4 % bigger, the same broken top 3 cm lower (a band in the
    # wall cut by the very same shape left its cut faces in one plane with the wall's — 55 z-fighting pairs, the gate)
    if dmg:
        for k, (c, sz) in enumerate(spec["dmg"]):
            cut = K.breach(c, tuple(v * 1.04 for v in sz), seed=seed * 7 + k, mat="stone")
            for o in extras: K.boolean(o, cut)
    if ruin:
        h, amp = spec["ruin"]
        top = K.skyline(X0 - 1.5, X1 + 1.5, Z0 - 5.0, Z1 + 1.5, h - 0.03, amp, seed=seed, mat="stone")
        for o in extras: K.boolean(o, top)
    # THE BATTER: the walls lean in as they rise (~1 % a metre), the whole house — after every cut, so the openings, the
    # beams and the bands follow the wall they are in (a taper about the house's own axis: every part shares the origin)
    for o in K.groups[G]:
        if o.type != "MESH": continue
        md = o.modifiers.new("Batter", "SIMPLE_DEFORM"); md.deform_method = "TAPER"; md.deform_axis = "Z"; md.factor = -0.011

for spec in TYPES.values(): spec.update(builder=buildMechta, farRatio=0.38)   # (0.3: the loggia house's far ruin shaded off its near — the gate)

exported = buildKit(TYPES, MATDEF, "mechta.glb", prefix="Mechta", seed0=1957, surfaces=True)
previews(TYPES, exported, prefix="Mechta", tag="mechta_", spacing=13, frame=0.8)
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(REFS, "mechta.blend"))
print("DONE")
